import { ARBITRUM_CHAIN_ID, ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT, marketSnapshotSchema } from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { describe, expect, it } from 'vitest';
import { ARBSYS_ADDRESS, MULTICALL3_ADDRESS, SELECTOR } from '../support/abi.ts';
import {
  ARB_L2_BLOCK,
  ARB_OFFICIAL,
  ARB_PAIR_ONE,
  ARB_PAIR_TWO,
  ARBITRUM_FEEDS,
  ARBITRUM_SEQUENCER_FEED,
  type ArbitrumMode,
  aboutArbitrum,
  arbitrumLines,
  isArbitrumUrl,
} from '../support/fake-arbitrum.ts';
import { TEST_PRICES } from '../support/fixtures.ts';
import {
  answerOf,
  arbitrumReadOf,
  isUnread,
  NOW,
  NOW_SECONDS,
  OFFICIAL_READ,
  pointOf,
  robinhoodFetches,
  scene,
} from './support.ts';

/**
 * Reading Arbitrum One, docs/CONTRACTS.md section 23, rules 1 to 4, 8, 9 and 11: one `eth_call` to
 * Multicall3, never a batch; the L2 block from ArbSys; the official endpoint alone, else the pair,
 * the second pinned to the first's L2 block and taken only when the two answers are byte-identical;
 * each endpoint once, with no retry, at most three requests; the read beside the Robinhood one, with
 * one `takenAt`; its provenance in `otherChains`; failures and log lines that say the chain and
 * never a URL.
 */

const ARBITRUM_SYMBOLS = ['BNB', 'HYPE', 'SOL'] as const;

function expectArbitrumPriced(snapshot: Awaited<ReturnType<ReturnType<typeof scene>['take']>>): void {
  for (const symbol of ARBITRUM_SYMBOLS) {
    expect(pointOf(snapshot, symbol), symbol).toMatchObject({ priceMicro: TEST_PRICES[symbol], fresh: true });
  }
}

function blockOf(tag: unknown): number | null {
  if (typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag)) return Number.parseInt(tag, 16);
  if (typeof tag === 'object' && tag !== null && 'blockNumber' in tag) {
    return blockOf((tag as { blockNumber: unknown }).blockNumber);
  }
  return null;
}

