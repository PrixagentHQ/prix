import type { AgentRecord, RankInput } from '@prix/contracts';
import { agentPublicSchema, leagueResponseSchema, marketResponseSchema, meResponseSchema } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Api, Client } from '../support/api.ts';
import { createApi, expectNoSecret, expectShape, rankingOf, TEST_API_KEY } from '../support/api.ts';
import { testWallet } from '../support/eth.ts';
import { createTestVault, decisionJson } from '../support/fakes.ts';
import { SEASON_1, TEST_PRICES } from '../support/fixtures.ts';
import { createMemoryStore } from '../support/memory-store.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, DEFAULT_SUMMARY, expectReplayMatches } from '../support/scheduler.ts';

/**
 * The first line of the acceptance list, docs/SPEC.md section 8: "The path from sign-in to
 * a ranked agent works." Here it runs end to end in memory: the HTTP API and the scheduler
 * share one store, a stranger signs in and builds an agent, and five trading days pass.
 * docs/CONTRACTS.md section 9 names this test as the proof of the ranked half of that line.
 */
describe('from sign-in to a ranked agent, over five simulated trading days', () => {
  const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  const HOURS = [15, 16, 17, 18, 19];
  const openPrompt =
    'Strategy marker-501-end: put two fifths of the portfolio into the strongest chip maker and keep the rest in cash.';
  const proPrompt = 'Strategy marker-502-end: hold two large companies in equal parts and change the portfolio rarely.';

  let api: Api;
  let world: World;
  let owner: Client;
  let proOwner: Client;
  let openAgent: AgentRecord;
  let proAgent: AgentRecord;
  let rivals: AgentRecord[];
  let thursdayLeague: ReturnType<typeof leagueResponseSchema.parse>;

  const stored = async (id: string): Promise<AgentRecord> => {
    const agent = await api.store.getAgent(id);
    if (!agent) throw new Error('the agent is gone');
    return agent;
  };

  beforeAll(async () => {
    const store = createMemoryStore([SEASON_1]);
    const vault = createTestVault();
    api = createApi({ store, vault, now: '2026-10-05T12:00:00.000Z' });
    world = createWorld({ store, vault });

    // Monday noon: two strangers sign in and build their agents through the API.
    owner = await api.signedIn(testWallet(51));
    const created = await owner.post('/api/agents', { name: 'First Light', prompt: openPrompt, division: 'open' });
    expect(created.status, created.text).toBe(201);
    proOwner = await api.signedIn(testWallet(52));
    const key = await proOwner.post('/api/model-keys', {
      provider: 'openai',
      model: 'model-test-1',
      apiKey: TEST_API_KEY,
    });
    expect(key.status, key.text).toBe(201);
    const createdPro = await proOwner.post('/api/agents', {
      name: 'Own Engine',
      prompt: proPrompt,
      division: 'pro',
      modelKeyId: key.json.modelKey.id,
    });
    expect(createdPro.status, createdPro.text).toBe(201);
    openAgent = await stored(created.json.agent.id);
    proAgent = await stored(createdPro.json.agent.id);

    // Three more Open agents are already in the league.
    rivals = [await world.addOpen(11), await world.addOpen(12), await world.addOpen(13)];
    world.answers.set(501, decisionJson({ NVDA: 40 }, 'Holds the strongest chip maker.'));
    world.answers.set(502, decisionJson({ NVDA: 20, MSFT: 20 }, 'Holds two large companies.'));
    world.answers.set(11, decisionJson({ MSFT: 40 }, 'Holds one software company.'));
    world.answers.set(12, decisionJson({}, 'Stays in cash.'));
    world.answers.set(13, 'I am not sure what to do today.');

    for (const [index, day] of DAYS.entries()) {
      // NVDA gains 1% a day and MSFT loses half a percent, far from the 30% of a hold.
      world.feed.prices = {
        ...TEST_PRICES,
        NVDA: Math.round((TEST_PRICES.NVDA as number) * 1.01 ** index),
        MSFT: Math.round((TEST_PRICES.MSFT as number) * 0.995 ** index),
      };
      await world.step(`${day}T14:30:05.000Z`);
      for (const hour of HOURS) await world.runTick(`${day}T${hour}:00:05.000Z`);
      if (index === 3) {
        api.setNow(`${day}T20:00:00.000Z`);
        thursdayLeague = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open'));
      }
    }
    api.setNow('2026-10-09T20:00:00.000Z');
  });

  it('shows the agent without a rank, with the reason, until it has five trading days', () => {
    const row = thursdayLeague.rows.find((entry) => entry.agentId === openAgent.id);
    expect(row).toMatchObject({
      rank: null,
      unrankedReason: 'min_trading_days',
      tradingDays: 4,
      lastStatus: 'decided',
    });
    expect(thursdayLeague.state).toMatchObject({ tickId: '2026-10-08T15:00Z', rankedCount: 0 });
  });

  it('ranks the agent on the public league after five trading days', async () => {
    const reply = await api.client().get('/api/league?division=open');
    const league = expectShape(leagueResponseSchema, reply);
    expect(league.state).toMatchObject({ tickId: '2026-10-09T15:00Z', method: 'v1', rankedCount: 3, agentCount: 4 });
    expect(league.seasonEnded).toBe(false);
    expect(league.round).toBeNull();

    const [first, second, third, fourth] = league.rows;
    // NVDA rose all week, so the agent that held it leads. Cash is second, the falling stock third.
    expect(first).toMatchObject({
      agentId: openAgent.id,
      name: 'First Light',
      rank: 1,
      unrankedReason: null,
      tradingDays: 5,
      lastStatus: 'decided',
    });
    expect(first?.seasonReturnBps).toBeGreaterThan(0);
    expect(first?.spark).toHaveLength(5);
    expect(second).toMatchObject({ agentId: rivals[1]?.id, rank: 2, seasonReturnBps: 0, tradeCount: 0 });
    expect(third).toMatchObject({ agentId: rivals[0]?.id, rank: 3 });
    expect(third?.seasonReturnBps).toBeLessThan(0);
    // The agent whose model never answered properly has five days and no decision.
    expect(fourth).toMatchObject({
      agentId: rivals[2]?.id,
      rank: null,
      unrankedReason: 'min_decisions',
      lastStatus: 'no_decision',
      seasonReturnBps: 0,
    });
  });

  it('orders the league exactly as the reference ranking does', async () => {
    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open'));
    const inputs: RankInput[] = [];
    for (const agent of [openAgent, ...rivals]) {
      const standing = await api.store.getStanding(agent.id, SEASON_1.id);
      if (!standing) throw new Error('no standing');
      inputs.push({
        agentId: agent.id,
        name: agent.name,
        createdAt: agent.createdAt,
        stats: standing.stats,
        lastStatus: standing.lastTickId === league.state?.tickId ? standing.lastStatus : null,
      });
    }
    expect(rankingOf(league.rows)).toEqual(scoring.rankAgents(inputs));
  });

  it('shows the record of the agent on its public page', async () => {
    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${openAgent.id}`));
    expect(page).toMatchObject({
      name: 'First Light',
      division: 'open',
      model: { kind: 'house' },
      rank: 1,
      unrankedReason: null,
      rankedCount: 3,
      method: 'v1',
      asOfTickId: '2026-10-09T15:00Z',
      prompt: null,
      summary: DEFAULT_SUMMARY,
      summaryStatus: 'ready',
    });
    expect(page.stats).toMatchObject({
      decidedCount: 5,
      noDecisionCount: 0,
      skippedCount: 0,
      tradingDays: 5,
      lastDay: '2026-10-09',
    });
    expect(page.decisions.map((decision) => decision.tickId)).toEqual(
      [...DAYS].reverse().map((day) => `${day}T15:00Z`),
    );
    expect(
      page.decisions.every(
        (decision) => decision.status === 'decided' && decision.reason === 'Holds the strongest chip maker.',
      ),
    ).toBe(true);
    expect(page.holdings.map((holding) => holding.symbol)).toEqual(['NVDA']);
    expect(page.holdings[0]?.priceMicro).toBe(world.feed.prices.NVDA);
    // Cash and holdings add up to the whole portfolio.
    const total = page.cashMicro + page.holdings.reduce((sum, holding) => sum + holding.valueMicro, 0);
    expect(total).toBe(page.stats.equityMicro);
    expect(page.cashWeightBps + (page.holdings[0]?.weightBps ?? 0)).toBeGreaterThanOrEqual(9_999);
    expect(page.cashWeightBps + (page.holdings[0]?.weightBps ?? 0)).toBeLessThanOrEqual(10_001);
  });

  it('shows the owner the latest decision on the account page', async () => {
    const me = expectShape(meResponseSchema, await owner.get('/api/me'));
    expect(me.agent).toMatchObject({
      id: openAgent.id,
      prompt: openPrompt,
      summary: DEFAULT_SUMMARY,
      summaryStatus: 'ready',
    });
    expect(me.agent?.lastDecision).toMatchObject({ tickId: '2026-10-09T15:00Z', status: 'decided' });
  });

  it('ranks the Pro agent too, on the key of its owner, and never shows that key', async () => {
    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=pro'));
    expect(league.state).toMatchObject({ tickId: '2026-10-09T19:00Z', rankedCount: 1, agentCount: 1 });
    expect(league.rows).toHaveLength(1);
    expect(league.rows[0]).toMatchObject({ agentId: proAgent.id, rank: 1, tradingDays: 5 });

    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${proAgent.id}`));
    expect(page.model).toEqual({ kind: 'own', providerLabel: 'OpenAI', model: 'model-test-1' });
    expect(page.stats.decidedCount).toBe(25);
    expect(page.decisions).toHaveLength(25);
    expect(page.decisions[0]?.tickId).toBe('2026-10-09T19:00Z');

    // The scheduler opened the key the API had sealed, and used it for this agent only.
    expect(world.own.built.length).toBe(25);
    expect(world.own.built.every((built) => built.apiKey === TEST_API_KEY && built.keyId === proAgent.modelKeyId)).toBe(
      true,
    );
    await owner.get('/api/me');
    await proOwner.get('/api/me');
    expectNoSecret(api.transcript.join('\n'), [TEST_API_KEY], 'a response');
    expectNoSecret(world.log.text(), [TEST_API_KEY], 'the log');
    expectNoSecret(api.store.dump(), [TEST_API_KEY], 'the database');
  });

  it('reports an open market as of the last tick', async () => {
    const body = expectShape(marketResponseSchema, await api.client().get('/api/market'));
    expect(body.market).toMatchObject({ open: true, closedReason: null, lastTickId: '2026-10-09T19:00Z' });
    expect(body.season).toEqual(SEASON_1);
  });

  it('keeps records that replaying the stored decisions reproduces exactly', async () => {
    for (const agent of [openAgent, proAgent, ...rivals]) await expectReplayMatches(world, agent);
  });

  it('gave the model the strategy of the owner, word for word, and never the prompt of another agent', () => {
    const calls = world.decisionCalls.filter((call) => call.n === 501);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      const user = call.request.messages.find((message) => message.role === 'user');
      expect(JSON.parse(user?.content ?? '{}').strategy).toBe(openPrompt);
      expect(JSON.stringify(call.request.messages)).not.toContain('marker-502-end');
    }
  });

  it('takes the agent off the ranking when its owner pauses it', async () => {
    // Monday morning, an hour before the session of the owner runs out.
    api.setNow('2026-10-12T11:00:00.000Z');
    expect((await owner.patch(`/api/agents/${openAgent.id}`, { paused: true })).status).toBe(200);
    for (const hour of [15, 16, 17]) await world.runTick(`2026-10-12T${hour}:00:05.000Z`);
    api.setNow('2026-10-12T16:00:00.000Z');
    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open'));
    const row = league.rows.find((entry) => entry.agentId === openAgent.id);
    // It keeps its record and loses its rank: pausing cannot hold a place.
    expect(row).toMatchObject({ rank: null, unrankedReason: 'inactive', lastStatus: null, tradingDays: 5 });
    expect(league.rows[0]).toMatchObject({ agentId: rivals[1]?.id, rank: 1 });
    expect(league.state).toMatchObject({ tickId: '2026-10-12T15:00Z', rankedCount: 2 });
  });
});
