import type { ApiDeps } from './api.ts';
import type { Entitlements, EntitlementsPort } from './entitlements.ts';
import type { RecordsReadPort } from './phase2-reputation.ts';
import type { TelegramWebhookAdminResponse, TelegramWebhookWatch } from './phase6-holders.ts';
import type { TelegramUpdateKind } from './phase6-holders2.ts';
import { fillSchema } from './portfolio.ts';
import type { Address, AgentId, Division, IsoTime, TickId, UtcDay } from './primitives.ts';
import {
  amountSchema,
  divisionSchema,
  idSchema,
  isoTimeSchema,
  signedAmountSchema,
  symbolSchema,
  tickIdSchema,
} from './primitives.ts';
import type { DecisionRow } from './ticks.ts';
import { seasonSchema } from './ticks.ts';
import { z } from './zod.ts';

/**
 * Phase 3, Follow. docs/contracts/phase-3-follow.md says what these shapes mean and what the
 * rules are. Where the two disagree, the code is the shape and the document is the rule.
 *
 * Nothing here edits a Phase 1 contract file. One Phase 1 route changes at integration: the delay on
 * the decisions of `GET /api/agents/:id` (task follow-api). There is no new error code: a wallet at
 * its 25 follows gets 409 `invalid_input` with field `follows`.
 */

// --- constants -----------------------------------------------------------------------------------

/** A wallet follows at most this many agents. It bounds the cost of the feed query. */
export const MAX_FOLLOWS_PER_WALLET = 25;
/** Items on one page of a feed. */
export const FEED_PAGE_DEFAULT = 20;
export const FEED_PAGE_MAX = 30;
/** The feed of followed agents looks back this many days and no further. */
export const FOLLOW_FEED_WINDOW_DAYS = 3;

/** A Telegram link code: 32 characters of base64url, made from 24 random bytes. */
export const LINK_CODE_LENGTH = 32;
export const LINK_CODE_TTL_SECONDS = 900;
/** Telegram allows A-Z, a-z, 0-9, underscore and hyphen in a start parameter, 64 characters at most. */
export const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** Notification work per cron run. docs/contracts/phase-3-follow.md section 5 derives them. */
export const NOTIFY_EMIT_PAIRS_PER_RUN = 100;
export const NOTIFY_SENDS_PER_RUN = 20;
export const NOTIFY_MAX_ATTEMPTS = 3;
/** A queued notice that has not been sent within this time is dropped: a late notice is noise. */
export const NOTIFY_STALE_AFTER_SECONDS = 7_200;
/** At most this many notices are queued in one UTC day, for everyone together. */
export const NOTIFY_QUEUE_PER_DAY = 3_000;
/** A notice names at most this many symbols. */
export const NOTICE_SYMBOLS_MAX = 5;

/** The cron expressions of the two follow steps, beside the scheduler's own `* * * * *`. */
export const FOLLOW_CRON_EMIT = '*/2 * * * *';
export const FOLLOW_CRON_DELIVER = '1-59/2 * * * *';

/** Rows of a season result per division. */
export const SEASON_RESULTS_TOP = 10;
/** Season results are cached this long once the season has ended. */
export const SEASON_RESULTS_CACHE_SECONDS = 3_600;
/** A feed read without a session is cached this long. */
export const FEED_CACHE_SECONDS = 30;

/** Link-preview text. Conservative limits: a preview cuts longer text, and cut text can lose the label. */
export const SHARE_TITLE_MAX = 70;
export const SHARE_DESCRIPTION_MAX = 200;

/** The last line of every notification. */
export const NOTICE_SIMULATION_LINE = 'Paper trading simulation. Not investment advice. No real orders are placed.';

/** What the bot answers in the chat. These are the only two messages it ever sends unprompted. */
export const TELEGRAM_LINKED_REPLY =
  'Linked. You will get a short note when an agent you follow changes its paper portfolio. Send /stop to unlink. Paper trading simulation. Not investment advice.';
/**
 * The linked reply of the holders round (docs/contracts/phase-6-holders.md section 7, revision 3, H2-SEC-7):
 * a link code is bearer, so the reply names the wallet the chat is now linked to, in short form, and the
 * way out. api-core sends `telegramLinkedReply(shortAddress(address))` with the address `redeemLinkCode`
 * answers, in place of TELEGRAM_LINKED_REPLY, which stays until that change is built and is then deleted.
 */
