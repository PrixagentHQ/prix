import type { ApiErrorCode } from './api.ts';
import type {
  RoomApiDeps,
  RoomMessageRecord,
  RoomTurnRefusal,
  RoomWaitField,
  RoomWriterRecord,
} from './phase6-room.ts';
import {
  ROOM_MESSAGES_PER_DAY_MAX,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_WRITE_MIN_TOKENS,
  roomAdminMessageSchema,
  roomAdminResponseSchema,
  roomMeResponseSchema,
  roomMessageSchema,
  roomResponseSchema,
  roomRetryAfterSeconds,
  roomTurnRefusal,
} from './phase6-room.ts';
import type { SocialJob, SocialJobDeps, SocialJobName } from './phase6-social.ts';
import type { Address, IsoTime, UtcDay } from './primitives.ts';
import { addressSchema, amountSchema, isoTimeSchema } from './primitives.ts';
import type { RoomPictureFacts, RoomPictureType } from './room-picture.ts';
import {
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MAX_SIDE,
  ROOM_PICTURE_MIN_BYTES,
  ROOM_PICTURE_MIN_SIDE,
  ROOM_PICTURE_PROBLEMS,
  ROOM_PICTURE_REPORTER_AGE_SECONDS,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_TYPES,
  ROOM_PICTURE_WRITER_AGE_SECONDS,
  ROOM_PICTURES_PATH,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
} from './room-picture.ts';
import { z } from './zod.ts';

export * from './room-picture.ts';

/**
 * Phase 6.4: pictures in the room (2026-10-11). The founder decided that users may
 * upload pictures and GIFs into the Community chat, and that nothing is paid for: Cloudflare's free plan
 * only. docs/contracts/phase-6-pictures.md says what these mean and what the rules are. Where the two
 * disagree, this file is the shape and that file is the rule.
 *
 * A picture is the first thing in Prix that a stranger made and Prix cannot read. So: D1 decides and KV
 * only holds bytes; only the server's own serialisation of a file is stored (`roomPictureCheck`,
 * room-picture.ts, a file with no import, which the composer runs too); the bytes are served so that no
 * browser can treat them as a page or a script, and never from a cache; a reader sees nothing before a
 * click; a hide or a mute deletes the bytes at once; three holders hide a picture and an admin decides;
 * an admin wallet cannot upload at all; and an admin turns every picture off with one write to D1. The
 * public word is "picture".
 *
 * Revision 2 (2026-10-11) takes the security review of draft 1 (5 medium, 7 low) and the builder's reading
 * (C1 to C11); the document's status line and its section 20 say what changed. What a browser script needs
 * (the paths, the limits a page prints, the composer's ladder, the attributes the two web owners share)
 * moved to room-picture.ts, the one file of the contracts a script may import values from, and is exported
 * from here again.
 *
 * Revision 3 (2026-10-11) takes the second look of both readers (the security reviewer's N1 to N5 and its
 * notes A to C, the builder's reader's N1 to N10); the document's section 21 says what changed. In this
 * file: `clearPicturesOff` takes the keys of the two counts that switch pictures off by themselves and
 * deletes them with the row, and the comments say what the document now says of the upload's execution
 * context, the migration's fill, a report of an admin wallet's picture, keep's `already` and the sweep's
 * order. No constant changed.
 *
 * Revision 4 (2026-10-11) takes a third look at revision 3 (the document's section 22). In this file,
 * comments, and one name: the order inside `clearPicturesOff`'s batch, the context read before the
 * upload's promise is made, a note at `roomPictureRowsWorst`, and an eighth log line,
 * `ROOM_PICTURE_LOG_EVENTS.uploadFailed`. No constant and no signature changed.
 *
 * Revision 5 (2026-10-11) takes the operator's decisions on what the first build round left open (the
 * document's section 23). In this file: ROOM_PICTURE_POST_WRITE_ROWS is 11, what a stored upload was
 * measured to write, and `roomPictureRowsWorst` and `roomDailyCapBesidePictures` follow it, with
 * ROOM_PICTURE_PRUNE_ROWS as a name for what the prune deletes of a picture; eleven more names in
 * ROOM_PICTURE_COPY_KEYS and the slots of every key that has one; and the comments say what the owners
 * built and the operator let stand (the orphan's log line and its count, the sweep's `now` and its slice, an
 * idle sweep that reads at most one row). ROOM_PICTURE_MAX_BYTES, in room-picture.ts, is 262,144. No
 * signature changed, and no name an owner built against.
 *
 * Revision 6 (2026-10-12) takes what two security reviews and a design check of the first round's built
 * code found, on the operator's decisions (the document's section 24). In this file: one constant,
 * ROOM_PICTURE_BODY_SECONDS, the deadline an upload's body is read against (S1); `markGone` bound to the
 * state `removed` inside its statement (S2); the report's steps 4 to 6 as one promise handed to
 * `waitUntil`, said at RoomPictureApiDeps (S3); six more names in ROOM_PICTURE_COPY_KEYS (`ReportAsk`,
 * `ReportYes`, `ReportNo`, `RestingRow`, `AdminPicturesTitle`, `AdminMessagesTitle`) and new drafts for the
 * switch's two labels. In room-picture.ts, two more names in ROOM_PICTURE_DOM for the report's question.
 * No rule of `roomPictureCheck` changed, no other constant, no signature, and no name an owner built
 * against. The operator's reading of the same day changed three things: the deadline is thirty seconds and not
 * the review's ten; a ninth log line, `ROOM_PICTURE_LOG_EVENTS.reportFailed`; and what closes an open report
 * question when its picture is hidden (room-picture.ts, at ROOM_PICTURE_DOM).
 *
 * Revision 7 (2026-10-12) is a comment and nothing else: the upload's reader keeps no piece of the body,
 * said at ROOM_PICTURE_BODY_SECONDS, on the confirming security look at the second round's code (the
 * document's section 25). No constant, type, schema or name changed.
 */

// --- the switch and the caps ---------------------------------------------------------------------------

/**
 * Worker variable of prix-api. Pictures are on only while SOCIAL_ENABLED, ROOM_ENABLED and
 * ROOM_PICTURES_ENABLED are all on (exactly "true" after trimming and lower-casing). Off: the upload, the
 * bytes and the report routes are not mounted and answer the generic 404; the room's read answers as
 * Phase 6.3's does and leaves picture messages out. The admin's routes are mounted always. This is the
 * switch of a deploy; `pictures_off` in D1 is the switch without one (`RoomPicturesOff`).
 */
export const ROOM_PICTURES_ENABLED_VAR = 'ROOM_PICTURES_ENABLED';
export function roomPicturesEnabled(
  social: string | undefined,
  room: string | undefined,
  pictures: string | undefined,
): boolean {
  const on = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'true';
  return on(social) && on(room) && on(pictures);
}

/** The KV binding of prix-api that holds the bytes, and the namespace's title. Nothing else is ever put in it. */
export const ROOM_PICTURES_KV_BINDING = 'ROOM_PICTURES';
export const ROOM_PICTURES_KV_TITLE = 'prix-room-pictures';

/**
 * The least a wallet must hold to upload, in whole $PRIX. The holding of a message, on the founder's word (free
 * uploads). It is a constant of its own so that it can be raised without touching who may write; raising it
 * needs a sentence of its own, which is a change of this contract.
 */
export const ROOM_PICTURE_MIN_TOKENS = ROOM_WRITE_MIN_TOKENS;
// ROOM_PICTURE_WRITER_AGE_SECONDS, ROOM_PICTURE_REPORTER_AGE_SECONDS, ROOM_PICTURES_PER_WALLET_PER_DAY and
// ROOM_PICTURE_TTL_SECONDS are in room-picture.ts: a page prints them through ROOM_PICTURE_LIMITS.
/** Pictures of all wallets in one UTC hour. */
export const ROOM_PICTURES_PER_HOUR = 10;
/** Pictures of all wallets in one UTC day. Read by `roomPicturesDailyCap`. What one person can moderate bounds it, not KV. */
export const ROOM_PICTURES_DAILY_CAP_VAR = 'ROOM_PICTURES_PER_DAY';
export const ROOM_PICTURES_PER_DAY_DEFAULT = 60;
export const ROOM_PICTURES_PER_DAY_MAX = 150;
export function roomPicturesDailyCap(value: string | undefined): number {
  const text = (value ?? '').trim();
  // Not set is the default; "0" stops uploads and keeps serving what is there.
  if (!/^\d{1,6}$/.test(text)) return ROOM_PICTURES_PER_DAY_DEFAULT;
  return Math.min(Number(text), ROOM_PICTURES_PER_DAY_MAX);
}
/** A wallet with this many pictures hidden by reports and not yet decided by an admin uploads no more. */
export const ROOM_REPORTED_PICTURES_PAUSE = 2;

/**
 * Pictures shown in one UTC day, all readers together. Every shown picture is one request of the 100,000
 * the whole site has in a day and one of KV's 100,000 reads. At the cap the room's read says `resting`,
 * the page offers no "Show picture", and the bytes route answers `picture_views_day` with no KV read.
 */
export const ROOM_PICTURE_VIEWS_VAR = 'ROOM_PICTURE_VIEWS_PER_DAY';
export const ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT = 20_000;
export const ROOM_PICTURE_VIEWS_PER_DAY_MAX = 30_000;
export function roomPictureViewsCap(value: string | undefined): number {
  const text = (value ?? '').trim();
  if (!/^\d{1,6}$/.test(text)) return ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT;
  return Math.min(Number(text), ROOM_PICTURE_VIEWS_PER_DAY_MAX);
}
/**
 * A view is counted once in this many, by adding this many, so that a view does not cost a D1 row: 20,000
 * views are about 800 rows written. The draw is the server's (`RoomPictureApiDeps.random`).
 */
export const ROOM_PICTURE_VIEW_SAMPLE = 25;

/**
 * The UTC days whose pictures can be in KV at one moment: a span of seven times 24 hours touches at most
 * eight UTC days, and one more for an expiry that comes late, for which Cloudflare names no bound.
 */
export const ROOM_PICTURE_STORAGE_DAYS = 9;
/** KV's "1 GB" of the free plan, read as 10^9 bytes: the smaller reading. */
export const ROOM_PICTURE_STORAGE_LIMIT_BYTES = 1_000_000_000;
/**
 * The most bytes the namespace can hold: every day of ROOM_PICTURE_STORAGE_DAYS at the day's cap, every
 * picture of the largest size. A key no row names (a request that ended between the put and the insert)
 * is inside it: a put is tried only after the day's count was taken. 353,894,400 at the cap's ceiling
 * since revision 5 (707,788,800 while the largest picture was 524,288 bytes).
 */
export function roomPictureStorageWorstBytes(picturesCap: number = ROOM_PICTURES_PER_DAY_MAX): number {
  return ROOM_PICTURE_STORAGE_DAYS * picturesCap * ROOM_PICTURE_MAX_BYTES;
}

