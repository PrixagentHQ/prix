import type { RoomPictureRefusalField, RoomRefusalField } from '@prix/contracts';
import {
  API_WRITE_ROWS_PER_DAY,
  ROOM_MESSAGES_PER_HOUR,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PICTURE_BODY_SECONDS,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MIN_BYTES,
  ROOM_PICTURE_POST_WRITE_ROWS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_STORAGE_RETRY_SECONDS,
  ROOM_PICTURE_TEXT,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURES_PATH,
  ROOM_PICTURES_PER_DAY_DEFAULT,
  ROOM_PICTURES_PER_DAY_MAX,
  ROOM_PICTURES_PER_HOUR,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  ROOM_REFUSALS,
  ROOM_SECONDS_BETWEEN,
  roomDayKey,
  roomHourKey,
  roomPictureCheck,
  roomPictureDayKey,
  roomPictureHourKey,
  roomPictureKeySchema,
  roomPicturePostResponseSchema,
  WALLET_WRITES_PER_DAY,
} from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import type { Reply } from './api/harness.ts';
import { errorOf } from './api/harness.ts';
import { db } from './support/d1.ts';
import {
  CORPUS,
  GIF_SCRIPT,
  GIF_SMALLEST,
  gifTinted,
  hex,
  holds,
  JPEG_EXIF,
  JPEG_SCRIPT,
  PNG_SMALLEST,
} from './support/picture-files.ts';
import type { PictureLedger, PictureWorld, WorldOptions } from './support/pictures.ts';
import {
  ADMIN,
  counterOf,
  createPictureWorld,
  emptyPictureTables,
  eventsOf,
  pictureLedger,
  pictureRows,
  SITE,
  seedCount,
  seedPicture,
  seedWriter,
  sha256Hex,
  TestContext,
  withOver,
} from './support/pictures.ts';

/**
 * Uploading a picture (docs/contracts/phase-6-pictures.md section 5, at revision 6): the real routes
 * behind `createApp`, the real stores on a local D1 with migration 0013, and the real bytes port over a
 * KV of the test's own.
 *
 * The eleven steps in their order. Each step is refused once, and after each refusal the test reads what
 * was left behind from the tables and from KV themselves (`pictureLedger`), against the nine lines of
 * the contract: steps 1 to 5 leave nothing and steps 1 to 3 read no byte of the body; step 6 leaves what
 * it spent itself; step 7 leaves that and no turn; `picture_blocked` leaves the turn and the wallet's
 * picture of the day; step 9 the same, with the room's counts as they were; a put that throws leaves the
 * four counts spent; an insert that is refused leaves at worst a key that no row names.
 *
 * The files are sent to the API directly, never through the composer: every file section 4 names.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';
const HOUR_KEY = roomHourKey(DAY, 12);
const DAY_KEY = roomDayKey(DAY);
const PICTURE_HOUR_KEY = roomPictureHourKey(DAY, 12);
const PICTURE_DAY_KEY = roomPictureDayKey(DAY);
/** 12:10:30 UTC: 49 minutes and 30 seconds to the hour, 11 hours more to 00:00 UTC. */
const TO_THE_HOUR = 49 * 60 + 30;
const TO_MIDNIGHT = 11 * 3_600 + TO_THE_HOUR;

const WRITER = '0x00000000000000000000000000000000000005b2';
const SECOND = '0x00000000000000000000000000000000000005b3';
const POOR = '0x00000000000000000000000000000000000005c0';

const FILE = GIF_SMALLEST;

function world(options: WorldOptions = {}): PictureWorld {
  return createPictureWorld(db, { now: NOW, ...options });
}

/** A refusal of a picture or of the room: `invalid_input`, the field and its status, never cached. */
function expectRefusal(reply: Reply, field: RoomPictureRefusalField | RoomRefusalField): void {
  const status =
    field in ROOM_PICTURE_REFUSALS
      ? ROOM_PICTURE_REFUSALS[field as RoomPictureRefusalField]
      : ROOM_REFUSALS[field as RoomRefusalField];
  expect(reply.status, reply.text).toBe(status);
  expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field });
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
  if (status === 429 || status === 503) expect(reply.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
  else expect(reply.headers.get('Retry-After')).toBeNull();
}

