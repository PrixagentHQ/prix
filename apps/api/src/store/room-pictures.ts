import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type {
  Address,
  IsoTime,
  RoomPictureMessageRecord,
  RoomPictureRecord,
  RoomPictureState,
  RoomPictureStore,
  RoomPicturesOff,
  RoomPicturesOffReason,
  RoomPictureTurn,
  RoomPictureType,
  RoomPictureWriterRecord,
  RoomServablePicture,
} from '@prix/contracts';
import {
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PICTURE_AUTO_OFF_REPORTED,
  ROOM_PICTURE_DELETES_PER_CALL,
  ROOM_PICTURE_REPORT_STRIKES,
  ROOM_PICTURE_REPORTER_AGE_SECONDS,
  ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY,
  ROOM_PICTURE_REPORTS_TO_HIDE,
  ROOM_PICTURE_STATES,
  ROOM_PICTURE_TEXT,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_TYPES,
  ROOM_PICTURE_WRITER_AGE_SECONDS,
  ROOM_PICTURES_OFF_REASONS,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  ROOM_REPORTED_PICTURES_PAUSE,
  ROOM_SECONDS_BETWEEN,
  roomPictureKeySchema,
  roomPictureSha256Schema,
  roomPicturesLeft,
  roomPictureTurnRefusal,
} from '@prix/contracts';
import type { AuthorHolderSql, Bound, MessageSql, WriterSql } from './room.ts';
import {
  AUTHOR_HOLDER_COLUMNS,
  AUTHOR_HOLDER_JOIN,
  changesOf,
  HIDE_MESSAGE,
  MESSAGE_COLUMNS,
  MUTE_WRITER,
  NO_CURSOR,
  toMessage,
  toWriter,
  wholeNumber,
  withAuthorHolder,
} from './room.ts';

/**
 * The Phase 6.4 side of D1: `createRoomPictureStore(db)` implements `RoomPictureStore` over
 * infra/migrations/0013_room_pictures.sql (docs/contracts/phase-6-pictures.md sections 2, 5, 7, 8 and 9).
 *
 * D1 decides and KV only holds bytes: no method here reads or writes KV. Every method is one D1 call or
 * one D1 batch, and a batch is a transaction. Every rule is a condition inside a statement: a turn is
 * counted, a picture stored, a report counted, a picture removed or kept and the switch set only where the
 * statement itself finds the rows as the rule asks, so two requests at once cannot both pass.
 *
 * No statement runs in a D1 session. Without one every query is answered by the primary, which is what
 * makes a hide, a mute and the switch hold everywhere at the next request (the contract's section 6).
 * Nothing in this file calls `withSession`, and nobody adds it.
 *
 * Addresses are stored and compared in lower case. Times are ISO text as `toISOString()` writes them, so
 * text order is time order and the statements compare them as text; an edge in time ("seven days before
 * now") is worked out here and bound as such a text.
 *
 * How a batch knows what its own first statement did. A batch cannot hand one statement's outcome to the
 * next, so `putReport` rests on one invariant instead: between batches, a picture's `pic_reports` equals
 * the number of rows of `room_picture_reports` for it. The batch inserts the report's row first. From then
 * until its last statement, "the count of rows is above `pic_reports`" is true exactly when THIS batch
 * inserted a row, and every later write asks that. The last statement brings `pic_reports` level again.
 *
 * Its tests: apps/api/src/store/room-pictures.d1.test.ts, on a local D1
 * (`pnpm exec vitest run --config apps/api/vitest.workers.config.ts`), with a race for every rule.
 */

interface PictureSql {
  pic_type: string | null;
  pic_key: string | null;
  pic_bytes: number | null;
  pic_width: number | null;
  pic_height: number | null;
  pic_frames: number | null;
  pic_sha256: string | null;
  pic_state: string | null;
  pic_reports: number;
  pic_decided_at: string | null;
  pic_decided_by: string | null;
  pic_gone_at: string | null;
}

type PictureMessageSql = MessageSql & PictureSql;

interface UploaderSql extends WriterSql {
  first_at: string | null;
  pictures_day: string | null;
  pictures_count: number;
  reports_day: string | null;
  reports_count: number;
  report_strikes: number;
  reported_open: number;
}

interface OffSql {
  at: string;
  by: string;
  why: string;
}

/** What `room_flags.by` holds when the switch set itself. The store answers it as null. */
const AUTO = 'auto';
const PICTURES_OFF = 'pictures_off';

function pictureType(value: string): RoomPictureType {
  const type = ROOM_PICTURE_TYPES.find((known) => known === value);
  if (type === undefined) throw new Error('room pictures: a stored picture has a type this code does not know');
  return type;
}

function pictureState(value: string | null): RoomPictureState {
  const state = ROOM_PICTURE_STATES.find((known) => known === value);
  if (state === undefined) throw new Error('room pictures: a stored picture has a state this code does not know');
  return state;
}

function toPicture(row: PictureSql): RoomPictureRecord | null {
  if (row.pic_type === null) return null;
  if (
    row.pic_bytes === null ||
    row.pic_width === null ||
    row.pic_height === null ||
    row.pic_frames === null ||
    row.pic_sha256 === null
  ) {
    throw new Error('room pictures: a picture message is stored without its facts');
  }
  return {
    type: pictureType(row.pic_type),
    width: row.pic_width,
    height: row.pic_height,
    frames: row.pic_frames,
    bytes: row.pic_bytes,
    sha256: row.pic_sha256,
    key: row.pic_key,
    state: pictureState(row.pic_state),
    reports: row.pic_reports,
    decidedAt: row.pic_decided_at,
    decidedBy: row.pic_decided_by,
    goneAt: row.pic_gone_at,
  };
}

