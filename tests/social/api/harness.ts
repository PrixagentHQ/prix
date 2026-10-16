import type {
  AgentRecord,
  ApiError,
  Entitlements,
  HoldersGate,
  RateLimitRule,
  ReputationStore,
  RoomApiDeps,
  RoomHoldersApiDeps,
  RoomPictureApiDeps,
  RoomPictureBytes,
  RoomPictureStore,
  RoomStore,
  SeasonMethod,
  SocialApiDeps,
  SocialStore,
  Store,
  Tier,
  WarStanding,
  WarStandingsEngine,
} from '@prix/contracts';
import {
  entitlementsOfTier,
  OPEN_PREVIEW_ENTITLEMENTS,
  roomDailyCap,
  roomDayKey,
  roomHourKey,
  roomPicturesDailyCap,
  roomPictureViewsCap,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import { createApp } from '../../../apps/api/src/http/index.ts';
import { hashToken, newSessionToken } from '../../../apps/api/src/http/session.ts';
import { createTestVault, FakeRateLimiter } from '../../support/fakes.ts';
import { makeAgent, SEASON_1, startingPortfolio } from '../../support/fixtures.ts';
import type { MemoryStore } from '../../support/memory-store.ts';
import { createMemoryStore } from '../../support/memory-store.ts';
import { FakeSocialStore } from './fake-social-store.ts';

export const SITE = 'https://prix.test';
export const ADMIN = '0x00000000000000000000000000000000000009a1';
export const HOUSE = '0x00000000000000000000000000000000000004a1';
export const START = '2026-10-20T12:00:00.000Z';

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the API sent and then checks it against a schema
  json: any;
}

/** The war standings engine is reputation's; this fake returns one schema-valid line per entrant. */
export const fakeWarStandings: WarStandingsEngine = {
  standings(entrants, complete): WarStanding[] {
    return entrants.map(({ entrant, rows }, index) => ({
      slot: entrant.slot,
      modelId: entrant.modelId,
      provider: entrant.provider,
      label: entrant.label,
      maker: entrant.maker,
      rank: complete ? index + 1 : null,
      returnBps: entrant.stats.seasonReturnBps,
      maxDrawdownBps: entrant.stats.maxDrawdownBps,
      tradeCount: entrant.stats.tradeCount,
      days: entrant.days,
      decided: rows.filter((row) => row.status === 'decided').length,
      noDecision: rows.filter((row) => row.status === 'no_decision').length,
      skipped: rows.filter((row) => row.status === 'skipped').length,
      codes: {},
      costMicro: 0,
      neurons: 0,
      v2: { n: 0, meanMilliBps: 0, volMilliBps: 0, ratioMilli: 0, shrinkMilli: 0, scoreMilli: 0 },
      confidence: 'insufficient',
      daily: entrant.stats.daily,
    }));
  },
};

export interface Harness {
  store: MemoryStore;
  social: FakeSocialStore;
  limiter: FakeRateLimiter;
  counters: Map<string, number>;
  methods: Map<string, SeasonMethod>;
  deps: SocialApiDeps;
  entitlements: { value: Entitlements };
  setNow(iso: string): void;
  advance(ms: number): void;
  fetch(method: string, path: string, options?: RequestOptions): Promise<Reply>;
  /** A session cookie for `address`, stored as the sign-in route would store it. */
  signIn(address: string): Promise<string>;
  seedAgent(
    n: number,
    options?: { owner?: string; createdAt?: string; overrides?: Partial<AgentRecord> },
  ): Promise<AgentRecord>;
}

export interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  origin?: string | null;
  contentType?: string | null;
  /** More headers, for the attacks of a client that claims something (the room harness only). */
  extraHeaders?: Record<string, string>;
  /** More cookies beside the session's (the room harness only). */
  extraCookie?: string;
}

