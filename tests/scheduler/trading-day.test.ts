import type { AgentRecord } from '@prix/contracts';
import {
  isoTimeSchema,
  leagueStateSchema,
  marketStatusSchema,
  OPEN_DAILY_TICK_HOUR_UTC,
  TICK_CREATE_WINDOW_MINUTES,
} from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectNoSecret } from '../support/api.ts';
import { SEASON_1, TEST_PRICES, TEST_SYMBOLS } from '../support/fixtures.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, DEFAULT_REASON, expectReplayMatches, proApiKey } from '../support/scheduler.ts';

/**
 * Acceptance, docs/SPEC.md section 8: "A full trading day runs unattended: ticks fire,
 * decisions validate, portfolios update, the league reorders, and nothing exceeds a Worker
 * limit." One step runs for every minute of Tuesday 2026-10-06, as the Cron Trigger would.
 */
describe('a whole trading day, one step a minute', () => {
  const DAY = '2026-10-06';
  const HOURS = [15, 16, 17, 18, 19];
  const tickId = (hour: number) => `${DAY}T${hour}:00Z`;

  let world: World;
  let pro: AgentRecord[];
  let open: AgentRecord[];
  let paused: AgentRecord;
  let hidden: AgentRecord;

  beforeAll(async () => {
    world = createWorld();
    pro = [await world.addPro(1), await world.addPro(2), await world.addPro(3)];
    open = [];
    for (let n = 11; n <= 17; n += 1) open.push(await world.addOpen(n));
    paused = await world.addOpen(21, { overrides: { status: 'paused', pausedReason: 'owner' } });
    hidden = await world.addOpen(22, { overrides: { hidden: true, status: 'paused', pausedReason: 'admin' } });

    // Prices drift a little every hour, far below the 30% that would put a symbol on hold.
    const drift = (hour: number, index: number) => 1 + ((hour * 7 + index * 3) % 11) / 1_000 - 0.005;
    for (let minute = 14 * 60 + 55; minute <= 20 * 60 + 5; minute += 1) {
      const hour = Math.floor(minute / 60);
      world.feed.prices = Object.fromEntries(
        TEST_SYMBOLS.map((symbol, index) => [symbol, Math.round((TEST_PRICES[symbol] as number) * drift(hour, index))]),
      );
      const at = `${DAY}T${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:07.000Z`;
      await world.step(at);
    }
  });

  it('never throws and always returns a report', () => {
    expect(world.reports).toHaveLength(20 * 60 + 5 - (14 * 60 + 55) + 1);
  });

  it('creates one tick for every hour from 15 to 19 UTC, and none outside', async () => {
    expect([...world.store.ticks.keys()].sort()).toEqual(HOURS.map(tickId));
    expect(
      world.reports.filter((entry) => entry.report.action === 'tick_created').map((entry) => entry.report.tickId),
    ).toEqual(HOURS.map(tickId));
    const outside = world.reports.filter((entry) => entry.at < `${DAY}T15:00` || entry.at >= `${DAY}T20:00`);
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((entry) => entry.report.action === 'idle')).toBe(true);
  });

  it('creates every tick in the first minutes of its hour, from one market snapshot', () => {
    for (const tick of world.store.ticks.values()) {
      expect(tick.seasonId).toBe(SEASON_1.id);
      expect(new Date(tick.createdAt).getUTCMinutes()).toBeLessThan(TICK_CREATE_WINDOW_MINUTES);
      expect(tick.snapshot.open).toBe(true);
      expect(tick.snapshot.prices.map((point) => point.symbol)).toEqual(TEST_SYMBOLS);
      expect(world.market.calls).toContain(tick.snapshot.takenAt);
    }
  });

  it('completes every tick within its own hour', () => {
    expect(
      world.reports.filter((entry) => entry.report.action === 'tick_completed').map((entry) => entry.report.tickId),
    ).toEqual(HOURS.map(tickId));
    for (const tick of world.store.ticks.values()) {
      expect(tick.status).toBe('complete');
      expect(isoTimeSchema.safeParse(tick.completedAt).success).toBe(true);
      expect((tick.completedAt as string).slice(0, 13)).toBe(tick.id.slice(0, 13));
    }
  });

  it('makes exactly one tick of the day the daily tick: the first at or after 15 UTC', () => {
    expect(OPEN_DAILY_TICK_HOUR_UTC).toBe(15);
    const daily = [...world.store.ticks.values()].filter((tick) => tick.daily).map((tick) => tick.id);
    expect(daily).toEqual([tickId(15)]);
  });

  it('asks every Pro agent at every tick, with the model of its owner', async () => {
    for (const agent of pro) {
      const rows = await world.rows(agent);
      expect(rows.map((row) => row.tickId)).toEqual(HOURS.map(tickId));
      expect(rows.every((row) => row.status === 'decided' && row.division === 'pro')).toBe(true);
    }
    expect(world.decisionCalls.filter((call) => call.division === 'pro')).toHaveLength(15);
  });

  it('asks every Open agent once, at the daily tick, with the house model', async () => {
    for (const agent of open) {
      const rows = await world.rows(agent);
      expect(rows.map((row) => [row.tickId, row.status, row.division, row.model])).toEqual([
        [tickId(15), 'decided', 'open', 'house'],
      ]);
    }
    expect(
      world.decisionCalls
        .filter((call) => call.division === 'open')
        .map((call) => call.n)
        .sort(),
    ).toEqual([11, 12, 13, 14, 15, 16, 17]);
  });

  it('gives a paused agent and a hidden agent no rows', async () => {
    expect(await world.rows(paused)).toEqual([]);
    expect(await world.rows(hidden)).toEqual([]);
    expect(world.decisionCalls.some((call) => call.n === 21 || call.n === 22)).toBe(false);
  });

  it('records what was asked and what was answered in every row', async () => {
    const agent = pro[0] as AgentRecord;
    const first = world.row(agent, tickId(15));
    expect(first).toMatchObject({
      agentId: agent.id,
      seasonId: SEASON_1.id,
      division: 'pro',
      status: 'decided',
      code: null,
      targetsBps: { NVDA: 2_000, MSFT: 2_000 },
      reason: DEFAULT_REASON,
      halted: [],
      model: 'openai:model-1',
      strategyAt: agent.strategyChangedAt,
    });
    expect(first.fills.map((fill) => [fill.symbol, fill.side])).toEqual([
      ['MSFT', 'buy'],
      ['NVDA', 'buy'],
    ]);
    expect(first.createdAt.slice(0, 13)).toBe(`${DAY}T15`);
  });

  it('fills every trade at the reference price of the tick, and at no other price', async () => {
    for (const agent of [...pro, ...open]) {
      for (const row of await world.rows(agent)) {
        const tick = world.store.ticks.get(row.tickId);
        for (const fill of row.fills) {
          const point = tick?.snapshot.prices.find((entry) => entry.symbol === fill.symbol);
          expect(fill.priceMicro).toBe(point?.priceMicro);
        }
      }
    }
  });

  it('keeps a record that replaying the stored decisions reproduces exactly', async () => {
    for (const agent of [...pro, ...open]) await expectReplayMatches(world, agent);
  });

  it('updates the stats of every agent from its rows', async () => {
    for (const agent of pro) {
      const stats = await world.stats(agent);
      expect(stats).toMatchObject({
        decidedCount: 5,
        noDecisionCount: 0,
        skippedCount: 0,
        tradingDays: 1,
        lastDay: DAY,
      });
      expect(stats.daily).toHaveLength(1);
      expect(stats.tradeCount).toBeGreaterThanOrEqual(2);
    }
    for (const agent of open) {
      expect(await world.stats(agent)).toMatchObject({ decidedCount: 1, tradingDays: 1, tradeCount: 2, lastDay: DAY });
    }
  });

  it('publishes the league of each division as of its last tick', async () => {
    const proState = await world.store.getLeagueState(SEASON_1.id, 'pro');
    const openState = await world.store.getLeagueState(SEASON_1.id, 'open');
    expect(leagueStateSchema.safeParse(proState).success).toBe(true);
    expect(proState).toMatchObject({ tickId: tickId(19), method: 'v1', agentCount: 3, rankedCount: 0 });
    // The Open table is as of the daily tick. The paused agent is on it, the hidden one is not.
    expect(openState).toMatchObject({ tickId: tickId(15), method: 'v1', agentCount: 8, rankedCount: 0 });
  });

  it('reorders the league as the portfolios move', async () => {
    const table = await world.store.listStandings(SEASON_1.id, 'pro', 100, 0);
    expect(table.map((row) => row.agentId).sort()).toEqual(pro.map((agent) => agent.id).sort());
    const returns = table.map((row) => row.stats.seasonReturnBps);
    expect(returns).toEqual([...returns].sort((a, b) => b - a));
    expect(table.every((row) => row.lastTickId === tickId(19) && row.lastStatus === 'decided')).toBe(true);
  });

  it('leaves the market status open, as of the last tick', async () => {
    const status = await world.store.getMarketStatus();
    expect(marketStatusSchema.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({ open: true, closedReason: null, lastTickId: tickId(19), halted: [] });
  });

  it('stays inside the Worker limits in every step', () => {
    // Six outgoing connections: at most five model calls at a time, and five per step.
    expect(world.peak.concurrentModelCalls).toBeLessThanOrEqual(5);
    expect(world.peak.modelCallsInStep).toBeLessThanOrEqual(world.limits.maxDecisionsPerStep);
    // Fifty D1 queries per invocation, and every Store method is at least one.
    expect(world.peak.storeCallsInStep).toBeLessThanOrEqual(50);
    for (const entry of world.reports) {
      expect(entry.report.decided + entry.report.noDecision).toBeLessThanOrEqual(world.limits.maxDecisionsPerStep);
    }
  });

  it('really runs model calls of one step at the same time', () => {
    expect(world.peak.concurrentModelCalls).toBeGreaterThan(1);
  });

  it('calls each model with the limits it was given', () => {
    expect(world.decisionCalls.length).toBe(22);
    for (const call of world.decisionCalls) {
      expect(call.request.maxOutputTokens).toBe(
        call.division === 'pro' ? world.limits.ownMaxOutputTokens : world.limits.maxOutputTokens,
      );
      expect(call.request.timeoutMs).toBe(world.limits.modelTimeoutMs);
      expect(call.request.jsonDecision).toBe(true);
    }
  });

  it('opens a key at the moment of use, and only for the agent that owns it', () => {
    expect(world.own.built).toHaveLength(15);
    for (const built of world.own.built) {
      const n = Number(built.model.replace('model-', ''));
      expect(built.apiKey).toBe(proApiKey(n));
      expect(built.provider).toBe('openai');
    }
    expect(world.vault.opened).toHaveLength(15);
  });

  it('counts the neurons of the house model for the day', async () => {
    // Seven decisions of 1,600 input and 120 output tokens:
    // 7 * (1,600 * 26,668 + 120 * 204,805) / 1,000,000 = 7 * 67.25 = 470.7 neurons, a call rounded up.
    const neurons = await world.store.getAiNeurons(DAY, 'decision');
    expect(neurons).toBeGreaterThanOrEqual(470);
    expect(neurons).toBeLessThanOrEqual(476);
  });

  it('never logs a key, a prompt or what a model said', () => {
    const text = world.log.text();
    expectNoSecret(text, [1, 2, 3].map(proApiKey), 'the log');
    for (const agent of [...pro, ...open]) expect(text).not.toContain(agent.prompt);
    expect(text).not.toContain(DEFAULT_REASON);
    expect(text).not.toContain('"targets"');
    expect(text).not.toContain('marker-');
  });

  it('never stores a key in the clear', () => {
    expectNoSecret(world.store.dump(), [1, 2, 3].map(proApiKey), 'the database');
  });
});
