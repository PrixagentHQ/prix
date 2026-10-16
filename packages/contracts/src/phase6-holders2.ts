import type { ApiDeps } from './api.ts';
import type { Entitlements, EntitlementsPort, Tier } from './entitlements.ts';
import type { FollowApiDeps, FollowStore, TelegramSend } from './phase3-follow.ts';
import { feedDelaySchema, feedItemSchema, telegramUpdateSchema } from './phase3-follow.ts';
import { TOKEN_CACHE_SECONDS, TOKEN_STALE_GRACE_SECONDS } from './phase4-token.ts';
import type { RoomAuthorHolder, RoomHolding, RoomWriterRecord } from './phase6-room.ts';
import { ROOM_MESSAGES_PER_WALLET_PER_DAY } from './phase6-room.ts';
import type { RoomPictureApiDeps } from './phase6-room-pictures.ts';
import type { SocialJob, SocialJobDeps } from './phase6-social.ts';
import type { Address, IsoTime, UtcDay } from './primitives.ts';
import { isoTimeSchema } from './primitives.ts';
import { z } from './zod.ts';

/**
 * Phase 6.8: the holders' second wave (D-159, 2026-10-16; revision 3). Three perks of holding $PRIX, each decided on
 * the server from the token service's stored or fresh read and never from a request:
 *
 * - F. Holders in the Community chat: a quiet Holder mark on the room's public read, and more messages a day
 *   by tier.
 * - G. The holders' lounge on Telegram, which is the Prix Community group (D-163): from the switch-on a
 *   newcomer's join request is approved by @PrixagentBot for a linked wallet at tier 1 or above, members who
 *   were in the group before stay, and a daily sweep removes a member the bot let in whose wallet fell below it.
 * - H. The holders' tape: /tape, every agent's newest decisions, as they are made for a holder and past the
 *   24-hour delay for everyone else, the Prix Live hold kept for everyone.
 *
 * docs/contracts/phase-6-holders-2.md says what these mean and in which order every route and job checks.
 * Where the two disagree, this file is the shape and that file is the rule. Nothing here returns anything on
 * a holding: every perk is access to a feature. The first wave (docs/contracts/phase-6-holders.md) is a
 * separate file and nothing here reads it.
 */

// --- shared: the gate and a stored tier ------------------------------------------------------------------

/** Whether the token gate is on and which token it reads: the token service's config, never a request. */
export interface HoldersGate {
  /** False while the token does not exist or its gate is off. */
  gatingOn: boolean;
  /** The token's address, lower-case; null while there is none. */
  token: Address | null;
}

/**
 * The tier a stored `token_holders` row gives, by the rule of `entitlementsFor(address, { cachedOnly: true })`
 * (packages/runtime/src/token/service.ts): the row's tier while the gate is on, the row was read from the
 * gate's token, and its read is younger than TOKEN_STALE_GRACE_SECONDS at `now`; otherwise 0. A time that
 * does not parse, or a tier that is not an integer from 0 to 3, gives 0. It reads no chain and no memory, so
 * the room's read and the lounge's sweep can apply it to rows they joined themselves.
 */
export function storedTierOf(row: RoomAuthorHolder | null | undefined, gate: HoldersGate, now: IsoTime): Tier {
  if (row === null || row === undefined) return 0;
  if (!gate.gatingOn || gate.token === null) return 0;
  if (row.tokenAddress.toLowerCase() !== gate.token) return 0;
  const age = Date.parse(now) - Date.parse(row.checkedAt);
  if (!Number.isFinite(age) || !(age < TOKEN_STALE_GRACE_SECONDS * 1_000)) return 0;
  const tier = row.tier;
  return tier === 1 || tier === 2 || tier === 3 ? tier : 0;
}

/** The least tier of every perk of this wave: 10 ppm of the supply, 10,000 $PRIX of 1,000,000,000. */
export const HOLDERS2_MIN_TIER: Tier = 1;

// --- F. holders in the Community chat --------------------------------------------------------------------

/**
 * Worker variable of prix-api. On only when exactly "true" after trimming and lower-casing. Off, the room
 * answers as Phase 6.4 does: no `holder` field on a message and ROOM_MESSAGES_PER_WALLET_PER_DAY for every
 * wallet. It needs the room's own switches as well.
 */