/** Distinct wallets whose reports hide a picture until an admin decides. */
export const ROOM_PICTURE_REPORTS_TO_HIDE = 3;
/** Reports of one wallet in one UTC day. */
export const ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY = 5;
/**
 * Reports of all wallets in one UTC day that are counted. Only a report that `putReport` counted takes one
 * of them (a second report of one picture by one wallet never does, however many are sent at once). The
 * counted report that finds the count full switches pictures off (`reports_day`) and is answered 204: a
 * crowd can spend this count, and what it buys is that pictures go off, never that a picture stays up
 * because nobody can report it any more. An admin who switches pictures on gives the room this count
 * again, and the hour's count of hidden pictures (`clearPicturesOff`, revision 3): with the count left
 * full, "Pictures on" would have lasted until the next counted report.
 */
export const ROOM_PICTURE_REPORTS_PER_DAY = 100;
/** Pictures hidden by reports in one UTC hour that switch pictures off until an admin switches them on (`reports_hour`). */
export const ROOM_PICTURE_AUTO_OFF_REPORTED = 5;
/** A wallet with this many strikes (a report of a picture an admin then kept) is answered 204 and counted nowhere. */
export const ROOM_PICTURE_REPORT_STRIKES = 2;
/**
 * KV deletes one admin call makes at most: three pictures a day on each of the eight UTC days a span of
 * seven days touches. It is every picture of one writer that can still have bytes, because a removal gives
 * up the key of a picture whose message is ROOM_PICTURE_TTL_SECONDS old with no KV call (`hideWithPicture`,
 * `muteWithPictures`).
 */
export const ROOM_PICTURE_DELETES_PER_CALL = 24;
/** KV deletes the sweep job tries in one run. It stops at the first that throws. */
export const ROOM_PICTURE_SWEEP_PER_RUN = 10;
/** Reported pictures the admins' page lists at once, oldest first. */
export const ROOM_PICTURE_REPORTED_SHOWN = 20;

/**
 * How long an upload's body may take, in seconds (revision 6, the security review of the built code, S1).
 * Steps 1 to 3 of the upload take nothing, so without a deadline a wallet that may upload could open a
 * request, send no body and wait: the hour's ten pictures could be hoarded and released in one moment,
 * steps 6 to 11 would run on a `now`, a day and an hour read hours before, and every parked request would
 * hold memory in the isolate. The route (step 4 of the document's section 5):
 *
 * - starts ONE timer of this many seconds when step 4 begins, and every read of the body races that one
 *   timer (never a new timer for each read: a body that trickles would otherwise never end). When the
 *   timer wins, the reader is cancelled and the answer is `picture_malformed`;
 * - answers `picture_malformed` too when a read rejects (a body that broke), never a 500;
 * - keeps no piece of the body (revision 7, the confirming security look at the second round's code). When
 *   the first piece arrives it makes ONE buffer of the declared length, never before, and copies each piece
 *   into it at its place. The Workers runtime hands every piece on a buffer of 4,096 bytes whatever the
 *   piece carries, so a reader that collected its pieces held 4,096 times a body written a byte at a time.
 *   While it reads, the route holds at most the declared length and the one piece in its hands. It refuses
 *   a body as soon as more than the declared length has come, and copies nothing of the piece that passes
 *   it;
 * - races each read against a promise made for that read alone, which the one timer settles, and looks
 *   before each read whether the timer has fired. One promise for the whole body would keep every finished
 *   read, and the buffer under its piece, reachable until the timer is cleared;
 * - after step 5 and before it takes the execution context, reads the clock once more: when that reading
 *   is more than this many seconds past the request's own `now` (the one read after step 2), the answer is
 *   `picture_malformed` with nothing spent. This second reading is the rule by the route's own clock; the
 *   timer is what frees the request before the body ends. It is never a step's `now`, day or hour.
 *
 * Thirty seconds is 262,144 bytes at about 70 kbit a second: a slower sender is refused and may try again.
 * The review proposed ten, which is about 210 kbit a second and would refuse an ordinary phone on a slow
 * network; the operator took thirty. A parked upload holds at most its declared length and one piece of 4,096
 * bytes, 266,240 bytes for the largest, which is true only of a reader that keeps no piece (revision 7).
 * The `write` rule is 20 a wallet and 120 for all in a fixed window of 60 seconds at one location; a
 * window can be spent in its first second, and twice a limit passes across a window's edge. So by the
 * rule's count one wallet parks at most 40 uploads and all wallets 240 at one location, which are
 * 63,897,600 bytes if every one meets in one isolate, half of an isolate's 128 MB. The binding counts
 * permissively (apps/api/src/rate-limit.ts), so that figure is a ceiling on abuse and no exact bound.
 * (Revision 6 and the first text of revision 7 said "at most sixty", which the rule does not give: the
 * confirming security look at the final branch.) An upload released inside thirty seconds is one its
 * sender could have sent at once.
 */
export const ROOM_PICTURE_BODY_SECONDS = 30;

/**
 * The limiter rule of the two bytes routes, on top of the `read` rule every request passes: the binding
 * `RATE_PICTURE` of prix-api, namespace 466304, this many in 60 seconds. Its subject is
 * `clientNetwork(request)` of `apps/api/src/http/guard.ts` (an IPv4 address, or the /48 of an IPv6 one) and
 * never `clientSubject` (the /64): one rented /48 is 65,536 subjects of that kind. A brake, not a bound:
 * the day's bound is ROOM_PICTURE_VIEWS_PER_DAY.
 */
export const ROOM_PICTURE_RATE_BINDING = 'RATE_PICTURE';
export const ROOM_PICTURE_RATE_NAMESPACE = '466304';
export const ROOM_PICTURE_RATE_PER_MINUTE = 10;

/** The keys of the pictures' counts, for `takeCounter` of Phase 2 (which deletes day counters by their `d:<day>:` start). `hour` is 0 to 23, UTC. */
export function roomPictureDayKey(day: UtcDay): string {
  return `d:${day}:room:pic:*`;
}
export function roomPictureHourKey(day: UtcDay, hour: number): string {
  return `d:${day}:room:pic:h${String(hour).padStart(2, '0')}`;
}
/** Views of the day, added to ROOM_PICTURE_VIEW_SAMPLE at a time by `RoomPictureStore.addViews`. */
export function roomPictureViewsKey(day: UtcDay): string {
  return `d:${day}:room:pic:views`;
}
/** Reports of the day, all wallets together. Deleted by `RoomPictureStore.clearPicturesOff` when an admin switches pictures on. */
export function roomPictureReportsKey(day: UtcDay): string {
  return `d:${day}:room:pic:reports`;
}
/** Pictures hidden by reports in one hour: written inside `RoomPictureStore.putReport`'s batch, and deleted by `clearPicturesOff` for the hour an admin switches pictures on in. */
export function roomPictureReportHidesKey(day: UtcDay, hour: number): string {
  return `d:${day}:room:pic:hid${String(hour).padStart(2, '0')}`;
}

// --- the plan's arithmetic -----------------------------------------------------------------------------

/**
 * D1 rows a call may write, for `spendWrite` and `requireWriter`: an index written counts as a row.
 *
 * A stored upload writes ELEVEN, and eleven are booked (revision 5; perf had counted eleven by D1's
 * `rows_written` where ten were booked). Statement by statement, on local D1, through the entry:
 * - 1: the wallet's write of the day (`users`), written by `spendWrite` itself;
 * - 1: the day's rows (`api_writes`), written by `spendWrite` itself;
 * - 1: the writer's row, the turn and the wallet's picture of the day in one UPDATE (`takePictureTurn`);
 * - 4: the room's four counts, one row each (`counters`, step 9);
 * - 4: the message (`putPicture`'s one INSERT): its row, the index of its author, the index of pictures
 *   with bytes, the sequence's row.
 * Two wallets, each its first upload and its second, wrote the same eleven, the upload that made the
 * two counts of pictures among them: an upload never makes the writer's row and never sets `first_at`.
 * Until revision 5 this comment counted nine by the tables and booked ten: the nine were
 * right, and the two rows that `spendWrite` writes for its own bookkeeping were counted nowhere.
 *
 * The same measurement, said so that the operator has it: a message of text writes 8 rows at its write (the
 * same two rows of `spendWrite` beside the six of its tables), and a wallet's first message 9, where
 * `ROOM_POST_WRITE_ROWS` books 7. That figure is the room's own contract's and is not changed here.
 */
export const ROOM_PICTURE_POST_WRITE_ROWS = 11;
/**
 * D1 rows the prune deletes of a picture message: its row, the index of its author, and the index of
 * pictures with bytes while the row still has its key. One more than of a message of text.
 */
export const ROOM_PICTURE_PRUNE_ROWS = 3;
/**
 * A counted report: its row, the reporter's row, the message's row, the room's reports of the day; and for
 * the report that hides, the index of reported pictures and the hour's count of hidden ones.
 */
export const ROOM_PICTURE_REPORT_WRITE_ROWS = 6;

/**
 * D1 rows a day the room may write beside the league's planned rows, Prix Live and Phase 6.2, and what a
 * message costs of them: the two figures of docs/contracts/phase-6-room.md section 10.
 */
export const ROOM_ROWS_PER_DAY = 5_700;
export const ROOM_ROWS_PER_MESSAGE = 9;
/**
 * D1 rows a day pictures can write at these caps, worst case, beyond the 9 a picture costs as the message
 * it is (ROOM_ROWS_PER_MESSAGE). For each picture: 5 more than that message (revision 5; 4 before): the
 * 11 it writes (ROOM_PICTURE_POST_WRITE_ROWS) and the 3 the prune deletes of it (ROOM_PICTURE_PRUNE_ROWS),
 * less the 9; and 5 if it is removed or kept (the block row, the index rows it leaves, the mark that its
 * bytes are gone, or the strikes). The views' samples and 50 for views under way when the cap is reached.
 * Every counted report at what it books, and its row at the prune. 2,150 at the defaults (60 pictures,
 * 20,000 views); 3,050 at 150 pictures; 3,450 at 150 pictures and 30,000 views.
 *
 * Not counted here (revision 4, a note of the third look): since revision 3 each "Pictures on" gives the
 * day another hundred counted reports. Their rows come out of what `requireWriter` books for each report
 * against the API's own day, which sign-in and edits share: no report writes a row that was not booked.
 */
