import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { AgentRecord, AgentStats, Division, RankInput, ScoringDivision, SeasonScoreRow } from '@prix/contracts';
import { SCORING_METHOD } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { createReputationStore } from '../../apps/api/src/store/reputation.ts';
import { makeAgent, makeRow, SEASON_1, startingPortfolio, startingStats, testId } from '../support/fixtures.ts';

/**
 * Part A of docs/contracts/phase-6-social.md: one official rank per season. `rerank` of the D1
 * store, on the real migrations in a local D1 database, copies the v2 rank from season_scores in a
 * v2 season and computes the v1 order in any other season, so the table, the agent page, the data
 * API and the archive publish one rank.
 */
const db = (env as unknown as { DB: D1Database }).DB;
const store = createD1Store(db);
const reputation = createReputationStore(db);

const V1 = SEASON_1;
const V2 = { id: 'seasontwoaaa', number: 2, startsAt: '2026-11-02T00:00:00.000Z', endsAt: '2026-12-28T00:00:00.000Z' };
const TICK = '2026-11-20T19:00Z';
const SCORED_DAY = '2026-11-19';

const agents = new Map<number, AgentRecord>();

function statsOf(returnBps: number, extra: Partial<AgentStats> = {}): AgentStats {
  return {
    ...startingStats(),
    equityMicro: 10_000_000_000 + returnBps * 1_000_000,
    peakEquityMicro: 10_000_000_000 + Math.max(returnBps, 0) * 1_000_000,
    seasonReturnBps: returnBps,
    tradingDays: 6,
    decidedCount: 6,
    ...extra,
  };
}

async function add(n: number, seasonId: string, division: Division = 'open'): Promise<AgentRecord> {
  const agent = makeAgent({ n, division, modelKeyId: division === 'pro' ? 'keyaaaaaaaaa' : null });
  expect(await store.createAgent(agent, seasonId, startingPortfolio(), startingStats(), 500, 500)).toBe('created');
  agents.set(n, agent);
  return agent;
}

/** A decision row at `tickId` with these stats, so that the v1 ranking sees the agent as active. */
async function settle(agent: AgentRecord, seasonId: string, tickId: string, stats: AgentStats): Promise<void> {
  const row = { ...makeRow({ agent, tickId, equityMicro: stats.equityMicro }), seasonId };
  expect(await store.writeDecision(row, stats, 0)).toBe(true);
}

function score(
  agent: AgentRecord,
  seasonId: string,
  over: Partial<SeasonScoreRow> = {},
  division: ScoringDivision = 'open',
): SeasonScoreRow {
  return {
    seasonId,
    division,
    agentId: agent.id,
    name: agent.name,
    agentCreatedAt: agent.createdAt,
    method: 'v2',
    moments: { n: 12, sumBps: 600, sumSqBps: 40_000 },
    returnBps: 400,
    maxDrawdownBps: 100,
    tradingDays: 12,
    decidedCount: 8,
    tradeCount: 3,
    scoreMilli: 250,
    confidence: 'low',
    unrankedReason: null,
    scoredDay: SCORED_DAY,
    updatedAt: '2026-11-20T01:00:00.000Z',
    ...over,
  };
}

async function ranksOf(seasonId: string, division: Division): Promise<Map<string, number | null>> {
  const result = await db
    .prepare('SELECT agent_id, rank FROM portfolios WHERE season_id = ?1 AND division = ?2')
    .bind(seasonId, division)
    .all<{ agent_id: string; rank: number | null }>();
  return new Map(result.results.map((r) => [r.agent_id, r.rank]));
}

/** How many times a rank was written, counted by a trigger the test adds after the migrations. */
async function rankWrites(): Promise<number> {
  const result = await db.prepare('SELECT count(*) AS n FROM qa_rank_writes').first<{ n: number }>();
  return result?.n ?? 0;
}