function toPictureMessage(row: PictureMessageSql): RoomPictureMessageRecord {
  return { ...toMessage(row), picture: toPicture(row) };
}

function toUploader(row: UploaderSql): RoomPictureWriterRecord {
  return {
    ...toWriter(row),
    firstAt: row.first_at,
    picturesDay: row.pictures_day,
    picturesCount: row.pictures_count,
    reportsDay: row.reports_day,
    reportsCount: row.reports_count,
    reportStrikes: row.report_strikes,
    reportedOpen: row.reported_open,
  };
}

function toOff(row: OffSql): RoomPicturesOff {
  const why = ROOM_PICTURES_OFF_REASONS.find((known) => known === row.why);
  if (why === undefined) throw new Error('room pictures: the switch is stored with a reason this code does not know');
  return { at: row.at, by: row.by === AUTO ? null : row.by, why };
}

function toServable(row: { key: string; type: string; bytes: number; author: string }): RoomServablePicture {
  return { key: row.key, type: pictureType(row.type), bytes: row.bytes, author: row.author };
}

/** The time `seconds` before `now`, as ISO text. A `now` that is no time fails here, before any statement. */
function before(now: IsoTime, seconds: number): IsoTime {
  const instant = Date.parse(now);
  if (!Number.isFinite(instant)) throw new Error('room pictures: now must be an ISO time');
  return new Date(instant - seconds * 1_000).toISOString();
}

const PICTURE_COLUMNS =
  'm.pic_type, m.pic_key, m.pic_bytes, m.pic_width, m.pic_height, m.pic_frames, m.pic_sha256, m.pic_state, m.pic_reports, m.pic_decided_at, m.pic_decided_by, m.pic_gone_at';
const PICTURE_MESSAGE_COLUMNS = `${MESSAGE_COLUMNS}, ${PICTURE_COLUMNS}`;

/**
 * A writer's row with what pictures add, and the count of its pictures that are hidden by reports and not
 * decided: a range of the partial index `room_messages_pic_reported`, which holds those pictures and no
 * other row. `alias` names the row of `room_writers` the columns are read from.
 */
function uploaderColumns(alias: string, prefix = ''): string {
  const names = [
    'address',
    'last_at',
    'day',
    'count',
    'muted_at',
    'muted_by',
    'cut_at',
    'first_at',
    'pictures_day',
    'pictures_count',
    'reports_day',
    'reports_count',
    'report_strikes',
  ];
  const columns = names.map((name) => `${alias}.${name} AS ${prefix}${name}`).join(', ');
  return `${columns},
  (SELECT COUNT(*) FROM room_messages INDEXED BY room_messages_pic_reported
   WHERE author = ${alias}.address AND pic_state = 'reported') AS ${prefix}reported_open`;
}

const GET_UPLOADER = `SELECT ${uploaderColumns('u')} FROM room_writers AS u WHERE u.address = ?1`;

/**
 * What the public may see of a picture, as conditions on a message `m` and its writer `w`: it has bytes
 * Prix did not delete, its message is not hidden, its writer is not muted now, it was written after its
 * writer's cut, it is among the newest `scan` ids, it is younger than seven days, and pictures are not
 * switched off. The states are the caller's: `ok` and `kept` for the gate, `ok` alone for a report.
 * `scan` and `edge` name the two parameters: the scan, and the time seven days before now.
 */
function seenByThePublic(states: string, scan: string, edge: string): string {
  return `m.pic_type IS NOT NULL
  AND m.pic_state IN (${states})
  AND m.pic_key IS NOT NULL
  AND m.hidden_at IS NULL
  AND w.muted_at IS NULL
  AND (w.cut_at IS NULL OR m.at > w.cut_at)
  AND m.id > (SELECT COALESCE(MAX(id), 0) FROM room_messages) - ${scan}
  AND m.at > ${edge}
  AND NOT EXISTS (SELECT 1 FROM room_flags WHERE name = '${PICTURES_OFF}')`;
}

/**
 * The public read while pictures are on: the statement of `RoomStore.listNewest` with each message's
 * picture, and with picture messages in it. At most twice ?2 rows. ?1 limit, ?2 scan.
 *
 * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.1): each message carries its author's stored
 * `token_holders` row, joined by that table's primary key: at most ?1 rows more, and no statement more.
 */
const READ_ROOM = `
SELECT ${PICTURE_MESSAGE_COLUMNS}, ${AUTHOR_HOLDER_COLUMNS}
FROM room_messages AS m
LEFT JOIN room_writers AS w ON w.address = m.author
${AUTHOR_HOLDER_JOIN}
WHERE m.id > (SELECT COALESCE(MAX(id), 0) FROM room_messages) - ?2
  AND m.hidden_at IS NULL
  AND w.muted_at IS NULL
  AND (w.cut_at IS NULL OR m.at > w.cut_at)
ORDER BY m.id DESC
LIMIT ?1`;

const GET_OFF = `SELECT at, by, why FROM room_flags WHERE name = '${PICTURES_OFF}'`;
const GET_COUNTER = 'SELECT n FROM counters WHERE key = ?1';