export const ROOM_HOLDERS_VAR = 'ROOM_HOLDERS';
export function roomHoldersOn(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/** A wallet's messages of one UTC day by tier: 30 as before at tier 0, then 60, 90 and 120. */
export const ROOM_WALLET_DAY_CAP_BY_TIER: readonly [number, number, number, number] = [30, 60, 90, 120];

/**
 * The holding the room asks from this phase on: `RoomHolding` with the tier of the same stored row. It is
 * what `TokenService.holdingOf` answers since revision 2 (phase4-token.ts: `{ gatingOn, tokens, tier? }`),
 * so the entry passes `tokenService.holdingOf` through with no cast.
 */
export interface RoomHoldingWithTier extends RoomHolding {
  /**
   * The tier column of the row `holdingOf` took tokens from (with `cachedOnly`, the stored row within
   * TOKEN_STALE_GRACE_SECONDS; without it, the row it read again or found fresh): 0 for no row, for the
   * memory-only read under one whole token, and while the gate is off. It is not asked of `entitlementsFor`
   * (revision 3, builder L5). Never a figure of a request. engine-runtime always sets it; a holding without
   * it counts as tier 0, so every existing fake still builds.
   */
  tier?: Tier;
  /**
   * The time of the successful chain read the answer rests on; null when it rests on none. Absent counts as
   * null (revision 3, security L1: the lounge's join approves only on a read younger than TOKEN_CACHE_SECONDS).
   */
  checkedAt?: IsoTime | null;
}

/**
 * A wallet's cap of messages of the day. ROOM_MESSAGES_PER_WALLET_PER_DAY while ROOM_HOLDERS is off or
 * the gate is off; otherwise ROOM_WALLET_DAY_CAP_BY_TIER of the holding's tier, `holding.tier ?? 0`. An
 * admin takes no turn and is never asked for one.
 */
export function roomWalletDayCap(holding: Pick<RoomHoldingWithTier, 'gatingOn' | 'tier'>, holdersOn: boolean): number {
  if (!holdersOn || !holding.gatingOn) return ROOM_MESSAGES_PER_WALLET_PER_DAY;
  return ROOM_WALLET_DAY_CAP_BY_TIER[holding.tier ?? 0] ?? ROOM_MESSAGES_PER_WALLET_PER_DAY;
}

/** What is left of a wallet's day under `dayCap`, from its row as it stands. Never below 0. */
export function roomLeftToday(writer: RoomWriterRecord | null, day: UtcDay, dayCap: number): number {
  const written = writer !== null && writer.day === day ? writer.count : 0;
  return Math.max(0, dayCap - written);
}

/**
 * The Holder mark of one message: true only for a message that is not an admin's and whose author's stored
 * tier (`storedTierOf`) is HOLDERS2_MIN_TIER or above. Never a tier number, never a figure, never "verified";
 * it changes no order and no count.
 */
export function roomHolderMark(admin: boolean, authorTier: Tier): boolean {
  return !admin && authorTier >= HOLDERS2_MIN_TIER;
}

/**
 * What the room's routes take from this phase on, beside `RoomPictureApiDeps`. The two new fields are
 * optional and absent counts as off, so every harness that builds the old deps still type-checks.
 */
export interface RoomHoldersApiDeps extends RoomPictureApiDeps {
  /** `roomHoldersOn` of ROOM_HOLDERS. Absent is off. */
  roomHoldersOn?: boolean;
  /** The token service's `holdingOf`, now with the tier of the same row (`tier` optional, absent is 0). */
  holding(address: Address, options?: { cachedOnly?: boolean }): Promise<RoomHoldingWithTier>;
  /**
   * The token service's config as a gate. One read of its memory or of `token_config`. Absent: no mark on
   * any message and every cap ROOM_MESSAGES_PER_WALLET_PER_DAY (30).
   */
  holdersGate?(): Promise<HoldersGate>;
}

// --- G. the holders' lounge on Telegram ------------------------------------------------------------------

/** Worker variables of prix-api. None is a secret. */
export const HOLDERS_LOUNGE_VAR = 'HOLDERS_LOUNGE';
export const HOLDERS_LOUNGE_CHAT_ID_VAR = 'HOLDERS_LOUNGE_CHAT_ID';
export const HOLDERS_LOUNGE_INVITE_URL_VAR = 'HOLDERS_LOUNGE_INVITE_URL';

/** A supergroup's id as Telegram gives it: -100 and its digits. */
export const LOUNGE_CHAT_ID_PATTERN = /^-100\d{6,13}$/;
/** An invite link that asks for approval, as Telegram makes it: https://t.me/+ and its code. */
export const LOUNGE_INVITE_URL_PATTERN = /^https:\/\/t\.me\/\+[A-Za-z0-9_-]{8,64}$/;

export interface LoungeConfig {
  /** Negative: a supergroup. */
  chatId: number;
  inviteUrl: string;
}

/**
 * The lounge's config, or null. Null unless HOLDERS_LOUNGE is exactly "on" after trimming and lower-casing,
 * the chat id matches LOUNGE_CHAT_ID_PATTERN and is a safe integer, and the invite URL matches
 * LOUNGE_INVITE_URL_PATTERN. The entry passes null to every part of the lounge while the bot itself is not
 * configured (`FollowApiDeps.telegram` null). Null: `GET /api/lounge` is not mounted, a join request is
 * ignored (neither approved nor declined), and the sweep is idle.
 */
export function loungeConfig(vars: { on?: string; chatId?: string; inviteUrl?: string }): LoungeConfig | null {
  if ((vars.on ?? '').trim().toLowerCase() !== 'on') return null;
  const idText = (vars.chatId ?? '').trim();
  const url = (vars.inviteUrl ?? '').trim();
  if (!LOUNGE_CHAT_ID_PATTERN.test(idText) || !LOUNGE_INVITE_URL_PATTERN.test(url)) return null;
  const chatId = Number(idText);
  if (!Number.isSafeInteger(chatId)) return null;
  return { chatId, inviteUrl: url };
}

/** Members the bot keeps at most. A join beyond it is declined with `full`. It bounds the sweep's rows. */
export const LOUNGE_MEMBERS_MAX = 1_000;
/** The sweep is idle before this hour of each UTC day: the night, away from the league's rounds. */
export const LOUNGE_SWEEP_FROM_HOUR_UTC = 2;
/** Members one run of the sweep reads and judges, and removals it makes at most. */
export const LOUNGE_SWEEP_CHECKS_PER_RUN = 50;
export const LOUNGE_SWEEP_REMOVALS_PER_RUN = 5;
/**
 * The members' wallets read again before the sweep judges (revision 3, security H1: `refreshHolders`): one
 * batched chain read, one subrequest, and at most two D1 statements (the previous rows and the store).
 */
export const LOUNGE_SWEEP_REFRESH_STATEMENTS = 2;
export const LOUNGE_SWEEP_CHAIN_READS = 1;
/**
 * D1 statements of one run at its worst: the gate's config (1), the list (1), the read of the members'
 * wallets again (2), the guard's skip gate (1: the sweep calls it once, after `listDue` finds members and
 * before its first ban), a delete for each removal (5), the mark of the checked rows (1), and the guard's
 * reset of its count after a run that works (1). Telegram calls: three a removal (ban, unban, the direct
 * message). Every ban call counts against LOUNGE_SWEEP_REMOVALS_PER_RUN whatever it answers (revision 3,
 * builder M1), and a ban that does not answer ok makes no unban and no message, so the calls stay within 15.
 */
export const LOUNGE_SWEEP_STATEMENTS_MAX =
  1 + 1 + LOUNGE_SWEEP_REFRESH_STATEMENTS + 1 + LOUNGE_SWEEP_REMOVALS_PER_RUN + 1 + 1;
export const LOUNGE_SWEEP_TELEGRAM_CALLS_MAX = 3 * LOUNGE_SWEEP_REMOVALS_PER_RUN;
/** The sweep's own subrequests at most: its statements, its Telegram calls and its one chain read. */
export const LOUNGE_SWEEP_SUBREQUESTS_MAX =
  LOUNGE_SWEEP_STATEMENTS_MAX + LOUNGE_SWEEP_TELEGRAM_CALLS_MAX + LOUNGE_SWEEP_CHAIN_READS;
/**
 * `full` counts only rows whose `joined_at` is within LOUNGE_FULL_JOINED_DAYS or which the sweep marked
 * within LOUNGE_FULL_MARKED_DAYS (revision 3, security L6). LOUNGE_MEMBERS_MAX counts those rows, not
 * members of the group: a member who left by themselves keeps a row until the sweep removes it for a link
 * or a tier (builder L4).
 */
export const LOUNGE_FULL_JOINED_DAYS = 90;
export const LOUNGE_FULL_MARKED_DAYS = 7;
/** The bounds of the `full` count at `now`: rows joined at or after `joinedFrom`, or marked on or after `checkedFrom`. */
export function loungeFullCountFrom(now: IsoTime): { joinedFrom: IsoTime; checkedFrom: UtcDay } {
  const at = Date.parse(now);
  const day = 86_400_000;
  return {
    joinedFrom: new Date(at - LOUNGE_FULL_JOINED_DAYS * day).toISOString(),
    checkedFrom: new Date(at - LOUNGE_FULL_MARKED_DAYS * day).toISOString().slice(0, 10),
  };
}
/**
 * Direct messages of a decline: at most one per Telegram user per reason per UTC day, kept in the isolate's
 * memory with at most this many entries; later declines in the same day send none (revision 3, security L3).
 */
export const LOUNGE_DIRECT_MEMORY_MAX = 1_000;
/**
 * The lounge keeps one bot (revision 3, security M3, the reviewer's second wording: D-159 and D-163 name
 * @PrixagentBot as the group's admin). As an admin it receives every message of the Community group, so each
 * is one request of prix-api. The founder turns on Slow Mode of this many seconds in the group, and the switch goes
 * back off if the group's requests pass LOUNGE_GROUP_REQUESTS_DAY_MAX in a day.
 */
export const LOUNGE_SLOW_MODE_SECONDS = 10;
export const LOUNGE_GROUP_REQUESTS_DAY_MAX = 10_000;
/**
 * The social step's subrequests are shared by every job it runs in one invocation: the step runs the first
 * job that is not idle, so when the sweep runs every job ahead of it in the entry's list was idle in the same
 * run. The jobs ahead of it once both holders waves are merged: model_war, rank_tape, rivalry_match,
 * strategy_dna, manager_value and poll_tally. Their idle reads are booked at two each (the readers' figure,
 * revision 2; perf measures it). The sweep's own subrequests are its statements, its Telegram calls and its one
 * chain read (LOUNGE_SWEEP_SUBREQUESTS_MAX, revision 3).
 */
export const LOUNGE_SWEEP_JOBS_AHEAD = 6;
export const SOCIAL_IDLE_READS_PER_JOB = 2;
export const SOCIAL_STEP_SUBREQUESTS_MAX = 50;
/** D1 rows a member's row writes: its row and its two indexes. The daily mark rewrites the row and the due index. */
export const LOUNGE_JOIN_WRITE_ROWS = 3;
export const LOUNGE_MARK_WRITE_ROWS_PER_MEMBER = 3;

/** One row of `holders_lounge_members` (migration 0019): a member the bot let in. */
export interface LoungeMemberRecord {
  /** The Telegram user's id, which is also the id of its private chat with the bot. */
  telegramUserId: number;
  wallet: Address;
  joinedAt: IsoTime;
  /** The UTC day the sweep last judged it; the day it joined at first. */
  checkedDay: UtcDay;
}

/** A member as the sweep reads it, with the two joins it needs. */
export interface LoungeDueMember extends LoungeMemberRecord {
  /** `notify_chats.chat_id` of the member's wallet now; null when the wallet has no linked chat. */
  linkedChatId: number | null;
  /** The wallet's stored `token_holders` row; null when there is none. */
  holder: RoomAuthorHolder | null;
}

/**
 * `apps/api/src/store/lounge.ts` exports `createLoungeStore(db)`. Every method is one D1 statement or one
 * D1 batch. Addresses are lower-case.
 */
export interface LoungeStore {
  /** The wallet linked to a private chat (`notify_chats` by its unique `chat_id`), or null. */
  chatWallet(chatId: number): Promise<Address | null>;
  /**
   * One batch of three reads: the row of this Telegram user, the row of this wallet, and the count of the
   * rows `full` counts at `now` (`loungeFullCountFrom(now)`: `joined_at >= joinedFrom OR checked_day >=
   * checkedFrom`; revision 3, security L6).
   */
  members(
    telegramUserId: number,
    wallet: Address,
    now: IsoTime,
  ): Promise<{ byUser: LoungeMemberRecord | null; byWallet: LoungeMemberRecord | null; count: number }>;
  /**
   * Stores the member: an insert, or an update of the wallet of this Telegram user's row, with `joined_at`
   * and `checked_day` set to `now` and its day. `wallet_taken` when another Telegram user's row holds the
   * wallet (the unique index refuses it); nothing is written then.
   */
  putMember(telegramUserId: number, wallet: Address, now: IsoTime): Promise<'stored' | 'wallet_taken'>;
  /** False when there was no row. */
  deleteMember(telegramUserId: number): Promise<boolean>;
  /**
   * Members whose `checked_day` is before `day`, oldest day first and then by Telegram user id, at most
   * `limit`, each with `linkedChatId` and `holder` from two joins by key. One statement.
   */
  listDue(day: UtcDay, limit: number): Promise<LoungeDueMember[]>;
  /** Sets `checked_day` to `day` for these Telegram user ids, in one statement. An empty list writes nothing. */
  markChecked(telegramUserIds: readonly number[], day: UtcDay): Promise<void>;
}
export type CreateLoungeStore = (db: unknown) => LoungeStore;

/**
 * The part of a Telegram update the webhook reads from this phase on: `telegramUpdateSchema` with a join
 * request. Everything else is dropped. `user_chat_id` is the chat the bot may write to for the next five
 * minutes, whether or not the user started the bot.
 */
export const telegramJoinRequestSchema = z.object({
  chat: z.object({ id: z.number().int(), type: z.string() }),
  from: z.object({ id: z.number().int().positive(), is_bot: z.boolean() }),
  user_chat_id: z.number().int().positive(),
  date: z.number().int(),
});
export type TelegramJoinRequest = z.infer<typeof telegramJoinRequestSchema>;
export const telegramUpdateWithJoinSchema = telegramUpdateSchema.extend({
  chat_join_request: telegramJoinRequestSchema.optional(),
});
export type TelegramUpdateWithJoin = z.infer<typeof telegramUpdateWithJoinSchema>;

/**
 * `setWebhook`'s list from this phase on. The first holders wave's admin route
 * `POST /api/admin/telegram/webhook` (docs/contracts/phase-6-holders.md section 7) sends it, imported from
 * @prix/contracts: whichever wave merges second makes that route send this constant and the first wave's
 * case for the route's `allowed_updates` pin it (revision 3, builder H1). infra/follow/set-telegram-webhook.mjs
 * is neither changed nor run by this wave: the token and the secret are never typed on a command line. It is
 * no environment variable. HOLDERS_LOUNGE stays off until both waves have merged. Since revision 6 of
 * docs/contracts/phase-6-holders.md (R1, HB1F-SEC-1) `TelegramPort.setWebhook` takes
 * `allowedUpdates: readonly TelegramUpdateKind[]`, and the first wave's admin route sends this constant itself.
 */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'chat_join_request'] as const;
