import { DurableObject } from 'cloudflare:workers';
import type {
  Address,
  ApiApp,
  ApiConfig,
  ApiDeps,
  ApiError,
  CronStep,
  DataConfig,
  DataDeps,
  EntitlementsPort,
  MarketConfig,
  RateLimiter,
  SchedulerDeps,
  SchedulerLimits,
  SocialApiDeps,
  SocialJob,
  SocialJobDeps,
  WorkersAiLike,
} from '@prix/contracts';
import {
  addressSchema,
  CHAIN_ID,
  CRON_PLAN,
  DATA_API_DAILY_CEILING,
  DATA_CALL_PRICE_MICRO,
  DATA_MIN_PAYMENT_MICRO,
  DATA_PAGE_DAILY_CEILING,
  DATA_PAID_DAILY_CAP,
  DATA_PAYMENT_CONFIRMATIONS,
  FEED_STALE_AFTER_SECONDS,
  feedQuerySchema,
  HOUSE_MAX_OUTPUT_TOKENS,
  HOUSE_NEURONS_PER_DAY,
  HOUSE_SUMMARY_NEURONS_PER_DAY,
  idSchema,
  LEAGUE_MAX_PAGE,
  leagueQuerySchema,
  OWN_MAX_OUTPUT_TOKENS,
  REPUTATION_CRON,
  socialEnabled,
  stepsFor,
} from '@prix/contracts';
import { createMarket, UNIVERSE } from '@prix/market';
import { createDataChain } from '@prix/market/data-chain';
import { createTokenChainReader } from '@prix/market/token-balances';
import { createWalletActivityReader } from '@prix/market/wallet-activity';
import { scoring } from '@prix/reputation';
import { awards } from '@prix/reputation/awards';
import { createChainRecord } from '@prix/reputation/chain-record';
import { strategyDna } from '@prix/reputation/dna';
import { rivalryEngine } from '@prix/reputation/rivalry';
import { scoringV2 } from '@prix/reputation/v2';
import { warStandings } from '@prix/reputation/war-standings';
import { createHouseModel, createKeyOpener, createKeySealer, createOwnModel, runSchedulerStep } from '@prix/runtime';
import { runDeliverStep } from '@prix/runtime/follow/deliver';
import { runEmitStep } from '@prix/runtime/follow/emit';
import { createPushSender } from '@prix/runtime/follow/push';
import { createTelegramPort } from '@prix/runtime/follow/telegram';
import { createListingSyncJob } from '@prix/runtime/reputation/listing-job';
import {
  createCleanupJob,
  createDayPricesJob,
  createSeasonFreezeJob,
  createSeasonLifecycleJob,
  createSeasonScoreJob,
} from '@prix/runtime/reputation/season-jobs';
import { runReputationStep } from '@prix/runtime/reputation/step';
import {
  createManagerValueJob,
  createModelWarJob,
  createRankTapeJob,
  createRivalryMatchJob,
  createStrategyDnaJob,
  runSocialStep,
} from '@prix/runtime/social/index';
import { createTokenService } from '@prix/runtime/token/service';
import { runTokenStep } from '@prix/runtime/token/step';
import { sim } from '@prix/sim';
import { createManagerEngine } from '@prix/sim/manager';
import { isAddress, recoverMessageAddress } from 'viem';
import { createDataApp, isDataPath } from './http/data/app.ts';
import type { FeedCursorSigner } from './http/follow/feed-cursor.ts';
import { createFeedCursorSigner } from './http/follow/feed-cursor.ts';
import { createFeedReadPort } from './http/follow/index.ts';
import type { AppExtras } from './http/index.ts';
import { createApp } from './http/index.ts';
import { createAgentCreationGuard, createClaimVerifier } from './http/reputation/index.ts';
import { readSessionToken } from './http/session.ts';
import { createMarketConfig, workerRpcUrls } from './market-config.ts';
import type { RateLimitEnv } from './rate-limit.ts';
import { createRateLimiter } from './rate-limit.ts';
import { createDataStore } from './store/data.ts';
import { createFollowStore } from './store/follow.ts';
import { createD1Store } from './store/index.ts';
import { createPushStore } from './store/push.ts';
import { createReputationStore } from './store/reputation.ts';
import { createSocialStore } from './store/social.ts';
import { createTokenStore } from './store/token.ts';

/** A chain record counts Stock Tokens only (docs/CONTRACTS.md section 21, rule 6); built once. */
const chainRecord = createChainRecord(UNIVERSE);

/**
 * The `prix-api` Worker. This file is the only place that touches bindings: it builds `ApiDeps`
 * for the HTTP API and `SchedulerDeps` for the Cron Trigger, and hands each to code that knows
 * ports only. It also holds the two things that belong to the Worker and to no route: the cache
 * in front of the public reads, and the warm-up of the signature arithmetic.
 * docs/CONTRACTS.md sections 13 and 15 name every binding and variable.
 */
export interface Env extends RateLimitEnv {
  /** The clock that runs the scheduled work. Absent in a runtime without Durable Objects. */
  CLOCK?: DurableObjectNamespace<Clock>;
  /** The one D1 database. */
  DB: D1Database;
  /** Workers AI, for the house model. */
  AI: WorkersAiLike;
  /** Secret. 32 random bytes in base64. Seals and opens model keys. */
  KEY_ENCRYPTION_KEY: string;
  /** Secret. 32 random bytes in base64. Signs sign-in nonces and does nothing else. */
  NONCE_SECRET: string;
  /** Secret, optional. The keyed RPC endpoint. Without it only the public endpoint is used. */
  RPC_URL?: string;
  /** The public origin of the site, for example https://prixagent.com. */
  SITE_ORIGIN: string;
  /** Comma-separated admin wallets. */
  ADMIN_ADDRESSES: string;
  /**
   * Optional. Comma-separated wallets whose agents Prix itself runs (docs/CONTRACTS.md section 17).
   * Their agents carry `house: true` in every public read, and the creation guard does not count
   * them. Addresses are public. Empty or absent: there are no house agents.
   */
  HOUSE_OWNERS?: string;
  /** The Workers AI model id of the house model. */
  HOUSE_MODEL: string;
  /** The price of the house model: neurons per million input tokens. Belongs to `HOUSE_MODEL`. */
  HOUSE_MODEL_INPUT_NEURONS: string | number;
  /** The price of the house model: neurons per million output tokens. Belongs to `HOUSE_MODEL`. */
  HOUSE_MODEL_OUTPUT_NEURONS: string | number;
  /** Optional. "on" lets contract wallets (ERC-1271, ERC-6492) claim a listing, through one RPC read. Default off. */
  LISTING_CONTRACT_WALLETS?: string;
  /** Optional secret. The Telegram bot token. Without it, notes are not delivered. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Optional secret. Telegram sends it back with every webhook call. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Optional. The bot's name without the @. */
  TELEGRAM_BOT_USERNAME?: string;
  /** Optional. The public VAPID key for browser push: the raw point, base64url. Empty turns browser push off. */
  VAPID_PUBLIC_KEY?: string;
  /** Optional secret. The VAPID private key, PKCS8 in base64. */
  VAPID_PRIVATE_KEY?: string;
  /** Phase 5, read when the data API is mounted. "true" turns the free tier of the public API on. */
  DATA_API_ENABLED?: string;
  /** Phase 5. "true" turns paid calls on; it also needs PAYMENT_ADDRESS. */
  DATA_PAYMENTS_ENABLED?: string;
  /** Phase 5. The address that receives payments. Public. */
  PAYMENT_ADDRESS?: string;
  /** Phase 5. A lower daily ceiling of API requests. Never above 40,000. */
  DATA_API_DAILY_CEILING?: string;
  /**
   * Phase 6. "true" mounts the public social routes. Off, every public /api/social path is the
   * generic 404; the admin routes and the social jobs run either way (docs/contracts/phase-6-social.md 4.1).
   */
  SOCIAL_ENABLED?: string;
  /** Phase 6. Optional secret: the Groq key of Model Wars. Absent, no Groq model can enter a war. Never logged. */
  GROQ_API_KEY?: string;
}

