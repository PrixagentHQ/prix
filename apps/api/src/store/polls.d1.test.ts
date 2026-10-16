import { env } from 'cloudflare:workers';
import type { Address } from '@prix/contracts';
import { HOLDER_POLLS, POLL_MAX_VOTERS } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createOwnerHoldsStore } from './owner-holds.ts';
import { createPollStore } from './polls.ts';

/**
 * The holders' poll's D1 store and the owner's mark on a local D1 database, inside the Workers runtime:
 * the rules of docs/contracts/phase-6-holders.md section 4.2 that only SQL can get wrong.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const db = (env as unknown as { DB: D1Database }).DB;

const POLL = 'model-war-2-strategy';
const OTHER_POLL = 'other-poll';
const A = '0x00000000000000000000000000000000000000a1' as Address;
const B = '0x00000000000000000000000000000000000000b2' as Address;
const C = '0x00000000000000000000000000000000000000c3' as Address;
const D = '0x00000000000000000000000000000000000000d4' as Address;
const T0 = '2026-10-16T10:00:00.000Z';
const T1 = '2026-10-16T10:00:01.000Z';
const T2 = '2026-10-16T10:00:02.000Z';

interface Asked {
  statements: string[];
  batches: number;
}

function watched(): { db: D1Database; asked: Asked } {
  const asked: Asked = { statements: [], batches: 0 };
  const proxy = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          asked.statements.push(sql);
          return target.prepare(sql);
        };
      }
      if (name === 'batch') {
        return (list: D1PreparedStatement[]) => {
          asked.batches += 1;
          return target.batch(list);
        };
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, asked };
}

function isOneCall(asked: Asked): boolean {
  return asked.batches === 1 || (asked.batches === 0 && asked.statements.length === 1);
}

/** The rows' own count by option, to compare with poll_counts. */
async function groupBy(pollId: string): Promise<Record<string, number>> {
  const rows = await db
    .prepare('SELECT option_id, COUNT(*) AS n FROM poll_votes WHERE poll_id = ?1 GROUP BY option_id')
    .bind(pollId)
    .all<{ option_id: string; n: number }>();
  const out: Record<string, number> = {};
  for (const row of rows.results) out[row.option_id] = row.n;
  return out;
}

/** poll_counts without its zero rows, for comparison with the rows' group-by. */
async function counts(pollId: string): Promise<Record<string, number>> {
  const all = await createPollStore(db).castCounts(pollId);
  return Object.fromEntries(Object.entries(all).filter(([, n]) => n > 0));
}

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM poll_votes'),
    db.prepare('DELETE FROM poll_counts'),
    db.prepare('DELETE FROM poll_results'),
    db.prepare('DELETE FROM users'),
  ]);
});

describe('migration 0018', () => {
  it('adds users.show_holds with a default of 0 that takes only 0 and 1', async () => {
    await db.prepare("INSERT INTO users (address, created_at) VALUES (?1, '2026-10-16')").bind(A).run();
    const row = await db
      .prepare('SELECT show_holds FROM users WHERE address = ?1')
      .bind(A)
      .first<{ show_holds: number }>();
    expect(row?.show_holds).toBe(0);
    await expect(db.prepare('UPDATE users SET show_holds = 2 WHERE address = ?1').bind(A).run()).rejects.toThrow();
  });

  it('refuses a counted figure above the cast one', async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO poll_results (poll_id, option_id, cast_votes, counted, counted_at, first_block, last_block) VALUES ('p', 'o', 1, 2, ?1, 1, 1)",
        )
        .bind(T0)
        .run(),
    ).rejects.toThrow();
  });
});

