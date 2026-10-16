import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { Address, RoomMessageRecord, RoomStore, RoomTurn, RoomWriterRecord } from '@prix/contracts';
import { ROOM_MESSAGES_PER_WALLET_PER_DAY, ROOM_SECONDS_BETWEEN, roomTurnRefusal } from '@prix/contracts';

/**
 * The Phase 6.3 side of D1: `createRoomStore(db)` implements `RoomStore` over
 * infra/migrations/0012_room.sql (docs/contracts/phase-6-room.md sections 2, 5, 6 and 7).
 *
 * Every method is one D1 call or one D1 batch, and a batch is a transaction. Every rule is a condition
 * inside a statement: a turn is counted, a message hidden and a writer muted only where the statement
 * itself finds the row as the rule asks, so two requests at once cannot both pass. Addresses are stored
 * and compared in lower case. Times are ISO text as `toISOString()` writes them, so text order is time
 * order (packages/contracts/src/primitives.ts) and the statements compare them as text.
 *
 * What a read costs, in rows: `listNewest` walks at most `scan` messages by the primary key and looks
 * each one's writer up by its key, so at most twice `scan`; it has no way to go further down. Since
 * Phase 6.8 it also looks up the author's stored token row by its key for each message it answers, at
 * most `limit` (ROOM_PAGE) rows more.
 * `getCounts` is two seeks of the counters' key.
 *
 * Its tests: apps/api/src/store/room.d1.test.ts, on a local D1
 * (`pnpm exec vitest run --config apps/api/vitest.workers.config.ts`).
 */

export type Bound = string | number | null;

export function changesOf(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
}

/** A limit or a count from the caller: a whole number, zero or more, or the statement fails here. */
export function wholeNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`room store: ${name} must be a whole number, zero or more`);
  return value;
}

export interface MessageSql {
  id: number;
  at: string;
  author: string;
  text: string;
  hidden_at: string | null;
  hidden_by: string | null;
}

export interface WriterSql {
  address: string;
  last_at: string | null;
  day: string | null;
  count: number;
  muted_at: string | null;
  muted_by: string | null;
  cut_at: string | null;
}

export function toMessage(row: MessageSql): RoomMessageRecord {
  return {
    id: row.id,
    at: row.at,
    author: row.author,
    text: row.text,
    hiddenAt: row.hidden_at,
    hiddenBy: row.hidden_by,
  };
}

export function toWriter(row: WriterSql): RoomWriterRecord {
  return {
    address: row.address,
    lastAt: row.last_at,
    day: row.day,
    count: row.count,
    mutedAt: row.muted_at,
    mutedBy: row.muted_by,
    cutAt: row.cut_at,
  };
}

/**
 * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.1): the columns of the author's stored
 * `token_holders` row that the public read joins, by that table's primary key, for the Holder mark.
 */
export interface AuthorHolderSql {
  holder_tier: number | null;
  holder_token: string | null;
  holder_checked_at: string | null;
}

/** A message of the public read with its author's stored token row, or null when there is none. */
export function withAuthorHolder<T extends RoomMessageRecord>(message: T, row: AuthorHolderSql): T {
  const { holder_tier: tier, holder_token: tokenAddress, holder_checked_at: checkedAt } = row;
  const authorHolder =
    tier === null || tokenAddress === null || checkedAt === null ? null : { tier, tokenAddress, checkedAt };
  return { ...message, authorHolder };
}

/** The join of the public read and its three columns: at most one seek of `token_holders` a message. */
export const AUTHOR_HOLDER_JOIN = 'LEFT JOIN token_holders AS h ON h.address = m.author';
export const AUTHOR_HOLDER_COLUMNS =
  'h.tier AS holder_tier, h.token_address AS holder_token, h.checked_at AS holder_checked_at';

export const MESSAGE_COLUMNS = 'm.id, m.at, m.author, m.text, m.hidden_at, m.hidden_by';
export const WRITER_COLUMNS = 'address, last_at, day, count, muted_at, muted_by, cut_at';

