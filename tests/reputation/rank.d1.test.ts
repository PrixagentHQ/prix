import { env } from 'cloudflare:workers';
import type { ScoreRankInput, ScoringDivision, SeasonScoreRow } from '@prix/contracts';
import { scoringV2 } from '@prix/reputation/v2';
import { describe, expect, it } from 'vitest';
import { createReputationStore } from '../../apps/api/src/store/reputation.ts';
import { testId } from '../support/fixtures.ts';
import { createRng } from '../support/prng.ts';

/**
 * The ranking SQL computes (`rankScores`) is the ranking of the reference (`scoringV2.rankAll`),
 * on the real migrations in a local D1 database: ties, unranked rows and a second run included.
 */
const db = (env as unknown as { DB: D1Database }).DB;
const store = createReputationStore(db);

interface Seed {
  row: SeasonScoreRow;
  input: ScoreRankInput;
}

function seed(seasonId: string, division: ScoringDivision, n: number, over: Partial<SeasonScoreRow> = {}): Seed {
  const rng = createRng(n * 7919);
  const returns = Array.from({ length: rng.int(0, 16) }, () => rng.int(-300, 300));
  const days = returns.length;
  const core = scoringV2.seasonScore({
    division,
    returnsBps: returns,
    tradingDays: days,
    decidedCount: rng.int(0, 12),
    activeOnScoredDay: rng.chance(0.9),
    returnBps: rng.int(-500, 1_500),
    maxDrawdownBps: rng.int(0, 900),
  });
  const base: SeasonScoreRow = {
    seasonId,
    division,
    agentId: testId('agent', n),
    name: `Agent ${n}`,
    agentCreatedAt: `2026-10-0${1 + (n % 5)}T08:00:00.000Z`,
    method: 'v2',
    moments: core.moments,
    returnBps: rng.int(-500, 1_500),
    maxDrawdownBps: rng.int(0, 900),
    tradingDays: days,
    decidedCount: rng.int(0, 12),
    tradeCount: 3,
    scoreMilli: core.breakdown.scoreMilli,
    confidence: core.confidence,
    unrankedReason: core.unrankedReason,
    scoredDay: '2026-10-20',
    updatedAt: '2026-10-20T01:00:00.000Z',
  };
  const row = { ...base, ...over };
  return {
    row,
    input: {
      agentId: row.agentId,
      createdAt: row.agentCreatedAt,
      scoreMilli: row.scoreMilli ?? 0,
      returnBps: row.returnBps,
      maxDrawdownBps: row.maxDrawdownBps,
      unrankedReason: row.unrankedReason,
    },
  };
}

/** Rows that are eligible and share every sort key but the age and the id, so ties are decided late. */
function tied(seasonId: string, division: ScoringDivision, from: number, count: number): Seed[] {
  return Array.from({ length: count }, (_, i) =>
    seed(seasonId, division, from + i, {
      moments: { n: 12, sumBps: 600, sumSqBps: 40_000 },
      scoreMilli: 250,
      returnBps: 400,
      maxDrawdownBps: 120,
      confidence: 'low',
      unrankedReason: null,
      tradingDays: 12,
      decidedCount: 8,
      // Two agents share a creation time: the id decides.
      agentCreatedAt: `2026-10-0${1 + (i % 3)}T08:00:00.000Z`,
    }),
  );
}

async function ranksInD1(seasonId: string, division: ScoringDivision): Promise<Map<string, number | null>> {
  const result = await db
    .prepare('SELECT agent_id, rank FROM season_scores WHERE season_id = ?1 AND division = ?2')
    .bind(seasonId, division)
    .all<{ agent_id: string; rank: number | null }>();
  return new Map(result.results.map((r) => [r.agent_id, r.rank]));
}

function expectedRanks(seeds: readonly Seed[]): Map<string, number | null> {
  return new Map(scoringV2.rankAll(seeds.map((s) => s.input)).map((r) => [r.agentId, r.rank]));
}

