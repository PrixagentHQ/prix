import type { D1Database } from '@cloudflare/workers-types';
import type { IsoTime, TelegramWebhookWatch } from '@prix/contracts';
import { isoTimeSchema, TELEGRAM_WEBHOOK_MOVED_CURSOR } from '@prix/contracts';

/**
 * The webhook's watch (docs/contracts/phase-6-holders.md section 7, revision 4, H3-SEC-8) on job_state: the
 * row TELEGRAM_WEBHOOK_MOVED_CURSOR holds the UTC time the watchdog first saw the webhook moved, and an empty
 * body while it is not. One statement a call. A read that fails answers null, as the contract says.
 */
const READ_SQL = 'SELECT body FROM job_state WHERE name = ?1';
/** Writes the time only while the row is absent or empty, so the first time seen is kept. */
const MARK_SQL = `INSERT INTO job_state (name, body, updated_at) VALUES (?1, ?2, ?2)
ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at WHERE job_state.body = ''`;
const CLEAR_SQL = `INSERT INTO job_state (name, body, updated_at) VALUES (?1, '', ?2)
ON CONFLICT (name) DO UPDATE SET body = '', updated_at = excluded.updated_at`;

export function createTelegramWebhookWatch(db: D1Database, now: () => Date = () => new Date()): TelegramWebhookWatch {
  return {
    async movedAt(): Promise<IsoTime | null> {
      try {
        const row = await db.prepare(READ_SQL).bind(TELEGRAM_WEBHOOK_MOVED_CURSOR).first<{ body: string }>();
        const parsed = isoTimeSchema.safeParse(row?.body ?? '');
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async markMoved(at: IsoTime): Promise<void> {
      await db.prepare(MARK_SQL).bind(TELEGRAM_WEBHOOK_MOVED_CURSOR, at).run();
    },
    async clear(): Promise<void> {
      await db.prepare(CLEAR_SQL).bind(TELEGRAM_WEBHOOK_MOVED_CURSOR, now().toISOString()).run();
    },
  };
}
