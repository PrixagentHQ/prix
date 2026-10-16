import { env } from 'cloudflare:workers';
import type { RoomPictureInput, RoomPictureStore } from '@prix/contracts';
import {
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_PICTURE_AUTO_OFF_REPORTED,
  ROOM_PICTURE_DELETES_PER_CALL,
  ROOM_PICTURE_REPORT_STRIKES,
  ROOM_PICTURE_REPORTER_AGE_SECONDS,
  ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY,
  ROOM_PICTURE_REPORTS_TO_HIDE,
  ROOM_PICTURE_TEXT,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_VIEW_SAMPLE,
  ROOM_PICTURE_WRITER_AGE_SECONDS,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  ROOM_REPORTED_PICTURES_PAUSE,
  ROOM_SCAN,
  ROOM_SECONDS_BETWEEN,
  roomDayKey,
  roomHourKey,
  roomPictureDayKey,
  roomPictureHourKey,
  roomPictureReportHidesKey,
  roomPictureReportsKey,
  roomPictureTurnRefusal,
  roomPictureViewsKey,
} from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRoomStore } from './room.ts';
import { createRoomPictureBytes } from './room-picture-bytes.ts';
import { createRoomPictureStore } from './room-pictures.ts';

/**
 * The pictures' D1 store on a local D1 database, inside the Workers runtime, and the bytes port against a
 * fake KV: the rules of docs/contracts/phase-6-pictures.md sections 2, 5, 6, 7, 8 and 9 that only SQL can
 * get wrong. Every rule lives inside a statement, so each has a race here: the same call sent several
 * times at once, of which exactly as many pass as the rule allows.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const bindings = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
};
const db = bindings.DB;

const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';
const CAROL = '0x00000000000000000000000000000000000000c3';
const DAVE = '0x00000000000000000000000000000000000000d4';
const ERIN = '0x00000000000000000000000000000000000000e5';
const ADMIN = '0x00000000000000000000000000000000000009a1';
const DAY = '2026-10-11';
const HOUR = 10;

/** A time `seconds` after 10:00:00 UTC of DAY, as `toISOString()` writes it. */
function at(seconds: number): string {
  return new Date(Date.parse(`${DAY}T10:00:00.000Z`) + seconds * 1_000).toISOString();
}
/** The moment most tests call "now": two days after 10:00, so that a reporter's first message can be a day old. */
const NOW_SECONDS = 2 * 86_400;
const NOW = at(NOW_SECONDS);
const NOW_DAY = NOW.slice(0, 10);
/** Long enough before NOW for an upload and for a report. */
const OLD = at(0);

const sha = (n: number): string => n.toString(16).padStart(64, '0');
const key = (n: number): string => `pic/${n.toString(16).padStart(32, '0')}`;

/** What a method asked of D1: every statement it prepared, how many batches it sent, and whether it opened a session. */
interface Asked {
  statements: string[];
  batches: number;
  sessions: number;
  rowsRead: number;
}

/** The database, with every statement and every batch written down, and the rows each answer says it read. */
function watched(): { db: D1Database; asked: Asked } {
  const asked: Asked = { statements: [], batches: 0, sessions: 0, rowsRead: 0 };
  const meter = <T extends { meta?: { rows_read?: number } }>(result: T): T => {
    asked.rowsRead += result?.meta?.rows_read ?? 0;
    return result;
  };
  // A statement the store holds is a stand-in that meters its own answer; a batch is handed the real ones.
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const standIn = new Proxy(statement, {
      get(target, name) {
        if (name === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (name === 'all' || name === 'run') return async () => meter(await target[name]());
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    real.set(standIn, statement);
    return standIn;
  };
  const proxy = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          asked.statements.push(sql);
          return wrap(target.prepare(sql));
        };
      }
      if (name === 'batch') {
        return async (list: D1PreparedStatement[]) => {
          asked.batches += 1;
          const results = await target.batch(list.map((statement) => real.get(statement) ?? statement));
          for (const result of results) meter(result);
          return results;
        };
      }
      if (name === 'withSession') asked.sessions += 1;
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, asked };
}

/** One D1 call or one D1 batch: either one batch, or one statement and no batch. */
function isOneCall(asked: Asked): boolean {
  return asked.batches === 1 || (asked.batches === 0 && asked.statements.length === 1);
}

const pictures = createRoomPictureStore(db);
const room = createRoomStore(db);

/** A writer's row as a test needs it: a first message long ago, and whatever else it names. */
async function writer(address: string, columns: Record<string, string | number | null> = {}): Promise<void> {
  const row: Record<string, string | number | null> = { address, first_at: OLD, ...columns };
  const names = Object.keys(row);
  await db
    .prepare(`INSERT INTO room_writers (${names.join(', ')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`)
    .bind(...names.map((name) => row[name] ?? null))
    .run();
}

let nextPicture = 1;
function input(author: string, now: string, extra: Partial<RoomPictureInput> = {}): RoomPictureInput {
  const n = nextPicture;
  nextPicture += 1;
  return {
    author,
    now,
    key: key(n),
    type: 'png',
    width: 640,
    height: 480,
    frames: 1,
    bytes: 1_000 + n,
    sha256: sha(n),
    ...extra,
  };
}

/** A stored picture of `author`, written at `when`. Its writer gets a row when it has none. */
async function picture(author: string, when: string = NOW, extra: Partial<RoomPictureInput> = {}): Promise<number> {
  const has = await db.prepare('SELECT 1 FROM room_writers WHERE address = ?1').bind(author).first();
  if (has === null) await writer(author);
  const stored = await pictures.putPicture(input(author, when, extra));
  if (!stored.ok) throw new Error(`the test's picture was refused: ${stored.why}`);
  return stored.message.id;
}

async function column<T>(sql: string, ...values: (string | number)[]): Promise<T | null> {
  const row = await db
    .prepare(sql)
    .bind(...values)
    .first<{ v: T }>();
  return row === null ? null : row.v;
}

