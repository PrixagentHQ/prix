import { DurableObject } from 'cloudflare:workers';
import type {
  Address,
  ApiApp,
  ApiConfig,
  ApiDeps,
  ApiError,
  CreateLoungeSweepJob,
  CreatePollHoldingReader,
  CreatePollTallyJob,
  CreateRoomPictureSweepJob,
  CreateTelegramLoungePort,
  CronStep,
  DataConfig,
  DataDeps,
  EntitlementsPort,
  FollowApiDepsWithLounge,
  HolderPoll,
  HoldersGate,
  LoungeApiDeps,
  MarketConfig,
  PollApiDeps,
  PollTallyJobDeps,
  PollTallyOutcome,
  RateLimiter,
  RoomHoldersApiDeps,
  RoomPictureApiDeps,
  SchedulerDeps,
  SchedulerLimits,
  SocialApiDeps,
  SocialJob,
  SocialJobDeps,
  SocialJobName,
  TallyPoll,
  TapeApiDeps,
  TelegramPort,
  TelegramWebhookWatch,
  TokenService,
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
  loungeConfig,
  OWN_MAX_OUTPUT_TOKENS,
  POLL_TALLY_DELAY_LABEL,
  POLL_TALLY_JOB_OFF_WHAT,
  pollTallyDelaySeconds,
  pollTallyJobOn,
  REPUTATION_CRON,
  ROOM_PICTURE_SWEEP_JOB,
  ROOM_PICTURES_ADMIN_PATH,
  ROOM_PICTURES_PATH,
  roomDailyCap,
  roomDailyCapBesidePictures,
  roomHoldersOn,
  roomPictureDropsRead,
  roomPicturesDailyCap,
  roomPicturesEnabled,
  roomPictureViewsCap,
  SOCIAL_CRON,
  socialEnabled,
  stepsFor,
  TAPE_PATH,
  TELEGRAM_WEBHOOK_URL,
  tapeEnabled,
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
import * as runtimeRoot from '@prix/runtime';
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
import * as socialRuntime from '@prix/runtime/social/index';
import {
  createManagerValueJob,
  createModelWarJob,
  createRankTapeJob,
  createRivalryMatchJob,
  createStrategyDnaJob,
  runSocialStep,
} from '@prix/runtime/social/index';
import { createRoomPruneJob } from '@prix/runtime/social/room-prune';
import { createTokenService } from '@prix/runtime/token/service';
import { runTokenStep } from '@prix/runtime/token/step';
import { sim } from '@prix/sim';
import { createManagerEngine } from '@prix/sim/manager';
import { isAddress, recoverMessageAddress } from 'viem';
import { createDataApp, isDataPath } from './http/data/app.ts';
import { errorResponse, failures } from './http/errors.ts';
import type { FeedCursorSigner } from './http/follow/feed-cursor.ts';
import { createFeedCursorSigner } from './http/follow/feed-cursor.ts';
import { createFeedReadPort } from './http/follow/index.ts';
import type { AppExtras, LoungeRouteDeps } from './http/index.ts';
import { createApp } from './http/index.ts';
import { createAgentCreationGuard, createClaimVerifier } from './http/reputation/index.ts';
import { readSessionToken } from './http/session.ts';
import { createMarketConfig, workerRpcUrls } from './market-config.ts';
import { type PollHoldingConfig, pollHoldingFor } from './poll-holding.ts';
import type { RateLimitEnv } from './rate-limit.ts';
import { createPictureLimiter, createRateLimiter } from './rate-limit.ts';
import { createDataStore } from './store/data.ts';
import { createFollowStore } from './store/follow.ts';
import { createD1Store } from './store/index.ts';
import { createLoungeStore } from './store/lounge.ts';
import { createOwnerHoldsStore } from './store/owner-holds.ts';
import { createPollStore } from './store/polls.ts';
import { createPushStore } from './store/push.ts';
import { createReputationStore } from './store/reputation.ts';
import { createRoomStore } from './store/room.ts';
import type { RoomPictureKv } from './store/room-picture-bytes.ts';
import { createRoomPictureBytes } from './store/room-picture-bytes.ts';
import { createRoomPictureStore } from './store/room-pictures.ts';
import { createSocialStore } from './store/social.ts';
import { createTokenStore } from './store/token.ts';
import { createTelegramWebhookWatch } from './store/webhook-watch.ts';

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
  /**
   * Phase 6.3. "true", with SOCIAL_ENABLED also "true", mounts the room's public and writer routes.
   * Otherwise they are the generic 404; the admin's routes and the prune job run either way
   * (docs/contracts/phase-6-room.md sections 7 and 8).
   */
  ROOM_ENABLED?: string;
  /**
   * Phase 6.3. Messages of all wallets in one UTC day, read by `roomDailyCap`: ROOM_MESSAGES_PER_DAY_DEFAULT
   * (400) when not set or not a number, never above ROOM_MESSAGES_PER_DAY_MAX (600); "0" is a room nobody
   * but an admin writes in.
   */
  ROOM_MESSAGES_PER_DAY?: string;
  /**
   * Phase 6.4. "true", with SOCIAL_ENABLED and ROOM_ENABLED also "true", mounts the upload, the bytes and
   * the report of the room's pictures (`roomPicturesEnabled`). Otherwise they are the generic 404 and the
   * room's read answers as Phase 6.3's does. The admin's routes and the sweep job run either way
   * (docs/contracts/phase-6-pictures.md section 10).
   */
  ROOM_PICTURES_ENABLED?: string;
  /**
   * Phase 6.4. Pictures of all wallets in one UTC day, read by `roomPicturesDailyCap`: 60 when not set or
   * not a number, never above 150; "0" stops uploads and keeps serving what is there.
   */
  ROOM_PICTURES_PER_DAY?: string;
  /**
   * Phase 6.4. Pictures shown in one UTC day, all readers together, read by `roomPictureViewsCap`: 20,000
   * when not set or not a number, never above 30,000.
   */
  ROOM_PICTURE_VIEWS_PER_DAY?: string;
  /**
   * Phase 6.4. The KV namespace `prix-room-pictures`, which holds the bytes of the room's pictures and
   * nothing else. Absent until the founder has made the namespace and the binding is taken out of its comment in
   * wrangler.jsonc: every method of the bytes port then throws, and each caller does what it does when KV
   * fails (`createRoomPictureBytes`). `RATE_PICTURE`, the limiter of the bytes routes, is in `RateLimitEnv`.
   */
  ROOM_PICTURES?: RoomPictureKv;
  /**
   * Phase 6.7, the holders' poll (docs/contracts/phase-6-holders.md section 4.6): on only while it reads
   * exactly "true" (`pollsSwitchOn`). Off, the vote and the three public reads are the generic 404; the admin's
   * tally route and the `poll_tally` job run either way. The job and the admin's tally carry it as
   * `PollTallyJobDeps.pollsEnabled` (revision 8e, F3): while it is not "true" a closed poll with no voter is not
   * counted.
   */
  POLLS_ENABLED?: string;
  /**
   * Phase 6.7 (holders contract revision 8b, R8-SEC-1; revision 8c, CR8B-3): `poll_tally` is in the social
   * step's list only while this reads exactly "on" (`pollTallyJobOn`; absent counts as off). Off, only that list
   * changes: `step_not_configured` is logged with what `poll_tally_job_off`, and `PollApiDeps.tally` and the
   * admin route are unchanged. The runbook keeps (POLLS_ENABLED, POLL_TALLY_JOB) in POLL_RUNBOOK_STATES.
   */
  POLL_TALLY_JOB?: string;
  /**
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 5). "true" (`roomHoldersOn`) turns on the room's
   * Holder mark and its caps of a day by tier, with the room's own switches. Anything else: no `holder`
   * field and 30 messages a day for every wallet.
   */
  ROOM_HOLDERS?: string;
  /**
   * Phase 6.8 (section 4.1). "on", with a valid HOLDERS_LOUNGE_CHAT_ID, a valid HOLDERS_LOUNGE_INVITE_URL
   * and the bot configured, turns the holders' lounge on (`loungeConfig`). Anything else: the lounge is null
   * everywhere. None of the three is a secret.
   */
  HOLDERS_LOUNGE?: string;
  /** Phase 6.8. The Prix Community group's chat id: -100 and its digits. Empty until the founder gives it. */
  HOLDERS_LOUNGE_CHAT_ID?: string;
  /** Phase 6.8. The group's invite link that asks for approval: https://t.me/+ and its code. Empty until the founder makes it. */
  HOLDERS_LOUNGE_INVITE_URL?: string;
  /** Phase 6.8 (section 3.1). "true", with SOCIAL_ENABLED, mounts GET /api/tape. Anything else: the generic 404. */
  TAPE_ENABLED?: string;
}

