import { agentNameSchema, promptSchema, summaryStatusSchema } from './agents.ts';
import type { ApiDeps } from './api.ts';
import {
  FEE_BPS,
  HOUSE_NEURONS_PER_DAY,
  MAX_WEIGHT_BPS,
  MIN_TRADE_BPS,
  SLIPPAGE_BPS,
  STARTING_CASH_MICRO,
} from './constants.ts';
import type { Entitlements, EntitlementsPort, Tier } from './entitlements.ts';
import type { Confidence, DayPrices, ReputationStore, ScoringV2Engine, SeasonMethod } from './phase2-reputation.ts';
import { confidenceSchema, scoreBreakdownSchema, seasonMethodSchema } from './phase2-reputation.ts';
import { ADVICE_WORDS } from './phase3-follow.ts';
import type { PortfolioState, SimEngine } from './portfolio.ts';
import { fillSchema, portfolioStateSchema } from './portfolio.ts';
import type { Address, AgentId, Division, IsoTime, SeasonId, TickId, UtcDay } from './primitives.ts';
import {
  addressSchema,
  amountSchema,
  divisionSchema,
  idSchema,
  isoTimeSchema,
  signedAmountSchema,
  symbolSchema,
  tickIdSchema,
  utcDaySchema,
} from './primitives.ts';
import type { CreateHouseModel, CreateOwnModel, WorkersAiLike } from './scheduler.ts';
import type { AgentStats, ScoringEngine, StandingConfidence } from './scoring.ts';
import { agentStatsSchema, dailyPointSchema, rowStatusSchema } from './scoring.ts';
import type { Store } from './store.ts';
import { z } from './zod.ts';

/**
 * Phase 6, the social strategy layer. docs/contracts/phase-6-social.md says what these mean and what
 * the rules are. Where the two disagree, this file is the shape and that file is the rule.
 *
 * Everything here is paper. It reads the simulation's stored rows and never a wallet, a real order or a
 * real-money record, and nothing here is advice. Nothing here edits a Phase 1 to 5 table, except the
 * official rank of a v2 season, which is Phase 1's `rerank` (docs/CONTRACTS.md section 18).
 */

// --- the switch, the clock, the limits of a run ---------------------------------------------------

/** The Worker variable of prix-api. Off unless it is exactly "true" after trimming and lower-casing. */
export const SOCIAL_ENABLED_VAR = 'SOCIAL_ENABLED';
export function socialEnabled(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/** Every Phase 6 route lives under this prefix. While the switch is off the public routes are not mounted. */
export const SOCIAL_API_PREFIX = '/api/social';

/**
 * The fifth clock schedule: minutes 3, 8, ..., 58. Its own Clock Durable Object, whose alarm runs the step with
 * 50 subrequests. Its CPU is the alarm's, which Cloudflare's Durable Objects limits page sets by the Workers plan
 * (Free: 10 ms; the page's 30 seconds is a default it does not set against the Free plan). Prix sets the step a
 * ceiling of its own, SOCIAL_STEP_CPU_MS (1,000 ms, phase6-holders.ts, revision 8b of
 * docs/contracts/phase-6-holders.md, R8-1 and R8-SEC-1), on observed leniency, not on a promise.
 */
export const SOCIAL_CRON = '3-58/5 * * * *';

/** What one job may do in one run of the social step. */
export const SOCIAL_JOB_MAX_STATEMENTS = 25;
export const SOCIAL_JOB_MAX_MODEL_CALLS = 4;

/** GET /api/social/status. 404 while the switch is off, because the routes are not mounted. */
export const socialStatusResponseSchema = z.strictObject({ on: z.literal(true) });
export type SocialStatusResponse = z.infer<typeof socialStatusResponseSchema>;

/** Rows on one page of a Phase 6 list. */
export const SOCIAL_PAGE_SIZE = 24;
export const socialPageQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100).default(1),
});
export type SocialPageQuery = z.infer<typeof socialPageQuerySchema>;

/**
 * Words that no Phase 6 title, name or copy uses, beside ADVICE_WORDS. qa tests the `social` copy area
 * against this list; admin war titles are checked by `isSocialSafeText`. The forms of "fund" and "bet"
 * are listed one by one so that "fundamental", "between", "better" and "beta" stay usable. "Season" is
 * refused because the league has none (D-109).
 */
export const SOCIAL_FORBIDDEN_WORDS =
  /\b(seasons?|best|smartest|safer|safest|winner\w*|wins?|won|beat\w*|champion\w*|fund(?:s|ed|ing)?|bets?|betting|bettors?|odds|wager\w*|stakes?|jackpot|prize\w*|guarantee\w*|outperform\w*|aggressive|conservative|suitable|risk tolerance)\b/i;

export function isSocialSafeText(text: string): boolean {
  return !SOCIAL_FORBIDDEN_WORDS.test(text) && !ADVICE_WORDS.test(text);
}

/** The confidence of a standing row (scoring.ts) and of v2 (phase2-reputation.ts) must stay the same set. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const STANDING_CONFIDENCE_MATCHES_V2: Same<StandingConfidence, Confidence> = true;

// --- shared shapes ---------------------------------------------------------------------------------

/** A job's cursor: one row of Phase 2's job_state, written in the same batch as the job's work. */
export interface JobCursor {
  name: string;
  body: string;
}

/** The job_state names of Phase 6. */
export const SOCIAL_CURSOR = {
  dna: 'social:dna',
  tape: 'social:tape',
  rivalry: 'social:rivalry',
  managers: 'social:managers',
} as const;

/**
 * A final day: a UTC day with a day_prices row while no tick is processing. `seasonId` is the season of
 * the tick the prices came from. The tape and the managers act on final days only.
 */
export interface FinalDay {
  day: UtcDay;
  tickId: TickId;
  seasonId: SeasonId;
}

/** An agent as the Phase 6 store returns it. The owner is read for ownerShort and the house mark only. */
export interface SocialAgentRecord {
  id: AgentId;
  name: string;
  owner: Address;
  division: Division;
  hidden: boolean;
  createdAt: IsoTime;
}

/** An agent as a Phase 6 response names it. Never an owner address, a prompt or a figure. */
export const socialAgentRefSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  ownerShort: z.string(),
  house: z.boolean(),
});
export type SocialAgentRef = z.infer<typeof socialAgentRefSchema>;

// --- Strategy DNA ------------------------------------------------------------------------------------

export const DNA_METHOD = 'dna-v1';
export const DNA_WINDOW_DAYS = 40;
/** Per axis; the same number as MIN_TRADING_DAYS_V2. */
export const DNA_MIN_DAYS = 10;
export const DNA_MOMENTUM_LOOKBACK_DAYS = 20;
/** A profile is as of a day D with D <= today - DNA_LAG_DAYS: every row of D is past FEED_DELAY_SECONDS. */
export const DNA_LAG_DAYS = 2;
/** Agents per job run. perf tunes it. */
export const DNA_CHUNK_AGENTS = 10;
export const DNA_TURNOVER_PERIOD_DAYS = 20;

export const dnaNoteSchema = z.enum([
  'not_enough_history',
  'no_holdings',
  'needs_market_history',
  'longer_than_window',
]);
export type DnaNote = z.infer<typeof dnaNoteSchema>;

export const dnaAxisSchema = z.strictObject({
  /** The unit is named by the key in `dnaAxesSchema`. Null below the minimum or when not defined. */
  value: z.number().int().nullable(),
  /** Days (or returns) that entered this axis. */
  sample: amountSchema,
  min: amountSchema,
  note: dnaNoteSchema.nullable(),
});
export type DnaAxis = z.infer<typeof dnaAxisSchema>;