const pic = (id: number) =>
  db
    .prepare(
      `SELECT hidden_at, pic_key, pic_state, pic_reports, pic_decided_at, pic_decided_by, pic_gone_at
       FROM room_messages WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      hidden_at: string | null;
      pic_key: string | null;
      pic_state: string | null;
      pic_reports: number;
      pic_decided_at: string | null;
      pic_decided_by: string | null;
      pic_gone_at: string | null;
    }>();

const counter = (name: string) => column<number>('SELECT n AS v FROM counters WHERE key = ?1', name);
const HIDES = roomPictureReportHidesKey(NOW_DAY, HOUR);

/** Three reporters who may report: a first message a day old, never muted, no strike. */
const REPORTERS = [BOB, CAROL, DAVE] as const;
async function reporters(): Promise<void> {
  for (const address of REPORTERS) await writer(address);
}
const report = (id: number, reporter: string, now: string = NOW) =>
  pictures.putReport(id, reporter, ROOM_SCAN, now, now.slice(0, 10), HIDES);

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM room_messages'),
    db.prepare('DELETE FROM room_writers'),
    db.prepare('DELETE FROM room_picture_reports'),
    db.prepare('DELETE FROM room_picture_blocks'),
    db.prepare('DELETE FROM room_flags'),
    db.prepare("DELETE FROM counters WHERE key LIKE 'd:%:room:%'"),
  ]);
});

describe('migration 0013', () => {
  const columns = async (table: string): Promise<string[]> =>
    (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map(
      (row) => row.name,
    );

  it('adds the twelve columns of a picture to room_messages and the six of a writer to room_writers', async () => {
    expect(await columns('room_messages')).toEqual([
      'id',
      'at',
      'author',
      'text',
      'hidden_at',
      'hidden_by',
      'pic_type',
      'pic_key',
      'pic_bytes',
      'pic_width',
      'pic_height',
      'pic_frames',
      'pic_sha256',
      'pic_state',
      'pic_reports',
      'pic_decided_at',
      'pic_decided_by',
      'pic_gone_at',
    ]);
    expect(await columns('room_writers')).toEqual([
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
    ]);
  });

  it('makes the three tables, and the list of removed bytes holds no reporter', async () => {
    expect(await columns('room_picture_reports')).toEqual(['message_id', 'reporter', 'at']);
    expect(await columns('room_picture_blocks')).toEqual([
      'sha256',
      'at',
      'by',
      'message_id',
      'author',
      'posted_at',
      'type',
      'bytes',
      'width',
      'height',
      'frames',
      'reports',
    ]);
    expect(await columns('room_flags')).toEqual(['name', 'at', 'by', 'why']);
  });

  it('makes its three indexes partial, so that a message of text writes none of them', async () => {
    const indexes = (
      await db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'room_messages_pic_%'")
        .all<{ name: string; sql: string }>()
    ).results;

    expect(indexes.map((index) => index.name).sort()).toEqual([
      'room_messages_pic_live',
      'room_messages_pic_owed',
      'room_messages_pic_reported',
    ]);
    for (const index of indexes) expect(index.sql, index.name).toMatch(/\bWHERE\b/);
  });

  it("fills first_at from each writer's oldest message that is not hidden, and leaves the others null", async () => {
    const migration = bindings.TEST_MIGRATIONS.find(({ name }) => name.startsWith('0013_'));
    const fill = migration?.queries.find((query) => /UPDATE room_writers SET first_at/.test(query));
    expect(fill, "the migration's fill").toBeDefined();
    // ALICE: a hidden first line, then one that stands. BOB: only a hidden line. CAROL: no message left.
    await db.batch([
      db
        .prepare(
          `INSERT INTO room_messages (at, author, text, hidden_at, hidden_by) VALUES (?1, '${ALICE}', 'spam', ?2, '${ADMIN}')`,
        )
        .bind(at(0), at(5)),
      db.prepare(`INSERT INTO room_messages (at, author, text) VALUES (?1, '${ALICE}', 'second')`).bind(at(60)),
      db.prepare(`INSERT INTO room_messages (at, author, text) VALUES (?1, '${ALICE}', 'third')`).bind(at(120)),
      db
        .prepare(
          `INSERT INTO room_messages (at, author, text, hidden_at, hidden_by) VALUES (?1, '${BOB}', 'spam', ?2, '${ADMIN}')`,
        )
        .bind(at(10), at(20)),
      db.prepare(`INSERT INTO room_writers (address) VALUES ('${ALICE}'), ('${BOB}'), ('${CAROL}')`),
    ]);

    await db.prepare(fill ?? '').run();

    const rows = (
      await db
        .prepare('SELECT address, first_at FROM room_writers ORDER BY address')
        .all<{ address: string; first_at: string | null }>()
    ).results;
    expect(rows).toEqual([
      { address: ALICE, first_at: at(60) },
      { address: BOB, first_at: null },
      { address: CAROL, first_at: null },
    ]);
  });
});

describe('the runbook’s one statement for a hide by an older API (section 2, revision 4)', () => {
  /** The contract's statement, word for word (docs/contracts/phase-6-pictures.md, section 2). */
  const CONTRACT =
    'UPDATE room_writers SET first_at = NULL WHERE first_at IS NOT NULL AND EXISTS (SELECT 1 FROM room_messages WHERE author = room_writers.address AND at = room_writers.first_at AND hidden_at IS NOT NULL);';

  /** The statement the runbook prints, which is the contract's. */
  function printed(): string[] {
    return [CONTRACT];
  }

  /** What an API older than this phase does at a hide: `hidden_at` and `hidden_by`, and nothing else. */
  const hideAsAnOlderApi = (id: number, when: string) =>
    db.prepare("UPDATE room_messages SET hidden_at = ?2, hidden_by = 'old' WHERE id = ?1").bind(id, when).run();

  const firstAt = (address: string) =>
    column<string>('SELECT first_at AS v FROM room_writers WHERE address = ?1', address);

  it('clears the first_at that a hidden first message left, and no other', async () => {
    // ALICE: her first line was hidden by an older API, which left her first_at where it was.
    const spam = await room.putMessage(ALICE, 'spam', at(0));
    await room.putMessage(ALICE, 'a later line', at(120));
    await hideAsAnOlderApi(spam.id, at(5));
    // BOB: his first line stands, and a later line of his was hidden.
    await room.putMessage(BOB, 'a first line', at(10));
    const later = await room.putMessage(BOB, 'a later line', at(130));
    await hideAsAnOlderApi(later.id, at(140));
    // CAROL: a first_at whose message the prune took. DAVE: no first message that counts.
    await writer(CAROL, { first_at: at(20) });
    await writer(DAVE, { first_at: null });
    // ERIN: a line of hers at the very second of ALICE's hidden one stands.
    await room.putMessage(ERIN, 'the same second', at(0));
    expect(await firstAt(ALICE)).toBe(at(0));

    const [statement = ''] = printed();
    const result = await db.prepare(statement).run();

    expect(result.meta.changes).toBe(1);
    expect(await firstAt(ALICE)).toBeNull();
    expect(await firstAt(BOB)).toBe(at(10));
    expect(await firstAt(CAROL)).toBe(at(20));
    expect(await firstAt(DAVE)).toBeNull();
    expect(await firstAt(ERIN)).toBe(at(0));
    // What it is for: the wallet waits again from its next stored message, as after a hide of this phase.
    expect(await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).toEqual({ ok: false, why: 'new_writer' });
    expect(await pictures.takePictureTurn(BOB, NOW, NOW_DAY)).toMatchObject({ ok: true });
    const next = await room.putMessage(ALICE, 'a new first line', at(NOW_SECONDS + 60));
    expect(await firstAt(ALICE)).toBe(next.at);
  });

  it('changes nothing when it is run a second time, or when no hide of an older API happened', async () => {
    const spam = await room.putMessage(ALICE, 'spam', at(0));
    await room.putMessage(BOB, 'a first line', at(10));
    const [statement = ''] = printed();

    expect((await db.prepare(statement).run()).meta.changes).toBe(0);
    await hideAsAnOlderApi(spam.id, at(5));
    expect((await db.prepare(statement).run()).meta.changes).toBe(1);
    expect((await db.prepare(statement).run()).meta.changes).toBe(0);
    expect(await firstAt(BOB)).toBe(at(10));
  });

  it('finds nothing to clear after a hide of this phase, which clears first_at itself', async () => {
    const spam = await room.putMessage(ALICE, 'spam', at(0));
    await pictures.hideWithPicture(spam.id, ADMIN, at(5));
    expect(await firstAt(ALICE)).toBeNull();
    const [statement = ''] = printed();

    expect((await db.prepare(statement).run()).meta.changes).toBe(0);
  });

  it('reads the writers, and each writer’s messages through the index of the author, never the whole table', async () => {
    const [statement = ''] = printed();

    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all<{ detail: string }>();

    const steps = plan.results.map((step) => step.detail);
    expect(steps.some((step) => /room_messages USING INDEX room_messages_author \(author=\?\)/.test(step))).toBe(true);
    expect(steps.filter((step) => /\bSCAN\b/.test(step) && !/\bSCAN room_writers\b/.test(step))).toEqual([]);
  });
});

describe("the pictures' store: one D1 call or one batch for every method, and no D1 session", () => {
  it('asks D1 once for each of its methods, whatever it answers', async () => {
    await reporters();
    const id = await picture(ALICE);
    const calls: [string, (store: RoomPictureStore) => Promise<unknown>][] = [
      ['readRoom', (s) => s.readRoom(ROOM_PAGE, ROOM_SCAN, roomPictureViewsKey(NOW_DAY))],
      ['getServable', (s) => s.getServable(id, ROOM_SCAN, NOW, roomPictureViewsKey(NOW_DAY))],
      ['addViews', (s) => s.addViews(roomPictureViewsKey(NOW_DAY), ROOM_PICTURE_VIEW_SAMPLE, NOW)],
      ['getAdminPicture', (s) => s.getAdminPicture(id, NOW)],
      ['getUploader', (s) => s.getUploader(ALICE)],
      [
        'getPictureCounts',
        (s) =>
          s.getPictureCounts({
            hour: roomHourKey(NOW_DAY, HOUR),
            day: roomDayKey(NOW_DAY),
            pictureHour: roomPictureHourKey(NOW_DAY, HOUR),
            pictureDay: roomPictureDayKey(NOW_DAY),
          }),
      ],
      ['isBlocked', (s) => s.isBlocked(sha(1))],
      ['takePictureTurn', (s) => s.takePictureTurn(ALICE, NOW, NOW_DAY)],
      ['takePictureTurn of no row', (s) => s.takePictureTurn(ERIN, NOW, NOW_DAY)],
      ['putPicture', (s) => s.putPicture(input(ALICE, NOW))],
      ['lookReport', (s) => s.lookReport(id, BOB, ROOM_SCAN, NOW)],
      ['putReport', (s) => s.putReport(id, BOB, ROOM_SCAN, NOW, NOW_DAY, HIDES)],
      ['keepPicture', (s) => s.keepPicture(id, ADMIN, NOW)],
      ['hideWithPicture', (s) => s.hideWithPicture(id, ADMIN, NOW)],
      ['muteWithPictures', (s) => s.muteWithPictures(ALICE, ADMIN, NOW, ROOM_PICTURE_DELETES_PER_CALL)],
      ['markGone', (s) => s.markGone([id], NOW)],
      ['listOwedDeletes', (s) => s.listOwedDeletes(10)],
      ['listAllWithPictures', (s) => s.listAllWithPictures(null, ROOM_PAGE)],
      ['listReported', (s) => s.listReported(20)],
      ['getPicturesOff', (s) => s.getPicturesOff()],
      ['setPicturesOff', (s) => s.setPicturesOff(ADMIN, 'admin', NOW)],
      ['clearPicturesOff', (s) => s.clearPicturesOff(roomPictureReportsKey(NOW_DAY), HIDES)],
    ];

    for (const [name, call] of calls) {
      const { db: seen, asked } = watched();
      await call(createRoomPictureStore(seen));
      expect(isOneCall(asked), `${name}: ${asked.statements.length} statements, ${asked.batches} batches`).toBe(true);
      expect(asked.sessions, `${name} opened a D1 session`).toBe(0);
    }
  });
});

describe("the pictures' store: a picture's turn", () => {
  it('refuses a wallet with no row as new_writer and makes no row for it', async () => {
    expect(await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).toEqual({ ok: false, why: 'new_writer' });
    expect(await pictures.getUploader(ALICE)).toBeNull();
  });

  it("counts the message's turn and the wallet's picture of the day together, and says what is left of both", async () => {
    await writer(ALICE);

    const turn = await pictures.takePictureTurn(ALICE, NOW, NOW_DAY);

    expect(turn).toEqual({
      ok: true,
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1,
      picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY - 1,
    });
    expect(await pictures.getUploader(ALICE)).toMatchObject({
      lastAt: NOW,
      day: NOW_DAY,
      count: 1,
      picturesDay: NOW_DAY,
      picturesCount: 1,
    });
  });

  it('answers by what its write changed: a counted turn is ok though its row, read after it, would refuse', async () => {
    await writer(ALICE);

    const turn = await pictures.takePictureTurn(ALICE, NOW, NOW_DAY);

    expect(roomPictureTurnRefusal(await pictures.getUploader(ALICE), NOW, NOW_DAY)).toBe('too_soon');
    expect(turn.ok).toBe(true);
  });

  it('starts both counts again on another day', async () => {
    await writer(ALICE, { day: DAY, count: 7, pictures_day: DAY, pictures_count: 3, last_at: at(0) });

    expect(await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).toEqual({
      ok: true,
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1,
      picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY - 1,
    });
  });

  const tooNew = at(NOW_SECONDS - ROOM_PICTURE_WRITER_AGE_SECONDS + 1);
  const justOld = at(NOW_SECONDS - ROOM_PICTURE_WRITER_AGE_SECONDS);
  const refusals: [string, Record<string, string | number | null>, string][] = [
    ['muted', { muted_at: at(5), muted_by: ADMIN, cut_at: at(5) }, 'a writer who is muted now'],
    ['day', { day: NOW_DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY }, "the wallet's messages of the day"],
    ['too_soon', { last_at: at(NOW_SECONDS - ROOM_SECONDS_BETWEEN + 1) }, 'a last message 19 seconds ago'],
    ['not_allowed', { cut_at: at(5) }, 'a writer who was muted once: a lift gives back writing, not pictures'],
    ['new_writer', { first_at: null }, 'a writer with no first message that counts'],
    ['new_writer', { first_at: tooNew }, 'a first message a second short of the hour'],
    ['picture_day', { pictures_day: NOW_DAY, pictures_count: ROOM_PICTURES_PER_WALLET_PER_DAY }, 'three today'],
  ];
  for (const [why, columns, name] of refusals) {
    it(`refuses ${name} as ${why} and writes nothing`, async () => {
      await writer(ALICE, columns);
      const before = await pictures.getUploader(ALICE);

      expect(await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).toEqual({ ok: false, why });
      expect(await pictures.getUploader(ALICE)).toEqual(before);
    });
  }

  it('takes a turn at exactly the hour after the first message and at exactly the wait after the last', async () => {
    await writer(ALICE, { first_at: justOld, last_at: at(NOW_SECONDS - ROOM_SECONDS_BETWEEN) });

    expect((await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).ok).toBe(true);
  });

  it('refuses a writer with two pictures hidden by reports and not decided as paused, and takes one after a keep', async () => {
    await reporters();
    const ids = [await picture(ALICE, at(NOW_SECONDS - 100)), await picture(ALICE, at(NOW_SECONDS - 50))];
    expect(ROOM_REPORTED_PICTURES_PAUSE).toBe(ids.length);
    for (const id of ids) for (const reporter of REPORTERS) await report(id, reporter);
    expect((await pictures.getUploader(ALICE))?.reportedOpen).toBe(2);

    expect(await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).toEqual({ ok: false, why: 'paused' });
    await pictures.keepPicture(ids[0] ?? 0, ADMIN, NOW);
    expect((await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).ok).toBe(true);
  });

  it('names the reasons in the order of roomPictureTurnRefusal when several hold', async () => {
    await writer(ALICE, {
      cut_at: at(5),
      first_at: null,
      pictures_day: NOW_DAY,
      pictures_count: ROOM_PICTURES_PER_WALLET_PER_DAY,
    });

    expect(await pictures.takePictureTurn(ALICE, NOW, NOW_DAY)).toEqual({ ok: false, why: 'not_allowed' });
  });

  it('race: of eight turns of one wallet at once, one is counted', async () => {
    await writer(ALICE);

    const turns = await Promise.all(Array.from({ length: 8 }, () => pictures.takePictureTurn(ALICE, NOW, NOW_DAY)));

    expect(turns.filter((turn) => turn.ok)).toHaveLength(1);
    expect(turns.filter((turn) => !turn.ok && turn.why === 'too_soon')).toHaveLength(7);
    expect(await pictures.getUploader(ALICE)).toMatchObject({ count: 1, picturesCount: 1 });
  });

  it("race: the wallet's third and fourth picture of the day at once, from two last messages apart, are one", async () => {
    await writer(ALICE, { pictures_day: NOW_DAY, pictures_count: ROOM_PICTURES_PER_WALLET_PER_DAY - 1 });

    const turns = await Promise.all([
      pictures.takePictureTurn(ALICE, NOW, NOW_DAY),
      pictures.takePictureTurn(ALICE, at(NOW_SECONDS + ROOM_SECONDS_BETWEEN), NOW_DAY),
    ]);

    expect(turns.filter((turn) => turn.ok)).toHaveLength(1);
    expect((await pictures.getUploader(ALICE))?.picturesCount).toBe(ROOM_PICTURES_PER_WALLET_PER_DAY);
  });
});

describe("the pictures' store: what an upload looks at and stores", () => {
  it('reads the switch and the four counts in one statement, a key with no row as 0', async () => {
    const keys = {
      hour: roomHourKey(NOW_DAY, HOUR),
      day: roomDayKey(NOW_DAY),
      pictureHour: roomPictureHourKey(NOW_DAY, HOUR),
      pictureDay: roomPictureDayKey(NOW_DAY),
    };
    expect(await pictures.getPictureCounts(keys)).toEqual({
      off: null,
      hour: 0,
      day: 0,
      pictureHour: 0,
      pictureDay: 0,
    });

    await db.batch([
      db
        .prepare(
          "INSERT INTO counters (key, n, updated_at) VALUES (?1, 4, 'x'), (?2, 9, 'x'), (?3, 2, 'x'), (?4, 6, 'x')",
        )
        .bind(keys.hour, keys.day, keys.pictureHour, keys.pictureDay),
    ]);
    await pictures.setPicturesOff(null, 'reports_day', NOW);

    expect(await pictures.getPictureCounts(keys)).toEqual({
      off: { at: NOW, by: null, why: 'reports_day' },
      hour: 4,
      day: 9,
      pictureHour: 2,
      pictureDay: 6,
    });
  });

  it('stores the message and its picture in one row, with the contract’s own word as its text', async () => {
    await writer(ALICE);
    const given = input(ALICE, NOW, { type: 'gif', width: 320, height: 200, frames: 12 });

    const stored = await pictures.putPicture(given);

    expect(stored).toEqual({
      ok: true,
      message: {
        id: expect.any(Number),
        at: NOW,
        author: ALICE,
        text: ROOM_PICTURE_TEXT,
        hiddenAt: null,
        hiddenBy: null,
        picture: {
          type: 'gif',
          width: 320,
          height: 200,
          frames: 12,
          bytes: given.bytes,
          sha256: given.sha256,
          key: given.key,
          state: 'ok',
          reports: 0,
          decidedAt: null,
          decidedBy: null,
          goneAt: null,
        },
      },
    });
    expect(await column<number>('SELECT COUNT(*) AS v FROM room_messages')).toBe(1);
  });

  it('stores the author in lower case', async () => {
    await writer(ALICE);
    const stored = await pictures.putPicture(input(ALICE.toUpperCase().replace('0X', '0x'), NOW));

    expect(stored.ok && stored.message.author).toBe(ALICE);
  });

  it('refuses a muted writer and a room whose pictures are off, names which, and writes nothing', async () => {
    await writer(ALICE, { muted_at: at(5), muted_by: ADMIN, cut_at: at(5) });
    await writer(BOB);

    expect(await pictures.putPicture(input(ALICE, NOW))).toEqual({ ok: false, why: 'muted' });
    await pictures.setPicturesOff(ADMIN, 'admin', NOW);
    expect(await pictures.putPicture(input(BOB, NOW))).toEqual({ ok: false, why: 'off' });
    expect(await pictures.putPicture(input(ALICE, NOW))).toEqual({ ok: false, why: 'muted' });
    expect(await column<number>('SELECT COUNT(*) AS v FROM room_messages')).toBe(0);
  });

  it('race: an insert beside a mute leaves no picture of the writer that could be served, whichever came first', async () => {
    for (let round = 0; round < 6; round += 1) {
      const author = `0x${String(round).padStart(40, '6')}`;
      await writer(author);
      const calls = [
        () => pictures.putPicture(input(author, NOW)),
        () => pictures.muteWithPictures(author, ADMIN, NOW, ROOM_PICTURE_DELETES_PER_CALL),
      ] as const;
      // Sent in one order in even rounds and in the other in odd ones.
      const [stored] = await (round % 2 === 0
        ? Promise.all([calls[0](), calls[1]()])
        : Promise.all([calls[1](), calls[0]()]).then(([mute, put]) => [put, mute] as const));

      // Stored before the mute: the mute's own batch removed it. After it: the insert was refused.
      const states = (
        await db
          .prepare('SELECT pic_state FROM room_messages WHERE author = ?1')
          .bind(author)
          .all<{ pic_state: string }>()
      ).results.map((row) => row.pic_state);
      expect(states, `round ${round}`).toEqual(stored.ok ? ['removed'] : []);
      if (!stored.ok) expect(stored.why).toBe('muted');
    }
  });

  it('race: an insert beside the switch is stored before it or refused as off, and names the reason', async () => {
    for (let round = 0; round < 6; round += 1) {
      await db.prepare('DELETE FROM room_flags').run();
      const author = `0x${String(round).padStart(40, '5')}`;
      await writer(author);
      const put = () => pictures.putPicture(input(author, NOW));
      const off = () => pictures.setPicturesOff(ADMIN, 'admin', NOW);
      const [stored, switched] = await (round % 2 === 0
        ? Promise.all([put(), off()])
        : Promise.all([off(), put()]).then(([o, p]) => [p, o] as const));

      expect(switched).toBe(true);
      if (!stored.ok) expect(stored.why).toBe('off');
      const count = await column<number>('SELECT COUNT(*) AS v FROM room_messages WHERE author = ?1', author);
      expect(count, `round ${round}`).toBe(stored.ok ? 1 : 0);
      // Stored or not, the gate refuses from the switch's statement on.
      if (stored.ok) {
        const gate = await pictures.getServable(stored.message.id, ROOM_SCAN, NOW, roomPictureViewsKey(NOW_DAY));
        expect(gate.picture).toBeNull();
      }
    }
  });

  it('knows removed bytes by their hash, and only those', async () => {
    const id = await picture(ALICE, NOW, { sha256: sha(777) });
    expect(await pictures.isBlocked(sha(777))).toBe(false);

    await pictures.hideWithPicture(id, ADMIN, NOW);

    expect(await pictures.isBlocked(sha(777))).toBe(true);
    expect(await pictures.isBlocked(sha(778))).toBe(false);
  });
});

describe("the pictures' store: the gate of the bytes route", () => {
  const VIEWS = roomPictureViewsKey(NOW_DAY);
  const gate = (id: number, now: string = NOW) => pictures.getServable(id, ROOM_SCAN, now, VIEWS);

  it('answers where the bytes are and what the server wrote of them, with the day’s views', async () => {
    const given = input(ALICE, NOW, { type: 'jpeg' });
    await writer(ALICE);
    const stored = await pictures.putPicture(given);
    const id = stored.ok ? stored.message.id : 0;
    await pictures.addViews(VIEWS, 50, NOW);

    expect(await gate(id)).toEqual({
      picture: { key: given.key, type: 'jpeg', bytes: given.bytes, author: ALICE },
      views: 50,
    });
  });

  it('serves a kept picture, and answers the views whatever the picture is', async () => {
    const id = await picture(ALICE);
    await pictures.keepPicture(id, ADMIN, NOW);
    await pictures.addViews(VIEWS, 25, NOW);

    expect((await gate(id)).picture).not.toBeNull();
    expect(await gate(id + 1_000)).toEqual({ picture: null, views: 25 });
  });

  const closed: [string, (id: number) => Promise<unknown>][] = [
    ['a message of text', async () => undefined],
    [
      'a picture hidden by reports',
      async (id) => db.prepare("UPDATE room_messages SET pic_state = 'reported' WHERE id = ?1").bind(id).run(),
    ],
    [
      'a removed picture',
      async (id) => db.prepare("UPDATE room_messages SET pic_state = 'removed' WHERE id = ?1").bind(id).run(),
    ],
    [
      'a picture whose key is gone',
      async (id) => db.prepare('UPDATE room_messages SET pic_key = NULL WHERE id = ?1').bind(id).run(),
    ],
    [
      'a hidden message',
      async (id) => db.prepare("UPDATE room_messages SET hidden_at = 'x' WHERE id = ?1").bind(id).run(),
    ],
    [
      'a writer who is muted now',
      async () => db.prepare(`UPDATE room_writers SET muted_at = '${at(5)}' WHERE address = '${ALICE}'`).run(),
    ],
    [
      'a picture at or before its writer’s cut',
      async () => db.prepare(`UPDATE room_writers SET cut_at = '${NOW}' WHERE address = '${ALICE}'`).run(),
    ],
    ['pictures switched off', async () => pictures.setPicturesOff(ADMIN, 'admin', NOW)],
  ];
  for (const [name, close] of closed) {
    it(`answers null for ${name}, in the same shape as for any other reason`, async () => {
      const id = name === 'a message of text' ? (await room.putMessage(ALICE, 'a line', NOW)).id : await picture(ALICE);
      await close(id);

      expect(await gate(id)).toEqual({ picture: null, views: 0 });
    });
  }

  it('answers null for a picture at the edge of the newest ROOM_SCAN ids, and serves the one above it', async () => {
    const first = await picture(ALICE);
    const second = await picture(ALICE);
    await db
      .prepare(
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'line ' || i FROM n`,
      )
      .bind(ROOM_SCAN - 1, NOW, BOB)
      .run();

    expect((await gate(first)).picture).toBeNull();
    expect((await gate(second)).picture).not.toBeNull();
  });

  it('answers null from the moment the message is seven days old, and serves it a millisecond before', async () => {
    const id = await picture(ALICE, NOW);
    const end = Date.parse(NOW) + ROOM_PICTURE_TTL_SECONDS * 1_000;

    expect((await gate(id, new Date(end - 1).toISOString())).picture).not.toBeNull();
    expect((await gate(id, new Date(end).toISOString())).picture).toBeNull();
  });

  it('reads at most five rows', async () => {
    const id = await picture(ALICE);
    await pictures.addViews(VIEWS, 25, NOW);
    await pictures.setPicturesOff(ADMIN, 'admin', NOW);
    const { db: seen, asked } = watched();

    await createRoomPictureStore(seen).getServable(id, ROOM_SCAN, NOW, VIEWS);

    expect(asked.rowsRead).toBeGreaterThan(0);
    expect(asked.rowsRead).toBeLessThanOrEqual(5);
  });

  it('adds views in one statement that makes the row and answers the count after it', async () => {
    expect(await pictures.addViews(VIEWS, ROOM_PICTURE_VIEW_SAMPLE, NOW)).toBe(ROOM_PICTURE_VIEW_SAMPLE);
    expect(await pictures.addViews(VIEWS, ROOM_PICTURE_VIEW_SAMPLE, NOW)).toBe(2 * ROOM_PICTURE_VIEW_SAMPLE);
    expect(await counter(VIEWS)).toBe(2 * ROOM_PICTURE_VIEW_SAMPLE);
  });

  it('race: twenty samples at once each answer their own count, so that exactly one crosses a cap', async () => {
    const counts = await Promise.all(
      Array.from({ length: 20 }, () => pictures.addViews(VIEWS, ROOM_PICTURE_VIEW_SAMPLE, NOW)),
    );

    expect([...counts].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => (i + 1) * ROOM_PICTURE_VIEW_SAMPLE),
    );
    const cap = 10 * ROOM_PICTURE_VIEW_SAMPLE;
    expect(counts.filter((count) => count >= cap && count - ROOM_PICTURE_VIEW_SAMPLE < cap)).toHaveLength(1);
  });

  it('lets an admin look at a reported picture and at one while pictures are off, and at none that is removed, hidden or old', async () => {
    await reporters();
    const id = await picture(ALICE);
    const removed = await picture(ALICE);
    for (const reporter of REPORTERS) await report(id, reporter);
    await pictures.setPicturesOff(ADMIN, 'admin', NOW);

    expect(await pictures.getAdminPicture(id, NOW)).toMatchObject({
      key: expect.stringMatching(/^pic\//),
      author: ALICE,
    });
    const end = new Date(Date.parse(NOW) + ROOM_PICTURE_TTL_SECONDS * 1_000).toISOString();
    expect(await pictures.getAdminPicture(id, end)).toBeNull();
    await db.prepare("UPDATE room_messages SET hidden_at = 'x' WHERE id = ?1").bind(id).run();
    expect(await pictures.getAdminPicture(id, NOW)).toBeNull();
    expect(await pictures.getAdminPicture(removed, NOW)).not.toBeNull();
    await pictures.hideWithPicture(removed, ADMIN, NOW);
    expect(await pictures.getAdminPicture(removed, NOW)).toBeNull();
    expect(await pictures.getAdminPicture((await room.putMessage(ALICE, 'a line', NOW)).id, NOW)).toBeNull();
  });
});

