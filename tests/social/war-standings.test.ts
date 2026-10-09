import type { AgentStats, WarEntrant, WarRow, WarStandingInput } from '@prix/contracts';
import { MIN_TRADING_DAYS_V2, STARTING_CASH_MICRO } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { warStandings } from '@prix/reputation/war-standings';
import { describe, expect, it } from 'vitest';
import { createRng } from '../support/prng.ts';
import { entrantOf, GEMMA, GPT_OSS, LLAMA, MISTRAL } from './support/war.ts';

/**
 * The standings of a Model War (docs/contracts/phase-6-social.md section 5.3): the order of scoring v1
 * (return, then max drawdown, then fewer trades), equal return and drawdown sharing a rank, ranks only once
 * the war is complete, and the v2 breakdown shown but never ordering the table.
 */

const slots = ['A', 'B', 'C', 'D'] as const;

function stats(returnBps: number, over: Partial<AgentStats> = {}): AgentStats {
  const equity = STARTING_CASH_MICRO + returnBps * 1_000_000;
  return {
    ...scoring.initialStats(),
    equityMicro: equity,
    peakEquityMicro: Math.max(equity, STARTING_CASH_MICRO),
    seasonReturnBps: returnBps,
    ...over,
  };
}

function input(
  slot: (typeof slots)[number],
  modelId: string,
  s: AgentStats,
  rows: WarRow[] = [],
  over: Partial<WarEntrant> = {},
): WarStandingInput {
  return { entrant: entrantOf(slot, modelId, { stats: s, days: s.tradingDays, ...over }), rows };
}

function row(
  slot: (typeof slots)[number],
  status: WarRow['status'],
  code: string | null,
  extra: Partial<WarRow> = {},
): WarRow {
  return {
    warId: 'warlaunchaaa',
    slot,
    tickId: '2026-10-12T15:00Z',
    status,
    code,
    targetsBps: null,
    reason: null,
    fills: [],
    halted: [],
    portfolio: { cashMicro: STARTING_CASH_MICRO, holdings: {} },
    equityMicro: STARTING_CASH_MICRO,
    costMicro: 0,
    inputTokens: null,
    outputTokens: null,
    neurons: null,
    createdAt: '2026-10-12T15:30:00.000Z',
    ...extra,
  };
}

describe('the order of a finished war', () => {
  it('ranks by return, then by the smaller drawdown, then by fewer trades, then by slot', () => {
    const a = input('A', LLAMA, stats(300, { maxDrawdownBps: 80, tradeCount: 9 }));
    const b = input('B', GEMMA, stats(500, { maxDrawdownBps: 120, tradeCount: 3 }));
    const c = input('C', MISTRAL, stats(300, { maxDrawdownBps: 40, tradeCount: 12 }));
    const d = input('D', GPT_OSS, stats(-200, { maxDrawdownBps: 10, tradeCount: 1 }));
    const result = warStandings.standings([a, b, c, d], true);
    expect(result.map((s) => [s.slot, s.rank])).toEqual([
      ['B', 1],
      ['C', 2],
      ['A', 3],
      ['D', 4],
    ]);
  });

  it('gives equal return and equal drawdown the same rank, whatever their trades, and the next rank skips', () => {
    const a = input('A', LLAMA, stats(400, { maxDrawdownBps: 60, tradeCount: 7 }));
    const b = input('B', GEMMA, stats(400, { maxDrawdownBps: 60, tradeCount: 2 }));
    const c = input('C', MISTRAL, stats(100, { maxDrawdownBps: 60, tradeCount: 0 }));
    const result = warStandings.standings([a, b, c], true);
    // Fewer trades come first inside the shared rank.
    expect(result.map((s) => [s.slot, s.rank])).toEqual([
      ['B', 1],
      ['A', 1],
      ['C', 3],
    ]);
  });

  it('is the same whatever the order the entrants arrive in', () => {
    const rng = createRng(31);
    const entrants = slots.map((slot, k) =>
      input(
        slot,
        [LLAMA, GEMMA, MISTRAL, GPT_OSS][k] as string,
        stats(rng.int(-300, 300), { maxDrawdownBps: rng.int(0, 200), tradeCount: rng.int(0, 9) }),
      ),
    );
    const expected = JSON.stringify(warStandings.standings(entrants, true));
    for (let n = 0; n < 10; n++) {
      expect(JSON.stringify(warStandings.standings(rng.shuffle(entrants), true))).toBe(expected);
    }
  });
});

