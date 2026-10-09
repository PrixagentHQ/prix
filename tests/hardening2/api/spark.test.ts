import type { StandingSource } from '@prix/contracts';
import { SPARK_MAX_POINTS, standingRowSchema } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { describe, expect, it } from 'vitest';
import { toStandingRow } from '../../../apps/api/src/http/views.ts';

/**
 * A league row's sparkline carries at most SPARK_MAX_POINTS, the latest (docs/CONTRACTS.md section 20;
 * security review of 2026-10-08, the newest reads, finding 6): the league never resets, so the daily
 * history grows without end and a league page must stay inside the CPU of the free plan.
 */

function sourceWithDays(days: number): StandingSource {
  const start = Date.UTC(2026, 9, 5);
  const daily = Array.from({ length: days }, (_, index) => ({
    day: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    equityMicro: 10_000_000_000 + index,
  }));
  return {
    agentId: 'abcdefghijkl',
    name: 'Agent',
    createdAt: '2026-10-05T00:00:00.000Z',
    rank: null,
    stats: { ...scoring.initialStats(), daily },
    lastTickId: null,
    lastStatus: null,
  };
}

describe('the sparkline of a league row', () => {
  it('keeps every point while there are no more than SPARK_MAX_POINTS', () => {
    for (const days of [0, 1, SPARK_MAX_POINTS]) {
      const row = toStandingRow(scoring, null, sourceWithDays(days));
      expect(row.spark).toEqual(sourceWithDays(days).stats.daily.map((point) => point.equityMicro));
      expect(standingRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('keeps only the latest SPARK_MAX_POINTS, oldest first, once there are more', () => {
    for (const days of [SPARK_MAX_POINTS + 1, 250, 500]) {
      const source = sourceWithDays(days);
      const row = toStandingRow(scoring, null, source);
      expect(row.spark).toHaveLength(SPARK_MAX_POINTS);
      expect(row.spark).toEqual(source.stats.daily.slice(-SPARK_MAX_POINTS).map((point) => point.equityMicro));
      expect(standingRowSchema.safeParse(row).success, `${days} days`).toBe(true);
    }
  });
});
