import type { ScoreRankInput, ScoringDivision, SeasonArchiveEntry, SeasonResultRow } from '@prix/contracts';
import {
  CHAIN_ID,
  MIN_ACTIVE_DAYS_CHAIN,
  MIN_DECISIONS_V2,
  MIN_EXPOSURE_DAYS_CHAIN,
  MIN_TRADING_DAYS_V2,
  resultsResponseSchema,
} from '@prix/contracts';
import { scoringV2 } from '@prix/reputation/v2';
import { describe, expect, it } from 'vitest';
import { createReputationApp } from '../../apps/api/src/http/reputation/index.ts';
import { createApi } from '../support/api.ts';
import { SEASON_1, testId } from '../support/fixtures.ts';
import { reputationDeps, stubReputation } from './support.ts';

/**
 * Acceptance line 2 of docs/SPEC.md section 9: an agent with fewer than 10 trading days or fewer
 * than 5 decisions is not ranked, and the table says why on the row.
 */

/** Ten strong days: a score that would win any table if the agent were eligible. */
const GOOD_RETURNS = [120, 80, 150, 60, 110, 90, 130, 70, 100, 140];

function input(over: Partial<Parameters<typeof scoringV2.seasonScore>[0]> = {}) {
  return {
    division: 'open' as ScoringDivision,
    returnsBps: GOOD_RETURNS,
    tradingDays: MIN_TRADING_DAYS_V2,
    decidedCount: MIN_DECISIONS_V2,
    activeOnScoredDay: true,
    returnBps: 1_000,
    maxDrawdownBps: 100,
    ...over,
  };
}

describe('the thresholds are the ones of the specification', () => {
  it('are 10 trading days and 5 decisions', () => {
    expect(MIN_TRADING_DAYS_V2).toBe(10);
    expect(MIN_DECISIONS_V2).toBe(5);
  });
});

describe('scoringV2.seasonScore', () => {
  it('ranks an agent at exactly 10 days and 5 decisions', () => {
    const core = scoringV2.seasonScore(input());
    expect(core.unrankedReason).toBeNull();
    expect(core.confidence).not.toBe('insufficient');
  });

  it('leaves out an agent with 9 trading days: min_trading_days', () => {
    const core = scoringV2.seasonScore(input({ tradingDays: 9 }));
    expect(core.unrankedReason).toBe('min_trading_days');
    expect(core.confidence).toBe('insufficient');
  });

  it('leaves out an agent with 4 decisions: min_decisions', () => {
    const core = scoringV2.seasonScore(input({ decidedCount: 4 }));
    expect(core.unrankedReason).toBe('min_decisions');
    expect(core.confidence).toBe('insufficient');
  });

  it('names the days first when both are short', () => {
    expect(scoringV2.seasonScore(input({ tradingDays: 3, decidedCount: 1 })).unrankedReason).toBe('min_trading_days');
  });

  it('leaves out an agent with no row on the scored day: inactive', () => {
    const core = scoringV2.seasonScore(input({ activeOnScoredDay: false }));
    expect(core.unrankedReason).toBe('inactive');
    expect(core.confidence).toBe('insufficient');
  });

  it('uses the thresholds of the chain division for a listed agent', () => {
    const base = { division: 'chain' as const };
    expect(
      scoringV2.seasonScore(
        input({ ...base, tradingDays: MIN_EXPOSURE_DAYS_CHAIN, decidedCount: MIN_ACTIVE_DAYS_CHAIN }),
      ).unrankedReason,
    ).toBeNull();
    expect(
      scoringV2.seasonScore(input({ ...base, tradingDays: MIN_EXPOSURE_DAYS_CHAIN - 1, decidedCount: 9 }))
        .unrankedReason,
    ).toBe('min_trading_days');
    expect(
      scoringV2.seasonScore(input({ ...base, tradingDays: 12, decidedCount: MIN_ACTIVE_DAYS_CHAIN - 1 }))
        .unrankedReason,
    ).toBe('min_decisions');
  });
});

/** A table of eight agents: three eligible, five that miss one threshold each, one of them with the best score. */
interface Entry {
  n: number;
  tradingDays: number;
  decidedCount: number;
  active: boolean;
  returns: number[];
  returnBps: number;
}

const ENTRIES: Entry[] = [
  { n: 1, tradingDays: 10, decidedCount: 5, active: true, returns: [10, -5, 8, 3, -2, 6, 1, 4, -3, 5], returnBps: 25 },
  { n: 2, tradingDays: 14, decidedCount: 9, active: true, returns: [20, 10, 15, 5, 12, 8, 9, 7, 11, 6], returnBps: 99 },
  {
    n: 3,
    tradingDays: 12,
    decidedCount: 6,
    active: true,
    returns: [-10, -20, 5, -8, -4, 3, -9, -6, 2, -7],
    returnBps: -54,
  },
  // The best numbers of the table, but too few days.
  {
    n: 4,
    tradingDays: 9,
    decidedCount: 9,
    active: true,
    returns: [300, 250, 280, 310, 290, 260, 270, 305, 295],
    returnBps: 2_560,
  },
  // Too few decisions.
  { n: 5, tradingDays: 20, decidedCount: 4, active: true, returns: GOOD_RETURNS, returnBps: 1_000 },
  // No row on the scored day.
  { n: 6, tradingDays: 20, decidedCount: 20, active: false, returns: GOOD_RETURNS, returnBps: 1_000 },
  // Nothing at all.
  { n: 7, tradingDays: 0, decidedCount: 0, active: false, returns: [], returnBps: 0 },
  // Both short.
  { n: 8, tradingDays: 2, decidedCount: 2, active: true, returns: [50, 60], returnBps: 110 },
];

