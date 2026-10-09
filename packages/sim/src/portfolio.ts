import type { PortfolioState, PriceMap, TokenSymbol } from '@prix/contracts';
import { STARTING_CASH_MICRO } from '@prix/contracts';
import { fromAmount, label, toAmount, valueAt } from './math.ts';

/** A portfolio read into BigInt. `held` lists the symbols with more than zero units, in the order stored. */
export interface Position {
  symbol: TokenSymbol;
  units: bigint;
}

export interface ReadPortfolio {
  cash: bigint;
  held: Position[];
}

/** A fresh portfolio: `STARTING_CASH_MICRO` in cash and no holdings. A new object on every call. */
export function newPortfolio(): PortfolioState {
  return { cashMicro: STARTING_CASH_MICRO, holdings: {} };
}

/**
 * Reads a stored portfolio without changing it. An entry with zero units is not a holding
 * and is left out. Throws if the cash or a holding is not a safe integer that is zero or positive.
 */
export function readPortfolio(portfolio: PortfolioState): ReadPortfolio {
  const cash = fromAmount(portfolio.cashMicro, 'cashMicro');
  const held: Position[] = [];
  for (const symbol of Object.keys(portfolio.holdings)) {
    const units = fromAmount(portfolio.holdings[symbol], `the holding of ${label(symbol)}`);
    if (units > 0n) held.push({ symbol, units });
  }
  return { cash, held };
}

/** The reference price of a symbol. Throws if it is missing or is not a positive safe integer. */
export function readPrice(prices: PriceMap, symbol: TokenSymbol): bigint {
  if (!Object.hasOwn(prices, symbol)) {
    throw new Error(`@prix/sim: no price for ${label(symbol)}`);
  }
  const price = prices[symbol];
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price <= 0) {
    throw new Error(`@prix/sim: the price of ${label(symbol)} must be a positive safe integer`);
  }
  return BigInt(price);
}

/** Writes holdings back as a plain record, in the order given and without the zero ones. */
export function writePortfolio(cash: bigint, positions: readonly Position[]): PortfolioState {
  const entries: [TokenSymbol, number][] = [];
  for (const { symbol, units } of positions) {
    if (units > 0n) entries.push([symbol, toAmount(units, `the holding of ${label(symbol)}`)]);
  }
  return { cashMicro: toAmount(cash, 'cashMicro'), holdings: Object.fromEntries(entries) };
}

/**
 * `equity = cash + sum of value(units_i, price_i)` over every held symbol, halted ones included.
 * Throws if a held symbol has no price.
 */
export function valuePortfolio(portfolio: PortfolioState, prices: PriceMap): number {
  const { cash, held } = readPortfolio(portfolio);
  let equity = cash;
  for (const { symbol, units } of held) {
    equity += valueAt(units, readPrice(prices, symbol));
  }
  return toAmount(equity, 'the equity');
}
