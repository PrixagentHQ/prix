import { env as baseEnv } from 'cloudflare:workers';
import {
  ROOM_DAILY_CAP_VAR,
  ROOM_ENABLED_VAR,
  ROOM_PICTURE_RATE_BINDING,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
  ROOM_PICTURES_ADMIN_PATH,
  ROOM_PICTURES_ENABLED_VAR,
  ROOM_PICTURES_KV_BINDING,
  ROOM_PICTURES_PATH,
  roomPictureAdminPath,
  roomPictureHeaders,
  roomPicturePath,
  roomPictureReportPath,
  roomResponseSchema,
  roomWithPicturesResponseSchema,
  SESSION_COOKIE,
} from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, newSessionToken } from '../../apps/api/src/http/session.ts';
import worker from '../../apps/api/src/index.ts';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import { ADMIN, SITE } from './api/harness.ts';
import { db } from './support/d1.ts';
import { GIF_SCRIPT, GIF_SMALLEST, gifTinted, hex, JPEG_EXIF } from './support/picture-files.ts';
import { emptyPictureTables, pictureRows } from './support/pictures.ts';

/**
 * Pictures through the Worker's entry itself (docs/contracts/phase-6-pictures.md sections 0, 5, 7 and 10,
 * at revision 3): `worker.fetch(request, env, ctx)` on the local D1, with a KV and a Cache API of the
 * test's own that write down every call.
 *
 * The bytes never enter the Cache API: no key, no `put`, no `match`. A HEAD never runs a bytes route. Of
 * the paths at and under the pictures' path, only the upload that answered 201 drops the room's cached
 * read. And while ROOM_PICTURES_ENABLED is "false", as this round leaves it, nothing of pictures answers.
 *
 * The token service is the runtime's own with one seam: a test hands in the holding it answers, so that no
 * chain is read.
 */

const own = vi.hoisted(() => ({
  holdingOf: null as ((address: string) => Promise<{ gatingOn: boolean; tokens: number }>) | null,
}));
vi.mock('@prix/runtime/token/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prix/runtime/token/service')>();
  return {
    ...actual,
    createTokenService: (deps: Parameters<typeof actual.createTokenService>[0]) => {
      const service = actual.createTokenService(deps);
      return {
        ...service,
        holdingOf: (address: string, options?: Parameters<typeof service.holdingOf>[1]) =>
          own.holdingOf === null ? service.holdingOf(address, options) : own.holdingOf(address),
      };
    },
  };
});

const ROOM = '/api/social/room';
const WRITER = '0x00000000000000000000000000000000000007c3';
const REPORTER = '0x00000000000000000000000000000000000007c4';

/** A Cache API that writes down every call it gets, with the key it was asked for. */
class RecordingCache {
  readonly calls: { method: 'match' | 'put' | 'delete'; key: string }[] = [];
  private readonly held = new Map<string, Response>();

  private keyOf(key: RequestInfo | URL): string {
    return typeof key === 'string' ? key : key instanceof URL ? key.href : key.url;
  }

  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    this.calls.push({ method: 'match', key: this.keyOf(key) });
    return this.held.get(this.keyOf(key))?.clone();
  }

  async put(key: RequestInfo | URL, response: Response): Promise<void> {
    this.calls.push({ method: 'put', key: this.keyOf(key) });
    this.held.set(this.keyOf(key), new Response(await response.arrayBuffer(), response));
  }

  async delete(key: RequestInfo | URL): Promise<boolean> {
    this.calls.push({ method: 'delete', key: this.keyOf(key) });
    return this.held.delete(this.keyOf(key));
  }

  has(path: string): boolean {
    return this.held.has(`${SITE}${path}`);
  }

  of(method: 'match' | 'put' | 'delete'): string[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.key);
  }
}

/** A KV that writes down every call. */
function recordingKv() {
  const calls: { method: string; key: string; options?: unknown }[] = [];
  const held = new Map<string, ArrayBuffer>();
  return {
    calls,
    held,
    kv: {
      put: async (key: string, value: ArrayBuffer, options: unknown) => {
        calls.push({ method: 'put', key, options });
        held.set(key, value.slice(0));
      },
      get: async (key: string) => {
        calls.push({ method: 'get', key });
        return held.get(key)?.slice(0) ?? null;
      },
      delete: async (key: string) => {
        calls.push({ method: 'delete', key });
        held.delete(key);
      },
    },
  };
}