export function createHarness(options: { on?: boolean; groqConfigured?: boolean } = {}): Harness {
  let now = new Date(START);
  const store = createMemoryStore([SEASON_1]);
  const social = new FakeSocialStore(store);
  const limiter = new FakeRateLimiter();
  const counters = new Map<string, number>();
  const methods = new Map<string, SeasonMethod>();
  const entitlements = { value: OPEN_PREVIEW_ENTITLEMENTS };
  const deps: SocialApiDeps = {
    store,
    sim,
    scoring,
    sealer: createTestVault().sealer,
    rateLimiter: limiter,
    config: {
      siteOrigin: SITE,
      adminAddresses: [ADMIN],
      houseModel: '@cf/test/house-model',
      nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      houseOwners: [HOUSE],
    },
    now: () => new Date(now.getTime()),
    entitlements: { entitlementsFor: async () => entitlements.value },
    social,
    reputation: {
      async takeCounter(key, cap) {
        const value = counters.get(key) ?? 0;
        if (value >= cap) return false;
        counters.set(key, value + 1);
        return true;
      },
      async giveBackCounter(key) {
        counters.set(key, Math.max(0, (counters.get(key) ?? 0) - 1));
      },
      async getSeasonMethod(seasonId) {
        return { seasonId, method: methods.get(seasonId) ?? 'v1', lengthDays: 28, frozenAt: null };
      },
      // Every wallet of the harness signed in long ago, so no seasoning rule refuses it.
      async getFirstSignIn() {
        return '2020-01-01T00:00:00.000Z';
      },
    },
    warStandings: fakeWarStandings,
    groqConfigured: options.groqConfigured ?? false,
  };

  // The app the Worker serves: createApp mounts the admin routes always, the public ones while the switch is on.
  const app = createApp(deps, {
    socialAdmin: deps,
    ...((options.on ?? true) ? { social: deps } : {}),
  });

  const harness: Harness = {
    store,
    social,
    limiter,
    counters,
    methods,
    deps,
    entitlements,
    setNow(iso) {
      now = new Date(iso);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
      const origin = request.origin === undefined ? (changes ? SITE : null) : request.origin;
      if (origin !== null) headers.set('Origin', origin);
      const type = request.contentType === undefined ? (changes ? 'application/json' : null) : request.contentType;
      if (type !== null) headers.set('Content-Type', type);
      if (request.cookie !== undefined) headers.set('Cookie', `${SESSION_COOKIE}=${request.cookie}`);
      const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
      const response = await app.fetch(new Request(`${SITE}${path}`, { method, headers, body }));
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, headers: response.headers, text, json };
    },
    async signIn(address) {
      const token = newSessionToken();
      const at = now.toISOString();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      await store.putSession({ tokenHash: await hashToken(token), address, createdAt: at, expiresAt });
      return token;
    },
    async seedAgent(n, seed = {}) {
      const agent = makeAgent({ n, owner: seed.owner, createdAt: seed.createdAt, overrides: seed.overrides });
      const created = await store.createAgent(
        agent,
        SEASON_1.id,
        startingPortfolio(),
        scoring.initialStats(),
        1000,
        1000,
      );
      if (created !== 'created') throw new Error(`seedAgent: ${created}`);
      return agent;
    },
  };
  return harness;
}

export function errorOf(reply: Reply): ApiError['error'] {
  return (reply.json as ApiError).error;
}

// --- the room (Phase 6.3, docs/contracts/phase-6-room.md) ---------------------------------------------

/** The stores the room's routes stand on. A D1 test hands the real ones; a test of a fault wraps one first. */
export interface RoomParts {
  store: Store;
  reputation: ReputationStore;
  social: SocialStore;
  room: RoomStore;
  /**
   * From Phase 6.4 on the admin's hide and mute go through the pictures' store, whatever the switch of
   * pictures says (docs/contracts/phase-6-pictures.md section 19). A test that reaches either hands the
   * real one on its database; without it those two calls fail loudly.
   */
  pictures?: RoomPictureStore;
  /** The bytes of pictures. Without it: a store in memory that holds nothing. */
  bytes?: RoomPictureBytes;
}

/** A pictures' store for a harness that was given none: every call says so. */
function noPicturesStore(): RoomPictureStore {
  return new Proxy({} as RoomPictureStore, {
    get(_target, name) {
      return async () => {
        throw new Error(`createRoomHarness: no pictures store was handed in, and the route called ${String(name)}`);
      };
    },
  });
}

