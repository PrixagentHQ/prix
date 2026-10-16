import type { MarketEndpointFailure, MarketSnapshot, UniverseToken } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  FEED_STALE_AFTER_SECONDS,
  MARKET_QUIET_AFTER_SECONDS,
} from '@prix/contracts';
import { ARBITRUM_SEQUENCER_FEED, PUBLIC_RPC_URLS, UNIVERSE } from '@prix/market';
import * as chain from '@prix/market/chain';
import { createMarketWith } from '@prix/market/market';
import * as wire from '@prix/market/wire';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARB_L2_BLOCK,
  ARB_OFFICIAL,
  ARB_PAIR_ONE,
  ARB_PAIR_TWO,
  isArbitrumUrl,
  robinhoodFailures,
  TEST_ARBITRUM,
} from '../support/fake-arbitrum.ts';
import { TEST_PRICES } from '../support/fixtures.ts';
import { arbitrumReadOf, NOW, pointOf, ROBINHOOD_URL, type Scene, scene } from './support.ts';

/**
 * The market read encodes each chain's calldata once for a universe and decodes an answer that two
 * endpoints of one snapshot give in the same bytes once (docs/CONTRACTS.md sections 20 and 23; an
 * alarm has 10 ms of CPU). Neither may change a byte of a request or anything a snapshot says, so
 * every request is compared with a fresh encode and every result with a read that keeps nothing.
 *
 * viem is counted, not replaced: the two functions that build the calldata of a whole read and decode
 * a whole answer pass through a counter in front of the real ones. The fakes reach viem by a path of
 * their own and build no `tryBlockAndAggregate` calldata, so the counts are the market's alone.
 */

type Hex = `0x${string}`;

const seen = vi.hoisted(() => ({
  /** One entry per calldata of a whole read that viem built: the target of its first inner call. */
  outerEncodes: [] as string[],
  /** One entry per whole answer that viem decoded: the bytes. */
  outerDecodes: [] as string[],
}));

vi.mock('../../packages/market/node_modules/viem/_esm/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  type Viem = (parameters: { functionName?: unknown; args?: unknown; data?: unknown }) => unknown;
  const encode = actual.encodeFunctionData as Viem;
  const decode = actual.decodeFunctionResult as Viem;
  const counted: Record<string, unknown> = {
    ...actual,
    encodeFunctionData: ((parameters) => {
      if (parameters.functionName === 'tryBlockAndAggregate') {
        const calls = (parameters.args as [boolean, { target: string }[]])[1];
        seen.outerEncodes.push(String(calls[0]?.target).toLowerCase());
      }
      return encode(parameters);
    }) satisfies Viem,
    decodeFunctionResult: ((parameters) => {
      if (parameters.functionName === 'tryBlockAndAggregate') seen.outerDecodes.push(String(parameters.data));
      return decode(parameters);
    }) satisfies Viem,
  };
  return counted;
});

beforeEach(() => {
  seen.outerEncodes.length = 0;
  seen.outerDecodes.length = 0;
});

const OTHER_SEQUENCER_FEED = '0x00000000000000000000000000000000000005e9';
const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];

const norm = (url: string): string => url.trim().replace(/\/+$/, '');

/** The kept calldata of both chains is forgotten: the next call of either has to encode. */
function forget(): void {
  wire.snapshotCalldata([]);
  wire.arbitrumCalldata([], '0x00000000000000000000000000000000000000ff');
  seen.outerEncodes.length = 0;
}

interface Sent {
  url: string;
  init: RequestInit | undefined;
  /** The parsed request, when the body was JSON. */
  call: { params: [{ to: string; data: string }, string] };
  /** The `result` of the answer, when there was one. */
  result: string | null;
}

/** A `fetch` in front of `inner` that keeps every request exactly as it was given, and its answer. */
function recording(inner: typeof fetch): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const entry: Sent = {
      url: norm(String(input)),
      init,
      call: JSON.parse(String(init?.body)) as Sent['call'],
      result: null,
    };
    sent.push(entry);
    const response = await inner(input, init);
    if (response.status !== 200) return response;
    const text = await response.text();
    try {
      const result = (JSON.parse(text) as { result?: unknown }).result;
      entry.result = typeof result === 'string' ? result : null;
    } catch {
      entry.result = null;
    }
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fetchFn, sent };
}

