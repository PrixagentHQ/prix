import { type Entitlements, type EntitlementsReadOptions, TIER_RULES, type Tier } from './entitlements.ts';
import { type Address, addressSchema, type IsoTime, isoTimeSchema } from './primitives.ts';
import { z } from './zod.ts';

/**
 * Phase 4, Token: holder tiers decided on the server from the chain.
 * docs/contracts/phase-4-token.md says what every name here means and what the rules are.
 *
 * Nothing in this file trusts a client. A tier is computed by `computeTier` from a balance and
 * a total supply that the server read from the chain, and from thresholds that the server read
 * from its own configuration table.
 */

// --- constants ---------------------------------------------------------------------------------

/** A wallet's balance is re-read when the stored read is older than this. */
export const TOKEN_CACHE_SECONDS = 900;
/** How long one Worker isolate keeps the configuration row in memory. This is the flag's flip window. */
export const TOKEN_CONFIG_CACHE_SECONDS = 30;
/** `POST /api/token/refresh` refuses a wallet whose stored read is younger than this. */
export const TOKEN_REFRESH_MIN_SECONDS = 30;
/** When a read fails, the last known tier is used for this long. Longer than this, the wallet is tier 0. */
export const TOKEN_STALE_GRACE_SECONDS = 86_400;
/** The sweep re-reads every holder with a tier above 0 whose stored read is older than this. */
export const TOKEN_SWEEP_DUE_SECONDS = 1_800;
/** The most wallets one sweep run reads: one batched chain call and a handful of D1 statements. */
export const TOKEN_SWEEP_BATCH = 30;
/** Rows per multi-row upsert: nine bound values a row, and D1 allows 100 per statement. */
export const TOKEN_UPSERT_ROWS_PER_STATEMENT = 9;
/** A tier rises only when two reads at least this far apart both show it. It falls at the first read that shows less. */
export const TOKEN_RISE_HOLD_SECONDS = 3_600;
/** The second Cron Trigger, in UTC. It has its own 10 ms of CPU, apart from the league's trigger. */
export const TOKEN_CRON = '7,37 * * * *';
/** Thresholds are parts per million of the total supply. */
export const TOKEN_MAX_THRESHOLD_PPM = 1_000_000;
/** The link to buy may only point at these hosts. */
export const TOKEN_BUY_LINK_HOSTS: readonly string[] = ['ponsfamily.com', 'www.ponsfamily.com'];
/** The explorer page of a token is this plus its address. Source: docs.robinhood.com/chain/connecting, read 2026-10-06. */
export const TOKEN_EXPLORER_URL_PREFIX = 'https://robinhoodchain.blockscout.com/token/';
/** The thresholds the table starts with (docs/SPEC.md section 11). Config may only lower them once gating has run. */
export const TOKEN_DEFAULT_THRESHOLDS_PPM: readonly [number, number, number] = [10, 100, 1_000];

// --- tier arithmetic ---------------------------------------------------------------------------

export const tierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

/** The three thresholds for tiers 1, 2 and 3, in parts per million of the total supply. */
export type Thresholds = readonly [number, number, number];

const PPM = 1_000_000n;

/**
 * The tier of a holding. Integer arithmetic only: a wallet is in tier N when
 * `balance * 1,000,000 >= thresholdN * totalSupply`. Decimals do not enter, because both
 * amounts are in the token's base units. An empty balance or an empty supply is tier 0.
 */
export function computeTier(balance: bigint, totalSupply: bigint, thresholdsPpm: Thresholds): Tier {
  if (balance <= 0n || totalSupply <= 0n) return 0;
  const scaled = balance * PPM;
  if (scaled >= BigInt(thresholdsPpm[2]) * totalSupply) return 3;
  if (scaled >= BigInt(thresholdsPpm[1]) * totalSupply) return 2;
  if (scaled >= BigInt(thresholdsPpm[0]) * totalSupply) return 1;
  return 0;
}

/** The share of the supply a balance is, in whole parts per million, rounded down. */
export function holdingPpm(balance: bigint, totalSupply: bigint): number {
  if (balance <= 0n || totalSupply <= 0n) return 0;
  return Number((balance * PPM) / totalSupply);
}

