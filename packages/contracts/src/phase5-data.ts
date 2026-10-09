import { z } from 'zod';
import type { RateLimiter } from './api.ts';
import {
  agentPublicSchema,
  decisionPublicSchema,
  leagueQuerySchema,
  leagueResponseSchema,
  seasonsResponseSchema,
} from './api.ts';
import type { Entitlements, EntitlementsPort } from './entitlements.ts';
import { marketClosedReasonSchema, marketStatusSchema, pricePointSchema } from './market.ts';
import type { SimEngine } from './portfolio.ts';
import type { Address, IsoTime, UtcDay } from './primitives.ts';
import {
  addressSchema,
  amountSchema,
  divisionSchema,
  idSchema,
  isoTimeSchema,
  tickIdSchema,
  utcDaySchema,
} from './primitives.ts';
import type { ScoringEngine } from './scoring.ts';
import { agentStatsSchema, rowStatusSchema } from './scoring.ts';
import type { Store } from './store.ts';
import { seasonSchema } from './ticks.ts';

/**
 * Phase 5, the data network: a read-only, keyed, metered and cached API under /api/v1, an MCP
 * server that calls the same code, trust lookups read from the chain, and prepaid credits bought
 * with a USDG transfer that the server verifies on the chain. docs/contracts/phase-5-data.md says
 * what every name here means. This file edits no other contract file and is exported by the operator.
 *
 * Nothing here moves, holds or orders anything. The product receives a payment and credits a
 * number of calls; it never holds a balance for trading.
 */

// --- constants -------------------------------------------------------------------------------------

export const DATA_API_VERSION = 'v1';

/** Carried in every response and in every MCP result, because agents read them without a page around them. */
export const DATA_NOTICE =
  'Prix data is a record of a paper-trading simulation and of public chain facts. It is not investment advice and not a recommendation to buy, sell or hold anything.';

/**
 * The whole product has 100,000 requests a day, D1 writes 100,000 a day and 5,000,000 rows read.
 * A metered call costs two written rows (usage and the global count), so this ceiling is at most
 * 20,000 written rows and 10,000 requests, and a call that is refused for quota writes nothing.
 */
export const DATA_API_DAILY_CEILING = 10_000;
/**
 * The part of the keyed ceiling that only paid calls may use (a bucket of its own), so free callers
 * cannot lock a paying one out. The free calls get `apiDailyCeiling` minus this, so together they
 * stay at the ceiling, and with the page lookups at the 12,000 requests of docs/contracts/README.md.
 */
export const DATA_API_PAID_DAILY_CEILING = 2_000;
/** Trust-page misses one network (IPv6: its /48) may cause per UTC day, in front of the shared count. */
export const DATA_PAGE_MISSES_PER_NETWORK = 100;
/** Payment hashes one wallet may submit per UTC day. */
export const DATA_PAYMENT_SUBMISSIONS_PER_DAY = 30;
/** Lookups on the public trust page that miss the cache, per UTC day, for everyone together. */
export const DATA_PAGE_DAILY_CEILING = 2_000;
/** Calls one wallet may pay for in a UTC day, so that one payer cannot take the whole ceiling. */
export const DATA_PAID_DAILY_CAP = 5_000;

/** The price of one call above the free quota, in micro-USDG: 0.001 USDG, so 1 USDG buys 1,000 calls. */
export const DATA_CALL_PRICE_MICRO = 1_000;
/** The smallest payment that is credited, in micro-USDG: 1 USDG. */
export const DATA_MIN_PAYMENT_MICRO = 1_000_000;
/** A payment counts when its block is at least this many blocks behind the head. */
export const DATA_PAYMENT_CONFIRMATIONS = 20;

/**
 * USDG on Robinhood Chain, chain ID 4663. The address is on docs.robinhood.com/chain/contracts and on
 * docs.paxos.com, both read on 2026-10-06. Six decimals is the figure Paxos gives for USDG on every
 * chain; neither page states it for this chain, so the payment reader checks `decimals()` once per
 * isolate and refuses to credit when it is not 6.
 */
export const USDG_ADDRESS: Address = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const USDG_DECIMALS = 6;
/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * The Pons factories on Robinhood Chain. docs.ponsfamily.com lists the first as the active factory
 * with start block 8991118; docs.mobula.io lists the second as the previous generation. Their
 * generation labels disagree between the two sources, so the labels here say only which is which.
 * The start block of the second is not published: the scan starts at block 0 for it.
 */
