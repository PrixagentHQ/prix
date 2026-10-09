/** Pure helpers over snapshots and stored prices. docs/CONTRACTS.md section 5. */
import type {
  ComputeRecentReturns,
  DailyPrices,
  HaltedSymbols,
  MarketSnapshot,
  TokenSymbol,
  ToPriceMap,
} from '@prix/contracts';
import { UNIVERSE } from './universe.ts';

/** The return from `then` to `now` in basis points, or null where there is no usable earlier price. */
function returnBps(now: number, then: number | undefined): number | null {
  if (then === undefined || !Number.isFinite(then) || then <= 0 || !Number.isFinite(now)) return null;
  const bps = Math.round(((now - then) * 10_000) / then);
  return bps === 0 ? 0 : bps;
}

/**
 * Compares the current prices with the stored prices of the 1st, 5th and 20th most recent earlier
 * trading days. `history` holds earlier trading days only, in any order; it is ordered here by day.
 * Returns one entry per symbol of `prices`: universe symbols first, in universe order, then any
 * other symbol in ascending order. A return is null where the league has no such day yet.
 */
export const computeRecentReturns: ComputeRecentReturns = (prices, history) => {
  const newestFirst: DailyPrices[] = [...history].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const known = new Set<TokenSymbol>(UNIVERSE.map((token) => token.symbol));
  const symbols: TokenSymbol[] = [
    ...UNIVERSE.map((token) => token.symbol).filter((symbol) => Object.hasOwn(prices, symbol)),
    ...Object.keys(prices)
      .filter((symbol) => !known.has(symbol))
      .sort(),
  ];
  const at = (symbol: TokenSymbol, daysBack: number): number | undefined => {
    const day = newestFirst[daysBack - 1];
    return day !== undefined && Object.hasOwn(day.prices, symbol) ? day.prices[symbol] : undefined;
  };
  return symbols.map((symbol) => {
    const now = prices[symbol] as number;
    return {
      symbol,
      day1Bps: returnBps(now, at(symbol, 1)),
      day5Bps: returnBps(now, at(symbol, 5)),
      day20Bps: returnBps(now, at(symbol, 20)),
    };
  });
};

/** The prices of a snapshot by symbol, halted symbols included. */
export const toPriceMap: ToPriceMap = (snapshot: MarketSnapshot) => {
  const map: Record<TokenSymbol, number> = {};
  for (const point of snapshot.prices) map[point.symbol] = point.priceMicro;
  return map;
};

/** The symbols of a snapshot whose `fresh` is false. */
export const haltedSymbols: HaltedSymbols = (snapshot: MarketSnapshot) =>
  snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol);
