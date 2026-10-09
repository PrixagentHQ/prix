import { beforeEach, describe, expect, it } from 'vitest';
import { testId } from '../../../support/fixtures.ts';
import { db, resetDb, SEASON_1, storesOn } from '../../support/d1.ts';
import { managerOf, policyOf } from '../../support/managers.ts';

/**
 * Security review 6, finding 2 (docs/contracts/phase-6-social.md section 5.5): MAX_MANAGERS_TOTAL counts
 * open managers only, active or paused and not hidden. A closed or hidden manager frees its place, so
 * closed managers that stay public with their record can never fill Prix for good. The limit is a
 * condition of the create statement; here it is 3 so that the test stays small.
 */

const plain = storesOn(db);
const NOW = '2026-10-08T10:00:00.000Z';
const LIMITS = { maxForOwner: 5, maxTotal: 3 };
const TARGETS = { [testId('agent', 1)]: 3000, [testId('agent', 2)]: 3000 };

async function create(n: number) {
  const manager = managerOf(n);
  return plain.social.createManager(manager, policyOf(manager.id, 1, TARGETS, 'hold'), LIMITS);
}

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('the most managers Prix holds', () => {
  it('counts active and paused managers that are not hidden, and nothing else', async () => {
    for (const n of [1, 2, 3]) expect(await create(n)).toBe('created');
    expect(await create(4)).toBe('full');

    // A closed manager frees its place.
    expect(await plain.social.setManagerStatus(managerOf(1).id, null, 'closed', NOW)).toBe(true);
    expect(await create(4)).toBe('created');
    expect(await create(5)).toBe('full');

    // A hidden manager frees its place, whatever its status.
    expect(await plain.social.setManagerHidden(managerOf(2).id, true, NOW)).toBe(true);
    expect(await create(5)).toBe('created');
    expect(await create(6)).toBe('full');

    // A paused manager keeps its place.
    expect(await plain.social.setManagerStatus(managerOf(3).id, null, 'paused', NOW)).toBe(true);
    expect(await create(6)).toBe('full');

    // Unhiding takes the place back: Prix is then over the limit and refuses until a place is free.
    expect(await plain.social.setManagerHidden(managerOf(2).id, false, NOW)).toBe(true);
    expect(await create(6)).toBe('full');
    expect(await plain.social.setManagerStatus(managerOf(3).id, null, 'closed', NOW)).toBe(true);
    expect(await plain.social.setManagerStatus(managerOf(4).id, null, 'closed', NOW)).toBe(true);
    expect(await create(6)).toBe('created');
    const open = await db
      .prepare("SELECT count(*) AS n FROM managers WHERE status IN ('active', 'paused') AND hidden = 0")
      .first<{ n: number }>();
    expect(open?.n).toBe(3);
  });
});