export const PONS_FACTORIES: readonly { address: Address; label: 'active' | 'previous'; startBlock: number }[] = [
  { address: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', label: 'active', startBlock: 8_991_118 },
  { address: '0x0c37a24f5d23a486fa692d1500881d698b1f77a4', label: 'previous', startBlock: 0 },
];
/**
 * event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory,
 * address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId,
 * uint256 restrictionsEndBlock, uint256 initialBuyAmount). topic1 is the token, topic2 the deployer.
 * The topic is as docs.ponsfamily.com prints it; a test recomputes it from the signature.
 */
export const PONS_TOKEN_LAUNCHED_TOPIC0 = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

/** A key is `prix_` and 52 base32 characters: 32 random bytes. */
export const DATA_KEY_PREFIX = 'prix_';
export const DATA_KEY_PATTERN = /^prix_[a-z2-7]{52}$/;
/** How much of a key is stored in the clear to recognise it: `prix_` and seven characters. */
export const DATA_KEY_SHOWN_CHARS = 12;
export const MAX_API_KEYS_PER_WALLET = 5;
/** Keys a wallet may create in one UTC day, revoked ones included. */
export const MAX_API_KEY_CREATES_PER_DAY = 5;
/** Keys created by everyone together in one UTC day. Each costs four written rows, so this is at most 2,000 of the day's 100,000. */
export const DATA_KEY_CREATES_DAILY_CEILING = 500;
export const DATA_KEY_LABEL_MAX = 40;

export const DEVELOPER_LAUNCHES_MAX = 50;
/** Seconds a lookup is served from the Worker cache. */
export const TRUST_CACHE_SECONDS = { developer: 300, token: 600, wallet: 60 } as const;
/** Usage rows older than this many days are deleted. */
export const USAGE_RETENTION_DAYS = 35;

/** The method versions that trust lookups state. A change of what a lookup reads is a new version. */
export const TRUST_METHODS = {
  developer: 'developer-v1',
  token: 'token-facts-v1',
  wallet: 'wallet-record-v1',
} as const;

const COMMON_BLIND_SPOTS = [
  'These are facts read from the chain or from the league. They are not a score, a rating or a recommendation.',
  'A lookup describes one address. It does not link addresses that belong to the same person.',
  'The chain is read at one moment through a public endpoint; a very recent event may be missing.',
] as const;

export const TRUST_BLIND_SPOTS = {
  developer: [
    ...COMMON_BLIND_SPOTS,
    'Only launches made through the Pons factories listed in `factoriesScanned` are found. Launches through any other launchpad, or by deploying a token directly, are not.',
    'A launch is attributed to the address that called the factory. When that address is a contract, the person behind it is not named.',
    'It says nothing about what happened to a token after its launch.',
  ],
  token: [
    ...COMMON_BLIND_SPOTS,
    'Selector findings read the deployed bytecode for a four-byte function selector. A selector can be present and not callable, or absent in a contract that reaches the same effect another way.',
    'Holder concentration is checked for the deployer only. Other large holders, locked liquidity, taxes, trading restrictions and the contents of the liquidity pool are not read.',
    'A token that is not an ERC-20, or that answers its fields in a non-standard way, shows those fields as null.',
  ],
  wallet: [
    ...COMMON_BLIND_SPOTS,
    'It lists the agents that this wallet owns in the Prix league. A wallet with no agent here may still run agents elsewhere.',
    'A listing is the owner’s own registration on the chain. It proves who listed the agent, not that the agent is good.',
    'The record is a paper simulation at reference prices. It says nothing about real trading.',
  ],
} as const;

// --- errors ------------------------------------------------------------------------------------------

export const dataErrorCodeSchema = z.enum([
  /** No key was sent. */
  'missing_key',
  /** The key is unknown, revoked, or its wallet is blocked. */
  'invalid_key',
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_input',
  'rate_limited',
  /** The wallet's free calls for the UTC day are used up and it has no credits. */
  'quota_exceeded',
  /** The API's daily ceiling is reached for everyone. */
  'api_busy',
  /** A daily limit of the free plan is used up. */
  'daily_limit',
  'key_limit_reached',
  'key_create_limit_reached',
  /** The API is not switched on, or payments are not. */
  'unavailable',
  /** A payment is not final yet, or the chain does not know the transaction yet. Try again. */
  'payment_pending',
  /** A payment cannot be credited. The message says why. */
  'payment_invalid',
  /** The transaction was credited to another wallet. */
  'payment_already_credited',
  'chain_unavailable',
  'internal',
]);
export type DataErrorCode = z.infer<typeof dataErrorCodeSchema>;

export const DATA_ERROR_STATUS: Record<DataErrorCode, number> = {
  missing_key: 401,
  invalid_key: 401,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  rate_limited: 429,
  quota_exceeded: 429,
  api_busy: 503,
  daily_limit: 503,
  key_limit_reached: 409,
  key_create_limit_reached: 429,
  unavailable: 503,
  payment_pending: 409,
  payment_invalid: 422,
  payment_already_credited: 409,
  chain_unavailable: 503,
  internal: 500,
};

/** The same shape as `apiErrorSchema`, with this phase's codes. A message says what happened and what to do next. */
export const dataErrorSchema = z.strictObject({
  error: z.strictObject({
    code: dataErrorCodeSchema,
    message: z.string(),
    field: z.string().nullable(),
  }),
});
export type DataError = z.infer<typeof dataErrorSchema>;

/** An error the caller is told about. The message is written by hand and never carries anything from a request or a thrown error. */
export class DataFailure extends Error {
  readonly code: DataErrorCode;
  readonly field: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: DataErrorCode, message: string, field: string | null = null, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'DataFailure';
    this.code = code;
    this.field = field;
    this.headers = headers;
  }

  get status(): number {
    return DATA_ERROR_STATUS[this.code];
  }
}

