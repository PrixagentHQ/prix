import type { AgentId, ManagerBook, ManagerDayResult, ManagerPolicy, UtcDay } from '@prix/contracts';
import { MANAGER_EXIT_AFTER_MISSING_DAYS, STARTING_CASH_MICRO } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import { createManagerEngine } from '@prix/sim/manager';
import { describe, expect, it } from 'vitest';
import { createRng } from '../support/prng.ts';

/**
 * The paper manager engine (docs/contracts/phase-6-social.md section 5.5). A manager holds 2 to 5
 * public agents at weights, each priced at its daily point, and trades through sim.rebalance. The
 * examples are worked by hand at 10 bps of fee and 10 bps of slippage; the properties hold on random
 * runs: no negative cash or units, equity never rises on a rebalance, no fill on a halted agent, the
 * same input gives the same output, and the fills equal sim.rebalance's.
 */

const manager = createManagerEngine({ sim, scoring });

const X: AgentId = 'agentaaaaaaa';
const Y: AgentId = 'agentbbbbbbb';
const Z: AgentId = 'agentccccccc';
const MANAGER = 'managerzzzzz';

const usd = (n: number) => n * 1_000_000;

function policy(version: number, targetsBps: Record<string, number>, over: Partial<ManagerPolicy> = {}): ManagerPolicy {
  return {
    managerId: MANAGER,
    version,
    targetsBps,
    schedule: 'hold',
    setAt: '2026-10-05T10:00:00.000Z',
    setDay: '2026-10-05',
    ...over,
  };
}

const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';
const THU = '2026-10-15';
const FRI = '2026-10-16';
const NEXT_MON = '2026-10-19';

describe('the first day: a hand-worked rebalance', () => {
  // Cash 10,000 dollars. Agent X priced at 100 dollars, Y at 200; targets X 40 percent, Y 30 percent.
  //   X: wanted 4,000 -> 40 units; notional 4,000; slippage 10 bps = 4.00; fee 10 bps = 4.00; costs 4,008.00
  //   Y: wanted 3,000 -> 15 units; notional 3,000; slippage 3.00; fee 3.00; costs 3,006.00
  //   cash after 10,000 - 4,008 - 3,006 = 2,986; holdings worth 4,000 + 3,000; equity 9,986; cost 14.00.
  // Not scaled: the wanted total times 1.002 (7,014) is below the cash.
  const first = () =>
    manager.day({
      book: null,
      stats: null,
      day: TUE,
      values: { [X]: usd(100), [Y]: usd(200) },
      policy: policy(1, { [X]: 4000, [Y]: 3000 }),
    });

  it('buys through sim.rebalance at the agents daily points, with the costs of the paper engine', () => {
    const r = first();
    expect(r.reason).toBe('start');
    expect(r.equityBeforeMicro).toBe(STARTING_CASH_MICRO);
    expect(r.fills).toEqual([
      {
        agentId: X,
        side: 'buy',
        unitsMicro: 40_000_000,
        priceMicro: usd(100),
        notionalMicro: usd(4000),
        feeMicro: usd(4),
        slippageMicro: usd(4),
      },
      {
        agentId: Y,
        side: 'buy',
        unitsMicro: 15_000_000,
        priceMicro: usd(200),
        notionalMicro: usd(3000),
        feeMicro: usd(3),
        slippageMicro: usd(3),
      },
    ]);
    expect(r.costMicro).toBe(usd(14));
    expect(r.equityMicro).toBe(usd(9986));
    expect(r.book).toEqual({
      cashMicro: usd(2986),
      holdings: { [X]: 40_000_000, [Y]: 15_000_000 },
      lastValue: { [X]: usd(100), [Y]: usd(200) },
      missingDays: { [X]: 0, [Y]: 0 },
      policyVersion: 1,
      lastRebalanceDay: TUE,
    });
    expect(r.exited).toEqual([]);
    expect(r.targetsUsed).toEqual({ [X]: 4000, [Y]: 3000 });
  });

  it('counts the day in the stats like a league day: a valued day, a decision, and one trade per fill', () => {
    const r = first();
    expect(r.stats).toMatchObject({
      tradingDays: 1,
      decidedCount: 1,
      tradeCount: 2,
      equityMicro: usd(9986),
      seasonReturnBps: -14,
      lastDay: TUE,
    });
    expect(r.stats.daily).toEqual([{ day: TUE, equityMicro: usd(9986) }]);
  });

  it('values a later day at the new points and trades nothing under a hold schedule', () => {
    const one = first();
    const two = manager.day({
      book: one.book,
      stats: one.stats,
      day: WED,
      values: { [X]: usd(110), [Y]: usd(190) },
      policy: policy(1, { [X]: 4000, [Y]: 3000 }),
    });
    // 2,986 cash + 40 x 110 + 15 x 190 = 2,986 + 4,400 + 2,850 = 10,236.
    expect(two.reason).toBeNull();
    expect(two.fills).toEqual([]);
    expect(two.targetsUsed).toBeNull();
    expect(two.equityMicro).toBe(usd(10_236));
    expect(two.equityBeforeMicro).toBe(two.equityMicro);
    expect(two.book.holdings).toEqual(one.book.holdings);
    expect(two.book.lastRebalanceDay).toBe(TUE);
    expect(two.book.lastValue).toEqual({ [X]: usd(110), [Y]: usd(190) });
    expect(two.stats).toMatchObject({ tradingDays: 2, decidedCount: 1, tradeCount: 2 });
    expect(two.stats.skippedCount).toBe(1);
  });
});

