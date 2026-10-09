import {
  DNA_CHUNK_AGENTS,
  DNA_METHOD,
  SOCIAL_CURSOR,
  SOCIAL_JOB_MAX_STATEMENTS,
  socialFailureCursor,
} from '@prix/contracts';
import { createStrategyDnaJob } from '@prix/runtime/social/index';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, jobDeps, meteredDb, resetDb, SEASON_1, storesOn } from './support/d1.ts';
import { dayAt, League } from './support/league.ts';

/**
 * The strategy_dna job (docs/contracts/phase-6-social.md section 5.1) on the real database: the
 * statements it sends, how it idles, how a new method starts a new pass, and how it fails.
 */

const plain = storesOn(db);
const DAYS = 14;
const AGENTS = 13;
const now = (offset: number) => `${dayAt(DAYS - 1 + offset)}T01:00:00.000Z`;

function run(at: string) {
  const metered = meteredDb(db);
  const world = jobDeps(storesOn(metered.db), { now: at });
  const job = createStrategyDnaJob(world.deps);
  return {
    metered,
    world,
    async once() {
      metered.reset();
      const outcome = await job.run(new Date(at));
      return { outcome, statements: metered.meter.statements, writes: metered.meter.writes };
    },
  };
}

const cursor = async () => JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.dna)) as string);
const profileCount = async () =>
  ((await db.prepare('SELECT count(*) AS n FROM strategy_dna').first<{ n: number }>()) as { n: number }).n;

let league: League;

beforeAll(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
  league = new League(plain, { agents: AGENTS, seed: 11 });
  await league.addAgents();
  for (let i = 0; i < DAYS; i++) await league.playDay(i);
});

describe('the passes', () => {
  it('computes ten agents a run, within the statement limit, then the rest, and ends the pass', async () => {
    const t = run(now(3));
    const first = await t.once();
    expect(first.outcome).toBe('more');
    expect(first.statements).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
    expect(await profileCount()).toBe(DNA_CHUNK_AGENTS);
    expect(await cursor()).toMatchObject({ method: DNA_METHOD, done: false });

    const second = await t.once();
    expect(second.outcome).toBe('done');
    expect(second.statements).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
    expect(await profileCount()).toBe(AGENTS);
    expect(await cursor()).toMatchObject({ method: DNA_METHOD, done: true, afterAgentId: null });
  });

  it('is idle at no more than two reads and no write while no newer priced day exists', async () => {
    const t = run(now(3));
    const idle = await t.once();
    expect(idle.outcome).toBe('idle');
    expect(idle.writes).toBe(0);
    expect(idle.statements).toBeLessThanOrEqual(2);
  });

  it('waits two days before a newer priced day is profiled, then starts a new pass as of that day', async () => {
    await league.playDay(DAYS);
    expect((await cursor()).asOfDay).toBe(dayAt(DAYS - 1));
    // One day after the new priced day it is still inside the feed delay: idle.
    const early = run(`${dayAt(DAYS + 1)}T01:00:00.000Z`);
    expect((await early.once()).outcome).toBe('idle');
    // Two days after it, the pass starts as of that day.
    const ready = run(`${dayAt(DAYS + 2)}T01:00:00.000Z`);
    expect((await ready.once()).outcome).toBe('more');
    expect(await cursor()).toMatchObject({ method: DNA_METHOD, asOfDay: dayAt(DAYS), done: false });
    expect((await ready.once()).outcome).toBe('done');
  });
});

