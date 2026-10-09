import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { createReputationStore } from '../../apps/api/src/store/reputation.ts';
import { makeAgent, SEASON_1, startingPortfolio, startingStats } from '../support/fixtures.ts';

/**
 * The record of an agent that has no season_scores row yet names the scoring method of the newest
 * season of the league (agentTrackRecordSchema.method), not a fixed v2: v1 when that season has no
 * season_methods row (D-109), and the row's method when it has one.
 */
const db = (env as unknown as { DB: D1Database }).DB;
const store = createD1Store(db);
const reputation = createReputationStore(db);

const V2 = { id: 'seasontwoaaa', number: 2, startsAt: '2026-11-02T00:00:00.000Z', endsAt: '2026-12-28T00:00:00.000Z' };

beforeAll(async () => {
  await db.prepare('DELETE FROM season_methods').run();
  await db
    .prepare('INSERT OR IGNORE INTO seasons (id, number, starts_at, ends_at) VALUES (?, ?, ?, ?)')
    .bind(SEASON_1.id, SEASON_1.number, SEASON_1.startsAt, SEASON_1.endsAt)
    .run();
});

describe('the empty track record names the method of the newest season', () => {
  it('is v1 for an unscored agent when the newest season has no season_methods row', async () => {
    const agent = makeAgent({ n: 901 });
    expect(await store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 500, 500)).toBe('created');
    const record = await reputation.getTrackRecord(agent.id);
    expect(record?.seasons).toEqual([]);
    expect(record?.method).toBe('v1');
  });

  it('is v2 for an unscored agent when the newest season has a v2 row', async () => {
    expect(await reputation.putSeason(V2, 'v2', 56)).toBe(true);
    const agent = makeAgent({ n: 902 });
    expect(await store.createAgent(agent, V2.id, startingPortfolio(), startingStats(), 500, 500)).toBe('created');
    const record = await reputation.getTrackRecord(agent.id);
    expect(record?.seasons).toEqual([]);
    expect(record?.method).toBe('v2');
  });
});