/** A body that says how often it was asked for bytes, and whether it was cancelled. Nothing is made before it is asked. */
function watchedBody(
  bytes: Uint8Array,
  chunk = bytes.length,
): { stream: ReadableStream<Uint8Array>; pulls: () => number; cancelled: () => boolean } {
  let pulls = 0;
  let cancelled = false;
  let from = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (from >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(from, from + chunk));
        from += chunk;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

/** The deadline of an upload's body, read from the contract and never typed. */
const BODY_MS = ROOM_PICTURE_BODY_SECONDS * 1_000;

/**
 * A body the test holds in its hand: nothing comes until it is pushed, and it ends, breaks or stays open as
 * the test says. `pulls` counts how often the route asked it for bytes, so a test knows the route is at
 * step 4 and waiting.
 */
function heldBody(): {
  stream: ReadableStream<Uint8Array>;
  state: { pulls: number; cancelled: boolean };
  push(bytes: Uint8Array): void;
  send(bytes: Uint8Array): void;
  fail(): void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(given) {
        controller = given;
      },
      pull() {
        state.pulls += 1;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    state,
    push: (bytes) => controller?.enqueue(bytes.slice()),
    send(bytes) {
      controller?.enqueue(bytes.slice());
      controller?.close();
    },
    fail: () => controller?.error(new Error('the body broke')),
  };
}

/**
 * Lets real work go on (the route's own reads of D1) until `until` holds, at most `most` turns. A read of
 * the database is a real wait that no faked timer touches: a test with the timers in its hand cannot sleep.
 */
async function ticks(until: () => boolean, most = 400): Promise<void> {
  for (let turn = 0; turn < most && !until(); turn += 1) await db.prepare('SELECT 1').first();
}

/** Whether a promise has settled, without awaiting it: an answer that never comes fails a test, and does not hang it. */
function watch(promise: Promise<unknown>): { done: boolean } {
  const state = { done: false };
  const settle = (): void => {
    state.done = true;
  };
  promise.then(settle, settle);
  return state;
}

const d1 = (w: PictureWorld): string[] => w.trace.filter((step) => step.startsWith('d1 '));
const writes = (w: PictureWorld): string[] =>
  d1(w).filter((step) => /^d1 (insert|update|delete|replace)\b/i.test(step));
/** The trace from a mark on: what one request asked. */
function since(w: PictureWorld, mark: number): string[] {
  return w.trace.slice(mark);
}

let logged: unknown[][] = [];

beforeEach(async () => {
  await emptyPictureTables(db);
  logged = [];
  for (const method of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a stored upload', () => {
  it('answers 201 with the message, stores the clean bytes for seven days, and leaves one of everything', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);

    const reply = await w.upload(JPEG_EXIF, { cookie });

    expect(reply.status, reply.text).toBe(201);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    const body = roomPicturePostResponseSchema.parse(reply.json);
    const clean = roomPictureCheck(JPEG_EXIF);
    if (!clean.ok) throw new Error('the fixture is refused');
    expect(body.message.picture).toEqual({
      type: 'jpeg',
      width: 16,
      height: 16,
      bytes: clean.bytes.length,
      frames: 1,
      state: 'shown',
    });
    expect(body.message.text).toBe(ROOM_PICTURE_TEXT);
    expect(body.message.admin).toBe(false);
    expect(body.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY - 1);
    expect(body.picturesLeft).toBe(ROOM_PICTURES_PER_WALLET_PER_DAY - 1);

    // KV: one put, of an ArrayBuffer of exactly the clean bytes, with the seven days and nothing else.
    expect(w.kv.puts).toHaveLength(1);
    const put = w.kv.puts[0];
    expect(put?.options).toEqual({ expirationTtl: ROOM_PICTURE_TTL_SECONDS });
    expect(ROOM_PICTURE_TTL_SECONDS).toBe(604_800);
    expect(put?.value).toBeInstanceOf(ArrayBuffer);
    expect(hex(new Uint8Array(put?.value ?? new ArrayBuffer(0)))).toBe(hex(clean.bytes));
    expect(roomPictureKeySchema.safeParse(put?.key).success).toBe(true);
    expect(w.kv.gets).toEqual([]);

    // The row: every field is the server's.
    const rows = await pictureRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: NOW,
      author: WRITER,
      text: ROOM_PICTURE_TEXT,
      hidden_at: null,
      pic_type: 'jpeg',
      pic_key: put?.key,
      pic_bytes: clean.bytes.length,
      pic_width: 16,
      pic_height: 16,
      pic_frames: 1,
      pic_sha256: await sha256Hex(clean.bytes),
      pic_state: 'ok',
      pic_reports: 0,
    });

    expect(await pictureLedger(w, WRITER)).toEqual<PictureLedger>({
      walletWrites: 1,
      dayRows: ROOM_PICTURE_POST_WRITE_ROWS,
      turn: { lastAt: NOW, count: 1, pictures: 1 },
      hour: 1,
      day: 1,
      pictureHour: 1,
      pictureDay: 1,
      messages: before.messages + 1,
      pictures: 1,
      keys: 1,
      puts: 1,
    });
  });

  it('carries no key, no hash, no whole address and no address of a picture in its answer', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expect(reply.status).toBe(201);
    const row = (await pictureRows(db))[0];
    expect(row?.pic_key).toMatch(/^pic\//);
    const sent = `${[...reply.headers.entries()].join('\n')}\n${reply.text}`;
    expect(sent).not.toContain(row?.pic_key ?? 'none');
    expect(sent).not.toContain((row?.pic_key ?? 'pic/none').slice(4));
    expect(sent).not.toContain(row?.pic_sha256 ?? 'none');
    expect(sent.toLowerCase()).not.toContain(WRITER);
    expect(sent).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(sent).not.toContain('/pictures/');
    expect(sent).not.toMatch(/https?:\/\//);
    expect(Object.keys(reply.json.message.picture).sort()).toEqual([
      'bytes',
      'frames',
      'height',
      'state',
      'type',
      'width',
    ]);
  });

  it('makes a key of its own for every upload: the same bytes from two wallets have two keys', async () => {
    const w = world();
    const first = await seedWriter(w, WRITER);
    const second = await seedWriter(w, SECOND);

    expect((await w.upload(FILE, { cookie: first.cookie })).status).toBe(201);
    expect((await w.upload(FILE, { cookie: second.cookie })).status).toBe(201);

    const rows = await pictureRows(db);
    expect(rows.map((row) => row.pic_sha256)).toEqual([rows[0]?.pic_sha256, rows[0]?.pic_sha256]);
    expect(rows[0]?.pic_key).not.toBe(rows[1]?.pic_key);
    for (const row of rows) {
      const key = row.pic_key ?? '';
      expect(key).not.toContain((row.pic_sha256 ?? 'none').slice(0, 16));
      expect(key).not.toContain(row.author.slice(2, 18));
    }
    // No key was read before its row existed: a null read is charged and cached.
    expect(w.kv.gets).toEqual([]);
  });

  it('trusts nothing of the request but the bytes: a claimed type and a file name change nothing', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);

    const reply = await w.upload(PNG_SMALLEST, {
      cookie,
      headers: {
        'X-File-Name': 'holiday.svg',
        'X-Content-Type': 'image/svg+xml',
        'Content-Disposition': 'attachment; filename="page.html"',
        'X-Picture-Width': '2048',
        'X-Picture-Author': ADMIN,
      },
    });

    expect(reply.status).toBe(201);
    expect((await pictureRows(db))[0]).toMatchObject({
      pic_type: 'png',
      pic_width: 16,
      pic_height: 16,
      author: WRITER,
    });
  });
});

describe('the corpus of section 4, sent to the API itself', () => {
  for (const { name, file, expect: wanted } of CORPUS) {
    it(name, async () => {
      const w = world();
      const { cookie } = await seedWriter(w, WRITER);
      const before = await pictureLedger(w, WRITER);

      const reply = await w.upload(file, { cookie });

      if (!wanted.ok) {
        expectRefusal(reply, `picture_${wanted.problem}`);
        // Steps 1 to 5 leave nothing: no row, no count, no key.
        expect(await pictureLedger(w, WRITER)).toEqual(before);
        expect(w.kv.calls()).toBe(0);
        expect(writes(w)).toEqual([]);
        return;
      }

      expect(reply.status, reply.text).toBe(201);
      const stored = new Uint8Array(w.kv.puts[0]?.value ?? new ArrayBuffer(0));
      const clean = roomPictureCheck(file);
      // Only the rule's own serialisation is stored, never what was sent.
      expect(clean.ok && hex(stored) === hex(clean.bytes)).toBe(true);
      if (wanted.clean !== undefined) expect(hex(stored)).toBe(hex(wanted.clean));
      for (const text of wanted.gone ?? []) expect(holds(stored, text), `the stored bytes hold ${text}`).toBe(false);
      if (wanted.stays !== undefined) expect(holds(stored, wanted.stays)).toBe(true);
      expect(w.kv.puts[0]?.options).toEqual({ expirationTtl: ROOM_PICTURE_TTL_SECONDS });
      expect((await pictureRows(db))[0]).toMatchObject({
        pic_type: wanted.type,
        pic_width: wanted.width,
        pic_height: wanted.height,
        pic_frames: wanted.frames,
        pic_bytes: stored.length,
        pic_sha256: await sha256Hex(stored),
      });
      expect(reply.json.message.picture).toMatchObject({
        type: wanted.type,
        width: wanted.width,
        height: wanted.height,
        frames: wanted.frames,
        bytes: stored.length,
      });
    });
  }

  it('stores the GIF that is also a script as it came, and refuses the JPEG that was one', async () => {
    // The contract's section 4 says that the rule does not stop such a file. What makes it inert is how
    // it is served (room-picture-bytes.d1.test.ts): this test only pins that it IS stored.
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);

    const gif = await w.upload(GIF_SCRIPT, { cookie });
    w.advance(ROOM_SECONDS_BETWEEN * 1_000);
    const jpeg = await w.upload(JPEG_SCRIPT, { cookie });

    expect(gif.status).toBe(201);
    expect(hex(new Uint8Array(w.kv.puts[0]?.value ?? new ArrayBuffer(0)))).toBe(hex(GIF_SCRIPT));
    expectRefusal(jpeg, 'picture_malformed');
    expect(w.kv.puts).toHaveLength(1);
  });
});

