import {
  CRYPTO_UNIVERSE_SIZE,
  isStockToken,
  STOCK_UNIVERSE_SIZE,
  UNIVERSE_SIZE,
  universeTokenSchema,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market/universe';
import { describe, expect, it } from 'vitest';
import { TEST_CRYPTO_SYMBOLS, TEST_PRICES, TEST_STOCK_SYMBOLS, TEST_SYMBOLS } from '../support/fixtures.ts';

/**
 * The universe of docs/CONTRACTS.md section 21 as the other suites rely on it: two kinds, the Stock
 * Tokens by symbol and then the crypto assets by symbol, one namespace of symbols, and the test
 * fixtures in step with it.
 */

const stocks = UNIVERSE.filter((entry) => isStockToken(entry));
const coins = UNIVERSE.filter((entry) => !isStockToken(entry));

describe('the universe with crypto assets', () => {
  it('counts UNIVERSE_SIZE = STOCK_UNIVERSE_SIZE + CRYPTO_UNIVERSE_SIZE = 25 (section 23)', () => {
    expect(UNIVERSE_SIZE).toBe(STOCK_UNIVERSE_SIZE + CRYPTO_UNIVERSE_SIZE);
    expect([STOCK_UNIVERSE_SIZE, CRYPTO_UNIVERSE_SIZE, UNIVERSE_SIZE]).toEqual([20, 5, 25]);
    expect(UNIVERSE).toHaveLength(UNIVERSE_SIZE);
    expect(stocks).toHaveLength(STOCK_UNIVERSE_SIZE);
    expect(coins).toHaveLength(CRYPTO_UNIVERSE_SIZE);
  });

  it('parses every entry with the contract schema', () => {
    for (const entry of UNIVERSE) expect(universeTokenSchema.safeParse(entry).success, entry.symbol).toBe(true);
  });

  it('lists the Stock Tokens by symbol, then BTC and ETH, then BNB, HYPE and SOL (sections 21 and 23)', () => {
    const symbols = UNIVERSE.map((entry) => entry.symbol);
    const stockSymbols = stocks.map((entry) => entry.symbol);
    expect(symbols).toEqual([...stockSymbols, 'BTC', 'ETH', 'BNB', 'HYPE', 'SOL']);
    expect(stockSymbols).toEqual([...stockSymbols].sort());
  });

  it('gives a crypto asset no token address, so no on-chain record can reach one', () => {
    for (const coin of coins) {
      expect(coin.kind).toBe('crypto');
      expect(Object.keys(coin)).not.toContain('tokenAddress');
      expect(Object.keys(coin)).not.toContain('tokenDecimals');
    }
  });

  it('keeps one namespace: no symbol and no feed address is used twice across the two kinds', () => {
    const symbols = UNIVERSE.map((entry) => entry.symbol.toUpperCase());
    expect(new Set(symbols).size).toBe(symbols.length);
    const feeds = UNIVERSE.map((entry) => entry.feedAddress.toLowerCase());
    expect(new Set(feeds).size).toBe(feeds.length);
  });

  it('reads the crypto feeds of section 21 on Robinhood Chain', () => {
    const feedOf = (symbol: string) => coins.find((entry) => entry.symbol === symbol)?.feedAddress.toLowerCase();
    expect(feedOf('ETH')).toBe('0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9');
    expect(feedOf('BTC')).toBe('0xa2c5184bf03d373dc9de4876eb4bce595b460251');
    for (const coin of coins) expect(coin.feedDecimals, coin.symbol).toBe(8);
  });
});

describe('the test fixtures follow the universe', () => {
  it('prices exactly the symbols of the universe, in universe order', () => {
    expect(TEST_SYMBOLS).toEqual(UNIVERSE.map((entry) => entry.symbol));
    expect(Object.keys(TEST_PRICES)).toHaveLength(UNIVERSE_SIZE);
  });

  it('splits the symbols by kind as the universe does', () => {
    expect(TEST_STOCK_SYMBOLS).toEqual(stocks.map((entry) => entry.symbol));
    expect(TEST_CRYPTO_SYMBOLS).toEqual(coins.map((entry) => entry.symbol));
  });
});