export function roomPictureRowsWorst(picturesCap: number, viewsCap: number): number {
  const beyondAMessage = ROOM_PICTURE_POST_WRITE_ROWS + ROOM_PICTURE_PRUNE_ROWS - ROOM_ROWS_PER_MESSAGE;
  const pictures = picturesCap * (beyondAMessage + 5);
  const views = Math.ceil(viewsCap / ROOM_PICTURE_VIEW_SAMPLE) + 50;
  const reports = ROOM_PICTURE_REPORTS_PER_DAY * (ROOM_PICTURE_REPORT_WRITE_ROWS + 1);
  return pictures + views + reports;
}
/**
 * The room's cap of messages while pictures are on: `roomDailyCap` of ROOM_MESSAGES_PER_DAY, lowered so
 * that messages and pictures together stay inside ROOM_ROWS_PER_DAY. Since revision 5, of a cap of 400
 * messages: 394 at the defaults (60 pictures, 20,000 views); 294 at 150 pictures; 250 at 150 pictures
 * and 30,000 views; and the whole 400 while the day's pictures are at most 55 (at 20,000 views), which
 * covers the first two steps of the opening, 5 and 20. Before revision 5 the three figures were 400, 311
 * and 266: a picture is counted one row dearer now, and the room's share is not raised for it, so six
 * messages of the day give way at the default. The entry hands this to the room's routes as
 * `roomDailyCap` while `picturesEnabled` holds.
 */
export function roomDailyCapBesidePictures(messagesCap: number, picturesCap: number, viewsCap: number): number {
  const left = ROOM_ROWS_PER_DAY - roomPictureRowsWorst(picturesCap, viewsCap);
  const fits = Math.max(0, Math.floor(left / ROOM_ROWS_PER_MESSAGE));
  return Math.max(0, Math.min(messagesCap, fits, ROOM_MESSAGES_PER_DAY_MAX));
}

// --- what is stored ------------------------------------------------------------------------------------

/**
 * The text a picture message carries in `room_messages.text`: the contract's own word, never anything of
 * a request. A picture has no caption. The column and `roomMessageSchema.text` keep their rule (not
 * empty), so every reader of the table that is older than pictures still reads a valid message. A page
 * that knows pictures shows the picture's row and never this text.
 */
export const ROOM_PICTURE_TEXT = 'Picture';

/**
 * A picture's state. `ok`: as uploaded. `reported`: ROOM_PICTURE_REPORTS_TO_HIDE wallets reported it, the
 * public sees it no more, its bytes stay for the admins. `kept`: an admin looked and kept it; it is shown
 * and takes no more reports. `removed`: an admin hid its message or muted its writer; its bytes are
 * deleted and nothing brings it back.
 */
export const ROOM_PICTURE_STATES = ['ok', 'reported', 'kept', 'removed'] as const;
export type RoomPictureState = (typeof ROOM_PICTURE_STATES)[number];

/** The KV key of a picture: `pic/` and 32 hex characters of 16 random bytes. */
export const roomPictureKeySchema = z.string().regex(/^pic\/[0-9a-f]{32}$/);
/**
 * A new key, made by the server for every upload: never derived from the content, the wallet or the
 * message, never read before its row exists, and never in a response or a log line.
 */
export function newRoomPictureKey(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = (globalThis as unknown as { crypto: { getRandomValues(array: Uint8Array): Uint8Array } }).crypto;
  webCrypto.getRandomValues(bytes);
  let key = 'pic/';
  for (const byte of bytes) key += byte.toString(16).padStart(2, '0');
  return key;
}

/** SHA-256 of the stored bytes, lower-case hex. */
export const roomPictureSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** The picture of a message as it is stored: columns of the message's own row (migration 0013). */
export interface RoomPictureRecord extends RoomPictureFacts {
  /** The length of the stored bytes. */
  bytes: number;
  sha256: string;
  /** The KV key; null once Prix has deleted the bytes. The bytes of a key that is not null may still have expired. */
  key: string | null;
  state: RoomPictureState;
  /** Counted reports, at most ROOM_PICTURE_REPORTS_TO_HIDE. */
  reports: number;
  /** When an admin kept or removed it, and who. */
  decidedAt: IsoTime | null;
  decidedBy: Address | null;
  /** When Prix deleted the bytes from KV. */
  goneAt: IsoTime | null;
}

/** A message with its picture, or with none. */
export interface RoomPictureMessageRecord extends RoomMessageRecord {
  picture: RoomPictureRecord | null;
}

/** A writer's row with what pictures add to it. */
export interface RoomPictureWriterRecord extends RoomWriterRecord {
  /**
   * The time of the writer's first message that was stored and still counts; null while it has none. From
   * this phase on `RoomStore.putMessage` sets it, in the batch that stores a message of text, where it is
   * null, and makes the writer's row for it when there is none (an admin takes no turn and may have no
   * row); a turn that stored no message does not. The migration fills it from each writer's oldest
   * message that is not hidden (`AND hidden_at IS NULL`, revision 3), and leaves it null for a writer who
   * has none. `hideWithPicture` sets it back to null when the message it hides is the one that set it (its
   * `at` equals this time): a first line that an admin hid opens neither pictures nor reports, and the
   * writer's next stored message starts the wait again.
   */
  firstAt: IsoTime | null;
  picturesDay: UtcDay | null;
  picturesCount: number;
  reportsDay: UtcDay | null;
  reportsCount: number;
  reportStrikes: number;
  /** The writer's pictures that are `reported` now: hidden by reports and not yet decided. */
  reportedOpen: number;
}

/** Why pictures are off without a deploy: an admin's switch, or one of the two that set themselves. */
export const ROOM_PICTURES_OFF_REASONS = ['admin', 'reports_hour', 'reports_day'] as const;
export type RoomPicturesOffReason = (typeof ROOM_PICTURES_OFF_REASONS)[number];
/** The one row of `room_flags` this phase knows, `pictures_off`. `by` is null when it set itself. */
export interface RoomPicturesOff {
  at: IsoTime;
  by: Address | null;
  why: RoomPicturesOffReason;
}

export type RoomPictureTurnRefusal = RoomTurnRefusal | 'not_allowed' | 'new_writer' | 'paused' | 'picture_day';
export type RoomPictureTurn =
  | { ok: true; left: number; picturesLeft: number }
  | { ok: false; why: RoomPictureTurnRefusal };

/**
 * Why a writer's row refuses a picture at `now`, or null. First what refuses a message, in the order of
 * `roomTurnRefusal` (`muted`, `day`, `too_soon`); then `not_allowed` (the wallet was muted once: `cutAt` is
 * set, also after a lift); `new_writer` (no stored message yet, or the first one is younger than
 * ROOM_PICTURE_WRITER_AGE_SECONDS); `paused` (ROOM_REPORTED_PICTURES_PAUSE of its pictures are hidden by
 * reports and not decided); `picture_day` (the wallet's ROOM_PICTURES_PER_WALLET_PER_DAY). A wallet with
 * no row has no first message. The route asks it of `getUploader` before anything is spent, and the
 * store's `takePictureTurn` decides by the same order. A time that does not parse refuses.
 */
export function roomPictureTurnRefusal(
  writer: RoomPictureWriterRecord | null,
  now: IsoTime,
  day: UtcDay,
  /** Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2): the wallet's cap of messages of the day; a picture is a message. */
  dayCap: number = ROOM_MESSAGES_PER_WALLET_PER_DAY,
): RoomPictureTurnRefusal | null {
  const turn = roomTurnRefusal(writer, now, day, dayCap);
  if (turn !== null) return turn;
  return roomPictureRowRefusal(writer, now, day);
}

/**
 * The part of `roomPictureTurnRefusal` that is about pictures alone: what the writer's row says once the
 * room's own turn (`muted`, `day`, `too_soon`) is left out, in the same order as before (revision 8).
 * `roomPictureTurnRefusal` calls it, so an upload is judged exactly as it was. It is exported for `me`,
 * which must not let a wait of the room hide it: in the seconds after a wallet's first message the turn
 * answers `too_soon`, and a page that read that wait as "may add a picture" offered the picker to a wallet
 * whose first message was seconds old (seen on production in the first minute a wallet wrote, 2026-10-12;
 * the upload refused it, as it must).
 */
export function roomPictureRowRefusal(
  writer: RoomPictureWriterRecord | null,
  now: IsoTime,
  day: UtcDay,
): Extract<RoomPictureTurnRefusal, 'new_writer' | 'not_allowed' | 'paused' | 'picture_day'> | null {
  if (writer === null) return 'new_writer';
  if (writer.cutAt !== null) return 'not_allowed';
  if (writer.firstAt === null) return 'new_writer';
  if (!(Date.parse(now) - Date.parse(writer.firstAt) >= ROOM_PICTURE_WRITER_AGE_SECONDS * 1_000)) return 'new_writer';
  if (writer.reportedOpen >= ROOM_REPORTED_PICTURES_PAUSE) return 'paused';
  if (writer.picturesDay === day && writer.picturesCount >= ROOM_PICTURES_PER_WALLET_PER_DAY) return 'picture_day';
  return null;
}

/** What is left of a wallet's pictures on `day`, from its row as it stands. */
export function roomPicturesLeft(writer: RoomPictureWriterRecord | null, day: UtcDay): number {
  const made = writer !== null && writer.picturesDay === day ? writer.picturesCount : 0;
  return Math.max(0, ROOM_PICTURES_PER_WALLET_PER_DAY - made);
}

export type RoomPictureReporterRefusal = 'muted' | 'not_allowed' | 'new_writer' | 'struck';
/**
 * Why a wallet's row lets it report no picture at all at `now`, or null: `muted`; `not_allowed` (muted
 * once: `cutAt` is set, also after a lift); `new_writer` (no stored message yet, or the first one is younger
 * than ROOM_PICTURE_REPORTER_AGE_SECONDS, a day: longer than the hour an upload waits); `struck`
 * (ROOM_PICTURE_REPORT_STRIKES strikes). A wallet with no row has no first message. A reader who never
 * wrote cannot report: that is the price of making a report cost a message and a day. `me` asks this
 * function alone for its `report`. A time that does not parse refuses.
 */
export function roomPictureReporterRefusal(
  reporter: RoomPictureWriterRecord | null,
  now: IsoTime,
): RoomPictureReporterRefusal | null {
  if (reporter === null) return 'new_writer';
  if (reporter.mutedAt !== null) return 'muted';
  if (reporter.cutAt !== null) return 'not_allowed';
  if (reporter.firstAt === null) return 'new_writer';
  if (!(Date.parse(now) - Date.parse(reporter.firstAt) >= ROOM_PICTURE_REPORTER_AGE_SECONDS * 1_000)) {
    return 'new_writer';
  }
  if (reporter.reportStrikes >= ROOM_PICTURE_REPORT_STRIKES) return 'struck';
  return null;
}

export type RoomPictureReportRefusal = RoomPictureReporterRefusal | 'already' | 'own' | 'report_day';
/**
 * Why a wallet's report of one picture is not counted, or null, in this ONE order (revision 2: `already`
 * has its place in it). First the wallet's own row, by `roomPictureReporterRefusal`: `muted`, `not_allowed`,
 * `new_writer`, `struck`. Then `already` (`lookReport` found a report of this picture by this wallet),
 * `own` (the picture's writer) and `report_day` (the wallet's ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY).
 *
 * `struck` and `already` are not refusals a client sees: the route answers 204 for both and writes
 * nothing, so that a struck wallet does not learn it, and a second report reads as the first did. So a
 * wallet that reported a picture before and has since reached its day's cap is answered 204 for that
 * picture, and 429 `report_wallet_day` for any other. The route asks this of `lookReport`'s answer before
 * anything is spent, and the store's `putReport` decides by the same order inside its statements.
 */
