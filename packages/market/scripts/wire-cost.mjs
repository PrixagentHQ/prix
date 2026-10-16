// What a snapshot costs in encoding and decoding (packages/market/src/wire.ts), counted and timed on
// the real code of packages/market. No network: `fetch` is a function in this file that answers from
// memory. Never deployed.
//
//   node packages/market/scripts/wire-cost.mjs [--runs 500]
//
// Why: the alarm of a free-plan Worker has 10 ms of CPU, and tools/perf/stage2-tick.mjs measured most
// of the heaviest step in the encoding of the same calldata for every request. So:
//
// 1. The calldata of a chain's read is encoded once per universe (and sequencer feed), not once per
//    request: after the first snapshot of the process, a snapshot encodes nothing.
// 2. An answer is decoded once when two endpoints returned the same bytes, and once each when they
//    did not.
// 3. Neither changes a byte of what is sent: every request body is compared with the body built from
//    the plain encoders, and a digest of all of them is printed, with a digest of the snapshot, to set
//    against the same lines of a run on the code before the change.
//
// Counting: viem is given to wire.ts through scripts/wire-cost-viem.mjs, which counts the calls of
// `encodeFunctionData` for a whole read and of `decodeFunctionResult`. Nothing in src/ is touched.
//
// Exit code 1 when a count or a byte is not as above. Times are printed, never asserted.

import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

const WIRE_URL = new URL('../src/wire.ts', import.meta.url).href;
const COUNTED_VIEM_URL = new URL('./wire-cost-viem.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'viem' && context.parentURL === WIRE_URL) return { url: COUNTED_VIEM_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { counts, resetCounts } = await import('./wire-cost-viem.mjs');
const contracts = await import('@prix/contracts');
const chain = await import('../src/chain.ts');
const wire = await import('../src/wire.ts');
const { createMarketWith } = await import('../src/market.ts');
const { ARBITRUM_SEQUENCER_FEED, UNIVERSE } = await import('../src/universe.ts');

const { ARBITRUM_CHAIN_ID, ARBITRUM_CONFIRMING_RPC_URLS, ARBITRUM_OFFICIAL_RPC_URL, CHAIN_ID, feedChainOf } = contracts;

const runsAt = process.argv.indexOf('--runs');
const RUNS = runsAt === -1 ? 500 : Number(process.argv[runsAt + 1]);
if (!Number.isSafeInteger(RUNS) || RUNS < 1) {
  console.error('Usage: node packages/market/scripts/wire-cost.mjs [--runs 500]');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
}
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const plain = (value) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? `${v}n` : v));

// --- the endpoints, as the Worker lists them with a keyed RPC_URL ---------------------------------

const KEYED = 'https://keyed.wire-cost.invalid/v1/x'; // a made-up name; never resolved, never asked
const robinhoodUrls = chain.rpcEndpoints(KEYED);
const arbitrumUrls = [ARBITRUM_OFFICIAL_RPC_URL, ...ARBITRUM_CONFIRMING_RPC_URLS];
if (robinhoodUrls.length !== 4 || arbitrumUrls.length !== 3) throw new Error('Unexpected endpoint lists.');

// --- the two chains, from memory -------------------------------------------------------------------

const NOW = new Date('2026-10-09T15:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const L2_BLOCK = 391_234_567n;

function reads(change = {}) {
  return UNIVERSE.map((token, index) => ({
    round: {
      answer: BigInt(Math.round((50 + index * 37.37) * 1e8 * (change[token.symbol] ?? 1))),
      updatedAt: BigInt(NOW_SECONDS - 60),
    },
    decimals: token.feedDecimals,
    oraclePaused: token.kind === 'stock' ? false : null,
  }));
}

const robinhoodAnswer = (blockNumber) =>
  wire.encodeSnapshotResult(UNIVERSE, {
    blockNumber,
    blockTimestamp: BigInt(NOW_SECONDS - 2),
    chainId: BigInt(CHAIN_ID),
    reads: reads(),
  });
const arbitrumAnswer = (change) =>
  wire.encodeArbitrumResult(UNIVERSE, {
    l1BlockNumber: 23_456_789n,
    chainId: BigInt(ARBITRUM_CHAIN_ID),
    blockTimestamp: BigInt(NOW_SECONDS - 2),
    l2BlockNumber: L2_BLOCK,
    sequencer: { answer: 0n, startedAt: BigInt(NOW_SECONDS - 30 * 86_400) },
    reads: reads(change),
  });

const bodyOf = (result) => JSON.stringify({ jsonrpc: '2.0', id: 1, result });
/** What an endpoint says when it answers: `ok`, or `other`, the same feeds in other bytes. */
const ANSWERS = {
  robinhood: { ok: bodyOf(robinhoodAnswer(4_242_424n)), other: bodyOf(robinhoodAnswer(4_242_425n)) },
  arbitrum: { ok: bodyOf(arbitrumAnswer({})), other: bodyOf(arbitrumAnswer({ SOL: 1.5 })) },
};

/** The request each chain must get, built with the plain encoders: the bytes the product sent before. */
const expectedCalldata = {
  robinhood: wire.encodeSnapshotCall(UNIVERSE),
  arbitrum: wire.encodeArbitrumCall(UNIVERSE, ARBITRUM_SEQUENCER_FEED.address),
};
const expectedBody = (kind, tag) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      { to: kind === 'robinhood' ? wire.MULTICALL_ADDRESS : wire.MULTICALL3_ADDRESS, data: expectedCalldata[kind] },
      tag,
    ],
  });

