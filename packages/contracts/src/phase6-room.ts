import type { EntitlementsReadOptions } from './entitlements.ts';
import type { SocialApiDeps, SocialJob, SocialJobDeps } from './phase6-social.ts';
import type { Address, IsoTime, UtcDay } from './primitives.ts';
import { addressSchema, amountSchema, isoTimeSchema } from './primitives.ts';
import { ROOM_TEXT_MAX, ROOM_TEXT_PROBLEMS } from './room-text.ts';
import { z } from './zod.ts';

export * from './room-text.ts';

/**
 * Phase 6.3: the room, a public chat between users (D-138, 2026-10-10). The founder asked for it:
 * no link and no contract address but $PRIX's.
 * docs/contracts/phase-6-room.md says what these mean and what the rules are. Where the two disagree, this
 * file is the shape and that file is the rule.
 *
 * It is the first part of Prix that publishes what a stranger typed. So: anyone reads the newest messages
 * and nothing older; only a signed-in wallet that holds $PRIX writes; a text is refused whole by
 * `roomTextProblem` (room-text.ts, a file with no zod, which the composer imports) and never edited;
 * nothing refreshes by itself; every count is the server's; an admin hides a message and mutes a writer;
 * and one switch takes the whole room away. The public word is "Community chat". `room` is the name in
 * code, tables and routes.
 */

// --- the switch and the caps ---------------------------------------------------------------------------

/**
 * Worker variables of prix-api. The room is on only while SOCIAL_ENABLED and ROOM_ENABLED are both on
 * (exactly "true" after trimming and lower-casing). Off: its public and writer routes are not mounted and
 * answer the generic 404; an answer already cached lives out its 30 seconds. The admin's routes are
 * mounted always.
 */
export const ROOM_ENABLED_VAR = 'ROOM_ENABLED';
/** Messages of all wallets in one UTC day. Read by `roomDailyCap`; lowering it is how the room is slowed. */
export const ROOM_DAILY_CAP_VAR = 'ROOM_MESSAGES_PER_DAY';
export const ROOM_MESSAGES_PER_DAY_DEFAULT = 400;
/**
 * The ceiling of the variable. A message is 7 rows for `requireWriter`, and once the room holds ROOM_KEEP
 * the prune job deletes an old message for each new one, 2 rows more: 600 messages at 9 rows are 5,400 of
 * the about 5,700 rows a day the plan has left beside the league's planned rows, Prix Live and Phase 6.2.
 */
export const ROOM_MESSAGES_PER_DAY_MAX = 600;
export function roomDailyCap(value: string | undefined): number {
  const text = (value ?? '').trim();
  // Not set is the default; "0" is a room nobody writes in.
  if (!/^\d{1,6}$/.test(text)) return ROOM_MESSAGES_PER_DAY_DEFAULT;
  return Math.min(Number(text), ROOM_MESSAGES_PER_DAY_MAX);
}
/** Messages of all wallets in one UTC hour: a day cannot be filled in ten minutes by fourteen wallets that hold the token for an hour. */
export const ROOM_MESSAGES_PER_HOUR = 40;

/** Messages a read answers, and how many of the newest ids it looks through for them: hidden rows never make it read further. */
export const ROOM_PAGE = 50;
export const ROOM_SCAN = 200;
/**
 * The least a wallet must hold to write, in whole $PRIX. One: the founder, 2026-10-11, an hour after the room went
 * live ("writing a line must not ask for a tier"). Revisions 1 to 6 asked for tier 1. An admin wallet
 * always writes. It is a low wall on purpose: the room's caps and the admins' mute bound a crowd of
 * wallets, not the holding.
 */
export const ROOM_WRITE_MIN_TOKENS = 1;

/** A wallet's holding as the room asks it. */
export interface RoomHolding {
  /** False while the token does not exist or its gate is off: nobody but an admin writes then. */
  gatingOn: boolean;
  /** Whole $PRIX the wallet holds, rounded down; 0 when the token service has no usable read of it. */
  tokens: number;
}
/** One wallet: a message no sooner than this after its last, and this many in one UTC day. */
export const ROOM_SECONDS_BETWEEN = 20;
export const ROOM_MESSAGES_PER_WALLET_PER_DAY = 30;
/** Messages kept. The prune job deletes the older ones, at most ROOM_PRUNE_PER_RUN a run. */
export const ROOM_KEEP = 2_000;
export const ROOM_PRUNE_PER_RUN = 200;
/** The keys of the room's counts, for `takeCounter` of Phase 2 (which deletes day counters by their `d:<day>:` start). `hour` is 0 to 23, UTC. */
export function roomDayKey(day: UtcDay): string {
  return `d:${day}:room:*`;
}
export function roomHourKey(day: UtcDay, hour: number): string {
  return `d:${day}:room:h${String(hour).padStart(2, '0')}`;
}

