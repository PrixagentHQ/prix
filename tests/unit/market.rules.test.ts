import type { PricePoint, UniverseToken } from '@prix/contracts';
import { isStockToken, MARKET_QUIET_AFTER_SECONDS, MAX_HALTED_FEEDS, MIN_PRICE_MICRO } from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import type { FeedRead } from '@prix/market/rules';
import {
  agreedSnapshot,
  buildSnapshot,
  closedSnapshot,
  decideOpen,
  FUTURE_TOLERANCE_SECONDS,
  feedProblem,
  isStale,
  judgeFeed,
  marketIsQuiet,
  NODE_LAG_TOLERANCE_SECONDS,
  nodeIsCurrent,
  toPriceMicro,
} from '@prix/market/rules';
import { describe, expect, it } from 'vitest';

/**
 * The pure rules of the market, through `@prix/market/rules`: no network, no clock. The same
 * rules are tested end to end through a fake RPC in market.test.ts. Here each one is tested
 * on its own, at its edges. docs/CONTRACTS.md sections 5 and 15 are the source of every number.
 */

const NOW = 1_790_000_000;
const TOKEN: UniverseToken = { ...(UNIVERSE[0] as UniverseToken), feedDecimals: 8 };
const COIN: UniverseToken = {
  kind: 'crypto',
  symbol: 'BTC',
  name: 'Bitcoin',
  feedAddress: '0xa2c5184bf03d373dc9de4876eb4bce595b460251',
  feedDecimals: 8,
  sourceUrl: 'https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood',
  readOn: '2026-10-09',
};
const read = (patch: Partial<FeedRead> & { answer?: bigint; updatedAt?: number } = {}): FeedRead => ({
  round: { answer: patch.answer ?? 18_241_000_000n, updatedAt: BigInt(patch.updatedAt ?? NOW - 60) },
  decimals: 8,
  oraclePaused: false,
  ...('round' in patch ? { round: patch.round } : {}),
  ...('decimals' in patch ? { decimals: patch.decimals } : {}),
  ...('oraclePaused' in patch ? { oraclePaused: patch.oraclePaused } : {}),
});

describe('toPriceMicro: the price conversion', () => {
  it.each([
    [18_241_000_000n, 8, 182_410_000n],
    [12_345_678_950n, 8, 123_456_790n],
    [12_345_678_949n, 8, 123_456_789n],
    [12_345_678_945n, 8, 123_456_789n],
    [12_345_678_955n, 8, 123_456_790n],
    [5n, 8, 0n],
    [50n, 8, 1n],
    [250_000_000n, 6, 250_000_000n],
    [2_500n, 2, 25_000_000n],
    [10n ** 18n, 18, 1_000_000n],
  ])('answer %s with %s decimals is %s micro-USD, rounded half up', (answer, decimals, expected) => {
    expect(toPriceMicro(answer, decimals)).toBe(expected);
  });

  it('is exact for an answer far beyond what a double can hold', () => {
    expect(toPriceMicro(7_654_321_123_456_000_000n, 12)).toBe(7_654_321_123_456n);
  });
});

describe('feedProblem: an invalid answer', () => {
  const check = (patch?: Parameters<typeof read>[0], now = NOW) => feedProblem(read(patch), 8, now);

  it('accepts a normal answer', () => {
    expect(check()).toBeNull();
  });

  it('refuses a read that failed', () => {
    expect(check({ round: null })).toBe('read_failed');
    expect(check({ decimals: null })).toBe('read_failed');
  });

  it("refuses a feed whose own decimals differ from the universe entry's", () => {
    expect(check({ decimals: 6 })).toBe('decimals_mismatch');
    expect(check({ decimals: 18 })).toBe('decimals_mismatch');
  });

  it('refuses a zero answer and a negative one', () => {
    expect(check({ answer: 0n })).toBe('answer_not_positive');
    expect(check({ answer: -1n })).toBe('answer_not_positive');
  });

  it('refuses a price below one cent and accepts exactly one cent', () => {
    expect(MIN_PRICE_MICRO).toBe(10_000);
    expect(check({ answer: 999_949n })).toBe('price_below_minimum');
    expect(check({ answer: 1_000_000n })).toBeNull();
  });

  it('refuses a price that does not fit a safe integer', () => {
    expect(check({ answer: 10n ** 30n })).toBe('price_not_safe');
  });

  it('refuses an update time of zero, and one more than five minutes ahead', () => {
    expect(FUTURE_TOLERANCE_SECONDS).toBe(300);
    expect(check({ updatedAt: 0 })).toBe('updated_at_zero');
    expect(check({ updatedAt: NOW + 300 })).toBeNull();
    expect(check({ updatedAt: NOW + 301 })).toBe('updated_at_in_future');
  });

  it('does not refuse an old update: old is stale, not invalid', () => {
    expect(check({ updatedAt: 1 })).toBeNull();
  });
});

