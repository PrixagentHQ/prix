import type { DayPrices, DnaInput, DnaObservation, PortfolioState } from '@prix/contracts';

/**
 * Builders for the Strategy DNA tests. Every number is written the way a person would work it out
 * by hand: whole US dollars and whole shares, turned into micro-units only here.
 */

export const MICRO = 1_000_000;
export const usd = (dollars: number): number => Math.round(dollars * MICRO);
export const shares = (count: number): number => Math.round(count * MICRO);

export const SEASON_A = 'seasonaaaaaa';
export const SEASON_B = 'seasonbbbbbb';

/** Day 1 is 2026-10-06; day `i` is `i - 1` days later. Plain calendar arithmetic, in UTC. */
export function day(i: number): string {
  return new Date(Date.parse('2026-10-05T00:00:00.000Z') + i * 86_400_000).toISOString().slice(0, 10);
}

export type Prices = Record<string, number>;

/** A priced day. Prices are in whole US dollars. */
export function priced(i: number, dollars: Prices): DayPrices {
  const pricesMicro: Record<string, number> = {};
  for (const [symbol, price] of Object.entries(dollars)) pricesMicro[symbol] = usd(price);
  return { day: day(i), tickId: `${day(i)}T19:00Z`, pricesMicro };
}

/** `count` priced days, 1..count, all at the same prices. */
export function flatPrices(count: number, dollars: Prices, from = 1): DayPrices[] {
  return Array.from({ length: count }, (_, k) => priced(from + k, dollars));
}

export interface ObsOptions {
  /** Cash in whole dollars. */
  cash: number;
  /** Shares held by symbol. */
  held?: Record<string, number>;
  /** Equity in whole dollars. Default: cash plus the shares at `prices`. */
  equity?: number;
  prices?: Prices;
  season?: string;
}

export function portfolioOf(cash: number, held: Record<string, number> = {}): PortfolioState {
  const holdings: Record<string, number> = {};
  for (const [symbol, count] of Object.entries(held)) if (count > 0) holdings[symbol] = shares(count);
  return { cashMicro: usd(cash), holdings };
}

export function obs(i: number, options: ObsOptions): DnaObservation {
  const prices = options.prices ?? {};
  const held = options.held ?? {};
  let equity = options.equity;
  if (equity === undefined) {
    equity = options.cash;
    for (const [symbol, count] of Object.entries(held)) equity += count * (prices[symbol] ?? 0);
  }
  return {
    day: day(i),
    tickId: `${day(i)}T19:00Z`,
    seasonId: options.season ?? SEASON_A,
    portfolio: portfolioOf(options.cash, held),
    equityMicro: usd(equity),
  };
}

/** A DNA input with defaults that most tests keep: an agent that has kept one strategy since day 0. */
export function input(
  observations: readonly DnaObservation[],
  pricedDays: readonly DayPrices[],
  over: Partial<DnaInput> = {},
): DnaInput {
  const last = pricedDays[pricedDays.length - 1];
  return {
    agentId: 'agentaaaaaaa',
    asOfDay: last?.day ?? day(1),
    strategySinceDay: day(0),
    observations,
    pricedDays,
    computedAt: '2026-12-01T00:05:00.000Z',
    ...over,
  };
}