export const dnaAxesSchema = z.strictObject({
  /** Effective number of positions x 1000, from 1000 to 20000. */
  positionsMilli: dnaAxisSchema,
  /** Mean cash share of equity, basis points. */
  cashBps: dnaAxisSchema,
  /** Net one-way turnover per DNA_TURNOVER_PERIOD_DAYS priced days, basis points of mean equity. */
  turnoverBps: dnaAxisSchema,
  /** Implied holding period in priced days. Null with `longer_than_window` when nothing sold or above the window. */
  holdingDays: dnaAxisSchema,
  /** Sample standard deviation of daily returns, basis points. */
  swingBps: dnaAxisSchema,
  /** Largest fall from a running peak in the window, basis points of the peak. */
  deepestFallBps: dnaAxisSchema,
  /** Weighted mean of (2 * percentile - 1) of held symbols' trailing returns, x 1000, -1000..1000. */
  momentumMilli: dnaAxisSchema,
});
export type DnaAxes = z.infer<typeof dnaAxesSchema>;

export const dnaProfileSchema = z.strictObject({
  method: z.string(),
  agentId: idSchema,
  status: z.enum(['forming', 'ready']),
  asOfDay: utcDaySchema,
  /** The first priced day of the window: the later of 40 priced days back and the strategy's day. */
  windowStartDay: utcDaySchema,
  /** The UTC day of the agent's strategyChangedAt when computed. */
  strategySinceDay: utcDaySchema,
  pricedDays: amountSchema,
  observedDays: amountSchema,
  firstTickId: tickIdSchema.nullable(),
  lastTickId: tickIdSchema.nullable(),
  axes: dnaAxesSchema,
  computedAt: isoTimeSchema,
});
export type DnaProfile = z.infer<typeof dnaProfileSchema>;

/** The last decision row of one UTC day, reduced to what DNA reads. */
export interface DnaObservation {
  day: UtcDay;
  tickId: TickId;
  seasonId: SeasonId;
  portfolio: PortfolioState;
  equityMicro: number;
}

export interface DnaInput {
  agentId: AgentId;
  asOfDay: UtcDay;
  /** utcDay(agent.strategyChangedAt). */
  strategySinceDay: UtcDay;
  /** Oldest first, at most DNA_WINDOW_DAYS + 1, days <= asOfDay. The first may precede the window (prior state). */
  observations: readonly DnaObservation[];
  /** Oldest first, ending at asOfDay, at most DNA_WINDOW_DAYS + DNA_MOMENTUM_LOOKBACK_DAYS. */
  pricedDays: readonly DayPrices[];
  computedAt: IsoTime;
}

/** `packages/reputation/src/dna.ts` exports `strategyDna`. Pure, deterministic, never throws, no model. */
export interface StrategyDnaEngine {
  profile(input: DnaInput): DnaProfile;
}

/** The body of job_state `social:dna`. */
export interface DnaCursor {
  method: string;
  asOfDay: UtcDay;
  afterAgentId: AgentId | null;
  done: boolean;
}

export interface DnaAgentRef {
  id: AgentId;
  strategyChangedAt: IsoTime;
}

// --- forks -------------------------------------------------------------------------------------------

export const FORK_LINK_WINDOW_SECONDS = 600;
export const FORKS_PER_PARENT_PER_DAY = 20;
/** A parent or root name key at least this long must not appear inside a fork's name key. */
export const FORK_NAME_GUARD_MIN_KEY = 4;
export const LINEAGE_CHILDREN_PREVIEW = 12;
/** Rows a link costs against API_WRITE_ROWS_PER_DAY: the row, two index rows, the counter. */
export const FORK_LINK_WRITE_ROWS = 4;

export const linkForkInputSchema = z.strictObject({ parentId: idSchema });
export type LinkForkInput = z.infer<typeof linkForkInputSchema>;

/** One lineage row. Insert only. */
export interface LineageRow {
  agentId: AgentId;
  parentId: AgentId;
  rootId: AgentId;
  /** 1 or more. An agent without a row has depth 0. */
  depth: number;
  createdAt: IsoTime;
}

/** A member of a family as the store returns it. Hidden members are never returned. */
export interface LineageMember {
  agent: SocialAgentRecord;
  depth: number;
  /** Null when the parent is hidden or the member is the root. */
  parentId: AgentId | null;
}

/** An agent as lineage shows it. No figure, no rank, no prompt, by design. */
export const lineageAgentSchema = socialAgentRefSchema.extend({
  createdAt: isoTimeSchema,
  depth: amountSchema,
});
export type LineageAgent = z.infer<typeof lineageAgentSchema>;

/** A parent or root that is hidden is shown as not shown, with no id and no name. */
export const lineageRefSchema = z.union([lineageAgentSchema, z.strictObject({ shown: z.literal(false) })]);
export type LineageRef = z.infer<typeof lineageRefSchema>;

export const lineageSchema = z.strictObject({
  depth: amountSchema,
  /** Null for an agent that is not a fork. */
  parent: lineageRefSchema.nullable(),
  root: lineageRefSchema.nullable(),
  childCount: amountSchema,
  /** The newest visible children, at most LINEAGE_CHILDREN_PREVIEW. */
  children: z.array(lineageAgentSchema),
});
export type Lineage = z.infer<typeof lineageSchema>;

export const linkForkResponseSchema = z.strictObject({ agentId: idSchema, lineage: lineageSchema });
export type LinkForkResponse = z.infer<typeof linkForkResponseSchema>;

export const familyResponseSchema = z.strictObject({
  rootId: idSchema,
  /** Null when the root is hidden. */
  root: lineageAgentSchema.nullable(),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
  memberCount: amountSchema,
  members: z.array(lineageAgentSchema.extend({ parentId: idSchema.nullable() })),
});
export type FamilyResponse = z.infer<typeof familyResponseSchema>;

/** What the fork builder may prefill from. Strictly public fields; never a figure or a private prompt. */
export const forkSourceResponseSchema = z.strictObject({
  parent: socialAgentRefSchema.extend({
    division: divisionSchema,
    createdAt: isoTimeSchema,
    summary: z.string().nullable(),
    summaryStatus: summaryStatusSchema,
    /** Null unless the owner has published the prompt at the moment of the read. */
    prompt: z.string().nullable(),
  }),
  dna: dnaProfileSchema.nullable(),
  /** Null while the root is hidden. */
  rootId: idSchema.nullable(),
  /** The depth the fork will have. */
  forkDepth: z.number().int().positive(),
});
export type ForkSourceResponse = z.infer<typeof forkSourceResponseSchema>;

// --- rivalries ---------------------------------------------------------------------------------------

/** Tape days of the season, up to the day matched, that one decision looks at. */
export const RIVALRY_WINDOW_TAPE_DAYS = 10;
export const RIVALRY_FORM_CLOSE_DAYS = 5;
export const RIVALRY_FORM_MIN_SWAPS = 1;
export const RIVALRY_KEEP_CLOSE_DAYS = 3;
export const RIVALRY_SMALL_TABLE = 20;
export const RIVALRY_MAX_GAP_SMALL = 1;
export const RIVALRY_MAX_GAP = 2;
export const RIVALRY_MAX_ACTIVE_PER_AGENT = 2;
export const RIVALRY_EVENTS_SHOWN = 50;

/** Places within which two ranks are close, on a day with `rankedCount` ranked agents. */
export function rivalryGap(rankedCount: number): number {
  return rankedCount < RIVALRY_SMALL_TABLE ? RIVALRY_MAX_GAP_SMALL : RIVALRY_MAX_GAP;
}

