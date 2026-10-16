// The two must-fix items of the stage 2 security review (docs/CONTRACTS.md sections 20 and 23),
// checked on the real code of packages/market. Local only: the only network it touches is a few HTTP
// servers it starts on 127.0.0.1 and stops again. Never deployed.
//
//   node packages/market/scripts/read-hardening-check.mjs
//
// 1. Redirects. An endpoint that answers with a redirect is one request and an `http` failure: the
//    read never follows it, so a redirect chain cannot spend the Worker's subrequests and a listed
//    host cannot hand the request to another host. The same holds for the data reads: `createRpc`,
//    the wallet activity reader and the token balance reader.
// 2. Bounded decoding. An `eth_call` result that is longer than the read can honestly be, that does
//    not hold exactly the expected number of inner results, or whose inner results claim more bytes
//    than the answer has, is refused as `malformed` before viem decodes anything.
//
// Exit code 1 on any failure. Times are printed, never asserted against a tight limit.

import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

const contracts = await import('@prix/contracts');
const chain = await import('../src/chain.ts');
const wire = await import('../src/wire.ts');
const { createMarketWith } = await import('../src/market.ts');
const rpcModule = await import('../src/rpc.ts');
const { createWalletActivityReader } = await import('../src/wallet-activity.ts');
const { createTokenChainReader } = await import('../src/token-balances.ts');
const { UNIVERSE } = await import('../src/universe.ts');

const { ARBITRUM_CHAIN_ID, CHAIN_ID, feedChainOf, isStockToken } = contracts;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
}
const show = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));
/** What `run` threw, or null. */
async function failedWith(run) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}
/** Any ERC-20 of the universe, for the reads that need a token. */
const stock = UNIVERSE.find((token) => isStockToken(token));

// --- 1. redirects ---------------------------------------------------------------------------------

