import type {
  AgentId,
  AgentStats,
  CreateManagerEngine,
  ManagerBook,
  ManagerDayInput,
  ManagerDayResult,
  ManagerEngine,
  ManagerFill,
  ManagerPolicy,
  PriceMap,
  RebalanceReason,
  UtcDay,
} from '@prix/contracts';
import { MANAGER_EXIT_AFTER_MISSING_DAYS } from '@prix/contracts';

/**
 * The paper manager engine. docs/contracts/phase-6-social.md section 5.5 specifies it.
 *
 * A manager holds a few public agents, each priced at its daily equity. The agent ids are the
 * keys `sim` already accepts as symbols, so every trade goes through `sim.rebalance` unchanged
 * and the value comes from `sim.valuePortfolio`. Nothing here holds funds or places an order.
 *
 * Pure: no clock, no randomness, no I/O, and the input is never changed.
 */

const DAY_MS = 86_400_000;

/** The Monday of the ISO week of a UTC day, as a day string that sorts like the calendar. */
function isoWeekStart(day: UtcDay): UtcDay {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(year, month - 1, date);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday is 0
  return new Date(ms - weekday * DAY_MS).toISOString().slice(0, 10);
}

function hasPoint(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function own(record: Readonly<Record<string, number>>, key: string): number | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function emptyBook(cashMicro: number): ManagerBook {
  return { cashMicro, holdings: {}, lastValue: {}, missingDays: {}, policyVersion: 0, lastRebalanceDay: null };
}

export const createManagerEngine: CreateManagerEngine = ({ sim, scoring }): ManagerEngine => {
  function day(input: ManagerDayInput): ManagerDayResult {
    const { policy, values } = input;
    const start = input.book === null;
    const book: ManagerBook = input.book ?? emptyBook(sim.newPortfolio().cashMicro);
    const heldBefore = Object.keys(book.holdings).filter((id) => (book.holdings[id] ?? 0) > 0);

    // 1. Price every held or targeted agent: its point, or its last value with the agent halted.
    const agents = [...new Set<AgentId>([...heldBefore, ...Object.keys(policy.targetsBps)])].sort();
    const prices: PriceMap = {};
    const lastValue: Record<AgentId, number> = {};
    const missingDays: Record<AgentId, number> = {};
    const missing = new Set<AgentId>();
    for (const id of agents) {
      const point = Object.hasOwn(values, id) ? values[id] : null;
      if (hasPoint(point)) {
        prices[id] = point;
        lastValue[id] = point;
        missingDays[id] = 0;
      } else {
        const last = own(book.lastValue, id);
        if (last !== undefined) {
          prices[id] = last;
          lastValue[id] = last;
        }
        missingDays[id] = (own(book.missingDays, id) ?? 0) + 1;
        missing.add(id);
      }
    }

    // 2. An agent that is held and has been missing too long is sold at its last value.
    const exiting = new Set<AgentId>(
      heldBefore.filter((id) => (missingDays[id] ?? 0) >= MANAGER_EXIT_AFTER_MISSING_DAYS && Object.hasOwn(prices, id)),
    );

    // 3. The reason, the first that applies.
    let reason: RebalanceReason | null = null;
    if (start) reason = 'start';
    else if (policy.version > book.policyVersion) reason = 'policy';
    else if (
      policy.schedule === 'weekly' &&
      book.lastRebalanceDay !== null &&
      isoWeekStart(input.day) > isoWeekStart(book.lastRebalanceDay)
    ) {
      reason = 'scheduled';
    } else if (exiting.size > 0) reason = 'exit';

    // 4. Trade through sim.rebalance.
    let portfolio = { cashMicro: book.cashMicro, holdings: { ...book.holdings } };
    let fills: ManagerFill[] = [];
    let costMicro = 0;
    let targetsUsed: Record<AgentId, number> | null = null;
    const equityBeforeMicro = sim.valuePortfolio(portfolio, prices);
    if (reason !== null) {
      let targetsBps: Record<AgentId, number> = {};
      let halted: AgentId[];
      if (reason === 'exit') {
        for (const id of [...exiting].sort()) targetsBps[id] = 0;
        halted = agents.filter((id) => !exiting.has(id) && Object.hasOwn(prices, id));
      } else {
        targetsBps = {};
        for (const id of Object.keys(policy.targetsBps)) {
          // An agent that was never priced cannot be bought; an exiting one is sold.
          if (!Object.hasOwn(prices, id)) continue;
          targetsBps[id] = exiting.has(id) ? 0 : (policy.targetsBps[id] as number);
        }
        halted = agents.filter((id) => missing.has(id) && !exiting.has(id) && Object.hasOwn(prices, id));
      }
      const traded = sim.rebalance({ portfolio, prices, targetsBps, halted });
      portfolio = traded.portfolio;
      fills = traded.fills.map(({ symbol, ...fill }) => ({ agentId: symbol, ...fill }));
      costMicro = traded.costMicro;
      targetsUsed = targetsBps;
    }

    // 5. Value, and keep a book that carries only what is held or targeted.
    const equityMicro = sim.valuePortfolio(portfolio, prices);
    const keep = new Set<AgentId>([...Object.keys(portfolio.holdings), ...Object.keys(policy.targetsBps)]);
    const keptLastValue: Record<AgentId, number> = {};
    const keptMissing: Record<AgentId, number> = {};
    for (const id of agents) {
      if (!keep.has(id)) continue;
      if (Object.hasOwn(lastValue, id)) keptLastValue[id] = lastValue[id] as number;
      keptMissing[id] = missingDays[id] as number;
    }
    const nextBook: ManagerBook = {
      cashMicro: portfolio.cashMicro,
      holdings: portfolio.holdings,
      lastValue: keptLastValue,
      missingDays: keptMissing,
      policyVersion: Math.max(book.policyVersion, policy.version),
      lastRebalanceDay: reason === null ? book.lastRebalanceDay : input.day,
    };

    // 6. Stats: decided on a rebalance day, skipped otherwise.
    const stats: AgentStats = scoring.updateStats(input.stats ?? scoring.initialStats(), {
      day: input.day,
      status: reason === null ? 'skipped' : 'decided',
      equityMicro,
      fillCount: fills.length,
    });

    return {
      book: nextBook,
      stats,
      equityBeforeMicro,
      equityMicro,
      reason,
      fills,
      costMicro,
      exited: [...exiting].sort(),
      targetsUsed,
    };
  }

  function replay(input: {
    policies: readonly ManagerPolicy[];
    days: ReadonlyArray<{ day: UtcDay; values: Readonly<Record<AgentId, number | null>> }>;
  }): { book: ManagerBook; stats: AgentStats; rebalances: ManagerDayResult[] } {
    const policies = [...input.policies].sort((a, b) => a.version - b.version);
    let book: ManagerBook | null = null;
    let stats: AgentStats | null = null;
    const rebalances: ManagerDayResult[] = [];
    for (const { day: utcDay, values } of input.days) {
      // The policy in force: the latest version set on a day before this one.
      let policy: ManagerPolicy | undefined;
      for (const candidate of policies) if (candidate.setDay < utcDay) policy = candidate;
      if (policy === undefined) continue;
      const result: ManagerDayResult = day({ book, stats, day: utcDay, values, policy });
      book = result.book;
      stats = result.stats;
      if (result.reason !== null) rebalances.push(result);
    }
    return {
      book: book ?? emptyBook(sim.newPortfolio().cashMicro),
      stats: stats ?? scoring.initialStats(),
      rebalances,
    };
  }

  return { day, replay };
};
