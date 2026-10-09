import type { AgentPublic, SeasonScoreRow, StandingRow, UnrankedReason } from '@prix/contracts';
import { agentPublicSchema, dataEnvelope, leagueResponseSchema, SCORING_METHOD } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createDataHarness, testWallet } from '../data/support/harness.ts';
import type { Api } from '../support/api.ts';
import { createApi, expectShape } from '../support/api.ts';
import { makeTick, SEASON_1, testId, utc } from '../support/fixtures.ts';

/**
 * Part A of docs/contracts/phase-6-social.md, section 3, as the public API shows it: every row of
 * the mapping table through GET /api/league and GET /api/agents/:id, and the same rank and the same
 * reason on the league row, the agent read and both handlers of the data API (/api/v1/league and
 * /api/v1/agents/:id). The store is the in-memory one, which follows the same rule as the D1 store.
 */

const NOW = '2026-10-20T20:10:00.000Z';
const TICK_AT = '2026-10-20T19:00:00.000Z';
const TICK = '2026-10-20T19:00Z';
const SCORED_DAY = '2026-10-19';

const ranked = (seasonReturnBps: number) => ({
  seasonReturnBps,
  equityMicro: 10_000_000_000 + seasonReturnBps * 1_000_000,
  peakEquityMicro: 10_000_000_000 + Math.max(0, seasonReturnBps) * 1_000_000,
  tradingDays: 12,
  decidedCount: 9,
});

interface Figures {
  rank: number | null;
  unrankedReason: UnrankedReason | null;
  scoreMilli: number | null;
  confidence: string | null;
  scoredDay: string | null;
}

const figuresOf = (row: Omit<Figures, 'scoreMilli' | 'confidence' | 'scoredDay'> & Partial<Figures>): Figures => ({
  rank: row.rank,
  unrankedReason: row.unrankedReason,
  scoreMilli: row.scoreMilli ?? null,
  confidence: row.confidence ?? null,
  scoredDay: row.scoredDay ?? null,
});

const NONE: Figures = { rank: null, unrankedReason: null, scoreMilli: null, confidence: null, scoredDay: null };

function scoreRow(
  n: number,
  over: Partial<SeasonScoreRow> & { rank?: number | null } = {},
): SeasonScoreRow & { rank: number | null } {
  return {
    seasonId: SEASON_1.id,
    division: 'open',
    agentId: testId('agent', n),
    name: `Agent ${n}`,
    agentCreatedAt: '2026-10-05T08:00:00.000Z',
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
    updatedAt: '2026-10-20T01:00:00.000Z',
    rank: null,
    ...over,
  };
}

async function world(options: { method: 'v1' | 'v2'; ticks?: boolean } = { method: 'v2' }): Promise<Api> {
  const api = createApi({ now: NOW });
  expect(await api.store.createTick(makeTick(utc(TICK_AT), { daily: true, status: 'complete' }))).toBe(true);
  if (options.method === 'v2') api.store.seedSeasonMethod(SEASON_1.id, 'v2');
  return api;
}

async function leagueRows(api: Api): Promise<Map<string, StandingRow>> {
  const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open'));
  return new Map(league.rows.map((row) => [row.agentId, row]));
}

async function agentPage(api: Api, id: string): Promise<AgentPublic> {
  return expectShape(agentPublicSchema, await api.client().get(`/api/agents/${id}`));
}