describe('step 1: from the chat page, a length, a session, the limiter', () => {
  const cases: [string, Record<string, string | null>][] = [
    ['another origin', { Origin: 'https://evil.example' }],
    ['no origin', { Origin: null }],
    ['the JSON content type', { 'Content-Type': 'application/json' }],
    ['a form', { 'Content-Type': 'multipart/form-data; boundary=x' }],
    ['a plain form', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['text', { 'Content-Type': 'text/plain' }],
    ['a claimed picture', { 'Content-Type': 'image/gif' }],
    ['the type with a parameter', { 'Content-Type': 'application/octet-stream; charset=utf-8' }],
    ['no content type', { 'Content-Type': null }],
    ['no Sec-Fetch-Site', { 'Sec-Fetch-Site': null }],
    ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }],
    ['Sec-Fetch-Site: none', { 'Sec-Fetch-Site': 'none' }],
    ['a Content-Encoding', { 'Content-Encoding': 'gzip' }],
    ['a Content-Encoding of identity', { 'Content-Encoding': 'identity' }],
  ];
  for (const [name, headers] of cases) {
    it(`refuses ${name} as the guard does, before the session and before a byte is read`, async () => {
      const w = world();
      const { cookie } = await seedWriter(w, WRITER);
      const before = await pictureLedger(w, WRITER);
      const body = watchedBody(FILE);
      const mark = w.trace.length;

      const reply = await w.upload(FILE, { cookie, headers, body: body.stream });

      expect(reply.status, reply.text).toBe(403);
      expect(errorOf(reply)).toMatchObject({ code: 'forbidden', field: null });
      expect(body.pulls()).toBe(0);
      // Nothing was asked but the `read` rule every request passes: no session, no D1, no KV, no context.
      expect(since(w, mark)).toEqual(['limit.read']);
      expect(await pictureLedger(w, WRITER)).toEqual(before);
    });
  }

  const lengths: [string, string | null][] = [
    ['no Content-Length', null],
    ['a length of one byte too few', String(ROOM_PICTURE_MIN_BYTES - 1)],
    ['a length of one byte too many', String(ROOM_PICTURE_MAX_BYTES + 1)],
    ['a length of 0', '0'],
    ['a length that is no number', 'many'],
    ['a length with a sign', '+64'],
    ['a length in hex', '0x40'],
    ['a length with a fraction', '64.0'],
    ['a negative length', '-64'],
    ['a length of 100 MB', '104857600'],
  ];
  for (const [name, declared] of lengths) {
    it(`answers picture_size for ${name}, with no byte read and no session asked`, async () => {
      const w = world();
      const { cookie } = await seedWriter(w, WRITER);
      const before = await pictureLedger(w, WRITER);
      const body = watchedBody(FILE);
      const mark = w.trace.length;

      const reply = await w.upload(FILE, { cookie, declared, body: body.stream });

      expectRefusal(reply, 'picture_size');
      expect(body.pulls()).toBe(0);
      expect(since(w, mark)).toEqual(['limit.read']);
      expect(await pictureLedger(w, WRITER)).toEqual(before);
    });
  }

  it('takes a length at each end of the range', async () => {
    expect(ROOM_PICTURE_MIN_BYTES).toBe(32);
    // Revision 5: 256 KiB, where revision 3 had 512.
    expect(ROOM_PICTURE_MAX_BYTES).toBe(262_144);
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    // 32 bytes that are no picture, and the largest length: both pass step 1 and are judged by the rule.
    expectRefusal(await w.upload(new Uint8Array(ROOM_PICTURE_MIN_BYTES), { cookie }), 'picture_type');
    expectRefusal(await w.upload(new Uint8Array(ROOM_PICTURE_MAX_BYTES), { cookie }), 'picture_type');
  });

  it('answers 401 with no session, and with a session that is not one, before anything is counted', async () => {
    const w = world();
    await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);

    for (const cookie of [undefined, 'not-a-session']) {
      const body = watchedBody(FILE);
      const reply = await w.upload(FILE, { cookie, body: body.stream });
      expect(reply.status).toBe(401);
      expect(errorOf(reply).code).toBe('unauthorized');
      expect(body.pulls()).toBe(0);
    }
    expect(w.limiter.asked.filter((ask) => ask.rule === 'write')).toEqual([]);
    expect(w.holdingReads).toEqual([]);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });

  it("answers 429 rate_limited when the limiter's write rule refuses the wallet, and asks nothing further", async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    w.limiter.writesAllowed = 0;
    const body = watchedBody(FILE);

    const reply = await w.upload(FILE, { cookie, body: body.stream });

    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(w.limiter.asked.filter((ask) => ask.rule === 'write')).toEqual([{ rule: 'write', subject: WRITER }]);
    expect(w.holdingReads).toEqual([]);
    expect(body.pulls()).toBe(0);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });
});

describe('step 2: who', () => {
  it('refuses an admin wallet with picture_admin: it passes no byte check and no cap, and no holding is asked', async () => {
    const w = world();
    const cookie = await w.signIn(ADMIN);
    w.holdings.set(ADMIN, 1_000_000);
    // A room that is full and switched off, and a file that is no picture: an admin still gets its own answer.
    await seedCount(db, PICTURE_DAY_KEY, 10_000, NOW);
    await w.deps.pictures.setPicturesOff(null, 'reports_day', NOW);
    const body = watchedBody(new TextEncoder().encode('<svg onload=alert(1)>'.padEnd(64, ' ')));
    const mark = w.trace.length;

    const reply = await w.upload(FILE, { cookie, body: body.stream, declared: '64' });

    expectRefusal(reply, 'picture_admin');
    expect(body.pulls()).toBe(0);
    expect(w.holdingReads).toEqual([]);
    expect(since(w, mark).filter((step) => /room_writers|counters|room_flags|room_messages/.test(step))).toEqual([]);
    expect(w.kv.calls()).toBe(0);
    expect(await pictureRows(db)).toEqual([]);
  });

  it('refuses a wallet that was an uploader before it became an admin wallet, as any admin', async () => {
    const first = world();
    const { cookie } = await seedWriter(first, WRITER);
    expect((await first.upload(FILE, { cookie })).status).toBe(201);

    const later = world({ adminAddresses: [ADMIN, WRITER], now: '2026-10-20T13:00:00.000Z' });
    later.holdings.set(WRITER, 1);
    expectRefusal(await later.upload(gifTinted(7), { cookie: await later.signIn(WRITER) }), 'picture_admin');
    expect(await pictureRows(db)).toHaveLength(1);
  });

  it('asks the stored holding only (cachedOnly), and refuses gate_off, then not_holder', async () => {
    const w = world();
    const holder = await seedWriter(w, WRITER);
    const poor = await seedWriter(w, POOR);
    w.holdings.set(POOR, 0.999);
    const before = await pictureLedger(w, POOR);

    expectRefusal(await w.upload(FILE, { cookie: poor.cookie }), 'not_holder');
    w.gate.on = false;
    expectRefusal(await w.upload(FILE, { cookie: holder.cookie }), 'gate_off');
    expectRefusal(await w.upload(FILE, { cookie: poor.cookie }), 'gate_off');

    expect(w.holdingReads).toEqual([
      { address: POOR, cachedOnly: true },
      { address: WRITER, cachedOnly: true },
      { address: POOR, cachedOnly: true },
    ]);
    expect(await pictureLedger(w, POOR)).toEqual(before);
    expect(w.kv.calls()).toBe(0);
  });

  it('believes no holding of the request', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, POOR);
    w.holdings.set(POOR, 0);

    const reply = await w.upload(FILE, {
      cookie,
      headers: { 'X-Prix-Tokens': '1000000', 'X-Holding': '1000000', 'X-Tier': '3' },
    });

    expectRefusal(reply, 'not_holder');
  });
});

