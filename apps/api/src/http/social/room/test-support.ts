import type {
  ApiError,
  Entitlements,
  EntitlementsReadOptions,
  HoldersGate,
  KeySealer,
  RateLimitRule,
  RoomAuthorHolder,
  RoomHoldersApiDeps,
  RoomHoldingWithTier,
  RoomMessageRecord,
  RoomStore,
  RoomTurn,
  RoomWriterRecord,
  ScoringEngine,
  SessionRecord,
  SimEngine,
  SocialStore,
  Store,
  Tier,
  WarStandingsEngine,
} from '@prix/contracts';
import {
  entitlementsOfTier,
  ROOM_MESSAGES_PER_DAY_DEFAULT,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
  ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
  ROOM_PICTURES_PER_DAY_DEFAULT,
  ROOM_WRITE_MIN_TOKENS,
  roomTurnRefusal,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@prix/contracts';
import { createApp } from '../../index.ts';
import { hashToken, newSessionToken } from '../../session.ts';
import {
  MemoryRoomPictureBytes,
  MemoryRoomPictureStore,
  RecordingContext,
  type RoomTables,
} from './test-support-pictures.ts';

/**
 * What the unit tests of the room's routes stand on: a room store in memory that keeps the rules of
 * `RoomStore` (packages/contracts/src/phase6-room.ts), the few ports of the API that the routes reach, and
 * one list, `trace`, that every fake writes to, so that a test reads the order of a request's steps and
 * what a refusal left. No D1, no Worker. Nothing here is imported by the Worker.
 */

export const SITE = 'https://prix.test';
export const SITE_HOST = 'prix.test';
export const START = '2026-10-20T12:00:00.000Z';
export const DAY = '2026-10-20';
/** As a Worker variable may hold it: the routes compare in lower case. */
export const ADMIN_AS_CONFIGURED = '0x00000000000000000000000000000000000009A1';
export const ADMIN = ADMIN_AS_CONFIGURED.toLowerCase();
export const HOLDER = '0x00000000000000000000000000000000000000b1';
export const OTHER = '0x00000000000000000000000000000000000000c2';
export const THIRD = '0x00000000000000000000000000000000000000d3';
/** A wallet the token service has no holding for. */
export const STRANGER = '0x00000000000000000000000000000000000000e4';
/** The one address a message may hold in these tests. Not a real token. */
export const TOKEN = '0x1f2e3d4c5b6a79880123456789abcdef01234567';

/** `RoomStore` in memory, by the rules its interface states. */
export class MemoryRoomStore implements RoomStore, RoomTables {
  readonly messages: RoomMessageRecord[] = [];
  readonly writers = new Map<string, RoomWriterRecord>();
  /** `room_writers.first_at` (Phase 6.4): the time of a writer's first stored message that still counts. */
  readonly firstAt = new Map<string, string>();
  /** The ids of picture messages (Phase 6.4): `listNewest` leaves them out. */
  readonly pictureIds = new Set<number>();
  /**
   * What a test sets to make one call fail, or to make something change between the look of step 4 and
   * what is taken after it: `beforeTurn` runs when the turn is asked for, before the row is judged.
   */
  failTurn = false;
  failPut = false;
  beforeTurn: (() => void) | null = null;
  /** Runs once a message was looked up: what the prune job may do between an admin's look and its write. */
  afterGetMessage: (() => void) | null = null;
  /**
   * Phase 6.8: the `token_holders` rows the public read joins by author (section 2.1 of the holders' second
   * wave). A message whose author has no row here carries `authorHolder: null`.
   */
  readonly tokenRows = new Map<string, RoomAuthorHolder>();
  private nextId = 1;

  /** `counters` is the table of Phase 2 that the room's two counts live in: `getCounts` reads it and takes nothing. */
  constructor(
    private readonly trace: string[],
    private readonly counters: ReadonlyMap<string, number>,
  ) {}

  /** A message put straight into the table, for a read's fixture. */
  seed(author: string, text: string, at: string, hiddenAt: string | null = null): RoomMessageRecord {
    const message: RoomMessageRecord = { id: this.nextId, at, author, text, hiddenAt, hiddenBy: null };
    this.nextId += 1;
    this.messages.push(message);
    return message;
  }

  setWriter(address: string, fields: Partial<RoomWriterRecord>): void {
    const row = this.writers.get(address) ?? {
      address,
      lastAt: null,
      day: null,
      count: 0,
      mutedAt: null,
      mutedBy: null,
      cutAt: null,
    };
    this.writers.set(address, { ...row, ...fields });
  }

  /** From Phase 6.4 on it leaves picture messages out: it is the read of a room whose pictures are not enabled. */
  async listNewest(limit: number, scan: number): Promise<RoomMessageRecord[]> {
    this.trace.push(`room.listNewest:${limit}:${scan}`);
    return this.visible(limit, scan, true);
  }

  /** The messages the public may see among the newest `scan` ids, newest first; with `textOnly`, no picture message. */
  visible(limit: number, scan: number, textOnly = false): RoomMessageRecord[] {
    const newest = this.messages.reduce((most, message) => Math.max(most, message.id), 0);
    return this.messages
      .filter((message) => message.id > newest - scan)
      .filter((message) => !textOnly || !this.pictureIds.has(message.id))
      .filter((message) => {
        const writer = this.writers.get(message.author);
        if (message.hiddenAt !== null) return false;
        if (writer === undefined) return true;
        return writer.mutedAt === null && (writer.cutAt === null || message.at > writer.cutAt);
      })
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((message) => {
        const row = this.tokenRows.get(message.author);
        return { ...message, authorHolder: row === undefined ? null : { ...row } };
      });
  }

  async listAllMessages(
    before: number | null,
    limit: number,
  ): Promise<(RoomMessageRecord & { muted: boolean; cut: boolean })[]> {
    this.trace.push(`room.listAllMessages:${before}:${limit}`);
    return this.messages
      .filter((message) => before === null || message.id < before)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((message) => {
        const writer = this.writers.get(message.author);
        const cutAt = writer?.cutAt ?? null;
        return {
          ...message,
          muted: (writer?.mutedAt ?? null) !== null,
          cut: cutAt !== null && message.at <= cutAt,
        };
      });
  }

  async getMessage(id: number): Promise<RoomMessageRecord | null> {
    this.trace.push('room.getMessage');
    const message = this.messages.find((entry) => entry.id === id);
    const found = message === undefined ? null : { ...message };
    this.afterGetMessage?.();
    return found;
  }

  async getWriter(address: string): Promise<RoomWriterRecord | null> {
    this.trace.push('room.getWriter');
    const row = this.writers.get(address);
    return row === undefined ? null : { ...row };
  }

  async getCounts(hourKey: string, dayKey: string): Promise<{ hour: number; day: number }> {
    this.trace.push(`room.getCounts:${hourKey}:${dayKey}`);
    return { hour: this.counters.get(hourKey) ?? 0, day: this.counters.get(dayKey) ?? 0 };
  }

  /** Every `dayCap` the routes passed, in order (Phase 6.8): undefined when a route left it out. */
  readonly dayCaps: (number | undefined)[] = [];

  async takeTurn(address: string, now: string, day: string, dayCap?: number): Promise<RoomTurn> {
    this.trace.push('room.takeTurn');
    this.dayCaps.push(dayCap);
    if (this.failTurn) throw new Error('takeTurn failed');
    this.beforeTurn?.();
    const cap = dayCap ?? ROOM_MESSAGES_PER_WALLET_PER_DAY;
    const row = this.writers.get(address) ?? null;
    const why = roomTurnRefusal(row, now, day, cap);
    if (why !== null) return { ok: false, why };
    const count = (row !== null && row.day === day ? row.count : 0) + 1;
    this.setWriter(address, { lastAt: now, day, count });
    return { ok: true, left: Math.max(0, cap - count) };
  }

  async putMessage(author: string, text: string, now: string): Promise<RoomMessageRecord> {
    this.trace.push('room.putMessage');
    if (this.failPut) throw new Error('putMessage failed');
    // Phase 6.4: the same batch sets the writer's `first_at` where it is null.
    if (!this.firstAt.has(author)) this.firstAt.set(author, now);
    return { ...this.seed(author, text, now) };
  }

  async hideMessage(id: number, by: string, now: string): Promise<'hidden' | 'already' | 'none'> {
    this.trace.push('room.hideMessage');
    const message = this.messages.find((entry) => entry.id === id);
    if (message === undefined) return 'none';
    if (message.hiddenAt !== null) return 'already';
    message.hiddenAt = now;
    message.hiddenBy = by;
    return 'hidden';
  }

  async muteWriter(address: string, by: string, now: string): Promise<boolean> {
    this.trace.push('room.muteWriter');
    if ((this.writers.get(address)?.mutedAt ?? null) !== null) return false;
    this.setWriter(address, { mutedAt: now, mutedBy: by, cutAt: now });
    return true;
  }

  /**
   * As the store's one statement does (the contract's comment of `unmuteWriter`, revision 5): the mute is
   * lifted and the cut moves forward to the time of the writer's newest message when that is later. It
   * never moves back, and a writer that was not muted keeps its row as it is.
   */
  async unmuteWriter(address: string): Promise<boolean> {
    this.trace.push('room.unmuteWriter');
    const row = this.writers.get(address);
    if (row === undefined || row.mutedAt === null) return false;
    const cut = row.cutAt ?? row.mutedAt;
    const newest = this.messages
      .filter((message) => message.author === address)
      .reduce((latest, message) => (message.at > latest ? message.at : latest), cut);
    this.setWriter(address, { mutedAt: null, mutedBy: null, cutAt: newest });
    return true;
  }

  async pruneMessages(): Promise<number> {
    return 0;
  }
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  /** The body as it came, for an answer of bytes. */
  raw: Uint8Array;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks it against a schema
  json: any;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  /**
   * A body of bytes, the upload's: sent with the upload's content type, `Sec-Fetch-Site: same-origin` and
   * its own length, unless `headers` says otherwise.
   */
  bytes?: Uint8Array;
  /** A body that arrives in pieces, in place of `bytes`: a test sets the upload's headers itself. */
  stream?: ReadableStream<Uint8Array>;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
  /** Headers set last, as they are; a null takes a header out. */
  headers?: Record<string, string | null>;
  /** The address the request comes from. */
  ip?: string;
  /** False: the app is fetched with no execution context, as it was before Phase 6.4. */
  context?: boolean;
}

export interface HarnessOptions {
  /** Whether the entry hands `room` to the app at all. Default true. */
  given?: boolean;
  roomEnabled?: boolean;
  roomDailyCap?: number;
  prixAddress?: string | null;
  /** `picturesEnabled` (Phase 6.4). Default false: the room as Phase 6.3 answers it. */
  pictures?: boolean;
  /** Whether the entry hands `roomPictures` to the app. Default: as `given`. */
  picturesGiven?: boolean;
  picturesDailyCap?: number;
  pictureViewsCap?: number;
  /**
   * Phase 6.8: `roomHoldersOn` as the entry gives it. Undefined: the deps carry neither `roomHoldersOn` nor
   * `holdersGate`, as every harness before this phase built them.
   */
  holders?: boolean;
  /** With `holders` set: false leaves `holdersGate` out of the deps. Default true. */
  holdersGate?: boolean;
}

export interface Harness {
  /** Every call of a fake, in the order it was made. */
  trace: string[];
  room: MemoryRoomStore;
  pictures: MemoryRoomPictureStore;
  bytes: MemoryRoomPictureBytes;
  /** The execution context every request is fetched with, unless a request says `context: false`. */
  ctx: RecordingContext;
  /** The `picture` rule of the limiter: whether it refuses, and every subject it was asked for. */
  pictureLimiter: { denied: boolean; asked: string[] };
  /** What `deps.random` answers: 0.99 draws no sample of a view, 0 draws one. `asked` counts the draws. */
  draw: { value: number; asked: number };
  /** The request the app was fetched with last: its `bodyUsed` says whether a route read the body. */
  last: { request: Request | null };
  counters: Map<string, number>;
  /** What `requireWriter` spent: the wallets' writes of the day and the day's rows. */
  spent: { walletWrites: number; rows: number };
  /** The limits a test lowers to make `requireWriter` refuse. */
  limits: { walletWritesLeft: number; rowsLeft: number };
  /** The rules the limiter refuses, and how many more times it allows `write` before it refuses (null: always). */
  limiter: { denied: Set<RateLimitRule>; writesAllowed: number | null };
  /**
   * The port of the tiers. No route of the room asks it (contract revision 7), so `asked` stays empty; what
   * it would answer is tier 0, the tier that never wrote.
   */
  entitlements: { value: Entitlements; asked: (EntitlementsReadOptions | undefined)[] };
  /**
   * What the token service's `holdingOf` answers, as `deps.holding` hands it on: the gate, and the whole
   * tokens of each wallet in lower case (a wallet not named holds none). Each is answered as it is set and
   * neither changes the other, so that a test sees which of the two a route judged. `asked` is every call
   * with its address and its options; `fail` makes the read throw.
   */
  holding: {
    gatingOn: boolean;
    tokens: Map<string, number>;
    /** Phase 6.8: the tier `holdingOf` answers beside the tokens (a wallet not named is at tier 0). */
    tiers: Map<string, Tier>;
    asked: { address: string; options: EntitlementsReadOptions | undefined }[];
    fail: boolean;
  };
  /** Phase 6.8: what `holdersGate` answers, and how many times it was asked. */
  gate: HoldersGate & { asked: number };
  token: { address: string | null };
  /**
   * What a test sets to make a give-back of a count fail, the keys whose take fails, and `spend`: the
   * store's booking of the day's rows throws, which is a fault of `spendWrite` and no refusal of it.
   */
  faults: { giveBack: boolean; take: Set<string>; spend: boolean };
  /**
   * Every reading of the clock, in order; each is also the step `clock` of the trace. A test sets `stepMs`
   * to move the clock on after every reading, so that two readings never name the same instant.
   */
  clock: { reads: string[]; stepMs: number };
  setNow(iso: string): void;
  fetch(method: string, path: string, options?: RequestOptions): Promise<Reply>;
  /** A session cookie for `address`, stored as the sign-in route stores it. */
  signIn(address: string): Promise<string>;
  /** What the fakes hold that a refusal could have changed, as one value to compare. */
  ledger(): unknown;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  let now = new Date(START);
  const trace: string[] = [];
  const counters = new Map<string, number>();
  const room = new MemoryRoomStore(trace, counters);
  const pictures = new MemoryRoomPictureStore(trace, room, counters);
  const bytes = new MemoryRoomPictureBytes(trace);
  const ctx = new RecordingContext(trace);
  const pictureLimiter: Harness['pictureLimiter'] = { denied: false, asked: [] };
  const draw: Harness['draw'] = { value: 0.99, asked: 0 };
  const last: Harness['last'] = { request: null };
  const spent = { walletWrites: 0, rows: 0 };
  const limits = { walletWritesLeft: Number.POSITIVE_INFINITY, rowsLeft: Number.POSITIVE_INFINITY };
  const limiter: Harness['limiter'] = { denied: new Set<RateLimitRule>(), writesAllowed: null };
  const entitlements: Harness['entitlements'] = { value: entitlementsOfTier(0), asked: [] };
  const holding: Harness['holding'] = {
    gatingOn: true,
    tokens: new Map([HOLDER, OTHER, THIRD].map((address) => [address, ROOM_WRITE_MIN_TOKENS])),
    tiers: new Map(),
    asked: [],
    fail: false,
  };
  const gate: Harness['gate'] = { gatingOn: true, token: TOKEN, asked: 0 };
  const token = { address: options.prixAddress === undefined ? TOKEN : options.prixAddress };
  const faults = { giveBack: false, take: new Set<string>(), spend: false };
  const clock: Harness['clock'] = { reads: [], stepMs: 0 };
  const sessions = new Map<string, SessionRecord>();

  // The four methods of the store that a request of the room reaches, through the guard.
  const store: Pick<Store, 'getSession' | 'putSession' | 'spendWalletWrite' | 'spendApiWrites'> = {
    async getSession(tokenHash) {
      trace.push('store.getSession');
      return sessions.get(tokenHash) ?? null;
    },
    async putSession(session) {
      sessions.set(session.tokenHash, session);
    },
    async spendWalletWrite() {
      trace.push('store.spendWalletWrite');
      if (limits.walletWritesLeft <= 0) return false;
      limits.walletWritesLeft -= 1;
      spent.walletWrites += 1;
      return true;
    },
    async spendApiWrites(_day, rows) {
      trace.push(`store.spendApiWrites:${rows}`);
      if (faults.spend) throw new Error('spendApiWrites failed');
      if (limits.rowsLeft < rows) return false;
      limits.rowsLeft -= rows;
      spent.rows += rows;
      return true;
    },
  };

  const deps: RoomHoldersApiDeps = {
    store: store as Store,
    // No route of the room reaches these five ports.
    sim: {} as SimEngine,
    scoring: {} as ScoringEngine,
    sealer: {} as KeySealer,
    social: {} as SocialStore,
    warStandings: {} as WarStandingsEngine,
    groqConfigured: false,
    rateLimiter: {
      async allow(rule, subject) {
        trace.push(`limiter:${rule}:${subject}`);
        if (limiter.denied.has(rule)) return false;
        if (rule === 'write' && limiter.writesAllowed !== null) {
          if (limiter.writesAllowed <= 0) return false;
          limiter.writesAllowed -= 1;
        }
        return true;
      },
    },
    config: {
      siteOrigin: SITE,
      adminAddresses: [ADMIN_AS_CONFIGURED],
      houseModel: '@cf/test/house-model',
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: [],
    },
    now: () => {
      const reading = new Date(now.getTime());
      trace.push('clock');
      clock.reads.push(reading.toISOString());
      now = new Date(now.getTime() + clock.stepMs);
      return reading;
    },
    entitlements: {
      async entitlementsFor(_address, read) {
        trace.push(`entitlements:${read?.cachedOnly === true ? 'cachedOnly' : 'full'}`);
        entitlements.asked.push(read);
        return entitlements.value;
      },
    },
    reputation: {
      async takeCounter(key, cap) {
        trace.push(`counter.take:${key}`);
        if (faults.take.has(key)) throw new Error('takeCounter failed');
        const value = counters.get(key) ?? 0;
        if (value >= cap) return false;
        counters.set(key, value + 1);
        return true;
      },
      async giveBackCounter(key) {
        trace.push(`counter.back:${key}`);
        if (faults.giveBack) throw new Error(`giveBackCounter failed for ${key}`);
        counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1));
      },
      async getSeasonMethod(seasonId) {
        return { seasonId, method: 'v1', lengthDays: 28, frozenAt: null };
      },
      async getFirstSignIn() {
        return '2020-01-01T00:00:00.000Z';
      },
    },
    room,
    roomEnabled: options.roomEnabled ?? true,
    roomDailyCap: options.roomDailyCap ?? ROOM_MESSAGES_PER_DAY_DEFAULT,
    async prixAddress() {
      trace.push('prixAddress');
      return token.address;
    },
    async holding(address, read): Promise<RoomHoldingWithTier> {
      trace.push(`holding:${read?.cachedOnly === true ? 'cachedOnly' : 'full'}`);
      holding.asked.push({ address, options: read });
      if (holding.fail) throw new Error('holding failed');
      const answer: RoomHoldingWithTier = { gatingOn: holding.gatingOn, tokens: holding.tokens.get(address) ?? 0 };
      const tier = holding.tiers.get(address);
      return tier === undefined ? answer : { ...answer, tier };
    },
    ...(options.holders === undefined
      ? {}
      : {
          roomHoldersOn: options.holders,
          ...(options.holdersGate === false
            ? {}
            : {
                async holdersGate(): Promise<HoldersGate> {
                  trace.push('holdersGate');
                  gate.asked += 1;
                  return { gatingOn: gate.gatingOn, token: gate.token };
                },
              }),
        }),
    pictures,
    bytes,
    picturesEnabled: options.pictures ?? false,
    picturesDailyCap: options.picturesDailyCap ?? ROOM_PICTURES_PER_DAY_DEFAULT,
    pictureViewsCap: options.pictureViewsCap ?? ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
    pictureLimiter: {
      async allow(subject) {
        trace.push(`limiter:picture:${subject}`);
        pictureLimiter.asked.push(subject);
        return !pictureLimiter.denied;
      },
    },
    random() {
      trace.push('random');
      draw.asked += 1;
      return draw.value;
    },
  };

  // As the entry does: the admin's routes always, the others when it hands `room` and `roomPictures` over.
  const given = options.given ?? true;
  const app = createApp(deps, {
    roomAdmin: deps,
    roomPicturesAdmin: deps,
    ...(given ? { room: deps } : {}),
    ...((options.picturesGiven ?? given) ? { roomPictures: deps } : {}),
  });

  return {
    trace,
    room,
    pictures,
    bytes,
    ctx,
    pictureLimiter,
    draw,
    last,
    counters,
    spent,
    limits,
    limiter,
    entitlements,
    holding,
    gate,
    token,
    faults,
    clock,
    setNow(iso) {
      now = new Date(iso);
    },
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': request.ip ?? '203.0.113.9' });
      const origin = request.origin === undefined ? (changes ? SITE : null) : request.origin;
      if (origin !== null) headers.set('Origin', origin);
      const usual =
        request.bytes !== undefined ? ROOM_PICTURE_UPLOAD_CONTENT_TYPE : changes ? 'application/json' : null;
      const type = request.contentType === undefined ? usual : request.contentType;
      if (type !== null) headers.set('Content-Type', type);
      if (request.bytes !== undefined) {
        headers.set('Sec-Fetch-Site', 'same-origin');
        headers.set('Content-Length', String(request.bytes.length));
      }
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
      const body =
        request.stream ??
        request.bytes ??
        request.rawBody ??
        (request.body === undefined ? undefined : JSON.stringify(request.body));
      const init: RequestInit & { duplex?: 'half' } = { method, headers, body };
      if (request.stream !== undefined) init.duplex = 'half';
      const sent = new Request(`${SITE}${path}`, init);
      last.request = sent;
      const response = await (request.context === false ? app.fetch(sent) : app.fetch(sent, ctx));
      const raw = new Uint8Array(await response.arrayBuffer());
      const text = new TextDecoder().decode(raw);
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, headers: response.headers, text, raw, json };
    },
    async signIn(address) {
      const sessionToken = newSessionToken();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      const tokenHash = await hashToken(sessionToken);
      sessions.set(tokenHash, { tokenHash, address, createdAt: now.toISOString(), expiresAt });
      return sessionToken;
    },
    ledger() {
      return {
        spent: { ...spent },
        counters: [...counters.entries()].sort(),
        writers: [...room.writers.values()].map((row) => ({ ...row })),
        messages: room.messages.map((message) => ({ ...message })),
        firstAt: [...room.firstAt.entries()].sort(),
        pictures: pictures.ledger(),
        bytes: bytes.ledger(),
      };
    },
  };
}

/** Waits until every promise the context was handed has settled: what Cloudflare does after the answer. */
export async function settled(h: Harness): Promise<void> {
  await Promise.all(h.ctx.waited);
}

export function errorOf(reply: Reply): ApiError['error'] {
  return (reply.json as ApiError).error;
}

/** The steps of a request after the entry's own `read` rule, without the session reads and the readings of the clock. */
export function stepsOf(trace: readonly string[]): string[] {
  return trace.filter((step) => !step.startsWith('limiter:read:') && step !== 'store.getSession' && step !== 'clock');
}
