import type { LeagueState, OfficialScore, StandingSource } from '@prix/contracts';
import { standingRowSchema } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { describe, expect, it } from 'vitest';
import { standingOf, toStandingRow } from '../../../apps/api/src/http/views.ts';

/** docs/contracts/phase-6-social.md section 3: the mapping table of standingOf. */

const TICK = '2026-11-20T19:00';

function state(method: string, scoredDay: string | null | undefined): LeagueState {
  return {
    seasonId: 'season2aaaaaa',
    division: 'open',
    tickId: TICK,
    computedAt: '2026-11-20T19:05:00.000Z',
    method,
    rankedCount: 3,
    agentCount: 5,
    ...(scoredDay === undefined ? {} : { scoredDay }),
  };
}

const OFFICIAL: OfficialScore = {
  unrankedReason: null,
  scoreMilli: 1234,
  confidence: 'medium',
  scoredDay: '2026-11-19',
};

const stats = scoring.initialStats();

describe('standingOf, the official rank', () => {
  it('a v1 season answers as before, with three null fields', () => {
    const ranked = standingOf(scoring, state('v1', undefined), 2, stats, TICK, null);
    expect(ranked).toEqual({ rank: 2, unrankedReason: null, scoreMilli: null, confidence: null, scoredDay: null });
    const unranked = standingOf(scoring, state('v1', null), null, stats, TICK, OFFICIAL);
    expect(unranked.rank).toBeNull();
    expect(unranked.unrankedReason).toBe(scoring.unrankedReason(stats, true));
    expect(unranked.scoreMilli).toBeNull();
    expect(unranked.confidence).toBeNull();
    expect(unranked.scoredDay).toBeNull();
  });

  it('v2 without a league state: everything null', () => {
    expect(standingOf(scoring, null, null, stats, null, OFFICIAL)).toEqual({
      rank: null,
      unrankedReason: null,
      scoreMilli: null,
      confidence: null,
      scoredDay: null,
    });
  });

  it('v2 before the first scored day: everything null, even with a stored rank', () => {
    expect(standingOf(scoring, state('v2', null), 4, stats, TICK, OFFICIAL)).toEqual({
      rank: null,
      unrankedReason: null,
      scoreMilli: null,
      confidence: null,
      scoredDay: null,
    });
  });

  it('v2 with a stored rank: that rank and the official figures', () => {
    expect(standingOf(scoring, state('v2', '2026-11-19'), 1, stats, TICK, OFFICIAL)).toEqual({
      rank: 1,
      unrankedReason: null,
      scoreMilli: 1234,
      confidence: 'medium',
      scoredDay: '2026-11-19',
    });
  });

  it('v2 without a rank but with an official row: its reason and figures', () => {
    const official: OfficialScore = { ...OFFICIAL, unrankedReason: 'inactive', scoreMilli: null };
    expect(standingOf(scoring, state('v2', '2026-11-19'), null, stats, TICK, official)).toEqual({
      rank: null,
      unrankedReason: 'inactive',
      scoreMilli: null,
      confidence: 'medium',
      scoredDay: '2026-11-19',
    });
  });

  it('v2 without a rank and without an official row: min_trading_days', () => {
    expect(standingOf(scoring, state('v2', '2026-11-19'), null, stats, TICK, null)).toEqual({
      rank: null,
      unrankedReason: 'min_trading_days',
      scoreMilli: null,
      confidence: null,
      scoredDay: null,
    });
    expect(standingOf(scoring, state('v2', '2026-11-19'), null, stats, TICK)).toMatchObject({
      unrankedReason: 'min_trading_days',
    });
  });
});

describe('toStandingRow, the official rank', () => {
  const source: StandingSource = {
    agentId: 'agentaaaaaaa',
    name: 'Index Core',
    createdAt: '2026-10-06T19:00:00.000Z',
    rank: 3,
    stats,
    lastTickId: TICK,
    lastStatus: 'decided',
    summary: null,
    owner: '0x1111111111111111111111111111111111111111',
    official: { ...OFFICIAL, scoreMilli: -50, confidence: 'low' },
  };

  it('sends the three fields, null in a v1 season', () => {
    const row = toStandingRow(scoring, state('v1', undefined), source, []);
    expect(standingRowSchema.parse(row)).toEqual(row);
    expect(row).toMatchObject({ rank: 3, scoreMilli: null, confidence: null, scoredDay: null });
    expect(Object.hasOwn(row, 'scoreMilli')).toBe(true);
  });

  it('sends the official figures in a v2 season', () => {
    const row = toStandingRow(scoring, state('v2', '2026-11-19'), source, []);
    expect(standingRowSchema.parse(row)).toEqual(row);
    expect(row).toMatchObject({ rank: 3, unrankedReason: null, scoreMilli: -50, confidence: 'low' });
    expect(row.scoredDay).toBe('2026-11-19');
  });
});
