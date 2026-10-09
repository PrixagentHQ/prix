import { z } from 'zod';
import { agentNameSchema } from './agents.ts';
import type { ApiDeps } from './api.ts';
import type { EntitlementsPort } from './entitlements.ts';
import type { PortfolioState, SimEngine } from './portfolio.ts';
import type { Address, IsoTime, TokenSymbol, UtcDay } from './primitives.ts';
import {
  addressSchema,
  amountSchema,
  idSchema,
  isoTimeSchema,
  signedAmountSchema,
  symbolSchema,
  tickIdSchema,
  utcDaySchema,
} from './primitives.ts';
import type { AgentStats, ScoringEngine, UnrankedReason } from './scoring.ts';
import { unrankedReasonSchema } from './scoring.ts';
import type { Store } from './store.ts';
import type { DecisionRow, Season, Tick } from './ticks.ts';
import { seasonSchema } from './ticks.ts';

/**
 * Phase 2, Reputation. docs/contracts/phase-2-reputation.md says what these mean and what the rules are.
 * Where the two disagree, this file is the shape and that file is the rule; report the disagreement.
 *
 * Nothing here edits a Phase 1 file. Scoring v2 is a second method beside v1: a season's method is
 * stored in `season_methods`, and a season without a row there is v1. v1 results never change.
 */

// --- constants ---------------------------------------------------------------------------------

export const SCORING_METHOD_V2 = 'v2';
/** The method of the estimated record of a listed on-chain agent. Every such record names it. */
export const CHAIN_METHOD = 'chain-v1';
/**
 * D-109: the league is one continuous league. Season 1 is its only season and ends here, which in
 * practice is never, so no rollover runs, nothing resets and no season is shown on the site.
 */
export const ONE_LEAGUE_ENDS_AT = '2099-12-31T00:00:00.000Z';
/** Seasons from the second on are eight weeks long and scored with v2 (unused while D-109 holds). */
export const SEASON_LENGTH_DAYS_V2 = 56;
/** The next season row is created this long before the current one ends, and its portfolios with it. */
export const ROLLOVER_LEAD_HOURS = 24;
/** A season is frozen this long after its end, when no tick of it is still processing. */
export const FREEZE_AFTER_SEASON_HOURS = 1;

/** To be ranked under v2: this many days with a row, this many decisions, and a row on the scored day. */
export const MIN_TRADING_DAYS_V2 = 10;
export const MIN_DECISIONS_V2 = 5;
/** To be ranked as a listed on-chain agent: days with exposure to a universe token, and days with a priced transfer. */
export const MIN_EXPOSURE_DAYS_CHAIN = 10;
export const MIN_ACTIVE_DAYS_CHAIN = 3;
/** The score shrinks toward zero by n / (n + SHRINK_DAYS): a short lucky run cannot top the table. */
export const SHRINK_DAYS = 20;
/** A daily volatility below this is treated as this, in basis points, so sitting in cash cannot score high. */
export const VOL_FLOOR_BPS = 25;
/** Confidence by number of return days: below 20 low, 20 to 59 medium, 60 and more high. */
export const CONFIDENCE_MEDIUM_DAYS = 20;
export const CONFIDENCE_HIGH_DAYS = 60;

/** Chunk sizes that keep one job run inside 10 ms of CPU and 50 D1 statements. */
export const ROLLOVER_CHUNK_AGENTS = 50;
export const SCORE_CHUNK_AGENTS = 25;
export const SCORE_CHUNK_LISTINGS = 15;
export const FREEZE_CHUNK_ROWS = 100;

/** Listed on-chain agents. */
export const MAX_LISTINGS_TOTAL = 100;
/** A claimant may list this many wallets per `maxAgents` of its entitlements. 3 in the open preview. */
export const LISTINGS_PER_MAX_AGENT = 3;
export const CLAIM_TTL_SECONDS = 600;
export const CLAIM_NONCE_RANDOM_LENGTH = 24;
export const CLAIM_STATEMENT = 'This signs a message only. It sends no transaction and costs no gas.';
/** Domain separation of the claim nonce's HMAC, under the Worker secret NONCE_SECRET. */
export const CLAIM_HMAC_LABEL = 'prix-listing-claim-v1';
/** Whether a listing may be claimed with an ERC-1271 contract wallet signature. Off until proven on the chain. */
export const LISTING_CONTRACT_WALLETS_DEFAULT = false;

/** Reading a wallet's activity. */
export const LISTING_SYNC_INTERVAL_SECONDS = 21_600;
/** One eth_getLogs window. The public endpoint allows 10,000,000 blocks and 10,000 logs per call (read 2026-10-06). */
export const LOG_WINDOW_BLOCKS = 8_000_000;
export const MIN_LOG_WINDOW_BLOCKS = 250_000;
/** A block this close to the head is not read yet. */
export const CONFIRMATION_BLOCKS = 100;
/** eth_getBlockByNumber calls in one batched request. */
export const BLOCKS_PER_TIMESTAMP_BATCH = 40;
/** A listing with more events than this stops syncing and says so (`too_active`). */
export const MAX_CHAIN_EVENTS_PER_LISTING = 5_000;
/** Events shown on a listing's page. */
export const LISTING_EVENTS_PAGE = 50;

/** Sybil limits on creating an agent, none of which needs an identity check. */
export const WALLET_SEASONING_SECONDS = 600;
export const NEW_AGENTS_PER_NETWORK_PER_DAY = 3;
/**
 * Per network in a rolling period of `CREATION_PERIOD_DAYS` days, key `p:<period>:net:<network>` with
 * period `creationPeriod(day)`. D-109: the one season never ends, so a season no longer bounds a cap,
 * or it would become a cap for life on a network that many people share.
 */
