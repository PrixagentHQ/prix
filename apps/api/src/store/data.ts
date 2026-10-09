/**
 * The D1 implementation of DataStore (docs/contracts/phase-5-data.md section 2). Every limit is
 * decided in the statement that counts. Schema: infra/migrations/0005_data.sql.
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { DataStore } from '@prix/contracts';
import { DailyLimitError, USAGE_RETENTION_DAYS } from '@prix/contracts';

const KEY_COLUMNS = 'id, owner, key_hash, prefix, label, created_at, last_used_day, revoked_at';

const AUTHENTICATE_KEY = `
SELECT k.id, k.owner, k.last_used_day FROM api_keys k
WHERE k.key_hash = ?1 AND k.revoked_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM api_blocked b WHERE b.owner = k.owner)`;

const MARK_KEY_USED =
  'UPDATE api_keys SET last_used_day = ?2 WHERE id = ?1 AND (last_used_day IS NULL OR last_used_day < ?2)';

/** ?1 id, ?2 owner, ?3 hash, ?4 prefix, ?5 label, ?6 created at, ?7 max active, ?8 max creates today, ?9 day start, ?10 max creates all today. */
const CREATE_KEY = `
INSERT INTO api_keys (${KEY_COLUMNS})
SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM api_blocked WHERE owner = ?2)
  AND (SELECT COUNT(*) FROM api_keys WHERE owner = ?2 AND revoked_at IS NULL) < ?7
  AND (SELECT COUNT(*) FROM api_keys WHERE owner = ?2 AND created_at >= ?9) < ?8
  AND (SELECT COUNT(*) FROM api_keys WHERE created_at >= ?9) < ?10
RETURNING id`;

const KEY_REFUSAL = `
SELECT
  EXISTS (SELECT 1 FROM api_blocked WHERE owner = ?1) AS blocked,
  (SELECT COUNT(*) FROM api_keys WHERE owner = ?1 AND revoked_at IS NULL) AS active,
  (SELECT COUNT(*) FROM api_keys WHERE owner = ?1 AND created_at >= ?2) AS mine_today,
  (SELECT COUNT(*) FROM api_keys WHERE created_at >= ?2) AS all_today`;

const LIST_KEYS = `SELECT ${KEY_COLUMNS} FROM api_keys WHERE owner = ?1 ORDER BY created_at DESC, id`;
const REVOKE_KEY =
  'UPDATE api_keys SET revoked_at = ?3 WHERE id = ?1 AND owner = ?2 AND revoked_at IS NULL RETURNING id';

const METER_FREE = `
INSERT INTO api_usage (day, owner, free_n, paid_n) VALUES (?1, ?2, 1, 0)
ON CONFLICT (day, owner) DO UPDATE SET free_n = free_n + 1 WHERE free_n < ?3
RETURNING free_n, paid_n`;

const METER_PAID_CREDITS = `
UPDATE api_credits SET balance_micro = balance_micro - ?3
WHERE owner = ?2 AND balance_micro >= ?3
  AND COALESCE((SELECT paid_n FROM api_usage WHERE day = ?1 AND owner = ?2), 0) < ?4
RETURNING balance_micro`;

const METER_PAID_USAGE = `
INSERT INTO api_usage (day, owner, free_n, paid_n) SELECT ?1, ?2, 0, 1 WHERE changes() > 0
ON CONFLICT (day, owner) DO UPDATE SET paid_n = paid_n + 1
RETURNING free_n, paid_n`;

const METER_GLOBAL = `
INSERT INTO api_global (day, bucket, n) VALUES (?1, ?2, 1)
ON CONFLICT (day, bucket) DO UPDATE SET n = n + 1 WHERE n < ?3
RETURNING n`;

const METER_COUNTER = `
INSERT INTO counters (key, n, updated_at) VALUES (?1, 1, ?2)
ON CONFLICT (key) DO UPDATE SET n = n + 1, updated_at = excluded.updated_at WHERE n < ?3
RETURNING n`;

const REFUND_FREE = 'UPDATE api_usage SET free_n = free_n - 1 WHERE day = ?1 AND owner = ?2 AND free_n > 0';
const REFUND_PAID_CREDITS = `
UPDATE api_credits SET balance_micro = balance_micro + ?3
WHERE owner = ?2 AND COALESCE((SELECT paid_n FROM api_usage WHERE day = ?1 AND owner = ?2), 0) > 0`;
const REFUND_PAID_USAGE = 'UPDATE api_usage SET paid_n = paid_n - 1 WHERE day = ?1 AND owner = ?2 AND paid_n > 0';