/** The bytes of pictures in memory, for a harness whose tests store none. */
function emptyBytes(): RoomPictureBytes {
  const held = new Map<string, Uint8Array>();
  return {
    async put(key, bytes) {
      held.set(key, bytes.slice());
    },
    async get(key) {
      return held.get(key)?.slice() ?? null;
    },
    async delete(key) {
      held.delete(key);
    },
  };
}

/** A limiter that can refuse the `write` rule from its n-th asking on: step 5 of a write asks it a second time. */
export class RoomLimiter extends FakeRateLimiter {
  /** How many askings of the `write` rule pass before it refuses. */
  writesAllowed = Number.POSITIVE_INFINITY;

  override async allow(rule: RateLimitRule, subject: string): Promise<boolean> {
    const allowed = await super.allow(rule, subject);
    if (rule !== 'write') return allowed;
    return allowed && this.writesAsked() <= this.writesAllowed;
  }

  /** How often the `write` rule was asked, for one wallet or for all. */
  writesAsked(subject?: string): number {
    return this.asked.filter(
      (ask) => ask.rule === 'write' && (subject === undefined || ask.subject.toLowerCase() === subject.toLowerCase()),
    ).length;
  }
}

export interface RoomHarness {
  deps: RoomPictureApiDeps;
  limiter: RoomLimiter;
  /** The token gate: off, nobody but an admin writes. */
  gate: { on: boolean };
  /**
   * What a wallet holds in whole $PRIX, as the token service read it, by its address in lower case; 0 for a
   * wallet that is not named. It is what `deps.holding` answers unless the harness was given a `holding` of
   * the test's own (contract revision 7: who may write is a holding, not a tier).
   */
  holdings: Map<string, number>;
  /** Every asking of a wallet's holding, with whether the route asked for the stored one only. */
  holdingReads: { address: string; cachedOnly: boolean }[];
  /**
   * The stored tier of a wallet, by its address in lower case; 0 for a wallet that is not named. No route
   * of the room asks a tier: a test sets one to show that it changes nothing.
   */
  tiers: Map<string, Tier>;
  /** Every reading of a wallet's tier, with whether the route asked for the stored one only. The room leaves it empty. */
  tierReads: { address: string; cachedOnly: boolean }[];
  /** The token's address as the token's config holds it. */
  token: { address: string | null };
  /** Every response so far: what a leak scan reads. */
  transcript: string[];
  /**
   * What the app handed to `waitUntil` of a request's execution context, in order: every request of this
   * harness carries a context that records it (docs/contracts/phase-6-pictures.md section 5).
   */
  waited: Promise<unknown>[];
  now(): string;
  setNow(iso: string): void;
  advance(ms: number): void;
  fetch(method: string, path: string, options?: RequestOptions): Promise<Reply>;
  /** A session cookie for `address`, stored as the sign-in route stores one. */
  signIn(address: string): Promise<string>;
}

/**
 * The room's routes behind `createApp` itself, as the Worker's entry mounts them: the admin's always, the
 * status, the read, `me` and the write only while the room is on. The cap of the day is read from the
 * variable's text by the contract's own `roomDailyCap`, as the entry reads it.
 */