describe('rankScores equals scoringV2.rankAll', () => {
  it.each(['open', 'chain'] as const)('on 60 random rows with ties, in the %s division', async (division) => {
    const seasonId = `season${division}aa`.slice(0, 12).padEnd(12, 'a');
    const seeds = [
      ...Array.from({ length: 40 }, (_, i) => seed(seasonId, division, i + 1)),
      ...tied(seasonId, division, 100, 20),
    ];
    await store.putScores(seeds.map((s) => s.row));
    const ranked = await store.rankScores(seasonId, division);

    const expected = expectedRanks(seeds);
    const actual = await ranksInD1(seasonId, division);
    expect(actual.size).toBe(seeds.length);
    for (const [agentId, rank] of expected) expect(actual.get(agentId), agentId).toBe(rank);
    expect(ranked).toBe([...expected.values()].filter((r) => r !== null).length);
    expect(ranked).toBeGreaterThan(20);
    // Not everything is ranked: the table has unranked rows too.
    expect([...actual.values()].some((r) => r === null)).toBe(true);
  });

  it('is the same when run twice', async () => {
    const seasonId = 'seasontwiceaa';
    const seeds = Array.from({ length: 30 }, (_, i) => seed(seasonId.slice(0, 12), 'pro', i + 1));
    await store.putScores(seeds.map((s) => s.row));
    const first = await store.rankScores(seasonId.slice(0, 12), 'pro');
    const before = await ranksInD1(seasonId.slice(0, 12), 'pro');
    const second = await store.rankScores(seasonId.slice(0, 12), 'pro');
    expect(second).toBe(first);
    expect(await ranksInD1(seasonId.slice(0, 12), 'pro')).toEqual(before);
  });

  it('follows the reference after scores change and an agent loses its eligibility', async () => {
    const seasonId = 'seasonmoveaaa';
    const seeds = tied(seasonId, 'open', 1, 8);
    await store.putScores(seeds.map((s) => s.row));
    await store.rankScores(seasonId, 'open');

    // Agent 3 falls below the minimum sample; agent 5 gets the best score; agent 7 drops to the worst.
    const changed = seeds.map((s) => {
      const n = Number.parseInt(s.row.name.split(' ')[1] ?? '0', 10);
      if (n === 3)
        return seed(seasonId, 'open', 3, { ...s.row, unrankedReason: 'min_trading_days', confidence: 'insufficient' });
      if (n === 5) return seed(seasonId, 'open', 5, { ...s.row, scoreMilli: 900 });
      if (n === 7) return seed(seasonId, 'open', 7, { ...s.row, scoreMilli: -50 });
      return s;
    });
    await store.putScores(changed.map((s) => s.row));
    await store.rankScores(seasonId, 'open');

    const expected = expectedRanks(changed);
    const actual = await ranksInD1(seasonId, 'open');
    for (const [agentId, rank] of expected) expect(actual.get(agentId), agentId).toBe(rank);
    expect(actual.get(testId('agent', 3))).toBeNull();
    expect(actual.get(testId('agent', 5))).toBe(1);
    expect(actual.get(testId('agent', 7))).toBe(7);
  });

  it('never ranks a row below the minimum sample, however high its score', async () => {
    const seasonId = 'seasonminsamp';
    const seeds = [
      ...tied(seasonId, 'open', 1, 3),
      seed(seasonId, 'open', 50, { scoreMilli: 5_000, unrankedReason: 'min_decisions', confidence: 'insufficient' }),
    ];
    await store.putScores(seeds.map((s) => s.row));
    await store.rankScores(seasonId, 'open');
    const actual = await ranksInD1(seasonId, 'open');
    expect(actual.get(testId('agent', 50))).toBeNull();
    expect(new Set([...actual.values()].filter((r) => r !== null))).toEqual(new Set([1, 2, 3]));
  });
});