/**
 * A `fetch` that answers from memory. `modes` gives each endpoint, in list order, what it does:
 * `ok` or `other` (it answers), `http_500` (it never does), or `fail_once:ok` and `fail_once:other`
 * (HTTP 500, then the answer).
 */
function world(modes) {
  const endpoints = new Map();
  for (const [index, url] of robinhoodUrls.entries()) {
    endpoints.set(url, { kind: 'robinhood', mode: modes.robinhood[index], hits: 0 });
  }
  for (const [index, url] of arbitrumUrls.entries()) {
    endpoints.set(url, { kind: 'arbitrum', mode: modes.arbitrum[index], hits: 0 });
  }
  const requests = [];
  return {
    requests,
    reset() {
      requests.length = 0;
      for (const endpoint of endpoints.values()) endpoint.hits = 0;
    },
    fetch: async (input, init) => {
      const url = String(input);
      const endpoint = endpoints.get(url);
      if (endpoint === undefined) throw new Error('A request to an endpoint that is in no list.');
      endpoint.hits += 1;
      requests.push({ url, kind: endpoint.kind, body: init.body, redirect: init.redirect });
      let mode = endpoint.mode;
      if (mode.startsWith('fail_once:')) mode = endpoint.hits === 1 ? 'http_500' : mode.slice('fail_once:'.length);
      if (mode === 'http_500') return new Response('', { status: 500 });
      return new Response(ANSWERS[endpoint.kind][mode], {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

function marketOf(fetchFn) {
  return createMarketWith(
    {
      rpcUrls: robinhoodUrls,
      fetch: fetchFn,
      staleAfterSeconds: 3_600,
      cryptoStaleAfterSecondsBySymbol: { BTC: 3_600, ETH: 3_600, BNB: 3_600, HYPE: 3_600, SOL: 3_600 },
      quietAfterSeconds: 3_600,
      arbitrum: {
        officialRpcUrl: arbitrumUrls[0],
        confirmingRpcUrls: [arbitrumUrls[1], arbitrumUrls[2]],
        sequencerGraceSeconds: 3_600,
      },
    },
    { pause: async () => undefined, log: () => undefined },
  );
}

/** What the counters say since the last reset, by chain. */
function counted() {
  const outer = counts.decodes.get('tryBlockAndAggregate') ?? 0;
  // Only the Arbitrum read asks ArbSys, once in every answer that is decoded.
  const arbitrumDecodes = counts.decodes.get('arbBlockNumber') ?? 0;
  return {
    robinhoodEncodes: counts.outerEncodes.get(wire.MULTICALL_ADDRESS.toLowerCase()) ?? 0,
    arbitrumEncodes: counts.outerEncodes.get(wire.MULTICALL3_ADDRESS.toLowerCase()) ?? 0,
    robinhoodDecodes: outer - arbitrumDecodes,
    arbitrumDecodes,
  };
}

const HEAVIEST = 'most requests with a tick, the confirming endpoints say the same bytes';
const scenarios = [
  {
    name: 'typical: the keyed Robinhood endpoint and the official Arbitrum one answer',
    modes: { robinhood: ['ok', 'ok', 'ok', 'ok'], arbitrum: ['ok', 'ok', 'ok'] },
    requests: { robinhood: 1, arbitrum: 1 },
    decodes: { robinhood: 1, arbitrum: 1 },
  },
  {
    name: HEAVIEST,
    modes: {
      robinhood: ['http_500', 'http_500', 'fail_once:ok', 'fail_once:ok'],
      arbitrum: ['http_500', 'ok', 'ok'],
    },
    requests: { robinhood: 8, arbitrum: 3 },
    // Two answers on each chain, the same bytes twice.
    decodes: { robinhood: 1, arbitrum: 1 },
  },
  {
    name: 'most requests, the confirming endpoints say other bytes (Robinhood a block on, Arbitrum another SOL)',
    modes: {
      robinhood: ['http_500', 'http_500', 'fail_once:ok', 'fail_once:other'],
      arbitrum: ['http_500', 'ok', 'other'],
    },
    requests: { robinhood: 8, arbitrum: 3 },
    decodes: { robinhood: 2, arbitrum: 2 },
  },
  {
    name: 'every endpoint fails at once (11 x HTTP 500)',
    modes: {
      robinhood: ['http_500', 'http_500', 'http_500', 'http_500'],
      arbitrum: ['http_500', 'http_500', 'http_500'],
    },
    requests: { robinhood: 8, arbitrum: 3 },
    decodes: { robinhood: 0, arbitrum: 0 },
  },
];

// --- 1. the first snapshot of the process ----------------------------------------------------------

resetCounts();
{
  const heaviest = scenarios.find((scenario) => scenario.name === HEAVIEST);
  const w = world(heaviest.modes);
  await marketOf(w.fetch).takeSnapshot(NOW);
  const first = counted();
  console.log(`first snapshot of the process ("${HEAVIEST}"): ${plain(first)}`);
  check(
    'the first snapshot encodes the calldata of each chain once',
    first.robinhoodEncodes === 1 && first.arbitrumEncodes === 1,
    `${first.robinhoodEncodes} Robinhood, ${first.arbitrumEncodes} Arbitrum, for ${w.requests.length} requests`,
  );
}

// --- 2. every snapshot after it ----------------------------------------------------------------------

const rows = [];
for (const scenario of scenarios) {
  console.log(`\n${scenario.name}`);
  const w = world(scenario.modes);
  const market = marketOf(w.fetch);

  resetCounts();
  w.reset();
  const snapshot = await market.takeSnapshot(NOW);
  const work = counted();
  const sent = { robinhood: 0, arbitrum: 0 };
  let sameBytes = true;
  let manual = true;
  for (const request of w.requests) {
    sent[request.kind] += 1;
    const tag = JSON.parse(request.body).params[1];
    if (request.body !== expectedBody(request.kind, tag)) sameBytes = false;
    if (request.redirect !== 'manual') manual = false;
  }
  const requestDigest = sha(w.requests.map((r) => `${r.url}\n${r.redirect}\n${r.body}`).join('\n\n'));
  const snapshotDigest = sha(plain(snapshot));
  const unread = snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol);

  check(
    'requests',
    sent.robinhood === scenario.requests.robinhood && sent.arbitrum === scenario.requests.arbitrum,
    `${sent.robinhood} Robinhood + ${sent.arbitrum} Arbitrum`,
  );
  check('every request body is the one the plain encoders build, byte for byte', sameBytes);
  check('every request says redirect: manual', manual);
  check(
    'calldata encoded in this snapshot',
    work.robinhoodEncodes === 0 && work.arbitrumEncodes === 0,
    `${work.robinhoodEncodes} Robinhood + ${work.arbitrumEncodes} Arbitrum (0 + 0 wanted)`,
  );
  check(
    'answers decoded in this snapshot',
    work.robinhoodDecodes === scenario.decodes.robinhood && work.arbitrumDecodes === scenario.decodes.arbitrum,
    `${work.robinhoodDecodes} Robinhood + ${work.arbitrumDecodes} Arbitrum ` +
      `(${scenario.decodes.robinhood} + ${scenario.decodes.arbitrum} wanted)`,
  );
  console.log(
    `     snapshot: open ${snapshot.open}, closedReason ${snapshot.closedReason ?? 'none'}, ` +
      `${snapshot.prices.length} prices, not fresh ${unread.length === 0 ? 'none' : unread.join(' ')}, otherChains ${plain(snapshot.otherChains ?? null)}`,
  );
  console.log(`     digest of the requests ${requestDigest}, of the snapshot ${snapshotDigest}`);

  // Time: the whole of takeSnapshot with every answer from memory. An estimate, not a Worker.
  const one = async () => {
    w.reset();
    await market.takeSnapshot(NOW);
  };
  for (let i = 0; i < 200; i++) await one();
  const samples = [];
  const before = process.cpuUsage();
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await one();
    samples.push(performance.now() - start);
  }
  const used = process.cpuUsage(before);
  samples.sort((a, b) => a - b);
  const row = {
    scenario: scenario.name,
    requests: sent,
    encodes: { robinhood: work.robinhoodEncodes, arbitrum: work.arbitrumEncodes },
    decodes: { robinhood: work.robinhoodDecodes, arbitrum: work.arbitrumDecodes },
    cpuMeanMs: (used.user + used.system) / 1000 / RUNS,
    wallMedianMs: samples[Math.floor(samples.length / 2)],
    wallP99Ms: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))],
    requestDigest,
    snapshotDigest,
  };
  rows.push(row);
  console.log(
    `     takeSnapshot, ${RUNS} runs: ${row.cpuMeanMs.toFixed(2)} ms of CPU mean, ` +
      `${row.wallMedianMs.toFixed(2)} ms median, ${row.wallP99Ms.toFixed(2)} ms at the 99th percentile. ESTIMATE.`,
  );
}

