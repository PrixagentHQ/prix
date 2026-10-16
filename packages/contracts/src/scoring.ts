import type { PortfolioState, PriceMap } from './portfolio.ts';
import type { IsoTime, TickId, UtcDay } from './primitives.ts';
import {
  amountSchema,
  divisionSchema,
  idSchema,
  isoTimeSchema,
  signedAmountSchema,
  symbolSchema,
  tickIdSchema,
  utcDaySchema,
} from './primitives.ts';
import { z } from './zod.ts';

/** What happened to one agent at one tick. */
export const rowStatusSchema = z.enum(['decided', 'no_decision', 'skipped']);
export type RowStatus = z.infer<typeof rowStatusSchema>;

/** The portfolio value at the last row of one day. */
export const dailyPointSchema = z.strictObject({
  day: utcDaySchema,
  equityMicro: amountSchema,
});
export type DailyPoint = z.infer<typeof dailyPointSchema>;

/**
 * The running record of one agent in one season. It is updated once for every tick row
 * the agent gets, and it is everything scoring v1 needs.
 */
export const agentStatsSchema = z.strictObject({
  /** Portfolio value after the agent's latest row, in micro-USD. */
  equityMicro: amountSchema,
  /** The highest `equityMicro` seen this season. Starts at STARTING_CASH_MICRO. */
  peakEquityMicro: amountSchema,
  /** (equity - start) / start, in basis points. */
  seasonReturnBps: signedAmountSchema,
  /** The largest fall from a peak, in basis points of that peak. Zero or positive. */
  maxDrawdownBps: amountSchema,
  /** Number of fills this season. */
  tradeCount: amountSchema,
  decidedCount: amountSchema,
  noDecisionCount: amountSchema,
  skippedCount: amountSchema,
  /** Days on which the agent had a row, whether or not it was asked. */
  tradingDays: amountSchema,
  /** The UTC day of the latest row. Null before the first row. */
  lastDay: utcDaySchema.nullable(),
  /** One point per day with a row, oldest first. */
  daily: z.array(dailyPointSchema),
});
export type AgentStats = z.infer<typeof agentStatsSchema>;

/** The stats event of a decision row. docs/CONTRACTS.md section 9 says how a row maps to it. */
export interface StatsEvent {
  /** `utcDayOfTick(row.tickId)`: the day of the tick, never the day the row was written. */
  day: string;
  status: RowStatus;
  /** `row.equityMicro`. */
  equityMicro: number;
  /** `row.fills.length`. */
  fillCount: number;
}

export const unrankedReasonSchema = z.enum(['min_trading_days', 'min_decisions', 'inactive']);
export type UnrankedReason = z.infer<typeof unrankedReasonSchema>;

/**
 * How much history a v2 score rests on. The same values as `confidenceSchema` of phase2-reputation.ts,
 * repeated here because that file imports this one; phase6-social.ts checks at compile time that the two agree.
 */
export const standingConfidenceSchema = z.enum(['insufficient', 'low', 'medium', 'high']);
export type StandingConfidence = z.infer<typeof standingConfidenceSchema>;

/**
 * The official v2 score behind a rank: the agent's season_scores row (Phase 2), read by primary key.
 * Set only in a season whose method is v2 and only when the agent has a v2 row; null otherwise.
 * docs/CONTRACTS.md section 18.
 */
export interface OfficialScore {
  unrankedReason: UnrankedReason | null;
  scoreMilli: number | null;
  confidence: StandingConfidence | null;
  scoredDay: UtcDay | null;
}

/** One line of a league table. */
/** The most daily points a league row's sparkline carries (D-109). */
export const SPARK_MAX_POINTS = 90;