/** `seasonId-agentLo-agentHi`, the lower agent id first. */
export const rivalryIdSchema = z.string().regex(/^[a-z2-7]{12}-[a-z2-7]{12}-[a-z2-7]{12}$/);
export function rivalryId(seasonId: SeasonId, a: AgentId, b: AgentId): string {
  return a < b ? `${seasonId}-${a}-${b}` : `${seasonId}-${b}-${a}`;
}

/** One final day of one division: visible ranked agents in rank order, from portfolios.rank. */
export interface RankTapeDay {
  seasonId: SeasonId;
  division: Division;
  day: UtcDay;
  method: SeasonMethod;
  ranks: ReadonlyArray<readonly [agentId: AgentId, rank: number]>;
}

/** The body of job_state `social:tape`. `missed` keeps the last ten days whose ranks had moved on. */
export interface TapeCursor {
  tapedDay: UtcDay | null;
  missed: UtcDay[];
}

/** The body of job_state `social:rivalry`. */
export interface RivalryCursor {
  matchedDay: UtcDay | null;
}

const rankSchema = z.number().int().positive();

export const rivalryStatusSchema = z.enum(['active', 'ended']);
export const rivalryEndReasonSchema = z.enum(['apart', 'season_end']);
export const rivalryPointSchema = z.tuple([utcDaySchema, rankSchema.nullable(), rankSchema.nullable()]);

/** One pair in one season and division. `agentA < agentB`. */
export const rivalrySchema = z.strictObject({
  seasonId: idSchema,
  division: divisionSchema,
  agentA: idSchema,
  agentB: idSchema,
  status: rivalryStatusSchema,
  formedDay: utcDaySchema,
  endedDay: utcDaySchema.nullable(),
  endReason: rivalryEndReasonSchema.nullable(),
  /** Who ranked higher on the latest tape day both were ranked. */
  leader: idSchema.nullable(),
  leadChanges: amountSchema,
  lastDay: utcDaySchema,
  /** One point per tape day from the window that formed it: [day, rankA, rankB]. */
  series: z.array(rivalryPointSchema),
});
export type Rivalry = z.infer<typeof rivalrySchema>;

export const rivalryEventKindSchema = z.enum(['formed', 'overtake', 'ended']);
export type RivalryEventKind = z.infer<typeof rivalryEventKindSchema>;

/** Insert only. The page words it from `kind` and `detail`; no model text is ever used. */
export const rivalryEventSchema = z.strictObject({
  seasonId: idSchema,
  agentA: idSchema,
  agentB: idSchema,
  day: utcDaySchema,
  seq: amountSchema,
  kind: rivalryEventKindSchema,
  /** The agent that moved above the other; null for formed and ended. */
  subject: idSchema.nullable(),
  rankA: rankSchema.nullable(),
  rankB: rankSchema.nullable(),
  /** The integers the sentence uses: gap, closeDays, swaps, windowDays. */
  detail: z.record(z.string(), z.number().int()),
});
export type RivalryEvent = z.infer<typeof rivalryEventSchema>;

export interface RivalryDayInput {
  seasonId: SeasonId;
  division: Division;
  /** The season's last RIVALRY_WINDOW_TAPE_DAYS tape days of the division, oldest first, ending with the day matched. */
  tape: readonly RankTapeDay[];
  /** The active rivalries of this season and division before this day. */
  active: readonly Rivalry[];
}

export interface RivalryDayResult {
  /** Rivalries whose row changes, new ones included. */
  upserts: Rivalry[];
  events: RivalryEvent[];
}

/** `packages/reputation/src/rivalry.ts` exports `rivalryEngine`. Pure, deterministic, reads no score. */
export interface RivalryEngine {
  matchDay(input: RivalryDayInput): RivalryDayResult;
  /** Ends every active rivalry of an earlier season with `season_end`, at its last tape day. */
  endSeason(input: { active: readonly Rivalry[]; lastTape: RankTapeDay | null; day: UtcDay }): RivalryDayResult;
  /** Folds matchDay over every tape day, in order; must equal what is stored. */
  replay(input: { tapes: readonly RankTapeDay[] }): { rivalries: Rivalry[]; events: RivalryEvent[] };
}

/** A rivalry as the store returns it for a read: both agents visible, or the row is not returned. */
export interface StoredRivalryView {
  rivalry: Rivalry;
  agentA: SocialAgentRecord;
  agentB: SocialAgentRecord;
}

export const rivalryPublicSchema = z.strictObject({
  id: rivalryIdSchema,
  seasonId: idSchema,
  division: divisionSchema,
  status: rivalryStatusSchema,
  formedDay: utcDaySchema,
  endedDay: utcDaySchema.nullable(),
  endReason: rivalryEndReasonSchema.nullable(),
  agentA: socialAgentRefSchema,
  agentB: socialAgentRefSchema,
  leader: idSchema.nullable(),
  leadChanges: amountSchema,
  lastDay: utcDaySchema,
  rankA: rankSchema.nullable(),
  rankB: rankSchema.nullable(),
});
export type RivalryPublic = z.infer<typeof rivalryPublicSchema>;

export const rivalriesQuerySchema = z.strictObject({
  division: divisionSchema.default('open'),
  page: z.coerce.number().int().min(1).max(100).default(1),
});
export type RivalriesQuery = z.infer<typeof rivalriesQuerySchema>;

export const rivalriesResponseSchema = z.strictObject({
  /** Null before the first season has a tape day. */
  seasonId: idSchema.nullable(),
  division: divisionSchema,
  method: seasonMethodSchema,
  /** Tape days recorded this season in this division, for the empty state. */
  tapedDays: amountSchema,
  page: z.number().int().positive(),
  hasMore: z.boolean(),
  rivalries: z.array(rivalryPublicSchema),
});
export type RivalriesResponse = z.infer<typeof rivalriesResponseSchema>;

export const rivalryDetailResponseSchema = z.strictObject({
  rivalry: rivalryPublicSchema,
  method: seasonMethodSchema,
  series: z.array(rivalryPointSchema),
  /** Newest first, at most RIVALRY_EVENTS_SHOWN. */
  events: z.array(rivalryEventSchema),
});
export type RivalryDetailResponse = z.infer<typeof rivalryDetailResponseSchema>;

// --- Model Wars --------------------------------------------------------------------------------------

/** Workers AI neurons wars may use in a UTC day, and never more than HOUSE_NEURONS_PER_DAY with today's decisions. */
export const WAR_NEURONS_PER_DAY = 300;
export const WAR_DECISIONS_AND_WARS_CEILING = HOUSE_NEURONS_PER_DAY;
/** UTF-8 bytes per token when the input is estimated, as the scheduler does. */
export const WAR_BYTES_PER_TOKEN_ESTIMATE = 3;
export const ACTIVE_WARS_MAX = 1;
export const WAR_ENTRANTS_MIN = 2;
export const WAR_ENTRANTS_MAX = 4;
export const WAR_TRADING_DAYS_MIN = 5;
export const WAR_TRADING_DAYS_MAX = 20;
export const WAR_TRADING_DAYS_DEFAULT = 10;
/** A war not finished by startsOn + this x tradingDays calendar days is stopped with `budget`. */
export const WAR_DEADLINE_DAYS_PER_TRADING_DAY = 3;
export const WAR_MAX_OUTPUT_TOKENS = 300;
export const WAR_TIMEOUT_MS = 20_000;
/** Two war-days in a row of provider_rejected stop the war. */
export const WAR_REJECTED_DAYS_TO_STOP = 2;
/** Rows a war creation costs: the war, its two index rows, up to 4 entrants with their index rows, a counter. */
export const WAR_CREATE_WRITE_ROWS = 12;