describe('PollStore.putVote', () => {
  it('stores a new vote and its count in one batch', async () => {
    const { db: spy, asked } = watched();
    expect(await createPollStore(spy).putVote(POLL, A, 'index-core', T0, POLL_MAX_VOTERS)).toBe('stored');
    expect(asked.batches).toBe(1);
    expect(await groupBy(POLL)).toEqual({ 'index-core': 1 });
    expect(await counts(POLL)).toEqual({ 'index-core': 1 });
  });

  it('moves the count on a change, nets zero on the same option, and changes back', async () => {
    const store = createPollStore(db);
    await store.putVote(POLL, A, 'index-core', T0, POLL_MAX_VOTERS);
    await store.putVote(POLL, B, 'index-core', T0, POLL_MAX_VOTERS);
    expect(await store.putVote(POLL, A, 'dip-buyer', T1, POLL_MAX_VOTERS)).toBe('stored');
    expect(await counts(POLL)).toEqual({ 'index-core': 1, 'dip-buyer': 1 });
    expect(await counts(POLL)).toEqual(await groupBy(POLL));
    await store.putVote(POLL, A, 'dip-buyer', T2, POLL_MAX_VOTERS);
    expect(await counts(POLL)).toEqual({ 'index-core': 1, 'dip-buyer': 1 });
    await store.putVote(POLL, A, 'index-core', T2, POLL_MAX_VOTERS);
    expect(await counts(POLL)).toEqual({ 'index-core': 2 });
    expect(await counts(POLL)).toEqual(await groupBy(POLL));
    expect(await store.getVote(POLL, A)).toBe('index-core');
    const row = await db
      .prepare('SELECT created_at FROM poll_votes WHERE poll_id = ?1 AND wallet = ?2')
      .bind(POLL, A)
      .first<{ created_at: string }>();
    expect(row?.created_at).toBe(T2);
  });

  it('answers full for a new wallet at the cap, while a voter at the cap still changes', async () => {
    const store = createPollStore(db);
    expect(await store.putVote(POLL, A, 'index-core', T0, 2)).toBe('stored');
    expect(await store.putVote(POLL, B, 'index-core', T0, 2)).toBe('stored');
    expect(await store.putVote(POLL, C, 'index-core', T0, 2)).toBe('full');
    expect(await store.getVote(POLL, C)).toBeNull();
    expect(await store.putVote(POLL, B, 'momentum-five', T1, 2)).toBe('stored');
    expect(await counts(POLL)).toEqual({ 'index-core': 1, 'momentum-five': 1 });
    expect(await counts(POLL)).toEqual(await groupBy(POLL));
  });

  it('stores one of two concurrent new votes one below the cap', async () => {
    const store = createPollStore(db);
    await store.putVote(POLL, A, 'index-core', T0, 2);
    const answers = await Promise.all([
      store.putVote(POLL, B, 'dip-buyer', T1, 2),
      store.putVote(POLL, C, 'dip-buyer', T1, 2),
    ]);
    expect(answers.filter((a) => a === 'stored')).toHaveLength(1);
    expect(answers.filter((a) => a === 'full')).toHaveLength(1);
    expect(await counts(POLL)).toEqual(await groupBy(POLL));
  });

  it('keeps polls apart: the cap and the counts are a poll’s own', async () => {
    const store = createPollStore(db);
    await store.putVote(OTHER_POLL, A, 'x1', T0, 1);
    expect(await store.putVote(POLL, A, 'index-core', T0, 1)).toBe('stored');
    expect(await counts(POLL)).toEqual({ 'index-core': 1 });
    expect(await counts(OTHER_POLL)).toEqual({ x1: 1 });
  });
});

describe('PollStore reads', () => {
  it('getVote and castCounts are one statement each', async () => {
    await createPollStore(db).putVote(POLL, A, 'index-core', T0, POLL_MAX_VOTERS);
    const one = watched();
    expect(await createPollStore(one.db).getVote(POLL, A)).toBe('index-core');
    expect(await createPollStore(one.db).getVote(POLL, B)).toBeNull();
    expect(one.asked.statements).toHaveLength(2);
    const two = watched();
    expect(await createPollStore(two.db).castCounts(POLL)).toEqual({ 'index-core': 1 });
    expect(isOneCall(two.asked)).toBe(true);
  });

  it('listVoters pages by wallet after a cursor and leaves out votes made at or after before', async () => {
    const store = createPollStore(db);
    await store.putVote(POLL, C, 'dip-buyer', T0, POLL_MAX_VOTERS);
    await store.putVote(POLL, A, 'index-core', T0, POLL_MAX_VOTERS);
    await store.putVote(POLL, B, 'index-core', T0, POLL_MAX_VOTERS);
    await store.putVote(POLL, D, 'index-core', T2, POLL_MAX_VOTERS);
    const { db: spy, asked } = watched();
    const first = await createPollStore(spy).listVoters(POLL, null, T1, 2);
    expect(first).toEqual([
      { wallet: A, option: 'index-core' },
      { wallet: B, option: 'index-core' },
    ]);
    expect(isOneCall(asked)).toBe(true);
    const second = await store.listVoters(POLL, B, T1, 2);
    expect(second).toEqual([{ wallet: C, option: 'dip-buyer' }]);
    expect(await store.listVoters(POLL, C, T1, 2)).toEqual([]);
  });
});