export function createRoomHarness(
  parts: RoomParts,
  options: {
    on?: boolean;
    now?: string;
    dailyCap?: string;
    adminAddresses?: string[];
    prixAddress?: string | null;
    /**
     * A holding of the test's own in place of the harness's map: a token service's `holdingOf`, or a
     * function that fails. Every asking is recorded in `holdingReads` all the same; `gate` and `holdings`
     * do not reach it.
     */
    holding?: RoomApiDeps['holding'];
    /**
     * Phase 6.8 (docs/contracts/phase-6-holders-2.md section 2): ROOM_HOLDERS on, with the gate's read of
     * the test's own. Left out, the deps carry neither field, which counts as off.
     */
    holders?: { gate: () => Promise<HoldersGate> };
  } = {},
): RoomHarness {
  let now = new Date(options.now ?? START);
  const limiter = new RoomLimiter();
  const gate = { on: true };
  const holdings = new Map<string, number>();
  const holdingReads: RoomHarness['holdingReads'] = [];
  // As the token service's `holdingOf` answers: no gate and no tokens while the gate is off, else the
  // wallet's whole tokens.
  const holdingOf: RoomApiDeps['holding'] =
    options.holding ??
    (async (address) =>
      gate.on ? { gatingOn: true, tokens: holdings.get(address.toLowerCase()) ?? 0 } : { gatingOn: false, tokens: 0 });
  const tiers = new Map<string, Tier>();
  const tierReads: RoomHarness['tierReads'] = [];
  const token = { address: options.prixAddress ?? null };
  const transcript: string[] = [];
  const on = options.on ?? true;
  // Pictures are not enabled in this harness: it is the room of Phase 6.3, on the API of Phase 6.4. The
  // pictures' own tests have a harness of their own (tests/social/support/pictures.ts).
  const deps: RoomHoldersApiDeps = {
    ...(options.holders === undefined ? {} : { roomHoldersOn: true, holdersGate: options.holders.gate }),
    pictures: parts.pictures ?? noPicturesStore(),
    bytes: parts.bytes ?? emptyBytes(),
    picturesEnabled: false,
    picturesDailyCap: roomPicturesDailyCap(undefined),
    pictureViewsCap: roomPictureViewsCap(undefined),
    pictureLimiter: { allow: async () => true },
    random: () => 0.99,
    store: parts.store,
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
      async entitlementsFor(address, read) {
        // The port also answers for nobody (a visitor with no session): the room never asks that.
        const wallet = address ?? 'nobody';
        tierReads.push({ address: wallet, cachedOnly: read?.cachedOnly === true });
        if (!gate.on) return OPEN_PREVIEW_ENTITLEMENTS;
        return entitlementsOfTier(tiers.get(wallet.toLowerCase()) ?? 0);
      },
    },
    social: parts.social,
    reputation: parts.reputation,
    warStandings: fakeWarStandings,
    groqConfigured: false,
    room: parts.room,
    roomEnabled: on,
    roomDailyCap: roomDailyCap(options.dailyCap),
    prixAddress: async () => token.address,
    async holding(address, read) {
      holdingReads.push({ address, cachedOnly: read?.cachedOnly === true });
      return holdingOf(address, read);
    },
  };

  const app = createApp(deps, { roomAdmin: deps, ...(on ? { room: deps } : {}) });
  const waited: Promise<unknown>[] = [];
  /** A request's execution context that writes down what `waitUntil` was handed. */
  const context = {
    waitUntil: (promise: Promise<unknown>) => void waited.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };

  return {
    deps,
    limiter,
    gate,
    holdings,
    holdingReads,
    tiers,
    tierReads,
    token,
    transcript,
    waited,
    now: () => now.toISOString(),
    setNow(iso) {
      now = new Date(iso);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
    async fetch(method, path, request = {}) {
      const changes = method !== 'GET' && method !== 'HEAD';
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
      const origin = request.origin === undefined ? (changes ? SITE : null) : request.origin;
      if (origin !== null) headers.set('Origin', origin);
      const type = request.contentType === undefined ? (changes ? 'application/json' : null) : request.contentType;
      if (type !== null) headers.set('Content-Type', type);
      for (const [name, value] of Object.entries(request.extraHeaders ?? {})) headers.set(name, value);
      const cookies = [
        request.cookie === undefined ? null : `${SESSION_COOKIE}=${request.cookie}`,
        request.extraCookie ?? null,
      ]
        .filter((part): part is string => part !== null)
        .join('; ');
      if (cookies !== '') headers.set('Cookie', cookies);
      const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
      const response = await app.fetch(new Request(`${SITE}${path}`, { method, headers, body }), context as never);
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      const head = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n');
      transcript.push(`${method} ${path} -> ${response.status}\n${head}\n\n${text}`);
      return { status: response.status, headers: response.headers, text, json };
    },
    async signIn(address) {
      const sessionToken = newSessionToken();
      const at = now.toISOString();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
      await parts.store.putSession({ tokenHash: await hashToken(sessionToken), address, createdAt: at, expiresAt });
      // The sign-in route also writes the wallet's first sign-in; here it is long ago.
      await parts.store.touchUser(address, '2020-01-01T00:00:00.000Z');
      return sessionToken;
    },
  };
}

