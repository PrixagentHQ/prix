import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  MAX_BODY_BYTES,
  ROOM_MESSAGES_PER_HOUR,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PICTURE_BODY_SECONDS,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_MAX_BYTES,
  ROOM_PICTURE_MAX_FRAMES,
  ROOM_PICTURE_MIN_BYTES,
  ROOM_PICTURE_POST_WRITE_ROWS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_STORAGE_RETRY_SECONDS,
  ROOM_PICTURE_TEXT,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
  ROOM_PICTURES_PATH,
  ROOM_PICTURES_PER_HOUR,
  ROOM_PICTURES_PER_WALLET_PER_DAY,
  ROOM_REFUSALS,
  ROOM_REPORTED_PICTURES_PAUSE,
  ROOM_SECONDS_BETWEEN,
  type RoomPictureRefusalField,
  type RoomRefusalField,
  roomDayKey,
  roomHourKey,
  roomPictureCheck,
  roomPictureDayKey,
  roomPictureHourKey,
  roomPictureKeySchema,
  roomPicturePostResponseSchema,
} from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failures } from '../../errors.ts';
import { shortAddress } from '../../views.ts';
import { ROOM_PICTURE_SENTENCES, ROOM_SENTENCES } from './refusals.ts';
import {
  ADMIN,
  createHarness,
  DAY,
  errorOf,
  type Harness,
  HOLDER,
  type Reply,
  type RequestOptions,
  START,
  STRANGER,
  settled,
  stepsOf,
} from './test-support.ts';
import { gifBytes } from './test-support-pictures.ts';

/**
 * The upload of a picture against docs/contracts/phase-6-pictures.md section 5: the eleven steps in their
 * order, each refused once, and what each refusal leaves. A store and the bytes in memory, no D1, no KV.
 */

const HOUR_KEY = roomHourKey(DAY, 12);
const DAY_KEY = roomDayKey(DAY);
const PIC_HOUR_KEY = roomPictureHourKey(DAY, 12);
const PIC_DAY_KEY = roomPictureDayKey(DAY);
/** The four counts of step 9, in its order. */
const COUNT_KEYS = [HOUR_KEY, DAY_KEY, PIC_HOUR_KEY, PIC_DAY_KEY] as const;
const UPLOAD = ROOM_PICTURES_PATH;
/** Two hours before the harness's clock: a first message old enough for a picture. */
const FIRST = '2026-10-20T10:00:00.000Z';
const GIF = gifBytes();
const LOOKS = [
  'pictures.getUploader',
  `pictures.getPictureCounts:${HOUR_KEY}:${DAY_KEY}:${PIC_HOUR_KEY}:${PIC_DAY_KEY}`,
];
/** Step 1's limiter and step 2's holding, as every upload that passes them leaves them in the trace. */
const BEFORE_LOOKS = [`limiter:write:${HOLDER}`, 'holding:cachedOnly'];
const SPEND = [
  'ctx.waitUntil',
  `limiter:write:${HOLDER}`,
  'store.spendWalletWrite',
  `store.spendApiWrites:${ROOM_PICTURE_POST_WRITE_ROWS}`,
];

/** A harness with pictures on and a holder whose first message is two hours old. */
async function ready(options: Parameters<typeof createHarness>[0] = {}): Promise<{ h: Harness; cookie: string }> {
  const h = createHarness({ pictures: true, ...options });
  h.room.firstAt.set(HOLDER, FIRST);
  return { h, cookie: await h.signIn(HOLDER) };
}

function upload(h: Harness, cookie: string | undefined, options: RequestOptions = {}): Promise<Reply> {
  return h.fetch('POST', UPLOAD, { bytes: GIF, ...(cookie === undefined ? {} : { cookie }), ...options });
}

function expectPictureRefusal(reply: Reply, field: RoomPictureRefusalField): void {
  expect(reply.status).toBe(ROOM_PICTURE_REFUSALS[field]);
  expect(errorOf(reply)).toEqual({
    code: 'invalid_input',
    message: ROOM_PICTURE_SENTENCES[field as keyof typeof ROOM_PICTURE_SENTENCES],
    field,
  });
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}

function expectRoomRefusal(reply: Reply, field: RoomRefusalField): void {
  expect(reply.status).toBe(ROOM_REFUSALS[field]);
  expect(errorOf(reply)).toEqual({ code: 'invalid_input', message: ROOM_SENTENCES[field], field });
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}

/** The JSON log lines written to either stream of the console while `run` ran. */
async function logged(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  const keep = (text: unknown): void => {
    lines.push(JSON.parse(String(text)) as Record<string, unknown>);
  };
  const log = vi.spyOn(console, 'log').mockImplementation(keep);
  const error = vi.spyOn(console, 'error').mockImplementation(keep);
  try {
    await run();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return lines;
}

/** The deadline of an upload's body, in milliseconds: the contract's constant, never a typed figure. */
const DEADLINE_MS = ROOM_PICTURE_BODY_SECONDS * 1_000;

/** The timer of the machine, kept before any test fakes `setTimeout`: a turn of the event loop is real. */
const realSetTimeout = globalThis.setTimeout;

/** Lets everything that is ready run: a few turns of the event loop, whatever a test did to the timers. */
async function turns(count = 5): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}

/** The longest a test waits for something the route must do, by the machine's own clock. */
const PATIENCE_MS = 3_000;

/**
 * Waits, a turn at a time, until `done` says so. A route that never gets there fails the test with what it
 * never did: a wait without an end would outlive the test and keep its worker alive.
 */
async function until(what: string, done: () => boolean): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!done()) {
    if (Date.now() > end) throw new Error(`the route never ${what}`);
    await turns(1);
  }
}

/** How many uploads have passed step 3's second look, whatever hour their counts are of. */
function looked(h: Harness): number {
  return h.trace.filter((step) => step.startsWith('pictures.getPictureCounts:')).length;
}

/** Waits until `count` uploads have passed step 3 and wait for their bodies at step 4. */
async function parked(h: Harness, count = 1): Promise<void> {
  await until(`passed step 3 with ${count} uploads`, () => looked(h) >= count);
  await turns();
}

/** The answer of an upload when it has one by now, or `pending` while the route still waits. */
async function outcome(answer: Promise<Reply>): Promise<Reply | 'pending'> {
  const got: { reply: Reply | 'pending' } = { reply: 'pending' };
  void answer.then((reply) => {
    got.reply = reply;
  });
  await turns(20);
  return got.reply;
}

/** An answer that must have come: the reply, or a failed test that says the route still waits. */
async function answered(answer: Promise<Reply>): Promise<Reply> {
  const reply = await outcome(answer);
  if (reply === 'pending') throw new Error('the upload still waits for its body');
  return reply;
}

/** A body the test holds: nothing arrives until the test sends it, and the test sees a cancel. */
function heldBody(): {
  stream: ReadableStream<Uint8Array>;
  state: { cancelled: boolean };
  /** Some bytes, with more to come. */
  push(bytes: Uint8Array): void;
  /** These bytes, and the end of the body. */
  send(bytes: Uint8Array): void;
  /** The body breaks: the client hung up. */
  fail(): void;
} {
  const state = { cancelled: false };
  const held: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      held.controller = controller;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    stream,
    state,
    push: (bytes) => held.controller?.enqueue(bytes),
    send: (bytes) => {
      held.controller?.enqueue(bytes);
      held.controller?.close();
    },
    fail: () => held.controller?.error(new Error('the client hung up')),
  };
}

/** An upload whose body is a stream, declared as `length` bytes. */
function uploadStream(
  h: Harness,
  cookie: string,
  stream: ReadableStream<Uint8Array>,
  length: number,
  options: RequestOptions = {},
): Promise<Reply> {
  return h.fetch('POST', UPLOAD, {
    cookie,
    stream,
    contentType: ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
    ...options,
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Length': String(length), ...options.headers },
  });
}

