import type { DailyPrices, MarketSnapshot, UniverseToken } from '@prix/contracts';
import {
  CHAIN_ID,
  CRYPTO_FEED_STALE_AFTER_SECONDS,
  CRYPTO_UNIVERSE_SIZE,
  FEED_STALE_AFTER_SECONDS,
  isStockToken,
  MARKET_QUIET_AFTER_SECONDS,
  MAX_HALTED_FEEDS,
  MIN_PRICE_MICRO,
  marketSnapshotSchema,
  STOCK_UNIVERSE_SIZE,
  UNIVERSE_SIZE,
  universeTokenSchema,
} from '@prix/contracts';
import { computeRecentReturns, createMarket, FEED_SOURCE_URL, haltedSymbols, toPriceMap, UNIVERSE } from '@prix/market';
import { UNIVERSE_TOKEN_BY_ADDRESS } from '@prix/market/wallet-activity';
import { MULTICALL_ADDRESS } from '@prix/market/wire';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FeedState } from '../support/fake-rpc.ts';
import { FakeRpc } from '../support/fake-rpc.ts';
import { makeSnapshot, TEST_PRICES, utc } from '../support/fixtures.ts';

/**
 * The market of docs/CONTRACTS.md section 5: the universe, the conversion of a feed answer
 * to a price, the rule that says whether the market is open, and recent returns.
 * The chain is a fake JSON-RPC endpoint (tests/support/fake-rpc.ts). Nothing here is live.
 */