/**
 * The page a visitor may see, in one statement. Its edge is the newest id less ?2: the one MAX of the
 * primary key is a seek, and the messages above the edge are a range of that key, so what is looked at
 * is fixed by arithmetic on the ids and never by a count of rows. A row missing among the newest ids
 * (none is today: only the prune deletes, from the bottom) is not made up for from below the edge. The
 * statement leaves out a hidden message, a message of a writer who is muted now and a message at or
 * before its writer's cut_at, and has no way to look further down: a stretch of hidden rows makes the
 * page shorter, not the read longer. The writer is joined at the read by its primary key, so a mute or
 * its lift shows with the next read. ?1 limit, ?2 scan.
 *
 * Phase 6.4 (docs/contracts/phase-6-pictures.md section 19): it leaves picture messages out. It is the
 * read of a room whose pictures are not enabled; while they are, the route answers
 * `RoomPictureStore.readRoom`. A picture message still stands among the newest ids, so it makes this page
 * shorter as a hidden message does.
 *
 * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.1): each message carries its author's stored
 * `token_holders` row, joined by that table's primary key: at most ?1 seeks more, and no statement more.
 */
const LIST_NEWEST = `
SELECT ${MESSAGE_COLUMNS}, ${AUTHOR_HOLDER_COLUMNS}
FROM room_messages AS m
LEFT JOIN room_writers AS w ON w.address = m.author
${AUTHOR_HOLDER_JOIN}
WHERE m.id > (SELECT COALESCE(MAX(id), 0) FROM room_messages) - ?2
  AND m.pic_type IS NULL
  AND m.hidden_at IS NULL
  AND w.muted_at IS NULL
  AND (w.cut_at IS NULL OR m.at > w.cut_at)
ORDER BY m.id DESC
LIMIT ?1`;

/**
 * The admins' page: every message below ?1 by the primary key, newest first, ?2 at most. `muted` is its
 * writer's mute as it is now. `cut` is the public read's own condition turned round: written at or
 * before its writer's cut_at, so no public read shows it, also after the mute was lifted.
 */
const LIST_ALL = `
SELECT ${MESSAGE_COLUMNS},
  w.muted_at IS NOT NULL AS muted,
  (w.cut_at IS NOT NULL AND m.at <= w.cut_at) AS cut
FROM room_messages AS m LEFT JOIN room_writers AS w ON w.address = m.author
WHERE m.id < ?1
ORDER BY m.id DESC
LIMIT ?2`;

const GET_MESSAGE = `SELECT ${MESSAGE_COLUMNS} FROM room_messages AS m WHERE m.id = ?1`;
const GET_WRITER = `SELECT ${WRITER_COLUMNS} FROM room_writers WHERE address = ?1`;

/**
 * The room's two counts as they stand, in one statement over the counters of Phase 2
 * (infra/migrations/0002_reputation.sql): each a seek of that table's primary key, and a key with no row
 * counts 0. Read and not taken: `takeCounter` of the reputation store is what counts. ?1 the hour's key,
 * ?2 the day's.
 */
const GET_COUNTS = `
SELECT
  COALESCE((SELECT n FROM counters WHERE key = ?1), 0) AS hour,
  COALESCE((SELECT n FROM counters WHERE key = ?2), 0) AS day`;

/**
 * A turn, counted only when `roomTurnRefusal` would answer null for the row as it stands. A wallet with
 * no row gets one. A row that is there is changed only while it is not muted, its count of this day is
 * below the cap, and its last message is at or before ?5, the latest time a last message may carry:
 * `now` less ROOM_SECONDS_BETWEEN. A row of another day starts the count again.
 * ?1 address, ?2 now, ?3 day, ?4 the wallet's cap of the day (Phase 6.8: `roomWalletDayCap` of its
 * holding, ROOM_MESSAGES_PER_WALLET_PER_DAY when the caller gives none), ?5 that time.
 */
const TAKE_TURN = `
INSERT INTO room_writers (address, last_at, day, count) VALUES (?1, ?2, ?3, 1)
ON CONFLICT (address) DO UPDATE SET
  last_at = ?2,
  day = ?3,
  count = CASE WHEN room_writers.day IS ?3 THEN room_writers.count + 1 ELSE 1 END
WHERE room_writers.muted_at IS NULL
  AND NOT (room_writers.day IS ?3 AND room_writers.count >= ?4)
  AND (room_writers.last_at IS NULL OR room_writers.last_at <= ?5)`;

const PUT_MESSAGE = `
INSERT INTO room_messages (at, author, text) VALUES (?1, ?2, ?3)
RETURNING id, at, author, text, hidden_at, hidden_by`;

