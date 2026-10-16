import type { RateLimitRule, RoomPictureApiDeps } from '@prix/contracts';
import {
  ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
  ROOM_PICTURES_PATH,
  roomDailyCap,
  roomDailyCapBesidePictures,
  roomDayKey,
  roomHourKey,
  roomPictureCheck,
  roomPictureDayKey,
  roomPictureHourKey,
  roomPictureReportHidesKey,
  roomPictureReportsKey,
  roomPicturesDailyCap,
  roomPictureViewsCap,
  roomPictureViewsKey,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import { createApp } from '../../../apps/api/src/http/index.ts';
import { hashToken, newSessionToken } from '../../../apps/api/src/http/session.ts';
import { createD1Store } from '../../../apps/api/src/store/index.ts';
import { createReputationStore } from '../../../apps/api/src/store/reputation.ts';
import { createRoomStore } from '../../../apps/api/src/store/room.ts';
import type { RoomPictureKv } from '../../../apps/api/src/store/room-picture-bytes.ts';
import { createRoomPictureBytes } from '../../../apps/api/src/store/room-picture-bytes.ts';
import { createRoomPictureStore } from '../../../apps/api/src/store/room-pictures.ts';
import { createSocialStore } from '../../../apps/api/src/store/social.ts';
import { createTestVault, FakeRateLimiter } from '../../support/fakes.ts';
import type { Reply } from '../api/harness.ts';
import { ADMIN, fakeWarStandings, HOUSE, SITE } from '../api/harness.ts';

/**
 * The room with pictures as the Worker serves it, for qa's tests of docs/contracts/phase-6-pictures.md:
 * the real routes behind `createApp`, the real stores on a local D1 with the real migrations, and the
 * real bytes port over a KV of the test's own. Nothing of the routes or of the stores is a fake.
 *
 * Everything the app asks of the outside is written to ONE trace, in the order it was asked: every
 * statement prepared on the database (`d1 <sql>`), every call of KV (`kv.put`, `kv.get`, `kv.delete`),
 * every asking of the limiter (`limit.write`, `limit.read`, `limit.picture`), and the hand-over to the
 * request's execution context (`ctx.waitUntil`). A test of an order reads it.
 */

export { ADMIN, SITE };

/** A KV of the test's own, as the binding ROOM_PICTURES answers: it writes down every call and can be made to fail. */
export class TestKv implements RoomPictureKv {
  readonly held = new Map<string, ArrayBuffer>();
  readonly puts: { key: string; value: ArrayBuffer; options: unknown }[] = [];
  readonly gets: string[] = [];
  readonly deletes: string[] = [];
  /** `put`, `get`, `delete`: the calls that throw. */
  readonly fail = new Set<'put' | 'get' | 'delete'>();
  /**
   * A KV that still answers after `delete`, as Cloudflare's does for a minute or more in a location that
   * read the key lately: `delete` answers and the bytes stay readable.
   */
  keepsAfterDelete = false;

  constructor(private readonly trace: string[]) {}

  async put(key: string, value: ArrayBuffer, options: { expirationTtl: number }): Promise<void> {
    this.trace.push('kv.put');
    this.puts.push({ key, value, options });
    if (this.fail.has('put')) throw new Error('KV put failed');
    this.held.set(key, value.slice(0));
  }

  async get(key: string, _type: 'arrayBuffer'): Promise<ArrayBuffer | null> {
    this.trace.push('kv.get');
    this.gets.push(key);
    if (this.fail.has('get')) throw new Error('KV get failed');
    return this.held.get(key)?.slice(0) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.trace.push('kv.delete');
    this.deletes.push(key);
    if (this.fail.has('delete')) throw new Error('KV delete failed');
    if (!this.keepsAfterDelete) this.held.delete(key);
  }

  calls(): number {
    return this.puts.length + this.gets.length + this.deletes.length;
  }
}

/** A request's execution context that writes down what `waitUntil` was handed, and when. */
export class TestContext {
  readonly waited: Promise<unknown>[] = [];
  readonly props = {};

  constructor(private readonly trace: string[]) {}

  waitUntil(promise: Promise<unknown>): void {
    this.trace.push('ctx.waitUntil');
    this.waited.push(promise);
  }

  passThroughOnException(): void {}
}

class TracedLimiter extends FakeRateLimiter {
  /** How many askings of the `write` rule pass before it refuses. */
  writesAllowed = Number.POSITIVE_INFINITY;
  private writes = 0;

  constructor(private readonly trace: string[]) {
    super();
  }

  override async allow(rule: RateLimitRule, subject: string): Promise<boolean> {
    this.trace.push(`limit.${rule}`);
    const allowed = await super.allow(rule, subject);
    if (rule !== 'write') return allowed;
    this.writes += 1;
    return allowed && this.writes <= this.writesAllowed;
  }
}

export interface UploadOptions {
  /** The session cookie; none: a visitor. */
  cookie?: string;
  /** Headers set, replaced or (with null) left out, after the ones a real upload carries. */
  headers?: Record<string, string | null>;
  /** The declared length, when it is not the body's own. */
  declared?: string | null;
  /** A body of the test's own in place of the file's bytes. */
  body?: BodyInit | null;
  /** `none`: the app is fetched with no execution context at all. */
  context?: TestContext | 'none';
  ip?: string;
}

export interface PictureWorld {
  deps: RoomPictureApiDeps;
  db: D1Database;
  trace: string[];
  kv: TestKv;
  limiter: TracedLimiter;
  /** The `picture` rule of the bytes routes: every subject it was asked for, and whether it allows. */
  pictureRule: { asked: string[]; allow: boolean };
  /** What `deps.random` answers: 0.99 counts no view, 0 counts every one. */
  random: { value: number };
  gate: { on: boolean };
  holdings: Map<string, number>;
  /** Every asking of a holding, with whether the route asked for the stored one only. */
  holdingReads: { address: string; cachedOnly: boolean }[];
  /** Every response so far: what a leak scan reads. */
  transcript: string[];
  /** Every context a request of this world was given. */
  contexts: TestContext[];
  now(): string;
  setNow(iso: string): void;
  advance(ms: number): void;
  signIn(address: string): Promise<string>;
  /** Any request, as the site sends it: JSON and the site's origin for a write. The body is text or none. */
  fetch(
    method: string,
    path: string,
    options?: { cookie?: string; headers?: Record<string, string | null>; body?: unknown; ip?: string },
  ): Promise<Reply>;
  /** A picture's bytes, asked as an `<img>` on the site's own page asks: the two fetch headers, and no session unless one is given. */
  image(
    path: string,
    options?: { cookie?: string; headers?: Record<string, string | null>; ip?: string },
  ): Promise<Reply & { bytes: Uint8Array }>;
  /** An upload as the composer sends it, with a recording context of its own unless the test hands one. */
  upload(file: Uint8Array, options?: UploadOptions): Promise<Reply>;
  /** The request of an upload, not sent: for a test that never awaits the answer. */
  uploadRequest(file: Uint8Array, options?: UploadOptions): Request;
  /** The app itself: `fetch(request, ctx)`. */
  app: ReturnType<typeof createApp>;
}

export interface WorldOptions {
  now?: string;
  /** ROOM_PICTURES_ENABLED with the two other switches: off, the three public routes are not mounted. */
  pictures?: boolean;
  /** The variables' texts, read by the contract's own functions as the entry reads them. */
  messagesCap?: string;
  picturesCap?: string;
  viewsCap?: string;
  adminAddresses?: string[];
  /** A KV binding of the test's own, or `null` for no binding at all. */
  kv?: RoomPictureKv | null;
  /** Wraps the pictures' store before the routes get it: a fault, or a call that is watched. */
  wrapPictures?: (store: RoomPictureApiDeps['pictures']) => RoomPictureApiDeps['pictures'];
  /** The same for the store of the counters. */
  wrapReputation?: (store: RoomPictureApiDeps['reputation']) => RoomPictureApiDeps['reputation'];
}

/** A store with some of its methods replaced; every other method is the real one. */
export function withOver<T extends object>(target: T, over: Partial<T>): T {
  return new Proxy(target, {
    get(real, name) {
      if (name in over) return Reflect.get(over, name);
      const value = Reflect.get(real, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
  });
}

/**
 * A database whose every prepared statement is written to the trace, whole, with its white space folded.
 * A D1 session is written down too (`d1.withSession`), and what is prepared in it is traced like the
 * rest: no statement of the pictures' store may run in one (the contract's section 6: a session reads a
 * replica, and D1 must refuse a removed picture at once, from the primary).
 */
function tracedDb(real: D1Database, trace: string[]): D1Database {
  return new Proxy(real, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          trace.push(`d1 ${sql.replace(/\s+/g, ' ').trim()}`);
          return target.prepare(sql);
        };
      }
      if (name === 'withSession') {
        return (...args: unknown[]) => {
          trace.push('d1.withSession');
          // A session prepares statements as the database does: it is traced through the same wrapper.
          const open = Reflect.get(target, name) as unknown as (...a: unknown[]) => unknown;
          return tracedDb(open.apply(target, args) as D1Database, trace);
        };
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function createPictureWorld(real: D1Database, options: WorldOptions = {}): PictureWorld {
  let now = new Date(options.now ?? '2026-10-20T12:10:30.000Z');
  const trace: string[] = [];
  const db = tracedDb(real, trace);
  const kv = new TestKv(trace);
  const limiter = new TracedLimiter(trace);
  const pictureRule = { asked: [] as string[], allow: true };
  const random = { value: 0.99 };
  const gate = { on: true };
  const holdings = new Map<string, number>();
  const holdingReads: PictureWorld['holdingReads'] = [];
  const transcript: string[] = [];
  const contexts: TestContext[] = [];
  const picturesEnabled = options.pictures ?? true;
  const picturesDailyCap = roomPicturesDailyCap(options.picturesCap);
  const pictureViewsCap = roomPictureViewsCap(options.viewsCap);
  const messagesCap = roomDailyCap(options.messagesCap);
  const pictures = createRoomPictureStore(db);

  const deps: RoomPictureApiDeps = {
    store: createD1Store(db),
    sim,
    scoring,
    sealer: createTestVault().sealer,
    rateLimiter: limiter,
    config: {
      siteOrigin: SITE,
      adminAddresses: options.adminAddresses ?? [ADMIN],
      houseModel: '@cf/test/house-model',
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: [HOUSE],
    },
    now: () => new Date(now.getTime()),
    entitlements: {
      async entitlementsFor() {
        throw new Error('no route of pictures asks a tier');
      },
    },
    social: createSocialStore(db),
    reputation:
      options.wrapReputation === undefined
        ? createReputationStore(db)
        : options.wrapReputation(createReputationStore(db)),
    warStandings: fakeWarStandings,
    groqConfigured: false,
    room: createRoomStore(db),
    roomEnabled: true,
    // As the entry sets it: beside pictures the room's cap of messages gives way.
    roomDailyCap: picturesEnabled
      ? roomDailyCapBesidePictures(messagesCap, picturesDailyCap, pictureViewsCap)
      : messagesCap,
    prixAddress: async () => null,
    async holding(address, read) {
      holdingReads.push({ address, cachedOnly: read?.cachedOnly === true });
      return gate.on
        ? { gatingOn: true, tokens: holdings.get(address.toLowerCase()) ?? 0 }
        : { gatingOn: false, tokens: 0 };
    },
    pictures: options.wrapPictures === undefined ? pictures : options.wrapPictures(pictures),
    bytes: createRoomPictureBytes(options.kv === null ? undefined : (options.kv ?? kv)),
    picturesEnabled,
    picturesDailyCap,
    pictureViewsCap,
    pictureLimiter: {
      async allow(subject) {
        trace.push('limit.picture');
        pictureRule.asked.push(subject);
        return pictureRule.allow;
      },
    },
    random: () => random.value,
  };

  // As the entry mounts them: the admin's always, the room's and the pictures' public routes while on.
  const app = createApp(deps, {
    room: deps,
    roomAdmin: deps,
    roomPicturesAdmin: deps,
    ...(picturesEnabled ? { roomPictures: deps } : {}),
  });

  async function answer(method: string, path: string, response: Response): Promise<Reply & { bytes: Uint8Array }> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    const head = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n');
    transcript.push(`${method} ${path} -> ${response.status}\n${head}\n\n${text}`);
    return { status: response.status, headers: response.headers, text, json, bytes };
  }

  function apply(headers: Headers, extra: Record<string, string | null> | undefined): void {
    for (const [name, value] of Object.entries(extra ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
  }

  function uploadRequest(file: Uint8Array, request: UploadOptions = {}): Request {
    const headers = new Headers({
      'CF-Connecting-IP': request.ip ?? '203.0.113.9',
      Origin: SITE,
      'Content-Type': ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
      'Sec-Fetch-Site': 'same-origin',
    });
    const declared = request.declared === undefined ? String(file.length) : request.declared;
    if (declared !== null) headers.set('Content-Length', declared);
    if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
    apply(headers, request.headers);
    const body = request.body === undefined ? file : request.body;
    const streamed = body instanceof ReadableStream;
    return new Request(`${SITE}${ROOM_PICTURES_PATH}`, {
      method: 'POST',
      headers,
      body,
      ...(streamed ? { duplex: 'half' } : {}),
    } as RequestInit);
  }

  return {
    deps,
    db: real,
    trace,
    kv,
    limiter,
    pictureRule,
    random,
    gate,
    holdings,
    holdingReads,
    transcript,
    contexts,
    app,
    now: () => now.toISOString(),
    setNow(iso) {
      now = new Date(iso);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
    async signIn(address) {
      const sessionToken = newSessionToken();
      const at = now.toISOString();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      // On the plain database: a sign-in is no part of what a request asked.
      const store = createD1Store(real);
      await store.putSession({ tokenHash: await hashToken(sessionToken), address, createdAt: at, expiresAt });
      await store.touchUser(address, '2020-01-01T00:00:00.000Z');
      return sessionToken;
    },
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': request.ip ?? '203.0.113.9' });
      if (changes) {
        headers.set('Origin', SITE);
        headers.set('Content-Type', 'application/json');
      }
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      apply(headers, request.headers);
      const body = request.body === undefined ? undefined : JSON.stringify(request.body);
      const context = new TestContext(trace);
      contexts.push(context);
      const response = await app.fetch(new Request(`${SITE}${path}`, { method, headers, body }), context as never);
      await Promise.all(context.waited);
      return answer(method, path, response);
    },
    async image(path, request = {}) {
      const headers = new Headers({
        'CF-Connecting-IP': request.ip ?? '203.0.113.9',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Dest': 'image',
      });
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      apply(headers, request.headers);
      const context = new TestContext(trace);
      contexts.push(context);
      const response = await app.fetch(new Request(`${SITE}${path}`, { method: 'GET', headers }), context as never);
      return answer('GET', path, response);
    },
    uploadRequest,
    async upload(file, request = {}) {
      const sent = uploadRequest(file, request);
      let response: Response;
      if (request.context === 'none') {
        response = await app.fetch(sent);
      } else {
        const context = request.context ?? new TestContext(trace);
        contexts.push(context);
        response = await app.fetch(sent, context as never);
        await Promise.all(context.waited);
      }
      return answer('POST', ROOM_PICTURES_PATH, response);
    },
  };
}

// --- what a request left behind, read from the tables themselves ------------------------------------------

/** Everything a request of pictures can leave: the tables' own rows and KV's own keys. */
export interface PictureLedger {
  /** The wallet's state-changing requests of the day, which `spendWrite` counts. */
  walletWrites: number;
  /** The day's rows for API writes. */
  dayRows: number;
  /** The writer's turn: the time of its last message, and its messages and its pictures of the day. */
  turn: { lastAt: string | null; count: number; pictures: number } | null;
  /** The room's four counts, in the order step 9 takes them. */
  hour: number;
  day: number;
  pictureHour: number;
  pictureDay: number;
  messages: number;
  pictures: number;
  /** The keys KV holds, and how many puts it was asked for. */
  keys: number;
  puts: number;
}

export const NOTHING_LEFT: PictureLedger = {
  walletWrites: 0,
  dayRows: 0,
  turn: null,
  hour: 0,
  day: 0,
  pictureHour: 0,
  pictureDay: 0,
  messages: 0,
  pictures: 0,
  keys: 0,
  puts: 0,
};

export async function counterOf(db: D1Database, key: string): Promise<number> {
  return (await db.prepare('SELECT n FROM counters WHERE key = ?1').bind(key).first<{ n: number }>())?.n ?? 0;
}

export async function seedCount(db: D1Database, key: string, n: number, at: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO counters (key, n, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET n = excluded.n',
    )
    .bind(key, n, at)
    .run();
}

/** Reads the ledger for `address` at `now` (its UTC day and hour) straight from the tables and from KV. */
export async function pictureLedger(w: PictureWorld, address: string, at: string = w.now()): Promise<PictureLedger> {
  const db = w.db;
  const day = at.slice(0, 10);
  const hour = new Date(at).getUTCHours();
  const lower = address.toLowerCase();
  const user = await db
    .prepare('SELECT write_day, write_count FROM users WHERE lower(address) = ?1')
    .bind(lower)
    .first<{ write_day: string | null; write_count: number | null }>();
  const rows = await db.prepare('SELECT rows FROM api_writes WHERE day = ?1').bind(day).first<{ rows: number }>();
  const writer = await db
    .prepare('SELECT last_at, day, count, pictures_day, pictures_count FROM room_writers WHERE address = ?1')
    .bind(lower)
    .first<{
      last_at: string | null;
      day: string | null;
      count: number;
      pictures_day: string | null;
      pictures_count: number;
    }>();
  const messages = await db
    .prepare('SELECT COUNT(*) AS n, COUNT(pic_type) AS p FROM room_messages')
    .first<{ n: number; p: number }>();
  return {
    walletWrites: user !== null && user.write_day === day ? (user.write_count ?? 0) : 0,
    dayRows: rows?.rows ?? 0,
    turn:
      writer === null
        ? null
        : {
            lastAt: writer.last_at,
            count: writer.day === day ? writer.count : 0,
            pictures: writer.pictures_day === day ? writer.pictures_count : 0,
          },
    hour: await counterOf(db, roomHourKey(day, hour)),
    day: await counterOf(db, roomDayKey(day)),
    pictureHour: await counterOf(db, roomPictureHourKey(day, hour)),
    pictureDay: await counterOf(db, roomPictureDayKey(day)),
    messages: messages?.n ?? 0,
    pictures: messages?.p ?? 0,
    keys: w.kv.held.size,
    puts: w.kv.puts.length,
  };
}

/** The three counters reports and views keep, at `now`. */
export async function reportCounts(
  w: PictureWorld,
  at: string = w.now(),
): Promise<{ reports: number; hides: number; views: number }> {
  const day = at.slice(0, 10);
  const hour = new Date(at).getUTCHours();
  return {
    reports: await counterOf(w.db, roomPictureReportsKey(day)),
    hides: await counterOf(w.db, roomPictureReportHidesKey(day, hour)),
    views: await counterOf(w.db, roomPictureViewsKey(day)),
  };
}

/** Empties what the pictures' tests write, so that each starts from nothing. */
export async function emptyPictureTables(db: D1Database): Promise<void> {
  await db.batch(
    [
      'room_picture_reports',
      'room_picture_blocks',
      'room_flags',
      'room_messages',
      'room_writers',
      'counters',
      'api_writes',
      'sessions',
      'users',
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
}

/**
 * A writer who may upload and report at `now`: one whole $PRIX, and a first message of text that has
 * stood in the chat for `ageSeconds` (two days unless a test says otherwise), stored by the room's own
 * store as a write stores it.
 */
export async function seedWriter(
  w: PictureWorld,
  address: string,
  options: { ageSeconds?: number; text?: string } = {},
): Promise<{ cookie: string; firstId: number; firstAt: string }> {
  w.holdings.set(address.toLowerCase(), 1);
  const firstAt = new Date(Date.parse(w.now()) - (options.ageSeconds ?? 2 * 86_400) * 1_000).toISOString();
  const stored = await createRoomStore(w.db).putMessage(address.toLowerCase(), options.text ?? 'a first line', firstAt);
  return { cookie: await w.signIn(address), firstId: stored.id, firstAt };
}

/** The picture columns of a message's row, as the table holds them. */
export interface PictureRow {
  id: number;
  at: string;
  author: string;
  text: string;
  hidden_at: string | null;
  pic_type: string | null;
  pic_key: string | null;
  pic_bytes: number | null;
  pic_width: number | null;
  pic_height: number | null;
  pic_frames: number | null;
  pic_sha256: string | null;
  pic_state: string | null;
  pic_reports: number;
  pic_decided_by: string | null;
  pic_gone_at: string | null;
}

export async function pictureRows(db: D1Database): Promise<PictureRow[]> {
  const found = await db
    .prepare('SELECT * FROM room_messages WHERE pic_type IS NOT NULL ORDER BY id')
    .all<PictureRow>();
  return found.results;
}

export async function pictureRow(db: D1Database, id: number): Promise<PictureRow | null> {
  return db.prepare('SELECT * FROM room_messages WHERE id = ?1').bind(id).first<PictureRow>();
}

/** SHA-256 of bytes, in lower-case hex, as the upload keeps it. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

let seededKeys = 0;

export interface SeededPicture {
  id: number;
  key: string;
  /** The bytes KV holds for it: the rule's own serialisation of the file. */
  bytes: Uint8Array;
  sha256: string;
  at: string;
}

/**
 * A picture message put straight into the table and into KV, as a stored upload leaves one: the facts
 * are what `roomPictureCheck` reads of `file`, the key is one of the test's own, and KV holds the clean
 * bytes (unless `inKv` is false). No put is counted for it.
 */
export async function seedPicture(
  w: PictureWorld,
  author: string,
  file: Uint8Array,
  options: {
    at?: string;
    state?: 'ok' | 'reported' | 'kept' | 'removed';
    reports?: number;
    hiddenAt?: string | null;
    inKv?: boolean;
  } = {},
): Promise<SeededPicture> {
  const checked = roomPictureCheck(file);
  if (!checked.ok) throw new Error(`seedPicture: the file is refused (${checked.problem})`);
  seededKeys += 1;
  const key = `pic/${seededKeys.toString(16).padStart(32, '0')}`;
  const sha256 = await sha256Hex(checked.bytes);
  const at = options.at ?? w.now();
  const hiddenAt = options.hiddenAt ?? null;
  const row = await w.db
    .prepare(
      `INSERT INTO room_messages
         (at, author, text, hidden_at, hidden_by, pic_type, pic_key, pic_bytes, pic_width, pic_height, pic_frames,
          pic_sha256, pic_state, pic_reports)
       VALUES (?1, ?2, 'Picture', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       RETURNING id`,
    )
    .bind(
      at,
      author.toLowerCase(),
      hiddenAt,
      hiddenAt === null ? null : ADMIN,
      checked.type,
      key,
      checked.bytes.length,
      checked.width,
      checked.height,
      checked.frames,
      sha256,
      options.state ?? 'ok',
      options.reports ?? 0,
    )
    .first<{ id: number }>();
  if (row === null) throw new Error('seedPicture: no row');
  if (options.inKv !== false) w.kv.held.set(key, checked.bytes.slice().buffer as ArrayBuffer);
  return { id: row.id, key, bytes: checked.bytes, sha256, at };
}

/** What `console` was told while a test ran, each structured line parsed: the log lines of pictures are JSON. */
export function eventsOf(calls: unknown[][]): { event?: string; [name: string]: unknown }[] {
  const lines: { event?: string }[] = [];
  for (const call of calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as unknown;
      if (parsed !== null && typeof parsed === 'object') lines.push(parsed as { event?: string });
    } catch {
      // Not a structured line.
    }
  }
  return lines;
}
