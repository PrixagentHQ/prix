import type { AgentStats, RankInput, RowStatus, StatsEvent } from '@prix/contracts';
import {
  agentStatsSchema,
  MIN_DECISIONS_TO_RANK,
  MIN_TRADING_DAYS_TO_RANK,
  STARTING_CASH_MICRO,
  standingRowSchema,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { describe, expect, it } from 'vitest';
import { startingStats, testId } from '../support/fixtures.ts';
import { createRng } from '../support/prng.ts';

/**
 * Scoring v1, from docs/CONTRACTS.md section 9. Expected numbers are worked out by hand
 * in the comments. The starting value is 10,000,000,000 micro-USD.
 */

const START = STARTING_CASH_MICRO;

function event(day: string, status: RowStatus, equityMicro: number, fillCount = 0): StatsEvent {
  return { day, status, equityMicro, fillCount };
}

function statsWith(overrides: Partial<AgentStats>): AgentStats {
  return { ...startingStats(), ...overrides };
}

/** Stats that meet both thresholds. */
function rankable(overrides: Partial<AgentStats> = {}): AgentStats {
  return statsWith({ tradingDays: MIN_TRADING_DAYS_TO_RANK, decidedCount: MIN_DECISIONS_TO_RANK, ...overrides });
}

function entry(n: number, stats: AgentStats, lastStatus: RowStatus | null = 'decided', createdAt?: string): RankInput {
  return {
    agentId: testId('agent', n),
    name: `Agent ${n}`,
    createdAt: createdAt ?? '2026-10-05T08:00:00.000Z',
    stats,
    lastStatus,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('scoring.initialStats', () => {
  it('starts at the starting cash with every count at zero', () => {
    expect(scoring.initialStats()).toEqual({
      equityMicro: 10_000_000_000,
      peakEquityMicro: 10_000_000_000,
      seasonReturnBps: 0,
      maxDrawdownBps: 0,
      tradeCount: 0,
      decidedCount: 0,
      noDecisionCount: 0,
      skippedCount: 0,
      tradingDays: 0,
      lastDay: null,
      daily: [],
    });
  });

  it('returns a new object every time', () => {
    const first = scoring.initialStats();
    first.daily.push({ day: '2026-10-06', equityMicro: 1 });
    first.tradeCount = 9;
    expect(scoring.initialStats()).toEqual(startingStats());
  });
});

describe('scoring.updateStats', () => {
  it('records a first decision', () => {
    // return = round((10,684,000,000 - 1e10) * 1e4 / 1e10) = 684. New peak, no drawdown.
    const stats = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', 10_684_000_000, 3));
    expect(stats).toEqual({
      equityMicro: 10_684_000_000,
      peakEquityMicro: 10_684_000_000,
      seasonReturnBps: 684,
      maxDrawdownBps: 0,
      tradeCount: 3,
      decidedCount: 1,
      noDecisionCount: 0,
      skippedCount: 0,
      tradingDays: 1,
      lastDay: '2026-10-06',
      daily: [{ day: '2026-10-06', equityMicro: 10_684_000_000 }],
    });
  });

  it('replaces the point of the day for a second row on the same day', () => {
    // drawdown = round((10,684e6 - 10,500e6) * 1e4 / 10,684e6) = round(172.22) = 172.
    const first = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', 10_684_000_000, 3));
    const second = scoring.updateStats(first, event('2026-10-06', 'no_decision', 10_500_000_000));
    expect(second).toEqual({
      equityMicro: 10_500_000_000,
      peakEquityMicro: 10_684_000_000,
      seasonReturnBps: 500,
      maxDrawdownBps: 172,
      tradeCount: 3,
      decidedCount: 1,
      noDecisionCount: 1,
      skippedCount: 0,
      tradingDays: 1,
      lastDay: '2026-10-06',
      daily: [{ day: '2026-10-06', equityMicro: 10_500_000_000 }],
    });
  });

  it('appends a point on a new day and counts the trading day', () => {
    const first = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', 10_684_000_000, 3));
    const second = scoring.updateStats(first, event('2026-10-07', 'skipped', 10_700_000_000));
    expect(second.tradingDays).toBe(2);
    expect(second.skippedCount).toBe(1);
    expect(second.decidedCount).toBe(1);
    expect(second.lastDay).toBe('2026-10-07');
    expect(second.peakEquityMicro).toBe(10_700_000_000);
    expect(second.daily).toEqual([
      { day: '2026-10-06', equityMicro: 10_684_000_000 },
      { day: '2026-10-07', equityMicro: 10_700_000_000 },
    ]);
  });

  it('counts a day for a skipped or failed row too: a row is a row', () => {
    const skipped = scoring.updateStats(startingStats(), event('2026-10-06', 'skipped', START));
    expect([skipped.tradingDays, skipped.skippedCount, skipped.decidedCount, skipped.noDecisionCount]).toEqual([
      1, 1, 0, 0,
    ]);
    const failed = scoring.updateStats(startingStats(), event('2026-10-06', 'no_decision', START));
    expect([failed.tradingDays, failed.skippedCount, failed.decidedCount, failed.noDecisionCount]).toEqual([
      1, 0, 0, 1,
    ]);
  });

  it('keeps the largest drawdown after the portfolio recovers', () => {
    // Peak 12e9, fall to 9e9: round(3e9 * 1e4 / 12e9) = 2,500. Then a new peak of 13e9.
    let stats = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', 12_000_000_000));
    stats = scoring.updateStats(stats, event('2026-10-07', 'decided', 9_000_000_000));
    expect(stats.maxDrawdownBps).toBe(2_500);
    expect(stats.seasonReturnBps).toBe(-1_000);
    stats = scoring.updateStats(stats, event('2026-10-08', 'decided', 13_000_000_000));
    expect(stats.maxDrawdownBps).toBe(2_500);
    expect(stats.peakEquityMicro).toBe(13_000_000_000);
    expect(stats.seasonReturnBps).toBe(3_000);
    // A smaller fall from the new peak does not lower the record: round(1e9 * 1e4 / 13e9) = 769.
    stats = scoring.updateStats(stats, event('2026-10-09', 'decided', 12_000_000_000));
    expect(stats.maxDrawdownBps).toBe(2_500);
  });

  it('measures drawdown from the starting value when the portfolio never rose', () => {
    // round((1e10 - 9,876,543,210) * 1e4 / 1e10) = round(123.45679) = 123.
    const stats = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', 9_876_543_210, 1));
    expect(stats.peakEquityMicro).toBe(START);
    expect(stats.maxDrawdownBps).toBe(123);
    expect(stats.seasonReturnBps).toBe(-123);
  });

  it('returns 0, never negative zero, for a loss too small to show', () => {
    // (-1 * 1e4) / 1e10 = -0.000001, and Math.round of that is -0.
    const stats = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', START - 1, 1));
    expect(Object.is(stats.seasonReturnBps, 0)).toBe(true);
    expect(Object.is(stats.maxDrawdownBps, 0)).toBe(true);
    expect(JSON.stringify(stats.seasonReturnBps)).toBe('0');
    expect(agentStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('rounds a half toward positive infinity, and still never returns negative zero', () => {
    // -0.5 bps rounds to -0, which is returned as 0. -1.5 rounds to -1. +0.5 rounds to 1.
    const half = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', START - 500_000));
    expect(Object.is(half.seasonReturnBps, 0)).toBe(true);
    // The drawdown of the same event is +0.5 bps of the peak, which rounds up to 1.
    expect(half.maxDrawdownBps).toBe(1);
    const oneAndHalf = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', START - 1_500_000));
    expect(oneAndHalf.seasonReturnBps).toBe(-1);
    expect(oneAndHalf.maxDrawdownBps).toBe(2);
    const up = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', START + 500_000));
    expect(up.seasonReturnBps).toBe(1);
    expect(Object.is(up.maxDrawdownBps, 0)).toBe(true);
  });

  it('handles a portfolio that fell to zero', () => {
    const stats = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', 0, 2));
    expect(stats.seasonReturnBps).toBe(-10_000);
    expect(stats.maxDrawdownBps).toBe(10_000);
    expect(agentStatsSchema.safeParse(stats).success).toBe(true);
  });

  it('does not mutate the previous stats', () => {
    const previous = scoring.updateStats(startingStats(), event('2026-10-06', 'decided', 10_100_000_000, 1));
    const before = JSON.stringify(previous);
    const frozen = deepFreeze(structuredClone(previous));
    const sameDay = scoring.updateStats(frozen, event('2026-10-06', 'decided', 10_200_000_000, 1));
    const nextDay = scoring.updateStats(frozen, event('2026-10-07', 'decided', 10_300_000_000, 1));
    expect(JSON.stringify(frozen)).toBe(before);
    sameDay.daily.push({ day: '2026-10-09', equityMicro: 1 });
    nextDay.daily.length = 0;
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('holds its invariants over random histories, and replaying a history gives the same stats', () => {
    const rng = createRng(301);
    for (let run = 0; run < 300; run += 1) {
      const events: StatsEvent[] = [];
      let day = 5;
      let equity = START;
      for (let i = 0, count = rng.int(1, 60); i < count; i += 1) {
        if (rng.chance(0.3)) day += rng.int(1, 3);
        const status = rng.pick<RowStatus>(['decided', 'decided', 'no_decision', 'skipped']);
        equity = Math.max(0, Math.round(equity * (0.9 + rng.next() * 0.2)));
        const date = new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10);
        events.push(event(date, status, equity, status === 'decided' ? rng.int(0, 6) : 0));
      }

      let stats = scoring.initialStats();
      let previousDrawdown = 0;
      for (const step of events) {
        stats = scoring.updateStats(stats, step);
        expect(agentStatsSchema.safeParse(stats).success).toBe(true);
        expect(stats.equityMicro).toBe(step.equityMicro);
        expect(stats.peakEquityMicro).toBeGreaterThanOrEqual(stats.equityMicro);
        expect(stats.maxDrawdownBps).toBeGreaterThanOrEqual(previousDrawdown);
        expect(Object.is(stats.seasonReturnBps, -0)).toBe(false);
        expect(Object.is(stats.maxDrawdownBps, -0)).toBe(false);
        previousDrawdown = stats.maxDrawdownBps;
      }

      const days = [...new Set(events.map((step) => step.day))];
      const last = events[events.length - 1] as StatsEvent;
      expect(stats.tradingDays).toBe(days.length);
      expect(stats.daily.map((point) => point.day)).toEqual(days);
      expect(stats.daily.map((point) => point.equityMicro)).toEqual(
        days.map((d) => (events.filter((step) => step.day === d).pop() as StatsEvent).equityMicro),
      );
      expect(stats.lastDay).toBe(last.day);
      expect(stats.decidedCount + stats.noDecisionCount + stats.skippedCount).toBe(events.length);
      expect(stats.decidedCount).toBe(events.filter((step) => step.status === 'decided').length);
      expect(stats.tradeCount).toBe(events.reduce((sum, step) => sum + step.fillCount, 0));
      expect(stats.peakEquityMicro).toBe(Math.max(START, ...events.map((step) => step.equityMicro)));
      expect(stats.seasonReturnBps).toBe(expectedRound(((last.equityMicro - START) * 10_000) / START));

      const replayed = events.reduce((acc, step) => scoring.updateStats(acc, step), scoring.initialStats());
      expect(replayed).toEqual(stats);
    }
  });
});

describe('scoring.unrankedReason', () => {
  it('ranks an active agent that meets both thresholds', () => {
    expect(scoring.unrankedReason(rankable(), true)).toBeNull();
  });

  it('gives the first reason that applies, in the order of the contract', () => {
    expect(MIN_TRADING_DAYS_TO_RANK).toBe(5);
    expect(MIN_DECISIONS_TO_RANK).toBe(3);
    expect(scoring.unrankedReason(statsWith({ tradingDays: 4, decidedCount: 0 }), false)).toBe('min_trading_days');
    expect(scoring.unrankedReason(statsWith({ tradingDays: 4, decidedCount: 9 }), true)).toBe('min_trading_days');
    expect(scoring.unrankedReason(statsWith({ tradingDays: 5, decidedCount: 2 }), false)).toBe('min_decisions');
    expect(scoring.unrankedReason(statsWith({ tradingDays: 9, decidedCount: 2 }), true)).toBe('min_decisions');
    expect(scoring.unrankedReason(statsWith({ tradingDays: 5, decidedCount: 3 }), false)).toBe('inactive');
  });

  it('gives a paused agent with a good record the reason "inactive": pausing cannot hold a rank', () => {
    const stats = rankable({ tradingDays: 20, decidedCount: 20, seasonReturnBps: 4_200 });
    expect(scoring.unrankedReason(stats, false)).toBe('inactive');
    expect(scoring.unrankedReason(stats, true)).toBeNull();
  });

  it('counts only decisions toward the decision threshold, not skipped or failed rows', () => {
    const stats = statsWith({ tradingDays: 9, decidedCount: 2, noDecisionCount: 30, skippedCount: 30 });
    expect(scoring.unrankedReason(stats, true)).toBe('min_decisions');
  });
});

describe('scoring.compare', () => {
  const base = () => rankable({ seasonReturnBps: 500, maxDrawdownBps: 200, tradeCount: 10 });

  it('puts the higher season return first', () => {
    const a = entry(1, { ...base(), seasonReturnBps: 501 });
    const b = entry(2, base());
    expect(scoring.compare(a, b)).toBeLessThan(0);
    expect(scoring.compare(b, a)).toBeGreaterThan(0);
  });

  it('orders negative returns correctly', () => {
    const a = entry(1, { ...base(), seasonReturnBps: -10 });
    const b = entry(2, { ...base(), seasonReturnBps: -2_000 });
    expect(scoring.compare(a, b)).toBeLessThan(0);
  });

  it('breaks a tie on return with the lower drawdown', () => {
    const a = entry(2, { ...base(), maxDrawdownBps: 199 });
    const b = entry(1, base());
    expect(scoring.compare(a, b)).toBeLessThan(0);
    expect(scoring.compare(b, a)).toBeGreaterThan(0);
  });

  it('then with the lower trade count', () => {
    const a = entry(2, { ...base(), tradeCount: 9 });
    const b = entry(1, base());
    expect(scoring.compare(a, b)).toBeLessThan(0);
  });

  it('then with the earlier creation time, compared as text', () => {
    const a = entry(2, base(), 'decided', '2026-10-05T07:59:59.999Z');
    const b = entry(1, base(), 'decided', '2026-10-05T08:00:00.000Z');
    expect(scoring.compare(a, b)).toBeLessThan(0);
    expect(scoring.compare(b, a)).toBeGreaterThan(0);
  });

  it('and last with the lower agent id, so two agents never compare as equal', () => {
    const a = entry(1, base());
    const b = entry(2, base());
    expect(scoring.compare(a, b)).toBeLessThan(0);
    expect(scoring.compare(b, a)).toBeGreaterThan(0);
  });

  it('does not let a later key override an earlier one', () => {
    // Better return, but worse on every later key.
    const a = entry(
      9,
      { ...base(), seasonReturnBps: 501, maxDrawdownBps: 9_000, tradeCount: 999 },
      'decided',
      '2026-10-09T00:00:00.000Z',
    );
    const b = entry(1, base());
    expect(scoring.compare(a, b)).toBeLessThan(0);
  });
});

describe('scoring.rankAgents', () => {
  it('returns no rows for no entries', () => {
    expect(scoring.rankAgents([])).toEqual([]);
  });

  it('ranks the eligible agents 1, 2, 3 and lists the others after them with a reason', () => {
    const leader = entry(1, rankable({ seasonReturnBps: 900, equityMicro: 10_900_000_000 }));
    const second = entry(2, rankable({ seasonReturnBps: 300, equityMicro: 10_300_000_000 }));
    const third = entry(3, rankable({ seasonReturnBps: -50, equityMicro: 9_950_000_000 }));
    const paused = entry(4, rankable({ seasonReturnBps: 5_000, equityMicro: 15_000_000_000 }), null);
    const young = entry(5, statsWith({ seasonReturnBps: 2_000, tradingDays: 2, decidedCount: 2 }));
    const quiet = entry(6, statsWith({ seasonReturnBps: 100, tradingDays: 6, decidedCount: 1 }), 'no_decision');

    const rows = scoring.rankAgents([quiet, third, young, paused, leader, second]);
    expect(rows.map((row) => [row.agentId, row.rank, row.unrankedReason])).toEqual([
      [leader.agentId, 1, null],
      [second.agentId, 2, null],
      [third.agentId, 3, null],
      // Unranked, in compare order: the paused agent has the best return of the three.
      [paused.agentId, null, 'inactive'],
      [young.agentId, null, 'min_trading_days'],
      [quiet.agentId, null, 'min_decisions'],
    ]);
    for (const row of rows) expect(standingRowSchema.safeParse(row).success).toBe(true);
  });

  it('does not give a paused agent a rank, even with the best record in the division', () => {
    const paused = entry(1, rankable({ seasonReturnBps: 9_000 }), null);
    const active = entry(2, rankable({ seasonReturnBps: 1 }));
    const rows = scoring.rankAgents([paused, active]);
    expect(rows[0]).toMatchObject({ agentId: active.agentId, rank: 1, unrankedReason: null });
    expect(rows[1]).toMatchObject({
      agentId: paused.agentId,
      rank: null,
      unrankedReason: 'inactive',
      lastStatus: null,
    });
  });

  it('ranks an agent whose row at the tick was skipped or failed: it has a row, so it is active', () => {
    const skipped = entry(1, rankable({ seasonReturnBps: 10 }), 'skipped');
    const failed = entry(2, rankable({ seasonReturnBps: 5 }), 'no_decision');
    expect(scoring.rankAgents([failed, skipped]).map((row) => [row.rank, row.lastStatus])).toEqual([
      [1, 'skipped'],
      [2, 'no_decision'],
    ]);
  });

  it('copies the figures of an agent into its row, with the daily values as the sparkline', () => {
    const stats = rankable({
      equityMicro: 10_684_000_000,
      seasonReturnBps: 684,
      maxDrawdownBps: 172,
      tradeCount: 14,
      tradingDays: 6,
      daily: [
        { day: '2026-10-05', equityMicro: 10_100_000_000 },
        { day: '2026-10-06', equityMicro: 10_684_000_000 },
      ],
    });
    const [row] = scoring.rankAgents([entry(7, stats, 'decided')]);
    expect(row).toEqual({
      rank: 1,
      unrankedReason: null,
      agentId: testId('agent', 7),
      name: 'Agent 7',
      seasonReturnBps: 684,
      maxDrawdownBps: 172,
      tradeCount: 14,
      tradingDays: 6,
      equityMicro: 10_684_000_000,
      spark: [10_100_000_000, 10_684_000_000],
      lastStatus: 'decided',
    });
  });

  it('never shares a rank and never skips one, whatever the input order', () => {
    const rng = createRng(302);
    for (let run = 0; run < 200; run += 1) {
      const entries: RankInput[] = [];
      for (let n = 0, count = rng.int(1, 40); n < count; n += 1) {
        entries.push(
          entry(
            n,
            statsWith({
              // Few distinct values, so ties on every key are common.
              seasonReturnBps: rng.int(-2, 2) * 100,
              maxDrawdownBps: rng.int(0, 2) * 50,
              tradeCount: rng.int(0, 2),
              tradingDays: rng.int(3, 7),
              decidedCount: rng.int(1, 5),
            }),
            rng.pick<RowStatus | null>(['decided', 'decided', 'no_decision', 'skipped', null]),
            `2026-10-0${rng.int(5, 6)}T08:00:00.000Z`,
          ),
        );
      }
      const rows = scoring.rankAgents(rng.shuffle(entries));
      const byId = new Map(entries.map((item) => [item.agentId, item]));
      const eligible = (item: RankInput) =>
        item.stats.tradingDays >= 5 && item.stats.decidedCount >= 3 && item.lastStatus !== null;
      const expected = [
        ...entries.filter(eligible).sort(referenceOrder),
        ...entries.filter((item) => !eligible(item)).sort(referenceOrder),
      ];
      expect(rows.map((row) => row.agentId)).toEqual(expected.map((item) => item.agentId));

      const rankedCount = entries.filter(eligible).length;
      expect(rows.map((row) => row.rank)).toEqual(expected.map((_, index) => (index < rankedCount ? index + 1 : null)));
      for (const row of rows) {
        const source = byId.get(row.agentId) as RankInput;
        expect(row.unrankedReason).toBe(scoring.unrankedReason(source.stats, source.lastStatus !== null));
        expect(row.rank === null).toBe(row.unrankedReason !== null);
      }
      // The same data in another order gives the same table.
      expect(scoring.rankAgents(rng.shuffle(entries))).toEqual(rows);
    }
  });

  it('agrees with compare: sorting with compare gives the order of each group', () => {
    const rng = createRng(303);
    const entries = Array.from({ length: 30 }, (_, n) =>
      entry(n, rankable({ seasonReturnBps: rng.int(-3, 3), maxDrawdownBps: rng.int(0, 3), tradeCount: rng.int(0, 3) })),
    );
    const rows = scoring.rankAgents(entries);
    expect(rows.map((row) => row.agentId)).toEqual([...entries].sort(scoring.compare).map((item) => item.agentId));
  });
});

/** Math.round with negative zero returned as 0, as section 9 words it. */
function expectedRound(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/** The order of section 9, written here on its own. */
function referenceOrder(a: RankInput, b: RankInput): number {
  if (a.stats.seasonReturnBps !== b.stats.seasonReturnBps) return b.stats.seasonReturnBps - a.stats.seasonReturnBps;
  if (a.stats.maxDrawdownBps !== b.stats.maxDrawdownBps) return a.stats.maxDrawdownBps - b.stats.maxDrawdownBps;
  if (a.stats.tradeCount !== b.stats.tradeCount) return a.stats.tradeCount - b.stats.tradeCount;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.agentId < b.agentId ? -1 : 1;
}
