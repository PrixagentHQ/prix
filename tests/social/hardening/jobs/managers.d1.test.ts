import type { SocialJobDeps } from '@prix/contracts';
import { MANAGER_CHUNK, SOCIAL_CURSOR, SOCIAL_JOB_MAX_STATEMENTS } from '@prix/contracts';
import { createManagerValueJob } from '@prix/runtime/social/index';
import { beforeAll, describe, expect, it } from 'vitest';
import { testId } from '../../../support/fixtures.ts';
import { db, jobDeps, meteredDb, resetDb, SEASON_1, storesOn } from '../../support/d1.ts';
import { dayAt, League } from '../../support/league.ts';
import { addManager, managerOf } from '../../support/managers.ts';

/**
 * Security review 6, finding 3 (docs/contracts/phase-6-social.md section 5.5): `agentValuesOn` takes at
 * most 100 agent ids, so the manager_value job closes a chunk early while the distinct agents of its
 * managers would pass 100. Here 25 managers hold 125 distinct agents: a whole chunk of MANAGER_CHUNK would
 * ask for 125 values, and without the early close no manager would ever be valued again.
 */

const plain = storesOn(db);
const at = (i: number) => `${dayAt(i)}T21:00:00.000Z`;
const MANAGERS = 25;
const PER_MANAGER = 5;

let league: League;

beforeAll(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
  league = new League(plain, { agents: PER_MANAGER, seed: 4 });
  await league.addAgents();
  await league.playTick(0);
  await league.closeDay(0);
  const real = league.agents.map((a) => a.id);
  for (let n = 1; n <= MANAGERS; n++) {
    // Manager 1 holds the five real agents; every other manager five agents of its own.
    const ids =
      n === 1 ? real : Array.from({ length: PER_MANAGER }, (_, k) => testId('agent', 10_000 + n * PER_MANAGER + k));
    await addManager(plain, n, Object.fromEntries(ids.map((id) => [id, 1900])), 'weekly');
  }
});

describe('a chunk whose managers hold more than 100 distinct agents', () => {
  it('closes early, values every manager over several runs, and never asks for more than 100 values', async () => {
    expect(MANAGER_CHUNK).toBe(MANAGERS);
    const asked: number[] = [];
    const outcomes: string[] = [];
    const statements: number[] = [];
    for (let run = 0; run < 6; run++) {
      const metered = meteredDb(db);
      const stores = storesOn(metered.db);
      const world = jobDeps(stores, { now: at(0) });
      const deps: SocialJobDeps = {
        ...world.deps,
        social: {
          ...stores.social,
          agentValuesOn: (seasonId, day, ids) => {
            asked.push(ids.length);
            return stores.social.agentValuesOn(seasonId, day, ids);
          },
        },
      };
      const outcome = await createManagerValueJob(deps).run(new Date(at(0)));
      outcomes.push(outcome);
      statements.push(metered.meter.statements);
      if (outcome === 'idle' || outcome === 'done') break;
    }
    expect(outcomes).toEqual(['more', 'done']);
    expect(asked.length).toBeGreaterThan(1);
    expect(Math.max(...asked)).toBeLessThanOrEqual(100);
    expect(asked.reduce((a, b) => a + b, 0)).toBe(MANAGERS * PER_MANAGER);
    expect(Math.max(...statements)).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);

    for (let n = 1; n <= MANAGERS; n++) {
      const book = await plain.social.getManagerBook(managerOf(n).id, SEASON_1.id);
      expect(book?.lastDay, `manager ${n}`).toBe(dayAt(0));
    }
    expect(JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.managers)) as string)).toEqual({
      valuedDay: dayAt(0),
      work: null,
    });
    // The manager of the real agents traded at their values of the day.
    const first = await plain.social.listManagerRebalances(managerOf(1).id, SEASON_1.id, 10);
    expect(first.map((r) => r.reason)).toEqual(['start']);
    expect(first[0]?.fills.length).toBe(PER_MANAGER);
  });

  it('writes nothing on a second run of the same day', async () => {
    const dump = async () =>
      JSON.stringify({
        books: (await db.prepare('SELECT * FROM manager_books ORDER BY manager_id').all()).results,
        rebalances: (await db.prepare('SELECT * FROM manager_rebalances ORDER BY manager_id, day').all()).results,
      });
    const before = await dump();
    await plain.reputation.putJobState(SOCIAL_CURSOR.managers, JSON.stringify({ valuedDay: null, work: null }), at(0));
    const world = jobDeps(plain, { now: at(0) });
    const job = createManagerValueJob(world.deps);
    for (let run = 0; run < 6; run++) if ((await job.run(new Date(at(0)))) !== 'more') break;
    expect(await dump()).toBe(before);
  });
});
