import { KEY_FAILURES_TO_PAUSE } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { decisionJson } from '../support/fakes.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, expectReplayMatches } from '../support/scheduler.ts';

/**
 * The scheduler rules that revision 3 added (docs/CONTRACTS.md section 15, "Scheduler"):
 * membership is fixed at the snapshot, a strategy changed after it is not traded, a step
 * proves the database takes writes before it asks a model, a key that keeps failing pauses
 * its agent, and an engine that throws costs one agent one row.
 */

const DAY = '2026-10-06';
const T15 = `${DAY}T15:00Z`;
const T16 = `${DAY}T16:00Z`;

describe('membership is fixed at the snapshot', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  it('leaves an agent that is created after the tick was made out of that tick', async () => {
    const early = await world.addPro(1);
    expect((await world.step(`${DAY}T15:00:05.000Z`)).action).toBe('tick_created');
    const late = await world.addPro(2, { createdAt: `${DAY}T15:00:30.000Z` });
    await world.run(`${DAY}T15:01:05.000Z`, `${DAY}T15:09:05.000Z`);
    expect((await world.store.getTick(T15))?.status).toBe('complete');
    expect(world.row(early, T15).status).toBe('decided');
    expect(await world.rows(late)).toEqual([]);
    // It is in the next tick.
    await world.runTick(`${DAY}T16:00:05.000Z`);
    expect(world.row(late, T16).status).toBe('decided');
  });

  it('leaves an agent created in the same instant as the snapshot out of the tick', async () => {
    const tickTime = `${DAY}T15:00:05.000Z`;
    await world.step(tickTime);
    const same = await world.addOpen(11, { createdAt: tickTime });
    await world.run(`${DAY}T15:01:05.000Z`, `${DAY}T15:09:05.000Z`);
    expect(await world.rows(same)).toEqual([]);
  });

  it('skips an agent whose strategy changed after the snapshot, with changed_this_round and no model call', async () => {
    const edited = await world.addPro(1);
    const untouched = await world.addPro(2);
    await world.step(`${DAY}T15:00:05.000Z`);
    // The owner sees the prices of the round and edits the strategy.
    expect(
      await world.store.updateAgent(
        edited.id,
        {
          prompt: 'Strategy marker-1-end: buy the biggest winner of the round.',
          strategyChangedAt: `${DAY}T15:00:40.000Z`,
        },
        `${DAY}T15:00:40.000Z`,
      ),
    ).toBe('updated');
    await world.run(`${DAY}T15:01:05.000Z`, `${DAY}T15:09:05.000Z`);
    const row = world.row(edited, T15);
    expect(row).toMatchObject({
      status: 'skipped',
      code: 'changed_this_round',
      fills: [],
      costMicro: 0,
      targetsBps: null,
      model: null,
    });
    expect(row.portfolio).toEqual((await world.rows(edited))[0]?.portfolio);
    expect(world.decisionCalls.map((call) => call.n)).toEqual([2]);
    expect(world.row(untouched, T15).status).toBe('decided');
    // The change counts from the next tick on.
    await world.runTick(`${DAY}T16:00:05.000Z`);
    expect(world.row(edited, T16).status).toBe('decided');
    await expectReplayMatches(world, edited);
  });

  it('skips an agent that was resumed after the snapshot, because resuming sets the strategy time', async () => {
    const agent = await world.addPro(1, { overrides: { status: 'paused', pausedReason: 'owner' } });
    await world.step(`${DAY}T15:00:05.000Z`);
    await world.store.updateAgent(
      agent.id,
      { status: 'active', pausedReason: null, strategyChangedAt: `${DAY}T15:00:20.000Z` },
      `${DAY}T15:00:20.000Z`,
    );
    await world.run(`${DAY}T15:01:05.000Z`, `${DAY}T15:09:05.000Z`);
    expect(world.row(agent, T15)).toMatchObject({ status: 'skipped', code: 'changed_this_round' });
    expect(world.decisionCalls).toHaveLength(0);
  });
});