/**
 * THE GATE of the bytes route, in one statement of at most five rows: the views' counter, and beside it
 * the picture, which is there only when every condition of `seenByThePublic` holds (the message by its
 * key, its writer by its key, the newest id, the switch). One row always comes back, so the views are
 * answered whatever the picture is, and nothing in the answer says which condition failed.
 * ?1 id, ?2 scan, ?3 the time seven days before now, ?4 the views' key.
 */
const GET_SERVABLE = `
SELECT v.views, p.key, p.type, p.bytes, p.author
FROM (SELECT COALESCE((SELECT n FROM counters WHERE key = ?4), 0) AS views) AS v
LEFT JOIN (
  SELECT m.pic_key AS key, m.pic_type AS type, m.pic_bytes AS bytes, m.author AS author
  FROM room_messages AS m
  LEFT JOIN room_writers AS w ON w.address = m.author
  WHERE m.id = ?1
  AND ${seenByThePublic("'ok', 'kept'", '?2', '?3')}
) AS p ON 1 = 1`;

/** Adds to a counter and answers the count after it: one statement, its own RETURNING. ?1 key, ?2 add, ?3 now. */
const ADD_VIEWS = `
INSERT INTO counters (key, n, updated_at) VALUES (?1, ?2, ?3)
ON CONFLICT (key) DO UPDATE SET n = n + ?2, updated_at = excluded.updated_at
RETURNING n`;

/**
 * What an admin may look at: a picture that is not removed, with bytes, whose message is not hidden and
 * is younger than seven days. Not bound by the scan nor by the switch. ?1 id, ?2 the time seven days
 * before now.
 */
const GET_ADMIN_PICTURE = `
SELECT m.pic_key AS key, m.pic_type AS type, m.pic_bytes AS bytes, m.author AS author
FROM room_messages AS m
WHERE m.id = ?1
  AND m.pic_type IS NOT NULL
  AND m.pic_state IN ('ok', 'kept', 'reported')
  AND m.pic_key IS NOT NULL
  AND m.hidden_at IS NULL
  AND m.at > ?2`;

/** The switch and the room's four counts, read and not taken: five seeks. ?1 to ?4 the four keys. */
const GET_PICTURE_COUNTS = `
SELECT f.at AS off_at, f.by AS off_by, f.why AS off_why,
  COALESCE((SELECT n FROM counters WHERE key = ?1), 0) AS hour,
  COALESCE((SELECT n FROM counters WHERE key = ?2), 0) AS day,
  COALESCE((SELECT n FROM counters WHERE key = ?3), 0) AS picture_hour,
  COALESCE((SELECT n FROM counters WHERE key = ?4), 0) AS picture_day
FROM (SELECT 1) AS one
LEFT JOIN room_flags AS f ON f.name = '${PICTURES_OFF}'`;

const IS_BLOCKED = 'SELECT 1 AS found FROM room_picture_blocks WHERE sha256 = ?1';

/**
 * A picture's turn: the message's turn (the columns `RoomStore.takeTurn` counts) and the wallet's picture
 * of the day, both in one UPDATE or neither, only when `roomPictureTurnRefusal` would answer null for the
 * row as it stands. An UPDATE and no upsert: a wallet with no row has no first message, is refused, and
 * gets no row. The right-hand sides read the row as it was before the statement.
 * ?1 address, ?2 now, ?3 day, ?4 the wallet's messages of a day, ?5 the latest time a last message may
 * carry, ?6 the latest time a first message may carry, ?7 the pause, ?8 the wallet's pictures of a day.
 */
const TAKE_PICTURE_TURN = `
UPDATE room_writers SET
  last_at = ?2,
  day = ?3,
  count = CASE WHEN day IS ?3 THEN count + 1 ELSE 1 END,
  pictures_day = ?3,
  pictures_count = CASE WHEN pictures_day IS ?3 THEN pictures_count + 1 ELSE 1 END
WHERE address = ?1
  AND muted_at IS NULL
  AND NOT (day IS ?3 AND count >= ?4)
  AND (last_at IS NULL OR last_at <= ?5)
  AND cut_at IS NULL
  AND first_at IS NOT NULL
  AND first_at <= ?6
  AND (SELECT COUNT(*) FROM room_messages INDEXED BY room_messages_pic_reported
       WHERE author = ?1 AND pic_state = 'reported') < ?7
  AND NOT (pictures_day IS ?3 AND pictures_count >= ?8)`;

/**
 * One INSERT that makes the message and its picture together, only while the writer is not muted and
 * pictures are not switched off. ?1 now, ?2 author, ?3 the contract's word, ?4 type, ?5 key, ?6 bytes,
 * ?7 width, ?8 height, ?9 frames, ?10 SHA-256.
 */
const PUT_PICTURE = `
INSERT INTO room_messages
  (at, author, text, pic_type, pic_key, pic_bytes, pic_width, pic_height, pic_frames, pic_sha256, pic_state)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'ok'
WHERE NOT EXISTS (SELECT 1 FROM room_writers WHERE address = ?2 AND muted_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM room_flags WHERE name = '${PICTURES_OFF}')
RETURNING id, at, author, text, hidden_at, hidden_by,
  pic_type, pic_key, pic_bytes, pic_width, pic_height, pic_frames, pic_sha256, pic_state, pic_reports,
  pic_decided_at, pic_decided_by, pic_gone_at`;

