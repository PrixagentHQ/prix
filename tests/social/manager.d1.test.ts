import type { DailyPoint, ManagerDayResult, ManagerPolicy, ManagerRebalance } from '@prix/contracts';
import { MANAGER_CHUNK, SOCIAL_CURSOR, SOCIAL_JOB_MAX_STATEMENTS } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { createManagerValueJob } from '@prix/runtime/social/index';
import { sim } from '@prix/sim';
import { createManagerEngine } from '@prix/sim/manager';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, jobDeps, meteredDb, resetDb, SEASON_1, storesOn } from './support/d1.ts';
import { dayAt, League } from './support/league.ts';
import { addManager, policyOf } from './support/managers.ts';

/**
 * The manager_value job (docs/contracts/phase-6-social.md section 5.5) on the real database: 26
 * paper managers over 6 public agents for 14 days. What the job stores is what the pure engine makes of
 * the stored policies and the agents' daily points: the replay test below recomputes every book.
 */

const plain = storesOn(db);
const engine = createManagerEngine({ sim, scoring });
const DAYS = 14;
let league: League;
const managers: Array<{ id: string; owner: string }> = [];
const statementsPerRun: number[] = [];
const outcomes: string[] = [];

/** The daily point of each agent on each day of the season, from its stored stats. */
async function pointsOf(agentId: string): Promise<Map<string, number>> {
  const record = await plain.store.getPortfolio(agentId, SEASON_1.id);
  return new Map((record?.stats.daily ?? []).map((p: DailyPoint) => [p.day, p.equityMicro]));
}

const at = (i: number) => `${dayAt(i)}T21:00:00.000Z`;

beforeAll(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
  league = new League(plain, { agents: 6, seed: 9 });
  await league.addAgents();
  const ids = league.agents.map((a) => a.id);
  for (let n = 1; n <= 26; n++) {
    const a = ids[n % 6] as string;
    const b = ids[(n + 2) % 6] as string;
    const c = ids[(n + 4) % 6] as string;
    const manager = await addManager(plain, n, { [a]: 3000, [b]: 2500, [c]: 2000 }, n % 3 === 0 ? 'hold' : 'weekly');
    managers.push({ id: manager.id, owner: manager.owner });
  }
});

describe('the job, day by day', () => {
  it('values every active manager on every final day, in chunks of 25, and the batches stay in the limit', async () => {
    for (let i = 0; i < DAYS; i++) {
      await league.playTick(i);
      await league.closeDay(i);
      // Day 3: manager 2 is paused and manager 3 is hidden by an admin; day 5: manager 1 changes its policy.
      if (i === 3) {
        await plain.social.setManagerStatus(managers[1]?.id as string, managers[1]?.owner as never, 'paused', at(i));
        await plain.social.setManagerHidden(managers[2]?.id as string, true, at(i));
      }
      if (i === 5) {
        const ids = league.agents.map((a) => a.id);
        const policy = policyOf(
          managers[0]?.id as string,
          2,
          { [ids[0] as string]: 4000, [ids[3] as string]: 4000 },
          'hold',
          dayAt(5),
        );
        expect(await plain.social.putPolicy(policy, at(i))).toBe('stored');
      }
      const metered = meteredDb(db);
      const world = jobDeps(storesOn(metered.db), { now: at(i) });
      const job = createManagerValueJob(world.deps);
      for (let run = 0; run < 6; run++) {
        metered.reset();
        const outcome = await job.run(new Date(at(i)));
        statementsPerRun.push(metered.meter.statements);
        outcomes.push(`${i}:${outcome}`);
        if (outcome === 'idle') break;
      }
    }
    // Days 0 to 2: 26 active managers, a run of 25 (more) and a run of the last one (done). From day 3 a
    // manager is paused and one hidden: 24 are active, which is one run (done).
    expect(outcomes.filter((o) => o.endsWith(':more'))).toHaveLength(3);
    expect(outcomes.filter((o) => o.endsWith(':done'))).toHaveLength(DAYS);
    expect(MANAGER_CHUNK).toBe(25);
    // The contract: a job stays within SOCIAL_JOB_MAX_STATEMENTS statements per run.
    expect(Math.max(...statementsPerRun)).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
  });

  it('is idle at no more than two reads and no write once every final day is valued', async () => {
    const metered = meteredDb(db);
    const world = jobDeps(storesOn(metered.db), { now: at(DAYS) });
    const outcome = await createManagerValueJob(world.deps).run(new Date(at(DAYS)));
    expect(outcome).toBe('idle');
    expect(metered.meter.statements).toBeLessThanOrEqual(2);
    expect(metered.meter.writes).toBe(0);
    expect(JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.managers)) as string)).toEqual({
      valuedDay: dayAt(DAYS - 1),
      work: null,
    });
  });
});