describe('a step proves the database takes writes before it asks a model', () => {
  it('ends as idle and asks no model when touchScheduler fails', async () => {
    const world = createWorld();
    const agents = [await world.addPro(1), await world.addOpen(11)];
    world.store.failing = { method: 'touchScheduler', times: 1_000 };
    const reports = await world.run(`${DAY}T15:00:05.000Z`, `${DAY}T15:12:05.000Z`);
    expect(world.decisionCalls).toHaveLength(0);
    expect(world.house.requests).toHaveLength(0);
    expect(world.own.requests()).toHaveLength(0);
    expect(world.store.decisions.size).toBe(0);
    expect(reports.every((report) => report.decided === 0 && report.noDecision === 0)).toBe(true);
    // The step that met the failure said idle.
    expect(reports.filter((report) => report.action === 'idle').length).toBeGreaterThan(0);
    for (const agent of agents) expect(await world.rows(agent)).toEqual([]);
  });

  it('carries on at the next minute once the database takes writes again', async () => {
    const world = createWorld();
    const agent = await world.addPro(1);
    world.store.failing = { method: 'touchScheduler', times: 2 };
    await world.run(`${DAY}T15:00:05.000Z`, `${DAY}T15:12:05.000Z`);
    expect(world.row(agent, T15).status).toBe('decided');
    expect(world.decisionCalls).toHaveLength(1);
  });

  it('touches the scheduler before the first model call of a step', async () => {
    const world = createWorld();
    await world.addPro(1);
    await world.runTick(`${DAY}T15:00:05.000Z`);
    expect(world.store.schedulerTouchedAt).not.toBeNull();
  });
});

describe('a key that keeps failing', () => {
  it(`pauses its Pro agent after ${KEY_FAILURES_TO_PAUSE} rejected rows in a row, with the reason key_failing`, async () => {
    const world = createWorld();
    const agent = await world.addPro(1);
    world.answers.set(1, { ok: false, code: 'provider_rejected', httpStatus: 401 });
    for (const hour of ['15', '16', '17']) await world.runTick(`${DAY}T${hour}:00:05.000Z`);
    const stored = await world.store.getAgent(agent.id);
    expect(stored).toMatchObject({ status: 'paused', pausedReason: 'key_failing' });
    const rows = await world.rows(agent);
    expect(rows.map((row) => [row.status, row.code])).toEqual([
      ['no_decision', 'provider_rejected'],
      ['no_decision', 'provider_rejected'],
      ['no_decision', 'provider_rejected'],
    ]);
    expect(world.store.portfolios.get(`${agent.id}|seasononeaaa`)?.keyFailures).toBe(KEY_FAILURES_TO_PAUSE);
    // A paused agent is not asked again.
    await world.runTick(`${DAY}T18:00:05.000Z`);
    expect(world.decisionCalls).toHaveLength(3);
  });

  it('does not pause an agent whose failures are interrupted by an answer that works', async () => {
    const world = createWorld();
    const agent = await world.addPro(1);
    const script = [
      { ok: false as const, code: 'provider_rejected' as const, httpStatus: 401 },
      { ok: false as const, code: 'provider_rejected' as const, httpStatus: 401 },
      decisionJson({ NVDA: 20 }),
      { ok: false as const, code: 'provider_rejected' as const, httpStatus: 401 },
    ];
    let call = 0;
    world.answers.set(1, () => script[call++] ?? decisionJson({}));
    for (const hour of ['15', '16', '17', '18']) await world.runTick(`${DAY}T${hour}:00:05.000Z`);
    expect((await world.store.getAgent(agent.id))?.status).toBe('active');
    expect(world.store.portfolios.get(`${agent.id}|seasononeaaa`)?.keyFailures).toBe(1);
  });

  it('counts a provider timeout as neither a failure of the key nor a reset of the count', async () => {
    const world = createWorld();
    const agent = await world.addPro(1);
    world.answers.set(1, { ok: false, code: 'provider_timeout', httpStatus: null });
    for (const hour of ['15', '16', '17', '18']) await world.runTick(`${DAY}T${hour}:00:05.000Z`);
    expect((await world.store.getAgent(agent.id))?.status).toBe('active');
    // Zero for any other row that is not skipped.
    expect(world.store.portfolios.get(`${agent.id}|seasononeaaa`)?.keyFailures).toBe(0);
  });

  it('gives a Pro agent whose key row is gone the code key_unavailable, and asks no model', async () => {
    const world = createWorld();
    const agent = await world.addPro(1);
    world.store.modelKeys.delete(agent.modelKeyId as string);
    await world.runTick(`${DAY}T15:00:05.000Z`);
    expect(world.row(agent, T15)).toMatchObject({ status: 'no_decision', code: 'key_unavailable', model: null });
    expect(world.decisionCalls).toHaveLength(0);
    expect(world.own.built).toHaveLength(0);
  });

  it('never opens a key that belongs to another wallet, even when the agent names it', async () => {
    const world = createWorld();
    const victim = await world.addPro(1);
    const thief = await world.addPro(2);
    // The thief's agent points at the victim's key row.
    await world.store.updateAgent(thief.id, { modelKeyId: victim.modelKeyId }, `${DAY}T10:00:00.000Z`);
    await world.store.updateAgent(thief.id, { strategyChangedAt: `${DAY}T10:00:00.000Z` }, `${DAY}T10:00:00.000Z`);
    await world.runTick(`${DAY}T15:00:05.000Z`);
    expect(world.row(thief, T15)).toMatchObject({ status: 'no_decision', code: 'key_unavailable' });
    expect(world.own.built.map((built) => built.keyId)).toEqual([victim.modelKeyId]);
    expect(world.vault.opened).toEqual([victim.modelKeyId]);
  });

  it('does not open a key whose provider was changed in the database', async () => {
    const world = createWorld();
    const agent = await world.addPro(1);
    const key = world.store.modelKeys.get(agent.modelKeyId as string);
    if (!key) throw new Error('no key');
    world.store.modelKeys.set(key.id, { ...key, provider: 'anthropic' });
    await world.runTick(`${DAY}T15:00:05.000Z`);
    expect(world.row(agent, T15)).toMatchObject({ status: 'no_decision', code: 'key_unavailable' });
    // No model was built, so no key went to another company.
    expect(world.own.built).toHaveLength(0);
  });
});