// --- 3. the calldata follows the universe and the sequencer feed -------------------------------------

console.log('\nthe calldata of a read follows what it is asked for');
{
  const sentData = [];
  const capture = async (_input, init) => {
    sentData.push(JSON.parse(init.body).params[0].data);
    return new Response('', { status: 500 });
  };
  const robinhoodOnly = UNIVERSE.filter((token) => feedChainOf(token) === CHAIN_ID);
  const universe = robinhoodOnly.slice(0, 5);
  await chain.readSnapshot(KEYED, universe, capture);
  await chain.readSnapshot(KEYED, universe, capture);
  // The same array, changed in place: the next request must carry the new content.
  universe[0] = robinhoodOnly[7];
  const changed = wire.encodeSnapshotCall(universe);
  await chain.readSnapshot(KEYED, universe, capture);
  await chain.readSnapshot(KEYED, UNIVERSE, capture);
  check(
    'readSnapshot sends the calldata of the universe it is given, also after the array changed in place',
    sentData[0] === wire.encodeSnapshotCall(robinhoodOnly.slice(0, 5)) &&
      sentData[1] === sentData[0] &&
      sentData[2] === changed &&
      sentData[2] !== sentData[0] &&
      sentData[3] === expectedCalldata.robinhood,
  );

  sentData.length = 0;
  const otherFeed = '0x00000000000000000000000000000000000000aa';
  await chain.readArbitrum(KEYED, 'latest', UNIVERSE, capture);
  await chain.readArbitrum(KEYED, 'latest', UNIVERSE, capture, 4_000, otherFeed);
  await chain.readArbitrum(KEYED, 5n, UNIVERSE, capture);
  check(
    'readArbitrum sends the calldata of the sequencer feed it is given',
    sentData[0] === expectedCalldata.arbitrum &&
      sentData[1] === wire.encodeArbitrumCall(UNIVERSE, otherFeed) &&
      sentData[1] !== sentData[0] &&
      sentData[2] === expectedCalldata.arbitrum,
  );
}