describe('PollStore results', () => {
  const poll = HOLDER_POLLS[0];
  if (poll === undefined) throw new Error('No poll in HOLDER_POLLS.');
  const result = {
    pollId: poll.id,
    cast: { 'big-tech-equal': 0, 'index-core': 3, 'momentum-five': 1, 'dip-buyer': 3 },
    counted: { 'big-tech-equal': 0, 'index-core': 2, 'momentum-five': 1, 'dip-buyer': 2 },
    leaders: ['index-core', 'dip-buyer'],
    countedAt: T2,
    firstBlock: 90_000_000,
    lastBlock: 90_000_000,
  };

  it('writes a result once, in one batch, and reads it back with its leaders', async () => {
    const { db: spy, asked } = watched();
    expect(await createPollStore(spy).putResult(result)).toBe(true);
    expect(asked.batches).toBe(1);
    expect(await createPollStore(db).putResult({ ...result, countedAt: T0 })).toBe(false);
    const read = watched();
    const back = await createPollStore(read.db).getResults([poll.id, OTHER_POLL]);
    expect(isOneCall(read.asked)).toBe(true);
    expect(back).toEqual([result]);
    expect(await createPollStore(db).getResults([])).toEqual([]);
  });

  it('deleteVotes deletes at most its limit and never the counts or the result', async () => {
    const store = createPollStore(db);
    for (const wallet of [A, B, C]) await store.putVote(POLL, wallet, 'index-core', T0, POLL_MAX_VOTERS);
    await store.putResult(result);
    const { db: spy, asked } = watched();
    expect(await createPollStore(spy).deleteVotes(POLL, 2)).toBe(2);
    expect(isOneCall(asked)).toBe(true);
    expect(await store.listVoters(POLL, null, T2, 10)).toEqual([{ wallet: C, option: 'index-core' }]);
    expect(await store.deleteVotes(POLL, 2)).toBe(1);
    expect(await store.deleteVotes(POLL, 2)).toBe(0);
    expect(await store.castCounts(POLL)).toEqual({ 'index-core': 3 });
    expect(await store.getResults([POLL])).toHaveLength(1);
  });

  it('pruneVoters deletes the named voters and takes each from its count, in one batch', async () => {
    const store = createPollStore(db);
    await store.putVote(POLL, A, 'index-core', T0, POLL_MAX_VOTERS);
    await store.putVote(POLL, B, 'index-core', T0, POLL_MAX_VOTERS);
    await store.putVote(POLL, C, 'dip-buyer', T0, POLL_MAX_VOTERS);
    await store.putVote(OTHER_POLL, A, 'x1', T0, POLL_MAX_VOTERS);
    const { db: spy, asked } = watched();
    expect(await createPollStore(spy).pruneVoters(POLL, [A, C, D])).toBe(2);
    expect(asked.batches).toBe(1);
    expect(await counts(POLL)).toEqual({ 'index-core': 1 });
    expect(await counts(POLL)).toEqual(await groupBy(POLL));
    expect(await counts(OTHER_POLL)).toEqual({ x1: 1 });
    expect(await store.pruneVoters(POLL, [])).toBe(0);
    expect(await store.putVote(POLL, A, 'momentum-five', T1, POLL_MAX_VOTERS)).toBe('stored');
    expect(await counts(POLL)).toEqual(await groupBy(POLL));
  });
});

describe('OwnerHoldsStore', () => {
  it('reads false without a row, and sets and clears the choice with one statement each', async () => {
    const { db: spy, asked } = watched();
    const store = createOwnerHoldsStore(spy);
    expect(await store.getShowHolds(A)).toBe(false);
    await store.setShowHolds(A, true, T0);
    expect(await store.getShowHolds(A)).toBe(true);
    await store.setShowHolds(A, false, T1);
    expect(await store.getShowHolds(A)).toBe(false);
    expect(asked.batches).toBe(0);
    expect(asked.statements).toHaveLength(5);
  });

  it('keeps an existing row’s created_at and write count', async () => {
    await db
      .prepare("INSERT INTO users (address, created_at, write_day, write_count) VALUES (?1, ?2, '2026-10-16', 4)")
      .bind(B, T0)
      .run();
    await createOwnerHoldsStore(db).setShowHolds(B, true, T2);
    const row = await db
      .prepare('SELECT created_at, write_count, show_holds FROM users WHERE address = ?1')
      .bind(B)
      .first<{ created_at: string; write_count: number; show_holds: number }>();
    expect(row).toEqual({ created_at: T0, write_count: 4, show_holds: 1 });
  });
});
