import { env as baseEnv } from 'cloudflare:workers';
import type {
  EntitlementsReadOptions,
  RoomPictureApiDeps,
  RoomPictureSweepJobDeps,
  SocialJobOutcome,
  TokenService,
} from '@prix/contracts';
import {
  ROOM_DAILY_CAP_VAR,
  ROOM_ENABLED_VAR,
  ROOM_KEEP,
  ROOM_MESSAGES_PER_DAY_DEFAULT,
  ROOM_MESSAGES_PER_DAY_MAX,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PICTURE_RATE_BINDING,
  ROOM_PICTURE_RATE_NAMESPACE,
  ROOM_PICTURE_RATE_PER_MINUTE,
  ROOM_PICTURE_SWEEP_JOB,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
  ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
  ROOM_PICTURE_VIEWS_PER_DAY_MAX,
  ROOM_PICTURE_VIEWS_VAR,
  ROOM_PICTURES_ADMIN_PATH,
  ROOM_PICTURES_DAILY_CAP_VAR,
  ROOM_PICTURES_ENABLED_VAR,
  ROOM_PICTURES_KV_BINDING,
  ROOM_PICTURES_PATH,
  ROOM_PICTURES_PER_DAY_DEFAULT,
  ROOM_PICTURES_PER_DAY_MAX,
  roomDailyCapBesidePictures,
  roomPictureCheck,
  SESSION_COOKIE,
  SOCIAL_CRON,
} from '@prix/contracts';
import { resetTokenMemory } from '@prix/runtime/token/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppExtras } from './http/index.ts';
import { hashToken, newSessionToken } from './http/session.ts';
import worker, { runCron } from './index.ts';
import { createPictureLimiter } from './rate-limit.ts';
import { createD1Store } from './store/index.ts';
import { createRoomStore } from './store/room.ts';
import { createRoomPictureStore } from './store/room-pictures.ts';

/**
 * The room in the Worker entry (docs/contracts/phase-6-room.md sections 6 and 8), through what the entry
 * exports, its `fetch`: the two cache keys, the HEAD rule, a percent spelling of a path, one read at a
 * time with no `put` of a read that a write overtook, and the drop of the read's key after a write.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 *
 * Whether a request reached the app is read from what the app cannot do without: every request it takes
 * passes the `read` rule of the limiter, and every read of the room asks D1. Both are counted here.
 */
const ORIGIN = 'https://prix.test';
const ADMIN = '0x00000000000000000000000000000000000009a1';
const SOMEONE = '0x00000000000000000000000000000000000005b2';
const ROOM = '/api/social/room';
const STATUS = '/api/social/room/status';
const CACHED_READS = [ROOM, STATUS] as const;
const MARKER = 'from-the-cache';

const db = (baseEnv as unknown as { DB: D1Database }).DB;

/**
 * The token service the entry builds is the runtime's own, with one seam for these tests: while a test
 * hands in a `holdingOf` of its own, the service answers a holding with it and reads no chain. Nothing
 * else of the service changes, and with no `holdingOf` handed in it is the runtime's service whole.
 */
const own = vi.hoisted(() => ({ holdingOf: null as TokenService['holdingOf'] | null }));
vi.mock('@prix/runtime/token/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prix/runtime/token/service')>();
  return {
    ...actual,
    createTokenService: (deps: Parameters<typeof actual.createTokenService>[0]): TokenService => {
      const service = actual.createTokenService(deps);
      return {
        ...service,
        holdingOf: (address, options) => (own.holdingOf ?? service.holdingOf)(address, options),
      };
    },
  };
});

/**
 * Phase 6.4. The app the entry builds is the API's own, with one seam for these tests: every call of its
 * `fetch` is written down with the context it was handed and the extras it was built from, and a test may
 * answer for it (`app.answer`) to see what the ENTRY does with an answer, whatever route makes it.
 * With no `answer` it is the API's app whole.
 */
type PictureExtras = AppExtras & { roomPictures?: RoomPictureApiDeps; roomPicturesAdmin?: RoomPictureApiDeps };
const app = vi.hoisted(() => ({
  contexts: [] as unknown[],
  extras: null as unknown,
  answer: null as ((request: Request) => Response | null) | null,
}));
vi.mock('./http/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http/index.ts')>();
  return {
    ...actual,
    createApp: (...args: Parameters<typeof actual.createApp>) => {
      app.extras = args[1];
      const real = actual.createApp(...args) as { fetch(request: Request, ctx?: unknown): Promise<Response> };
      return {
        fetch: async (request: Request, ctx?: unknown): Promise<Response> => {
          app.contexts.push(ctx);
          return app.answer?.(request) ?? real.fetch(request, ctx);
        },
      };
    },
  };
});

/**
 * Phase 6.4. The sweep job the entry puts in the social step is the runtime's own
 * (`createRoomPictureSweepJob`), with one seam: what it was built from is written down, its runs are
 * counted, and a test may answer for a run (`sweep.outcome`) to see where the ENTRY put it in the list.
 * While the runtime has no such job yet, a run that no test answers for is idle.
 */
const sweep = vi.hoisted(() => ({
  outcome: null as SocialJobOutcome | null,
  runs: 0,
  deps: null as RoomPictureSweepJobDeps | null,
}));
vi.mock('@prix/runtime/social/index', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  type Job = { name: string; run(now: Date): Promise<SocialJobOutcome> };
  const real = actual.createRoomPictureSweepJob as ((deps: RoomPictureSweepJobDeps) => Job) | undefined;
  return {
    ...actual,
    // Phase 6.7: the entry reads these two by name; a mock throws on a name it does not define, so each is
    // named here with what the runtime exports (undefined until engine-runtime's poll-tally.ts lands).
    createPollTallyJob: actual.createPollTallyJob,
    tallyPoll: actual.tallyPoll,
    createRoomPictureSweepJob: (deps: RoomPictureSweepJobDeps): Job => {
      sweep.deps = deps;
      const job = real?.(deps);
      return {
        name: 'room_picture_sweep',
        run: async (now: Date) => {
          sweep.runs += 1;
          if (sweep.outcome !== null) return sweep.outcome;
          return job === undefined ? 'idle' : job.run(now);
        },
      };
    },
  };
});

/** What the app asked for while it answered: limiter calls and D1 statements. */
interface Reached {
  limiter: number;
  statements: number;
  /** How often the public read's one statement was prepared: once for every run of `listNewest`. */
  reads: number;
}

/** Text that only the statement of `listNewest` holds: its edge, the newest id less the scan. */
const LIST_NEWEST_MARK = 'COALESCE(MAX(id), 0)';

/** A fresh env each time, so the entry builds its wiring again; with the room on unless a test says otherwise. */
function envWith(extra: Record<string, unknown> = {}): { env: Record<string, unknown>; reached: Reached } {
  const reached: Reached = { limiter: 0, statements: 0, reads: 0 };
  const counted = {
    limit: async () => {
      reached.limiter += 1;
      return { success: true };
    },
  };
  // A test's own database is watched as the plain one is.
  const { DB: given, ...rest } = extra;
  const watchedDb = new Proxy((given as D1Database | undefined) ?? db, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          reached.statements += 1;
          if (sql.includes(LIST_NEWEST_MARK)) reached.reads += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const env = {
    ...(baseEnv as unknown as Record<string, unknown>),
    DB: watchedDb,
    SITE_ORIGIN: ORIGIN,
    ADMIN_ADDRESSES: ADMIN,
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET: btoa('n'.repeat(32)),
    RATE_SIGN_IN: counted,
    RATE_WRITE: counted,
    RATE_READ: counted,
    SOCIAL_ENABLED: 'true',
    [ROOM_ENABLED_VAR]: 'true',
    [ROOM_DAILY_CAP_VAR]: '400',
    ...rest,
  };
  return { env, reached };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

async function call(env: Record<string, unknown>, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  return response;
}

async function plant(path: string): Promise<void> {
  await caches.default.put(
    `${ORIGIN}${path}`,
    new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }),
  );
}

/** What this location holds under the key that is `path` alone, as text, or null. */
async function stored(path: string): Promise<string | null> {
  const hit = await caches.default.match(`${ORIGIN}${path}`);
  return hit === undefined ? null : hit.text();
}

/** A session cookie for `address`, stored as the sign-in route stores one. */
async function sessionFor(address: string): Promise<string> {
  const token = newSessionToken();
  const now = Date.now();
  await createD1Store(db).putSession({
    tokenHash: await hashToken(token),
    address,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  });
  return `${SESSION_COOKIE}=${token}`;
}

/** A write as the site sends one: its origin and the JSON media type, which `assertFromSite` asks of every write. */
function write(method: string, cookie: string | null, body?: unknown): RequestInit {
  const headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (cookie !== null) headers.Cookie = cookie;
  return body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
}

beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM room_messages'), db.prepare('DELETE FROM room_writers')]);
  for (const path of [...CACHED_READS, `${ROOM}/me`, '/api/social/admin/room']) {
    await caches.default.delete(`${ORIGIN}${path}`);
  }
});

/** Status, headers and body of an answer, so that two answers can be compared byte for byte. */
async function seen(response: Response): Promise<{ status: number; headers: string[]; body: string }> {
  return {
    status: response.status,
    headers: [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).sort(),
    body: await response.text(),
  };
}

describe('the switch: SOCIAL_ENABLED and ROOM_ENABLED, both', () => {
  const UNKNOWN = '/api/no-such-path';

  for (const [social, room] of [
    ['true', 'true'],
    [' TRUE ', ' True '],
  ]) {
    it(`mounts the room's read and its status while they are ${JSON.stringify([social, room])}`, async () => {
      const { env } = envWith({ SOCIAL_ENABLED: social, [ROOM_ENABLED_VAR]: room });

      expect(await (await call(env, STATUS)).json()).toEqual({ on: true });
      expect((await call(env, ROOM)).status).toBe(200);
    });
  }

  for (const [social, room] of [
    ['true', 'false'],
    ['true', undefined],
    ['true', 'yes'],
    ['true', '1'],
    ['false', 'true'],
    [undefined, 'true'],
  ]) {
    it(`answers the room's four routes exactly as an unknown path while they are ${JSON.stringify([social, room])}`, async () => {
      const { env } = envWith({ SOCIAL_ENABLED: social, [ROOM_ENABLED_VAR]: room });
      const someone = await sessionFor(SOMEONE);
      const unknown = await seen(await call(env, UNKNOWN));
      expect(unknown.status).toBe(404);

      expect(await seen(await call(env, STATUS)), STATUS).toEqual(unknown);
      expect(await seen(await call(env, ROOM)), ROOM).toEqual(unknown);
      expect(await seen(await call(env, `${ROOM}/me`, { headers: { Cookie: someone } })), 'me').toEqual(unknown);
      const unknownWrite = await seen(await call(env, UNKNOWN, write('POST', someone, { text: 'hello' })));
      expect(await seen(await call(env, ROOM, write('POST', someone, { text: 'hello' }))), 'write').toEqual(
        unknownWrite,
      );
    });
  }

  it("mounts the admin's routes whatever the switch says, and answers anyone else as an unknown path", async () => {
    const { env } = envWith({ [ROOM_ENABLED_VAR]: 'false' });
    const admin = await sessionFor(ADMIN);
    const someone = await sessionFor(SOMEONE);
    const message = await createRoomStore(db).putMessage(SOMEONE, 'a line', new Date().toISOString());

    const read = await call(env, '/api/social/admin/room', { headers: { Cookie: admin } });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { messages: { id: number }[] }).messages.map(({ id }) => id)).toEqual([message.id]);
    const hide = await call(env, `/api/social/admin/room/messages/${message.id}`, write('DELETE', admin));
    expect(hide.status).toBe(204);
    expect((await createRoomStore(db).getMessage(message.id))?.hiddenAt).not.toBeNull();

    const unknown = await seen(await call(env, UNKNOWN, { headers: { Cookie: someone } }));
    expect(await seen(await call(env, '/api/social/admin/room', { headers: { Cookie: someone } }))).toEqual(unknown);
  });
});