describe('step 3: looked at, and not taken', () => {
  const at = (secondsAgo: number): string => new Date(Date.parse(NOW) - secondsAgo * 1_000).toISOString();
  const set = (sql: string, ...values: unknown[]): Promise<unknown> =>
    db
      .prepare(`UPDATE room_writers SET ${sql} WHERE address = ?1`)
      .bind(WRITER, ...values)
      .run();

  const rows: [
    RoomPictureRefusalField | RoomRefusalField,
    string,
    (w: PictureWorld) => Promise<unknown>,
    number | null,
  ][] = [
    ['muted', 'a writer who is muted', () => set('muted_at = ?2, muted_by = ?3, cut_at = ?2', at(60), ADMIN), null],
    [
      'wallet_day',
      'a wallet at its messages of the day',
      () => set('day = ?2, count = ?3', DAY, ROOM_MESSAGES_PER_WALLET_PER_DAY),
      TO_MIDNIGHT,
    ],
    ['too_soon', 'a message five seconds ago', () => set('last_at = ?2', at(5)), ROOM_SECONDS_BETWEEN - 5],
    ['picture_not_allowed', 'a writer who was muted once and lifted', () => set('cut_at = ?2', at(86_400)), null],
    ['picture_new_writer', 'a first message of 59 minutes', () => set('first_at = ?2', at(3_599)), null],
    ['picture_new_writer', 'a first message that an admin hid', () => set('first_at = NULL'), null],
    [
      'picture_paused',
      'two pictures hidden by reports and not decided',
      async (w) => {
        await seedPicture(w, WRITER, gifTinted(1), { state: 'reported', reports: 3, at: at(7_200) });
        await seedPicture(w, WRITER, gifTinted(2), { state: 'reported', reports: 3, at: at(7_100) });
      },
      null,
    ],
    [
      'picture_wallet_day',
      'three pictures today',
      () => set('pictures_day = ?2, pictures_count = ?3', DAY, ROOM_PICTURES_PER_WALLET_PER_DAY),
      TO_MIDNIGHT,
    ],
    ['pictures_off', 'the switch set', (w) => w.deps.pictures.setPicturesOff(ADMIN, 'admin', NOW), null],
    [
      'room_hour',
      "the room's hour of messages full",
      () => seedCount(db, HOUR_KEY, ROOM_MESSAGES_PER_HOUR, NOW),
      TO_THE_HOUR,
    ],
    ['room_day', "the room's day of messages full", () => seedCount(db, DAY_KEY, 400, NOW), TO_MIDNIGHT],
    [
      'picture_room_hour',
      "the room's hour of pictures full",
      () => seedCount(db, PICTURE_HOUR_KEY, ROOM_PICTURES_PER_HOUR, NOW),
      TO_THE_HOUR,
    ],
    [
      'picture_room_day',
      "the room's day of pictures full",
      () => seedCount(db, PICTURE_DAY_KEY, ROOM_PICTURES_PER_DAY_DEFAULT, NOW),
      TO_MIDNIGHT,
    ],
  ];

  for (const [field, name, arrange, wait] of rows) {
    it(`refuses ${name} with ${field}: no byte read, nothing written, nothing handed to the context`, async () => {
      const w = world();
      const { cookie } = await seedWriter(w, WRITER);
      await arrange(w);
      const before = await pictureLedger(w, WRITER);
      const body = watchedBody(FILE);
      const context = new TestContext(w.trace);
      const mark = w.trace.length;

      const reply = await w.upload(FILE, { cookie, body: body.stream, context });

      expectRefusal(reply, field);
      if (wait !== null) expect(reply.headers.get('Retry-After')).toBe(String(wait));
      expect(body.pulls()).toBe(0);
      expect(context.waited).toEqual([]);
      expect(since(w, mark).filter((step) => /^d1 (insert|update|delete|replace)\b/i.test(step))).toEqual([]);
      // One asking of the write rule, not two: step 6 never began.
      expect(since(w, mark).filter((step) => step === 'limit.write')).toHaveLength(1);
      // Whether Prix once removed these bytes is not asked before a turn is paid.
      expect(since(w, mark).filter((step) => step.includes('room_picture_blocks'))).toEqual([]);
      expect(w.kv.calls()).toBe(0);
      expect(await pictureLedger(w, WRITER)).toEqual(before);
    });
  }

  it('refuses a wallet with no row at all as a new writer, and makes no row for it', async () => {
    const w = world();
    w.holdings.set(SECOND, 5);
    const cookie = await w.signIn(SECOND);

    expectRefusal(await w.upload(FILE, { cookie }), 'picture_new_writer');

    expect((await pictureLedger(w, SECOND)).turn).toBeNull();
  });

  it("answers the writer's own refusal before the room's, and the switch before a count", async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    await seedCount(db, HOUR_KEY, ROOM_MESSAGES_PER_HOUR, NOW);
    await seedCount(db, PICTURE_DAY_KEY, ROOM_PICTURES_PER_DAY_DEFAULT, NOW);

    await w.deps.pictures.setPicturesOff(ADMIN, 'admin', NOW);
    expectRefusal(await w.upload(FILE, { cookie }), 'pictures_off');
    await set('pictures_day = ?2, pictures_count = ?3', DAY, ROOM_PICTURES_PER_WALLET_PER_DAY);
    expectRefusal(await w.upload(FILE, { cookie }), 'picture_wallet_day');
  });
});

describe('step 4: the body, through a counting reader', () => {
  it('answers picture_malformed for a body shorter than it declared, and leaves nothing', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);

    const reply = await w.upload(FILE, { cookie, declared: String(FILE.length + 1), body: watchedBody(FILE).stream });

    expectRefusal(reply, 'picture_malformed');
    expect(await pictureLedger(w, WRITER)).toEqual(before);
    expect(writes(w)).toEqual([]);
  });

  it('cancels a body that runs past its declared length, and never reads the rest of it', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    // 200 chunks of 64 KiB behind a declared length of one small file: 12.5 MB that must not be read.
    const long = new Uint8Array(200 * 65_536);
    long.set(FILE, 0);
    const body = watchedBody(long, 65_536);

    const reply = await w.upload(FILE, { cookie, declared: String(FILE.length), body: body.stream });

    expectRefusal(reply, 'picture_malformed');
    expect(body.cancelled()).toBe(true);
    expect(body.pulls()).toBeLessThanOrEqual(2);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });

  it('answers picture_malformed for a request with a length and no body', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);

    expectRefusal(await w.upload(FILE, { cookie, declared: String(FILE.length), body: null }), 'picture_malformed');
  });

  it('reads a body that arrives in many small pieces, when it is as long as it said', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);

    const reply = await w.upload(JPEG_EXIF, { cookie, body: watchedBody(JPEG_EXIF, 7).stream });

    expect(reply.status, reply.text).toBe(201);
  });
});

describe('step 4: the body against its deadline (revision 6, S1)', () => {
  it('refuses a body that has not come whole when ROOM_PICTURE_BODY_SECONDS have passed, cancels it, and leaves nothing', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    const context = new TestContext(w.trace);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = heldBody();
    const answer = w.upload(FILE, { cookie, body: body.stream, context });
    const seen = watch(answer);
    await ticks(() => body.state.pulls > 0);
    expect(body.state.pulls).toBeGreaterThan(0);

    body.push(FILE.slice(0, 10));
    await vi.advanceTimersByTimeAsync(BODY_MS - 1);
    await ticks(() => seen.done, 20);
    // A millisecond before the deadline the route still waits, and the body is still open.
    expect(seen.done).toBe(false);
    expect(body.state.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await ticks(() => seen.done);

    expect(seen.done).toBe(true);
    expectRefusal(await answer, 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
    expect(context.waited).toEqual([]);
    expect(writes(w)).toEqual([]);
    expect(w.kv.calls()).toBe(0);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });

  it('has ONE timer for the whole body: a body that trickles is refused when that deadline has passed', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = heldBody();
    const answer = w.upload(FILE, { cookie, body: body.stream });
    const seen = watch(answer);
    await ticks(() => body.state.pulls > 0);

    // A byte at the start and one at each quarter of the deadline: no read waits as long as the deadline,
    // so a timer made anew for each read would never win, and the upload would never end.
    for (let piece = 0; piece < 4; piece += 1) {
      body.push(FILE.slice(piece, piece + 1));
      await ticks(() => false, 5);
      await vi.advanceTimersByTimeAsync(BODY_MS / 4);
    }
    await ticks(() => seen.done);

    expect(seen.done).toBe(true);
    expectRefusal(await answer, 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });

  it('answers a body that breaks as picture_malformed and never as a 500, with nothing spent', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    const context = new TestContext(w.trace);
    const body = heldBody();
    const answer = w.upload(FILE, { cookie, body: body.stream, context });
    await ticks(() => body.state.pulls > 0);

    body.push(FILE.slice(0, 10));
    await ticks(() => false, 5);
    body.fail();

    expectRefusal(await answer, 'picture_malformed');
    expect(context.waited).toEqual([]);
    expect(writes(w)).toEqual([]);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });

  it('refuses a body longer than it declared as soon as it is, without waiting for an end that never comes', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    const body = heldBody();
    const answer = w.upload(FILE, { cookie, declared: '64', body: body.stream });
    const seen = watch(answer);
    await ticks(() => body.state.pulls > 0);

    // 65 bytes of a body that says 64 and then never ends.
    body.push(new Uint8Array(65));
    await ticks(() => seen.done);

    expect(seen.done).toBe(true);
    expectRefusal(await answer, 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });
});