describe('isStale: the stale rule', () => {
  it('is stale only when older than the threshold', () => {
    expect(isStale(NOW - 90_000, NOW, 90_000)).toBe(false);
    expect(isStale(NOW - 90_001, NOW, 90_000)).toBe(true);
    expect(isStale(NOW, NOW, 0)).toBe(false);
  });

  it('fails closed when the threshold is not a number', () => {
    expect(isStale(NOW, NOW, Number.NaN)).toBe(true);
    expect(isStale(NOW, NOW, undefined as unknown as number)).toBe(true);
  });

  it('says nothing about whether the market is open: an old feed halts only its own symbol', () => {
    const judged = judgeFeed(TOKEN, read({ updatedAt: NOW - 100_000 }), NOW, 90_000);
    expect(judged.problem).toBeNull();
    expect(judged.point).toMatchObject({ fresh: false, ageSeconds: 100_000 });
  });
});

describe('judgeFeed', () => {
  it('halts a symbol whose oracle is paused, or whose pause flag could not be read', () => {
    expect(judgeFeed(TOKEN, read({ oraclePaused: true }), NOW, 90_000).point.fresh).toBe(false);
    expect(judgeFeed(TOKEN, read({ oraclePaused: null }), NOW, 90_000).point.fresh).toBe(false);
    expect(judgeFeed(TOKEN, read({ oraclePaused: false }), NOW, 90_000).point.fresh).toBe(true);
  });

  it('ignores oraclePaused for a crypto entry, which has no token to ask', () => {
    expect(judgeFeed(COIN, read({ oraclePaused: true }), NOW, 90_000).point.fresh).toBe(true);
    expect(judgeFeed(COIN, read({ oraclePaused: null }), NOW, 90_000).point.fresh).toBe(true);
    expect(judgeFeed(COIN, read({ updatedAt: NOW - 90_001 }), NOW, 90_000).point.fresh).toBe(false);
  });

  it.each([
    ['updated_at_zero', read({ updatedAt: 0 })],
    ['updated_at_in_future', read({ updatedAt: NOW + FUTURE_TOLERANCE_SECONDS + 1 })],
    ['price_below_minimum', read({ answer: 1n })],
    ['decimals_mismatch', read({ decimals: 18 })],
    ['answer_not_positive', read({ answer: -5n })],
    ['read_failed', read({ round: null })],
  ] as const)('marks a crypto answer with %s unread: price 0, not fresh', (problem, coinRead) => {
    const judged = judgeFeed(COIN, coinRead, NOW, 90_000);
    expect(judged.problem).toBe(problem);
    expect(judged.point).toMatchObject({ symbol: 'BTC', priceMicro: 0, fresh: false });
  });

  it('shows an invalid answer as not fresh, with the problem, and never throws', () => {
    const judged = judgeFeed(TOKEN, { round: null, decimals: null, oraclePaused: null }, NOW, 90_000);
    expect(judged.problem).toBe('read_failed');
    expect(judged.point.fresh).toBe(false);
  });
});

describe('marketIsQuiet: the quiet rule', () => {
  const feeds = (...ages: number[]) => ages.map((age) => judgeFeed(TOKEN, read({ updatedAt: NOW - age }), NOW, 90_000));

  it('is quiet when the newest feed is older than the limit, and not at the limit', () => {
    expect(MARKET_QUIET_AFTER_SECONDS).toBe(10_800);
    expect(marketIsQuiet(feeds(10_801, 20_000), MARKET_QUIET_AFTER_SECONDS)).toBe(true);
    expect(marketIsQuiet(feeds(10_800, 20_000), MARKET_QUIET_AFTER_SECONDS)).toBe(false);
  });

  it('is decided by the newest feed of the universe, not by an old one', () => {
    expect(marketIsQuiet(feeds(86_000, 60, 86_000), MARKET_QUIET_AFTER_SECONDS)).toBe(false);
  });

  it('is quiet for an empty universe and for a limit that is not a number, so a bad setting fails closed', () => {
    expect(marketIsQuiet([], MARKET_QUIET_AFTER_SECONDS)).toBe(true);
    expect(marketIsQuiet(feeds(1), Number.NaN)).toBe(true);
  });
});

