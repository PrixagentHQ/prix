import { env } from 'cloudflare:workers';
import { TELEGRAM_WEBHOOK_MOVED_CURSOR } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTelegramWebhookWatch } from './webhook-watch.ts';

/**
 * The webhook's watch on job_state (docs/contracts/phase-6-holders.md section 7, H3-SEC-8).
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const db = (env as unknown as { DB: D1Database }).DB;
const T0 = '2026-10-16T13:13:00.000Z';
const T1 = '2026-10-16T14:13:00.000Z';

beforeEach(async () => {
  await db.prepare('DELETE FROM job_state WHERE name = ?1').bind(TELEGRAM_WEBHOOK_MOVED_CURSOR).run();
});

describe('TelegramWebhookWatch', () => {
  it('is not marked without a row, keeps the first time it was marked, and clears', async () => {
    const watch = createTelegramWebhookWatch(db, () => new Date(T1));
    expect(await watch.movedAt()).toBeNull();
    await watch.markMoved(T0);
    await watch.markMoved(T1);
    expect(await watch.movedAt()).toBe(T0);
    await watch.clear();
    expect(await watch.movedAt()).toBeNull();
    await watch.markMoved(T1);
    expect(await watch.movedAt()).toBe(T1);
  });

  it('answers null when the read fails', async () => {
    const broken = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('down')) }) }) };
    const watch = createTelegramWebhookWatch(broken as unknown as D1Database);
    expect(await watch.movedAt()).toBeNull();
  });
});