// --- what is stored ------------------------------------------------------------------------------------

/** A message as it is stored. The whole address stays on the server; a page gets the short form. */
export interface RoomMessageRecord {
  /** Rising by one with every message: the order of the room. */
  id: number;
  at: IsoTime;
  author: Address;
  text: string;
  hiddenAt: IsoTime | null;
  hiddenBy: Address | null;
  /**
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.1): the author's stored token row as
   * `listNewest` and `RoomPictureStore.readRoom` join it (`token_holders` by its key), null when there is
   * none. Only those two reads set it; the route judges it with `storedTierOf` and never reads a chain.
   */
  authorHolder?: RoomAuthorHolder | null;
}

/** The columns of a `token_holders` row that the room's read joins for its Holder mark. */
export interface RoomAuthorHolder {
  tier: number;
  /** The token the row was read from, lower-case. */
  tokenAddress: string;
  checkedAt: IsoTime;
}

/** A writer's own row: the last message, the count of the day, a mute, and the time before which nothing of the writer is shown. */
export interface RoomWriterRecord {
  address: Address;
  lastAt: IsoTime | null;
  day: UtcDay | null;
  count: number;
  mutedAt: IsoTime | null;
  mutedBy: Address | null;
  /** Set by a mute and never cleared; a lift moves it forward to the writer's newest message. Nothing written at or before it is shown. */
  cutAt: IsoTime | null;
}

export type RoomTurnRefusal = 'muted' | 'day' | 'too_soon';
export type RoomTurn = { ok: true; left: number } | { ok: false; why: RoomTurnRefusal };

/**
 * Why a writer's row refuses a turn at `now`, or null: `muted` first, then `day` (the wallet's cap), then
 * `too_soon`. The route asks it of `getWriter` before anything is spent, and the store's `takeTurn` decides
 * by the same order.
 */
export function roomTurnRefusal(
  writer: RoomWriterRecord | null,
  now: IsoTime,
  day: UtcDay,
  /**
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2): the wallet's cap of the day,
   * `roomWalletDayCap` of its holding. Left out it is ROOM_MESSAGES_PER_WALLET_PER_DAY, as before.
   */
  dayCap: number = ROOM_MESSAGES_PER_WALLET_PER_DAY,
): RoomTurnRefusal | null {
  if (writer === null) return null;
  if (writer.mutedAt !== null) return 'muted';
  if (writer.day === day && writer.count >= dayCap) return 'day';
  if (writer.lastAt !== null && Date.parse(now) - Date.parse(writer.lastAt) < ROOM_SECONDS_BETWEEN * 1_000)
    return 'too_soon';
  return null;
}

/** The refusals of the room that are 429. Each carries `Retry-After`, in whole seconds, from `roomRetryAfterSeconds`. */
export type RoomWaitField = 'too_soon' | 'wallet_day' | 'room_hour' | 'room_day';

/**
 * The seconds a 429 of the room tells a client to wait: what is left of ROOM_SECONDS_BETWEEN after `lastAt`
 * for `too_soon` (the writer's last message; null reads as none left); the time to the next full UTC hour
 * for `room_hour`; the time to the next 00:00 UTC for `wallet_day` and `room_day`. At least 1. A time that
 * does not parse answers the whole wait of its field. A `too_soon` of `takeTurn` itself (step 6: another
 * request of the wallet took the turn a moment ago, and the row of step 4 is older than that turn) is asked
 * with `lastAt` equal to `now`, which answers ROOM_SECONDS_BETWEEN.
 */
