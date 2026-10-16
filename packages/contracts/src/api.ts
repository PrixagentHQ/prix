import { agentStatusSchema, pausedReasonSchema, summaryStatusSchema } from './agents.ts';
import { LEAGUE_MAX_PAGE } from './constants.ts';
import type { EntitlementsPort } from './entitlements.ts';
import { marketStatusSchema } from './market.ts';
import type { KeySealer } from './models.ts';
import { modelKeyPublicSchema, providerIdSchema } from './models.ts';
import type { OwnerHoldsStore } from './phase6-holders.ts';
import type { SimEngine } from './portfolio.ts';
import { fillSchema } from './portfolio.ts';
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
import type { ScoringEngine } from './scoring.ts';
import {
  agentStatsSchema,
  leagueStateSchema,
  rowStatusSchema,
  standingConfidenceSchema,
  standingRowSchema,
  unrankedReasonSchema,
} from './scoring.ts';
import type { Store } from './store.ts';
import { seasonSchema, symbolHoldSchema } from './ticks.ts';
import { z } from './zod.ts';

/**
 * The HTTP API, version 1 of Phase 1. Every route lives under /api. Requests and responses
 * are JSON. docs/CONTRACTS.md section 4 lists the routes; the shapes are here.
 */

export const apiErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_input',
  'rate_limited',
  'name_taken',
  'name_not_allowed',
  'owner_has_agent',
  /** The division has as many agents as Phase 1 can run. */
  'league_full',
  /** The wallet already stores as many model keys as it may. */
  'key_limit_reached',
  /** A daily limit of the free plan is used up. The product is paused until 00:00 UTC. */
  'daily_limit',
  'no_active_season',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** Every error response. `message` says what happened and what to do next. It never carries a stack trace. */
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** For invalid_input: the path of the first field that failed, for example "prompt". */
    field: z.string().nullable(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// --- sign-in ---------------------------------------------------------------------------------

/** GET /api/siwe/nonce */
export const nonceResponseSchema = z.strictObject({
  nonce: z.string(),
  expiresAt: isoTimeSchema,
  /** What the Sign-In with Ethereum message must contain, so the page does not guess. */
  domain: z.string(),
  uri: z.string(),
  chainId: z.number().int(),
  statement: z.string(),
});
export type NonceResponse = z.infer<typeof nonceResponseSchema>;

/** POST /api/siwe/verify */
export const verifyInputSchema = z.strictObject({
  message: z.string().min(1).max(2_000),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'Expected a 65-byte signature.'),
});
export type VerifyInput = z.infer<typeof verifyInputSchema>;

/** The response of POST /api/siwe/verify. The session itself travels in an HttpOnly cookie. */
export const sessionResponseSchema = z.strictObject({ address: addressSchema });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

// --- public reads ----------------------------------------------------------------------------

/** One decision as anyone may see it. */
export const decisionPublicSchema = z.strictObject({
  tickId: tickIdSchema,
  at: isoTimeSchema,
  status: rowStatusSchema,
  /** A NoDecisionCode or a SkipCode. Null for a decision. */
  code: z.string().nullable(),
  reason: z.string().nullable(),
  fills: z.array(fillSchema),
  /** Symbols that were halted at the tick. A target for one of them was accepted and not traded. */
  halted: z.array(symbolSchema),
  equityMicro: amountSchema,
  costMicro: amountSchema,
});
export type DecisionPublic = z.infer<typeof decisionPublicSchema>;

export const holdingPublicSchema = z.strictObject({
  symbol: symbolSchema,
  unitsMicro: amountSchema,
  /** The reference price at the agent's latest tick. */
  priceMicro: amountSchema,
  valueMicro: amountSchema,
  weightBps: amountSchema,
});
export type HoldingPublic = z.infer<typeof holdingPublicSchema>;

/**
 * GET /api/league?division=open|pro&season=<id>&page=<n>. The season defaults to the active
 * one, or to the latest one that has started when none is active.
 */
export const leagueQuerySchema = z.strictObject({
  division: divisionSchema.default('open'),
  season: idSchema.optional(),
  page: z.coerce.number().int().min(1).max(LEAGUE_MAX_PAGE).default(1),
});

export const leagueResponseSchema = z.strictObject({
  season: seasonSchema,
  division: divisionSchema,
  /** True when the season is over: the table is final and nothing trades. */
  seasonEnded: z.boolean(),
  market: marketStatusSchema.nullable(),
  /** What the ranks are as of. Null until the division has had its first ranking this season. */
  state: leagueStateSchema.nullable(),
  /** One page: ranked agents by rank, then the unranked ones. LEAGUE_PAGE_SIZE rows at most. */
  rows: z.array(standingRowSchema),
  page: z.number().int().positive(),
  /** True if there is a next page. */
  hasMore: z.boolean(),
  /** The round that is still being processed, if there is one. */
  round: z.strictObject({ tickId: tickIdSchema, pending: amountSchema }).nullable(),
});
export type LeagueResponse = z.infer<typeof leagueResponseSchema>;