describe('the one address a message may hold', () => {
  const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044';
  const setToken = (address: string | null) =>
    db.prepare('UPDATE token_config SET token_address = ?1 WHERE id = 1').bind(address).run();

  // The token service keeps the configuration in the isolate's memory for a while: each test reads it anew.
  beforeEach(() => {
    resetTokenMemory();
  });
  afterEach(async () => {
    await setToken(null);
    resetTokenMemory();
  });

  it('is null in the read while the token has no address', async () => {
    const { env } = envWith();

    expect(((await (await call(env, ROOM)).json()) as { prixAddress: unknown }).prixAddress).toBeNull();
  });

  it("is the token's own configuration, in lower case, and not a value of the request", async () => {
    await setToken(TOKEN);
    const { env } = envWith();

    const response = await call(env, `${ROOM}?prixAddress=0x00000000000000000000000000000000000000ff`);

    expect(((await response.json()) as { prixAddress: unknown }).prixAddress).toBe(TOKEN);
  });
});

describe('who may write: a holding of one whole $PRIX, read by the token service', () => {
  const HOLDER = '0x00000000000000000000000000000000000007c3';
  /** Every question the entry put to the token service, with the options it handed on. */
  const asked: { address: string; options: EntitlementsReadOptions | undefined }[] = [];

  beforeEach(() => {
    asked.length = 0;
    // A token service of the test's own: the gate is on, HOLDER holds one whole token, anyone else none.
    own.holdingOf = async (address, options) => {
      asked.push({ address, options });
      return { gatingOn: true, tokens: address === HOLDER ? 1 : 0 };
    };
  });
  afterEach(() => {
    own.holdingOf = null;
  });

  it('answers `me` with `yes` for a wallet with one token and with `not_holder` for a wallet with none', async () => {
    const { env } = envWith();
    const holder = await sessionFor(HOLDER);
    const someone = await sessionFor(SOMEONE);

    const one = await call(env, `${ROOM}/me`, { headers: { Cookie: holder } });
    const none = await call(env, `${ROOM}/me`, { headers: { Cookie: someone } });

    expect([one.status, none.status]).toEqual([200, 200]);
    expect(await one.json()).toEqual({ write: 'yes', left: ROOM_MESSAGES_PER_WALLET_PER_DAY });
    expect(await none.json()).toEqual({ write: 'not_holder', left: 0 });
    // The holding is the token service's answer for the session's own address, asked in full.
    expect(asked).toEqual([
      { address: HOLDER, options: undefined },
      { address: SOMEONE, options: undefined },
    ]);
  });

  it("hands the write's `cachedOnly` on to the token service, so that a write reads no chain", async () => {
    const { env } = envWith();
    const holder = await sessionFor(HOLDER);
    const someone = await sessionFor(SOMEONE);

    const written = await call(env, ROOM, write('POST', holder, { text: 'the league looks good today' }));
    const refused = await call(env, ROOM, write('POST', someone, { text: 'the league looks good today' }));

    expect(written.status).toBe(201);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { field: string } }).error.field).toBe('not_holder');
    expect(asked).toEqual([
      { address: HOLDER, options: { cachedOnly: true } },
      { address: SOMEONE, options: { cachedOnly: true } },
    ]);
  });
});