/** One kind of update Telegram may deliver to the webhook: an item of TELEGRAM_ALLOWED_UPDATES (revision 6, R1). */
export type TelegramUpdateKind = (typeof TELEGRAM_ALLOWED_UPDATES)[number];

/**
 * The lounge's calls to Telegram. Implemented in `packages/runtime/src/holders/lounge-telegram.ts` over the
 * Bot API's POST methods with a JSON body: `approveChatJoinRequest` and `declineChatJoinRequest`
 * (`chat_id`, `user_id`), `banChatMember` (`chat_id`, `user_id`, `revoke_messages` false), `unbanChatMember`
 * (`chat_id`, `user_id`, `only_if_banned` true) and `sendMessage` (`chat_id`, `text`, no parse mode). Each
 * answers as `TelegramPort.sendMessage` does and never throws. The token is in the URL of the call and in
 * nothing else: never in a log line, an error, or an answer.
 */
export interface TelegramLoungePort {
  approveJoin(chatId: number, userId: number): Promise<TelegramSend>;
  declineJoin(chatId: number, userId: number): Promise<TelegramSend>;
  ban(chatId: number, userId: number): Promise<TelegramSend>;
  unban(chatId: number, userId: number): Promise<TelegramSend>;
  /**
   * A direct message. A chat id that `loungeDirectChatOk` refuses is answered `rejected` with no call: the
   * lounge's own port never posts in a group, the Community group least of all (section 4.10: prix-buybot
   * and the daily league post do post there, through other code that holds the same token).
   */
  sendDirect(chatId: number, text: string): Promise<TelegramSend>;
}
export type CreateTelegramLoungePort = (botToken: string, fetchFn?: typeof fetch) => TelegramLoungePort;