const GET_USAGE = 'SELECT free_n, paid_n FROM api_usage WHERE day = ?1 AND owner = ?2';
const LIST_USAGE = `
SELECT day, free_n, paid_n FROM api_usage INDEXED BY api_usage_owner
WHERE owner = ?1 ORDER BY day DESC LIMIT ?2`;

const GET_CREDITS = 'SELECT balance_micro, bought_micro FROM api_credits WHERE owner = ?1';
const INSERT_PAYMENT =
  'INSERT INTO api_payments (tx_hash, owner, amount_micro, block_number, credited_at) VALUES (?1, ?2, ?3, ?4, ?5)';
const ADD_CREDITS = `
INSERT INTO api_credits (owner, balance_micro, bought_micro, updated_at) VALUES (?1, ?2, ?2, ?3)
ON CONFLICT (owner) DO UPDATE SET
  balance_micro = balance_micro + excluded.balance_micro,
  bought_micro = bought_micro + excluded.bought_micro,
  updated_at = excluded.updated_at`;
const GET_PAYMENT_OWNER = 'SELECT owner FROM api_payments WHERE tx_hash = ?1';
const LIST_PAYMENTS = `
SELECT tx_hash, owner, amount_micro, block_number, credited_at FROM api_payments
WHERE owner = ?1 ORDER BY credited_at DESC, tx_hash LIMIT ?2`;

const IS_BLOCKED = 'SELECT 1 AS found FROM api_blocked WHERE owner = ?1';
const BLOCK_WALLET = 'INSERT OR REPLACE INTO api_blocked (owner, reason, created_at) VALUES (?1, ?2, ?3)';
const REVOKE_ALL_KEYS = 'UPDATE api_keys SET revoked_at = ?2 WHERE owner = ?1 AND revoked_at IS NULL';
const UNBLOCK_WALLET = 'DELETE FROM api_blocked WHERE owner = ?1 RETURNING owner';

const PRUNE_USAGE = 'DELETE FROM api_usage WHERE day < ?1';
const PRUNE_GLOBAL = 'DELETE FROM api_global WHERE day < ?1';

interface KeyRow {
  id: string;
  owner: string;
  key_hash: string;
  prefix: string;
  label: string;
  created_at: string;
  last_used_day: string | null;
  revoked_at: string | null;
}

interface PaymentRow {
  tx_hash: string;
  owner: string;
  amount_micro: number;
  block_number: number;
  credited_at: string;
}

/** True if a database error says that a daily limit of the plan is used up. Mirrors the Phase 1 store. */
function isDailyLimitMessage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`.toLowerCase();
  if (!text.includes('d1')) return false;
  return /daily|per day|quota|free tier|free plan/.test(text) && /limit|exceed|quota/.test(text);
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`.toLowerCase();
  return text.includes('unique') || text.includes('constraint');
}

