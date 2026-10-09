import type { ReputationStore } from '@prix/contracts';
import { CREATION_PERIOD_DAYS, creationPeriod, NEW_AGENTS_PER_NETWORK_PER_PERIOD } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../../../apps/api/src/http/errors.ts';
import { createAgentCreationGuard } from '../../../apps/api/src/http/reputation/index.ts';
import { stubReputation } from '../../reputation/support.ts';
import { NONCE_SECRET } from '../../support/api.ts';
import { testWallet } from '../../support/eth.ts';

/**
 * D-109: the cap of a network counts per rolling period of CREATION_PERIOD_DAYS days. These tests
 * run the real guard against a store whose counters really count up to their cap, as D1 does,
 * and move the clock across days and across the edge of a period.
 */
const NETWORK = '198.51.100.7';
const DAY_MS = 86_400_000;

const addDays = (day: string, d: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + d * DAY_MS).toISOString().slice(0, 10);
/** The first day of the period that 2026-10-08 falls in. */
const START = new Date(creationPeriod('2026-10-08') * CREATION_PERIOD_DAYS * DAY_MS).toISOString().slice(0, 10);

function countingGuard() {
  const n = new Map<string, number>();
  const reputation: ReputationStore = stubReputation({
    getFirstSignIn: async () => '2020-01-01T00:00:00.000Z',
    takeCounter: async (key: string, cap: number) => {
      const have = n.get(key) ?? 0;
      if (have >= cap) return false;
      n.set(key, have + 1);
      return true;
    },
    giveBackCounter: async (key: string) => {
      n.set(key, Math.max(0, (n.get(key) ?? 0) - 1));
    },
  });
  const guard = createAgentCreationGuard(reputation, NONCE_SECRET, []);
  const create = (seed: number, day: string) =>
    guard.reserve({
      owner: testWallet(seed).address,
      networkSubject: NETWORK,
      seasonId: 'season-1',
      now: new Date(`${day}T10:00:00.000Z`),
    });
  return { guard, create, n };
}

async function refusal(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiFailure) return error;
    throw error;
  }
  throw new Error('the guard did not refuse');
}

/** Eight agents over four days (two a day, under the cap of three a day). */
async function fillPeriod(create: (seed: number, day: string) => Promise<unknown>) {
  for (let i = 0; i < NEW_AGENTS_PER_NETWORK_PER_PERIOD; i++) await create(200 + i, addDays(START, Math.floor(i / 2)));
}

describe('the cap of a network per period', () => {
  it('refuses the ninth agent in a period, whichever day it comes', async () => {
    expect(NEW_AGENTS_PER_NETWORK_PER_PERIOD).toBe(8);
    const g = countingGuard();
    await fillPeriod(g.create);
    const ninth = await refusal(g.create(300, addDays(START, 10)));
    expect(ninth.code).toBe('rate_limited');
    expect(ninth.message).not.toMatch(/season/i);
    // Still refused on the last day of the period.
    const last = addDays(START, CREATION_PERIOD_DAYS - 1);
    expect(creationPeriod(last)).toBe(creationPeriod(START));
    await refusal(g.create(301, last));
  });

  it('counts again from the first day of the next period', async () => {
    const g = countingGuard();
    await fillPeriod(g.create);
    const next = addDays(START, CREATION_PERIOD_DAYS);
    expect(creationPeriod(next)).toBe(creationPeriod(START) + 1);
    await expect(g.create(302, next)).resolves.toBeDefined();
  });

  it('gives the counters it took back when the period cap refuses', async () => {
    const g = countingGuard();
    await fillPeriod(g.create);
    const taken = () => [...g.n].filter(([, v]) => v > 0).sort();
    const before = taken();
    await refusal(g.create(303, addDays(START, 6)));
    expect(taken()).toEqual(before);
  });

  it('gives a reservation back when the creation did not happen, so the cap is not spent', async () => {
    const g = countingGuard();
    for (let i = 0; i < NEW_AGENTS_PER_NETWORK_PER_PERIOD; i++) {
      const reservation = await g.create(400 + i, addDays(START, i));
      await g.guard.release(reservation);
    }
    expect([...g.n.values()].every((v) => v === 0)).toBe(true);
    // Eight released creations leave the whole allowance.
    await expect(g.create(410, addDays(START, 9))).resolves.toBeDefined();
  });
});