describe("the pictures' store: reports", () => {
  it('looks at a picture without writing: open, its writer, whether this wallet reported it, and the reporter’s row', async () => {
    await reporters();
    const id = await picture(ALICE);

    const look = await pictures.lookReport(id, BOB, ROOM_SCAN, NOW);

    expect(look).toMatchObject({ open: true, author: ALICE, already: false, reporter: { address: BOB, firstAt: OLD } });
    await report(id, BOB);
    expect(await pictures.lookReport(id, BOB, ROOM_SCAN, NOW)).toMatchObject({ open: true, already: true });
    expect(await pictures.lookReport(id, ERIN, ROOM_SCAN, NOW)).toMatchObject({ open: true, reporter: null });
    expect(await pictures.lookReport(id + 1_000, BOB, ROOM_SCAN, NOW)).toBeNull();
    expect(await pictures.lookReport((await room.putMessage(ALICE, 'a line', NOW)).id, BOB, ROOM_SCAN, NOW)).toBeNull();
  });

  it('says a kept, a reported, a removed and a switched-off picture are not open', async () => {
    await reporters();
    const kept = await picture(ALICE);
    await pictures.keepPicture(kept, ADMIN, NOW);
    const removed = await picture(ALICE);
    await pictures.hideWithPicture(removed, ADMIN, NOW);
    const open = await picture(ALICE);

    expect((await pictures.lookReport(kept, BOB, ROOM_SCAN, NOW))?.open).toBe(false);
    expect((await pictures.lookReport(removed, BOB, ROOM_SCAN, NOW))?.open).toBe(false);
    await pictures.setPicturesOff(ADMIN, 'admin', NOW);
    expect((await pictures.lookReport(open, BOB, ROOM_SCAN, NOW))?.open).toBe(false);
  });

  it('counts a report: its row, the reporter’s count of the day and the picture’s count, and leaves the room’s count alone', async () => {
    await reporters();
    const id = await picture(ALICE);

    expect(await report(id, BOB)).toEqual({ counted: true, hid: false, off: false });

    expect(
      await column<string>('SELECT at AS v FROM room_picture_reports WHERE message_id = ?1 AND reporter = ?2', id, BOB),
    ).toBe(NOW);
    expect(await pictures.getUploader(BOB)).toMatchObject({ reportsDay: NOW_DAY, reportsCount: 1 });
    expect(await pic(id)).toMatchObject({ pic_state: 'ok', pic_reports: 1 });
    expect(await counter(roomPictureReportsKey(NOW_DAY))).toBeNull();
    expect(await counter(HIDES)).toBeNull();
  });

  it('hides a picture at the third wallet and deletes nothing', async () => {
    await reporters();
    const id = await picture(ALICE);

    const answers = [];
    for (const reporter of REPORTERS) answers.push(await report(id, reporter));

    expect(REPORTERS).toHaveLength(ROOM_PICTURE_REPORTS_TO_HIDE);
    expect(answers).toEqual([
      { counted: true, hid: false, off: false },
      { counted: true, hid: false, off: false },
      { counted: true, hid: true, off: false },
    ]);
    expect(await pic(id)).toMatchObject({
      pic_state: 'reported',
      pic_reports: 3,
      pic_key: expect.any(String),
      hidden_at: null,
    });
    expect(await counter(HIDES)).toBe(1);
    // A fourth wallet finds it closed.
    await writer(ERIN);
    expect(await report(id, ERIN)).toEqual({ counted: false, hid: false, off: false });
    expect((await pic(id))?.pic_reports).toBe(3);
  });

  const day = NOW_DAY;
  const uncounted: [string, () => Promise<{ id: number; reporter: string }>][] = [
    [
      'a second report of one picture by one wallet',
      async () => {
        const id = await picture(ALICE);
        await report(id, BOB);
        return { id, reporter: BOB };
      },
    ],
    ['a report of the wallet’s own picture', async () => ({ id: await picture(BOB), reporter: BOB })],
    ['a wallet with no row', async () => ({ id: await picture(ALICE), reporter: ERIN })],
    [
      'a muted wallet',
      async () => {
        await db
          .prepare(`UPDATE room_writers SET muted_at = '${at(5)}', cut_at = '${at(5)}' WHERE address = '${BOB}'`)
          .run();
        return { id: await picture(ALICE), reporter: BOB };
      },
    ],
    [
      'a wallet that was muted once',
      async () => {
        await db.prepare(`UPDATE room_writers SET cut_at = '${at(5)}' WHERE address = '${BOB}'`).run();
        return { id: await picture(ALICE), reporter: BOB };
      },
    ],
    [
      'a wallet whose first message is 23 hours old',
      async () => {
        const young = at(NOW_SECONDS - ROOM_PICTURE_REPORTER_AGE_SECONDS + 3_600);
        await db.prepare(`UPDATE room_writers SET first_at = '${young}' WHERE address = '${BOB}'`).run();
        return { id: await picture(ALICE), reporter: BOB };
      },
    ],
    [
      'a wallet with no first message that counts',
      async () => {
        await db.prepare(`UPDATE room_writers SET first_at = NULL WHERE address = '${BOB}'`).run();
        return { id: await picture(ALICE), reporter: BOB };
      },
    ],
    [
      'a struck wallet',
      async () => {
        await db
          .prepare(`UPDATE room_writers SET report_strikes = ${ROOM_PICTURE_REPORT_STRIKES} WHERE address = '${BOB}'`)
          .run();
        return { id: await picture(ALICE), reporter: BOB };
      },
    ],
    [
      'a wallet at its cap of the day',
      async () => {
        await db
          .prepare(
            `UPDATE room_writers SET reports_day = '${day}', reports_count = ${ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY} WHERE address = '${BOB}'`,
          )
          .run();
        return { id: await picture(ALICE), reporter: BOB };
      },
    ],
    [
      'a kept picture',
      async () => {
        const id = await picture(ALICE);
        await pictures.keepPicture(id, ADMIN, NOW);
        return { id, reporter: BOB };
      },
    ],
    [
      'a picture of a hidden message',
      async () => {
        const id = await picture(ALICE);
        await db.prepare("UPDATE room_messages SET hidden_at = 'x' WHERE id = ?1").bind(id).run();
        return { id, reporter: BOB };
      },
    ],
    [
      'a picture whose writer is muted now',
      async () => {
        const id = await picture(ALICE);
        await db.prepare(`UPDATE room_writers SET muted_at = '${at(5)}' WHERE address = '${ALICE}'`).run();
        return { id, reporter: BOB };
      },
    ],
    [
      'a picture seven days old',
      async () => ({
        id: await picture(ALICE, at(NOW_SECONDS - ROOM_PICTURE_TTL_SECONDS)),
        reporter: BOB,
      }),
    ],
    [
      'a picture below the newest ROOM_SCAN ids',
      async () => {
        const id = await picture(ALICE);
        await db
          .prepare(
            `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
           INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'line ' || i FROM n`,
          )
          .bind(ROOM_SCAN, NOW, CAROL)
          .run();
        return { id, reporter: BOB };
      },
    ],
    [
      'pictures switched off',
      async () => {
        const id = await picture(ALICE);
        await pictures.setPicturesOff(ADMIN, 'admin', NOW);
        return { id, reporter: BOB };
      },
    ],
    ['a message of text', async () => ({ id: (await room.putMessage(ALICE, 'a line', NOW)).id, reporter: BOB })],
  ];
  for (const [name, arrange] of uncounted) {
    it(`does not count ${name}, and writes nothing`, async () => {
      await reporters();
      const { id, reporter } = await arrange();
      const snapshot = async () => ({
        reports: await column<number>('SELECT COUNT(*) AS v FROM room_picture_reports'),
        reporter: await pictures.getUploader(reporter),
        picture: await pic(id),
        hides: await counter(HIDES),
        flag: await pictures.getPicturesOff(),
      });
      const before = await snapshot();

      expect(await report(id, reporter)).toEqual({ counted: false, hid: false, off: false });
      expect(await snapshot()).toEqual(before);
    });
  }

  it('hides nothing and counts no hide for a report that is not counted, of a picture one report short of hidden', async () => {
    await reporters();
    await writer(ERIN, { report_strikes: ROOM_PICTURE_REPORT_STRIKES });
    const id = await picture(ALICE);
    await report(id, BOB);
    await report(id, CAROL);

    // A second report by a wallet that reported it, a struck wallet's, and the writer's own.
    for (const reporter of [BOB, ERIN, ALICE]) {
      expect(await report(id, reporter), reporter).toEqual({ counted: false, hid: false, off: false });
    }

    expect(await pic(id)).toMatchObject({ pic_state: 'ok', pic_reports: 2 });
    expect(await counter(HIDES)).toBeNull();
    expect(await pictures.getPicturesOff()).toBeNull();
  });

  it('does not switch pictures off for a report that is not counted, though the hour’s count is full', async () => {
    await reporters();
    const id = await picture(ALICE);
    await report(id, BOB);
    await report(id, CAROL);
    await db
      .prepare("INSERT INTO counters (key, n, updated_at) VALUES (?1, ?2, 'x')")
      .bind(HIDES, ROOM_PICTURE_AUTO_OFF_REPORTED)
      .run();

    expect(await report(id, BOB)).toEqual({ counted: false, hid: false, off: false });

    expect(await counter(HIDES)).toBe(ROOM_PICTURE_AUTO_OFF_REPORTED);
    expect(await pictures.getPicturesOff()).toBeNull();
  });

  it('starts a reporter’s count again on another day', async () => {
    await reporters();
    await db
      .prepare(
        `UPDATE room_writers SET reports_day = '${DAY}', reports_count = ${ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY} WHERE address = '${BOB}'`,
      )
      .run();
    const id = await picture(ALICE);

    expect((await report(id, BOB)).counted).toBe(true);
    expect(await pictures.getUploader(BOB)).toMatchObject({ reportsDay: NOW_DAY, reportsCount: 1 });
  });

  it('race: fifty reports of one picture by one wallet at once are counted once', async () => {
    await reporters();
    const id = await picture(ALICE);

    const answers = await Promise.all(Array.from({ length: 50 }, () => report(id, BOB)));

    expect(answers.filter((answer) => answer.counted)).toHaveLength(1);
    expect(await column<number>('SELECT COUNT(*) AS v FROM room_picture_reports')).toBe(1);
    expect((await pictures.getUploader(BOB))?.reportsCount).toBe(1);
    expect((await pic(id))?.pic_reports).toBe(1);
  });

  it('race: three wallets at once, each twice, hide the picture once and count it three times', async () => {
    await reporters();
    const id = await picture(ALICE);

    const answers = await Promise.all([...REPORTERS, ...REPORTERS].map((reporter) => report(id, reporter)));

    expect(answers.filter((answer) => answer.counted)).toHaveLength(3);
    expect(answers.filter((answer) => answer.hid)).toHaveLength(1);
    expect(await pic(id)).toMatchObject({ pic_state: 'reported', pic_reports: 3 });
    expect(await counter(HIDES)).toBe(1);
    for (const reporter of REPORTERS) expect((await pictures.getUploader(reporter))?.reportsCount).toBe(1);
  });

  it("race: a wallet's last report of the day and one more at once, of two pictures, are one", async () => {
    await reporters();
    await db
      .prepare(
        `UPDATE room_writers SET reports_day = '${NOW_DAY}', reports_count = ${ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY - 1} WHERE address = '${BOB}'`,
      )
      .run();
    const ids = [await picture(ALICE), await picture(ALICE)];

    const answers = await Promise.all(ids.map((id) => report(id, BOB)));

    expect(answers.filter((answer) => answer.counted)).toHaveLength(1);
    expect((await pictures.getUploader(BOB))?.reportsCount).toBe(ROOM_PICTURE_REPORTS_PER_WALLET_PER_DAY);
  });

  it('switches pictures off by itself at the fifth picture hidden in one hour, once, as `auto`', async () => {
    // Five pictures of five writers, each reported by its own three wallets: nobody reaches a cap of a day.
    const hidden: { hid: boolean; off: boolean }[] = [];
    for (let n = 0; n < ROOM_PICTURE_AUTO_OFF_REPORTED; n += 1) {
      const id = await picture(`0x${String(n).padStart(40, '7')}`);
      for (let r = 0; r < ROOM_PICTURE_REPORTS_TO_HIDE; r += 1) {
        const reporter = `0x${String(n * 10 + r).padStart(40, '8')}`;
        await writer(reporter);
        const answer = await report(id, reporter);
        if (r === ROOM_PICTURE_REPORTS_TO_HIDE - 1) hidden.push({ hid: answer.hid, off: answer.off });
      }
    }

    expect(hidden).toEqual([
      { hid: true, off: false },
      { hid: true, off: false },
      { hid: true, off: false },
      { hid: true, off: false },
      { hid: true, off: true },
    ]);
    expect(await counter(HIDES)).toBe(ROOM_PICTURE_AUTO_OFF_REPORTED);
    expect(await pictures.getPicturesOff()).toEqual({ at: NOW, by: null, why: 'reports_hour' });
    expect(await column<string>("SELECT by AS v FROM room_flags WHERE name = 'pictures_off'")).toBe('auto');
  });

  it('race: the report that hides the fifth picture of the hour, sent twice at once, switches pictures off once', async () => {
    await db
      .prepare("INSERT INTO counters (key, n, updated_at) VALUES (?1, ?2, 'x')")
      .bind(HIDES, ROOM_PICTURE_AUTO_OFF_REPORTED - 1)
      .run();
    await reporters();
    const id = await picture(ALICE);
    for (const reporter of REPORTERS.slice(0, 2)) await report(id, reporter);

    const answers = await Promise.all([report(id, DAVE), report(id, DAVE), report(id, DAVE)]);

    expect(answers.filter((answer) => answer.counted)).toHaveLength(1);
    expect(answers.filter((answer) => answer.hid)).toHaveLength(1);
    expect(answers.filter((answer) => answer.off)).toHaveLength(1);
    expect(await counter(HIDES)).toBe(ROOM_PICTURE_AUTO_OFF_REPORTED);
    expect(await pictures.getPicturesOff()).toEqual({ at: NOW, by: null, why: 'reports_hour' });
  });
});

