import type {
  Address,
  ApiKeyRecord,
  AuthenticatedKey,
  DataStore,
  GlobalBucket,
  PaymentRecord,
  UsageCounts,
  UtcDay,
} from '@prix/contracts';
import { USAGE_RETENTION_DAYS } from '@prix/contracts';

/**
 * An in-memory `DataStore` with the semantics of the SQL of docs/contracts/phase-5-data.md
 * section 2: every limit is decided in the same synchronous step that counts, a refusal writes
 * nothing, and a payment hash is credited once. tests/data/store.d1.test.ts runs the same
 * contract against this store and against the real D1 store, so the two cannot drift apart.
 */
export class MemoryDataStore implements DataStore {
  readonly keys = new Map<string, ApiKeyRecord>();
  readonly blocked = new Map<Address, { reason: string; createdAt: string }>();
  readonly usage = new Map<string, UsageCounts & { day: UtcDay; owner: Address }>();
  readonly global = new Map<string, number>();
  readonly credits = new Map<Address, { balanceMicro: number; boughtMicro: number }>();
  readonly payments = new Map<string, PaymentRecord>();
  /** Counts every write, so a test can say "a refusal wrote nothing". */
  writes = 0;

  private usageKey = (day: UtcDay, owner: Address): string => `${day}|${owner}`;

  /** Every table as one JSON text, for the test that looks for a secret in storage. */
  dump(): string {
    return JSON.stringify({
      keys: [...this.keys.values()],
      blocked: [...this.blocked],
      usage: [...this.usage.values()],
      global: [...this.global],
      credits: [...this.credits],
      payments: [...this.payments.values()],
    });
  }

  /** Every counter, for "a refused call changes no counter". */
  counters(): string {
    return JSON.stringify({
      usage: [...this.usage.values()],
      global: [...this.global],
      credits: [...this.credits],
    });
  }

  async authenticateKey(keyHash: string): Promise<AuthenticatedKey | null> {
    for (const key of this.keys.values()) {
      if (key.keyHash === keyHash && key.revokedAt === null && !this.blocked.has(key.owner)) {
        return { keyId: key.id, owner: key.owner, lastUsedDay: key.lastUsedDay };
      }
    }
    return null;
  }

  async markKeyUsed(keyId: string, day: UtcDay): Promise<void> {
    const key = this.keys.get(keyId);
    if (key !== undefined && (key.lastUsedDay === null || key.lastUsedDay < day)) {
      key.lastUsedDay = day;
      this.writes += 1;
    }
  }

  async createKey(
    key: ApiKeyRecord,
    limits: { maxActive: number; maxCreatesToday: number; maxCreatesAllToday: number; dayStart: string },
  ): Promise<'created' | 'key_limit_reached' | 'create_limit_reached' | 'ceiling_reached' | 'blocked'> {
    if (this.blocked.has(key.owner)) return 'blocked';
    const all = [...this.keys.values()];
    const mine = all.filter((entry) => entry.owner === key.owner);
    if (mine.filter((entry) => entry.revokedAt === null).length >= limits.maxActive) return 'key_limit_reached';
    if (mine.filter((entry) => entry.createdAt >= limits.dayStart).length >= limits.maxCreatesToday) {
      return 'create_limit_reached';
    }
    if (all.filter((entry) => entry.createdAt >= limits.dayStart).length >= limits.maxCreatesAllToday) {
      return 'ceiling_reached';
    }
    if (this.keys.has(key.id) || all.some((entry) => entry.keyHash === key.keyHash)) {
      throw new Error('MemoryDataStore: duplicate key');
    }
    this.keys.set(key.id, { ...key });
    this.writes += 1;
    return 'created';
  }