describe('a healthy Arbitrum read', () => {
  it('prices SOL, BNB and HYPE from the official endpoint alone, in one request', async () => {
    const s = scene();
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ open: true, closedReason: null, takenAt: NOW.toISOString() });
    expectArbitrumPriced(snapshot);
    expect(snapshot.otherChains).toEqual([OFFICIAL_READ]);
    expect(s.rpc.arbitrum.requests.map((request) => request.url)).toEqual([ARB_OFFICIAL]);
    expect(s.failures).toEqual([]);
  });

  it('sends one eth_call to Multicall3, never a JSON-RPC batch', async () => {
    const s = scene();
    await s.take();
    const [request] = s.rpc.arbitrum.requests;
    expect(request).toMatchObject({ batch: false, methods: ['eth_call'], to: MULTICALL3_ADDRESS });
  });

  it('carries the chain ID, the block time, ArbSys, the sequencer feed and each feed with its decimals', async () => {
    const s = scene();
    await s.take();
    const calls = s.rpc.arbitrum.requests[0]?.calls ?? [];
    const has = (target: string, selector: string) =>
      calls.some((call) => call.target === target && call.selector === selector);
    expect(has(MULTICALL3_ADDRESS, SELECTOR.getChainId)).toBe(true);
    expect(has(MULTICALL3_ADDRESS, SELECTOR.getCurrentBlockTimestamp)).toBe(true);
    expect(has(ARBSYS_ADDRESS, SELECTOR.arbBlockNumber)).toBe(true);
    expect(has(ARBITRUM_SEQUENCER_FEED, SELECTOR.latestRoundData)).toBe(true);
    for (const feed of Object.values(ARBITRUM_FEEDS)) {
      expect(has(feed, SELECTOR.latestRoundData), feed).toBe(true);
      expect(has(feed, SELECTOR.decimals), feed).toBe(true);
    }
    // Nothing else is read on Arbitrum One: no Robinhood feed, no token, no pool.
    const allowed = new Set([
      MULTICALL3_ADDRESS,
      ARBSYS_ADDRESS,
      ARBITRUM_SEQUENCER_FEED,
      ...Object.values(ARBITRUM_FEEDS),
    ]);
    for (const call of calls) expect(allowed.has(call.target), call.target).toBe(true);
  });

  it('never reads SOL, BNB or HYPE on Robinhood Chain', async () => {
    const s = scene();
    await s.take();
    for (const feed of Object.values(ARBITRUM_FEEDS)) expect(s.rpc.calledAddresses.has(feed)).toBe(false);
  });

  it("dates the read with ArbSys's L2 block, never the Ethereum block that Multicall3 gives", async () => {
    const s = scene();
    s.rpc.arbitrum.set({ l2Block: 401_000_001, l1Block: 23_000_002 });
    const snapshot = await s.take();
    expect(arbitrumReadOf(snapshot)?.blockNumber).toBe(401_000_001);
    // The Robinhood block stays the snapshot's own.
    expect(snapshot.blockNumber).toBe(s.rpc.blockNumber);
  });

  it('runs beside the Robinhood read, not after it, and the snapshot has one takenAt', async () => {
    const s = scene();
    let arbitrumAsked = false;
    let overlapped = false;
    const gated: typeof fetch = async (input, init) => {
      const url = new Request(input, init).url;
      if (isArbitrumUrl(url)) {
        arbitrumAsked = true;
        return s.rpc.fetch(input, init);
      }
      // Holds the Robinhood answer until the Arbitrum request has been sent, for at most 1.5 s.
      for (let waited = 0; waited < 1_500 && !arbitrumAsked; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      overlapped = arbitrumAsked;
      return s.rpc.fetch(input, init);
    };
    const snapshot = await s.take({ fetch: gated });
    expect(overlapped).toBe(true);
    expect(snapshot.takenAt).toBe(NOW.toISOString());
    expectArbitrumPriced(snapshot);
  });

  it('reads Arbitrum once per snapshot, however many Robinhood endpoints it takes', async () => {
    const s = scene();
    // The official Robinhood endpoint is down; publicnode and dRPC must agree (section 20).
    const [official, publicnode, drpc] = PUBLIC_RPC_URLS as [string, string, string];
    s.rpc.setMode(official, 'http_500');
    const snapshot = await s.take({ rpcUrls: [official, publicnode, drpc] });
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(s.rpc.arbitrum.requests).toHaveLength(1);
    expect(robinhoodFetches(s.fetched).length).toBeGreaterThanOrEqual(3);
    expectArbitrumPriced(snapshot);
    expect(snapshot.otherChains).toEqual([OFFICIAL_READ]);
  });

  it('compares only Robinhood points between two Robinhood fallbacks and copies the Arbitrum points unchanged', async () => {
    const s = scene();
    const [official, publicnode, drpc] = PUBLIC_RPC_URLS as [string, string, string];
    s.rpc.setMode(official, 'network_error');
    const snapshot = await s.take({ rpcUrls: [official, publicnode, drpc] });
    const healthy = await scene().take();
    expect(snapshot.open).toBe(true);
    for (const symbol of ARBITRUM_SYMBOLS) expect(pointOf(snapshot, symbol)).toEqual(pointOf(healthy, symbol));
  });
});