/** `iso` moved on by `ms` milliseconds. */
function later(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * A picture of exactly `length` bytes: the fixture, with one comment extension before its frame that fills
 * the rest. The rule drops a comment, so what is stored of it is the fixture's own bytes.
 */
function gifOfLength(length: number): Uint8Array {
  // The header (13 bytes) and the table of two colours (6): the comment stands behind them.
  const head = 19;
  const comment: number[] = [0x21, 0xfe];
  // Sub-blocks of 1 to 255 bytes, each behind its own length; then the terminator.
  let left = length - GIF.length - 3;
  while (left > 0) {
    const size = left > 257 ? 256 : left === 257 ? 2 : left;
    comment.push(size - 1, ...new Array<number>(size - 1).fill(0x2e));
    left -= size;
  }
  comment.push(0);
  return Uint8Array.from([...GIF.slice(0, head), ...comment, ...GIF.slice(head)]);
}

/** A picture of the largest size an upload may declare. */
const LARGEST = gifOfLength(ROOM_PICTURE_MAX_BYTES);

/**
 * The buffer the Workers runtime hands every piece of a body on, whatever the piece carries: read on local
 * workerd by the confirming look of round 2, where 3,000 bytes written singly came as 2,484 to 3,000
 * pieces, each a view on a buffer of 4,096 bytes of its own.
 */
const RUNTIME_BUFFER_BYTES = 4_096;

/** A full collection, which Node hides unless it is asked for. The flag is put back as it was found. */
const collect = ((): (() => void) => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  setFlagsFromString('--no-expose-gc');
  return gc;
})();

/**
 * The bytes of every ArrayBuffer of this process that something still reaches, as the review measured the
 * reader (`reader-memory`): two full collections, the second of which frees what the first found
 * unreachable, and then the process's own count. It is the measure of the rule itself, which is in bytes:
 * a piece is a view of one byte, and what it costs is the buffer under it. And it does not know how a
 * reader would keep a piece, so a list, a promise that outlives a read and whatever comes after them all
 * read the same.
 */
function heldBuffers(): number {
  collect();
  collect();
  return process.memoryUsage().arrayBuffers;
}

/**
 * A body that comes a byte at a time, as the Workers runtime hands it: each piece is a view of one byte on
 * a buffer of RUNTIME_BUFFER_BYTES of its own. A piece is made when the reader asks for it and the body
 * keeps none, so whatever is held of them is held by the route.
 *
 * It looks at what is held before the first piece, then before every `every`-th, and when it has handed
 * the last one: each time when the reader has asked for a piece and before that piece is made, so every
 * piece that exists then is one the reader was handed. The first look is the floor every later one is
 * measured from: nothing of the body exists then. A look that finds more than `bound` is taken again after
 * the event loop has turned, three times at most, and the least stands: the process's own messages live in
 * ArrayBuffers too and go away, and what a reader holds does not. When a look still finds more than
 * `bound`, the body breaks there: the test has its answer, and a reader that keeps every piece of a largest
 * picture would keep a gigabyte.
 *
 * With `pieces`, no more than that many are handed and the body then neither goes on nor ends.
 */
function byteAtATime(
  bytes: Uint8Array,
  options: { every: number; bound: number; pieces?: number },
): {
  stream: ReadableStream<Uint8Array>;
  seen: {
    /** The pieces handed so far. */
    handed: number;
    /** The looks taken. */
    looks: number;
    /** The most a look found held, above the floor. */
    worst: number;
    /** Every count of pending timers a look found. */
    timers: Set<number>;
    cancelled: boolean;
  };
  /** Settles when the body has handed all it will: its last piece, or the one before a look that found too much. */
  finished: Promise<void>;
  /** What is held now, above the floor. */
  held(): number;
} {
  const count = options.pieces ?? bytes.length;
  const seen = { handed: 0, looks: 0, worst: 0, timers: new Set<number>(), cancelled: false };
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let floor: number | null = null;
  const held = (): number => {
    const now = heldBuffers();
    floor ??= now;
    return now - floor;
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const last = seen.handed === count;
        if (last || seen.handed % options.every === 0) {
          let found = held();
          for (let again = 0; found > options.bound && again < 3; again += 1) {
            await turns(2);
            found = Math.min(found, held());
          }
          seen.looks += 1;
          seen.worst = Math.max(seen.worst, found);
          seen.timers.add(vi.getTimerCount());
          // A turn of the event loop at every look: a body of a quarter of a million pieces starves nothing.
          await turns(1);
          if (found > options.bound) {
            finish();
            controller.error(new Error('the reader holds more than its bound'));
            return;
          }
        }
        if (last) {
          finish();
          if (options.pieces === undefined) controller.close();
          return;
        }
        const piece = new Uint8Array(new ArrayBuffer(RUNTIME_BUFFER_BYTES), 0, 1);
        piece[0] = bytes[seen.handed] ?? 0;
        seen.handed += 1;
        controller.enqueue(piece);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen, finished, held };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the fixture', () => {
  it("is a picture by the contract's rule, and one with a comment is stored without it", () => {
    const plain = roomPictureCheck(GIF);
    expect(plain).toMatchObject({ ok: true, type: 'gif', width: 16, height: 16, frames: 1 });
    const tagged = gifBytes({ comment: 'made by a camera at 52.5N 13.4E' });
    const clean = roomPictureCheck(tagged);
    expect(clean.ok && clean.bytes.length).toBe(GIF.length);
    expect(tagged.length).toBeGreaterThan(GIF.length);
  });

  it('has a picture of the largest size, of which the rule keeps the fixture and nothing else', () => {
    expect(LARGEST.length).toBe(ROOM_PICTURE_MAX_BYTES);
    const clean = roomPictureCheck(LARGEST);
    expect(clean.ok && [...clean.bytes]).toEqual([...GIF]);
  });
});

