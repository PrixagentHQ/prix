// The price strip at 25 symbols (docs/CONTRACTS.md section 23): the API's order kept, the five coins
// as one group after the Stock Tokens, and a coin that was not fresh at the round said in words.
// Run: pnpm exec vitest run --config apps/web/src/arena/vitest.config.ts
import type { MarketPricesResponse } from '@prix/contracts';
import { STOCK_UNIVERSE_SIZE, UNIVERSE_SIZE } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { kindAt, tickerOf } from './board.ts';

// Sample data for this check only: the symbols of the universe, in the contract's order, at made-up prices.
const STOCKS = ['AAPL', 'AMD', 'AMZN', 'COIN', 'CRCL', 'GME', 'GOOGL', 'INTC', 'META', 'MSFT'];
const MORE_STOCKS = ['MSTR', 'MU', 'NVDA', 'PLTR', 'QQQ', 'SGOV', 'SPCX', 'SPY', 'TSLA', 'USO'];
const COINS = ['BTC', 'ETH', 'BNB', 'HYPE', 'SOL'];
const SYMBOLS = [...STOCKS, ...MORE_STOCKS, ...COINS];

function answer(notFresh: readonly string[]): MarketPricesResponse {
  return {
    tickId: '2026-10-09T15:00Z',
    takenAt: '2026-10-09T15:00:04.000Z',
    prices: SYMBOLS.map((symbol, index) => ({
      symbol,
      name: `${symbol} name`,
      priceMicro: (index + 1) * 12_340_000,
      changeBps: index % 3 === 0 ? -125 : 210,
      fresh: !notFresh.includes(symbol),
    })),
  };
}

describe('the price strip at 25 symbols', () => {
  it('shows every symbol the API sent, in its order', () => {
    const ticker = tickerOf(answer([]));
    expect(SYMBOLS).toHaveLength(UNIVERSE_SIZE);
    expect(ticker?.items.map((item) => item.symbol)).toEqual(SYMBOLS);
  });

  it('puts the five coins in one crypto group after the Stock Tokens', () => {
    const items = tickerOf(answer([]))?.items ?? [];
    expect(items.slice(0, STOCK_UNIVERSE_SIZE).every((item) => item.kind === 'stock')).toBe(true);
    expect(items.slice(STOCK_UNIVERSE_SIZE).map((item) => [item.symbol, item.kind])).toEqual(
      COINS.map((symbol) => [symbol, 'crypto']),
    );
    expect(kindAt(STOCK_UNIVERSE_SIZE - 1)).toBe('stock');
    expect(kindAt(STOCK_UNIVERSE_SIZE)).toBe('crypto');
  });

  it('says a coin that was not fresh was not traded this round, with no chain words', () => {
    const items = tickerOf(answer(['SOL']))?.items ?? [];
    const sol = items.find((item) => item.symbol === 'SOL');
    expect(sol?.price).toBe('$308.50, not traded this round');
    expect(sol?.price).not.toMatch(/arbitrum|chain|sequencer|rpc|stale/i);
    // Its change on the day is still the API's, with its sign.
    expect(sol?.change).toBe('−1.25%');
    expect(sol?.tone).toBe('loss');
    for (const item of items.filter((entry) => entry.symbol !== 'SOL')) {
      expect(item.price).not.toMatch(/not traded/);
    }
  });

  it('says the same of every coin of the second chain when that chain was not read', () => {
    const items = tickerOf(answer(['BNB', 'HYPE', 'SOL']))?.items ?? [];
    const halted = items.filter((item) => item.price.endsWith(', not traded this round')).map((item) => item.symbol);
    expect(halted).toEqual(['BNB', 'HYPE', 'SOL']);
  });

  it('shows nothing before the first round', () => {
    expect(tickerOf({ tickId: null, takenAt: null, prices: [] })).toBeNull();
    expect(tickerOf(null)).toBeNull();
  });
});