describe('the reasons for a rebalance, first that applies', () => {
  const targets = { [X]: 4000, [Y]: 3000 };
  const start = manager.day({
    book: null,
    stats: null,
    day: TUE,
    values: { [X]: usd(100), [Y]: usd(200) },
    policy: policy(1, targets, { schedule: 'weekly' }),
  });
  const points = { [X]: usd(100), [Y]: usd(200) };

  it('is scheduled on the first final day of a new ISO week under a weekly policy', () => {
    const sameWeek = manager.day({
      book: start.book,
      stats: start.stats,
      day: FRI,
      values: points,
      policy: policy(1, targets, { schedule: 'weekly' }),
    });
    expect(sameWeek.reason).toBeNull();
    const monday = manager.day({
      book: start.book,
      stats: start.stats,
      day: NEXT_MON,
      values: points,
      policy: policy(1, targets, { schedule: 'weekly' }),
    });
    expect(monday.reason).toBe('scheduled');
    expect(monday.book.lastRebalanceDay).toBe(NEXT_MON);
  });

  it('never rebalances on a schedule under a hold policy', () => {
    const hold = manager.day({
      book: start.book,
      stats: start.stats,
      day: NEXT_MON,
      values: points,
      policy: policy(1, targets, { schedule: 'hold' }),
    });
    expect(hold.reason).toBeNull();
  });

  it('is policy when a newer version is in force, and then the book carries the version', () => {
    const next = policy(2, { [X]: 2000, [Y]: 2000, [Z]: 2000 }, { schedule: 'hold', setDay: MON });
    const changed = manager.day({
      book: start.book,
      stats: start.stats,
      day: WED,
      values: { ...points, [Z]: usd(50) },
      policy: next,
    });
    expect(changed.reason).toBe('policy');
    expect(changed.book.policyVersion).toBe(2);
    expect(changed.targetsUsed).toEqual({ [X]: 2000, [Y]: 2000, [Z]: 2000 });
    // Selling down X and Y funds Z: the first sells are in ascending id order, then the buy of Z.
    expect(changed.fills.map((f) => `${f.side}:${f.agentId}`)).toEqual([`sell:${X}`, `sell:${Y}`, `buy:${Z}`]);
  });

  it('puts policy before scheduled when both apply', () => {
    const next = policy(2, targets, { schedule: 'weekly', setDay: FRI });
    const both = manager.day({ book: start.book, stats: start.stats, day: NEXT_MON, values: points, policy: next });
    expect(both.reason).toBe('policy');
  });
});

