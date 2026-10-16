import type { MarketEndpointFailure, MarketSnapshot } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  FEED_STALE_AFTER_SECONDS,
  MARKET_QUIET_AFTER_SECONDS,
  marketSnapshotSchema,
  UNIVERSE_SIZE,
} from '@prix/contracts';
import { PUBLIC_RPC_URLS, rpcEndpoints, UNIVERSE } from '@prix/market';
import { createMarketWith, RETRY_PAUSE_MS } from '@prix/market/market';
import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_ARBITRUM } from '../support/fake-arbitrum.ts';
import type { EndpointMode, FeedState } from '../support/fake-rpc.ts';
import { FakeRpc } from '../support/fake-rpc.ts';
import { utc } from '../support/fixtures.ts';

/**
 * How `takeSnapshot` explains and survives a failing endpoint (docs/CONTRACTS.md sections 5 and 15,
 * `MarketConfig.onEndpointFailure`, docs/DECISIONS.md D-098). The chain is a fake: a scripted
 * fetch answers each request in turn, and anything it was not told falls through to `FakeRpc`.
 * The pause before a retry is recorded, not slept.
 */

const NOW = utc('2026-10-06T18:00:04.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const PRIMARY = 'https://rpc-primary.test/v2/secret-key';
const FALLBACK = 'https://rpc-fallback.test';

/** One scripted answer. `fake` hands the request to FakeRpc in that mode ('ok' answers the snapshot). */
type Step =
  | { status: number; body?: string }
  | { throws: 'network' | 'timeout' | 'abort' }
  | { hang: true }
  | { rpcError: number }
  | { fake: EndpointMode };

interface Scene {
  rpc: FakeRpc;
  failures: MarketEndpointFailure[];
  pauses: number[];
  /** Scripted answers per endpoint, used in order; once used up, the endpoint answers normally. */
  script(url: string, ...steps: Step[]): void;
  requestsTo(url: string): number;
  take(options?: {
    hook?: (failure: MarketEndpointFailure) => void;
    rpcUrls?: string[];
    timeoutMs?: number;
  }): Promise<MarketSnapshot>;
}

function scene(): Scene {
  const rpc = new FakeRpc();
  rpc.blockTimestamp = NOW_SECONDS - 2;
  // Arbitrum One keeps its own clock here, so a Robinhood node that lags leaves it current: this
  // suite is about the Robinhood endpoints (section 23 has its own suites).
  rpc.arbitrum.set({ blockTimestamp: NOW_SECONDS - 1 });
  UNIVERSE.forEach((token, index) => {
    rpc.setFeed(token.feedAddress, {
      answer: BigInt(100 + index) * 10n ** BigInt(token.feedDecimals),
      updatedAt: NOW_SECONDS - 60 - index,
      decimals: token.feedDecimals,
    });
  });
  const scripts = new Map<string, Step[]>();
  const counts = new Map<string, number>();
  const failures: MarketEndpointFailure[] = [];
  const pauses: number[] = [];

  const scriptedFetch: typeof fetch = async (input, init) => {
    const url = new Request(input, init).url.replace(/\/+$/, '');
    counts.set(url, (counts.get(url) ?? 0) + 1);
    const step = scripts.get(url)?.shift() ?? { fake: 'ok' };
    if ('status' in step) return new Response(step.body ?? 'refused', { status: step.status });
    if ('throws' in step) {
      if (step.throws === 'network') throw new TypeError('fetch failed');
      if (step.throws === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
      throw new DOMException('This operation was aborted', 'AbortError');
    }
    if ('hang' in step) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    if ('rpcError' in step) {
      const body = { jsonrpc: '2.0', id: 1, error: { code: step.rpcError, message: 'refused' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    rpc.setMode(url, step.fake);
    try {
      return await rpc.fetch(input, init);
    } finally {
      rpc.setMode(url, 'ok');
    }
  };

  return {
    rpc,
    failures,
    pauses,
    script(url, ...steps) {
      scripts.set(url.replace(/\/+$/, ''), steps);
    },
    requestsTo(url) {
      return counts.get(url.replace(/\/+$/, '')) ?? 0;
    },
    take(options = {}) {
      const market = createMarketWith(
        {
          rpcUrls: options.rpcUrls ?? [PRIMARY, FALLBACK],
          arbitrum: TEST_ARBITRUM,
          staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
          cryptoStaleAfterSecondsBySymbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
          quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
          fetch: scriptedFetch,
          // The Robinhood endpoints only: an Arbitrum failure carries chainId 42161 (section 23).
          onEndpointFailure:
            options.hook ??
            ((failure) => {
              if (failure.chainId !== ARBITRUM_CHAIN_ID) failures.push(failure);
            }),
        },
        {
          pause: async (ms) => {
            pauses.push(ms);
          },
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      );
      return market.takeSnapshot(NOW);
    },
  };
}

/** Changes part of one feed the fake already answers for. */
function patchFeed(rpc: FakeRpc, feedAddress: string, patch: Partial<FeedState>): void {
  const current = rpc.feeds.get(feedAddress.toLowerCase());
  if (!current) throw new Error(`the fake has no feed ${feedAddress}`);
  rpc.setFeed(feedAddress, { ...current, ...patch });
}

const CLOSED = { open: false, closedReason: 'rpc_unavailable', blockNumber: 0, prices: [] };

describe('market: the pause before a retry', () => {
  it('is short: more than nothing and at most one second', () => {
    expect(RETRY_PAUSE_MS).toBeGreaterThan(0);
    expect(RETRY_PAUSE_MS).toBeLessThanOrEqual(1_000);
  });
});

describe('market: a healthy endpoint', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  it('reports no failure, makes one request and does not pause', async () => {
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(s.failures).toEqual([]);
    expect(s.pauses).toEqual([]);
    expect(s.requestsTo(PRIMARY)).toBe(1);
    expect(s.requestsTo(FALLBACK)).toBe(0);
  });
});

describe('market: a transient failure is retried once on the same endpoint', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  const transient: [string, Step][] = [
    ['HTTP 429', { status: 429 }],
    ['HTTP 500', { status: 500 }],
    ['HTTP 502', { status: 502 }],
    ['HTTP 503', { status: 503 }],
    ['HTTP 504', { status: 504 }],
    ['a network error', { throws: 'network' }],
    ['a timeout', { throws: 'timeout' }],
    ['a JSON-RPC rate limit (-32005)', { rpcError: -32005 }],
    ['a JSON-RPC rate limit (429)', { rpcError: 429 }],
    ['a JSON-RPC internal error (-32603)', { rpcError: -32603 }],
  ];

  it.each(transient)(
    'after %s, retries after a pause and opens without the fallback or a report',
    async (_name, step) => {
      s.script(PRIMARY, step);
      const snapshot = await s.take();
      expect(snapshot.open).toBe(true);
      expect(snapshot.prices).toHaveLength(UNIVERSE_SIZE);
      expect(s.requestsTo(PRIMARY)).toBe(2);
      expect(s.requestsTo(FALLBACK)).toBe(0);
      expect(s.pauses).toEqual([RETRY_PAUSE_MS]);
      expect(s.failures).toEqual([]);
    },
  );

  it('retries only once: a second transient failure moves on to the fallback and is reported', async () => {
    s.script(PRIMARY, { status: 429 }, { status: 429 });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(s.requestsTo(PRIMARY)).toBe(2);
    expect(s.requestsTo(FALLBACK)).toBe(1);
    expect(s.failures).toEqual([{ endpoint: 0, kind: 'http', code: 429 }]);
  });

  it('reports the failure of the retry, which is the one that ended the endpoint', async () => {
    s.script(PRIMARY, { status: 503 }, { throws: 'timeout' });
    await s.take();
    expect(s.failures).toEqual([{ endpoint: 0, kind: 'timeout' }]);
  });

  it('makes at most two requests per endpoint, four in all, when everything fails', async () => {
    s.script(PRIMARY, { throws: 'network' }, { throws: 'network' }, { throws: 'network' });
    s.script(FALLBACK, { status: 429 }, { status: 429 }, { status: 429 });
    const snapshot = await s.take();
    expect(snapshot).toMatchObject(CLOSED);
    expect(s.requestsTo(PRIMARY)).toBe(2);
    expect(s.requestsTo(FALLBACK)).toBe(2);
    expect(s.pauses).toEqual([RETRY_PAUSE_MS, RETRY_PAUSE_MS]);
  });
});

describe('market: a failure that a retry would not mend is not retried', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  const permanent: [string, Step, Omit<MarketEndpointFailure, 'endpoint'>][] = [
    ['HTTP 403', { status: 403 }, { kind: 'http', code: 403 }],
    ['HTTP 401', { status: 401 }, { kind: 'http', code: 401 }],
    ['HTTP 404', { status: 404 }, { kind: 'http', code: 404 }],
    ['a JSON-RPC method not found (-32601)', { rpcError: -32601 }, { kind: 'rpc_error', code: -32601 }],
    ['a JSON-RPC invalid params (-32602)', { rpcError: -32602 }, { kind: 'rpc_error', code: -32602 }],
    ['a revert (3)', { rpcError: 3 }, { kind: 'rpc_error', code: 3 }],
    ['an unparseable body', { fake: 'garbage' }, { kind: 'malformed' }],
    ['an HTML page with status 200', { fake: 'html' }, { kind: 'malformed' }],
    ['an empty result', { fake: 'empty_result' }, { kind: 'malformed' }],
    ['a multicall of the wrong length', { fake: 'short_answer' }, { kind: 'malformed' }],
    [
      'a JSON body with neither result nor error',
      { status: 200, body: '{"jsonrpc":"2.0","id":1}' },
      { kind: 'malformed' },
    ],
    ['a JSON-RPC batch where one object was expected', { status: 200, body: '[]' }, { kind: 'malformed' }],
  ];

  it.each(permanent)('%s goes straight to the fallback, reported once', async (_name, step, expected) => {
    s.script(PRIMARY, step);
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(s.requestsTo(PRIMARY)).toBe(1);
    expect(s.requestsTo(FALLBACK)).toBe(1);
    expect(s.pauses).toEqual([]);
    expect(s.failures).toEqual([{ endpoint: 0, ...expected }]);
  });

  it('reports an endpoint that answers for another chain as malformed', async () => {
    s.rpc.chainId = 1;
    const snapshot = await s.take();
    expect(snapshot).toMatchObject(CLOSED);
    expect(s.failures).toEqual([
      { endpoint: 0, kind: 'malformed' },
      { endpoint: 1, kind: 'malformed' },
    ]);
    expect(s.pauses).toEqual([]);
  });

  it('reports a node that cannot tell the time of its block as malformed', async () => {
    s.rpc.blockTimestampFails = true;
    await s.take();
    expect(s.failures.map((failure) => failure.kind)).toEqual(['malformed', 'malformed']);
  });
});

describe('market: a node that is behind', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  it('is reported with its lag and is not retried', async () => {
    s.rpc.blockTimestamp = NOW_SECONDS - 301;
    const snapshot = await s.take();
    expect(snapshot).toMatchObject(CLOSED);
    expect(s.requestsTo(PRIMARY)).toBe(1);
    expect(s.requestsTo(FALLBACK)).toBe(1);
    expect(s.pauses).toEqual([]);
    expect(s.failures).toEqual([
      { endpoint: 0, kind: 'behind', lagSeconds: 301 },
      { endpoint: 1, kind: 'behind', lagSeconds: 301 },
    ]);
  });

  it('gives a negative lag for a block too far in the future', async () => {
    s.rpc.blockTimestamp = NOW_SECONDS + 400;
    await s.take({ rpcUrls: [PRIMARY] });
    expect(s.failures).toEqual([{ endpoint: 0, kind: 'behind', lagSeconds: -400 }]);
  });
});

describe('market: timeouts', () => {
  it('ends a request that never answers with its own time limit, and calls it a timeout', async () => {
    const s = scene();
    s.script(PRIMARY, { hang: true }, { hang: true });
    const snapshot = await s.take({ rpcUrls: [PRIMARY], timeoutMs: 20 });
    expect(snapshot).toMatchObject(CLOSED);
    expect(s.requestsTo(PRIMARY)).toBe(2);
    expect(s.failures).toEqual([{ endpoint: 0, kind: 'timeout' }]);
  });

  it('calls an aborted request a timeout too', async () => {
    const s = scene();
    s.script(PRIMARY, { throws: 'abort' }, { throws: 'abort' });
    await s.take({ rpcUrls: [PRIMARY] });
    expect(s.failures).toEqual([{ endpoint: 0, kind: 'timeout' }]);
  });
});

describe('market: the report of a failure', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  it('names the endpoint by its position and never carries the URL, which may hold a key', async () => {
    s.script(PRIMARY, { status: 403 });
    s.script(FALLBACK, { status: 403 });
    await s.take();
    expect(s.failures.map((failure) => failure.endpoint)).toEqual([0, 1]);
    const text = JSON.stringify(s.failures);
    expect(text).not.toContain('rpc-primary');
    expect(text).not.toContain('secret-key');
    expect(text).not.toContain('rpc-fallback');
  });

  it('carries only the fields of the contract', async () => {
    s.script(PRIMARY, { status: 403 });
    s.rpc.blockTimestamp = NOW_SECONDS - 900;
    await s.take();
    for (const failure of s.failures) {
      for (const key of Object.keys(failure)) expect(['endpoint', 'kind', 'code', 'lagSeconds']).toContain(key);
    }
  });

  it('is not made for an endpoint that was never tried', async () => {
    s.script(PRIMARY, { status: 403 });
    await s.take({ rpcUrls: [PRIMARY, FALLBACK, 'https://rpc-third.test'] });
    expect(s.failures).toEqual([{ endpoint: 0, kind: 'http', code: 403 }]);
    expect(s.requestsTo('https://rpc-third.test')).toBe(0);
  });

  it('changes nothing when the hook throws, on a closed market or an open one', async () => {
    const throwing = (): void => {
      throw new Error('the log is broken');
    };
    s.script(PRIMARY, { status: 403 });
    const open = await s.take({ hook: throwing });
    expect(open.open).toBe(true);
    s.script(PRIMARY, { status: 403 });
    s.script(FALLBACK, { status: 403 });
    const closed = await s.take({ hook: throwing });
    expect(marketSnapshotSchema.safeParse(closed).success).toBe(true);
    expect(closed).toMatchObject(CLOSED);
  });

  it('changes nothing when the hook returns a promise that rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      s.script(PRIMARY, { status: 403 });
      const hook = (async () => {
        throw new Error('async log failure');
      }) as unknown as (failure: MarketEndpointFailure) => void;
      const snapshot = await s.take({ hook });
      expect(snapshot.open).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('works without a hook', async () => {
    const market = createMarketWith(
      {
        rpcUrls: [PRIMARY],
        arbitrum: TEST_ARBITRUM,
        staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
        cryptoStaleAfterSecondsBySymbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
        quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
        fetch: async () => new Response('no', { status: 403 }),
      },
      { pause: async () => {} },
    );
    expect(await market.takeSnapshot(NOW)).toMatchObject(CLOSED);
  });
});

describe('market: one failed call inside the batched read', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  it("halts only that symbol when one token's pause flag fails, with no retry and no report", async () => {
    const token = UNIVERSE[4];
    if (!token) throw new Error('the universe has no fifth token');
    patchFeed(s.rpc, token.feedAddress, { pauseReadFails: true });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual([token.symbol]);
    expect(s.requestsTo(PRIMARY)).toBe(1);
    expect(s.failures).toEqual([]);
  });

  it('closes with feed_invalid, as the contract says, when one feed read fails, and the endpoint has answered', async () => {
    const token = UNIVERSE[4];
    if (!token) throw new Error('the universe has no fifth token');
    patchFeed(s.rpc, token.feedAddress, { reverts: true });
    const snapshot = await s.take();
    expect(snapshot.closedReason).toBe('feed_invalid');
    expect(snapshot.prices).toHaveLength(UNIVERSE_SIZE);
    expect(s.requestsTo(FALLBACK)).toBe(0);
    expect(s.failures).toEqual([]);
  });
});

describe('market: the public endpoint list as the Worker builds it', () => {
  it('falls through the keyed endpoint and the official one to publicnode, in order, and asks dRPC once to confirm it', async () => {
    const [official, publicnode, drpc] = PUBLIC_RPC_URLS as [string, string, string];
    const s = scene();
    s.script(PRIMARY, { status: 429 }, { status: 429 });
    s.script(official, { status: 429 }, { status: 429 });
    const snapshot = await s.take({ rpcUrls: rpcEndpoints(PRIMARY) });
    expect(snapshot.open).toBe(true);
    expect(s.requestsTo(publicnode)).toBe(1);
    // Section 20: a third party's snapshot stands only when a second independent endpoint agrees.
    expect(s.requestsTo(drpc)).toBe(1);
    expect(s.failures).toEqual([
      { endpoint: 0, kind: 'http', code: 429 },
      { endpoint: 1, kind: 'http', code: 429 },
    ]);
  });

  it('does not take publicnode alone when the keyed endpoint and the official one fail and dRPC is down', async () => {
    const [official, publicnode, drpc] = PUBLIC_RPC_URLS as [string, string, string];
    const s = scene();
    s.script(PRIMARY, { status: 429 }, { status: 429 });
    s.script(official, { status: 429 }, { status: 429 });
    s.script(drpc, { status: 503 }, { status: 503 });
    const snapshot = await s.take({ rpcUrls: rpcEndpoints(PRIMARY) });
    expect(snapshot).toMatchObject(CLOSED);
    expect(s.requestsTo(publicnode)).toBe(1);
    expect(s.failures.map((f) => f.endpoint)).toEqual([0, 1, 3]);
  });

  it('moves on from a node that is behind to the next endpoint, and closes when all are behind', async () => {
    const [official, publicnode, drpc] = PUBLIC_RPC_URLS as [string, string, string];
    const s = scene();
    s.rpc.blockTimestamp = NOW_SECONDS - 600;
    const snapshot = await s.take({ rpcUrls: rpcEndpoints(undefined) });
    expect(snapshot).toMatchObject(CLOSED);
    expect(s.requestsTo(official)).toBe(1);
    expect(s.requestsTo(publicnode)).toBe(1);
    expect(s.requestsTo(drpc)).toBe(1);
    expect(s.failures.map((f) => f.kind)).toEqual(['behind', 'behind', 'behind']);
  });

  it('closes with rpc_unavailable when all three public endpoints fail', async () => {
    const s = scene();
    for (const url of PUBLIC_RPC_URLS) s.script(url, { status: 429 }, { status: 429 });
    const snapshot = await s.take({ rpcUrls: rpcEndpoints(undefined) });
    expect(snapshot).toMatchObject(CLOSED);
    expect(s.failures.map((f) => f.endpoint)).toEqual([0, 1, 2]);
  });
});