export const TELEGRAM_LINKED_REPLY_TEMPLATE =
  'Linked. This chat now gets notes for wallet {ownerShort}. If that is not your wallet, send /stop. You get a short note when an agent that wallet follows changes its paper portfolio. Paper trading simulation. Not investment advice.';
export function telegramLinkedReply(ownerShort: string): string {
  return TELEGRAM_LINKED_REPLY_TEMPLATE.replace('{ownerShort}', ownerShort);
}
export const TELEGRAM_STOPPED_REPLY = 'Unlinked. You will get no more notes from Prix here.';

/**
 * Words that no follow copy may contain: a decision is shown as a record of a simulation and is
 * never an instruction. `qa` runs every notice, share text and `follow.*` draft through this.
 * Model output (an agent's reason) is not copy and is not checked here; notifications carry no
 * model text for that reason.
 */
export const ADVICE_WORDS = /\b(buy|buying|sell|selling|should|recommend\w*|signal\w*|must|tip|guarantee\w*)\b/i;

export function containsAdviceWord(text: string): boolean {
  return ADVICE_WORDS.test(text);
}

// --- the delay -----------------------------------------------------------------------------------

/**
 * The newest `createdAt` a viewer may see, for a delay. The server computes it from
 * `EntitlementsPort.entitlementsFor(viewer)` and from nothing the client sent.
 */
export function visibleCutoff(now: Date, delaySeconds: number): IsoTime {
  return new Date(now.getTime() - Math.max(0, delaySeconds) * 1000).toISOString();
}

/** True if a row written at `createdAt` may be shown to a viewer with this delay. */
export function isVisibleAt(createdAt: IsoTime, now: Date, delaySeconds: number): boolean {
  return createdAt <= visibleCutoff(now, delaySeconds);
}

export const feedDelaySchema = z.strictObject({
  /** Zero means no delay. */
  seconds: amountSchema,
  /** False while the token does not exist or the gating flag is off: the page says "preview". */
  gatingOn: z.boolean(),
});
export type FeedDelay = z.infer<typeof feedDelaySchema>;

export function feedDelayOf(entitlements: Entitlements): FeedDelay {
  return { seconds: entitlements.feedDelaySeconds, gatingOn: entitlements.gatingOn };
}

// --- the feed ------------------------------------------------------------------------------------

/**
 * Where a feed page continues: the tick and the agent of the last item, signed by the API, as
 * `2026-10-06T15:00Z~abcdefghijkl~abcdefghijklmnop`. The signature is the first 80 bits of HMAC-SHA-256,
 * in lower-case base32, over `feedCursorBase(cursor)`, under a key the API derives from NONCE_SECRET with
 * the label "feed-cursor". The API issues only signed cursors and answers any other with 400
 * `invalid_input` (field `cursor`) before it reads anything or looks in its cache, so the cache key space
 * stays finite (security review of 2026-10-08, the newest reads, finding 3). A client passes it back unchanged.
 */
export const feedCursorSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00Z~[a-z2-7]{12}~[a-z2-7]{16}$/, 'Expected a feed cursor.');
export type FeedCursorText = z.infer<typeof feedCursorSchema>;

export interface FeedCursor {
  tickId: TickId;
  agentId: AgentId;
}

/** The signed part of a cursor: `tickId~agentId`. */
export function feedCursorBase(cursor: FeedCursor): string {
  return `${cursor.tickId}~${cursor.agentId}`;
}

/** Joins a cursor and the signature the API computed over `feedCursorBase(cursor)`. */
export function formatFeedCursor(cursor: FeedCursor, signature: string): FeedCursorText {
  return `${feedCursorBase(cursor)}~${signature}`;
}

/** Null for text that is not a cursor. The API verifies `signature` before it uses the cursor. */
export function parseFeedCursor(text: string): (FeedCursor & { signature: string }) | null {
  if (!feedCursorSchema.safeParse(text).success) return null;
  const [tickId, agentId, signature] = text.split('~');
  return tickId === undefined || agentId === undefined || signature === undefined
    ? null
    : { tickId, agentId, signature };
}

/**
 * GET /api/agents/:id/feed and GET /api/feed. The query is strict: there is no parameter for a
 * delay, so a client cannot ask for less of it. `?delay=0` is 400 `invalid_input`.
 */