describe("after step 5: a request too old by the route's own clock (revision 6, S1)", () => {
  /** An upload that passes steps 1 to 3 at the world's clock, and whose whole body comes `laterMs` after that. */
  async function arriving(
    w: PictureWorld,
    cookie: string,
    file: Uint8Array,
    laterMs: number,
    context?: TestContext,
  ): Promise<Reply> {
    const body = heldBody();
    const answer = w.upload(file, { cookie, body: body.stream, ...(context === undefined ? {} : { context }) });
    await ticks(() => body.state.pulls > 0);
    w.advance(laterMs);
    body.send(file);
    return answer;
  }

  it('is picture_malformed with nothing spent a millisecond past the seconds, and stored under its own `now` exactly at them', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER, NOW);
    const context = new TestContext(w.trace);

    const late = await arriving(w, cookie, FILE, BODY_MS + 1, context);

    expectRefusal(late, 'picture_malformed');
    expect(context.waited).toEqual([]);
    expect(writes(w)).toEqual([]);
    expect(w.kv.calls()).toBe(0);
    expect(await pictureLedger(w, WRITER, NOW)).toEqual(before);

    w.setNow(NOW);
    const onTime = await arriving(w, cookie, FILE, BODY_MS);
    expect(onTime.status, onTime.text).toBe(201);
    // Every step of it is of the request's own reading of the clock, never of the one that judged its age.
    expect((await pictureRows(db))[0]?.at).toBe(NOW);
    expect(await pictureLedger(w, WRITER, NOW)).toMatchObject({ hour: 1, day: 1, pictureHour: 1, pictureDay: 1 });
  });

  it("lets nobody hoard an hour: uploads parked before the hour's end and released after it are refused, and no count lands on either hour", async () => {
    const w = world({ now: '2026-10-20T12:59:50.000Z' });
    const parked: { body: ReturnType<typeof heldBody>; answer: Promise<Reply>; file: Uint8Array }[] = [];
    for (const [n, address] of [WRITER, SECOND, POOR].entries()) {
      const { cookie } = await seedWriter(w, address);
      const body = heldBody();
      const file = gifTinted(n + 1);
      parked.push({ body, file, answer: w.upload(file, { cookie, body: body.stream }) });
      await ticks(() => body.state.pulls > 0);
    }

    // 35 seconds later, in the next hour, every body comes at once.
    w.setNow('2026-10-20T13:00:25.000Z');
    for (const one of parked) one.body.send(one.file);

    for (const one of parked) expectRefusal(await one.answer, 'picture_malformed');
    expect(await pictureRows(db)).toHaveLength(0);
    expect(w.kv.calls()).toBe(0);
    for (const hour of [12, 13]) {
      expect(await counterOf(db, roomPictureHourKey(DAY, hour)), `hour ${hour}`).toBe(0);
      expect(await counterOf(db, roomHourKey(DAY, hour)), `hour ${hour}`).toBe(0);
    }
    expect(writes(w)).toEqual([]);
  });
});

describe('step 5: the rule, and nothing asked of D1', () => {
  it('asks the database nothing between the look at the counts and the refusal of a file', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const context = new TestContext(w.trace);
    const mark = w.trace.length;

    expectRefusal(await w.upload(JPEG_SCRIPT, { cookie, context }), 'picture_malformed');

    const asked = since(w, mark);
    // The last statement that reads the switch and the counts: step 3's own.
    const counts = asked.map((step) => step.startsWith('d1 ') && step.includes('room_flags')).lastIndexOf(true);
    expect(counts).toBeGreaterThan(-1);
    expect(asked.slice(counts + 1)).toEqual([]);
    expect(context.waited).toEqual([]);
  });
});

describe('steps 6 to 11: one promise, handed to the context before anything of step 6 is called', () => {
  it('records the promise before the second asking of the write rule, and hands over exactly one', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const context = new TestContext(w.trace);
    const mark = w.trace.length;

    const reply = await w.upload(FILE, { cookie, context });

    expect(reply.status).toBe(201);
    const asked = since(w, mark);
    const handed = asked.indexOf('ctx.waitUntil');
    const rules = asked.flatMap((step, index) => (step === 'limit.write' ? [index] : []));
    expect(rules).toHaveLength(2);
    expect(handed).toBeGreaterThan(rules[0] ?? -1);
    // The first call of step 6 is the second asking of the limiter's `write` rule.
    expect(handed).toBeLessThan(rules[1] ?? -1);
    // Nothing is written, and KV is not asked, before the hand-over.
    expect(asked.slice(0, handed).filter((step) => /^d1 (insert|update|delete|replace)\b/i.test(step))).toEqual([]);
    expect(asked.slice(0, handed).filter((step) => step.startsWith('kv.'))).toEqual([]);
    expect(context.waited).toHaveLength(1);
    await expect(context.waited[0]).resolves.toBeUndefined();
  });

  it('stores the message though nobody ever awaits the answer: only what the context was handed', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const context = new TestContext(w.trace);

    // The response is never awaited before the check: a client that left would not have read it either.
    const answer = w.app.fetch(w.uploadRequest(FILE, { cookie }), context as never);
    const settled = Promise.resolve(answer).then(
      (response) => response.status,
      () => -1,
    );
    await vi.waitFor(() => expect(context.waited).toHaveLength(1), { timeout: 5_000, interval: 5 });
    await context.waited[0];

    expect(await pictureRows(db)).toHaveLength(1);
    expect(w.kv.held.size).toBe(1);
    expect(await settled).toBe(201);
  });

  it('hands over a promise that never rejects, whatever steps 6 to 11 answer', async () => {
    const refusals: [string, number, WorldOptions, (w: PictureWorld) => void][] = [
      [
        'the limiter at step 6',
        429,
        {},
        (w) => {
          w.limiter.writesAllowed = 1;
        },
      ],
      [
        'a blocked file at step 8',
        403,
        { wrapPictures: (store) => withOver(store, { isBlocked: async () => true }) },
        () => undefined,
      ],
      [
        'a put that throws',
        503,
        {},
        (w) => {
          w.kv.fail.add('put');
        },
      ],
      [
        'an insert that throws',
        500,
        {
          wrapPictures: (store) =>
            withOver(store, {
              putPicture: async () => {
                throw new Error('D1 is away');
              },
            }),
        },
        () => undefined,
      ],
    ];
    for (const [name, status, options, arrange] of refusals) {
      await emptyPictureTables(db);
      const w = world(options);
      const { cookie } = await seedWriter(w, WRITER);
      arrange(w);
      const context = new TestContext(w.trace);

      const response = await w.app.fetch(w.uploadRequest(FILE, { cookie }), context as never);

      expect(response.status, name).toBe(status);
      expect(context.waited, name).toHaveLength(1);
      await expect(context.waited[0], name).resolves.toBeUndefined();
    }
  });

  it('answers 500 with nothing spent when the app was given no context, and runs nothing of steps 6 to 11', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    const mark = w.trace.length;

    const reply = await w.upload(FILE, { cookie, context: 'none' });

    expect(reply.status).toBe(500);
    expect(errorOf(reply)).toMatchObject({ code: 'internal', field: null });
    // There is no fallback: the limiter was asked once, nothing was written, KV was not asked.
    const asked = since(w, mark);
    expect(asked.filter((step) => step === 'limit.write')).toHaveLength(1);
    expect(asked.filter((step) => /^d1 (insert|update|delete|replace)\b/i.test(step))).toEqual([]);
    expect(w.kv.calls()).toBe(0);
    expect(await pictureLedger(w, WRITER)).toEqual(before);
    // Give a stray promise the time to run, had the route started its work before it asked for the context.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await pictureLedger(w, WRITER)).toEqual(before);
  });
});