export const NEW_AGENTS_PER_NETWORK_PER_PERIOD = 8;
/** @deprecated D-109: use NEW_AGENTS_PER_NETWORK_PER_PERIOD; the operator removes this name once nothing reads it. */
export const NEW_AGENTS_PER_NETWORK_PER_SEASON = NEW_AGENTS_PER_NETWORK_PER_PERIOD;
/** The length of the rolling period of the creation caps that used to count per season. */
export const CREATION_PERIOD_DAYS = 28;
/** The number of the `CREATION_PERIOD_DAYS`-day period that a UTC day falls in, counted from 1970-01-01. */
export function creationPeriod(day: UtcDay): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000 / CREATION_PERIOD_DAYS);
}
export const NEW_AGENTS_PER_DAY = 60;
export const CLAIMS_PER_NETWORK_PER_DAY = 5;
export const CLAIMS_PER_CLAIMANT_PER_DAY = 5;

/** Rows on one page of a results table or of the listed agents. */
export const RESULTS_PAGE_SIZE = 100;

export const EXPLORER_URL = 'https://robinhoodchain.blockscout.com';
export const explorerTxUrl = (txHash: string): string => `${EXPLORER_URL}/tx/${txHash}`;
export const explorerAddressUrl = (address: string): string => `${EXPLORER_URL}/address/${address}`;

// --- vocabulary --------------------------------------------------------------------------------

export const seasonMethodSchema = z.enum(['v1', 'v2']);
export type SeasonMethod = z.infer<typeof seasonMethodSchema>;

/** `chain` is the table of listed on-chain agents. It is ranked on its own and never mixed with the paper ones. */
export const scoringDivisionSchema = z.enum(['open', 'pro', 'chain']);
export type ScoringDivision = z.infer<typeof scoringDivisionSchema>;

/** `insufficient`: the agent is below the minimum sample and is not ranked. */
export const confidenceSchema = z.enum(['insufficient', 'low', 'medium', 'high']);
export type Confidence = z.infer<typeof confidenceSchema>;

/** What an estimated record leaves out. Every on-chain record carries all of them. */
export const exclusionCodeSchema = z.enum([
  'non_universe_tokens',
  'cash_and_stablecoins',
  'native_eth',
  'positions_held_in_contracts',
  'intraday_timing',
  'fees_and_slippage',
  'days_without_reference_price',
  'one_sided_swaps_counted_as_transfers',
]);
export type ExclusionCode = z.infer<typeof exclusionCodeSchema>;
export const CHAIN_EXCLUSIONS: readonly ExclusionCode[] = exclusionCodeSchema.options;

// --- scoring v2: pure shapes -------------------------------------------------------------------

/** The sums that a score is made of. Integers, so seasons can be pooled without their daily series. */
export const scoreMomentsSchema = z.strictObject({
  /** Number of return days. */
  n: amountSchema,
  /** The sum of the daily returns, in basis points. */
  sumBps: signedAmountSchema,
  /** The sum of the squares of the daily returns, in basis points squared. */
  sumSqBps: amountSchema,
});
export type ScoreMoments = z.infer<typeof scoreMomentsSchema>;

/**
 * The score of one set of moments. With `n` return days, `mean = sumBps / n` and, for n of 2 or more,
 * `variance = (sumSqBps - sumBps^2 / n) / (n - 1)` (zero for n below 2), `vol = sqrt(variance)`,
 * `volEff = max(vol, VOL_FLOOR_BPS)`, `ratio = mean / volEff`, `shrink = n / (n + SHRINK_DAYS)`,
 * `score = ratio * shrink`. Every `*Milli` is `Math.round(x * 1000)` of the unrounded quantity.
 * A score of an empty set is all zeros.
 */
export const scoreBreakdownSchema = z.strictObject({
  n: amountSchema,
  meanMilliBps: signedAmountSchema,
  volMilliBps: amountSchema,
  ratioMilli: signedAmountSchema,
  shrinkMilli: amountSchema,
  scoreMilli: signedAmountSchema,
});
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

/** What one season row of one agent is made from. */
export interface SeasonScoreInput {
  /** The division, which sets the thresholds. */
  division: ScoringDivision;
  /** Daily returns in basis points, oldest first. For a paper agent: `dailyReturnsBps` of its stats. */
  returnsBps: readonly number[];
  /** Days with a row (paper) or with exposure to a universe token (chain). */
  tradingDays: number;
  /** Decisions (paper) or days with a priced transfer (chain). */
  decidedCount: number;
  /** True if the agent has a row on the scored day (paper) or a record through it (chain). */
  activeOnScoredDay: boolean;
  /** The season return, in basis points. */
  returnBps: number;
  maxDrawdownBps: number;
}

export interface SeasonScoreCore {
  moments: ScoreMoments;
  breakdown: ScoreBreakdown;
  confidence: Confidence;
  /** Null when the agent is eligible. The first that applies, in the order of the thresholds above, then `inactive`. */
  unrankedReason: UnrankedReason | null;
}

/** One agent as the v2 reference ranking sees it. */
export interface ScoreRankInput {
  agentId: string;
  createdAt: IsoTime;
  scoreMilli: number;
  returnBps: number;
  maxDrawdownBps: number;
  unrankedReason: UnrankedReason | null;
}

/** The record of an agent across seasons. */
export const allTimeRecordSchema = z.strictObject({
  /** Seasons the agent has a row in, whatever their method. */
  seasons: amountSchema,
  /** Seasons that were scored with v2 and went into `breakdown`. */
  scoredSeasons: amountSchema,
  /** The seasons' returns compounded: `Math.round((product of (10,000 + r) / 10,000 - 1) * 10,000)`. */
  returnBps: signedAmountSchema,
  tradingDays: amountSchema,
  /** The pooled moments of the v2 seasons, scored like one season. */
  breakdown: scoreBreakdownSchema,
  confidence: confidenceSchema,
});
export type AllTimeRecord = z.infer<typeof allTimeRecordSchema>;

