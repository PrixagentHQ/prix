/**
 * Scoring v1. docs/CONTRACTS.md section 9 is the rule; packages/reputation/METHOD.md says the
 * same thing in plain words. The three must agree.
 *
 * Every function here is pure: no clock, no randomness, no I/O. It trusts its input, never
 * throws, never mutates its input, and never returns negative zero.
 *
 * A change to what any function returns is a new method and a new file (v2.ts), never an edit
 * of this one: published ranks carry the method name they were computed with.
 *
 * A v1 rank orders agents by their return over one season. It is not a measure of skill:
 * METHOD.md lists what v1 does not defend against.
 */
import type {
  AgentStats,
  DailyPoint,
  RankInput,
  ScoringEngine,
  StandingRow,
  StatsEvent,
  UnrankedReason,
} from '@prix/contracts';
import {
  BPS,
  MIN_DECISIONS_TO_RANK,
  MIN_TRADING_DAYS_TO_RANK,
  SCORING_METHOD,
  STARTING_CASH_MICRO,
} from '@prix/contracts';

/**
 * The method this file implements. The type is the literal "v1", so the package stops
 * compiling if the contract names another method while this file is still the engine.
 */
export const METHOD: 'v1' = SCORING_METHOD;

/**
 * `part / whole` in basis points, as section 9 writes it: `Math.round(part * B / whole)` in
 * plain double arithmetic. `Math.round` rounds a half toward positive infinity, so 0.5 becomes
 * 1 and -1.5 becomes -1. It returns negative zero for a value in [-0.5, -0]; that becomes 0.
 */
function toBps(part: number, whole: number): number {
  const rounded = Math.round((part * BPS) / whole);
  return rounded === 0 ? 0 : rounded;
}

function initialStats(): AgentStats {
  return {
    equityMicro: STARTING_CASH_MICRO,
    peakEquityMicro: STARTING_CASH_MICRO,
    seasonReturnBps: 0,
    maxDrawdownBps: 0,
    tradeCount: 0,
    decidedCount: 0,
    noDecisionCount: 0,
    skippedCount: 0,
    tradingDays: 0,
    lastDay: null,
    daily: [],
  };
}

function updateStats(previous: AgentStats, event: StatsEvent): AgentStats {
  const equityMicro = event.equityMicro;
  const peakEquityMicro = Math.max(previous.peakEquityMicro, equityMicro);
  // A peak of zero cannot come from `initialStats`. The guard only keeps 0 / 0 out of the stats.
  const drawdownNowBps = peakEquityMicro > 0 ? toBps(peakEquityMicro - equityMicro, peakEquityMicro) : 0;

  const sameDay = event.day === previous.lastDay;
  const kept = sameDay ? previous.daily.slice(0, -1) : previous.daily;
  const daily: DailyPoint[] = kept.map((point) => ({ day: point.day, equityMicro: point.equityMicro }));
  daily.push({ day: event.day, equityMicro });

  return {
    equityMicro,
    peakEquityMicro,
    seasonReturnBps: toBps(equityMicro - STARTING_CASH_MICRO, STARTING_CASH_MICRO),
    maxDrawdownBps: Math.max(previous.maxDrawdownBps, drawdownNowBps),
    tradeCount: previous.tradeCount + event.fillCount,
    decidedCount: previous.decidedCount + (event.status === 'decided' ? 1 : 0),
    noDecisionCount: previous.noDecisionCount + (event.status === 'no_decision' ? 1 : 0),
    skippedCount: previous.skippedCount + (event.status === 'skipped' ? 1 : 0),
    tradingDays: previous.tradingDays + (sameDay ? 0 : 1),
    lastDay: event.day,
    daily,
  };
}

function unrankedReason(stats: AgentStats, hasRowAtTick: boolean): UnrankedReason | null {
  if (stats.tradingDays < MIN_TRADING_DAYS_TO_RANK) return 'min_trading_days';
  if (stats.decidedCount < MIN_DECISIONS_TO_RANK) return 'min_decisions';
  if (!hasRowAtTick) return 'inactive';
  return null;
}

/**
 * The league order: higher return, then lower drawdown, then fewer trades, then the older
 * agent, then the lower id. Text compares by code unit, which for ISO times and base32 ids is
 * the order SQLite's default collation gives.
 */
function compare(a: RankInput, b: RankInput): number {
  if (a.stats.seasonReturnBps !== b.stats.seasonReturnBps) {
    return a.stats.seasonReturnBps > b.stats.seasonReturnBps ? -1 : 1;
  }
  if (a.stats.maxDrawdownBps !== b.stats.maxDrawdownBps) {
    return a.stats.maxDrawdownBps < b.stats.maxDrawdownBps ? -1 : 1;
  }
  if (a.stats.tradeCount !== b.stats.tradeCount) {
    return a.stats.tradeCount < b.stats.tradeCount ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.agentId !== b.agentId) return a.agentId < b.agentId ? -1 : 1;
  return 0;
}

function standingRow(entry: RankInput, rank: number | null, reason: UnrankedReason | null): StandingRow {
  return {
    rank,
    unrankedReason: reason,
    agentId: entry.agentId,
    name: entry.name,
    seasonReturnBps: entry.stats.seasonReturnBps,
    maxDrawdownBps: entry.stats.maxDrawdownBps,
    tradeCount: entry.stats.tradeCount,
    tradingDays: entry.stats.tradingDays,
    equityMicro: entry.stats.equityMicro,
    spark: entry.stats.daily.map((point) => point.equityMicro),
    lastStatus: entry.lastStatus,
  };
}

function rankAgents(entries: readonly RankInput[]): StandingRow[] {
  const ranked: RankInput[] = [];
  const unranked: { entry: RankInput; reason: UnrankedReason }[] = [];
  for (const entry of entries) {
    const reason = unrankedReason(entry.stats, entry.lastStatus !== null);
    if (reason === null) ranked.push(entry);
    else unranked.push({ entry, reason });
  }
  ranked.sort(compare);
  unranked.sort((a, b) => compare(a.entry, b.entry));

  const rows: StandingRow[] = [];
  for (const entry of ranked) rows.push(standingRow(entry, rows.length + 1, null));
  for (const { entry, reason } of unranked) rows.push(standingRow(entry, null, reason));
  return rows;
}

export const scoringV1: ScoringEngine = {
  initialStats,
  updateStats,
  unrankedReason,
  compare,
  rankAgents,
};