beforeAll(async () => {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  for (const { name } of tables.results) {
    if (!name.startsWith('_cf_')) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  const bindings = env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  await db
    .prepare('INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?, ?, ?, ?)')
    .bind(V1.id, V1.number, V1.startsAt, V1.endsAt)
    .run();
  expect(await reputation.putSeason(V2, 'v2', 56)).toBe(true);
  await db.prepare('CREATE TABLE qa_rank_writes (agent_id TEXT NOT NULL, season_id TEXT NOT NULL, rank INTEGER)').run();
  await db
    .prepare(
      `CREATE TRIGGER qa_rank_writes_trigger AFTER UPDATE OF rank ON portfolios
       BEGIN INSERT INTO qa_rank_writes VALUES (NEW.agent_id, NEW.season_id, NEW.rank); END`,
    )
    .run();
});

describe('rerank in a v2 season copies the official rank', () => {
  it('copies the rank of every visible ranked score, clears the others and ignores the method argument', async () => {
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map((n) => add(n, V2.id)));
    if (!a || !b || !c || !d) throw new Error('setup');
    // The v1 order would be d, c, b, a by return. The official order below is the reverse of it.
    for (const [agent, bps] of [
      [a, 100],
      [b, 200],
      [c, 300],
      [d, 400],
    ] as const) {
      await settle(agent, V2.id, TICK, statsOf(bps));
    }
    await reputation.putScores([
      score(a, V2.id, { scoreMilli: 900 }),
      score(b, V2.id, { scoreMilli: 800 }),
      score(c, V2.id, { scoreMilli: 700 }),
      score(d, V2.id, { scoreMilli: null, confidence: 'insufficient', unrankedReason: 'min_trading_days' }),
    ]);
    expect(await reputation.rankScores(V2.id, 'open')).toBe(3);

    const state = await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:05:00.000Z', SCORING_METHOD);
    const ranks = await ranksOf(V2.id, 'open');
    expect(ranks.get(a.id)).toBe(1);
    expect(ranks.get(b.id)).toBe(2);
    expect(ranks.get(c.id)).toBe(3);
    expect(ranks.get(d.id)).toBeNull();
    expect(state).toMatchObject({ method: 'v2', rankedCount: 3, agentCount: 4, scoredDay: SCORED_DAY });
    expect(await store.getLeagueState(V2.id, 'open')).toEqual(state);

    // The `method` argument is ignored in a v2 season: the state says v2 whatever the caller passes.
    const again = await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:05:00.000Z', 'v1');
    expect(again.method).toBe('v2');
  });

  it('clears a rank when the score is no longer ranked, and copies a new one', async () => {
    const a = agents.get(1) as AgentRecord;
    const d = agents.get(4) as AgentRecord;
    const b = agents.get(2) as AgentRecord;
    const c = agents.get(3) as AgentRecord;
    // a loses its rank (inactive on the scored day); d becomes first; b and c move up.
    await reputation.putScores([
      score(a, V2.id, { scoreMilli: null, confidence: 'low', unrankedReason: 'inactive' }),
      score(d, V2.id, { scoreMilli: 950 }),
    ]);
    await reputation.rankScores(V2.id, 'open');
    await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:10:00.000Z', SCORING_METHOD);
    const ranks = await ranksOf(V2.id, 'open');
    expect(ranks.get(d.id)).toBe(1);
    expect(ranks.get(b.id)).toBe(2);
    expect(ranks.get(c.id)).toBe(3);
    expect(ranks.get(a.id)).toBeNull();
  });

  it('clears the rank of an agent that has no season_scores row at all', async () => {
    const e = await add(5, V2.id);
    await settle(e, V2.id, TICK, statsOf(5_000));
    // A stale rank, as a v1 pass would have left it.
    await db.prepare('UPDATE portfolios SET rank = 1 WHERE agent_id = ?1 AND season_id = ?2').bind(e.id, V2.id).run();
    await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:15:00.000Z', SCORING_METHOD);
    expect((await ranksOf(V2.id, 'open')).get(e.id)).toBeNull();
  });

  it('leaves a hidden agent without a rank and never copies its rank, and unhiding brings it back', async () => {
    const d = agents.get(4) as AgentRecord;
    await db.prepare('UPDATE agents SET hidden = 1 WHERE id = ?1').bind(d.id).run();
    const hidden = await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:20:00.000Z', SCORING_METHOD);
    let ranks = await ranksOf(V2.id, 'open');
    expect(ranks.get(d.id)).toBeNull();
    // The visible agents keep the ranks of season_scores, which still has d at 1: the official rank
    // is copied as it is, so the table has a gap where the hidden agent stood.
    expect(ranks.get((agents.get(2) as AgentRecord).id)).toBe(2);
    expect(hidden.rankedCount).toBe(2);

    await db.prepare('UPDATE agents SET hidden = 0 WHERE id = ?1').bind(d.id).run();
    await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:25:00.000Z', SCORING_METHOD);
    ranks = await ranksOf(V2.id, 'open');
    expect(ranks.get(d.id)).toBe(1);
  });

  it('is idempotent: a second run gives the same ranks and the same state, and writes no rank', async () => {
    const first = await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:30:00.000Z', SCORING_METHOD);
    const before = await ranksOf(V2.id, 'open');
    const writesBefore = await rankWrites();
    const second = await store.rerank(V2.id, 'open', TICK, '2026-11-20T19:30:00.000Z', SCORING_METHOD);
    expect(second).toEqual(first);
    expect(await ranksOf(V2.id, 'open')).toEqual(before);
    // Ranks that did not change are not written again.
    expect((await rankWrites()) - writesBefore).toBe(0);
  });

  it('keeps the division apart: a pro rerank touches no open rank', async () => {
    const p = await add(6, V2.id, 'pro');
    await settle(p, V2.id, TICK, statsOf(100));
    await reputation.putScores([score(p, V2.id, { scoreMilli: 111 }, 'pro')]);
    await reputation.rankScores(V2.id, 'pro');
    const openBefore = await ranksOf(V2.id, 'open');
    const state = await store.rerank(V2.id, 'pro', TICK, '2026-11-20T19:35:00.000Z', SCORING_METHOD);
    expect((await ranksOf(V2.id, 'pro')).get(p.id)).toBe(1);
    expect(state).toMatchObject({ division: 'pro', method: 'v2', rankedCount: 1, scoredDay: SCORED_DAY });
    expect(await ranksOf(V2.id, 'open')).toEqual(openBefore);
  });

  it('states scoredDay as the latest scored day of the division, and null before the first pass', async () => {
    const emptySeason = {
      id: 'seasonthreea',
      number: 3,
      startsAt: '2027-01-04T00:00:00.000Z',
      endsAt: '2027-03-01T00:00:00.000Z',
    };
    expect(await reputation.putSeason(emptySeason, 'v2', 56)).toBe(true);
    const x = await add(7, emptySeason.id);
    await settle(x, emptySeason.id, '2027-01-05T19:00Z', statsOf(10));
    const before = await store.rerank(
      emptySeason.id,
      'open',
      '2027-01-05T19:00Z',
      '2027-01-05T19:05:00.000Z',
      SCORING_METHOD,
    );
    expect(before).toMatchObject({ method: 'v2', scoredDay: null, rankedCount: 0 });

    await reputation.putScores([score(x, emptySeason.id, { scoredDay: '2027-01-04' })]);
    await reputation.putScores([score(x, emptySeason.id, { scoredDay: '2027-01-05' })]);
    await reputation.rankScores(emptySeason.id, 'open');
    const after = await store.rerank(
      emptySeason.id,
      'open',
      '2027-01-05T19:00Z',
      '2027-01-05T19:10:00.000Z',
      SCORING_METHOD,
    );
    expect(after.scoredDay).toBe('2027-01-05');
    expect((await ranksOf(emptySeason.id, 'open')).get(x.id)).toBe(1);
  });
});

