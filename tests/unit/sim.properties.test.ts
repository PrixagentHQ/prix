import type { Fill, PortfolioState, PriceMap, RebalanceInput, RebalanceResult } from '@prix/contracts';
import {
  BPS,
  FEE_BPS,
  fillSchema,
  MAX_WEIGHT_BPS,
  MICRO,
  MIN_PRICE_MICRO,
  MIN_TRADE_BPS,
  portfolioStateSchema,
  SLIPPAGE_BPS,
} from '@prix/contracts';
import { sim } from '@prix/sim';
import { describe, expect, it } from 'vitest';
import type { Rng } from '../support/prng.ts';
import { createRng } from '../support/prng.ts';

/**
 * The properties of docs/CONTRACTS.md section 7 ("What must always hold"), each checked on
 * thousands of random portfolios from a fixed seed. A failure prints the seed, the case
 * number and the input, so it can be replayed exactly.
 *
 * The expected values are computed here with BigInt from the definitions of section 7,
 * never by calling the engine.
 */

const CASES = 4_000;
const SYMBOLS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
const M = BigInt(MICRO);
const B = BigInt(BPS);

function valueMicro(units: number, price: number): bigint {
  return (BigInt(units) * BigInt(price)) / M;
}

function equityOf(portfolio: PortfolioState, prices: PriceMap): bigint {
  let total = BigInt(portfolio.cashMicro);
  for (const [symbol, units] of Object.entries(portfolio.holdings))
    total += valueMicro(units, prices[symbol] as number);
  return total;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** A price from one cent to 5,000 USD, spread evenly over the orders of magnitude. */
function randomPrice(rng: Rng): number {
  const exponent = 4 + rng.next() * 5.7;
  return Math.max(MIN_PRICE_MICRO, Math.min(5_000_000_000, Math.round(10 ** exponent)));
}

function randomInput(rng: Rng): RebalanceInput {
  const prices: PriceMap = {};
  for (const symbol of SYMBOLS) prices[symbol] = randomPrice(rng);

  // Portfolio sizes from a few micro-USD to tens of millions of USD, below the 90 million bound.
  const scale = rng.pick([1_000, 1_000_000, 10_000_000_000, 10_000_000_000, 10_000_000_000, 60_000_000_000_000]);
  const holdings: Record<string, number> = {};
  let budget = scale;
  for (const symbol of rng.shuffle(SYMBOLS).slice(0, rng.int(0, 5))) {
    const worth = Math.floor(rng.next() * budget * 0.6);
    budget -= worth;
    const units = Math.floor((worth * MICRO) / (prices[symbol] as number));
    if (units > 0 && Number.isSafeInteger(units)) holdings[symbol] = units;
  }
  const cashMicro = rng.chance(0.15) ? 0 : Math.floor(rng.next() * budget);

  const targetsBps: Record<string, number> = {};
  if (!rng.chance(0.15)) {
    let left = BPS;
    for (const symbol of rng.shuffle(SYMBOLS).slice(0, rng.int(1, 6))) {
      const bps = Math.min(left, rng.chance(0.3) ? MAX_WEIGHT_BPS : rng.int(1, MAX_WEIGHT_BPS));
      if (bps <= 0) break;
      targetsBps[symbol] = bps;
      left -= bps;
    }
  }
  const halted = rng.chance(0.4) ? rng.shuffle(SYMBOLS).slice(0, rng.int(1, 3)) : [];
  return { portfolio: { cashMicro, holdings }, prices, targetsBps, halted };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function forEachCase(seed: number, check: (input: RebalanceInput, result: RebalanceResult) => void): void {
  const rng = createRng(seed);
  for (let index = 0; index < CASES; index += 1) {
    const input = randomInput(rng);
    const result = sim.rebalance(structuredClone(input));
    try {
      check(input, result);
    } catch (error) {
      throw new Error(
        `seed ${seed}, case ${index}: ${(error as Error).message}\ninput: ${JSON.stringify(input)}\nresult: ${JSON.stringify(result)}`,
      );
    }
  }
}

function allNumbers(result: RebalanceResult): number[] {
  const numbers = [result.portfolio.cashMicro, result.equityBeforeMicro, result.equityAfterMicro, result.costMicro];
  numbers.push(...Object.values(result.portfolio.holdings));
  for (const fill of result.fills) {
    numbers.push(fill.unitsMicro, fill.priceMicro, fill.notionalMicro, fill.feeMicro, fill.slippageMicro);
  }
  return numbers;
}

describe('sim.rebalance, properties of section 7', () => {
  it('keeps cash and every holding zero or positive: no leverage and no shorting', () => {
    forEachCase(101, (_input, result) => {
      expect(result.portfolio.cashMicro).toBeGreaterThanOrEqual(0);
      for (const units of Object.values(result.portfolio.holdings)) expect(units).toBeGreaterThan(0);
      expect(portfolioStateSchema.safeParse(result.portfolio).success).toBe(true);
    });
  });

  it('removes zero holdings from the result', () => {
    forEachCase(102, (_input, result) => {
      expect(Object.values(result.portfolio.holdings).every((units) => units !== 0)).toBe(true);
    });
  });

  it('never fills a halted symbol and leaves every halted holding as it was', () => {
    forEachCase(103, (input, result) => {
      for (const symbol of input.halted) {
        expect(result.fills.some((fill) => fill.symbol === symbol)).toBe(false);
        expect(result.portfolio.holdings[symbol]).toBe(input.portfolio.holdings[symbol]);
      }
    });
  });

  it('never adds value: equity after is at most equity before', () => {
    forEachCase(104, (input, result) => {
      expect(result.equityAfterMicro).toBeLessThanOrEqual(result.equityBeforeMicro);
      expect(BigInt(result.equityBeforeMicro)).toBe(equityOf(input.portfolio, input.prices));
      expect(BigInt(result.equityAfterMicro)).toBe(equityOf(result.portfolio, input.prices));
    });
  });

  it('keeps every bought symbol at or below 40% of the value before trading', () => {
    forEachCase(105, (input, result) => {
      const cap = (BigInt(result.equityBeforeMicro) * BigInt(MAX_WEIGHT_BPS)) / B;
      for (const fill of result.fills) {
        if (fill.side !== 'buy') continue;
        const units = result.portfolio.holdings[fill.symbol] ?? 0;
        expect(valueMicro(units, input.prices[fill.symbol] as number) <= cap).toBe(true);
      }
    });
  });

  it('keeps every bought symbol at or below its own target, measured before costs', () => {
    forEachCase(106, (input, result) => {
      for (const fill of result.fills) {
        if (fill.side !== 'buy') continue;
        const target = (BigInt(result.equityBeforeMicro) * BigInt(input.targetsBps[fill.symbol] ?? 0)) / B;
        const units = result.portfolio.holdings[fill.symbol] ?? 0;
        expect(valueMicro(units, input.prices[fill.symbol] as number) <= target).toBe(true);
      }
    });
  });

  it('sells everything that is not halted when the targets are empty', () => {
    forEachCase(107, (input, _result) => {
      const emptied = sim.rebalance({ ...structuredClone(input), targetsBps: {} });
      const halted = new Set(input.halted);
      const expected = Object.fromEntries(
        Object.entries(input.portfolio.holdings).filter(([symbol]) => halted.has(symbol)),
      );
      expect(emptied.portfolio.holdings).toEqual(expected);
      expect(emptied.fills.every((fill) => fill.side === 'sell')).toBe(true);
    });
  });

  it('sells a held symbol with no target in full, however small it is', () => {
    forEachCase(108, (input, result) => {
      const halted = new Set(input.halted);
      for (const symbol of Object.keys(input.portfolio.holdings)) {
        if (halted.has(symbol) || input.targetsBps[symbol] !== undefined) continue;
        expect(result.portfolio.holdings[symbol]).toBeUndefined();
        const fill = result.fills.find((entry) => entry.symbol === symbol);
        expect(fill?.side).toBe('sell');
        expect(fill?.unitsMicro).toBe(input.portfolio.holdings[symbol]);
      }
    });
  });

  it('does not mutate its input', () => {
    const rng = createRng(109);
    for (let index = 0; index < 1_000; index += 1) {
      const input = randomInput(rng);
      const before = JSON.stringify(input);
      const frozen = deepFreeze(structuredClone(input));
      // A frozen input makes a write throw instead of passing silently.
      expect(() => sim.rebalance(frozen)).not.toThrow();
      expect(JSON.stringify(frozen)).toBe(before);
    }
  });

  it('returns the same result for the same input, and never shares objects with it', () => {
    forEachCase(110, (input, result) => {
      const again = sim.rebalance(structuredClone(input));
      expect(again).toEqual(result);
      const shared = structuredClone(input);
      const output = sim.rebalance(shared);
      output.portfolio.holdings.ZZZ = 1;
      expect(shared.portfolio.holdings.ZZZ).toBeUndefined();
    });
  });

  it('returns only safe integers', () => {
    forEachCase(111, (_input, result) => {
      for (const value of allNumbers(result)) expect(Number.isSafeInteger(value)).toBe(true);
      for (const fill of result.fills) expect(fillSchema.safeParse(fill).success).toBe(true);
    });
  });

  it('lists sells before buys, each group in ascending symbol order, one fill per symbol', () => {
    forEachCase(112, (_input, result) => {
      const sells = result.fills.filter((fill) => fill.side === 'sell').map((fill) => fill.symbol);
      const buys = result.fills.filter((fill) => fill.side === 'buy').map((fill) => fill.symbol);
      expect(result.fills.map((fill) => fill.side)).toEqual([...sells.map(() => 'sell'), ...buys.map(() => 'buy')]);
      expect(sells).toEqual([...sells].sort());
      expect(buys).toEqual([...buys].sort());
      expect(new Set(result.fills.map((fill) => fill.symbol)).size).toBe(result.fills.length);
    });
  });

  it('fills at the reference price and charges fee and slippage by the formulas of steps 4 and 6', () => {
    const rate = BigInt(SLIPPAGE_BPS);
    const feeRate = BigInt(FEE_BPS);
    forEachCase(113, (input, result) => {
      for (const fill of result.fills) {
        expect(fill.unitsMicro).toBeGreaterThan(0);
        expect(fill.priceMicro).toBe(input.prices[fill.symbol]);
        const notional = valueMicro(fill.unitsMicro, fill.priceMicro);
        expect(BigInt(fill.notionalMicro)).toBe(notional);
        if (fill.side === 'sell') {
          const slippage = bigMin(ceilDiv(notional * rate, B), notional);
          expect(BigInt(fill.slippageMicro)).toBe(slippage);
          expect(BigInt(fill.feeMicro)).toBe(bigMin(ceilDiv(notional * feeRate, B), notional - slippage));
        } else {
          expect(fill.notionalMicro).toBeGreaterThan(0);
          expect(BigInt(fill.slippageMicro)).toBe(ceilDiv(notional * rate, B));
          expect(BigInt(fill.feeMicro)).toBe(ceilDiv(notional * feeRate, B));
        }
      }
    });
  });

  it('accounts for every micro-USD and micro-share: the fills explain the whole change', () => {
    forEachCase(114, (input, result) => {
      let cash = BigInt(input.portfolio.cashMicro);
      let cost = 0n;
      const holdings: Record<string, number> = { ...input.portfolio.holdings };
      for (const fill of result.fills) {
        const charges = BigInt(fill.feeMicro) + BigInt(fill.slippageMicro);
        cost += charges;
        if (fill.side === 'sell') {
          cash += BigInt(fill.notionalMicro) - charges;
          holdings[fill.symbol] = (holdings[fill.symbol] ?? 0) - fill.unitsMicro;
        } else {
          cash -= BigInt(fill.notionalMicro) + charges;
          holdings[fill.symbol] = (holdings[fill.symbol] ?? 0) + fill.unitsMicro;
        }
        expect(cash >= 0n).toBe(true);
      }
      for (const symbol of Object.keys(holdings)) if (holdings[symbol] === 0) delete holdings[symbol];
      expect(BigInt(result.portfolio.cashMicro)).toBe(cash);
      expect(result.portfolio.holdings).toEqual(holdings);
      expect(BigInt(result.costMicro)).toBe(cost);
    });
  });

  it('does not trade a targeted symbol whose change is below the smallest trade', () => {
    forEachCase(115, (input, result) => {
      const equity = equityOf(input.portfolio, input.prices);
      const minTrade = (equity * BigInt(MIN_TRADE_BPS)) / B;
      for (const [symbol, bps] of Object.entries(input.targetsBps)) {
        const current = valueMicro(input.portfolio.holdings[symbol] ?? 0, input.prices[symbol] as number);
        const delta = (equity * BigInt(bps)) / B - current;
        const size = delta < 0n ? -delta : delta;
        if (size < minTrade) expect(result.fills.some((fill) => fill.symbol === symbol)).toBe(false);
      }
    });
  });

  it('sells exactly the units of step 4 for a holding that is above its target', () => {
    forEachCase(116, (input, result) => {
      const halted = new Set(input.halted);
      const equity = equityOf(input.portfolio, input.prices);
      const minTrade = (equity * BigInt(MIN_TRADE_BPS)) / B;
      for (const [symbol, bps] of Object.entries(input.targetsBps)) {
        const units = input.portfolio.holdings[symbol] ?? 0;
        if (halted.has(symbol) || units === 0) continue;
        const price = BigInt(input.prices[symbol] as number);
        const delta = (equity * BigInt(bps)) / B - valueMicro(units, Number(price));
        if (delta >= 0n || -delta < minTrade) continue;
        const sellUnits = bigMin(BigInt(units), (-delta * M) / price);
        const fill = result.fills.find((entry) => entry.symbol === symbol);
        if (sellUnits === 0n) {
          expect(fill).toBeUndefined();
        } else {
          expect(fill?.side).toBe('sell');
          expect(BigInt((fill as Fill).unitsMicro)).toBe(sellUnits);
        }
      }
    });
  });

  it('buys exactly the units of steps 5 and 6 when there is cash for every target', () => {
    forEachCase(117, (input, result) => {
      // Only cases with no sells and no shortage of cash, where step 5 does not scale and
      // step 6 never has to recompute: wanted = delta for every buy.
      if (Object.keys(input.portfolio.holdings).length > 0) return;
      const total = Object.values(input.targetsBps).reduce((sum, bps) => sum + bps, 0);
      if (total > 9_000) return;
      const halted = new Set(input.halted);
      const equity = BigInt(input.portfolio.cashMicro);
      // Below one USD the rounded-up charges of a few micro-USD can exceed the cash that is left.
      if (equity < 1_000_000n) return;
      const minTrade = (equity * BigInt(MIN_TRADE_BPS)) / B;
      for (const [symbol, bps] of Object.entries(input.targetsBps)) {
        const fill = result.fills.find((entry) => entry.symbol === symbol);
        const delta = (equity * BigInt(bps)) / B;
        const price = BigInt(input.prices[symbol] as number);
        const units = (delta * M) / price;
        if (halted.has(symbol) || delta < minTrade || units === 0n || (units * price) / M === 0n) {
          expect(fill).toBeUndefined();
        } else {
          expect(fill?.side).toBe('buy');
          expect(BigInt((fill as Fill).unitsMicro)).toBe(units);
        }
      }
    });
  });
});

describe('sim.valuePortfolio, properties', () => {
  it('equals cash plus the floor value of every holding, as a safe integer', () => {
    const rng = createRng(201);
    for (let index = 0; index < 2_000; index += 1) {
      const input = randomInput(rng);
      const value = sim.valuePortfolio(structuredClone(input.portfolio), input.prices);
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(BigInt(value)).toBe(equityOf(input.portfolio, input.prices));
    }
  });
});

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