/** The rules every war freezes. The universe is added at creation. */
export const WAR_RULES = {
  startingCashMicro: STARTING_CASH_MICRO,
  feeBps: FEE_BPS,
  slippageBps: SLIPPAGE_BPS,
  maxWeightBps: MAX_WEIGHT_BPS,
  minTradeBps: MIN_TRADE_BPS,
  schedule: 'daily_tick',
} as const;

export const warProviderSchema = z.enum(['workers-ai', 'groq']);
export type WarProvider = z.infer<typeof warProviderSchema>;

export interface WarModel {
  /** The id exactly as the provider spells it. */
  id: string;
  provider: WarProvider;
  maker: string;
  family: string;
  label: string;
  /** Workers AI only; null for Groq, which spends no neurons. */
  inputNeuronsPerMillion: number | null;
  outputNeuronsPerMillion: number | null;
  /** UTC day the prices were read on developers.cloudflare.com/workers-ai/platform/pricing. */
  pricesReadOn: UtcDay | null;
  /** Extra input fields sent with every call, Workers AI only (for example thinking off). */
  extra: Readonly<Record<string, unknown>>;
  /** The probe that admitted it: docs/reviews/phase-6-war-models.md. Null means not admitted. */
  probe: { on: UtcDay; valid: number; of: number } | null;
}

/** Candidates. An entry with probe null cannot be chosen. The operator fills `probe` after the house probe. */
export const WAR_MODELS: readonly WarModel[] = [
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    provider: 'workers-ai',
    maker: 'Meta',
    family: 'Llama',
    label: 'Llama 3.3 70B',
    inputNeuronsPerMillion: 26_668,
    outputNeuronsPerMillion: 204_805,
    pricesReadOn: '2026-10-07',
    extra: {},
    probe: null,
  },
  {
    id: '@cf/google/gemma-4-26b-a4b-it',
    provider: 'workers-ai',
    maker: 'Google',
    family: 'Gemma',
    label: 'Gemma 4 26B A4B',
    inputNeuronsPerMillion: 9_091,
    outputNeuronsPerMillion: 27_273,
    pricesReadOn: '2026-10-07',
    extra: { chat_template_kwargs: { enable_thinking: false } },
    probe: { on: '2026-10-09', valid: 27, of: 27 },
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    provider: 'workers-ai',
    maker: 'Mistral AI',
    family: 'Mistral',
    label: 'Mistral Small 3.1 24B',
    inputNeuronsPerMillion: 31_876,
    outputNeuronsPerMillion: 50_488,
    pricesReadOn: '2026-10-07',
    extra: {},
    probe: { on: '2026-10-09', valid: 27, of: 27 },
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    provider: 'workers-ai',
    maker: 'Z.ai',
    family: 'GLM',
    label: 'GLM-4.7-Flash',
    inputNeuronsPerMillion: 5_500,
    outputNeuronsPerMillion: 36_400,
    pricesReadOn: '2026-10-07',
    extra: { chat_template_kwargs: { enable_thinking: false } },
    probe: null,
  },
  {
    id: 'openai/gpt-oss-120b',
    provider: 'groq',
    maker: 'OpenAI',
    family: 'gpt-oss',
    label: 'gpt-oss-120b',
    inputNeuronsPerMillion: null,
    outputNeuronsPerMillion: null,
    pricesReadOn: null,
    extra: {},
    probe: null,
  },
  {
    id: 'qwen/qwen3.8-27b',
    provider: 'groq',
    maker: 'Alibaba',
    family: 'Qwen',
    label: 'Qwen3.8 27B',
    inputNeuronsPerMillion: null,
    outputNeuronsPerMillion: null,
    pricesReadOn: null,
    extra: {},
    probe: null,
  },
];

export function warModelOf(id: string): WarModel | null {
  return WAR_MODELS.find((model) => model.id === id) ?? null;
}

export const warModelIdSchema = z
  .string()
  .refine((id) => warModelOf(id)?.probe != null, 'Choose a model that passed the war probe.');

export const warSlotSchema = z.enum(['A', 'B', 'C', 'D']);
export type WarSlot = z.infer<typeof warSlotSchema>;
export const warStatusSchema = z.enum(['scheduled', 'running', 'complete', 'stopped']);
export type WarStatus = z.infer<typeof warStatusSchema>;
export const warStopReasonSchema = z.enum(['admin', 'prompt_changed', 'model_unavailable', 'budget']);
export type WarStopReason = z.infer<typeof warStopReasonSchema>;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const warRulesSchema = z.strictObject({
  startingCashMicro: amountSchema,
  feeBps: amountSchema,
  slippageBps: amountSchema,
  maxWeightBps: amountSchema,
  minTradeBps: amountSchema,
  universe: z.array(symbolSchema),
  schedule: z.literal('daily_tick'),
});
export type WarRules = z.infer<typeof warRulesSchema>;

/** POST /api/social/admin/wars. Nothing else is accepted; the server fills the rest. */
export const createWarInputSchema = z.strictObject({
  title: z.string().trim().min(3).max(80).refine(isSocialSafeText, 'This title uses a word Prix does not use.'),
  strategy: promptSchema,
  startsOn: utcDaySchema,
  tradingDays: z.number().int().min(WAR_TRADING_DAYS_MIN).max(WAR_TRADING_DAYS_MAX).default(WAR_TRADING_DAYS_DEFAULT),
  models: z
    .array(warModelIdSchema)
    .min(WAR_ENTRANTS_MIN)
    .max(WAR_ENTRANTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'A model can enter a war once.'),
});
export type CreateWarInput = z.infer<typeof createWarInputSchema>;

/** The war as stored. Frozen at creation except status, stop reason, the prompt freeze and the tick ids. */
export const warRecordSchema = z.strictObject({
  id: idSchema,
  number: z.number().int().positive(),
  title: z.string(),
  status: warStatusSchema,
  stopReason: warStopReasonSchema.nullable(),
  strategy: z.string(),
  strategySha256: sha256HexSchema,
  /** SHA-256 of DECISION_SYSTEM_MESSAGE, frozen at the first war-day. */
  systemMessageSha256: sha256HexSchema.nullable(),
  /** "decision@" + the first 12 hex of systemMessageSha256. */
  promptVersion: z.string().nullable(),
  rules: warRulesSchema,
  startsOn: utcDaySchema,
  tradingDays: amountSchema,
  deadlineDay: utcDaySchema,
  /** Scoring method of the table order. */
  method: z.literal('v1'),
  createdAt: isoTimeSchema,
  firstTickId: tickIdSchema.nullable(),
  lastTickId: tickIdSchema.nullable(),
  endedAt: isoTimeSchema.nullable(),
});
export type WarRecord = z.infer<typeof warRecordSchema>;

export const warEntrantSchema = z.strictObject({
  warId: idSchema,
  slot: warSlotSchema,
  modelId: z.string(),
  provider: warProviderSchema,
  maker: z.string(),
  family: z.string(),
  label: z.string(),
  extra: z.record(z.string(), z.unknown()),
  maxOutputTokens: amountSchema,
  inputNeuronsPerMillion: z.number().nonnegative().nullable(),
  outputNeuronsPerMillion: z.number().nonnegative().nullable(),
  pricesReadOn: utcDaySchema.nullable(),
  probedOn: utcDaySchema,
  portfolio: portfolioStateSchema,
  stats: agentStatsSchema,
  lastTickId: tickIdSchema.nullable(),
  days: amountSchema,
  /** provider_rejected war-days in a row. */
  rejectedDays: amountSchema,
});
export type WarEntrant = z.infer<typeof warEntrantSchema>;