describe("the room's prune in the social step", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs whatever the switch says, after the jobs of Phase 6, and keeps the newest ROOM_KEEP', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await db
      .prepare(
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO room_messages (at, author, text) SELECT '2026-10-01T00:00:00.000Z', ?2, 'line ' || i FROM n`,
      )
      .bind(ROOM_KEEP + 3, SOMEONE)
      .run();
    const count = async () =>
      (await db.prepare('SELECT COUNT(*) AS n FROM room_messages').first<{ n: number }>())?.n ?? -1;
    const statements: string[] = [];
    const recording = new Proxy(db, {
      get(target, name) {
        if (name === 'prepare') {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const { env } = envWith({ DB: recording, SOCIAL_ENABLED: 'false', [ROOM_ENABLED_VAR]: 'false' });

    // A step ends after the first job that did work, so the prune's turn can take a few steps.
    for (let step = 0; step < 8 && (await count()) > ROOM_KEEP; step += 1) {
      statements.length = 0;
      await runCron(SOCIAL_CRON, env as never);
    }

    expect(await count()).toBe(ROOM_KEEP);
    // The step that pruned asked the Model Wars job first and nothing of it afterwards: the prune is last.
    const pruned = statements.findIndex((sql) => /DELETE FROM room_messages/.test(sql));
    const wars = statements.findIndex((sql) => /\bwars\b/.test(sql));
    expect(pruned).toBeGreaterThan(-1);
    expect(wars).toBeGreaterThan(-1);
    expect(wars).toBeLessThan(pruned);
    expect(statements.slice(pruned + 1).filter((sql) => /\b(wars|rivalries|managers|day_prices)\b/.test(sql))).toEqual(
      [],
    );
  });
});

describe("the room's two cache keys", () => {
  for (const path of CACHED_READS) {
    it(`answers a GET of ${path} from the app on a miss, and stores it under its path`, async () => {
      const { env, reached } = envWith();

      const response = await call(env, path);

      expect(response.status).toBe(200);
      expect(reached.limiter).toBeGreaterThan(0);
      expect(await stored(path)).toBe(await response.text());
    });

    it(`looks ${path} up by its path alone: a query does not make a second key`, async () => {
      const { env, reached } = envWith();
      await plant(path);

      for (const query of ['', '?before=3', '?junk=1&page=2', '?before=3&before=4']) {
        expect(await (await call(env, `${path}${query}`)).text(), query).toBe(MARKER);
      }
      expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
    });

    it(`stores a miss of ${path} with a query under the path alone, and serves the next query from it`, async () => {
      const { env, reached } = envWith();

      const first = await call(env, `${path}?junk=1`);
      expect(first.status).toBe(200);
      const body = await first.text();
      expect(await stored(path)).toBe(body);
      expect(await stored(`${path}?junk=1`)).toBeNull();
      const afterMiss = { ...reached };

      const second = await call(env, `${path}?junk=2&other=3`);

      expect(await second.text()).toBe(body);
      expect(reached).toEqual(afterMiss);
    });
  }

  it("never looks up the composer's own read or the admins' read", async () => {
    const { env } = envWith();
    await plant(`${ROOM}/me`);
    await plant('/api/social/admin/room');

    expect(await (await call(env, `${ROOM}/me`)).text()).not.toBe(MARKER);
    expect(await (await call(env, '/api/social/admin/room')).text()).not.toBe(MARKER);
  });
});

describe('the HEAD rule of the two cached reads', () => {
  for (const path of CACHED_READS) {
    for (const query of ['', '?junk=1']) {
      it(`answers a HEAD of ${path}${query} with 405 and Allow: GET when nothing is cached, and never reaches the route`, async () => {
        const { env, reached } = envWith();

        const response = await call(env, `${path}${query}`, { method: 'HEAD' });

        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.text()).toBe('');
        expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
        // A miss by HEAD is not stored either: the next HEAD is a miss again.
        expect(await stored(path)).toBeNull();
        expect((await call(env, `${path}${query}`, { method: 'HEAD' })).status).toBe(405);
        expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
      });

      it(`answers a HEAD of ${path}${query} from what is cached, with no body, and never reaches the route`, async () => {
        const { env, reached } = envWith();
        await plant(path);

        const response = await call(env, `${path}${query}`, { method: 'HEAD' });

        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=30');
        expect(await response.text()).toBe('');
        expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
      });
    }

    it(`answers a HEAD of ${path} after a GET stored it, as it answers one before: without the route`, async () => {
      const { env, reached } = envWith();
      expect((await call(env, path)).status).toBe(200);
      const afterGet = { ...reached };

      const response = await call(env, path, { method: 'HEAD' });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
      expect(reached).toEqual(afterGet);
    });

    for (const [social, room] of [
      ['true', 'false'],
      ['false', 'true'],
    ]) {
      it(`answers a HEAD of ${path} exactly as a HEAD of an unknown path while the switches are ${JSON.stringify([social, room])}`, async () => {
        const { env, reached } = envWith({ SOCIAL_ENABLED: social, [ROOM_ENABLED_VAR]: room });
        const unknown = await seen(await call(env, '/api/no-such-path', { method: 'HEAD' }));
        expect(unknown.status).toBe(404);
        const afterUnknown = { ...reached };

        const response = await seen(await call(env, path, { method: 'HEAD' }));

        expect(response).toEqual(unknown);
        // Like a GET of it: the app answers, and no route of the room is there to ask D1.
        expect(reached.statements).toBe(afterUnknown.statements);
        expect(await stored(path)).toBeNull();
      });
    }
  }

  describe('with no cache at all', () => {
    beforeEach(() => {
      vi.stubGlobal('caches', undefined);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    for (const path of CACHED_READS) {
      it(`answers a HEAD of ${path} with 405 before anything else is asked`, async () => {
        const { env, reached } = envWith();

        const response = await call(env, path, { method: 'HEAD' });

        expect(typeof caches).toBe('undefined');
        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.text()).toBe('');
        expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
      });

      it(`answers a HEAD of ${path} as a HEAD of an unknown path while the room is off`, async () => {
        const { env } = envWith({ [ROOM_ENABLED_VAR]: 'false' });
        const unknown = await seen(await call(env, '/api/no-such-path', { method: 'HEAD' }));

        expect(await seen(await call(env, path, { method: 'HEAD' }))).toEqual(unknown);
        expect(unknown.status).toBe(404);
      });
    }

    it('still answers a GET of the read from the app', async () => {
      const { env, reached } = envWith();

      expect((await call(env, ROOM)).status).toBe(200);
      expect(reached.reads).toBe(1);
    });
  });

  it('is the rule of those two paths only: a HEAD of another read is answered by the app', async () => {
    const { env, reached } = envWith();

    const me = await call(env, `${ROOM}/me`, { method: 'HEAD' });

    expect(me.status).not.toBe(405);
    expect(reached.limiter).toBeGreaterThan(0);
  });
});

describe('a percent spelling of a path of the room', () => {
  // The router decodes a percent sign, so the app alone would answer these as the routes themselves.
  const SPELLINGS = [
    '/api/social/roo%6d',
    '/api/social/room%2Fstatus',
    '/api/social/room%2fstatus',
    '/api/social/%72oom',
  ];

  for (const spelling of SPELLINGS) {
    for (const method of ['GET', 'HEAD']) {
      it(`answers a ${method} of ${spelling} with the generic 404, and asks nothing`, async () => {
        const { env, reached } = envWith();
        await plant(ROOM);
        await plant(STATUS);

        const response = await call(env, spelling, { method });

        expect(response.status).toBe(404);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const body = await response.text();
        expect(body).not.toBe(MARKER);
        expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe('not_found');
        expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
      });
    }
  }
});

describe('one read of the room at a time', () => {
  const LINE = 'the league looks good today';

  /** Every GET at once, each answer read to its end, and then everything handed to `waitUntil`. */
  async function burst(env: Record<string, unknown>, paths: string[]): Promise<Response[]> {
    const answers = await Promise.all(
      paths.map((path) => worker.fetch(new Request(`${ORIGIN}${path}`) as never, env as never, ctx as never)),
    );
    await Promise.all(pending.splice(0));
    return answers;
  }

  /**
   * A database whose read of the room waits: the statement runs, and its rows are held back until
   * `release` is called. Every other statement is answered at once.
   */
  function heldRead(): { db: D1Database; release: () => void; started: Promise<void> } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const held = new Proxy(db, {
      get(target, name) {
        if (name === 'prepare') {
          return (sql: string) => {
            if (!sql.includes(LIST_NEWEST_MARK)) return target.prepare(sql);
            return {
              bind: (...values: unknown[]) => ({
                all: async () => {
                  const rows = await target
                    .prepare(sql)
                    .bind(...values)
                    .all();
                  begun();
                  await gate;
                  return rows;
                },
              }),
            };
          };
        }
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { db: held, release, started };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The security review's own test of the build (review5-room-build-security.txt, the medium finding):
  // 25 simultaneous GETs ran the read 25 times.
  it('runs the read once for 25 simultaneous misses, with and without a query, and answers every one', async () => {
    const store = createRoomStore(db);
    for (let i = 0; i < 5; i += 1) {
      await store.putMessage(SOMEONE, `line ${i}`, new Date(Date.UTC(2026, 9, 11, 1, 0, i)).toISOString());
    }
    const { env, reached } = envWith();
    const paths = Array.from({ length: 25 }, (_, i) => `${ROOM}${i % 2 === 1 ? `?x=${i}` : ''}`);

    const answers = await burst(env, paths);

    expect(answers.map((answer) => answer.status)).toEqual(paths.map(() => 200));
    const bodies = await Promise.all(answers.map((answer) => answer.text()));
    expect(new Set(bodies).size).toBe(1);
    expect((JSON.parse(bodies[0] ?? '') as { messages: unknown[] }).messages).toHaveLength(5);
    expect(reached.reads).toBe(1);
    // Only the request that read reached the app: the others were answered from what it stored.
    expect(reached.limiter).toBe(1);

    // Once it is stored, 25 more run nothing.
    const before = { ...reached };
    const again = await burst(
      env,
      paths.map(() => ROOM),
    );
    expect(again.map((answer) => answer.status)).toEqual(paths.map(() => 200));
    expect(reached).toEqual(before);
  });

  it('answers a miss beside a read that does not end with 503, Retry-After: 1 and no-store, without the route', async () => {
    const { db: held, release, started } = heldRead();
    const { env, reached } = envWith({ DB: held });
    const first = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
    await started;
    const whileHeld = { ...reached };
    const began = Date.now();

    const second = await worker.fetch(new Request(`${ORIGIN}${ROOM}?x=1`) as never, env as never, ctx as never);

    expect(second.status).toBe(503);
    expect(second.headers.get('Retry-After')).toBe('1');
    expect(second.headers.get('Cache-Control')).toBe('no-store');
    expect(reached).toEqual(whileHeld);
    // It asked the cache again every 100 ms, ten times at most.
    const waited = Date.now() - began;
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(4_000);

    release();
    expect((await first).status).toBe(200);
    await Promise.all(pending.splice(0));
    expect(await stored(ROOM)).not.toBeNull();
    // The mark is cleared with the store: the next miss reads at once.
    await caches.default.delete(`${ORIGIN}${ROOM}`);
    expect((await call(env, ROOM)).status).toBe(200);
  });

  it('answers a miss beside a read under way from what that read stores, as soon as it is there', async () => {
    const { db: held, release, started } = heldRead();
    const { env, reached } = envWith({ DB: held });
    const first = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
    await started;
    const whileHeld = { ...reached };

    const second = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();

    const [one, two] = await Promise.all([first, second]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(await two.text()).toBe(await one.text());
    expect(reached).toEqual(whileHeld);
    await Promise.all(pending.splice(0));
  });

  it('does not wait for a read that started more than 5 seconds ago', async () => {
    const { db: held, release, started } = heldRead();
    const { env, reached } = envWith({ DB: held });
    const first = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
    await started;
    expect(reached.reads).toBe(1);
    const real = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => real + 5_000);

    const second = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
    // Its read is held as the first one's is: that it was prepared at all is the proof.
    await vi.waitFor(() => expect(reached.reads).toBe(2));

    release();
    expect((await Promise.all([first, second])).map((answer) => answer.status)).toEqual([200, 200]);
    await Promise.all(pending.splice(0));
  });

  it('still waits for a read that started just under 5 seconds ago', async () => {
    const { db: held, release, started } = heldRead();
    const { env, reached } = envWith({ DB: held });
    const first = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
    await started;
    const real = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => real + 4_900);

    const second = await worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);

    expect(second.status).toBe(503);
    expect(reached.reads).toBe(1);
    vi.restoreAllMocks();
    release();
    expect((await first).status).toBe(200);
    await Promise.all(pending.splice(0));
  });

  it('clears the mark at once when the answer may not be stored: the next miss reads', async () => {
    const refuse = { now: true };
    const { env, reached } = envWith({
      RATE_READ: { limit: async () => ({ success: !refuse.now }) },
    });

    expect((await call(env, ROOM)).status).toBe(429);
    expect(await stored(ROOM)).toBeNull();
    refuse.now = false;
    const began = Date.now();
    const response = await call(env, ROOM);

    expect(response.status).toBe(200);
    expect(reached.reads).toBe(1);
    expect(Date.now() - began).toBeLessThan(900);
  });

  it('clears the mark at once when the route fails: the next miss reads', async () => {
    const fail = { now: true };
    const failing = new Proxy(db, {
      get(target, name) {
        if (name === 'prepare') {
          return (sql: string) => {
            if (fail.now && sql.includes(LIST_NEWEST_MARK)) throw new Error('D1 is away');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { env } = envWith({ DB: failing });

    expect((await call(env, ROOM)).status).toBe(500);
    expect(await stored(ROOM)).toBeNull();
    fail.now = false;
    const began = Date.now();

    expect((await call(env, ROOM)).status).toBe(200);
    expect(Date.now() - began).toBeLessThan(900);
  });

  it('is the rule of the read only: simultaneous misses of the status are each answered by the app', async () => {
    const { env } = envWith();

    const answers = await burst(env, [STATUS, STATUS, STATUS]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
  });

  it('is not asked while the room is off: simultaneous GETs are each the generic 404, at once', async () => {
    const { env } = envWith({ [ROOM_ENABLED_VAR]: 'false' });
    const began = Date.now();

    const answers = await burst(env, [ROOM, ROOM, ROOM, ROOM]);

    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404]);
    expect(Date.now() - began).toBeLessThan(900);
  });

  describe('a write that overtakes a read', () => {
    it('makes a read under way skip its put when a message is written: the old page is never stored', async () => {
      const { db: held, release, started } = heldRead();
      const { env } = envWith({ DB: held });
      const admin = await sessionFor(ADMIN);
      const read = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
      await started;

      const written = await worker.fetch(
        new Request(`${ORIGIN}${ROOM}`, write('POST', admin, { text: LINE })) as never,
        env as never,
        ctx as never,
      );
      expect(written.status).toBe(201);
      release();
      const old = (await (await read).json()) as { messages: unknown[] };
      await Promise.all(pending.splice(0));

      // The read was made before the write and says so; it is answered, and not kept.
      expect(old.messages).toEqual([]);
      expect(await stored(ROOM)).toBeNull();
      const next = (await (await call(env, ROOM)).json()) as { messages: { text: string }[] };
      expect(next.messages.map((message) => message.text)).toEqual([LINE]);
    });

    for (const [name, method, suffix] of [
      ['a hide', 'DELETE', ''],
      ['a mute', 'PUT', '/mute'],
    ] as const) {
      it(`makes a read under way skip its put after ${name}: the page read before it is never stored`, async () => {
        const message = await createRoomStore(db).putMessage(SOMEONE, LINE, new Date().toISOString());
        const { db: held, release, started } = heldRead();
        const { env } = envWith({ DB: held });
        const admin = await sessionFor(ADMIN);
        const read = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
        await started;

        const removed = await worker.fetch(
          new Request(`${ORIGIN}/api/social/admin/room/messages/${message.id}${suffix}`, write(method, admin)) as never,
          env as never,
          ctx as never,
        );
        expect(removed.status).toBe(204);
        release();
        const old = (await (await read).json()) as { messages: { id: number }[] };
        await Promise.all(pending.splice(0));

        expect(old.messages.map(({ id }) => id)).toEqual([message.id]);
        expect(await stored(ROOM)).toBeNull();
        const next = (await (await call(env, ROOM)).json()) as { messages: unknown[] };
        expect(next.messages).toEqual([]);
      });
    }

    it('stores a read as before when a write to the room was refused while it was under way', async () => {
      const { db: held, release, started } = heldRead();
      const { env } = envWith({ DB: held });
      const read = worker.fetch(new Request(`${ORIGIN}${ROOM}`) as never, env as never, ctx as never);
      await started;

      const refused = await worker.fetch(
        new Request(`${ORIGIN}${ROOM}`, write('POST', null, { text: LINE })) as never,
        env as never,
        ctx as never,
      );
      expect(refused.status).toBe(401);
      release();
      const body = await (await read).text();
      await Promise.all(pending.splice(0));

      expect(await stored(ROOM)).toBe(body);
    });
  });
});

describe("the drop of the read's key after a write", () => {
  const LINE = 'the league looks good today';

  it('drops it when a message is written, and leaves the status', async () => {
    const { env } = envWith();
    const admin = await sessionFor(ADMIN);
    await plant(ROOM);
    await plant(STATUS);

    const response = await call(env, ROOM, write('POST', admin, { text: LINE }));

    expect(response.status).toBe(201);
    expect(await stored(ROOM)).toBeNull();
    expect(await stored(STATUS)).toBe(MARKER);
    // The next read is the app's own, with the new message in it.
    const read = (await (await call(env, ROOM)).json()) as { messages: { text: string }[] };
    expect(read.messages.map((message) => message.text)).toEqual([LINE]);
  });

  it("drops it after each of the admin's three writes by a message's id", async () => {
    const { env } = envWith();
    const admin = await sessionFor(ADMIN);
    const message = await createRoomStore(db).putMessage(SOMEONE, LINE, new Date().toISOString());
    const writes: [string, string][] = [
      ['PUT', `/api/social/admin/room/messages/${message.id}/mute`],
      ['DELETE', `/api/social/admin/room/messages/${message.id}/mute`],
      ['DELETE', `/api/social/admin/room/messages/${message.id}`],
    ];
    for (const [method, path] of writes) {
      await plant(ROOM);

      const response = await call(env, path, write(method, admin));

      expect(response.status, `${method} ${path}`).toBe(204);
      expect(await stored(ROOM), `${method} ${path}`).toBeNull();
    }
  });

  it('leaves it after a write that is refused, and after a read', async () => {
    const { env } = envWith();
    const admin = await sessionFor(ADMIN);
    await plant(ROOM);
    const refused: [number, string, RequestInit][] = [
      [401, ROOM, write('POST', null, { text: LINE })],
      [400, ROOM, write('POST', admin, { text: '' })],
      [404, '/api/social/admin/room/messages/999999', write('DELETE', admin)],
      [404, '/api/social/admin/room/messages/999999/mute', write('PUT', admin)],
    ];
    for (const [status, path, init] of refused) {
      const response = await call(env, path, init);
      expect(response.status, `${init.method} ${path}`).toBe(status);
      expect(await stored(ROOM), `${init.method} ${path}`).toBe(MARKER);
    }

    expect((await call(env, '/api/social/admin/room', { headers: { Cookie: admin } })).status).toBe(200);
    expect((await call(env, `${ROOM}/me`, { headers: { Cookie: admin } })).status).toBe(200);
    expect(await stored(ROOM)).toBe(MARKER);
  });
});

// --- Phase 6.4: pictures in the room (docs/contracts/phase-6-pictures.md) -------------------------------

const PICTURES = ROOM_PICTURES_PATH;
const ADMIN_PICTURES = ROOM_PICTURES_ADMIN_PATH;
const UNKNOWN_PATH = '/api/no-such-path';

/** The env with pictures enabled too, unless a test says otherwise. */
function pictureEnv(extra: Record<string, unknown> = {}) {
  return envWith({ [ROOM_PICTURES_ENABLED_VAR]: 'true', ...extra });
}

/** The extras the entry handed `createApp` for `env`: the wiring is built at the env's first request. */
async function extrasOf(env: Record<string, unknown>): Promise<PictureExtras> {
  await call(env, UNKNOWN_PATH);
  return app.extras as PictureExtras;
}

/** A KV that writes down every call. */
function fakeKv() {
  const calls: { method: string; args: unknown[] }[] = [];
  const held = new Map<string, ArrayBuffer>();
  return {
    calls,
    held,
    kv: {
      put: async (...args: [string, ArrayBuffer, { expirationTtl: number }]) => {
        calls.push({ method: 'put', args });
        held.set(args[0], args[1]);
      },
      get: async (...args: [string, 'arrayBuffer']) => {
        calls.push({ method: 'get', args });
        return held.get(args[0]) ?? null;
      },
      delete: async (...args: [string]) => {
        calls.push({ method: 'delete', args });
        held.delete(args[0]);
      },
    },
  };
}

describe('pictures in the entry', () => {
  beforeEach(async () => {
    app.answer = null;
    app.contexts.length = 0;
    sweep.outcome = null;
    sweep.runs = 0;
    await db.batch([
      db.prepare('DELETE FROM room_picture_reports'),
      db.prepare('DELETE FROM room_picture_blocks'),
      db.prepare('DELETE FROM room_flags'),
      db.prepare("DELETE FROM counters WHERE key LIKE 'd:%:room:%'"),
    ]);
    for (const path of [PICTURES, `${PICTURES}/12`, `${ADMIN_PICTURES}/12`]) {
      await caches.default.delete(`${ORIGIN}${path}`);
    }
  });
  afterEach(() => {
    app.answer = null;
    sweep.outcome = null;
    vi.restoreAllMocks();
  });

  describe('the switch: SOCIAL_ENABLED, ROOM_ENABLED and ROOM_PICTURES_ENABLED, all three', () => {
    for (const [social, room, pictures] of [
      ['true', 'true', 'true'],
      [' TRUE ', 'True', ' true'],
    ]) {
      it(`hands the app the pictures' public routes while they are ${JSON.stringify([social, room, pictures])}`, async () => {
        const { env } = envWith({
          SOCIAL_ENABLED: social,
          [ROOM_ENABLED_VAR]: room,
          [ROOM_PICTURES_ENABLED_VAR]: pictures,
        });

        const extras = await extrasOf(env);

        expect(extras.roomPictures?.picturesEnabled).toBe(true);
        expect(extras.roomPicturesAdmin?.picturesEnabled).toBe(true);
      });
    }

    for (const [social, room, pictures] of [
      ['true', 'true', 'false'],
      ['true', 'true', undefined],
      ['true', 'true', 'yes'],
      ['true', 'true', '1'],
      ['true', 'false', 'true'],
      ['false', 'true', 'true'],
      [undefined, 'true', 'true'],
    ]) {
      it(`hands the app the admin's routes alone while they are ${JSON.stringify([social, room, pictures])}`, async () => {
        const { env } = envWith({
          SOCIAL_ENABLED: social,
          [ROOM_ENABLED_VAR]: room,
          [ROOM_PICTURES_ENABLED_VAR]: pictures,
        });

        const extras = await extrasOf(env);

        expect(extras.roomPictures).toBeUndefined();
        expect(extras.roomPicturesAdmin?.picturesEnabled).toBe(false);
        // The paths of the three public routes are what an unknown path is.
        const unknown = await seen(await call(env, UNKNOWN_PATH));
        expect(await seen(await call(env, `${PICTURES}/12`))).toEqual(unknown);
      });
    }

    it("hands the room's own two factories the same deps, with the pictures' store and bytes in them", async () => {
      const extras = await extrasOf(pictureEnv().env);

      for (const deps of [extras.room, extras.roomAdmin, extras.roomPictures, extras.roomPicturesAdmin]) {
        expect(deps).toBe(extras.roomPicturesAdmin);
      }
      const deps = extras.roomPicturesAdmin;
      expect(Object.keys(deps?.pictures ?? {})).toContain('getServable');
      expect(Object.keys(deps?.bytes ?? {}).sort()).toEqual(['delete', 'get', 'put']);
    });
  });

  describe('the caps', () => {
    it('reads the two caps of a day from their variables, with their defaults and ceilings', async () => {
      const defaults = (await extrasOf(pictureEnv().env)).roomPicturesAdmin;
      expect([defaults?.picturesDailyCap, defaults?.pictureViewsCap]).toEqual([
        ROOM_PICTURES_PER_DAY_DEFAULT,
        ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
      ]);

      const high = (
        await extrasOf(pictureEnv({ [ROOM_PICTURES_DAILY_CAP_VAR]: '9000', [ROOM_PICTURE_VIEWS_VAR]: '99999' }).env)
      ).roomPicturesAdmin;
      expect([high?.picturesDailyCap, high?.pictureViewsCap]).toEqual([
        ROOM_PICTURES_PER_DAY_MAX,
        ROOM_PICTURE_VIEWS_PER_DAY_MAX,
      ]);

      const stopped = (await extrasOf(pictureEnv({ [ROOM_PICTURES_DAILY_CAP_VAR]: '0' }).env)).roomPicturesAdmin;
      expect(stopped?.picturesDailyCap).toBe(0);
    });

    it("lowers the room's cap of messages beside pictures while they are enabled, and not while they are not", async () => {
      const caps = {
        [ROOM_DAILY_CAP_VAR]: '600',
        [ROOM_PICTURES_DAILY_CAP_VAR]: '150',
        [ROOM_PICTURE_VIEWS_VAR]: '30000',
      };

      const on = (await extrasOf(pictureEnv(caps).env)).roomPicturesAdmin;
      const off = (await extrasOf(envWith({ ...caps, [ROOM_PICTURES_ENABLED_VAR]: 'false' }).env)).roomPicturesAdmin;

      expect(on?.roomDailyCap).toBe(
        roomDailyCapBesidePictures(
          ROOM_MESSAGES_PER_DAY_MAX,
          ROOM_PICTURES_PER_DAY_MAX,
          ROOM_PICTURE_VIEWS_PER_DAY_MAX,
        ),
      );
      // The contract's own figure at both ceilings since its revision 5 (266 before).
      expect(on?.roomDailyCap).toBe(250);
      expect(off?.roomDailyCap).toBe(ROOM_MESSAGES_PER_DAY_MAX);
    });

    it("hands the room the contract's figures of a day at the default cap of 400 messages", async () => {
      const capAt = async (pictures: number | null, views: number | null): Promise<number | undefined> =>
        (
          await extrasOf(
            pictureEnv({
              ...(pictures === null ? {} : { [ROOM_PICTURES_DAILY_CAP_VAR]: String(pictures) }),
              ...(views === null ? {} : { [ROOM_PICTURE_VIEWS_VAR]: String(views) }),
            }).env,
          )
        ).roomPicturesAdmin?.roomDailyCap;

      // `pictureEnv` sets the room's own variable to its default (docs/contracts/phase-6-pictures.md, section 13).
      expect(ROOM_MESSAGES_PER_DAY_DEFAULT).toBe(400);
      // At the defaults (60 pictures, 20,000 views) six messages of the day give way (400 before revision 5).
      expect(await capAt(null, null)).toBe(394);
      expect(await capAt(null, null)).toBe(
        roomDailyCapBesidePictures(
          ROOM_MESSAGES_PER_DAY_DEFAULT,
          ROOM_PICTURES_PER_DAY_DEFAULT,
          ROOM_PICTURE_VIEWS_PER_DAY_DEFAULT,
        ),
      );
      // The opening's first two steps, and every cap up to 55 pictures, cost the room nothing.
      for (const pictures of [5, 20, 55]) expect(await capAt(pictures, null), `${pictures} pictures`).toBe(400);
      expect(await capAt(56, null)).toBeLessThan(400);
      // At the ceiling of pictures (311 before revision 5), and at both ceilings (266 before).
      expect(await capAt(ROOM_PICTURES_PER_DAY_MAX, null)).toBe(294);
      expect(await capAt(ROOM_PICTURES_PER_DAY_MAX, ROOM_PICTURE_VIEWS_PER_DAY_MAX)).toBe(250);
    });

    it('draws a number from 0 up to and not including 1', async () => {
      const random = (await extrasOf(pictureEnv().env)).roomPicturesAdmin?.random;

      const draws = Array.from({ length: 2_000 }, () => random?.() ?? -1);

      expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...draws)).toBeLessThan(1);
      expect(new Set(draws).size).toBeGreaterThan(1_900);
    });
  });

  describe('the bytes and the limiter, with and without their bindings', () => {
    const KEY = 'pic/000000000000000000000000000000aa';

    it('throws from every method of the bytes while there is no ROOM_PICTURES binding', async () => {
      const bytes = (await extrasOf(pictureEnv().env)).roomPicturesAdmin?.bytes;

      await expect(bytes?.put(KEY, new Uint8Array([1]), ROOM_PICTURE_TTL_SECONDS)).rejects.toThrow(/ROOM_PICTURES/);
      await expect(bytes?.get(KEY)).rejects.toThrow(/ROOM_PICTURES/);
      await expect(bytes?.delete(KEY)).rejects.toThrow(/ROOM_PICTURES/);
    });

    it('puts through the ROOM_PICTURES binding with the expiry of seven days', async () => {
      const { kv, calls } = fakeKv();
      const bytes = (await extrasOf(pictureEnv({ [ROOM_PICTURES_KV_BINDING]: kv }).env)).roomPicturesAdmin?.bytes;

      await bytes?.put(KEY, new Uint8Array([1, 2, 3]), ROOM_PICTURE_TTL_SECONDS);

      expect(calls.map((call) => [call.method, call.args[0], call.args[2]])).toEqual([
        ['put', KEY, { expirationTtl: 604_800 }],
      ]);
    });

    it('refuses every subject while there is no RATE_PICTURE binding, and says so once', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const limiter = (await extrasOf(pictureEnv().env)).roomPicturesAdmin?.pictureLimiter;

      expect(await limiter?.allow('203.0.113.7')).toBe(false);
      expect(await limiter?.allow('203.0.113.8')).toBe(false);

      const lines = errors.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"picture"'));
      expect(lines).toEqual([
        JSON.stringify({ event: 'rate_limit_unavailable', rule: 'picture', reason: 'binding_missing' }),
      ]);
    });

    it('counts a subject through the RATE_PICTURE binding as it was given: a /48 is never cut to a /64', async () => {
      const keys: string[] = [];
      const binding = {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: !key.includes('full') };
        },
      };
      const limiter = (await extrasOf(pictureEnv({ [ROOM_PICTURE_RATE_BINDING]: binding }).env)).roomPicturesAdmin
        ?.pictureLimiter;

      // `2001:db8:1234::` is what `clientNetwork` makes of an IPv6 address: its /48. The `read` rule's own
      // cut would turn it into `2001:db8:1234:0::/64`, and a whole address into its /64.
      expect(await limiter?.allow('2001:db8:1234::')).toBe(true);
      expect(await limiter?.allow('2001:db8:1234:5678:9abc:def0:1:2')).toBe(true);
      expect(await limiter?.allow('203.0.113.7')).toBe(true);
      expect(await limiter?.allow('full')).toBe(false);

      expect(keys).toEqual([
        'net:2001:db8:1234::',
        'net:2001:db8:1234:5678:9abc:def0:1:2',
        'net:203.0.113.7',
        'net:full',
      ]);
    });

    it('refuses when it cannot count: a binding that throws, an answer that is none, a subject that is empty', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const throwing = createPictureLimiter({
        limit: async () => {
          throw new Error('away');
        },
      });
      const wrong = createPictureLimiter({ limit: async () => ({ success: 'yes' }) as never });
      const asked: string[] = [];
      const counting = createPictureLimiter({
        limit: async ({ key }) => {
          asked.push(key);
          return { success: true };
        },
      });

      expect(await throwing.allow('203.0.113.7')).toBe(false);
      expect(await wrong.allow('203.0.113.7')).toBe(false);
      expect(await counting.allow('')).toBe(false);
      expect(await counting.allow('   ')).toBe(false);
      expect(asked).toEqual([]);
    });
  });

  describe('wrangler.jsonc', () => {
    /** apps/api/wrangler.jsonc of the checkout under test, handed in as text by this suite's config. */
    const REAL = (baseEnv as unknown as { WRANGLER_JSONC: string }).WRANGLER_JSONC;
    /** A config's text with its comment lines taken out: what a deploy reads. */
    const liveOf = (text: string): string =>
      text
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

    it('gives RATE_PICTURE the limit of the contract, in 60 seconds, in its own namespace', () => {
      const { ratelimits } = JSON.parse(liveOf(REAL)) as {
        ratelimits: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
      };
      const binding = ratelimits.find(({ name }) => name === ROOM_PICTURE_RATE_BINDING);

      expect(binding).toEqual({
        name: 'RATE_PICTURE',
        namespace_id: ROOM_PICTURE_RATE_NAMESPACE,
        simple: { limit: ROOM_PICTURE_RATE_PER_MINUTE, period: 60 },
      });
      const namespaces = ratelimits.map(({ namespace_id }) => namespace_id);
      expect(new Set(namespaces).size).toBe(namespaces.length);
    });

    /**
     * The namespace `prix-room-pictures`, created on the operator's account on 2026-10-11 (infra/README.md
     * section 18). An id is not a secret. It is held here so that a slip of one character in the config
     * fails a test: a binding with a wrong id would bind another namespace, or none.
     */
    const NAMESPACE_ID = '0407f2417b4e49029d406858639fbe04';
    const BINDING_LINE = `{ "binding": "${ROOM_PICTURES_KV_BINDING}", "id": "${NAMESPACE_ID}" }`;
    /** The binding's three lines as a deploy reads them, which is how they read in a comment behind its mark. */
    const BINDING_LINES = ['"kv_namespaces": [', BINDING_LINE, '],'];
    /** The day's cap of pictures at each step of the runbook (section 18, step 5), and "0": uploads stopped. */
    const PICTURES_A_DAY = ['0', '5', '20', '60'];
    /** What `picturesConfigProblem` can say. Each is one rule, and each has texts below that it refuses. */
    const PROBLEMS = {
      unreadable: 'it is not JSON once its comment lines are taken out, so nothing here can say what a deploy reads',
      switch: `${ROOM_PICTURES_ENABLED_VAR} is neither "true" nor "false"`,
      perDay: `${ROOM_PICTURES_DAILY_CAP_VAR} is not a step of the runbook: ${PICTURES_A_DAY.join(', ')}`,
      views: `${ROOM_PICTURE_VIEWS_VAR} is not a whole number from 1 to ${ROOM_PICTURE_VIEWS_PER_DAY_MAX}`,
      comment: 'a comment holds lines of the KV binding that are not its three lines with the id, one after the other',
      list: 'a deploy would read a list of KV bindings that is not the one binding of the pictures and nothing else',
      name: `a deploy would read a KV binding that is not named ${ROOM_PICTURES_KV_BINDING}`,
      id: `a deploy would bind ${ROOM_PICTURES_KV_BINDING} to a namespace that is not ${NAMESPACE_ID}, or make one by itself`,
      extra: `the binding ${ROOM_PICTURES_KV_BINDING} carries more than its name and its id`,
      second: 'a second "kv_namespaces" stands outside the comments',
      early: `${ROOM_PICTURES_ENABLED_VAR} is "true" and a deploy would read no binding of the namespace: the binding first`,
      both: 'the binding stands in its comment and bound: once it is bound, its three commented lines are gone',
      neither: 'the binding stands neither in its comment nor bound',
      elsewhere: `"${ROOM_PICTURES_KV_BINDING}" names something else in the file beside the KV binding`,
    } as const;

    /**
     * What is wrong with a text of apps/api/wrangler.jsonc, or null. The file changes twice on the way to
     * pictures, each time in a commit of the operator's with a deploy of its own (infra/README.md section 18,
     * steps 2 and 5), so no single state is pinned here: a test that had to be edited between two deploys
     * would stop the second one. What holds across them is pinned. The text is in one of two states:
     *
     *   as built  the binding of the namespace stands in a comment, its three lines one after the other
     *             with the namespace's id; a deploy reads no KV binding; the switch is "false".
     *   bound     a deploy reads that one KV binding and no other; none of its lines is left in a comment;
     *             the switch is "false" or "true".
     *
     * In both, the day's cap of pictures is a step of the runbook and the cap of views is a whole number
     * from 1 to the contract's ceiling. The bound binding is judged as a deploy reads it, so its layout on
     * three lines or on one is the same. A comment line that names `"kv_namespaces"` or the binding in
     * double quotes is read as a line of config that was commented out, never as prose.
     */
    function picturesConfigProblem(text: string): string | null {
      const lines = text.split('\n').map((line) => line.trim());
      /** A comment line without its mark, or null for a line a deploy reads. */
      const commented = (line: string | undefined): string | null =>
        line?.startsWith('//') ? line.replace(/^\/\/\s*/, '') : null;
      const times = (whole: string, part: string): number => whole.split(part).length - 1;
      const live = liveOf(text);
      const name = `"${ROOM_PICTURES_KV_BINDING}"`;

      let read: { vars?: Record<string, unknown>; kv_namespaces?: unknown };
      try {
        read = JSON.parse(live);
      } catch {
        return PROBLEMS.unreadable;
      }
      const enabled = read.vars?.[ROOM_PICTURES_ENABLED_VAR];
      const perDay = read.vars?.[ROOM_PICTURES_DAILY_CAP_VAR];
      const views = read.vars?.[ROOM_PICTURE_VIEWS_VAR];
      if (enabled !== 'true' && enabled !== 'false') return PROBLEMS.switch;
      if (!PICTURES_A_DAY.some((step) => step === perDay)) return PROBLEMS.perDay;
      if (typeof views !== 'string') return PROBLEMS.views;
      if (!/^[1-9]\d{0,4}$/.test(views)) return PROBLEMS.views;
      if (Number(views) > ROOM_PICTURE_VIEWS_PER_DAY_MAX) return PROBLEMS.views;

      // The binding in its comment: its three lines whole and once, or no line of it.
      const inComment = lines.some((_, at) => BINDING_LINES.every((line, k) => commented(lines[at + k]) === line));
      const kept = lines.filter((line) => ['"kv_namespaces"', name].some((part) => commented(line)?.includes(part)));
      if (kept.length !== (inComment ? 2 : 0)) return PROBLEMS.comment;

      // The binding a deploy reads: that one, or none.
      const bound = read.kv_namespaces !== undefined;
      if (bound) {
        if (!Array.isArray(read.kv_namespaces) || read.kv_namespaces.length !== 1) return PROBLEMS.list;
        const [only] = read.kv_namespaces as ({ binding?: unknown; id?: unknown } | null)[];
        if (only?.binding !== ROOM_PICTURES_KV_BINDING) return PROBLEMS.name;
        if (only.id !== NAMESPACE_ID) return PROBLEMS.id;
        if (Object.keys(only).length !== 2) return PROBLEMS.extra;
      }
      if (times(live, '"kv_namespaces"') !== (bound ? 1 : 0)) return PROBLEMS.second;

      // The order of the runbook, and one place for the binding.
      if (enabled === 'true' && !bound) return PROBLEMS.early;
      if (inComment && bound) return PROBLEMS.both;
      if (!inComment && !bound) return PROBLEMS.neither;
      if (times(text, name) !== 1) return PROBLEMS.elsewhere;
      return null;
    }

    /**
     * The operator's two edits of the file, as its script makes them and as section 18 words them: `bind` puts
     * one line where the three commented lines stood and changes nothing else (step 2), `switched` rewrites
     * the two variables (step 5). Each throws when what it looks for does not stand once, where the script
     * writes nothing.
     */
    const COMMENTED = ['  // "kv_namespaces": [', `  //   ${BINDING_LINE}`, '  // ],'] as const;
    /** The bound binding as the script writes it: on one line, which is how the formatter of `pnpm lint` prints it. */
    const BOUND = `  "kv_namespaces": [${BINDING_LINE}],`;
    /** The same binding on the three lines of its comment with their marks taken away: the same to a deploy. */
    const ON_THREE = ['  "kv_namespaces": [', `    ${BINDING_LINE}`, '  ],'] as const;
    function bind(text: string): string {
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      return withChange(text, COMMENTED.join(eol), BOUND);
    }
    function switched(text: string, on: 'true' | 'false', perDay: string): string {
      return withVar(withVar(text, ROOM_PICTURES_ENABLED_VAR, `"${on}"`), ROOM_PICTURES_DAILY_CAP_VAR, `"${perDay}"`);
    }
    /** `text` with one piece of it replaced. The piece stands once, so no crafted text differs by accident. */
    function withChange(text: string, from: string, to: string): string {
      if (text.split(from).length !== 2) throw new Error(`not once in the text: ${from}`);
      return text.replace(from, () => to);
    }
    /** `text` with the value of one variable written as `json`. The variable stands once. */
    function withVar(text: string, name: string, json: string): string {
      const value = new RegExp(`("${name}": )[^,\\r\\n]*`, 'g');
      if ([...text.matchAll(value)].length !== 1) throw new Error(`not once in the text: the variable ${name}`);
      return text.replace(value, (_, key: string) => `${key}${json}`);
    }

    it('allows the real file: it is in one of the two states of the runbook', () => {
      expect(
        picturesConfigProblem(REAL),
        'apps/api/wrangler.jsonc is in none of the states that infra/README.md section 18 allows',
      ).toBeNull();
    });

    it('still allows the real file after each step ahead of it: the binding, then the switch at every cap', () => {
      // Step 2 as the operator's script makes it, unless the real file is past it.
      const asBuilt = (JSON.parse(liveOf(REAL)) as { kv_namespaces?: unknown }).kv_namespaces === undefined;
      const afterStep2 = asBuilt ? bind(REAL) : REAL;

      expect(picturesConfigProblem(afterStep2)).toBeNull();
      // Step 5 and its way back: neither is a state this file has to be edited for.
      for (const perDay of PICTURES_A_DAY) {
        expect(picturesConfigProblem(switched(afterStep2, 'true', perDay)), `"true" at "${perDay}"`).toBeNull();
        expect(picturesConfigProblem(switched(afterStep2, 'false', perDay)), `"false" at "${perDay}"`).toBeNull();
      }
    });

    /** A config with the lines of pictures as the build left them in apps/api/wrangler.jsonc, and little else. */
    const AS_BUILT = [
      '// The `prix-api` Worker, cut down to what the rule reads.',
      '{',
      '  "name": "prix-api",',
      '  "vars": {',
      '    "ROOM_ENABLED": "true",',
      '    // Phase 6.4. Mounted only while this, ROOM_ENABLED and SOCIAL_ENABLED all read "true".',
      `    "${ROOM_PICTURES_ENABLED_VAR}": "false",`,
      '    // Pictures of all wallets in one UTC day. "0" stops uploads and keeps serving what is there.',
      `    "${ROOM_PICTURES_DAILY_CAP_VAR}": "60",`,
      `    "${ROOM_PICTURE_VIEWS_VAR}": "20000"`,
      '  },',
      '',
      '  // Phase 6.4: the KV namespace `prix-room-pictures`. IT IS COMMENTED OUT ON PURPOSE. To bind it, take',
      '  // the comment marks of those three lines away and change nothing else. Never a binding without an id.',
      ...COMMENTED,
      '',
      '  "ai": { "binding": "AI" }',
      '}',
      '',
    ].join('\n');
    const BOUND_TEXT = bind(AS_BUILT);
    /** The config with the binding nowhere: neither in its comment nor bound. */
    const NOWHERE = withChange(AS_BUILT, `${COMMENTED.join('\n')}\n`, '');
    /** Another namespace's id: the real one with its last character changed. */
    const OTHER_ID = `${NAMESPACE_ID.slice(0, -1)}5`;

    it('allows the state after the build: the binding in its comment, the switch "false", any step of the cap', () => {
      expect(picturesConfigProblem(AS_BUILT)).toBeNull();
      for (const perDay of PICTURES_A_DAY) {
        expect(picturesConfigProblem(switched(AS_BUILT, 'false', perDay)), perDay).toBeNull();
      }
      // A checkout with Windows line ends holds the same config.
      expect(picturesConfigProblem(AS_BUILT.replaceAll('\n', '\r\n'))).toBeNull();
    });

    it('allows the bound state: the one binding as the operator binds it, the switch "false" or "true", any step', () => {
      // The edit is one line where the three commented lines stood, and no other line.
      const before = AS_BUILT.split('\n');
      const after = BOUND_TEXT.split('\n');
      const at = before.indexOf(COMMENTED[0]);
      expect(after[at]).toBe(
        '  "kv_namespaces": [{ "binding": "ROOM_PICTURES", "id": "0407f2417b4e49029d406858639fbe04" }],',
      );
      expect([...after.slice(0, at), ...COMMENTED, ...after.slice(at + 1)]).toEqual(before);

      expect(picturesConfigProblem(BOUND_TEXT)).toBeNull();
      for (const on of ['false', 'true'] as const) {
        for (const perDay of PICTURES_A_DAY) {
          expect(picturesConfigProblem(switched(BOUND_TEXT, on, perDay)), `"${on}" at "${perDay}"`).toBeNull();
        }
      }
      expect(picturesConfigProblem(bind(AS_BUILT.replaceAll('\n', '\r\n')))).toBeNull();
    });

    it('allows the bound binding on three lines as well: its layout is no rule, and the views at both ends', () => {
      const onThree = withChange(BOUND_TEXT, BOUND, ON_THREE.join('\n'));

      expect(picturesConfigProblem(onThree)).toBeNull();
      expect(picturesConfigProblem(switched(onThree, 'true', '5'))).toBeNull();
      expect(picturesConfigProblem(onThree.replaceAll('\n', '\r\n'))).toBeNull();
      for (const views of ['1', '20000', String(ROOM_PICTURE_VIEWS_PER_DAY_MAX)]) {
        expect(picturesConfigProblem(withVar(AS_BUILT, ROOM_PICTURE_VIEWS_VAR, `"${views}"`)), views).toBeNull();
        expect(picturesConfigProblem(withVar(BOUND_TEXT, ROOM_PICTURE_VIEWS_VAR, `"${views}"`)), views).toBeNull();
      }
    });

    /** Every state the file must never be in, each with the one rule that refuses it. */
    const REFUSED: [state: string, text: () => string, problem: string][] = [
      // The switch before the binding: the binding is step 2 of the runbook, the switch step 5.
      [
        'the switch "true" while the binding is still in its comment',
        () => withVar(AS_BUILT, ROOM_PICTURES_ENABLED_VAR, '"true"'),
        PROBLEMS.early,
      ],
      [
        'the switch "true" at the cap of the drill while the binding is still in its comment',
        () => switched(AS_BUILT, 'true', '5'),
        PROBLEMS.early,
      ],
      [
        'the switch "true" while the binding is missing',
        () => withVar(NOWHERE, ROOM_PICTURES_ENABLED_VAR, '"true"'),
        PROBLEMS.early,
      ],
      [
        'the binding missing, neither in its comment nor bound, with the switch "false"',
        () => NOWHERE,
        PROBLEMS.neither,
      ],
      // A binding that is not the one of the namespace, alone.
      [
        'a binding with another id, one character off',
        () => withChange(BOUND_TEXT, NAMESPACE_ID, OTHER_ID),
        PROBLEMS.id,
      ],
      ['a binding with no id', () => withChange(BOUND_TEXT, `, "id": "${NAMESPACE_ID}"`, ''), PROBLEMS.id],
      ['a binding with an empty id', () => withChange(BOUND_TEXT, NAMESPACE_ID, ''), PROBLEMS.id],
      [
        'a binding under another name',
        () => withChange(BOUND_TEXT, `"binding": "${ROOM_PICTURES_KV_BINDING}"`, '"binding": "PICTURES"'),
        PROBLEMS.name,
      ],
      [
        'a binding beside a second KV binding',
        () => withChange(BOUND_TEXT, BINDING_LINE, `${BINDING_LINE}, { "binding": "OTHER", "id": "${OTHER_ID}" }`),
        PROBLEMS.list,
      ],
      [
        'a binding beside a second KV binding, on lines of their own',
        () =>
          withChange(
            BOUND_TEXT,
            BOUND,
            [ON_THREE[0], `${ON_THREE[1]},`, `    { "binding": "OTHER", "id": "${OTHER_ID}" }`, ON_THREE[2]].join('\n'),
          ),
        PROBLEMS.list,
      ],
      [
        'the binding twice in its list',
        () => withChange(BOUND_TEXT, BINDING_LINE, `${BINDING_LINE}, ${BINDING_LINE}`),
        PROBLEMS.list,
      ],
      [
        'an empty list of KV bindings beside the commented lines',
        () => withChange(AS_BUILT, COMMENTED[0], `  "kv_namespaces": [],\n${COMMENTED[0]}`),
        PROBLEMS.list,
      ],
      [
        'KV bindings that are no list',
        () => withChange(BOUND_TEXT, BOUND, `  "kv_namespaces": ${BINDING_LINE},`),
        PROBLEMS.list,
      ],
      [
        'a binding that carries more than its name and its id',
        () => withChange(BOUND_TEXT, `"id": "${NAMESPACE_ID}"`, `"id": "${NAMESPACE_ID}", "preview_id": "${OTHER_ID}"`),
        PROBLEMS.extra,
      ],
      [
        'a second "kv_namespaces" that the last one hides from a reader of JSON',
        () =>
          withChange(BOUND_TEXT, BOUND, `  "kv_namespaces": [{ "binding": "OTHER", "id": "${OTHER_ID}" }],\n${BOUND}`),
        PROBLEMS.second,
      ],
      [
        'a KV binding inside an environment block while the top level binds none',
        () =>
          withChange(
            AS_BUILT,
            COMMENTED[0],
            `  "env": { "staging": { "kv_namespaces": [{ "binding": "OTHER", "id": "${OTHER_ID}" }] } },\n${COMMENTED[0]}`,
          ),
        PROBLEMS.second,
      ],
      // The commented lines and the bound lines: never both, and never a part of either.
      [
        'the commented lines and the bound line both',
        () => withChange(AS_BUILT, COMMENTED.join('\n'), [...COMMENTED, BOUND].join('\n')),
        PROBLEMS.both,
      ],
      [
        'the commented lines and the binding bound on three lines both',
        () => withChange(AS_BUILT, COMMENTED.join('\n'), [...COMMENTED, ...ON_THREE].join('\n')),
        PROBLEMS.both,
      ],
      [
        'the commented lines and the bound line both, with the switch "true"',
        () => switched(withChange(AS_BUILT, COMMENTED.join('\n'), [BOUND, ...COMMENTED].join('\n')), 'true', '5'),
        PROBLEMS.both,
      ],
      [
        'one commented line of the binding left behind once it is bound',
        () => withChange(BOUND_TEXT, BOUND, `${COMMENTED[0]}\n${BOUND}`),
        PROBLEMS.comment,
      ],
      ['the commented binding with another id', () => withChange(AS_BUILT, NAMESPACE_ID, OTHER_ID), PROBLEMS.comment],
      [
        'the commented binding with a placeholder for its id',
        () => withChange(AS_BUILT, NAMESPACE_ID, '<the id of the namespace>'),
        PROBLEMS.comment,
      ],
      [
        'the commented binding with a line between its three',
        () => withChange(AS_BUILT, COMMENTED[1], `  // The founder makes the namespace.\n${COMMENTED[1]}`),
        PROBLEMS.comment,
      ],
      [
        'the commented binding twice',
        () => withChange(AS_BUILT, COMMENTED.join('\n'), [...COMMENTED, ...COMMENTED].join('\n')),
        PROBLEMS.comment,
      ],
      // An edit by hand that stopped half way: no deploy could read it, and neither can this rule.
      [
        'the mark of the first line alone taken away',
        () => withChange(AS_BUILT, COMMENTED[0], ON_THREE[0]),
        PROBLEMS.unreadable,
      ],
      [
        'the mark of the second line alone taken away',
        () => withChange(AS_BUILT, COMMENTED[1], ON_THREE[1]),
        PROBLEMS.unreadable,
      ],
      [
        'the mark of the third line alone taken away',
        () => withChange(AS_BUILT, COMMENTED[2], ON_THREE[2]),
        PROBLEMS.unreadable,
      ],
      [
        'the marks of the first two lines taken away and the third left',
        () => withChange(AS_BUILT, `${COMMENTED[0]}\n${COMMENTED[1]}`, `${ON_THREE[0]}\n${ON_THREE[1]}`),
        PROBLEMS.unreadable,
      ],
      [
        'the name of the binding given to something else as well',
        () =>
          withChange(
            AS_BUILT,
            '    "ROOM_ENABLED": "true",',
            `    "ROOM_ENABLED": "true",\n    "${ROOM_PICTURES_KV_BINDING}": "on",`,
          ),
        PROBLEMS.elsewhere,
      ],
      // The caps: the runbook's steps for the pictures of a day, the contract's range for the views.
      ...['150', '6', '61', '', '05', ' 5', '5.0', 'many'].map((perDay): [string, () => string, string] => [
        `a cap of "${perDay}" pictures a day, which is no step of the runbook`,
        () => withVar(BOUND_TEXT, ROOM_PICTURES_DAILY_CAP_VAR, `"${perDay}"`),
        PROBLEMS.perDay,
      ]),
      [
        'a cap of pictures that is a number and no text',
        () => withVar(AS_BUILT, ROOM_PICTURES_DAILY_CAP_VAR, '5'),
        PROBLEMS.perDay,
      ],
      [
        'no cap of pictures',
        () => withChange(AS_BUILT, `    "${ROOM_PICTURES_DAILY_CAP_VAR}": "60",\n`, ''),
        PROBLEMS.perDay,
      ],
      ...['0', '30001', '99999', '100000', '020000', '20000.5', '2e4', '', 'many'].map(
        (views): [string, () => string, string] => [
          `a cap of "${views}" views a day`,
          () => withVar(BOUND_TEXT, ROOM_PICTURE_VIEWS_VAR, `"${views}"`),
          PROBLEMS.views,
        ],
      ),
      [
        'a cap of views that is a number and no text',
        () => withVar(AS_BUILT, ROOM_PICTURE_VIEWS_VAR, '20000'),
        PROBLEMS.views,
      ],
      [
        'no cap of views',
        () => withChange(AS_BUILT, `,\n    "${ROOM_PICTURE_VIEWS_VAR}": "20000"`, ''),
        PROBLEMS.views,
      ],
      // The switch is one of two words, as text. The entry reads " TRUE " as on, so no third spelling stands here.
      ...['"TRUE"', '" true"', '"on"', '"1"', '""', 'true', 'false'].map((json): [string, () => string, string] => [
        `a switch written as ${json}`,
        () => withVar(BOUND_TEXT, ROOM_PICTURES_ENABLED_VAR, json),
        PROBLEMS.switch,
      ]),
      ['no switch', () => withChange(AS_BUILT, `    "${ROOM_PICTURES_ENABLED_VAR}": "false",\n`, ''), PROBLEMS.switch],
    ];

    for (const [state, text, problem] of REFUSED) {
      it(`refuses ${state}`, () => {
        expect(picturesConfigProblem(text())).toBe(problem);
      });
    }

    it('has a text it refuses for every rule, and a different word for each', () => {
      const said = Object.values(PROBLEMS);

      expect(new Set(said).size).toBe(said.length);
      expect(new Set(REFUSED.map(([, , problem]) => problem))).toEqual(new Set(said));
    });
  });

  describe('the HEAD rule of the two bytes paths', () => {
    const SEGMENTS = ['12', 'abc', 'off', '0', '99999999999999999999'];

    for (const segment of SEGMENTS) {
      it(`answers a HEAD of ${PICTURES}/${segment} with 405 and Allow: GET while pictures are enabled, and asks nothing`, async () => {
        const { env, reached } = pictureEnv();

        const response = await call(env, `${PICTURES}/${segment}`, { method: 'HEAD' });

        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.text()).toBe('');
        expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
        expect(app.contexts).toEqual([]);
      });

      it(`answers a HEAD of ${ADMIN_PICTURES}/${segment} with the generic 404, whatever the switch says, and asks nothing`, async () => {
        for (const pictures of ['true', 'false']) {
          const { env, reached } = envWith({ [ROOM_PICTURES_ENABLED_VAR]: pictures });
          const admin = await sessionFor(ADMIN);
          const unknown = await seen(await call(env, UNKNOWN_PATH, { method: 'HEAD' }));
          const afterUnknown = { ...reached };
          app.contexts.length = 0;

          const response = await seen(
            await call(env, `${ADMIN_PICTURES}/${segment}`, { method: 'HEAD', headers: { Cookie: admin } }),
          );

          expect(response.status, pictures).toBe(404);
          expect(response, pictures).toEqual(unknown);
          expect(reached, pictures).toEqual(afterUnknown);
          expect(app.contexts, pictures).toEqual([]);
        }
      });
    }

    for (const [social, room, pictures] of [
      ['true', 'true', 'false'],
      ['true', 'false', 'true'],
      ['false', 'true', 'true'],
    ]) {
      it(`answers a HEAD of the public bytes path exactly as a HEAD of an unknown path while the switches are ${JSON.stringify([social, room, pictures])}`, async () => {
        const { env } = envWith({
          SOCIAL_ENABLED: social,
          [ROOM_ENABLED_VAR]: room,
          [ROOM_PICTURES_ENABLED_VAR]: pictures,
        });
        const unknown = await seen(await call(env, UNKNOWN_PATH, { method: 'HEAD' }));
        expect(unknown.status).toBe(404);

        expect(await seen(await call(env, `${PICTURES}/12`, { method: 'HEAD' }))).toEqual(unknown);
      });
    }

    it('is the rule of a path of exactly one segment: a further segment and a trailing slash go to the app', async () => {
      const { env } = pictureEnv();
      const paths = [
        PICTURES,
        `${PICTURES}/`,
        `${PICTURES}/12/`,
        `${PICTURES}/12/report`,
        ADMIN_PICTURES,
        `${ADMIN_PICTURES}/`,
        `${ADMIN_PICTURES}/12/keep`,
        `${ADMIN_PICTURES}x/12`,
      ];
      for (const path of paths) {
        app.contexts.length = 0;

        const response = await call(env, path, { method: 'HEAD' });

        expect(response.status, path).not.toBe(405);
        expect(app.contexts, path).toHaveLength(1);
      }
    });

    it('answers a percent spelling of either path with the generic 404 before the rule is asked', async () => {
      const { env, reached } = pictureEnv();

      for (const path of [`${PICTURES}/1%32`, `${PICTURES}%2F12`, `${ADMIN_PICTURES}/%31`]) {
        const response = await call(env, path, { method: 'HEAD' });
        expect(response.status, path).toBe(404);
      }
      expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
    });

    describe('with no cache at all', () => {
      beforeEach(() => {
        vi.stubGlobal('caches', undefined);
      });
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('answers both as with one: 405 for the public path, the generic 404 for the admin’s', async () => {
        const { env, reached } = pictureEnv();

        expect((await call(env, `${PICTURES}/12`, { method: 'HEAD' })).status).toBe(405);
        expect((await call(env, `${ADMIN_PICTURES}/12`, { method: 'HEAD' })).status).toBe(404);
        expect(reached).toEqual({ limiter: 0, statements: 0, reads: 0 });
      });
    });
  });

  describe('the bytes paths have no cache key', () => {
    /** An answer the cache would keep if the path had a key: a 200 that says it is public. */
    const storable = (): Response =>
      new Response('bytes', { status: 200, headers: { 'Cache-Control': 'public, max-age=30' } });

    for (const path of [`${PICTURES}/12`, `${ADMIN_PICTURES}/12`]) {
      it(`never answers a GET of ${path} from the cache: what is planted there is not looked up`, async () => {
        const { env } = pictureEnv();
        await plant(path);
        app.answer = (request) => (new URL(request.url).pathname === path ? storable() : null);

        const response = await call(env, path);

        expect(await response.text()).toBe('bytes');
        expect(app.contexts).toHaveLength(1);
      });

      it(`never stores an answer of ${path}, whatever the answer says of itself, and asks the app each time`, async () => {
        const { env } = pictureEnv();
        app.answer = (request) => (new URL(request.url).pathname === path ? storable() : null);

        for (const query of ['', '?x=1', '']) {
          expect((await call(env, `${path}${query}`)).status).toBe(200);
        }

        expect(app.contexts).toHaveLength(3);
        expect(await stored(path)).toBeNull();
      });
    }
  });

  describe("the drop of the room's cached read", () => {
    const answerWith =
      (method: string, path: string, status: number) =>
      (request: Request): Response | null =>
        request.method === method && new URL(request.url).pathname === path
          ? new Response(status === 204 ? null : '{}', { status })
          : null;

    it('drops it when the upload answered 201, and leaves the status', async () => {
      const { env } = pictureEnv();
      await plant(ROOM);
      await plant(STATUS);
      app.answer = answerWith('POST', PICTURES, 201);

      const response = await call(env, PICTURES, { method: 'POST' });

      expect(response.status).toBe(201);
      expect(await stored(ROOM)).toBeNull();
      expect(await stored(STATUS)).toBe(MARKER);
    });

    for (const status of [200, 204, 400, 403, 404, 429, 500, 503]) {
      it(`leaves it when the upload answered ${status}`, async () => {
        const { env } = pictureEnv();
        await plant(ROOM);
        app.answer = answerWith('POST', PICTURES, status);

        expect((await call(env, PICTURES, { method: 'POST' })).status).toBe(status);

        expect(await stored(ROOM)).toBe(MARKER);
      });
    }

    for (const status of [204, 201, 404, 429]) {
      it(`leaves it after a report, whatever it answered: ${status}`, async () => {
        const { env } = pictureEnv();
        await plant(ROOM);
        app.answer = answerWith('POST', `${PICTURES}/12/report`, status);

        for (let n = 0; n < 3; n += 1) {
          expect((await call(env, `${PICTURES}/12/report`, { method: 'POST' })).status).toBe(status);
        }

        expect(await stored(ROOM)).toBe(MARKER);
      });
    }

    it('leaves it after a GET of a picture and after a 201 of any other method or path there', async () => {
      const { env } = pictureEnv();
      await plant(ROOM);
      for (const [method, path] of [
        ['GET', `${PICTURES}/12`],
        ['PUT', PICTURES],
        ['POST', `${PICTURES}/`],
        ['POST', `${PICTURES}/12`],
      ] as const) {
        app.answer = answerWith(method, path, 201);
        expect((await call(env, path, { method })).status, `${method} ${path}`).toBe(201);
        expect(await stored(ROOM), `${method} ${path}`).toBe(MARKER);
      }
    });

    it("drops it after the admin's keep and the two of the switch, as after every write under the admin's prefix", async () => {
      const { env } = pictureEnv();
      for (const [method, path] of [
        ['PUT', `${ADMIN_PICTURES}/12/keep`],
        ['PUT', `${ADMIN_PICTURES}/off`],
        ['DELETE', `${ADMIN_PICTURES}/off`],
      ] as const) {
        await plant(ROOM);
        app.answer = answerWith(method, path, 204);

        expect((await call(env, path, { method })).status, `${method} ${path}`).toBe(204);

        expect(await stored(ROOM), `${method} ${path}`).toBeNull();
      }
    });
  });

  describe("the request's execution context", () => {
    it('is handed to the app at each of the three places the entry calls it', async () => {
      const { env } = pictureEnv();
      const places: [string, string][] = [
        ['a path with no cache key', `${ROOM}/me`],
        ['a cached read that missed', STATUS],
        ['the read of the room, one at a time', ROOM],
      ];
      for (const [name, path] of places) {
        app.contexts.length = 0;

        await call(env, path);

        expect(app.contexts, name).toHaveLength(1);
        expect(app.contexts[0], name).toBe(ctx);
      }
    });

    it('is handed on with a write too: the upload is a POST of a path with no cache key', async () => {
      const { env } = pictureEnv();

      await call(env, PICTURES, { method: 'POST' });

      expect(app.contexts).toEqual([ctx]);
    });
  });

  describe('an upload driven through the entry', () => {
    const HOLDER = '0x00000000000000000000000000000000000007c3';

    /** LZW with nothing compressed, at a code size of 2: a clear code before every two pixels of colour 0, then the end code. */
    function lzwFlat(pixels: number): number[] {
      const codes: number[] = [];
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        if (pixel % 2 === 0) codes.push(4);
        codes.push(0);
      }
      codes.push(5);
      const bytes = new Array<number>(Math.ceil((codes.length * 3) / 8)).fill(0);
      codes.forEach((code, index) => {
        const bit = index * 3;
        const low = bit >> 3;
        bytes[low] = (bytes[low] ?? 0) | ((code << (bit & 7)) & 0xff);
        if ((bit & 7) > 5) bytes[low + 1] = (bytes[low + 1] ?? 0) | (code >> (8 - (bit & 7)));
      });
      return bytes;
    }

    /** A still GIF of 16 by 16 pixels, the smallest side the contract takes. */
    function smallGif(): Uint8Array {
      const data = lzwFlat(16 * 16);
      return Uint8Array.from([
        ...[...'GIF89a'].map((letter) => letter.charCodeAt(0)),
        ...[16, 0, 16, 0, 0x80, 0, 0],
        ...[0, 0, 0, 255, 255, 255],
        ...[0x2c, 0, 0, 0, 0, 16, 0, 16, 0, 0],
        2,
        data.length,
        ...data,
        0,
        0x3b,
      ]);
    }

    beforeEach(() => {
      own.holdingOf = async () => ({ gatingOn: true, tokens: 1 });
    });
    afterEach(() => {
      own.holdingOf = null;
    });

    it('sends a file the contract’s own check takes', () => {
      expect(roomPictureCheck(smallGif())).toMatchObject({ ok: true, type: 'gif', width: 16, height: 16, frames: 1 });
    });

    // The contract's section 5: the context reaches the route through two files. This entry hands its
    // `ctx` on; `createApp` hands it to the router (api-core); the route gives steps 6 to 11 to its
    // `waitUntil` before it awaits them, and has no fallback. So the 201 is the proof: only a context
    // that arrived can give it. What the context was handed is not looked at (revision 4): it also holds
    // the entry's own hand-overs, and the route's is a derived promise that nobody can tell from them.
    it('answers 201 and stores the message, driven through `serve` with a context and a KV in memory', async () => {
      const { kv, held } = fakeKv();
      const allow = { limit: async () => ({ success: true }) };
      const { env } = pictureEnv({ [ROOM_PICTURES_KV_BINDING]: kv, [ROOM_PICTURE_RATE_BINDING]: allow });
      const holder = await sessionFor(HOLDER);
      // A first message that stood in the chat for two hours.
      const long = new Date(Date.now() - 2 * 3_600_000).toISOString();
      await createRoomStore(db).putMessage(HOLDER, 'a first line', long);
      const file = smallGif();
      const handed: Promise<unknown>[] = [];
      const context = {
        waitUntil: (promise: Promise<unknown>) => void handed.push(promise),
        passThroughOnException: () => undefined,
      };

      const answer = await worker.fetch(
        new Request(`${ORIGIN}${PICTURES}`, {
          method: 'POST',
          headers: {
            Origin: ORIGIN,
            Cookie: holder,
            'Content-Type': ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
            'Content-Length': String(file.length),
            'Sec-Fetch-Site': 'same-origin',
          },
          body: file,
        }) as never,
        env as never,
        context as never,
      );
      await Promise.all(handed);

      expect(answer.status).toBe(201);
      const body = (await answer.json()) as { message: { id: number; picture: Record<string, unknown> | null } };
      const pictures = (await createRoomPictureStore(db).listAllWithPictures(null, 10)).filter(
        (message) => message.picture !== null,
      );
      // The stored message, and the one the answer names.
      expect(pictures).toHaveLength(1);
      expect(pictures[0]).toMatchObject({
        id: body.message.id,
        author: HOLDER,
        picture: { type: 'gif', width: 16, height: 16, state: 'ok' },
      });
      expect(body.message.picture).toMatchObject({ type: 'gif', width: 16, height: 16 });
      // The stored bytes are the server's own serialisation, under the row's key.
      expect([...held.keys()]).toEqual([pictures[0]?.picture?.key]);
    });
  });

  describe("the sweep of the pictures' owed bytes in the social step", () => {
    const count = async () =>
      (await db.prepare('SELECT COUNT(*) AS n FROM room_messages').first<{ n: number }>())?.n ?? -1;

    beforeEach(async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await db
        .prepare(
          `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
           INSERT INTO room_messages (at, author, text) SELECT '2026-10-01T00:00:00.000Z', ?2, 'line ' || i FROM n`,
        )
        .bind(ROOM_KEEP + 3, SOMEONE)
        .run();
    });

    it('stands before the prune: while the sweep has work the prune waits, and runs once the sweep is idle', async () => {
      const { env } = envWith({ SOCIAL_ENABLED: 'false', [ROOM_ENABLED_VAR]: 'false' });

      sweep.outcome = 'more';
      for (let step = 0; step < 8; step += 1) await runCron(SOCIAL_CRON, env as never);

      expect(sweep.runs).toBeGreaterThan(0);
      expect(await count()).toBe(ROOM_KEEP + 3);

      sweep.outcome = 'idle';
      for (let step = 0; step < 8 && (await count()) > ROOM_KEEP; step += 1) await runCron(SOCIAL_CRON, env as never);

      expect(await count()).toBe(ROOM_KEEP);
    });

    it('lets the step go on to the prune when a run of the sweep failed', async () => {
      const { env } = envWith();

      sweep.outcome = 'failed';
      for (let step = 0; step < 8 && (await count()) > ROOM_KEEP; step += 1) await runCron(SOCIAL_CRON, env as never);

      expect(sweep.runs).toBeGreaterThan(0);
      expect(await count()).toBe(ROOM_KEEP);
    });

    it("is built from the pictures' store and the bytes, whatever the switches say", async () => {
      const { kv, calls } = fakeKv();
      const { env } = envWith({
        SOCIAL_ENABLED: 'false',
        [ROOM_ENABLED_VAR]: 'false',
        [ROOM_PICTURES_ENABLED_VAR]: 'false',
        [ROOM_PICTURES_KV_BINDING]: kv,
      });

      sweep.deps = null;
      await runCron(SOCIAL_CRON, env as never);

      // The step builds its jobs at every run, whichever of them then has work.
      const built = ((): RoomPictureSweepJobDeps | null => sweep.deps)();
      expect(built).not.toBeNull();
      expect(await built?.pictures.listOwedDeletes(10)).toEqual([]);
      await built?.bytes.delete('pic/000000000000000000000000000000bb');
      expect(calls).toEqual([{ method: 'delete', args: ['pic/000000000000000000000000000000bb'] }]);
    });

    // engine-runtime builds the job (packages/runtime/src/social/room-picture-sweep.ts) beside this round.
    // Until its export is where the entry reads it, the entry runs the social step without the sweep.
    it('is the job the runtime exports beside its other social jobs', async () => {
      const runtime = await vi.importActual<Record<string, unknown>>('@prix/runtime/social/index');

      expect(typeof runtime.createRoomPictureSweepJob, ROOM_PICTURE_SWEEP_JOB).toBe('function');
    });
  });
});