export function roomRetryAfterSeconds(field: RoomWaitField, now: IsoTime, lastAt: IsoTime | null): number {
  const at = Date.parse(now);
  if (field === 'too_soon') {
    const since = lastAt === null ? ROOM_SECONDS_BETWEEN * 1_000 : at - Date.parse(lastAt);
    if (!Number.isFinite(since)) return ROOM_SECONDS_BETWEEN;
    const left = Math.ceil((ROOM_SECONDS_BETWEEN * 1_000 - since) / 1_000);
    return Math.min(ROOM_SECONDS_BETWEEN, Math.max(1, left));
  }
  const span = field === 'room_hour' ? 3_600_000 : 86_400_000;
  if (!Number.isFinite(at)) return span / 1_000;
  return Math.max(1, Math.ceil((span - (at % span)) / 1_000));
}

/**
 * `apps/api/src/store/room.ts` exports `createRoomStore(db)`. Every method is one D1 call or one D1 batch.
 * Migration `infra/migrations/0012_room.sql` (the contract's section 2 gives its statements).
 */
export interface RoomStore {
  /**
   * The messages a page may show: among the newest `scan` ids and nothing below them, at most `limit`,
   * newest first; none that is hidden, none of a writer who is muted now, and none written at or before
   * its writer's `cutAt`. It never reads further down to fill a page. One statement: its edge is the
   * newest id less `scan` (`id > (SELECT COALESCE(MAX(id), 0) FROM room_messages) - scan`) and a
   * message's writer is read by its key, so a call reads at most twice `scan` rows.
   *
   * Phase 6.4 (docs/contracts/phase-6-pictures.md section 19): it leaves picture messages out
   * (`pic_type IS NULL`). It is the read of a room whose pictures are not enabled; while they are, the
   * route answers `RoomPictureStore.readRoom`.
   */
  listNewest(limit: number, scan: number): Promise<RoomMessageRecord[]>;
  /**
   * Every message with an id below `before` (the newest when null), newest first, at most `limit`, hidden
   * ones and those of muted writers too: for the admins' page. `muted`: its writer is muted now. `cut`: it
   * was written at or before its writer's `cutAt`, so no public read shows it though it may be neither
   * hidden nor its writer muted now.
   */
  listAllMessages(
    before: number | null,
    limit: number,
  ): Promise<(RoomMessageRecord & { muted: boolean; cut: boolean })[]>;
  getMessage(id: number): Promise<RoomMessageRecord | null>;
  getWriter(address: Address): Promise<RoomWriterRecord | null>;
  /**
   * The room's two counts as they stand, read and not taken, in one statement over the counters of Phase 2
   * (the keys of `roomHourKey` and `roomDayKey`). A key with no row counts 0. The route asks it before it
   * spends anything, so that a full room costs a read.
   */
  getCounts(hourKey: string, dayKey: string): Promise<{ hour: number; day: number }>;
  /**
   * A writer's turn, as one batch: a write that counts the turn only when `roomTurnRefusal` would answer
   * null for the row as it stands, then a read of the row. A refusal writes nothing and names its reason
   * from the row, in the order of `roomTurnRefusal`. Ok answers what is left of the wallet's day. Whether
   * the turn was counted is what the write changed (its `meta.changes`), never a second judgement of the
   * row read after it: once a turn is counted that row's `lastAt` is `now`, and `roomTurnRefusal` of it
   * answers `too_soon`.
   *
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2): `dayCap` (ROOM_MESSAGES_PER_WALLET_PER_DAY
   * when left out) is the bound of the same one statement, `count < ?dayCap` where the SQL had 30; ok answers
   * `left: max(0, dayCap − count)`, and a refusal is named with `roomTurnRefusal(record, now, day, dayCap)`.
   */
  takeTurn(address: Address, now: IsoTime, day: UtcDay, dayCap?: number): Promise<RoomTurn>;
  /**
   * Stores a message.
   *
   * Phase 6.4 (docs/contracts/phase-6-pictures.md section 19): one batch, the insert and the writer's
   * `first_at` (migration 0013) set to `now` where it is null; the batch makes the writer's row for it
   * when there is none (an admin takes no turn and may have no row). The signature and the answer are as
   * before.
   */
  putMessage(author: Address, text: string, now: IsoTime): Promise<RoomMessageRecord>;
  /**
   * Hides a message for good: `hidden` when it did, `already` when it was hidden, `none` when no message has that id.
   *
   * Phase 6.4: no route calls it any more. The admin's hide calls `RoomPictureStore.hideWithPicture`,
   * whatever the switch of pictures says.
   */
  hideMessage(id: number, by: Address, now: IsoTime): Promise<'hidden' | 'already' | 'none'>;
  /**
   * Mutes a writer and sets its `cutAt` to `now`; makes the row when the writer has none. False when it was muted already.
   *
   * Phase 6.4: no route calls it any more. The admin's mute calls `RoomPictureStore.muteWithPictures`,
   * whatever the switch of pictures says.
   */
  muteWriter(address: Address, by: Address, now: IsoTime): Promise<boolean>;
  /**
   * Lifts a mute and, in the same statement, moves `cutAt` forward to the time of the writer's newest
   * message when that is later: nothing the writer wrote before the lift is ever shown, also a message
   * that was stored while the mute was on its way. False when the writer was not muted.
   */
  unmuteWriter(address: Address): Promise<boolean>;
  /**
   * Deletes messages with an id at or below the newest id less `keep`, at most `limit`, in one statement,
   * and answers how many. Ids rise by one, so the edge is arithmetic and no row is walked to find it.
   *
   * Phase 6.4 (docs/contracts/phase-6-pictures.md section 19): one batch, the delete of messages as
   * before and the delete of the rows of `room_picture_reports` whose message is at or below the same
   * edge. It still answers the count of messages.
   */
  pruneMessages(keep: number, limit: number): Promise<number>;
}