export const feedQuerySchema = z.strictObject({
  cursor: feedCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(FEED_PAGE_MAX).default(FEED_PAGE_DEFAULT),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/** One decision, as a feed shows it. Only decided rows are in a feed. */
export const feedItemSchema = z.strictObject({
  agentId: idSchema,
  agentName: z.string(),
  division: divisionSchema,
  tickId: tickIdSchema,
  /** When the row was written. The delay is measured from it. */
  at: isoTimeSchema,
  reason: z.string(),
  fills: z.array(fillSchema),
  halted: z.array(symbolSchema),
  equityMicro: amountSchema,
  costMicro: amountSchema,
  /** Always true. The server sets it so that no page can show a decision without its label. */
  simulated: z.literal(true),
  /** True for an agent that Prix itself runs. The API always sends it; optional as on a league row. */
  house: z.boolean().optional(),
});
export type FeedItem = z.infer<typeof feedItemSchema>;

export const feedPageSchema = z.strictObject({
  /** Newest tick first, then agent id descending. */
  items: z.array(feedItemSchema),
  nextCursor: feedCursorSchema.nullable(),
  delay: feedDelaySchema,
});
export type FeedPage = z.infer<typeof feedPageSchema>;

/** The response of GET /api/agents/:id/feed. 404 for an unknown or hidden agent. */
export const agentFeedResponseSchema = feedPageSchema.extend({
  agent: z.strictObject({ id: idSchema, name: z.string(), division: divisionSchema }),
  /** Wallets that follow the agent. It is a count of wallets that signed in, not of people, and it scores nothing. */
  followerCount: amountSchema,
});
export type AgentFeedResponse = z.infer<typeof agentFeedResponseSchema>;

/** The response of GET /api/feed: the decisions of the agents the signed-in wallet follows. */
export const followingFeedResponseSchema = feedPageSchema;
export type FollowingFeedResponse = z.infer<typeof followingFeedResponseSchema>;

/**
 * The response of GET /api/feed/league: the newest decisions of every agent that is not hidden,
 * both divisions together. It is the one feed that is the same for everyone: it is cut by the
 * delay of a visitor who is not signed in, whoever asks, so that one stored answer serves every
 * request. A holder's view without the delay is the agent feed and the following feed.
 */
export const leagueFeedResponseSchema = feedPageSchema;
export type LeagueFeedResponse = z.infer<typeof leagueFeedResponseSchema>;

/** What a store returns for a feed row. */
export interface FeedRow {
  agentName: string;
  row: DecisionRow;
  /** The owner of the agent, so that the read side can mark a house agent. Every feed read of the store sets it. */
  owner?: Address;
}

export interface FeedStoreQuery {
  /** Only rows strictly before this cursor, in (tickId, agentId) order. Null for the first page. */
  before: FeedCursor | null;
  /** Only rows written at or before this instant: `visibleCutoff(now, delaySeconds)`. */
  notAfter: IsoTime;
  /** Rows to return. The port asks for one more than a page, to know whether there is a next page. */
  limit: number;
  /** Following feed only: no row of an earlier tick. */
  sinceTickId?: TickId;
}

export interface FeedAgent {
  id: AgentId;
  name: string;
  division: Division;
  owner: Address;
  followers: number;
}

/**
 * The read side that later phases use: the decisions of one agent or of the agents a wallet
 * follows, already cut by the delay the viewer is entitled to. The delay comes from
 * `EntitlementsPort.entitlementsFor(viewer)` and from nothing else. An agent's owner sees the
 * agent's own decisions without delay. Implemented in `apps/api/src/http/follow/feed-read.ts`.
 */
export interface FeedReadPort {
  /** Null for an unknown or hidden agent. `viewer` is null for a visitor who is not signed in. */
  agentFeed(agentId: AgentId, viewer: Address | null, query: FeedQuery): Promise<AgentFeedResponse | null>;
  followingFeed(viewer: Address, query: FeedQuery): Promise<FollowingFeedResponse>;
  /**
   * The league feed. Its delay is `entitlementsFor(null)`: no session is read, and none changes
   * the answer, because the answer is stored and served to everyone.
   */
  leagueFeed(query: FeedQuery): Promise<LeagueFeedResponse>;
}

export interface FeedReadDeps {
  store: Pick<FollowStore, 'getFeedAgent' | 'listAgentFeed' | 'listFollowFeed' | 'listLeagueFeed'>;
  entitlements: EntitlementsPort;
  now(): Date;
  /** `ApiConfig.houseOwners`: every feed item of an agent of one of these wallets says `house: true`. */
  houseOwners?: readonly string[];
}
export type CreateFeedReadPort = (deps: FeedReadDeps) => FeedReadPort;

// --- follows -------------------------------------------------------------------------------------

export const followEntrySchema = z.strictObject({
  agentId: idSchema,
  name: z.string(),
  division: divisionSchema,
  /** Whether a note is sent to the wallet's chat when the agent changes its portfolio. */
  notify: z.boolean(),
  createdAt: isoTimeSchema,
  /** True for an agent that Prix itself runs (docs/CONTRACTS.md section 17). Always sent; optional for an older API. */
  house: z.boolean().optional(),
});
export type FollowEntry = z.infer<typeof followEntrySchema>;

/** GET /api/follows */
export const followsResponseSchema = z.strictObject({
  follows: z.array(followEntrySchema),
  /** MAX_FOLLOWS_PER_WALLET, so the page can say how many are left. */
  limit: z.number().int().positive(),
});
export type FollowsResponse = z.infer<typeof followsResponseSchema>;

/** PUT /api/follows/:agentId. The same call follows and changes the note setting. */
export const putFollowInputSchema = z.strictObject({ notify: z.boolean() });
export type PutFollowInput = z.infer<typeof putFollowInputSchema>;

export const followResponseSchema = z.strictObject({ follow: followEntrySchema });
export type FollowResponse = z.infer<typeof followResponseSchema>;

// --- notifications -------------------------------------------------------------------------------

export const telegramStatusSchema = z.strictObject({
  /** False until the bot is configured. Then nothing about Telegram is offered. */
  available: z.boolean(),
  linked: z.boolean(),
  /** A linked chat can be paused without unlinking it. */
  enabled: z.boolean(),
  botUsername: z.string().nullable(),
  linkedAt: isoTimeSchema.nullable(),
  /** Whether this wallet's notes are held back by gating: a wallet with a feed delay gets none. */
  delayed: z.boolean(),
});
export type TelegramStatus = z.infer<typeof telegramStatusSchema>;

/** GET /api/notifications */
export const notificationsResponseSchema = z.strictObject({ telegram: telegramStatusSchema });
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

/** The response of POST /api/notifications/telegram/link. */
export const telegramLinkResponseSchema = z.strictObject({
  /** https://t.me/<bot>?start=<code>. Opening it and pressing Start links the chat. */
  url: z.string(),
  expiresAt: isoTimeSchema,
});
export type TelegramLinkResponse = z.infer<typeof telegramLinkResponseSchema>;

/** PATCH /api/notifications/telegram */
export const setTelegramInputSchema = z.strictObject({ enabled: z.boolean() });
export type SetTelegramInput = z.infer<typeof setTelegramInputSchema>;

export function telegramLinkUrl(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}

/**
 * The part of a Telegram update the webhook reads. Everything else in the update is dropped.
 * Only a private chat is served.
 */
export const telegramUpdateSchema = z.object({
  message: z
    .object({
      text: z.string().max(200).optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export interface TelegramConfig {
  /** Without the @. */
  botUsername: string;
  /** The value Telegram sends back in X-Telegram-Bot-Api-Secret-Token. */
  webhookSecret: string;
}

export type TelegramSend =
  | { ok: true }
  /** blocked: the user stopped the bot (403). retry: 429, 5xx or no answer. rejected: any other refusal. */
  | { ok: false; reason: 'blocked' | 'retry' | 'rejected'; retryAfterSeconds: number | null };

/**
 * The phase's outgoing calls. Implemented in `packages/runtime/src/follow/telegram.ts`. The two webhook
 * calls are the holders round's (docs/contracts/phase-6-holders.md section 7, revision 3, HB-2): only the
 * admin route `POST /api/admin/telegram/webhook` uses them. Like `sendMessage`, neither throws, and no error
 * or log carries the URL (the bot token is in its path).
 */
export interface TelegramPort {
  /** Plain text, no parse mode. Never throws. */
  sendMessage(chatId: number, text: string): Promise<TelegramSend>;
  /**
   * Telegram's `setWebhook`; true when Telegram answered ok. Never throws. Revision 6 of the holders contract
   * (R1, HB1F-SEC-1): `allowedUpdates` is any list of `TelegramUpdateKind`, passed through as `allowed_updates`;
   * the admin route sends `TELEGRAM_ALLOWED_UPDATES` (phase6-holders2.ts) and nothing else. Revision 7
   * (HB1F2-SEC-2): the list is a non-empty tuple, because Telegram reads `allowed_updates: []` as almost every
   * update type; an empty list does not compile.
   */
  setWebhook(input: {
    url: string;
    secretToken: string;
    allowedUpdates: readonly [TelegramUpdateKind, ...TelegramUpdateKind[]];
    dropPendingUpdates: true;
  }): Promise<boolean>;
  /** Telegram's `getWebhookInfo`, reduced to the three fields the founder pastes back; null on any failure. Never throws. */
  getWebhookInfo(): Promise<TelegramWebhookAdminResponse | null>;
}

export type CreateTelegramPort = (botToken: string, fetchFn?: typeof fetch) => TelegramPort;

export interface NoticeInput {
  agentName: string;
  tickId: TickId;
  fills: readonly { symbol: string; side: 'buy' | 'sell' }[];
  /** The agent's page. */
  link: string;
}

/**
 * The text of one notification. It states facts of the simulation: which symbols the paper
 * portfolio added and which it reduced. It carries no model text, no reason and no forecast, and
 * it never uses the words of an instruction.
 */
export function formatNotice(input: NoticeInput): string {
  const symbols = (side: 'buy' | 'sell'): string => {
    const seen: string[] = [];
    for (const fill of input.fills) if (fill.side === side && !seen.includes(fill.symbol)) seen.push(fill.symbol);
    return seen.slice(0, NOTICE_SYMBOLS_MAX).join(', ');
  };
  const added = symbols('buy');
  const reduced = symbols('sell');
  const parts = [added === '' ? null : `Added: ${added}.`, reduced === '' ? null : `Reduced: ${reduced}.`].filter(
    (part): part is string => part !== null,
  );
  const when = `${input.tickId.slice(0, 10)} ${input.tickId.slice(11, 16)} UTC`;
  return [
    `${input.agentName} changed its paper portfolio in the ${when} round.`,
    ...(parts.length === 0 ? [] : [parts.join(' ')]),
    input.link,
    NOTICE_SIMULATION_LINE,
  ].join('\n');
}

// --- season results and awards -------------------------------------------------------------------

/** Computed facts about a finished season. Nothing of value goes with them. */
export const awardKindSchema = z.enum(['season_leader', 'steadiest']);
export type AwardKind = z.infer<typeof awardKindSchema>;

export const awardSchema = z.strictObject({
  kind: awardKindSchema,
  division: divisionSchema,
  agentId: idSchema,
  name: z.string(),
  seasonReturnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  /** True for an agent that Prix itself runs (docs/CONTRACTS.md section 17). Always sent; optional for an older API. */
  house: z.boolean().optional(),
});
export type Award = z.infer<typeof awardSchema>;

export const resultRowSchema = z.strictObject({
  rank: z.number().int().positive(),
  agentId: idSchema,
  name: z.string(),
  seasonReturnBps: signedAmountSchema,
  maxDrawdownBps: amountSchema,
  tradingDays: amountSchema,
  /** True for an agent that Prix itself runs (docs/CONTRACTS.md section 17). Always sent; optional for an older API. */
  house: z.boolean().optional(),
});
export type ResultRow = z.infer<typeof resultRowSchema>;

/**
 * One ranked agent of a frozen season, mapped from a `SeasonResultRow` of Phase 2 (`returnBps` is
 * `seasonReturnBps`). Ordered by rank. Only rows with a rank are candidates.
 */
export interface AwardCandidate {
  rank: number;
  agentId: AgentId;
  name: string;
  seasonReturnBps: number;
  maxDrawdownBps: number;
  tradingDays: number;
}

/** Implemented in `packages/reputation/src/awards.ts`. Pure; trusts its input; never throws. */
export interface AwardsEngine {
  /**
   * `season_leader`: the agent with rank 1. `steadiest`: among ranked agents with a season return
   * above zero, the lowest maximum drawdown, ties by higher return, then by agent id. An award
   * with no candidate is left out.
   */
  computeAwards(division: Division, candidates: readonly AwardCandidate[]): Award[];
}

/** GET /api/seasons/:number/results */
export const seasonResultsResponseSchema = z.strictObject({
  season: seasonSchema,
  /** True when the season has ended and both divisions have been ranked. Awards exist only then. */
  final: z.boolean(),
  divisions: z.array(
    z.strictObject({
      division: divisionSchema,
      rankedCount: amountSchema,
      top: z.array(resultRowSchema).max(SEASON_RESULTS_TOP),
      awards: z.array(awardSchema),
    }),
  ),
  /** Always none. A season award is a fact, not a prize. */
  prize: z.literal('none'),
});
export type SeasonResultsResponse = z.infer<typeof seasonResultsResponseSchema>;

// --- the store -----------------------------------------------------------------------------------

export interface ChatLink {
  address: Address;
  chatId: number;
  enabled: boolean;
  linkedAt: IsoTime;
}

/** Where the emitter stands. One row. docs/contracts/phase-3-follow.md section 5. */
export interface EmitState {
  /** The last tick that is fully emitted. Null before the first run. */
  doneTickId: TickId | null;
  /** The tick being emitted, and the key of the last pair queued, while it is partly done. */
  workTickId: TickId | null;
  afterAgentId: string;
  afterAddress: string;
  /** The UTC day of `queuedToday`. */
  queueDay: UtcDay;
  queuedToday: number;
}

/** A decided row with fills, and a wallet that follows its agent with notes on and a linked chat. */
export interface EmitCandidate {
  agentId: AgentId;
  address: Address;
}

export interface NoticeKey {
  address: Address;
  tickId: TickId;
  agentId: AgentId;
}

/** A queued notice that can be delivered now: the chat, the follow and the agent are all still valid. */
export interface DueNotice extends NoticeKey {
  attempts: number;
  chatId: number;
  agentName: string;
  fills: { symbol: string; side: 'buy' | 'sell' }[];
}

/**
 * Everything the phase stores, behind one interface. `platform` implements it for D1 in
 * `apps/api/src/store/follow.ts`. Every method is one D1 statement or one D1 batch.
 */
export interface FollowStore {
  // --- follows
  /**
   * Follows, or changes `notify` of an existing follow, in one statement. The limit and the two
   * refusals are decided in SQL. `agent_unavailable`: unknown or hidden agent. `own_agent`: the
   * wallet owns the agent.
   */
  putFollow(
    address: Address,
    agentId: AgentId,
    notify: boolean,
    now: IsoTime,
    maxFollows: number,
  ): Promise<'created' | 'updated' | 'follow_limit_reached' | 'agent_unavailable' | 'own_agent'>;
  /** False if the wallet did not follow the agent. Idempotent for the caller. */
  deleteFollow(address: Address, agentId: AgentId): Promise<boolean>;
  /** The wallet's follows, newest first, hidden agents left out. At most MAX_FOLLOWS_PER_WALLET rows. */
  listFollows(address: Address): Promise<FollowEntry[]>;

  // --- feed reads
  /** Null for an unknown or hidden agent. */
  getFeedAgent(agentId: AgentId): Promise<FeedAgent | null>;
  /** Decided rows of one agent, newest first. */
  listAgentFeed(agentId: AgentId, query: FeedStoreQuery): Promise<FeedRow[]>;
  /** Decided rows of the agents the wallet follows, newest first, hidden agents left out. */
  listFollowFeed(address: Address, query: FeedStoreQuery): Promise<FeedRow[]>;
  /**
   * Decided rows of every agent that is not hidden, both divisions, newest tick first and then
   * agent id descending. One read of the index `decisions_decided_by_tick`, bounded by `limit`.
   */
  listLeagueFeed(query: FeedStoreQuery): Promise<FeedRow[]>;

  // --- chat link
  /** Replaces the wallet's open link code, if any. Only the hash of the code is stored. */
  putLinkCode(address: Address, codeHash: string, expiresAt: IsoTime): Promise<void>;
  /**
   * One batch: deletes the code if it exists and has not expired, and links `chatId` to the
   * code's wallet. `chat_in_use`: the chat is linked to another wallet. `invalid`: unknown or expired.
   */
  redeemLinkCode(
    codeHash: string,
    chatId: number,
    now: IsoTime,
  ): Promise<{ result: 'linked'; address: Address } | { result: 'invalid' | 'chat_in_use' }>;
  getChat(address: Address): Promise<ChatLink | null>;
  /** False if the wallet has no linked chat. */
  setChatEnabled(address: Address, enabled: boolean): Promise<boolean>;
  /** Removes the link and the wallet's queued notices. False if there was no link. */
  deleteChat(address: Address): Promise<boolean>;
  /** The same for a chat that sent /stop or blocked the bot. */
  deleteChatById(chatId: number): Promise<boolean>;

  // --- the emitter and the outbox
  getEmitState(): Promise<EmitState>;
  latestCompleteTickId(): Promise<TickId | null>;
  /** The oldest tick with status complete whose id is greater than `tickId`. Null if none. */
  nextCompleteTickAfter(tickId: TickId): Promise<TickId | null>;
  /** Pairs after `after` in (agentId, address) order, at most `limit`. Decided rows with at least one fill only. */
  listEmitCandidates(
    tickId: TickId,
    after: { agentId: string; address: string },
    limit: number,
  ): Promise<EmitCandidate[]>;
  /** One batch: inserts the keys (a key that exists is ignored) and replaces the emit state. */
  commitEmit(state: EmitState, keys: readonly NoticeKey[], queuedAt: IsoTime): Promise<void>;
  /** Up to `limit` deliverable notices, in key order. */
  listDueNotices(limit: number): Promise<DueNotice[]>;
  /** One batch: deletes `done`, adds one attempt to `retry`, and deletes a retry that has reached `maxAttempts`. */
  finishNotices(done: readonly NoticeKey[], retry: readonly NoticeKey[], maxAttempts: number): Promise<void>;
  /** Deletes notices queued before `staleBefore` and link codes that expired before `now`. Bounded. */
  sweep(now: IsoTime, staleBefore: IsoTime, limit: number): Promise<void>;
}

export type CreateFollowStore = (db: unknown) => FollowStore;

// --- wiring --------------------------------------------------------------------------------------

/** What `createFollowRoutes` in `apps/api/src/http/follow/index.ts` needs, beside the Phase 1 deps. */
export interface FollowApiDeps extends ApiDeps {
  follow: FollowStore;
  feed: FeedReadPort;
  entitlements: EntitlementsPort;
  awards: AwardsEngine;
  /**
   * Phase 2's read side. Season results and awards are read from `season_scores` through it, so the
   * results of a season are the official ranking of its method (v1 or v2), and exist only once the
   * season is frozen (`SeasonArchiveEntry.frozenAt` is not null).
   */
  records: RecordsReadPort;
  /** Null until the bot is configured: the notification routes then answer 404. */
  telegram: { config: TelegramConfig; port: TelegramPort } | null;
  /**
   * The webhook's watch (docs/contracts/phase-6-holders.md section 7, revision 4, H3-SEC-8). While it answers
   * a time, the link routes and the status's `botUsername` answer as while `botUsername` is "", and
   * `POST /api/admin/telegram/webhook` clears it once its read-back url is TELEGRAM_WEBHOOK_URL. Absent: never moved.
   */
  webhookWatch?: TelegramWebhookWatch;
}

export interface EmitDeps {
  store: Pick<
    FollowStore,
    'getEmitState' | 'latestCompleteTickId' | 'nextCompleteTickAfter' | 'listEmitCandidates' | 'commitEmit' | 'sweep'
  >;
  log(event: string, data?: Record<string, string | number | boolean | null>): void;
}

export interface DeliverDeps {
  store: Pick<FollowStore, 'listDueNotices' | 'finishNotices' | 'deleteChatById'>;
  telegram: TelegramPort;
  /**
   * Called as `entitlementsFor(address, { cachedOnly: true })`: the step has 50 subrequests and
   * must never wait for a chain read (docs/contracts/README.md, the seam).
   */
  entitlements: EntitlementsPort;
  /** The origin of the site, for the link in a notice. */
  siteOrigin: string;
  log(event: string, data?: Record<string, string | number | boolean | null>): void;
}

export interface EmitReport {
  action: 'idle' | 'initialised' | 'queued' | 'tick_done' | 'budget_reached';
  tickId: TickId | null;
  queued: number;
}

export interface DeliverReport {
  sent: number;
  dropped: number;
  retried: number;
  blocked: number;
}

/** Called by the operator from the Cron Trigger FOLLOW_CRON_EMIT. Never throws. */
export type RunEmitStep = (deps: EmitDeps, now: Date) => Promise<EmitReport>;
/** Called by the operator from the Cron Trigger FOLLOW_CRON_DELIVER. Never throws. */
export type RunDeliverStep = (deps: DeliverDeps, now: Date) => Promise<DeliverReport>;

/** The webhook's header, and what the route answers. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