describe('a stored picture (section 5, the whole order)', () => {
  it('runs the eleven steps in their order and answers 201 with the message', async () => {
    const { h, cookie } = await ready();
    const reply = await upload(h, cookie);
    expect(reply.status).toBe(201);
    expect(stepsOf(h.trace)).toEqual([
      ...BEFORE_LOOKS,
      ...LOOKS,
      ...SPEND,
      'pictures.takePictureTurn',
      'pictures.isBlocked',
      ...COUNT_KEYS.map((key) => `counter.take:${key}`),
      'bytes.put',
      'pictures.putPicture',
    ]);
    const body = roomPicturePostResponseSchema.parse(reply.json);
    expect(body).toEqual({
      message: {
        id: 1,
        at: START,
        authorShort: shortAddress(HOLDER),
        admin: false,
        text: ROOM_PICTURE_TEXT,
        picture: { type: 'gif', width: 16, height: 16, bytes: GIF.length, frames: 1, state: 'shown' },
      },
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1,
      picturesLeft: ROOM_PICTURES_PER_WALLET_PER_DAY - 1,
    });
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
  });

  it('stores only what the rule hands back, under a key of its own, with the seven days of expiry', async () => {
    const { h, cookie } = await ready();
    const sent = gifBytes({ comment: 'made by a camera at 52.5N 13.4E' });
    expect((await upload(h, cookie, { bytes: sent })).status).toBe(201);
    const [[key, held] = ['', undefined]] = [...h.bytes.held.entries()];
    expect(roomPictureKeySchema.safeParse(key).success).toBe(true);
    expect(held?.ttlSeconds).toBe(ROOM_PICTURE_TTL_SECONDS);
    expect([...(held?.bytes ?? [])]).toEqual([...GIF]);
    const stored = h.pictures.pictures.get(1);
    expect(stored).toMatchObject({ key, bytes: GIF.length, type: 'gif', state: 'ok', reports: 0 });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', GIF));
    expect(stored?.sha256).toBe([...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    expect(h.room.messages[0]).toMatchObject({ author: HOLDER, text: ROOM_PICTURE_TEXT, at: START });
  });

  it('answers no key, no hash and no whole address', async () => {
    const { h, cookie } = await ready();
    const reply = await upload(h, cookie);
    const stored = h.pictures.pictures.get(1);
    expect(reply.text).not.toContain(stored?.key ?? 'pic/');
    expect(reply.text).not.toContain(stored?.sha256 ?? 'none');
    expect(reply.text).not.toContain(HOLDER);
    expect(reply.text).not.toContain('pic/');
  });

  it('reads the clock after step 2 for its `now`, and every later step is of that reading', async () => {
    const { h, cookie } = await ready();
    h.clock.stepMs = 1_000;
    h.trace.length = 0;
    expect((await upload(h, cookie)).status).toBe(201);
    // The session's own reading, then the route's: the second reading of the request.
    const route = h.clock.reads[1];
    expect(h.trace.indexOf('holding:cachedOnly')).toBeLessThan(h.trace.indexOf('clock', h.trace.indexOf('clock') + 1));
    expect(h.trace.indexOf('clock', h.trace.indexOf('clock') + 1)).toBeLessThan(
      h.trace.indexOf('pictures.getUploader'),
    );
    expect(h.room.messages[0]?.at).toBe(route);
    expect(h.room.writers.get(HOLDER)?.lastAt).toBe(route);
  });

  it("reads the clock once more after step 5 and before the context is taken, and never as a step's `now`", async () => {
    const { h, cookie } = await ready();
    h.clock.stepMs = 1_000;
    h.trace.length = 0;
    expect((await upload(h, cookie)).status).toBe(201);
    // The session's reading, the route's `now`, the reading after step 5; then `spendWrite`'s own.
    const clocks = h.trace.flatMap((step, index) => (step === 'clock' ? [index] : []));
    const [, , again] = clocks;
    expect(again).toBeGreaterThan(h.trace.findIndex((step) => step.startsWith('pictures.getPictureCounts')));
    expect(again).toBeLessThan(h.trace.indexOf('ctx.waitUntil'));
    // Nothing is stored under the second reading: the message, the turn and the four counts are the first's.
    expect(h.room.messages[0]?.at).toBe(h.clock.reads[1]);
    expect(h.room.messages[0]?.at).not.toBe(h.clock.reads[2]);
    expect([...h.counters.keys()]).toEqual([...COUNT_KEYS]);
  });
});

describe('step 1: from the site, the declared length, the session, the limiter', () => {
  it.each<[string, RequestOptions]>([
    ['another origin', { origin: 'https://evil.test' }],
    ['no origin', { origin: null }],
    ['the JSON content type', { contentType: 'application/json' }],
    ['a form', { contentType: 'multipart/form-data; boundary=x' }],
    ['the type with a parameter', { contentType: 'application/octet-stream; charset=utf-8' }],
    ['no content type', { contentType: null }],
    ['no Sec-Fetch-Site', { headers: { 'Sec-Fetch-Site': null } }],
    ['a request from another site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }],
    ['a request from the same site and another origin', { headers: { 'Sec-Fetch-Site': 'same-site' } }],
    ['a Content-Encoding', { headers: { 'Content-Encoding': 'gzip' } }],
    ['an identity Content-Encoding', { headers: { 'Content-Encoding': 'identity' } }],
  ])("refuses %s with the guard's own answer, before anything is read", async (_name, options) => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    h.trace.length = 0;
    const reply = await upload(h, cookie, options);
    expect(reply.status).toBe(403);
    expect(errorOf(reply)).toEqual({ code: 'forbidden', message: failures.badPictureOrigin().message, field: null });
    expect(h.trace.filter((step) => !step.startsWith('limiter:read:'))).toEqual([]);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });

  it.each<[string, string | null]>([
    ['no length', null],
    ['a length that is no number', 'abc'],
    ['a length with a sign', '+37'],
    ['a length with a fraction', '37.0'],
    ['a length below the least', String(ROOM_PICTURE_MIN_BYTES - 1)],
    ['a length above the most', String(ROOM_PICTURE_MAX_BYTES + 1)],
    ['a length of a hundred megabytes', '104857600'],
  ])('refuses %s as picture_size, with no session read and no byte read', async (_name, length) => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    h.trace.length = 0;
    const reply = await upload(h, cookie, { headers: { 'Content-Length': length } });
    expectPictureRefusal(reply, 'picture_size');
    expect(h.trace.filter((step) => !step.startsWith('limiter:read:'))).toEqual([]);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });

  it.each([ROOM_PICTURE_MIN_BYTES, ROOM_PICTURE_MAX_BYTES])('takes a declared length of %d', async (length) => {
    const { h } = await ready();
    // No session: the answer is step 1's third question, so the length passed.
    const reply = await upload(h, undefined, { headers: { 'Content-Length': String(length) } });
    expect(reply.status).toBe(401);
  });

  it('asks for the session after the length, and answers 401 before anything is counted', async () => {
    const { h } = await ready();
    const before = h.ledger();
    h.trace.length = 0;
    const reply = await upload(h, undefined);
    expect(reply.status).toBe(401);
    expect(errorOf(reply).code).toBe('unauthorized');
    expect(stepsOf(h.trace)).toEqual([]);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });

  it("asks the limiter's write rule for the wallet, and a refusal leaves nothing", async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    h.limiter.denied.add('write');
    const reply = await upload(h, cookie);
    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(stepsOf(h.trace)).toEqual([`limiter:write:${HOLDER}`]);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });
});

describe('step 2: who', () => {
  it('refuses an admin wallet before its holding is asked, and before anything of a writer is read', async () => {
    const h = createHarness({ pictures: true });
    h.room.firstAt.set(ADMIN, FIRST);
    h.holding.tokens.set(ADMIN, 1_000_000);
    const before = h.ledger();
    const reply = await upload(h, await h.signIn(ADMIN));
    expectPictureRefusal(reply, 'picture_admin');
    expect(stepsOf(h.trace)).toEqual([`limiter:write:${ADMIN}`]);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses every wallet while the token gate is off', async () => {
    const { h, cookie } = await ready();
    h.holding.gatingOn = false;
    const before = h.ledger();
    expectRoomRefusal(await upload(h, cookie), 'gate_off');
    expect(stepsOf(h.trace)).toEqual(BEFORE_LOOKS);
    expect(h.holding.asked).toEqual([{ address: HOLDER, options: { cachedOnly: true } }]);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses a wallet that holds less than one whole token', async () => {
    const h = createHarness({ pictures: true });
    h.room.firstAt.set(STRANGER, FIRST);
    h.holding.tokens.set(STRANGER, 0.99);
    const before = h.ledger();
    expectRoomRefusal(await upload(h, await h.signIn(STRANGER)), 'not_holder');
    expect(stepsOf(h.trace)).toEqual([`limiter:write:${STRANGER}`, 'holding:cachedOnly']);
    expect(h.ledger()).toEqual(before);
  });
});