export function roomPictureReportRefusal(
  reporter: RoomPictureWriterRecord | null,
  author: Address,
  already: boolean,
  now: IsoTime,
  day: UtcDay,
): RoomPictureReportRefusal | null {
  const own = roomPictureReporterRefusal(reporter, now);
  if (own !== null) return own;
  // `roomPictureReporterRefusal` answers `new_writer` for no row, so there is one here.
  if (reporter === null) return 'new_writer';
  if (already) return 'already';
  if (reporter.address.toLowerCase() === author.toLowerCase()) return 'own';
  if (reporter.reportsDay === day && reporter.reportsCount >= ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY) {
    return 'report_day';
  }
  return null;
}

// --- the stores ----------------------------------------------------------------------------------------

/** What the gate hands the bytes route: where the bytes are and what the server itself wrote of them. Never anything of the upload. */
export interface RoomServablePicture {
  key: string;
  type: RoomPictureType;
  bytes: number;
  /**
   * The writer's whole address, for one question and nothing else: a picture whose writer is an admin
   * wallet now (a wallet that uploaded before it became one) is not served, so that no picture ever
   * stands under Prix's mark. It leaves the server in no response and no log line.
   */
  author: Address;
}

/** The room's four counts as they stand, with the switch that needs no deploy. */
export interface RoomPictureCounts {
  off: RoomPicturesOff | null;
  hour: number;
  day: number;
  pictureHour: number;
  pictureDay: number;
}

/** What `putPicture` is given: every field is the server's. */
export interface RoomPictureInput extends RoomPictureFacts {
  author: Address;
  now: IsoTime;
  key: string;
  /** The length of the bytes `roomPictureCheck` handed back, which is what KV holds. */
  bytes: number;
  sha256: string;
}

/**
 * `apps/api/src/store/room-pictures.ts` exports `createRoomPictureStore(db)`. Every method is one D1 call
 * or one D1 batch, and every rule is a condition inside a statement, so that two requests at once cannot
 * both pass. Migration `infra/migrations/0013_room_pictures.sql` (the contract's section 2 gives its
 * statements). No method runs in a D1 session: every statement is answered by the primary.
 *
 * No method reads or writes KV: the routes and the sweep job do, after a method of this store has said
 * that they may.
 */
export interface RoomPictureStore {
  /**
   * The public read while pictures are on, in one batch: the messages `RoomStore.listNewest` answers
   * (among the newest `scan` ids, at most `limit`, none hidden, none of a writer who is muted now, none at
   * or before its writer's `cutAt`), each with its picture; the `pictures_off` row; and the views counted
   * under `viewsKey`. It reads at most twice `scan` rows and two more, and never a row of
   * `room_picture_reports` or `room_picture_blocks`.
   */
  readRoom(
    limit: number,
    scan: number,
    viewsKey: string,
  ): Promise<{ messages: RoomPictureMessageRecord[]; off: RoomPicturesOff | null; views: number }>;
  /**
   * THE GATE of the bytes route, in one statement of at most five rows (the message by its key, its
   * writer by its key, the newest id, the `pictures_off` row, the views' counter). `picture` is null
   * unless ALL of these hold: the message has a picture in state `ok` or `kept`; its key is not null; the
   * message is not hidden; its writer is not muted now; it was written after its writer's `cutAt`; its id
   * is above the newest id less `scan`; it was written after `now` less ROOM_PICTURE_TTL_SECONDS; there is
   * no `pictures_off` row. `views` is the day's count whatever `picture` is. It must not read KV, the
   * reports or the blocks, and must not say which condition failed.
   */
  getServable(
    id: number,
    scan: number,
    now: IsoTime,
    viewsKey: string,
  ): Promise<{ picture: RoomServablePicture | null; views: number }>;
  /**
   * Adds `add` to the views of the day in one statement, making the counter's row when there is none, and
   * answers the count after it (the statement's own RETURNING, never a second read). The route logs
   * `room_picture_views_cap` when that count has reached the cap and the count less `add` had not: once a
   * day, by the one request whose sample crossed it.
   */
  addViews(viewsKey: string, add: number, now: IsoTime): Promise<number>;
  /**
   * What an admin may look at, in one statement: a picture in state `ok`, `kept` or `reported` whose key
   * is not null and whose message was written after `now` less ROOM_PICTURE_TTL_SECONDS. A removed picture
   * and the picture of a hidden message are null: their bytes are deleted. Not bound by `scan` nor by
   * `pictures_off`: a reported picture is decided while pictures are off. The route answers the generic
   * 404 for a picture whose writer is an admin wallet now, as the public route does: an admin removes it
   * without looking.
   */
  getAdminPicture(id: number, now: IsoTime): Promise<RoomServablePicture | null>;

  /** A writer's row with what pictures add, and the count of its pictures that are `reported` now, in one statement. */
  getUploader(address: Address): Promise<RoomPictureWriterRecord | null>;
  /**
   * The `pictures_off` row and the room's four counts as they stand, read and not taken, in one statement
   * (five seeks: the flag, and the counters of `roomHourKey`, `roomDayKey`, `roomPictureHourKey` and
   * `roomPictureDayKey`). A key with no row counts 0.
   */
  getPictureCounts(keys: {
    hour: string;
    day: string;
    pictureHour: string;
    pictureDay: string;
  }): Promise<RoomPictureCounts>;
  /**
   * True when these bytes were removed by an admin before: one seek of `room_picture_blocks`. The upload
   * asks it only after `takePictureTurn` (step 8), so that the question costs the wallet a turn and one of
   * its pictures of the day: three answers a wallet a day, not twenty a minute.
   */
  isBlocked(sha256: string): Promise<boolean>;
  /**
   * A writer's turn for a picture, as one batch: a write that counts the message's turn (as
   * `RoomStore.takeTurn` does) and the wallet's picture of the day, both or neither, only when
   * `roomPictureTurnRefusal` would answer null for the row as it stands; then a read of the row. A refusal
   * writes nothing and names its reason from the row, in that function's order. Whether the turn was
   * counted is what the write changed, never a second judgement of the row read after it. A wallet with no
   * row is refused as `new_writer` and gets no row.
   *
   * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2): `dayCap` (ROOM_MESSAGES_PER_WALLET_PER_DAY
   * when left out) is the bound of the same one statement where the SQL had 30; ok answers
   * `left: max(0, dayCap − count)`, and a refusal is named with `roomPictureTurnRefusal(record, now, day, dayCap)`.
   */
  takePictureTurn(address: Address, now: IsoTime, day: UtcDay, dayCap?: number): Promise<RoomPictureTurn>;
  /**
   * Stores a picture message, as one batch: one INSERT that makes the message and its picture together
   * (the picture is columns of the message's row, so there is never one without the other), with
   * ROOM_PICTURE_TEXT as its text and state `ok`, only while the writer is not muted and there is no
   * `pictures_off` row; then a read that says which of the two refused. A refusal writes nothing.
   */
  putPicture(
    input: RoomPictureInput,
  ): Promise<{ ok: true; message: RoomPictureMessageRecord } | { ok: false; why: 'muted' | 'off' }>;

  /**
   * What the report route looks at, in one statement and without writing: whether the picture is one the
   * public may see now and may report (the gate's own conditions, with the state `ok` alone: a `kept` and
   * a `reported` picture take no report), its writer's address, whether this wallet reported it before,
   * and the reporter's row. Null when no message has that id or it has no picture.
   *
   * The store cannot know who is an admin, so the route asks one thing more of the answer (revision 3): a
   * picture whose writer (`author`) is an admin wallet now is the generic 404, as one that is not `open`
   * is. The read shows it as gone and no bytes route serves it, so no report of it is counted.
   */
  lookReport(
    id: number,
    reporter: Address,
    scan: number,
    now: IsoTime,
  ): Promise<{ open: boolean; author: Address; already: boolean; reporter: RoomPictureWriterRecord | null } | null>;
  /**
   * A report, as one batch, each write under every condition `lookReport` only looked at, judged again
   * inside the statement with the same `scan` and `now`: the picture is `open` (the gate's own conditions,
   * the newest `scan` ids among them, with the state `ok` alone), and `roomPictureReportRefusal` would
   * answer null for the reporter's row as it stands (not muted, never muted, a first message
   * ROOM_PICTURE_REPORTER_AGE_SECONDS old, fewer than ROOM_PICTURE_REPORT_STRIKES strikes, no report of
   * this picture by this wallet yet, not the picture's writer, the day's count below its cap). The writes:
   * the report's row (one a wallet a picture: its primary key is what makes two reports sent at once count
   * once); the reporter's count of the day; the picture's count, and the state `reported` when it reaches
   * ROOM_PICTURE_REPORTS_TO_HIDE; then, when this report hid the picture, one more on the counter
   * `hidesKey`, and the `pictures_off` row with `reports_hour` when that counter has reached
   * ROOM_PICTURE_AUTO_OFF_REPORTED. A report that is not counted writes nothing. It deletes no byte and no
   * row. `counted`: the report's row was written by this call (what the insert changed, never a second
   * judgement). `hid`: this report hid the picture. `off`: this report switched pictures off. It does not
   * touch the room's count of reports of the day: the route takes that, after this call and only when
   * `counted` is true.
   */
  putReport(
    id: number,
    reporter: Address,
    scan: number,
    now: IsoTime,
    day: UtcDay,
    hidesKey: string,
  ): Promise<{ counted: boolean; hid: boolean; off: boolean }>;

