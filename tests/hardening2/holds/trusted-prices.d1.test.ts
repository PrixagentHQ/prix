import { env } from 'cloudflare:workers';
import { TRUSTED_PRICE_LOOKBACK_TICKS } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../../../apps/api/src/store/index.ts';
import { LIST_TRUSTED_PRICE_TICKS } from '../../../apps/api/src/store/sql.ts';
import { tickAt, trustedPricesContract } from './trusted-prices-contract.ts';

/**
 * `getLastTrustedPrices` of the D1 store on a local D1 database inside the Workers runtime
 * (docs/CONTRACTS.md section 20): the same answers as the memory store, from one bounded read
 * of the primary key of `ticks`, newest first, with no sort and no scan.
 */
const db = (env as unknown as { DB: D1Database }).DB;

describe('D1 store getLastTrustedPrices', () => {
  trustedPricesContract(async () => {
    await db.prepare('DELETE FROM ticks').run();
    return createD1Store(db);
  });

  it('is one walk of the primary key of ticks from its end, at most the lookback in rows', async () => {
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${LIST_TRUSTED_PRICE_TICKS}`)
      .bind('2026-10-08T15:00Z', TRUSTED_PRICE_LOOKBACK_TICKS)
      .all<{ detail: string }>();
    const text = plan.results.map((line) => line.detail).join(' | ');
    expect(plan.results, text).toHaveLength(1);
    expect(text).toMatch(/SEARCH ticks USING PRIMARY KEY \(id<\?\)/);
    expect(text).not.toMatch(/TEMP B-TREE|SCAN/);
  });

  it('reads no more rows than the lookback, however long the history', async () => {
    await db.prepare('DELETE FROM ticks').run();
    const store = createD1Store(db);
    const count = TRUSTED_PRICE_LOOKBACK_TICKS + 20;
    for (let n = 0; n < count; n += 1) expect(await store.createTick(tickAt(n))).toBe(true);
    const result = await db
      .prepare(LIST_TRUSTED_PRICE_TICKS)
      .bind(tickAt(count).id, TRUSTED_PRICE_LOOKBACK_TICKS)
      .all<{ id: string }>();
    expect(result.results).toHaveLength(TRUSTED_PRICE_LOOKBACK_TICKS);
    expect(result.meta.rows_read).toBeLessThanOrEqual(TRUSTED_PRICE_LOOKBACK_TICKS + 1);
  });
});