describe('decideOpen: the open rule and the reason that wins', () => {
  const ok = judgeFeed(TOKEN, read(), NOW, 90_000);
  const stale = judgeFeed(TOKEN, read({ updatedAt: NOW - 100_000 }), NOW, 90_000);
  const invalid = judgeFeed(TOKEN, read({ answer: 0n }), NOW, 90_000);

  it('is open with every feed good', () => {
    expect(decideOpen([ok, ok, ok], MARKET_QUIET_AFTER_SECONDS)).toEqual({ open: true, closedReason: null });
  });

  it(`allows ${MAX_HALTED_FEEDS} halted symbols and closes with the next`, () => {
    expect(decideOpen([ok, stale, stale], MARKET_QUIET_AFTER_SECONDS).open).toBe(true);
    expect(decideOpen([ok, stale, stale, stale], MARKET_QUIET_AFTER_SECONDS)).toEqual({
      open: false,
      closedReason: 'feeds_stale',
    });
  });

  it('closes with feed_invalid for one invalid answer, whatever else is true', () => {
    expect(decideOpen([ok, invalid], MARKET_QUIET_AFTER_SECONDS).closedReason).toBe('feed_invalid');
    expect(decideOpen([invalid, stale, stale, stale], MARKET_QUIET_AFTER_SECONDS).closedReason).toBe('feed_invalid');
  });

  it('closes with feeds_stale for a quiet market, even with no symbol halted', () => {
    const quiet = judgeFeed(TOKEN, read({ updatedAt: NOW - 20_000 }), NOW, 90_000);
    expect(quiet.point.fresh).toBe(true);
    expect(decideOpen([quiet, quiet], MARKET_QUIET_AFTER_SECONDS)).toEqual({
      open: false,
      closedReason: 'feeds_stale',
    });
  });

  it('never lets a crypto feed decide: invalid, stale or unread, it halts only its own symbol', () => {
    const coinInvalid = judgeFeed(COIN, read({ answer: 0n }), NOW, 90_000);
    const coinUnread = judgeFeed(COIN, { round: null, decimals: null, oraclePaused: null }, NOW, 90_000);
    const coinStale = judgeFeed(COIN, read({ updatedAt: NOW - 100_000 }), NOW, 90_000);
    expect(coinInvalid.problem).toBe('answer_not_positive');
    expect(coinUnread.problem).toBe('read_failed');
    expect(decideOpen([ok, coinInvalid, coinUnread, coinStale], MARKET_QUIET_AFTER_SECONDS)).toEqual({
      open: true,
      closedReason: null,
    });
    // Two halted Stock Tokens and three halted coins: still open.
    expect(decideOpen([ok, stale, stale, coinStale, coinStale, coinStale], MARKET_QUIET_AFTER_SECONDS).open).toBe(true);
  });

  it('is quiet when only a crypto feed has published: the Stock Tokens decide', () => {
    const quietStock = judgeFeed(TOKEN, read({ updatedAt: NOW - 40 * 3_600 }), NOW, 90_000);
    const freshCoin = judgeFeed(COIN, read({ updatedAt: NOW - 5 }), NOW, 90_000);
    expect(decideOpen([quietStock, quietStock, freshCoin], MARKET_QUIET_AFTER_SECONDS)).toEqual({
      open: false,
      closedReason: 'feeds_stale',
    });
    // With no Stock Token at all, the market is closed.
    expect(decideOpen([freshCoin], MARKET_QUIET_AFTER_SECONDS)).toEqual({ open: false, closedReason: 'feeds_stale' });
  });

  it('never answers held_for_review: the scheduler gives that reason', () => {
    for (const feeds of [[ok], [stale], [invalid], []]) {
      expect(decideOpen(feeds, MARKET_QUIET_AFTER_SECONDS).closedReason).not.toBe('held_for_review');
    }
  });
});

describe('nodeIsCurrent', () => {
  it('speaks for the present when the latest block is at most 300 seconds old', () => {
    expect(NODE_LAG_TOLERANCE_SECONDS).toBe(300);
    expect(nodeIsCurrent(BigInt(NOW - 300), NOW)).toBe(true);
    expect(nodeIsCurrent(BigInt(NOW - 301), NOW)).toBe(false);
  });

  it('refuses a block more than five minutes ahead, and an unknown time', () => {
    expect(nodeIsCurrent(BigInt(NOW + 300), NOW)).toBe(true);
    expect(nodeIsCurrent(BigInt(NOW + 301), NOW)).toBe(false);
    expect(nodeIsCurrent(null, NOW)).toBe(false);
  });
});

