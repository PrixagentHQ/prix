import type { AgentStats, DecisionRow, PortfolioState, PriceMap, Tick } from '@prix/contracts';
import { utcDayOfTick } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { replay } from '@prix/reputation/replay';
import { sim } from '@prix/sim';
import { describe, expect, it } from 'vitest';
import { makeAgent, makeSnapshot, makeTick, TEST_PRICES, utc } from '../support/fixtures.ts';
import { createRng } from '../support/prng.ts';

/**
 * Acceptance line 1 of docs/SPEC.md section 9: replaying an agent's stored rows through
 * `sim.rebalance` and `scoring.updateStats` reproduces the published record, and any change to
 * one fill, one equity or the published stats is a mismatch that names the first tick and field.
 * The rows are built as docs/CONTRACTS.md section 10 says: rebalance for a decided row, the same
 * portfolio for any other, and `updateStats` with the event of section 9.
 */

const SYMBOLS = Object.keys(TEST_PRICES);

interface Built {
  rows: DecisionRow[];
  ticks: Record<string, Tick>;
  published: AgentStats;
}

/** One agent's rows over the given tick times, from a seeded price walk. */
function build(division: 'open' | 'pro', times: readonly Date[], seed: number): Built {
  const rng = createRng(seed);
  const agent = makeAgent({ n: seed, division });
  const prices: PriceMap = { ...TEST_PRICES };
  let portfolio: PortfolioState = sim.newPortfolio();
  let stats = scoring.initialStats();
  const rows: DecisionRow[] = [];
  const ticks: Record<string, Tick> = {};

  times.forEach((time, index) => {
    for (const symbol of SYMBOLS) {
      prices[symbol] = Math.max(1_000_000, Math.round((prices[symbol] as number) * (1 + (rng.next() - 0.48) * 0.04)));
    }
    // One feed is stale at tick 7: its symbol is valued but never traded.
    const stale = index === 7 ? ['NVDA'] : [];
    const snapshot = makeSnapshot(time, { prices, stale });
    const tick = makeTick(time, { daily: true, status: 'complete', snapshot });
    ticks[tick.id] = tick;

    const priceMap: PriceMap = {};
    for (const point of snapshot.prices) priceMap[point.symbol] = point.priceMicro;
    const halted = snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol);

    // Every fifth row is a no decision, every eleventh one is skipped; the rest are decided.
    const status = index % 11 === 10 ? 'skipped' : index % 5 === 4 ? 'no_decision' : 'decided';
    let row: DecisionRow;
    if (status === 'decided') {
      const targetsBps: Record<string, number> = {};
      for (const symbol of rng.shuffle(SYMBOLS).slice(0, rng.int(2, 4))) targetsBps[symbol] = rng.int(500, 2_400);
      const result = sim.rebalance({ portfolio, prices: priceMap, targetsBps, halted });
      portfolio = result.portfolio;
      row = {
        agentId: agent.id,
        tickId: tick.id,
        seasonId: tick.seasonId,
        division,
        status,
        code: null,
        targetsBps,
        reason: 'Follows the plan.',
        fills: result.fills,
        halted,
        portfolio: result.portfolio,
        equityMicro: result.equityAfterMicro,
        costMicro: result.costMicro,
        model: 'house:test',
        strategyAt: agent.strategyChangedAt,
        createdAt: `${tick.id.slice(0, 16)}:01.000Z`,
      };
    } else {
      row = {
        agentId: agent.id,
        tickId: tick.id,
        seasonId: tick.seasonId,
        division,
        status,
        code: status === 'skipped' ? 'not_reached' : 'invalid_json',
        targetsBps: null,
        reason: null,
        fills: [],
        halted,
        portfolio,
        equityMicro: sim.valuePortfolio(portfolio, priceMap),
        costMicro: 0,
        model: status === 'skipped' ? null : 'house:test',
        strategyAt: status === 'skipped' ? null : agent.strategyChangedAt,
        createdAt: `${tick.id.slice(0, 16)}:01.000Z`,
      };
    }
    stats = scoring.updateStats(stats, {
      day: utcDayOfTick(row.tickId),
      status: row.status,
      equityMicro: row.equityMicro,
      fillCount: row.fills.length,
    });
    rows.push(row);
  });
  return { rows, ticks, published: stats };
}

/** Open: one tick a day for 20 days. Pro: 20 hourly ticks across five days (UTC 14:00 to 17:00). */
const OPEN_TIMES = Array.from({ length: 20 }, (_, i) => utc(`2026-10-${String(i + 1).padStart(2, '0')}T14:00:00.000Z`));
const PRO_TIMES = Array.from({ length: 20 }, (_, i) =>
  utc(`2026-10-${String(1 + Math.floor(i / 4)).padStart(2, '0')}T${String(14 + (i % 4))}:00:00.000Z`),
);