/** A `fetch` in front of `inner` whose every multicall answer has `padBytes` zero bytes after it. */
function padding(inner: typeof fetch, padBytes: number): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const answer = (await response.json()) as { result: string };
    return new Response(JSON.stringify({ ...answer, result: `${answer.result}${'00'.repeat(padBytes)}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function snapshotBody(universe: readonly UniverseToken[]): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: wire.MULTICALL_ADDRESS, data: wire.encodeSnapshotCall(universe) }, 'latest'],
  });
}

function arbitrumBody(universe: readonly UniverseToken[], feed: string, tag: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: wire.MULTICALL3_ADDRESS, data: wire.encodeArbitrumCall(universe, feed) }, tag],
  });
}

const MALFORMED = { ok: false, failure: { kind: 'malformed' } };

describe('the calldata of the Robinhood read, encoded once (wire.ts)', () => {
  const stocks = UNIVERSE.slice(0, 5);
  const coins = UNIVERSE.slice(-5);

  it('is the plain encoding for the universe, a subset and an empty universe', () => {
    for (const universe of [UNIVERSE, stocks, coins, [], UNIVERSE, stocks]) {
      expect(wire.snapshotCalldata(universe)).toBe(wire.encodeSnapshotCall(universe));
    }
  });

  it('gives a second universe its own calldata', () => {
    const first = wire.snapshotCalldata(UNIVERSE);
    const second = wire.snapshotCalldata(stocks);
    expect(second).not.toBe(first);
    expect(second).toBe(wire.encodeSnapshotCall(stocks));
    expect(wire.snapshotCalldata(UNIVERSE)).toBe(first);
  });

  it('encodes again when the same array is changed in place', () => {
    const universe: UniverseToken[] = UNIVERSE.slice(0, 4);
    const before = wire.snapshotCalldata(universe);
    universe[0] = UNIVERSE[10] as UniverseToken;
    const replaced = wire.snapshotCalldata(universe);
    expect(replaced).toBe(wire.encodeSnapshotCall(universe));
    expect(replaced).not.toBe(before);

    universe.pop();
    const shorter = wire.snapshotCalldata(universe);
    expect(shorter).toBe(wire.encodeSnapshotCall(universe));
    expect(shorter).not.toBe(replaced);

    // An entry of the array changed in place: another feed behind the same symbol.
    const entry = { ...(universe[1] as UniverseToken) };
    universe[1] = entry;
    const withCopy = wire.snapshotCalldata(universe);
    (entry as { feedAddress: string }).feedAddress = (UNIVERSE[12] as UniverseToken).feedAddress;
    const otherFeed = wire.snapshotCalldata(universe);
    expect(otherFeed).toBe(wire.encodeSnapshotCall(universe));
    expect(otherFeed).not.toBe(withCopy);
  });

  it('does not build the calldata again for the same content', () => {
    forget();
    const first = wire.snapshotCalldata(UNIVERSE);
    expect(seen.outerEncodes).toHaveLength(1);
    expect(wire.snapshotCalldata(UNIVERSE)).toBe(first);
    // Another array that says the same.
    expect(wire.snapshotCalldata([...UNIVERSE])).toBe(first);
    expect(seen.outerEncodes).toHaveLength(1);
    // The counter does see an encode: the plain encoder builds it every time.
    expect(wire.encodeSnapshotCall(UNIVERSE)).toBe(first);
    expect(seen.outerEncodes).toHaveLength(2);
    // Other content is encoded, and then the first again.
    wire.snapshotCalldata(stocks);
    wire.snapshotCalldata(UNIVERSE);
    expect(seen.outerEncodes).toHaveLength(4);
  });
});

describe('the calldata of the Arbitrum read, encoded once (wire.ts)', () => {
  const feed = ARBITRUM_SEQUENCER_FEED.address;

  it('is the plain encoding for two sequencer feeds in alternation', () => {
    const plain = [wire.encodeArbitrumCall(UNIVERSE, feed), wire.encodeArbitrumCall(UNIVERSE, OTHER_SEQUENCER_FEED)];
    expect(plain[0]).not.toBe(plain[1]);
    for (let round = 0; round < 3; round++) {
      expect(wire.arbitrumCalldata(UNIVERSE, feed)).toBe(plain[0]);
      expect(wire.arbitrumCalldata(UNIVERSE, OTHER_SEQUENCER_FEED)).toBe(plain[1]);
    }
  });

  it('is the plain encoding for a subset and an empty universe, and its own for each', () => {
    const one = UNIVERSE.filter((token) => token.symbol !== 'SOL');
    const all = wire.arbitrumCalldata(UNIVERSE, feed);
    for (const universe of [one, [], UNIVERSE, one]) {
      expect(wire.arbitrumCalldata(universe, feed)).toBe(wire.encodeArbitrumCall(universe, feed));
    }
    expect(wire.arbitrumCalldata(one, feed)).not.toBe(all);
  });

  it('encodes again when the same array is changed in place', () => {
    const universe: UniverseToken[] = [...UNIVERSE];
    const before = wire.arbitrumCalldata(universe, feed);
    // The last entry is read on Arbitrum One (the order of the contract: BTC, ETH, BNB, HYPE, SOL).
    universe.pop();
    const after = wire.arbitrumCalldata(universe, feed);
    expect(after).toBe(wire.encodeArbitrumCall(universe, feed));
    expect(after).not.toBe(before);
  });

  it('does not build the calldata again for the same content', () => {
    forget();
    const first = wire.arbitrumCalldata(UNIVERSE, feed);
    expect(seen.outerEncodes).toHaveLength(1);
    expect(wire.arbitrumCalldata(UNIVERSE, feed)).toBe(first);
    expect(wire.arbitrumCalldata([...UNIVERSE], feed)).toBe(first);
    expect(seen.outerEncodes).toHaveLength(1);
    expect(wire.encodeArbitrumCall(UNIVERSE, feed)).toBe(first);
    expect(seen.outerEncodes).toHaveLength(2);
  });

  it('keeps the two chains apart: one does not push out the other', () => {
    forget();
    const robinhood = wire.snapshotCalldata(UNIVERSE);
    const arbitrum = wire.arbitrumCalldata(UNIVERSE, feed);
    expect(arbitrum).not.toBe(robinhood);
    expect(wire.snapshotCalldata(UNIVERSE)).toBe(robinhood);
    expect(wire.arbitrumCalldata(UNIVERSE, feed)).toBe(arbitrum);
    expect(seen.outerEncodes).toHaveLength(2);
  });
});

describe('one Robinhood read (readSnapshot in chain.ts)', () => {
  it('sends exactly the plain eth_call, with redirect manual', async () => {
    const wireOf = recording(scene().rpc.fetch);
    const stocks = UNIVERSE.slice(0, 5);
    expect((await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, wireOf.fetch)).ok).toBe(true);
    await chain.readSnapshot(ROBINHOOD_URL, stocks, wireOf.fetch);
    expect((await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, wireOf.fetch)).ok).toBe(true);
    expect(wireOf.sent.map((request) => request.init?.body)).toEqual([
      snapshotBody(UNIVERSE),
      snapshotBody(stocks),
      snapshotBody(UNIVERSE),
    ]);
    for (const request of wireOf.sent) {
      expect(request.init?.redirect).toBe('manual');
      expect(request.init?.method).toBe('POST');
    }
  });

  it('decodes the same bytes once with one createDecodedAnswers, and says what a read without it says', async () => {
    const s = scene();
    const plain = await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, s.rpc.fetch);
    expect(plain.ok).toBe(true);
    expect(seen.outerDecodes).toHaveLength(1);

    seen.outerDecodes.length = 0;
    const decoded = chain.createDecodedAnswers();
    const first = await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, s.rpc.fetch, undefined, decoded);
    const second = await chain.readSnapshot(OFFICIAL, UNIVERSE, s.rpc.fetch, undefined, decoded);
    expect(seen.outerDecodes).toHaveLength(1);
    expect(first).toEqual(plain);
    expect(second).toEqual(plain);
  });

  it('decodes the same bytes twice without it', async () => {
    const s = scene();
    await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, s.rpc.fetch);
    await chain.readSnapshot(OFFICIAL, UNIVERSE, s.rpc.fetch);
    expect(seen.outerDecodes).toHaveLength(2);
    expect(seen.outerDecodes[0]).toBe(seen.outerDecodes[1]);
  });

  it('decodes other bytes again, and gives the second answer, not the first', async () => {
    const s = scene();
    const decoded = chain.createDecodedAnswers();
    const first = await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, s.rpc.fetch, undefined, decoded);
    s.setFeed('AAPL', { answer: 1_234_500_000n });
    const second = await chain.readSnapshot(OFFICIAL, UNIVERSE, s.rpc.fetch, undefined, decoded);
    expect(seen.outerDecodes).toHaveLength(2);
    expect(second).toEqual(await chain.readSnapshot(OFFICIAL, UNIVERSE, s.rpc.fetch));
    expect(second).not.toEqual(first);
  });

  it('decodes the same bytes again for another universe array', async () => {
    const s = scene();
    const decoded = chain.createDecodedAnswers();
    const first = await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, s.rpc.fetch, undefined, decoded);
    const second = await chain.readSnapshot(ROBINHOOD_URL, [...UNIVERSE], s.rpc.fetch, undefined, decoded);
    expect(seen.outerDecodes).toHaveLength(2);
    expect(seen.outerDecodes[0]).toBe(seen.outerDecodes[1]);
    expect(second).toEqual(first);
  });

  it('calls a malformed answer malformed both times', async () => {
    const short = scene();
    short.rpc.setMode(ROBINHOOD_URL, 'short_answer');
    const otherChain = scene();
    otherChain.rpc.chainId = 1;
    for (const s of [short, otherChain]) {
      const decoded = chain.createDecodedAnswers();
      expect(await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, s.rpc.fetch, undefined, decoded)).toEqual(MALFORMED);
      expect(await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, s.rpc.fetch, undefined, decoded)).toEqual(MALFORMED);
    }
  });

  it('calls an answer over snapshotResultMaxBytes malformed and does not keep it', async () => {
    const fetchFn = padding(scene().rpc.fetch, wire.snapshotResultMaxBytes(UNIVERSE));
    const decoded = chain.createDecodedAnswers();
    expect(await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, fetchFn, undefined, decoded)).toEqual(MALFORMED);
    expect(await chain.readSnapshot(ROBINHOOD_URL, UNIVERSE, fetchFn, undefined, decoded)).toEqual(MALFORMED);
    expect(decoded.robinhood).toEqual([]);
    expect(decoded.arbitrum).toEqual([]);
  });
});

describe('one Arbitrum read (readArbitrum in chain.ts)', () => {
  const feed = ARBITRUM_SEQUENCER_FEED.address;

  it('sends exactly the plain eth_call at latest and at a pinned block, with redirect manual', async () => {
    const wireOf = recording(scene().rpc.fetch);
    expect((await chain.readArbitrum(ARB_OFFICIAL, 'latest', UNIVERSE, wireOf.fetch)).ok).toBe(true);
    expect((await chain.readArbitrum(ARB_PAIR_ONE, BigInt(ARB_L2_BLOCK), UNIVERSE, wireOf.fetch)).ok).toBe(true);
    await chain.readArbitrum(ARB_PAIR_TWO, 'latest', UNIVERSE, wireOf.fetch, undefined, OTHER_SEQUENCER_FEED);
    expect((await chain.readArbitrum(ARB_OFFICIAL, 'latest', UNIVERSE, wireOf.fetch)).ok).toBe(true);
    expect(wireOf.sent.map((request) => request.init?.body)).toEqual([
      arbitrumBody(UNIVERSE, feed, 'latest'),
      arbitrumBody(UNIVERSE, feed, `0x${ARB_L2_BLOCK.toString(16)}`),
      arbitrumBody(UNIVERSE, OTHER_SEQUENCER_FEED, 'latest'),
      arbitrumBody(UNIVERSE, feed, 'latest'),
    ]);
    for (const request of wireOf.sent) expect(request.init?.redirect).toBe('manual');
  });

  it('decodes the same bytes once with one createDecodedAnswers, and says what a read without it says', async () => {
    const s = scene();
    const plain = await chain.readArbitrum(ARB_PAIR_ONE, 'latest', UNIVERSE, s.rpc.fetch);
    expect(plain.ok).toBe(true);
    expect(seen.outerDecodes).toHaveLength(1);

    seen.outerDecodes.length = 0;
    const decoded = chain.createDecodedAnswers();
    const pinned = BigInt(ARB_L2_BLOCK);
    const first = await chain.readArbitrum(
      ARB_PAIR_ONE,
      'latest',
      UNIVERSE,
      s.rpc.fetch,
      undefined,
      undefined,
      decoded,
    );
    const second = await chain.readArbitrum(ARB_PAIR_TWO, pinned, UNIVERSE, s.rpc.fetch, undefined, undefined, decoded);
    expect(seen.outerDecodes).toHaveLength(1);
    expect(first).toEqual(plain);
    expect(second).toEqual(plain);
  });

  it('decodes the same bytes twice without it, other bytes twice with it, and another universe array again', async () => {
    const s = scene();
    await chain.readArbitrum(ARB_PAIR_ONE, 'latest', UNIVERSE, s.rpc.fetch);
    await chain.readArbitrum(ARB_PAIR_TWO, 'latest', UNIVERSE, s.rpc.fetch);
    expect(seen.outerDecodes).toHaveLength(2);
    expect(seen.outerDecodes[0]).toBe(seen.outerDecodes[1]);

    seen.outerDecodes.length = 0;
    const decoded = chain.createDecodedAnswers();
    const first = await chain.readArbitrum(
      ARB_PAIR_ONE,
      'latest',
      UNIVERSE,
      s.rpc.fetch,
      undefined,
      undefined,
      decoded,
    );
    const again = await chain.readArbitrum(
      ARB_PAIR_ONE,
      'latest',
      [...UNIVERSE],
      s.rpc.fetch,
      undefined,
      undefined,
      decoded,
    );
    expect(seen.outerDecodes).toHaveLength(2);
    expect(again).toEqual(first);

    s.setFeed('SOL', { answer: 99_900_000_000n });
    const moved = await chain.readArbitrum(
      ARB_PAIR_TWO,
      'latest',
      UNIVERSE,
      s.rpc.fetch,
      undefined,
      undefined,
      decoded,
    );
    expect(seen.outerDecodes).toHaveLength(3);
    expect(moved).toEqual(await chain.readArbitrum(ARB_PAIR_TWO, 'latest', UNIVERSE, s.rpc.fetch));
    expect(moved).not.toEqual(first);
  });

  it('calls a malformed answer malformed both times', async () => {
    const s = scene();
    s.rpc.arbitrum.set({ chainId: 1 });
    const decoded = chain.createDecodedAnswers();
    for (const url of [ARB_PAIR_ONE, ARB_PAIR_TWO]) {
      const outcome = await chain.readArbitrum(url, 'latest', UNIVERSE, s.rpc.fetch, undefined, undefined, decoded);
      expect(outcome, url).toEqual(MALFORMED);
    }
  });

  it('calls an answer over arbitrumResultMaxBytes malformed and does not keep it', async () => {
    const fetchFn = padding(scene().rpc.fetch, wire.arbitrumResultMaxBytes(UNIVERSE));
    const decoded = chain.createDecodedAnswers();
    for (const url of [ARB_PAIR_ONE, ARB_PAIR_TWO]) {
      const outcome = await chain.readArbitrum(url, 'latest', UNIVERSE, fetchFn, undefined, undefined, decoded);
      expect(outcome, url).toEqual(MALFORMED);
    }
    expect(decoded.arbitrum).toEqual([]);
    expect(decoded.robinhood).toEqual([]);
  });
});

/**
 * The step with the most requests (tools/perf/stage2-tick.mjs): the keyed and the official Robinhood
 * endpoint fail twice each, the two fallbacks fail once and then agree (8 requests); the official
 * Arbitrum endpoint fails and the pair agrees at the pinned block (3 requests).
 */
function mostRequests(): {
  s: Scene;
  sent: Sent[];
  failures: MarketEndpointFailure[];
  take(): Promise<MarketSnapshot>;
} {
  const s = scene();
  s.rpc.setMode(ROBINHOOD_URL, 'http_500');
  s.rpc.setMode(OFFICIAL, 'http_500');
  s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
  const hits = new Map<string, number>();
  const failOnce: typeof fetch = async (input, init) => {
    const url = norm(String(input));
    const hit = (hits.get(url) ?? 0) + 1;
    hits.set(url, hit);
    if (hit === 1 && (url === norm(PUBLICNODE) || url === norm(DRPC))) return new Response('later', { status: 500 });
    return s.rpc.fetch(input, init);
  };
  const wireOf = recording(failOnce);
  const failures: MarketEndpointFailure[] = [];
  const market = createMarketWith(
    {
      rpcUrls: [ROBINHOOD_URL, OFFICIAL, PUBLICNODE, DRPC],
      arbitrum: TEST_ARBITRUM,
      staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
      cryptoStaleAfterSecondsBySymbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
      fetch: wireOf.fetch,
      onEndpointFailure: (failure) => failures.push(failure),
    },
    { pause: async () => {}, log: () => {} },
  );
  return { s, sent: wireOf.sent, failures, take: () => market.takeSnapshot(NOW) };
}

describe('a whole snapshot with the most requests (market.ts)', () => {
  it('sends 8 + 3 requests, each chain the same calldata every time, equal to a fresh encode', async () => {
    const most = mostRequests();
    await most.take();
    const robinhood = most.sent.filter((request) => !isArbitrumUrl(request.url));
    const arbitrum = most.sent.filter((request) => isArbitrumUrl(request.url));
    expect(robinhood.map((request) => request.url)).toEqual(
      [ROBINHOOD_URL, ROBINHOOD_URL, OFFICIAL, OFFICIAL, PUBLICNODE, PUBLICNODE, DRPC, DRPC].map(norm),
    );
    expect(arbitrum.map((request) => request.url)).toEqual([ARB_OFFICIAL, ARB_PAIR_ONE, ARB_PAIR_TWO].map(norm));
    expect(arbitrum).toHaveLength(ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT);

    const body = snapshotBody(UNIVERSE);
    for (const request of robinhood) expect(request.init?.body, request.url).toBe(body);
    const feed = ARBITRUM_SEQUENCER_FEED.address;
    expect(arbitrum.map((request) => request.init?.body)).toEqual([
      arbitrumBody(UNIVERSE, feed, 'latest'),
      arbitrumBody(UNIVERSE, feed, 'latest'),
      arbitrumBody(UNIVERSE, feed, `0x${ARB_L2_BLOCK.toString(16)}`),
    ]);
    for (const request of most.sent) expect(request.init?.redirect, request.url).toBe('manual');
  });

  it('gives the snapshot of a step where nothing failed, with the pair named for Arbitrum', async () => {
    const healthy = await scene().take({ rpcUrls: [ROBINHOOD_URL, OFFICIAL, PUBLICNODE, DRPC] });
    const most = mostRequests();
    const snapshot = await most.take();
    expect(snapshot).toMatchObject({ open: true, closedReason: null, blockNumber: healthy.blockNumber });
    expect(snapshot.prices).toEqual(healthy.prices);
    for (const [symbol, price] of Object.entries(TEST_PRICES)) {
      expect(pointOf(snapshot, symbol), symbol).toMatchObject({ priceMicro: price, fresh: true });
    }
    expect(arbitrumReadOf(snapshot)).toEqual({
      chainId: ARBITRUM_CHAIN_ID,
      blockNumber: ARB_L2_BLOCK,
      endpoint: 1,
      confirmedBy: 2,
      problem: null,
    });
    expect(robinhoodFailures(most.failures)).toEqual([
      { endpoint: 0, kind: 'http', code: 500 },
      { endpoint: 1, kind: 'http', code: 500 },
    ]);
    expect(most.failures.filter((failure) => failure.chainId === ARBITRUM_CHAIN_ID)).toEqual([
      { chainId: ARBITRUM_CHAIN_ID, endpoint: 0, kind: 'http', code: 500 },
    ]);
  });

  it('decodes each chain once: the two endpoints that agree say the same bytes', async () => {
    const most = mostRequests();
    await most.take();
    const answers = (arbitrum: boolean): (string | null)[] =>
      most.sent
        .filter((request) => isArbitrumUrl(request.url) === arbitrum && request.result !== null)
        .map((r) => r.result);
    const robinhood = answers(false);
    const pair = answers(true);
    // The fault is what the suite says it is: two answers a chain, the same bytes.
    expect(robinhood).toHaveLength(2);
    expect(robinhood[0]).toBe(robinhood[1]);
    expect(pair).toHaveLength(2);
    expect(pair[0]).toBe(pair[1]);
    expect([...seen.outerDecodes].sort()).toEqual([robinhood[0] as Hex, pair[0] as Hex].sort());
  });

  it('keeps nothing between two snapshots: the second decodes again', async () => {
    const most = mostRequests();
    const first = await most.take();
    expect(seen.outerDecodes).toHaveLength(2);
    const second = await most.take();
    expect(seen.outerDecodes).toHaveLength(4);
    expect(second.prices).toEqual(first.prices);
    expect(arbitrumReadOf(second)).toEqual(arbitrumReadOf(first));
  });
});
