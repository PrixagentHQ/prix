import type {
  DayPrices,
  DnaAxes,
  DnaAxis,
  DnaInput,
  DnaNote,
  DnaObservation,
  DnaProfile,
  PortfolioState,
  StrategyDnaEngine,
} from '@prix/contracts';
import {
  DNA_METHOD,
  DNA_MIN_DAYS,
  DNA_MOMENTUM_LOOKBACK_DAYS,
  DNA_TURNOVER_PERIOD_DAYS,
  DNA_WINDOW_DAYS,
  STARTING_CASH_MICRO,
} from '@prix/contracts';
import { scoringV2 } from './v2.ts';

/**
 * Strategy DNA, method `dna-v1`: a measured description of what an agent did, from the last decision
 * row of each UTC day and Phase 2's day prices. docs/contracts/phase-6-social.md section 5.1.
 *
 * It is not a score, a rank or a rating. Nothing is sorted by it and nothing is given for it. It never
 * reads a prompt, a summary or a model answer. A profile describes a short, simulated record and is
 * not advice.
 *
 * Pure and deterministic: the same input gives the same JSON, byte for byte, with the fixed key order
 * below. It never throws; an input it cannot read gives a `forming` profile with empty axes.
 *
 * Hand-computed example (the numbers the throwaway check in .artifacts and qa's tests use). Eleven window
 * days, prices A = 10 and B = 20 USD, cash 5,000 USD, and the book alternates between
 * X = (A 300, B 100 shares) and Y = (A 100, B 200 shares), equity 10,000 USD every day:
 *   positions: X weights 0.6 / 0.4 give 1 / 0.52 = 1.9231 (6 days); Y weights 0.2 / 0.8 give 1 / 0.68 = 1.4706
 *     (5 days); mean 1.7174, so positionsMilli 1717.
 *   cash: 5,000 / 10,000, so cashBps 5000.
 *   turnover (the first day is the opening, excluded): each of the 10 other days moves 2,000 USD one way;
 *     2,000 * 10 / 10,000 * 20 / 10 * 10,000 = 40,000 bps.
 *   holding days: invested 5,000 USD each day, 2,000 USD sold each day: 5,000 * 10 / 20,000 = 2.5, so 3.
 */

const MICRO_BIG = 1_000_000n;
const MIN = DNA_MIN_DAYS;

/** floor(units * price / 1,000,000) in BigInt: the arithmetic of packages/sim/src/math.ts `valueAt`, copied. */
function valueAt(units: bigint, price: bigint): bigint {
  return (units * price) / MICRO_BIG;
}

/** Math.round with negative zero as 0; null when the number is not finite. */
function roundTo(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const r = Math.round(x);
  return r === 0 ? 0 : r;
}

function axis(value: number | null, sample: number, note: DnaNote | null): DnaAxis {
  return { value, sample, min: MIN, note };
}

function blankAxis(): DnaAxis {
  return axis(null, 0, 'not_enough_history');
}

function blankAxes(): DnaAxes {
  return {
    positionsMilli: blankAxis(),
    cashBps: blankAxis(),
    turnoverBps: blankAxis(),
    holdingDays: blankAxis(),
    swingBps: blankAxis(),
    deepestFallBps: blankAxis(),
    momentumMilli: blankAxis(),
  };
}