/** A private chat's id is a user's id, a positive integer; a group's is negative. */
export function loungeDirectChatOk(chatId: number): boolean {
  return Number.isSafeInteger(chatId) && chatId > 0;
}

export const LOUNGE_JOIN_REFUSALS = ['bot', 'not_linked', 'wallet_taken', 'gate_off', 'below_tier', 'full'] as const;
export type LoungeJoinRefusal = (typeof LOUNGE_JOIN_REFUSALS)[number];

export type LoungeJoinDecision =
  /**
   * Not this lounge's request, the lounge is off, or the wallet's read could not be made fresh (revision 3,
   * security L1): no call to Telegram at all; the request waits in Telegram.
   */
  | { action: 'ignore' }
  /**
   * Send `LOUNGE_DIRECT_MESSAGES[reason]` (none for `bot`, and none when this user already had this reason's
   * message today: LOUNGE_DIRECT_MEMORY_MAX) to `user_chat_id`, then decline the request, whatever the
   * message answered: Telegram lets the bot write to `user_chat_id` only until the request is processed
   * (revision 3, builder H2).
   */
  | { action: 'decline'; reason: LoungeJoinRefusal }
  /**
   * Store the row first, then approve. When the approval answers `rejected`, delete the row again and log
   * `lounge_join_failed`; when it answers `retry` or anything else, keep the row and log `lounge_join_failed`:
   * the sweep judges it like any member (revision 3, security L2).
   */
  | { action: 'approve' };

