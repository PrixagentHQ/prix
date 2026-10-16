import type { MarketSnapshot, UniverseToken } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  CHAIN_ID,
  CRYPTO_UNIVERSE_SIZE,
  cryptoAssetSchema,
  feedChainIdSchema,
  feedChainOf,
  isStockToken,
  marketSnapshotSchema,
  otherChainReadSchema,
  STOCK_UNIVERSE_SIZE,
  UNIVERSE_SIZE,
  universeTokenSchema,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import { describe, expect, it } from 'vitest';
import { ARBITRUM_FEEDS } from '../support/fake-arbitrum.ts';
import { makeSnapshot, TEST_PRICES, TEST_SYMBOLS, utc } from '../support/fixtures.ts';

/**
 * The universe of docs/CONTRACTS.md section 23, and the snapshot shape: 25 symbols, the three new
 * coins after BTC and ETH with their Arbitrum One feeds, every crypto entry naming its feed chain.
 * `otherChains` is optional, so every tick stored before section 23 still parses.
 */

const crypto = (symbol: string): UniverseToken | undefined => UNIVERSE.find((token) => token.symbol === symbol);

describe('the universe at 25 symbols', () => {
  it('counts 20 Stock Tokens and 5 crypto assets', () => {
    expect(STOCK_UNIVERSE_SIZE).toBe(20);
    expect(CRYPTO_UNIVERSE_SIZE).toBe(5);
    expect(UNIVERSE_SIZE).toBe(25);
    expect(UNIVERSE).toHaveLength(25);
  });

  it('keeps every position a stored tick already has, and adds BNB, HYPE and SOL after BTC and ETH', () => {
    expect(UNIVERSE.slice(0, 20).every(isStockToken)).toBe(true);
    expect(UNIVERSE.slice(20).map((token) => token.symbol)).toEqual(['BTC', 'ETH', 'BNB', 'HYPE', 'SOL']);
  });

  it('matches the test universe symbol for symbol', () => {
    expect(UNIVERSE.map((token) => token.symbol)).toEqual([...TEST_SYMBOLS]);
  });

  const expected: [string, string, string][] = [
    ['SOL', 'Solana', ARBITRUM_FEEDS.SOL],
    ['BNB', 'BNB', ARBITRUM_FEEDS.BNB],
    ['HYPE', 'Hyperliquid', ARBITRUM_FEEDS.HYPE],
  ];

  for (const [symbol, name, feed] of expected) {
    it(`lists ${symbol} with its Arbitrum One feed of section 23`, () => {
      const token = crypto(symbol);
      expect(token).toMatchObject({
        kind: 'crypto',
        symbol,
        name,
        feedDecimals: 8,
        readOn: '2026-10-09',
        chainId: ARBITRUM_CHAIN_ID,
      });
      expect(token?.feedAddress.toLowerCase()).toBe(feed);
      // Chainlink's feed page for Arbitrum's network.
      expect(token?.sourceUrl).toMatch(/^https:\/\/docs\.chain\.link\/.*network=arbitrum/);
      expect(universeTokenSchema.safeParse(token).success).toBe(true);
      if (token !== undefined) expect(feedChainOf(token)).toBe(ARBITRUM_CHAIN_ID);
    });
  }

  it('reads BTC and ETH on Robinhood Chain, from its feed page', () => {
    for (const symbol of ['BTC', 'ETH']) {
      const token = crypto(symbol);
      expect(token, symbol).toMatchObject({ chainId: CHAIN_ID });
      expect(token?.sourceUrl, symbol).toMatch(/network=robinhood/);
    }
  });

  it('reads every Stock Token on Robinhood Chain', () => {
    for (const token of UNIVERSE.filter(isStockToken)) expect(feedChainOf(token), token.symbol).toBe(CHAIN_ID);
  });

  it('never repeats a feed address across the two chains', () => {
    const feeds = UNIVERSE.map((token) => token.feedAddress.toLowerCase());
    expect(new Set(feeds).size).toBe(feeds.length);
  });
});

describe('the contract shapes of section 23', () => {
  it('takes only Robinhood Chain and Arbitrum One as feed chains', () => {
    expect(feedChainIdSchema.safeParse(4663).success).toBe(true);
    expect(feedChainIdSchema.safeParse(42161).success).toBe(true);
    for (const other of [1, 10, 8453, 0, '42161']) expect(feedChainIdSchema.safeParse(other).success).toBe(false);
  });

  it('refuses a crypto entry without its feed chain', () => {
    const { chainId: _chain, ...without } = { ...(crypto('BTC') as UniverseToken & { chainId: number }) };
    expect(cryptoAssetSchema.safeParse(without).success).toBe(false);
  });

  it('refuses an otherChains entry with a URL for an endpoint, a fourth position or an unknown problem', () => {
    const good = { chainId: 42161, blockNumber: 1, endpoint: 0, confirmedBy: null, problem: null };
    expect(otherChainReadSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, endpoint: 'https://arb1.arbitrum.io/rpc' },
      { ...good, endpoint: 3 },
      { ...good, confirmedBy: -1 },
      { ...good, problem: 'closed' },
      { ...good, chainId: 1 },
      { ...good, url: 'https://arb1.arbitrum.io/rpc' },
    ]) {
      expect(otherChainReadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('stage 1 ticks still parse', () => {
  const at = utc('2026-10-09T19:00:05.000Z');
  const { BNB: _b, HYPE: _h, SOL: _s, ...stage1Prices } = TEST_PRICES;

  it('a snapshot of 22 symbols with no otherChains, as stored before section 23', () => {
    const snapshot = makeSnapshot(at, { prices: stage1Prices });
    expect(snapshot.prices).toHaveLength(22);
    expect('otherChains' in snapshot).toBe(false);
    expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('a stored stage 1 tick read back from JSON', () => {
    const stored = JSON.parse(JSON.stringify(makeSnapshot(at, { prices: stage1Prices }))) as unknown;
    expect(marketSnapshotSchema.parse(stored).prices.map((point) => point.symbol)).toEqual(Object.keys(stage1Prices));
  });

  it('a stage 1 closed snapshot with no prices', () => {
    expect(marketSnapshotSchema.safeParse(makeSnapshot(at, { rpcDown: true })).success).toBe(true);
  });

  it('a stage 2 snapshot with otherChains, and not one with more than four second chains', () => {
    const read = { chainId: 42161 as const, blockNumber: 391_234_567, endpoint: 0, confirmedBy: null, problem: null };
    const snapshot: MarketSnapshot = makeSnapshot(at, { otherChains: [read] });
    expect(marketSnapshotSchema.parse(snapshot).otherChains).toEqual([read]);
    expect(marketSnapshotSchema.safeParse({ ...snapshot, otherChains: Array(5).fill(read) }).success).toBe(false);
  });
});