/** A server on 127.0.0.1 with a free port; `handler` gets every request with its body read. */
async function serve(handler) {
  const hits = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      hits.push({ method: request.method, url: request.url });
      handler(request, response, Buffer.concat(chunks).toString('utf8'));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/rpc`,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const servers = [];
try {
  // A redirect loop: every request is sent back to the same address, method and body kept (307).
  const loop = await serve((request, response) => {
    response.writeHead(307, { location: request.url });
    response.end();
  });
  servers.push(loop);

  const arbitrumLoop = await chain.readArbitrum(loop.url, 'latest', UNIVERSE, fetch, 4_000);
  check('readArbitrum makes one request to a redirect loop', loop.hits.length === 1, `${loop.hits.length} requests`);
  check(
    'readArbitrum reports the redirect as an http failure with its code',
    !arbitrumLoop.ok && arbitrumLoop.failure.kind === 'http' && arbitrumLoop.failure.code === 307,
    show(arbitrumLoop),
  );

  loop.hits.length = 0;
  const snapshotLoop = await chain.readSnapshot(loop.url, UNIVERSE, fetch, 4_000);
  check('readSnapshot makes one request to a redirect loop', loop.hits.length === 1, `${loop.hits.length} requests`);
  check(
    'readSnapshot reports the redirect as an http failure with its code',
    !snapshotLoop.ok && snapshotLoop.failure.kind === 'http' && snapshotLoop.failure.code === 307,
    show(snapshotLoop),
  );

  // The whole snapshot against four endpoints that all loop: one Robinhood endpoint (not retried, a
  // redirect is not transient) and the three Arbitrum endpoints, each once.
  loop.hits.length = 0;
  const reported = [];
  const market = createMarketWith(
    {
      rpcUrls: [loop.url],
      fetch,
      staleAfterSeconds: 3_600,
      cryptoStaleAfterSecondsBySymbol: {},
      quietAfterSeconds: 3_600,
      arbitrum: { officialRpcUrl: loop.url, confirmingRpcUrls: [loop.url, loop.url], sequencerGraceSeconds: 3_600 },
      onEndpointFailure: (failure) => reported.push(failure),
    },
    { pause: async () => undefined, timeoutMs: 4_000, log: () => undefined },
  );
  const closed = await market.takeSnapshot(new Date());
  check(
    'a snapshot whose four endpoints all redirect makes four requests',
    loop.hits.length === 4,
    `${loop.hits.length} requests`,
  );
  check(
    'that snapshot is closed with rpc_unavailable and every endpoint reported http 307',
    closed.open === false &&
      closed.closedReason === 'rpc_unavailable' &&
      reported.length === 4 &&
      reported.every((failure) => failure.kind === 'http' && failure.code === 307),
    show({ open: closed.open, closedReason: closed.closedReason, reported }),
  );

  // A listed host that points at another host: the other host is never asked.
  const other = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"jsonrpc":"2.0","id":1,"result":"0x01"}');
  });
  servers.push(other);
  const pointer = await serve((_request, response) => {
    response.writeHead(307, { location: other.url });
    response.end();
  });
  servers.push(pointer);
  const pointed = await chain.readArbitrum(pointer.url, 'latest', UNIVERSE, fetch, 4_000);
  check(
    'a redirect to another host is not followed',
    pointer.hits.length === 1 && other.hits.length === 0,
    `${pointer.hits.length} to the listed host, ${other.hits.length} to the other`,
  );
  check('and is an http failure', !pointed.ok && pointed.failure.kind === 'http', show(pointed));

  // The data reads (the data API, the wallet activity of an agent, the balances of the tier sweep)
  // follow no redirect either: a 3xx is one request and a failure, never a request to another host.
  const { ChainUnavailableError, TokenReadError } = contracts;
  const hitsOf = () => `${pointer.hits.length} to the listed host, ${other.hits.length} to the other`;
  const clearHits = () => {
    for (const server of servers) server.hits.length = 0;
  };

  clearHits();
  const rpcPointed = await failedWith(() => rpcModule.createRpc([pointer.url]).call('eth_blockNumber', []));
  check('createRpc does not follow a redirect', pointer.hits.length === 1 && other.hits.length === 0, hitsOf());
  check(
    'createRpc reports the redirect as a refusal: ChainUnavailableError, not the transient kind',
    rpcPointed instanceof ChainUnavailableError && !(rpcPointed instanceof rpcModule.ChainTransientError),
    String(rpcPointed),
  );
  clearHits();
  await failedWith(() => rpcModule.createRpc([loop.url]).batch([{ method: 'eth_blockNumber', params: [] }]));
  check('createRpc makes one request to a redirect loop', loop.hits.length === 1, `${loop.hits.length} requests`);
  clearHits();
  await failedWith(() => rpcModule.createRpc([pointer.url, loop.url]).call('eth_blockNumber', []));
  check(
    'createRpc does not ask the next endpoint after a redirect (it is not a failure that may pass)',
    pointer.hits.length === 1 && loop.hits.length === 0 && other.hits.length === 0,
    `${hitsOf()}, ${loop.hits.length} to the next endpoint`,
  );

  clearHits();
  const wallet = createWalletActivityReader({ rpcUrls: [pointer.url] });
  const head = await wallet.headBlock();
  check(
    'the wallet reader does not follow a redirect',
    pointer.hits.length === 1 && other.hits.length === 0 && head === null,
    `${hitsOf()}, head ${show(head)}`,
  );
  clearHits();
  const looped = await createWalletActivityReader({ rpcUrls: [loop.url] }).readTransfers(wire.MULTICALL3_ADDRESS, 1, 2);
  check(
    'the wallet reader makes one request to a redirect loop and has no answer',
    loop.hits.length === 1 && looped.ok === false && looped.reason === 'rpc_unavailable',
    `${loop.hits.length} requests, ${show(looped)}`,
  );
  // The body of a redirect is not an answer: it cannot say that the window is too large.
  const talking = await serve((_request, response) => {
    response.writeHead(307, { location: other.url, 'content-type': 'application/json' });
    response.end('{"jsonrpc":"2.0","id":0,"error":{"code":-32005,"message":"query exceeds limit of 10000"}}');
  });
  servers.push(talking);
  clearHits();
  const talked = await createWalletActivityReader({ rpcUrls: [talking.url] }).readTransfers(
    wire.MULTICALL3_ADDRESS,
    1,
    2,
  );
  check(
    'the wallet reader does not read the body of a redirect',
    talking.hits.length === 1 && other.hits.length === 0 && talked.ok === false && talked.reason === 'rpc_unavailable',
    `${talking.hits.length} to the listed host, ${other.hits.length} to the other, ${show(talked)}`,
  );

  clearHits();
  const balances = await failedWith(() =>
    createTokenChainReader([pointer.url]).readBalances(stock.tokenAddress, [wire.MULTICALL3_ADDRESS]),
  );
  check(
    'the token balance reader does not follow a redirect',
    pointer.hits.length === 1 && other.hits.length === 0,
    hitsOf(),
  );
  check(
    'and has no balances: TokenReadError rpc_unavailable',
    balances instanceof TokenReadError && balances.code === 'rpc_unavailable',
    String(balances),
  );
  clearHits();
  await failedWith(() =>
    createTokenChainReader([loop.url]).readBalances(stock.tokenAddress, [wire.MULTICALL3_ADDRESS]),
  );
  check(
    'the token balance reader makes one request to a redirect loop',
    loop.hits.length === 1,
    `${loop.hits.length} requests`,
  );
} finally {
  for (const server of servers) await server.close();
}

// --- 2. bounded decoding --------------------------------------------------------------------------

const WORD = 32;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const bytesOf = (hex) => (hex.length - 2) / 2;

/** An honest answer: every inner call succeeded. */
const NOW = 1_791_000_000n;
const round = { answer: 123_456_789n, updatedAt: NOW - 60n };
const robinhoodReads = UNIVERSE.map((token) =>
  feedChainOf(token) === CHAIN_ID
    ? { round, decimals: 8, oraclePaused: isStockToken(token) ? false : null }
    : { round: null, decimals: null, oraclePaused: null },
);
const arbitrumFeedReads = UNIVERSE.map((token) =>
  feedChainOf(token) === ARBITRUM_CHAIN_ID
    ? { round, decimals: 8, oraclePaused: null }
    : { round: null, decimals: null, oraclePaused: null },
);
const honestSnapshot = wire.encodeSnapshotResult(UNIVERSE, {
  blockNumber: 9_000_000n,
  blockTimestamp: NOW,
  chainId: BigInt(CHAIN_ID),
  reads: robinhoodReads,
});
const honestArbitrum = wire.encodeArbitrumResult(UNIVERSE, {
  l1BlockNumber: 23_456_789n,
  chainId: BigInt(ARBITRUM_CHAIN_ID),
  blockTimestamp: NOW,
  l2BlockNumber: 391_234_567n,
  sequencer: { answer: 0n, startedAt: NOW - 2_592_000n },
  reads: arbitrumFeedReads,
});

const snapshotCalls = wire.snapshotCallCount(UNIVERSE);
const arbitrumCalls = wire.arbitrumCallCount(UNIVERSE);
console.log(
  `honest answers: Robinhood ${bytesOf(honestSnapshot)} bytes in ${snapshotCalls} results, ` +
    `Arbitrum ${bytesOf(honestArbitrum)} bytes in ${arbitrumCalls} results`,
);

const hasBounds =
  typeof wire.snapshotResultMaxBytes === 'function' &&
  typeof wire.arbitrumResultMaxBytes === 'function' &&
  typeof wire.multicallResultProblem === 'function';
check('wire.ts exports snapshotResultMaxBytes, arbitrumResultMaxBytes and multicallResultProblem', hasBounds);

const snapshotMax = hasBounds ? wire.snapshotResultMaxBytes(UNIVERSE) : 28_000;
const arbitrumMax = hasBounds ? wire.arbitrumResultMaxBytes(UNIVERSE) : 4_480;
if (hasBounds) {
  check(
    'the Robinhood limit is twice the honest answer',
    snapshotMax === 2 * bytesOf(honestSnapshot),
    `${snapshotMax} bytes`,
  );
  check(
    'the Arbitrum limit is twice the honest answer',
    arbitrumMax === 2 * bytesOf(honestArbitrum),
    `${arbitrumMax} bytes`,
  );
  check(
    'an honest Robinhood answer has no problem',
    wire.multicallResultProblem(honestSnapshot, snapshotCalls, snapshotMax) === null,
  );
  check(
    'an honest Arbitrum answer has no problem',
    wire.multicallResultProblem(honestArbitrum, arbitrumCalls, arbitrumMax) === null,
  );
}

/**
 * A crafted `tryBlockAndAggregate` answer: `count` results that all point at one element holding
 * `blobBytes` bytes of zeros. `declared` is the array-length word, `count` by default.
 */
function aliased(count, blobBytes, declared = count) {
  const padded = Math.ceil(blobBytes / WORD) * WORD;
  return `0x${word(1)}${word(0)}${word(0x60)}${word(declared)}${word(count * WORD).repeat(count)}${word(1)}${word(0x40)}${word(blobBytes)}${'00'.repeat(padded)}`;
}
/** The bytes of an aliased answer around its blob. */
const aliasedOverhead = (count) => WORD * (4 + count) + 3 * WORD;

/** An `eth_call` answered with `result` by a fetch that never touches a network. */
const answering = (result) => async () =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function timed(run) {
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const outcome = await run();
  return {
    outcome,
    ms: performance.now() - started,
    heapMb: (process.memoryUsage().heapUsed - before) / (1024 * 1024),
  };
}
const cost = ({ ms, heapMb }) => `${ms.toFixed(1)} ms, heap ${heapMb >= 0 ? '+' : ''}${heapMb.toFixed(1)} MB`;
const isMalformed = (outcome) => !outcome.ok && outcome.failure.kind === 'malformed';
/** A crafted answer must cost no more than this: the reviewer measured 249 ms and 2.3 s for the two below. */
const REFUSAL_BUDGET_MS = 40;

// Warm up, so that the first timed read does not pay for the first use of the module.
await chain.readArbitrum('https://arbitrum.invalid', 'latest', UNIVERSE, answering(honestArbitrum));
await chain.readSnapshot('https://robinhood.invalid', UNIVERSE, answering(honestSnapshot));

const honestA = await timed(() =>
  chain.readArbitrum('https://arbitrum.invalid', 'latest', UNIVERSE, answering(honestArbitrum)),
);
check('readArbitrum accepts the honest answer', honestA.outcome.ok === true, cost(honestA));
const honestS = await timed(() => chain.readSnapshot('https://robinhood.invalid', UNIVERSE, answering(honestSnapshot)));
check('readSnapshot accepts the honest answer', honestS.outcome.ok === true, cost(honestS));

// The reviewer's two answers: 200 and 50 results that each point at one blob of 60,000 bytes.
for (const count of [200, 50]) {
  const crafted = aliased(count, 60_000);
  const label = `${count} results of 60,000 bytes (${crafted.length - 2} hex characters)`;
  const a = await timed(() => chain.readArbitrum('https://arbitrum.invalid', 'latest', UNIVERSE, answering(crafted)));
  check(
    `readArbitrum refuses ${label} cheaply`,
    isMalformed(a.outcome) && a.ms < REFUSAL_BUDGET_MS,
    `${show(a.outcome)}, ${cost(a)}`,
  );
  const s = await timed(() => chain.readSnapshot('https://robinhood.invalid', UNIVERSE, answering(crafted)));
  check(
    `readSnapshot refuses ${label} cheaply`,
    isMalformed(s.outcome) && s.ms < REFUSAL_BUDGET_MS,
    `${show(s.outcome)}, ${cost(s)}`,
  );
}

// Each check alone, on the pure function: the length, the array-length word, the array's place,
// and results that share their bytes.
if (hasBounds) {
  const problem = wire.multicallResultProblem;
  const overLong = `${honestArbitrum}${'00'.repeat(arbitrumMax - bytesOf(honestArbitrum) + WORD)}`;
  check(
    'an answer one word over the limit is too_long',
    problem(overLong, arbitrumCalls, arbitrumMax) === 'too_long',
    String(problem(overLong, arbitrumCalls, arbitrumMax)),
  );
  const atLimit = `${honestArbitrum}${'00'.repeat(arbitrumMax - bytesOf(honestArbitrum))}`;
  check(
    'an honest answer padded to the limit exactly has no problem',
    problem(atLimit, arbitrumCalls, arbitrumMax) === null,
    String(problem(atLimit, arbitrumCalls, arbitrumMax)),
  );
  for (const declared of [arbitrumCalls - 1, arbitrumCalls + 1, 0, 2 ** 31]) {
    const wrong = `0x${honestArbitrum.slice(2, 2 + 3 * 64)}${word(declared)}${honestArbitrum.slice(2 + 4 * 64)}`;
    check(
      `an array-length word of ${declared} instead of ${arbitrumCalls} is wrong_count`,
      problem(wrong, arbitrumCalls, arbitrumMax) === 'wrong_count',
      String(problem(wrong, arbitrumCalls, arbitrumMax)),
    );
  }
  const moved = `0x${honestArbitrum.slice(2, 2 + 2 * 64)}${word(0x80)}${honestArbitrum.slice(2 + 3 * 64)}`;
  check(
    'an array that does not start where the encoding puts it is wrong_layout',
    problem(moved, arbitrumCalls, arbitrumMax) === 'wrong_layout',
    String(problem(moved, arbitrumCalls, arbitrumMax)),
  );
  check(
    'an answer cut short is wrong_layout',
    problem(honestArbitrum.slice(0, 2 + 3 * 64), arbitrumCalls, arbitrumMax) === 'wrong_layout' &&
      problem('0x', arbitrumCalls, arbitrumMax) === 'wrong_layout',
  );
  const sharedA = aliased(arbitrumCalls, arbitrumMax - aliasedOverhead(arbitrumCalls));
  check(
    'the right count of results sharing one blob, inside the limit, is aliased',
    problem(sharedA, arbitrumCalls, arbitrumMax) === 'aliased',
    `${bytesOf(sharedA)} bytes: ${String(problem(sharedA, arbitrumCalls, arbitrumMax))}`,
  );
}

// The worst answer that passes the length and the count: the right number of results, the answer as
// long as the limit allows, every result pointing at the same blob.
const worstA = aliased(arbitrumCalls, arbitrumMax - aliasedOverhead(arbitrumCalls));
const worstS = aliased(snapshotCalls, snapshotMax - aliasedOverhead(snapshotCalls));
const a = await timed(() => chain.readArbitrum('https://arbitrum.invalid', 'latest', UNIVERSE, answering(worstA)));
check(
  `readArbitrum refuses ${arbitrumCalls} results sharing one blob at the limit (${bytesOf(worstA)} bytes)`,
  isMalformed(a.outcome) && a.ms < REFUSAL_BUDGET_MS,
  `${show(a.outcome)}, ${cost(a)}`,
);
const s = await timed(() => chain.readSnapshot('https://robinhood.invalid', UNIVERSE, answering(worstS)));
check(
  `readSnapshot refuses ${snapshotCalls} results sharing one blob at the limit (${bytesOf(worstS)} bytes)`,
  isMalformed(s.outcome) && s.ms < REFUSAL_BUDGET_MS,
  `${show(s.outcome)}, ${cost(s)}`,
);

// What the plain decode of those two costs, for the record: the work the checks keep out.
for (const [name, data, abi] of [
  ['Arbitrum', worstA, wire.multicallAbi],
  ['Robinhood', worstS, wire.multicallAbi],
]) {
  const { decodeFunctionResult } = await import('viem');
  const plain = await timed(async () => {
    const [, , results] = decodeFunctionResult({ abi, functionName: 'tryBlockAndAggregate', data });
    return results.length;
  });
  console.log(`note plain viem decode of the ${name} worst case: ${plain.outcome} results, ${cost(plain)}`);
}

// Inner calls that failed still decode: an answer shorter than the honest one, and one whose failed
// call carries a revert reason.
const allFailed = wire.encodeArbitrumResult(UNIVERSE, {
  l1BlockNumber: 23_456_789n,
  chainId: BigInt(ARBITRUM_CHAIN_ID),
  blockTimestamp: NOW,
  l2BlockNumber: 391_234_567n,
  sequencer: null,
  reads: UNIVERSE.map(() => ({ round: null, decimals: null, oraclePaused: null })),
});
const feedsFailed = await chain.readArbitrum('https://arbitrum.invalid', 'latest', UNIVERSE, answering(allFailed));
check(
  'readArbitrum accepts an answer whose sequencer and feed calls all failed',
  feedsFailed.ok === true &&
    feedsFailed.answer.sequencer === null &&
    feedsFailed.answer.reads.every((r) => r.round === null),
  `${bytesOf(allFailed)} bytes`,
);

// Every inner call reverted with a reason of one word: the longest answer the limit is meant to hold.
const { encodeFunctionResult } = await import('viem');
const REVERT_REASON = `0x08c379a0${word(0x20)}${word(18)}${Buffer.from('Feed is not usable').toString('hex').padEnd(64, '0')}`;
const reverted = (count) =>
  encodeFunctionResult({
    abi: wire.multicallAbi,
    functionName: 'tryBlockAndAggregate',
    result: [1n, `0x${word(0)}`, Array.from({ length: count }, () => ({ success: false, returnData: REVERT_REASON }))],
  });
if (hasBounds) {
  for (const [name, count, max] of [
    ['Arbitrum', arbitrumCalls, arbitrumMax],
    ['Robinhood', snapshotCalls, snapshotMax],
  ]) {
    const answer = reverted(count);
    check(
      `a ${name} answer whose ${count} calls all reverted with a reason fits the limit`,
      wire.multicallResultProblem(answer, count, max) === null,
      `${bytesOf(answer)} of ${max} bytes: ${String(wire.multicallResultProblem(answer, count, max))}`,
    );
  }
}
const allReverted = await chain.readArbitrum(
  'https://arbitrum.invalid',
  'latest',
  UNIVERSE,
  answering(reverted(arbitrumCalls)),
);
check(
  'readArbitrum decodes that answer and refuses it only for its missing chain ID',
  isMalformed(allReverted) && wire.decodeArbitrumResult(UNIVERSE, reverted(arbitrumCalls)).chainId === null,
  show(allReverted),
);

// --- 3. the real endpoints, only when asked: `--live` ---------------------------------------------
//
// One read-only `eth_call` to each public endpoint of both chains (six requests), through the same
// `readSnapshot` and `readArbitrum`. It proves that what the real multicall contracts answer passes
// the checks above, and that no endpoint needs a redirect to answer, the snapshot's reads or the data
// reads (nine more requests: three to each public Robinhood endpoint). An endpoint this machine cannot
// reach at all (`network` or `timeout`: no answer was read) is skipped, not failed, but each chain
// needs one endpoint that answered.
if (process.argv.includes('--live')) {
  const { ARBITRUM_OFFICIAL_RPC_URL, ARBITRUM_CONFIRMING_RPC_URLS } = contracts;
  /** `fetch`, keeping the `result` of the last answer and the status. */
  const seen = { status: null, result: null };
  const recording = async (input, init) => {
    seen.status = null;
    seen.result = null;
    const response = await fetch(input, init);
    seen.status = response.status;
    try {
      seen.result = (await response.clone().json()).result ?? null;
    } catch {
      // Not JSON: the read says what it made of it.
    }
    return response;
  };
  const host = (url) => new URL(url).host;
  console.log(`live reads at ${new Date().toISOString()}`);

  async function live(name, urls, read, calls, max, blockOf) {
    let answered = 0;
    for (const url of urls) {
      const outcome = await read(url);
      if (!outcome.ok && (outcome.failure.kind === 'network' || outcome.failure.kind === 'timeout')) {
        console.log(`skip live ${name} read from ${host(url)}: not reachable from here, ${show(outcome.failure)}`);
        continue;
      }
      const problem =
        typeof seen.result === 'string' && hasBounds
          ? wire.multicallResultProblem(seen.result, calls, max)
          : 'no result';
      if (outcome.ok) answered += 1;
      check(
        `live ${name} read from ${host(url)}`,
        outcome.ok === true && problem === null,
        outcome.ok
          ? `HTTP ${seen.status}, ${bytesOf(seen.result)} of ${max} bytes, block ${blockOf(outcome)}`
          : `HTTP ${seen.status}, ${show(outcome.failure)}, check: ${String(problem)}`,
      );
    }
    check(`at least one live ${name} endpoint answered`, answered > 0, `${answered} of ${urls.length}`);
  }

  await live(
    'Robinhood',
    chain.PUBLIC_RPC_URLS,
    (url) => chain.readSnapshot(url, UNIVERSE, recording),
    snapshotCalls,
    snapshotMax,
    (outcome) => outcome.reads.blockNumber,
  );
  await live(
    'Arbitrum',
    [ARBITRUM_OFFICIAL_RPC_URL, ...ARBITRUM_CONFIRMING_RPC_URLS],
    (url) => chain.readArbitrum(url, 'latest', UNIVERSE, recording),
    arbitrumCalls,
    arbitrumMax,
    (outcome) => outcome.answer.l2BlockNumber,
  );

  // The data reads, each as the product sends it, with `redirect: 'manual'` whatever the reader says:
  // an endpoint that needs a redirect to answer one of them would show a 3xx here. What the reader
  // makes of the answer is not the point (a third-party endpoint alone is never believed).
  const statuses = [];
  const manual = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'manual' });
    statuses.push(response.status);
    return response;
  };
  for (const url of chain.PUBLIC_RPC_URLS) {
    statuses.length = 0;
    await failedWith(() =>
      rpcModule.createRpc([url], manual).batch([
        { method: 'eth_blockNumber', params: [] },
        { method: 'eth_getCode', params: [stock.tokenAddress, 'latest'] },
      ]),
    );
    await createWalletActivityReader({ rpcUrls: [url], fetch: manual }).headBlock();
    await failedWith(() =>
      createTokenChainReader([url], manual).readBalances(stock.tokenAddress, [wire.MULTICALL3_ADDRESS]),
    );
    if (statuses.length === 0) {
      console.log(`skip live data reads from ${host(url)}: not reachable from here`);
      continue;
    }
    check(
      `live data reads from ${host(url)} (createRpc, wallet reader, balance reader) need no redirect`,
      statuses.length === 3 && statuses.every((status) => status === 200),
      `HTTP ${statuses.join(', ')}`,
    );
  }
}

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