describe('a war that is still running', () => {
  it('ranks no one and keeps the rows in slot order, whatever the returns', () => {
    const a = input('A', LLAMA, stats(-500));
    const b = input('B', GEMMA, stats(900));
    const c = input('C', MISTRAL, stats(100));
    const result = warStandings.standings([c, b, a], false);
    expect(result.map((s) => s.slot)).toEqual(['A', 'B', 'C']);
    expect(result.map((s) => s.rank)).toEqual([null, null, null]);
  });
});

describe('what a line shows', () => {
  it('counts decisions, no-decision codes, skips, costs and neurons from the rows', () => {
    const rows = [
      row('A', 'decided', null, { costMicro: 1_500, neurons: 12.5 }),
      row('A', 'decided', null, { costMicro: 700, neurons: 7.5 }),
      row('A', 'no_decision', 'invalid_json', { neurons: 10 }),
      row('A', 'no_decision', 'invalid_json'),
      row('A', 'no_decision', 'reason_invalid'),
      row('A', 'skipped', 'internal_error'),
    ];
    const [line] = warStandings.standings([input('A', LLAMA, stats(0, { tradingDays: 6 }), rows)], true);
    expect(line).toMatchObject({
      slot: 'A',
      modelId: LLAMA,
      decided: 2,
      noDecision: 3,
      skipped: 1,
      costMicro: 2_200,
      neurons: 30,
      codes: { internal_error: 1, invalid_json: 2, reason_invalid: 1 },
      days: 6,
    });
  });

  it('shows the v2 breakdown and its confidence beside the figures, and never orders by them', () => {
    // A has the better return and a poor v2 score; B has the better v2 score and the worse return.
    const noisy: AgentStats = stats(400, {
      tradingDays: 10,
      daily: Array.from({ length: 10 }, (_, k) => ({
        day: `2026-10-${String(12 + k).padStart(2, '0')}`,
        equityMicro: STARTING_CASH_MICRO + (k % 2 === 0 ? 900 : -500) * 1_000_000 + k * 130_000_000,
      })),
    });
    const smooth: AgentStats = stats(300, {
      tradingDays: 10,
      daily: Array.from({ length: 10 }, (_, k) => ({
        day: `2026-10-${String(12 + k).padStart(2, '0')}`,
        equityMicro: STARTING_CASH_MICRO + (k + 1) * 30_000_000,
      })),
    });
    const result = warStandings.standings([input('A', LLAMA, noisy), input('B', GEMMA, smooth)], true);
    // The order is the return.
    expect(result.map((s) => s.slot)).toEqual(['A', 'B']);
    const [first, second] = result;
    expect(first?.v2.scoreMilli).toBeLessThan(second?.v2.scoreMilli ?? 0);
    expect(first?.v2.n).toBe(10);
    // Ten days are enough for low confidence (the minimum of scoring v2), nine are not.
    expect(MIN_TRADING_DAYS_V2).toBe(10);
    expect(first?.confidence).toBe('low');
    const [short] = warStandings.standings(
      [input('A', LLAMA, stats(0, { tradingDays: 9, daily: (noisy.daily as []).slice(0, 9) }))],
      true,
    );
    expect(short?.confidence).toBe('insufficient');
  });

  it('is deterministic and does not change its input', () => {
    const entrants = [input('A', LLAMA, stats(10)), input('B', GEMMA, stats(20))];
    const frozen = JSON.stringify(entrants);
    const a = JSON.stringify(warStandings.standings(entrants, true));
    expect(JSON.stringify(entrants)).toBe(frozen);
    expect(JSON.stringify(warStandings.standings(entrants, true))).toBe(a);
  });
});