describe('the mapping table of the official rank (section 3)', () => {
  it('v1 season: rank and reason as before, and no v2 figures', async () => {
    const api = await world({ method: 'v1' });
    const top = await api.seedAgent({ n: 1, tickId: TICK, stats: ranked(500) });
    const young = await api.seedAgent({ n: 2, tickId: TICK, stats: { ...ranked(100), tradingDays: 2 } });
    const idle = await api.seedAgent({ n: 3, tickId: TICK, stats: { ...ranked(50), decidedCount: 1 } });
    await api.store.rerank(SEASON_1.id, 'open', TICK, NOW, SCORING_METHOD);
    // Score rows of the wrong season method must not matter.
    api.store.seedSeasonScores([scoreRow(1, { method: 'v1', scoreMilli: null, confidence: null }), scoreRow(2)]);

    const rows = await leagueRows(api);
    expect(figuresOf(rows.get(top.id) as StandingRow)).toEqual({ ...NONE, rank: 1 });
    expect(figuresOf(rows.get(young.id) as StandingRow)).toEqual({ ...NONE, unrankedReason: 'min_trading_days' });
    expect(figuresOf(rows.get(idle.id) as StandingRow)).toEqual({ ...NONE, unrankedReason: 'min_decisions' });
    for (const agent of [top, young, idle]) {
      const page = await agentPage(api, agent.id);
      expect(figuresOf(page)).toEqual(figuresOf(rows.get(agent.id) as StandingRow));
      expect(page.method).toBe('v1');
    }
  });

  it('v2 season, no league state yet: no rank, no reason, no figures', async () => {
    const api = await world();
    const agent = await api.seedAgent({ n: 1, tickId: TICK, stats: ranked(500) });
    api.store.seedSeasonScores([scoreRow(1, { rank: 1 })]);
    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open'));
    expect(league.state).toBeNull();
    expect(figuresOf(league.rows[0] as StandingRow)).toEqual(NONE);
    expect(figuresOf(await agentPage(api, agent.id))).toEqual(NONE);
  });

  it('v2 season, state without a scored day: no rank, no reason, no figures', async () => {
    const api = await world();
    const agent = await api.seedAgent({ n: 1, tickId: TICK, stats: ranked(500) });
    await api.store.rerank(SEASON_1.id, 'open', TICK, NOW, SCORING_METHOD);
    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open'));
    expect(league.state).toMatchObject({ method: 'v2', scoredDay: null });
    expect(figuresOf(league.rows[0] as StandingRow)).toEqual(NONE);
    expect(figuresOf(await agentPage(api, agent.id))).toEqual(NONE);
  });

  it('v2 season after a pass: a stored rank, an unranked score, and an agent with no score row', async () => {
    const api = await world();
    const first = await api.seedAgent({ n: 1, tickId: TICK, stats: ranked(100) });
    const second = await api.seedAgent({ n: 2, tickId: TICK, stats: ranked(900) });
    const inactive = await api.seedAgent({ n: 3, tickId: TICK, stats: ranked(300) });
    const fresh = await api.seedAgent({ n: 4, tickId: TICK, stats: { ...ranked(0), tradingDays: 1, decidedCount: 1 } });
    // The official order differs from the v1 order on purpose: agent 1 is last by return and first by score.
    api.store.seedSeasonScores([
      scoreRow(1, { scoreMilli: 640, confidence: 'medium', rank: 1 }),
      scoreRow(2, { scoreMilli: 120, confidence: 'low', rank: 2 }),
      scoreRow(3, { scoreMilli: null, confidence: 'low', unrankedReason: 'inactive', rank: null }),
    ]);
    await api.store.rerank(SEASON_1.id, 'open', TICK, NOW, SCORING_METHOD);

    const rows = await leagueRows(api);
    // Row: a stored rank. The rank is the copied one, the reason is null, the figures come from the score row.
    expect(figuresOf(rows.get(first.id) as StandingRow)).toEqual({
      rank: 1,
      unrankedReason: null,
      scoreMilli: 640,
      confidence: 'medium',
      scoredDay: SCORED_DAY,
    });
    expect(figuresOf(rows.get(second.id) as StandingRow)).toEqual({
      rank: 2,
      unrankedReason: null,
      scoreMilli: 120,
      confidence: 'low',
      scoredDay: SCORED_DAY,
    });
    // Row: no rank, a score row. The reason is the score row's, with its figures.
    expect(figuresOf(rows.get(inactive.id) as StandingRow)).toEqual({
      rank: null,
      unrankedReason: 'inactive',
      scoreMilli: null,
      confidence: 'low',
      scoredDay: SCORED_DAY,
    });
    // Row: no rank, no score row, a scored day: too few trading days, and no figures.
    expect(figuresOf(rows.get(fresh.id) as StandingRow)).toEqual({ ...NONE, unrankedReason: 'min_trading_days' });

    // The agent page says the same for every one of them.
    for (const agent of [first, second, inactive, fresh]) {
      expect(figuresOf(await agentPage(api, agent.id)), agent.id).toEqual(figuresOf(rows.get(agent.id) as StandingRow));
    }
    const page = await agentPage(api, first.id);
    expect(page.method).toBe('v2');
    expect(page.rankedCount).toBe(2);
  });

  it('v2 season: the live figures stay live and only the rank is as of the scored day', async () => {
    const api = await world();
    const agent = await api.seedAgent({ n: 1, tickId: TICK, stats: ranked(777) });
    api.store.seedSeasonScores([scoreRow(1, { returnBps: 5, rank: 1 })]);
    await api.store.rerank(SEASON_1.id, 'open', TICK, NOW, SCORING_METHOD);
    const row = (await leagueRows(api)).get(agent.id) as StandingRow;
    expect(row.seasonReturnBps).toBe(777);
    expect(row.rank).toBe(1);
    expect(row.scoredDay).toBe(SCORED_DAY);
  });

  it('a hidden agent is left out of the table and its score gives no rank to anyone else', async () => {
    const api = await world();
    const hidden = await api.seedAgent({ n: 1, tickId: TICK, stats: ranked(100), overrides: { hidden: true } });
    const shown = await api.seedAgent({ n: 2, tickId: TICK, stats: ranked(100) });
    api.store.seedSeasonScores([scoreRow(1, { rank: 1 }), scoreRow(2, { rank: 2 })]);
    await api.store.rerank(SEASON_1.id, 'open', TICK, NOW, SCORING_METHOD);
    const rows = await leagueRows(api);
    expect(rows.has(hidden.id)).toBe(false);
    expect(rows.get(shown.id)?.rank).toBe(2);
    expect((await api.client().get(`/api/agents/${hidden.id}`)).status).toBe(404);
  });
});

