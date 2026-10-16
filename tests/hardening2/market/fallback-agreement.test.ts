import type { MarketEndpointFailure, MarketSnapshot, UniverseToken } from '@prix/contracts';
import {
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  FEED_STALE_AFTER_SECONDS,
  MARKET_QUIET_AFTER_SECONDS,
  marketSnapshotSchema,
} from '@prix/contracts';
import { createMarket, PUBLIC_RPC_URL, PUBLIC_RPC_URLS, rpcEndpoints, UNIVERSE } from '@prix/market';
import { createMarketWith, type MarketLogLine } from '@prix/market/market';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aboutArbitrum,
  isArbitrumUrl,
  robinhoodFailures,
  robinhoodLines,
  TEST_ARBITRUM,
} from '../../support/fake-arbitrum.ts';
import { FakeRpc } from '../../support/fake-rpc.ts';
import { utc } from '../../support/fixtures.ts';

/**
 * A snapshot that a third-party fallback endpoint served (not the keyed RPC_URL, not the official
 * endpoint) is accepted only when a second independent endpoint agrees on every feed in the same
 * step; otherwise the market closes with `rpc_unavailable`. The endpoint that served each tick is
 * logged as `market_endpoint_used`, by its index and never its URL (docs/CONTRACTS.md section 20;
 * security review of the newest reads, finding 2).
 *
 * Each endpoint is its own fake chain, so one can lie while another tells the truth.
 */

const NOW = utc('2026-10-08T18:00:04.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const KEYED = 'https://rpc-keyed.test/v2/secret-key';
const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];

/** A chain whose feeds all answer the truth at NOW. */
function honestChain(): FakeRpc {
  const rpc = new FakeRpc();
  rpc.blockTimestamp = NOW_SECONDS - 2;
  UNIVERSE.forEach((token, index) => {
    rpc.setFeed(token.feedAddress, {
      answer: BigInt(100 + index) * 10n ** BigInt(token.feedDecimals),
      updatedAt: NOW_SECONDS - 60 - index,
      decimals: token.feedDecimals,
    });
  });
  return rpc;
}

function firstToken(): UniverseToken {
  const token = UNIVERSE[0];
  if (!token) throw new Error('the universe is empty');
  return token;
}
const FIRST = firstToken();

/** A chain that lies about one feed's answer: ten times the truth. */
function lyingPrice(): FakeRpc {
  const rpc = honestChain();
  rpc.setFeed(FIRST.feedAddress, {
    answer: 1_000n * 10n ** BigInt(FIRST.feedDecimals),
    updatedAt: NOW_SECONDS - 60,
    decimals: FIRST.feedDecimals,
  });
  return rpc;
}

/** A chain that answers every feed with a time far in the past: the market looks shut. */
function allStale(): FakeRpc {
  const rpc = honestChain();
  UNIVERSE.forEach((token, index) => {
    rpc.setFeed(token.feedAddress, {
      answer: BigInt(100 + index) * 10n ** BigInt(token.feedDecimals),
      updatedAt: NOW_SECONDS - 400_000,
      decimals: token.feedDecimals,
    });
  });
  return rpc;
}

type Route = FakeRpc | { status: number } | { throws: 'network' };

/**
 * What one snapshot did on Robinhood Chain. The Arbitrum read of section 23 runs beside it on a
 * healthy fake Arbitrum; its requests, failures and log lines are left out of `asked`, `failures`
 * and `logs`, and kept whole in `allLogs`.
 */
interface Run {
  snapshot: MarketSnapshot;
  failures: MarketEndpointFailure[];
  logs: Record<string, unknown>[];
  allLogs: MarketLogLine[];
  asked: string[];
}

const norm = (url: string): string => url.replace(/\/+$/, '');

/** Takes one snapshot with each endpoint answering by its route; an endpoint without one is honest. */
async function take(rpcUrls: readonly string[], routes: Record<string, Route> = {}): Promise<Run> {
  const honest = honestChain();
  const asked: string[] = [];
  const failures: MarketEndpointFailure[] = [];
  const logs: MarketLogLine[] = [];
  const routed = new Map(Object.entries(routes).map(([url, route]) => [norm(url), route]));
  const fetchFn: typeof fetch = async (input, init) => {
    const url = norm(new Request(input, init).url);
    if (!isArbitrumUrl(url)) asked.push(url);
    const route = routed.get(url) ?? honest;
    if (route instanceof FakeRpc) return route.fetch(input, init);
    if ('status' in route) return new Response('no', { status: route.status });
    throw new TypeError('fetch failed');
  };
  const market = createMarketWith(
    {
      rpcUrls,
      arbitrum: TEST_ARBITRUM,
      staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
      cryptoStaleAfterSecondsBySymbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
      fetch: fetchFn,
      onEndpointFailure: (failure) => failures.push(failure),
    },
    { pause: async () => {}, log: (line) => logs.push(line) },
  );
  const snapshot = await market.takeSnapshot(NOW);
  return { snapshot, failures: robinhoodFailures(failures), logs: robinhoodLines(logs), allLogs: logs, asked };
}