describe('step 3: looked at, and not taken', () => {
  type Arrange = (h: Harness) => void;
  const writerCases: [string, Arrange, RoomPictureRefusalField | RoomRefusalField][] = [
    ['a muted wallet', (h) => h.room.setWriter(HOLDER, { mutedAt: FIRST, cutAt: FIRST }), 'muted'],
    [
      'a wallet at its messages of the day',
      (h) => h.room.setWriter(HOLDER, { day: DAY, count: ROOM_MESSAGES_PER_WALLET_PER_DAY }),
      'wallet_day',
    ],
    [
      'a wallet that wrote a moment ago',
      (h) => h.room.setWriter(HOLDER, { lastAt: '2026-10-20T11:59:55.000Z' }),
      'too_soon',
    ],
    ['a wallet that was muted once', (h) => h.room.setWriter(HOLDER, { cutAt: FIRST }), 'picture_not_allowed'],
    ['a wallet with no stored message', (h) => h.room.firstAt.delete(HOLDER), 'picture_new_writer'],
    [
      'a wallet whose first message is 59 minutes old',
      (h) => h.room.firstAt.set(HOLDER, '2026-10-20T11:01:00.000Z'),
      'picture_new_writer',
    ],
    [
      'a wallet with two pictures hidden by reports',
      (h) => {
        for (let n = 0; n < ROOM_REPORTED_PICTURES_PAUSE; n += 1)
          h.pictures.seedPicture(HOLDER, FIRST, { state: 'reported' });
      },
      'picture_paused',
    ],
    [
      'a wallet at its pictures of the day',
      (h) => h.pictures.setExtra(HOLDER, { picturesDay: DAY, picturesCount: ROOM_PICTURES_PER_WALLET_PER_DAY }),
      'picture_wallet_day',
    ],
  ];

  it.each(writerCases)('refuses %s by its row, and reads no count and no byte', async (_name, arrange, field) => {
    const { h, cookie } = await ready();
    arrange(h);
    const before = h.ledger();
    const reply = await upload(h, cookie);
    if (field in ROOM_REFUSALS) expectRoomRefusal(reply, field as RoomRefusalField);
    else expectPictureRefusal(reply, field as RoomPictureRefusalField);
    if (reply.status === 429) expect(reply.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, 'pictures.getUploader']);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });

  it('tells a hurried wallet what is left of its wait, and one at a cap of a day the time to 00:00 UTC', async () => {
    const { h, cookie } = await ready();
    h.room.setWriter(HOLDER, { lastAt: '2026-10-20T11:59:55.000Z' });
    expect((await upload(h, cookie)).headers.get('Retry-After')).toBe(String(ROOM_SECONDS_BETWEEN - 5));
    h.room.setWriter(HOLDER, { lastAt: null });
    h.pictures.setExtra(HOLDER, { picturesDay: DAY, picturesCount: ROOM_PICTURES_PER_WALLET_PER_DAY });
    expect((await upload(h, cookie)).headers.get('Retry-After')).toBe(String(12 * 3_600));
  });

  const countCases: [string, Arrange, RoomPictureRefusalField | RoomRefusalField, string][] = [
    [
      'the switch',
      (h) => void Object.assign(h.pictures, { off: { at: FIRST, by: null, why: 'reports_hour' } }),
      'pictures_off',
      '',
    ],
    ['the hour of messages', (h) => void h.counters.set(HOUR_KEY, ROOM_MESSAGES_PER_HOUR), 'room_hour', '3600'],
    ['the day of messages', (h) => void h.counters.set(DAY_KEY, 7), 'room_day', '43200'],
    [
      'the hour of pictures',
      (h) => void h.counters.set(PIC_HOUR_KEY, ROOM_PICTURES_PER_HOUR),
      'picture_room_hour',
      '3600',
    ],
    ['the day of pictures', (h) => void h.counters.set(PIC_DAY_KEY, 5), 'picture_room_day', '43200'],
  ];

  it.each(countCases)('refuses by %s as it stands, and takes nothing', async (_name, arrange, field, wait) => {
    const { h, cookie } = await ready({ roomDailyCap: 7, picturesDailyCap: 5 });
    h.setNow('2026-10-20T12:00:00.000Z');
    arrange(h);
    const before = h.ledger();
    const reply = await upload(h, cookie);
    if (field in ROOM_REFUSALS) expectRoomRefusal(reply, field as RoomRefusalField);
    else expectPictureRefusal(reply, field as RoomPictureRefusalField);
    expect(reply.headers.get('Retry-After')).toBe(wait === '' ? null : wait);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS]);
    expect(h.last.request?.bodyUsed).toBe(false);
    expect(h.ledger()).toEqual(before);
  });

  it("judges the five of the second look in the contract's order", async () => {
    const { h, cookie } = await ready({ roomDailyCap: 7, picturesDailyCap: 5 });
    for (const [, arrange] of countCases) arrange(h);
    const order: string[] = [];
    for (const [, , field] of countCases) {
      order.push(errorOf(await upload(h, cookie)).field ?? '');
      if (field === 'pictures_off') h.pictures.off = null;
      else if (field === 'room_hour') h.counters.delete(HOUR_KEY);
      else if (field === 'room_day') h.counters.delete(DAY_KEY);
      else if (field === 'picture_room_hour') h.counters.delete(PIC_HOUR_KEY);
    }
    expect(order).toEqual(countCases.map(([, , field]) => field));
  });

  it("judges the writer's row before the room's counts", async () => {
    const { h, cookie } = await ready();
    h.pictures.off = { at: FIRST, by: null, why: 'admin' };
    h.room.setWriter(HOLDER, { cutAt: FIRST });
    expectPictureRefusal(await upload(h, cookie), 'picture_not_allowed');
  });
});

describe('step 4: the body, through a counting reader', () => {
  it.each<[string, RequestOptions]>([
    ['fewer bytes than it declared', { headers: { 'Content-Length': String(GIF.length + 1) } }],
    [
      'more bytes than it declared',
      { bytes: gifBytes({ comment: 'x'.repeat(40) }), headers: { 'Content-Length': '40' } },
    ],
  ])('refuses a body of %s as malformed, and leaves nothing', async (_name, options) => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    const reply = await upload(h, cookie, options);
    expectPictureRefusal(reply, 'picture_malformed');
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS]);
    expect(h.ctx.waited).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses a request with a length and no body', async () => {
    const { h, cookie } = await ready();
    const reply = await h.fetch('POST', UPLOAD, {
      cookie,
      contentType: 'application/octet-stream',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Length': '64' },
    });
    expectPictureRefusal(reply, 'picture_malformed');
  });

  it('never hands a shorter body to the rule: it is malformed by its length, whatever it holds', async () => {
    const { h, cookie } = await ready();
    // 40 bytes that are no picture, declared as 64. Judged by the rule they would be `picture_type`.
    const reply = await upload(h, cookie, { bytes: new Uint8Array(40), headers: { 'Content-Length': '64' } });
    expectPictureRefusal(reply, 'picture_malformed');
  });

  it('stops reading a body that goes on past the length it declared', async () => {
    const { h, cookie } = await ready();
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1_024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const reply = await h.fetch('POST', UPLOAD, {
      cookie,
      stream: endless,
      contentType: 'application/octet-stream',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Length': '2048' },
    });
    expectPictureRefusal(reply, 'picture_malformed');
    expect(cancelled).toBe(true);
    // 2,048 bytes were declared: the third piece is the one that passes them, and nothing is asked after it.
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it('takes a body that arrives in pieces', async () => {
    const { h, cookie } = await ready();
    const pieces = [GIF.slice(0, 5), GIF.slice(5, 20), GIF.slice(20)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const piece = pieces.shift();
        if (piece === undefined) controller.close();
        else controller.enqueue(piece);
      },
    });
    const reply = await h.fetch('POST', UPLOAD, {
      cookie,
      stream,
      contentType: 'application/octet-stream',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Length': String(GIF.length) },
    });
    expect(reply.status).toBe(201);
    expect([...([...h.bytes.held.values()][0]?.bytes ?? [])]).toEqual([...GIF]);
  });
});