describe('an agent without a point', () => {
  const targets = { [X]: 4000, [Y]: 3000 };
  const policyHold = policy(1, targets);
  const start = manager.day({
    book: null,
    stats: null,
    day: MON,
    values: { [X]: usd(100), [Y]: usd(200) },
    policy: policyHold,
  });

  it('is valued at its last value and halted, and its missing days are counted', () => {
    const day2 = manager.day({
      book: start.book,
      stats: start.stats,
      day: TUE,
      values: { [X]: null, [Y]: usd(210) },
      policy: policyHold,
    });
    expect(day2.book.missingDays).toEqual({ [X]: 1, [Y]: 0 });
    expect(day2.book.lastValue).toEqual({ [X]: usd(100), [Y]: usd(210) });
    // 2,986 + 40 x 100 (the last value) + 15 x 210 = 2,986 + 4,000 + 3,150.
    expect(day2.equityMicro).toBe(usd(10_136));
    expect(day2.fills).toEqual([]);
  });

  it('is sold at its last value after three missing days, and nothing else trades that day', () => {
    let book: ManagerBook = start.book;
    let stats = start.stats;
    const days = [TUE, WED, THU];
    const results: ManagerDayResult[] = [];
    for (const d of days) {
      const r = manager.day({ book, stats, day: d, values: { [X]: null, [Y]: usd(200) }, policy: policyHold });
      results.push(r);
      book = r.book;
      stats = r.stats;
    }
    expect(MANAGER_EXIT_AFTER_MISSING_DAYS).toBe(3);
    expect(results[0]?.reason).toBeNull();
    expect(results[1]?.reason).toBeNull();
    const exit = results[2] as ManagerDayResult;
    expect(exit.reason).toBe('exit');
    expect(exit.exited).toEqual([X]);
    expect(exit.targetsUsed).toEqual({ [X]: 0 });
    // One sell: X, 40 units at the last value of 100 dollars: notional 4,000, 4 + 4 of costs.
    expect(exit.fills).toEqual([
      {
        agentId: X,
        side: 'sell',
        unitsMicro: 40_000_000,
        priceMicro: usd(100),
        notionalMicro: usd(4000),
        feeMicro: usd(4),
        slippageMicro: usd(4),
      },
    ]);
    expect(exit.book.holdings).toEqual({ [Y]: 15_000_000 });
    expect(exit.book.cashMicro).toBe(usd(2986) + usd(3992));
  });

  it('does not buy an agent that was never priced, and does not crash', () => {
    const r = manager.day({
      book: null,
      stats: null,
      day: MON,
      values: { [X]: usd(100), [Y]: null },
      policy: policyHold,
    });
    expect(r.reason).toBe('start');
    expect(r.fills.map((f) => f.agentId)).toEqual([X]);
    expect(r.book.holdings[Y]).toBeUndefined();
    expect(r.equityMicro).toBeLessThanOrEqual(STARTING_CASH_MICRO);
  });
});

describe('replay', () => {
  const days = [
    { day: MON, values: { [X]: usd(100), [Y]: usd(200) } },
    { day: TUE, values: { [X]: usd(104), [Y]: usd(198) } },
    { day: WED, values: { [X]: usd(103), [Y]: usd(205) } },
    { day: NEXT_MON, values: { [X]: usd(107), [Y]: usd(207) } },
  ];
  const policies = [
    policy(1, { [X]: 4000, [Y]: 3000 }, { schedule: 'weekly', setDay: '2026-10-11' }),
    policy(2, { [X]: 3000, [Y]: 3000 }, { schedule: 'weekly', setDay: TUE }),
  ];

  it('equals folding day() from an empty book, with the policy in force on each day', () => {
    const replayed = manager.replay({ policies, days });
    let book: ManagerBook | null = null;
    let stats = null as ReturnType<typeof scoring.initialStats> | null;
    const rebalances: ManagerDayResult[] = [];
    for (const { day, values } of days) {
      let inForce: ManagerPolicy | undefined;
      for (const p of policies) if (p.setDay < day) inForce = p;
      const r = manager.day({ book, stats, day, values, policy: inForce as ManagerPolicy });
      book = r.book;
      stats = r.stats;
      if (r.reason !== null) rebalances.push(r);
    }
    expect(replayed.book).toEqual(book);
    expect(replayed.stats).toEqual(stats);
    expect(replayed.rebalances).toEqual(rebalances);
    // MON start, WED policy (v2 set TUE takes effect after it), NEXT_MON scheduled.
    expect(replayed.rebalances.map((r) => r.reason)).toEqual(['start', 'policy', 'scheduled']);
  });

  it('skips a day with no policy in force and returns an empty book when there is nothing to value', () => {
    const early = manager.replay({ policies: [policy(1, { [X]: 4000, [Y]: 3000 }, { setDay: WED })], days });
    expect(early.rebalances[0]?.reason).toBe('start');
    expect(early.stats.tradingDays).toBe(1);
    const none = manager.replay({ policies: [], days });
    expect(none.book.cashMicro).toBe(STARTING_CASH_MICRO);
    expect(none.rebalances).toEqual([]);
    expect(none.stats).toEqual(scoring.initialStats());
  });
});