/** Which of the two refused an insert, read in its batch. ?1 author. */
const PUT_PICTURE_REFUSED = `
SELECT
  EXISTS (SELECT 1 FROM room_writers WHERE address = ?1 AND muted_at IS NOT NULL) AS muted,
  EXISTS (SELECT 1 FROM room_flags WHERE name = '${PICTURES_OFF}') AS off`;

/**
 * What the report route looks at, without writing: the picture's writer, whether the picture is one the
 * public may see and report (`seenByThePublic` with the state `ok` alone), whether this wallet reported
 * it, and the reporter's row. No row when no message has that id or it has no picture.
 * ?1 id, ?2 reporter, ?3 scan, ?4 the time seven days before now.
 */
const LOOK_REPORT = `
SELECT m.author AS author,
  (${seenByThePublic("'ok'", '?3', '?4')}) AS is_open,
  EXISTS (SELECT 1 FROM room_picture_reports WHERE message_id = ?1 AND reporter = ?2) AS already,
  ${uploaderColumns('r', 'r_')}
FROM room_messages AS m
LEFT JOIN room_writers AS w ON w.address = m.author
LEFT JOIN room_writers AS r ON r.address = ?2
WHERE m.id = ?1 AND m.pic_type IS NOT NULL`;

/** True in a batch of `putReport` from its insert to its last statement, exactly when that batch inserted a row. */
const THIS_BATCH_COUNTED = 'm.pic_reports < (SELECT COUNT(*) FROM room_picture_reports WHERE message_id = m.id)';

/**
 * The report's row, under every condition `lookReport` only looked at: the picture is open, and
 * `roomPictureReportRefusal` would answer null for the reporter's row as it stands. A second report of one
 * picture by one wallet meets the primary key and changes nothing, however many are sent at once.
 * ?1 id, ?2 reporter, ?3 scan, ?4 now, ?5 the time seven days before now, ?6 the latest time a reporter's
 * first message may carry, ?7 the strikes, ?8 day, ?9 the wallet's reports of a day.
 */
const PUT_REPORT = `
INSERT INTO room_picture_reports (message_id, reporter, at)
SELECT m.id, r.address, ?4
FROM room_messages AS m
LEFT JOIN room_writers AS w ON w.address = m.author
JOIN room_writers AS r ON r.address = ?2
WHERE m.id = ?1
  AND ${seenByThePublic("'ok'", '?3', '?5')}
  AND r.muted_at IS NULL
  AND r.cut_at IS NULL
  AND r.first_at IS NOT NULL
  AND r.first_at <= ?6
  AND r.report_strikes < ?7
  AND m.author <> r.address
  AND NOT (r.reports_day IS ?8 AND r.reports_count >= ?9)
ON CONFLICT (message_id, reporter) DO NOTHING`;

/** The reporter's count of the day, only when this batch counted the report. ?1 id, ?2 reporter, ?3 day. */
const COUNT_REPORTER = `
UPDATE room_writers SET
  reports_day = ?3,
  reports_count = CASE WHEN reports_day IS ?3 THEN reports_count + 1 ELSE 1 END
WHERE address = ?2
  AND EXISTS (SELECT 1 FROM room_messages AS m WHERE m.id = ?1 AND ${THIS_BATCH_COUNTED})`;

/**
 * One more on the hour's count of pictures hidden by reports, only when this batch counted the report and
 * that report is the one that hides: the picture is still `ok` and its count reaches the threshold with
 * it. What this changed is `hid`. ?1 id, ?2 the hides' key, ?3 now, ?4 the reports that hide.
 */
const COUNT_HIDE = `
INSERT INTO counters (key, n, updated_at)
SELECT ?2, 1, ?3 FROM room_messages AS m
WHERE m.id = ?1
  AND m.pic_state = 'ok'
  AND ${THIS_BATCH_COUNTED}
  AND m.pic_reports + 1 >= ?4
ON CONFLICT (key) DO UPDATE SET n = n + 1, updated_at = excluded.updated_at`;

/**
 * The switch, set by itself, under the same condition and when the hour's count has reached its figure.
 * A row that is there stays: the first reason stays. What this changed is `off`.
 * ?1 id, ?2 now, ?3 the reports that hide, ?4 the hides' key, ?5 the hidden pictures that switch pictures off.
 */
const AUTO_OFF = `
INSERT INTO room_flags (name, at, by, why)
SELECT '${PICTURES_OFF}', ?2, '${AUTO}', 'reports_hour' FROM room_messages AS m
WHERE m.id = ?1
  AND m.pic_state = 'ok'
  AND ${THIS_BATCH_COUNTED}
  AND m.pic_reports + 1 >= ?3
  AND (SELECT n FROM counters WHERE key = ?4) >= ?5
ON CONFLICT (name) DO NOTHING`;

/**
 * The picture's count, and the state `reported` at the threshold: the last statement of the batch, which
 * brings `pic_reports` level with the rows again. ?1 id, ?2 the reports that hide.
 */
const COUNT_PICTURE = `
UPDATE room_messages AS m SET
  pic_state = CASE WHEN m.pic_reports + 1 >= ?2 THEN 'reported' ELSE m.pic_state END,
  pic_reports = m.pic_reports + 1
WHERE m.id = ?1 AND ${THIS_BATCH_COUNTED}`;