describe('step 4: the body is read against a deadline (revision 6, S1)', () => {
  it('refuses a body that is not whole when the deadline passes, cancels the reader and leaves nothing', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = heldBody();
    const answer = uploadStream(h, cookie, body.stream, GIF.length);
    await parked(h);
    body.push(GIF.slice(0, 10));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(await outcome(answer)).toBe('pending');
    expect(body.state.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS]);
    expect(h.ctx.waited).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses a body of which no byte ever comes, when the deadline passes', async () => {
    const { h, cookie } = await ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = heldBody();
    const answer = uploadStream(h, cookie, body.stream, ROOM_PICTURE_MAX_BYTES);
    await parked(h);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
    expect(h.ctx.waited).toEqual([]);
  });

  it('races every read against one timer: a body that trickles is refused when the one deadline has passed', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = heldBody();
    const answer = uploadStream(h, cookie, body.stream, GIF.length);
    await parked(h);
    // A byte at the start and one at each quarter of the deadline: no single read waits as long as the
    // deadline, so a timer made anew for each read would never win.
    for (let piece = 0; piece < 4; piece += 1) {
      body.push(GIF.slice(piece, piece + 1));
      await turns();
      await vi.advanceTimersByTimeAsync(DEADLINE_MS / 4);
    }
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
    expect(h.ledger()).toEqual(before);
  });

  it('leaves no timer behind, whatever the body did', async () => {
    const { h, cookie } = await ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect((await upload(h, cookie)).status).toBe(201);
    expect(vi.getTimerCount()).toBe(0);
    h.setNow(later(START, 60_000));
    expectPictureRefusal(await upload(h, cookie, { headers: { 'Content-Length': '64' } }), 'picture_malformed');
    expect(vi.getTimerCount()).toBe(0);
    const broken = heldBody();
    const answer = uploadStream(h, cookie, broken.stream, GIF.length);
    await parked(h, 3);
    broken.fail();
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers a body that breaks as malformed and never as a 500, with nothing spent', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = heldBody();
    const answer = uploadStream(h, cookie, body.stream, GIF.length);
    await parked(h);
    body.push(GIF.slice(0, 10));
    await turns();
    body.fail();
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(error).not.toHaveBeenCalled();
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS]);
    expect(h.ctx.waited).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses a body that is longer than declared as soon as it is, without waiting for its end', async () => {
    const { h, cookie } = await ready();
    const body = heldBody();
    const answer = uploadStream(h, cookie, body.stream, 64);
    await parked(h);
    // 65 bytes of a body that then never ends.
    body.push(new Uint8Array(65));
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
  });

  it('takes no memory of the declared length before a byte has come: parked uploads hold nothing', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    const open: { body: ReturnType<typeof heldBody>; answer: Promise<Reply> }[] = [];
    const count = 40;
    const buffers = (): number => process.memoryUsage().arrayBuffers;
    const start = buffers();
    for (let n = 0; n < count; n += 1) {
      const body = heldBody();
      open.push({ body, answer: uploadStream(h, cookie, body.stream, ROOM_PICTURE_MAX_BYTES) });
    }
    await parked(h, count);
    // A buffer of the declared length for each would be the whole of `count` largest pictures.
    expect(buffers() - start).toBeLessThan((count * ROOM_PICTURE_MAX_BYTES) / 10);
    for (const one of open) one.body.fail();
    for (const one of open) expectPictureRefusal(await one.answer, 'picture_malformed');
    expect(h.ledger()).toEqual(before);
  });
});

describe('step 4: the reader keeps no piece (the confirming look of round 2, S1)', () => {
  /** The most an upload may hold while its body comes: its one buffer, and the piece in its hands. */
  const BOUND = ROOM_PICTURE_MAX_BYTES + RUNTIME_BUFFER_BYTES;

  it('holds the declared length and one piece at most while a largest picture comes a byte at a time, and stores it', async () => {
    const { h, cookie } = await ready();
    // The deadline is the route's one timer and never passes here, however slow the machine is.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A look before every 4,096th piece: 65 of them, the floor and the one after the last piece among them.
    const every = 4_096;
    const body = byteAtATime(LARGEST, { every, bound: BOUND });
    const reply = await uploadStream(h, cookie, body.stream, ROOM_PICTURE_MAX_BYTES);
    // 262,144 pieces on 4,096 bytes each are a gigabyte; a list of them, or a race that keeps every
    // finished read reachable from the one deadline, is found at the first look after the floor.
    expect(body.seen.worst).toBeLessThanOrEqual(BOUND);
    expect(body.seen.handed).toBe(ROOM_PICTURE_MAX_BYTES);
    expect(body.seen.looks).toBe(ROOM_PICTURE_MAX_BYTES / every + 1);
    // One timer for the whole body at every look, and none when the body has come.
    expect([...body.seen.timers]).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
    expect(reply.status).toBe(201);
    expect([...([...h.bytes.held.values()][0]?.bytes ?? [])]).toEqual([...GIF]);
  }, 120_000);

  it('holds no more while it is parked after 3,000 single bytes, and lets go of it when the deadline passes', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The attack as the review words it: a largest picture declared, 3,000 bytes written singly, then
    // silence. A reader that keeps the pieces holds 12,288,000 bytes of buffers here.
    const body = byteAtATime(LARGEST, { every: 1_000, bound: BOUND, pieces: 3_000 });
    const answer = uploadStream(h, cookie, body.stream, ROOM_PICTURE_MAX_BYTES);
    await body.finished;
    expect(body.seen.worst).toBeLessThanOrEqual(BOUND);
    expect(body.seen.handed).toBe(3_000);
    expect([...body.seen.timers]).toEqual([1]);
    expect(await outcome(answer)).toBe('pending');
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(body.seen.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // The buffer of the declared length went with the answer.
    expect(body.held()).toBeLessThan(ROOM_PICTURE_MAX_BYTES);
    expect(h.ledger()).toEqual(before);
  }, 60_000);

  it('looks at the deadline before each read: one that passed in the moment a piece came is not lost', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = heldBody();
    const answer = uploadStream(h, cookie, body.stream, GIF.length);
    await parked(h);
    // A piece comes, and before the reader has taken it the one timer fires. The read has won its race, so
    // the timer wakes nothing, and it fires once: a reader that began another read would wait for ever.
    body.push(GIF.slice(0, 10));
    vi.advanceTimersByTime(DEADLINE_MS);
    expectPictureRefusal(await answered(answer), 'picture_malformed');
    expect(body.state.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.ledger()).toEqual(before);
  });
});