  /**
   * Hides a message for good (as `RoomStore.hideMessage`) and, when it has a picture that is not removed
   * yet, removes the picture in the same batch, whether or not the message was hidden already: state
   * `removed`, who and when, and a row of `room_picture_blocks` with its SHA-256 and the record of the
   * removal (the writer's whole address, when it was posted, its type, size and dimensions and its count
   * of reports; never a reporter's address); a block row that is there for the same bytes stays as it is.
   *
   * In the same batch, two more writes. A picture whose message is ROOM_PICTURE_TTL_SECONDS old at `now`
   * gives up its key at once, with `pic_gone_at`, and no KV call follows: its bytes have expired or are
   * about to, and D1 refuses it already. And the writer's `first_at` is set to null when the hidden
   * message is the one that set it (its `at` equals `first_at`), for a message of text and for a picture
   * alike.
   *
   * `key` is the KV key the caller must delete now, null when the message has no picture, its bytes are
   * deleted already, or its key was given up in this batch. A message that was hidden before still
   * answers its key while it has one: a second hide tries the delete again. `removed`: this call set a
   * picture to `removed`. `reports`: that picture's count of reports, 0 when `removed` is false; the audit
   * line of the removal carries it.
   */
  hideWithPicture(
    id: number,
    by: Address,
    now: IsoTime,
  ): Promise<{ outcome: 'hidden' | 'already' | 'none'; key: string | null; removed: boolean; reports: number }>;
  /**
   * Mutes a writer (as `RoomStore.muteWriter`) and, in the same batch and whether or not the writer was
   * muted already, sets every picture of the writer that is not `removed` to `removed`, and gives up, with
   * `pic_gone_at` and no KV call, the key of each of the writer's pictures whose message is
   * ROOM_PICTURE_TTL_SECONDS old at `now`. `pictures` are the writer's pictures that still have a key
   * after that, newest first, at most `limit`, for the caller to delete now: all of them are younger than
   * seven days, so there are at most ROOM_PICTURE_DELETES_PER_CALL. `removed`: how many pictures this
   * call set to `removed`. The mute is audited when `muted` is true or `removed` is above 0. It writes no
   * block row: a mute judges a writer, not a picture.
   */
  muteWithPictures(
    address: Address,
    by: Address,
    now: IsoTime,
    limit: number,
  ): Promise<{ muted: boolean; removed: number; pictures: { id: number; key: string }[] }>;
  /**
   * After KV's delete answered: sets the key of these messages' pictures to null and `pic_gone_at` to
   * `now`, in one statement. At most ROOM_PICTURE_DELETES_PER_CALL ids. `pic_gone_at` is the time a key
   * was set to null: by this call, or by a removal that gave up the key of an expired picture. `now` is the
   * caller's one clock: the route's, or for the sweep the run's own (revision 5).
   *
   * BOUND TO THE STATE `removed`, inside the statement (revision 6, S2: `AND pic_state = 'removed'`). An id
   * whose picture is in any other state is left as it is: its key and its row do not change, and the call
   * does not throw. Without the bound, the id of a live picture would lose its key while its row stayed
   * `ok`: the public would read "gone" and the sweep would be owed nothing, so the bytes would sit until
   * their expiry. No honest caller needs otherwise: the hide, the mute and the sweep each pass ids the store
   * has just answered as removed. An id with no message, or whose key is null already, changes nothing
   * either.
   */
  markGone(ids: readonly number[], now: IsoTime): Promise<void>;
  /**
   * An admin keeps a picture, as one batch: state `kept` from `ok` or `reported`, who and when, and one
   * strike for every wallet that reported it. `kept` when it did, `already` when it was kept, `none` when
   * no message has that id, it has no picture, or the picture is removed. The route answers 204 for `kept`
   * and for `already` and the generic 404 for `none`; it audits `kept` alone (revision 3): `already`
   * changed nothing.
   */
  keepPicture(id: number, by: Address, now: IsoTime): Promise<'kept' | 'already' | 'none'>;
  /**
   * Pictures whose bytes Prix still owes a delete: state `removed` with a key, newest first, at most
   * `limit`. One statement over a partial index: a run with nothing owed reads at most one row (revision
   * 5: local D1 reports the seek that found nothing as a row read). Every one of them
   * was younger than ROOM_PICTURE_TTL_SECONDS when it was removed (a removal gives up an older key
   * itself), so the list holds only what a KV delete failed for; one that has aged since is still tried,
   * and KV answers a delete of a key it no longer has as a delete.
   */
  listOwedDeletes(limit: number): Promise<{ id: number; key: string }[]>;

  /**
   * Every message below `before` for the admins' page, as `RoomStore.listAllMessages` answers it, each
   * with its picture. One statement.
   */
  listAllWithPictures(
    before: number | null,
    limit: number,
  ): Promise<(RoomPictureMessageRecord & { muted: boolean; cut: boolean })[]>;
  /**
   * The pictures that are `reported` now, oldest first, at most `limit`, each with the wallets that
   * reported it and when. One batch of two statements over the partial index of reported pictures.
   */
  listReported(
    limit: number,
  ): Promise<(RoomPictureMessageRecord & { reporters: { address: Address; at: IsoTime }[] })[]>;

  getPicturesOff(): Promise<RoomPicturesOff | null>;
  /** Makes the `pictures_off` row unless there is one: the first reason stays. False when pictures were off already. */
  setPicturesOff(by: Address | null, why: RoomPicturesOffReason, now: IsoTime): Promise<boolean>;
  /**
   * Switches pictures on, as one batch (revision 3): deletes the `pictures_off` row and, only when there
   * was one, the two counters that set it by themselves: the room's reports of the day (`reportsKey`,
   * `roomPictureReportsKey(day)`) and the pictures hidden by reports in this hour (`hidesKey`,
   * `roomPictureReportHidesKey(day, hour)`), both of the route's `now`. So switching pictures on gives the
   * room its day's reports and its hour's hides again: with either count left full, the next counted
   * report would have switched pictures off again, each time, until 00:00 UTC or the hour's end. False
   * when there was no row: then no counter is deleted either, and the route audits nothing.
   *
   * The order inside the batch decides (revision 4): the two counters' delete first, conditional on the
   * row being there (`AND EXISTS (SELECT 1 FROM room_flags WHERE name = 'pictures_off')`), then the row's,
   * whose change is the answer. After the row's delete the condition is never true, and the counts stay.
   */
  clearPicturesOff(reportsKey: string, hidesKey: string): Promise<boolean>;
}

/**
 * The bytes, over the KV namespace bound as ROOM_PICTURES: `apps/api/src/store/room-picture-bytes.ts`
 * exports `createRoomPictureBytes(kv)`, where `kv` is the binding or undefined. KV holds bytes and decides
 * nothing. The port has no list, no metadata and no put without an expiry, so that no builder can reach
 * for one. With no binding (the namespace is the founder's to create, after the build) every method throws, and
 * each caller does what it does when KV fails: the upload answers `picture_storage`, a bytes route 503, a
 * hide and a mute still answer 204 and leave the delete owed, the sweep fails its run. Nothing is skipped
 * in silence.
 */
