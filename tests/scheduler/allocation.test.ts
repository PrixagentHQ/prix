import type { AgentRecord, ModelResponse } from '@prix/contracts';
import { HOUSE_NEURONS_PER_DAY, TICK_WINDOW_MINUTES } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { modelText } from '../support/fakes.ts';
import { SEASON_1, startingPortfolio, startingStats } from '../support/fixtures.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, expectReplayMatches } from '../support/scheduler.ts';

/**
 * The free allocation of the house model (docs/CONTRACTS.md sections 2 and 10): when it is
 * used up, the remaining Open agents skip the day, and the next day they come first. And the
 * two time windows after which an agent that was not reached is skipped.
 */

const DAY = '2026-10-06';
const T15 = `${DAY}T15:00Z`;
const START = `${DAY}T15:00:05.000Z`;
const exhausted: ModelResponse = { ok: false, code: 'allocation_exhausted', httpStatus: 429 };

async function addOpenAgents(world: World, count: number, first = 1): Promise<AgentRecord[]> {
  const agents: AgentRecord[] = [];
  for (let n = first; n < first + count; n += 1) agents.push(await world.addOpen(n));
  return agents;
}

describe('an exhausted allocation', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  it('skips every Open agent, without a model call, when the count of the day has reached the limit', async () => {
    expect(HOUSE_NEURONS_PER_DAY).toBe(9_000);
    const agents = await addOpenAgents(world, 4);
    await world.store.addAiNeurons(DAY, 'decision', HOUSE_NEURONS_PER_DAY);
    const tick = await world.runTick(START);
    expect(tick.status).toBe('complete');
    expect(world.decisionCalls).toHaveLength(0);
    for (const agent of agents) {
      expect(world.row(agent, T15)).toMatchObject({
        status: 'skipped',
        code: 'allocation_exhausted',
        targetsBps: null,
        reason: null,
        fills: [],
        costMicro: 0,
        portfolio: startingPortfolio(),
        equityMicro: 10_000_000_000,
        model: null,
        strategyAt: null,
      });
      expect(await world.stats(agent)).toEqual({
        ...startingStats(),
        skippedCount: 1,
        tradingDays: 1,
        lastDay: DAY,
        daily: [{ day: DAY, equityMicro: 10_000_000_000 }],
      });
      await expectReplayMatches(world, agent);
    }
    expect(await world.store.getAiNeurons(DAY, 'decision')).toBe(HOUSE_NEURONS_PER_DAY);
  });

  it('does not skip a Pro agent: the model of an owner has nothing to do with the house allocation', async () => {
    const pro = await world.addPro(1);
    const open = await world.addOpen(11);
    await world.store.addAiNeurons(DAY, 'decision', HOUSE_NEURONS_PER_DAY + 500);
    await world.runTick(START);
    expect(world.row(pro, T15).status).toBe('decided');
    expect(world.row(open, T15)).toMatchObject({ status: 'skipped', code: 'allocation_exhausted' });
  });

  it('writes at most ten skipped rows in one step', async () => {
    const agents = await addOpenAgents(world, 23);
    await world.store.addAiNeurons(DAY, 'decision', HOUSE_NEURONS_PER_DAY);
    await world.runTick(START);
    for (const entry of world.reports) expect(entry.report.skipped).toBeLessThanOrEqual(world.limits.maxSkipsPerStep);
    expect(world.reports.reduce((sum, entry) => sum + entry.report.skipped, 0)).toBe(23);
    expect(world.peak.storeCallsInStep).toBeLessThanOrEqual(50);
    for (const agent of agents) expect(world.row(agent, T15).code).toBe('allocation_exhausted');
  });

  it('skips the agents that are left when the count reaches the limit during the tick', async () => {
    // A small limit: one decision of 1,600 input and 120 output tokens counts about 11 neurons.
    world = createWorld({ limits: { houseNeuronsPerDay: 30 } });
    const agents = await addOpenAgents(world, 12);
    await world.runTick(START);
    const rows = agents.map((agent) => world.row(agent, T15));
    const decided = rows.filter((row) => row.status === 'decided');
    const skipped = rows.filter((row) => row.status === 'skipped');
    expect(decided.length + skipped.length).toBe(12);
    // The first step asks five agents (about 55 neurons). After it the count is over 30.
    expect(decided).toHaveLength(5);
    expect(skipped.every((row) => row.code === 'allocation_exhausted')).toBe(true);
    expect(world.decisionCalls).toHaveLength(5);
    expect(await world.store.getAiNeurons(DAY, 'decision')).toBeGreaterThanOrEqual(30);
  });

  it('charges the exact neurons the provider reports, and falls back to the token prices without them', async () => {
    await addOpenAgents(world, 2);
    const reason = '{"targets":{},"reason":"Stays in cash."}';
    world.answers.set(1, { ok: true, text: reason, inputTokens: 1_600, outputTokens: 120, neurons: 123 });
    // 1,600 tokens would cost 42.7 neurons: the reported figure wins, not the tokens.
    world.answers.set(2, { ok: true, text: reason, inputTokens: null, outputTokens: null, neurons: 7 });
    await world.runTick(START);
    expect(await world.store.getAiNeurons(DAY, 'decision')).toBe(130);
  });

  it('counts neurons from the token counts of each call', async () => {
    await addOpenAgents(world, 3);
    world.answers.set(1, modelText('{"targets":{},"reason":"Stays in cash."}', 1_000_000, 0));
    world.answers.set(2, modelText('{"targets":{},"reason":"Stays in cash."}', 0, 100_000));
    world.answers.set(3, modelText('{"targets":{},"reason":"Stays in cash."}', 2_000, 200));
    await world.runTick(START);
    // 26,668 for a million input tokens, 20,480.5 for 100,000 output tokens, and
    // 2,000 * 26,668 / 1e6 + 200 * 204,805 / 1e6 = 53.34 + 40.96 = 94.3 for the third call.
    const neurons = await world.store.getAiNeurons(DAY, 'decision');
    expect(neurons).toBeGreaterThanOrEqual(26_668 + 20_480 + 94);
    expect(neurons).toBeLessThanOrEqual(26_668 + 20_481 + 95);
  });

  it('skips the agents that are left when the house model says the allocation is used up', async () => {
    const agents = await addOpenAgents(world, 8);
    for (let n = 1; n <= 8; n += 1) world.answers.set(n, exhausted);
    const tick = await world.runTick(START);
    expect(tick.status).toBe('complete');
    for (const agent of agents) {
      const row = world.row(agent, T15);
      // Not "no decision": the agent was not at fault and its page says it skipped the day.
      expect(row).toMatchObject({
        status: 'skipped',
        code: 'allocation_exhausted',
        portfolio: startingPortfolio(),
        fills: [],
      });
    }
    // Every agent was asked at most once.
    expect(world.decisionCalls.length).toBeLessThanOrEqual(8);
    expect(new Set(world.decisionCalls.map((call) => call.n)).size).toBe(world.decisionCalls.length);
  });

  it('asks the agents that were skipped yesterday first today', async () => {
    world = createWorld({ limits: { houseNeuronsPerDay: 30 } });
    const agents = await addOpenAgents(world, 9);
    await world.runTick(START);
    const skippedYesterday = agents.filter((agent) => world.row(agent, T15).status === 'skipped');
    expect(skippedYesterday).toHaveLength(4);

    // The next day starts with a fresh count.
    world.decisionCalls.length = 0;
    await world.runTick('2026-10-07T15:00:05.000Z');
    const today = '2026-10-07T15:00Z';
    const decidedToday = agents.filter((agent) => world.row(agent, today).status === 'decided');
    expect(decidedToday).toHaveLength(5);
    // All four that were skipped yesterday are among the five that are asked today.
    for (const agent of skippedYesterday) expect(decidedToday.map((item) => item.id)).toContain(agent.id);
    // So nobody is skipped two days in a row while others decide twice.
    for (const agent of agents) {
      const stats = await world.stats(agent);
      expect(stats.decidedCount).toBeGreaterThanOrEqual(1);
      expect(stats.tradingDays).toBe(2);
    }
  });

  it('starts every UTC day with a fresh count', async () => {
    const agents = await addOpenAgents(world, 2);
    await world.store.addAiNeurons(DAY, 'decision', HOUSE_NEURONS_PER_DAY);
    await world.runTick(START);
    await world.runTick('2026-10-07T15:00:05.000Z');
    for (const agent of agents) {
      expect((await world.rows(agent)).map((row) => row.status)).toEqual(['skipped', 'decided']);
    }
    expect(await world.store.getAiNeurons('2026-10-07', 'decision')).toBeGreaterThan(0);
  });

  it('ranks the division after a tick of skipped rows: a skipped row is still a row', async () => {
    await addOpenAgents(world, 3);
    await world.store.addAiNeurons(DAY, 'decision', HOUSE_NEURONS_PER_DAY);
    await world.runTick(START);
    expect(await world.store.getLeagueState(SEASON_1.id, 'open')).toMatchObject({ tickId: T15, agentCount: 3 });
    const table = await world.store.listStandings(SEASON_1.id, 'open', 10, 0);
    expect(table.every((row) => row.lastTickId === T15 && row.lastStatus === 'skipped')).toBe(true);
  });
});