const CLOSED = { open: false, closedReason: 'rpc_unavailable', blockNumber: 0, prices: [] };
const DOWN: Route = { status: 429 };

describe('fallback agreement: a trusted endpoint is accepted alone', () => {
  it('takes the keyed endpoint alone and logs it as endpoint 0', async () => {
    const run = await take(rpcEndpoints(KEYED));
    expect(run.snapshot.open).toBe(true);
    expect(run.asked).toEqual([norm(KEYED)]);
    expect(run.logs).toEqual([{ event: 'market_endpoint_used', endpoint: 0, confirmedBy: null }]);
  });

  it('takes the official endpoint alone after the keyed one failed', async () => {
    const run = await take(rpcEndpoints(KEYED), { [KEYED]: DOWN });
    expect(run.snapshot.open).toBe(true);
    expect(run.asked).toEqual([norm(KEYED), norm(KEYED), norm(OFFICIAL)]);
    expect(run.logs).toEqual([{ event: 'market_endpoint_used', endpoint: 1, confirmedBy: null }]);
  });

  it('takes the official endpoint alone when no key is set', async () => {
    const run = await take(rpcEndpoints(undefined));
    expect(run.snapshot.open).toBe(true);
    expect(run.asked).toEqual([norm(OFFICIAL)]);
    expect(run.logs).toEqual([{ event: 'market_endpoint_used', endpoint: 0, confirmedBy: null }]);
  });

  it('accepts a closed snapshot of a trusted endpoint alone too', async () => {
    const run = await take([PUBLIC_RPC_URL, PUBLICNODE], { [PUBLIC_RPC_URL]: allStale() });
    expect(run.snapshot.closedReason).toBe('feeds_stale');
    expect(run.asked).toEqual([norm(PUBLIC_RPC_URL)]);
  });
});