  async listKeys(owner: Address): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((entry) => entry.owner === owner)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((entry) => ({ ...entry }));
  }

  async revokeKey(id: string, owner: Address, now: string): Promise<boolean> {
    const key = this.keys.get(id);
    if (key === undefined || key.owner !== owner || key.revokedAt !== null) return false;
    key.revokedAt = now;
    this.writes += 1;
    return true;
  }

  async meterFree(day: UtcDay, owner: Address, quota: number): Promise<UsageCounts | null> {
    if (quota < 1) return null;
    const k = this.usageKey(day, owner);
    const row = this.usage.get(k);
    if (row === undefined) {
      this.usage.set(k, { day, owner, freeN: 1, paidN: 0 });
      this.writes += 1;
      return { freeN: 1, paidN: 0 };
    }
    if (row.freeN >= quota) return null;
    row.freeN += 1;
    this.writes += 1;
    return { freeN: row.freeN, paidN: row.paidN };
  }

  async meterPaid(
    day: UtcDay,
    owner: Address,
    priceMicro: number,
    paidCap: number,
  ): Promise<{ usage: UsageCounts; balanceMicro: number } | null> {
    const credit = this.credits.get(owner);
    const row = this.usage.get(this.usageKey(day, owner));
    if (credit === undefined || credit.balanceMicro < priceMicro || (row?.paidN ?? 0) >= paidCap) return null;
    credit.balanceMicro -= priceMicro;
    const next = row ?? { day, owner, freeN: 0, paidN: 0 };
    next.paidN += 1;
    this.usage.set(this.usageKey(day, owner), next);
    this.writes += 2;
    return { usage: { freeN: next.freeN, paidN: next.paidN }, balanceMicro: credit.balanceMicro };
  }

  async meterGlobal(day: UtcDay, bucket: GlobalBucket, ceiling: number): Promise<number | null> {
    const k = `${day}|${bucket}`;
    const n = this.global.get(k) ?? 0;
    if (n >= ceiling) return null;
    this.global.set(k, n + 1);
    this.writes += 1;
    return n + 1;
  }

  readonly dayCounters = new Map<string, number>();

  async meterCounter(key: string, cap: number, _now: string): Promise<boolean> {
    const n = this.dayCounters.get(key) ?? 0;
    if (n >= cap) return false;
    this.dayCounters.set(key, n + 1);
    this.writes += 1;
    return true;
  }

  async refundCall(day: UtcDay, owner: Address, kind: 'free' | 'paid', priceMicro: number): Promise<void> {
    const row = this.usage.get(this.usageKey(day, owner));
    if (kind === 'free') {
      if (row !== undefined && row.freeN > 0) {
        row.freeN -= 1;
        this.writes += 1;
      }
      return;
    }
    const credit = this.credits.get(owner) ?? { balanceMicro: 0, boughtMicro: 0 };
    credit.balanceMicro += priceMicro;
    this.credits.set(owner, credit);
    if (row !== undefined && row.paidN > 0) row.paidN -= 1;
    this.writes += 2;
  }

  async getUsage(day: UtcDay, owner: Address): Promise<UsageCounts> {
    const row = this.usage.get(this.usageKey(day, owner));
    return { freeN: row?.freeN ?? 0, paidN: row?.paidN ?? 0 };
  }

  async listUsage(owner: Address, limit: number): Promise<{ day: UtcDay; freeN: number; paidN: number }[]> {
    return [...this.usage.values()]
      .filter((row) => row.owner === owner)
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, limit)
      .map((row) => ({ day: row.day, freeN: row.freeN, paidN: row.paidN }));
  }

  async getCredits(owner: Address): Promise<{ balanceMicro: number; boughtMicro: number }> {
    const row = this.credits.get(owner);
    return { balanceMicro: row?.balanceMicro ?? 0, boughtMicro: row?.boughtMicro ?? 0 };
  }

  async creditPayment(payment: PaymentRecord): Promise<'credited' | 'already_credited' | 'taken'> {
    const existing = this.payments.get(payment.txHash);
    if (existing !== undefined) return existing.owner === payment.owner ? 'already_credited' : 'taken';
    this.payments.set(payment.txHash, { ...payment });
    const row = this.credits.get(payment.owner) ?? { balanceMicro: 0, boughtMicro: 0 };
    row.balanceMicro += payment.amountMicro;
    row.boughtMicro += payment.amountMicro;
    this.credits.set(payment.owner, row);
    this.writes += 2;
    return 'credited';
  }

  async listPayments(owner: Address, limit: number): Promise<PaymentRecord[]> {
    return [...this.payments.values()]
      .filter((entry) => entry.owner === owner)
      .sort((a, b) => (a.creditedAt < b.creditedAt ? 1 : a.creditedAt > b.creditedAt ? -1 : 0))
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async isBlocked(owner: Address): Promise<boolean> {
    return this.blocked.has(owner);
  }

  async blockWallet(owner: Address, reason: string, now: string): Promise<void> {
    this.blocked.set(owner, { reason, createdAt: now });
    for (const key of this.keys.values()) if (key.owner === owner && key.revokedAt === null) key.revokedAt = now;
    this.writes += 1;
  }

  async unblockWallet(owner: Address): Promise<boolean> {
    return this.blocked.delete(owner);
  }

  async prune(today: UtcDay): Promise<number> {
    const cutoff = new Date(Date.parse(`${today}T00:00:00.000Z`) - USAGE_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    let deleted = 0;
    for (const [k, row] of this.usage) {
      if (row.day < cutoff) {
        this.usage.delete(k);
        deleted += 1;
      }
    }
    for (const k of [...this.global.keys()]) {
      if ((k.split('|')[0] as string) < cutoff) {
        this.global.delete(k);
        deleted += 1;
      }
    }
    return deleted;
  }
}