/** The UTC day `days` before `day` (YYYY-MM-DD). */
function dayBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function createDataStore(db: D1Database): DataStore {
  const stmt = (sql: string, ...values: unknown[]): D1PreparedStatement => db.prepare(sql).bind(...values);
  const first = <T>(sql: string, ...values: unknown[]): Promise<T | null> => stmt(sql, ...values).first<T>();
  const all = async <T>(sql: string, ...values: unknown[]): Promise<T[]> =>
    (await stmt(sql, ...values).all<T>()).results;

  const store: DataStore = {
    async authenticateKey(keyHash) {
      const row = await first<{ id: string; owner: string; last_used_day: string | null }>(AUTHENTICATE_KEY, keyHash);
      return row ? { keyId: row.id, owner: row.owner, lastUsedDay: row.last_used_day } : null;
    },

    async markKeyUsed(keyId, day) {
      await stmt(MARK_KEY_USED, keyId, day).run();
    },

    async createKey(key, limits) {
      const row = await first<{ id: string }>(
        CREATE_KEY,
        key.id,
        key.owner,
        key.keyHash,
        key.prefix,
        key.label,
        key.createdAt,
        limits.maxActive,
        limits.maxCreatesToday,
        limits.dayStart,
        limits.maxCreatesAllToday,
      );
      if (row) return 'created';
      const why = await first<{ blocked: number; active: number; mine_today: number; all_today: number }>(
        KEY_REFUSAL,
        key.owner,
        limits.dayStart,
      );
      if (why?.blocked) return 'blocked';
      if ((why?.active ?? 0) >= limits.maxActive) return 'key_limit_reached';
      if ((why?.mine_today ?? 0) >= limits.maxCreatesToday) return 'create_limit_reached';
      return 'ceiling_reached';
    },

    async listKeys(owner) {
      const rows = await all<KeyRow>(LIST_KEYS, owner);
      return rows.map((r) => ({
        id: r.id,
        owner: r.owner,
        keyHash: r.key_hash,
        prefix: r.prefix,
        label: r.label,
        createdAt: r.created_at,
        lastUsedDay: r.last_used_day,
        revokedAt: r.revoked_at,
      }));
    },

    async revokeKey(id, owner, now) {
      return (await first(REVOKE_KEY, id, owner, now)) !== null;
    },

    async meterFree(day, owner, quota) {
      if (quota < 1) return null;
      const row = await first<{ free_n: number; paid_n: number }>(METER_FREE, day, owner, quota);
      return row ? { freeN: row.free_n, paidN: row.paid_n } : null;
    },

    async meterPaid(day, owner, priceMicro, paidCap) {
      // One batch is one transaction. changes() in the second statement sees the first one.
      const [credits, usage] = await db.batch<Record<string, number>>([
        stmt(METER_PAID_CREDITS, day, owner, priceMicro, paidCap),
        stmt(METER_PAID_USAGE, day, owner),
      ]);
      const balance = credits?.results[0]?.balance_micro;
      const counts = usage?.results[0];
      if (balance === undefined || !counts) return null;
      return { usage: { freeN: counts.free_n ?? 0, paidN: counts.paid_n ?? 0 }, balanceMicro: balance };
    },

    async meterGlobal(day, bucket, ceiling) {
      const row = await first<{ n: number }>(METER_GLOBAL, day, bucket, ceiling);
      return row ? row.n : null;
    },

    async meterCounter(key, cap, now) {
      if (!/^d:\d{4}-\d{2}-\d{2}:/.test(key)) throw new Error('meterCounter: a key starts with d:<day>:');
      if (cap < 1) return false;
      const row = await first<{ n: number }>(METER_COUNTER, key, now, cap);
      return row !== null;
    },

    async refundCall(day, owner, kind, priceMicro) {
      if (kind === 'free') {
        await stmt(REFUND_FREE, day, owner).run();
        return;
      }
      await db.batch([stmt(REFUND_PAID_CREDITS, day, owner, priceMicro), stmt(REFUND_PAID_USAGE, day, owner)]);
    },

    async getUsage(day, owner) {
      const row = await first<{ free_n: number; paid_n: number }>(GET_USAGE, day, owner);
      return { freeN: row?.free_n ?? 0, paidN: row?.paid_n ?? 0 };
    },

    async listUsage(owner, limit) {
      const rows = await all<{ day: string; free_n: number; paid_n: number }>(LIST_USAGE, owner, limit);
      return rows.map((r) => ({ day: r.day, freeN: r.free_n, paidN: r.paid_n }));
    },

    async getCredits(owner) {
      const row = await first<{ balance_micro: number; bought_micro: number }>(GET_CREDITS, owner);
      return { balanceMicro: row?.balance_micro ?? 0, boughtMicro: row?.bought_micro ?? 0 };
    },

    async creditPayment(p) {
      try {
        await db.batch([
          stmt(INSERT_PAYMENT, p.txHash, p.owner, p.amountMicro, p.blockNumber, p.creditedAt),
          stmt(ADD_CREDITS, p.owner, p.amountMicro, p.creditedAt),
        ]);
        return 'credited';
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const row = await first<{ owner: string }>(GET_PAYMENT_OWNER, p.txHash);
        if (!row) throw error;
        return row.owner === p.owner ? 'already_credited' : 'taken';
      }
    },

    async listPayments(owner, limit) {
      const rows = await all<PaymentRow>(LIST_PAYMENTS, owner, limit);
      return rows.map((r) => ({
        txHash: r.tx_hash,
        owner: r.owner,
        amountMicro: r.amount_micro,
        blockNumber: r.block_number,
        creditedAt: r.credited_at,
      }));
    },

    async isBlocked(owner) {
      return (await first(IS_BLOCKED, owner)) !== null;
    },

    async blockWallet(owner, reason, now) {
      await db.batch([stmt(BLOCK_WALLET, owner, reason, now), stmt(REVOKE_ALL_KEYS, owner, now)]);
    },

    async unblockWallet(owner) {
      return (await first(UNBLOCK_WALLET, owner)) !== null;
    },

    async prune(today) {
      const cutoff = dayBefore(today, USAGE_RETENTION_DAYS);
      const results = await db.batch([stmt(PRUNE_USAGE, cutoff), stmt(PRUNE_GLOBAL, cutoff)]);
      return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
    },
  };

  return withDailyLimit(store);
}

/** Every method throws DailyLimitError for a used-up daily limit; any other error passes through unchanged. */
function withDailyLimit(store: DataStore): DataStore {
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(store)) {
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await (method as (...a: unknown[]) => unknown).apply(store, args);
      } catch (error) {
        throw isDailyLimitMessage(error) ? new DailyLimitError() : error;
      }
    };
  }
  return wrapped as unknown as DataStore;
}