const NOW = utc('2026-10-06T15:00:07.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const PRIMARY = 'https://rpc-primary.test';
const FALLBACK = 'https://rpc-fallback.test';

/** The price a feed answer stands for, by the formula of section 5, computed with BigInt. */
function expectedPriceMicro(answer: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number((answer * 1_000_000n * 2n + scale) / (2n * scale));
}

/** A plausible answer for a token: its position in the universe decides the price. */
function answerFor(token: UniverseToken, index: number): bigint {
  const usdTimesTenThousand = BigInt(250_000 + index * 137_911);
  return (usdTimesTenThousand * 10n ** BigInt(token.feedDecimals)) / 10_000n;
}

interface Scene {
  rpc: FakeRpc;
  setFeed(symbol: string, patch: Partial<FeedState>): void;
  take(options?: {
    rpcUrls?: string[];
    staleAfterSeconds?: number;
    cryptoStaleAfterSeconds?: number;
    quietAfterSeconds?: number;
    now?: Date;
  }): Promise<MarketSnapshot>;
}

function scene(): Scene {
  const rpc = new FakeRpc();
  rpc.blockTimestamp = NOW_SECONDS - 3;
  UNIVERSE.forEach((token, index) => {
    rpc.setFeed(token.feedAddress, {
      answer: answerFor(token, index),
      updatedAt: NOW_SECONDS - 30 - index,
      decimals: token.feedDecimals,
    });
  });
  const tokenOf = (symbol: string): UniverseToken => {
    const token = UNIVERSE.find((entry) => entry.symbol === symbol);
    if (!token) throw new Error(`no universe token ${symbol}`);
    return token;
  };
  return {
    rpc,
    setFeed(symbol, patch) {
      const token = tokenOf(symbol);
      const current = rpc.feeds.get(token.feedAddress.toLowerCase()) as FeedState;
      rpc.setFeed(token.feedAddress, { ...current, ...patch });
    },
    take(options = {}) {
      const market = createMarket({
        rpcUrls: options.rpcUrls ?? [PRIMARY, FALLBACK],
        staleAfterSeconds: options.staleAfterSeconds ?? FEED_STALE_AFTER_SECONDS,
        cryptoStaleAfterSeconds: options.cryptoStaleAfterSeconds ?? CRYPTO_FEED_STALE_AFTER_SECONDS,
        quietAfterSeconds: options.quietAfterSeconds ?? MARKET_QUIET_AFTER_SECONDS,
        fetch: rpc.fetch,
      });
      return market.takeSnapshot(options.now ?? NOW);
    },
  };
}

/** The symbol at a position of the universe. Fails clearly while the universe is not filled in. */
function symbolAt(index: number): string {
  const token = UNIVERSE[index];
  if (!token) throw new Error(`the universe has no token at position ${index}`);
  return token.symbol;
}

/** The Stock Token symbols, and the positions of the crypto assets in the universe. */
const STOCK_SYMBOLS = (): string[] => UNIVERSE.filter(isStockToken).map((token) => token.symbol);
const BTC_INDEX = STOCK_UNIVERSE_SIZE;
const ETH_INDEX = STOCK_UNIVERSE_SIZE + 1;

describe('UNIVERSE', () => {
  it('holds exactly 20 Stock Tokens, then the two crypto assets of section 21', () => {
    expect(UNIVERSE_SIZE).toBe(22);
    expect(UNIVERSE).toHaveLength(UNIVERSE_SIZE);
    expect(UNIVERSE.filter(isStockToken)).toHaveLength(STOCK_UNIVERSE_SIZE);
    expect(UNIVERSE.filter((token) => token.kind === 'crypto')).toHaveLength(CRYPTO_UNIVERSE_SIZE);
    // The Stock Tokens first, in symbol order, then the crypto assets in symbol order.
    expect(UNIVERSE.slice(0, STOCK_UNIVERSE_SIZE).every(isStockToken)).toBe(true);
    const stocks = STOCK_SYMBOLS();
    expect(stocks).toEqual([...stocks].sort());
  });

  it('lists BTC and ETH with the feeds of section 21, read on chain on 2026-10-09', () => {
    expect(UNIVERSE[BTC_INDEX]).toEqual({
      kind: 'crypto',
      symbol: 'BTC',
      name: 'Bitcoin',
      feedAddress: '0xa2c5184bf03d373dc9de4876eb4bce595b460251',
      feedDecimals: 8,
      sourceUrl: FEED_SOURCE_URL,
      readOn: '2026-10-09',
    });
    expect(UNIVERSE[ETH_INDEX]).toEqual({
      kind: 'crypto',
      symbol: 'ETH',
      name: 'Ethereum',
      feedAddress: '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9',
      feedDecimals: 8,
      sourceUrl: FEED_SOURCE_URL,
      readOn: '2026-10-09',
    });
  });

  it('gives every token a valid shape, with the source and the date its addresses were read', () => {
    expect(UNIVERSE.length).toBeGreaterThan(0);
    for (const token of UNIVERSE) {
      const parsed = universeTokenSchema.safeParse(token);
      expect(parsed.success, `${token.symbol}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(token.sourceUrl.startsWith('https://')).toBe(true);
    }
  });

  it('never repeats a symbol, a token address or a feed address', () => {
    expect(UNIVERSE.length).toBeGreaterThan(0);
    expect(new Set(UNIVERSE.map((token) => token.symbol)).size).toBe(UNIVERSE.length);
    const stocks = UNIVERSE.filter(isStockToken);
    expect(new Set(stocks.map((token) => token.tokenAddress)).size).toBe(stocks.length);
    expect(new Set(UNIVERSE.map((token) => token.feedAddress)).size).toBe(UNIVERSE.length);
    const tokens = new Set(stocks.map((token) => token.tokenAddress));
    for (const token of UNIVERSE) expect(tokens.has(token.feedAddress)).toBe(false);
  });

  it('keeps wallet activity to Stock Tokens: no crypto entry has a token address to watch', () => {
    expect(UNIVERSE_TOKEN_BY_ADDRESS.size).toBe(STOCK_UNIVERSE_SIZE);
    expect([...UNIVERSE_TOKEN_BY_ADDRESS.values()]).toEqual(STOCK_SYMBOLS());
  });

  it('does not list cash, and no entry is a zero address', () => {
    expect(UNIVERSE.length).toBeGreaterThan(0);
    for (const token of UNIVERSE) {
      expect(['CASH', 'USD', 'USDC']).not.toContain(token.symbol);
      if (isStockToken(token)) expect(token.tokenAddress).not.toBe(`0x${'0'.repeat(40)}`);
      expect(token.feedAddress).not.toBe(`0x${'0'.repeat(40)}`);
    }
  });
});

describe('market.takeSnapshot: an open market', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  it('is open when the RPC answers and every feed is valid and fresh', async () => {
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.open).toBe(true);
    expect(snapshot.closedReason).toBeNull();
    expect(snapshot.chainId).toBe(CHAIN_ID);
    expect(snapshot.takenAt).toBe(NOW.toISOString());
    expect(snapshot.blockNumber).toBe(s.rpc.blockNumber);
  });

  it('lists one price per universe token, in universe order', async () => {
    const snapshot = await s.take();
    expect(snapshot.prices).toHaveLength(UNIVERSE_SIZE);
    expect(snapshot.prices.map((point) => point.symbol)).toEqual(UNIVERSE.map((token) => token.symbol));
  });

  it('reports when each feed last updated and how old that is', async () => {
    const snapshot = await s.take();
    snapshot.prices.forEach((point, index) => {
      expect(point.updatedAt).toBe(new Date((NOW_SECONDS - 30 - index) * 1_000).toISOString());
      expect(point.ageSeconds).toBe(30 + index);
      expect(point.fresh).toBe(true);
    });
  });

  it('converts every answer to micro-USD by the formula of section 5', async () => {
    const snapshot = await s.take();
    UNIVERSE.forEach((token, index) => {
      expect(snapshot.prices[index]?.priceMicro).toBe(expectedPriceMicro(answerFor(token, index), token.feedDecimals));
    });
  });

  it('rounds half up when the feed has more than six decimals', async () => {
    const first = UNIVERSE[0];
    const second = UNIVERSE[1];
    const third = UNIVERSE[2];
    expect(first && second && third).toBeTruthy();
    if (!first || !second || !third) return;
    // In the feed's own decimals: 123.4567895 rounds up to 123.456790, 123.4567894999 rounds
    // down to 123.456789, and 123.456789 is exact. For a feed of six decimals or fewer the
    // three answers are exact and the formula must return them unchanged.
    const unit = (token: UniverseToken) => 10n ** BigInt(token.feedDecimals);
    const half = (123_456_789n * unit(first) + unit(first) / 2n) / 1_000_000n;
    const belowHalf = (123_456_789n * unit(second) + unit(second) / 2n) / 1_000_000n - 1n;
    const exact = (123_456_789n * unit(third)) / 1_000_000n;
    s.setFeed(first.symbol, { answer: half });
    s.setFeed(second.symbol, { answer: belowHalf });
    s.setFeed(third.symbol, { answer: exact });

    const snapshot = await s.take();
    expect(snapshot.prices[0]?.priceMicro).toBe(expectedPriceMicro(half, first.feedDecimals));
    expect(snapshot.prices[1]?.priceMicro).toBe(expectedPriceMicro(belowHalf, second.feedDecimals));
    expect(snapshot.prices[2]?.priceMicro).toBe(expectedPriceMicro(exact, third.feedDecimals));
    if (first.feedDecimals === 8) {
      // 123.45678950 -> 123,456,790 and 123.45678949 -> 123,456,789, written out by hand.
      expect(half).toBe(12_345_678_950n);
      expect(snapshot.prices[0]?.priceMicro).toBe(123_456_790);
    }
    if (second.feedDecimals === 8) {
      expect(belowHalf).toBe(12_345_678_949n);
      expect(snapshot.prices[1]?.priceMicro).toBe(123_456_789);
    }
    expect(snapshot.prices[2]?.priceMicro).toBe(
      third.feedDecimals >= 6 ? 123_456_789 : expectedPriceMicro(exact, third.feedDecimals),
    );
  });

  it('keeps a very large price exact', async () => {
    const token = UNIVERSE[0];
    if (!token) throw new Error('the universe is empty');
    // 7,654,321.123456 USD.
    const answer = (7_654_321_123_456n * 10n ** BigInt(token.feedDecimals)) / 1_000_000n;
    s.setFeed(token.symbol, { answer });
    const snapshot = await s.take();
    expect(snapshot.prices[0]?.priceMicro).toBe(expectedPriceMicro(answer, token.feedDecimals));
    expect(Number.isSafeInteger(snapshot.prices[0]?.priceMicro)).toBe(true);
  });

  it('sends one eth_call, to the Multicall, with the calldata that @prix/market/wire builds', async () => {
    await s.take();
    expect(s.rpc.callTargets).toEqual([MULTICALL_ADDRESS.toLowerCase()]);
    expect(s.rpc.httpRequests.at(0)?.methods).toEqual(['eth_call']);
  });

  it("reads each feed and each Stock Token's pause flag, and no pool: a pool price is not a reference price", async () => {
    await s.take();
    const expected = new Set<string>([
      MULTICALL_ADDRESS.toLowerCase(),
      ...UNIVERSE.map((token) => token.feedAddress.toLowerCase()),
      ...UNIVERSE.filter(isStockToken).map((token) => token.tokenAddress.toLowerCase()),
    ]);
    expect(s.rpc.calledAddresses).toEqual(expected);
  });

  it('makes one batched read, not one request per feed', async () => {
    await s.take();
    // One batched read, with room for a block-number or chain-id request beside it.
    expect(s.rpc.requestsTo(PRIMARY)).toBeGreaterThan(0);
    expect(s.rpc.requestsTo(PRIMARY)).toBeLessThanOrEqual(3);
    expect(s.rpc.requestsTo(FALLBACK)).toBe(0);
  });
});

describe('market.takeSnapshot: stale feeds', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  it('treats a feed as fresh at exactly the threshold and as stale one second later', async () => {
    s.setFeed(symbolAt(3), { updatedAt: NOW_SECONDS - FEED_STALE_AFTER_SECONDS });
    s.setFeed(symbolAt(4), { updatedAt: NOW_SECONDS - FEED_STALE_AFTER_SECONDS - 1 });
    const snapshot = await s.take();
    expect(snapshot.prices[3]).toMatchObject({ fresh: true, ageSeconds: FEED_STALE_AFTER_SECONDS });
    expect(snapshot.prices[4]).toMatchObject({ fresh: false, ageSeconds: FEED_STALE_AFTER_SECONDS + 1 });
  });

  it('stays open with up to two stale feeds and halts those symbols', async () => {
    expect(MAX_HALTED_FEEDS).toBe(2);
    s.setFeed(symbolAt(5), { updatedAt: NOW_SECONDS - FEED_STALE_AFTER_SECONDS - 1 });
    s.setFeed(symbolAt(11), { updatedAt: NOW_SECONDS - 100_000 });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(snapshot.closedReason).toBeNull();
    expect(snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual([
      symbolAt(5),
      symbolAt(11),
    ]);
    // A halted symbol keeps its last price, so it can still be valued.
    expect(snapshot.prices[5]?.priceMicro).toBeGreaterThan(0);
  });

  it('closes with three stale feeds', async () => {
    for (const index of [1, 2, 3]) s.setFeed(symbolAt(index), { updatedAt: NOW_SECONDS - 100_000 });
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('feeds_stale');
    expect(snapshot.prices).toHaveLength(UNIVERSE_SIZE);
  });

  it('closes on a weekend or a holiday, when every feed is stale', async () => {
    for (const token of UNIVERSE) s.setFeed(token.symbol, { updatedAt: NOW_SECONDS - 40 * 3_600 });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('feeds_stale');
    expect(snapshot.prices.every((point) => !point.fresh)).toBe(true);
  });

  it('uses the threshold it is given', async () => {
    s.setFeed(symbolAt(0), { updatedAt: NOW_SECONDS - 61 });
    const strict = await s.take({ staleAfterSeconds: 60 });
    expect(strict.prices[0]?.fresh).toBe(false);
    const loose = await s.take({ staleAfterSeconds: 61 });
    expect(loose.prices[0]?.fresh).toBe(true);
  });
});

describe('market.takeSnapshot: a quiet market, a paused oracle and the reason that wins', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  const setAllUpdated = (secondsAgo: number): void => {
    for (const token of UNIVERSE) s.setFeed(token.symbol, { updatedAt: NOW_SECONDS - secondsAgo });
  };

  it('is closed with feeds_stale when no feed has published for more than three hours, with no symbol halted', async () => {
    setAllUpdated(MARKET_QUIET_AFTER_SECONDS + 1);
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('feeds_stale');
    // On a Saturday every feed is younger than 25 hours: nothing needs to be halted.
    expect(snapshot.prices.every((point) => point.fresh)).toBe(true);
  });

  it('is open when one feed of the universe has published inside the quiet limit, exactly at it', async () => {
    setAllUpdated(MARKET_QUIET_AFTER_SECONDS + 600);
    s.setFeed(symbolAt(9), { updatedAt: NOW_SECONDS - MARKET_QUIET_AFTER_SECONDS });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(snapshot.closedReason).toBeNull();
  });

  it('uses the quiet limit it is given', async () => {
    setAllUpdated(120);
    expect((await s.take({ quietAfterSeconds: 119 })).closedReason).toBe('feeds_stale');
    expect((await s.take({ quietAfterSeconds: 120 })).open).toBe(true);
  });

  it('halts a symbol whose token reports that its oracle is paused, and stays open', async () => {
    s.setFeed(symbolAt(4), { oraclePaused: true });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual([symbolAt(4)]);
    // The price is still shown, so a holding can be valued.
    expect(snapshot.prices[4]?.priceMicro).toBeGreaterThan(0);
  });

  it('halts only that symbol when its pause flag cannot be read, and does not close the market', async () => {
    s.setFeed(symbolAt(6), { pauseReadFails: true });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual([symbolAt(6)]);
  });

  it('closes with feeds_stale when more than two oracles are paused', async () => {
    for (const index of [1, 2, 3]) s.setFeed(symbolAt(index), { oraclePaused: true });
    const snapshot = await s.take();
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('feeds_stale');
  });

  it('answers feed_invalid before feeds_stale when both are true', async () => {
    for (const index of [1, 2, 3]) s.setFeed(symbolAt(index), { updatedAt: NOW_SECONDS - 100_000 });
    s.setFeed(symbolAt(8), { answer: 0n });
    expect((await s.take()).closedReason).toBe('feed_invalid');
  });

  it('answers rpc_unavailable before anything else when no endpoint answered for the present', async () => {
    for (const index of [1, 2, 3]) s.setFeed(symbolAt(index), { updatedAt: NOW_SECONDS - 100_000 });
    s.rpc.setMode(PRIMARY, 'network_error');
    s.rpc.setMode(FALLBACK, 'network_error');
    expect((await s.take()).closedReason).toBe('rpc_unavailable');
  });
});

describe('market.takeSnapshot: invalid answers close the market', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  const closedAsInvalid = async (): Promise<void> => {
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('feed_invalid');
  };

  it('an answer of zero', async () => {
    s.setFeed(symbolAt(7), { answer: 0n });
    await closedAsInvalid();
  });

  it('a negative answer', async () => {
    s.setFeed(symbolAt(7), { answer: -18_241_000_000n });
    await closedAsInvalid();
  });

  it('a price below one cent', async () => {
    const token = UNIVERSE[7];
    if (!token) throw new Error('the universe has no token at position 7');
    expect(MIN_PRICE_MICRO).toBe(10_000);
    // 0.009999 USD in the feed's decimals, where the feed has room for it.
    const answer = (9_999n * 10n ** BigInt(token.feedDecimals)) / 1_000_000n;
    s.setFeed(token.symbol, { answer: answer > 0n ? answer : 0n });
    await closedAsInvalid();
  });

  it('a feed whose own decimals differ from the universe entry', async () => {
    const token = UNIVERSE[7];
    if (!token) throw new Error('the universe has no token at position 7');
    s.setFeed(token.symbol, { decimals: token.feedDecimals + 1 });
    await closedAsInvalid();
  });

  it('a failed latestRoundData()', async () => {
    s.setFeed(symbolAt(7), { reverts: true });
    await closedAsInvalid();
  });

  it('a failed decimals()', async () => {
    s.setFeed(symbolAt(7), { decimalsFails: true });
    await closedAsInvalid();
  });

  it('a price that does not fit a safe integer', async () => {
    const token = UNIVERSE[7];
    if (!token) throw new Error('the universe has no token at position 7');
    s.setFeed(token.symbol, { answer: 10n ** BigInt(token.feedDecimals + 16) });
    await closedAsInvalid();
  });

  it('an update time of zero', async () => {
    s.setFeed(symbolAt(7), { updatedAt: 0 });
    await closedAsInvalid();
  });

  it('an update time more than five minutes in the future', async () => {
    s.setFeed(symbolAt(7), { updatedAt: NOW_SECONDS + 301 });
    await closedAsInvalid();
  });

  it('accepts exactly one cent, and an update time a little in the future', async () => {
    const token = UNIVERSE[7];
    if (!token) throw new Error('the universe has no token at position 7');
    s.setFeed(token.symbol, { answer: 10n ** BigInt(token.feedDecimals) / 100n, updatedAt: NOW_SECONDS + 240 });
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.open).toBe(true);
    expect(snapshot.prices[7]?.priceMicro).toBe(
      token.feedDecimals >= 2 ? MIN_PRICE_MICRO : snapshot.prices[7]?.priceMicro,
    );
    expect(snapshot.prices[7]?.fresh).toBe(true);
  });
});

describe('market.takeSnapshot: crypto assets (section 21)', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  const halted = (snapshot: MarketSnapshot): string[] =>
    snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol);

  it('prices BTC and ETH from their feeds, fresh, in an open market', async () => {
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(snapshot.prices[BTC_INDEX]).toMatchObject({ symbol: 'BTC', fresh: true });
    expect(snapshot.prices[ETH_INDEX]).toMatchObject({ symbol: 'ETH', fresh: true });
  });

  it('halts a stale crypto feed and keeps the market open', async () => {
    s.setFeed('BTC', { updatedAt: NOW_SECONDS - CRYPTO_FEED_STALE_AFTER_SECONDS - 1 });
    const snapshot = await s.take();
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(halted(snapshot)).toEqual(['BTC']);
    expect(snapshot.prices[BTC_INDEX]?.priceMicro).toBeGreaterThan(0);
  });

  it('halts an invalid crypto answer and keeps the market open', async () => {
    s.setFeed('ETH', { answer: 0n });
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(halted(snapshot)).toEqual(['ETH']);
  });

  it('halts a crypto feed that could not be read and keeps the market open', async () => {
    s.setFeed('BTC', { reverts: true });
    s.setFeed('ETH', { decimalsFails: true });
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(halted(snapshot)).toEqual(['BTC', 'ETH']);
  });

  it('does not count halted crypto symbols against MAX_HALTED_FEEDS', async () => {
    s.setFeed(symbolAt(1), { updatedAt: NOW_SECONDS - 100_000 });
    s.setFeed(symbolAt(2), { updatedAt: NOW_SECONDS - 100_000 });
    s.setFeed('BTC', { updatedAt: NOW_SECONDS - 100_000 });
    s.setFeed('ETH', { reverts: true });
    const snapshot = await s.take();
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(halted(snapshot)).toEqual([symbolAt(1), symbolAt(2), 'BTC', 'ETH']);
  });

  it('is closed on a weekend: every Stock Token quiet, the crypto feeds fresh', async () => {
    for (const symbol of STOCK_SYMBOLS()) s.setFeed(symbol, { updatedAt: NOW_SECONDS - 40 * 3_600 });
    s.setFeed('BTC', { updatedAt: NOW_SECONDS - 60 });
    s.setFeed('ETH', { updatedAt: NOW_SECONDS - 5 });
    const snapshot = await s.take();
    expect(snapshot).toMatchObject({ open: false, closedReason: 'feeds_stale' });
    expect(snapshot.prices[BTC_INDEX]?.fresh).toBe(true);
    expect(snapshot.prices[ETH_INDEX]?.fresh).toBe(true);
  });

  it('is closed when the Stock Tokens are quiet, though a crypto feed published a second ago', async () => {
    for (const symbol of STOCK_SYMBOLS()) {
      s.setFeed(symbol, { updatedAt: NOW_SECONDS - MARKET_QUIET_AFTER_SECONDS - 1 });
    }
    s.setFeed('ETH', { updatedAt: NOW_SECONDS - 1 });
    expect((await s.take()).closedReason).toBe('feeds_stale');
  });

  it('uses the crypto threshold for crypto and the stock threshold for Stock Tokens', async () => {
    s.setFeed(symbolAt(0), { updatedAt: NOW_SECONDS - 100 });
    s.setFeed('BTC', { updatedAt: NOW_SECONDS - 100 });
    const strictCrypto = await s.take({ cryptoStaleAfterSeconds: 99 });
    expect(halted(strictCrypto)).toEqual(['BTC']);
    const strictStock = await s.take({ staleAfterSeconds: 99 });
    expect(halted(strictStock)).toContain(symbolAt(0));
    expect(halted(strictStock)).not.toContain('BTC');
  });

  it('halts every crypto symbol, and only those, when the crypto threshold is not a number', async () => {
    const snapshot = await s.take({ cryptoStaleAfterSeconds: Number.NaN });
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(halted(snapshot)).toEqual(['BTC', 'ETH']);
  });

  it('never asks a crypto entry for oraclePaused()', async () => {
    // The fake would answer a paused oracle for these if it were asked; the market must not ask.
    s.setFeed('BTC', { oraclePaused: true });
    s.setFeed('ETH', { pauseReadFails: true });
    const snapshot = await s.take();
    expect(halted(snapshot)).toEqual([]);
  });
});

describe('market.takeSnapshot: RPC failures', () => {
  let s: Scene;
  beforeEach(() => {
    s = scene();
  });

  const modes = ['network_error', 'http_500', 'garbage', 'html', 'rpc_error', 'empty_result'] as const;

  it.each(modes)('falls back to the second endpoint when the first answers with %s', async (mode) => {
    s.rpc.setMode(PRIMARY, mode);
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(snapshot.prices).toHaveLength(UNIVERSE_SIZE);
    expect(s.rpc.requestsTo(FALLBACK)).toBeGreaterThan(0);
  });

  it.each(modes)('returns a closed snapshot, and does not throw, when every endpoint answers with %s', async (mode) => {
    s.rpc.setMode(PRIMARY, mode);
    s.rpc.setMode(FALLBACK, mode);
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toEqual({
      takenAt: NOW.toISOString(),
      chainId: CHAIN_ID,
      blockNumber: 0,
      open: false,
      closedReason: 'rpc_unavailable',
      prices: [],
    });
  });

  it('does not try the fallback when an endpoint answers with invalid feed reads: it has answered', async () => {
    s.setFeed(symbolAt(2), { answer: 0n });
    const snapshot = await s.take();
    expect(snapshot.closedReason).toBe('feed_invalid');
    expect(s.rpc.requestsTo(FALLBACK)).toBe(0);
  });

  it('moves on to the fallback when the first endpoint answers with a multicall of the wrong length', async () => {
    s.rpc.setMode(PRIMARY, 'short_answer');
    const snapshot = await s.take();
    expect(snapshot.open).toBe(true);
    expect(s.rpc.requestsTo(FALLBACK)).toBeGreaterThan(0);
  });

  it('treats a node whose latest block is older than 300 seconds as failed, and moves on', async () => {
    s.rpc.blockTimestamp = NOW_SECONDS - 301;
    const snapshot = await s.take();
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('rpc_unavailable');
    // Both endpoints were asked, because the first one had not answered for the present.
    expect(s.rpc.requestsTo(FALLBACK)).toBeGreaterThan(0);
  });

  it('accepts a node whose latest block is exactly 300 seconds old', async () => {
    s.rpc.blockTimestamp = NOW_SECONDS - 300;
    expect((await s.take()).open).toBe(true);
  });

  it('treats a node that cannot tell the time of its block as not current', async () => {
    s.rpc.blockTimestampFails = true;
    expect((await s.take()).closedReason).toBe('rpc_unavailable');
  });

  it('treats an endpoint that answers for another chain as rpc_unavailable', async () => {
    s.rpc.chainId = 1;
    expect((await s.take()).closedReason).toBe('rpc_unavailable');
  });

  it('does not try the fallback when the first endpoint answers', async () => {
    await s.take();
    expect(s.rpc.requestsTo(FALLBACK)).toBe(0);
  });

  it('works with a single endpoint, and closes when that one fails', async () => {
    expect((await s.take({ rpcUrls: [FALLBACK] })).open).toBe(true);
    s.rpc.setMode(FALLBACK, 'network_error');
    const snapshot = await s.take({ rpcUrls: [FALLBACK] });
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('rpc_unavailable');
  });

  it('does not throw and does not open when a feed reverts', async () => {
    s.setFeed(symbolAt(2), { reverts: true });
    const snapshot = await s.take();
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.open).toBe(false);
    expect(snapshot.closedReason).toBe('feed_invalid');
  });

  it('never reaches the network when it is given a fetch', async () => {
    const realFetch = globalThis.fetch;
    let leaked = 0;
    globalThis.fetch = (async () => {
      leaked += 1;
      throw new Error('the global fetch must not be used in a test');
    }) as typeof fetch;
    try {
      await s.take();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(leaked).toBe(0);
  });
});

describe('toPriceMap and haltedSymbols', () => {
  it('maps every symbol of a snapshot to its price, halted ones included', () => {
    const snapshot = makeSnapshot(NOW, { stale: ['NVDA', 'TSLA'] });
    expect(toPriceMap(snapshot)).toEqual({ ...TEST_PRICES });
  });

  it('lists the symbols that are not fresh, in snapshot order', () => {
    expect(haltedSymbols(makeSnapshot(NOW, { stale: ['TSLA', 'NVDA'] }))).toEqual(['NVDA', 'TSLA']);
    expect(haltedSymbols(makeSnapshot(NOW))).toEqual([]);
  });

  it('returns nothing for a snapshot taken while the RPC was down', () => {
    const snapshot = makeSnapshot(NOW, { rpcDown: true });
    expect(toPriceMap(snapshot)).toEqual({});
    expect(haltedSymbols(snapshot)).toEqual([]);
  });
});

describe('computeRecentReturns', () => {
  const symbols = (): string[] => UNIVERSE.map((token) => token.symbol);

  /** `count` earlier trading days, newest first, with every price at `priceAt(dayIndex)`. */
  function history(count: number, priceAt: (dayIndex: number, symbolIndex: number) => number): DailyPrices[] {
    return Array.from({ length: count }, (_, dayIndex) => ({
      day: new Date(Date.UTC(2026, 9, 5) - dayIndex * 86_400_000).toISOString().slice(0, 10),
      prices: Object.fromEntries(symbols().map((symbol, symbolIndex) => [symbol, priceAt(dayIndex, symbolIndex)])),
    }));
  }

  const now = (price: number): Record<string, number> => Object.fromEntries(symbols().map((symbol) => [symbol, price]));

  it('returns one entry per symbol, in universe order', () => {
    expect(symbols().length).toBe(UNIVERSE_SIZE);
    const returns = computeRecentReturns(
      now(100_000_000),
      history(1, () => 100_000_000),
    );
    expect(returns.map((entry) => entry.symbol)).toEqual(symbols());
  });

  it('is null everywhere while the league has no history', () => {
    const returns = computeRecentReturns(now(100_000_000), []);
    expect(returns.length).toBe(UNIVERSE_SIZE);
    for (const entry of returns) expect(entry).toMatchObject({ day1Bps: null, day5Bps: null, day20Bps: null });
  });

  it('compares with the 1st, 5th and 20th most recent earlier trading day', () => {
    // Day 1 closed at 100, day 5 at 80, day 20 at 50, every other day at 1. Now 110.
    const days = history(20, (dayIndex) =>
      dayIndex === 0 ? 100_000_000 : dayIndex === 4 ? 80_000_000 : dayIndex === 19 ? 50_000_000 : 1_000_000,
    );
    const returns = computeRecentReturns(now(110_000_000), days);
    expect(returns.length).toBe(UNIVERSE_SIZE);
    for (const entry of returns) expect(entry).toMatchObject({ day1Bps: 1_000, day5Bps: 3_750, day20Bps: 12_000 });
  });

  it('is null for the periods the history does not reach yet', () => {
    const four = computeRecentReturns(
      now(110_000_000),
      history(4, () => 100_000_000),
    );
    expect(four.length).toBe(UNIVERSE_SIZE);
    for (const entry of four) expect(entry).toMatchObject({ day1Bps: 1_000, day5Bps: null, day20Bps: null });
    const nineteen = computeRecentReturns(
      now(110_000_000),
      history(19, () => 100_000_000),
    );
    for (const entry of nineteen) expect(entry).toMatchObject({ day1Bps: 1_000, day5Bps: 1_000, day20Bps: null });
  });

  it('rounds to whole basis points and reports a fall as negative', () => {
    // (182,410,000 - 183,950,000) * 10,000 / 183,950,000 = -83.72 -> -84.
    // (182,410,000 - 181,000,000) * 10,000 / 181,000,000 = 77.90 -> 78.
    const days = history(5, (dayIndex) => (dayIndex === 0 ? 183_950_000 : 181_000_000));
    const returns = computeRecentReturns(now(182_410_000), days);
    expect(returns.length).toBe(UNIVERSE_SIZE);
    for (const entry of returns) expect(entry).toMatchObject({ day1Bps: -84, day5Bps: 78 });
  });

  it('returns 0, never negative zero, for a fall too small to show', () => {
    const returns = computeRecentReturns(
      now(999_999_999),
      history(1, () => 1_000_000_000),
    );
    expect(returns.length).toBe(UNIVERSE_SIZE);
    for (const entry of returns) {
      expect(Object.is(entry.day1Bps, 0)).toBe(true);
      expect(JSON.stringify(entry.day1Bps)).toBe('0');
    }
  });

  it('does not mutate its input', () => {
    const prices = Object.freeze(now(110_000_000));
    const days = history(3, () => 100_000_000);
    const before = JSON.stringify(days);
    for (const day of days) {
      Object.freeze(day.prices);
      Object.freeze(day);
    }
    Object.freeze(days);
    expect(() => computeRecentReturns(prices, days)).not.toThrow();
    expect(JSON.stringify(days)).toBe(before);
  });
});