describe('step 6: what a write costs its wallet', () => {
  it('answers 429 when the limiter refuses the second asking, and leaves nothing', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    w.limiter.writesAllowed = 1;

    const reply = await w.upload(FILE, { cookie });

    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(await pictureLedger(w, WRITER)).toEqual(before);
    expect(w.kv.calls()).toBe(0);
  });

  it("keeps daily_limit when the wallet's writes of the day are used up: no turn, no count, no key", async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    await db
      .prepare('UPDATE users SET write_day = ?2, write_count = ?3 WHERE address = ?1')
      .bind(WRITER, DAY, WALLET_WRITES_PER_DAY)
      .run();
    const before = await pictureLedger(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(await pictureLedger(w, WRITER)).toEqual(before);
    expect(w.kv.calls()).toBe(0);
  });

  it("keeps daily_limit when the day's rows are used up, and leaves what the step itself spent: the wallet's write", async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    await db
      .prepare('INSERT INTO api_writes (day, rows) VALUES (?1, ?2)')
      .bind(DAY, API_WRITE_ROWS_PER_DAY - ROOM_PICTURE_POST_WRITE_ROWS + 1)
      .run();
    const before = await pictureLedger(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(await pictureLedger(w, WRITER)).toEqual({ ...before, walletWrites: 1 });
    expect(w.kv.calls()).toBe(0);
  });

  it('books ROOM_PICTURE_POST_WRITE_ROWS of the day for an upload', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    await db
      .prepare('INSERT INTO api_writes (day, rows) VALUES (?1, ?2)')
      .bind(DAY, API_WRITE_ROWS_PER_DAY - ROOM_PICTURE_POST_WRITE_ROWS)
      .run();

    expect((await w.upload(FILE, { cookie })).status).toBe(201);
    expect((await pictureLedger(w, WRITER)).dayRows).toBe(API_WRITE_ROWS_PER_DAY);
  });
});

describe('step 7: the turn, decided inside the statement', () => {
  it('refuses a turn that another request took since the look, with the whole wait, and leaves no turn of its own', async () => {
    // Between step 3 and step 7 another request of the same wallet stored a message.
    const w = world({
      wrapPictures: (store) =>
        withOver(store, {
          takePictureTurn: async (address, now, day) => {
            await db.prepare('UPDATE room_writers SET last_at = ?2 WHERE address = ?1').bind(address, now).run();
            return store.takePictureTurn(address, now, day);
          },
        }),
    });
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expectRefusal(reply, 'too_soon');
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_SECONDS_BETWEEN));
    // What step 6 spent, and no turn: the count of the day and the picture of the day did not move.
    expect(await pictureLedger(w, WRITER)).toEqual({
      ...before,
      walletWrites: 1,
      dayRows: ROOM_PICTURE_POST_WRITE_ROWS,
      turn: { lastAt: NOW, count: 0, pictures: 0 },
    });
    expect(w.kv.calls()).toBe(0);
    expect(w.trace.filter((step) => step.includes('room_picture_blocks'))).toEqual([]);
  });

  it('lets one of two uploads sent at once through, and counts one turn and one picture', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);

    const replies = await Promise.all([w.upload(gifTinted(1), { cookie }), w.upload(gifTinted(2), { cookie })]);

    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 429]);
    const ledger = await pictureLedger(w, WRITER);
    expect(ledger.turn).toEqual({ lastAt: NOW, count: 1, pictures: 1 });
    expect(ledger.pictures).toBe(1);
    expect(ledger.pictureDay).toBe(1);
  });
});

describe('step 8: bytes an admin removed before', () => {
  async function block(w: PictureWorld, file: Uint8Array): Promise<void> {
    const removed = await seedPicture(w, SECOND, file, { at: '2026-10-19T10:00:00.000Z' });
    const hidden = await w.deps.pictures.hideWithPicture(removed.id, ADMIN, '2026-10-19T11:00:00.000Z');
    expect(hidden.removed).toBe(true);
    w.kv.held.clear();
  }

  it('is refused only here, with the turn and the picture of the day spent and the counts as they were', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    await block(w, JPEG_EXIF);
    const before = await pictureLedger(w, WRITER);
    const mark = w.trace.length;

    // The file as a phone made it: what is compared is the hash of the clean bytes.
    const reply = await w.upload(JPEG_EXIF, { cookie });

    expectRefusal(reply, 'picture_blocked');
    expect(await pictureLedger(w, WRITER)).toEqual({
      ...before,
      walletWrites: 1,
      dayRows: ROOM_PICTURE_POST_WRITE_ROWS,
      turn: { lastAt: NOW, count: 1, pictures: 1 },
    });
    expect(w.kv.puts).toEqual([]);
    // The block is asked after the turn's write, and after the hand-over to the context.
    const asked = since(w, mark);
    const blockAsked = asked.findIndex((step) => step.startsWith('d1 ') && step.includes('room_picture_blocks'));
    const turnTaken = asked.findIndex((step) => /^d1 update room_writers/i.test(step));
    expect(turnTaken).toBeGreaterThan(-1);
    expect(blockAsked).toBeGreaterThan(turnTaken);
    expect(asked.filter((step) => step.includes('room_picture_blocks'))).toHaveLength(1);
  });

  it('costs one of the three pictures of the day each time: the fourth question is not answered', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    await block(w, FILE);

    const answers: string[] = [];
    for (let n = 0; n < ROOM_PICTURES_PER_WALLET_PER_DAY + 1; n += 1) {
      const reply = await w.upload(FILE, { cookie });
      answers.push(errorOf(reply).field ?? '');
      w.advance(ROOM_SECONDS_BETWEEN * 1_000);
    }

    expect(answers).toEqual(['picture_blocked', 'picture_blocked', 'picture_blocked', 'picture_wallet_day']);
    // Three questions of the block list a wallet a day, and no more.
    expect(w.trace.filter((step) => /^d1 select\b/i.test(step) && step.includes('room_picture_blocks'))).toHaveLength(
      3,
    );
  });

  it('is passed by one changed byte: it stops lazy uploads of the same file only', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    await block(w, gifTinted(1));

    expect((await w.upload(gifTinted(2), { cookie })).status).toBe(201);
  });
});