describe('agents that a tick does not reach', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  it('skips pending Pro agents once 50 minutes of the hour have passed', async () => {
    expect(TICK_WINDOW_MINUTES).toBe(50);
    const agents: AgentRecord[] = [];
    for (let n = 1; n <= 8; n += 1) agents.push(await world.addPro(n));
    expect((await world.step(`${DAY}T15:00:05.000Z`)).action).toBe('tick_created');
    // The Cron Trigger was down until 15:51.
    await world.run(`${DAY}T15:51:05.000Z`, `${DAY}T15:58:05.000Z`);
    expect((await world.store.getTick(T15))?.status).toBe('complete');
    expect(world.decisionCalls).toHaveLength(0);
    for (const agent of agents) {
      expect(world.row(agent, T15)).toMatchObject({
        status: 'skipped',
        code: 'not_reached',
        model: null,
        strategyAt: null,
        portfolio: startingPortfolio(),
      });
    }
  });

  it('still asks Pro agents at minute 49', async () => {
    const agent = await world.addPro(1);
    await world.step(`${DAY}T15:00:05.000Z`);
    await world.run(`${DAY}T15:49:05.000Z`, `${DAY}T15:55:05.000Z`);
    expect(world.row(agent, T15).status).toBe('decided');
  });

  it('skips pending Open agents once the UTC day of the daily tick is over', async () => {
    const open = await addOpenAgents(world, 3, 11);
    const pro = await world.addPro(1);
    expect((await world.step(START)).action).toBe('tick_created');
    // Nothing ran until after midnight. The old tick is finished first, under its own season.
    await world.run('2026-10-07T00:01:05.000Z', '2026-10-07T00:10:05.000Z');
    expect((await world.store.getTick(T15))?.status).toBe('complete');
    expect(world.decisionCalls).toHaveLength(0);
    for (const agent of open) expect(world.row(agent, T15)).toMatchObject({ status: 'skipped', code: 'not_reached' });
    expect(world.row(pro, T15)).toMatchObject({ status: 'skipped', code: 'not_reached' });
    // The day of a row is the day of its tick, not the day it was written.
    for (const agent of open) expect(await world.stats(agent)).toMatchObject({ lastDay: DAY, tradingDays: 1 });
  });

  it('finishes the oldest unfinished tick before it creates the next one', async () => {
    const agent = await world.addPro(1);
    await world.step(`${DAY}T15:00:05.000Z`);
    // The next step comes an hour late.
    const report = await world.step(`${DAY}T16:00:05.000Z`);
    expect(report.tickId).toBe(T15);
    expect(report.action).not.toBe('tick_created');
    await world.run(`${DAY}T16:01:05.000Z`, `${DAY}T16:09:05.000Z`);
    expect((await world.store.getTick(T15))?.status).toBe('complete');
    expect(world.row(agent, T15)).toMatchObject({ status: 'skipped', code: 'not_reached' });
    // The 16:00 tick is still created inside its window, and the agent decides there.
    expect((await world.store.getTick(`${DAY}T16:00Z`))?.status).toBe('complete');
    expect(world.row(agent, `${DAY}T16:00Z`).status).toBe('decided');
  });

  it('does not ask Open agents at a tick that is not the daily tick', async () => {
    const open = await world.addOpen(11);
    await world.addPro(1);
    await world.runTick(`${DAY}T15:00:05.000Z`);
    await world.runTick(`${DAY}T16:00:05.000Z`);
    await world.runTick(`${DAY}T17:00:05.000Z`);
    expect((await world.rows(open)).map((row) => row.tickId)).toEqual([T15]);
    expect(await world.store.getLeagueState(SEASON_1.id, 'open')).toMatchObject({ tickId: T15 });
  });

  it('makes a later tick the daily tick when the 15:00 tick could not be created', async () => {
    const open = await world.addOpen(11);
    world.feed.options = { rpcDown: true };
    await world.run(`${DAY}T15:00:05.000Z`, `${DAY}T15:09:05.000Z`);
    world.feed.options = {};
    const tick = await world.runTick(`${DAY}T16:00:05.000Z`);
    expect(tick.daily).toBe(true);
    expect((await world.rows(open)).map((row) => row.tickId)).toEqual([`${DAY}T16:00Z`]);
    const next = await world.runTick(`${DAY}T17:00:05.000Z`);
    expect(next.daily).toBe(false);
  });
});