function isPrice(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

function isAmount(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Holding {
  symbol: string;
  units: bigint;
}

interface Obs {
  day: string;
  tickId: string;
  seasonId: string;
  cash: number;
  holdings: Holding[];
  equity: number;
}

interface Valued {
  values: Array<{ symbol: string; value: bigint }>;
  invested: bigint;
}

function holdingsOf(portfolio: PortfolioState | undefined): Holding[] | null {
  if (!portfolio || typeof portfolio !== 'object') return null;
  const raw = portfolio.holdings;
  if (!raw || typeof raw !== 'object') return null;
  const out: Holding[] = [];
  for (const symbol of Object.keys(raw).sort(cmp)) {
    const units = raw[symbol];
    if (!isAmount(units)) return null;
    if (units > 0) out.push({ symbol, units: BigInt(units) });
  }
  return out;
}

function cleanObservation(o: DnaObservation | undefined): Obs | null {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.day !== 'string' || typeof o.tickId !== 'string' || typeof o.seasonId !== 'string') return null;
  const portfolio = o.portfolio;
  if (!portfolio || typeof portfolio !== 'object' || !isAmount(portfolio.cashMicro)) return null;
  if (!isAmount(o.equityMicro)) return null;
  const holdings = holdingsOf(portfolio);
  if (!holdings) return null;
  return {
    day: o.day,
    tickId: o.tickId,
    seasonId: o.seasonId,
    cash: portfolio.cashMicro,
    holdings,
    equity: o.equityMicro,
  };
}

function cleanPriced(d: DayPrices | undefined): DayPrices | null {
  if (!d || typeof d !== 'object' || typeof d.day !== 'string') return null;
  if (!d.pricesMicro || typeof d.pricesMicro !== 'object') return null;
  return d;
}

/** Oldest first, one entry per day (the last wins), by plain string order of the day. */
function byDay<T extends { day: string }>(items: readonly T[]): T[] {
  const sorted = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => cmp(a.item.day, b.item.day) || a.i - b.i)
    .map((x) => x.item);
  const out: T[] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && last.day === item.day) out[out.length - 1] = item;
    else out.push(item);
  }
  return out;
}

function valuation(o: Obs, prices: Record<string, number> | undefined): Valued | null {
  if (!prices) return null;
  const values: Array<{ symbol: string; value: bigint }> = [];
  let invested = 0n;
  for (const h of o.holdings) {
    const p = prices[h.symbol];
    if (!isPrice(p)) return null;
    const value = valueAt(h.units, BigInt(p));
    values.push({ symbol: h.symbol, value });
    invested += value;
  }
  return { values, invested };
}

function isOpening(cash: number, holdings: readonly Holding[]): boolean {
  return cash === STARTING_CASH_MICRO && holdings.length === 0;
}

/** Tie-averaged percentile of each symbol's trailing return among the symbols priced on both days. */
function percentiles(now: Record<string, number>, then: Record<string, number>): Map<string, number> {
  const rows: Array<{ symbol: string; ratio: number }> = [];
  for (const symbol of Object.keys(now).sort(cmp)) {
    const a = now[symbol];
    const b = then[symbol];
    if (isPrice(a) && isPrice(b) && a > 0 && b > 0) rows.push({ symbol, ratio: a / b });
  }
  rows.sort((x, y) => x.ratio - y.ratio || cmp(x.symbol, y.symbol));
  const out = new Map<string, number>();
  const n = rows.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && rows[j + 1]?.ratio === rows[i]?.ratio) j += 1;
    // Positions i + 1 .. j + 1 share one average rank.
    const avgRank = (i + 1 + (j + 1)) / 2;
    const pct = n > 1 ? (avgRank - 1) / (n - 1) : 0.5;
    for (let k = i; k <= j; k++) {
      const row = rows[k];
      if (row) out.set(row.symbol, pct);
    }
    i = j + 1;
  }
  return out;
}