describe('properties on random runs', () => {
  const ids = [X, Y, Z, 'agentddddddd', 'agenteeeeeee'];
  const SCHEDULES = ['hold', 'weekly'] as const;

  function randomRun(seed: number) {
    const rng = createRng(seed);
    const count = rng.int(2, 5);
    const chosen = ids.slice(0, count);
    const weights = (): Record<string, number> => {
      // 500..4000 each, sum at most 10,000.
      const out: Record<string, number> = {};
      let left = 10_000;
      for (const [k, id] of chosen.entries()) {
        const rest = chosen.length - k - 1;
        const max = Math.min(4000, left - rest * 500);
        out[id] = rng.int(500, max);
        left -= out[id] as number;
      }
      return out;
    };
    const dayCount = rng.int(8, 40);
    const policies: ManagerPolicy[] = [policy(1, weights(), { schedule: rng.pick(SCHEDULES), setDay: '2026-10-05' })];
    const values: Array<{ day: UtcDay; values: Record<string, number | null> }> = [];
    const level: Record<string, number> = {};
    for (const id of chosen) level[id] = rng.int(40, 400) * 1_000_000;
    // Some agents go quiet for a stretch.
    const quietFrom = new Map<string, number>();
    for (const id of chosen) if (rng.chance(0.35)) quietFrom.set(id, rng.int(2, dayCount));
    for (let i = 0; i < dayCount; i++) {
      const day = new Date(Date.parse('2026-10-06T00:00:00.000Z') + i * 86_400_000).toISOString().slice(0, 10);
      const row: Record<string, number | null> = {};
      for (const id of chosen) {
        level[id] = Math.max(1_000_000, Math.round((level[id] as number) * (1 + rng.int(-300, 300) / 10_000)));
        const from = quietFrom.get(id);
        const quiet = from !== undefined && i >= from && i < from + rng.int(1, 6);
        row[id] = quiet ? null : (level[id] as number);
      }
      values.push({ day, values: row });
      if (rng.chance(0.08) && i < dayCount - 1) {
        policies.push(policy(policies.length + 1, weights(), { schedule: rng.pick(SCHEDULES), setDay: day }));
      }
    }
    return { policies, values };
  }

  it('keeps every rule on 120 random runs', () => {
    let rebalanceDays = 0;
    let exits = 0;
    let haltedDays = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { policies, values } = randomRun(seed * 104_729);
      let book: ManagerBook | null = null;
      let stats = null as ReturnType<typeof scoring.initialStats> | null;
      for (const { day, values: points } of values) {
        let inForce: ManagerPolicy | undefined;
        for (const p of policies) if (p.setDay < day) inForce = p;
        if (!inForce) continue;
        const input = {
          book: structuredClone(book),
          stats: structuredClone(stats),
          day,
          values: points,
          policy: inForce,
        };
        const frozen = JSON.stringify(input);
        const r = manager.day(input);
        // The input is not changed, and the same input gives the same answer.
        expect(JSON.stringify(input)).toBe(frozen);
        expect(JSON.stringify(manager.day(structuredClone(input)))).toBe(JSON.stringify(r));

        // No negative cash or units, all integers.
        expect(Number.isSafeInteger(r.book.cashMicro) && r.book.cashMicro >= 0, `seed ${seed} cash`).toBe(true);
        for (const units of Object.values(r.book.holdings)) {
          expect(Number.isSafeInteger(units) && units > 0, `seed ${seed} units`).toBe(true);
        }

        // Prices as the document says: the point, else the last value.
        const prior: ManagerBook = book ?? {
          cashMicro: STARTING_CASH_MICRO,
          holdings: {},
          lastValue: {},
          missingDays: {},
          policyVersion: 0,
          lastRebalanceDay: null,
        };
        const involved = [...new Set([...Object.keys(prior.holdings), ...Object.keys(inForce.targetsBps)])].sort();
        const prices: Record<string, number> = {};
        const missing: string[] = [];
        for (const id of involved) {
          const point = points[id];
          if (typeof point === 'number' && point > 0) prices[id] = point;
          else {
            missing.push(id);
            const last = prior.lastValue[id];
            if (last !== undefined) prices[id] = last;
          }
        }

        if (r.reason !== null) {
          rebalanceDays += 1;
          // Equity never rises on a rebalance day.
          expect(r.equityMicro, `seed ${seed} ${day}`).toBeLessThanOrEqual(r.equityBeforeMicro);
          // The fills are sim.rebalance's on the same input.
          const exiting = new Set(r.exited);
          const targets = r.targetsUsed as Record<string, number>;
          const halted = involved.filter((id) => missing.includes(id) && !exiting.has(id) && id in prices);
          const haltedFor = r.reason === 'exit' ? involved.filter((id) => !exiting.has(id) && id in prices) : halted;
          const reference = sim.rebalance({
            portfolio: { cashMicro: prior.cashMicro, holdings: { ...prior.holdings } },
            prices,
            targetsBps: targets,
            halted: haltedFor,
          });
          expect(r.fills, `seed ${seed} ${day}`).toEqual(
            reference.fills.map(({ symbol, ...f }) => ({ agentId: symbol, ...f })),
          );
          expect(r.costMicro).toBe(reference.costMicro);
          expect(r.book.cashMicro).toBe(reference.portfolio.cashMicro);
          expect(r.book.holdings).toEqual(reference.portfolio.holdings);
          expect(r.equityMicro).toBe(reference.equityAfterMicro);
          // No fill on a halted agent: an agent without a point only trades when it is exited.
          for (const fill of r.fills) {
            if (missing.includes(fill.agentId)) {
              expect(exiting.has(fill.agentId), `seed ${seed} ${fill.agentId}`).toBe(true);
              expect(fill.side).toBe('sell');
            }
          }
          for (const id of missing) if (!exiting.has(id)) haltedDays += 1;
          exits += r.exited.length;
        } else {
          // A day without a rebalance trades nothing and changes only the values.
          expect(r.fills).toEqual([]);
          expect(r.costMicro).toBe(0);
          expect(r.equityMicro).toBe(r.equityBeforeMicro);
          expect(r.book.holdings).toEqual(prior.holdings);
          expect(r.book.cashMicro).toBe(prior.cashMicro);
        }
        // Stats: every day is a valued day; decisions are rebalance days; trades are fills.
        expect(r.stats.tradingDays).toBe((stats?.tradingDays ?? 0) + 1);
        expect(r.stats.decidedCount).toBe((stats?.decidedCount ?? 0) + (r.reason === null ? 0 : 1));
        expect(r.stats.tradeCount).toBe((stats?.tradeCount ?? 0) + r.fills.length);
        book = r.book;
        stats = r.stats;
      }
      // A replay of the same days reproduces the run.
      const replayed = manager.replay({ policies, days: values });
      expect(replayed.book, `seed ${seed}`).toEqual(book);
      expect(replayed.stats).toEqual(stats);
    }
    // The runs are rich enough to prove something.
    expect(rebalanceDays).toBeGreaterThan(200);
    expect(exits).toBeGreaterThan(0);
    expect(haltedDays).toBeGreaterThan(0);
  });
});
