import type { ApiKeyRecord, DataStore } from '@prix/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The guarantees of docs/contracts/phase-5-data.md section 2 that the in-memory `DataStore` of the
 * tests and the real D1 store must both keep. tests/data/store.d1.test.ts runs it against both.
 */

const DAY = '2026-10-06';
const DAY_START = '2026-10-06T00:00:00.000Z';
const NOW = '2026-10-06T14:00:00.000Z';
const A = `0x${'a1'.repeat(20)}`;
const B = `0x${'b2'.repeat(20)}`;

let counter = 0;
function keyOf(owner: string, createdAt = NOW): ApiKeyRecord {
  counter += 1;
  const n = counter.toString(16).padStart(64, '0');
  return {
    id: `key${counter.toString().padStart(9, '0')}`,
    owner,
    keyHash: n,
    prefix: `prix_${n.slice(-7)}`,
    label: `k${counter}`,
    createdAt,
    lastUsedDay: null,
    revokedAt: null,
  };
}
const LIMITS = { maxActive: 5, maxCreatesToday: 5, maxCreatesAllToday: 500, dayStart: DAY_START };
const payment = (txHash: string, owner: string, amountMicro = 1_000_000) => ({
  txHash,
  owner,
  amountMicro,
  blockNumber: 10,
  creditedAt: NOW,
});
const HASH_1 = `0x${'01'.repeat(32)}`;
const HASH_2 = `0x${'02'.repeat(32)}`;