describe('step 5: the rule', () => {
  it.each<[RoomPictureRefusalField, Uint8Array]>([
    ['picture_type', new Uint8Array(64)],
    ['picture_type', new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(40)}</svg>`)],
    ['picture_malformed', Uint8Array.from([...GIF, 0])],
    ['picture_dimensions', gifBytes({ side: 8 })],
    ['picture_frames', gifBytes({ frames: ROOM_PICTURE_MAX_FRAMES + 1 })],
  ])('refuses a file as %s, and leaves nothing', async (field, bytes) => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    const reply = await upload(h, cookie, { bytes });
    expectPictureRefusal(reply, field);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS]);
    expect(h.ctx.waited).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('never reads a content type or a name of the request for what the file is', async () => {
    const { h, cookie } = await ready();
    const reply = await upload(h, cookie, { headers: { 'X-File-Name': 'page.html', 'X-Content-Type': 'text/html' } });
    expect(reply.status).toBe(201);
    expect(h.pictures.pictures.get(1)?.type).toBe('gif');
  });
});

describe("after step 5: a request too old by the route's own clock (revision 6, S1)", () => {
  /** An upload that passes steps 1 to 3 at the harness's clock, and whose whole body comes at `arrival`. */
  async function arriving(h: Harness, cookie: string, arrival: string, options: RequestOptions = {}): Promise<Reply> {
    const body = heldBody();
    const earlier = looked(h);
    const answer = uploadStream(h, cookie, body.stream, GIF.length, options);
    await parked(h, earlier + 1);
    h.setNow(arrival);
    body.send(GIF);
    return answer;
  }

  it('refuses an upload whose body came thirteen hours later, with nothing spent and no context taken', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    const reply = await arriving(h, cookie, '2026-10-21T01:00:00.000Z');
    expectPictureRefusal(reply, 'picture_malformed');
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS]);
    expect(h.ctx.waited).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it('takes a body that came whole exactly at the deadline, and refuses one a millisecond past it', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    expectPictureRefusal(await arriving(h, cookie, later(START, DEADLINE_MS + 1)), 'picture_malformed');
    expect(h.ledger()).toEqual(before);
    h.setNow(START);
    const reply = await arriving(h, cookie, later(START, DEADLINE_MS));
    expect(reply.status).toBe(201);
    // Stored under the request's own `now`, never under the reading that judged its age.
    expect(h.room.messages[0]?.at).toBe(START);
    expect([...h.counters.keys()]).toEqual([...COUNT_KEYS]);
  });

  it('answers the refusal with or without an execution context', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = await arriving(h, cookie, later(START, DEADLINE_MS + 1), { context: false });
    expectPictureRefusal(reply, 'picture_malformed');
    expect(error).not.toHaveBeenCalled();
    expect(h.ledger()).toEqual(before);
  });

  it("never stores more pictures in one moment than the hour's cap: twenty bodies released at once", async () => {
    const h = createHarness({ pictures: true });
    const open: { body: ReturnType<typeof heldBody>; answer: Promise<Reply> }[] = [];
    // Ten wallets open an upload in hour 12 and send no body; ten more do so in hour 13; then all twenty
    // send their bodies in one moment of hour 13.
    for (let n = 0; n < 2 * ROOM_PICTURES_PER_HOUR; n += 1) {
      if (n === ROOM_PICTURES_PER_HOUR) {
        await parked(h, ROOM_PICTURES_PER_HOUR);
        h.setNow('2026-10-20T13:00:05.000Z');
      }
      const wallet = `0x${String(n + 1).padStart(40, '0')}`;
      h.room.firstAt.set(wallet, FIRST);
      h.holding.tokens.set(wallet, 1);
      const body = heldBody();
      open.push({ body, answer: uploadStream(h, await h.signIn(wallet), body.stream, GIF.length) });
    }
    await parked(h, 2 * ROOM_PICTURES_PER_HOUR);
    h.setNow('2026-10-20T13:00:10.000Z');
    for (const one of open) one.body.send(GIF);
    const replies = await Promise.all(open.map((one) => one.answer));
    for (const reply of replies.slice(0, ROOM_PICTURES_PER_HOUR)) expectPictureRefusal(reply, 'picture_malformed');
    expect(replies.slice(ROOM_PICTURES_PER_HOUR).map((reply) => reply.status)).toEqual(
      Array(ROOM_PICTURES_PER_HOUR).fill(201),
    );
    expect(h.room.messages).toHaveLength(ROOM_PICTURES_PER_HOUR);
    // Nothing is counted under the hour that had passed: every count is of the hour the bodies came in.
    expect(h.counters.has(HOUR_KEY)).toBe(false);
    expect(h.counters.has(PIC_HOUR_KEY)).toBe(false);
    expect(h.counters.get(roomPictureHourKey(DAY, 13))).toBe(ROOM_PICTURES_PER_HOUR);
    expect(new Set(h.room.messages.map((message) => message.at))).toEqual(new Set(['2026-10-20T13:00:05.000Z']));
  });
});

describe('steps 6 to 11: one promise, handed to waitUntil before it is awaited', () => {
  it('hands the work over before the first call of step 6', async () => {
    const { h, cookie } = await ready();
    expect((await upload(h, cookie)).status).toBe(201);
    const steps = stepsOf(h.trace);
    expect(h.ctx.waited).toHaveLength(1);
    expect(steps.indexOf('ctx.waitUntil')).toBe(steps.indexOf(LOOKS[1] ?? '') + 1);
    expect(steps.indexOf('ctx.waitUntil')).toBeLessThan(steps.lastIndexOf(`limiter:write:${HOLDER}`));
    expect(steps.filter((step) => step === `limiter:write:${HOLDER}`)).toHaveLength(2);
  });

  it('finishes without the client: the message is stored when only the handed promise is awaited', async () => {
    const { h, cookie } = await ready();
    const answer = upload(h, cookie);
    await until('handed its work to the context', () => h.ctx.waited.length > 0);
    await expect(h.ctx.waited[0]).resolves.toBeUndefined();
    expect(h.room.messages).toHaveLength(1);
    expect(h.pictures.pictures.get(1)?.state).toBe('ok');
    expect((await answer).status).toBe(201);
  });

  it('hands over a promise that never rejects, also when a later step refuses or throws', async () => {
    const { h, cookie } = await ready();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.limits.rowsLeft = 0;
    expect((await upload(h, cookie)).status).toBe(503);
    h.limits.rowsLeft = Number.POSITIVE_INFINITY;
    h.pictures.fail.add('takePictureTurn');
    expect((await upload(h, cookie)).status).toBe(500);
    expect(h.ctx.waited).toHaveLength(2);
    for (const handed of h.ctx.waited) await expect(handed).resolves.toBeUndefined();
  });

  it('answers 500 with nothing spent when the app was given no execution context', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = await upload(h, cookie, { context: false });
    expect(reply.status).toBe(500);
    expect(errorOf(reply).code).toBe('internal');
    // A wait before anything is asserted: work that was made before the context was read would run on
    // after the 500, and only then leave its steps in the trace and its spending in the ledger.
    await turns(20);
    expect(error).toHaveBeenCalledTimes(1);
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS]);
    expect(h.ledger()).toEqual(before);
  });
});

describe('a fault of steps 6 to 11 is logged inside the work, with the number of its step (revision 4)', () => {
  type Arrange = (h: Harness) => void;
  const FAILED = ROOM_PICTURE_LOG_EVENTS.uploadFailed;

  it.each<[number, string, Arrange]>([
    [6, "the booking of the day's rows throws", (h) => void Object.assign(h.faults, { spend: true })],
    [7, 'the turn throws', (h) => void h.pictures.fail.add('takePictureTurn')],
    [8, 'the look for removed bytes throws', (h) => void h.pictures.fail.add('isBlocked')],
    [9, 'a take of a count throws', (h) => void h.faults.take.add(PIC_HOUR_KEY)],
    [11, 'the insert throws', (h) => void h.pictures.fail.add('putPicture')],
  ])('logs step %d when %s, before the work rejects', async (step, _name, arrange) => {
    const { h, cookie } = await ready();
    arrange(h);
    let status = 0;
    const lines = await logged(async () => {
      status = (await upload(h, cookie)).status;
    });
    expect(status).toBe(500);
    const own = lines.filter((line) => line.event === FAILED);
    expect(own).toEqual([{ event: FAILED, step }]);
    // Written by the work itself: before the error handler's own line, which a client that left never causes.
    expect(lines.map((line) => line.event).indexOf(FAILED)).toBeLessThan(
      lines.map((line) => line.event).indexOf('api_error'),
    );
  });

  it('is written by the time the handed promise has settled, which is all that is left when the client has gone', async () => {
    const { h, cookie } = await ready();
    h.pictures.fail.add('takePictureTurn');
    const seen: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((text: unknown) => void seen.push(String(text)));
    const answer = upload(h, cookie);
    await until('handed its work to the context', () => h.ctx.waited.length > 0);
    await expect(h.ctx.waited[0]).resolves.toBeUndefined();
    expect(seen.map((text) => JSON.parse(text) as unknown)).toContainEqual({ event: FAILED, step: 7 });
    expect((await answer).status).toBe(500);
  });

  it.each<[string, Arrange, number]>([
    ["the limiter's refusal at step 6", (h) => void Object.assign(h.limiter, { writesAllowed: 1 }), 429],
    ["the wallet's writes of the day at step 6", (h) => void Object.assign(h.limits, { walletWritesLeft: 0 }), 503],
    [
      'a refused turn at step 7',
      (h) =>
        h.pictures.before.set('takePictureTurn', () => h.room.setWriter(HOLDER, { lastAt: START, day: DAY, count: 1 })),
      429,
    ],
    [
      'a put that throws at step 10, which is answered and does not reject',
      (h) => void Object.assign(h.bytes.fail, { put: true }),
      503,
    ],
  ])('is not written for %s: a refusal is an answer and no fault', async (_name, arrange, expected) => {
    const { h, cookie } = await ready();
    arrange(h);
    let status = 0;
    const lines = await logged(async () => {
      status = (await upload(h, cookie)).status;
    });
    expect(status).toBe(expected);
    expect(lines).toEqual([]);
  });

  it("carries the step's number and nothing else: no address, key or hash", async () => {
    const { h, cookie } = await ready();
    h.pictures.fail.add('putPicture');
    const lines = await logged(async () => {
      await upload(h, cookie);
    });
    const line = lines.find((entry) => entry.event === FAILED);
    expect(Object.keys(line ?? {}).sort()).toEqual(['event', 'step']);
  });
});

describe('step 6: the write of the day', () => {
  it('asks the limiter once more, and a refusal there leaves nothing', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    h.limiter.writesAllowed = 1;
    const reply = await upload(h, cookie);
    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS, 'ctx.waitUntil', `limiter:write:${HOLDER}`]);
    expect(h.ledger()).toEqual(before);
  });

  it('refuses a wallet at its writes of the day with nothing spent', async () => {
    const { h, cookie } = await ready();
    const before = h.ledger();
    h.limits.walletWritesLeft = 0;
    const reply = await upload(h, cookie);
    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(stepsOf(h.trace).at(-1)).toBe('store.spendWalletWrite');
    expect(h.ledger()).toEqual(before);
  });

  it("refuses when the day's rows are spent, and leaves the wallet's write of the day spent", async () => {
    const { h, cookie } = await ready();
    h.limits.rowsLeft = ROOM_PICTURE_POST_WRITE_ROWS - 1;
    const reply = await upload(h, cookie);
    expect(reply.status).toBe(503);
    expect(errorOf(reply).code).toBe('daily_limit');
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS, ...SPEND]);
    expect(h.spent).toEqual({ walletWrites: 1, rows: 0 });
    expect(h.room.writers.size).toBe(0);
    expect(h.counters.size).toBe(0);
  });
});

/** What steps 7 and later leave when they refuse: the write of the day and the rows, spent at step 6. */
const SPENT = { walletWrites: 1, rows: ROOM_PICTURE_POST_WRITE_ROWS };

describe('step 7: the turn', () => {
  it('decides what step 3 only looked at, and a refused turn leaves no turn and no count', async () => {
    const { h, cookie } = await ready();
    // Another request of the wallet wins the turn between the look and the take.
    h.pictures.before.set('takePictureTurn', () => h.room.setWriter(HOLDER, { lastAt: START, day: DAY, count: 1 }));
    const reply = await upload(h, cookie);
    expectRoomRefusal(reply, 'too_soon');
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_SECONDS_BETWEEN));
    expect(stepsOf(h.trace)).toEqual([...BEFORE_LOOKS, ...LOOKS, ...SPEND, 'pictures.takePictureTurn']);
    expect(h.spent).toEqual(SPENT);
    expect(h.room.writers.get(HOLDER)?.count).toBe(1);
    expect(h.pictures.extras.size).toBe(0);
    expect(h.counters.size).toBe(0);
    expect(h.bytes.held.size).toBe(0);
  });

  it('answers a refusal of the turn by the field of a picture', async () => {
    const { h, cookie } = await ready();
    h.pictures.before.set('takePictureTurn', () =>
      h.pictures.setExtra(HOLDER, { picturesDay: DAY, picturesCount: ROOM_PICTURES_PER_WALLET_PER_DAY }),
    );
    expectPictureRefusal(await upload(h, cookie), 'picture_wallet_day');
    h.pictures.extras.clear();
    h.pictures.before.set('takePictureTurn', () => h.room.setWriter(HOLDER, { mutedAt: START, cutAt: START }));
    expectRoomRefusal(await upload(h, cookie), 'muted');
  });

  it('leaves the same when the turn throws', async () => {
    const { h, cookie } = await ready();
    h.pictures.fail.add('takePictureTurn');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await upload(h, cookie)).status).toBe(500);
    expect(h.spent).toEqual(SPENT);
    expect(h.counters.size).toBe(0);
    expect(h.bytes.held.size).toBe(0);
  });
});

describe('step 8: bytes an admin removed before', () => {
  it('asks only after the turn, and the answer costs the turn and a picture of the day', async () => {
    const { h, cookie } = await ready();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', GIF));
    const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    h.pictures.blocks.set(sha256, {
      at: FIRST,
      by: ADMIN,
      messageId: 9,
      author: STRANGER,
      postedAt: FIRST,
      type: 'gif',
      bytes: GIF.length,
      width: 16,
      height: 16,
      frames: 1,
      reports: 3,
    });
    const reply = await upload(h, cookie);
    expectPictureRefusal(reply, 'picture_blocked');
    expect(stepsOf(h.trace)).toEqual([
      ...BEFORE_LOOKS,
      ...LOOKS,
      ...SPEND,
      'pictures.takePictureTurn',
      'pictures.isBlocked',
    ]);
    expect(h.spent).toEqual(SPENT);
    expect(h.room.writers.get(HOLDER)).toMatchObject({ lastAt: START, day: DAY, count: 1 });
    expect(h.pictures.extras.get(HOLDER)).toMatchObject({ picturesDay: DAY, picturesCount: 1 });
    expect(h.counters.size).toBe(0);
    expect(h.bytes.held.size).toBe(0);
    expect(h.room.messages).toEqual([]);
  });

  it('is never asked of a file that an earlier step refused', async () => {
    const { h, cookie } = await ready();
    h.room.setWriter(HOLDER, { cutAt: FIRST });
    await upload(h, cookie);
    await upload(h, cookie, { bytes: new Uint8Array(64) });
    expect(h.trace).not.toContain('pictures.isBlocked');
  });
});

describe("step 9: the room's four counts", () => {
  const caps: [string, RoomPictureRefusalField | RoomRefusalField, number][] = [
    [HOUR_KEY, 'room_hour', ROOM_MESSAGES_PER_HOUR],
    [DAY_KEY, 'room_day', 7],
    [PIC_HOUR_KEY, 'picture_room_hour', ROOM_PICTURES_PER_HOUR],
    [PIC_DAY_KEY, 'picture_room_day', 5],
  ];

  it.each(caps)('gives back what it took when the count %s is full, and keeps the turn', async (key, field, cap) => {
    const { h, cookie } = await ready({ roomDailyCap: 7, picturesDailyCap: 5 });
    // The count fills between the look of step 3 and the take.
    h.pictures.before.set('isBlocked', () => void h.counters.set(key, cap));
    const reply = await upload(h, cookie);
    if (field in ROOM_REFUSALS) expectRoomRefusal(reply, field as RoomRefusalField);
    else expectPictureRefusal(reply, field as RoomPictureRefusalField);
    expect(reply.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
    const taken = COUNT_KEYS.slice(0, COUNT_KEYS.indexOf(key as (typeof COUNT_KEYS)[number]));
    expect(stepsOf(h.trace).slice([...BEFORE_LOOKS, ...LOOKS, ...SPEND].length + 2)).toEqual([
      ...taken.map((taken_) => `counter.take:${taken_}`),
      `counter.take:${key}`,
      ...[...taken].reverse().map((taken_) => `counter.back:${taken_}`),
    ]);
    for (const other of taken) expect(h.counters.get(other)).toBe(0);
    expect(h.counters.get(key)).toBe(cap);
    expect(h.spent).toEqual(SPENT);
    expect(h.room.writers.get(HOLDER)?.count).toBe(1);
    expect(h.pictures.extras.get(HOLDER)?.picturesCount).toBe(1);
    expect(h.bytes.held.size).toBe(0);
    expect(h.room.messages).toEqual([]);
  });

  it.each(caps)('gives back what it took when the take of %s throws', async (key) => {
    const { h, cookie } = await ready();
    h.faults.take.add(key);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await upload(h, cookie)).status).toBe(500);
    for (const other of COUNT_KEYS) expect(h.counters.get(other) ?? 0).toBe(0);
    expect(h.bytes.held.size).toBe(0);
    expect(h.room.writers.get(HOLDER)?.count).toBe(1);
  });

  it('keeps the refusal when a give-back fails', async () => {
    const { h, cookie } = await ready({ picturesDailyCap: 5 });
    h.pictures.before.set('isBlocked', () => void h.counters.set(PIC_DAY_KEY, 5));
    h.faults.giveBack = true;
    const lines = await logged(async () => {
      expectPictureRefusal(await upload(h, cookie), 'picture_room_day');
    });
    expect(lines.map((line) => line.event)).toEqual(Array(3).fill('room_count_not_given_back'));
    expect(stepsOf(h.trace).filter((step) => step.startsWith('counter.back:'))).toHaveLength(3);
  });

  it('stops uploads at a cap of 0 and takes nothing', async () => {
    const { h, cookie } = await ready({ picturesDailyCap: 0 });
    expectPictureRefusal(await upload(h, cookie), 'picture_room_day');
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
  });
});

describe('step 10: the put', () => {
  it('answers 503 when the put throws, and gives no count back', async () => {
    const { h, cookie } = await ready();
    h.bytes.fail.put = true;
    const reply = await upload(h, cookie);
    expectPictureRefusal(reply, 'picture_storage');
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_PICTURE_STORAGE_RETRY_SECONDS));
    expect(stepsOf(h.trace).at(-1)).toBe('bytes.put');
    expect(h.trace.filter((step) => step.startsWith('counter.back:'))).toEqual([]);
    for (const key of COUNT_KEYS) expect(h.counters.get(key)).toBe(1);
    expect(h.spent).toEqual(SPENT);
    expect(h.room.messages).toEqual([]);
  });
});

describe('step 11: the insert', () => {
  it.each<['muted' | 'off', RoomPictureRefusalField | RoomRefusalField]>([
    ['muted', 'muted'],
    ['off', 'pictures_off'],
  ])('deletes the key once and logs it when the insert is refused as %s', async (why, field) => {
    const { h, cookie } = await ready();
    h.pictures.before.set('putPicture', () => {
      if (why === 'muted') h.room.setWriter(HOLDER, { mutedAt: START, mutedBy: ADMIN, cutAt: START });
      else h.pictures.off = { at: START, by: ADMIN, why: 'admin' };
    });
    let reply: Reply | null = null;
    const lines = await logged(async () => {
      reply = await upload(h, cookie);
    });
    if (reply === null) throw new Error('no reply');
    if (field in ROOM_REFUSALS) expectRoomRefusal(reply, field as RoomRefusalField);
    else expectPictureRefusal(reply, field as RoomPictureRefusalField);
    expect(lines).toEqual([{ event: ROOM_PICTURE_LOG_EVENTS.orphan, count: 1 }]);
    expect(stepsOf(h.trace).slice(-3)).toEqual(['bytes.put', 'pictures.putPicture', 'bytes.delete']);
    expect(h.bytes.deletes).toHaveLength(1);
    expect(h.bytes.held.size).toBe(0);
    expect(h.room.messages).toEqual([]);
    for (const key of COUNT_KEYS) expect(h.counters.get(key)).toBe(1);
  });

  it('tries the delete once and never again when it throws, and keeps the refusal', async () => {
    const { h, cookie } = await ready();
    h.pictures.before.set(
      'putPicture',
      () => void Object.assign(h.pictures, { off: { at: START, by: ADMIN, why: 'admin' } }),
    );
    h.bytes.fail.delete.add('*');
    const lines = await logged(async () => {
      expectPictureRefusal(await upload(h, cookie), 'pictures_off');
    });
    expect(lines).toEqual([{ event: ROOM_PICTURE_LOG_EVENTS.orphan, count: 1 }]);
    expect(h.bytes.deletes).toHaveLength(1);
    expect(h.bytes.held.size).toBe(1);
  });

  it('leaves the key to its expiry when the insert throws: it may have stored the row', async () => {
    const { h, cookie } = await ready();
    h.pictures.fail.add('putPicture');
    let status = 0;
    const lines = await logged(async () => {
      status = (await upload(h, cookie)).status;
    });
    expect(status).toBe(500);
    expect(lines.map((line) => line.event)).toEqual([
      ROOM_PICTURE_LOG_EVENTS.orphan,
      ROOM_PICTURE_LOG_EVENTS.uploadFailed,
      'api_error',
    ]);
    expect(lines[0]).toEqual({ event: ROOM_PICTURE_LOG_EVENTS.orphan, count: 1 });
    expect(h.bytes.deletes).toEqual([]);
    expect([...h.bytes.held.values()][0]?.ttlSeconds).toBe(ROOM_PICTURE_TTL_SECONDS);
  });

  it('writes no address, key or hash into a log line', async () => {
    const { h, cookie } = await ready();
    h.pictures.before.set(
      'putPicture',
      () => void Object.assign(h.pictures, { off: { at: START, by: ADMIN, why: 'admin' } }),
    );
    const lines = await logged(async () => {
      await upload(h, cookie);
    });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('pic/');
    expect(text).not.toContain(HOLDER);
  });
});

describe('the one exemption of the body limit (section 5)', () => {
  const large = String(MAX_BODY_BYTES + 1);
  const tooLarge = failures.bodyTooLarge().message;

  it("lets a declared length above 16,384 bytes through to the upload and to step 1's own rule", async () => {
    const { h } = await ready();
    const reply = await upload(h, undefined, { headers: { 'Content-Length': large } });
    expect(reply.status).toBe(401);
    const over = await upload(h, undefined, { headers: { 'Content-Length': String(ROOM_PICTURE_MAX_BYTES + 1) } });
    expectPictureRefusal(over, 'picture_size');
  });

  it.each<[string, string]>([
    ['POST', '/api/social/room'],
    ['POST', `${UPLOAD}/1/report`],
    ['POST', `${UPLOAD}/`],
    ['PUT', UPLOAD],
    ['DELETE', UPLOAD],
    ['PUT', '/api/social/admin/room/pictures/off'],
    ['DELETE', '/api/social/admin/room/messages/1'],
    ['POST', '/api/agents'],
  ])('keeps the 16,384 bytes on %s %s', async (method, path) => {
    const { h, cookie } = await ready();
    const reply = await h.fetch(method, path, { cookie, headers: { 'Content-Length': large } });
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toEqual({ code: 'invalid_input', message: tooLarge, field: null });
    expect(stepsOf(h.trace)).toEqual([]);
  });
});

describe('the switch of pictures (section 10)', () => {
  it.each([
    ['the entry does not hand pictures over', { pictures: true, picturesGiven: false }],
    ['pictures are handed over with their switch off', { pictures: false }],
  ])('answers the generic 404 on the three routes while %s', async (_name, options) => {
    const h = createHarness(options);
    h.room.firstAt.set(HOLDER, FIRST);
    const picture = h.pictures.seedPicture(STRANGER, FIRST);
    const cookie = await h.signIn(HOLDER);
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    h.trace.length = 0;
    const replies = [
      await upload(h, cookie),
      await h.fetch('GET', `${UPLOAD}/${picture.id}`, {
        headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' },
      }),
      await h.fetch('POST', `${UPLOAD}/${picture.id}/report`, { cookie }),
    ];
    for (const reply of replies) {
      expect(reply.status).toBe(404);
      expect(reply.text).toBe(unknown.text);
    }
    expect(stepsOf(h.trace)).toEqual([]);
    expect(h.ctx.waited).toEqual([]);
  });
});

describe("the API's own sentences of a refused picture", () => {
  it("names the largest file by the contract's figure, in whole kibibytes", () => {
    expect(ROOM_PICTURE_MAX_BYTES % 1_024).toBe(0);
    expect(ROOM_PICTURE_SENTENCES.picture_size).toContain(`${ROOM_PICTURE_MAX_BYTES / 1_024} KiB`);
  });

  it('says of a malformed picture what is true of a file that cannot be read and of one that came too late', () => {
    const sentence = ROOM_PICTURE_SENTENCES.picture_malformed;
    expect(sentence).toMatch(/did not arrive whole/);
    expect(sentence).toMatch(/cannot be read/);
    // What to do next, for both: the same picture once more, or another one.
    expect(sentence).toMatch(/again/);
    expect(sentence).toMatch(/another picture/);
    expect(sentence).not.toMatch(/broken|not a whole/i);
  });

  it('names who decides on a picture by the site’s word: an admin of Prix, never a moderator', () => {
    for (const [field, sentence] of Object.entries(ROOM_PICTURE_SENTENCES)) {
      expect(sentence, field).not.toMatch(/moderator/i);
    }
    for (const field of ['picture_blocked', 'picture_paused', 'report_own'] as const) {
      expect(ROOM_PICTURE_SENTENCES[field], field).toMatch(/\ban admin of Prix\b/i);
    }
  });
});

describe('what the tests stand on', () => {
  it('waits for the handed work', async () => {
    const { h, cookie } = await ready();
    await upload(h, cookie);
    await settled(h);
    expect(h.ctx.waited).toHaveLength(1);
  });
});