describe('fallback agreement: a third-party endpoint needs a second one to agree', () => {
  it('opens when publicnode and dRPC agree on every feed, and logs both indexes', async () => {
    const run = await take(rpcEndpoints(KEYED), { [KEYED]: DOWN, [OFFICIAL]: DOWN });
    expect(run.snapshot.open).toBe(true);
    expect(run.snapshot.prices).toHaveLength(UNIVERSE.length);
    expect(run.asked.filter((url) => url === norm(PUBLICNODE))).toHaveLength(1);
    expect(run.asked.filter((url) => url === norm(DRPC))).toHaveLength(1);
    expect(run.logs).toEqual([{ event: 'market_endpoint_used', endpoint: 2, confirmedBy: 3 }]);
    expect(run.failures.map((failure) => failure.endpoint)).toEqual([0, 1]);
  });

  it('serves the snapshot of the endpoint that answered first', async () => {
    const run = await take([PUBLICNODE, DRPC]);
    const alone = await take([PUBLIC_RPC_URL]);
    expect(run.snapshot).toEqual(alone.snapshot);
  });

  it('closes with rpc_unavailable when the third-party endpoint lies about one price', async () => {
    const run = await take(rpcEndpoints(undefined), { [OFFICIAL]: DOWN, [PUBLICNODE]: lyingPrice() });
    expect(run.snapshot).toMatchObject(CLOSED);
    expect(marketSnapshotSchema.safeParse(run.snapshot).success).toBe(true);
    expect(run.logs).toEqual([{ event: 'market_endpoint_rejected', endpoint: 1, confirmedBy: 2, reason: 'disagreed' }]);
  });

  it('closes when the confirming endpoint is the one that lies: a disagreement is never settled by trust', async () => {
    const run = await take(rpcEndpoints(undefined), { [OFFICIAL]: DOWN, [DRPC]: lyingPrice() });
    expect(run.snapshot).toMatchObject(CLOSED);
  });

  it('closes when the two disagree only on when one feed last updated', async () => {
    const shifted = honestChain();
    shifted.setFeed(FIRST.feedAddress, {
      answer: 100n * 10n ** BigInt(FIRST.feedDecimals),
      updatedAt: NOW_SECONDS - 30,
      decimals: FIRST.feedDecimals,
    });
    const run = await take([PUBLICNODE, DRPC], { [PUBLICNODE]: shifted });
    expect(run.snapshot).toMatchObject(CLOSED);
  });

  it('closes when the two disagree only on whether one feed is paused', async () => {
    const paused = honestChain();
    paused.setFeed(FIRST.feedAddress, {
      answer: 100n * 10n ** BigInt(FIRST.feedDecimals),
      updatedAt: NOW_SECONDS - 60,
      decimals: FIRST.feedDecimals,
      oraclePaused: true,
    });
    const run = await take([PUBLICNODE, DRPC], { [DRPC]: paused });
    expect(run.snapshot).toMatchObject(CLOSED);
  });

  it('closes with rpc_unavailable, not feeds_stale, when a third party answers a shut market the second denies', async () => {
    const run = await take([PUBLICNODE, DRPC], { [PUBLICNODE]: allStale() });
    expect(run.snapshot).toMatchObject(CLOSED);
  });

  it('accepts a closed market that both third parties agree on', async () => {
    const run = await take([PUBLICNODE, DRPC], { [PUBLICNODE]: allStale(), [DRPC]: allStale() });
    expect(run.snapshot.open).toBe(false);
    expect(run.snapshot.closedReason).toBe('feeds_stale');
    expect(run.logs).toEqual([{ event: 'market_endpoint_used', endpoint: 0, confirmedBy: 1 }]);
  });

  it('closes when the second endpoint fails, reports its failure and logs the snapshot as unconfirmed', async () => {
    const run = await take(rpcEndpoints(undefined), { [OFFICIAL]: DOWN, [DRPC]: DOWN });
    expect(run.snapshot).toMatchObject(CLOSED);
    expect(run.failures).toEqual([
      { endpoint: 0, kind: 'http', code: 429 },
      { endpoint: 2, kind: 'http', code: 429 },
    ]);
    expect(run.logs).toEqual([
      { event: 'market_endpoint_rejected', endpoint: 1, confirmedBy: null, reason: 'unconfirmed' },
    ]);
  });

  it('closes when the second endpoint is behind, and reports it as behind', async () => {
    const behind = honestChain();
    behind.blockTimestamp = NOW_SECONDS - 900;
    const run = await take([PUBLICNODE, DRPC], { [DRPC]: behind });
    expect(run.snapshot).toMatchObject(CLOSED);
    expect(run.failures).toEqual([{ endpoint: 1, kind: 'behind', lagSeconds: 900 }]);
  });

  it('closes when only the last third-party endpoint answers: there is no one left to agree', async () => {
    const run = await take(rpcEndpoints(undefined), { [OFFICIAL]: DOWN, [PUBLICNODE]: { throws: 'network' } });
    expect(run.snapshot).toMatchObject(CLOSED);
    expect(run.logs).toEqual([
      { event: 'market_endpoint_rejected', endpoint: 2, confirmedBy: null, reason: 'unconfirmed' },
    ]);
  });

  it('knows a third-party endpoint written with a trailing slash', async () => {
    const run = await take([`${PUBLICNODE}/`, DRPC]);
    expect(run.snapshot.open).toBe(true);
    expect(run.asked).toEqual([norm(PUBLICNODE), norm(DRPC)]);
    expect(run.logs).toEqual([{ event: 'market_endpoint_used', endpoint: 0, confirmedBy: 1 }]);
  });

  it('does not count a second address of the same host as independent', async () => {
    const sameHost = `${PUBLICNODE}/again`;
    const run = await take([PUBLICNODE, sameHost, DRPC], { [DRPC]: DOWN });
    expect(run.snapshot).toMatchObject(CLOSED);
    expect(run.asked).not.toContain(norm(sameHost));
  });

  it('makes at most two requests to each endpoint, in order, and never goes back', async () => {
    const run = await take(rpcEndpoints(KEYED), { [KEYED]: DOWN, [OFFICIAL]: DOWN, [DRPC]: DOWN });
    expect(run.snapshot).toMatchObject(CLOSED);
    expect(run.asked).toEqual([
      norm(KEYED),
      norm(KEYED),
      norm(OFFICIAL),
      norm(OFFICIAL),
      norm(PUBLICNODE),
      norm(DRPC),
      norm(DRPC),
    ]);
  });
});

/** A chain that answers one crypto feed differently from the honest one; `null` makes the feed revert. */
function otherCoin(symbol: string, answer: bigint | null): FakeRpc {
  const rpc = honestChain();
  const index = UNIVERSE.findIndex((token) => token.symbol === symbol);
  const coin = UNIVERSE[index];
  if (coin?.kind !== 'crypto') throw new Error(`${symbol} is not a crypto entry`);
  rpc.setFeed(coin.feedAddress, {
    answer: answer ?? 1n,
    updatedAt: NOW_SECONDS - 60 - index,
    decimals: coin.feedDecimals,
    reverts: answer === null,
  });
  return rpc;
}