export interface RoomPictureBytes {
  /**
   * `kv.put(key, <an ArrayBuffer of exactly these bytes>, { expirationTtl: ttlSeconds })`. Always
   * ROOM_PICTURE_TTL_SECONDS: that expiry bounds the storage, removes a key no row names without a list
   * call, and makes a failed delete harmless.
   */
  put(key: string, bytes: Uint8Array, ttlSeconds: number): Promise<void>;
  /** `kv.get(key, 'arrayBuffer')`. Null when KV has none. Called only after `getServable` or `getAdminPicture` answered this key. */
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

// --- the API -------------------------------------------------------------------------------------------

// ROOM_PICTURES_PATH, `roomPicturePath`, `roomPictureReportPath`, `roomPictureAdminPath` and
// `roomPictureIdOf` are in room-picture.ts: a browser script builds the addresses.

/**
 * A picture as a page shows it: what the server itself read of the file, and one of three states.
 * `shown`: a click may load it. `reported`: hidden after reports until an admin decides. `gone`: its seven
 * days are over, or its bytes are served no more (its writer is an admin wallet now, or its key is gone);
 * the message stays, and the page's sentence for it names no reason. Never a key, a hash, a count of
 * reports or a URL.
 */
export const roomPictureViewSchema = z.strictObject({
  type: z.enum(ROOM_PICTURE_TYPES),
  width: z.number().int().min(ROOM_PICTURE_MIN_SIDE).max(ROOM_PICTURE_MAX_SIDE),
  height: z.number().int().min(ROOM_PICTURE_MIN_SIDE).max(ROOM_PICTURE_MAX_SIDE),
  bytes: z.number().int().min(ROOM_PICTURE_MIN_BYTES).max(ROOM_PICTURE_MAX_BYTES),
  /** More than 1: an animated GIF. */
  frames: z.number().int().min(1).max(ROOM_PICTURE_MAX_FRAMES),
  state: z.enum(['shown', 'reported', 'gone']),
});
export type RoomPictureView = z.infer<typeof roomPictureViewSchema>;

/**
 * A stored picture as the public read shows it at `now`, for a message that read already let through.
 * `reported` while it is; `shown` while it is `ok` or `kept`, has a key, is younger than
 * ROOM_PICTURE_TTL_SECONDS and its writer is no admin wallet now (`admin`: the mark the read computes for
 * the message); `gone` otherwise. It says of a picture exactly what `getServable` and the bytes route
 * would, the `pictures_off` row and the views aside: those are the read's own `pictures` field.
 */
export function roomPictureView(
  picture: RoomPictureRecord,
  at: IsoTime,
  now: IsoTime,
  admin: boolean,
): RoomPictureView {
  const young = Date.parse(now) - Date.parse(at) < ROOM_PICTURE_TTL_SECONDS * 1_000;
  const shown = (picture.state === 'ok' || picture.state === 'kept') && picture.key !== null && young && !admin;
  return {
    type: picture.type,
    width: picture.width,
    height: picture.height,
    bytes: picture.bytes,
    frames: picture.frames,
    state: picture.state === 'reported' ? 'reported' : shown ? 'shown' : 'gone',
  };
}

/**
 * A message as a page shows it from Phase 6.4 on. `picture` is absent in an answer of an API older than
 * pictures and while pictures are not enabled, null for a message of text, and set for a picture message,
 * whose `text` is then ROOM_PICTURE_TEXT and is not shown.
 */
export const roomPictureMessageSchema = roomMessageSchema.extend({
  picture: roomPictureViewSchema.nullable().optional(),
});
export type RoomPictureMessage = z.infer<typeof roomPictureMessageSchema>;

/**
 * GET /api/social/room from Phase 6.4 on: `roomResponseSchema` with pictures. `pictures` is absent while
 * pictures are not enabled. `on`: a page may offer "Show picture". `off`: the `pictures_off` row is set.
 * `resting`: the day's views have reached the cap, until 00:00 UTC. Both new fields are optional because
 * the site is deployed before the API.
 */
export const roomWithPicturesResponseSchema = roomResponseSchema.extend({
  messages: z.array(roomPictureMessageSchema).max(ROOM_PAGE),
  pictures: z.enum(['on', 'off', 'resting']).optional(),
});
export type RoomWithPicturesResponse = z.infer<typeof roomWithPicturesResponseSchema>;

/**
 * GET /api/social/room/me from Phase 6.4 on. The three new fields are absent while pictures are not
 * enabled. `picture` is judged by `roomPictureRowRefusal`, the pictures' own part of the rule, never by a
 * wait of the room (revision 8): `yes` when it answers null or `picture_day` (a wait of pictures, which the
 * upload says); `new_writer` when that is its answer; `no` for `not_allowed` and `paused`; `admin` for an
 * admin wallet, which cannot upload; `no` whenever `write` is not `yes`. The room's own waits (`day`,
 * `too_soon`) change nothing here: a wallet that must wait twenty seconds for its next message is told of
 * pictures what its row says, so a wallet whose first message is seconds old reads `new_writer`.
 * `picturesLeft` is the wallet's pictures left today, 0 unless `picture` is `yes`. `report`: the wallet's row
 * would let it report another wallet's picture now (`roomPictureReporterRefusal` answers null or `struck`:
 * a struck wallet is told true, so that it does not learn it; the day's cap of reports is not asked here,
 * the report says so); false for an admin and whenever `write` is not `yes`. `yes` cannot know that
 * pictures are off, resting or full: the room's read and the upload say so. No field carries a time: the
 * sentence for `new_writer` says the rule (ROOM_PICTURE_LIMITS.writerAgeMinutes after the first message),
 * not the minute.
 */
export const roomMeWithPicturesResponseSchema = roomMeResponseSchema.extend({
  picture: z.enum(['yes', 'no', 'admin', 'new_writer']).optional(),
  picturesLeft: amountSchema.optional(),
  report: z.boolean().optional(),
});
export type RoomMeWithPicturesResponse = z.infer<typeof roomMeWithPicturesResponseSchema>;

/**
 * POST /api/social/room/pictures, a session. The body is the file's bytes and nothing else, with
 * `Content-Type: application/octet-stream` exactly (ROOM_PICTURE_UPLOAD_CONTENT_TYPE, room-picture.ts) and a
 * `Content-Length`: no JSON, no form, no file name, no claimed type, no caption. The answer carries the
 * message as it was stored.
 */
export const roomPicturePostResponseSchema = z.strictObject({
  message: roomPictureMessageSchema,
  /** What is left of the wallet's messages today, and of its pictures. */
  left: amountSchema,
  picturesLeft: amountSchema,
});
export type RoomPicturePostResponse = z.infer<typeof roomPicturePostResponseSchema>;

/**
 * The refusals of pictures, each `invalid_input` (no new error code) with the field named here and the
 * status beside it. The page has one sentence for each. An upload also answers the room's own `not_holder`,
 * `gate_off`, `muted`, `too_soon`, `wallet_day`, `room_hour` and `room_day` (ROOM_REFUSALS), and a refusal
 * of the guard or of `requireWriter` keeps its own code.
 */
export const ROOM_PICTURE_REFUSALS = {
  ...(Object.fromEntries(ROOM_PICTURE_PROBLEMS.map((problem) => [`picture_${problem}`, 400])) as Record<
    `picture_${(typeof ROOM_PICTURE_PROBLEMS)[number]}`,
    400
  >),
  /** These bytes were removed by an admin before. Answered at step 8 of the upload: the turn and the wallet's picture of the day are spent. */
  picture_blocked: 403,
  /** An admin wallet does not upload and does not report: Prix never posts a picture here. */
  picture_admin: 403,
  /** The wallet has no stored message yet, or its first one is younger than ROOM_PICTURE_WRITER_AGE_SECONDS. */
  picture_new_writer: 403,
  /** The wallet was muted once. A lift gives back writing, not pictures. */
  picture_not_allowed: 403,
  /** ROOM_REPORTED_PICTURES_PAUSE of the wallet's pictures are hidden by reports and not decided. */
  picture_paused: 403,
  /** The `pictures_off` row is set. */
  pictures_off: 403,
  /** The wallet's ROOM_PICTURES_PER_WALLET_PER_DAY. */
  picture_wallet_day: 429,
  /** The room's ROOM_PICTURES_PER_HOUR. */
  picture_room_hour: 429,
  /** The room's pictures of the day. */
  picture_room_day: 429,
  /** The bytes route: the day's views have reached the cap. No page shows a sentence for it (`RoomPictureSentenceField`). */
  picture_views_day: 429,
  /** KV refused the put. The turn and the counts stay spent. */
  picture_storage: 503,
  /** A report of the wallet's own picture. */
  report_own: 400,
  /** A report by a wallet with no stored message yet, or whose first one is younger than ROOM_PICTURE_REPORTER_AGE_SECONDS. */
  report_new_writer: 403,
  /** The wallet's ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY. */
  report_wallet_day: 429,
} as const;
export type RoomPictureRefusalField = keyof typeof ROOM_PICTURE_REFUSALS;
/**
 * The refusals a page has a sentence for: all but `picture_views_day`, which only the bytes route answers,
 * to an `<img>`, whose error carries no status. The page's one sentence for a picture that did not load
 * (`social.roomPictureLoadFailed`) covers it, and the room's read says `resting` on the next load. A page's
 * map of sentences is typed `Record<RoomPictureSentenceField, string>`, so that the compiler finds a gap.
 */
export type RoomPictureSentenceField = Exclude<RoomPictureRefusalField, 'picture_views_day'>;

/** The field of each refusal of a picture's turn: the room's own for the three a message has, a picture's for the rest. */
export const ROOM_PICTURE_TURN_FIELDS = {
  muted: 'muted',
  day: 'wallet_day',
  too_soon: 'too_soon',
  not_allowed: 'picture_not_allowed',
  new_writer: 'picture_new_writer',
  paused: 'picture_paused',
  picture_day: 'picture_wallet_day',
} as const satisfies Record<RoomPictureTurnRefusal, RoomPictureRefusalField | RoomWaitField | 'muted'>;

/**
 * The field of each refusal of a report. `struck` and `already` have none: each is answered 204 and
 * counted nowhere. `new_writer` has a field of its own here, because a reporter waits a day and an
 * uploader an hour, and one sentence cannot say both.
 */
export const ROOM_PICTURE_REPORT_FIELDS = {
  muted: 'muted',
  not_allowed: 'picture_not_allowed',
  new_writer: 'report_new_writer',
  own: 'report_own',
  report_day: 'report_wallet_day',
} as const satisfies Record<Exclude<RoomPictureReportRefusal, 'struck' | 'already'>, RoomPictureRefusalField | 'muted'>;

/** The refusals of pictures that carry `Retry-After`, in whole seconds, from `roomPictureRetryAfterSeconds`. */
export type RoomPictureWaitField =
  | 'picture_wallet_day'
  | 'picture_room_hour'
  | 'picture_room_day'
  | 'picture_views_day'
  | 'picture_storage'
  | 'report_wallet_day';
/**
 * `Retry-After` of `picture_storage`, and of the bytes routes when KV or the views' count throws. That 503
 * of a bytes route is the API's error shape with the code `internal` and a null field (as the room's own
 * 503 of a read under way is), with `Cache-Control: no-store`: it is no refusal of ROOM_PICTURE_REFUSALS
 * and no new error code. The other answers of a bytes route that are not a 200: the generic 404
 * (`not_found`), 429 `rate_limited` (the limiter's own), and 429 `invalid_input` with the field
 * `picture_views_day`.
 */
export const ROOM_PICTURE_STORAGE_RETRY_SECONDS = 60;
export const ROOM_PICTURE_BYTES_RETRY_SECONDS = 5;
export const ROOM_PICTURE_BYTES_FAILURE_CODE = 'internal' satisfies ApiErrorCode;
/** The time to the next full UTC hour for `picture_room_hour`; to the next 00:00 UTC for the four of a day; ROOM_PICTURE_STORAGE_RETRY_SECONDS for `picture_storage`. */
export function roomPictureRetryAfterSeconds(field: RoomPictureWaitField, now: IsoTime): number {
  if (field === 'picture_storage') return ROOM_PICTURE_STORAGE_RETRY_SECONDS;
  return roomRetryAfterSeconds(field === 'picture_room_hour' ? 'room_hour' : 'room_day', now, null);
}

/** What a 200 of the bytes routes says its bytes are: from the stored type, through this table, and from nothing else. */
export const ROOM_PICTURE_CONTENT_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
} as const satisfies Record<RoomPictureType, string>;
export const ROOM_PICTURE_EXTENSIONS = {
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
} as const satisfies Record<RoomPictureType, string>;

/**
 * THE WHOLE header set of a 200 of the two bytes routes. The route sends exactly these and a test compares
 * the full list, not single headers. Nothing of them comes from the upload or from KV. Never sent: ETag,
 * Last-Modified, Vary, Set-Cookie, any Access-Control header. A Range or a conditional header of the
 * request is ignored: never 206, never 304.
 *
 * `nosniff` and the type from the table: no browser guesses. The policy with `sandbox`: opened as a
 * document, the bytes run nothing. `attachment`: an `<img>` ignores it, and a navigation to the address
 * downloads a file and never shows a picture full-window under Prix's address. `same-origin`: no other
 * site embeds it. `no-store`: no cache holds a picture that an admin then removes.
 */