/** GET /api/agents/:id. 404 for an unknown or hidden agent. */
export const agentPublicSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  division: divisionSchema,
  /** The owner's address, shortened: 0x7a3f…c91e. */
  ownerShort: z.string(),
  /** The house model, or the owner's provider and model. The page words it. */
  model: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('house') }),
    z.strictObject({ kind: z.literal('own'), providerLabel: z.string(), model: z.string() }),
    /** A Pro agent whose model key was removed. */
    z.strictObject({ kind: z.literal('none') }),
  ]),
  status: agentStatusSchema,
  createdAt: isoTimeSchema,
  summary: z.string().nullable(),
  summaryStatus: summaryStatusSchema,
  /** The full strategy prompt. Null unless the owner has published it. */
  prompt: z.string().nullable(),
  season: seasonSchema,
  /** The published rank. Null when the agent is not ranked. */
  rank: z.number().int().positive().nullable(),
  /**
   * Why there is no rank. Null when there is one, and also null when the division has had no
   * ranking yet this season: the page then says the agent has not been in a round.
   */
  unrankedReason: unrankedReasonSchema.nullable(),
  /** How many agents of the division are ranked. Zero before the first ranking. */
  rankedCount: amountSchema,
  stats: agentStatsSchema,
  holdings: z.array(holdingPublicSchema),
  cashMicro: amountSchema,
  cashWeightBps: amountSchema,
  /** The tick the holdings are valued at. Null before the agent's first row. */
  asOfTickId: tickIdSchema.nullable(),
  /** Newest first, at most 30. */
  decisions: z.array(decisionPublicSchema),
  /** The scoring method behind the rank: the season's official method, "v1" or "v2". Stats are always the live figures. */
  method: z.string(),
  /** True for an agent that Prix itself runs. The API always sends it; optional as on a league row. */
  house: z.boolean().optional(),
  /** As on a league row (section 18): null in a v1 season. Optional in the schema, always sent. */
  scoreMilli: signedAmountSchema.nullable().optional(),
  confidence: standingConfidenceSchema.nullable().optional(),
  scoredDay: utcDaySchema.nullable().optional(),
  /**
   * Phase 6.7 (docs/contracts/phase-6-holders.md, part B): true when the owner's STORED tier is 2 or above,
   * read with `cachedOnly` (`ownerHoldsOf`), and the owner has turned the mark on from /account/token
   * (`users.show_holds`, off by default; revision 2); false otherwise, for a house agent and while gating is off. Sent only by
   * `GET /api/agents/:id`; the data API never sends it. Optional so that a page built for it can read an
   * API that does not send it yet.
   */
  ownerHolds: z.boolean().optional(),
});
export type AgentPublic = z.infer<typeof agentPublicSchema>;

/** GET /api/market */
export const marketResponseSchema = z.strictObject({
  market: marketStatusSchema.nullable(),
  season: seasonSchema.nullable(),
});
export type MarketResponse = z.infer<typeof marketResponseSchema>;

/** One symbol of the price strip. docs/CONTRACTS.md section 17.2. */
export const marketPriceSchema = z.strictObject({
  symbol: symbolSchema,
  /** The token's name as the universe gives it, for example "NVIDIA". */
  name: z.string(),
  /** The reference price at the round, in micro-USD per share. */
  priceMicro: amountSchema,
  /** The change since the last stored daily price before the round's day, in basis points. Null without one. */
  changeBps: signedAmountSchema.nullable(),
  /** False when the feed was stale at the round: the price is shown as it is and marked. */
  fresh: z.boolean(),
});
export type MarketPrice = z.infer<typeof marketPriceSchema>;

/** GET /api/market/prices: the universe at the latest round, for the price strip. Public, cached 30 seconds. */
export const marketPricesResponseSchema = z.strictObject({
  /** The round the prices are from. Null before the first round, and then `prices` is empty. */
  tickId: tickIdSchema.nullable(),
  takenAt: isoTimeSchema.nullable(),
  /** In universe order. */
  prices: z.array(marketPriceSchema),
});
export type MarketPricesResponse = z.infer<typeof marketPricesResponseSchema>;

/** GET /api/seasons */
export const seasonsResponseSchema = z.strictObject({ seasons: z.array(seasonSchema) });
export type SeasonsResponse = z.infer<typeof seasonsResponseSchema>;

/** GET /api/providers */
export const providersResponseSchema = z.strictObject({
  providers: z.array(z.strictObject({ id: providerIdSchema, label: z.string() })),
  /** The Workers AI model id of the house model, so the product can say what runs Open agents. */
  houseModel: z.string(),
});
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;

// --- signed-in --------------------------------------------------------------------------------

