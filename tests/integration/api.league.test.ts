import type { AgentStats, RankInput, RowStatus } from '@prix/contracts';
import {
  agentPublicSchema,
  LEAGUE_PAGE_SIZE,
  leagueResponseSchema,
  marketResponseSchema,
  SCORING_METHOD,
  seasonsResponseSchema,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../support/api.ts';
import { createApi, expectError, expectPublicCache, expectShape, PROMPT, rankingOf } from '../support/api.ts';
import {
  makeRow,
  makeSnapshot,
  makeTick,
  SEASON_1,
  startingStats,
  TEST_PRICES,
  testId,
  utc,
} from '../support/fixtures.ts';
import { createRng } from '../support/prng.ts';

/**
 * The public reads of docs/CONTRACTS.md sections 4 and 15: the market, the seasons, the
 * league and the agent page. Records are put into the store directly, the way the scheduler
 * leaves them, and the API must report them without adding or trusting anything.
 */

const T1 = '2026-10-06T15:00Z';
const T2 = '2026-10-06T16:00Z';
const T3 = '2026-10-06T17:00Z';
const NOW = '2026-10-06T16:10:00.000Z';

const ranked = (seasonReturnBps: number, extra: Partial<AgentStats> = {}): Partial<AgentStats> => ({
  seasonReturnBps,
  equityMicro: 10_000_000_000 + seasonReturnBps * 1_000_000,
  tradingDays: 5,
  decidedCount: 5,
  ...extra,
});

async function addTicks(api: Api, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    const tick = makeTick(utc(`${id.slice(0, 16)}:00.000Z`), { status: 'complete' });
    expect(await api.store.createTick(tick)).toBe(true);
  }
}

describe('GET /api/market and GET /api/seasons', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi({ now: NOW });
  });

  it('reports no market status before the scheduler has checked the market', async () => {
    const reply = await api.client().get('/api/market');
    const body = expectShape(marketResponseSchema, reply);
    expectPublicCache(reply);
    expect(body).toEqual({ market: null, season: SEASON_1 });
  });

  it('reports the stored market status, closed reason included', async () => {
    const status = {
      open: false,
      closedReason: 'feeds_stale' as const,
      checkedAt: NOW,
      lastTickId: T1,
      halted: ['NVDA'],
    };
    await api.store.putMarketStatus(status);
    const body = expectShape(marketResponseSchema, await api.client().get('/api/market'));
    expect(body.market).toEqual(status);
  });

  it('reports the active season only: null once it has ended, and null before any season exists', async () => {
    api.setNow('2026-12-01T00:00:00.000Z');
    expect(expectShape(marketResponseSchema, await api.client().get('/api/market')).season).toBeNull();
    const empty = createApi({ now: NOW, seasons: [] });
    expect(expectShape(marketResponseSchema, await empty.client().get('/api/market'))).toEqual({
      market: null,
      season: null,
    });
  });

  it('reports a market that is closed because symbols are held for review', async () => {
    const status = {
      open: false,
      closedReason: 'held_for_review' as const,
      checkedAt: NOW,
      lastTickId: T1,
      halted: ['AAPL', 'MSFT', 'NVDA'],
    };
    await api.store.putMarketStatus(status);
    expect(expectShape(marketResponseSchema, await api.client().get('/api/market')).market).toEqual(status);
  });

  it('lists the seasons', async () => {
    const reply = await api.client().get('/api/seasons');
    expect(expectShape(seasonsResponseSchema, reply).seasons).toEqual([SEASON_1]);
    expectPublicCache(reply);
  });

  it('answers 429 when the read limit of an IP address is reached', async () => {
    api.limiter.denied.add('read');
    const client = api.client('198.51.100.77');
    expectError(await client.get('/api/league'), 429, 'rate_limited');
    expect(api.limiter.asked).toContainEqual({ rule: 'read', subject: '198.51.100.77' });
  });

  it('answers 404 in the shape of the contract for a route that does not exist', async () => {
    expectError(await api.client().get('/api/does-not-exist'), 404, 'not_found');
  });
});