/** One entrant at one war-day. Insert only. Mirrors a league decision row; no raw model output is stored. */
export const warRowSchema = z.strictObject({
  warId: idSchema,
  slot: warSlotSchema,
  tickId: tickIdSchema,
  status: rowStatusSchema,
  code: z.string().nullable(),
  targetsBps: z.record(symbolSchema, amountSchema).nullable(),
  reason: z.string().nullable(),
  fills: z.array(fillSchema),
  halted: z.array(symbolSchema),
  portfolio: portfolioStateSchema,
  equityMicro: amountSchema,
  costMicro: amountSchema,
  inputTokens: amountSchema.nullable(),
  outputTokens: amountSchema.nullable(),
  neurons: z.number().nonnegative().nullable(),
  createdAt: isoTimeSchema,
});
export type WarRow = z.infer<typeof warRowSchema>;

export const warStandingSchema = z.strictObject({
  slot: warSlotSchema,
  modelId: z.string(),
  provider: warProviderSchema,
  label: z.string(),
  maker: z.string(),
  /** Null while the war runs. Equal return and drawdown share a rank. */
  rank: z.number().int().positive().nullable(),
  returnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  tradeCount: amountSchema,
  days: amountSchema,
  decided: amountSchema,
  noDecision: amountSchema,
  skipped: amountSchema,
  codes: z.record(z.string(), amountSchema),
  costMicro: amountSchema,
  neurons: z.number().nonnegative(),
  v2: scoreBreakdownSchema,
  confidence: confidenceSchema,
  daily: z.array(dailyPointSchema),
});
export type WarStanding = z.infer<typeof warStandingSchema>;

export interface WarStandingInput {
  entrant: WarEntrant;
  rows: readonly WarRow[];
}

/** `packages/reputation/src/war-standings.ts` exports `warStandings`. Pure; v1 order; v2 shown, never ordering. */
export interface WarStandingsEngine {
  standings(entrants: readonly WarStandingInput[], complete: boolean): WarStanding[];
}

export const warDaySchema = z.strictObject({
  tickId: tickIdSchema,
  takenAt: isoTimeSchema,
  pricesMicro: z.record(symbolSchema, amountSchema),
  halted: z.array(symbolSchema),
});
export type WarDay = z.infer<typeof warDaySchema>;

export const warEntrantPublicSchema = warEntrantSchema.omit({ portfolio: true, stats: true, rejectedDays: true });

export const warListResponseSchema = z.strictObject({
  page: z.number().int().positive(),
  hasMore: z.boolean(),
  wars: z.array(
    z.strictObject({
      id: idSchema,
      number: z.number().int().positive(),
      title: z.string(),
      status: warStatusSchema,
      startsOn: utcDaySchema,
      tradingDays: amountSchema,
      daysDone: amountSchema,
      entrants: z.array(
        z.strictObject({ slot: warSlotSchema, modelId: z.string(), label: z.string(), maker: z.string() }),
      ),
    }),
  ),
});
export type WarListResponse = z.infer<typeof warListResponseSchema>;

export const warDetailResponseSchema = z.strictObject({
  war: warRecordSchema,
  entrants: z.array(warEntrantPublicSchema),
  standings: z.array(warStandingSchema),
  days: z.array(warDaySchema),
  rows: z.array(warRowSchema),
});
export type WarDetailResponse = z.infer<typeof warDetailResponseSchema>;

/** What the war job may change on a war. */
export type WarPatch = Partial<
  Pick<
    WarRecord,
    'status' | 'stopReason' | 'systemMessageSha256' | 'promptVersion' | 'firstTickId' | 'lastTickId' | 'endedAt'
  >
>;

// --- paper managers ----------------------------------------------------------------------------------

export const MANAGER_MIN_AGENTS = 2;
export const MANAGER_MAX_AGENTS = 5;
export const MANAGER_MIN_WEIGHT_BPS = 500;
/** The paper engine's own cap, so sim.rebalance is reused unmodified. */
export const MANAGER_MAX_WEIGHT_BPS = MAX_WEIGHT_BPS;
export const MANAGER_EXIT_AFTER_MISSING_DAYS = 3;
export const MANAGER_POLICY_CHANGES_PER_DAY = 1;
export const MANAGER_CHUNK = 25;
/** Open managers only (active or paused, not hidden): a closed or hidden manager frees its place. */
export const MAX_MANAGERS_TOTAL = 250;
export const MANAGERS_CREATED_PER_DAY = 50;
/**
 * Sybil limits on manager creation, the same kind as on agent creation (docs/contracts/phase-2-reputation.md,
 * the creation guard): per network a day and a rolling period (`creationPeriod`, D-109), where a network is the
 * keyed hash of the client IP address (`networkKey`, an IPv6 address by its /48). Keys `d:<day>:mgrnet:<network>`
 * and `p:<period>:mgrnet:<network>`, taken with `takeCounter` beside the others and given back unless the answer is 201.
 */
export const NEW_MANAGERS_PER_NETWORK_PER_DAY = 3;
export const NEW_MANAGERS_PER_NETWORK_PER_PERIOD = 8;
/** Creations a wallet may make beyond its slots in one rolling period (`creationPeriod`, D-109), key `p:<period>:mgr:<address>`. */
export const MANAGER_EXTRA_CREATIONS_PER_PERIOD = 2;
/** @deprecated D-109: use MANAGER_EXTRA_CREATIONS_PER_PERIOD; the operator removes this name once nothing reads it. */
export const MANAGER_EXTRA_CREATIONS_PER_SEASON = MANAGER_EXTRA_CREATIONS_PER_PERIOD;
export const MANAGER_SLOTS_PREVIEW = 1;
export const MANAGER_SLOTS_BY_TIER: Readonly<Record<Tier, number>> = { 0: 1, 1: 2, 2: 3, 3: 5 };
export const MANAGER_REBALANCES_SHOWN = 20;
export const MANAGER_CREATE_WRITE_ROWS = 8;
export const MANAGER_POLICY_WRITE_ROWS = 3;
export const MANAGER_STATUS_WRITE_ROWS = 3;

/** Refused as a whole word of a manager name. */
export const MANAGER_NAME_BLOCKED_WORDS: readonly string[] = [
  'asset',
  'assets',
  'management',
  'advisor',
  'adviser',
  'advisors',
  'etf',
  'trust',
  'bank',
  'securities',
  'partners',
  'llc',
  'ltd',
  'inc',
];
/** Refused anywhere inside a manager name's letters and digits. */
export const MANAGER_NAME_BLOCKED_PARTS: readonly string[] = ['fund', 'invest', 'capital', 'wealth'];

export function isManagerNameAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter((word) => word !== '');
  if (words.some((word) => MANAGER_NAME_BLOCKED_WORDS.includes(word))) return false;
  const key = lower.replace(/[^a-z0-9]/g, '');
  return !MANAGER_NAME_BLOCKED_PARTS.some((part) => key.includes(part));
}

export function maxManagersFor(entitlements: Entitlements): number {
  return entitlements.gatingOn ? MANAGER_SLOTS_BY_TIER[entitlements.tier] : MANAGER_SLOTS_PREVIEW;
}

/** The word rules of every Phase 6 string apply to a manager name too. */
export const managerNameSchema = agentNameSchema
  .refine(isManagerNameAllowed, 'That name is not allowed for a paper manager.')
  .refine(isSocialSafeText, 'That name is not allowed for a paper manager.');
