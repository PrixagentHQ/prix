import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDataStore } from '../../apps/api/src/store/data.ts';
import { MemoryDataStore } from './support/memory-data-store.ts';
import { describeDataStoreContract } from './support/store-contract.ts';

/**
 * docs/contracts/phase-5-data.md section 8 item 6: the `DataStore` against a local D1 database
 * built from the migrations. The concurrency guarantees of section 2 are one contract, run against
 * the in-memory store the other tests use and against the real one, so the two agree on them.
 * Run with `--config tests/vitest.workers.config.ts`.
 */
const db = (env as unknown as { DB: D1Database }).DB;

const A = `0x${'a1'.repeat(20)}`;
const DAY = '2026-10-06';

async function emptyDatabase(): Promise<void> {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  for (const { name } of tables.results) {
    if (!name.startsWith('_cf_')) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  const bindings = env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
}

describeDataStoreContract('the D1 DataStore on a local database', async () => {
  await emptyDatabase();
  return createDataStore(db);
});

describeDataStoreContract('the in-memory DataStore of the data tests', async () => new MemoryDataStore());

describe('what only SQL can get wrong', () => {
  beforeEach(emptyDatabase);

  it('answers the changes() question of meterPaid: the second statement of the batch sees the first', async () => {
    const store = createDataStore(db);
    await store.creditPayment({
      txHash: `0x${'03'.repeat(32)}`,
      owner: A,
      amountMicro: 1_000,
      blockNumber: 1,
      creditedAt: '2026-10-06T10:00:00.000Z',
    });
    // If changes() did not see the update of the first statement, the usage row would never be
    // written on success, or would always be written on refusal. Both are checked.
    const paid = await store.meterPaid(DAY, A, 1_000, 100);
    expect(paid).toEqual({ usage: { freeN: 0, paidN: 1 }, balanceMicro: 0 });
    const usageRows = await db.prepare('SELECT free_n, paid_n FROM api_usage WHERE owner = ?').bind(A).all();
    expect(usageRows.results).toEqual([{ free_n: 0, paid_n: 1 }]);

    // Refusal for lack of credit: the first statement changes no row, so changes() is 0 and the
    // second inserts nothing and does not count the call.
    expect(await store.meterPaid(DAY, A, 1_000, 100)).toBeNull();
    const after = await db.prepare('SELECT free_n, paid_n FROM api_usage WHERE owner = ?').bind(A).all();
    expect(after.results).toEqual([{ free_n: 0, paid_n: 1 }]);
    const credits = await db.prepare('SELECT balance_micro FROM api_credits WHERE owner = ?').bind(A).first();
    expect(credits).toEqual({ balance_micro: 0 });
  });

  it('a refused meterPaid for a wallet with no usage row and no credits writes no row at all', async () => {
    const store = createDataStore(db);
    expect(await store.meterPaid(DAY, A, 1_000, 100)).toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM api_usage').first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM api_credits').first<{ n: number }>())?.n).toBe(0);
  });

  it('a payment is insert only in the database itself', async () => {
    const store = createDataStore(db);
    const txHash = `0x${'04'.repeat(32)}`;
    await store.creditPayment({
      txHash,
      owner: A,
      amountMicro: 5_000,
      blockNumber: 1,
      creditedAt: '2026-10-06T10:00:00.000Z',
    });
    await expect(
      db.prepare('UPDATE api_payments SET amount_micro = 1 WHERE tx_hash = ?').bind(txHash).run(),
    ).rejects.toThrow(/insert only/);
    await expect(db.prepare('DELETE FROM api_payments WHERE tx_hash = ?').bind(txHash).run()).rejects.toThrow(
      /insert only/,
    );
  });

  it('a credit that conflicts on the hash adds nothing to the balance (the batch is aborted whole)', async () => {
    const store = createDataStore(db);
    const payment = {
      txHash: `0x${'05'.repeat(32)}`,
      owner: A,
      amountMicro: 7_000,
      blockNumber: 1,
      creditedAt: '2026-10-06T10:00:00.000Z',
    };
    await Promise.all([store.creditPayment(payment), store.creditPayment(payment), store.creditPayment(payment)]);
    const credits = await db
      .prepare('SELECT balance_micro, bought_micro FROM api_credits WHERE owner = ?')
      .bind(A)
      .first();
    expect(credits).toEqual({ balance_micro: 7_000, bought_micro: 7_000 });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM api_payments').first<{ n: number }>())?.n).toBe(1);
  });

  it('stores a key only as its hash and its 12-character prefix', async () => {
    const store = createDataStore(db);
    const secret = `prix_${'q'.repeat(52)}`;
    const keyHash = 'f'.repeat(64);
    await store.createKey(
      {
        id: 'keyidaaaaaaa',
        owner: A,
        keyHash,
        prefix: secret.slice(0, 12),
        label: 'x',
        createdAt: '2026-10-06T10:00:00.000Z',
        lastUsedDay: null,
        revokedAt: null,
      },
      { maxActive: 5, maxCreatesToday: 5, maxCreatesAllToday: 500, dayStart: '2026-10-06T00:00:00.000Z' },
    );
    const rows = await db.prepare('SELECT * FROM api_keys').all();
    expect(JSON.stringify(rows.results)).not.toContain(secret);
    expect(rows.results[0]).toMatchObject({ key_hash: keyHash, prefix: secret.slice(0, 12) });
  });
});
