import type { TokenHolder } from '@prix/contracts';
import { settleTier } from '@prix/runtime/token/service';
import { describe, expect, it } from 'vitest';
import { testAddress } from '../support/fixtures.ts';

/** Security review finding 12: a tier rises after two reads an hour apart and falls at the first lower read. */

const T0 = new Date('2026-10-06T10:00:00.000Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

function row(tier: 0 | 1 | 2 | 3, riseTier: 0 | 1 | 2 | 3 | null = null, riseSince: string | null = null): TokenHolder {
  return {
    address: testAddress(1),
    balance: '0',
    totalSupply: '1',
    decimals: 18,
    tier,
    maxAgents: 1,
    tokenAddress: testAddress(2),
    checkedAt: T0.toISOString(),
    riseTier: riseTier === 0 ? null : riseTier,
    riseSince,
  };
}

describe('settleTier', () => {
  it('starts a rise at the first read and grants nothing', () => {
    expect(settleTier(null, 3, T0)).toEqual({ tier: 0, riseTier: 3, riseSince: T0.toISOString() });
  });

  it('does not grant a rise at a second read less than 60 minutes later', () => {
    const first = settleTier(null, 3, T0);
    expect(settleTier({ ...row(0), ...first }, 3, at(59)).tier).toBe(0);
  });

  it('grants a rise at a second read 60 minutes later, and the lower of the two reads', () => {
    const first = settleTier(null, 3, T0);
    expect(settleTier({ ...row(0), ...first }, 3, at(60)).tier).toBe(3);
    const mixed = settleTier({ ...row(0), ...first }, 1, at(30));
    expect(settleTier({ ...row(0), ...mixed }, 3, at(61)).tier).toBe(1);
  });

  it('falls at the first read that shows less, and forgets a pending rise', () => {
    expect(settleTier(row(3), 1, at(1))).toEqual({ tier: 1, riseTier: null, riseSince: null });
    const pending = settleTier(null, 2, T0);
    expect(settleTier({ ...row(0), ...pending }, 0, at(30))).toEqual({ tier: 0, riseTier: null, riseSince: null });
  });
});