/**
 * Which encryption secret seals new model keys. There is one secret today, so one version.
 * Rotating it means a second secret under a new version number, and both given to the opener.
 */
const KEY_VERSION = 1;

/** The sizes of docs/CONTRACTS.md section 2 that are not product constants: they follow from the free-plan limits. */
const MAX_DECISIONS_PER_STEP = 5;
const MAX_SKIPS_PER_STEP = 10;
const MAX_SUMMARIES_PER_STEP = 2;
const MODEL_TIMEOUT_MS = 20_000;

type LogData = Record<string, string | number | boolean | null>;

/** One structured log line. Never pass a key, a prompt, a URL with a key in it, or model output. */
function log(event: string, data: LogData = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

function logError(event: string, data: LogData = {}): void {
  console.error(JSON.stringify({ event, ...data }));
}

/**
 * What a log may say about a thrown value: its class name and nothing else. An error message can
 * quote its input, and the input can be a request body with a model key in it.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// --- warm-up ------------------------------------------------------------------------------------

/**
 * A signed message that anyone may read. It was signed once with a key that was thrown away, it
 * names no site and no nonce, and it grants nothing. It exists so that the Worker can recover one
 * address when it starts.
 */
const WARM_UP = {
  message: 'Prix warm-up. This signature is a public constant and grants nothing.',
  signature:
    '0xddf7b048a42058f70cee78b405bf1980a1b2e49d828e239b6fbd6a039aa6d1d257b0dd00c69a11a3eb86cb7ec08a38dc010525fb52683f622e8c874f44716c4d1c',
  address: '0x045cdc09c7f6fa7129ffa2c9fb7fe50176d34739',
} as const;

let warmUpState: 'pending' | 'done' | 'failed' = 'pending';

/**
 * The first signature recovery in a fresh Worker builds the curve's tables of multiples, and that
 * costs several times the 10 ms of CPU a request on the free plan may use. Start-up has its own
 * limit of one second and belongs to no request, so the tables are built here: this runs in the
 * global scope, through the same function a sign-in uses. It needs no clock, no randomness and
 * no I/O, which the global scope does not allow.
 */
async function warmUpSignatures(): Promise<void> {
  try {
    const recovered = await recoverMessageAddress({ message: WARM_UP.message, signature: WARM_UP.signature });
    warmUpState = recovered.toLowerCase() === WARM_UP.address ? 'done' : 'failed';
  } catch {
    warmUpState = 'failed';
  }
}

// Awaited, so that start-up does not end before the tables exist.
await warmUpSignatures();

// --- configuration ------------------------------------------------------------------------------

/** A binding or variable that is missing or malformed. `code` is safe to log; it holds no value. */
class ConfigError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Worker configuration: ${code}`);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function configCode(error: unknown): string {
  return error instanceof ConfigError ? error.code : errorName(error);
}

function requireText(value: string | undefined, code: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw new ConfigError(code);
  return text;
}

/**
 * `ApiConfig.siteOrigin`: a bare origin in lower case, which is what a browser sends in `Origin`
 * and what a sign-in message must name. `SITE_ORIGIN` may be written with capitals or with a
 * trailing slash. Anything more than an origin is refused: a path, a query, a fragment, a login.
 */
function readSiteOrigin(env: Env): string {
  const text = requireText(env.SITE_ORIGIN, 'site_origin_missing');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError('site_origin_invalid');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const bare =
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  const written = text.toLowerCase();
  if (
    !bare ||
    (written !== url.origin && written !== `${url.origin}/`) ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new ConfigError('site_origin_invalid');
  }
  return url.origin;
}

/**
 * A variable that lists wallets: addresses separated by commas, in any case, returned in lower
 * case. An entry that is not an address is left out, and the log says how many were, never which.
 */
function readAddressList(value: string | undefined, ignoredEvent: string): string[] {
  const entries = (typeof value === 'string' ? value : '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  const valid = entries.filter((entry) => addressSchema.safeParse(entry).success);
  if (valid.length !== entries.length) logError(ignoredEvent, { ignored: entries.length - valid.length });
  return valid;
}

function readAdminAddresses(env: Env): string[] {
  return readAddressList(env.ADMIN_ADDRESSES, 'admin_addresses_ignored');
}

/** `ApiConfig.houseOwners`, read as `ADMIN_ADDRESSES` is. A house wallet gets no right an admin has. */
function readHouseOwners(env: Env): string[] {
  return readAddressList(env.HOUSE_OWNERS, 'house_owners_ignored');
}

/** True if `text` is base64 for exactly 32 bytes. */
function isBase64Of32Bytes(text: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return false;
  try {
    return atob(text).length === 32;
  } catch {
    return false;
  }
}

/**
 * `NONCE_SECRET` signs sign-in nonces and nothing else. A short or guessable one would let
 * anyone mint nonces, so the shape is checked. It must also differ from the secret that seals
 * model keys: one leaked value must not open both doors.
 */
function readNonceSecret(env: Env): string {
  const secret = requireText(env.NONCE_SECRET, 'nonce_secret_missing');
  if (!isBase64Of32Bytes(secret)) throw new ConfigError('nonce_secret_invalid');
  if (secret === (typeof env.KEY_ENCRYPTION_KEY === 'string' ? env.KEY_ENCRYPTION_KEY.trim() : '')) {
    throw new ConfigError('nonce_secret_reused');
  }
  return secret;
}

function readApiConfig(env: Env): ApiConfig {
  return {
    siteOrigin: readSiteOrigin(env),
    adminAddresses: readAdminAddresses(env),
    houseModel: requireText(env.HOUSE_MODEL, 'house_model_missing'),
    nonceSecret: readNonceSecret(env),
    houseOwners: readHouseOwners(env),
  };
}

/** A neuron price: a positive number, written as text or as a number in the Wrangler file. */
function readNeuronPrice(value: string | number | undefined, code: string): number {
  const price =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(price) || price <= 0) throw new ConfigError(code);
  return price;
}

/**
 * docs/CONTRACTS.md sections 2 and 15. The two prices come from variables beside `HOUSE_MODEL`,
 * because they are the prices of that model and change with it.
 */
function readSchedulerLimits(env: Env): SchedulerLimits {
  return {
    maxDecisionsPerStep: MAX_DECISIONS_PER_STEP,
    maxSkipsPerStep: MAX_SKIPS_PER_STEP,
    maxSummariesPerStep: MAX_SUMMARIES_PER_STEP,
    houseNeuronsPerDay: HOUSE_NEURONS_PER_DAY,
    houseNeuronsPerMillionInputTokens: readNeuronPrice(
      env.HOUSE_MODEL_INPUT_NEURONS,
      'house_model_input_neurons_invalid',
    ),
    houseNeuronsPerMillionOutputTokens: readNeuronPrice(
      env.HOUSE_MODEL_OUTPUT_NEURONS,
      'house_model_output_neurons_invalid',
    ),
    summaryNeuronsPerDay: HOUSE_SUMMARY_NEURONS_PER_DAY,
    modelTimeoutMs: MODEL_TIMEOUT_MS,
    maxOutputTokens: HOUSE_MAX_OUTPUT_TOKENS,
    ownMaxOutputTokens: OWN_MAX_OUTPUT_TOKENS,
    feedStaleAfterSeconds: FEED_STALE_AFTER_SECONDS,
  };
}

/**
 * The endpoints of every chain read, in order: the keyed endpoint first, then every public one
 * that `packages/market` names (`rpcEndpoints`). A malformed `RPC_URL` is left out, and never
 * logged: it holds a key.
 */
function readRpcUrls(env: Env): string[] {
  return workerRpcUrls(env.RPC_URL, () => logError('rpc_url_ignored'));
}

/** Every endpoint that fails is logged as `market_endpoint_failed`, by its index and never its URL (D-098). */
function readMarketConfig(env: Env): MarketConfig {
  return createMarketConfig(readRpcUrls(env));
}

/** Everything the HTTP API gets. It can seal a model key. Nothing here can open one. */
function buildApiDeps(env: Env, entitlements: EntitlementsPort): ApiDeps {
  if (env.DB === undefined) throw new ConfigError('db_binding_missing');
  return {
    entitlements,
    store: createD1Store(env.DB),
    sim,
    scoring,
    sealer: createKeySealer(requireText(env.KEY_ENCRYPTION_KEY, 'key_encryption_key_missing'), KEY_VERSION),
    rateLimiter: createRateLimiter(env),
    config: readApiConfig(env),
    now: () => new Date(),
  };
}

/** Phase 5: the settings of the public data API. Paid calls need the flag and a valid address. */
function readDataConfig(env: Env, siteOrigin: string, adminAddresses: readonly string[]): DataConfig {
  const address = (env.PAYMENT_ADDRESS ?? '').trim();
  const valid = addressSchema.safeParse(address).success && isAddress(address, { strict: true });
  if (address !== '' && !valid) logError('payment_address_invalid', {});
  const ceiling = Number((env.DATA_API_DAILY_CEILING ?? '').trim());
  return {
    enabled: (env.DATA_API_ENABLED ?? '').trim().toLowerCase() === 'true',
    paymentsEnabled: (env.DATA_PAYMENTS_ENABLED ?? '').trim().toLowerCase() === 'true' && valid,
    paymentAddress: valid ? (address.toLowerCase() as Address) : null,
    siteOrigin,
    adminAddresses,
    apiDailyCeiling: Number.isInteger(ceiling) && ceiling > 0 ? Math.min(ceiling, 40_000) : DATA_API_DAILY_CEILING,
    pageDailyCeiling: DATA_PAGE_DAILY_CEILING,
    paidDailyCap: DATA_PAID_DAILY_CAP,
    callPriceMicro: DATA_CALL_PRICE_MICRO,
    minPaymentMicro: DATA_MIN_PAYMENT_MICRO,
    confirmations: DATA_PAYMENT_CONFIRMATIONS,
  };
}

/** Telegram's three settings. All three, or the bot is off. */
function readTelegram(env: Env): { config: { botUsername: string; webhookSecret: string }; token: string } | null {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const webhookSecret = (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  const botUsername = (env.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (token === '' || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) || botUsername === '') return null;
  return { config: { botUsername, webhookSecret }, token };
}

/** Browser push needs both halves of the VAPID pair. */
function readVapid(env: Env): { publicKey: string; privateKey: string } | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim();
  if (publicKey === '' || privateKey === '') return null;
  return { publicKey, privateKey };
}

/**
 * Phase 6: the Groq key of Model Wars, or null. Its value goes to the war job's `createOwnModel` and
 * nowhere else; only whether it is set reaches the HTTP side, as `groqConfigured`.
 */
function readGroqKey(env: Env): string | null {
  const key = typeof env.GROQ_API_KEY === 'string' ? env.GROQ_API_KEY.trim() : '';
  return key === '' ? null : key;
}

/**
 * Stands in for a missing AI binding in the social jobs, so that the jobs that need no model (the
 * tape, rivalries, DNA, managers) still run. A war entrant asked through it gets an error, which the
 * war job records like any failed call.
 */
const AI_MISSING: WorkersAiLike = {
  run: async () => {
    throw new ConfigError('ai_binding_missing');
  },
};

/** Everything of Phases 2 to 6 that the Worker builds once per isolate. Bindings and settings only. */
function buildWiring(env: Env) {
  if (env.DB === undefined) throw new ConfigError('db_binding_missing');
  const rpcUrls = readRpcUrls(env);
  const pushStore = createPushStore(env.DB);
  const vapid = readVapid(env);
  const tokenService = createTokenService({
    store: createTokenStore(env.DB),
    chain: createTokenChainReader(rpcUrls),
    now: () => new Date(),
    log,
  });
  // The one entitlements port of every phase. The preview port is for tests only.
  const entitlements: EntitlementsPort = tokenService;
  const apiDeps = buildApiDeps(env, entitlements);
  // `houseOwners` sets the `house` mark of a result row, a track record and a follow (section 17.1).
  const { houseOwners } = apiDeps.config;
  const reputation = createReputationStore(env.DB, { houseOwners });
  const follow = createFollowStore(env.DB, { houseOwners });
  const verifier = createClaimVerifier({
    contractWallets: (env.LISTING_CONTRACT_WALLETS ?? 'off').trim().toLowerCase() === 'on',
    rpcUrls,
  });
  const reputationDeps = {
    ...apiDeps,
    reputation,
    entitlements,
    verifier,
    guard: createAgentCreationGuard(reputation, apiDeps.config.nonceSecret, apiDeps.config.houseOwners),
    chainId: CHAIN_ID,
  };
  const telegram = readTelegram(env);
  const followDeps = {
    ...apiDeps,
    follow,
    feed: createFeedReadPort({
      store: follow,
      entitlements,
      now: apiDeps.now,
      houseOwners: apiDeps.config.houseOwners,
    }),
    entitlements,
    awards,
    records: reputation,
    telegram: telegram === null ? null : { config: telegram.config, port: createTelegramPort(telegram.token) },
  };
  // `houseOwners` sets the same `house` mark in the data API as in the public API.
  const dataDeps: DataDeps = {
    houseOwners: apiDeps.config.houseOwners,
    store: apiDeps.store,
    data: createDataStore(env.DB),
    chain: createDataChain({ rpcUrls }),
    records: reputation,
    entitlements,
    sim,
    scoring,
    rateLimiter: apiDeps.rateLimiter,
    config: readDataConfig(env, apiDeps.config.siteOrigin, apiDeps.config.adminAddresses),
    now: () => new Date(),
  };
  // Phase 6. The HTTP side learns only whether a Groq key is set, never the key.
  const social = createSocialStore(env.DB);
  const groqApiKey = readGroqKey(env);
  const socialDeps: SocialApiDeps = {
    ...apiDeps,
    social,
    reputation,
    entitlements,
    warStandings,
    groqConfigured: groqApiKey !== null,
  };
  return {
    apiDeps,
    reputationDeps,
    followDeps,
    dataDeps,
    social,
    socialDeps,
    socialOn: socialEnabled(env.SOCIAL_ENABLED),
    groqApiKey,
    tokenService,
    reputation,
    follow,
    telegram,
    pushStore,
    vapid,
    rpcUrls,
    entitlements,
  };
}

type Wiring = ReturnType<typeof buildWiring>;
let cachedWiring: { env: Env; wiring: Wiring } | null = null;

function wiringFor(env: Env): Wiring {
  if (cachedWiring !== null && cachedWiring.env === env) return cachedWiring.wiring;
  const wiring = buildWiring(env);
  cachedWiring = { env, wiring };
  return wiring;
}

/** Everything a scheduler step gets. Only this side holds a `KeyOpener`. */
function buildSchedulerDeps(env: Env): SchedulerDeps {
  if (env.DB === undefined) throw new ConfigError('db_binding_missing');
  if (env.AI === undefined) throw new ConfigError('ai_binding_missing');
  return {
    store: createD1Store(env.DB),
    market: createMarket(readMarketConfig(env)),
    sim,
    scoring,
    houseModel: createHouseModel(env.AI, requireText(env.HOUSE_MODEL, 'house_model_missing')),
    ownModel: (key, apiKey) => createOwnModel(key, apiKey),
    keys: createKeyOpener({
      [KEY_VERSION]: requireText(env.KEY_ENCRYPTION_KEY, 'key_encryption_key_missing'),
    }),
    limits: readSchedulerLimits(env),
    log,
  };
}

/**
 * What Phase 6 hands the app: `AppExtras.social` (mounted by `createSocialRoutes`) and
 * `AppExtras.socialAdmin` (mounted by `createSocialAdminRoutes`), docs/contracts/phase-6-social.md
 * section 10. Spelled here as well, so that this file stays the same once apps/api/src/http/index.ts
 * declares them.
 */
interface SocialExtras {
  social?: SocialApiDeps;
  socialAdmin?: SocialApiDeps;
}

/** The API as one isolate holds it: the app, and the two things the cache in front of it needs. */
interface Api {
  app: ApiApp;
  rateLimiter: RateLimiter;
  siteOrigin: string;
  /** Checks a feed cursor before the cache is asked (docs/CONTRACTS.md section 20). */
  cursorSigner: FeedCursorSigner;
}

/**
 * The app is built once per isolate and reused, so a request does not pay for route setup inside
 * its 10 ms of CPU. It holds bindings and configuration only, never anything about a request.
 */
let cachedApi: { env: Env; api: Api } | null = null;

function apiFor(env: Env): Api {
  if (cachedApi !== null && cachedApi.env === env) return cachedApi.api;
  const {
    apiDeps: deps,
    reputationDeps,
    followDeps,
    tokenService,
    pushStore,
    vapid,
    socialDeps,
    socialOn,
  } = wiringFor(env);
  const extras: AppExtras & SocialExtras = {
    reputation: reputationDeps,
    follow: followDeps,
    token: { service: tokenService },
    push: { ...deps, push: pushStore, vapidPublicKey: vapid?.publicKey ?? null },
    // Phase 6 (docs/contracts/phase-6-social.md 4.1): the admin routes always, the public ones only
    // while SOCIAL_ENABLED is on. Off, every public /api/social path falls to the generic 404.
    socialAdmin: socialDeps,
    ...(socialOn ? { social: socialDeps } : {}),
  };
  const api: Api = {
    app: createApp(deps, extras),
    rateLimiter: deps.rateLimiter,
    siteOrigin: deps.config.siteOrigin,
    cursorSigner: createFeedCursorSigner(deps.config.nonceSecret),
  };
  cachedApi = { env, api };
  if (warmUpState !== 'done') logError('warm_up_failed', { state: warmUpState });
  return api;
}

/** The public data API, built once per isolate like the app above. */
let cachedDataApp: { env: Env; app: ApiApp } | null = null;

function dataAppFor(env: Env): ApiApp {
  if (cachedDataApp !== null && cachedDataApp.env === env) return cachedDataApp.app;
  const app = createDataApp(wiringFor(env).dataDeps);
  cachedDataApp = { env, app };
  return app;
}

function internalError(): Response {
  const body: ApiError = {
    error: {
      code: 'internal',
      message: 'Something went wrong on our side. Nothing was changed. Try again in a minute.',
      field: null,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function notFound(): Response {
  const body: ApiError = { error: { code: 'not_found', message: 'There is nothing at this address.', field: null } };
  return new Response(JSON.stringify(body), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// --- the cache in front of the public reads -----------------------------------------------------

/** How long a public read is served from the cache. docs/CONTRACTS.md section 15. */
const PUBLIC_READ_SECONDS = 30;
const PUBLIC_CACHE_CONTROL = `public, max-age=${PUBLIC_READ_SECONDS}`;

/**
 * The public reads that take no query. Whatever query a request adds to them is not part of the key.
 * `/api/market/prices` is the price strip of docs/CONTRACTS.md section 17.2.
 */
const PLAIN_PUBLIC_READS: ReadonlySet<string> = new Set([
  '/api/market',
  '/api/market/prices',
  '/api/seasons',
  '/api/providers',
]);
const AGENT_PATH = '/api/agents/';
/** The public reads of Phases 2 to 4. A read of one of these never depends on who asks, except the feed. */
const PHASE_PLAIN_READS: ReadonlySet<string> = new Set([
  '/api/reputation/seasons',
  '/api/reputation/listings',
  '/api/token',
]);
const PHASE_PATTERNS: readonly RegExp[] = [
  /^\/api\/reputation\/seasons\/[A-Za-z0-9_-]{1,64}\/results$/,
  /^\/api\/reputation\/agents\/[A-Za-z0-9_-]{1,64}\/record$/,
  /^\/api\/reputation\/listings\/[A-Za-z0-9_-]{1,64}$/,
  /^\/api\/seasons\/[0-9]{1,6}\/results$/,
];
const FEED_PATTERN = /^\/api\/agents\/[A-Za-z0-9_-]{1,64}\/feed$/;
/** The only query parameters a cached read of Phases 2 to 4 may carry. Any other parameter skips the cache. */
const PHASE_QUERY_PARAMS: ReadonlySet<string> = new Set(['division', 'page', 'cursor', 'limit']);

/** The cache key of a Phase 2 to 4 read: the path and its known parameters, sorted, or null. */
function phaseReadKey(request: Request, url: URL, siteOrigin: string): string | null {
  const path = url.pathname;
  const feed = FEED_PATTERN.test(path);
  if (!feed && !PHASE_PLAIN_READS.has(path) && !PHASE_PATTERNS.some((pattern) => pattern.test(path))) return null;
  // A feed is cut by the viewer's tier, so a request with the session cookie is never shared. Any
  // other Cookie header changes nothing in the answer and must not skip the cache (section 20).
  if (feed && readSessionToken(request) !== null) return null;
  // A read that takes no query is cached under its path alone, whatever a request adds.
  if (PHASE_PLAIN_READS.has(path) && path !== '/api/reputation/listings') return `${siteOrigin}${path}`;
  if (/^\/api\/(reputation\/(agents|listings)\/[^/]+(\/record)?|seasons\/[0-9]+\/results)$/.test(path)) {
    return `${siteOrigin}${path}`;
  }
  const given: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    // Unknown parameters are left out of the key; a known one that repeats or is malformed skips the cache.
    if (!PHASE_QUERY_PARAMS.has(name)) continue;
    if (!/^[A-Za-z0-9._:~-]{1,200}$/.test(value)) return null;
    if (given.some(([other]) => other === name)) return null;
    given.push([name, value]);
  }
  given.sort(([a], [b]) => (a < b ? -1 : 1));
  const query = given.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  return `${siteOrigin}${path}${query === '' ? '' : `?${query}`}`;
}
/**
 * The public reads of Phase 6 (docs/contracts/phase-6-social.md section 6), each with the query
 * parameters it takes. They read no session, so they are shared whatever the cookie. While the
 * switch is off they answer 404, and a 404 is never stored. `/api/social/me/managers` is private
 * and has no key.
 */
const SOCIAL_ID = '[A-Za-z0-9_-]{1,64}';
const SOCIAL_READS: readonly { pattern: RegExp; params: readonly string[] }[] = [
  { pattern: /^\/api\/social\/status$/, params: [] },
  { pattern: new RegExp(`^/api/social/agents/${SOCIAL_ID}(/fork-source)?$`), params: [] },
  { pattern: new RegExp(`^/api/social/families/${SOCIAL_ID}$`), params: ['page'] },
  { pattern: /^\/api\/social\/rivalries$/, params: ['division', 'page'] },
  { pattern: new RegExp(`^/api/social/rivalries/${SOCIAL_ID}$`), params: [] },
  { pattern: /^\/api\/social\/wars$/, params: ['page'] },
  { pattern: new RegExp(`^/api/social/wars/${SOCIAL_ID}$`), params: [] },
  { pattern: /^\/api\/social\/managers$/, params: ['page'] },
  { pattern: new RegExp(`^/api/social/managers/${SOCIAL_ID}$`), params: [] },
];

/**
 * The cache key of a Phase 6 read: the path and its known parameters, sorted, or null. A read that
 * takes no query is keyed by its path alone. A list read with a parameter it does not take, or one
 * that repeats or is malformed, is not looked up: the strict schema of the route answers it with 400.
 */
function socialReadKey(url: URL, siteOrigin: string): string | null {
  const path = url.pathname;
  const read = SOCIAL_READS.find(({ pattern }) => pattern.test(path));
  if (read === undefined) return null;
  if (read.params.length === 0) return `${siteOrigin}${path}`;
  const given: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (!read.params.includes(name) || given.some(([other]) => other === name)) return null;
    if (!/^[A-Za-z0-9]{1,16}$/.test(value)) return null;
    given.push([name, value]);
  }
  given.sort(([a], [b]) => (a < b ? -1 : 1));
  const query = given.map(([name, value]) => `${name}=${value}`).join('&');
  return `${siteOrigin}${path}${query === '' ? '' : `?${query}`}`;
}
const ADMIN_AGENT_PATH = '/api/admin/agents/';
const LEAGUE_FEED_PATH = '/api/feed/league';

/**
 * The cache key of the league feed (docs/CONTRACTS.md section 17): the path and its two
 * parameters, `limit` with its default filled in and then `cursor`. The feed is the same for
 * everyone, so the key is the same with a session cookie and without one.
 *
 * The query is read with the schema the route itself uses. A query that schema refuses (an
 * unknown parameter, a repeated one, a malformed cursor, a limit out of range) is not looked up:
 * the API answers it with 400, and a 400 is never stored. `GET /api/feed`, the feed of followed
 * agents, is another path and has no key at all: it is private.
 */
function leagueFeedKey(url: URL, siteOrigin: string): string | null {
  const given: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(given, name)) return null;
    given[name] = value;
  }
  const query = feedQuerySchema.safeParse(given);
  if (!query.success) return null;
  const { cursor, limit } = query.data;
  const cursorPart = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  return `${siteOrigin}${LEAGUE_FEED_PATH}?limit=${limit}${cursorPart}`;
}

/**
 * The cache key of a request, or null when the request is not one of the five public reads of
 * docs/CONTRACTS.md section 15, or would not be answered with 200.
 *
 * The key is the normalised URL: the site's origin, the exact path, and only the parameters the
 * route knows, with their defaults filled in and in one order. A query string that the route
 * ignores is left out, so adding junk to a URL does not get past the cache. A league query that
 * the shared schema refuses is not looked up at all: the API answers it, with 400.
 */
function publicReadKey(request: Request, siteOrigin: string): string | null {
  // Only the agent read and the feed of one agent read a session; they skip the cache when the
  // session cookie is present. The league feed reads none and is shared whatever the cookie.
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const path = url.pathname;
  if (PLAIN_PUBLIC_READS.has(path)) return `${siteOrigin}${path}`;
  if (path === LEAGUE_FEED_PATH) return leagueFeedKey(url, siteOrigin);
  const phase = phaseReadKey(request, url, siteOrigin);
  if (phase !== null) return phase;
  if (path.startsWith('/api/social/')) return socialReadKey(url, siteOrigin);

  if (path.startsWith(AGENT_PATH)) {
    // The agent read cuts decisions by the viewer's tier, so a request with the session cookie is
    // never shared. Any other Cookie header changes nothing in the answer and must not skip the
    // cache (docs/CONTRACTS.md section 20).
    if (readSessionToken(request) !== null) return null;
    const id = path.slice(AGENT_PATH.length);
    return idSchema.safeParse(id).success ? `${siteOrigin}${AGENT_PATH}${id}` : null;
  }

  if (path === '/api/league') {
    const given: Record<string, string> = {};
    for (const [name, value] of url.searchParams) {
      if (Object.hasOwn(given, name)) return null;
      given[name] = value;
    }
    const query = leagueQuerySchema.safeParse(given);
    if (!query.success) return null;
    const { division, page, season } = query.data;
    const seasonPart = season === undefined ? '' : `&season=${season}`;
    return `${siteOrigin}/api/league?division=${division}&page=${page}${seasonPart}`;
  }

  return null;
}

/**
 * True if an answer of the API may be stored: a 200 that the API itself marked public, with no
 * cookie in it and nothing that would make it differ per visitor.
 */
function isStorable(response: Response): boolean {
  if (response.status !== 200) return false;
  const control = (response.headers.get('cache-control') ?? '').toLowerCase();
  if (!control.includes('public') || control.includes('no-store') || control.includes('private')) return false;
  return !response.headers.has('set-cookie') && !response.headers.has('vary');
}

/** A write that changes what a league or an agent's page shows: an agent created, edited or hidden. */
function changesLeague(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  return path === '/api/agents' || path.startsWith(AGENT_PATH) || path.startsWith(ADMIN_AGENT_PATH);
}

/**
 * Drops the stored league pages after such a write, and the stored reads of the agent it names
 * (its page and its two Phase 6 reads), so that a person who has just built an agent finds it on
 * the league at once and not half a minute later. Only the cache of this location is
 * touched; anywhere else the 30 seconds run out. A wallet's writes are limited by the minute and
 * by the day, so this cannot be used to keep the cache empty.
 */
async function forgetLeague(cache: Cache, siteOrigin: string, path: string): Promise<void> {
  const keys: string[] = [];
  for (const division of ['open', 'pro']) {
    for (let page = 1; page <= LEAGUE_MAX_PAGE; page += 1) {
      keys.push(`${siteOrigin}/api/league?division=${division}&page=${page}`);
    }
  }
  const rest = path.startsWith(ADMIN_AGENT_PATH)
    ? path.slice(ADMIN_AGENT_PATH.length)
    : path.startsWith(AGENT_PATH)
      ? path.slice(AGENT_PATH.length)
      : '';
  const id = rest.split('/')[0] ?? '';
  if (idSchema.safeParse(id).success) {
    // The Phase 6 reads of the agent too, so a prompt just made private or an agent just hidden is
    // not served from here for another 30 seconds (docs/contracts/phase-6-social.md section 7,
    // security review 6, finding 5). Their keys are the paths alone, as `socialReadKey` makes them.
    keys.push(
      `${siteOrigin}${AGENT_PATH}${id}`,
      `${siteOrigin}/api/social/agents/${id}`,
      `${siteOrigin}/api/social/agents/${id}/fork-source`,
    );
  }
  await Promise.all(keys.map((key) => cache.delete(key).catch(() => false)));
}

/** The Cache API of the Worker, or null in a runtime that has none. */
function publicCache(): Cache | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

let cacheFailureLogged = false;

/** A cache that fails must never fail a request: the API answers instead. One log line per isolate. */
function cacheFailed(step: 'match' | 'put', error: unknown): void {
  if (cacheFailureLogged) return;
  cacheFailureLogged = true;
  logError('public_cache_failed', { step, error: errorName(error) });
}

/**
 * True when a feed read carries a cursor this API did not sign. Such a read answers 400 before it
 * looks in the cache (docs/CONTRACTS.md section 20), so a cursor of the right shape with an invented
 * signature never reaches a stored answer.
 */
async function hasForeignCursor(request: Request, signer: FeedCursorSigner): Promise<boolean> {
  const url = new URL(request.url);
  if (url.pathname !== LEAGUE_FEED_PATH && !FEED_PATTERN.test(url.pathname)) return false;
  for (const cursor of url.searchParams.getAll('cursor')) {
    if ((await signer.verify(cursor)) === null) return true;
  }
  return false;
}

/**
 * One request. A public read without a session cookie is looked up in the cache first.
 *
 * - A hit is answered at once and is not counted by the `read` rule: it costs no database read.
 * - A miss goes to the API, which counts it. Its answer is stored for 30 seconds if it may be.
 * - Everything else goes straight to the API and is never stored.
 */
async function serve(request: Request, api: Api, ctx: ExecutionContext): Promise<Response> {
  // Ids are base32 and symbols are [A-Z0-9.], so no route needs a percent sign. The router decodes
  // the path, which would let a spelling of a public read walk past the cache key.
  const path = new URL(request.url).pathname;
  if ((path === '/api' || path.startsWith('/api/')) && path.includes('%')) return notFound();
  const head = request.method === 'HEAD';
  const cache = publicCache();
  let key = cache === null ? null : publicReadKey(request, api.siteOrigin);
  // A feed cursor this API did not sign is never looked up: the route answers it with 400.
  if (key !== null && (await hasForeignCursor(request, api.cursorSigner))) key = null;
  if (cache === null || key === null) {
    const answer = await api.app.fetch(request);
    if (cache !== null && answer.ok && changesLeague(request.method, path)) {
      ctx.waitUntil(forgetLeague(cache, api.siteOrigin, path));
    }
    return answer;
  }

  let hit: Response | undefined;
  try {
    // Looked up by URL alone: no header of the request can turn the answer into a 304 or a 206.
    hit = await cache.match(key);
  } catch (error) {
    cacheFailed('match', error);
  }
  // A hit costs no database read, so it is not counted by the `read` rule: many people share one
  // address behind a mobile carrier, and counting what costs nothing would lock them out together.
  if (hit !== undefined) return head ? new Response(null, hit) : hit;

  const response = await api.app.fetch(request);
  if (!head && isStorable(response)) {
    try {
      const copy = new Response(response.clone().body, response);
      copy.headers.set('Cache-Control', PUBLIC_CACHE_CONTROL);
      ctx.waitUntil(cache.put(key, copy).catch((error: unknown) => cacheFailed('put', error)));
    } catch (error) {
      cacheFailed('put', error);
    }
  }
  return response;
}

/** The league step: one minute of scheduler work. It never throws. */
async function runLeagueStep(env: Env): Promise<void> {
  let deps: SchedulerDeps;
  try {
    deps = buildSchedulerDeps(env);
  } catch (error) {
    logError('scheduler_not_started', { code: configCode(error) });
    return;
  }
  try {
    const report = await runSchedulerStep(deps, new Date());
    // An idle minute is the common case and says nothing new. Leave it out of the daily log allowance.
    if (report.action !== 'idle' || report.summaries > 0) log('scheduler_step', { ...report });
  } catch (error) {
    // A step never throws by contract. If one does, record that it did, without its message.
    logError('scheduler_step_failed', { error: errorName(error) });
  }
}

/** The schedule of the league step, as a cron expression: every minute. */
const LEAGUE_CRON = '* * * * *';
/**
 * Every schedule the clock keeps: every trigger of `CRON_PLAN`. Each has an object of its own, so
 * each run has the limits of its own, as a Cron Trigger would have given it.
 */
const CLOCK_CRONS: readonly string[] = Object.keys(CRON_PLAN);

const notConfiguredLogged = new Set<string>();

/** Says once per isolate that a step has nothing to do because something is not configured. */
function notConfigured(step: string, what: string): void {
  if (notConfiguredLogged.has(step)) return;
  notConfiguredLogged.add(step);
  log('step_not_configured', { step, what });
}

/** The reputation step: the six jobs of docs/contracts/phase-2-reputation.md section 9, in order. */
async function runReputationWork(env: Env, now: Date): Promise<void> {
  const w = wiringFor(env);
  const deps = {
    store: createD1Store(env.DB),
    reputation: w.reputation,
    sim,
    scoring,
    scoringV2,
    chainRecord,
    wallet: createWalletActivityReader({ rpcUrls: w.rpcUrls }),
    entitlements: w.entitlements,
    now: () => new Date(),
  };
  const result = await runReputationStep(
    [
      createSeasonLifecycleJob(deps),
      createSeasonFreezeJob(deps),
      createDayPricesJob(deps),
      createSeasonScoreJob(deps),
      createListingSyncJob(deps),
      createCleanupJob(deps),
    ],
    now,
  );
  if (result.ran !== null) log('reputation_step', { job: result.ran, outcome: result.outcome });
}

/**
 * The social step: the five jobs of docs/contracts/phase-6-social.md section 4.2, in that order.
 * They run whatever SOCIAL_ENABLED says, so that the features have history on the day they open.
 */
async function runSocialWork(env: Env, now: Date): Promise<void> {
  const w = wiringFor(env);
  const deps: SocialJobDeps = {
    store: w.apiDeps.store,
    social: w.social,
    reputation: w.reputation,
    sim,
    scoring,
    scoringV2,
    dna: strategyDna,
    rivalry: rivalryEngine,
    manager: createManagerEngine({ sim, scoring }),
    war: {
      ai: env.AI ?? AI_MISSING,
      // The key goes to createOwnModel, which sends it to the one allowlisted Groq URL only.
      groqApiKey: w.groqApiKey,
      createHouseModel,
      createOwnModel,
    },
    now: () => new Date(),
    log,
  };
  const jobs: readonly SocialJob[] = [
    createModelWarJob(deps),
    createRankTapeJob(deps),
    createRivalryMatchJob(deps),
    createStrategyDnaJob(deps),
    createManagerValueJob(deps),
  ];
  const result = await runSocialStep(jobs, now);
  if (result.ran !== null) log('social_step', { job: result.ran, outcome: result.outcome });
}

/** Every step a clock may name: the steps of `CRON_PLAN`, and Phase 6's `social`. */
type ClockStep = CronStep | 'social';
const CLOCK_STEPS: ReadonlySet<string> = new Set<ClockStep>([
  'league',
  'reputation',
  'emit',
  'deliver',
  'token',
  'social',
]);

function isClockStep(step: string): step is ClockStep {
  return CLOCK_STEPS.has(step);
}

async function runStep(step: string, env: Env, now: Date): Promise<void> {
  // A step this Worker does not know does nothing. It never falls through to another step.
  if (!isClockStep(step)) {
    logError('step_unknown', { step });
    return;
  }
  if (step === 'league') return runLeagueStep(env);
  if (step === 'reputation') return runReputationWork(env, now);
  if (step === 'social') return runSocialWork(env, now);
  const w = wiringFor(env);
  if (step === 'emit') {
    const report = await runEmitStep({ store: w.follow, log }, now);
    if (report.action !== 'idle') log('emit_step', { ...report });
    return;
  }
  if (step === 'deliver') {
    if (w.telegram === null && w.vapid === null) return notConfigured('deliver', 'telegram_or_push');
    const report = await runDeliverStep(
      {
        store: w.follow,
        telegram: w.telegram === null ? null : (w.followDeps.telegram?.port ?? createTelegramPort(w.telegram.token)),
        push:
          w.vapid === null ? null : createPushSender({ store: w.pushStore, ...w.vapid, now: () => new Date(), log }),
        entitlements: w.entitlements,
        siteOrigin: w.apiDeps.config.siteOrigin,
        log,
      },
      now,
    );
    if (report.sent + report.dropped + report.retried + report.blocked > 0) log('deliver_step', { ...report });
    return;
  }
  if (step === 'token') {
    const report = await runTokenStep(w.tokenService, now);
    if (report.action === 'off') notConfigured('token', 'token_address');
    else if (report.action !== 'idle') log('token_step', { ...report });
  }
}

/**
 * The scheduled work of one schedule: every step `stepsFor` gives, in order. Each step has its own
 * try and catch, so one failing step stops neither the next nor the clock. It never throws.
 *
 * `plan` is `CRON_PLAN` except in a test, which passes a plan of its own to see what a schedule
 * would run; an expression the plan does not know runs the league step, as `stepsFor` says.
 */
export async function runCron(
  cron: string,
  env: Env,
  plan: Readonly<Record<string, readonly string[]>> = CRON_PLAN,
): Promise<void> {
  const now = new Date();
  const steps: readonly string[] = plan[cron] ?? stepsFor(cron);
  for (const step of steps) {
    try {
      await runStep(step, env, now);
    } catch (error) {
      logError('step_failed', { step, error: errorName(error) });
    }
  }
  // Phase 5: the daily clean-up of usage rows, once, at 03:10 UTC, in the even-minute run after both steps.
  if (cron === REPUTATION_CRON && now.getUTCHours() === 3 && now.getUTCMinutes() <= 30) {
    try {
      await createDataStore(env.DB).prune(now.toISOString().slice(0, 10));
    } catch (error) {
      logError('data_prune_failed', { error: errorName(error) });
    }
  }
}

/**
 * The minutes of the hour a cron expression names. Only the minute field is read, because every
 * schedule of Prix leaves the other four fields open. It takes a star, a star with a step, a range,
 * a range with a step, and a list of minutes.
 */
function minutesOf(cron: string): number[] {
  const field = cron.trim().split(/\s+/)[0] ?? '*';
  const minutes = new Set<number>();
  for (const part of field.split(',')) {
    const [range = '*', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    const [fromText, toText] = range === '*' ? ['0', '59'] : range.split('-');
    const from = Number(fromText);
    const to = toText === undefined ? (stepText === undefined ? from : 59) : Number(toText);
    if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(step) || step < 1) continue;
    for (let minute = Math.max(0, from); minute <= Math.min(59, to); minute += step) minutes.add(minute);
  }
  return minutes.size === 0 ? [...Array(60).keys()] : [...minutes].sort((a, b) => a - b);
}

/** The start of the next minute after `now` that the expression names, in milliseconds. */
function nextFire(cron: string, now: number): number {
  const minutes = new Set(minutesOf(cron));
  let at = Math.floor(now / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 && !minutes.has(new Date(at).getUTCMinutes()); i += 1) at += 60_000;
  return at;
}

/**
 * The clock. The free plan of Cloudflare allows five Cron Triggers for a whole account, and an
 * account can have spent them on other Workers. A Durable Object alarm needs none: it wakes the
 * object at a set time, and the object sets the next alarm before it does its work, so the clock
 * goes on whatever the work does. There is one object per schedule, named by its cron expression.
 *
 * Cloudflare runs an alarm at least once and retries a handler that throws, so the work must be
 * safe to run twice. The league step is: a tick is created once and a row is written once.
 */
export class Clock extends DurableObject<Env> {
  /** Makes sure the alarm of this schedule is set. Safe to call at any time and any number of times. */
  async start(cron: string): Promise<void> {
    if ((await this.ctx.storage.get<string>('cron')) !== cron) await this.ctx.storage.put('cron', cron);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(nextFire(cron, Date.now()));
  }

  override async alarm(): Promise<void> {
    const cron = await this.ctx.storage.get<string>('cron');
    if (cron === undefined) return;
    if (!CLOCK_CRONS.includes(cron)) {
      // A clock of another release (a rollback, a changed expression). It stops for good: no step,
      // no other clock started. Deleting the alarm inside its handler also stops a retry, on a
      // best-effort basis (Alarms API). The expression is not secret.
      log('clock_unknown', { cron });
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.setAlarm(nextFire(cron, Date.now()));
    // Keep the other clocks running: one that lost its alarm does not wait for a visitor.
    if (this.env.CLOCK !== undefined) {
      for (const other of CLOCK_CRONS) {
        if (other === cron) continue;
        try {
          await this.env.CLOCK.get(this.env.CLOCK.idFromName(other)).start(other);
        } catch (error) {
          logError('clock_not_started', { error: errorName(error) });
        }
      }
    }
    await runCron(cron, this.env);
  }
}

let clockCheckedAt = 0;

/**
 * Starts every clock that is not running. An ordinary request does this at most once in five
 * minutes for each isolate, so a clock that ever stopped is going again within minutes of the
 * next visit. The first request after a deploy starts it for the first time. The watchdog trigger
 * (`scheduled`) passes `always`, so its run is never skipped because a request checked recently.
 */
function ensureClocks(env: Env, ctx: ExecutionContext, always = false): void {
  const now = Date.now();
  if (env.CLOCK === undefined || (!always && now - clockCheckedAt < 300_000)) return;
  clockCheckedAt = now;
  for (const cron of CLOCK_CRONS) {
    const clock = env.CLOCK.get(env.CLOCK.idFromName(cron));
    ctx.waitUntil(
      clock.start(cron).catch((error: unknown) => logError('clock_not_started', { error: errorName(error) })),
    );
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    ensureClocks(env, ctx);
    if (isDataPath(new URL(request.url).pathname)) {
      try {
        return await dataAppFor(env).fetch(request);
      } catch (error) {
        logError('data_api_failed', { code: configCode(error) });
        return internalError();
      }
    }
    let api: Api;
    try {
      api = apiFor(env);
    } catch (error) {
      logError('api_not_started', { code: configCode(error) });
      return internalError();
    }
    try {
      return await serve(request, api, ctx);
    } catch (error) {
      logError('api_unhandled_error', { method: request.method, error: errorName(error) });
      return internalError();
    }
  },

  /**
   * The watchdog (security review, finding 17b): starts every clock, so the scheduled work does not
   * wait for a visitor after a night in which every clock stopped. Its trigger, once the account has
   * one to spare, is an expression outside `CRON_PLAN`, and `stepsFor` gives such an expression no
   * step, so that run starts clocks and nothing else. A `CRON_PLAN` expression still runs its steps,
   * which `wrangler dev --test-scheduled` and `pnpm stack --scheduled` use locally; it must never be a
   * trigger in production, where its clock already runs it (tests/watchdog).
   */
  async scheduled(controller, env, ctx): Promise<void> {
    ensureClocks(env, ctx, true);
    await runCron(controller.cron === '' ? LEAGUE_CRON : controller.cron, env);
  },
} satisfies ExportedHandler<Env>;