describe('a row that the store refuses to validate', () => {
  it('becomes a skipped row with internal_error, so it is not asked again every minute', async () => {
    const world = createWorld();
    const refused = await world.addPro(1);
    const fine = await world.addPro(2);
    const real = world.store.writeDecision.bind(world.store);
    let first = true;
    world.store.writeDecision = async (row, stats, keyFailures) => {
      if (first && row.status !== 'skipped') {
        first = false;
        // What a schema refusing a row throws: the review matches it by its name.
        throw Object.assign(new Error('row refused'), { name: 'ZodError' });
      }
      return real(row, stats, keyFailures);
    };
    await world.runTick(`${DAY}T15:00:05.000Z`);
    const rows = [world.row(refused, T15), world.row(fine, T15)];
    expect(rows.filter((row) => row.status === 'skipped' && row.code === 'internal_error')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'decided')).toHaveLength(1);
    expect(world.log.lines.some((line) => line.event === 'row_refused')).toBe(true);
  });
});

describe('an engine that throws', () => {
  it('costs one agent one skipped row with internal_error and leaves its portfolio as it was', async () => {
    const world = createWorld();
    const broken = await world.addPro(1);
    const fine = await world.addPro(2);
    const real = world.deps.sim;
    let calls = 0;
    (world.deps as { sim: typeof real }).sim = {
      ...real,
      rebalance: (input) => {
        calls += 1;
        if (calls === 1) throw new Error('boom: a bug in the engine');
        return real.rebalance(input);
      },
    };
    await world.runTick(`${DAY}T15:00:05.000Z`);
    const rows = [world.row(broken, T15), world.row(fine, T15)];
    const failed = rows.filter((row) => row.code === 'internal_error');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'skipped', fills: [], costMicro: 0 });
    expect(rows.filter((row) => row.status === 'decided')).toHaveLength(1);
    // The event is logged, and the message of the error is not what is stored in the row.
    expect(world.log.lines.some((line) => line.event === 'agent_failed')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('boom');
  });
});