export const standingRowSchema = z.strictObject({
  /** 1 is the leader. Null for an agent that is shown but not ranked. */
  rank: z.number().int().positive().nullable(),
  /** Why the agent has no rank. Null when it has one. */
  unrankedReason: unrankedReasonSchema.nullable(),
  agentId: idSchema,
  name: z.string(),
  seasonReturnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  tradeCount: amountSchema,
  tradingDays: amountSchema,
  equityMicro: amountSchema,
  /**
   * Daily values for the sparkline, oldest first, at most `SPARK_MAX_POINTS` (the latest ones): the league
   * never resets (D-109), so the full history stays on the record page. Plotted by position.
   */
  spark: z.array(amountSchema).max(SPARK_MAX_POINTS),
  /** What happened to the agent at the league's tick. Null if it had no row at that tick. */
  lastStatus: rowStatusSchema.nullable(),
  // The three fields below came with the board look (docs/CONTRACTS.md section 17). The API
  // always sends them. They are optional so that a page built for them can read an API that
  // does not send them yet: the site is deployed before the API.
  /** The agent's strategy summary, as its own page shows it. Null until one is written. */
  summary: z.string().nullable().optional(),
  /** When the agent was created. */
  createdAt: isoTimeSchema.optional(),
  /** True for an agent that Prix itself runs. Every surface that shows the agent says so. */
  house: z.boolean().optional(),
  // The three fields below came with the official rank (docs/CONTRACTS.md section 18). The API always
  // sends them; they are null in a v1 season and optional for the same reason as the three above.
  /** The v2 score behind the rank, in thousandths. Null in a v1 season, before the first pass, or without a v2 row. */
  scoreMilli: signedAmountSchema.nullable().optional(),
  /** How much history the score rests on. Not a forecast. */
  confidence: standingConfidenceSchema.nullable().optional(),
  /** The UTC day the official rank is as of. The figures are as of the league state's tick. */
  scoredDay: utcDaySchema.nullable().optional(),
  // The two fields below came with the price strip (docs/CONTRACTS.md section 17.2); always sent,
  // optional for the same reason as the fields above.
  /** The agent's three largest holdings, by value at the prices of its latest row, largest first. */
  topHoldings: z
    .array(z.strictObject({ symbol: symbolSchema, weightBps: amountSchema }))
    .max(3)
    .optional(),
  /** The share of the portfolio in cash at the same prices. */
  cashWeightBps: amountSchema.optional(),
});
export type StandingRow = z.infer<typeof standingRowSchema>;

/** What a league table is as of. One row per season and division, replaced at every ranking. */
export const leagueStateSchema = z.strictObject({
  seasonId: idSchema,
  division: divisionSchema,
  /** The tick the ranks are as of. */
  tickId: tickIdSchema,
  computedAt: isoTimeSchema,
  /** The scoring method that produced the ranks, for example "v1". */
  method: z.string(),
  rankedCount: amountSchema,
  /** Ranked and unranked agents together, hidden ones left out. */
  agentCount: amountSchema,
  /** v2 seasons: the day the official ranks are as of, max(season_scores.scored_day). Null before the first pass; null or absent in v1. */
  scoredDay: utcDaySchema.nullable().optional(),
});
export type LeagueState = z.infer<typeof leagueStateSchema>;

/** What the store knows about one agent's standing. The API turns it into a `StandingRow`. */
export interface StandingSource {
  agentId: string;
  name: string;
  createdAt: IsoTime;
  /** The published rank, set by the last ranking. Null if the agent was not ranked then. */
  rank: number | null;
  stats: AgentStats;
  /** The tick of the agent's latest row this season. */
  lastTickId: TickId | null;
  /** The status of that latest row. */
  lastStatus: RowStatus | null;
  // The store always sets the two fields below. They are optional so that a source built by
  // hand in a test may leave them out.
  /** The agent's strategy summary. Null until one is written. */
  summary?: string | null;
  /** The owner's address, so that the API can mark a house agent. It reaches no response. */
  owner?: string;
  /** v2 seasons only: the store sets it from a LEFT JOIN on season_scores. Null when there is no v2 row. */
  official?: OfficialScore | null;
  /**
   * The agent's portfolio after its latest row and the reference prices of that row's tick, so that
   * the API can give a league row its top holdings (docs/CONTRACTS.md section 17.2). The store always
   * sets both; they are optional so that a source built by hand in a test may leave them out.
   */
  portfolio?: PortfolioState;
  prices?: PriceMap;
}

/** One agent as the reference ranking sees it. */
export interface RankInput {
  agentId: string;
  name: string;
  createdAt: IsoTime;
  stats: AgentStats;
  /** The agent's status at the tick being ranked. Null if it had no row at that tick. */
  lastStatus: RowStatus | null;
}

/**
 * Scoring v1. `packages/reputation` implements every function here as a pure function that
 * trusts its input and never throws. docs/CONTRACTS.md section 9 specifies the rules.
 */
export interface ScoringEngine {
  /** The stats of an agent that has no row yet this season. */
  initialStats(): AgentStats;
  /** The stats after one more row. Never mutates `previous`. */
  updateStats(previous: AgentStats, event: StatsEvent): AgentStats;
  /** Why an agent has no rank, or null if it is ranked. `hasRowAtTick` is false for a paused agent. */
  unrankedReason(stats: AgentStats, hasRowAtTick: boolean): UnrankedReason | null;
  /** Negative if `a` comes before `b` in a league table. Never zero for two different agents. */
  compare(a: RankInput, b: RankInput): number;
  /**
   * The reference ranking: ranked agents first, by rank, then the unranked ones.
   * The store ranks in SQL; its order must equal this function's order.
   */
  rankAgents(entries: readonly RankInput[]): StandingRow[];
}