describe('fallback agreement: a crypto difference never closes the market (section 21, rule 2)', () => {
  it('stays open when the two differ only on a crypto price, and marks that coin unread', async () => {
    const run = await take([PUBLICNODE, DRPC], { [DRPC]: otherCoin('ETH', 999_999n * 10n ** 8n) });
    const alone = await take([PUBLIC_RPC_URL]);
    expect(run.snapshot.open).toBe(true);
    expect(run.snapshot.closedReason).toBeNull();
    expect(marketSnapshotSchema.safeParse(run.snapshot).success).toBe(true);
    const eth = run.snapshot.prices.find((point) => point.symbol === 'ETH');
    const aloneEth = alone.snapshot.prices.find((point) => point.symbol === 'ETH');
    expect(eth).toEqual({ ...aloneEth, priceMicro: 0, fresh: false });
    // Every other point is the first endpoint's own.
    expect(run.snapshot.prices.filter((point) => point.symbol !== 'ETH')).toEqual(
      alone.snapshot.prices.filter((point) => point.symbol !== 'ETH'),
    );
    expect(run.logs).toEqual([{ event: 'market_endpoint_used', endpoint: 0, confirmedBy: 1 }]);
  });

  it('stays open when one endpoint cannot read a crypto feed at all', async () => {
    const run = await take([PUBLICNODE, DRPC], { [DRPC]: otherCoin('BTC', null) });
    expect(run.snapshot.open).toBe(true);
    expect(run.snapshot.prices.find((point) => point.symbol === 'BTC')).toMatchObject({ priceMicro: 0, fresh: false });
    const stocks = new Set(UNIVERSE.filter((token) => token.kind === 'stock').map((token) => token.symbol));
    expect(run.snapshot.prices.filter((point) => stocks.has(point.symbol)).every((point) => point.fresh)).toBe(true);
  });

  it('still closes when a Stock Token differs as well as a coin', async () => {
    const both = lyingPrice();
    const eth = UNIVERSE.find((token) => token.symbol === 'ETH');
    if (!eth) throw new Error('no ETH in the universe');
    both.setFeed(eth.feedAddress, { answer: 5n * 10n ** 8n, updatedAt: NOW_SECONDS - 60, decimals: 8 });
    const run = await take([PUBLICNODE, DRPC], { [PUBLICNODE]: both });
    expect(run.snapshot).toMatchObject(CLOSED);
  });
});

describe('fallback agreement: the log line', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never carries an endpoint URL, which may hold a key', async () => {
    const runs = [
      await take(rpcEndpoints(KEYED)),
      await take(rpcEndpoints(KEYED), { [KEYED]: DOWN, [OFFICIAL]: DOWN }),
      await take(rpcEndpoints(KEYED), { [KEYED]: DOWN, [OFFICIAL]: DOWN, [PUBLICNODE]: lyingPrice() }),
    ];
    // Every line, the Arbitrum ones of section 23 included.
    const text = JSON.stringify(runs.map((run) => run.allLogs));
    const pieces = ['secret-key', 'rpc-keyed', 'publicnode', 'drpc', 'chain.robinhood.com', 'https:', '.test'];
    for (const piece of pieces) expect(text).not.toContain(piece);
  });

  it('changes nothing when the logger throws', async () => {
    const market = createMarketWith(
      {
        rpcUrls: [PUBLICNODE, DRPC],
        arbitrum: TEST_ARBITRUM,
        staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
        cryptoStaleAfterSecondsBySymbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
        quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
        fetch: honestChain().fetch,
      },
      {
        pause: async () => {},
        log: () => {
          throw new Error('the log is broken');
        },
      },
    );
    const snapshot = await market.takeSnapshot(NOW);
    expect(snapshot.open).toBe(true);
  });

  it('is written to the Worker log by the product market as one JSON line', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const market = createMarket({
      rpcUrls: [KEYED],
      arbitrum: TEST_ARBITRUM,
      staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
      cryptoStaleAfterSecondsBySymbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
      fetch: honestChain().fetch,
    });
    const snapshot = await market.takeSnapshot(NOW);
    expect(snapshot.open).toBe(true);
    const lines = info.mock.calls.map((call) => String(call[0]));
    // Each line is one JSON object; the Robinhood one names endpoint 0, taken alone. Section 23 lets
    // every line say its chain, so only the Robinhood line's own fields are compared.
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(robinhoodLines(parsed)).toContainEqual({ event: 'market_endpoint_used', endpoint: 0, confirmedBy: null });
    expect(parsed.filter((line) => aboutArbitrum(line)).length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('secret-key');
  });
});