/** The facts a join request is judged on, each read on the server in the order of the fields. */
export interface LoungeJoinFacts {
  config: LoungeConfig | null;
  request: Pick<TelegramJoinRequest, 'chat' | 'from'>;
  /** `LoungeStore.chatWallet(request.from.id)`. */
  linkedWallet: Address | null;
  /** `LoungeStore.members(request.from.id, linkedWallet, now)`; null when it was not read. */
  members: { byUser: LoungeMemberRecord | null; byWallet: LoungeMemberRecord | null; count: number } | null;
  /** `entitlementsFor(linkedWallet)` WITHOUT `cachedOnly`, so the hour before a tier rises holds; null when not read. */
  entitlements: Pick<Entitlements, 'gatingOn' | 'tier'> | null;
  /**
   * `TokenService.holdingOf(linkedWallet).checkedAt`, read right after the entitlements: the time of the
   * successful read the answer rests on; null when there is none or it was not read (revision 3, security L1).
   */
  holdingCheckedAt: IsoTime | null;
  /** The route's one reading of the clock. */
  now: IsoTime;
}

/**
 * Whether the wallet's stored row was checked within TOKEN_CACHE_SECONDS by a read that succeeded (revision 3,
 * security L1). False for a time that does not parse or lies in the future.
 */
export function loungeReadFresh(checkedAt: IsoTime | null, now: IsoTime): boolean {
  if (checkedAt === null) return false;
  const age = Date.parse(now) - Date.parse(checkedAt);
  return Number.isFinite(age) && age >= 0 && age < TOKEN_CACHE_SECONDS * 1_000;
}

/**
 * The lounge's one rule for a join request, in this order: `ignore` (the lounge is off, or the request is
 * for another chat); `bot` (the requester is a bot); `not_linked` (no wallet is linked to this Telegram
 * user's private chat); `wallet_taken` (another Telegram user's row holds the wallet: one wallet lets in one
 * account); `gate_off` (the token gate is off); `ignore` when the wallet's read could not be made fresh
 * (`loungeReadFresh`: the budget spent or the chain unreadable; neither approved nor declined); `below_tier`
 * (the wallet's tier, read fresh, is below HOLDERS2_MIN_TIER); `full` (LOUNGE_MEMBERS_MAX counted rows and
 * this user has none); otherwise `approve`. The route reads in that order and stops at the first refusal: a
 * fact it did not read is null here, and null at a step that needs it refuses as that step would with the
 * least it could mean (no members read is `full`; no entitlements read is `gate_off`).
 */
export function loungeJoinDecision(facts: LoungeJoinFacts): LoungeJoinDecision {
  const { config, request } = facts;
  if (config === null || request.chat.id !== config.chatId) return { action: 'ignore' };
  if (request.from.is_bot) return { action: 'decline', reason: 'bot' };
  if (facts.linkedWallet === null) return { action: 'decline', reason: 'not_linked' };
  const members = facts.members;
  if (members !== null && members.byWallet !== null && members.byWallet.telegramUserId !== request.from.id) {
    return { action: 'decline', reason: 'wallet_taken' };
  }
  if (facts.entitlements === null || !facts.entitlements.gatingOn) return { action: 'decline', reason: 'gate_off' };
  if (!loungeReadFresh(facts.holdingCheckedAt, facts.now)) return { action: 'ignore' };
  if (facts.entitlements.tier < HOLDERS2_MIN_TIER) return { action: 'decline', reason: 'below_tier' };
  if (members === null || (members.byUser === null && members.count >= LOUNGE_MEMBERS_MAX)) {
    return { action: 'decline', reason: 'full' };
  }
  return { action: 'approve' };
}

export type LoungeSweepVerdict = 'keep' | 'remove_unlinked' | 'remove_below_tier';

/**
 * Whether a stored `token_holders` row can judge a member's tier (revision 2, M8): there is a row, the gate
 * is on, the row is of the gate's token, and its read is younger than TOKEN_STALE_GRACE_SECONDS at `now`.
 * A missing, stale or other-token row cannot: the token sweep may be behind (a chain read down for a day,
 * more holders than it refreshes), and a member is never removed for Prix's own missing read.
 */