describe('the confirming pair', () => {
  it('reads the first at latest, then the second pinned to its L2 block, and takes an identical answer', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_ONE, { l2Block: ARB_L2_BLOCK + 40 });
    // The second's head is further on, as a real node's would be; pinned, it answers at the first's block.
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, { l2Block: ARB_L2_BLOCK + 90 });
    const snapshot = await s.take();
    const requests = s.rpc.arbitrum.requests;
    expect(requests.map((request) => request.url)).toEqual([ARB_OFFICIAL, ARB_PAIR_ONE, ARB_PAIR_TWO]);
    expect(blockOf(requests[1]?.blockTag)).toBeNull();
    expect(blockOf(requests[2]?.blockTag)).toBe(ARB_L2_BLOCK + 40);
    expect(arbitrumReadOf(snapshot)).toEqual({
      chainId: ARBITRUM_CHAIN_ID,
      blockNumber: ARB_L2_BLOCK + 40,
      endpoint: 1,
      confirmedBy: 2,
      problem: null,
    });
    expectArbitrumPriced(snapshot);
  });

  it('is not asked when the official endpoint answered', async () => {
    const s = scene();
    await s.take();
    expect(s.rpc.arbitrum.requestsTo(ARB_PAIR_ONE)).toEqual([]);
    expect(s.rpc.arbitrum.requestsTo(ARB_PAIR_TWO)).toEqual([]);
  });

  it('gives disagreed, and unreads the coins, when the two differ on one feed', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'network_error' });
    s.rpc.arbitrum.patchFeedAt(ARB_PAIR_TWO, ARBITRUM_FEEDS.HYPE, {
      answer: answerOf(TEST_PRICES.HYPE as number) + 1n,
    });
    const snapshot = await s.take();
    expect(arbitrumReadOf(snapshot)).toMatchObject({ problem: 'disagreed', confirmedBy: null });
    for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('gives disagreed when the two differ only on the sequencer', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_429' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, {
      sequencer: { answer: 0n, startedAt: BigInt(NOW_SECONDS - 40 * 86_400) },
    });
    const snapshot = await s.take();
    expect(arbitrumReadOf(snapshot)?.problem).toBe('disagreed');
  });

  it('gives disagreed when the second answers at another block than the one it was pinned to', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'rpc_error' });
    // A node that ignores the pin and answers its own head: the bytes differ, so nothing is taken.
    const ignoresPin: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.replace(/\/+$/, '') !== ARB_PAIR_TWO) return s.rpc.fetch(input, init);
      const body = JSON.parse(await request.text()) as { params: unknown[] };
      body.params[1] = 'latest';
      return s.rpc.fetch(ARB_PAIR_TWO, { method: 'POST', body: JSON.stringify(body) });
    };
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, { l2Block: ARB_L2_BLOCK + 7 });
    const snapshot = await s.take({ fetch: ignoresPin });
    expect(arbitrumReadOf(snapshot)?.problem).toBe('disagreed');
    for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
  });

  it('gives unconfirmed when only the first of the pair answers', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, { mode: 'network_error' });
    const snapshot = await s.take();
    expect(arbitrumReadOf(snapshot)).toMatchObject({ problem: 'unconfirmed', confirmedBy: null });
    for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
  });

  it('gives unconfirmed when the second keeps no state at the pinned block', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, { mode: 'no_history' });
    expect(arbitrumReadOf(await s.take())?.problem).toBe('unconfirmed');
  });

  it('takes nothing from the pair when the first of it fails', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_ONE, { mode: 'network_error' });
    const snapshot = await s.take();
    expect(['unconfirmed', 'rpc_unavailable']).toContain(arbitrumReadOf(snapshot)?.problem);
    for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
  });

  it('gives rpc_unavailable, block 0 and no endpoint when none of the three answers', async () => {
    const s = scene();
    s.rpc.arbitrum.set({ mode: 'network_error' });
    const snapshot = await s.take();
    expect(arbitrumReadOf(snapshot)).toEqual({
      chainId: ARBITRUM_CHAIN_ID,
      blockNumber: 0,
      endpoint: null,
      confirmedBy: null,
      problem: 'rpc_unavailable',
    });
    for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
  });
});

describe('what the official endpoint must give to be taken alone', () => {
  const cases: [string, Parameters<ReturnType<typeof scene>['rpc']['arbitrum']['setEndpoint']>[1]][] = [
    ['answers for another chain', { chainId: 1 }],
    ['cannot say its chain', { chainId: null }],
    ['is more than five minutes behind', { blockTimestamp: NOW_SECONDS - 301 }],
    ['is in the future', { blockTimestamp: NOW_SECONDS + 400 }],
    ['answers with garbage', { mode: 'garbage' }],
    ['answers with more than 256 KB', { mode: 'huge' }],
    ['refuses with a JSON-RPC error', { mode: 'rpc_error' }],
    ['is rate limited', { mode: 'http_429' }],
  ];

  for (const [label, patch] of cases) {
    it(`is passed over when it ${label}, and the pair is read instead`, async () => {
      const s = scene();
      s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, patch);
      const snapshot = await s.take();
      expect(arbitrumReadOf(snapshot)).toMatchObject({ endpoint: 1, confirmedBy: 2, problem: null });
      expectArbitrumPriced(snapshot);
      expect(s.rpc.arbitrum.requestsTo(ARB_OFFICIAL)).toHaveLength(1);
    });
  }

  it('is passed over when it hangs, within the time limit', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'hang' });
    const started = Date.now();
    const snapshot = await s.take({ timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(arbitrumReadOf(snapshot)).toMatchObject({ endpoint: 1, confirmedBy: 2, problem: null });
  });
});