describe('rerank in a v1 season is the v1 ranking, unchanged', () => {
  it('ranks by the order of section 9 and equals scoring.rankAgents', async () => {
    const inputs: RankInput[] = [];
    const returns = [350, -120, 900, 350, 0, 220];
    for (const [i, bps] of returns.entries()) {
      const agent = await add(20 + i, V1.id);
      const stats = statsOf(bps, { tradeCount: i % 3, maxDrawdownBps: (i * 37) % 200 });
      await settle(agent, V1.id, TICK, stats);
      inputs.push({ agentId: agent.id, name: agent.name, createdAt: agent.createdAt, stats, lastStatus: 'decided' });
    }
    // Scores of method v1 in the table must change nothing in a v1 season.
    await reputation.putScores(
      inputs.map((_input, i) =>
        score(agents.get(20 + i) as AgentRecord, V1.id, { method: 'v1', scoreMilli: null, confidence: null }),
      ),
    );
    const state = await store.rerank(V1.id, 'open', TICK, '2026-11-20T19:05:00.000Z', SCORING_METHOD);
    const expected = new Map(scoring.rankAgents(inputs).map((row) => [row.agentId, row.rank]));
    const actual = await ranksOf(V1.id, 'open');
    for (const [agentId, rank] of expected) expect(actual.get(agentId), agentId).toBe(rank);
    expect(state.method).toBe(SCORING_METHOD);
    expect(state.rankedCount).toBe([...expected.values()].filter((r) => r !== null).length);
    // A v1 state has no scoredDay (null or absent, the schema says).
    expect(state.scoredDay ?? null).toBeNull();
  });

  it('ignores season_scores rows of method v2 in a season whose method is v1', async () => {
    // Plant v2 scores that would reverse the order. The season has no season_methods row, so it is v1.
    const rows = [20, 21, 22, 23, 24, 25].map((n, i) =>
      score(agents.get(n) as AgentRecord, V1.id, { scoreMilli: 100 + i * 100 }),
    );
    await reputation.putScores(rows);
    await reputation.rankScores(V1.id, 'open');
    const before = await ranksOf(V1.id, 'open');
    const state = await store.rerank(V1.id, 'open', TICK, '2026-11-20T19:10:00.000Z', SCORING_METHOD);
    expect(await ranksOf(V1.id, 'open')).toEqual(before);
    expect(state.method).toBe(SCORING_METHOD);
  });

  it('takes the rank from an agent that loses its eligibility, as before', async () => {
    const quiet = agents.get(21) as AgentRecord;
    // No row at the new tick: the agent is not ranked at a later tick.
    const later = '2026-11-20T20:00Z';
    for (const n of [20, 22, 23, 24, 25]) {
      const agent = agents.get(n) as AgentRecord;
      const current = await store.getStanding(agent.id, V1.id);
      if (!current) throw new Error('no standing');
      await settle(agent, V1.id, later, { ...current.stats });
    }
    await store.rerank(V1.id, 'open', later, '2026-11-20T20:05:00.000Z', SCORING_METHOD);
    expect((await ranksOf(V1.id, 'open')).get(quiet.id)).toBeNull();
    expect(testId('agent', 21)).toBe(quiet.id);
  });
});