describe('buildSnapshot and closedSnapshot', () => {
  const now = new Date(NOW * 1_000);
  const reads = UNIVERSE.map((token) => ({
    ...read({ answer: 100n * 10n ** BigInt(token.feedDecimals) }),
    decimals: token.feedDecimals,
  }));

  it('builds an open snapshot, one price per token in universe order', () => {
    const snapshot = buildSnapshot({
      now,
      universe: UNIVERSE,
      blockNumber: 12_345n,
      reads,
      staleAfterSeconds: 90_000,
      cryptoStaleAfterSeconds: 90_000,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    });
    expect(snapshot).toMatchObject({ open: true, closedReason: null, blockNumber: 12_345, takenAt: now.toISOString() });
    expect(snapshot.prices.map((point) => point.symbol)).toEqual(UNIVERSE.map((token) => token.symbol));
    expect(snapshot.prices.every((point) => point.priceMicro === 100_000_000)).toBe(true);
    expect(snapshot.prices.every((point) => point.fresh)).toBe(true);
  });

  it('judges a crypto entry by cryptoStaleAfterSeconds and a Stock Token by staleAfterSeconds', () => {
    const snapshot = buildSnapshot({
      now,
      universe: [TOKEN, COIN],
      blockNumber: 1n,
      reads: [read({ updatedAt: NOW - 100 }), read({ updatedAt: NOW - 100 })],
      staleAfterSeconds: 200,
      cryptoStaleAfterSeconds: 99,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    });
    expect(snapshot.open).toBe(true);
    expect(snapshot.prices.map((point) => point.fresh)).toEqual([true, false]);
  });

  it('keeps the market open when a crypto read is missing, and halts that symbol', () => {
    const snapshot = buildSnapshot({
      now,
      universe: [TOKEN, COIN],
      blockNumber: 1n,
      reads: [read()],
      staleAfterSeconds: 90_000,
      cryptoStaleAfterSeconds: 90_000,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    });
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(snapshot.prices.map((point) => point.fresh)).toEqual([true, false]);
  });

  it('treats a missing Stock Token read as a failed one, which closes the market', () => {
    const snapshot = buildSnapshot({
      now,
      universe: UNIVERSE,
      blockNumber: 1n,
      // The last Stock Token, and the crypto entries after it, have no read.
      reads: reads.slice(0, UNIVERSE.filter(isStockToken).length - 1),
      staleAfterSeconds: 90_000,
      cryptoStaleAfterSeconds: 90_000,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    });
    expect(snapshot.closedReason).toBe('feed_invalid');
  });

  it('gives a closed snapshot block zero and no prices', () => {
    expect(closedSnapshot(now, 'rpc_unavailable')).toMatchObject({
      blockNumber: 0,
      open: false,
      closedReason: 'rpc_unavailable',
      prices: [],
    });
  });
});

describe('agreedSnapshot: the Stock Tokens must agree; a crypto difference only unreads the coin', () => {
  const now = new Date(NOW * 1_000);
  const build = (coinAnswer: bigint, stockAnswer = 18_241_000_000n) =>
    buildSnapshot({
      now,
      universe: [TOKEN, COIN],
      blockNumber: 1n,
      reads: [read({ answer: stockAnswer }), read({ answer: coinAnswer })],
      staleAfterSeconds: 90_000,
      cryptoStaleAfterSeconds: 90_000,
      quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    });
  const cryptoSymbols = new Set([COIN.symbol]);

  it('returns the first snapshot unchanged when the two agree on every point', () => {
    const a = build(6_000_000_000_000n);
    expect(agreedSnapshot(a, build(6_000_000_000_000n), cryptoSymbols)).toEqual(a);
  });

  it('returns the first snapshot with a differing crypto point marked unread', () => {
    const a = build(6_000_000_000_000n);
    const agreed = agreedSnapshot(a, build(7_000_000_000_000n), cryptoSymbols);
    expect(agreed?.open).toBe(true);
    expect(agreed?.closedReason).toBeNull();
    expect(agreed?.prices[0]).toEqual(a.prices[0]);
    expect(agreed?.prices[1]).toEqual({ ...a.prices[1], priceMicro: 0, fresh: false });
  });

  it('refuses when a Stock Token point differs', () => {
    expect(agreedSnapshot(build(6_000_000_000_000n), build(6_000_000_000_000n, 10n ** 8n), cryptoSymbols)).toBeNull();
  });

  it('refuses when the open state, the reason, the chain, the time or the symbols differ', () => {
    const a = build(6_000_000_000_000n);
    const [stock, coin] = a.prices as [PricePoint, PricePoint];
    expect(agreedSnapshot(a, { ...a, open: false, closedReason: 'feeds_stale' }, cryptoSymbols)).toBeNull();
    expect(agreedSnapshot(a, { ...a, takenAt: new Date((NOW + 1) * 1_000).toISOString() }, cryptoSymbols)).toBeNull();
    expect(agreedSnapshot(a, { ...a, chainId: 1 as typeof a.chainId }, cryptoSymbols)).toBeNull();
    expect(agreedSnapshot(a, { ...a, prices: [stock, { ...coin, symbol: 'ETH' }] }, cryptoSymbols)).toBeNull();
    expect(agreedSnapshot(a, { ...a, prices: [stock] }, cryptoSymbols)).toBeNull();
  });

  it('treats a difference on a symbol outside the crypto set as a disagreement', () => {
    expect(agreedSnapshot(build(6_000_000_000_000n), build(7_000_000_000_000n), new Set())).toBeNull();
  });
});