export function loungeStoredRowCurrent(row: RoomAuthorHolder | null, gate: HoldersGate, now: IsoTime): boolean {
  if (row === null || !gate.gatingOn || gate.token === null) return false;
  if (row.tokenAddress.toLowerCase() !== gate.token) return false;
  const age = Date.parse(now) - Date.parse(row.checkedAt);
  return Number.isFinite(age) && age < TOKEN_STALE_GRACE_SECONDS * 1_000;
}

/**
 * The sweep's rule for one member: `keep` while the gate is off (nobody is removed for a gate that is off);
 * `remove_unlinked` when the member's Telegram account is no longer the linked chat of the wallet that let it
 * in (it sent /stop, unlinked on /following, or the wallet was linked to another account: a link passed on);
 * `remove_below_tier` only when the wallet's stored row is of the gate's token, is younger than
 * TOKEN_STALE_GRACE_SECONDS, and its tier is below HOLDERS2_MIN_TIER (`loungeStoredRowCurrent`, then
 * `storedTierOf`); otherwise `keep`. A missing, stale or other-token row is `keep` and left unchecked (not
 * marked: `loungeSweepMarks` is false for it), so it is judged again on the next run.
 *
 * Revision 3 (security H1): the sweep judges a member only after `refreshHolders` has read the listed
 * members' wallets again, and `member.holder` is that read's answer for the wallet, so every member is judged
 * on a row younger than TOKEN_CACHE_SECONDS; when that read fails the run is `idle` and judges nobody.
 */
export function loungeSweepVerdict(member: LoungeDueMember, gate: HoldersGate, now: IsoTime): LoungeSweepVerdict {
  if (!gate.gatingOn || gate.token === null) return 'keep';
  if (member.linkedChatId !== member.telegramUserId) return 'remove_unlinked';
  if (!loungeStoredRowCurrent(member.holder, gate, now)) return 'keep';
  if (storedTierOf(member.holder, gate, now) < HOLDERS2_MIN_TIER) return 'remove_below_tier';
  return 'keep';
}

/**
 * Whether the sweep marks a member it judged `keep` as checked today: only when its stored row is current
 * (`loungeStoredRowCurrent`). A `keep` on a missing, stale or other-token row is left unchecked. (A member
 * whose ban answered `rejected` is marked whatever this says: section 4.6 step 5.)
 */
export function loungeSweepMarks(member: LoungeDueMember, gate: HoldersGate, now: IsoTime): boolean {
  return loungeSweepVerdict(member, gate, now) === 'keep' && loungeStoredRowCurrent(member.holder, gate, now);
}

/** True from LOUNGE_SWEEP_FROM_HOUR_UTC to the end of the UTC day. */
export function loungeSweepHour(now: Date): boolean {
  return now.getUTCHours() >= LOUNGE_SWEEP_FROM_HOUR_UTC;
}

/** What `createLoungeSweepJob(deps): SocialJob` of `packages/runtime/src/social/lounge-sweep.ts` takes. Its name is `holders_lounge_sweep`. */
export interface LoungeSweepJobDeps extends Pick<SocialJobDeps, 'log' | 'social' | 'reputation' | 'now'> {
  lounge: LoungeStore;
  /** Null while the lounge is off or the bot is not configured: the job is idle. */
  config: LoungeConfig | null;
  port: TelegramLoungePort | null;
  holdersGate(): Promise<HoldersGate>;
  /**
   * `TokenService.refreshHolders` (revision 3, security H1): the listed members' wallets read again in one
   * batched chain read before any is judged. Null answered (the gate off or the read failed): the run is
   * `idle` and writes nothing. The entry passes null here while the token service has no `refreshHolders`,
   * and the job is then idle.
   */
  refreshHolders:
    | ((wallets: readonly Address[], now: Date) => Promise<ReadonlyMap<Address, RoomAuthorHolder> | null>)
    | null;
  /** The site's origin, for the /following link in a direct message. */
  siteOrigin: string;
}
/**
 * engine-runtime exports `createLoungeSweepJob` and `createTelegramLoungePort` from
 * packages/runtime/src/social/index.ts (`@prix/runtime/social/index`). The entry reads both by name from that
 * module's namespace, typed CreateLoungeSweepJob and CreateTelegramLoungePort, as it reads
 * `createRoomPictureSweepJob`. While either is undefined it logs `step_not_configured`, the sweep is not in
 * the list, and lounge is null everywhere (revision 2, L8; revision 3, builder M2).
 */
export type CreateLoungeSweepJob = (deps: LoungeSweepJobDeps) => SocialJob;

/** GET /api/lounge, a session. Never cached. Mounted only while `loungeConfig` is not null. */
export const loungeResponseSchema = z
  .strictObject({
    state: z.enum(['not_holder', 'link_telegram', 'open']),
    /** The lounge's invite link: only in state `open`, null otherwise. */
    url: z.string().regex(LOUNGE_INVITE_URL_PATTERN).nullable(),
  })
  .refine((answer) => (answer.state === 'open') === (answer.url !== null), {
    message: 'The invite link is sent in state open and in no other.',
  });
export type LoungeResponse = z.infer<typeof loungeResponseSchema>;

/**
 * The account route's rule, in this order: `not_holder` while the gate is off or the wallet's tier, by
 * `entitlementsFor(address)` without `cachedOnly`, is below HOLDERS2_MIN_TIER; `link_telegram` while the
 * wallet has no linked chat (`FollowStore.getChat`); otherwise `open` with the invite link.
 */