/**
 * Phase 6.4, in the batch of `putMessage`: the time of the writer's first message that was stored
 * (`room_writers.first_at`, migration 0013), set to the message's time where it is null and left where it
 * is set. A wallet with no row gets one: an admin takes no turn and may have none. A turn that stored no
 * message never comes here, so the first message has stood in the room. A row this makes carries no turn:
 * its count is 0 and its last message null, as `TAKE_TURN` expects of a row it changes.
 * ?1 address, ?2 the message's time.
 */
const SET_FIRST_AT = `
INSERT INTO room_writers (address, first_at) VALUES (?1, ?2)
ON CONFLICT (address) DO UPDATE SET first_at = ?2
WHERE room_writers.first_at IS NULL`;

/** Hides once: a message that is hidden keeps the time and the admin of its first hiding. */
export const HIDE_MESSAGE =
  'UPDATE room_messages SET hidden_at = ?2, hidden_by = ?3 WHERE id = ?1 AND hidden_at IS NULL';
const MESSAGE_EXISTS = 'SELECT 1 AS found FROM room_messages WHERE id = ?1';

/**
 * A mute, and with it the cut: nothing the writer wrote at or before ?2 is shown again. A wallet that
 * never wrote gets its row. A writer who is muted already is left as it is, with the first mute's time.
 */
export const MUTE_WRITER = `
INSERT INTO room_writers (address, muted_at, muted_by, cut_at) VALUES (?1, ?2, ?3, ?2)
ON CONFLICT (address) DO UPDATE SET muted_at = ?2, muted_by = ?3, cut_at = ?2
WHERE room_writers.muted_at IS NULL`;

/**
 * Lifts a mute and, in the same statement, moves the cut forward to the time of the writer's newest
 * message when that is later (docs/contracts/phase-6-room.md section 7). A message can be stored with a
 * time after the mute's: its request read the clock after the admin's did and reached D1 before the mute.
 * While the writer is muted nothing of it shows; without this the lift would show that one. A writer who
 * is muted takes no turn, so every message of it that exists at the lift is from before the mute or is
 * such a straggler, and none of them is shown again. The cut never moves backwards: it is the later of
 * the cut as it stands and that newest time, and a writer with no message keeps its cut. The right-hand
 * sides read the row as it was before the statement. The newest time is read through the index
 * `room_messages_author`: the writer's own messages and no others. ?1 address.
 */
const UNMUTE_WRITER = `
UPDATE room_writers SET
  muted_at = NULL,
  muted_by = NULL,
  cut_at = MAX(
    COALESCE(cut_at, muted_at),
    COALESCE((SELECT MAX(at) FROM room_messages WHERE author = ?1), COALESCE(cut_at, muted_at)))
WHERE address = ?1 AND muted_at IS NOT NULL`;

/**
 * The oldest messages beyond the newest ?1, at most ?2. The edge is the newest id less ?1: MAX of the
 * primary key is one seek, and the range below the edge starts at the table's first row, so a run that
 * has nothing to delete reads no stretch of the table to learn it.
 */
const PRUNE_MESSAGES = `
DELETE FROM room_messages WHERE id IN (
  SELECT id FROM room_messages
  WHERE id <= (SELECT MAX(id) FROM room_messages) - ?1
  ORDER BY id
  LIMIT ?2)`;

/**
 * Phase 6.4, in the batch of `pruneMessages`: the reports of pictures at or below the same edge, the
 * newest id less ?1. A report is a row of its own (`room_picture_reports`, migration 0013) and holds a
 * reporter's address, which is kept nowhere after its message has aged out. The edge does not move while
 * the batch runs: the prune deletes from the bottom and never the newest id. The range starts at the
 * table's first row, as the prune's own does.
 */
const PRUNE_PICTURE_REPORTS = `
DELETE FROM room_picture_reports
WHERE message_id <= (SELECT MAX(id) FROM room_messages) - ?1`;

/** An id no message will reach: the cursor of the admins' read when none is given. */
export const NO_CURSOR = Number.MAX_SAFE_INTEGER;