function scored(entry: Entry, division: ScoringDivision = 'open') {
  return scoringV2.seasonScore({
    division,
    returnsBps: entry.returns,
    tradingDays: entry.tradingDays,
    decidedCount: entry.decidedCount,
    activeOnScoredDay: entry.active,
    returnBps: entry.returnBps,
    maxDrawdownBps: 50,
  });
}

function rankInput(entry: Entry): ScoreRankInput {
  const core = scored(entry);
  return {
    agentId: testId('agent', entry.n),
    createdAt: '2026-10-05T08:00:00.000Z',
    scoreMilli: core.breakdown.scoreMilli,
    returnBps: entry.returnBps,
    maxDrawdownBps: 50,
    unrankedReason: core.unrankedReason,
  };
}

const EXPECTED_REASON: Record<number, string | null> = {
  1: null,
  2: null,
  3: null,
  4: 'min_trading_days',
  5: 'min_decisions',
  6: 'inactive',
  7: 'min_trading_days',
  8: 'min_trading_days',
};

describe('scoringV2.rankAll', () => {
  const ranks = new Map(scoringV2.rankAll(ENTRIES.map(rankInput)).map((r) => [r.agentId, r.rank]));

  it('gives each unranked agent the right reason', () => {
    for (const entry of ENTRIES)
      expect(scored(entry).unrankedReason, `agent ${entry.n}`).toBe(EXPECTED_REASON[entry.n]);
  });

  it('gives every agent below the minimum sample a null rank, even with the best score', () => {
    for (const n of [4, 5, 6, 7, 8]) expect(ranks.get(testId('agent', n)), `agent ${n}`).toBeNull();
    expect(scored(ENTRIES[3] as Entry).breakdown.scoreMilli).toBeGreaterThan(
      scored(ENTRIES[1] as Entry).breakdown.scoreMilli,
    );
  });

  it('ranks the others 1, 2, 3 in the order of the score', () => {
    expect(ranks.get(testId('agent', 2))).toBe(1);
    expect(ranks.get(testId('agent', 1))).toBe(2);
    expect(ranks.get(testId('agent', 3))).toBe(3);
  });

  it('lists every agent once', () => {
    expect(ranks.size).toBe(ENTRIES.length);
  });
});

describe('GET /seasons/:id/results through the reputation app', () => {
  const entry: SeasonArchiveEntry = {
    season: SEASON_1,
    method: 'v2',
    lengthDays: 56,
    frozenAt: null,
    rankedCount: { open: 3, pro: 0, chain: 0 },
    agentCount: { open: 8, pro: 0, chain: 0 },
  };

  function rows(): SeasonResultRow[] {
    const ranks = new Map(scoringV2.rankAll(ENTRIES.map(rankInput)).map((r) => [r.agentId, r.rank]));
    return ENTRIES.map((e) => {
      const core = scored(e);
      return {
        rank: ranks.get(testId('agent', e.n)) ?? null,
        unrankedReason: core.unrankedReason,
        agentId: testId('agent', e.n),
        name: `Agent ${e.n}`,
        division: 'open' as const,
        method: 'v2' as const,
        returnBps: e.returnBps,
        maxDrawdownBps: 50,
        tradingDays: e.tradingDays,
        decidedCount: e.decidedCount,
        scoreMilli: core.breakdown.scoreMilli,
        confidence: core.confidence,
        scoredDay: '2026-10-20',
      };
    }).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  }

  async function fetchResults(path: string) {
    const api = createApi();
    const stored = rows();
    const app = createReputationApp(
      reputationDeps(api, {
        verifier: { verify: async () => null },
        chainId: CHAIN_ID,
        reputation: stubReputation({
          getSeasonArchiveEntry: async (id: string) => (id === SEASON_1.id ? entry : null),
          listSeasonResults: async (id: string, division: string, limit: number, offset: number) =>
            id === SEASON_1.id && division === 'open' ? stored.slice(offset, offset + limit) : [],
        }),
      }),
    );
    const response = await app.fetch(new Request(`https://prix.test${path}`));
    return { response, body: (await response.json()) as unknown };
  }

  it('returns the reason on each unranked row and a rank on each ranked one', async () => {
    const { response, body } = await fetchResults(`/api/reputation/seasons/${SEASON_1.id}/results?division=open`);
    expect(response.status).toBe(200);
    const parsed = resultsResponseSchema.parse(body);
    expect(parsed.rows).toHaveLength(8);
    for (const row of parsed.rows) {
      const n = ENTRIES.findIndex((e) => testId('agent', e.n) === row.agentId) + 1;
      expect(row.unrankedReason, `agent ${n}`).toBe(EXPECTED_REASON[n]);
      expect(row.rank === null, `agent ${n}`).toBe(EXPECTED_REASON[n] !== null);
      if (row.rank === null) expect(row.confidence).toBe('insufficient');
    }
    expect(parsed.rows.slice(0, 3).map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(parsed.estimated).toBe(false);
  });

  it('says an unknown season is not found', async () => {
    const { response } = await fetchResults('/api/reputation/seasons/zzzzzzzzzzzz/results');
    expect(response.status).toBe(404);
  });
});