/**
 * Scoring v2. `packages/reputation/src/v2.ts` exports `scoringV2: ScoringV2Engine`. Every function is
 * pure, deterministic and never throws, and none of them touches `scoring` (v1).
 */
export interface ScoringV2Engine {
  /**
   * Daily returns from the daily equity points: the first is `startEquityMicro` to `daily[0]`, then
   * each point to the next. `Math.round((now - before) * 10_000 / before)`, negative zero as 0.
   */
  dailyReturnsBps(startEquityMicro: number, daily: readonly { day: string; equityMicro: number }[]): number[];
  momentsOf(returnsBps: readonly number[]): ScoreMoments;
  breakdownOf(moments: ScoreMoments): ScoreBreakdown;
  confidenceOf(n: number, eligible: boolean): Confidence;
  /** The whole season row, from its input. */
  seasonScore(input: SeasonScoreInput): SeasonScoreCore;
  /** Negative if `a` ranks before `b`: higher score, higher return, lower drawdown, older agent, lower id. */
  compare(a: ScoreRankInput, b: ScoreRankInput): number;
  /** The reference ranking: ranked ones in `compare` order with ranks 1, 2, 3, then the rest with null. SQL must equal it. */
  rankAll(entries: readonly ScoreRankInput[]): { agentId: string; rank: number | null }[];
  /** Pools seasons. Only rows with `method` v2 add their moments; every row adds to the compounded return. */
  allTime(
    seasons: readonly {
      method: SeasonMethod;
      returnBps: number;
      tradingDays: number;
      moments: ScoreMoments;
    }[],
  ): AllTimeRecord;
}

// --- results, archive and track record (the public read models) ---------------------------------

/** One line of a results table. The same shape for a live v2 season, a frozen season and a v1 season. */
export const seasonResultRowSchema = z.strictObject({
  rank: z.number().int().positive().nullable(),
  unrankedReason: unrankedReasonSchema.nullable(),
  /** An agent id or, in the `chain` division, a listing id. */
  agentId: idSchema,
  name: z.string(),
  division: scoringDivisionSchema,
  method: seasonMethodSchema,
  returnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  tradingDays: amountSchema,
  decidedCount: amountSchema,
  /** Null for a v1 row. */
  scoreMilli: signedAmountSchema.nullable(),
  confidence: confidenceSchema.nullable(),
  /** The UTC day the row was scored as of. Null for a v1 row. */
  scoredDay: utcDaySchema.nullable(),
  /** True for an agent that Prix itself runs (docs/CONTRACTS.md section 17). Always sent; optional for an older API. */
  house: z.boolean().optional(),
});
export type SeasonResultRow = z.infer<typeof seasonResultRowSchema>;

export const seasonArchiveEntrySchema = z.strictObject({
  season: seasonSchema,
  method: seasonMethodSchema,
  lengthDays: z.number().int().positive(),
  /** Set when the season is over and its results are final. Null while it runs. */
  frozenAt: isoTimeSchema.nullable(),
  /** How many agents are ranked in each division. Zero where nothing was ranked. */
  rankedCount: z.strictObject({ open: amountSchema, pro: amountSchema, chain: amountSchema }),
  agentCount: z.strictObject({ open: amountSchema, pro: amountSchema, chain: amountSchema }),
});
export type SeasonArchiveEntry = z.infer<typeof seasonArchiveEntrySchema>;

export const trackRecordSeasonSchema = z.strictObject({
  season: seasonSchema,
  method: seasonMethodSchema,
  frozen: z.boolean(),
  rank: z.number().int().positive().nullable(),
  unrankedReason: unrankedReasonSchema.nullable(),
  returnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  tradingDays: amountSchema,
  decidedCount: amountSchema,
  breakdown: scoreBreakdownSchema.nullable(),
  confidence: confidenceSchema.nullable(),
});
export type TrackRecordSeason = z.infer<typeof trackRecordSeasonSchema>;

/** One agent's record across seasons. Named apart from `AgentRecord`, which is the stored agent. */
export const agentTrackRecordSchema = z.strictObject({
  agentId: idSchema,
  name: z.string(),
  division: scoringDivisionSchema,
  /** Newest season first. */
  seasons: z.array(trackRecordSeasonSchema),
  allTime: allTimeRecordSchema,
  /** The scoring method of the newest season. */
  method: seasonMethodSchema,
  /** True for an agent that Prix itself runs (docs/CONTRACTS.md section 17). Always sent; optional for an older API. */
  house: z.boolean().optional(),
});
export type AgentTrackRecord = z.infer<typeof agentTrackRecordSchema>;

// --- listed on-chain agents --------------------------------------------------------------------

export const listingStatusSchema = z.enum(['active', 'removed']);
export type ListingStatus = z.infer<typeof listingStatusSchema>;

/**
 * `backfill`: still reading history. `live`: caught up. `error`: the reader failed several times.
 * `too_active`: more than MAX_CHAIN_EVENTS_PER_LISTING events, so the record stops and says so.
 */
export const listingSyncStateSchema = z.enum(['backfill', 'live', 'error', 'too_active']);
export type ListingSyncState = z.infer<typeof listingSyncStateSchema>;

export const signatureKindSchema = z.enum(['eoa', 'contract']);
export type SignatureKind = z.infer<typeof signatureKindSchema>;