describe('one rank on every surface', () => {
  it('the league row, the agent read and both data handlers agree on rank, reason and figures', async () => {
    const h = await createDataHarness();
    const { api } = h;
    api.store.seedSeasonMethod(SEASON_1.id, 'v2');
    // Agent 1 is seeded by the harness at 2026-10-06T13:00Z. More agents, with stats at the same tick.
    const tickId = '2026-10-06T13:00Z';
    const second = await api.seedAgent({ n: 2, tickId, stats: ranked(200) });
    const third = await api.seedAgent({ n: 3, tickId, stats: ranked(400) });
    const fourth = await api.seedAgent({ n: 4, tickId, stats: { ...ranked(0), tradingDays: 1, decidedCount: 1 } });
    const ids = [h.agentId, second.id, third.id, fourth.id];
    api.store.seedSeasonScores([
      scoreRow(1, { agentId: h.agentId, scoreMilli: 310, confidence: 'high', rank: 2 }),
      scoreRow(2, { scoreMilli: 900, confidence: 'medium', rank: 1 }),
      scoreRow(3, { scoreMilli: null, confidence: 'insufficient', unrankedReason: 'min_decisions', rank: null }),
    ]);
    await api.store.rerank(SEASON_1.id, 'open', tickId, '2026-10-06T13:30:00.000Z', SCORING_METHOD);

    const { secret } = await h.seedKey(testWallet(81).address);
    const publicRows = await leagueRows(api);
    const dataLeague = await h.send('GET', '/api/v1/league?division=open', { key: secret });
    expect(dataLeague.status, dataLeague.text).toBe(200);
    const dataRows = new Map(
      dataEnvelope(leagueResponseSchema)
        .parse(dataLeague.json)
        .data.rows.map((row) => [row.agentId, row]),
    );

    const seen: Figures[] = [];
    for (const id of ids) {
      const league = figuresOf(publicRows.get(id) as StandingRow);
      expect(figuresOf(dataRows.get(id) as StandingRow), `data league ${id}`).toEqual(league);
      expect(figuresOf(await agentPage(api, id)), `agent read ${id}`).toEqual(league);
      const dataAgent = await h.send('GET', `/api/v1/agents/${id}`, { key: secret });
      expect(dataAgent.status, dataAgent.text).toBe(200);
      expect(figuresOf(dataEnvelope(agentPublicSchema).parse(dataAgent.json).data), `data agent ${id}`).toEqual(league);
      seen.push(league);
    }
    // The comparison above is not about nothing: the four agents hold four different cases.
    expect(seen.map((f) => f.rank)).toEqual([2, 1, null, null]);
    expect(seen[2]?.unrankedReason).toBe('min_decisions');
    expect(seen[3]?.unrankedReason).toBe('min_trading_days');
  });
});
