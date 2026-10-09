import { z } from 'zod';
import type { TokenSymbol } from './primitives.ts';
import { amountSchema, symbolSchema } from './primitives.ts';

/**
 * A paper portfolio. Cash is in micro-USD and holdings are in micro-shares.
 * A symbol with zero units is left out. There are no negative numbers: no leverage, no shorting.
 */
export const portfolioStateSchema = z.strictObject({
  cashMicro: amountSchema,
  holdings: z.record(symbolSchema, amountSchema),
});
export type PortfolioState = z.infer<typeof portfolioStateSchema>;

/** Reference prices in micro-USD per share, by symbol. */
export type PriceMap = Record<TokenSymbol, number>;

/** One simulated trade. `priceMicro` is the reference price; fee and slippage are charged on top. */
export const fillSchema = z.strictObject({
  symbol: symbolSchema,
  side: z.enum(['buy', 'sell']),
  unitsMicro: amountSchema,
  priceMicro: amountSchema,
  /** floor(unitsMicro * priceMicro / 1,000,000) */
  notionalMicro: amountSchema,
  feeMicro: amountSchema,
  slippageMicro: amountSchema,
});
export type Fill = z.infer<typeof fillSchema>;

export interface RebalanceInput {
  portfolio: PortfolioState;
  /** A price for every symbol that is held or targeted. A halted symbol keeps its last known price. */
  prices: PriceMap;
  /** Target weights in basis points, already validated. Symbols left out have a target of zero. */
  targetsBps: Record<TokenSymbol, number>;
  /** Symbols whose feed is stale at this tick. They are valued but never traded. */
  halted: readonly TokenSymbol[];
}

export interface RebalanceResult {
  portfolio: PortfolioState;
  /** Sells first, then buys, each group in ascending symbol order. Empty when nothing traded. */
  fills: Fill[];
  /** Portfolio value before trading, at the reference prices. */
  equityBeforeMicro: number;
  /** Portfolio value after trading, at the same prices. Never above `equityBeforeMicro`. */
  equityAfterMicro: number;
  /** Total fees plus slippage charged. */
  costMicro: number;
}

/**
 * The simulation engine. `packages/sim` implements every function here as a pure function:
 * no clock, no randomness, no I/O. docs/CONTRACTS.md section 7 specifies the arithmetic.
 */
export interface SimEngine {
  /** A fresh portfolio: STARTING_CASH_MICRO in cash and no holdings. */
  newPortfolio(): PortfolioState;
  /** cashMicro plus the floor value of every holding. Throws if a held symbol has no price. */
  valuePortfolio(portfolio: PortfolioState, prices: PriceMap): number;
  /** Trade toward the targets. Throws only on a programming error, such as a missing price. */
  rebalance(input: RebalanceInput): RebalanceResult;
}
