import { SOCIAL_CURSOR } from '@prix/contracts';
import { createManagerValueJob } from '@prix/runtime/social/index';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSocialStore } from '../../../../apps/api/src/store/social.ts';
import { db, jobDeps, resetDb, SEASON_1, storesOn } from '../../support/d1.ts';
import { dayAt, League } from '../../support/league.ts';
import { addManager, managerOf, policyOf } from '../../support/managers.ts';

/**
 * The query plans of the statements this hardening changed or added: every table they touch is reached by
 * its primary key or a named index, never by a scan of the table. The statements are taken as the store
 * sends them, by a database wrapper that keeps the text of every prepared statement.
 */

const plain = storesOn(db);
const at = (i: number) => `${dayAt(i)}T21:00:00.000Z`;

interface Recorded {
  sql: string;
  values: unknown[];
}

/** The full text and the values of every statement prepared through the wrapper, in order. */
function recording(): { db: D1Database; sql: Recorded[] } {
  const sql: Recorded[] = [];
  const wrapper = {
    // The store always binds what it prepares, so the wrapper only needs `bind`.
    prepare: (text: string) => {
      const entry: Recorded = { sql: text, values: [] };
      sql.push(entry);
      const real = db.prepare(text);
      return {
        bind: (...values: unknown[]) => {
          entry.values = values;
          return real.bind(...values);
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
  };
  return { db: wrapper as unknown as D1Database, sql };
}

async function planOf(statement: Recorded): Promise<string[]> {
  const rows = await db
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .bind(...statement.values)
    .all<{ detail: string }>();
  return rows.results.map((row) => row.detail);
}

/**
 * The plan lines that read a stored table without its key or an index. Not tables: json_each (a virtual
 * table), the constant row of a SELECT without FROM, and the co-routines and subqueries of the plan itself.
 */
function tableScans(plan: readonly string[]): string[] {
  const coroutines = new Set(plan.map((line) => /^CO-ROUTINE (\S+)/.exec(line)?.[1]).filter(Boolean));
  return plan.filter((line) => {
    const scanned = /^SCAN (\S+)/.exec(line)?.[1];
    if (scanned === undefined || coroutines.has(scanned)) return false;
    if (/VIRTUAL TABLE|^SCAN CONSTANT ROW|^SCAN \(subquery-/.test(line)) return false;
    return !/USING (COVERING )?INDEX|USING PRIMARY KEY|USING INTEGER PRIMARY KEY/.test(line);
  });
}

const statements = new Map<string, Recorded>();

beforeAll(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
  const league = new League(plain, { agents: 3 });
  await league.addAgents();
  await league.playDay(0);
  await league.playDay(1);
  const ids = league.agents.map((a) => a.id);
  await addManager(plain, 1, { [ids[0] as string]: 3000, [ids[1] as string]: 3000 }, 'weekly');

  const take = (name: string, match: RegExp, list: Recorded[]) => {
    const found = list.find((entry) => match.test(entry.sql));
    if (found === undefined) throw new Error(`no statement ${name}`);
    statements.set(name, found);
  };

  const rec = recording();
  const social = createSocialStore(rec.db);
  const world = jobDeps({ ...plain, social }, { now: at(0) });
  // Day 0 inserts the book; day 1 updates it.
  await createManagerValueJob(world.deps).run(new Date(at(0)));
  await createManagerValueJob(world.deps).run(new Date(at(1)));
  await social.writeTape(
    SEASON_1.id,
    dayAt(1),
    'v2',
    { name: SOCIAL_CURSOR.tape, body: JSON.stringify({ tapedDay: dayAt(1), missed: [] }) },
    at(1),
  );
  const a = ids[0] as string;
  const b = ids[1] as string;
  const [low, high] = a < b ? [a, b] : [b, a];
  await social.applyRivalryDay(
    {
      upserts: [
        {
          seasonId: SEASON_1.id,
          division: 'open',
          agentA: low,
          agentB: high,
          status: 'active',
          formedDay: dayAt(1),
          endedDay: null,
          endReason: null,
          leader: low,
          leadChanges: 0,
          lastDay: dayAt(1),
          series: [[dayAt(1), 1, 2]],
        },
      ],
      events: [
        {
          seasonId: SEASON_1.id,
          agentA: low,
          agentB: high,
          day: dayAt(1),
          seq: 0,
          kind: 'formed',
          subject: null,
          rankA: 1,
          rankB: 2,
          detail: { gap: 1, closeDays: 5, swaps: 1, windowDays: 5 },
        },
      ],
    },
    { name: SOCIAL_CURSOR.rivalry, body: JSON.stringify({ matchedDay: dayAt(1) }) },
    at(1),
  );
  const second = managerOf(2);
  await social.createManager(second, policyOf(second.id, 1, { [a]: 3000, [b]: 3000 }), {
    maxForOwner: 5,
    maxTotal: 250,
  });

  take('UPDATE_MANAGER_BOOKS', /^\s*UPDATE manager_books/, rec.sql);
  take('INSERT_MANAGER_BOOKS', /^\s*INSERT INTO manager_books/, rec.sql);
  take('INSERT_MANAGER_REBALANCES', /^\s*INSERT INTO manager_rebalances/, rec.sql);
  take('WRITE_TAPE_DAY', /^\s*INSERT INTO rivalry_days/, rec.sql);
  take('UPSERT_RIVALRIES', /^\s*INSERT INTO rivalries/, rec.sql);
  take('INSERT_RIVALRY_EVENTS', /^\s*INSERT INTO rivalry_events/, rec.sql);
  take('CREATE_MANAGER_CHECK', /^\s*SELECT \(\(SELECT count/, rec.sql);
  take('CREATE_MANAGER', /^\s*INSERT INTO managers/, rec.sql);
});

describe('query plans of the hardened statements', () => {
  for (const name of [
    'UPDATE_MANAGER_BOOKS',
    'INSERT_MANAGER_BOOKS',
    'INSERT_MANAGER_REBALANCES',
    'WRITE_TAPE_DAY',
    'UPSERT_RIVALRIES',
    'INSERT_RIVALRY_EVENTS',
    'CREATE_MANAGER_CHECK',
    'CREATE_MANAGER',
  ]) {
    it(`${name} reads every table by a key or a named index`, async () => {
      const plan = await planOf(statements.get(name) as Recorded);
      console.log(`${name}\n  ${plan.join('\n  ')}`);
      expect(plan.length).toBeGreaterThan(0);
      expect(tableScans(plan)).toEqual([]);
    });
  }

  it('counts open managers on index managers_public', async () => {
    const plan = await planOf(statements.get('CREATE_MANAGER_CHECK') as Recorded);
    expect(plan.some((line) => /managers_public/.test(line))).toBe(true);
  });
});
