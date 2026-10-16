import type { AgentRecord } from './agents.ts';
import { marketSnapshotSchema } from './market.ts';
import type { PortfolioState } from './portfolio.ts';
import { fillSchema, portfolioStateSchema } from './portfolio.ts';
import { amountSchema, divisionSchema, idSchema, isoTimeSchema, symbolSchema, tickIdSchema } from './primitives.ts';
import type { AgentStats } from './scoring.ts';
import { rowStatusSchema } from './scoring.ts';
import { z } from './zod.ts';

export const seasonSchema = z.strictObject({
  id: idSchema,
  /** 1 for the first season. */
  number: z.number().int().positive(),
  startsAt: isoTimeSchema,
  /** The season runs up to, and not including, this instant. */
  endsAt: isoTimeSchema,
});
export type Season = z.infer<typeof seasonSchema>;

/**
 * One decision round. A tick belongs to one UTC hour and has one market snapshot,
 * which every agent in the tick decides from and fills at.
 */
export const tickSchema = z.strictObject({
  id: tickIdSchema,
  seasonId: idSchema,
  /** True for the one tick of a trading day at which Open-division agents decide. */
  daily: z.boolean(),
  snapshot: marketSnapshotSchema,
  status: z.enum(['processing', 'complete']),
  createdAt: isoTimeSchema,
  completedAt: isoTimeSchema.nullable(),
});
export type Tick = z.infer<typeof tickSchema>;

/**
 * What happened to one agent at one tick, and the portfolio it left behind.
 * There is at most one row per agent per tick. Rows are never updated or deleted:
 * replaying an agent's rows in tick order must reproduce its record exactly.
 */
export const decisionRowSchema = z.strictObject({
  agentId: idSchema,
  tickId: tickIdSchema,
  seasonId: idSchema,
  division: divisionSchema,
  status: rowStatusSchema,
  /** A NoDecisionCode when status is no_decision, a SkipCode when it is skipped, else null. */
  code: z.string().nullable(),
  /** The validated targets in basis points. Null unless status is decided. */
  targetsBps: z.record(symbolSchema, amountSchema).nullable(),
  /** The model's one sentence. Null unless status is decided. */
  reason: z.string().nullable(),
  fills: z.array(fillSchema),
  /** Symbols that were halted at this tick. */
  halted: z.array(symbolSchema),
  /** The portfolio after this row. */
  portfolio: portfolioStateSchema,
  /** The value of that portfolio at the tick's reference prices. */
  equityMicro: amountSchema,
  /** Fees plus slippage charged in this row. */
  costMicro: amountSchema,
  /** The label of the model that was asked. Null when no model was asked. */
  model: z.string().nullable(),
  /** The agent's `strategyChangedAt` when the model was asked: which strategy decided. Null when no model was asked. */
  strategyAt: isoTimeSchema.nullable(),
  createdAt: isoTimeSchema,
});
export type DecisionRow = z.infer<typeof decisionRowSchema>;

/**
 * A symbol held for review because its price jumped. While it is held, every snapshot keeps
 * `priceMicro` for it and marks it not fresh, so it is valued at the trusted price and not traded.
 */
export const symbolHoldSchema = z.strictObject({
  symbol: symbolSchema,
  /** The last price that was trusted. */
  priceMicro: amountSchema,
  /** The price the feed reported when the hold began. */
  seenPriceMicro: amountSchema,
  sinceTickId: tickIdSchema,
  /** Set when an admin releases the hold. The next tick takes the feed's price and deletes the row. */
  releasedAt: isoTimeSchema.nullable(),
  createdAt: isoTimeSchema,
});
export type SymbolHold = z.infer<typeof symbolHoldSchema>;

/** Everything the scheduler needs to process one agent at one tick. */
export interface AgentWork {
  agent: AgentRecord;
  portfolio: PortfolioState;
  stats: AgentStats;
  /** Rows in a row, up to now, in which the provider refused the key or the model. */
  keyFailures: number;
}
