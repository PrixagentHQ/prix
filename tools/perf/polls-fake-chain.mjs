// The fake chain of gate 3 (docs/contracts/phase-6-holders.md revision 8f, section 25 perf's row), shared by
// tools/perf/polls-tally.mjs (Node) and tools/perf/polls-tally-worker (local workerd). Plain JavaScript with no
// import, so both can load it; the market's wire encoder is handed in.
//
// What it does, as qa's fake does (section 5, qa's case; revision 8c CR8B-1, 8d CR8C-2):
// - three endpoints at the URLs of PUBLIC_RPC_URLS (official, publicnode, dRPC), each answering an `eth_call`
//   of the lean tryBlockAndAggregate with the market's own result encoder;
// - every answer comes after `latencyMs` of the real clock (setTimeout), and a fetch whose signal aborts rejects;
// - the head advances `blocksPerSecond` blocks a second of the real clock from the run's first fetch;
// - the publicnode-shaped endpoint answers HTTP 403 to a block tag more than `keylessStateBlocks` behind the head,
//   judged when it receives the request;
// - the official endpoint's behaviour is the scenario's: 'answer', '429', 'never' (a fetch that never resolves
//   until its signal aborts) or 'slow' (answers correctly after `slowMs`);
// - `publicnodeSlowCall`, when set, makes publicnode answer its n-th call (1-based) after `slowMs`.
// Nothing here reaches a network.

const OFFICIAL = 'rpc.mainnet.chain.robinhood.com';
const PUBLICNODE = 'robinhood-rpc.publicnode.com';
const DRPC = 'robinhood.drpc.org';

export const FAKE_HOSTS = { official: OFFICIAL, publicnode: PUBLICNODE, drpc: DRPC };

/**
 * @param {object} o
 * @param {object} o.wire the market's token-wire module (encodeTokenCallLean, encodeTokenResult)
 * @param {string} o.token the token's address
 * @param {bigint} o.holds each wallet's balance in the answer
 * @param {bigint} o.supply the total supply
 * @param {bigint} o.head0 the head at the run's first fetch
 * @param {number} o.latencyMs every answer's delay
 * @param {number} o.blocksPerSecond the head's speed (0 for a head that stands)
 * @param {number} o.keylessStateBlocks publicnode's window
 * @param {string} o.official 'answer' | '429' | 'never' | 'slow'
 * @param {number} [o.slowMs]
 * @param {number|null} [o.publicnodeSlowCall]
 * @param {() => number} o.realNow milliseconds of the real clock
 * @param {() => number} o.chainSeconds the block timestamp to answer (the run's clock, in seconds)
 */
export function makeFakeChain(o) {
  const sent = { total: 0, byHost: {}, other: 0, refusedByFake: 0 };
  const lean1 = o.wire.encodeTokenCallLean(o.token, ['0x0000000000000000000000000000000000000001']).length;
  const lean2 = o.wire.encodeTokenCallLean(o.token, [
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000002',
  ]).length;
  const perWallet = lean2 - lean1;
  const answers = new Map();
  let t0 = null;
  let publicnodeCalls = 0;
  const headNow = () => {
    if (t0 === null) return o.head0;
    return o.head0 + BigInt(Math.floor(((o.realNow() - t0) * o.blocksPerSecond) / 1000));
  };
  const answerFor = (n, blockNumber) => {
    const key = `${n}:${blockNumber}`;
    let hex = answers.get(key);
    if (hex === undefined) {
      hex = o.wire.encodeTokenResult({
        blockNumber,
        blockTimestamp: BigInt(Math.floor(o.chainSeconds()) - 2),
        totalSupply: o.supply,
        decimals: 18,
        balances: Array.from({ length: n }, () => o.holds),
      });
      answers.set(key, hex);
    }
    return hex;
  };
  /** Waits `ms` of the real clock, or rejects when the signal aborts. */
  const wait = (ms, signal) =>
    new Promise((resolveWait, rejectWait) => {
      if (signal?.aborted) return rejectWait(signal.reason ?? new Error('aborted'));
      const timer = ms === Infinity ? null : setTimeout(resolveWait, ms);
      signal?.addEventListener('abort', () => {
        if (timer !== null) clearTimeout(timer);
        rejectWait(signal.reason ?? new Error('aborted'));
      });
    });
  const json = (id, result) =>
    new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":"${result}"}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  async function fetchFn(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    if (host !== OFFICIAL && host !== PUBLICNODE && host !== DRPC) {
      sent.other += 1;
      throw new Error(`perf fake chain: a fetch to ${host}, which the step must not make`);
    }
    if (t0 === null) t0 = o.realNow();
    sent.total += 1;
    sent.byHost[host] = (sent.byHost[host] ?? 0) + 1;
    const signal = init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined);
    const text = typeof init?.body === 'string' ? init.body : await new Request(input, init).text();
    const body = JSON.parse(text);
    if (Array.isArray(body) || body.method !== 'eth_call') {
      sent.refusedByFake += 1;
      throw new Error(`perf fake chain: asked ${Array.isArray(body) ? 'a batch' : body.method}`);
    }
    const [call, tag] = body.params;
    const n = 1 + (call.data.length - lean1) / perWallet;
    if (!Number.isInteger(n) || n < 1) throw new Error('perf fake chain: calldata is not a lean balance read');
    // Judged when the request is received (CR8D-2).
    const head = headNow();
    const blockNumber = tag === undefined || tag === 'latest' ? head : BigInt(tag);
    let delay = o.latencyMs;
    if (host === OFFICIAL) {
      if (o.official === 'never') {
        await wait(Infinity, signal);
        throw new Error('unreachable');
      }
      if (o.official === '429') {
        await wait(delay, signal);
        return new Response('{"error":"rate limited"}', { status: 429 });
      }
      if (o.official === 'slow') delay = o.slowMs;
    }
    if (host === PUBLICNODE) {
      publicnodeCalls += 1;
      if (o.publicnodeSlowCall != null && publicnodeCalls === o.publicnodeSlowCall) delay = o.slowMs;
      if (head - blockNumber > BigInt(o.keylessStateBlocks)) {
        await wait(delay, signal);
        return new Response('{"error":"state not served"}', { status: 403 });
      }
    }
    if (blockNumber > head) {
      await wait(delay, signal);
      return new Response(
        `{"jsonrpc":"2.0","id":${JSON.stringify(body.id)},"error":{"code":-32000,"message":"header not found"}}`,
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const hex = answerFor(n, blockNumber);
    await wait(delay, signal);
    return json(body.id, hex);
  }

  /** Builds every answer a run at the standing head can ask for, so a replay's CPU holds no encoding. */
  function warm(pages, margin) {
    for (const n of pages) {
      answerFor(n, o.head0);
      answerFor(n, o.head0 - BigInt(margin));
    }
  }

  return { fetch: fetchFn, sent, warm, head: headNow };
}