export const managerScheduleSchema = z.enum(['weekly', 'hold']);
export type ManagerSchedule = z.infer<typeof managerScheduleSchema>;
export const managerStatusSchema = z.enum(['active', 'paused', 'closed']);
export type ManagerStatus = z.infer<typeof managerStatusSchema>;
export const rebalanceReasonSchema = z.enum(['start', 'policy', 'scheduled', 'exit']);
export type RebalanceReason = z.infer<typeof rebalanceReasonSchema>;

/** Target weights by agent id: 2..5 agents, each 500..4000 bps, sum <= 10000; cash is the rest. */
export const managerTargetsSchema = z
  .record(idSchema, z.number().int().min(MANAGER_MIN_WEIGHT_BPS).max(MANAGER_MAX_WEIGHT_BPS))
  .refine((targets) => {
    const n = Object.keys(targets).length;
    return n >= MANAGER_MIN_AGENTS && n <= MANAGER_MAX_AGENTS;
  }, 'Pick from 2 to 5 agents.')
  .refine(
    (targets) => Object.values(targets).reduce((sum, bps) => sum + bps, 0) <= 10_000,
    'Weights add up to more than 100%.',
  );

export const managerRecordSchema = z.strictObject({
  id: idSchema,
  /** Never in a public response. */
  owner: addressSchema,
  name: z.string(),
  nameKey: z.string(),
  status: managerStatusSchema,
  hidden: z.boolean(),
  policyVersion: z.number().int().positive(),
  createdAt: isoTimeSchema,
  createdDay: utcDaySchema,
  updatedAt: isoTimeSchema,
});
export type ManagerRecord = z.infer<typeof managerRecordSchema>;

/** Insert only. A version set on `setDay` takes effect at the first final day strictly after it. */
export const managerPolicySchema = z.strictObject({
  managerId: idSchema,
  version: z.number().int().positive(),
  targetsBps: managerTargetsSchema,
  schedule: managerScheduleSchema,
  setAt: isoTimeSchema,
  setDay: utcDaySchema,
});
export type ManagerPolicy = z.infer<typeof managerPolicySchema>;

/** The paper book of one manager in one season. Holdings are micro-units of an agent priced at its daily equity. */
export const managerBookSchema = z.strictObject({
  cashMicro: amountSchema,
  holdings: z.record(idSchema, amountSchema),
  lastValue: z.record(idSchema, amountSchema),
  missingDays: z.record(idSchema, amountSchema),
  policyVersion: z.number().int().nonnegative(),
  lastRebalanceDay: utcDaySchema.nullable(),
});
export type ManagerBook = z.infer<typeof managerBookSchema>;

export const managerFillSchema = fillSchema.omit({ symbol: true }).extend({ agentId: idSchema });
export type ManagerFill = z.infer<typeof managerFillSchema>;

export interface ManagerDayInput {
  /** Null on the first valued day of the season: the book starts as sim.newPortfolio(). */
  book: ManagerBook | null;
  /** Null on the first valued day of the season: scoring.initialStats(). */
  stats: AgentStats | null;
  day: UtcDay;
  /** Every held or targeted agent: its daily point on `day`, or null when it has none. */
  values: Readonly<Record<AgentId, number | null>>;
  /** The policy in force on `day`: the latest version with setDay < day. */
  policy: ManagerPolicy;
}

export interface ManagerDayResult {
  book: ManagerBook;
  /** scoring.updateStats: tradingDays = valued days, decidedCount = rebalance days, tradeCount = fills. */
  stats: AgentStats;
  equityBeforeMicro: number;
  equityMicro: number;
  reason: RebalanceReason | null;
  fills: ManagerFill[];
  costMicro: number;
  exited: AgentId[];
  /** The targets actually used, after exits. Null when nothing was rebalanced. */
  targetsUsed: Record<AgentId, number> | null;
}

/** `packages/sim/src/manager.ts` exports `createManagerEngine`. Pure; sim.rebalance and sim.valuePortfolio unchanged. */
export interface ManagerEngine {
  day(input: ManagerDayInput): ManagerDayResult;
  replay(input: {
    policies: readonly ManagerPolicy[];
    days: ReadonlyArray<{ day: UtcDay; values: Readonly<Record<AgentId, number | null>> }>;
  }): { book: ManagerBook; stats: AgentStats; rebalances: ManagerDayResult[] };
}
export type CreateManagerEngine = (deps: { sim: SimEngine; scoring: ScoringEngine }) => ManagerEngine;

/** The body of job_state `social:managers`. */
export interface ManagerCursor {
  valuedDay: UtcDay | null;
  work: { day: UtcDay; seasonId: SeasonId; afterId: AgentId | null } | null;
}

/** One manager to value on one day, as the store reads it. */
export interface ManagerWork {
  manager: ManagerRecord;
  policy: ManagerPolicy;
  book: ManagerBook | null;
  stats: AgentStats | null;
  lastDay: UtcDay | null;
}

export interface ManagerDayWrite {
  managerId: string;
  /** The book's last_day as read; the write applies only while it is still this (compare and set). */
  prevDay: UtcDay | null;
  result: ManagerDayResult;
  /** scoringV2.breakdownOf(momentsOf(dailyReturnsBps(STARTING_CASH_MICRO, stats.daily))).volMilliBps */
  volMilliBps: number;
}

export const managerRebalanceSchema = z.strictObject({
  day: utcDaySchema,
  reason: rebalanceReasonSchema,
  policyVersion: z.number().int().positive(),
  targetsBps: z.record(idSchema, amountSchema),
  fills: z.array(managerFillSchema),
  exited: z.array(idSchema),
  equityBeforeMicro: amountSchema,
  equityAfterMicro: amountSchema,
  costMicro: amountSchema,
});
export type ManagerRebalance = z.infer<typeof managerRebalanceSchema>;

export interface ManagerBookRow {
  book: ManagerBook;
  stats: AgentStats;
  lastDay: UtcDay | null;
  volMilliBps: number;
}

export interface ManagerListRow {
  manager: ManagerRecord;
  policy: ManagerPolicy;
  /** Null before the first valued day of the season. */
  book: ManagerBookRow | null;
}

export const managerSeasonFiguresSchema = z.strictObject({
  seasonId: idSchema,
  returnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  /** Daily volatility, not annualised. */
  volMilliBps: amountSchema,
  valuedDays: amountSchema,
  equityMicro: amountSchema,
});

export const managerRowSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  status: managerStatusSchema,
  schedule: managerScheduleSchema,
  agentCount: amountSchema,
  createdAt: isoTimeSchema,
  /** Null before the first valued day of the season. */
  season: managerSeasonFiguresSchema.nullable(),
});
export type ManagerRow = z.infer<typeof managerRowSchema>;

export const managerAllocationLineSchema = z.strictObject({
  /** Null when the agent is no longer public: the page says so and shows no name or link. */
  agent: socialAgentRefSchema.nullable(),
  targetBps: amountSchema,
  currentBps: amountSchema,
  state: z.enum(['valued', 'no_point_today', 'exited']),
});

export const managerListResponseSchema = z.strictObject({
  seasonId: idSchema.nullable(),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
  managers: z.array(managerRowSchema),
});
export type ManagerListResponse = z.infer<typeof managerListResponseSchema>;