describe('a new method', () => {
  it('starts the pass again from the first agent when the cursor names another method, and rewrites the profiles', async () => {
    await plain.reputation.putJobState(
      SOCIAL_CURSOR.dna,
      JSON.stringify({ method: 'dna-v0', asOfDay: dayAt(DAYS - 1), afterAgentId: null, done: true }),
      now(5),
    );
    // Old rows keep their old computation time until the new pass reaches them.
    const before = (
      await db.prepare('SELECT agent_id, body FROM strategy_dna ORDER BY agent_id').all<{
        agent_id: string;
        body: string;
      }>()
    ).results;
    const at = now(5);
    const t = run(at);
    const first = await t.once();
    expect(first.outcome).toBe('more');
    const after = (
      await db.prepare('SELECT agent_id, body FROM strategy_dna ORDER BY agent_id').all<{
        agent_id: string;
        body: string;
      }>()
    ).results;
    const stamped = (rows: typeof before) =>
      rows.filter((r) => JSON.parse(r.body).computedAt === new Date(at).toISOString());
    expect(stamped(before)).toHaveLength(0);
    expect(stamped(after)).toHaveLength(DNA_CHUNK_AGENTS);
    expect(await cursor()).toMatchObject({ method: DNA_METHOD, done: false });
    expect((await t.once()).outcome).toBe('done');
    expect(
      stamped(
        (await db.prepare('SELECT agent_id, body FROM strategy_dna').all<{ agent_id: string; body: string }>()).results,
      ),
    ).toHaveLength(AGENTS);
  });

  it('reads a cursor it cannot understand as no cursor and starts a pass, without throwing', async () => {
    for (const body of ['not json', '[]', '{"method":"dna-v1"}', '{"method":"dna-v1","asOfDay":7,"done":true}']) {
      await plain.reputation.putJobState(SOCIAL_CURSOR.dna, body, now(6));
      const t = run(now(6));
      const result = await t.once();
      expect(['more', 'done']).toContain(result.outcome);
      expect(result.statements).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
      while ((await t.once()).outcome === 'more') {
        // finish the pass
      }
    }
  });
});

describe('failures', () => {
  it('answers failed and never throws when the database fails at any statement, writes nothing half-way and logs no message', async () => {
    await plain.reputation.putJobState(
      SOCIAL_CURSOR.dna,
      JSON.stringify({ method: 'dna-v0', asOfDay: dayAt(DAYS - 1), afterAgentId: null, done: true }),
      now(7),
    );
    const probe = run(now(7));
    const full = (await probe.once()).statements;
    expect(full).toBeGreaterThanOrEqual(5);
    for (let after = 0; after < full; after++) {
      // Each failure point is a first failure: after SOCIAL_JOB_SKIP_AFTER_FAILURES failures in a row the
      // job would rightly wait for the next UTC day (contract 6.1), which hardening/jobs checks.
      await db.prepare('DELETE FROM job_state WHERE name = ?1').bind(socialFailureCursor('strategy_dna')).run();
      await plain.reputation.putJobState(
        SOCIAL_CURSOR.dna,
        JSON.stringify({ method: 'dna-v0', asOfDay: dayAt(DAYS - 1), afterAgentId: null, done: true }),
        now(7),
      );
      const rowsBefore = JSON.stringify(
        (await db.prepare('SELECT * FROM strategy_dna ORDER BY agent_id').all()).results,
      );
      const cursorBefore = await plain.reputation.getJobState(SOCIAL_CURSOR.dna);
      const t = run(now(7));
      t.metered.failAfter(after, new Error('database exploded: secret-token-31337'));
      const outcome = await createStrategyDnaJobFor(t).run(new Date(now(7)));
      t.metered.clear();
      // Contract 6.1 (section 18.6): a job that throws answers `failed`, logged with its name, and never throws.
      expect(outcome, `after ${after}`).toBe('failed');
      expect(t.world.logs.some((l) => l.event === 'social_job_failed' && l.data?.job === 'strategy_dna')).toBe(true);
      expect(JSON.stringify(t.world.logs)).not.toContain('secret-token-31337');
      // A failed run leaves the profiles and the cursor as they were.
      expect(JSON.stringify((await db.prepare('SELECT * FROM strategy_dna ORDER BY agent_id').all()).results)).toBe(
        rowsBefore,
      );
      expect(await plain.reputation.getJobState(SOCIAL_CURSOR.dna)).toBe(cursorBefore);
    }
  });
});

function createStrategyDnaJobFor(t: ReturnType<typeof run>) {
  return createStrategyDnaJob(t.world.deps);
}