describe('the cap of three requests', () => {
  it('is three', () => {
    expect(ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT).toBe(3);
  });

  const modes: ArbitrumMode[] = ['ok', 'network_error', 'http_429', 'http_500', 'rpc_error', 'garbage', 'no_history'];

  it('holds for every mix of endpoint failures: each endpoint once, no retry, never a batch, only eth_call', async () => {
    for (const official of modes) {
      for (const one of modes) {
        for (const two of modes) {
          const s = scene();
          s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: official });
          s.rpc.arbitrum.setEndpoint(ARB_PAIR_ONE, { mode: one });
          s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, { mode: two });
          const snapshot = await s.take();
          const label = `${official}/${one}/${two}`;
          const requests = s.rpc.arbitrum.requests;
          expect(requests.length, label).toBeLessThanOrEqual(ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT);
          for (const url of [ARB_OFFICIAL, ARB_PAIR_ONE, ARB_PAIR_TWO]) {
            expect(s.rpc.arbitrum.requestsTo(url).length, `${label} ${url}`).toBeLessThanOrEqual(1);
          }
          for (const request of requests) {
            expect(request.batch, label).toBe(false);
            expect(request.methods, label).toEqual(['eth_call']);
          }
          // The market stays as the Robinhood read says, whatever Arbitrum did.
          expect(snapshot, label).toMatchObject({ open: true, closedReason: null });
          expect(snapshot.otherChains, label).toHaveLength(1);
        }
      }
    }
  }, 180_000);

  it('holds when the Robinhood read falls through every endpoint too', async () => {
    const s = scene();
    const [official, publicnode, drpc] = PUBLIC_RPC_URLS as [string, string, string];
    for (const url of [official, publicnode, drpc]) s.rpc.setMode(url, 'http_500');
    s.rpc.arbitrum.set({ mode: 'http_500' });
    await s.take({ rpcUrls: [official, publicnode, drpc] });
    expect(s.rpc.arbitrum.requests.length).toBeLessThanOrEqual(3);
  });
});

describe('failures and log lines of the Arbitrum endpoints', () => {
  it('reports each failed endpoint once, with chainId 42161 and its position', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_429' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_ONE, { mode: 'network_error' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, { mode: 'http_500' });
    await s.take();
    const arbitrum = s.failures.filter((failure) => failure.chainId === ARBITRUM_CHAIN_ID);
    expect(arbitrum.map((failure) => failure.endpoint).sort()).toEqual([0, 1, 2]);
    expect(arbitrum.find((failure) => failure.endpoint === 0)).toMatchObject({ kind: 'http', code: 429 });
    expect(arbitrum.find((failure) => failure.endpoint === 1)).toMatchObject({ kind: 'network' });
    // The Robinhood endpoint answered: no failure without a chain, or with Robinhood's.
    expect(s.failures.filter((failure) => failure.chainId !== ARBITRUM_CHAIN_ID)).toEqual([]);
  });

  it('logs the endpoint used for Arbitrum, saying the chain', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    await s.take();
    const used = arbitrumLines(s.logs).filter((line) => line.event === 'market_endpoint_used');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ endpoint: 1, confirmedBy: 2 });
  });

  it('logs a disagreement as a rejection that says the chain', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    s.rpc.arbitrum.patchFeedAt(ARB_PAIR_TWO, ARBITRUM_FEEDS.SOL, { updatedAt: NOW_SECONDS - 61 });
    await s.take();
    const rejected = arbitrumLines(s.logs).filter((line) => line.event === 'market_endpoint_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ endpoint: 1, confirmedBy: 2, reason: 'disagreed' });
  });

  it('never puts a URL in a failure or a log line', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    s.rpc.arbitrum.setEndpoint(ARB_PAIR_TWO, { mode: 'network_error' });
    await s.take();
    const text = JSON.stringify([s.logs, s.failures]);
    for (const piece of ['https:', 'arb-official', 'arb-pair', 'arbitrum.io', 'publicnode', 'drpc', 'secret-key']) {
      expect(text).not.toContain(piece);
    }
    expect(s.logs.some((line) => aboutArbitrum(line))).toBe(true);
  });
});