export function createRoomStore(db: D1Database): RoomStore {
  function prepare(statement: string, ...values: Bound[]): D1PreparedStatement {
    return db.prepare(statement).bind(...values);
  }

  const lower = (address: Address): Address => address.toLowerCase();

  const store: RoomStore = {
    async listNewest(limit, scan) {
      const result = await prepare(LIST_NEWEST, wholeNumber(limit, 'limit'), wholeNumber(scan, 'scan')).all<
        MessageSql & AuthorHolderSql
      >();
      return result.results.map((row) => withAuthorHolder(toMessage(row), row));
    },

    async listAllMessages(before, limit) {
      const cursor = before === null ? NO_CURSOR : wholeNumber(before, 'before');
      const result = await prepare(LIST_ALL, cursor, wholeNumber(limit, 'limit')).all<
        MessageSql & { muted: number; cut: number }
      >();
      return result.results.map((row) => ({ ...toMessage(row), muted: row.muted === 1, cut: row.cut === 1 }));
    },

    async getMessage(id) {
      const row = await prepare(GET_MESSAGE, wholeNumber(id, 'id')).first<MessageSql>();
      return row === null ? null : toMessage(row);
    },

    async getWriter(address) {
      const row = await prepare(GET_WRITER, lower(address)).first<WriterSql>();
      return row === null ? null : toWriter(row);
    },

    async getCounts(hourKey, dayKey) {
      const row = await prepare(GET_COUNTS, hourKey, dayKey).first<{ hour: number; day: number }>();
      if (row === null) throw new Error("room store: the room's counts came back with no row");
      return { hour: row.hour, day: row.day };
    },

    async takeTurn(address, now, day, dayCap = ROOM_MESSAGES_PER_WALLET_PER_DAY): Promise<RoomTurn> {
      const writer = lower(address);
      const cap = wholeNumber(dayCap, 'dayCap');
      const instant = Date.parse(now);
      if (!Number.isFinite(instant)) throw new Error('room store: now must be an ISO time');
      const latestLast = new Date(instant - ROOM_SECONDS_BETWEEN * 1_000).toISOString();
      const [taken, read] = await db.batch<WriterSql>([
        prepare(TAKE_TURN, writer, now, day, cap, latestLast),
        prepare(GET_WRITER, writer),
      ]);
      const row = read?.results[0];
      if (row === undefined) throw new Error('room store: a turn left no row of its writer');
      const record = toWriter(row);
      // Whether the turn was counted is what the write changed, never a judgement of the row read after
      // it: a counted turn leaves `now` as the row's last message, and `roomTurnRefusal` of that row
      // answers `too_soon`.
      if (changesOf(taken) > 0) return { ok: true, left: Math.max(0, cap - record.count) };
      // Nothing was written, so the row is the one that refused: it names the reason, in the contract's order.
      const why = roomTurnRefusal(record, now, day, cap);
      if (why === null) throw new Error('room store: a turn was refused and its row names no reason');
      return { ok: false, why };
    },

    async putMessage(author, text, now) {
      const writer = lower(author);
      const [stored] = await db.batch<MessageSql>([
        prepare(PUT_MESSAGE, now, writer, text),
        prepare(SET_FIRST_AT, writer, now),
      ]);
      const row = stored?.results[0];
      if (row === undefined) throw new Error('room store: a message was written and no row came back');
      return toMessage(row);
    },

    async hideMessage(id, by, now) {
      const message = wholeNumber(id, 'id');
      const [hidden, found] = await db.batch<{ found: number }>([
        prepare(HIDE_MESSAGE, message, now, lower(by)),
        prepare(MESSAGE_EXISTS, message),
      ]);
      if (changesOf(hidden) > 0) return 'hidden';
      return found !== undefined && found.results.length > 0 ? 'already' : 'none';
    },

    async muteWriter(address, by, now) {
      const result = await prepare(MUTE_WRITER, lower(address), now, lower(by)).run();
      return changesOf(result) > 0;
    },

    async unmuteWriter(address) {
      const result = await prepare(UNMUTE_WRITER, lower(address)).run();
      return changesOf(result) > 0;
    },

    async pruneMessages(keep, limit) {
      const kept = wholeNumber(keep, 'keep');
      const [messages] = await db.batch([
        prepare(PRUNE_MESSAGES, kept, wholeNumber(limit, 'limit')),
        prepare(PRUNE_PICTURE_REPORTS, kept),
      ]);
      // The count of messages, as before: the prune job reads it to know whether there is more.
      return changesOf(messages);
    },
  };

  return store;
}