/**
 * The record of a removal, written before the state changes: the bytes by their SHA-256, who removed
 * them and when, the message, the writer's whole address, when it was posted, its type, size and
 * dimensions and its count of reports. Never a reporter's address. A row that is there for the same bytes
 * stays as it is. ?1 id, ?2 now, ?3 the admin.
 */
const PUT_BLOCK = `
INSERT INTO room_picture_blocks
  (sha256, at, by, message_id, author, posted_at, type, bytes, width, height, frames, reports)
SELECT pic_sha256, ?2, ?3, id, author, at, pic_type, pic_bytes, pic_width, pic_height, pic_frames, pic_reports
FROM room_messages
WHERE id = ?1 AND pic_type IS NOT NULL AND pic_state <> 'removed'
ON CONFLICT (sha256) DO NOTHING`;

/** A picture removed once: one that is removed keeps the time and the admin of its removal. ?1 id, ?2 now, ?3 the admin. */
const REMOVE_PICTURE = `
UPDATE room_messages SET pic_state = 'removed', pic_decided_at = ?2, pic_decided_by = ?3
WHERE id = ?1 AND pic_type IS NOT NULL AND pic_state <> 'removed'`;

/**
 * A removed picture whose message is seven days old gives up its key in the batch that removes it, and no
 * KV call follows: its bytes have expired or are about to. ?1 id, ?2 now, ?3 the time seven days before now.
 */
const GIVE_UP_KEY = `
UPDATE room_messages SET pic_key = NULL, pic_gone_at = ?2
WHERE id = ?1 AND pic_state = 'removed' AND pic_key IS NOT NULL AND at <= ?3`;

/**
 * A hide of the message that set its writer's `first_at` clears it, for a message of text and for a
 * picture alike: a first line that an admin hid opens neither pictures nor reports. ?1 id.
 */
const CLEAR_FIRST_AT = `
UPDATE room_writers SET first_at = NULL
WHERE address = (SELECT author FROM room_messages WHERE id = ?1 AND hidden_at IS NOT NULL)
  AND first_at = (SELECT at FROM room_messages WHERE id = ?1)`;

const AFTER_HIDE = 'SELECT pic_key AS key, pic_reports AS reports FROM room_messages WHERE id = ?1';

/**
 * Every picture of a writer that is not removed, removed. A picture that is not removed has its key (a
 * key is given up only at or after a removal), so the writer's pictures are a range of the partial index
 * `room_messages_pic_live`. ?1 the writer, ?2 now, ?3 the admin.
 */
const REMOVE_PICTURES_OF = `
UPDATE room_messages INDEXED BY room_messages_pic_live
SET pic_state = 'removed', pic_decided_at = ?2, pic_decided_by = ?3
WHERE author = ?1 AND pic_key IS NOT NULL AND pic_state <> 'removed'`;

/** As `GIVE_UP_KEY`, for every removed picture of a writer. ?1 the writer, ?2 now, ?3 the time seven days before now. */
const GIVE_UP_KEYS_OF = `
UPDATE room_messages INDEXED BY room_messages_pic_live
SET pic_key = NULL, pic_gone_at = ?2
WHERE author = ?1 AND pic_key IS NOT NULL AND pic_state = 'removed' AND at <= ?3`;

/** The writer's removed pictures that still have a key, newest first. ?1 the writer, ?2 limit. */
const KEYS_OF = `
SELECT id, pic_key AS key
FROM room_messages INDEXED BY room_messages_pic_live
WHERE author = ?1 AND pic_key IS NOT NULL AND pic_state = 'removed'
ORDER BY id DESC
LIMIT ?2`;

/** One strike for every wallet that reported a picture, only while it can still be kept. ?1 id. */
const STRIKE_REPORTERS = `
UPDATE room_writers SET report_strikes = report_strikes + 1
WHERE address IN (SELECT reporter FROM room_picture_reports WHERE message_id = ?1)
  AND EXISTS (SELECT 1 FROM room_messages
              WHERE id = ?1 AND pic_type IS NOT NULL AND pic_state IN ('ok', 'reported'))`;

/** Kept once, from `ok` or `reported`. ?1 id, ?2 now, ?3 the admin. */
const KEEP_PICTURE = `
UPDATE room_messages SET pic_state = 'kept', pic_decided_at = ?2, pic_decided_by = ?3
WHERE id = ?1 AND pic_type IS NOT NULL AND pic_state IN ('ok', 'reported')`;

const STATE_OF = 'SELECT pic_state AS state FROM room_messages WHERE id = ?1 AND pic_type IS NOT NULL';

/**
 * The bytes Prix still owes a delete, newest first: the partial index `room_messages_pic_owed` holds
 * removed pictures with a key and no other row, so a run with nothing owed reads at most one row (the
 * seek that found nothing, which D1 books) and never the table. ?1 limit.
 */
const LIST_OWED = `
SELECT id, pic_key AS key
FROM room_messages INDEXED BY room_messages_pic_owed
WHERE pic_state = 'removed' AND pic_key IS NOT NULL
ORDER BY id DESC
LIMIT ?1`;