/** An agent as its owner sees it. The only response that carries a private prompt. */
export const agentOwnerViewSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  division: divisionSchema,
  status: agentStatusSchema,
  pausedReason: pausedReasonSchema.nullable(),
  hidden: z.boolean(),
  prompt: z.string(),
  promptPublic: z.boolean(),
  summary: z.string().nullable(),
  summaryStatus: summaryStatusSchema,
  modelKeyId: idSchema.nullable(),
  createdAt: isoTimeSchema,
  /** The agent's latest row, so the owner sees a failed key or a skipped day at once. */
  lastDecision: decisionPublicSchema.nullable(),
});
export type AgentOwnerView = z.infer<typeof agentOwnerViewSchema>;

/** GET /api/me. 401 without a session. */
export const meResponseSchema = z.strictObject({
  address: addressSchema,
  isAdmin: z.boolean(),
  agent: agentOwnerViewSchema.nullable(),
  modelKeys: z.array(modelKeyPublicSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** The response of POST /api/model-keys. */
export const modelKeyResponseSchema = z.strictObject({ modelKey: modelKeyPublicSchema });
export type ModelKeyResponse = z.infer<typeof modelKeyResponseSchema>;

/** The response of POST /api/agents and PATCH /api/agents/:id. */
export const agentResponseSchema = z.strictObject({ agent: agentOwnerViewSchema });
export type AgentResponse = z.infer<typeof agentResponseSchema>;

// --- admin ------------------------------------------------------------------------------------

/** POST /api/admin/agents/:id/hidden. Only for wallets in ADMIN_ADDRESSES. */
export const setHiddenInputSchema = z.strictObject({ hidden: z.boolean() });
export type SetHiddenInput = z.infer<typeof setHiddenInputSchema>;

/** GET /api/admin/holds. Only for wallets in ADMIN_ADDRESSES. */
export const holdsResponseSchema = z.strictObject({ holds: z.array(symbolHoldSchema) });
export type HoldsResponse = z.infer<typeof holdsResponseSchema>;

// --- rate limiting ------------------------------------------------------------------------------

/**
 * `sign_in` counts a sign-in step per IP address. `sign_in_global` is the count for everyone
 * together, taken in verify only after the nonce has proved genuine, so that requests which
 * cost nothing cannot shut sign-in for everyone.
 */
export type RateLimitRule = 'sign_in' | 'sign_in_global' | 'write' | 'read';

/** How the API asks whether a request may proceed. `platform` implements it. */
export interface RateLimiter {
  /**
   * True if the request is allowed. `subject` is an IP address or a wallet address. The limiter
   * also keeps one global count for `sign_in` and for `write`, and it refuses when it cannot count.
   */
  allow(rule: RateLimitRule, subject: string): Promise<boolean>;
}

// --- wiring -------------------------------------------------------------------------------------

export interface ApiConfig {
  /** The public origin of the site, for example https://prix.example. No trailing slash. */
  siteOrigin: string;
  /** Wallets that may use the admin routes, lower case. */
  adminAddresses: readonly string[];
  /** The Workers AI model id of the house model. */
  houseModel: string;
  /** The Worker secret NONCE_SECRET: 32 random bytes in base64, used only to sign sign-in nonces. */
  nonceSecret: string;
  /**
   * Wallets whose agents Prix itself runs, lower case: the Worker variable HOUSE_OWNERS. Their
   * agents carry `house: true` in every public read. Nothing else about them differs: they are
   * scheduled, scored and ranked like any other agent. Absent means there are none.
   */
  houseOwners?: readonly string[];
}

/** True if `owner` is one of the house wallets. The one test every phase uses to mark a house agent. */
export function isHouseOwner(houseOwners: readonly string[] | undefined, owner: string | undefined): boolean {
  if (houseOwners === undefined || owner === undefined) return false;
  const wanted = owner.toLowerCase();
  return houseOwners.some((entry) => entry.toLowerCase() === wanted);
}

/** Everything the HTTP API needs. The Worker entry point builds it from its bindings. */
export interface ApiDeps {
  store: Store;
  /** For the starting portfolio of a new agent. */
  sim: SimEngine;
  /** For the starting stats of a new agent and for the reason an agent has no rank. */
  scoring: ScoringEngine;
  /** The API can seal a key. It has no way to open one. */
  sealer: KeySealer;
  rateLimiter: RateLimiter;
  config: ApiConfig;
  now(): Date;
  /**
   * What each wallet may do: agent slots, feed delay, API quota. Absent means `openPreviewEntitlements`.
   * Phase 4 supplies the real port; the operator builds one instance and gives it to every phase.
   * docs/contracts/README.md, the seam.
   */
  entitlements?: EntitlementsPort;
  /**
   * The owner's choice to show "Owner holds $PRIX" (docs/contracts/phase-6-holders.md section 3, revision 3,
   * HB-3). routes-public.ts and the token routes read it; while it is absent `ownerHolds` is false and both
   * owner-holds routes answer the generic 404. platform passes it from apps/api/src/index.ts.
   */
  ownerHolds?: OwnerHoldsStore;
}

/** What `createApp` in `apps/api/src/http` returns. */
export interface ApiApp {
  fetch(request: Request): Promise<Response>;
}