/** A listing as it is stored. `signature` and `message` stay on the row so that anyone can check the claim. */
export const listingRecordSchema = z.strictObject({
  id: idSchema,
  /** The agent's own wallet, the one that signed. */
  wallet: addressSchema,
  /** The signed-in Prix account that asked. It may equal `wallet`. */
  claimant: addressSchema,
  name: agentNameSchema,
  nameKey: z.string(),
  message: z.string(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signatureKind: signatureKindSchema,
  status: listingStatusSchema,
  hidden: z.boolean(),
  /** From the claimant's entitlements at the last sync. Always false while gating is off. */
  verified: z.boolean(),
  claimedAt: isoTimeSchema,
  syncState: listingSyncStateSchema,
  /** The last block whose logs have been read. Zero before the first sync. */
  syncedBlock: amountSchema,
  syncedAt: isoTimeSchema.nullable(),
  /** The size of the next log window, halved when the node refuses one. */
  windowBlocks: amountSchema,
  syncErrors: amountSchema,
  eventCount: amountSchema,
  /** The checkpoint of the record: balances after all events up to `recordDay`, in wei by symbol. */
  balancesWei: z.record(symbolSchema, z.string().regex(/^\d+$/)),
  /** The last priced day folded into the record. Null before the first. */
  recordDay: utcDaySchema.nullable(),
  /** The highest block among the events folded into the checkpoint. Events after it are not folded yet. */
  recordBlock: amountSchema,
  /** The record's value at `recordDay`, as a portfolio index that starts at 10,000 USD, in micro-USD. */
  indexMicro: amountSchema,
});
export type ListingRecord = z.infer<typeof listingRecordSchema>;

export const chainEventKindSchema = z.enum(['transfer', 'swap']);
export type ChainEventKind = z.infer<typeof chainEventKindSchema>;

/** One Transfer log of a universe token that names the listed wallet. */
export const chainEventSchema = z.strictObject({
  block: amountSchema,
  logIndex: amountSchema,
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  symbol: symbolSchema,
  direction: z.enum(['in', 'out']),
  /** The amount in the token's smallest unit, as a decimal string: 18 decimals do not fit a safe integer. */
  amountWei: z.string().regex(/^\d+$/),
  /** `swap` only when the same transaction also moved another universe token of the wallet the other way. */
  kind: chainEventKindSchema,
  /** The UTC day of the block. */
  day: utcDaySchema,
});
export type ChainEvent = z.infer<typeof chainEventSchema>;

/** One priced day of a listed agent's estimated record. */
export const listingDaySchema = z.strictObject({
  day: utcDaySchema,
  /** The day's return on the previous day's holdings, in basis points. Zero when `exposed` is false. */
  returnBps: signedAmountSchema,
  /** False when the wallet held no universe token at the start of the day. Such days are not scored. */
  exposed: z.boolean(),
  /** The portfolio index after the day, in micro-USD, starting at 10,000 USD. */
  indexMicro: amountSchema,
  /** The value of the holdings at the end of the day, at the day's reference prices, in micro-USD. */
  valueMicro: amountSchema,
  /** Events of the day, and how many of them could not be priced. */
  eventCount: amountSchema,
  unpricedEventCount: amountSchema,
});
export type ListingDay = z.infer<typeof listingDaySchema>;

export const chainEventPublicSchema = z.strictObject({
  day: utcDaySchema,
  block: amountSchema,
  txHash: z.string(),
  explorerUrl: z.string(),
  symbol: symbolSchema,
  direction: z.enum(['in', 'out']),
  /** The amount in tokens with at most six decimals, as text. */
  amount: z.string(),
  kind: chainEventKindSchema,
  /** False when the day has no reference price: the event is listed and left out of the record. */
  priced: z.boolean(),
});
export type ChainEventPublic = z.infer<typeof chainEventPublicSchema>;

/** A listed on-chain agent as the public sees it. */
export const listingPublicSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  wallet: addressSchema,
  explorerUrl: z.string(),
  verified: z.boolean(),
  claimedAt: isoTimeSchema,
  syncState: listingSyncStateSchema,
  syncedAt: isoTimeSchema.nullable(),
  eventCount: amountSchema,
  /** Always true: nothing on a listed agent is a measured result. The page says "estimated". */
  estimated: z.literal(true),
  /** `chain-v1`. */
  recordMethod: z.literal(CHAIN_METHOD),
  /** The scoring method of the season the standing is from, for example `v2`. Null before a season has one. */
  scoringMethod: seasonMethodSchema.nullable(),
  exclusions: z.array(exclusionCodeSchema),
  /** The first priced day of the record. Null while there is none. */
  recordFrom: utcDaySchema.nullable(),
  /** Null until a day has been scored in the current season. */
  standing: seasonResultRowSchema.nullable(),
});
export type ListingPublic = z.infer<typeof listingPublicSchema>;

export const listingDetailSchema = listingPublicSchema.extend({
  /** Anyone can check the claim: the exact text that was signed, and the signature. */
  claimMessage: z.string(),
  claimSignature: z.string(),
  signatureKind: signatureKindSchema,
  /** Every priced day of the season, oldest first. */
  days: z.array(listingDaySchema),
  /** The newest LISTING_EVENTS_PAGE events, newest first. */
  events: z.array(chainEventPublicSchema),
  track: agentTrackRecordSchema.nullable(),
});
export type ListingDetail = z.infer<typeof listingDetailSchema>;

// --- HTTP: requests and responses ---------------------------------------------------------------

/** The cursor of every list under /api/reputation. */
export const pageQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/** GET /api/reputation/seasons */
export const archiveResponseSchema = z.strictObject({ seasons: z.array(seasonArchiveEntrySchema) });
export type ArchiveResponse = z.infer<typeof archiveResponseSchema>;