export function roomPictureHeaders(id: number, type: RoomPictureType, bytes: number): Record<string, string> {
  return {
    'Content-Type': ROOM_PICTURE_CONTENT_TYPES[type],
    'Content-Length': String(bytes),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Content-Disposition': `attachment; filename="prix-chat-${id}.${ROOM_PICTURE_EXTENSIONS[type]}"`,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, noimageindex, noarchive',
    'Accept-Ranges': 'none',
  };
}
/** The two headers a request for bytes must carry, each with exactly this value: an `<img>` on Prix's own page sends both. */
export const ROOM_PICTURE_FETCH_HEADERS = { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image' } as const;

/** A picture as the admins' page lists it. Never the key. */
export const roomAdminPictureSchema = z.strictObject({
  type: z.enum(ROOM_PICTURE_TYPES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  frames: z.number().int().positive(),
  /** The first 12 hex characters of the SHA-256 of the stored bytes. */
  sha256Short: z.string().regex(/^[0-9a-f]{12}$/),
  state: z.enum(ROOM_PICTURE_STATES),
  reports: amountSchema,
  /** An admin can still look at it: `getAdminPicture` would answer it now, and its writer is no admin wallet now. */
  viewable: z.boolean(),
  /** Prix has deleted the bytes from KV. False for a removed picture means that the delete is still owed. */
  bytesGone: z.boolean(),
});
export type RoomAdminPicture = z.infer<typeof roomAdminPictureSchema>;

/** GET /api/social/admin/room?before=<id> from Phase 6.4 on: `roomAdminResponseSchema` with each message's picture. */
export const roomAdminPictureMessageSchema = roomAdminMessageSchema.extend({
  picture: roomAdminPictureSchema.nullable().optional(),
});
export const roomAdminWithPicturesResponseSchema = roomAdminResponseSchema.extend({
  messages: z.array(roomAdminPictureMessageSchema).max(ROOM_PAGE),
});
export type RoomAdminWithPicturesResponse = z.infer<typeof roomAdminWithPicturesResponseSchema>;

/**
 * GET /api/social/admin/room/pictures, an admin session; the generic 404 to anyone else. Never cached.
 * Whether pictures are off and why, and the pictures that wait for a decision, oldest first, with the
 * whole addresses of the writer and of the wallets that reported each.
 */
export const roomPicturesAdminResponseSchema = z.strictObject({
  off: z
    .strictObject({ at: isoTimeSchema, by: addressSchema.nullable(), why: z.enum(ROOM_PICTURES_OFF_REASONS) })
    .nullable(),
  reported: z
    .array(
      z.strictObject({
        id: z.number().int().positive(),
        at: isoTimeSchema,
        author: addressSchema,
        picture: roomAdminPictureSchema,
        reporters: z
          .array(z.strictObject({ address: addressSchema, at: isoTimeSchema }))
          .max(ROOM_PICTURE_REPORTS_TO_HIDE),
      }),
    )
    .max(ROOM_PICTURE_REPORTED_SHOWN),
  /** There are more reported pictures than ROOM_PICTURE_REPORTED_SHOWN. */
  more: z.boolean(),
});
export type RoomPicturesAdminResponse = z.infer<typeof roomPicturesAdminResponseSchema>;

/**
 * The admin's writes that are new, each audited with these names, only when it changed something: PUT
 * /admin/room/pictures/:id/keep with the message's id as its target; PUT and DELETE
 * /admin/room/pictures/off with the target `pictures`. Revision 3 says both out: a keep is audited when
 * `keepPicture` answered `kept`, never for `already`; a switch when `setPicturesOff` or `clearPicturesOff`
 * answered true. A removal is the room's own hide and a mute is the room's own mute, audited as
 * ROOM_AUDIT_ACTIONS names them, each when it changed something: a hide when its outcome is `hidden` or
 * `removed` is true, a mute when `muted` is true or `removed` is above 0. The audit line of a hide that
 * removed a picture also carries that picture's count of reports, a number (`hideWithPicture`'s
 * `reports`): `audit` of the social routes takes it as an optional fourth argument, api-core's. No audit
 * line and no table keeps a reporter's address beyond the report's own row, which the prune deletes with
 * its message.
 */
export const ROOM_PICTURE_AUDIT_ACTIONS = {
  keep: 'room_picture_keep',
  off: 'room_pictures_off',
  on: 'room_pictures_on',
} as const;

/**
 * The log lines of pictures. Each carries a message's id, a count or the number of a step and nothing
 * else: never an address, a key, a hash or a byte. Which each carries (revision 5, as api-core and
 * engine-runtime built them): the id for `deleteFailed` after a hide and for each delete of a mute that
 * threw, for `lengthMismatch` and for `reported`; `{ count: 1 }` for an `orphan`; for `autoOff` the
 * count that switched (ROOM_PICTURE_AUTO_OFF_REPORTED, or ROOM_PICTURE_REPORTS_PER_DAY); for
 * `deleteFailed` when a mute's `markGone` failed, the number of marks that failed; for `viewsCap` the
 * day's count; for `swept` how many were deleted; for `uploadFailed` and `reportFailed` the step's number.
 */
export const ROOM_PICTURE_LOG_EVENTS = {
  /** KV's delete threw after a hide or a mute: the sweep job tries again. */
  deleteFailed: 'room_picture_delete_failed',
  /** KV answered bytes of another length than the row says: answered as the generic 404. */
  lengthMismatch: 'room_picture_length_mismatch',
  /**
   * The insert of step 11 was refused or threw, after the put (revision 5). Refused: the one delete of the
   * key is tried, once. Thrown: the key is NOT deleted, because the row may exist; it is left to its
   * expiry. Logged with `{ count: 1 }` in both cases.
   */
  orphan: 'room_picture_orphan',
  /** A third report hid a picture. */
  reported: 'room_picture_reported',
  /** Pictures switched themselves off. */
  autoOff: 'room_pictures_auto_off',
  /** The sweep job deleted owed bytes: written only after `markGone` answered for them (revision 5). */
  swept: 'room_pictures_swept',
  /** The day's views reached the cap: logged once a day, with the count, by the request whose sample crossed it (`addViews`). */
  viewsCap: 'room_picture_views_cap',
  /**
   * A step of the upload's work (6 to 11) threw (revision 4): logged with that step's number, inside the
   * work's own failure path and before it rejects, so that a fault after the client has left is not lost.
   */
  uploadFailed: 'room_picture_upload_failed',
  /**
   * A step of a report's work (4 to 6) threw (revision 6, the operator's reading): logged with that step's
   * number, inside the work's own failure path and before it rejects, as `uploadFailed` is for an upload.
   */
  reportFailed: 'room_picture_report_failed',
} as const;

/**
 * `apps/api/src/http/social/room/` exports, beside the room's two factories: `createRoomPictureRoutes(deps)`
 * (the upload, the bytes and the report, mounted under SOCIAL_API_PREFIX only while `picturesEnabled`
 * holds) and `createRoomPictureAdminRoutes(deps)` (the admin's bytes, its list, keep, off and on: mounted
 * always, the generic 404 to anyone who is not an admin session). From this phase on the room's own two
 * factories take this type too: the read and `me` carry pictures while `picturesEnabled` holds, and the
 * hide and the mute delete bytes whatever the switch says. The entry hands them to `createApp` as
 * `AppExtras.roomPictures` and `AppExtras.roomPicturesAdmin`. No route drops a cached answer and no route
 * has a handle on the Cache API: the entry drops the room's read, and of the paths at and under
 * ROOM_PICTURES_PATH only for the upload that answered 201 (`roomPictureDropsRead`).
 *
 * The upload needs the request's execution context, which is no dep (revision 3, the document's section
 * 5): `createApp` answers `fetch(request, ctx)` and calls `app.fetch(request, undefined, ctx)` (api-core),
 * and the entry hands its `ctx` at each of its calls of `api.app.fetch` (platform). The route takes
 * `c.executionCtx` once, before the promise of steps 6 to 11 is made (revision 4) and outside any `try`,
 * and hands that promise to its `waitUntil`, never rejecting, before anything of step 6 is called. With no context the
 * upload is a 500 with nothing spent: there is no fallback, in a test or in production.
 *
 * The report does the same from its step 4 on (revision 6, S3; the document's section 8): its steps 4 to
 * 6 (`requireWriter`, `putReport`, and the room's count of reports when the report was counted) are one
 * promise, handed over in the upload's own spelled order: `const ctx = c.executionCtx; const work =
 * Promise.resolve().then(run); ctx.waitUntil(work.then(() => undefined, () => undefined)); await work`.
 * The context is read before `work` is made and outside any `try`, and there is no fallback: a report that
 * passed step 3 with no context is a 500 with nothing written, and one refused at steps 1 to 3 gets its
 * answer with or without a context. Before, a reporter who hung up after `putReport` could keep a counted
 * report out of the room's hundred of the day.
 *
 * The upload's body is read against ROOM_PICTURE_BODY_SECONDS (revision 6, S1), as that constant says.
 */
export interface RoomPictureApiDeps extends RoomApiDeps {
  pictures: RoomPictureStore;
  bytes: RoomPictureBytes;
  /** SOCIAL_ENABLED, ROOM_ENABLED and ROOM_PICTURES_ENABLED. While it holds, `roomDailyCap` is `roomDailyCapBesidePictures`. */
  picturesEnabled: boolean;
  /** `roomPicturesDailyCap` of ROOM_PICTURES_PER_DAY. */
  picturesDailyCap: number;
  /** `roomPictureViewsCap` of ROOM_PICTURE_VIEWS_PER_DAY. */
  pictureViewsCap: number;
  /**
   * The limiter rule of the bytes routes, over the binding RATE_PICTURE. `subject` is
   * `clientNetwork(request)` of guard.ts (an IPv4 address, or the /48 of an IPv6 one), never
   * `clientSubject`. It refuses when it cannot count, and when the binding is missing, as every rule does.
   */
  pictureLimiter: { allow(subject: string): Promise<boolean> };
  /** A number from 0 up to and not including 1, for the draw of ROOM_PICTURE_VIEW_SAMPLE. The server's; a test fixes it. */
  random(): number;
}

/**
 * The name of the job that deletes owed bytes: the eighth name of `socialJobNameSchema` (phase6-social.ts,
 * since revision 2; the last in that schema's list since revision 3, which is the order the phases added
 * the names in and nothing else, until Phases 6.7 and 6.8 appended `poll_tally` (the ninth, holders
 * contract revision 4, HB3-3) and `holders_lounge_sweep` (the tenth) after it). In the entry's list of jobs
 * it stands BEFORE `room_prune`, which stays
 * last: the step runs the first job that is not idle and returns, and a prune that works on most runs
 * would keep a job behind it waiting without end. The sweep cannot do that to the prune: it is idle
 * whenever nothing is owed, works through at most ROOM_PICTURE_SWEEP_PER_RUN a run, and a run of it that
 * fails lets the step go on to the next job.
 */
export const ROOM_PICTURE_SWEEP_JOB = 'room_picture_sweep' satisfies SocialJobName;
/**
 * What `createRoomPictureSweepJob(deps): SocialJob` of `packages/runtime/src/social/room-picture-sweep.ts`
 * takes. It runs under `guardSocialJob` like every social job, whatever the switches say. A run: one
 * `listOwedDeletes(ROOM_PICTURE_SWEEP_PER_RUN)`; `idle` when that is empty, and the guard's skip gate
 * before the first delete otherwise; `bytes.delete` for each key, one after another, stopping at the first
 * that throws; `markGone` for those that answered, in one call, when there are any. It answers `more` when
 * it found ROOM_PICTURE_SWEEP_PER_RUN and every delete answered, `done` when it found fewer and every
 * delete answered, and throws after `markGone` when a delete threw, so that the guard counts a failure.
 * A failed run has tried one delete that failed. After SOCIAL_JOB_SKIP_AFTER_FAILURES failures in a row it
 * is skipped until the next UTC day; a run that works clears that count, so the bound is one failing
 * delete a run, not a figure of the day. It logs a count only.
 *
 * Three things the job does by itself (revision 5, as engine-runtime built it): it cuts the list it was
 * answered to ROOM_PICTURE_SWEEP_PER_RUN, whatever the store handed back; `markGone` gets the run's own
 * `now`, the one clock of the run; and the line `room_pictures_swept` is written only after `markGone`
 * answered, so that no line says "swept" of a key the row still names.
 *
 * The price of that order, said so that nobody is surprised (revision 3): the list is newest first and the
 * run stops at the first delete that throws, so a key whose delete always throws holds back every older
 * owed delete. The seven days bound it (those keys expire) and D1 refuses those pictures meanwhile.
 */
export interface RoomPictureSweepJobDeps extends Pick<SocialJobDeps, 'log' | 'social' | 'reputation' | 'now'> {
  pictures: Pick<RoomPictureStore, 'listOwedDeletes' | 'markGone'>;
  bytes: Pick<RoomPictureBytes, 'delete'>;
}
export type CreateRoomPictureSweepJob = (deps: RoomPictureSweepJobDeps) => SocialJob;

/**
 * Whether an answer of a path at or under ROOM_PICTURES_PATH drops the room's cached read: only the upload
 * that stored a picture, a POST of the path itself answered 201. A report never does, whatever it
 * answered (a repeated report is a 204 that nothing of the day bounds, and a drop for each would let one
 * wallet make every read of the room a miss); a picture that reports hid is refused by the gate at once
 * and leaves the read within its 30 seconds. The admin's writes under `/api/social/admin/room/` drop the
 * read as the room's own contract says (its section 6), the three new ones among them. The entry asks
 * this function beside its own rule for the room.
 */
export function roomPictureDropsRead(method: string, path: string, status: number): boolean {
  return method === 'POST' && path === ROOM_PICTURES_PATH && status === 201;
}

// --- the sentences that are the contract's own ---------------------------------------------------------

/** Under ROOM_DISCLAIMER, server-rendered, in body size, as it stands, while pictures are enabled. */
export const ROOM_PICTURE_DISCLAIMER =
  'Pictures here are uploaded by users, not by Prix, and nobody checks them before they appear. Prix never posts a picture in this chat and never sends an address, a link or a QR code in one. Do not scan a code or copy an address from a picture.';
/** In the row of every picture, before the click and after it. */
export const ROOM_PICTURE_ROW_NOTE = 'Picture from a user. Not checked by Prix.';
/** In the composer, above the send, once a picture is chosen. */
export const ROOM_PICTURE_COMPOSER_NOTE =
  'This picture will be public, and anyone who sees it can save it. Prix removes location data from the file, not from what the picture shows. A picture is shown for at most seven days.';
/** In the composer of an admin wallet, in place of the control. */
export const ROOM_PICTURE_ADMIN_NOTE = 'Prix never posts a picture here: an admin wallet cannot add one.';
// ROOM_PICTURE_ALT and ROOM_PICTURE_LIMITS are in room-picture.ts: a browser script reads them.

// --- the names of the page's sentences -----------------------------------------------------------------

/**
 * The copy key of a refusal's sentence: `social.roomPictureRefusal` and the field in camel case, without
 * its `picture_` or `pictures_` start (`picture_new_writer` is `social.roomPictureRefusalNewWriter`,
 * `pictures_off` is `social.roomPictureRefusalOff`, `report_own` is `social.roomPictureRefusalReportOwn`),
 * as the room's own are `social.roomRefusal<Field>`.
 */
export function roomPictureRefusalKey(field: RoomPictureSentenceField): string {
  const name = field
    .replace(/^pictures?_/, '')
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  return `social.roomPictureRefusal${name}`;
}

/**
 * The names of this phase's keys in the `social` copy area, each `social.roomPicture<Name>` (revision 2:
 * draft 1 gave the pattern alone, and three owners would each have made up names that `text(key, draft)`
 * never compares). The NAMES are the contract's, so that the editor and the two web owners build at the
 * same time; the WORDS are the editor's, and the drafts here and in the document stand until the editor
 * has written them. A web owner that needs one more key reads it with `text(key, draft)` and names it in
 * its report, as in the room. Placeholders are in braces and are filled by the page from the server's own
 * values or from ROOM_PICTURE_LIMITS.
 *
 * The row on `/chat` (web-arena): `Show` ("Show picture"), `Hide` ("Hide picture"), `Facts` ("{type},
 * {width} x {height}, {size}"), `FactsAnimated` ("GIF, animated, {frames} frames, {width} x {height},
 * {size}": the count is the server's `frames`), `SizeKb` (revision 5: "{count} KB", the `{size}` of
 * `Facts` and of `FactsAnimated` and the size wherever else a page prints one, read by both web owners;
 * the count is whole kilobytes of 1,024 bytes ROUNDED UP, `Math.ceil(bytes / 1_024)`, so that a file
 * never reads smaller than it is and a file below one kilobyte reads "1 KB". There is no `SizeBytes` and
 * no `Size`: one key and one rounding rule), `Off` ("Pictures are switched off for now."), `Resting`
 * ("Pictures are resting until 00:00 UTC.": since revision 6 said once, under the list's heading, while
 * the read says `resting`), `RestingRow` (revision 6: the short form each picture row keeps while pictures
 * rest, "Not shown until 00:00 UTC."), `Reported` ("Hidden after reports. A moderator will look."),
 * `Gone` ("This picture is no longer available.": it names no reason, since the seven days, a lost key and
 * a writer who is an admin wallet now all read so), `LoadFailed` ("This picture is not available right
 * now.", for every load that failed, whatever its status), `Report` ("Report").
 *
 * The report (web-account): `ReportDone` ("Reported. A moderator will look if others report it too."),
 * `ReportFailed` (a report that was not answered), `ReportClosed` (revision 5: the generic 404 of a
 * report, "This picture is not open to reports now."), and since revision 6 the question a first press on
 * "Report" opens: `ReportAsk` (the question, which says in one calm sentence what a report does and types
 * no figure: "Report this picture? It is hidden for everyone once enough users report it, and a moderator
 * then decides."), `ReportYes` ("Report", the one button that sends the report) and `ReportNo` ("Cancel",
 * which restores the row as it was).
 *
 * The composer (web-account): `Add` ("Add a picture"), `Discard` (takes the chosen picture out again),
 * and since revision 5 `Send` ("Send picture": the send button while a picture is chosen), `Sending`
 * (its busy label, "Sending picture"), `SendFailed` (an upload that got no answer: "The picture did not
 * reach Prix, and it is still chosen here. Try again in a minute.") and `SendFailedTitle` ("Picture not
 * sent"); `NewWriter` ("You can add a picture {minutes} minutes after your first message here.": the rule, since
 * `me` carries no time), `Limits` (what a picture may be, every number from ROOM_PICTURE_LIMITS),
 * `LeftOne` and `LeftOther` (the wallet's pictures left today).
 *
 * `/admin/chat` (web-account): `AdminOffState` (off since {at}), `AdminOnState` (revision 5: "Pictures
 * are on."), `AdminOffByAdmin`, `AdminOffByReportsHour` and `AdminOffByReportsDay` (who or which count set
 * it), `AdminReportedTitle` ("Reported pictures"), `AdminReportedEmpty`, `AdminReportedMore`, and since
 * revision 5 `AdminReportedBy` ("Reported by", before the reporters' addresses), `AdminReportsOne`
 * ("1 report") and `AdminReportsOther` ("{count} reports"), and `AdminHash` ("SHA-256 begins {hash}");
 * and since revision 6 the titles of the page's two cards that had none, `AdminPicturesTitle` ("Pictures",
 * the card of the switch) and `AdminMessagesTitle` ("All messages", the card of the list of every message);
 * `AdminShow` ("Show picture"), `AdminUnblur` ("Unblur picture"; the admin's "Hide picture" is the row's
 * own key `Hide`),
 * `AdminNotViewable` (its bytes can no longer be looked at), `AdminStateOk`, `AdminStateReported`,
 * `AdminStateKept`, `AdminStateRemoved`, `AdminBytesGone`, `AdminBytesOwed`; and for each of the four
 * controls `AdminRemove` ("Remove picture"), `AdminKeep` ("Keep picture"), `AdminOff` ("Switch pictures
 * off") and `AdminOn` ("Switch pictures on": revision 6 for both, where the drafts were "Pictures off" and
 * "Pictures on": a control says its act, and "Pictures off" under "Pictures are on." read as a state) the
 * six of every admin control of the room: the name itself and `Busy`, `Question`, `Consequence` (for
 * `AdminRemove`: the bytes cannot be brought back), `Done` and `Failed` after it.
 *
 * And one for every field of `RoomPictureSentenceField`, by `roomPictureRefusalKey`.
 *
 * THE SLOTS (revision 5). These keys have slots and no other has one:
 * - `Facts`: {type} {width} {height} {size}. `FactsAnimated`: {frames} {width} {height} {size}.
 *   {width} and {height} are printed grouped, as the site prints numbers ("1,600 × 1,200 pixels");
 *   {size} is the sentence of `SizeKb`.
 * - `SizeKb`: {count}. `LeftOther`: {count}. `AdminReportsOther`: {count}.
 * - `NewWriter`: {minutes}, ROOM_PICTURE_LIMITS.writerAgeMinutes.
 * - `AdminOffState`: {at}, a time in UTC. `AdminHash`: {hash}, `sha256Short` of the admins' read.
 * Where the editor wrote a figure of ROOM_PICTURE_LIMITS into a sentence (`Limits`, and the sentences
 * of the refusals), the sentence has no slot and no page passes one: a page never types a number.
 * `AdminOffByAdmin` has no slot: the page sets the admin's whole address beside the sentence.
 *
 * The drafts of the eleven names of revision 5 are the owners' own, from their reports of round 1; the
 * editor settles each sentence.
 *
 * The six names of revision 6 (`ReportAsk`, `ReportYes`, `ReportNo`, `RestingRow`, `AdminPicturesTitle`,
 * `AdminMessagesTitle`) have no slot: `ReportAsk` types no figure, and `RestingRow` says 00:00 UTC as
 * `Resting` does. Their drafts are the operator's, from the reviews of the built code; the editor settles
 * each sentence. ROOM_PICTURE_COPY_KEYS holds 93 keys now, the refusals' among them (87 at revision 5).
 */
const ROOM_PICTURE_COPY_NAMES = [
  'Show',
  'Hide',
  'Facts',
  'FactsAnimated',
  'SizeKb',
  'Off',
  'Resting',
  'RestingRow',
  'Reported',
  'Gone',
  'LoadFailed',
  'Report',
  'ReportDone',
  'ReportFailed',
  'ReportClosed',
  'ReportAsk',
  'ReportYes',
  'ReportNo',
  'Add',
  'Discard',
  'Send',
  'Sending',
  'SendFailed',
  'SendFailedTitle',
  'NewWriter',
  'Limits',
  'LeftOne',
  'LeftOther',
  'AdminOffState',
  'AdminOnState',
  'AdminOffByAdmin',
  'AdminOffByReportsHour',
  'AdminOffByReportsDay',
  'AdminReportedTitle',
  'AdminReportedEmpty',
  'AdminReportedMore',
  'AdminReportedBy',
  'AdminReportsOne',
  'AdminReportsOther',
  'AdminHash',
  'AdminPicturesTitle',
  'AdminMessagesTitle',
  'AdminShow',
  'AdminUnblur',
  'AdminNotViewable',
  'AdminStateOk',
  'AdminStateReported',
  'AdminStateKept',
  'AdminStateRemoved',
  'AdminBytesGone',
  'AdminBytesOwed',
  ...(['AdminRemove', 'AdminKeep', 'AdminOff', 'AdminOn'] as const).flatMap((control) =>
    (['', 'Busy', 'Question', 'Consequence', 'Done', 'Failed'] as const).map((part) => `${control}${part}`),
  ),
] as const;
export const ROOM_PICTURE_COPY_KEYS: readonly string[] = [
  ...ROOM_PICTURE_COPY_NAMES.map((name) => `social.roomPicture${name}`),
  ...(Object.keys(ROOM_PICTURE_REFUSALS) as RoomPictureRefusalField[])
    .filter((field): field is RoomPictureSentenceField => field !== 'picture_views_day')
    .map(roomPictureRefusalKey),
];
