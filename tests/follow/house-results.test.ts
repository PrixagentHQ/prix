import type { RecordsReadPort, SeasonArchiveEntry, SeasonResultRow } from '@prix/contracts';
import { seasonResultsResponseSchema } from '@prix/contracts';
import { awards } from '@prix/reputation/awards';
import { describe, expect, it } from 'vitest';
import { SEASON_1, testId } from '../support/fixtures.ts';
import { createHarness } from './support.ts';

/**
 * docs/CONTRACTS.md section 17.1: a row and an award of the season results of Phase 3 carry the
 * house mark of the Phase 2 row they come from, and always send it.
 */
const FROZEN: SeasonArchiveEntry = {
  season: SEASON_1,
  method: 'v2',
  lengthDays: 28,
  frozenAt: '2026-11-02T01:00:00.000Z',
  rankedCount: { open: 3, pro: 0, chain: 0 },
  agentCount: { open: 3, pro: 0, chain: 0 },
};

function row(n: number, rank: number, house: boolean | undefined, returnBps: number, maxDrawdownBps: number) {
  const base: SeasonResultRow = {
    rank,
    unrankedReason: null,
    agentId: testId('agent', n),
    name: `Agent ${n}`,
    division: 'open',
    method: 'v2',
    returnBps,
    maxDrawdownBps,
    tradingDays: 20,
    decidedCount: 20,
    scoreMilli: 1_000 - rank,
    confidence: 'high',
    scoredDay: '2026-11-01',
  };
  return house === undefined ? base : { ...base, house };
}

// Agent 1 leads and is a house agent; agent 2 is the steadiest and is not; agent 3 sends no mark.
const ROWS: SeasonResultRow[] = [row(1, 1, true, 900, 400), row(2, 2, false, 300, 50), row(3, 3, undefined, 200, 300)];

const records: Partial<RecordsReadPort> = {
  listSeasonArchive: async () => [FROZEN],
  listSeasonResults: async (seasonId, division, limit, offset) =>
    seasonId === SEASON_1.id && division === 'open' ? ROWS.slice(offset, offset + limit) : [],
};

async function results() {
  const harness = createHarness({ records: records as RecordsReadPort, awards });
  const reply = await harness.anonymous().get('/api/seasons/1/results');
  expect(reply.status, reply.text).toBe(200);
  const body = seasonResultsResponseSchema.parse(reply.json);
  const open = body.divisions.find((entry) => entry.division === 'open');
  if (open === undefined) throw new Error('no open division');
  return open;
}

describe('GET /api/seasons/:number/results, the house mark', () => {
  it('marks the row of a house agent and no other, and sends the mark on every row', async () => {
    const open = await results();
    expect(open.top.map((entry) => [entry.agentId, entry.house])).toEqual([
      [testId('agent', 1), true],
      [testId('agent', 2), false],
      [testId('agent', 3), false],
    ]);
  });

  it('marks the award of a house agent and no other', async () => {
    const open = await results();
    const byKind = new Map(open.awards.map((award) => [award.kind, award]));
    expect(byKind.get('season_leader')?.agentId).toBe(testId('agent', 1));
    expect(byKind.get('season_leader')?.house).toBe(true);
    expect(byKind.get('steadiest')?.agentId).toBe(testId('agent', 2));
    expect(byKind.get('steadiest')?.house).toBe(false);
  });
});
