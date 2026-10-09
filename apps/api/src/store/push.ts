import type { D1Database } from '@cloudflare/workers-types';
import type { PushStore, PushSubscriptionRow } from '@prix/contracts';

/** The D1 implementation of `PushStore`. The schema is infra/migrations/0007_push.sql. */

/** SHA-256 of an endpoint, in hex. */
export async function endpointId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Row {
  id: string;
  address: string;
  endpoint: string;
  created_at: string;
  last_pushed_at: string | null;
}

export function createPushStore(db: D1Database): PushStore {
  return {
    async addSubscription(address, endpoint, now, max) {
      const id = await endpointId(endpoint);
      await db.batch([
        db
          .prepare(
            `INSERT INTO push_subscriptions (id, address, endpoint, created_at, last_pushed_at) VALUES (?1, ?2, ?3, ?4, NULL)
             ON CONFLICT (id) DO UPDATE SET address = excluded.address, created_at = excluded.created_at`,
          )
          .bind(id, address, endpoint, now),
        db
          .prepare(
            `DELETE FROM push_subscriptions WHERE address = ?1 AND id NOT IN (
               SELECT id FROM push_subscriptions WHERE address = ?1 ORDER BY created_at DESC, id ASC LIMIT ?2)`,
          )
          .bind(address, max),
      ]);
    },
    async removeSubscription(address, endpoint) {
      await db
        .prepare('DELETE FROM push_subscriptions WHERE id = ?1 AND address = ?2')
        .bind(await endpointId(endpoint), address)
        .run();
    },
    async listSubscriptions(address) {
      const result = await db
        .prepare(
          'SELECT id, address, endpoint, created_at, last_pushed_at FROM push_subscriptions WHERE address = ?1 ORDER BY created_at ASC',
        )
        .bind(address)
        .all<Row>();
      return result.results.map(
        (row): PushSubscriptionRow => ({
          id: row.id,
          address: row.address,
          endpoint: row.endpoint,
          createdAt: row.created_at,
          lastPushedAt: row.last_pushed_at,
        }),
      );
    },
    async removeByEndpoint(endpoint) {
      await db
        .prepare('DELETE FROM push_subscriptions WHERE id = ?1')
        .bind(await endpointId(endpoint))
        .run();
    },
    async markAccepted(endpoint, now) {
      await db
        .prepare('UPDATE push_subscriptions SET last_pushed_at = ?2 WHERE id = ?1')
        .bind(await endpointId(endpoint), now)
        .run();
    },
  };
}