// --- configuration -----------------------------------------------------------------------------

const thresholdPpmSchema = z.number().int().min(1).max(TOKEN_MAX_THRESHOLD_PPM);

const thresholdsSchema = z
  .tuple([thresholdPpmSchema, thresholdPpmSchema, thresholdPpmSchema])
  .refine(([one, two, three]) => one < two && two < three, 'Thresholds must rise from tier 1 to tier 3.');

/** An https link to a host in `TOKEN_BUY_LINK_HOSTS`, with no credentials and no fragment. */
export const buyUrlSchema = z
  .string()
  .max(300)
  .refine((text) => {
    try {
      const url = new URL(text);
      return (
        url.protocol === 'https:' &&
        TOKEN_BUY_LINK_HOSTS.includes(url.hostname) &&
        url.username === '' &&
        url.password === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  }, 'The buy link must be an https link on ponsfamily.com.');

/** An address pasted from anywhere: trimmed and lower-cased, then checked as a lower-case address. */
export const pastedAddressSchema = z.string().trim().toLowerCase().pipe(addressSchema);

/** The one configuration row, as the store returns it. */
export const tokenConfigSchema = z.strictObject({
  /** The gating flag. Off: everyone has `OPEN_PREVIEW_ENTITLEMENTS`. */
  enabled: z.boolean(),
  /** The token. Null until it is launched. */
  tokenAddress: addressSchema.nullable(),
  thresholdsPpm: thresholdsSchema,
  buyUrl: buyUrlSchema.nullable(),
  /** Set the first time gating is switched on with a token. After that the address is fixed and thresholds only fall. */
  activatedAt: isoTimeSchema.nullable(),
  updatedAt: isoTimeSchema,
  /** The admin wallet, or `migration` for the row the migration wrote. */
  updatedBy: z.string(),
});
export type TokenConfig = z.infer<typeof tokenConfigSchema>;

/** `PUT /api/admin/token/config`: the whole writable part of the configuration. */
export const tokenConfigInputSchema = z
  .strictObject({
    enabled: z.boolean(),
    tokenAddress: pastedAddressSchema.nullable(),
    thresholdsPpm: thresholdsSchema,
    buyUrl: buyUrlSchema.nullable(),
  })
  .refine((input) => !input.enabled || input.tokenAddress !== null, {
    message: 'Gating cannot be on without a token address.',
    path: ['tokenAddress'],
  });
export type TokenConfigInput = z.infer<typeof tokenConfigInputSchema>;

export const tokenConfigResponseSchema = z.strictObject({ config: tokenConfigSchema });
export type TokenConfigResponse = z.infer<typeof tokenConfigResponseSchema>;

// --- public and signed-in responses -------------------------------------------------------------

export const tierRuleViewSchema = z.strictObject({
  tier: tierSchema,
  thresholdPpm: z.number().int().nonnegative(),
  maxAgents: z.number().int().positive(),
  realtimeFeed: z.boolean(),
  verifiedBadge: z.boolean(),
  apiDailyQuota: z.number().int().positive(),
});
export type TierRuleView = z.infer<typeof tierRuleViewSchema>;

/** The tier table with the configured thresholds in it. Tier 0 has threshold 0. */
export function tierTable(thresholdsPpm: Thresholds): TierRuleView[] {
  return TIER_RULES.map((rule) => ({
    tier: rule.tier,
    thresholdPpm: rule.tier === 0 ? 0 : (thresholdsPpm[rule.tier - 1] ?? rule.thresholdPpm),
    maxAgents: rule.maxAgents,
    realtimeFeed: rule.realtimeFeed,
    verifiedBadge: rule.verifiedBadge,
    apiDailyQuota: rule.apiDailyQuota,
  }));
}

/** `GET /api/token`. Public. */
export const tokenInfoResponseSchema = z.strictObject({
  /** True when the flag is on and a token is configured: tiers then decide what a wallet gets. */
  gatingOn: z.boolean(),
  tokenAddress: addressSchema.nullable(),
  /** The explorer page of the token. Null while no token is configured. */
  explorerUrl: z.string().nullable(),
  /** Null unless a token address is configured and a buy link is set. */
  buyUrl: z.string().nullable(),
  tiers: z.array(tierRuleViewSchema).length(4),
  /** The delay for a viewer without the real-time feed once gating is on. */
  feedDelaySeconds: z.number().int().nonnegative(),
});
export type TokenInfoResponse = z.infer<typeof tokenInfoResponseSchema>;

export const entitlementsSchema = z.strictObject({
  tier: tierSchema,
  maxAgents: z.number().int().positive(),
  feedDelaySeconds: z.number().int().nonnegative(),
  verifiedBadge: z.boolean(),
  apiDailyQuota: z.number().int().positive(),
  gatingOn: z.boolean(),
});

const digitsSchema = z.string().regex(/^\d{1,78}$/);

/** `GET /api/token/me` and `POST /api/token/refresh`. Signed in. Everything here was read by the server. */
export const tokenMeResponseSchema = z.strictObject({
  gatingOn: z.boolean(),
  tokenAddress: addressSchema.nullable(),
  tier: tierSchema,
  entitlements: entitlementsSchema,
  /** Base units, as decimal digits. Null when nothing has been read, for example while gating is off. */
  balance: digitsSchema.nullable(),
  totalSupply: digitsSchema.nullable(),
  decimals: z.number().int().min(0).max(36).nullable(),
  holdingPpm: z.number().int().nonnegative().nullable(),
  /** The next tier up, with how much more of the supply it needs. Null at tier 3 or while gating is off. */
  nextTier: z
    .strictObject({
      tier: tierSchema,
      thresholdPpm: z.number().int().positive(),
      missingPpm: z.number().int().positive(),
    })
    .nullable(),
  slots: z.strictObject({
    used: z.number().int().nonnegative(),
    max: z.number().int().positive(),
    pausedForSlots: z.number().int().nonnegative(),
  }),
  /** When the balance was read. Null when it was never read. */
  checkedAt: isoTimeSchema.nullable(),
  /** True when the last read failed and an older one is in use. */
  stale: z.boolean(),
});
export type TokenMeResponse = z.infer<typeof tokenMeResponseSchema>;

/** `GET /api/admin/token/probe?wallet=0x…`: the tier a wallet would have under the current configuration, whether or not gating is on. Writes nothing. */
export const tokenProbeQuerySchema = z.strictObject({ wallet: pastedAddressSchema });
export const tokenProbeResponseSchema = z.strictObject({
  wallet: addressSchema,
  tokenAddress: addressSchema,
  tier: tierSchema,
  balance: digitsSchema,
  totalSupply: digitsSchema,
  decimals: z.number().int().min(0).max(36),
  holdingPpm: z.number().int().nonnegative(),
  blockNumber: z.number().int().nonnegative(),
  readAt: isoTimeSchema,
});
export type TokenProbeResponse = z.infer<typeof tokenProbeResponseSchema>;

// --- the chain reader ----------------------------------------------------------------------------

export type TokenReadErrorCode =
  /** No endpoint answered, or the answer was not the expected multicall result. */
  | 'rpc_unavailable'
  /** The address is not a usable ERC-20: `totalSupply` or `decimals` reverted, or the supply is zero. */
  | 'invalid_token'
  /** A balance read failed or is larger than the total supply. Nothing is used from such an answer. */
  | 'invalid_answer';

/** Thrown by a `TokenChainReader`. Carries a code and nothing else: an RPC message can hold a key. */
export class TokenReadError extends Error {
  readonly code: TokenReadErrorCode;

  constructor(code: TokenReadErrorCode) {
    super(`Token read failed: ${code}`);
    this.name = 'TokenReadError';
    this.code = code;
  }
}

export interface TokenBalances {
  totalSupply: bigint;
  decimals: number;
  /** One balance for each wallet asked about, in the same order. */
  balances: readonly bigint[];
  blockNumber: bigint;
}

/**
 * Reads `totalSupply`, `decimals` and `balanceOf` of every wallet from one token in a single
 * multicall, which is one outbound request. `@prix/market/token-balances` implements it.
 * The token address always comes from the configuration row and never from a request.
 */
export interface TokenChainReader {
  /**
   * `atBlock` (Phase 6.7, docs/contracts/phase-6-holders.md section 5, revision 2): when given, every
   * endpoint is asked at that block number (the `eth_call` block tag) and the answer's `blockNumber` is
   * that block; absent, the endpoint's head as before. Only the holders' poll tally passes it.
   */
  readBalances(token: Address, wallets: readonly Address[], atBlock?: number): Promise<TokenBalances>;
}

// --- the store ------------------------------------------------------------------------------------

/** One wallet's last read, as stored in `token_holders`. */
export interface TokenHolder {
  address: Address;
  /** Base units, as decimal digits. */
  balance: string;
  totalSupply: string;
  decimals: number;
  tier: Tier;
  /** The agent slots of that tier when it was read. */
  maxAgents: number;
  /** The token this row was read from. A row for another token is treated as absent. */
  tokenAddress: Address;
  checkedAt: string;
  /** The highest tier every read since `riseSince` has shown while `tier` is lower. Null when no rise is pending. */
  riseTier?: Tier | null;
  riseSince?: string | null;
}

export type TokenConfigOutcome =
  | { kind: 'saved'; config: TokenConfig }
  /** The database refused: the token address is fixed, or a threshold was raised, after activation. */
  | { kind: 'locked' };

/** `apps/api/src/store/token.ts` implements it for D1. This is the only code that writes the token tables. */
export interface TokenStore {
  getConfig(): Promise<TokenConfig>;
  /**
   * Writes the configuration row. Sets `activatedAt` the first time `enabled` is true. In the
   * same batch, when `enabled` is false, releases every slot pause (`releaseSlotPauses`).
   */
  putConfig(input: TokenConfigInput, now: string, by: string): Promise<TokenConfigOutcome>;
  /** Null for an unknown wallet or a row read from another token. */
  getHolder(address: Address, token: Address): Promise<TokenHolder | null>;
  /** The stored rows of these wallets for `token` (at most `TOKEN_SWEEP_BATCH`). Wallets with no row are left out. */
  getHolders(addresses: readonly Address[], token: Address): Promise<TokenHolder[]>;
  /** Upserts the rows, `TOKEN_UPSERT_ROWS_PER_STATEMENT` to a statement, in one batch. Marks a row dirty when its slots changed. */
  putHolders(rows: readonly TokenHolder[]): Promise<void>;
  /** Holders of `token` with a tier above 0 whose `checkedAt` is before `checkedBefore`, oldest first. */
  listDueHolders(token: Address, checkedBefore: string, limit: number): Promise<Address[]>;
  /**
   * For every dirty holder, in one batch: pauses the active agents beyond the wallet's slots
   * with reason `slot_limit` (the oldest `maxAgents` agents by creation keep their place),
   * resumes the agents paused for `slot_limit` that fit again, and clears the dirty marks.
   * Never deletes anything.
   */
  applySlots(now: string): Promise<{ paused: number; resumed: number }>;
  /** Resumes every agent paused for `slot_limit`. Used when gating is switched off. */
  releaseSlotPauses(now: string): Promise<number>;
  /** The agents a wallet owns, and how many of them are paused for `slot_limit`. */
  countOwnerAgents(owner: Address): Promise<{ total: number; pausedForSlots: number }>;
}

// --- the service ------------------------------------------------------------------------------------

export type SaveConfigResult =
  | { ok: true; config: TokenConfig }
  | {
      ok: false;
      reason: 'token_invalid' | 'address_locked' | 'thresholds_locked' | 'chain_unavailable';
    };

export interface TokenStepReport {
  action: 'off' | 'idle' | 'swept' | 'failed';
  read: number;
  paused: number;
  resumed: number;
}

/**
 * The runtime of the phase. `packages/runtime/src/token/service.ts` builds it from a
 * `TokenStore`, a `TokenChainReader` and a clock, and nothing else. It is the
 * `EntitlementsPort` that every other phase calls.
 */
export interface TokenService {
  /**
   * Null is a visitor who is not signed in. Never trusts anything the client says. With
   * `options.cachedOnly` it never reads the chain: memory, then the stored row of any age within
   * `TOKEN_STALE_GRACE_SECONDS`, then tier 0 (docs/contracts/README.md, the seam; Phase 3 delivery uses it).
   */
  entitlementsFor(address: Address | null, options?: EntitlementsReadOptions): Promise<Entitlements>;
  /**
   * A wallet's holding in whole tokens, for a rule that asks for a holding and not for a tier (the room,
   * Phase 6.3): `gatingOn` as `info()` has it, and `tokens`, the stored balance divided by ten to the
   * token's decimals, rounded down and capped at Number.MAX_SAFE_INTEGER. From the same stored row a tier
   * comes from, never from a request. With `options.cachedOnly` it never reads the chain: the stored row of
   * any age within `TOKEN_STALE_GRACE_SECONDS`, else 0. Without it, a row that is missing or older than
   * `TOKEN_CACHE_SECONDS` is read again whatever its tier (a tier of 0 is otherwise kept for six hours),
   * within the same budget of reads on demand as `entitlementsFor`; when that budget is spent or the read
   * fails, the stored row within the stale grace, else 0. The hold before a tier rises does not apply: a
   * balance counts at the first read that shows it. While the gate is off: `{ gatingOn: false, tokens: 0 }`.
   *
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2, revision 3): it also answers `tier`: the tier
   * column of the row `holdingOf` took `tokens` from; 0 for no row, for the memory-only read under one whole
   * token, and while the gate is off. It is not asked of `entitlementsFor`. engine-runtime always sets
   * `tier`. A holding without `tier` counts as tier 0, so every existing fake still builds.
   *
   * Revision 3 (security L1): it also answers `checkedAt`, the time of the successful chain read the answer
   * rests on (the stored row's, or the isolate's memory's for the memory-only read); null when it rests on
   * none (the gate off, no read ever made). The lounge's join approves only when it is younger than
   * `TOKEN_CACHE_SECONDS`. Absent counts as null, so every existing fake still builds.
   */
  holdingOf(
    address: Address,
    options?: EntitlementsReadOptions,
  ): Promise<{ gatingOn: boolean; tokens: number; tier?: Tier; checkedAt?: IsoTime | null }>;
  /**
   * Phase 6.8, revision 3 (security H1; docs/contracts/phase-6-holders-2.md section 4.6 step 3): the lounge
   * sweep's read of these wallets again, in one batched chain read through the token sweep's own path
   * (`readBalances`, `settleTier`, the store): for at most LOUNGE_SWEEP_CHECKS_PER_RUN wallets, one subrequest
   * and at most two D1 statements (the previous rows and the store). It answers, for every wallet it read,
   * the tier `settleTier` gave, the gate's token and the read's time, whether or not a row was stored for
   * that wallet; null while the gate is off or when the read failed (nothing is written then). Optional, so
   * every existing fake still builds; engine-runtime always sets it, and the sweep is idle without it.
   */
  refreshHolders?(
    wallets: readonly Address[],
    now: Date,
  ): Promise<ReadonlyMap<Address, { tier: Tier; tokenAddress: Address; checkedAt: IsoTime }> | null>;
  /** The configuration, kept in memory for `TOKEN_CONFIG_CACHE_SECONDS`. */
  getConfig(): Promise<TokenConfig>;
  /** `GET /api/token`. */
  info(): Promise<TokenInfoResponse>;
  /**
   * `GET /api/token/me` with `refresh: false`, `POST /api/token/refresh` with `refresh: true`.
   * A refresh returns `too_soon` when the stored read is younger than `TOKEN_REFRESH_MIN_SECONDS`.
   */
  statusOf(address: Address, refresh: boolean): Promise<TokenMeResponse | 'too_soon'>;
  /** Admin: the tier a wallet would have now, with the configured token, flag on or off. */
  probe(wallet: Address): Promise<TokenProbeResponse>;
  /** Admin: validates the token against the chain, then writes. Refreshes the in-memory configuration. */
  saveConfig(input: TokenConfigInput, by: Address): Promise<SaveConfigResult>;
  /** One run of the second Cron Trigger. Never throws. */
  sweep(now: Date): Promise<TokenStepReport>;
}

/** What `createTokenRoutes` takes beside `ApiDeps` (docs/contracts/phase-4-token.md section 5.3: an intersection, not a field of `ApiDeps`). */
export interface TokenApiDeps {
  service: TokenService;
}
