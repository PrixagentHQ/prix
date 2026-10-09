import { env } from 'cloudflare:workers';
import { CREATION_PERIOD_DAYS, creationPeriod } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createReputationStore } from '../../../apps/api/src/store/reputation.ts';

/**
 * docs/CONTRACTS.md section 19 on a local D1 database: the clean-up of counters removes the
 * `p:<period>:` counters of periods before `creationPeriod(day)`, beside the day counters it
 * removed before, keeps the current period's, and stays bounded by its limit.
 */
const db = (env as unknown as { DB: D1Database }).DB;
const store = createReputationStore(db);

const DAY = '2026-10-08';
const NOW = '2026-10-08T03:00:00.000Z';
const CURRENT = creationPeriod(DAY);
const DAY_MS = 86_400_000;

async function put(...keys: string[]): Promise<void> {
  await db.batch(
    keys.map((k) => db.prepare('INSERT INTO counters (key, n, updated_at) VALUES (?1, 1, ?2)').bind(k, NOW)),
  );
}

async function keys(): Promise<string[]> {
  const { results } = await db.prepare('SELECT key FROM counters ORDER BY key').all<{ key: string }>();
  return results.map((r) => r.key);
}

beforeEach(async () => {
  await db.prepare('DELETE FROM counters').run();
});

describe('deleteOldCounters and period counters', () => {
  it('removes counters of earlier periods and keeps the current and later ones', async () => {
    await put(
      `p:${CURRENT - 1}:net:a`,
      `p:${CURRENT - 2}:net:b`,
      `p:${CURRENT}:net:a`,
      `p:${CURRENT + 1}:net:a`,
      'd:2026-10-07:x',
      `d:${DAY}:x`,
    );
    expect(await store.deleteOldCounters(DAY, 50)).toBe(3);
    expect(await keys()).toEqual([`d:${DAY}:x`, `p:${CURRENT}:net:a`, `p:${CURRENT + 1}:net:a`].sort());
  });

  it('compares periods as numbers, not as text', async () => {
    // In text order 'p:7399:' sorts before 'p:740:'. Only the number may decide.
    const later = CURRENT * 10 + 9; // more digits and larger: stays
    const shorter = Math.floor(CURRENT / 10); // fewer digits and smaller: goes
    await put(`p:${later}:net:a`, `p:${shorter}:net:a`, `p:${CURRENT}:net:a`);
    expect(await store.deleteOldCounters(DAY, 50)).toBe(1);
    expect(await keys()).toEqual([`p:${CURRENT}:net:a`, `p:${later}:net:a`].sort());
  });

  it('a period starts on its first day: the day before belongs to the period before', async () => {
    const firstDay = new Date(CURRENT * CREATION_PERIOD_DAYS * DAY_MS).toISOString().slice(0, 10);
    const dayBefore = new Date((CURRENT * CREATION_PERIOD_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
    await put(`p:${CURRENT - 1}:net:a`);
    expect(await store.deleteOldCounters(dayBefore, 50)).toBe(0);
    expect(await store.deleteOldCounters(firstDay, 50)).toBe(1);
  });

  it('never deletes more than the limit across day and period counters', async () => {
    await put('d:2026-10-01:a', 'd:2026-10-02:a', `p:${CURRENT - 1}:a`, `p:${CURRENT - 1}:b`, `p:${CURRENT - 2}:a`);
    expect(await store.deleteOldCounters(DAY, 3)).toBe(3);
    expect((await keys()).length).toBe(2);
    expect(await store.deleteOldCounters(DAY, 3)).toBe(2);
    expect(await keys()).toEqual([]);
  });

  it('leaves season counters of seasons that are not frozen alone', async () => {
    await put('s:season-1:net:a');
    expect(await store.deleteOldCounters(DAY, 50)).toBe(0);
    expect(await keys()).toEqual(['s:season-1:net:a']);
  });
});

describe('takeCounter with period keys', () => {
  it('takes a counter of the current period up to its cap', async () => {
    const key = `p:${CURRENT}:net:a`;
    expect(await store.takeCounter(key, 2, DAY, NOW)).toBe(true);
    expect(await store.takeCounter(key, 2, DAY, NOW)).toBe(true);
    expect(await store.takeCounter(key, 2, DAY, NOW)).toBe(false);
  });

  it('refuses a period key of another period', async () => {
    await expect(store.takeCounter(`p:${CURRENT - 1}:net:a`, 2, DAY, NOW)).rejects.toThrow();
  });
});