// --- the API -------------------------------------------------------------------------------------------

/** GET /api/social/room/status. 404 while the room is off. The site asks it once and keeps the answer for a minute, beside `socialIsOn`. */
export const roomStatusResponseSchema = z.strictObject({ on: z.literal(true) });
export type RoomStatusResponse = z.infer<typeof roomStatusResponseSchema>;

/** A message as a page shows it. */
export const roomMessageSchema = z.strictObject({
  id: z.number().int().positive(),
  at: isoTimeSchema,
  /** The writer's short address, as an agent's page shows its owner. Never the whole address. */
  authorShort: z.string().min(1).max(20),
  /** Written from an admin wallet (compared in lower case): the one mark a writer can carry, and nobody can type it. */
  admin: z.boolean(),
  text: z.string().min(1).max(ROOM_TEXT_MAX),
  /**
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.1): the quiet Holder mark, `roomHolderMark`
   * of the author's stored tier at read time. Sent on every message while ROOM_HOLDERS is on, absent while
   * it is off; never true beside `admin`. Optional, as `house` is on a feed item. The write's and the
   * upload's answers carry `holder` from the cap's own holding (`roomHolderMark(admin, holding.tier ?? 0)`)
   * while ROOM_HOLDERS is on (revision 2, L5), so the writer's own new row shows its mark at once.
   */
  holder: z.boolean().optional(),
});
export type RoomMessage = z.infer<typeof roomMessageSchema>;

/**
 * GET /api/social/room. Public, cached 30 s like every Phase 6 read, under one key: it takes no query.
 * Reads no session. The newest messages and nothing older: this version has no second page.
 */
export const roomResponseSchema = z.strictObject({
  on: z.literal(true),
  messages: z.array(roomMessageSchema).max(ROOM_PAGE),
  /** What `roomTextProblem` needs in the composer: the one address and the one host a message may hold. */
  prixAddress: addressSchema.nullable(),
  siteHost: z.string(),
});
export type RoomResponse = z.infer<typeof roomResponseSchema>;

/**
 * GET /api/social/room/me, a session. Never cached, and with no limiter of its own: every request passes
 * the `read` rule of its network address already. In this order: `gate_off` while the token gate is off
 * (not for an admin); `not_holder` while the wallet holds less than ROOM_WRITE_MIN_TOKENS, by
 * `deps.holding(address)` without `cachedOnly` (not for an admin); `muted` (not for an admin:
 * an admin is `yes` whatever its row says); otherwise `yes`.
 * `left` is the wallet's messages left today, and 0 unless `write` is `yes`; an admin takes no turn, so its
 * `left` is always ROOM_MESSAGES_PER_WALLET_PER_DAY, here and in the answer to a write. `yes` cannot know
 * that the room's hour or day is full: the write says so.
 */