const CASES = [
  { name: 'an Open agent', make: () => build('open', OPEN_TIMES, 101) },
  { name: 'a Pro agent', make: () => build('pro', PRO_TIMES, 202) },
] as const;

function replayOf(built: Built, rows: readonly DecisionRow[] = built.rows, published: AgentStats = built.published) {
  return replay.replayAgent({ rows, ticks: built.ticks, sim, scoring, published });
}

function copyRows(built: Built): DecisionRow[] {
  return built.rows.map((r) => ({ ...r, fills: r.fills.map((f) => ({ ...f })) }));
}

describe.each(CASES)('replay of $name over 20 ticks', ({ make }) => {
  it('is a real record: it traded, and it has every kind of row', () => {
    const built = make();
    expect(built.rows).toHaveLength(20);
    expect(built.rows.some((r) => r.fills.length > 0)).toBe(true);
    expect(new Set(built.rows.map((r) => r.status))).toEqual(new Set(['decided', 'no_decision', 'skipped']));
  });

  it('matches: the replayed stats and portfolio equal the published ones', () => {
    const built = make();
    const report = replayOf(built);
    expect(report.match).toBe(true);
    expect(report.firstMismatch).toBeNull();
    expect(report.rows).toBe(20);
    expect(report.stats).toEqual(built.published);
    expect(report.portfolio).toEqual(built.rows[19]?.portfolio);
  });

  it('replays in chunks to the same result', () => {
    const built = make();
    const headRows = built.rows.slice(0, 9);
    const headStats = headRows.reduce(
      (stats, row) =>
        scoring.updateStats(stats, {
          day: utcDayOfTick(row.tickId),
          status: row.status,
          equityMicro: row.equityMicro,
          fillCount: row.fills.length,
        }),
      scoring.initialStats(),
    );
    const head = replayOf(built, headRows, headStats);
    expect(head.match).toBe(true);
    const tail = replay.replayAgent({
      rows: built.rows.slice(9),
      ticks: built.ticks,
      sim,
      scoring,
      published: built.published,
      from: { portfolio: head.portfolio, stats: head.stats },
    });
    expect(tail.match).toBe(true);
    expect(tail.stats).toEqual(built.published);
  });

  it('names the first tick and the field when one fill is changed', () => {
    const built = make();
    const at = built.rows.findIndex((r) => r.fills.length > 0);
    expect(at).toBeGreaterThanOrEqual(0);
    const rows = copyRows(built);
    const fill = (rows[at] as DecisionRow).fills[0] as DecisionRow['fills'][number];
    fill.unitsMicro += 1;
    const report = replayOf(built, rows);
    expect(report.match).toBe(false);
    expect(report.firstMismatch).toEqual({ tickId: built.rows[at]?.tickId, field: 'fills' });
  });

  it('names the first tick and the field when one equity is changed', () => {
    const built = make();
    const at = 12;
    const rows = copyRows(built);
    (rows[at] as DecisionRow).equityMicro += 1;
    const report = replayOf(built, rows);
    expect(report.match).toBe(false);
    expect(report.firstMismatch).toEqual({ tickId: built.rows[at]?.tickId, field: 'equity' });
  });

  it('names the last tick and the field stats when the published stats are changed', () => {
    const built = make();
    const report = replayOf(built, built.rows, { ...built.published, tradeCount: built.published.tradeCount + 1 });
    expect(report.match).toBe(false);
    expect(report.firstMismatch).toEqual({ tickId: built.rows[19]?.tickId, field: 'stats' });
  });

  it('reports the earliest of two changes', () => {
    const built = make();
    const rows = copyRows(built);
    (rows[15] as DecisionRow).equityMicro += 5;
    (rows[6] as DecisionRow).equityMicro += 5;
    expect(replayOf(built, rows).firstMismatch).toEqual({ tickId: built.rows[6]?.tickId, field: 'equity' });
  });

  it('names a changed portfolio', () => {
    const built = make();
    const rows = copyRows(built);
    const at = 4;
    (rows[at] as DecisionRow).portfolio = {
      ...(rows[at] as DecisionRow).portfolio,
      cashMicro: (rows[at] as DecisionRow).portfolio.cashMicro + 1,
    };
    expect(replayOf(built, rows).firstMismatch).toEqual({ tickId: built.rows[at]?.tickId, field: 'portfolio' });
  });

  it('never reads the model label or the reason', () => {
    const built = make();
    const rows = copyRows(built).map((r) => ({ ...r, model: 'something-else', reason: r.reason && 'changed words' }));
    expect(replayOf(built, rows).match).toBe(true);
  });
});

describe('replay of an empty season', () => {
  it('matches the starting state', () => {
    const report = replay.replayAgent({ rows: [], ticks: {}, sim, scoring, published: scoring.initialStats() });
    expect(report.match).toBe(true);
    expect(report.rows).toBe(0);
  });
});
