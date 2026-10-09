import { computeTier, type Thresholds } from '@prix/contracts';
import { describe, expect, it } from 'vitest';

/**
 * docs/contracts/phase-4-token.md section 5.4, item 5: the boundaries of `computeTier`.
 * A wallet is in tier N when `balance * 1,000,000 >= thresholdN * totalSupply`, in integers.
 */

const DEFAULT: Thresholds = [10, 100, 1_000];

/** The smallest balance that reaches a threshold: ceil(threshold * supply / 1,000,000). */
function smallestBalance(thresholdPpm: number, supply: bigint): bigint {
  const product = BigInt(thresholdPpm) * supply;
  return (product + 999_999n) / 1_000_000n;
}

const SUPPLIES: readonly [string, bigint][] = [
  ['10^27 (18 decimals, a billion tokens)', 10n ** 27n],
  ['a supply that no threshold divides evenly', 1_000_003n],
  ['a small supply', 7n],
  ['the largest uint256', 2n ** 256n - 1n],
];

const THRESHOLD_SETS: readonly Thresholds[] = [DEFAULT, [1, 2, 3], [250_000, 500_000, 1_000_000]];

describe('computeTier at the edge of every tier', () => {
  for (const thresholds of THRESHOLD_SETS) {
    for (const [label, supply] of SUPPLIES) {
      for (const tier of [1, 2, 3] as const) {
        const threshold = thresholds[tier - 1] as number;
        it(`tier ${tier}, threshold ${threshold} ppm, supply ${label}: one below, at, and one above`, () => {
          const edge = smallestBalance(threshold, supply);
          const below = computeTier(edge - 1n, supply, thresholds);
          const at = computeTier(edge, supply, thresholds);
          const above = computeTier(edge + 1n, supply, thresholds);
          // One base unit below the edge is below this tier, whatever the lower tiers are.
          expect(below).toBeLessThan(tier);
          expect(at).toBeGreaterThanOrEqual(tier);
          expect(above).toBeGreaterThanOrEqual(tier);
          // Exactly at the edge a tier is reached, and not a higher one unless the next edge is the same unit.
          const nextEdge = tier === 3 ? null : smallestBalance(thresholds[tier] as number, supply);
          if (nextEdge === null || nextEdge > edge) expect(at).toBe(tier);
        });
      }
    }
  }

  it('gives the exact tiers around every threshold of the default table at a supply of 10^27', () => {
    const supply = 10n ** 27n;
    const cases: [bigint, number][] = [
      [10n ** 22n - 1n, 0],
      [10n ** 22n, 1],
      [10n ** 22n + 1n, 1],
      [10n ** 23n - 1n, 1],
      [10n ** 23n, 2],
      [10n ** 23n + 1n, 2],
      [10n ** 24n - 1n, 2],
      [10n ** 24n, 3],
      [10n ** 24n + 1n, 3],
    ];
    for (const [balance, tier] of cases) expect(computeTier(balance, supply, DEFAULT), String(balance)).toBe(tier);
  });

  it('is tier 0 for a balance of 0, at any supply', () => {
    for (const [, supply] of SUPPLIES) expect(computeTier(0n, supply, DEFAULT)).toBe(0);
  });

  it('is tier 0 for a supply of 0, whatever the balance, and does not divide by it', () => {
    expect(computeTier(0n, 0n, DEFAULT)).toBe(0);
    expect(computeTier(10n ** 27n, 0n, DEFAULT)).toBe(0);
  });

  it('is tier 0 for a negative balance or supply', () => {
    expect(computeTier(-1n, 10n ** 27n, DEFAULT)).toBe(0);
    expect(computeTier(10n ** 24n, -1n, DEFAULT)).toBe(0);
  });

  it('gives the top tier to the whole supply', () => {
    for (const [, supply] of SUPPLIES) expect(computeTier(supply, supply, DEFAULT)).toBe(3);
  });

  it('never loses the last unit to floating point at 10^27', () => {
    const supply = 10n ** 27n;
    // 10^22 - 1 is not representable as a double next to 10^22; an implementation with Number would call it tier 1.
    expect(computeTier(10n ** 22n - 1n, supply, DEFAULT)).toBe(0);
    expect(computeTier(10n ** 24n - 1n, supply, DEFAULT)).toBe(2);
  });
});