describe('GET /api/league', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi({ now: NOW });
  });

  const league = async (query = '') => expectShape(leagueResponseSchema, await api.client().get(`/api/league${query}`));

  it('serves an empty Open table by default, before any round', async () => {
    const reply = await api.client().get('/api/league');
    const body = expectShape(leagueResponseSchema, reply);
    expectPublicCache(reply);
    expect(body).toEqual({
      season: SEASON_1,
      division: 'open',
      seasonEnded: false,
      market: null,
      state: null,
      rows: [],
      page: 1,
      hasMore: false,
      round: null,
    });
  });

  it('shows agents without a rank and without a reason before the first ranking', async () => {
    await api.seedAgent({ n: 1 });
    await api.seedAgent({ n: 2 });
    const body = await league();
    expect(body.state).toBeNull();
    expect(body.rows).toHaveLength(2);
    for (const row of body.rows) expect(row).toMatchObject({ rank: null, unrankedReason: null, lastStatus: null });
  });

  it('shows the ranks the store published, and the reason for every agent without one', async () => {
    await addTicks(api, T1, T2);
    const leader = await api.seedAgent({ n: 1, stats: ranked(900), tickId: T2 });
    const second = await api.seedAgent({ n: 2, stats: ranked(300), tickId: T2, status: 'skipped' });
    const paused = await api.seedAgent({ n: 3, stats: ranked(5_000), tickId: T1 });
    const young = await api.seedAgent({ n: 4, stats: ranked(2_000, { tradingDays: 4 }), tickId: T2 });
    const quiet = await api.seedAgent({
      n: 5,
      stats: ranked(100, { decidedCount: 2 }),
      tickId: T2,
      status: 'no_decision',
    });
    const state = await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);

    const body = await league('?division=open');
    expect(body.state).toEqual(state);
    expect(body.state).toMatchObject({ tickId: T2, method: 'v1', rankedCount: 2, agentCount: 5 });
    expect(body.rows.map((row) => [row.agentId, row.rank, row.unrankedReason, row.lastStatus])).toEqual([
      [leader.id, 1, null, 'decided'],
      [second.id, 2, null, 'skipped'],
      // A paused agent keeps its record but not its rank, and has no status at the league's tick.
      [paused.id, null, 'inactive', null],
      [young.id, null, 'min_trading_days', 'decided'],
      [quiet.id, null, 'min_decisions', 'no_decision'],
    ]);
    expect(body.rows[0]).toMatchObject({
      name: leader.name,
      seasonReturnBps: 900,
      equityMicro: 10_900_000_000,
      tradingDays: 5,
    });
  });

  it('gives a ranked row no reason, and an unranked row the reason of its record at or after the league tick', async () => {
    // The league is as of T2. A newer round, T3, is being processed.
    await addTicks(api, T1, T2);
    const ranked1 = await api.seedAgent({ n: 1, stats: ranked(900), tickId: T2 });
    const young = await api.seedAgent({ n: 2, stats: ranked(500, { tradingDays: 4 }), tickId: T2 });
    const gone = await api.seedAgent({ n: 3, stats: ranked(100), tickId: T1 });
    const state = await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    expect(state.rankedCount).toBe(1);

    await api.store.createTick(makeTick(utc('2026-10-06T17:00:00.000Z')));
    api.setNow('2026-10-06T17:03:00.000Z');
    // Both got their row of the newer round. The ranked one fell below nothing; the young one is still young.
    const rowOf = (agent: typeof ranked1, stats: Partial<AgentStats>) =>
      api.store.writeDecision(makeRow({ agent, tickId: T3 }), { ...startingStats(), ...stats }, 0);
    expect(await rowOf(ranked1, ranked(950))).toBe(true);
    expect(await rowOf(young, ranked(520, { tradingDays: 4 }))).toBe(true);

    const body = await league();
    expect(body.state?.tickId).toBe(T2);
    expect(body.rows.map((row) => [row.agentId, row.rank, row.unrankedReason, row.lastStatus])).toEqual([
      // A stored rank always comes without a reason.
      [ranked1.id, 1, null, null],
      // Its latest row is after the league tick, so it is not "inactive": the true reason shows.
      [young.id, null, 'min_trading_days', null],
      [gone.id, null, 'inactive', null],
    ]);
    // `lastStatus` is only what happened at the league's tick. Those two rows are at a later one.
  });

  it('draws the sparkline from the daily values, oldest first', async () => {
    await addTicks(api, T2);
    const daily = [
      { day: '2026-10-05', equityMicro: 10_100_000_000 },
      { day: '2026-10-06', equityMicro: 10_684_000_000 },
    ];
    await api.seedAgent({ n: 1, stats: ranked(684, { daily, lastDay: '2026-10-06' }), tickId: T2 });
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    expect((await league()).rows[0]?.spark).toEqual([10_100_000_000, 10_684_000_000]);
  });

  it('gives every row its three largest holdings and its cash weight, as the agent page values them (section 17.2)', async () => {
    const at = utc('2026-10-06T15:00:00.000Z');
    const prices = { ...TEST_PRICES, NVDA: 200_000_000, MSFT: 400_000_000, AAPL: 100_000_000, SPY: 500_000_000 };
    await api.store.createTick(makeTick(at, { status: 'complete', snapshot: makeSnapshot(at, { prices }) }));
    const holder = await api.seedAgent({ n: 1 });
    const newcomer = await api.seedAgent({ n: 2 });
    // NVDA 2,000 USD, MSFT 2,200, AAPL 500, SPY 1,500 and 5,800 of cash: 12,000 USD in all.
    const portfolio = {
      cashMicro: 5_800_000_000,
      holdings: { NVDA: 10_000_000, MSFT: 5_500_000, AAPL: 5_000_000, SPY: 3_000_000 },
    };
    const row = makeRow({ agent: holder, tickId: T1, portfolio, equityMicro: 12_000_000_000 });
    expect(await api.store.writeDecision(row, { ...startingStats(), equityMicro: 12_000_000_000 }, 0)).toBe(true);

    const body = await league();
    const byId = new Map(body.rows.map((entry) => [entry.agentId, entry]));
    expect(byId.get(holder.id)?.topHoldings).toEqual([
      { symbol: 'MSFT', weightBps: 1_833 },
      { symbol: 'NVDA', weightBps: 1_666 },
      { symbol: 'SPY', weightBps: 1_250 },
    ]);
    expect(byId.get(holder.id)?.cashWeightBps).toBe(4_833);
    // Before its first row an agent holds cash only.
    expect(byId.get(newcomer.id)).toMatchObject({ topHoldings: [], cashWeightBps: 10_000 });

    // The card and the agent page never disagree.
    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${holder.id}`));
    expect(byId.get(holder.id)?.topHoldings).toEqual(
      page.holdings.slice(0, 3).map((entry) => ({ symbol: entry.symbol, weightBps: entry.weightBps })),
    );
    expect(byId.get(holder.id)?.cashWeightBps).toBe(page.cashWeightBps);
  });

  it('keeps the two divisions apart', async () => {
    await addTicks(api, T2);
    const open = await api.seedAgent({ n: 1, stats: ranked(100), tickId: T2 });
    const pro = await api.seedAgent({ n: 2, division: 'pro', stats: ranked(200), tickId: T2 });
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    await api.store.rerank(SEASON_1.id, 'pro', T2, NOW, SCORING_METHOD);
    expect((await league('?division=open')).rows.map((row) => row.agentId)).toEqual([open.id]);
    const proTable = await league('?division=pro');
    expect(proTable.division).toBe('pro');
    expect(proTable.rows.map((row) => [row.agentId, row.rank])).toEqual([[pro.id, 1]]);
  });

  it('agrees with scoring.rankAgents on a division with many ties', async () => {
    await addTicks(api, T1, T2);
    const rng = createRng(601);
    const inputs: RankInput[] = [];
    for (let n = 1; n <= 40; n += 1) {
      const stats: AgentStats = {
        ...startingStats(),
        seasonReturnBps: rng.int(-2, 2) * 100,
        maxDrawdownBps: rng.int(0, 2) * 50,
        tradeCount: rng.int(0, 2),
        tradingDays: rng.int(4, 6),
        decidedCount: rng.int(2, 4),
      };
      const atTick = rng.chance(0.75);
      const status = rng.pick<RowStatus>(['decided', 'no_decision', 'skipped']);
      const agent = await api.seedAgent({ n, stats, tickId: atTick ? T2 : T1, status });
      inputs.push({
        agentId: agent.id,
        name: agent.name,
        createdAt: agent.createdAt,
        stats,
        lastStatus: atTick ? status : null,
      });
    }
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    const expected = scoring.rankAgents(inputs);
    expect(rankingOf((await league()).rows)).toEqual(expected);
  });

  it('serves one page of 100 rows and says whether there is another', async () => {
    expect(LEAGUE_PAGE_SIZE).toBe(100);
    await addTicks(api, T2);
    for (let n = 1; n <= 101; n += 1) await api.seedAgent({ n, stats: ranked(10_000 - n), tickId: T2 });
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);

    const first = await league('?page=1');
    expect(first.rows).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.rows[0]?.rank).toBe(1);
    expect(first.rows[99]?.rank).toBe(100);
    const second = await league('?page=2');
    expect(second.page).toBe(2);
    expect(second.rows.map((row) => row.rank)).toEqual([101]);
    expect(second.hasMore).toBe(false);
    // The page is capped at the last page the open division can fill (section 15, last block).
    const third = await api.client().get('/api/league?page=3');
    expectError(third, 400, 'invalid_input');
  });

  it('does not say there is another page when a division has exactly 100 agents', async () => {
    for (let n = 1; n <= 100; n += 1) await api.seedAgent({ n });
    const body = await league();
    expect(body.rows).toHaveLength(100);
    expect(body.hasMore).toBe(false);
  });

  it('reports the round that is still being processed', async () => {
    await api.seedAgent({ n: 1 });
    await api.seedAgent({ n: 2 });
    await api.seedAgent({ n: 3, division: 'pro' });
    const at = utc('2026-10-06T15:00:00.000Z');
    api.setNow('2026-10-06T15:02:00.000Z');
    await api.store.createTick(makeTick(at, { daily: true }));
    expect((await league('?division=open')).round).toEqual({ tickId: '2026-10-06T15:00Z', pending: 2 });
    expect((await league('?division=pro')).round).toEqual({ tickId: '2026-10-06T15:00Z', pending: 1 });
    await api.store.completeTick('2026-10-06T15:00Z', api.now().toISOString());
    expect((await league()).round).toBeNull();
  });

  it('serves the table of a past season by id, and 404 for a season that does not exist', async () => {
    const body = await league(`?season=${SEASON_1.id}`);
    expect(body.season).toEqual(SEASON_1);
    expectError(await api.client().get(`/api/league?season=${testId('season', 9)}`), 404, 'not_found');
  });

  it('answers 404 when there is no season at all', async () => {
    const empty = createApi({ now: NOW, seasons: [] });
    expectError(await empty.client().get('/api/league'), 404, 'not_found');
    expectError(await empty.client().get('/api/league?division=pro'), 404, 'not_found');
    // A season that has not started yet is not one to show either.
    const early = createApi({ now: '2026-10-04T12:00:00.000Z' });
    expectError(await early.client().get('/api/league'), 404, 'not_found');
  });

  it('marks the season as ended once it is over, and keeps the table readable', async () => {
    await addTicks(api, T2);
    const agent = await api.seedAgent({ n: 1, stats: ranked(100), tickId: T2 });
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    api.setNow('2026-11-20T12:00:00.000Z');
    const body = await league();
    expect(body.seasonEnded).toBe(true);
    expect(body.season).toEqual(SEASON_1);
    expect(body.rows.map((row) => [row.agentId, row.rank])).toEqual([[agent.id, 1]]);
  });

  it.each([
    ['an unknown division', '?division=elite'],
    ['a page of zero', '?page=0'],
    ['a negative page', '?page=-1'],
    ['a page that is not a number', '?page=first'],
    ['a malformed season id', '?season=1'],
    ['a claimed rank', '?division=open&rank=1'],
    ['a claimed order', '?sort=name'],
    ['a claimed page size', '?limit=100000'],
    ['a claimed tier', '?tier=gold'],
  ])('refuses %s as invalid input', async (_why, query) => {
    expectError(await api.client().get(`/api/league${query}`), 400, 'invalid_input');
  });

  it('ignores what a request claims in its headers and cookies', async () => {
    await addTicks(api, T2);
    await api.seedAgent({ n: 1, stats: ranked(100), tickId: T2 });
    await api.seedAgent({ n: 2, stats: ranked(900), tickId: T2 });
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    const plain = await api.client().get('/api/league');
    const claiming = await api.client().get('/api/league', {
      headers: { 'X-Rank': '1', 'X-Tier': 'gold', 'X-Price-NVDA': '1', Cookie: 'rank=1; tier=gold; isAdmin=true' },
    });
    expect(claiming.json).toEqual(plain.json);
  });
});

describe('GET /api/agents/:id', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi({ now: NOW });
  });

  it('answers 404 for an agent that does not exist and for an id that is not an id', async () => {
    expectError(await api.client().get(`/api/agents/${testId('agent', 404)}`), 404, 'not_found');
    // Section 15: a malformed id in a path is 404, the same answer as for an unknown one.
    for (const id of ['1', 'AGENTAAAAAAB', 'agentaaaaaa1', 'agentaaaaaaab', "x'%20OR%201=1", '..%2F..%2Fme']) {
      expectError(await api.client().get(`/api/agents/${id}`), 404, 'not_found');
    }
  });

  it('values the holdings at the prices of the latest tick of the agent', async () => {
    const agent = await api.seedAgent({ n: 1 });
    const at = utc('2026-10-06T15:00:00.000Z');
    const prices = { ...TEST_PRICES, NVDA: 200_000_000, MSFT: 400_000_000 };
    await api.store.createTick(makeTick(at, { status: 'complete', snapshot: makeSnapshot(at, { prices }) }));
    // 10 NVDA at 200 USD = 2,000,000,000. 5.5 MSFT at 400 USD = 2,200,000,000. Cash 5,800,000,000.
    const portfolio = { cashMicro: 5_800_000_000, holdings: { NVDA: 10_000_000, MSFT: 5_500_000 } };
    const stats: AgentStats = {
      ...startingStats(),
      decidedCount: 1,
      tradingDays: 1,
      tradeCount: 2,
      lastDay: '2026-10-06',
      daily: [{ day: '2026-10-06', equityMicro: 10_000_000_000 }],
    };
    const row = {
      ...makeRow({
        agent,
        tickId: T1,
        portfolio,
        equityMicro: 10_000_000_000,
        fillCount: 2,
        // Written four minutes into the round, by a later step of the scheduler.
        createdAt: '2026-10-06T15:04:07.000Z',
      }),
      reason: 'Buys two large companies.',
      costMicro: 8_400_000,
    };
    expect(await api.store.writeDecision(row, stats, 0)).toBe(true);

    const reply = await api.client().get(`/api/agents/${agent.id}`);
    const page = expectShape(agentPublicSchema, reply);
    expectPublicCache(reply);
    expect(page.asOfTickId).toBe(T1);
    expect(page.cashMicro).toBe(5_800_000_000);
    expect(page.cashWeightBps).toBe(5_800);
    expect([...page.holdings].sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: 'MSFT', unitsMicro: 5_500_000, priceMicro: 400_000_000, valueMicro: 2_200_000_000, weightBps: 2_200 },
      { symbol: 'NVDA', unitsMicro: 10_000_000, priceMicro: 200_000_000, valueMicro: 2_000_000_000, weightBps: 2_000 },
    ]);
    expect(page.stats).toEqual(stats);
    expect(page.decisions).toEqual([
      {
        tickId: T1,
        // Section 15: `at` is the time the row was written, not the start of the tick.
        at: '2026-10-06T15:04:07.000Z',
        status: 'decided',
        code: null,
        reason: 'Buys two large companies.',
        fills: row.fills,
        halted: [],
        equityMicro: 10_000_000_000,
        costMicro: 8_400_000,
      },
    ]);
    expect(page.decisions[0]?.at).toBe(row.createdAt);
  });

  it('says a Pro agent has no model once its key is gone', async () => {
    const agent = await api.seedAgent({
      n: 1,
      division: 'pro',
      overrides: { modelKeyId: null, status: 'paused', pausedReason: 'key_removed' },
    });
    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${agent.id}`));
    expect(page.model).toEqual({ kind: 'none' });
    expect(page.status).toBe('paused');
  });

  it('takes rank, ranked count and method from the stored ranking', async () => {
    await addTicks(api, T1, T2);
    const leader = await api.seedAgent({ n: 1, stats: ranked(900), tickId: T2 });
    const second = await api.seedAgent({ n: 2, stats: ranked(300), tickId: T2 });
    const paused = await api.seedAgent({ n: 3, stats: ranked(5_000), tickId: T1 });
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    const page = async (id: string) => expectShape(agentPublicSchema, await api.client().get(`/api/agents/${id}`));
    expect(await page(leader.id)).toMatchObject({ rank: 1, unrankedReason: null, rankedCount: 2, method: 'v1' });
    expect(await page(second.id)).toMatchObject({ rank: 2, unrankedReason: null, rankedCount: 2 });
    expect(await page(paused.id)).toMatchObject({ rank: null, unrankedReason: 'inactive', rankedCount: 2 });
  });

  it('shows the newest 30 decisions, newest first, with the code of each failed or skipped one', async () => {
    const agent = await api.seedAgent({ n: 1 });
    const ids: string[] = [];
    // Five ticks a day, 15:00 to 19:00 UTC, over seven trading days: 35 rounds.
    for (const day of ['05', '06', '07', '08', '09', '12', '13']) {
      for (let hour = 15; hour <= 19; hour += 1) ids.push(`2026-10-${day}T${hour}:00Z`);
    }
    await addTicks(api, ...ids);
    api.setNow('2026-10-13T20:00:00.000Z');
    for (const [index, tickId] of ids.entries()) {
      const status: RowStatus = index % 3 === 0 ? 'decided' : index % 3 === 1 ? 'no_decision' : 'skipped';
      const code = status === 'decided' ? null : status === 'no_decision' ? 'provider_timeout' : 'changed_this_round';
      expect(await api.store.writeDecision(makeRow({ agent, tickId, status, code }), startingStats(), 0)).toBe(true);
    }
    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${agent.id}`));
    expect(page.decisions).toHaveLength(30);
    expect(page.decisions.map((decision) => decision.tickId)).toEqual([...ids].reverse().slice(0, 30));
    expect(page.asOfTickId).toBe(ids[ids.length - 1]);
    const newest = page.decisions[0];
    expect(newest).toMatchObject({ status: 'no_decision', code: 'provider_timeout', reason: null, fills: [] });
    expect(page.decisions[2]).toMatchObject({ status: 'skipped', code: 'changed_this_round', reason: null });
  });

  it('never shows the strategy time, the model label or the targets of a decision row', async () => {
    const agent = await api.seedAgent({ n: 1, overrides: { strategyChangedAt: '2026-10-05T11:22:33.000Z' } });
    await addTicks(api, T1);
    const row = {
      ...makeRow({ agent, tickId: T1, model: 'house:label-marker' }),
      targetsBps: { NVDA: 2_100 },
    };
    expect(row.strategyAt).toBe('2026-10-05T11:22:33.000Z');
    expect(await api.store.writeDecision(row, startingStats(), 0)).toBe(true);
    const reply = await api.client().get(`/api/agents/${agent.id}`);
    expectShape(agentPublicSchema, reply);
    expect(reply.text).not.toContain('2026-10-05T11:22:33.000Z');
    expect(reply.text).not.toContain('label-marker');
    expect(reply.text).not.toContain('targetsBps');
    expect(reply.text).not.toContain(agent.prompt);
    expect(reply.text).not.toContain(agent.owner);
  });

  it('serves the agent of a season that has ended', async () => {
    const agent = await api.seedAgent({ n: 1 });
    api.setNow('2026-11-20T12:00:00.000Z');
    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${agent.id}`));
    expect(page.season).toEqual(SEASON_1);
  });

  it('shows a published prompt and keeps a private one private', async () => {
    const open = await api.seedAgent({ n: 1, overrides: { promptPublic: true, prompt: `${PROMPT} Published.` } });
    const closed = await api.seedAgent({ n: 2 });
    expect((await api.client().get(`/api/agents/${open.id}`)).json.prompt).toBe(`${PROMPT} Published.`);
    const reply = await api.client().get(`/api/agents/${closed.id}`);
    expect(reply.json.prompt).toBeNull();
    expect(reply.text).not.toContain(closed.prompt);
  });

  it('returns a summary written by a model as plain text, exactly as stored', async () => {
    const summary = 'Buys <img src=x onerror=alert(1)> leaders & holds.';
    const agent = await api.seedAgent({ n: 1, overrides: { summary, summaryStatus: 'ready' } });
    const reply = await api.client().get(`/api/agents/${agent.id}`);
    expect(reply.json.summary).toBe(summary);
    expect(reply.headers.get('Content-Type') ?? '').toContain('application/json');
  });
});