describe("step 9: the room's four counts", () => {
  /** The look of step 3 sees an empty room; the counts are full by the time step 9 takes them. */
  const staleLook: WorldOptions = {
    wrapPictures: (store) =>
      withOver(store, {
        getPictureCounts: async () => ({ off: null, hour: 0, day: 0, pictureHour: 0, pictureDay: 0 }),
      }),
  };
  const full: [RoomPictureRefusalField | RoomRefusalField, string, number, number][] = [
    ['room_hour', HOUR_KEY, ROOM_MESSAGES_PER_HOUR, TO_THE_HOUR],
    ['room_day', DAY_KEY, 400, TO_MIDNIGHT],
    ['picture_room_hour', PICTURE_HOUR_KEY, ROOM_PICTURES_PER_HOUR, TO_THE_HOUR],
    ['picture_room_day', PICTURE_DAY_KEY, ROOM_PICTURES_PER_DAY_DEFAULT, TO_MIDNIGHT],
  ];

  for (const [field, key, cap, wait] of full) {
    it(`refuses ${field} when that count filled since the look: the turn stays spent, the counts it took are given back`, async () => {
      const w = world(staleLook);
      const { cookie } = await seedWriter(w, WRITER);
      await seedCount(db, key, cap, NOW);
      const before = await pictureLedger(w, WRITER);

      const reply = await w.upload(FILE, { cookie });

      expectRefusal(reply, field);
      expect(reply.headers.get('Retry-After')).toBe(String(wait));
      // The room's counts as they were; the turn is never given back.
      expect(await pictureLedger(w, WRITER)).toEqual({
        ...before,
        walletWrites: 1,
        dayRows: ROOM_PICTURE_POST_WRITE_ROWS,
        turn: { lastAt: NOW, count: 1, pictures: 1 },
      });
      expect(w.kv.calls()).toBe(0);
    });
  }

  it('takes the four in their order: messages of the hour, of the day, pictures of the hour, of the day', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const mark = w.trace.length;

    expect((await w.upload(FILE, { cookie })).status).toBe(201);

    // Each count is a statement on `counters`; its key is bound, so the order is read from the ledger of
    // a run that stops at each: see the four tests above. Here: four takes, all before the put.
    const asked = since(w, mark);
    const put = asked.indexOf('kv.put');
    const takes = asked.flatMap((step, index) => (/^d1 (insert|update)\b.*\bcounters\b/i.test(step) ? [index] : []));
    expect(takes).toHaveLength(4);
    expect(Math.max(...takes)).toBeLessThan(put);
  });

  it('gives back what it took when a count throws, and answers 500', async () => {
    const w = world({
      wrapReputation: (store) =>
        withOver(store, {
          takeCounter: async (key, cap, day, now) => {
            if (key === PICTURE_HOUR_KEY) throw new Error('D1 is away');
            return store.takeCounter(key, cap, day, now);
          },
        }),
    });
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expect(reply.status).toBe(500);
    expect(await pictureLedger(w, WRITER)).toEqual({
      ...before,
      walletWrites: 1,
      dayRows: ROOM_PICTURE_POST_WRITE_ROWS,
      turn: { lastAt: NOW, count: 1, pictures: 1 },
    });
  });

  it('keeps the refusal when a count cannot be given back', async () => {
    const w = world({
      ...staleLook,
      wrapReputation: (store) =>
        withOver(store, {
          giveBackCounter: async () => {
            throw new Error('D1 is away');
          },
        }),
    });
    const { cookie } = await seedWriter(w, WRITER);
    await seedCount(db, PICTURE_DAY_KEY, ROOM_PICTURES_PER_DAY_DEFAULT, NOW);

    const reply = await w.upload(FILE, { cookie });

    expectRefusal(reply, 'picture_room_day');
    expect(reply.headers.get('Retry-After')).toBe(String(TO_MIDNIGHT));
    // Not given back: they stay spent until their hour or their day ends.
    expect(await pictureLedger(w, WRITER)).toMatchObject({ hour: 1, day: 1, pictureHour: 1 });
  });
});

describe('step 10: the put', () => {
  it('answers 503 picture_storage with Retry-After 60 when the put throws, and gives no count back', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const before = await pictureLedger(w, WRITER);
    w.kv.fail.add('put');

    const reply = await w.upload(FILE, { cookie });

    expectRefusal(reply, 'picture_storage');
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_PICTURE_STORAGE_RETRY_SECONDS));
    // A put that threw may have written: the day's count of pictures is what bounds the puts of a day.
    expect(await pictureLedger(w, WRITER)).toEqual({
      ...before,
      walletWrites: 1,
      dayRows: ROOM_PICTURE_POST_WRITE_ROWS,
      turn: { lastAt: NOW, count: 1, pictures: 1 },
      hour: 1,
      day: 1,
      pictureHour: 1,
      pictureDay: 1,
      puts: 1,
    });
    expect(await pictureRows(db)).toEqual([]);
  });

  it('answers the same while there is no KV binding at all: nothing is skipped in silence', async () => {
    const w = world({ kv: null });
    const { cookie } = await seedWriter(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expectRefusal(reply, 'picture_storage');
    expect(await pictureRows(db)).toEqual([]);
    expect((await pictureLedger(w, WRITER)).pictureDay).toBe(1);
  });

  it('never tries more puts in a day than the count of pictures of the day', async () => {
    const w = world({ picturesCap: '2' });
    w.kv.fail.add('put');
    for (const [n, address] of [WRITER, SECOND, POOR].entries()) {
      const { cookie } = await seedWriter(w, address);
      const reply = await w.upload(gifTinted(n), { cookie });
      expectRefusal(reply, n < 2 ? 'picture_storage' : 'picture_room_day');
    }
    expect(w.kv.puts).toHaveLength(2);
  });
});

describe('step 11: the insert', () => {
  const orphanLines = (): unknown[] => eventsOf(logged).filter((line) => line.event === ROOM_PICTURE_LOG_EVENTS.orphan);

  it('refuses a writer who was muted since the turn, deletes the key once, and stores no message', async () => {
    const w = world({
      wrapPictures: (store) =>
        withOver(store, {
          putPicture: async (input) => {
            await createRoomStore(db).muteWriter(input.author, ADMIN, input.now);
            return store.putPicture(input);
          },
        }),
    });
    const { cookie } = await seedWriter(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expectRefusal(reply, 'muted');
    expect(await pictureRows(db)).toEqual([]);
    expect(w.kv.puts).toHaveLength(1);
    expect(w.kv.deletes).toEqual([w.kv.puts[0]?.key]);
    expect(w.kv.held.size).toBe(0);
    expect(orphanLines()).toEqual([{ event: 'room_picture_orphan', count: 1 }]);
    expect(await pictureLedger(w, WRITER)).toMatchObject({ hour: 1, day: 1, pictureHour: 1, pictureDay: 1 });
  });

  it('refuses when pictures were switched off since the look, and tries the delete once even if it throws', async () => {
    const w = world({
      wrapPictures: (store) =>
        withOver(store, {
          putPicture: async (input) => {
            await store.setPicturesOff(ADMIN, 'admin', input.now);
            return store.putPicture(input);
          },
        }),
    });
    const { cookie } = await seedWriter(w, WRITER);
    w.kv.fail.add('delete');

    const reply = await w.upload(FILE, { cookie });

    expectRefusal(reply, 'pictures_off');
    expect(await pictureRows(db)).toEqual([]);
    // Once and never again: a key that stays expires within the seven days it was put with.
    expect(w.kv.deletes).toHaveLength(1);
    expect(w.kv.held.size).toBe(1);
    expect(w.kv.puts[0]?.options).toEqual({ expirationTtl: ROOM_PICTURE_TTL_SECONDS });
  });

  it('answers 500 when the insert throws, tries no delete, and leaves a key that no row names', async () => {
    const w = world({
      wrapPictures: (store) =>
        withOver(store, {
          putPicture: async () => {
            throw new Error('D1 is away');
          },
        }),
    });
    const { cookie } = await seedWriter(w, WRITER);

    const reply = await w.upload(FILE, { cookie });

    expect(reply.status).toBe(500);
    expect(w.kv.deletes).toEqual([]);
    expect(w.kv.held.size).toBe(1);
    expect(orphanLines()).toEqual([{ event: 'room_picture_orphan', count: 1 }]);
    expect(await pictureLedger(w, WRITER)).toMatchObject({ pictures: 0, pictureDay: 1, puts: 1 });
  });
});

describe('the caps', () => {
  it("counts a picture as a message: the 20 seconds, the wallet's day and the room's hour all move", async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);

    expect((await w.upload(FILE, { cookie })).status).toBe(201);
    const text = await w.fetch('POST', '/api/social/room', { cookie, body: { text: 'the league looks good today' } });
    const second = await w.upload(gifTinted(3), { cookie });

    expect(text.status).toBe(429);
    expect(errorOf(text).field).toBe('too_soon');
    expectRefusal(second, 'too_soon');
    expect(second.headers.get('Retry-After')).toBe(String(ROOM_SECONDS_BETWEEN));
    const ledger = await pictureLedger(w, WRITER);
    expect(ledger.turn).toEqual({ lastAt: NOW, count: 1, pictures: 1 });
    expect([ledger.hour, ledger.day]).toEqual([1, 1]);
  });

  it(`stops a wallet at ${ROOM_PICTURES_PER_WALLET_PER_DAY} pictures a day, to 00:00 UTC`, async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const answers: number[] = [];
    for (let n = 0; n < ROOM_PICTURES_PER_WALLET_PER_DAY; n += 1) {
      answers.push((await w.upload(gifTinted(n), { cookie })).status);
      w.advance(ROOM_SECONDS_BETWEEN * 1_000);
    }
    const last = await w.upload(gifTinted(9), { cookie });

    expect(answers).toEqual([201, 201, 201]);
    expect(ROOM_PICTURES_PER_WALLET_PER_DAY).toBe(3);
    expectRefusal(last, 'picture_wallet_day');
    expect(last.headers.get('Retry-After')).toBe(String(TO_MIDNIGHT - 3 * ROOM_SECONDS_BETWEEN));

    // A new UTC day gives the three back.
    w.setNow('2026-10-21T00:00:01.000Z');
    expect((await w.upload(gifTinted(10), { cookie })).status).toBe(201);
  });

  it(`stops the room at ${ROOM_PICTURES_PER_HOUR} pictures an hour, and opens again at the next`, async () => {
    const w = world();
    const cookies: string[] = [];
    for (let n = 0; n < ROOM_PICTURES_PER_HOUR + 1; n += 1) {
      cookies.push((await seedWriter(w, `0x${(0x7000 + n).toString(16).padStart(40, '0')}`)).cookie);
    }
    const answers: number[] = [];
    for (const [n, cookie] of cookies.entries()) answers.push((await w.upload(gifTinted(n), { cookie })).status);

    expect(answers).toEqual([...new Array<number>(ROOM_PICTURES_PER_HOUR).fill(201), 429]);
    const refused = await w.upload(gifTinted(40), { cookie: cookies[ROOM_PICTURES_PER_HOUR] });
    expectRefusal(refused, 'picture_room_hour');
    expect(refused.headers.get('Retry-After')).toBe(String(TO_THE_HOUR));

    w.setNow('2026-10-20T13:00:00.000Z');
    expect((await w.upload(gifTinted(41), { cookie: cookies[ROOM_PICTURES_PER_HOUR] })).status).toBe(201);
  });

  it("reads the room's day from ROOM_PICTURES_PER_DAY: 60 by default, 150 at most, and 0 stops uploads", async () => {
    expect(world().deps.picturesDailyCap).toBe(ROOM_PICTURES_PER_DAY_DEFAULT);
    expect(ROOM_PICTURES_PER_DAY_DEFAULT).toBe(60);
    expect(world({ picturesCap: '9000' }).deps.picturesDailyCap).toBe(ROOM_PICTURES_PER_DAY_MAX);
    expect(ROOM_PICTURES_PER_DAY_MAX).toBe(150);
    expect(world({ picturesCap: 'many' }).deps.picturesDailyCap).toBe(ROOM_PICTURES_PER_DAY_DEFAULT);

    const stopped = world({ picturesCap: '0' });
    const { cookie } = await seedWriter(stopped, WRITER);
    const shown = await seedPicture(stopped, SECOND, gifTinted(5));
    expectRefusal(await stopped.upload(FILE, { cookie }), 'picture_room_day');
    // "0" stops uploads and keeps serving.
    expect((await stopped.image(`${ROOM_PICTURES_PATH}/${shown.id}`)).status).toBe(200);

    await emptyPictureTables(db);
    const two = world({ picturesCap: '2' });
    const answers: number[] = [];
    for (const [n, address] of [WRITER, SECOND, POOR].entries()) {
      answers.push((await two.upload(gifTinted(n), { cookie: (await seedWriter(two, address)).cookie })).status);
    }
    expect(answers).toEqual([201, 201, 429]);
  });
});