export function loungeAccountAnswer(
  config: LoungeConfig,
  entitlements: Pick<Entitlements, 'gatingOn' | 'tier'>,
  linked: boolean,
): LoungeResponse {
  if (!entitlements.gatingOn || entitlements.tier < HOLDERS2_MIN_TIER) return { state: 'not_holder', url: null };
  if (!linked) return { state: 'link_telegram', url: null };
  return { state: 'open', url: config.inviteUrl };
}

/**
 * What the follow routes take from this phase on: the webhook judges join requests, and GET /api/lounge.
 * The session, the entitlements (`FollowApiDeps.entitlements`) and `getChat` (`FollowApiDeps.follow`) come
 * from `FollowApiDeps` itself.
 */
export interface LoungeApiDeps {
  config: LoungeConfig;
  port: TelegramLoungePort;
  store: LoungeStore;
}
/**
 * `createFollowRoutes` takes this from this phase on. `GET /api/lounge` is registered by it through
 * `registerLoungeRoutes(routes, deps: FollowApiDepsWithLounge)` of apps/api/src/http/lounge/index.ts, only
 * while `deps.lounge` is not null (revision 2, M6).
 */
export interface FollowApiDepsWithLounge extends FollowApiDeps {
  /**
   * Null while `loungeConfig` is null or the bot is not configured. Absent is null, so every harness that
   * builds the old deps still type-checks.
   */
  lounge?: LoungeApiDeps | null;
}

/** The lounge's log lines. None carries a wallet, a Telegram id, a name, a text or a token. */
export const LOUNGE_LOG_EVENTS = [
  'lounge_join_approved',
  'lounge_join_declined',
  'lounge_join_failed',
  'lounge_member_removed',
  'lounge_remove_refused',
  'lounge_unban_failed',
  /** Once, with no value, when HOLDERS_LOUNGE is "on" and `loungeConfig` is null (revision 3, builder L3). */
  'lounge_config_invalid',
] as const;

// --- the words of the lounge, sent by the server ---------------------------------------------------------

/**
 * `{following}` is replaced with the site's origin and `/following`, the page where Telegram is linked
 * (revision 2, H2: the follow alerts' NotifySettings stand on /following, not on /account). Revision 3 names
 * the group as D-163 makes it, Prix Community, in place of "Prix Holders" (security M1).
 */
export const LOUNGE_DIRECT_MESSAGES: Record<Exclude<LoungeJoinRefusal, 'bot'> | LoungeSweepVerdict, string> = {
  not_linked:
    'A new member joins Prix Community on Telegram with a wallet that holds at least 10,000 $PRIX. This Telegram account is not linked to a wallet on Prix yet. Link it on {following}, then ask to join again.',
  wallet_taken:
    'The wallet linked to this Telegram account already let another Telegram account into Prix Community. One wallet lets in one Telegram account.',
  gate_off: 'Joining Prix Community by request is not open yet.',
  below_tier:
    'A new member joins Prix Community on Telegram with a wallet that holds at least 10,000 $PRIX. The wallet linked to this Telegram account holds less as Prix last read it. Hold 10,000 $PRIX in the linked wallet to join. A new holding counts about an hour after Prix first sees it.',
  full: 'Prix Community has reached the number of members it lets in by request for now. Ask to join again later.',
  keep: '',
  remove_unlinked:
    'Prix removed you from Prix Community because this Telegram account is no longer linked to the wallet that let you in. Link it again on {following} and ask to join again.',
  remove_below_tier:
    'Prix removed you from Prix Community because the wallet linked to this Telegram account no longer holds 10,000 $PRIX as Prix last read it. You can ask to join again when it does.',
};

/** The direct message of a refusal or a removal, with the /following link filled in. Null for `bot` and `keep`. */
export function loungeDirectMessage(reason: LoungeJoinRefusal | LoungeSweepVerdict, siteOrigin: string): string | null {
  if (reason === 'bot' || reason === 'keep') return null;
  return LOUNGE_DIRECT_MESSAGES[reason].replace('{following}', `${siteOrigin.replace(/\/+$/, '')}/following`);
}

/**
 * The group's description, which the founder pastes in Telegram (section 4.9 of the contract). Revision 3 (security
 * M1): the lounge is the Prix Community group (D-163), so it no longer says every member holds.
 */
export const LOUNGE_DESCRIPTION =
  "Prix Community. Since the holders' switch, a newcomer joins by a request that @PrixagentBot approves for a Telegram account linked on prixagent.com to a wallet that holds at least 10,000 $PRIX. Members who were here before stay, so being in this group says nothing about anyone's holding. @PrixagentBot posts $PRIX buys and the daily standings of the paper league here. It writes to you directly only to answer your request to join or to say that it removed you, and it never asks you for anything. Prix never runs trade calls, nothing here is investment advice, and nobody from Prix ever asks for a key, a seed phrase or money.";

// --- H. the holders' tape ----------------------------------------------------------------------------------

