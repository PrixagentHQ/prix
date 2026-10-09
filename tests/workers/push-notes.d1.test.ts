import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createFollowStore } from '../../apps/api/src/store/follow.ts';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { createPushStore } from '../../apps/api/src/store/push.ts';
import { runEmitStep } from '../../packages/runtime/src/follow/emit.ts';
import {
  makeAgent,
  makeRow,
  makeTick,
  SEASON_1,
  startingPortfolio,
  startingStats,
  testAddress,
  utc,
} from '../support/fixtures.ts';

/** A push-only wallet gets a queued note and a due note with chat id 0; a wallet with neither gets nothing. */
const db = (env as unknown as { DB: D1Database }).DB;

describe('notes for a wallet with a push subscription and no Telegram chat', () => {
  it('queues and lists one note for the push wallet only', async () => {
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all<{ name: string }>();
    for (const { name } of tables.results) {
      if (!name.startsWith('_cf_')) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
    }
    const bindings = env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
    await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
    await db
      .prepare('INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?, ?, ?, ?)')
      .bind(SEASON_1.id, SEASON_1.number, SEASON_1.startsAt, SEASON_1.endsAt)
      .run();

    const store = createD1Store(db);
    const follow = createFollowStore(db);
    const push = createPushStore(db);
    const agent = makeAgent({ n: 1, createdAt: '2026-10-05T01:00:00.000Z' });
    expect(await store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 200)).toBe('created');

    const pushWallet = testAddress(900);
    const bareWallet = testAddress(901);
    const now = '2026-10-06T12:00:00.000Z';
    await push.addSubscription(pushWallet, 'https://push.example/one', now, 5);
    expect(await follow.putFollow(pushWallet, agent.id, true, now, 50)).toBe('created');
    expect(await follow.putFollow(bareWallet, agent.id, true, now, 50)).toBe('created');

    // The first run only initialises the emitter at the latest complete tick.
    const t1 = makeTick(utc('2026-10-06T14:00:00.000Z'), { status: 'complete' });
    await store.createTick(t1);
    const deps = { store: follow, log: () => {} };
    await runEmitStep(deps, utc('2026-10-06T14:05:00.000Z'));
    expect((await follow.getEmitState()).doneTickId).toBe(t1.id);

    const t2 = makeTick(utc('2026-10-06T15:00:00.000Z'), { status: 'complete' });
    await store.createTick(t2);
    const row = makeRow({ agent, tickId: t2.id, status: 'decided', fillCount: 1 });
    expect(await store.writeDecision(row, startingStats(), 0)).toBe(true);

    const report = await runEmitStep(deps, utc('2026-10-06T15:05:00.000Z'));
    expect(report.queued).toBe(1);
    const due = await follow.listDueNotices(10);
    expect(due).toHaveLength(1);
    expect(due[0]?.address).toBe(pushWallet);
    expect(due[0]?.chatId).toBe(0);
  });
});