/** Thrown by a `DataChainPort` when no endpoint answered or an answer was unusable. The API turns it into 503 `chain_unavailable`. */
export class ChainUnavailableError extends Error {
  readonly code = 'chain_unavailable';

  constructor(message = 'The chain could not be read.') {
    super(message);
    this.name = 'ChainUnavailableError';
  }
}

// --- inputs ----------------------------------------------------------------------------------------

/** A chain address as a caller writes it, in any case. Handlers lower-case it with `lowerAddress`. */
export const addressInputSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 0x address of 40 hex characters.');
export const txHashInputSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'Expected a 0x transaction hash of 64 hex characters.');

export function lowerAddress(input: string): Address {
  return input.toLowerCase();
}

const noInputSchema = z.strictObject({});
const addressLookupInputSchema = z.strictObject({ address: addressInputSchema });

export const agentInputSchema = z.strictObject({ id: idSchema });
export const agentDecisionsInputSchema = z.strictObject({
  id: idSchema,
  /** Defaults to the active season, or the latest one that has started. */
  season: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// --- responses -------------------------------------------------------------------------------------

/** Every answer of the API and every MCP result is `{ notice, data }`. */
export function dataEnvelope<T extends z.ZodType>(data: T) {
  return z.strictObject({ notice: z.literal(DATA_NOTICE), data });
}

export const agentDecisionsResponseSchema = z.strictObject({
  agentId: idSchema,
  seasonId: idSchema,
  /** How long decisions are held back for this caller. Zero means none. Rows newer than that are left out. */
  delayedBySeconds: amountSchema,
  /** Newest first. */
  decisions: z.array(decisionPublicSchema),
});
export type AgentDecisionsResponse = z.infer<typeof agentDecisionsResponseSchema>;

export const marketSnapshotResponseSchema = z.strictObject({
  market: marketStatusSchema.nullable(),
  season: seasonSchema.nullable(),
  /** The prices of the latest tick, the ones the league fills at. Null before the first tick. */
  snapshot: z
    .strictObject({
      tickId: tickIdSchema,
      takenAt: isoTimeSchema,
      open: z.boolean(),
      closedReason: marketClosedReasonSchema.nullable(),
      prices: z.array(pricePointSchema),
    })
    .nullable(),
});
export type MarketSnapshotResponse = z.infer<typeof marketSnapshotResponseSchema>;

export const observationCodeSchema = z.enum([
  'not_a_contract',
  'owner_set',
  'owner_renounced',
  'upgradeable_proxy',
  'mint_selector_present',
  'pause_selector_present',
  'deployer_holds_over_10_percent',
  'launched_on_pons',
  'not_found_on_pons',
  'fields_unreadable',
  'no_launches_found',
  'launches_truncated',
  'no_agent_found',
]);
/** One plain statement of a fact that was read. Never a verdict. */
export const observationSchema = z.strictObject({ code: observationCodeSchema, text: z.string() });
export type Observation = z.infer<typeof observationSchema>;

export const ponsLaunchSchema = z.strictObject({
  factory: addressSchema,
  token: addressSchema,
  deployer: addressSchema,
  blockNumber: amountSchema,
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  logIndex: amountSchema,
});
export type PonsLaunch = z.infer<typeof ponsLaunchSchema>;

export const developerLookupSchema = z.strictObject({
  address: addressSchema,
  method: z.literal(TRUST_METHODS.developer),
  blindSpots: z.array(z.string()),
  factoriesScanned: z.array(addressSchema),
  scannedFromBlock: amountSchema,
  scannedToBlock: amountSchema,
  /** Every launch found, which may be more than `launches` holds. */
  launchCount: amountSchema,
  /** Newest first, at most DEVELOPER_LAUNCHES_MAX. */
  launches: z.array(ponsLaunchSchema),
  observations: z.array(observationSchema),
});
export type DeveloperLookup = z.infer<typeof developerLookupSchema>;

export const tokenFactsSchema = z.strictObject({
  address: addressSchema,
  chainId: z.literal(4663),
  method: z.literal(TRUST_METHODS.token),
  blindSpots: z.array(z.string()),
  /** The block the facts were read at. */
  readAtBlock: amountSchema,
  isContract: z.boolean(),
  codeSizeBytes: amountSchema,
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().int().nullable(),
  /** In the token's smallest unit, as a decimal string, because it can exceed a safe integer. */
  totalSupply: z.string().nullable(),
  /** The address `owner()` answers. Null when the token has no `owner()`. The zero address is shown as null with `owner_renounced`. */
  owner: addressSchema.nullable(),
  /** The EIP-1967 implementation address, or null when the slot is empty. */
  proxyImplementation: addressSchema.nullable(),
  hasMintSelector: z.boolean(),
  hasPauseSelector: z.boolean(),
  ponsLaunch: ponsLaunchSchema.nullable(),
  /** Share of the supply the deployer holds, in basis points, for a token launched on Pons. Null otherwise. */
  deployerHoldingBps: amountSchema.nullable(),
  observations: z.array(observationSchema),
});
export type TokenFacts = z.infer<typeof tokenFactsSchema>;

export const agentListingSchema = z.strictObject({
  agentId: idSchema,
  /** When the owner listed the agent on the chain. */
  listedAt: isoTimeSchema.nullable(),
  verifiedBadge: z.boolean(),
});
export type AgentListing = z.infer<typeof agentListingSchema>;

export const walletAgentRecordSchema = z.strictObject({
  agentId: idSchema,
  name: z.string(),
  division: divisionSchema,
  season: seasonSchema,
  rank: z.number().int().positive().nullable(),
  stats: agentStatsSchema,
  lastStatus: rowStatusSchema.nullable(),
  /** Null when the agent is not listed on the chain. */
  listing: agentListingSchema.nullable(),
});
export type WalletAgentRecord = z.infer<typeof walletAgentRecordSchema>;

export const walletRecordSchema = z.strictObject({
  address: addressSchema,
  method: z.literal(TRUST_METHODS.wallet),
  blindSpots: z.array(z.string()),
  /** The agents the wallet owns that are visible to the public. At most one in Phase 1. */
  agents: z.array(walletAgentRecordSchema),
  observations: z.array(observationSchema),
});
export type WalletRecord = z.infer<typeof walletRecordSchema>;

const tierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

/** GET /api/v1/me and GET /api/data/usage. Not metered. */
export const dataUsageSchema = z.strictObject({
  address: addressSchema,
  tier: tierSchema,
  /** False while the token or the gating flag is off: the page then says "preview". */
  gatingOn: z.boolean(),
  /** Free calls a day for this wallet, across all its keys. */
  quotaPerDay: amountSchema,
  usedFree: amountSchema,
  usedPaid: amountSchema,
  remainingFree: amountSchema,
  creditsMicro: amountSchema,
  callPriceMicro: amountSchema,
  /** The next 00:00 UTC. */
  resetsAt: isoTimeSchema,
  paymentsEnabled: z.boolean(),
  /** The last days with calls, newest first. Only in GET /api/data/usage. */
  history: z.array(z.strictObject({ day: utcDaySchema, free: amountSchema, paid: amountSchema })),
});
export type DataUsage = z.infer<typeof dataUsageSchema>;

// --- the endpoint registry -------------------------------------------------------------------------

export type DataEndpointId =
  | 'seasons'
  | 'league'
  | 'agent'
  | 'agent_decisions'
  | 'market'
  | 'developer'
  | 'token'
  | 'wallet'
  | 'usage';

export interface DataEndpointSpec {
  id: DataEndpointId;
  method: 'GET';
  /** Under /api/v1. `:name` is a path parameter. */
  path: string;
  /** The MCP tool that calls the same handler. */
  mcpTool: string;
  summary: string;
  /** Path parameters and query together, strict. The MCP tool's arguments are the same object. */
  input: z.ZodType;
  /** The `data` of the envelope. */
  data: z.ZodType;
  /** Seconds the answer is cached inside the Worker, after metering. Zero is never cached. */
  cacheSeconds: number;
  /** False only for `usage`. */
  metered: boolean;
  /** True when the unkeyed trust page may call it through GET /api/data/trust/:kind/:address. */
  pageSafe: boolean;
}

/**
 * The one list that the routes, the MCP tools, the published schema document and the tests are
 * generated from. Adding an endpoint means adding a row here and nothing else in the list.
 */
export const DATA_ENDPOINTS: readonly DataEndpointSpec[] = [
  {
    id: 'seasons',
    method: 'GET',
    path: '/seasons',
    mcpTool: 'get_seasons',
    summary: 'Every season that has been created, oldest first.',
    input: noInputSchema,
    data: seasonsResponseSchema,
    cacheSeconds: 300,
    metered: true,
    pageSafe: false,
  },
  {
    id: 'league',
    method: 'GET',
    path: '/league',
    mcpTool: 'get_league',
    summary: 'One page of a league table: ranks, returns, drawdown and sparkline of every agent of a division.',
    input: leagueQuerySchema,
    data: leagueResponseSchema,
    cacheSeconds: 30,
    metered: true,
    pageSafe: false,
  },
  {
    id: 'agent',
    method: 'GET',
    path: '/agents/:id',
    mcpTool: 'get_agent',
    summary:
      'One agent: rank, stats, holdings at the latest tick and its newest decisions, held back as the caller’s tier says.',
    input: agentInputSchema,
    data: agentPublicSchema,
    cacheSeconds: 30,
    metered: true,
    pageSafe: false,
  },
  {
    id: 'agent_decisions',
    method: 'GET',
    path: '/agents/:id/decisions',
    mcpTool: 'get_agent_decisions',
    summary: 'The decisions of one agent in a season, newest first, held back as the caller’s tier says.',
    input: agentDecisionsInputSchema,
    data: agentDecisionsResponseSchema,
    cacheSeconds: 30,
    metered: true,
    pageSafe: false,
  },
  {
    id: 'market',
    method: 'GET',
    path: '/market',
    mcpTool: 'get_market',
    summary:
      'Whether the paper market is open, and the reference prices of the Stock Tokens and crypto assets of the universe at the latest tick.',
    input: noInputSchema,
    data: marketSnapshotResponseSchema,
    cacheSeconds: 30,
    metered: true,
    pageSafe: false,
  },
  {
    id: 'developer',
    method: 'GET',
    path: '/trust/developers/:address',
    mcpTool: 'lookup_developer',
    summary: 'The Pons launches an address has made, read from the chain.',
    input: addressLookupInputSchema,
    data: developerLookupSchema,
    cacheSeconds: TRUST_CACHE_SECONDS.developer,
    metered: true,
    pageSafe: true,
  },
  {
    id: 'token',
    method: 'GET',
    path: '/trust/tokens/:address',
    mcpTool: 'lookup_token',
    summary: 'Basic facts of a token contract read from the chain, with the method version and what it does not cover.',
    input: addressLookupInputSchema,
    data: tokenFactsSchema,
    cacheSeconds: TRUST_CACHE_SECONDS.token,
    metered: true,
    pageSafe: true,
  },
  {
    id: 'wallet',
    method: 'GET',
    path: '/trust/wallets/:address',
    mcpTool: 'lookup_wallet',
    summary: 'The agents a wallet owns in the Prix league, and whether each is listed on the chain.',
    input: addressLookupInputSchema,
    data: walletRecordSchema,
    cacheSeconds: TRUST_CACHE_SECONDS.wallet,
    metered: true,
    pageSafe: true,
  },
  {
    id: 'usage',
    method: 'GET',
    path: '/me',
    mcpTool: 'get_usage',
    summary: 'The caller’s quota, calls used today and credits. Not metered.',
    input: noInputSchema,
    data: dataUsageSchema,
    cacheSeconds: 0,
    metered: false,
    pageSafe: false,
  },
];

export function dataEndpoint(id: DataEndpointId): DataEndpointSpec {
  const spec = DATA_ENDPOINTS.find((entry) => entry.id === id);
  if (spec === undefined) throw new Error(`unknown data endpoint: ${id}`);
  return spec;
}

/** GET /api/v1/schema: the registry as JSON Schema, built once when the Worker starts. */
export const schemaDocumentSchema = z.strictObject({
  version: z.literal(DATA_API_VERSION),
  notice: z.literal(DATA_NOTICE),
  endpoints: z.array(
    z.strictObject({
      id: z.string(),
      method: z.literal('GET'),
      path: z.string(),
      mcpTool: z.string(),
      summary: z.string(),
      metered: z.boolean(),
      cacheSeconds: amountSchema,
      /** JSON Schema of the path parameters and query. */
      input: z.record(z.string(), z.unknown()),
      /** JSON Schema of `data`. */
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  errors: z.array(z.strictObject({ code: dataErrorCodeSchema, status: z.number().int() })),
});
export type SchemaDocument = z.infer<typeof schemaDocumentSchema>;

/**
 * The registry as JSON Schema. It lives here, beside the registry, because both the API
 * (`GET /api/v1/schema`, built once at module load) and the documentation page (built at site build
 * time) need it, and `apps/web` does not depend on zod directly: only this package does.
 * `apps/api/src/http/data/schema-doc.ts` re-exports it.
 */
export function buildSchemaDocument(): SchemaDocument {
  return {
    version: DATA_API_VERSION,
    notice: DATA_NOTICE,
    endpoints: DATA_ENDPOINTS.map((spec) => ({
      id: spec.id,
      method: spec.method,
      path: `/api/v1${spec.path}`,
      mcpTool: spec.mcpTool,
      summary: spec.summary,
      metered: spec.metered,
      cacheSeconds: spec.cacheSeconds,
      input: z.toJSONSchema(spec.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
      data: z.toJSONSchema(spec.data, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>,
    })),
    errors: (Object.keys(DATA_ERROR_STATUS) as DataErrorCode[]).map((code) => ({
      code,
      status: DATA_ERROR_STATUS[code],
    })),
  };
}

// --- keys, credits, payments (signed in, under /api/data) ------------------------------------------

export const apiKeyPublicSchema = z.strictObject({
  id: idSchema,
  /** The first DATA_KEY_SHOWN_CHARS characters of the key. The key itself is never shown again. */
  prefix: z.string(),
  label: z.string(),
  createdAt: isoTimeSchema,
  lastUsedDay: utcDaySchema.nullable(),
  revoked: z.boolean(),
});
export type ApiKeyPublic = z.infer<typeof apiKeyPublicSchema>;

export const createApiKeyInputSchema = z.strictObject({
  label: z
    .string()
    .regex(/^[A-Za-z0-9 ._-]{1,40}$/, 'Use 1 to 40 letters, digits, spaces, dots, dashes or underscores.'),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

/** POST /api/data/keys. `secret` is shown here once and stored only as a hash. */
export const createApiKeyResponseSchema = z.strictObject({
  key: apiKeyPublicSchema,
  secret: z.string().regex(DATA_KEY_PATTERN),
});
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

export const listApiKeysResponseSchema = z.strictObject({
  keys: z.array(apiKeyPublicSchema),
  maxActive: amountSchema,
});
export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;

export const paymentPublicSchema = z.strictObject({
  txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  amountMicro: amountSchema,
  blockNumber: amountSchema,
  creditedAt: isoTimeSchema,
});
export type PaymentPublic = z.infer<typeof paymentPublicSchema>;

/** POST /api/data/payments. The page never asks the wallet for a transaction: the person pays in their own wallet and pastes the hash. */
export const submitPaymentInputSchema = z.strictObject({ txHash: txHashInputSchema });
export type SubmitPaymentInput = z.infer<typeof submitPaymentInputSchema>;

export const submitPaymentResponseSchema = z.strictObject({
  payment: paymentPublicSchema,
  balanceMicro: amountSchema,
  /** True when the same wallet submitted this transaction before: nothing new was credited. */
  alreadyCredited: z.boolean(),
});
export type SubmitPaymentResponse = z.infer<typeof submitPaymentResponseSchema>;

export const listPaymentsResponseSchema = z.strictObject({
  payments: z.array(paymentPublicSchema),
  balanceMicro: amountSchema,
});
export type ListPaymentsResponse = z.infer<typeof listPaymentsResponseSchema>;

/** GET /api/data/pricing. Public. */
export const pricingResponseSchema = z.strictObject({
  enabled: z.boolean(),
  freeQuotaPerDay: amountSchema,
  tiers: z.array(z.strictObject({ tier: tierSchema, thresholdPpm: amountSchema, quotaPerDay: amountSchema })),
  gatingOn: z.boolean(),
  paymentsEnabled: z.boolean(),
  callPriceMicro: amountSchema,
  minPaymentMicro: amountSchema,
  confirmations: amountSchema,
  /** Where to send USDG. Null while payments are off. */
  paymentAddress: addressSchema.nullable(),
  token: z.strictObject({
    symbol: z.literal('USDG'),
    address: addressSchema,
    decimals: z.literal(USDG_DECIMALS),
    chainId: z.literal(4663),
  }),
  dailyCeiling: amountSchema,
  mcpPath: z.string(),
});
export type PricingResponse = z.infer<typeof pricingResponseSchema>;

export const trustKindSchema = z.enum(['developers', 'tokens', 'wallets']);
export type TrustKind = z.infer<typeof trustKindSchema>;

// --- ports -----------------------------------------------------------------------------------------

export interface UsageCounts {
  freeN: number;
  paidN: number;
}

export interface ApiKeyRecord {
  id: string;
  owner: Address;
  /** SHA-256 of the whole key, in hex. */
  keyHash: string;
  prefix: string;
  label: string;
  createdAt: IsoTime;
  lastUsedDay: UtcDay | null;
  revokedAt: IsoTime | null;
}

export interface AuthenticatedKey {
  keyId: string;
  owner: Address;
  lastUsedDay: UtcDay | null;
}

export interface PaymentRecord {
  /** Lower case. */
  txHash: string;
  owner: Address;
  amountMicro: number;
  blockNumber: number;
  creditedAt: IsoTime;
}

export type GlobalBucket = 'api' | 'page';

/**
 * Everything this phase stores, behind one interface, in D1: `apps/api/src/store/data.ts`.
 * Every method is one statement or one batch, and every limit is decided in SQL in the same
 * statement that counts, so two concurrent calls cannot both pass a limit.
 */
export interface DataStore {
  // keys
  /** Null for an unknown or revoked key, or a blocked wallet. One indexed read. */
  authenticateKey(keyHash: string): Promise<AuthenticatedKey | null>;
  /** Sets `lastUsedDay` only when it is not `day` already, so it writes at most once a day per key. */
  markKeyUsed(keyId: string, day: UtcDay): Promise<void>;
  /**
   * Inserts the key unless the wallet is blocked, already has `maxActive` unrevoked keys, or
   * created `maxCreatesToday` keys since `dayStart`, or everyone together created `maxCreatesAllToday`
   * since then. Decided in SQL, in the same statement.
   */
  createKey(
    key: ApiKeyRecord,
    limits: { maxActive: number; maxCreatesToday: number; maxCreatesAllToday: number; dayStart: IsoTime },
  ): Promise<'created' | 'key_limit_reached' | 'create_limit_reached' | 'ceiling_reached' | 'blocked'>;
  /** Newest first, revoked ones included. */
  listKeys(owner: Address): Promise<ApiKeyRecord[]>;
  /** False if the key is not the owner's or is already revoked. */
  revokeKey(id: string, owner: Address, now: IsoTime): Promise<boolean>;

  // metering
  /** One statement: counts one free call if `freeN < quota`. Null when the quota is used up. Writes nothing then. */
  meterFree(day: UtcDay, owner: Address, quota: number): Promise<UsageCounts | null>;
  /**
   * Takes `priceMicro` from the wallet's credits and counts one paid call, unless the credits are
   * short or `paidN` has reached `paidCap`. Null then, and nothing is changed.
   */
  meterPaid(
    day: UtcDay,
    owner: Address,
    priceMicro: number,
    paidCap: number,
  ): Promise<{ usage: UsageCounts; balanceMicro: number } | null>;
  /** One statement: counts one call if the bucket's count is below `ceiling`. Null when it is not. */
  meterGlobal(day: UtcDay, bucket: GlobalBucket, ceiling: number): Promise<number | null>;
  /**
   * One statement on the shared `counters` table: counts one if the key's count is below `cap`.
   * `key` starts with `d:<day>:` so the daily prune removes it. False when the cap is reached.
   */
  meterCounter(key: string, cap: number, now: IsoTime): Promise<boolean>;
  /** Gives back one call that was counted and then not served: free, or paid (credits back, `paidN` down). */
  refundCall(day: UtcDay, owner: Address, kind: 'free' | 'paid', priceMicro: number): Promise<void>;
  getUsage(day: UtcDay, owner: Address): Promise<UsageCounts>;
  /** The wallet's last days with calls, newest first. */
  listUsage(owner: Address, limit: number): Promise<{ day: UtcDay; freeN: number; paidN: number }[]>;

  // credits and payments
  getCredits(owner: Address): Promise<{ balanceMicro: number; boughtMicro: number }>;
  /**
   * Inserts the payment and adds its amount to the wallet's credits, in one batch. The primary
   * key on `txHash` makes a second credit impossible, whoever sends it and however many at once.
   * `already_credited`: the same wallet sent it before. `taken`: another wallet did.
   */
  creditPayment(payment: PaymentRecord): Promise<'credited' | 'already_credited' | 'taken'>;
  listPayments(owner: Address, limit: number): Promise<PaymentRecord[]>;

  // abuse
  isBlocked(owner: Address): Promise<boolean>;
  /** Blocks the wallet and revokes its keys, in one batch. */
  blockWallet(owner: Address, reason: string, now: IsoTime): Promise<void>;
  /** False if the wallet was not blocked. Revoked keys stay revoked. */
  unblockWallet(owner: Address): Promise<boolean>;

  // upkeep
  /** Deletes usage and global-count rows older than USAGE_RETENTION_DAYS before `today`. Returns the rows deleted. */
  prune(today: UtcDay): Promise<number>;
}

export interface TokenBasics {
  isContract: boolean;
  codeSizeBytes: number;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  owner: Address | null;
  proxyImplementation: Address | null;
  hasMintSelector: boolean;
  hasPauseSelector: boolean;
  /** `balanceOf(holder)` as a decimal string, when a holder was asked for and the call answered. */
  holderBalance: string | null;
  readAtBlock: number;
}

export interface LaunchScan {
  /** Newest first, at most the `limit` asked for. */
  launches: PonsLaunch[];
  /** Launches found in the whole range, which may exceed `launches`. */
  total: number;
  scannedFromBlock: number;
  scannedToBlock: number;
}

export interface UsdgTransfer {
  from: Address;
  to: Address;
  /** Micro-USDG, as a decimal string. */
  valueMicro: string;
}

/** What the chain says about a transaction, with no judgement. The policy is `evaluatePayment` in apps/api. */
export interface PaymentFacts {
  /** False when no endpoint knows the transaction. */
  found: boolean;
  /** The receipt's status. Null when not found. */
  success: boolean | null;
  blockNumber: number | null;
  headBlock: number;
  /** `Transfer` logs of the USDG contract only, in log order. */
  transfers: UsdgTransfer[];
  /** False when `decimals()` of the USDG contract is not USDG_DECIMALS. */
  decimalsOk: boolean;
}

/**
 * Reads the chain for this phase. `packages/market/src/data-chain.ts` implements it with
 * JSON-RPC over `fetch`: no private key, no signing, and nothing but reads. Every method throws
 * `ChainUnavailableError` when no endpoint gave a usable answer.
 */
export interface DataChainPort {
  readLaunchesByDeployer(deployer: Address, limit: number): Promise<LaunchScan>;
  /** The launch that created `token`, or null if no Pons factory emitted one for it. */
  readLaunchOfToken(token: Address): Promise<PonsLaunch | null>;
  readTokenBasics(token: Address, holder: Address | null): Promise<TokenBasics>;
  readPaymentFacts(txHash: string): Promise<PaymentFacts>;
}

/**
 * What Phase 5 needs from Phase 2's `RecordsReadPort`: the on-chain listings of the agents of a
 * wallet. Until Phase 2 is wired, `noListings` answers for everyone.
 */
export interface DataRecordsPort {
  listingsOf(wallet: Address): Promise<readonly AgentListing[]>;
}

export const noListings: DataRecordsPort = { listingsOf: async () => [] };

export interface DataConfig {
  /** `DATA_API_ENABLED`. Off: every /api/v1 and /api/data route answers 404, and the MCP endpoint too. */
  enabled: boolean;
  /** `DATA_PAYMENTS_ENABLED`. Off: POST /api/data/payments answers 503 `unavailable`. */
  paymentsEnabled: boolean;
  /** `PAYMENT_ADDRESS`. Null while payments are off. */
  paymentAddress: Address | null;
  siteOrigin: string;
  adminAddresses: readonly string[];
  /** `DATA_API_DAILY_CEILING`, default DATA_API_DAILY_CEILING. */
  apiDailyCeiling: number;
  pageDailyCeiling: number;
  /** The paid calls' own ceiling; default DATA_API_PAID_DAILY_CEILING. */
  paidDailyCeiling?: number;
  paidDailyCap: number;
  callPriceMicro: number;
  minPaymentMicro: number;
  confirmations: number;
}

export interface DataDeps {
  /** The Phase 1 store: seasons, league, agents, decisions, ticks. Read only here. */
  store: Store;
  data: DataStore;
  chain: DataChainPort;
  records: DataRecordsPort;
  /** Phase 4 supplies the real one. Until then `openPreviewEntitlements`. */
  entitlements: EntitlementsPort;
  sim: SimEngine;
  scoring: ScoringEngine;
  rateLimiter: RateLimiter;
  config: DataConfig;
  now(): Date;
  /**
   * `ApiConfig.houseOwners` (docs/CONTRACTS.md section 17): the data API marks a house agent
   * `house: true` exactly as the public API does. Absent means there are none.
   */
  houseOwners?: readonly string[];
}

// --- the call path ---------------------------------------------------------------------------------

/** Who is calling: a key's wallet and what that wallet is entitled to, decided on the server. */
export interface DataCaller {
  keyId: string;
  owner: Address;
  entitlements: Entitlements;
}

/** Reads of one endpoint. Receives input that already passed the spec's schema. Returns the `data` of the envelope. */
export type DataHandler = (input: never, context: { caller: DataCaller | null; now: Date }) => Promise<unknown>;
export type DataHandlers = Record<DataEndpointId, DataHandler>;

export interface MeterOutcome {
  kind: 'free' | 'paid';
  /** The wallet's free calls a day. */
  limit: number;
  /** Free calls left today after this one. */
  remaining: number;
  creditsMicro: number;
}

export interface DataMeter {
  /**
   * Counts one call for the wallet, in this order: the free quota, then credits; then the global
   * ceiling, and gives the call back if the ceiling refuses. Throws `DataFailure`
   * `quota_exceeded` or `api_busy`. A call that is refused for quota writes nothing.
   */
  admit(caller: DataCaller, now: Date): Promise<MeterOutcome>;
  /** Gives back a counted call that was not served because of a server error. */
  refund(caller: DataCaller, outcome: MeterOutcome, now: Date): Promise<void>;
}

export interface EndpointResult {
  status: 200;
  /** `{ notice, data }`, already checked against the spec. */
  body: { notice: typeof DATA_NOTICE; data: unknown };
  /** Quota and cache headers, to merge into the response. */
  headers: Record<string, string>;
  cache: 'hit' | 'miss' | 'none';
}

export interface EndpointRunner {
  /**
   * The one path of a keyed call, for HTTP and for MCP: parse `rawInput` with the spec (400
   * `invalid_input` costs nothing), meter, look in the cache, call the handler, check the answer
   * against the spec, store it, and give the call back on a 5xx. Throws `DataFailure`.
   */
  run(id: DataEndpointId, rawInput: unknown, caller: DataCaller): Promise<EndpointResult>;
  /**
   * The public trust page: only for `pageSafe` endpoints, no key, counted in the `page` bucket and
   * only when the cache missed.
   */
  runPage(id: DataEndpointId, rawInput: unknown, network?: string): Promise<EndpointResult>;
}

export interface Authenticator {
  /** Reads `Authorization: Bearer <key>` and nothing else. Throws `missing_key` or `invalid_key`. */
  authenticate(request: Request): Promise<DataCaller>;
}

export type PaymentVerdict =
  | { kind: 'ok'; amountMicro: number; blockNumber: number }
  | { kind: 'pending'; message: string }
  | { kind: 'invalid'; message: string };

export interface PaymentService {
  /** Verifies the transaction on the chain and credits it once. Throws `DataFailure`. */
  submit(owner: Address, txHash: string): Promise<SubmitPaymentResponse>;
}