/** Worker variable of prix-api. On only when exactly "true" after trimming and lower-casing. Off: the route is not mounted. */
export const TAPE_ENABLED_VAR = 'TAPE_ENABLED';
export function tapeEnabled(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

export const TAPE_PATH = '/api/tape';
/** Decisions one answer carries: the newest, both divisions, no second page. */
export const TAPE_ROWS = 40;
/** How long the route keeps each of its two answers in the Cache API. */
export const TAPE_CACHE_SECONDS = 30;

/** The two answers of the tape: as made (a delay of 0) and past the delay. */
export type TapeView = 'live' | 'delayed';

/** The view a viewer's entitlements give: `live` when their feed delay is 0, else `delayed`. Nothing else decides it. */
export function tapeViewOf(entitlements: Pick<Entitlements, 'feedDelaySeconds'>): TapeView {
  return entitlements.feedDelaySeconds === 0 ? 'live' : 'delayed';
}

/**
 * The Cache API key of one view. It is made from the site's origin and the view alone, never from the
 * request's URL, query, headers or cookie; no route answers its path, and the entry's `publicReadKey`
 * answers null for TAPE_PATH, so nothing but this route reads or writes these two entries.
 */
export function tapeCacheKey(siteOrigin: string, view: TapeView): string {
  return `${siteOrigin.replace(/\/+$/, '')}/__cache/tape/${view}`;
}

/** The tape takes no query: any parameter is 400 `invalid_input`. */
export const tapeQuerySchema = z.strictObject({});

/** GET /api/tape. Every answer is `private` to the browser; the route itself shares each view for TAPE_CACHE_SECONDS. */
export const tapeResponseSchema = z.strictObject({
  view: z.enum(['live', 'delayed']),
  /** The delay the rows were cut by, and whether the gate is on: the page's sentence comes from these. */
  delay: feedDelaySchema,
  /** Newest tick first, then agent id descending, as the league feed. Each item says `simulated: true`. */
  items: z.array(feedItemSchema).max(TAPE_ROWS),
  /** When this answer was made. */
  asOf: isoTimeSchema,
});
export type TapeResponse = z.infer<typeof tapeResponseSchema>;

/**
 * What `registerTapeRoutes(routes, extras.tape, liveDelay)` of `apps/api/src/http/tape/index.ts` takes,
 * beside the Live delay (`LiveDelay` of apps/api/src/http/league/delay.ts, which is api-core's and not a
 * contract type). `AppExtras` (apps/api/src/http/index.ts) gains `tape?: TapeApiDeps`: the entry sets it only
 * while `tapeEnabled(TAPE_ENABLED)` and SOCIAL_ENABLED are both on, and http/index.ts mounts the route
 * whenever it is set (revision 2, M6: the switch is decided by the entry, so it is no field here).
 */
export interface TapeApiDeps extends ApiDeps {
  follow: Pick<FollowStore, 'listLeagueFeed'>;
  entitlements: EntitlementsPort;
}

// --- the page words --------------------------------------------------------------------------------------

/**
 * Every sentence a page of this wave says, by its key in the editor's deck (`apps/web/src/content/
 * deck-holders2.ts`, and `deck-social.ts` for the one key it changes). The editor writes them as they stand
 * here; a change is a contract revision. `{count}` is TAPE_ROWS.
 */
export const HOLDERS2_PAGE_WORDS = {
  'social.roomHolderMark': 'Holder',
  'social.roomHolderMarkLabel': 'This wallet holds $PRIX, as Prix last read it.',
  'social.roomDayCaps':
    'A wallet writes up to 30 messages a day, 60 from 10,000 $PRIX, 90 from 100,000 and 120 from 1,000,000.',
  'social.roomRefusalWalletDay': 'This wallet has sent all its messages for today. It can write again after 00:00 UTC.',
  'lounge.title': 'Prix Community on Telegram',
  'lounge.description':
    'Prix’s Community group on Telegram. A new member joins by a request that @PrixagentBot approves when the wallet linked to their Telegram account holds at least 10,000 $PRIX. It is a place to talk about Prix, never a source of trade calls or advice.',
  'lounge.join': 'Ask to join',
  'lounge.joinNote':
    'Telegram sends your request to @PrixagentBot, which lets you in when the wallet linked to your Telegram account holds at least 10,000 $PRIX.',
  'lounge.linkFirst': 'Link Telegram on this page first. The bot lets in the Telegram account linked to this wallet.',
  'lounge.notHolder':
    'A new member joins Prix Community on Telegram with a wallet that holds at least 10,000 $PRIX. A new holding counts about an hour after Prix first sees it.',
  'lounge.leaving':
    'Once a day Prix reads every member’s wallet again. A member whose wallet holds less than 10,000 $PRIX, or whose Telegram account is no longer linked to it, is removed and may ask to join again later.',
  'tape.title': 'Decision tape',
  'tape.description':
    'Every agent’s newest decisions in one place: what each paper portfolio changed and the reason its agent gave, newest first.',
  'tape.viewLive': 'Your wallet holds at least 10,000 $PRIX, so paper decisions show here when they are made.',
  'tape.viewDelayed':
    'Decisions appear here 24 hours after they are made. A wallet that holds at least 10,000 $PRIX sees them as they are made.',
  'tape.viewOpen': 'Decisions appear here as they are made.',
  'tape.liveHold':
    'An agent linked to Prix Live shows each day’s decisions from 20:00 UTC, for everyone, holders included.',
  'tape.notAdvice':
    'These are decisions of AI agents that run paper portfolios. Reasons are written by a model from each owner’s strategy. Nothing here is advice.',
  'tape.scale': 'Each agent decides at most a few times a day, so the newest {count} decisions reach back a few days.',
  'tape.empty': 'No decision to show yet.',
  'tape.fromLeague': 'See every agent’s newest decisions on the tape',
} as const;
export type Holders2PageWordKey = keyof typeof HOLDERS2_PAGE_WORDS;