export const managerDetailResponseSchema = z.strictObject({
  manager: managerRowSchema.extend({ policyVersion: z.number().int().positive() }),
  allocation: z.array(managerAllocationLineSchema),
  cashBps: amountSchema,
  lastRebalanceDay: utcDaySchema.nullable(),
  daily: z.array(dailyPointSchema),
  /** Newest first, at most MANAGER_REBALANCES_SHOWN. */
  rebalances: z.array(managerRebalanceSchema),
});
export type ManagerDetailResponse = z.infer<typeof managerDetailResponseSchema>;

export const myManagersResponseSchema = z.strictObject({
  slots: z.strictObject({ used: amountSchema, max: amountSchema }),
  managers: z.array(
    managerRowSchema.extend({
      hidden: z.boolean(),
      targetsBps: z.record(idSchema, amountSchema),
      /** True when today's one policy change is used. */
      changedToday: z.boolean(),
    }),
  ),
});
export type MyManagersResponse = z.infer<typeof myManagersResponseSchema>;

export const createManagerInputSchema = z.strictObject({
  name: managerNameSchema,
  targetsBps: managerTargetsSchema,
  schedule: managerScheduleSchema,
});
export type CreateManagerInput = z.infer<typeof createManagerInputSchema>;

export const patchManagerInputSchema = z.union([
  z.strictObject({ policy: z.strictObject({ targetsBps: managerTargetsSchema, schedule: managerScheduleSchema }) }),
  z.strictObject({ status: managerStatusSchema }),
]);
export type PatchManagerInput = z.infer<typeof patchManagerInputSchema>;

export const setManagerHiddenInputSchema = z.strictObject({ hidden: z.boolean() });

// --- the agent page read -----------------------------------------------------------------------------

/** GET /api/social/agents/:id: everything Phase 6 shows on an agent's page, in one cached read. */
export const agentSocialResponseSchema = z.strictObject({
  agentId: idSchema,
  /** Null before the first computation. */
  dna: dnaProfileSchema.nullable(),
  dnaWindowDays: amountSchema,
  dnaMinDays: amountSchema,
  lineage: lineageSchema,
  /** Active rivalries of the current season, at most RIVALRY_MAX_ACTIVE_PER_AGENT. */
  rivalries: z.array(rivalryPublicSchema),
});
export type AgentSocialResponse = z.infer<typeof agentSocialResponseSchema>;

// --- the store ---------------------------------------------------------------------------------------

/**
 * `apps/api/src/store/social.ts` exports `createSocialStore(db)`. Every method is one D1 call or one D1
 * batch; no method loads a whole division; every query uses an index of 0001, 0002 or 0008. No method
 * selects `agents.prompt`. A method that names agents for a read leaves hidden agents out unless it says so.
 */
export interface SocialStore {
  // shared
  /** Priced days after `afterDay` (all when null) while no tick is processing, oldest first, at most `limit`. */
  listFinalDays(afterDay: UtcDay | null, limit: number): Promise<FinalDay[]>;
  putCursor(cursor: JobCursor, now: IsoTime): Promise<void>;
  /** The agents with these ids, hidden ones included (with `hidden: true`). At most 100 ids. */
  listAgentRecords(ids: readonly AgentId[]): Promise<SocialAgentRecord[]>;

  // Strategy DNA
  /** Visible agents with an id after `afterId`, by id. */
  listDnaAgents(afterId: AgentId | null, limit: number): Promise<DnaAgentRef[]>;
  /** One batch: for each agent, its last row of each UTC day up to `throughDay`, at most `limit` days, oldest first. */
  listEndOfDay(
    agentIds: readonly AgentId[],
    throughDay: UtcDay,
    limit: number,
  ): Promise<Map<AgentId, DnaObservation[]>>;
  /** One batch: upserts the profiles and writes the cursor. */
  putDnaProfiles(profiles: readonly DnaProfile[], cursor: JobCursor, now: IsoTime): Promise<void>;
  getDna(agentId: AgentId): Promise<DnaProfile | null>;

  // forks
  putLineage(row: LineageRow): Promise<'stored' | 'exists'>;
  getLineage(agentId: AgentId): Promise<LineageRow | null>;
  countChildren(parentId: AgentId): Promise<number>;
  /** Visible children, newest first. */
  listChildren(parentId: AgentId, limit: number, offset: number): Promise<LineageMember[]>;
  countFamily(rootId: AgentId): Promise<number>;
  /** Visible members under one root, in creation order. */
  listFamily(rootId: AgentId, limit: number, offset: number): Promise<LineageMember[]>;

  // rank tape and rivalries
  /** One batch: one rivalry_days row per division, built in SQL from portfolios.rank, and the cursor. */
  writeTape(seasonId: SeasonId, day: UtcDay, method: SeasonMethod, cursor: JobCursor, now: IsoTime): Promise<void>;
  /** The newest `limit` tape days of the division up to `throughDay`, returned oldest first. */
  listTape(seasonId: SeasonId, division: Division, throughDay: UtcDay, limit: number): Promise<RankTapeDay[]>;
  countTapeDays(seasonId: SeasonId, division: Division): Promise<number>;
  /** Active rivalries of a division, of every season, oldest season first. */
  listActiveRivalries(division: Division, limit: number): Promise<Rivalry[]>;
  /** One batch: upserts, inserts the events, writes the cursor. */
  applyRivalryDay(result: RivalryDayResult, cursor: JobCursor, now: IsoTime): Promise<void>;
  /** Rivalries of a season and division with both agents visible: active first, newest formed first. */
  listRivalries(seasonId: SeasonId, division: Division, limit: number, offset: number): Promise<StoredRivalryView[]>;
  /** Active rivalries of one agent in one season, both agents visible. */
  listAgentRivalries(agentId: AgentId, seasonId: SeasonId): Promise<StoredRivalryView[]>;
  /** Null when unknown or when either agent is hidden. Events newest first, at most `eventLimit`. */
  getRivalry(
    seasonId: SeasonId,
    agentA: AgentId,
    agentB: AgentId,
    eventLimit: number,
  ): Promise<{ view: StoredRivalryView; events: RivalryEvent[] } | null>;

  // Model Wars
  /** Inserts the war with the next number and its entrants, unless a war is scheduled or running. */
  createWar(
    war: Omit<WarRecord, 'number'>,
    entrants: readonly WarEntrant[],
  ): Promise<{ result: 'created'; number: number } | { result: 'war_open' }>;
  /** The war that is scheduled or running, if any. */
  getOpenWar(): Promise<WarRecord | null>;
  getWar(id: string): Promise<WarRecord | null>;
  /** Newest first. */
  listWars(limit: number, offset: number): Promise<WarRecord[]>;
  listWarEntrants(warId: string): Promise<WarEntrant[]>;
  /** In tick and slot order. At most WAR_TRADING_DAYS_MAX x WAR_ENTRANTS_MAX rows. */
  listWarRows(warId: string): Promise<WarRow[]>;
  /** The daily tick of a UTC day, if it exists. */
  getDailyTickOf(day: UtcDay): Promise<{ id: TickId; status: 'processing' | 'complete' } | null>;
  getWarNeurons(day: UtcDay): Promise<number>;
  /** One statement: adds `neurons` only if the day's total stays at or below `max`. False, nothing written, otherwise. */
  reserveWarNeurons(day: UtcDay, neurons: number, max: number): Promise<boolean>;
  /** Adds `delta` (negative to give back), never below zero. */
  adjustWarNeurons(day: UtcDay, delta: number): Promise<void>;
  /**
   * One batch: inserts every row, then updates every entrant and the war. False, and nothing written,
   * if a row of that war, tick and slot already exists.
   */
  writeWarDay(
    warId: string,
    rows: readonly WarRow[],
    entrants: readonly WarEntrant[],
    patch: WarPatch,
    now: IsoTime,
  ): Promise<boolean>;
  updateWar(id: string, patch: WarPatch, now: IsoTime): Promise<void>;