/** POLLS_ENABLED: on only while it is exactly "true" (the contract's section 4.6), not trimmed, not lower-cased. */
export function pollsSwitchOn(value: string | undefined): boolean {
  return value === 'true';
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
    // Phase 6.7, B: the owner's choice of the mark, `users.show_holds` (migration 0018). The agent read and the
    // two owner-holds routes read it; a read that fails is false there (docs/contracts/phase-6-holders.md 3).
    ownerHolds: createOwnerHoldsStore(env.DB),
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

/**
 * Telegram's settings. The token and the webhook secret, or the bot is off. The username is not needed
 * (docs/contracts/phase-6-holders.md section 7, revision 3, H2-SEC-6): without it `botUsername` is "", the
 * webhook's admin route and the webhook itself work, and every link route stays closed (api-core), so the
 * webhook is set before the username opens the link route.
 */
export function readTelegram(
  env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_WEBHOOK_SECRET' | 'TELEGRAM_BOT_USERNAME'>,
): { config: { botUsername: string; webhookSecret: string }; token: string } | null {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const webhookSecret = (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  const botUsername = (env.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (token === '' || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) return null;
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

/** Phase 6.8: the name of the lounge's sweep in `socialJobNameSchema` (docs/contracts/phase-6-holders-2.md 4.6). */
const HOLDERS_LOUNGE_SWEEP_JOB: SocialJobName = 'holders_lounge_sweep';

/**
 * Phase 6.8: engine-runtime's two factories of the lounge, `createLoungeSweepJob` and
 * `createTelegramLoungePort`, read by their names from the runtime's social module
 * (`@prix/runtime/social/index`), as `createRoomPictureSweepJob` is read, and typed by the contract
 * (section 4.6). This file compiles before they land and is checked against the contract's types once they
 * have. Read at the moment they are needed, never copied at load.
 */
const holdersFactories: Pick<typeof socialRuntime, 'runSocialStep'> & {
  createLoungeSweepJob?: CreateLoungeSweepJob;
  createTelegramLoungePort?: CreateTelegramLoungePort;
} = socialRuntime;

/**
 * Both factories of the lounge, or null while either is missing: the lounge is then null everywhere. Each
 * is asked with `in` before it is read, so a module that does not export it (a test's stand-in of the
 * runtime among them, which throws on a read of a name it lacks) answers missing and never throws.
 */
function loungeFactories(): { sweep: CreateLoungeSweepJob; port: CreateTelegramLoungePort } | null {
  const sweep = 'createLoungeSweepJob' in holdersFactories ? holdersFactories.createLoungeSweepJob : undefined;
  const port = 'createTelegramLoungePort' in holdersFactories ? holdersFactories.createTelegramLoungePort : undefined;
  if (sweep === undefined || port === undefined) return null;
  return { sweep, port };
}

/**
 * Phase 6.8: the token gate as the holders' perks read it (`HoldersGate`): the token service's own
 * configuration, kept in memory by the service, never a request. On only while gating is enabled and a
 * token is set; the token's address in lower case.
 */
function holdersGateOf(tokenService: Pick<TokenService, 'getConfig'>): () => Promise<HoldersGate> {
  return async () => {
    const { enabled, tokenAddress } = await tokenService.getConfig();
    const token = tokenAddress === null ? null : tokenAddress.toLowerCase();
    return { gatingOn: enabled && token !== null, token };
  };
}

/**
 * Phase 6.8: the lounge's deps for the follow routes (docs/contracts/phase-6-holders-2.md section 4.1), or
 * null while `loungeConfig` is null, the bot is not configured, or either factory of engine-runtime is
 * missing. When HOLDERS_LOUNGE says "on" and the config is refused, `lounge_config_invalid` is logged with
 * no value: the wiring is built once per isolate, so the line is written once. The port takes the bot's
 * token and keeps it in the URL of its calls alone.
 */
function readLounge(
  env: Env,
  telegram: { token: string } | null,
  store: LoungeApiDeps['store'],
  tokenService: Pick<TokenService, 'holdingOf'>,
): LoungeRouteDeps | null {
  const config = loungeConfig({
    on: env.HOLDERS_LOUNGE,
    chatId: env.HOLDERS_LOUNGE_CHAT_ID,
    inviteUrl: env.HOLDERS_LOUNGE_INVITE_URL,
  });
  if (config === null) {
    if ((env.HOLDERS_LOUNGE ?? '').trim().toLowerCase() === 'on') log('lounge_config_invalid');
    return null;
  }
  const factories = loungeFactories();
  if (telegram === null || factories === null) return null;
  // Step 5 of section 4.4: the approval needs the time of the read the holding rests on
  // (`TokenService.holdingOf(wallet).checkedAt`). Without it no read is ever fresh and no join is approved.
  return { config, port: factories.port(telegram.token), store, holding: (address) => tokenService.holdingOf(address) };
}

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
  // Phase 6.8: the holders' lounge. Its store is built whatever the switch says, for the sweep's idle runs.
  const loungeStore = createLoungeStore(env.DB);
  const lounge = readLounge(env, telegram, loungeStore, tokenService);
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
    // Phase 6.8 (section 4.1): the join requests of the webhook and GET /api/lounge; null is off.
    lounge,
  } satisfies FollowApiDepsWithLounge;
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
  const socialOn = socialEnabled(env.SOCIAL_ENABLED);
  // Phase 6.3, the room. On only while both switches are: ROOM_ENABLED is read by the rule of
  // SOCIAL_ENABLED, exactly "true" after trimming and lower-casing (packages/contracts/src/phase6-room.ts).
  const room = createRoomStore(env.DB);
  // Phase 6.4, pictures in the room (docs/contracts/phase-6-pictures.md). On only while all three switches
  // are, each read by the one rule. The two caps of a day are variables; the constants are the contract's.
  const pictures = createRoomPictureStore(env.DB);
  // With no binding every method of the port throws: nothing is skipped in silence (section 6).
  const pictureBytes = createRoomPictureBytes(env.ROOM_PICTURES);
  const picturesEnabled = roomPicturesEnabled(env.SOCIAL_ENABLED, env.ROOM_ENABLED, env.ROOM_PICTURES_ENABLED);
  const picturesDailyCap = roomPicturesDailyCap(env.ROOM_PICTURES_PER_DAY);
  const pictureViewsCap = roomPictureViewsCap(env.ROOM_PICTURE_VIEWS_PER_DAY);
  const messagesDailyCap = roomDailyCap(env.ROOM_MESSAGES_PER_DAY);
  const holdersGate = holdersGateOf(tokenService);
  const roomDeps: RoomHoldersApiDeps = {
    ...socialDeps,
    room,
    roomEnabled: socialOn && socialEnabled(env.ROOM_ENABLED),
    // While pictures are enabled the room's cap of messages gives way, so that messages and pictures
    // together stay inside the room's rows of a day (section 13). Of a cap of 400 messages, since the
    // contract's revision 5: 394 at the defaults (60 pictures, 20,000 views), the whole 400 while the
    // day's pictures are at most 55, 294 at 150 pictures, 250 at 150 pictures and 30,000 views. While
    // pictures are not enabled, it is the room's own figure.
    roomDailyCap: picturesEnabled
      ? roomDailyCapBesidePictures(messagesDailyCap, picturesDailyCap, pictureViewsCap)
      : messagesDailyCap,
    pictures,
    bytes: pictureBytes,
    picturesEnabled,
    picturesDailyCap,
    pictureViewsCap,
    // The `picture` rule of the two bytes routes. It refuses while RATE_PICTURE is missing, as every rule does.
    pictureLimiter: createPictureLimiter(env.RATE_PICTURE),
    // The draw of the views' sample: a number from 0 up to and not including 1, the server's own.
    random: () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32,
    // The one address a message may hold: the token's own configuration, which the token routes read,
    // kept in memory by the service. Never from a request. Null while no token is configured.
    prixAddress: async (): Promise<Address | null> => {
      const { tokenAddress } = await tokenService.getConfig();
      return tokenAddress === null ? null : tokenAddress.toLowerCase();
    },
    // Who may write (the contract's section 3, revision 7): a holding of ROOM_WRITE_MIN_TOKENS whole
    // $PRIX and no tier. The holding is the token service's own read of the wallet, with the route's
    // options handed on as they are: the write asks `cachedOnly` and reads no chain, `me` reads in full.
    // Since Phase 6.8 the holding also answers the tier of the same stored row, which the caps of a day
    // read (docs/contracts/phase-6-holders-2.md section 2.2): passed through as it is, with no cast.
    holding: (address, options) => tokenService.holdingOf(address, options),
    // Phase 6.8 (section 2.1): the Holder mark and the caps by tier, only while ROOM_HOLDERS says "true".
    roomHoldersOn: roomHoldersOn(env.ROOM_HOLDERS),
    holdersGate,
  };
  // Phase 6.7, C: the holders' poll (docs/contracts/phase-6-holders.md sections 4 and 5). The store, the tally's
  // own deps (the job and the admin route take the same `tallyPoll`), and the routes' deps.
  const polls = createPollStore(env.DB);
  const { createPollHoldingReader } = runtimeFactories;
  const { createPollTallyJob, tallyPoll } = socialJobFactories;
  const pollHoldingConfig: PollHoldingConfig = async () => {
    const config = await tokenService.getConfig();
    return {
      token: config.tokenAddress,
      thresholdsPpm: config.thresholdsPpm,
      gatingOn: config.enabled && config.tokenAddress !== null,
    };
  };
  const tallyDelaySeconds = createTallyDelay(apiDeps.config.nonceSecret);
  // A new holding reader, with a new fetch meter, for each run (HB1-SEC-1): the social step calls this once an
  // invocation and the admin route once a request, so POLL_TALLY_MAX_FETCHES bounds each run on its own. Never
  // kept in this cached wiring. Both carry POLLS_ENABLED as `pollsEnabled` (revision 8e, F3): while it is not
  // "true", a closed poll with no voter is not counted.
  const pollsEnabled = pollsSwitchOn(env.POLLS_ENABLED);
  const pollJobDepsFor = (): PollTallyJobDeps | null =>
    createPollHoldingReader === undefined
      ? null
      : {
          polls,
          holding: pollHoldingFor(rpcUrls, pollHoldingConfig),
          adminAddresses: apiDeps.config.adminAddresses,
          houseOwners: apiDeps.config.houseOwners,
          tallyDelaySeconds,
          pollsEnabled,
          social,
          reputation,
          now: () => new Date(),
          log,
        };
  const pollDeps: PollApiDeps = {
    ...apiDeps,
    polls,
    entitlements,
    pollsEnabled,
    tierOnePpm: async () => (await tokenService.getConfig()).thresholdsPpm[0],
    tally: (poll: HolderPoll): Promise<PollTallyOutcome> => {
      const runDeps = pollJobDepsFor();
      if (tallyPoll === undefined || runDeps === null) {
        notConfigured('poll_tally', tallyPoll === undefined ? 'tallyPoll' : 'createPollHoldingReader');
        return Promise.resolve({ outcome: 'failed', step: 'read' });
      }
      return tallyPoll(runDeps, poll);
    },
  };
  // E (H3-SEC-8): the webhook's watch, read by the link routes and set by the watchdog at minute 13.
  const webhookWatch = createTelegramWebhookWatch(env.DB);
  const followDepsWithWatch = { ...followDeps, webhookWatch };
  return {
    polls,
    pollDeps,
    pollJobDepsFor,
    createPollTallyJob,
    webhookWatch,
    apiDeps,
    reputationDeps,
    followDeps: followDepsWithWatch,
    dataDeps,
    social,
    socialDeps,
    socialOn,
    room,
    roomDeps,
    pictures,
    pictureBytes,
    groqApiKey,
    tokenService,
    reputation,
    follow,
    telegram,
    pushStore,
    vapid,
    rpcUrls,
    entitlements,
    lounge,
    loungeStore,
    holdersGate,
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

/**
 * What Phase 6.3 hands the app: `AppExtras.room` (mounted by `createRoomRoutes`) and
 * `AppExtras.roomAdmin` (mounted by `createRoomAdminRoutes`), docs/contracts/phase-6-room.md section 8.
 * Spelled here as well, as `SocialExtras` is, so that this file stays the same once
 * apps/api/src/http/index.ts declares them.
 */
interface RoomExtras {
  room?: RoomHoldersApiDeps;
  roomAdmin?: RoomHoldersApiDeps;
}

/**
 * What Phase 6.8 hands the app: `AppExtras.tape` (mounted by `registerTapeRoutes(routes, extras.tape,
 * liveDelay)` whenever it is set), docs/contracts/phase-6-holders-2.md section 3.1. Spelled here as well,
 * as `RoomExtras` is, so that this file compiles before apps/api/src/http/index.ts declares it. The entry
 * sets it only while TAPE_ENABLED and SOCIAL_ENABLED are both on: the entry decides the switch.
 */
interface TapeExtras {
  tape?: TapeApiDeps;
}

/**
 * What Phase 6.4 hands the app: `AppExtras.roomPictures` (mounted by `createRoomPictureRoutes`: the
 * upload, the bytes and the report) and `AppExtras.roomPicturesAdmin` (mounted by
 * `createRoomPictureAdminRoutes`: the admin's bytes, its list, keep, off and on),
 * docs/contracts/phase-6-pictures.md sections 10 and 14. Spelled here as well, as `RoomExtras` is, so that
 * this file compiles before apps/api/src/http/index.ts declares them and stays the same once it does.
 * From this phase on the room's own two factories take `RoomPictureApiDeps` too: their read and `me`
 * carry pictures while `picturesEnabled` holds, and their hide and mute delete bytes whatever it says.
 */
interface RoomPictureExtras {
  roomPictures?: RoomPictureApiDeps;
  roomPicturesAdmin?: RoomPictureApiDeps;
}

/**
 * What Phase 6.7 hands the app: `AppExtras.polls` (docs/contracts/phase-6-holders.md section 4.4, revision 3,
 * HB-3), mounted by api-core's `createPollRoutes`. Spelled here as well, as `RoomExtras` is, so that this file
 * compiles before apps/api/src/http/index.ts declares it and stays the same once it does.
 */
interface PollExtras {
  polls?: PollApiDeps;
}

/**
 * The app as the entry calls it: a request and the request's own execution context. The upload of a
 * picture hands its later steps to `waitUntil` of that context, so that a client who hangs up does not
 * stop them between a count and the insert (docs/contracts/phase-6-pictures.md section 5). `ApiApp`
 * declares `fetch(request)` alone; what `createApp` answers fits this type with and without its second
 * parameter, so the entry compiles before and after apps/api/src/http/index.ts takes the context.
 */
interface EntryApp {
  fetch(request: Request, ctx?: ExecutionContext): Promise<Response>;
}

/** The API as one isolate holds it: the app, and the two things the cache in front of it needs. */
interface Api {
  app: EntryApp;
  rateLimiter: RateLimiter;
  siteOrigin: string;
  /** Checks a feed cursor before the cache is asked (docs/CONTRACTS.md section 20). */
  cursorSigner: FeedCursorSigner;
  /** True while the room's public routes are mounted: the entry's own rules for the room hold only then. */
  roomEnabled: boolean;
  /** True while the pictures' public routes are mounted: the HEAD rule of the public bytes path holds only then. */
  picturesEnabled: boolean;
  /** True while POLLS_ENABLED is on: the HEAD rule of GET /api/polls holds only then. */
  pollsEnabled: boolean;
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
    roomDeps,
    pollDeps,
    follow,
    entitlements,
  } = wiringFor(env);
  // Phase 6.8 (docs/contracts/phase-6-holders-2.md section 3.1): the tape's deps, only while TAPE_ENABLED
  // and SOCIAL_ENABLED are both on. Off, /api/tape falls to the generic 404.
  const tape: TapeApiDeps | null = socialOn && tapeEnabled(env.TAPE_ENABLED) ? { ...deps, follow, entitlements } : null;
  const extras: AppExtras & SocialExtras & RoomExtras & RoomPictureExtras & PollExtras & TapeExtras = {
    // Phase 6.7 (docs/contracts/phase-6-holders.md section 4.4, HB-3): always present. `createPollRoutes`
    // mounts the admin's tally always and the vote and the three public reads only while `pollsEnabled`.
    polls: pollDeps,
    reputation: reputationDeps,
    follow: followDeps,
    token: { service: tokenService },
    push: { ...deps, push: pushStore, vapidPublicKey: vapid?.publicKey ?? null },
    // Phase 6 (docs/contracts/phase-6-social.md 4.1): the admin routes always, the public ones only
    // while SOCIAL_ENABLED is on. Off, every public /api/social path falls to the generic 404.
    socialAdmin: socialDeps,
    ...(socialOn ? { social: socialDeps } : {}),
    // Phase 6.3 (docs/contracts/phase-6-room.md section 8): the admin's routes always, so a message can
    // be hidden and a writer muted while the room is off; the status, the read, `me` and the write only
    // while SOCIAL_ENABLED and ROOM_ENABLED are both on. Off, those four fall to the generic 404.
    roomAdmin: roomDeps,
    ...(roomDeps.roomEnabled ? { room: roomDeps } : {}),
    // Phase 6.4 (docs/contracts/phase-6-pictures.md section 10): the admin's routes always, so a reported
    // picture can be decided, a picture removed and pictures switched on or off while they are not
    // enabled; the upload, the bytes and the report only while SOCIAL_ENABLED, ROOM_ENABLED and
    // ROOM_PICTURES_ENABLED are all on. Off, those three fall to the generic 404.
    roomPicturesAdmin: roomDeps,
    ...(roomDeps.picturesEnabled ? { roomPictures: roomDeps } : {}),
    ...(tape === null ? {} : { tape }),
  };
  const api: Api = {
    app: createApp(deps, extras),
    rateLimiter: deps.rateLimiter,
    siteOrigin: deps.config.siteOrigin,
    cursorSigner: createFeedCursorSigner(deps.config.nonceSecret),
    roomEnabled: roomDeps.roomEnabled,
    picturesEnabled: roomDeps.picturesEnabled,
    pollsEnabled: pollDeps.pollsEnabled,
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
  // Phase 6.3, the room (docs/contracts/phase-6-room.md sections 6 and 8). The read takes no query and
  // has no older page, so it has one key, its path: no address can make a key of every value, and
  // simultaneous misses share one read in an isolate (`readRoomOnce`). The status is kept the same way.
  // `/api/social/room/me` and `/api/social/admin/room` match neither pattern: they read a session and
  // are never stored.
  { pattern: /^\/api\/social\/room\/status$/, params: [] },
  { pattern: /^\/api\/social\/room$/, params: [] },
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
  // Phase 6.7: GET /api/polls under its path alone, a query ignored and a session cookie changing nothing
  // (it holds no per-wallet data). Exactly this path: /api/polls/me and /api/polls/status are never stored.
  if (path === POLLS_PATH) return `${siteOrigin}${POLLS_PATH}`;
  // Phase 6.8 (docs/contracts/phase-6-holders-2.md section 3.1): the tape keeps its two answers under keys
  // of its own, made from the viewer's entitlements; this cache never stores nor serves one.
  if (path === TAPE_PATH) return null;
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

const ROOM_PATH = '/api/social/room';
const ROOM_STATUS_PATH = '/api/social/room/status';
const ROOM_ADMIN_PREFIX = '/api/social/admin/room/';

/**
 * The room's two cached reads, its read and its status (docs/contracts/phase-6-room.md section 6). While
 * the room is on, a HEAD of either is answered by `serve` and never by the app: from what this location
 * holds, or with `headNotCached` when it holds nothing or there is no cache at all. A miss by HEAD is not
 * stored, so without this rule every HEAD would run the read, and one address could spend D1's rows read
 * of a day through it. While the room is off the routes are not mounted and a HEAD is what a GET is, the
 * app's generic 404. The path is the exact one: the router matches no other spelling to these routes, and
 * a path with a percent sign is answered before this is asked.
 */
function isRoomCachedRead(path: string): boolean {
  return path === ROOM_PATH || path === ROOM_STATUS_PATH;
}

/**
 * The answer to a HEAD of a room read that nothing is cached for, and to a HEAD of the public bytes path
 * of a picture, which is never cached: 405, and the one method that reads it.
 */
function headNotCached(): Response {
  return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
}

/**
 * A write that changes what the room's read shows (docs/contracts/phase-6-room.md section 6): a message
 * written, and the admin's writes under its prefix: the three by a message's id, which hide it, mute its
 * writer or lift the mute, and from Phase 6.4 on the keep of a picture and the two of the pictures'
 * switch, which only admins make. The paths at and under `/api/social/room/pictures` are not this rule's:
 * `roomPictureDropsRead` is asked beside it, and of those only the upload that answered 201 drops the read.
 */
function changesRoom(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  return path === ROOM_PATH || path.startsWith(ROOM_ADMIN_PREFIX);
}

// --- the two bytes paths of the room's pictures --------------------------------------------------

/**
 * A path of exactly one segment under `prefix`, whatever the segment: every spelling the router hands to
 * the bytes route of that prefix. A path with a further segment or a trailing slash is not one, and a path
 * with a percent sign is answered before this is asked (docs/contracts/phase-6-pictures.md section 7, step 1).
 */
function isOneSegmentUnder(prefix: string, path: string): boolean {
  if (!path.startsWith(`${prefix}/`)) return false;
  const rest = path.slice(prefix.length + 1);
  return rest !== '' && !rest.includes('/');
}

/** The public bytes path of a picture: `/api/social/room/pictures/<one segment>`. */
function isPictureBytesPath(path: string): boolean {
  return isOneSegmentUnder(ROOM_PICTURES_PATH, path);
}

/** The admin's bytes path: `/api/social/admin/room/pictures/<one segment>`, `off` among them. */
function isAdminPictureBytesPath(path: string): boolean {
  return isOneSegmentUnder(ROOM_PICTURES_ADMIN_PATH, path);
}

/**
 * What the entry itself answers for a HEAD of a bytes path, or null when the request goes on to the app.
 * Hono answers a HEAD with the GET route, so without this a HEAD would run the gate, the views' count and
 * a KV read for an answer with no body: "a HEAD never runs them" (the contract's section 17).
 *
 * - The admin's bytes path: the generic 404, always and whatever the switches say. No page sends one.
 * - The public bytes path while pictures are enabled: 405 with `Allow: GET`.
 * - The public bytes path while they are not: null. The route is not mounted, and a HEAD is what a GET of
 *   the path is, the app's generic 404.
 *
 * Neither path has a cache key, for a GET either: `publicReadKey` answers null for both, since
 * `SOCIAL_READS` is a list of the reads that are kept and holds neither. There is no `cache.match` and no
 * `cache.put` of a picture, so no cached copy outlives a delete (the contract's section 0, rule 2).
 */
function pictureHeadAnswer(path: string, picturesEnabled: boolean): Response | null {
  // The app's own generic 404, as a HEAD carries it: its status and its headers, and no body.
  if (isAdminPictureBytesPath(path)) return new Response(null, errorResponse(failures.routeNotFound()));
  if (picturesEnabled && isPictureBytesPath(path)) return headNotCached();
  return null;
}

/**
 * Drops the room's stored read after such a write, so that a new message shows at once and a hidden one
 * is gone at once. Its key is the path alone, as `socialReadKey` makes it. No route has a handle on the
 * cache; this is the one place that drops it. Only the cache of this location is touched: anywhere else
 * a hidden message can be served until its 30 seconds run out.
 */
async function forgetRoom(cache: Cache, siteOrigin: string): Promise<void> {
  await cache.delete(`${siteOrigin}${ROOM_PATH}`).catch(() => false);
}

// --- the holders' poll's public read (docs/contracts/phase-6-holders.md section 4.4) -------------

/** The poll's one cached read. Its key is this path alone; no other path of the poll is ever stored. */
export const POLLS_PATH = '/api/polls';
const POLL_VOTE_PATTERN = /^\/api\/polls\/[^/]+\/vote$/;
const POLL_TALLY_PATTERN = /^\/api\/admin\/polls\/[^/]+\/tally$/;

/**
 * True when an answer drops the stored GET /api/polls: a vote that answered 200, and the admin's tally that
 * answered `done`. Never a refused vote, and never a tally that answered anything else.
 */
export function pollsDropRead(method: string, path: string, status: number, outcome: string | null): boolean {
  if (method !== 'POST' || status !== 200) return false;
  if (POLL_VOTE_PATTERN.test(path)) return true;
  return POLL_TALLY_PATTERN.test(path) && outcome === 'done';
}

/** The `outcome` of an admin tally's answer, read from a copy of its body, or null. Only that path is read. */
async function tallyOutcomeOf(method: string, path: string, answer: Response): Promise<string | null> {
  if (method !== 'POST' || answer.status !== 200 || !POLL_TALLY_PATTERN.test(path)) return null;
  try {
    const body = (await answer.clone().json()) as { outcome?: unknown };
    return typeof body.outcome === 'string' ? body.outcome : null;
  } catch {
    return null;
  }
}

async function forgetPolls(cache: Cache, siteOrigin: string): Promise<void> {
  await cache.delete(`${siteOrigin}${POLLS_PATH}`).catch(() => false);
}

// --- one read of the room at a time --------------------------------------------------------------

/** A read of the room that started longer ago than this no longer holds the others back. */
const ROOM_READ_MARK_MS = 5_000;
/** How long a miss waits before it asks the cache again, and how often it asks. One second in all. */
const ROOM_READ_WAIT_MS = 100;
const ROOM_READ_ASKS = 10;

/**
 * When the read of the room that is under way in this isolate started (`Date.now()`), or null when none
 * is (docs/contracts/phase-6-room.md section 6, "One read at a time"). It is a time and never a promise:
 * a request must not await another request's work, and a read whose request was cut leaves a mark that
 * simply grows old. It says nothing about any request: only that the one statement of `listNewest` is
 * probably running, so that simultaneous misses do not each run it. An isolate has one; a location that
 * runs several isolates has one read at a time in each.
 */
let roomReadStartedAt: number | null = null;

/**
 * How many writes to the room have answered ok in this isolate. A read notes the figure before it asks
 * the route and stores its answer only if the figure is still the same: a page read before a hide, a
 * mute or a new message is never stored after it.
 */
let roomWrites = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The answer to a miss that waited a second for another request's read and found nothing stored. */
function roomReadBusy(): Response {
  const body: ApiError = {
    error: { code: 'internal', message: 'The Community chat is loading. Try again in a second.', field: null },
  };
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '1' },
  });
}

/**
 * A GET of the room that missed the cache, while the room is on. Simultaneous misses do not each run the
 * read: one address could otherwise spend D1's rows read of a day with bursts at the moment the 30
 * seconds run out (security review of the build, 2026-10-11).
 *
 * - A read is under way and younger than 5 seconds: this request never runs the route. It asks the cache
 *   again every 100 ms, ten times at most, answers the hit when it is there, and otherwise answers 503
 *   with `Retry-After: 1`. Like a hit, it is not counted by the `read` rule.
 * - Otherwise this request is the read. The mark is cleared when its answer is stored, or at once when
 *   the answer may not be stored or the route throws.
 * - A write to the room that answered ok while the read was under way makes it skip its `put`, and takes
 *   out again what a `put` stored that was already on its way.
 */
async function readRoomOnce(
  request: Request,
  api: Api,
  ctx: ExecutionContext,
  cache: Cache,
  key: string,
): Promise<Response> {
  const startedAt = Date.now();
  if (roomReadStartedAt !== null && startedAt - roomReadStartedAt < ROOM_READ_MARK_MS) {
    for (let asked = 0; asked < ROOM_READ_ASKS; asked += 1) {
      await wait(ROOM_READ_WAIT_MS);
      try {
        const hit = await cache.match(key);
        if (hit !== undefined) return hit;
      } catch (error) {
        cacheFailed('match', error);
      }
    }
    return roomReadBusy();
  }

  roomReadStartedAt = startedAt;
  const writesBefore = roomWrites;
  // Only this read's own mark: one that grew old may have been replaced by a later read's.
  const clear = (): void => {
    if (roomReadStartedAt === startedAt) roomReadStartedAt = null;
  };
  let response: Response;
  try {
    response = await api.app.fetch(request, ctx);
  } catch (error) {
    clear();
    throw error;
  }
  if (!isStorable(response) || roomWrites !== writesBefore) {
    clear();
    return response;
  }
  try {
    const copy = new Response(response.clone().body, response);
    copy.headers.set('Cache-Control', PUBLIC_CACHE_CONTROL);
    ctx.waitUntil(
      cache
        .put(key, copy)
        .catch((error: unknown) => cacheFailed('put', error))
        // A write that answered while the put was on its way: its own drop may have come first.
        .then(() => (roomWrites === writesBefore ? false : cache.delete(key).catch(() => false)))
        .finally(clear),
    );
  } catch (error) {
    cacheFailed('put', error);
    clear();
  }
  return response;
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
 * - While the room is on, a HEAD of its read or of its status never reaches the API: a hit is answered
 *   with no body, anything else with 405 and `Allow: GET` (`isRoomCachedRead`).
 * - While the room is on, a GET of its read that misses beside another one's read does not reach the API
 *   either: it waits for what that read stores (`readRoomOnce`).
 * - A HEAD of a bytes path of the room's pictures never reaches the API (`pictureHeadAnswer`), and neither
 *   bytes path has a cache key: a GET of one always goes to the API and is never stored.
 * - Every call of the API is handed this request's `ctx`, at each of its three places.
 */
async function serve(request: Request, api: Api, ctx: ExecutionContext): Promise<Response> {
  // Ids are base32 and symbols are [A-Z0-9.], so no route needs a percent sign. The router decodes
  // the path, which would let a spelling of a public read walk past the cache key.
  const path = new URL(request.url).pathname;
  if ((path === '/api' || path.startsWith('/api/')) && path.includes('%')) return notFound();
  const head = request.method === 'HEAD';
  // A HEAD of a bytes path of the room's pictures never reaches the app, and nothing else is asked first.
  if (head) {
    const answered = pictureHeadAnswer(path, api.picturesEnabled);
    if (answered !== null) return answered;
  }
  const cache = publicCache();
  // While the room is on, a HEAD of its read or of its status never reaches the app. Judged before
  // anything else is asked: with no cache at all there is nothing to answer it from. While the room is
  // off it is what a GET of the path is, and goes the way of every request.
  // The same rule for the holders' poll's read while POLLS_ENABLED is on (holders contract section 4.4).
  const roomHead = head && ((api.roomEnabled && isRoomCachedRead(path)) || (api.pollsEnabled && path === POLLS_PATH));
  if (roomHead && cache === null) return headNotCached();
  let key = cache === null ? null : publicReadKey(request, api.siteOrigin);
  // A feed cursor this API did not sign is never looked up: the route answers it with 400.
  if (key !== null && (await hasForeignCursor(request, api.cursorSigner))) key = null;
  if (cache === null || key === null) {
    // Nothing can be cached for it here, so nothing is.
    if (roomHead) return headNotCached();
    // The request's own context goes with it: the upload of a picture hands its later steps to `waitUntil`.
    const answer = await api.app.fetch(request, ctx);
    if (cache !== null && answer.ok && changesLeague(request.method, path)) {
      ctx.waitUntil(forgetLeague(cache, api.siteOrigin, path));
    }
    // Of the paths at and under the pictures' path only the upload that answered 201 drops the read:
    // never a refused upload and never a report, whatever it answered (`roomPictureDropsRead`).
    if ((answer.ok && changesRoom(request.method, path)) || roomPictureDropsRead(request.method, path, answer.status)) {
      // Counted before the drop is sent: a read under way sees it and skips its `put` (`readRoomOnce`).
      roomWrites += 1;
      if (cache !== null) ctx.waitUntil(forgetRoom(cache, api.siteOrigin));
    }
    // Phase 6.7: a vote stored, or a tally that froze a result, drops the poll's read here at once.
    if (
      cache !== null &&
      pollsDropRead(request.method, path, answer.status, await tallyOutcomeOf(request.method, path, answer))
    ) {
      ctx.waitUntil(forgetPolls(cache, api.siteOrigin));
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
  // A miss, or a lookup that failed: the room's HEAD is answered here either way.
  if (roomHead) return headNotCached();
  // The room's read, and no other path: simultaneous misses share one read.
  if (!head && api.roomEnabled && path === ROOM_PATH) return readRoomOnce(request, api, ctx, cache, key);

  const response = await api.app.fetch(request, ctx);
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

/**
 * Says once per isolate that a step has nothing to do because something is not configured. Once for each
 * thing of a step: since Phase 6.8 the social step can miss two jobs, and each is said.
 */
function notConfigured(step: string, what: string): void {
  const key = `${step}\u0000${what}`;
  if (notConfiguredLogged.has(key)) return;
  notConfiguredLogged.add(key);
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
 * `createRoomPictureSweepJob` of packages/runtime/src/social/room-picture-sweep.ts, engine-runtime's, read
 * from where that package exports its social jobs (`createRoomPruneJob` is exported there too). It is
 * read by its name and typed by the contract, so that this file compiles before that file lands and is
 * checked against `CreateRoomPictureSweepJob` once it has: a factory of another shape is a type error here.
 */
const socialJobFactories: Pick<typeof socialRuntime, 'createRoomPruneJob'> & {
  createRoomPictureSweepJob?: CreateRoomPictureSweepJob;
  /** Phase 6.7 (holders contract revision 4, HB3-4): packages/runtime/src/social/poll-tally.ts, by name. */
  createPollTallyJob?: CreatePollTallyJob;
  tallyPoll?: TallyPoll;
} = socialRuntime;

/**
 * `createPollHoldingReader` of packages/runtime/src/token/poll-holding.ts, engine-runtime's, read by its name
 * from the runtime's root namespace and typed by the contract (holders contract revision 4, HB3-4), as
 * `createRoomPictureSweepJob` is read above. While it is undefined the tally job is not in the list and the
 * admin route's tally answers `{ outcome: 'failed', step: 'read' }`.
 */
const runtimeFactories: Pick<typeof runtimeRoot, 'createHouseModel'> & {
  createPollHoldingReader?: CreatePollHoldingReader;
} = runtimeRoot;

/** NONCE_SECRET's bytes: base64 of at least 32 bytes, as `readNonceSecret` has already checked. */
function nonceSecretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const binary = atob(secret.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * d of a poll (holders contract section 5 step 1, revision 4, H3-SEC-3): `pollTallyDelaySeconds` of
 * HMAC-SHA-256 over the poll's id, under a key derived from NONCE_SECRET with HKDF-SHA-256 (empty salt) and the
 * info POLL_TALLY_DELAY_LABEL, as apps/api/src/http/follow/feed-cursor.ts derives its key. The key is derived
 * once per isolate; d is computed on each call, kept nowhere and never logged.
 */
export function createTallyDelay(secret: string): (pollId: string) => Promise<number> {
  let key: Promise<CryptoKey> | null = null;
  const derive = async (): Promise<CryptoKey> => {
    const material = await crypto.subtle.importKey('raw', nonceSecretBytes(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(POLL_TALLY_DELAY_LABEL),
      },
      material,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
  };
  return async (pollId: string): Promise<number> => {
    if (key === null) {
      key = derive();
      // A failed derivation is not kept: the next call tries again.
      key.catch(() => {
        key = null;
      });
    }
    const mac = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(pollId));
    return pollTallyDelaySeconds(new Uint8Array(mac));
  };
}

/**
 * The social step: the five jobs of docs/contracts/phase-6-social.md section 4.2, in that order, then
 * the sweep of the pictures' owed bytes (docs/contracts/phase-6-pictures.md section 9), and after them
 * the room's prune (docs/contracts/phase-6-room.md section 7), the last of the list. The step returns
 * after the first job that did work, so the prune runs when the others were idle.
 * They run whatever SOCIAL_ENABLED, ROOM_ENABLED and ROOM_PICTURES_ENABLED say: the features have history
 * on the day they open, a room that was switched off still ages out, and bytes Prix owes a delete are
 * deleted whatever the switches say.
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
  // The sweep of the pictures' owed bytes. While the runtime exports no such job, the step says so once
  // and goes on without it: every other job, the prune among them, still runs.
  const { createRoomPictureSweepJob } = socialJobFactories;
  if (createRoomPictureSweepJob === undefined) notConfigured('social', ROOM_PICTURE_SWEEP_JOB);
  const sweep: readonly SocialJob[] =
    createRoomPictureSweepJob === undefined
      ? []
      : [
          createRoomPictureSweepJob({
            pictures: w.pictures,
            bytes: w.pictureBytes,
            social: deps.social,
            reputation: deps.reputation,
            now: deps.now,
            log: deps.log,
          }),
        ];
  // Phase 6.7, the holders' poll's tally (docs/contracts/phase-6-holders.md section 5). It runs whatever
  // POLLS_ENABLED says, which it carries as `pollsEnabled` (revision 8e, F3). While the runtime exports no such
  // job or no holding reader, the step says so once and goes on without it (revision 4, HB3-4).
  // POLL_TALLY_JOB not exactly "on" (revision 8b, R8-SEC-1; revision 8c, CR8B-3) takes it out of this list alone,
  // said once as `poll_tally_job_off`: the admin route's tally (`PollApiDeps.tally`) is unchanged.
  // One holding reader and one fetch meter for this invocation's run (HB1-SEC-1), built only while the job runs.
  const { createPollTallyJob } = w;
  const jobOn = pollTallyJobOn(env.POLL_TALLY_JOB);
  const pollJobDeps = jobOn ? w.pollJobDepsFor() : null;
  if (!jobOn) notConfigured('social', POLL_TALLY_JOB_OFF_WHAT);
  else if (createPollTallyJob === undefined) notConfigured('social', 'poll_tally');
  else if (pollJobDeps === null) notConfigured('social', 'poll_holding');
  const tally: readonly SocialJob[] =
    !jobOn || createPollTallyJob === undefined || pollJobDeps === null ? [] : [createPollTallyJob(pollJobDeps)];
  // Phase 6.8, the holders' lounge sweep (docs/contracts/phase-6-holders-2.md section 4.6). While either of
  // engine-runtime's two factories is missing the step says so once and goes on without it, and the lounge
  // is null everywhere. While the lounge is off the job is built with no config and no port, and is idle.
  const factories = loungeFactories();
  if (factories === null) notConfigured('social', HOLDERS_LOUNGE_SWEEP_JOB);
  const tokenPort: TokenService = w.tokenService;
  const loungeSweep: readonly SocialJob[] =
    factories === null
      ? []
      : [
          factories.sweep({
            lounge: w.loungeStore,
            config: w.lounge?.config ?? null,
            port: w.lounge?.port ?? null,
            holdersGate: w.holdersGate,
            // The token sweep's own read of the members' wallets (section 4.6 step 3); null while the token
            // service has none, and the job is then idle.
            refreshHolders:
              tokenPort.refreshHolders === undefined
                ? null
                : (wallets, at) => tokenPort.refreshHolders?.(wallets, at) ?? Promise.resolve(null),
            siteOrigin: w.apiDeps.config.siteOrigin,
            social: deps.social,
            reputation: deps.reputation,
            now: deps.now,
            log: deps.log,
          }),
        ];
  const jobs: readonly SocialJob[] = [
    createModelWarJob(deps),
    createRankTapeJob(deps),
    createRivalryMatchJob(deps),
    createStrategyDnaJob(deps),
    createManagerValueJob(deps),
    // Phase 6.7: `poll_tally` stands before `room_picture_sweep`, and `room_prune` stays last.
    ...tally,
    // Phase 6.8: after the jobs of Phase 6 and after the first holders wave's `poll_tally`, before
    // `room_picture_sweep`, which stays before `room_prune`.
    ...loungeSweep,
    // Phase 6.4: `room_picture_sweep` stands BEFORE `room_prune`. The step runs the first job that is not
    // idle and returns, and the prune works on most runs: behind it the sweep could wait without end. In
    // front of it the sweep holds the prune up only while bytes are owed, at most ten deletes a run, and a
    // run of it that fails lets the step go on (docs/contracts/phase-6-pictures.md section 9).
    ...sweep,
    // Last, whatever a later phase puts in front of it: `room_prune` is the final name of the step.
    createRoomPruneJob({
      room: w.room,
      social: deps.social,
      reputation: deps.reputation,
      now: deps.now,
      log: deps.log,
    }),
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
 * The clocks an alarm of `cron` starts: every other clock, but none from the social clock's alarm
 * (docs/contracts/phase-6-holders.md revision 8b, R8-SEC-2; revision 8c, R8C-3). The social step books every
 * subrequest of its invocation in docs/contracts/phase-6-holders-2.md section 8, with CLOCK_ALARM_FANOUT_CALLS
 * at 0, so its alarm makes no Durable Object call. The league, reputation, deliver and token alarms keep their
 * four start() calls, the social clock among them, so every clock is still kept running by the others.
 */
function clocksStartedBy(cron: string): readonly string[] {
  if (cron === SOCIAL_CRON) return [];
  return CLOCK_CRONS.filter((other) => other !== cron);
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
      for (const other of clocksStartedBy(cron)) {
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

/**
 * The webhook's watch (docs/contracts/phase-6-holders.md section 7, revision 4, H3-SEC-8), once an hour at the
 * watchdog's minute 13, only while `telegram` is built: `getWebhookInfo`; a url that is not TELEGRAM_WEBHOOK_URL
 * logs `telegram_webhook_moved` with no URL and marks the watch, which closes the link routes (api-core) until
 * an admin sets the webhook again. A null answer changes nothing and logs nothing. It never throws.
 */
export async function watchTelegramWebhook(
  port: Pick<TelegramPort, 'getWebhookInfo'>,
  watch: Pick<TelegramWebhookWatch, 'markMoved'>,
  now: Date,
  write: (event: string) => void,
): Promise<'moved' | 'same' | 'unknown'> {
  try {
    const info = await port.getWebhookInfo();
    if (info === null) return 'unknown';
    if (info.url === TELEGRAM_WEBHOOK_URL) return 'same';
    write('telegram_webhook_moved');
    await watch.markMoved(now.toISOString());
    return 'moved';
  } catch {
    write('telegram_webhook_watch_failed');
    return 'unknown';
  }
}

async function runWebhookWatch(env: Env): Promise<void> {
  try {
    const w = wiringFor(env);
    const telegram = w.followDeps.telegram;
    if (telegram === null) return;
    await watchTelegramWebhook(telegram.port, w.webhookWatch, new Date(), (event) => logError(event));
  } catch (error) {
    logError('telegram_webhook_watch_failed', { code: configCode(error) });
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
    // Once an hour: the first of the watchdog's two runs (minute 13 of `13,43 * * * *`).
    if (new Date(controller.scheduledTime).getUTCMinutes() < 30) {
      await runWebhookWatch(env);
    }
  },
} satisfies ExportedHandler<Env>;