describe('the one exemption of the 16,384 bytes', () => {
  it('is the upload alone: every other path and method still refuses a body that says it is larger', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const large = { 'Content-Length': '16385' };

    const others: [string, string][] = [
      ['POST', '/api/social/room'],
      ['PUT', ROOM_PICTURES_PATH],
      ['DELETE', ROOM_PICTURES_PATH],
      ['POST', `${ROOM_PICTURES_PATH}/`],
      ['POST', `${ROOM_PICTURES_PATH}/12/report`],
      ['POST', `${ROOM_PICTURES_PATH}/12`],
      ['PUT', '/api/social/admin/room/pictures/off'],
      ['PUT', '/api/social/admin/room/pictures/12/keep'],
      ['DELETE', '/api/social/admin/room/messages/12'],
    ];
    for (const [method, path] of others) {
      const reply = await w.fetch(method, path, { cookie, headers: large });
      expect(reply.status, `${method} ${path}`).toBe(400);
      expect(errorOf(reply), `${method} ${path}`).toMatchObject({ code: 'invalid_input', field: null });
    }

    // The upload itself is judged by its own step 1 in their place.
    const upload = await w.upload(new Uint8Array(20_000), { cookie });
    expectRefusal(upload, 'picture_type');
  });

  it('gives the path no exemption while pictures are not enabled: it is an unknown path that reads nothing', async () => {
    const w = world({ pictures: false });
    const { cookie } = await seedWriter(w, WRITER);
    const body = watchedBody(FILE);

    const reply = await w.upload(FILE, { cookie, body: body.stream });

    expect(reply.status).toBe(404);
    expect(errorOf(reply).code).toBe('not_found');
    expect(body.pulls()).toBe(0);
    expect(w.kv.calls()).toBe(0);
  });
});

describe('what an upload writes to the log', () => {
  it('names no address, no key and no hash, whatever it answered', async () => {
    const w = world({
      wrapPictures: (store) =>
        withOver(store, {
          putPicture: async (input) => {
            if (input.author === SECOND) await store.setPicturesOff(null, 'reports_day', input.now);
            return store.putPicture(input);
          },
        }),
    });
    const first = await seedWriter(w, WRITER);
    const second = await seedWriter(w, SECOND);
    expect((await w.upload(FILE, { cookie: first.cookie })).status).toBe(201);
    expectRefusal(await w.upload(gifTinted(4), { cookie: second.cookie }), 'pictures_off');

    const text = logged.map((call) => call.map(String).join(' ')).join('\n');
    expect(text).toContain('room_picture_orphan');
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/pic\/[0-9a-f]{32}/);
    expect(text).not.toMatch(/[0-9a-f]{32}/);
    expect(text).not.toContain(SITE);
  });

  it('writes room_picture_upload_failed with the number of the step that threw and nothing else, and no line for a refusal', async () => {
    // Revision 4's eighth line: once the client has left, the error handler never sees a fault of steps 6
    // to 11, so the work writes it itself before it rejects.
    const failed = (): unknown[] =>
      eventsOf(logged).filter((line) => line.event === ROOM_PICTURE_LOG_EVENTS.uploadFailed);
    const away = async (): Promise<never> => {
      throw new Error(`D1 is away for ${WRITER} at pic/0123456789abcdef0123456789abcdef`);
    };
    const faults: [number, WorldOptions][] = [
      [7, { wrapPictures: (store) => withOver(store, { takePictureTurn: away }) }],
      [8, { wrapPictures: (store) => withOver(store, { isBlocked: away }) }],
      [9, { wrapReputation: (store) => withOver(store, { takeCounter: away }) }],
      [11, { wrapPictures: (store) => withOver(store, { putPicture: away }) }],
    ];
    for (const [step, options] of faults) {
      await emptyPictureTables(db);
      logged = [];
      const w = world(options);
      const { cookie } = await seedWriter(w, WRITER);

      expect((await w.upload(FILE, { cookie })).status, `step ${step}`).toBe(500);

      expect(failed(), `step ${step}`).toEqual([{ event: 'room_picture_upload_failed', step }]);
    }

    // A refusal is an answer and no fault: the limiter at step 6, a blocked file, a put that throws.
    await emptyPictureTables(db);
    logged = [];
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    w.limiter.writesAllowed = 1;
    expect((await w.upload(FILE, { cookie })).status).toBe(429);
    w.limiter.writesAllowed = Number.POSITIVE_INFINITY;
    w.kv.fail.add('put');
    expectRefusal(await w.upload(FILE, { cookie }), 'picture_storage');
    expect(failed()).toEqual([]);
  });
});