function compute(input: DnaInput): DnaProfile {
  const since = typeof input.strategySinceDay === 'string' ? input.strategySinceDay : '';
  const asOf = typeof input.asOfDay === 'string' ? input.asOfDay : '';

  const priced = byDay(
    (Array.isArray(input.pricedDays) ? input.pricedDays : [])
      .map(cleanPriced)
      .filter((d): d is DayPrices => d !== null && d.day <= asOf),
  );
  const pricesByDay = new Map<string, Record<string, number>>();
  const indexByDay = new Map<string, number>();
  priced.forEach((d, i) => {
    pricesByDay.set(d.day, d.pricesMicro);
    indexByDay.set(d.day, i);
  });

  const windowPriced = priced.slice(-DNA_WINDOW_DAYS).filter((d) => d.day >= since);
  const windowStartDay = windowPriced[0]?.day ?? since;

  const all = byDay(
    (Array.isArray(input.observations) ? input.observations : [])
      .map(cleanObservation)
      .filter((o): o is Obs => o !== null && o.day <= asOf),
  );
  const firstWindow = all.findIndex((o) => o.day >= windowStartDay);
  const startIdx = firstWindow < 0 ? all.length : firstWindow;
  const windowIdx: number[] = [];
  for (let i = startIdx; i < all.length && windowIdx.length < DNA_WINDOW_DAYS; i++) windowIdx.push(i);

  const axes = blankAxes();
  const opening: Holding[] = [];

  let positionsSum = 0;
  let positionsN = 0;
  let pricedObs = 0;
  let cashSum = 0;
  let cashN = 0;
  let turnN = 0;
  let oneWaySum = 0n;
  let sellsSum = 0n;
  let investedSum = 0n;
  let equitySum = 0;
  const returns: number[] = [];
  let fall = 0;
  let peak = 0;
  let lastSeason: string | null = null;
  let momentumSum = 0;
  let momentumN = 0;
  let sawNoLookback = false;

  for (const gi of windowIdx) {
    const o = all[gi];
    if (!o) continue;
    const prev = gi > 0 ? all[gi - 1] : undefined;
    const sameSeason = prev !== undefined && prev.seasonId === o.seasonId;
    const prices = pricesByDay.get(o.day);
    const v = valuation(o, prices);

    // Equity alone: cash share, swing, deepest fall.
    if (o.equity > 0) {
      cashSum += o.cash / o.equity;
      cashN += 1;
    }
    const before = sameSeason && prev ? prev.equity : STARTING_CASH_MICRO;
    const r = scoringV2.dailyReturnsBps(before, [{ day: o.day, equityMicro: o.equity }])[0];
    if (r !== undefined) returns.push(r);
    if (o.seasonId !== lastSeason) {
      peak = o.equity;
      lastSeason = o.seasonId;
    } else if (o.equity > peak) {
      peak = o.equity;
    }
    if (peak > 0) fall = Math.max(fall, ((peak - o.equity) / peak) * 10_000);

    if (!v || !prices) continue;
    pricedObs += 1;

    // Positions.
    if (v.invested > 0n) {
      const total = Number(v.invested);
      let sq = 0;
      for (const x of v.values) {
        const w = Number(x.value) / total;
        sq += w * w;
      }
      if (sq > 0) {
        positionsSum += 1 / sq;
        positionsN += 1;
      }
    }

    // Turnover and holding days: the prior state is the previous observation of the same season,
    // else the opening portfolio. A day whose prior state is exactly the opening one is excluded.
    const priorCash = sameSeason && prev ? prev.cash : STARTING_CASH_MICRO;
    const priorHoldings = sameSeason && prev ? prev.holdings : opening;
    if (!isOpening(priorCash, priorHoldings)) {
      const units = new Map<string, { now: bigint; prior: bigint }>();
      for (const h of o.holdings) units.set(h.symbol, { now: h.units, prior: 0n });
      for (const h of priorHoldings) {
        const cur = units.get(h.symbol);
        if (cur) cur.prior = h.units;
        else units.set(h.symbol, { now: 0n, prior: h.units });
      }
      let abs = 0n;
      let sold = 0n;
      let usable = true;
      for (const symbol of [...units.keys()].sort(cmp)) {
        const u = units.get(symbol);
        const p = prices[symbol];
        if (!u || !isPrice(p)) {
          usable = false;
          break;
        }
        const diff = u.now - u.prior;
        if (diff > 0n) abs += valueAt(diff, BigInt(p));
        else if (diff < 0n) {
          const part = valueAt(-diff, BigInt(p));
          abs += part;
          sold += part;
        }
      }
      if (usable) {
        turnN += 1;
        oneWaySum += abs;
        sellsSum += sold;
        investedSum += v.invested;
        equitySum += o.equity;
      }
    }

    // Momentum.
    if (v.invested > 0n) {
      const idx = indexByDay.get(o.day);
      const then =
        idx === undefined || idx < DNA_MOMENTUM_LOOKBACK_DAYS ? undefined : priced[idx - DNA_MOMENTUM_LOOKBACK_DAYS];
      if (!then) {
        sawNoLookback = true;
      } else {
        const pct = percentiles(prices, then.pricesMicro);
        let weighted = 0n;
        for (const x of v.values) if (pct.has(x.symbol)) weighted += x.value;
        if (weighted > 0n) {
          const total = Number(weighted);
          let s = 0;
          for (const x of v.values) {
            const p = pct.get(x.symbol);
            if (p !== undefined) s += (Number(x.value) / total) * (2 * p - 1);
          }
          momentumSum += s;
          momentumN += 1;
        }
      }
    }
  }

  const n = windowIdx.length;
  const emptyNote = (sample: number): DnaNote | null =>
    sample >= MIN ? null : pricedObs > 0 && positionsN === 0 ? 'no_holdings' : 'not_enough_history';

  axes.positionsMilli = axis(
    positionsN >= MIN ? roundTo((1000 * positionsSum) / positionsN) : null,
    positionsN,
    emptyNote(positionsN),
  );
  axes.cashBps = axis(
    cashN >= MIN ? roundTo((cashSum / cashN) * 10_000) : null,
    cashN,
    cashN >= MIN ? null : 'not_enough_history',
  );

  if (turnN < MIN) {
    axes.turnoverBps = axis(null, turnN, 'not_enough_history');
    axes.holdingDays = axis(null, turnN, 'not_enough_history');
  } else {
    const meanEquity = equitySum / turnN;
    const turnover =
      meanEquity > 0
        ? roundTo((((Number(oneWaySum) / 2 / meanEquity) * DNA_TURNOVER_PERIOD_DAYS) / turnN) * 10_000)
        : null;
    axes.turnoverBps = axis(turnover, turnN, turnover === null ? 'not_enough_history' : null);
    const holding = sellsSum > 0n ? Number(investedSum) / Number(sellsSum) : null;
    if (holding === null || holding > turnN) axes.holdingDays = axis(null, turnN, 'longer_than_window');
    else axes.holdingDays = axis(roundTo(holding), turnN, null);
  }

  if (returns.length < MIN) {
    axes.swingBps = axis(null, returns.length, 'not_enough_history');
  } else {
    const b = scoringV2.breakdownOf(scoringV2.momentsOf(returns));
    axes.swingBps = axis(roundTo(b.volMilliBps / 1000), returns.length, null);
  }

  axes.deepestFallBps = n >= MIN ? axis(roundTo(fall), n, null) : axis(null, n, 'not_enough_history');

  if (momentumN >= MIN) {
    axes.momentumMilli = axis(roundTo((1000 * momentumSum) / momentumN), momentumN, null);
  } else {
    const note: DnaNote = sawNoLookback
      ? 'needs_market_history'
      : pricedObs > 0 && positionsN === 0
        ? 'no_holdings'
        : 'not_enough_history';
    axes.momentumMilli = axis(null, momentumN, note);
  }

  const first = windowIdx.length > 0 ? all[windowIdx[0] as number] : undefined;
  const last = windowIdx.length > 0 ? all[windowIdx[windowIdx.length - 1] as number] : undefined;
  return {
    method: DNA_METHOD,
    agentId: input.agentId,
    status: n >= MIN ? 'ready' : 'forming',
    asOfDay: input.asOfDay,
    windowStartDay,
    strategySinceDay: input.strategySinceDay,
    pricedDays: windowPriced.length,
    observedDays: n,
    firstTickId: first ? first.tickId : null,
    lastTickId: last ? last.tickId : null,
    axes,
    computedAt: input.computedAt,
  };
}

function profile(input: DnaInput): DnaProfile {
  try {
    return compute(input);
  } catch {
    const safe = (input ?? {}) as Partial<DnaInput>;
    return {
      method: DNA_METHOD,
      agentId: safe.agentId as string,
      status: 'forming',
      asOfDay: safe.asOfDay as string,
      windowStartDay: (safe.strategySinceDay ?? safe.asOfDay) as string,
      strategySinceDay: safe.strategySinceDay as string,
      pricedDays: 0,
      observedDays: 0,
      firstTickId: null,
      lastTickId: null,
      axes: blankAxes(),
      computedAt: safe.computedAt as string,
    };
  }
}

export const strategyDna: StrategyDnaEngine = { profile };
