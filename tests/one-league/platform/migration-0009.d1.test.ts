import { env } from 'cloudflare:workers';
import { ONE_LEAGUE_ENDS_AT } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * docs/CONTRACTS.md section 19: migration 0009 sets `ends_at` of season number 1 to
 * ONE_LEAGUE_ENDS_AT and changes nothing else. The test runs the migration's own statements, as
 * read from infra/migrations, on rows seeded after the schema is built.
 */
interface Migration {
  name: string;
  queries: string[];
}
interface SeasonRow {
  id: string;
  number: number;
  starts_at: string;
  ends_at: string;
}
const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Migration[] };
const db = bindings.DB;
const INSERT = 'INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?1, ?2, ?3, ?4)';

function migration0009(): Migration {
  const m = bindings.TEST_MIGRATIONS.find((x) => x.name.startsWith('0009_'));
  if (!m) throw new Error('migration 0009 not found');
  return m;
}

async function run0009(): Promise<void> {
  for (const sql of migration0009().queries) await db.prepare(sql).run();
}

async function seasons(): Promise<SeasonRow[]> {
  const { results } = await db
    .prepare('SELECT id, number, starts_at, ends_at FROM seasons ORDER BY number')
    .all<SeasonRow>();
  return results;
}

beforeEach(async () => {
  await db.prepare('DELETE FROM seasons').run();
});

describe('migration 0009_one_league', () => {
  it('is named 0009_one_league.sql', () => {
    expect(migration0009().name).toBe('0009_one_league.sql');
  });

  it('only updates the seasons table and depends on no Phase 6 table', () => {
    const text = migration0009()
      .queries.join('\n')
      .replace(/--[^\n]*/g, '');
    expect(text).toMatch(/UPDATE\s+seasons\b/i);
    expect(text).not.toMatch(/\b(CREATE|DROP|ALTER|INSERT|DELETE)\b/i);
    expect(text.match(/\bUPDATE\b/gi)?.length).toBe(1);
  });

  it('sets ends_at of season number 1 to ONE_LEAGUE_ENDS_AT and keeps its id and start', async () => {
    await db.prepare(INSERT).bind('season-1', 1, '2026-10-05T00:00:00.000Z', '2026-11-02T00:00:00.000Z').run();
    await run0009();
    expect(await seasons()).toEqual([
      { id: 'season-1', number: 1, starts_at: '2026-10-05T00:00:00.000Z', ends_at: ONE_LEAGUE_ENDS_AT },
    ]);
  });

  it('changes no other season', async () => {
    await db.batch([
      db.prepare(INSERT).bind('season-1', 1, '2026-10-05T00:00:00.000Z', '2026-11-02T00:00:00.000Z'),
      db.prepare(INSERT).bind('season-2', 2, '2030-01-01T00:00:00.000Z', '2030-02-01T00:00:00.000Z'),
    ]);
    await run0009();
    expect((await seasons())[1]).toEqual({
      id: 'season-2',
      number: 2,
      starts_at: '2030-01-01T00:00:00.000Z',
      ends_at: '2030-02-01T00:00:00.000Z',
    });
  });

  it('does nothing without seasons, and running it twice is harmless', async () => {
    await run0009();
    expect(await seasons()).toEqual([]);
    await db.prepare(INSERT).bind('season-1', 1, '2026-10-05T00:00:00.000Z', '2026-11-02T00:00:00.000Z').run();
    await run0009();
    await run0009();
    expect((await seasons())[0]?.ends_at).toBe(ONE_LEAGUE_ENDS_AT);
  });
});