/** The admins' page: the statement of `RoomStore.listAllMessages` with each message's picture. ?1 before, ?2 limit. */
const LIST_ALL_WITH_PICTURES = `
SELECT ${PICTURE_MESSAGE_COLUMNS},
  w.muted_at IS NOT NULL AS muted,
  (w.cut_at IS NOT NULL AND m.at <= w.cut_at) AS cut
FROM room_messages AS m LEFT JOIN room_writers AS w ON w.address = m.author
WHERE m.id < ?1
ORDER BY m.id DESC
LIMIT ?2`;

/** The pictures that wait for an admin, oldest first, over the partial index of reported pictures. ?1 limit. */
const REPORTED_IDS = `
SELECT m.id FROM room_messages AS m INDEXED BY room_messages_pic_reported
WHERE m.pic_state = 'reported'
ORDER BY m.id
LIMIT ?1`;
const LIST_REPORTED = `
SELECT ${PICTURE_MESSAGE_COLUMNS}
FROM room_messages AS m
WHERE m.id IN (${REPORTED_IDS})
ORDER BY m.id`;
const LIST_REPORTERS = `
SELECT r.message_id, r.reporter, r.at
FROM room_picture_reports AS r
WHERE r.message_id IN (${REPORTED_IDS})
ORDER BY r.message_id, r.at, r.reporter`;

/** The switch, set unless it is set: the first reason stays. ?1 now, ?2 who, ?3 why. */
const SET_OFF = `
INSERT INTO room_flags (name, at, by, why) VALUES ('${PICTURES_OFF}', ?1, ?2, ?3)
ON CONFLICT (name) DO NOTHING`;

/**
 * The two counts that switch pictures off by themselves, deleted only when the switch is set: before the
 * statement that deletes the row, in its batch. ?1 the reports' key of the day, ?2 the hides' key of the hour.
 */
const CLEAR_OFF_COUNTERS = `
DELETE FROM counters
WHERE key IN (?1, ?2) AND EXISTS (SELECT 1 FROM room_flags WHERE name = '${PICTURES_OFF}')`;
const CLEAR_OFF = `DELETE FROM room_flags WHERE name = '${PICTURES_OFF}'`;

type Row = Record<string, unknown>;