describe('the stored books are the engine replay of the stored policies and points', () => {
  it('equals engine.replay for every manager: book, stats and every rebalance', async () => {
    const points = new Map<string, Map<string, number>>();
    for (const agent of league.agents) points.set(agent.id, await pointsOf(agent.id));
    let checked = 0;
    for (const m of managers) {
      const record = await plain.social.getManager(m.id);
      const book = await plain.social.getManagerBook(m.id, SEASON_1.id);
      // The paused manager is valued until day 3 only; the hidden one is not valued from day 3 on.
      const policies: ManagerPolicy[] = [];
      for (let v = 1; v <= (record?.policyVersion ?? 1); v++) {
        const policy = await db
          .prepare(
            'SELECT targets, schedule, set_at, set_day FROM manager_policies WHERE manager_id = ?1 AND version = ?2',
          )
          .bind(m.id, v)
          .first<{ targets: string; schedule: 'weekly' | 'hold'; set_at: string; set_day: string }>();
        if (!policy) throw new Error('no policy');
        policies.push({
          managerId: m.id,
          version: v,
          targetsBps: JSON.parse(policy.targets),
          schedule: policy.schedule,
          setAt: policy.set_at,
          setDay: policy.set_day,
        });
      }
      const index = managers.indexOf(m);
      const lastValued = index === 1 || index === 2 ? 2 : DAYS - 1;
      const involved = new Set<string>();
      for (const p of policies) for (const id of Object.keys(p.targetsBps)) involved.add(id);
      const days = Array.from({ length: lastValued + 1 }, (_, i) => ({
        day: dayAt(i),
        values: Object.fromEntries([...involved].map((id) => [id, points.get(id)?.get(dayAt(i)) ?? null])),
      }));
      const replayed = engine.replay({ policies, days });
      expect(book, m.id).not.toBeNull();
      expect(book?.book, m.id).toEqual(replayed.book);
      expect(book?.stats, m.id).toEqual(replayed.stats);
      expect(book?.lastDay).toBe(dayAt(lastValued));

      const stored = await plain.social.listManagerRebalances(m.id, SEASON_1.id, 100);
      const expected = replayed.rebalances.map(rebalanceRecord(policies)).reverse();
      expect(stored, m.id).toEqual(expected);
      checked += 1;
    }
    expect(checked).toBe(26);
    // The runs here include the three kinds of day: a start, a weekly day and a policy change.
    const reasons = new Set<string>();
    for (const m of managers) {
      for (const r of await plain.social.listManagerRebalances(m.id, SEASON_1.id, 100)) reasons.add(r.reason);
    }
    expect(reasons).toEqual(new Set(['start', 'scheduled', 'policy']));
  });

  it('applies a policy the day after it was set, not the day it was set', async () => {
    const first = managers[0] as { id: string };
    const stored = await plain.social.listManagerRebalances(first.id, SEASON_1.id, 100);
    const policyChange = stored.find((r) => r.reason === 'policy');
    // Set on day 5 (the 5th of the run), valued on day 6.
    expect(policyChange?.day).toBe(dayAt(6));
    expect(policyChange?.policyVersion).toBe(2);
  });

  it('values a paused manager no more, and a hidden manager no more', async () => {
    for (const index of [1, 2]) {
      const book = await plain.social.getManagerBook(managers[index]?.id as string, SEASON_1.id);
      expect(book?.lastDay).toBe(dayAt(2));
      expect(book?.stats.tradingDays).toBe(3);
    }
  });
});

describe('failures and a second run', () => {
  it('writes nothing for a manager already valued for the day (compare and set on the last day)', async () => {
    const before = JSON.stringify((await db.prepare('SELECT * FROM manager_books ORDER BY manager_id').all()).results);
    // Rewind the cursor to the last day and run again: the books are at that day already.
    await plain.reputation.putJobState(
      SOCIAL_CURSOR.managers,
      JSON.stringify({ valuedDay: dayAt(DAYS - 2), work: null }),
      at(DAYS),
    );
    const world = jobDeps(plain, { now: at(DAYS) });
    const job = createManagerValueJob(world.deps);
    for (let run = 0; run < 4; run++) if ((await job.run(new Date(at(DAYS)))) === 'idle') break;
    const after = JSON.stringify((await db.prepare('SELECT * FROM manager_books ORDER BY manager_id').all()).results);
    expect(after).toBe(before);
    expect(
      (await db.prepare('SELECT count(*) AS n FROM manager_rebalances').first<{ n: number }>())?.n,
    ).toBeGreaterThan(26);
  });

  it('answers failed and never throws when the database fails at any statement, and a failed batch leaves the books as they were', async () => {
    // A new final day that no job has valued yet.
    await league.playTick(DAYS);
    await league.closeDay(DAYS);
    for (let after = 0; after < 8; after++) {
      const before = JSON.stringify(
        (await db.prepare('SELECT * FROM manager_books ORDER BY manager_id').all()).results,
      );
      const metered = meteredDb(db);
      const world = jobDeps(storesOn(metered.db), { now: at(DAYS) });
      metered.failAfter(after, new Error('database exploded: secret-token-1234'));
      const outcome = await createManagerValueJob(world.deps).run(new Date(at(DAYS)));
      // Contract 6.1 (section 18.6): a job that throws answers `failed`, logged with its name, and never throws.
      expect(outcome, `after ${after}`).toBe('failed');
      expect(JSON.stringify(world.logs)).not.toContain('secret-token-1234');
      expect(world.logs.some((l) => l.event === 'social_job_failed' && l.data?.job === 'manager_value')).toBe(true);
      const afterBooks = JSON.stringify(
        (await db.prepare('SELECT * FROM manager_books ORDER BY manager_id').all()).results,
      );
      expect(afterBooks).toBe(before);
    }
  });
});

/** The shape the job stores for a rebalance, from what the engine returned. */
function rebalanceRecord(policies: readonly ManagerPolicy[]) {
  return (r: ManagerDayResult): ManagerRebalance => {
    const day = r.stats.lastDay as string;
    let inForce: ManagerPolicy | undefined;
    for (const p of policies) if (p.setDay < day) inForce = p;
    return {
      day,
      reason: r.reason as NonNullable<ManagerDayResult['reason']>,
      policyVersion: (inForce as ManagerPolicy).version,
      targetsBps: r.targetsUsed ?? {},
      fills: r.fills,
      exited: r.exited,
      equityBeforeMicro: r.equityBeforeMicro,
      equityAfterMicro: r.equityMicro,
      costMicro: r.costMicro,
    };
  };
}
