import type { ReputationStore } from '@prix/contracts';
import {
  CREATION_PERIOD_DAYS,
  creationPeriod,
  NEW_AGENTS_PER_DAY,
  NEW_AGENTS_PER_NETWORK_PER_DAY,
  NEW_AGENTS_PER_NETWORK_PER_PERIOD,
  WALLET_SEASONING_SECONDS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../../../apps/api/src/http/errors.ts';
import { createAgentCreationGuard } from '../../../apps/api/src/http/reputation/index.ts';
import { stubReputation } from '../../reputation/support.ts';
import { NONCE_SECRET } from '../../support/api.ts';
import { testWallet } from '../../support/eth.ts';

/**
 * One continuous league (D-109, docs/CONTRACTS.md section 19): the creation guard counts a network
 * per rolling period of CREATION_PERIOD_DAYS days, key `p:<period>:net:<network>`, not per season.
 * Its refusal says when to try again and never names a season.
 */

const OWNER = testWallet(81).address;
const NETWORK = '198.51.100.7';
/** 2026-10-08, the day the seasons were removed. */
const NOW = new Date('2026-10-08T10:00:00.000Z');
const DAY = '2026-10-08';

function guardWith(full: readonly string[] = []) {
  const taken: { key: string; cap: number }[] = [];
  const givenBack: string[] = [];
  const longAgo = new Date(NOW.getTime() - (WALLET_SEASONING_SECONDS + 60) * 1000).toISOString();
  const reputation: ReputationStore = stubReputation({
    getFirstSignIn: async () => longAgo,
    takeCounter: async (key: string, cap: number) => {
      if (full.some((prefix) => key.startsWith(prefix))) return false;
      taken.push({ key, cap });
      return true;
    },
    giveBackCounter: async (key: string) => {
      givenBack.push(key);
    },
  });
  const guard = createAgentCreationGuard(reputation, NONCE_SECRET, []);
  const reserve = () => guard.reserve({ owner: OWNER, networkSubject: NETWORK, seasonId: 'season-1', now: NOW });
  return { guard, reserve, taken, givenBack };
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

describe('the creation guard in one continuous league', () => {
  it('counts the network per period, not per season', async () => {
    const g = guardWith();
    const reservation = await g.reserve();
    const period = creationPeriod(DAY);
    const keys = g.taken.map((entry) => entry.key);

    expect(keys).toHaveLength(3);
    expect(keys.some((key) => key.startsWith('s:'))).toBe(false);
    const periodKey = keys.find((key) => key.startsWith(`p:${period}:net:`));
    expect(periodKey).toBeDefined();
    expect(g.taken.find((entry) => entry.key === periodKey)?.cap).toBe(NEW_AGENTS_PER_NETWORK_PER_PERIOD);
    expect(g.taken.find((entry) => entry.key.startsWith(`d:${DAY}:net:`))?.cap).toBe(NEW_AGENTS_PER_NETWORK_PER_DAY);
    expect(g.taken.find((entry) => entry.key === `d:${DAY}:all`)?.cap).toBe(NEW_AGENTS_PER_DAY);
    expect(reservation.keys).toEqual(keys);
  });

  it('keeps the network itself out of the key', async () => {
    const g = guardWith();
    await g.reserve();
    for (const { key } of g.taken) expect(key).not.toContain(NETWORK);
  });

  it('refuses at the period cap, gives back what it took and says when to try again without a season', async () => {
    const period = creationPeriod(DAY);
    const g = guardWith([`p:${period}:net:`]);
    const failure = await refusal(g.reserve());

    expect(failure.code).toBe('rate_limited');
    expect(failure.message).not.toMatch(/season/i);
    // The next period starts at 00:00 UTC on this day.
    const nextStart = new Date((period + 1) * CREATION_PERIOD_DAYS * 86_400_000);
    const nextDay = nextStart.toISOString().slice(0, 10);
    expect(failure.message).toContain(nextDay);
    expect(failure.message).toContain('00:00 UTC');
    expect(Number(failure.headers['Retry-After'])).toBe(Math.ceil((nextStart.getTime() - NOW.getTime()) / 1000));
    // The day counter of the network was taken first and is given back.
    expect(g.givenBack).toHaveLength(1);
    expect(g.givenBack[0]?.startsWith(`d:${DAY}:net:`)).toBe(true);
  });

  it('still refuses at the day cap with a retry after 00:00 UTC', async () => {
    const g = guardWith([`d:${DAY}:net:`]);
    const failure = await refusal(g.reserve());
    expect(failure.code).toBe('rate_limited');
    expect(failure.message).not.toMatch(/season/i);
    expect(failure.message).toContain('00:00 UTC');
    expect(Number(failure.headers['Retry-After'])).toBe(14 * 3600);
  });
});
