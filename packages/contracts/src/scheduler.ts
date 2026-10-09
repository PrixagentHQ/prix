import type { MarketPort, PricePoint, RecentReturns } from './market.ts';
import type { ChatMessage, KeyOpener, KeySealer, ModelKeyRecord, ModelPort } from './models.ts';
import type { PortfolioState, SimEngine } from './portfolio.ts';
import type { IsoTime, TickId, TokenSymbol } from './primitives.ts';
import type { ScoringEngine } from './scoring.ts';
import type { Store } from './store.ts';

/** Sizes that come from the free-plan limits. docs/CONTRACTS.md section 2 derives them. */
export interface SchedulerLimits {
  /** Model calls in one step. */
  maxDecisionsPerStep: number;
  /** Rows written without a model call in one step: skipped agents. */
  maxSkipsPerStep: number;
  /** Strategy summaries generated in one step. */
  maxSummariesPerStep: number;
  /** The house model stops for the day when the counted neurons reach this. */
  houseNeuronsPerDay: number;
  /** Neurons counted for one house-model call, from its token counts. */
  houseNeuronsPerMillionInputTokens: number;
  houseNeuronsPerMillionOutputTokens: number;
  /** Of `houseNeuronsPerDay`, the most that summaries may use in a day. Decisions come first. */
  summaryNeuronsPerDay: number;
  modelTimeoutMs: number;
  /** Output tokens for the house model. */
  maxOutputTokens: number;
  /** Output tokens for an owner's model, which may spend some of them reasoning. */
  ownMaxOutputTokens: number;
  /** A feed older than this is stale. */
  feedStaleAfterSeconds: number;
}

/** Everything a scheduler step needs. The Worker entry point builds it from its bindings. */
export interface SchedulerDeps {
  store: Store;
  market: MarketPort;
  sim: SimEngine;
  scoring: ScoringEngine;
  houseModel: ModelPort;
  /** Builds the adapter for an owner's key from the opened key. */
  ownModel(key: ModelKeyRecord, apiKey: string): ModelPort;
  keys: KeyOpener;
  limits: SchedulerLimits;
  /** Structured log. Never pass a key, a prompt or model output to it. */
  log(event: string, data?: Record<string, string | number | boolean | null>): void;
}

export type SchedulerAction = 'idle' | 'market_closed' | 'tick_created' | 'batch' | 'tick_completed';

export interface SchedulerReport {
  action: SchedulerAction;
  tickId: TickId | null;
  decided: number;
  noDecision: number;
  skipped: number;
  /** Agents still without a row for the tick after this step. */
  pending: number;
  summaries: number;
}

/**
 * One step of the scheduler, run by a Cron Trigger every minute. `packages/runtime`
 * implements it. docs/CONTRACTS.md section 10 specifies what a step does.
 * A step never throws: it logs and returns a report.
 */
export type RunSchedulerStep = (deps: SchedulerDeps, now: Date) => Promise<SchedulerReport>;

// --- what packages/runtime exports, besides runSchedulerStep --------------------------------------

/** The part of a Workers AI binding the runtime uses, so it needs no Cloudflare types. */
export interface WorkersAiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** What goes into the user message of a decision call. docs/CONTRACTS.md section 6 shows the JSON. */
export interface DecisionPromptInput {
  now: IsoTime;
  /** One entry per universe symbol, in universe order. */
  prices: readonly PricePoint[];
  returns: readonly RecentReturns[];
  halted: readonly TokenSymbol[];
  portfolio: PortfolioState;
  /** The value of that portfolio at these prices. */
  equityMicro: number;
  /** The owner's strategy prompt, verbatim. */
  strategy: string;
}

export type CreateHouseModel = (ai: WorkersAiLike, modelId: string) => ModelPort;
export type CreateOwnModel = (
  key: Pick<ModelKeyRecord, 'provider' | 'model'>,
  apiKey: string,
  fetchImpl?: typeof fetch,
) => ModelPort;
/** `secretBase64` is 32 random bytes in base64: the Worker secret KEY_ENCRYPTION_KEY. */
export type CreateKeySealer = (secretBase64: string, keyVersion: number) => KeySealer;
/** One secret per key version, so a secret can be rotated without losing old keys. */
export type CreateKeyOpener = (secretsByVersion: Readonly<Record<number, string>>) => KeyOpener;
export type AssembleDecisionMessages = (input: DecisionPromptInput) => ChatMessage[];
/** The messages that ask the house model for a short public summary of a strategy. */
export type AssembleSummaryMessages = (strategy: string) => ChatMessage[];