export function describeDataStoreContract(name: string, make: () => Promise<DataStore>): void {
  describe(name, () => {
    it('two meterFree calls at quota minus one admit exactly one', async () => {
      const store = await make();
      for (let i = 0; i < 4; i += 1) expect(await store.meterFree(DAY, A, 5)).not.toBeNull();
      const results = await Promise.all([store.meterFree(DAY, A, 5), store.meterFree(DAY, A, 5)]);
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      expect(await store.getUsage(DAY, A)).toEqual({ freeN: 5, paidN: 0 });
    });

    it('twenty concurrent meterFree calls on a fresh wallet admit exactly the quota', async () => {
      const store = await make();
      const results = await Promise.all(Array.from({ length: 20 }, () => store.meterFree(DAY, A, 7)));
      expect(results.filter((r) => r !== null)).toHaveLength(7);
      expect((await store.getUsage(DAY, A)).freeN).toBe(7);
    });

    it('meterFree with a quota below 1 admits nothing and writes no row', async () => {
      const store = await make();
      expect(await store.meterFree(DAY, A, 0)).toBeNull();
      expect(await store.listUsage(A, 10)).toEqual([]);
    });

    it('meterGlobal admits exactly the ceiling under concurrency, per bucket', async () => {
      const store = await make();
      const results = await Promise.all(Array.from({ length: 12 }, () => store.meterGlobal(DAY, 'api', 5)));
      expect(results.filter((r) => r !== null)).toHaveLength(5);
      expect(await store.meterGlobal(DAY, 'page', 1)).toBe(1);
      expect(await store.meterGlobal(DAY, 'page', 1)).toBeNull();
    });

    it('creditPayment twice credits once, and concurrent submissions credit once', async () => {
      const store = await make();
      expect(await store.creditPayment(payment(HASH_1, A))).toBe('credited');
      expect(await store.creditPayment(payment(HASH_1, A))).toBe('already_credited');
      expect(await store.creditPayment(payment(HASH_1, B))).toBe('taken');
      expect(await store.getCredits(A)).toEqual({ balanceMicro: 1_000_000, boughtMicro: 1_000_000 });
      expect(await store.getCredits(B)).toEqual({ balanceMicro: 0, boughtMicro: 0 });

      const owners = [A, A, B, A, B];
      const results = await Promise.all(owners.map((owner) => store.creditPayment(payment(HASH_2, owner, 3_000_000))));
      expect(results.filter((r) => r === 'credited')).toHaveLength(1);
      const winner = owners[results.indexOf('credited')] as string;
      expect((await store.getCredits(winner)).balanceMicro).toBeGreaterThanOrEqual(3_000_000);
      const total = (await store.getCredits(A)).balanceMicro + (await store.getCredits(B)).balanceMicro;
      expect(total).toBe(1_000_000 + 3_000_000);
      expect(await store.listPayments(A, 10)).toHaveLength(winner === A ? 2 : 1);
    });

    it('createKey never exceeds the active-key limit, the daily limit, or the ceiling, whatever the concurrency', async () => {
      const active = await make();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => active.createKey(keyOf(A), { ...LIMITS, maxCreatesToday: 100 })),
      );
      expect(results.filter((r) => r === 'created')).toHaveLength(5);
      expect(results.filter((r) => r === 'key_limit_reached')).toHaveLength(5);
      expect(await active.listKeys(A)).toHaveLength(5);

      const daily = await make();
      const dailyResults = await Promise.all(
        Array.from({ length: 8 }, () => daily.createKey(keyOf(B), { ...LIMITS, maxActive: 100, maxCreatesToday: 3 })),
      );
      expect(dailyResults.filter((r) => r === 'created')).toHaveLength(3);
      expect(dailyResults.filter((r) => r === 'create_limit_reached')).toHaveLength(5);

      const ceiling = await make();
      const wallets = Array.from({ length: 6 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
      const ceilingResults = await Promise.all(
        wallets.map((owner) => ceiling.createKey(keyOf(owner), { ...LIMITS, maxCreatesAllToday: 4 })),
      );
      expect(ceilingResults.filter((r) => r === 'created')).toHaveLength(4);
      expect(ceilingResults.filter((r) => r === 'ceiling_reached')).toHaveLength(2);
    });

    it('a revoked key frees a slot of the active limit but not of the daily one', async () => {
      const store = await make();
      const first = keyOf(A);
      for (let i = 0; i < 4; i += 1) await store.createKey(keyOf(A), LIMITS);
      expect(await store.createKey(first, LIMITS)).toBe('created');
      expect(await store.createKey(keyOf(A), LIMITS)).toBe('key_limit_reached');
      expect(await store.revokeKey(first.id, A, NOW)).toBe(true);
      expect(await store.revokeKey(first.id, A, NOW)).toBe(false);
      expect(await store.revokeKey(first.id, B, NOW)).toBe(false);
      // Five were created today, so the daily limit now refuses even though a slot is free.
      expect(await store.createKey(keyOf(A), LIMITS)).toBe('create_limit_reached');
      expect((await store.listKeys(A)).find((k) => k.id === first.id)?.revokedAt).toBe(NOW);
    });

    it('authenticateKey finds a live key by its hash, and not a revoked key or a blocked wallet', async () => {
      const store = await make();
      const live = keyOf(A);
      const other = keyOf(B);
      await store.createKey(live, LIMITS);
      await store.createKey(other, LIMITS);
      expect(await store.authenticateKey(live.keyHash)).toEqual({ keyId: live.id, owner: A, lastUsedDay: null });
      expect(await store.authenticateKey('0'.repeat(64))).toBeNull();
      await store.revokeKey(live.id, A, NOW);
      expect(await store.authenticateKey(live.keyHash)).toBeNull();
      expect(await store.authenticateKey(other.keyHash)).not.toBeNull();
      await store.blockWallet(B, 'test', NOW);
      expect(await store.authenticateKey(other.keyHash)).toBeNull();
      expect(await store.isBlocked(B)).toBe(true);
      expect(await store.createKey(keyOf(B), LIMITS)).toBe('blocked');
      expect(await store.unblockWallet(B)).toBe(true);
      expect(await store.unblockWallet(B)).toBe(false);
      // Unblocking does not bring a revoked key back.
      expect(await store.authenticateKey(other.keyHash)).toBeNull();
    });

    it('markKeyUsed sets the day once and never moves it back', async () => {
      const store = await make();
      const key = keyOf(A);
      await store.createKey(key, LIMITS);
      await store.markKeyUsed(key.id, '2026-10-06');
      await store.markKeyUsed(key.id, '2026-10-05');
      expect((await store.authenticateKey(key.keyHash))?.lastUsedDay).toBe('2026-10-06');
      await store.markKeyUsed(key.id, '2026-10-07');
      expect((await store.authenticateKey(key.keyHash))?.lastUsedDay).toBe('2026-10-07');
    });

    describe('meterPaid', () => {
      it('takes the price and counts one paid call, and leaves everything unchanged when it refuses', async () => {
        const store = await make();
        await store.creditPayment(payment(HASH_1, A, 2_500));
        const first = await store.meterPaid(DAY, A, 1_000, 100);
        expect(first).toEqual({ usage: { freeN: 0, paidN: 1 }, balanceMicro: 1_500 });
        expect(await store.meterPaid(DAY, A, 1_000, 100)).toEqual({ usage: { freeN: 0, paidN: 2 }, balanceMicro: 500 });
        // Short of credits: null, nothing changed.
        expect(await store.meterPaid(DAY, A, 1_000, 100)).toBeNull();
        expect((await store.getCredits(A)).balanceMicro).toBe(500);
        expect(await store.getUsage(DAY, A)).toEqual({ freeN: 0, paidN: 2 });
      });

      it('a wallet with no credits row is refused and no usage row appears', async () => {
        const store = await make();
        expect(await store.meterPaid(DAY, B, 1_000, 100)).toBeNull();
        expect(await store.listUsage(B, 10)).toEqual([]);
        expect(await store.getCredits(B)).toEqual({ balanceMicro: 0, boughtMicro: 0 });
      });

      it('the daily paid cap refuses with the credits untouched', async () => {
        const store = await make();
        await store.creditPayment(payment(HASH_1, A, 10_000));
        expect(await store.meterPaid(DAY, A, 1_000, 2)).not.toBeNull();
        expect(await store.meterPaid(DAY, A, 1_000, 2)).not.toBeNull();
        expect(await store.meterPaid(DAY, A, 1_000, 2)).toBeNull();
        expect((await store.getCredits(A)).balanceMicro).toBe(8_000);
        expect((await store.getUsage(DAY, A)).paidN).toBe(2);
      });

      it('concurrent paid calls never spend more than the balance', async () => {
        const store = await make();
        await store.creditPayment(payment(HASH_1, A, 3_000));
        const results = await Promise.all(Array.from({ length: 10 }, () => store.meterPaid(DAY, A, 1_000, 100)));
        expect(results.filter((r) => r !== null)).toHaveLength(3);
        expect((await store.getCredits(A)).balanceMicro).toBe(0);
        expect((await store.getUsage(DAY, A)).paidN).toBe(3);
      });
    });

    it('refundCall gives back a free call, and a paid call with its credits, and never goes below zero', async () => {
      const store = await make();
      await store.meterFree(DAY, A, 5);
      await store.refundCall(DAY, A, 'free', 1_000);
      await store.refundCall(DAY, A, 'free', 1_000);
      expect((await store.getUsage(DAY, A)).freeN).toBe(0);

      await store.creditPayment(payment(HASH_1, B, 5_000));
      await store.meterPaid(DAY, B, 1_000, 100);
      await store.refundCall(DAY, B, 'paid', 1_000);
      expect(await store.getCredits(B)).toMatchObject({ balanceMicro: 5_000 });
      expect((await store.getUsage(DAY, B)).paidN).toBe(0);
      await store.refundCall(DAY, B, 'paid', 0);
      expect((await store.getUsage(DAY, B)).paidN).toBe(0);
    });

    it('blockWallet revokes every key of the wallet and only that wallet', async () => {
      const store = await make();
      const mine = keyOf(A);
      const theirs = keyOf(B);
      await store.createKey(mine, LIMITS);
      await store.createKey(theirs, LIMITS);
      await store.blockWallet(A, 'abuse', NOW);
      expect((await store.listKeys(A)).every((k) => k.revokedAt !== null)).toBe(true);
      expect((await store.listKeys(B)).every((k) => k.revokedAt === null)).toBe(true);
    });

    it('prune deletes usage and global rows older than the retention and keeps the rest', async () => {
      const store = await make();
      await store.meterFree('2026-08-01', A, 5);
      await store.meterGlobal('2026-08-01', 'api', 5);
      await store.meterFree('2026-10-05', A, 5);
      await store.meterGlobal('2026-10-05', 'api', 5);
      expect(await store.prune('2026-10-06')).toBe(2);
      expect((await store.listUsage(A, 10)).map((r) => r.day)).toEqual(['2026-10-05']);
    });
  });
}