interface Reached {
  limiter: number;
  statements: number;
}

/** A fresh env each time, so that the entry builds its wiring again: the room on, pictures on unless a test says otherwise. */
function entry(extra: Record<string, unknown> = {}) {
  const reached: Reached = { limiter: 0, statements: 0 };
  const counted = {
    limit: async () => {
      reached.limiter += 1;
      return { success: true };
    },
  };
  const watched = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          reached.statements += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const store = recordingKv();
  const env = {
    ...(baseEnv as unknown as Record<string, unknown>),
    DB: watched,
    SITE_ORIGIN: SITE,
    ADMIN_ADDRESSES: ADMIN,
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET: btoa('n'.repeat(32)),
    RATE_SIGN_IN: counted,
    RATE_WRITE: counted,
    RATE_READ: counted,
    [ROOM_PICTURE_RATE_BINDING]: counted,
    SOCIAL_ENABLED: 'true',
    [ROOM_ENABLED_VAR]: 'true',
    [ROOM_DAILY_CAP_VAR]: '400',
    [ROOM_PICTURES_ENABLED_VAR]: 'true',
    [ROOM_PICTURES_KV_BINDING]: store.kv,
    ...extra,
  };
  return { env, reached, kv: store };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

async function call(env: Record<string, unknown>, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await worker.fetch(new Request(`${SITE}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  return response;
}

/** A session cookie for `address`, stored as the sign-in route stores one, on the real clock the entry reads. */
async function sessionFor(address: string): Promise<string> {
  const token = newSessionToken();
  const now = Date.now();
  const store = createD1Store(db);
  await store.putSession({
    tokenHash: await hashToken(token),
    address,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  });
  await store.touchUser(address, '2020-01-01T00:00:00.000Z');
  return `${SESSION_COOKIE}=${token}`;
}

/** A wallet whose first message has stood in the chat for two days: it may upload and report. */
async function writerFor(address: string): Promise<string> {
  await createRoomStore(db).putMessage(address, 'a first line', new Date(Date.now() - 2 * 86_400_000).toISOString());
  return sessionFor(address);
}

const uploadOf = (cookie: string, file: Uint8Array): RequestInit => ({
  method: 'POST',
  headers: {
    Origin: SITE,
    Cookie: cookie,
    'Content-Type': ROOM_PICTURE_UPLOAD_CONTENT_TYPE,
    'Content-Length': String(file.length),
    'Sec-Fetch-Site': 'same-origin',
  },
  body: file,
});
const writeOf = (method: string, cookie: string): RequestInit => ({
  method,
  headers: { Origin: SITE, 'Content-Type': 'application/json', Cookie: cookie },
});
const imageOf = (cookie?: string): RequestInit => ({
  headers: {
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Dest': 'image',
    ...(cookie === undefined ? {} : { Cookie: cookie }),
  },
});

let cache: RecordingCache;

beforeEach(async () => {
  await emptyPictureTables(db);
  cache = new RecordingCache();
  vi.stubGlobal('caches', { default: cache });
  own.holdingOf = async () => ({ gatingOn: true, tokens: 1 });
  for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});
afterEach(() => {
  own.holdingOf = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the bytes and the Cache API', () => {
  it("never meet: an upload, the bytes, a HEAD, a report and the admin's look ask the cache for no key of a picture", async () => {
    const { env, kv } = entry();
    const writer = await writerFor(WRITER);
    const reporter = await writerFor(REPORTER);
    const admin = await sessionFor(ADMIN);

    // The room's read is stored, as on any day.
    expect((await call(env, ROOM)).status).toBe(200);
    expect(cache.has(ROOM)).toBe(true);

    const uploaded = await call(env, ROOM_PICTURES_PATH, uploadOf(writer, JPEG_EXIF));
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { message } = (await uploaded.json()) as { message: { id: number } };
    const path = roomPicturePath(message.id);

    for (let n = 0; n < 3; n += 1) {
      const shown = await call(env, path, imageOf());
      expect(shown.status).toBe(200);
      // What a cache would store if it were asked to: the answer forbids it by itself too.
      expect(shown.headers.get('Cache-Control')).toBe('private, no-store');
      await shown.arrayBuffer();
    }
    expect((await call(env, path, { method: 'HEAD', ...imageOf() })).status).toBe(405);
    expect((await call(env, path)).status).toBe(404);
    expect((await call(env, `${path}?x=1`, imageOf())).status).toBe(200);
    expect((await call(env, roomPictureReportPath(message.id), writeOf('POST', reporter))).status).toBe(204);
    expect((await call(env, roomPictureAdminPath(message.id), imageOf(admin))).status).toBe(200);
    expect((await call(env, roomPictureAdminPath(message.id), { method: 'HEAD', ...imageOf(admin) })).status).toBe(404);
    expect((await call(env, ROOM_PICTURES_ADMIN_PATH, { headers: { Cookie: admin } })).status).toBe(200);

    // No key, no put, no match and no delete of anything at or under either path of pictures.
    const touched = cache.calls.filter((entry) => entry.key.includes('/pictures'));
    expect(touched).toEqual([]);
    expect(cache.of('put')).toEqual([`${SITE}${ROOM}`]);
    // Every read of the bytes went to KV: none was answered from a cache.
    expect(kv.calls.filter((entry) => entry.method === 'get')).toHaveLength(5);
  });

  it("serves the bytes through the entry with exactly the contract's headers, and nothing the entry adds", async () => {
    const { env, kv } = entry();
    const writer = await writerFor(WRITER);
    const uploaded = await call(env, ROOM_PICTURES_PATH, uploadOf(writer, GIF_SCRIPT));
    const { message } = (await uploaded.json()) as { message: { id: number } };

    const shown = await call(env, roomPicturePath(message.id), imageOf());

    expect(shown.status).toBe(200);
    const sent = [...shown.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]).sort();
    const wanted = Object.entries(roomPictureHeaders(message.id, 'gif', GIF_SCRIPT.length))
      .map(([name, value]) => [name.toLowerCase(), value])
      .sort();
    expect(sent).toEqual(wanted);
    expect(hex(new Uint8Array(await shown.arrayBuffer()))).toBe(hex(GIF_SCRIPT));
    // The put the entry's own port made: an ArrayBuffer under a key of its own, with the seven days.
    const puts = kv.calls.filter((entry) => entry.method === 'put');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.options).toEqual({ expirationTtl: ROOM_PICTURE_TTL_SECONDS });
    expect(puts[0]?.key).toBe((await pictureRows(db))[0]?.pic_key);
    // The same file asked for as a script, a page or a worker: the generic 404.
    for (const dest of ['script', 'document', 'worker', 'style']) {
      const refused = await call(env, roomPicturePath(message.id), {
        headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': dest },
      });
      expect(refused.status, dest).toBe(404);
      expect(await refused.text(), dest).not.toContain('planted');
    }
  });

  it('answers a picture where there is no cache at all, as where there is one', async () => {
    vi.stubGlobal('caches', undefined);
    const { env } = entry();
    const writer = await writerFor(WRITER);
    const uploaded = await call(env, ROOM_PICTURES_PATH, uploadOf(writer, GIF_SMALLEST));
    const { message } = (await uploaded.json()) as { message: { id: number } };

    expect(uploaded.status).toBe(201);
    expect((await call(env, roomPicturePath(message.id), imageOf())).status).toBe(200);
    expect((await call(env, roomPicturePath(message.id), { method: 'HEAD' })).status).toBe(405);
  });
});

describe('a HEAD of a bytes path', () => {
  it("never runs a route: 405 with Allow: GET for the public path, the generic 404 for the admin's, and nothing is asked", async () => {
    const { env, reached, kv } = entry();
    const unknown = await call(env, '/api/no-such-path', { method: 'HEAD' });
    const asked = { ...reached };

    for (const segment of ['12', '1', 'abc', '0', 'off']) {
      const open = await call(env, `${ROOM_PICTURES_PATH}/${segment}`, { method: 'HEAD', ...imageOf() });
      expect(open.status, segment).toBe(405);
      expect(open.headers.get('Allow'), segment).toBe('GET');
      expect(await open.text(), segment).toBe('');

      const look = await call(env, `${ROOM_PICTURES_ADMIN_PATH}/${segment}`, { method: 'HEAD', ...imageOf() });
      expect(look.status, segment).toBe(404);
      expect([...look.headers.entries()].sort(), segment).toEqual([...unknown.headers.entries()].sort());
    }

    expect(reached).toEqual(asked);
    expect(kv.calls).toEqual([]);
    expect(cache.calls.filter((entry) => entry.key.includes('/pictures'))).toEqual([]);
  });

  it('is the generic 404 for the public path too while pictures are not enabled, like a GET', async () => {
    const { env, reached } = entry({ [ROOM_PICTURES_ENABLED_VAR]: 'false' });

    const head = await call(env, `${ROOM_PICTURES_PATH}/12`, { method: 'HEAD', ...imageOf() });
    const get = await call(env, `${ROOM_PICTURES_PATH}/12`, imageOf());

    expect([head.status, get.status]).toEqual([404, 404]);
    expect(head.headers.get('Allow')).toBeNull();
    expect(reached.statements).toBe(0);
  });
});

describe("what drops the room's cached read", () => {
  it('is the upload that answered 201, and no refused upload and no report, whatever it answered', async () => {
    const { env } = entry();
    const writer = await writerFor(WRITER);
    const reporter = await writerFor(REPORTER);
    const room = `${SITE}${ROOM}`;
    const readAgain = async (): Promise<void> => {
      expect((await call(env, ROOM)).status).toBe(200);
      expect(cache.has(ROOM)).toBe(true);
    };

    await readAgain();
    // Refused: a file that is no picture, a visitor, and a second upload inside the twenty seconds.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(64, ' '));
    expect((await call(env, ROOM_PICTURES_PATH, uploadOf(writer, svg))).status).toBe(400);
    expect((await call(env, ROOM_PICTURES_PATH, uploadOf('nobody=1', GIF_SMALLEST))).status).toBe(401);
    expect(cache.of('delete')).toEqual([]);

    const uploaded = await call(env, ROOM_PICTURES_PATH, uploadOf(writer, GIF_SMALLEST));
    expect(uploaded.status).toBe(201);
    expect(cache.of('delete')).toEqual([room]);
    expect(cache.has(ROOM)).toBe(false);
    const { message } = (await uploaded.json()) as { message: { id: number } };

    await readAgain();
    expect((await call(env, ROOM_PICTURES_PATH, uploadOf(writer, gifTinted(3)))).status).toBe(429);
    // A counted report, then the same report three times more: each a 204 that nothing of the day bounds.
    for (let n = 0; n < 4; n += 1) {
      expect((await call(env, roomPictureReportPath(message.id), writeOf('POST', reporter))).status).toBe(204);
    }
    expect((await call(env, roomPictureReportPath(message.id + 50), writeOf('POST', reporter))).status).toBe(404);
    expect((await call(env, roomPicturePath(message.id), imageOf())).status).toBe(200);

    expect(cache.of('delete')).toEqual([room]);
    expect(cache.has(ROOM)).toBe(true);
  });

  it("is every write of an admin under the room's admin prefix: a keep and the two of the switch among them", async () => {
    const { env } = entry();
    const writer = await writerFor(WRITER);
    const admin = await sessionFor(ADMIN);
    const uploaded = await call(env, ROOM_PICTURES_PATH, uploadOf(writer, GIF_SMALLEST));
    const { message } = (await uploaded.json()) as { message: { id: number } };

    for (const [method, path] of [
      ['PUT', `${ROOM_PICTURES_ADMIN_PATH}/${message.id}/keep`],
      ['PUT', `${ROOM_PICTURES_ADMIN_PATH}/off`],
      ['DELETE', `${ROOM_PICTURES_ADMIN_PATH}/off`],
      ['DELETE', `/api/social/admin/room/messages/${message.id}`],
    ] as const) {
      expect((await call(env, ROOM)).status).toBe(200);
      expect(cache.has(ROOM), `${method} ${path}`).toBe(true);
      expect((await call(env, path, writeOf(method, admin))).status, `${method} ${path}`).toBe(204);
      expect(cache.has(ROOM), `${method} ${path}`).toBe(false);
    }
  });
});

describe('while ROOM_PICTURES_ENABLED is "false", as this round leaves it', () => {
  it('answers the upload, the bytes and the report as unknown paths, and reads no byte of a body', async () => {
    const seeded = entry();
    const writer = await writerFor(WRITER);
    const uploaded = await call(seeded.env, ROOM_PICTURES_PATH, uploadOf(writer, GIF_SMALLEST));
    const { message } = (await uploaded.json()) as { message: { id: number } };
    const { env, kv } = entry({ [ROOM_PICTURES_ENABLED_VAR]: 'false' });

    const answers = [
      await call(env, ROOM_PICTURES_PATH, uploadOf(writer, gifTinted(2))),
      await call(env, roomPicturePath(message.id), imageOf()),
      await call(env, roomPictureReportPath(message.id), writeOf('POST', writer)),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404]);
    expect(kv.calls).toEqual([]);
    expect(await pictureRows(db)).toHaveLength(1);
  });

  it("answers the room's read as Phase 6.3 does, with no picture message and no word of pictures", async () => {
    const seeded = entry();
    const writer = await writerFor(WRITER);
    expect((await call(seeded.env, ROOM_PICTURES_PATH, uploadOf(writer, GIF_SMALLEST))).status).toBe(201);
    const on = await call(seeded.env, ROOM);
    expect(roomWithPicturesResponseSchema.parse(await on.json()).pictures).toBe('on');
    await cache.delete(`${SITE}${ROOM}`);

    const off = await call(entry({ [ROOM_PICTURES_ENABLED_VAR]: 'false' }).env, ROOM);

    const text = await off.text();
    expect(roomResponseSchema.parse(JSON.parse(text)).messages.map((message) => message.text)).toEqual([
      'a first line',
    ]);
    expect(text).not.toContain('picture');
  });

  it('still deletes the bytes at a hide, and answers 204 with no KV binding at all, as wrangler.jsonc has it today', async () => {
    const seeded = entry();
    const writer = await writerFor(WRITER);
    const admin = await sessionFor(ADMIN);
    const first = (await (await call(seeded.env, ROOM_PICTURES_PATH, uploadOf(writer, GIF_SMALLEST))).json()) as {
      message: { id: number };
    };
    const key = (await pictureRows(db))[0]?.pic_key;

    const bound = entry({ [ROOM_PICTURES_ENABLED_VAR]: 'false', [ROOM_PICTURES_KV_BINDING]: seeded.kv.kv });
    expect(
      (await call(bound.env, `/api/social/admin/room/messages/${first.message.id}`, writeOf('DELETE', admin))).status,
    ).toBe(204);
    expect(seeded.kv.calls.filter((entry) => entry.method === 'delete').map((entry) => entry.key)).toEqual([key]);
    expect((await pictureRows(db))[0]).toMatchObject({ pic_state: 'removed', pic_key: null });

    // With no binding: the answer is the same, and the delete stays owed.
    await emptyPictureTables(db);
    const again = await writerFor(WRITER);
    const adminAgain = await sessionFor(ADMIN);
    const second = (await (await call(entry().env, ROOM_PICTURES_PATH, uploadOf(again, GIF_SMALLEST))).json()) as {
      message: { id: number };
    };
    const unbound = entry({ [ROOM_PICTURES_ENABLED_VAR]: 'false', [ROOM_PICTURES_KV_BINDING]: undefined });
    expect(
      (await call(unbound.env, `/api/social/admin/room/messages/${second.message.id}`, writeOf('DELETE', adminAgain)))
        .status,
    ).toBe(204);
    const row = (await pictureRows(db))[0];
    expect(row?.pic_state).toBe('removed');
    expect(row?.pic_key).toMatch(/^pic\//);
  });
});

describe('the 16,384 bytes through the entry', () => {
  it('hold on every path but the upload of a picture', async () => {
    const { env } = entry();
    const writer = await writerFor(WRITER);
    const large = (method: string): RequestInit => ({
      method,
      headers: { Origin: SITE, 'Content-Type': 'application/json', Cookie: writer, 'Content-Length': '16385' },
      body: 'x'.repeat(16_385),
    });

    for (const [method, path] of [
      ['POST', ROOM],
      ['POST', `${ROOM_PICTURES_PATH}/12/report`],
      ['PUT', ROOM_PICTURES_PATH],
      ['PUT', `${ROOM_PICTURES_ADMIN_PATH}/off`],
    ] as const) {
      const answer = await call(env, path, large(method));
      expect(answer.status, `${method} ${path}`).toBe(400);
      expect(((await answer.json()) as { error: { code: string } }).error.code).toBe('invalid_input');
    }
    // The upload of 20,000 bytes is judged by its own rule: it is no picture, and not "too large".
    const upload = await call(env, ROOM_PICTURES_PATH, uploadOf(writer, new Uint8Array(20_000)));
    expect(upload.status).toBe(400);
    expect(((await upload.json()) as { error: { field: string } }).error.field).toBe('picture_type');
  });
});