  // paper managers
  /**
   * Inserts the manager and its first policy unless the owner has `maxForOwner` active or paused managers,
   * `maxTotal` managers exist, or the name key is used by a manager, an agent or a listing. Decided in SQL.
   */
  createManager(
    manager: ManagerRecord,
    policy: ManagerPolicy,
    limits: { maxForOwner: number; maxTotal: number },
  ): Promise<'created' | 'owner_limit' | 'name_taken' | 'full'>;
  getManager(id: string): Promise<ManagerRecord | null>;
  listManagersByOwner(owner: Address): Promise<ManagerRecord[]>;
  getLatestPolicy(managerId: string): Promise<ManagerPolicy | null>;
  /** Stores the policy only if its version is the manager's current version plus one; moves the version. */
  putPolicy(policy: ManagerPolicy, now: IsoTime): Promise<'stored' | 'changed'>;
  /** Only the owner's manager changes when `owner` is given; null for an admin. A closed manager never changes. */
  setManagerStatus(id: string, owner: Address | null, status: ManagerStatus, now: IsoTime): Promise<boolean>;
  setManagerHidden(id: string, hidden: boolean, now: IsoTime): Promise<boolean>;
  /** Active, visible managers after `afterId` by id, with the policy in force on `day` and their book of the season. */
  listManagersToValue(seasonId: SeasonId, day: UtcDay, afterId: string | null, limit: number): Promise<ManagerWork[]>;
  /** Each agent's daily point for `day` in the season, or null. Computed in SQL. */
  agentValuesOn(seasonId: SeasonId, day: UtcDay, agentIds: readonly AgentId[]): Promise<Record<AgentId, number | null>>;
  /** One batch: books (compare and set on last_day), rebalances, the cursor. */
  applyManagerDays(
    seasonId: SeasonId,
    day: UtcDay,
    writes: readonly ManagerDayWrite[],
    cursor: JobCursor,
    now: IsoTime,
  ): Promise<void>;
  /** Visible managers, newest first, with their book of the season. */
  listManagers(seasonId: SeasonId, limit: number, offset: number): Promise<ManagerListRow[]>;
  getManagerBook(managerId: string, seasonId: SeasonId): Promise<ManagerBookRow | null>;
  /** Newest first. */
  listManagerRebalances(managerId: string, seasonId: SeasonId, limit: number): Promise<ManagerRebalance[]>;
}

// --- scheduled work ----------------------------------------------------------------------------------

/**
 * The sixth name, `x_recheck`, is Phase 6.2's (phase6-voices.ts): the daily recheck of linked X accounts.
 * The seventh, `room_prune`, is Phase 6.3's (phase6-room.ts): it deletes the room's oldest messages.
 * The eighth, `room_picture_sweep`, is Phase 6.4's (phase6-room-pictures.ts): it deletes the bytes of
 * removed pictures that a KV delete failed for. In the entry's list of jobs it stands before `room_prune`,
 * which stays the last job of the step.
 *
 * Phase 6.4, revision 3: this schema lists the names in the order the phases added them, so
 * `room_picture_sweep` is its eighth name. Phase 6.7 (the holders contract, revision 4, HB3-3) adds `poll_tally`
 * as the ninth, and Phase 6.8 `holders_lounge_sweep` as the tenth and last, so the sweep is no longer the last. Nothing reads the order of this list: the order
 * the jobs run in is the entry's list, where the tally and the sweep stand before the prune.
 */
export const socialJobNameSchema = z.enum([
  'model_war',
  'rank_tape',
  'rivalry_match',
  'strategy_dna',
  'manager_value',
  'x_recheck',
  'room_prune',
  'room_picture_sweep',
  /** Phase 6.7: the holders' poll's count after its close (docs/contracts/phase-6-holders.md section 5). */
  'poll_tally',
  // Phase 6.8, the holders' second wave (docs/contracts/phase-6-holders-2.md section 4.6): the lounge's
  // daily sweep, appended after the names already here (after the first wave's `poll_tally` once both are
  // merged). In the entry's list it stands before `room_picture_sweep` (after `poll_tally` once both are
  // merged), and `room_prune` stays last.
  'holders_lounge_sweep',
]);
export type SocialJobName = z.infer<typeof socialJobNameSchema>;

/**
 * `idle`: nothing to do, nothing written. `more`: did a chunk, there is more. `done`: finished for now.
 * `failed`: the run threw; it was logged as social_job_failed, and the step goes on to the next job.
 */
export type SocialJobOutcome = 'idle' | 'more' | 'done' | 'failed';

/**
 * A job that answered `failed` on this many runs in a row is skipped until the next UTC day. The count
 * is a row of Phase 2's job_state named by `socialFailureCursor`, written by one upsert after a failure
 * and cleared by the next run that does work.
 */
export const SOCIAL_JOB_SKIP_AFTER_FAILURES = 3;
export function socialFailureCursor(job: SocialJobName): string {
  return `social:fail:${job}`;
}

export interface SocialJob {
  name: SocialJobName;
  /** Never throws: a failure is logged as social_job_failed with the job name and answers `failed`. */
  run(now: Date): Promise<SocialJobOutcome>;
}

export interface SocialStepResult {
  ran: SocialJobName | null;
  outcome: SocialJobOutcome;
}

/** `packages/runtime/src/social/step.ts`. Runs the first job that is not idle, and returns. */
export type RunSocialStep = (jobs: readonly SocialJob[], now: Date) => Promise<SocialStepResult>;

/** How the war job reaches the models. The Groq key goes only through createOwnModel. */
export interface WarModelDeps {
  ai: WorkersAiLike;
  /** The Worker secret GROQ_API_KEY, or null when it is not set. */
  groqApiKey: string | null;
  createHouseModel: CreateHouseModel;
  createOwnModel: CreateOwnModel;
}

/**
 * What the job factories of `packages/runtime/src/social/` take: createModelWarJob, createRankTapeJob,
 * createRivalryMatchJob, createStrategyDnaJob, createManagerValueJob. They run whatever SOCIAL_ENABLED says.
 */
export interface SocialJobDeps {
  store: Store;
  social: SocialStore;
  reputation: Pick<ReputationStore, 'getJobState' | 'listDayPrices' | 'latestPricedDay' | 'getSeasonMethod'>;
  sim: SimEngine;
  scoring: ScoringEngine;
  scoringV2: ScoringV2Engine;
  dna: StrategyDnaEngine;
  rivalry: RivalryEngine;
  manager: ManagerEngine;
  war: WarModelDeps;
  now(): Date;
  /** Never pass a key, a prompt or model output. */
  log(event: string, data?: Record<string, string | number | boolean | null>): void;
}

// --- HTTP --------------------------------------------------------------------------------------------

/**
 * `apps/api/src/http/social/` exports `createSocialRoutes(deps)` (public and owner routes, mounted only
 * while the switch is on) and `createSocialAdminRoutes(deps)` (mounted always; the generic 404 to anyone
 * who is not an admin session).
 */
export interface SocialApiDeps extends ApiDeps {
  social: SocialStore;
  /** The counters (forks per parent, manager creations and edits) and the season method. */
  reputation: Pick<ReputationStore, 'takeCounter' | 'giveBackCounter' | 'getSeasonMethod' | 'getFirstSignIn'>;
  entitlements: EntitlementsPort;
  warStandings: WarStandingsEngine;
  /** True when the Worker has GROQ_API_KEY: a war may then enter a Groq model. */
  groqConfigured: boolean;
}