export const roomMeResponseSchema = z.strictObject({
  write: z.enum(['yes', 'not_holder', 'muted', 'gate_off']),
  left: amountSchema,
  /**
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2 and 7, revision 2, M4): the wallet's cap of
   * the day, `roomWalletDayCap` of the holding `me` read (an admin's is ROOM_MESSAGES_PER_WALLET_PER_DAY).
   * Sent while ROOM_HOLDERS is on and absent while it is off: the page shows `social.roomDayCaps` exactly
   * when it is there. `roomMeWithPicturesResponseSchema` extends this schema, so it carries it too.
   */
  dayCap: amountSchema.optional(),
});
export type RoomMeResponse = z.infer<typeof roomMeResponseSchema>;

/**
 * POST /api/social/room, a session. The server folds and judges the text; the answer carries what was
 * stored. The schema takes an empty string, so that an empty text is refused by `roomTextProblem` as
 * `text_empty` like every other problem. A body this schema refuses (no JSON, a field too many, a text
 * that is no string or longer than 2,000 characters) keeps `readInput`'s own answer.
 */
export const roomPostRequestSchema = z.strictObject({ text: z.string().max(2_000) });
export type RoomPostRequest = z.infer<typeof roomPostRequestSchema>;
export const roomPostResponseSchema = z.strictObject({ message: roomMessageSchema, left: amountSchema });
export type RoomPostResponse = z.infer<typeof roomPostResponseSchema>;

/**
 * The refusals of the room, each `invalid_input` (no new error code) with the field named here and the
 * status beside it. The page has one sentence for each. A refusal of `requireWriter` itself keeps its own
 * code (`rate_limited`, `daily_limit`) and gets one sentence for both.
 */
export const ROOM_REFUSALS = {
  ...(Object.fromEntries(ROOM_TEXT_PROBLEMS.map((problem) => [`text_${problem}`, 400])) as Record<
    `text_${(typeof ROOM_TEXT_PROBLEMS)[number]}`,
    400
  >),
  /** The wallet holds less than ROOM_WRITE_MIN_TOKENS, or Prix has not read its holding since it was bought. */
  not_holder: 403,
  /** The token gate is off: nobody but an admin writes. */
  gate_off: 403,
  muted: 403,
  /** Sooner than ROOM_SECONDS_BETWEEN after the wallet's last message. */
  too_soon: 429,
  /** The wallet's ROOM_MESSAGES_PER_WALLET_PER_DAY. */
  wallet_day: 429,
  /** The room's ROOM_MESSAGES_PER_HOUR. */
  room_hour: 429,
  /** The room's cap of the day. */
  room_day: 429,
  /** An admin's writer cannot be muted: the answer of the PUT for a message of an admin. Lifting a mute is never refused. */
  admin: 400,
} as const;
export type RoomRefusalField = keyof typeof ROOM_REFUSALS;

/** A message's id in a path: digits with no leading zero. */
export const roomIdParamSchema = z.string().regex(/^[1-9]\d{0,14}$/);

/**
 * GET /api/social/admin/room?before=<id>, an admin session; the generic 404 to anyone else. Never cached.
 * What the admins' page needs to hide a message or mute its writer: the whole address, and the messages a
 * public read leaves out.
 */
export const roomAdminMessageSchema = z.strictObject({
  id: z.number().int().positive(),
  at: isoTimeSchema,
  author: addressSchema,
  text: z.string().min(1).max(ROOM_TEXT_MAX),
  hidden: z.boolean(),
  /** Its writer is muted now. */
  muted: z.boolean(),
  /** Written at or before its writer's cut: no public read shows it, also after the mute was lifted. */
  cut: z.boolean(),
  /** The author is an admin wallet: it cannot be muted. */
  admin: z.boolean(),
});
export const roomAdminResponseSchema = z.strictObject({
  messages: z.array(roomAdminMessageSchema).max(ROOM_PAGE),
  /** The id to pass as `before` for older messages; null when there are none. */
  older: z.number().int().positive().nullable(),
});
export type RoomAdminResponse = z.infer<typeof roomAdminResponseSchema>;
export const roomAdminQuerySchema = z.strictObject({ before: roomIdParamSchema.optional() });

/**
 * The admin's three writes, each by a message's id, so that no address travels in a path or a log line:
 * DELETE /admin/room/messages/:id hides it; PUT and DELETE /admin/room/messages/:id/mute mute and unmute
 * its writer. Each is audited with these names and the message's id as its target, only when it changed
 * something.
 */