describe("the pictures' store: an admin's hide", () => {
  it('hides a message of text as the room does, with no key and no picture removed', async () => {
    await writer(ALICE, { first_at: at(-500) });
    const message = await room.putMessage(ALICE, 'a line', NOW);

    expect(await pictures.hideWithPicture(message.id, ADMIN, at(NOW_SECONDS + 5))).toEqual({
      outcome: 'hidden',
      key: null,
      removed: false,
      reports: 0,
    });
    expect(await pictures.hideWithPicture(message.id, ADMIN, at(NOW_SECONDS + 9))).toMatchObject({
      outcome: 'already',
    });
    expect(await pictures.hideWithPicture(message.id + 1_000, ADMIN, NOW)).toEqual({
      outcome: 'none',
      key: null,
      removed: false,
      reports: 0,
    });
    // The first hide's time and admin stay.
    expect(await room.getMessage(message.id)).toMatchObject({ hiddenAt: at(NOW_SECONDS + 5), hiddenBy: ADMIN });
    expect(await column<number>('SELECT COUNT(*) AS v FROM room_picture_blocks')).toBe(0);
  });

  it('removes a picture in the same batch: state, who and when, the block row with the count of reports, and the key to delete', async () => {
    await reporters();
    const given = input(ALICE, NOW, { type: 'gif', width: 100, height: 80, frames: 4, sha256: sha(4242) });
    await writer(ALICE);
    const stored = await pictures.putPicture(given);
    const id = stored.ok ? stored.message.id : 0;
    await report(id, BOB);
    await report(id, CAROL);
    const later = at(NOW_SECONDS + 30);

    const answer = await pictures.hideWithPicture(id, ADMIN.toUpperCase().replace('0X', '0x'), later);

    expect(answer).toEqual({ outcome: 'hidden', key: given.key, removed: true, reports: 2 });
    expect(await pic(id)).toEqual({
      hidden_at: later,
      pic_key: given.key,
      pic_state: 'removed',
      pic_reports: 2,
      pic_decided_at: later,
      pic_decided_by: ADMIN,
      pic_gone_at: null,
    });
    expect(await db.prepare('SELECT * FROM room_picture_blocks').all()).toMatchObject({
      results: [
        {
          sha256: sha(4242),
          at: later,
          by: ADMIN,
          message_id: id,
          author: ALICE,
          posted_at: NOW,
          type: 'gif',
          bytes: given.bytes,
          width: 100,
          height: 80,
          frames: 4,
          reports: 2,
        },
      ],
    });
    // From that statement on D1 refuses it, whatever KV still holds.
    expect((await pictures.getServable(id, ROOM_SCAN, later, roomPictureViewsKey(NOW_DAY))).picture).toBeNull();
  });

  it('answers the key again at a second hide while it has one, and removes nothing twice', async () => {
    const id = await picture(ALICE);
    const first = await pictures.hideWithPicture(id, ADMIN, NOW);

    const second = await pictures.hideWithPicture(id, ADMIN, at(NOW_SECONDS + 60));

    expect(second).toEqual({ outcome: 'already', key: first.key, removed: false, reports: 0 });
    expect((await pic(id))?.pic_decided_at).toBe(NOW);
    await pictures.markGone([id], at(NOW_SECONDS + 61));
    expect(await pictures.hideWithPicture(id, ADMIN, at(NOW_SECONDS + 90))).toMatchObject({
      outcome: 'already',
      key: null,
    });
  });

  it('removes the picture of a message that an older API hid, and says so', async () => {
    const id = await picture(ALICE);
    await db.prepare("UPDATE room_messages SET hidden_at = ?2, hidden_by = 'old' WHERE id = ?1").bind(id, at(1)).run();

    expect(await pictures.hideWithPicture(id, ADMIN, NOW)).toMatchObject({ outcome: 'already', removed: true });
    expect((await pic(id))?.pic_state).toBe('removed');
  });

  it('gives up the key of a picture whose message is seven days old, in the batch, and answers no key', async () => {
    const written = at(NOW_SECONDS - ROOM_PICTURE_TTL_SECONDS);
    const old = await picture(ALICE, written);
    const young = await picture(ALICE, at(NOW_SECONDS - ROOM_PICTURE_TTL_SECONDS + 1));

    expect(await pictures.hideWithPicture(old, ADMIN, NOW)).toEqual({
      outcome: 'hidden',
      key: null,
      removed: true,
      reports: 0,
    });
    expect(await pic(old)).toMatchObject({ pic_state: 'removed', pic_key: null, pic_gone_at: NOW });
    expect((await pictures.hideWithPicture(young, ADMIN, NOW)).key).toMatch(/^pic\//);
    expect(await pic(young)).toMatchObject({ pic_key: expect.any(String), pic_gone_at: null });
  });

  it('leaves a block row that is there for the same bytes as it is', async () => {
    const first = await picture(ALICE, NOW, { sha256: sha(55) });
    await pictures.hideWithPicture(first, ADMIN, NOW);
    const second = await picture(BOB, NOW, { sha256: sha(55) });

    expect(await pictures.hideWithPicture(second, ADMIN, at(NOW_SECONDS + 9))).toMatchObject({ removed: true });

    expect(await db.prepare('SELECT message_id, author, at FROM room_picture_blocks').all()).toMatchObject({
      results: [{ message_id: first, author: ALICE, at: NOW }],
    });
  });

  for (const kind of ['text', 'picture'] as const) {
    it(`clears the writer's first_at when the hidden message of ${kind} is the one that set it, and only then`, async () => {
      await writer(ALICE, { first_at: NOW });
      await writer(BOB, { first_at: at(-500) });
      const make = async (author: string): Promise<number> => {
        if (kind === 'text') return (await room.putMessage(author, 'a line', NOW)).id;
        const stored = await pictures.putPicture(input(author, NOW));
        return stored.ok ? stored.message.id : 0;
      };
      const first = await make(ALICE);
      const later = await make(BOB);

      await pictures.hideWithPicture(first, ADMIN, at(NOW_SECONDS + 5));
      await pictures.hideWithPicture(later, ADMIN, at(NOW_SECONDS + 5));

      expect((await pictures.getUploader(ALICE))?.firstAt).toBeNull();
      expect((await pictures.getUploader(BOB))?.firstAt).toBe(at(-500));
      // The writer's next stored message starts the wait again.
      await room.putMessage(ALICE, 'another line', at(NOW_SECONDS + 60));
      expect((await pictures.getUploader(ALICE))?.firstAt).toBe(at(NOW_SECONDS + 60));
    });
  }

  it('race: of four hides of one picture at once, one hides and one removes', async () => {
    const id = await picture(ALICE);

    const answers = await Promise.all(Array.from({ length: 4 }, () => pictures.hideWithPicture(id, ADMIN, NOW)));

    expect(answers.filter((answer) => answer.outcome === 'hidden')).toHaveLength(1);
    expect(answers.filter((answer) => answer.outcome === 'already')).toHaveLength(3);
    expect(answers.filter((answer) => answer.removed)).toHaveLength(1);
    expect(new Set(answers.map((answer) => answer.key)).size).toBe(1);
    expect(await column<number>('SELECT COUNT(*) AS v FROM room_picture_blocks')).toBe(1);
  });
});

describe("the pictures' store: an admin's mute", () => {
  it('mutes as the room does and removes every picture of the writer in the same batch, with no block row', async () => {
    const ids = [
      await picture(ALICE, at(NOW_SECONDS - 300)),
      await picture(ALICE, at(NOW_SECONDS - 200)),
      await picture(ALICE, at(NOW_SECONDS - 100)),
    ];
    const other = await picture(BOB);
    await room.putMessage(ALICE, 'a line', at(NOW_SECONDS - 50));

    const answer = await pictures.muteWithPictures(ALICE, ADMIN, NOW, ROOM_PICTURE_DELETES_PER_CALL);

    expect(answer.muted).toBe(true);
    expect(answer.removed).toBe(3);
    // Newest first.
    expect(answer.pictures.map((entry) => entry.id)).toEqual([...ids].reverse());
    for (const entry of answer.pictures) expect(entry.key).toMatch(/^pic\/[0-9a-f]{32}$/);
    expect(await pictures.getUploader(ALICE)).toMatchObject({ mutedAt: NOW, mutedBy: ADMIN, cutAt: NOW });
    for (const id of ids) {
      expect(await pic(id)).toMatchObject({
        pic_state: 'removed',
        pic_decided_at: NOW,
        pic_decided_by: ADMIN,
        hidden_at: null,
      });
    }
    expect((await pic(other))?.pic_state).toBe('ok');
    expect(await column<number>('SELECT COUNT(*) AS v FROM room_picture_blocks')).toBe(0);
  });

  it('gives a wallet that never wrote its row, and answers no picture', async () => {
    expect(await pictures.muteWithPictures(ERIN, ADMIN, NOW, ROOM_PICTURE_DELETES_PER_CALL)).toEqual({
      muted: true,
      removed: 0,
      pictures: [],
    });
    expect(await pictures.getUploader(ERIN)).toMatchObject({ mutedAt: NOW, cutAt: NOW });
  });

  it('removes the pictures of a writer who was muted already, keeps the first mute, and answers keys that are still owed', async () => {
    const owed = await picture(ALICE, at(NOW_SECONDS - 100));
    await pictures.muteWithPictures(ALICE, ADMIN, at(NOW_SECONDS - 50), ROOM_PICTURE_DELETES_PER_CALL);
    // A picture that reached D1 beside the first mute.
    await db
      .prepare(
        `INSERT INTO room_messages (at, author, text, pic_type, pic_key, pic_bytes, pic_width, pic_height, pic_frames, pic_sha256, pic_state)
         VALUES (?1, ?2, 'Picture', 'png', ?3, 10, 1, 1, 1, ?4, 'ok')`,
      )
      .bind(at(NOW_SECONDS - 40), ALICE, key(9_001), sha(9_001))
      .run();

    const answer = await pictures.muteWithPictures(ALICE, ADMIN, NOW, ROOM_PICTURE_DELETES_PER_CALL);

    expect(answer.muted).toBe(false);
    expect(answer.removed).toBe(1);
    expect(answer.pictures.map((entry) => entry.id)).toContain(owed);
    expect(answer.pictures).toHaveLength(2);
    expect((await pictures.getUploader(ALICE))?.mutedAt).toBe(at(NOW_SECONDS - 50));
  });

  it('hands back no key for a picture seven days old: it gives the key up in the batch', async () => {
    const old = await picture(ALICE, at(NOW_SECONDS - ROOM_PICTURE_TTL_SECONDS));
    const young = await picture(ALICE, at(NOW_SECONDS - ROOM_PICTURE_TTL_SECONDS + 1));

    const answer = await pictures.muteWithPictures(ALICE, ADMIN, NOW, ROOM_PICTURE_DELETES_PER_CALL);

    expect(answer.removed).toBe(2);
    expect(answer.pictures.map((entry) => entry.id)).toEqual([young]);
    expect(await pic(old)).toMatchObject({ pic_state: 'removed', pic_key: null, pic_gone_at: NOW });
    expect(await pic(young)).toMatchObject({ pic_state: 'removed', pic_gone_at: null });
  });

  it('answers at most `limit` keys, the newest, and leaves the rest owed', async () => {
    const ids = [];
    for (let n = 0; n < 4; n += 1) ids.push(await picture(ALICE, at(NOW_SECONDS - 100 + n)));

    const answer = await pictures.muteWithPictures(ALICE, ADMIN, NOW, 3);

    expect(answer.removed).toBe(4);
    expect(answer.pictures.map((entry) => entry.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect((await pictures.listOwedDeletes(10)).map((entry) => entry.id)).toEqual([...ids].reverse());
  });

  it('race: of three mutes of one writer at once, one mutes and one removes', async () => {
    await picture(ALICE);
    await picture(ALICE);

    const answers = await Promise.all(
      Array.from({ length: 3 }, () => pictures.muteWithPictures(ALICE, ADMIN, NOW, ROOM_PICTURE_DELETES_PER_CALL)),
    );

    expect(answers.filter((answer) => answer.muted)).toHaveLength(1);
    expect(answers.map((answer) => answer.removed).sort()).toEqual([0, 0, 2]);
    for (const answer of answers) expect(answer.pictures).toHaveLength(2);
  });
});

describe("the pictures' store: the bytes Prix owes a delete", () => {
  it('lists removed pictures that still have a key, newest first, and no others', async () => {
    const removed = [await picture(ALICE), await picture(ALICE), await picture(ALICE)];
    await picture(BOB);
    for (const id of removed) await pictures.hideWithPicture(id, ADMIN, NOW);
    await pictures.markGone([removed[1] ?? 0], NOW);

    const owed = await pictures.listOwedDeletes(10);

    expect(owed.map((entry) => entry.id)).toEqual([removed[2], removed[0]]);
    for (const entry of owed) expect(entry.key).toMatch(/^pic\/[0-9a-f]{32}$/);
    expect((await pictures.listOwedDeletes(1)).map((entry) => entry.id)).toEqual([removed[2]]);
  });

  it('reads at most one row when nothing is owed, however many messages there are', async () => {
    await db
      .prepare(
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
         INSERT INTO room_messages (at, author, text) SELECT ?1, ?2, 'line ' || i FROM n`,
      )
      .bind(NOW, ALICE)
      .run();
    await picture(BOB);
    const { db: seen, asked } = watched();

    expect(await createRoomPictureStore(seen).listOwedDeletes(10)).toEqual([]);

    // None of the 301 messages: the partial index holds no entry. Local D1 books the seek that found
    // nothing as one row read (measured 2026-10-11), so the bound here is that one and never the table.
    expect(asked.rowsRead).toBeLessThanOrEqual(1);
  });

  it('marks the bytes gone in one statement: the key null and the time, for these ids only', async () => {
    const ids = [await picture(ALICE), await picture(ALICE), await picture(ALICE)];
    for (const id of ids) await pictures.hideWithPicture(id, ADMIN, NOW);
    const later = at(NOW_SECONDS + 7);

    await pictures.markGone([ids[0] ?? 0, ids[2] ?? 0], later);

    expect(await pic(ids[0] ?? 0)).toMatchObject({ pic_key: null, pic_gone_at: later });
    expect(await pic(ids[1] ?? 0)).toMatchObject({ pic_key: expect.any(String), pic_gone_at: null });
    expect(await pic(ids[2] ?? 0)).toMatchObject({ pic_key: null, pic_gone_at: later });
    // A second mark leaves the first time.
    await pictures.markGone([ids[0] ?? 0], at(NOW_SECONDS + 99));
    expect((await pic(ids[0] ?? 0))?.pic_gone_at).toBe(later);
  });

  it('marks only a removed picture: the id of a live one keeps its key and its row (S2)', async () => {
    const live = await picture(ALICE);
    const kept = await picture(ALICE);
    await pictures.keepPicture(kept, ADMIN, NOW);
    const removed = await picture(ALICE);
    await pictures.hideWithPicture(removed, ADMIN, NOW);
    const before = { live: await pic(live), kept: await pic(kept) };
    const later = at(NOW_SECONDS + 7);

    await pictures.markGone([live, kept, removed], later);

    expect(await pic(live)).toEqual(before.live);
    expect(await pic(kept)).toEqual(before.kept);
    expect(before.live).toMatchObject({ pic_state: 'ok', pic_key: expect.any(String), pic_gone_at: null });
    expect(before.kept).toMatchObject({ pic_state: 'kept', pic_key: expect.any(String), pic_gone_at: null });
    expect(await pic(removed)).toMatchObject({ pic_state: 'removed', pic_key: null, pic_gone_at: later });
    // The live picture is still served: its bytes were never owed a delete.
    expect((await pictures.getServable(live, ROOM_SCAN, later, roomPictureViewsKey(NOW_DAY))).picture).not.toBeNull();
  });

  it('asks nothing of D1 for an empty list, and refuses more ids than one call may carry', async () => {
    const { db: seen, asked } = watched();
    const store = createRoomPictureStore(seen);

    await store.markGone([], NOW);
    expect(asked.statements).toEqual([]);
    await expect(
      store.markGone(
        Array.from({ length: ROOM_PICTURE_DELETES_PER_CALL + 1 }, (_, i) => i + 1),
        NOW,
      ),
    ).rejects.toThrow(/at most/);
  });
});

describe("the pictures' store: an admin keeps a picture", () => {
  it('keeps a reported picture, with who and when, and gives every wallet that reported it one strike', async () => {
    await reporters();
    await writer(ERIN);
    const id = await picture(ALICE);
    for (const reporter of REPORTERS) await report(id, reporter);

    expect(await pictures.keepPicture(id, ADMIN, at(NOW_SECONDS + 9))).toBe('kept');

    expect(await pic(id)).toMatchObject({
      pic_state: 'kept',
      pic_decided_at: at(NOW_SECONDS + 9),
      pic_decided_by: ADMIN,
      pic_reports: 3,
    });
    for (const reporter of REPORTERS) expect((await pictures.getUploader(reporter))?.reportStrikes).toBe(1);
    expect((await pictures.getUploader(ERIN))?.reportStrikes).toBe(0);
    expect((await pictures.getServable(id, ROOM_SCAN, NOW, roomPictureViewsKey(NOW_DAY))).picture).not.toBeNull();
  });

  it('keeps a picture nobody reported, answers `already` for a kept one, and `none` for the rest', async () => {
    const id = await picture(ALICE);
    const removed = await picture(ALICE);
    await pictures.hideWithPicture(removed, ADMIN, NOW);
    const text = await room.putMessage(ALICE, 'a line', NOW);

    expect(await pictures.keepPicture(id, ADMIN, NOW)).toBe('kept');
    expect(await pictures.keepPicture(id, ADMIN, at(NOW_SECONDS + 9))).toBe('already');
    expect((await pic(id))?.pic_decided_at).toBe(NOW);
    expect(await pictures.keepPicture(removed, ADMIN, NOW)).toBe('none');
    expect(await pictures.keepPicture(text.id, ADMIN, NOW)).toBe('none');
    expect(await pictures.keepPicture(id + 1_000, ADMIN, NOW)).toBe('none');
  });

  it('race: of three keeps at once, one keeps, and a reporter gets one strike', async () => {
    await reporters();
    const id = await picture(ALICE);
    await report(id, BOB);

    const answers = await Promise.all(Array.from({ length: 3 }, () => pictures.keepPicture(id, ADMIN, NOW)));

    expect([...answers].sort()).toEqual(['already', 'already', 'kept']);
    expect((await pictures.getUploader(BOB))?.reportStrikes).toBe(1);
  });
});

describe("the pictures' store: the switch that needs no deploy", () => {
  const REPORTS = roomPictureReportsKey(NOW_DAY);

  it('keeps the first reason, and stores `auto` for a switch that set itself', async () => {
    expect(await pictures.getPicturesOff()).toBeNull();

    expect(await pictures.setPicturesOff(null, 'reports_day', NOW)).toBe(true);
    expect(await pictures.setPicturesOff(ADMIN, 'admin', at(NOW_SECONDS + 5))).toBe(false);

    expect(await pictures.getPicturesOff()).toEqual({ at: NOW, by: null, why: 'reports_day' });
    expect(await column<string>("SELECT by AS v FROM room_flags WHERE name = 'pictures_off'")).toBe('auto');
  });

  it('stores an admin in lower case', async () => {
    await pictures.setPicturesOff(ADMIN.toUpperCase().replace('0X', '0x'), 'admin', NOW);

    expect(await pictures.getPicturesOff()).toEqual({ at: NOW, by: ADMIN, why: 'admin' });
  });

  it('gives the room its day’s reports and its hour’s hides again when it switches pictures on', async () => {
    const other = roomPictureViewsKey(NOW_DAY);
    await db
      .prepare("INSERT INTO counters (key, n, updated_at) VALUES (?1, 100, 'x'), (?2, 5, 'x'), (?3, 75, 'x')")
      .bind(REPORTS, HIDES, other)
      .run();
    await pictures.setPicturesOff(null, 'reports_day', NOW);

    expect(await pictures.clearPicturesOff(REPORTS, HIDES)).toBe(true);

    expect(await pictures.getPicturesOff()).toBeNull();
    expect(await counter(REPORTS)).toBeNull();
    expect(await counter(HIDES)).toBeNull();
    expect(await counter(other)).toBe(75);
  });

  it('deletes no counter and answers false when there was no row', async () => {
    await db
      .prepare("INSERT INTO counters (key, n, updated_at) VALUES (?1, 100, 'x'), (?2, 5, 'x')")
      .bind(REPORTS, HIDES)
      .run();

    expect(await pictures.clearPicturesOff(REPORTS, HIDES)).toBe(false);

    expect(await counter(REPORTS)).toBe(100);
    expect(await counter(HIDES)).toBe(5);
  });

  it('race: of four at once that switch pictures off, one does; of four that switch them on, one does', async () => {
    const off = await Promise.all(Array.from({ length: 4 }, () => pictures.setPicturesOff(ADMIN, 'admin', NOW)));
    expect(off.filter(Boolean)).toHaveLength(1);

    const on = await Promise.all(Array.from({ length: 4 }, () => pictures.clearPicturesOff(REPORTS, HIDES)));
    expect(on.filter(Boolean)).toHaveLength(1);
  });
});

describe("the pictures' store: the reads", () => {
  it('answers the public read with each message’s picture, the switch and the views, in one batch', async () => {
    const VIEWS = roomPictureViewsKey(NOW_DAY);
    const text = await room.putMessage(ALICE, 'a line', at(NOW_SECONDS - 10));
    await writer(BOB);
    const shown = await picture(BOB);
    const hidden = await picture(BOB);
    await pictures.hideWithPicture(hidden, ADMIN, NOW);
    await pictures.addViews(VIEWS, 75, NOW);

    const read = await pictures.readRoom(ROOM_PAGE, ROOM_SCAN, VIEWS);

    expect(read.off).toBeNull();
    expect(read.views).toBe(75);
    expect(read.messages.map((message) => [message.id, message.picture?.state ?? null])).toEqual([
      [shown, 'ok'],
      [text.id, null],
    ]);
    await pictures.setPicturesOff(ADMIN, 'admin', NOW);
    expect((await pictures.readRoom(ROOM_PAGE, ROOM_SCAN, VIEWS)).off).toEqual({ at: NOW, by: ADMIN, why: 'admin' });
  });

  it('leaves out of the public read what the room’s read leaves out, and never goes below the scan', async () => {
    const VIEWS = roomPictureViewsKey(NOW_DAY);
    const cut = await picture(ALICE, at(NOW_SECONDS - 100));
    await pictures.muteWithPictures(ALICE, ADMIN, at(NOW_SECONDS - 50), ROOM_PICTURE_DELETES_PER_CALL);
    await db.prepare('UPDATE room_writers SET muted_at = NULL, muted_by = NULL WHERE address = ?1').bind(ALICE).run();
    const kept = await picture(CAROL);
    const reported = await picture(CAROL);
    await db.prepare("UPDATE room_messages SET pic_state = 'reported' WHERE id = ?1").bind(reported).run();
    await picture(DAVE);
    await db.prepare(`UPDATE room_writers SET muted_at = '${NOW}' WHERE address = '${DAVE}'`).run();

    const read = await pictures.readRoom(ROOM_PAGE, ROOM_SCAN, VIEWS);

    expect(read.messages.map((message) => message.id)).toEqual([reported, kept]);
    expect(read.messages.map((message) => message.id)).not.toContain(cut);
    expect((await pictures.readRoom(1, ROOM_SCAN, VIEWS)).messages.map((message) => message.id)).toEqual([reported]);
    expect((await pictures.readRoom(ROOM_PAGE, 1, VIEWS)).messages).toEqual([]);
  });

  it('answers the admins’ read as the room’s, each message with its picture', async () => {
    const text = await room.putMessage(ALICE, 'a line', at(NOW_SECONDS - 10));
    const shown = await picture(BOB);
    await pictures.muteWithPictures(BOB, ADMIN, at(NOW_SECONDS + 5), ROOM_PICTURE_DELETES_PER_CALL);

    const all = await pictures.listAllWithPictures(null, ROOM_PAGE);

    expect(all.map((m) => [m.id, m.muted, m.cut, m.picture?.state ?? null])).toEqual([
      [shown, true, true, 'removed'],
      [text.id, false, false, null],
    ]);
    expect((await pictures.listAllWithPictures(shown, ROOM_PAGE)).map((m) => m.id)).toEqual([text.id]);
    expect(await pictures.listAllWithPictures(null, 1)).toHaveLength(1);
  });

  it('lists the pictures that wait for an admin, oldest first, each with the wallets that reported it and when', async () => {
    await reporters();
    const first = await picture(ALICE);
    const second = await picture(ERIN);
    await picture(ALICE);
    for (const [n, reporter] of REPORTERS.entries()) await report(second, reporter, at(NOW_SECONDS + n));
    for (const [n, reporter] of REPORTERS.entries()) await report(first, reporter, at(NOW_SECONDS + 10 + n));

    const reported = await pictures.listReported(20);

    expect(reported.map((entry) => entry.id)).toEqual([first, second]);
    expect(reported[0]?.picture).toMatchObject({ state: 'reported', reports: 3 });
    expect(reported[1]?.reporters).toEqual(REPORTERS.map((address, n) => ({ address, at: at(NOW_SECONDS + n) })));
    expect(reported[0]?.reporters.map((entry) => entry.address)).toEqual([...REPORTERS]);
    expect((await pictures.listReported(1)).map((entry) => entry.id)).toEqual([first]);
    expect((await pictures.listReported(1))[0]?.reporters).toHaveLength(3);
  });

  it("answers a writer's row with what pictures add, an address in any case", async () => {
    await writer(ALICE, {
      pictures_day: NOW_DAY,
      pictures_count: 2,
      reports_day: NOW_DAY,
      reports_count: 1,
      report_strikes: 1,
    });

    expect(await pictures.getUploader(ALICE.toUpperCase().replace('0X', '0x'))).toEqual({
      address: ALICE,
      lastAt: null,
      day: null,
      count: 0,
      mutedAt: null,
      mutedBy: null,
      cutAt: null,
      firstAt: OLD,
      picturesDay: NOW_DAY,
      picturesCount: 2,
      reportsDay: NOW_DAY,
      reportsCount: 1,
      reportStrikes: 1,
      reportedOpen: 0,
    });
  });
});

describe('the bytes: the port over the KV namespace', () => {
  /** A KV that writes down every call as it came. */
  function fakeKv() {
    const calls: { method: string; args: unknown[] }[] = [];
    const held = new Map<string, ArrayBuffer>();
    return {
      calls,
      held,
      kv: {
        async put(...args: [string, ArrayBuffer, { expirationTtl: number }]): Promise<void> {
          calls.push({ method: 'put', args });
          held.set(args[0], args[1]);
        },
        async get(...args: [string, 'arrayBuffer']): Promise<ArrayBuffer | null> {
          calls.push({ method: 'get', args });
          return held.get(args[0]) ?? null;
        },
        async delete(...args: [string]): Promise<void> {
          calls.push({ method: 'delete', args });
          held.delete(args[0]);
        },
      },
    };
  }

  it('puts an ArrayBuffer of exactly the bytes, with the expiry and nothing else', async () => {
    const { kv, calls } = fakeKv();
    // A view into a larger buffer: only its own bytes may be stored.
    const whole = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
    const bytes = whole.subarray(2, 6);

    await createRoomPictureBytes(kv).put(key(1), bytes, ROOM_PICTURE_TTL_SECONDS);

    expect(calls).toHaveLength(1);
    const [name, value, options, ...rest] = calls[0]?.args ?? [];
    expect(name).toBe(key(1));
    expect(value).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(value as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
    expect(options).toEqual({ expirationTtl: 604_800 });
    expect(Object.keys(options as object)).toEqual(['expirationTtl']);
    expect(rest).toEqual([]);
  });

  it('refuses a put without a whole expiry of at least KV’s minimum, and a key that is not a picture’s', async () => {
    const { kv, calls } = fakeKv();
    const bytes = createRoomPictureBytes(kv);

    for (const ttl of [0, 59, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(bytes.put(key(1), new Uint8Array([1]), ttl), String(ttl)).rejects.toThrow();
    }
    for (const name of ['', 'pic/', 'pic/xyz', `${key(1)}0`, 'other/00000000000000000000000000000001']) {
      await expect(bytes.put(name, new Uint8Array([1]), ROOM_PICTURE_TTL_SECONDS), name).rejects.toThrow();
      await expect(bytes.get(name), name).rejects.toThrow();
      await expect(bytes.delete(name), name).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  it('gets the bytes as an arrayBuffer and null for a key KV has none of, and deletes', async () => {
    const { kv, calls } = fakeKv();
    const bytes = createRoomPictureBytes(kv);
    await bytes.put(key(2), new Uint8Array([5, 6, 7]), ROOM_PICTURE_TTL_SECONDS);

    const got = await bytes.get(key(2));
    expect(got).toBeInstanceOf(Uint8Array);
    expect([...(got ?? [])]).toEqual([5, 6, 7]);
    expect(await bytes.get(key(3))).toBeNull();
    await bytes.delete(key(2));
    expect(await bytes.get(key(2))).toBeNull();

    expect(calls.map((call) => [call.method, ...call.args.filter((arg) => typeof arg === 'string')])).toEqual([
      ['put', key(2)],
      ['get', key(2), 'arrayBuffer'],
      ['get', key(3), 'arrayBuffer'],
      ['delete', key(2)],
      ['get', key(2), 'arrayBuffer'],
    ]);
  });

  it('has no list, no metadata and no put without an expiry', () => {
    expect(Object.keys(createRoomPictureBytes(fakeKv().kv)).sort()).toEqual(['delete', 'get', 'put']);
  });

  it('throws from every method while there is no binding: nothing is skipped in silence', async () => {
    const bytes = createRoomPictureBytes(undefined);

    await expect(bytes.put(key(1), new Uint8Array([1]), ROOM_PICTURE_TTL_SECONDS)).rejects.toThrow(/ROOM_PICTURES/);
    await expect(bytes.get(key(1))).rejects.toThrow(/ROOM_PICTURES/);
    await expect(bytes.delete(key(1))).rejects.toThrow(/ROOM_PICTURES/);
  });

  it('lets what KV throws through to its caller', async () => {
    const failing = {
      put: async () => {
        throw new Error('KV put() limit exceeded for the day.');
      },
      get: async () => {
        throw new Error('KV is away');
      },
      delete: async () => {
        throw new Error('KV is away');
      },
    };
    const bytes = createRoomPictureBytes(failing);

    await expect(bytes.put(key(1), new Uint8Array([1]), ROOM_PICTURE_TTL_SECONDS)).rejects.toThrow(/limit exceeded/);
    await expect(bytes.get(key(1))).rejects.toThrow(/away/);
    await expect(bytes.delete(key(1))).rejects.toThrow(/away/);
  });
});