// --- 4. what one call costs here ----------------------------------------------------------------------

function bench(run) {
  for (let i = 0; i < 200; i++) run();
  const before = process.cpuUsage();
  for (let i = 0; i < 1_000; i++) run();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000 / 1_000;
}
const robinhoodResult = JSON.parse(ANSWERS.robinhood.ok).result;
const arbitrumResult = JSON.parse(ANSWERS.arbitrum.ok).result;
const cost = {
  encodeSnapshotCall: bench(() => wire.encodeSnapshotCall(UNIVERSE)),
  decodeSnapshotResult: bench(() => wire.decodeSnapshotResult(UNIVERSE, robinhoodResult)),
  encodeArbitrumCall: bench(() => wire.encodeArbitrumCall(UNIVERSE, ARBITRUM_SEQUENCER_FEED.address)),
  decodeArbitrumResult: bench(() => wire.decodeArbitrumResult(UNIVERSE, arbitrumResult)),
};
console.log(
  `\none call of the plain encoders and decoders, mean of 1,000: ${Object.entries(cost)
    .map(([name, ms]) => `${name} ${ms.toFixed(2)} ms`)
    .join(', ')}. ESTIMATE.`,
);

console.log(`\nJSON ${JSON.stringify({ node: process.version, runs: RUNS, cost, rows })}`);
console.log(failures === 0 ? '\nPASS' : `\nFAIL: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