export const ROOM_AUDIT_ACTIONS = { hide: 'room_hide', mute: 'room_mute', unmute: 'room_unmute' } as const;

/**
 * D1 rows a call may write, for `requireWriter`: an index written counts as a row. A message is six by
 * the tables: three for the message (its row, its index, the sequence's row), the writer's row, and the
 * room's two counts, one row each (both tables are WITHOUT ROWID). Seven is the figure the budget uses.
 * The prune's deletes are not a write of this call: section 10 of the contract counts them, 2 a message.
 */
export const ROOM_POST_WRITE_ROWS = 7;
/**
 * What a hide and a mute write. Since revision 5 the admin's three writes pass the limiter and are not
 * booked with `requireWriter`: a hide must never fail because a budget of the day is spent. The two
 * figures stay for the budget's table.
 */
export const ROOM_HIDE_WRITE_ROWS = 2;
export const ROOM_MUTE_WRITE_ROWS = 2;

/**
 * `apps/api/src/http/social/room/` exports `createRoomRoutes(deps)`: the status, the read, `me` and the
 * write, mounted under SOCIAL_API_PREFIX only while `roomEnabled` holds; and `createRoomAdminRoutes(deps)`:
 * the admin's read and its three writes, mounted always, the generic 404 to anyone who is not an admin
 * session. The entry hands them to `createApp` as `AppExtras.room` and `AppExtras.roomAdmin`, both of this
 * type, and spells the two names itself as it does for Phase 6. No route drops a cached answer: the entry
 * does, by the path of a write that answered ok (the contract's section 6).
 */
export interface RoomApiDeps extends SocialApiDeps {
  room: RoomStore;
  /** SOCIAL_ENABLED and ROOM_ENABLED. */
  roomEnabled: boolean;
  /** `roomDailyCap` of ROOM_MESSAGES_PER_DAY. Phase 6.4: while pictures are enabled, `roomDailyCapBesidePictures` of it (phase6-room-pictures.ts). */
  roomDailyCap: number;
  /** The token's address from the token's config, lower-case; null while there is none. */
  prixAddress(): Promise<Address | null>;
  /**
   * The wallet's holding, from the token service's `holdingOf` and never from a request. With
   * `cachedOnly` it reads no chain (the write asks it so); without it a read older than
   * TOKEN_CACHE_SECONDS is made again (`me` asks it so).
   */
  holding(address: Address, options?: EntitlementsReadOptions): Promise<RoomHolding>;
}

/**
 * What `createRoomPruneJob(deps): SocialJob` of `packages/runtime/src/social/room-prune.ts` takes. Its
 * name is `room_prune`; it is the seventh job of the social step and the last in the entry's list. Phase
 * 6.4: it stays the last in the entry's list, and `room_picture_sweep`, the eighth name, stands before it
 * there (docs/contracts/phase-6-pictures.md section 9). It runs
 * under `guardSocialJob` like every social job, calls `pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)` once
 * a run, is idle when that deletes nothing, and answers `more` when it deleted ROOM_PRUNE_PER_RUN. It runs
 * whatever the switch says, so that a room that was switched off still ages out, and logs a count only.
 * It never calls the guard's skip gate: its one statement is both its idle check and its write, so a run
 * that fails is tried again on the next run, and is answered `idle` after SOCIAL_JOB_SKIP_AFTER_FAILURES
 * failures of a UTC day.
 */
export interface RoomPruneJobDeps extends Pick<SocialJobDeps, 'log' | 'social' | 'reputation' | 'now'> {
  room: RoomStore;
}
export type CreateRoomPruneJob = (deps: RoomPruneJobDeps) => SocialJob;

/** The sentence that stands above the messages, server-rendered, in body size, as it stands. */
export const ROOM_DISCLAIMER =
  'Messages here are written by users, not by Prix, and nobody checks them before they appear. Nothing here is advice. Prix staff never write to anyone first and never ask for a key or a seed phrase.';
/** And under it while a token address is configured. `{address}` is $PRIX's contract. */
export const ROOM_TOKEN_NOTE = 'The only token of Prix is $PRIX, at {address}. No other address belongs in this chat.';