/** GET /api/reputation/seasons/:id/results?division=open|pro|chain&page=n */
export const resultsQuerySchema = z.strictObject({
  division: scoringDivisionSchema.default('open'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export const resultsResponseSchema = z.strictObject({
  entry: seasonArchiveEntrySchema,
  division: scoringDivisionSchema,
  rows: z.array(seasonResultRowSchema),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
  /** For a division with `chain`: the page words the table as estimated. */
  estimated: z.boolean(),
});
export type ResultsResponse = z.infer<typeof resultsResponseSchema>;

/** GET /api/reputation/agents/:id/record */
export const trackRecordResponseSchema = z.strictObject({ record: agentTrackRecordSchema });
export type TrackRecordResponse = z.infer<typeof trackRecordResponseSchema>;

/** GET /api/reputation/listings?page=n */
export const listingsResponseSchema = z.strictObject({
  listings: z.array(listingPublicSchema),
  page: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type ListingsResponse = z.infer<typeof listingsResponseSchema>;

/** GET /api/reputation/listings/:id */
export const listingResponseSchema = z.strictObject({ listing: listingDetailSchema });
export type ListingResponse = z.infer<typeof listingResponseSchema>;

/** POST /api/reputation/listings/claim-message. The server writes the message; the client never does. */
export const claimMessageInputSchema = z.strictObject({
  wallet: addressSchema,
  name: agentNameSchema,
});
export type ClaimMessageInput = z.infer<typeof claimMessageInputSchema>;

export const claimNonceSchema = z.string().regex(/^[A-Za-z0-9]{24}\.[0-9a-f]{32}$/);

export const claimMessageResponseSchema = z.strictObject({
  message: z.string(),
  nonce: claimNonceSchema,
  issuedAt: isoTimeSchema,
  expiresAt: isoTimeSchema,
});
export type ClaimMessageResponse = z.infer<typeof claimMessageResponseSchema>;

/** POST /api/reputation/listings. The server rebuilds the message from these fields and the session. */
export const createListingInputSchema = z.strictObject({
  wallet: addressSchema,
  name: agentNameSchema,
  nonce: claimNonceSchema,
  issuedAt: isoTimeSchema,
  expiresAt: isoTimeSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130,4096}$/, 'Expected a hex signature.'),
});
export type CreateListingInput = z.infer<typeof createListingInputSchema>;

/** The response of POST /api/reputation/listings, and of POST /api/reputation/listings/:id/status. */
export const listingOwnerViewSchema = listingPublicSchema.extend({
  status: listingStatusSchema,
  hidden: z.boolean(),
});
export type ListingOwnerView = z.infer<typeof listingOwnerViewSchema>;
export const listingOwnerResponseSchema = z.strictObject({ listing: listingOwnerViewSchema });
export type ListingOwnerResponse = z.infer<typeof listingOwnerResponseSchema>;

/** GET /api/reputation/me/listings */
export const myListingsResponseSchema = z.strictObject({
  listings: z.array(listingOwnerViewSchema),
  /** How many more the wallet may list, from its entitlements. */
  remaining: amountSchema,
});
export type MyListingsResponse = z.infer<typeof myListingsResponseSchema>;

/** POST /api/reputation/listings/:id/status. `removed` takes the listing off the public pages; the record is kept. */
export const setListingStatusInputSchema = z.strictObject({ status: listingStatusSchema });
export type SetListingStatusInput = z.infer<typeof setListingStatusInputSchema>;

/** POST /api/reputation/admin/listings/:id/hidden. Only for wallets in ADMIN_ADDRESSES. */
export const setListingHiddenInputSchema = z.strictObject({ hidden: z.boolean() });

// --- the claim message --------------------------------------------------------------------------

export interface ClaimFields {
  wallet: Address;
  name: string;
  claimant: Address;
  nonce: string;
  issuedAt: IsoTime;
  expiresAt: IsoTime;
  chainId: number;
}

/**
 * The exact text a wallet signs to list itself. The server builds it from its own fields and
 * compares what it rebuilds with what was signed, so the text a wallet showed is the text that
 * was checked. There is one layout and nothing optional.
 */
export function buildClaimMessage(fields: ClaimFields): string {
  return [
    'Prix listing claim',
    '',
    `I control the wallet ${fields.wallet} and ask Prix to list it as the on-chain agent "${fields.name}".`,
    `Asked by the Prix account ${fields.claimant}.`,
    CLAIM_STATEMENT,
    '',
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expires At: ${fields.expiresAt}`,
  ].join('\n');
}

/** What the claim route asks of the signature check. A forged or foreign signature is null. */
export interface ClaimSignatureVerifier {
  /**
   * `eoa`: the signature recovers to `wallet`. `contract`: the wallet is a contract that accepts it by
   * ERC-1271, tried only when the recovery does not match and contract wallets are switched on.
   * Null for anything else. Never throws.
   */
  verify(input: { wallet: Address; message: string; signature: string }): Promise<SignatureKind | null>;
}

// --- reading a wallet on the chain --------------------------------------------------------------

export interface HeadBlock {
  number: number;
  /** Unix seconds. */
  timestamp: number;
}

/** A Transfer log of a universe token with the listed wallet on one side. */
export interface RawTransfer {
  block: number;
  logIndex: number;
  txHash: string;
  symbol: TokenSymbol;
  direction: 'in' | 'out';
  amountWei: string;
}

export type ReadWindowResult =
  | { ok: true; transfers: RawTransfer[]; fromBlock: number; toBlock: number }
  | { ok: false; reason: 'window_too_large' | 'rpc_unavailable' };

/**
 * `packages/market/src/wallet-activity.ts` exports `createWalletActivityReader(config): WalletActivityPort`.
 * It reads JSON-RPC over `fetch` and never throws. At most one HTTP request for the head and the
 * logs together, and one more for the block times.
 */
export interface WalletActivityPort {
  /** The head block, less nothing: the caller subtracts CONFIRMATION_BLOCKS. */
  headBlock(): Promise<HeadBlock | null>;
  /**
   * Transfers of the universe's Stock Tokens (never its crypto assets) into and out of `wallet` in [fromBlock, toBlock], in block and
   * log order. Two eth_getLogs calls in one batched request. A node answer that says the range or the
   * number of logs is too large is `window_too_large`; the caller halves the window.
   */
  readTransfers(wallet: Address, fromBlock: number, toBlock: number): Promise<ReadWindowResult>;
  /** Unix seconds of each block, by number, in one batched request. At most BLOCKS_PER_TIMESTAMP_BATCH blocks. */
  blockTimes(blocks: readonly number[]): Promise<Record<number, number> | null>;
}

// --- the estimated record of a listed agent -----------------------------------------------------

/** The reference prices of one UTC day: the last complete tick of the day. */
export interface DayPrices {
  day: UtcDay;
  tickId: string;
  /** Micro-USD per token, by symbol. */
  pricesMicro: Record<TokenSymbol, number>;
}

export interface ChainRecordInput {
  /** Balances in wei by symbol after all events up to and including `recordDay`. */
  balancesWei: Record<TokenSymbol, string>;
  recordDay: UtcDay | null;
  indexMicro: number;
  /** Every event with a day after `recordDay`, in block and log order, with its day. */
  events: readonly ChainEvent[];
  /** Priced days after `recordDay` and up to the last settled day, oldest first. */
  days: readonly DayPrices[];
  /** The price of `recordDay` itself, the base of the first new day's return. Null before the first priced day. */
  baseDayPrices: DayPrices | null;
}

export interface ChainRecordResult {
  newDays: ListingDay[];
  balancesWei: Record<TokenSymbol, string>;
  recordDay: UtcDay | null;
  indexMicro: number;
}

/**
 * `packages/reputation/src/chain-record.ts` exports `chainRecord: ChainRecordEngine`. Pure. For each
 * priced day `d` after the checkpoint, with `B` the balances after every event up to the previous
 * priced day: `value(B, P) = sum over symbols of floor(balanceWei * priceMicro / 10^18)`, and the
 * return is `Math.round((value(B, P_d) - value(B, P_prev)) * 10_000 / value(B, P_prev))` when
 * `value(B, P_prev) > 0`, and the day is not exposed with a return of 0 otherwise. The index moves by
 * that return: `index = floor(index * (10_000 + returnBps) / 10_000)`, starting at STARTING_CASH_MICRO on
 * the first priced day. Events of day `d` are then applied to `B`. A transfer is a flow, never a
 * gain: only the price move of what was held counts, so moving tokens between wallets cannot
 * change a record. An event on a day with no reference price is applied to the balances and counted
 * in `unpricedEventCount`. The arithmetic is BigInt where a product can pass 2^53.
 */
export interface ChainRecordEngine {
  build(input: ChainRecordInput): ChainRecordResult;
  /** `swap` when one transaction has events of the wallet in both directions, else `transfer`. */
  classify(raw: readonly RawTransfer[], dayOfBlock: (block: number) => UtcDay): ChainEvent[];
}

// --- replay -------------------------------------------------------------------------------------

export interface ReplayInput {
  /** The agent's rows of one season, oldest first. */
  rows: readonly DecisionRow[];
  /** The tick of every row, for its prices and halted symbols. */
  ticks: Readonly<Record<string, Tick>>;
  sim: SimEngine;
  scoring: ScoringEngine;
  /** The stats that were published for the last row. Compared with the replayed ones. */
  published: AgentStats;
  /** Where to start: a fresh season, or the state after a chunk. Defaults to `sim.newPortfolio()` and `scoring.initialStats()`. */
  from?: { portfolio: PortfolioState; stats: AgentStats };
}

export const replayMismatchSchema = z.strictObject({
  tickId: tickIdSchema,
  /** What differed first: the fills, the portfolio, the equity or the stats. */
  field: z.enum(['fills', 'portfolio', 'equity', 'stats']),
});
export type ReplayMismatch = z.infer<typeof replayMismatchSchema>;

export interface ReplayReport {
  match: boolean;
  /** Rows replayed. */
  rows: number;
  firstMismatch: ReplayMismatch | null;
  /** The state after the last row, so a caller can replay in chunks. */
  portfolio: PortfolioState;
  stats: AgentStats;
}

/**
 * `packages/reputation/src/replay.ts` exports `replay: ReplayEngine`. Pure. For each row, in order: a
 * `decided` row is re-run through `sim.rebalance` with the stored targets, the tick's prices and the row's
 * halted symbols, and the fills, the portfolio and the equity must equal the row's; any other row must
 * leave the portfolio as it was and its equity must equal `valuePortfolio` at the tick's prices. The stats
 * are rebuilt with `scoring.updateStats` and the event of docs/CONTRACTS.md section 9, and the last ones
 * must equal `published`. It never calls a model.
 */
export interface ReplayEngine {
  replayAgent(input: ReplayInput): ReplayReport;
}

// --- the store ----------------------------------------------------------------------------------

export interface SeasonMethodRecord {
  seasonId: string;
  method: SeasonMethod;
  lengthDays: number;
  frozenAt: IsoTime | null;
}

/** An agent as the v2 scoring job reads it: only what a score needs. */
export interface ScoreSource {
  agentId: string;
  name: string;
  createdAt: IsoTime;
  /** Paper agents. The stats of the season. */
  stats: AgentStats | null;
  /** Listed agents. The priced days of the season, oldest first. */
  chainDays: ListingDay[] | null;
}

/** One row of `season_scores`, as the scoring job writes it. */
export const seasonScoreRowSchema = z.strictObject({
  seasonId: idSchema,
  division: scoringDivisionSchema,
  agentId: idSchema,
  name: z.string(),
  agentCreatedAt: isoTimeSchema,
  method: seasonMethodSchema,
  moments: scoreMomentsSchema,
  returnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  tradingDays: amountSchema,
  decidedCount: amountSchema,
  tradeCount: amountSchema,
  /** Null for a v1 row. */
  scoreMilli: signedAmountSchema.nullable(),
  confidence: confidenceSchema.nullable(),
  unrankedReason: unrankedReasonSchema.nullable(),
  scoredDay: utcDaySchema.nullable(),
  updatedAt: isoTimeSchema,
});
export type SeasonScoreRow = z.infer<typeof seasonScoreRowSchema>;

export type JobStateName = string;

export interface CreationReservation {
  /** The counter keys that were incremented, so that a failed creation can give them back. */
  keys: string[];
}

/**
 * The Phase 2 side of D1. `apps/api/src/store/reputation.ts` exports `createReputationStore(db)`. It
 * implements `RecordsReadPort` too. Every method is one D1 call or one D1 batch; no method loads a
 * whole division; every query uses an index of infra/migrations/0002_reputation.sql.
 */
export interface ReputationStore extends RecordsReadPort {
  // --- seasons ---------------------------------------------------------------------------------
  /** A season without a row is v1 and 28 days. */
  getSeasonMethod(seasonId: string): Promise<SeasonMethodRecord>;
  /** Inserts the `seasons` row and the `season_methods` row in one batch. False if the number exists. */
  putSeason(season: Season, method: SeasonMethod, lengthDays: number): Promise<boolean>;
  /**
   * Copies agents without a portfolio in `toSeasonId` into it, with `portfolio` and `stats`, in id order
   * after `afterAgentId`, at most `limit`. Idempotent. Returns the number of agents examined and the last id.
   */
  rolloverAgents(input: {
    toSeasonId: string;
    portfolio: PortfolioState;
    stats: AgentStats;
    afterAgentId: string | null;
    limit: number;
    now: IsoTime;
  }): Promise<{ examined: number; lastAgentId: string | null }>;
  /** Sets `frozen_at`. */
  markSeasonFrozen(seasonId: string, now: IsoTime): Promise<void>;
  /** True if a tick of the season is still `processing`. */
  hasProcessingTick(seasonId: string): Promise<boolean>;

  // --- scores ----------------------------------------------------------------------------------
  /** Paper agents of a season and division in id order after `afterAgentId`. Hidden ones included: ranking skips them in SQL. */
  listPaperScoreSources(
    seasonId: string,
    division: 'open' | 'pro',
    afterAgentId: string | null,
    limit: number,
  ): Promise<ScoreSource[]>;
  /** Listed agents, with their priced days inside [fromDay, toDay]. */
  listChainScoreSources(
    fromDay: UtcDay,
    toDay: UtcDay,
    afterListingId: string | null,
    limit: number,
  ): Promise<ScoreSource[]>;
  /** Upserts the rows in one batch. */
  putScores(rows: readonly SeasonScoreRow[]): Promise<void>;
  /**
   * Publishes the ranks of one division in SQL: eligible, visible rows ordered as `ScoringV2Engine.compare`
   * get ranks 1, 2, 3; every other row has a null rank. Safe to run twice. Returns the ranked count.
   */
  rankScores(seasonId: string, division: ScoringDivision): Promise<number>;
  /** v1 seasons: copies the final `portfolios` of a chunk into `season_scores` with method v1. Idempotent. */
  freezeV1Chunk(
    seasonId: string,
    afterAgentId: string | null,
    limit: number,
    now: IsoTime,
  ): Promise<{ copied: number; lastAgentId: string | null }>;

  // --- day prices ------------------------------------------------------------------------------
  /** Stores the prices of the last complete tick of the day. False if there is no such tick or the day is stored. */
  captureDayPrices(day: UtcDay): Promise<boolean>;
  /** Days after `afterDay` and up to `toDay`, oldest first. With `afterDay` null, from the first stored day. */
  listDayPrices(afterDay: UtcDay | null, toDay: UtcDay): Promise<DayPrices[]>;
  getDayPrices(day: UtcDay): Promise<DayPrices | null>;
  /** The latest stored day, or null. */
  latestPricedDay(): Promise<UtcDay | null>;

  // --- job state and counters ------------------------------------------------------------------
  getJobState(name: JobStateName): Promise<string | null>;
  putJobState(name: JobStateName, body: string, now: IsoTime): Promise<void>;
  /**
   * Adds one to the counter if it is below `cap`, atomically. False when the cap is reached. The key
   * starts with `d:<day>:`, `p:<period>:` or `s:<seasonId>:`, which is what `deleteOldCounters` removes by.
   */
  takeCounter(key: string, cap: number, day: UtcDay, now: IsoTime): Promise<boolean>;
  giveBackCounter(key: string): Promise<void>;
  /**
   * Deletes day counters before `day`, period counters of periods before `creationPeriod(day)`, and
   * season counters of seasons that are frozen. At most `limit`.
   */
  deleteOldCounters(day: UtcDay, limit: number): Promise<number>;
  /** When the wallet first signed in. Null if it never did. */
  getFirstSignIn(address: Address): Promise<IsoTime | null>;

  // --- listings --------------------------------------------------------------------------------
  /**
   * Inserts the listing unless the wallet or the name is taken (by a listing, or by an agent's name key) or a
   * cap is reached, all decided in SQL in the same batch.
   */
  createListing(
    listing: ListingRecord,
    limits: { maxPerClaimant: number; maxTotal: number },
  ): Promise<'created' | 'wallet_listed' | 'name_taken' | 'claimant_limit' | 'listings_full'>;
  /**
   * A new valid claim signed by the wallet itself takes the listing of that wallet from its claimant (finding 16):
   * the claimant, name, message, signature and claim time are replaced, `verified` is cleared and the listing is
   * active again; the record and the sync state stay. Decided in one statement: the name must be free (the
   * listing's own name counts as free) and the new claimant under `maxPerClaimant`.
   */
  replaceListingClaimant(
    listing: ListingRecord,
    limits: { maxPerClaimant: number },
  ): Promise<'replaced' | 'name_taken' | 'claimant_limit' | 'not_replaceable'>;
  getListing(id: string): Promise<ListingRecord | null>;
  getListingByWallet(wallet: Address): Promise<ListingRecord | null>;
  listListingsByClaimant(claimant: Address): Promise<ListingRecord[]>;
  /** Only the claimant's own listing changes. False otherwise. */
  setListingStatus(id: string, claimant: Address, status: ListingStatus, now: IsoTime): Promise<boolean>;
  setListingHidden(id: string, hidden: boolean): Promise<boolean>;
  /** The active, visible listing that is due: backfilling ones first, then the one synced longest ago and older than the interval. */
  nextListingToSync(now: IsoTime, minAgeSeconds: number): Promise<ListingRecord | null>;
  /** Events of a listing with a block after `block`, in block and log order. */
  listEventsAfterBlock(listingId: string, block: number, limit: number): Promise<ChainEvent[]>;
  /** True if a listing or an agent already uses the name key. */
  nameKeyTaken(nameKey: string): Promise<boolean>;
  /** One batch: inserts the events (ignoring a repeat), inserts the days, and updates the listing's checkpoint and state. */
  applySync(update: ListingSyncUpdate): Promise<void>;
  /** The newest events first, for a listing's page. */
  listEventsNewest(listingId: string, limit: number): Promise<ChainEvent[]>;
  listListingDays(listingId: string, fromDay: UtcDay, toDay: UtcDay): Promise<ListingDay[]>;
}

export interface ListingSyncUpdate {
  listingId: string;
  events: readonly ChainEvent[];
  days: readonly ListingDay[];
  syncedBlock: number;
  syncedAt: IsoTime;
  syncState: ListingSyncState;
  windowBlocks: number;
  syncErrors: number;
  verified: boolean;
  balancesWei: Record<TokenSymbol, string>;
  recordDay: UtcDay | null;
  recordBlock: number;
  indexMicro: number;
  eventCount: number;
}

/**
 * The read side that later phases use. `createReputationStore(db)` implements it. Every row is public
 * data: hidden agents and removed or hidden listings are never returned.
 */
export interface RecordsReadPort {
  /** Every season, newest first, with its method and counts. */
  listSeasonArchive(): Promise<SeasonArchiveEntry[]>;
  /** One page of a season's results in one division, ranked first. Null for an unknown season. */
  listSeasonResults(
    seasonId: string,
    division: ScoringDivision,
    limit: number,
    offset: number,
  ): Promise<SeasonResultRow[] | null>;
  getSeasonArchiveEntry(seasonId: string): Promise<SeasonArchiveEntry | null>;
  /** An agent's record across seasons, or a listing's. Null if it is unknown or hidden. */
  getTrackRecord(id: string): Promise<AgentTrackRecord | null>;
  /** The listed on-chain agents, ranked ones first. */
  listListedAgents(limit: number, offset: number): Promise<ListingPublic[]>;
  getListedAgent(id: string): Promise<ListingPublic | null>;
  /**
   * The public listings that belong to a wallet: the ones whose agent wallet it is and the ones it
   * claimed (a Prix account). Active and not hidden only; at most `MAX_LISTINGS_TOTAL` rows. Phase 5's
   * `DataRecordsPort` has the same shape, so the operator passes the store to both without an adapter.
   */
  listingsOf(wallet: Address): Promise<readonly ListingOfWallet[]>;
}

/** `listingId` is the id of the listing, as `agentId` in `AgentListing` of phase5-data.ts. */
export interface ListingOfWallet {
  agentId: string;
  /** `claimedAt` of the listing. */
  listedAt: IsoTime | null;
  /** `verified` of the listing. */
  verifiedBadge: boolean;
}

// --- scheduled work ------------------------------------------------------------------------------

export const reputationJobNameSchema = z.enum([
  'season_lifecycle',
  'season_freeze',
  'day_prices',
  'season_score',
  'listing_sync',
  'cleanup',
]);
export type ReputationJobName = z.infer<typeof reputationJobNameSchema>;

/** `idle`: nothing to do, and nothing was written. `more`: did a chunk, there is more. `done`: finished its work for now. */
export type JobOutcome = 'idle' | 'more' | 'done';

export interface ReputationJob {
  name: ReputationJobName;
  /** Never throws: a failure is logged with its job name and ends the step. */
  run(now: Date): Promise<JobOutcome>;
}

export interface ReputationStepResult {
  /** The job that ran, or null when every job was idle. */
  ran: ReputationJobName | null;
  outcome: JobOutcome;
}

/** `packages/runtime/src/reputation/step.ts`. Runs the first job that is not idle, and returns. */
export type RunReputationStep = (jobs: readonly ReputationJob[], now: Date) => Promise<ReputationStepResult>;

/** What the job factories take. Each lives in `packages/runtime/src/reputation/` and is named in the contract file. */
export interface ReputationJobDeps {
  store: Store;
  reputation: ReputationStore;
  sim: SimEngine;
  scoring: ScoringEngine;
  scoringV2: ScoringV2Engine;
  chainRecord: ChainRecordEngine;
  wallet: WalletActivityPort;
  entitlements: EntitlementsPort;
  now(): Date;
}

/** The Cron Trigger that runs the Phase 2 step. A second trigger, so it has its own 10 ms and 50 subrequests. */
export const REPUTATION_CRON = '*/2 * * * *';

// --- creating an agent: the sybil guard ----------------------------------------------------------

export interface AgentCreationGuard {
  /**
   * Called before `POST /api/agents` reaches its route, for a signed-in wallet. Throws an ApiFailure of
   * `apps/api/src/http/errors.ts` when a limit is reached; otherwise returns what to give back if the
   * creation then fails.
   */
  reserve(input: { owner: Address; networkSubject: string; seasonId: string; now: Date }): Promise<CreationReservation>;
  release(reservation: CreationReservation): Promise<void>;
}

/** Everything the Phase 2 routes need, on top of what Phase 1 routes need. */
export interface ReputationApiDeps extends ApiDeps {
  reputation: ReputationStore;
  entitlements: EntitlementsPort;
  verifier: ClaimSignatureVerifier;
  guard: AgentCreationGuard;
  /** The chain the claim names: CHAIN_ID. */
  chainId: number;
}