/** What a write of the room can leave behind, read from the database itself. */
export interface RoomLedger {
  /** The wallet's state-changing requests of the day, which `requireWriter` counts. */
  walletWrites: number;
  /** The day's rows for API writes, which `requireWriter` books. */
  dayRows: number;
  /** The writer's own row: its turn. */
  turn: {
    lastAt: string | null;
    day: string | null;
    count: number;
    mutedAt: string | null;
    cutAt: string | null;
  } | null;
  /** The room's count of the hour and of the day. */
  hour: number;
  day: number;
  messages: number;
}

/** Reads the ledger for `address` at `now` (its UTC day and hour) straight from the tables. */
export async function roomLedger(db: D1Database, address: string, now: string): Promise<RoomLedger> {
  const day = now.slice(0, 10);
  const hour = new Date(now).getUTCHours();
  const lower = address.toLowerCase();
  const user = await db
    .prepare('SELECT write_day, write_count FROM users WHERE lower(address) = ?1')
    .bind(lower)
    .first<{ write_day: string | null; write_count: number | null }>();
  const rows = await db.prepare('SELECT rows FROM api_writes WHERE day = ?1').bind(day).first<{ rows: number }>();
  const writer = await db
    .prepare('SELECT last_at, day, count, muted_at, cut_at FROM room_writers WHERE address = ?1')
    .bind(lower)
    .first<{
      last_at: string | null;
      day: string | null;
      count: number;
      muted_at: string | null;
      cut_at: string | null;
    }>();
  const count = async (key: string): Promise<number> =>
    (await db.prepare('SELECT n FROM counters WHERE key = ?1').bind(key).first<{ n: number }>())?.n ?? 0;
  const messages = await db.prepare('SELECT COUNT(*) AS n FROM room_messages').first<{ n: number }>();
  return {
    walletWrites: user !== null && user.write_day === day ? (user.write_count ?? 0) : 0,
    dayRows: rows?.rows ?? 0,
    turn:
      writer === null
        ? null
        : {
            lastAt: writer.last_at,
            day: writer.day,
            count: writer.count,
            mutedAt: writer.muted_at,
            cutAt: writer.cut_at,
          },
    hour: await count(roomHourKey(day, hour)),
    day: await count(roomDayKey(day)),
    messages: messages?.n ?? 0,
  };
}

/** Every statement the stores prepared on a database, whole, in order. */
export interface StatementRecord {
  db: D1Database;
  meter: {
    /** The statements, each with its white space folded. */
    log: string[];
    statements: number;
    /** Statements that are not a SELECT. */
    writes: number;
  };
  reset(): void;
}

/**
 * Wraps a database so that every statement prepared on it is kept, whole: the stores prepare a statement
 * when they send it, so this is what a request asked of the database. The statement itself is the real
 * one, so a batch runs as it does on the real database.
 */
export function recordStatements(real: D1Database): StatementRecord {
  const meter: StatementRecord['meter'] = { log: [], statements: 0, writes: 0 };
  const db = new Proxy(real, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          const text = sql.replace(/\s+/g, ' ').trim();
          meter.log.push(text);
          meter.statements += 1;
          if (/^(insert|update|delete|replace|create|drop|alter)\b/i.test(text)) meter.writes += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    db,
    meter,
    reset() {
      meter.log.length = 0;
      meter.statements = 0;
      meter.writes = 0;
    },
  };
}

/** Empties what the room's tests write, so that each starts from nothing: quicker than building the schema again. */
export async function emptyRoomTables(db: D1Database): Promise<void> {
  await db.batch(
    ['room_messages', 'room_writers', 'counters', 'api_writes', 'sessions', 'users'].map((table) =>
      db.prepare(`DELETE FROM ${table}`),
    ),
  );
}