/** The rows of one statement of a batch whose statements answer different shapes. */
function rowsOf<T>(result: D1Result<Row> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

export function createRoomPictureStore(db: D1Database): RoomPictureStore {
  function prepare(statement: string, ...values: Bound[]): D1PreparedStatement {
    return db.prepare(statement).bind(...values);
  }

  /** One statement, and its first row or null. */
  async function one<T>(statement: D1PreparedStatement): Promise<T | null> {
    const result = await statement.all<T>();
    return result.results[0] ?? null;
  }

  const lower = (address: Address): Address => address.toLowerCase();

  const store: RoomPictureStore = {
    async readRoom(limit, scan, viewsKey) {
      const [messages, off, views] = await db.batch<Row>([
        prepare(READ_ROOM, wholeNumber(limit, 'limit'), wholeNumber(scan, 'scan')),
        prepare(GET_OFF),
        prepare(GET_COUNTER, viewsKey),
      ]);
      const flag = rowsOf<OffSql>(off)[0];
      return {
        messages: rowsOf<PictureMessageSql & AuthorHolderSql>(messages).map((row) =>
          withAuthorHolder(toPictureMessage(row), row),
        ),
        off: flag === undefined ? null : toOff(flag),
        views: rowsOf<{ n: number }>(views)[0]?.n ?? 0,
      };
    },

    async getServable(id, scan, now, viewsKey) {
      const row = await one<{
        views: number;
        key: string | null;
        type: string | null;
        bytes: number | null;
        author: string | null;
      }>(
        prepare(
          GET_SERVABLE,
          wholeNumber(id, 'id'),
          wholeNumber(scan, 'scan'),
          before(now, ROOM_PICTURE_TTL_SECONDS),
          viewsKey,
        ),
      );
      if (row === null) throw new Error('room pictures: the gate came back with no row');
      const { key, type, bytes, author } = row;
      if (key === null || type === null || bytes === null || author === null) {
        return { picture: null, views: row.views };
      }
      return { picture: toServable({ key, type, bytes, author }), views: row.views };
    },

    async addViews(viewsKey, add, now) {
      const row = await one<{ n: number }>(prepare(ADD_VIEWS, viewsKey, wholeNumber(add, 'add'), now));
      if (row === null) throw new Error('room pictures: the views were counted and no count came back');
      return row.n;
    },

    async getAdminPicture(id, now) {
      const row = await one<{ key: string; type: string; bytes: number; author: string }>(
        prepare(GET_ADMIN_PICTURE, wholeNumber(id, 'id'), before(now, ROOM_PICTURE_TTL_SECONDS)),
      );
      return row === null ? null : toServable(row);
    },

    async getUploader(address) {
      const row = await one<UploaderSql>(prepare(GET_UPLOADER, lower(address)));
      return row === null ? null : toUploader(row);
    },

    async getPictureCounts(keys) {
      const row = await one<{
        off_at: string | null;
        off_by: string | null;
        off_why: string | null;
        hour: number;
        day: number;
        picture_hour: number;
        picture_day: number;
      }>(prepare(GET_PICTURE_COUNTS, keys.hour, keys.day, keys.pictureHour, keys.pictureDay));
      if (row === null) throw new Error("room pictures: the room's counts came back with no row");
      const set = row.off_at !== null && row.off_by !== null && row.off_why !== null;
      return {
        off: set ? toOff({ at: row.off_at ?? '', by: row.off_by ?? '', why: row.off_why ?? '' }) : null,
        hour: row.hour,
        day: row.day,
        pictureHour: row.picture_hour,
        pictureDay: row.picture_day,
      };
    },

    async isBlocked(sha256) {
      return (await one<{ found: number }>(prepare(IS_BLOCKED, sha256))) !== null;
    },

    async takePictureTurn(address, now, day, dayCap = ROOM_MESSAGES_PER_WALLET_PER_DAY): Promise<RoomPictureTurn> {
      const writer = lower(address);
      // Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2.2): a picture is a message, and counts
      // against the wallet's cap of the day by its holding.
      const cap = wholeNumber(dayCap, 'dayCap');
      const [taken, read] = await db.batch<Row>([
        prepare(
          TAKE_PICTURE_TURN,
          writer,
          now,
          day,
          cap,
          before(now, ROOM_SECONDS_BETWEEN),
          before(now, ROOM_PICTURE_WRITER_AGE_SECONDS),
          ROOM_REPORTED_PICTURES_PAUSE,
          ROOM_PICTURES_PER_WALLET_PER_DAY,
        ),
        prepare(GET_UPLOADER, writer),
      ]);
      const row = rowsOf<UploaderSql>(read)[0];
      // A wallet with no row has no first message: refused, and the UPDATE made no row for it.
      if (row === undefined) return { ok: false, why: 'new_writer' };
      const record = toUploader(row);
      // Whether the turn was counted is what the write changed, never a judgement of the row read after
      // it: a counted turn leaves `now` as the row's last message, and the row then reads as `too_soon`.
      if (changesOf(taken) > 0) {
        return {
          ok: true,
          left: Math.max(0, cap - record.count),
          picturesLeft: roomPicturesLeft(record, day),
        };
      }
      // Nothing was written, so the row is the one that refused: it names the reason, in the contract's order.
      const why = roomPictureTurnRefusal(record, now, day, cap);
      if (why === null) throw new Error("room pictures: a picture's turn was refused and its row names no reason");
      return { ok: false, why };
    },

    async putPicture(input) {
      if (!roomPictureKeySchema.safeParse(input.key).success) throw new Error("room pictures: not a picture's key");
      if (!roomPictureSha256Schema.safeParse(input.sha256).success) throw new Error('room pictures: not a SHA-256');
      const author = lower(input.author);
      const [stored, refused] = await db.batch<Row>([
        prepare(
          PUT_PICTURE,
          input.now,
          author,
          ROOM_PICTURE_TEXT,
          pictureType(input.type),
          input.key,
          wholeNumber(input.bytes, 'bytes'),
          wholeNumber(input.width, 'width'),
          wholeNumber(input.height, 'height'),
          wholeNumber(input.frames, 'frames'),
          input.sha256,
        ),
        prepare(PUT_PICTURE_REFUSED, author),
      ]);
      const row = rowsOf<PictureMessageSql>(stored)[0];
      if (row !== undefined) return { ok: true, message: toPictureMessage(row) };
      // Nothing was written. The read of the same batch says which of the two refused, the writer first.
      const reason = rowsOf<{ muted: number; off: number }>(refused)[0];
      if (reason?.muted === 1) return { ok: false, why: 'muted' };
      if (reason?.off === 1) return { ok: false, why: 'off' };
      throw new Error('room pictures: a picture was not stored and nothing names the reason');
    },

    async lookReport(id, reporter, scan, now) {
      const row = await one<Row & { author: string; is_open: number; already: number }>(
        prepare(
          LOOK_REPORT,
          wholeNumber(id, 'id'),
          lower(reporter),
          wholeNumber(scan, 'scan'),
          before(now, ROOM_PICTURE_TTL_SECONDS),
        ),
      );
      if (row === null) return null;
      // The reporter's columns come back under `r_`; with no row of the reporter every one of them is null.
      const own: Row = {};
      for (const [name, value] of Object.entries(row)) {
        if (name.startsWith('r_')) own[name.slice(2)] = value;
      }
      return {
        open: row.is_open === 1,
        author: row.author,
        already: row.already === 1,
        reporter: typeof own.address === 'string' ? toUploader(own as unknown as UploaderSql) : null,
      };
    },

    async putReport(id, reporter, scan, now, day, hidesKey) {
      const message = wholeNumber(id, 'id');
      const wallet = lower(reporter);
      const [counted, , hid, off] = await db.batch([
        prepare(
          PUT_REPORT,
          message,
          wallet,
          wholeNumber(scan, 'scan'),
          now,
          before(now, ROOM_PICTURE_TTL_SECONDS),
          before(now, ROOM_PICTURE_REPORTER_AGE_SECONDS),
          ROOM_PICTURE_REPORT_STRIKES,
          day,
          ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY,
        ),
        prepare(COUNT_REPORTER, message, wallet, day),
        prepare(COUNT_HIDE, message, hidesKey, now, ROOM_PICTURE_REPORTS_TO_HIDE),
        prepare(AUTO_OFF, message, now, ROOM_PICTURE_REPORTS_TO_HIDE, hidesKey, ROOM_PICTURE_AUTO_OFF_REPORTED),
        // Last: it brings the picture's count level with its rows, which ends "this batch counted".
        prepare(COUNT_PICTURE, message, ROOM_PICTURE_REPORTS_TO_HIDE),
      ]);
      // Each answer is what its own statement changed, never a second judgement.
      return { counted: changesOf(counted) > 0, hid: changesOf(hid) > 0, off: changesOf(off) > 0 };
    },

    async hideWithPicture(id, by, now) {
      const message = wholeNumber(id, 'id');
      const admin = lower(by);
      const [, hidden, removed, , , read] = await db.batch<Row>([
        // Before the state changes: the record reads the picture as it was.
        prepare(PUT_BLOCK, message, now, admin),
        prepare(HIDE_MESSAGE, message, now, admin),
        prepare(REMOVE_PICTURE, message, now, admin),
        prepare(GIVE_UP_KEY, message, now, before(now, ROOM_PICTURE_TTL_SECONDS)),
        prepare(CLEAR_FIRST_AT, message),
        prepare(AFTER_HIDE, message),
      ]);
      const row = rowsOf<{ key: string | null; reports: number }>(read)[0];
      if (row === undefined) return { outcome: 'none', key: null, removed: false, reports: 0 };
      const didRemove = changesOf(removed) > 0;
      return {
        outcome: changesOf(hidden) > 0 ? 'hidden' : 'already',
        // After this batch a picture of this message is removed, so a key that is left is a delete owed.
        key: row.key,
        removed: didRemove,
        reports: didRemove ? row.reports : 0,
      };
    },

    async muteWithPictures(address, by, now, limit) {
      const writer = lower(address);
      const admin = lower(by);
      const [muted, removed, , keys] = await db.batch<Row>([
        prepare(MUTE_WRITER, writer, now, admin),
        prepare(REMOVE_PICTURES_OF, writer, now, admin),
        prepare(GIVE_UP_KEYS_OF, writer, now, before(now, ROOM_PICTURE_TTL_SECONDS)),
        prepare(KEYS_OF, writer, wholeNumber(limit, 'limit')),
      ]);
      return {
        muted: changesOf(muted) > 0,
        removed: changesOf(removed),
        pictures: rowsOf<{ id: number; key: string }>(keys).map((row) => ({ id: row.id, key: row.key })),
      };
    },

    async markGone(ids, now) {
      if (ids.length === 0) return;
      if (ids.length > ROOM_PICTURE_DELETES_PER_CALL) {
        throw new Error(`room pictures: markGone takes at most ${ROOM_PICTURE_DELETES_PER_CALL} ids`);
      }
      const places = ids.map((_, index) => `?${index + 2}`).join(', ');
      // A key that is null already keeps the time it was set to null at. Bound to the state inside the
      // statement (section 9, S2): the id of a picture that is not removed is left as it is, so no caller
      // can take the key of a picture Prix still serves.
      await prepare(
        `UPDATE room_messages SET pic_key = NULL, pic_gone_at = ?1
         WHERE id IN (${places}) AND pic_key IS NOT NULL AND pic_state = 'removed'`,
        now,
        ...ids.map((id) => wholeNumber(id, 'id')),
      ).run();
    },

    async keepPicture(id, by, now) {
      const message = wholeNumber(id, 'id');
      const [, kept, read] = await db.batch<Row>([
        // Before the state changes: the strikes are given only while the picture can still be kept.
        prepare(STRIKE_REPORTERS, message),
        prepare(KEEP_PICTURE, message, now, lower(by)),
        prepare(STATE_OF, message),
      ]);
      if (changesOf(kept) > 0) return 'kept';
      return rowsOf<{ state: string }>(read)[0]?.state === 'kept' ? 'already' : 'none';
    },

    async listOwedDeletes(limit) {
      const result = await prepare(LIST_OWED, wholeNumber(limit, 'limit')).all<{ id: number; key: string }>();
      return result.results.map((row) => ({ id: row.id, key: row.key }));
    },

    async listAllWithPictures(cursor, limit) {
      const result = await prepare(
        LIST_ALL_WITH_PICTURES,
        cursor === null ? NO_CURSOR : wholeNumber(cursor, 'before'),
        wholeNumber(limit, 'limit'),
      ).all<PictureMessageSql & { muted: number; cut: number }>();
      return result.results.map((row) => ({ ...toPictureMessage(row), muted: row.muted === 1, cut: row.cut === 1 }));
    },

    async listReported(limit) {
      const most = wholeNumber(limit, 'limit');
      const [messages, reports] = await db.batch<Row>([prepare(LIST_REPORTED, most), prepare(LIST_REPORTERS, most)]);
      const reporters = rowsOf<{ message_id: number; reporter: string; at: string }>(reports);
      return rowsOf<PictureMessageSql>(messages).map((row) => ({
        ...toPictureMessage(row),
        reporters: reporters
          .filter((report) => report.message_id === row.id)
          .map((report) => ({ address: report.reporter, at: report.at })),
      }));
    },

    async getPicturesOff() {
      const row = await one<OffSql>(prepare(GET_OFF));
      return row === null ? null : toOff(row);
    },

    async setPicturesOff(by, why: RoomPicturesOffReason, now) {
      const result = await prepare(SET_OFF, now, by === null ? AUTO : lower(by), why).run();
      return changesOf(result) > 0;
    },

    async clearPicturesOff(reportsKey, hidesKey) {
      const [, cleared] = await db.batch([prepare(CLEAR_OFF_COUNTERS, reportsKey, hidesKey), prepare(CLEAR_OFF)]);
      return changesOf(cleared) > 0;
    },
  };

  return store;
}
