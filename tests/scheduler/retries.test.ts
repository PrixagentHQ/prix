import type { AgentRecord } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEASON_1 } from '../support/fixtures.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, expectReplayMatches } from '../support/scheduler.ts';

/**
 * docs/CONTRACTS.md section 10: a step can run twice, or two steps can overlap, and no
 * decision is applied twice. A step never throws, whatever the database does.
 */
describe('a step that runs twice', () => {
  const T13 = '2026-10-06T15:00Z';
  let world: World;
  let agents: AgentRecord[];

  beforeEach(async () => {
    world = createWorld();
    agents = [await world.addPro(1), await world.addPro(2), await world.addPro(3)];
  });

  const expectOneRowEach = async () => {
    for (const agent of agents) {
      const rows = await world.rows(agent);
      expect(rows.map((row) => row.tickId)).toEqual([T13]);
      const stats = await world.stats(agent);
      expect(stats.decidedCount + stats.noDecisionCount + stats.skippedCount).toBe(1);
      expect(stats.tradeCount).toBe(rows[0]?.fills.length);
      expect(await world.portfolio(agent)).toEqual(rows[0]?.portfolio);
      await expectReplayMatches(world, agent);
    }
  };

  it('creates the tick once when the same minute runs twice', async () => {
    const first = await world.step('2026-10-06T15:00:05.000Z');
    expect(first).toMatchObject({ action: 'tick_created', tickId: T13 });
    const tick = await world.store.getTick(T13);
    const second = await world.step('2026-10-06T15:00:05.000Z');
    expect(second.action).not.toBe('tick_created');
    expect(world.store.ticks.size).toBe(1);
    // The second run did not replace the snapshot of the tick.
    expect((await world.store.getTick(T13))?.snapshot).toEqual(tick?.snapshot);
  });

  it('creates one tick when two steps start at the same moment', async () => {
    const at = '2026-10-06T15:00:05.000Z';
    const reports = await Promise.all([world.step(at), world.step(at)]);
    expect(world.store.ticks.size).toBe(1);
    expect(reports.filter((report) => report.action === 'tick_created').length).toBeLessThanOrEqual(1);
    await world.runTick('2026-10-06T15:01:00.000Z');
    await expectOneRowEach();
  });

  it('applies every decision once when two steps overlap on the same agents', async () => {
    await world.step('2026-10-06T15:00:05.000Z');
    const at = '2026-10-06T15:01:05.000Z';
    await Promise.all([world.step(at), world.step(at), world.step(at)]);
    await world.runTick('2026-10-06T15:02:00.000Z');
    await expectOneRowEach();
    expect(world.store.decisions.size).toBe(3);
  });

  it('applies every decision once when every step of the hour runs twice', async () => {
    for (let minute = 0; minute < 12; minute += 1) {
      const at = `2026-10-06T15:${String(minute).padStart(2, '0')}:05.000Z`;
      await world.step(at);
      await world.step(at);
    }
    expect((await world.store.getTick(T13))?.status).toBe('complete');
    await expectOneRowEach();
  });

  it('does nothing more once the tick is complete', async () => {
    await world.runTick('2026-10-06T15:00:05.000Z');
    const rowsBefore = world.store.dump();
    const callsBefore = world.decisionCalls.length;
    for (const at of [
      '2026-10-06T15:05:00.000Z',
      '2026-10-06T15:09:59.000Z',
      '2026-10-06T15:30:00.000Z',
      '2026-10-06T15:59:00.000Z',
    ]) {
      const report = await world.step(at);
      expect(report.action).toBe('idle');
    }
    expect(world.store.dump()).toBe(rowsBefore);
    expect(world.decisionCalls.length).toBe(callsBefore);
  });

  it('ranks the same way when the ranking runs twice', async () => {
    await world.runTick('2026-10-06T15:00:05.000Z');
    const state = await world.store.getLeagueState(SEASON_1.id, 'pro');
    const table = await world.store.listStandings(SEASON_1.id, 'pro', 100, 0);
    await world.store.rerank(SEASON_1.id, 'pro', T13, state?.computedAt ?? '', 'v1');
    expect(await world.store.listStandings(SEASON_1.id, 'pro', 100, 0)).toEqual(table);
  });
});

describe('a step never throws', () => {
  let world: World;
  let agents: AgentRecord[];

  beforeEach(async () => {
    world = createWorld();
    agents = [await world.addPro(1), await world.addPro(2), await world.addOpen(11)];
  });

  it.each([
    'listProcessingTicks',
    'getActiveSeason',
    'getTick',
    'createTick',
    'putMarketStatus',
    'listSymbolHolds',
    'getLatestTick',
    'hasDailyTick',
  ])('returns a report when %s fails while a tick is being created', async (method) => {
    world.store.failing = { method, times: 1 };
    await world.step('2026-10-06T15:00:05.000Z');
    world.store.failing = null;
    // The next minutes recover: the tick exists and finishes, with one row per agent.
    await world.run('2026-10-06T15:01:05.000Z', '2026-10-06T15:09:05.000Z');
    expect((await world.store.getTick('2026-10-06T15:00Z'))?.status).toBe('complete');
    for (const agent of agents) {
      expect((await world.rows(agent)).map((row) => row.tickId)).toEqual(['2026-10-06T15:00Z']);
      await expectReplayMatches(world, agent);
    }
  });

  it.each([
    'listPendingAgents',
    'countPendingAgents',
    'getModelKey',
    'writeDecision',
    'listDailyPrices',
    'getAiNeurons',
    'addAiNeurons',
    'rerank',
    'completeTick',
  ])(
    'returns a report when %s fails while a tick is being processed, and no decision is lost or doubled',
    async (method) => {
      await world.step('2026-10-06T15:00:05.000Z');
      world.store.failing = { method, times: 2 };
      await world.step('2026-10-06T15:01:05.000Z');
      await world.step('2026-10-06T15:02:05.000Z');
      world.store.failing = null;
      await world.run('2026-10-06T15:03:05.000Z', '2026-10-06T15:12:05.000Z');
      expect((await world.store.getTick('2026-10-06T15:00Z'))?.status).toBe('complete');
      for (const agent of agents) {
        const rows = await world.rows(agent);
        expect(rows.map((row) => row.tickId)).toEqual(['2026-10-06T15:00Z']);
        const stats = await world.stats(agent);
        expect(stats.decidedCount + stats.noDecisionCount + stats.skippedCount).toBe(1);
        await expectReplayMatches(world, agent);
      }
    },
  );

  it('returns a report when the database is down for every call of a step', async () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(world.store)).filter(
      (name) => name !== 'constructor',
    );
    for (const method of methods) {
      world.store.failing = { method, times: 1 };
      await world.step('2026-10-06T15:00:05.000Z');
    }
    world.store.failing = null;
    await world.run('2026-10-06T15:01:05.000Z', '2026-10-06T15:09:05.000Z');
    // Whatever failed on the way, no agent ends the hour with more than one row.
    for (const agent of agents) expect((await world.rows(agent)).length).toBeLessThanOrEqual(1);
  });

  it('logs a failure without the text of the error turning into a crash', async () => {
    world.store.failing = { method: 'listProcessingTicks', times: 1 };
    await world.step('2026-10-06T15:00:05.000Z');
    expect(world.log.lines.length).toBeGreaterThan(0);
  });
});
