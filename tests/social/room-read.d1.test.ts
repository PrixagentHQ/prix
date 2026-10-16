import { env as baseEnv } from 'cloudflare:workers';
import {
  ROOM_DAILY_CAP_VAR,
  ROOM_ENABLED_VAR,
  ROOM_PAGE,
  ROOM_SCAN,
  ROOM_WRITE_MIN_TOKENS,
  roomMessageSchema,
  roomResponseSchema,
  roomStatusResponseSchema,
  SESSION_COOKIE,
} from '@prix/contracts';
import { resetTokenMemory } from '@prix/runtime/token/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../apps/api/src/index.ts';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import { createRoomPictureStore } from '../../apps/api/src/store/room-pictures.ts';
import type { RoomHarness } from './api/harness.ts';
import { ADMIN, createRoomHarness, emptyRoomTables, recordStatements, SITE } from './api/harness.ts';
import { db, storesOn } from './support/d1.ts';

/**
 * What the room publishes (docs/contracts/phase-6-room.md sections 3, 6 and 13), on a local D1.
 *
 * The first part goes through the real routes and the real store: a hidden message, a muted writer's
 * messages and a message at or before a cut are in no public response, also after the mute is lifted; no
 * public response holds a whole address; `admin` is the server's; a stored text is answered as text; the
 * read ignores every query and never reads below the newest ROOM_SCAN ids.
 *
 * The second part goes through what the Worker's entry exports, its `fetch`: one cache key for the read
 * whatever the query, and a HEAD of the read and of the status that never reaches the route.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const PRIX = '0xa74ac6e9f2f8493344923c23972d496364241044';
const WRITER = '0x00000000000000000000000000000000000005b2';
const MUTED = '0x00000000000000000000000000000000000005b3';
const THIRD = '0x00000000000000000000000000000000000005b4';
const ROOM = '/api/social/room';
const STATUS = '/api/social/room/status';

const metered = recordStatements(db);
const plainRoom = createRoomStore(db);

function world(options: Parameters<typeof createRoomHarness>[1] = {}): RoomHarness {
  const h = createRoomHarness(
    // From Phase 6.4 on the admin's hide and mute go through the pictures' store, whatever the switch of
    // pictures says: the real one, on the same counted database.
    { ...storesOn(metered.db), room: createRoomStore(metered.db), pictures: createRoomPictureStore(metered.db) },
    { now: NOW, prixAddress: PRIX, ...options },
  );
  for (const writer of [WRITER, MUTED, THIRD]) h.holdings.set(writer, ROOM_WRITE_MIN_TOKENS);
  return h;
}

const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
const hidePath = (id: number): string => `/api/social/admin/room/messages/${id}`;
const mutePath = (id: number): string => `/api/social/admin/room/messages/${id}/mute`;

/** The texts of the public read, newest first, checked against the contract's strict schema. */
async function shown(h: RoomHarness, query = ''): Promise<string[]> {
  const reply = await h.fetch('GET', `${ROOM}${query}`);
  expect(reply.status, reply.text).toBe(200);
  return roomResponseSchema.parse(reply.json).messages.map((message) => message.text);
}

/** Every response that was not for an admin's route: what the public can ever be sent. */
const publicTranscript = (h: RoomHarness): string =>
  h.transcript.filter((entry) => !/^\w+ \/api\/social\/admin\//.test(entry)).join('\n');

/** `count` messages of `author` with rising ids, in one statement. */
async function fill(
  count: number,
  author: string = WRITER,
  label = 'line',
): Promise<{ oldest: number; newest: number }> {
  await db
    .prepare(
      `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, ?4 || ' ' || i FROM n`,
    )
    .bind(count, NOW, author, label)
    .run();
  const edge = await db.prepare('SELECT MAX(id) AS newest FROM room_messages').first<{ newest: number }>();
  const newest = edge?.newest ?? 0;
  return { oldest: newest - count + 1, newest };
}

beforeEach(async () => {
  await emptyRoomTables(db);
  metered.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('what no public response holds', () => {
  it("leaves out a hidden message, a muted writer's messages and a message at or before a cut, also after the mute is lifted", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const h = world();
    const admin = await h.signIn(ADMIN);
    const writer = await h.signIn(WRITER);
    const muted = await h.signIn(MUTED);
    const third = await h.signIn(THIRD);
    const post = async (cookie: string, text: string): Promise<number> => {
      const reply = await h.fetch('POST', ROOM, { cookie, body: { text } });
      expect(reply.status, reply.text).toBe(201);
      return reply.json.message.id as number;
    };

    await post(writer, 'kept line one');
    const beforeMute = await post(muted, 'said before the mute');
    const toHide = await post(third, 'this line gets hidden');
    expect(await shown(h)).toEqual(['this line gets hidden', 'said before the mute', 'kept line one']);

    h.setNow(at(60));
    expect((await h.fetch('DELETE', hidePath(toHide), { cookie: admin })).status).toBe(204);
    expect((await h.fetch('PUT', mutePath(beforeMute), { cookie: admin })).status).toBe(204);
    await post(writer, 'kept line two');

    // Hidden, and its writer muted now.
    expect(await shown(h)).toEqual(['kept line two', 'kept line one']);
    // A message that reached the table at the very time of the mute, or before it, is cut with the rest.
    await plainRoom.putMessage(MUTED, 'stored at the very time of the mute', at(60));
    expect(await shown(h)).toEqual(['kept line two', 'kept line one']);

    // The mute is lifted: what the writer wrote at or before the mute stays out, a new line shows.
    h.setNow(at(120));
    expect((await h.fetch('DELETE', mutePath(beforeMute), { cookie: admin })).status).toBe(204);
    expect(await shown(h)).toEqual(['kept line two', 'kept line one']);
    await post(muted, 'said after the lift');
    expect(await shown(h)).toEqual(['said after the lift', 'kept line two', 'kept line one']);

    // A second mute moves the cut: the line after the first lift goes too, and stays out after the second lift.
    h.setNow(at(180));
    expect((await h.fetch('PUT', mutePath(beforeMute), { cookie: admin })).status).toBe(204);
    expect(await shown(h)).toEqual(['kept line two', 'kept line one']);
    expect((await h.fetch('DELETE', mutePath(beforeMute), { cookie: admin })).status).toBe(204);
    expect(await shown(h)).toEqual(['kept line two', 'kept line one']);

    // The writers' own reads and the read with a query say no more.
    await h.fetch('GET', `${ROOM}/me`, { cookie: muted });
    await h.fetch('GET', `${ROOM}/me`, { cookie: third });
    await h.fetch('GET', `${ROOM}?before=${toHide + 1}&hidden=1&all=true`);
    await h.fetch('GET', STATUS);
    const afterEverything = h.transcript.length;
    // From the time each line was taken away, no public response held it again.
    const sinceHidden = h.transcript
      .slice(h.transcript.findIndex((entry) => entry.startsWith(`DELETE ${hidePath(toHide)} `)))
      .filter((entry) => !/^\w+ \/api\/social\/admin\//.test(entry))
      .join('\n');
    expect(afterEverything).toBeGreaterThan(20);
    expect(sinceHidden).not.toContain('this line gets hidden');
    expect(sinceHidden).not.toContain('said before the mute');
    expect(sinceHidden).not.toContain('stored at the very time of the mute');
    expect(sinceHidden).toContain('kept line two');
  });

  it('shows a line written one millisecond after the cut, and not the one at the cut', async () => {
    const h = world();
    const cut = at(60);
    await plainRoom.putMessage(MUTED, 'at the cut', cut);
    await plainRoom.muteWriter(MUTED, ADMIN, cut);
    await plainRoom.unmuteWriter(MUTED);
    await plainRoom.putMessage(MUTED, 'just after the cut', new Date(Date.parse(cut) + 1).toISOString());

    expect(await shown(h)).toEqual(['just after the cut']);
  });

  it('leaves an admin muted before it became one out of the read until its mute is lifted, and what it wrote while muted after the lift too', async () => {
    const h = world();
    const message = await plainRoom.putMessage(ADMIN, 'a line of the admin', NOW);
    await plainRoom.muteWriter(ADMIN, ADMIN, at(-60));

    expect(await shown(h)).toEqual([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect((await h.fetch('DELETE', mutePath(message.id), { cookie: await h.signIn(ADMIN) })).status).toBe(204);
    // Revision 5: the lift moves the cut to the writer's newest message, so the line written while the
    // mute was on stays out, as for any writer (section 3); what the admin writes from now on shows.
    expect(await shown(h)).toEqual([]);
    await plainRoom.putMessage(ADMIN, 'a line of the admin after the lift', at(1));
    expect(await shown(h)).toEqual(['a line of the admin after the lift']);
  });

  it('holds no whole address in any public response: a writer is its short address', async () => {
    const h = world();
    const writer = await h.signIn(WRITER);
    const posted = await h.fetch('POST', ROOM, { cookie: writer, body: { text: `the only address is ${PRIX}` } });
    expect(posted.status, posted.text).toBe(201);
    await plainRoom.putMessage(ADMIN, 'a line of the admin', at(1));
    await plainRoom.muteWriter(THIRD, ADMIN, at(2));

    const read = await h.fetch('GET', ROOM);
    await h.fetch('GET', `${ROOM}/me`, { cookie: writer });
    await h.fetch('GET', STATUS);
    await h.fetch('POST', ROOM, { cookie: writer, body: { text: 'too soon after the first' } });
    await h.fetch('POST', ROOM, { cookie: await h.signIn(THIRD), body: { text: 'a line while muted' } });

    const answer = roomResponseSchema.parse(read.json);
    for (const message of answer.messages) {
      // Exactly the fields of the contract's message: no author, no hiding, nothing of the stored row.
      expect(Object.keys(message).sort()).toEqual(['admin', 'at', 'authorShort', 'id', 'text']);
      expect(message.authorShort).not.toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(message.authorShort.length).toBeLessThan(20);
    }
    expect(answer.messages.map((message) => message.authorShort)).toEqual([
      `${ADMIN.slice(0, 6)}…${ADMIN.slice(-4)}`,
      `${WRITER.slice(0, 6)}…${WRITER.slice(-4)}`,
    ]);
    expect(Object.keys(read.json).sort()).toEqual(['messages', 'on', 'prixAddress', 'siteHost']);
    // The one whole address a public response may hold is the token's own.
    const everything = publicTranscript(h).replaceAll(PRIX, '');
    expect(h.transcript.length).toBeGreaterThanOrEqual(5);
    expect(everything).not.toMatch(/0x[0-9a-fA-F]{40}/);
    for (const address of [WRITER, ADMIN, THIRD]) expect(everything.toLowerCase()).not.toContain(address.slice(2));
  });
});

describe('the admin mark', () => {
  it("is true for an admin's address only, in upper case or lower, in the list or in the stored row", async () => {
    const upper = `0x${ADMIN.slice(2).toUpperCase()}`;
    for (const [listed, stored] of [
      [ADMIN, ADMIN],
      [upper, ADMIN],
      [ADMIN, upper],
    ] as const) {
      await emptyRoomTables(db);
      const h = world({ adminAddresses: [listed] });
      await db
        .prepare('INSERT INTO room_messages (at, author, text) VALUES (?1, ?2, ?3)')
        .bind(NOW, stored, 'of the admin')
        .run();
      await plainRoom.putMessage(WRITER, 'of a holder', at(1));

      const reply = await h.fetch('GET', ROOM);

      const marks = roomResponseSchema.parse(reply.json).messages.map(({ text, admin }) => [text, admin]);
      expect(marks, `${listed} listed, ${stored} stored`).toEqual([
        ['of a holder', false],
        ['of the admin', true],
      ]);
    }
  });

  it('is nobody else: an address that only starts and ends as the admin is not marked', async () => {
    const h = world();
    // The short form of this address is the admin's own short form.
    const lookalike = `${ADMIN.slice(0, 6)}${'f'.repeat(32)}${ADMIN.slice(-4)}`;
    await plainRoom.putMessage(lookalike, 'ground to look like the admin', NOW);

    const [message] = roomResponseSchema.parse((await h.fetch('GET', ROOM)).json).messages;

    expect(message?.authorShort).toBe(`${ADMIN.slice(0, 6)}…${ADMIN.slice(-4)}`);
    expect(message?.admin).toBe(false);
  });

  it('cannot be typed: a body that carries it is refused, and a message that says it is not marked', async () => {
    const h = world();
    const writer = await h.signIn(WRITER);

    const typed = await h.fetch('POST', ROOM, { cookie: writer, body: { text: 'gm all', admin: true } });
    const said = await h.fetch('POST', ROOM, { cookie: writer, body: { text: 'admin: true, or so this line says' } });

    expect(typed.status).toBe(400);
    expect(said.status, said.text).toBe(201);
    expect(roomMessageSchema.parse(said.json.message).admin).toBe(false);
    expect(roomResponseSchema.parse((await h.fetch('GET', ROOM)).json).messages.map(({ admin }) => admin)).toEqual([
      false,
    ]);
  });
});

describe('a message is text', () => {
  const MARKUP = `<script>alert(1)</script> <img src=x onerror=1> & "double" 'single' </textarea>`;

  it('refuses a text with markup in it, so that none is stored', async () => {
    const h = world();
    const writer = await h.signIn(WRITER);

    for (const text of [MARKUP, '<b>bold</b>', 'gm <!-- note -->', 'see <a href=x>this</a>']) {
      const reply = await h.fetch('POST', ROOM, { cookie: writer, body: { text } });
      expect(reply.status, text).toBe(400);
      expect(reply.json.error.field, text).toBe('text_characters');
    }

    expect(await shown(h)).toEqual([]);
  });

  it('answers a stored text as text: the very characters, in a JSON answer that no browser reads as a page', async () => {
    const h = world();
    // A row that reached the table by another way than the route: the read still answers it as a string.
    await db
      .prepare('INSERT INTO room_messages (at, author, text) VALUES (?1, ?2, ?3)')
      .bind(NOW, WRITER, MARKUP)
      .run();

    const reply = await h.fetch('GET', ROOM);

    expect(reply.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(reply.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(roomResponseSchema.parse(reply.json).messages.map((message) => message.text)).toEqual([MARKUP]);
    // The body is the JSON of the answer and nothing around it.
    expect(reply.text).toBe(JSON.stringify(reply.json));
  });
});

describe('the public read', () => {
  it('answers the status while the room is on', async () => {
    const reply = await world().fetch('GET', STATUS);

    expect(roomStatusResponseSchema.parse(reply.json)).toEqual({ on: true });
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
  });

  it('answers the newest ROOM_PAGE messages, newest first, with the one address and the one host, and reads no session', async () => {
    const h = world();
    const { newest } = await fill(ROOM_PAGE + 10);
    const cookie = await h.signIn(WRITER);
    metered.reset();

    const reply = await h.fetch('GET', ROOM, { cookie });

    const answer = roomResponseSchema.parse(reply.json);
    expect(answer.messages.map((message) => message.id)).toEqual(
      Array.from({ length: ROOM_PAGE }, (_, index) => newest - index),
    );
    expect(answer.prixAddress).toBe(PRIX);
    expect(answer.siteHost).toBe(new URL(SITE).host);
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(reply.headers.get('Set-Cookie')).toBeNull();
    // No session is read, nothing is written, and the room's table is asked once.
    expect(metered.meter.log.filter((sql) => /sessions|users/.test(sql))).toEqual([]);
    expect(metered.meter.log.filter((sql) => /room_messages/.test(sql))).toHaveLength(1);
    expect(metered.meter.writes).toBe(0);
    // A read asks for no holding and for no tier.
    expect(h.holdingReads).toEqual([]);
    expect(h.tierReads).toEqual([]);
  });

  it('answers a request with a query as one without: no value of a request reaches the store', async () => {
    // What the route asks of the store, whatever the request says.
    const asked: [number, number][] = [];
    const room = createRoomStore(metered.db);
    const h = createRoomHarness(
      {
        ...storesOn(metered.db),
        room: {
          ...room,
          listNewest: (limit, scan) => {
            asked.push([limit, scan]);
            return room.listNewest(limit, scan);
          },
        },
      },
      { now: NOW, prixAddress: PRIX },
    );
    const { oldest } = await fill(ROOM_PAGE + 30);
    const plain = await h.fetch('GET', ROOM);

    for (const query of [
      `?before=${oldest + 5}`,
      '?before=1',
      '?limit=500&scan=100000',
      '?page=2&offset=50&cursor=abc',
      '?before=3&before=4',
      `?prixAddress=0x${'f'.repeat(40)}&siteHost=evil.io`,
      '?hidden=1&muted=1&all=true',
    ]) {
      const reply = await h.fetch('GET', `${ROOM}${query}`);
      expect(reply.status, query).toBe(200);
      expect(reply.text, query).toBe(plain.text);
      expect(reply.headers.get('Cache-Control'), query).toBe(plain.headers.get('Cache-Control'));
    }
    expect(asked).toHaveLength(8);
    for (const call of asked) expect(call).toEqual([ROOM_PAGE, ROOM_SCAN]);
  });

  it('never reads below the newest ROOM_SCAN ids: a stretch of hidden rows makes the page shorter, not the read longer', async () => {
    const h = world();
    const { oldest, newest } = await fill(ROOM_SCAN + 60);
    const hideFrom = (id: number) =>
      db.prepare('UPDATE room_messages SET hidden_at = ?1, hidden_by = ?2 WHERE id >= ?3').bind(NOW, ADMIN, id).run();
    const ids = async (): Promise<number[]> =>
      roomResponseSchema
        .parse((await h.fetch('GET', `${ROOM}?before=${oldest + 30}`)).json)
        .messages.map(({ id }) => id);

    // The newest ROOM_SCAN - 20 are hidden: the page is the 20 above the edge, and not one from below it.
    await hideFrom(newest - ROOM_SCAN + 21);
    expect(await ids()).toEqual(Array.from({ length: 20 }, (_, index) => newest - ROOM_SCAN + 20 - index));

    // All of the newest ROOM_SCAN are hidden: the page is empty, though 60 messages lie below.
    await hideFrom(newest - ROOM_SCAN + 1);
    expect(await ids()).toEqual([]);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM room_messages WHERE hidden_at IS NULL').first<{ n: number }>())?.n,
    ).toBe(60);
  });

  it("does not read below the edge for a muted writer's stretch either", async () => {
    const h = world();
    await fill(40, WRITER, 'older line');
    await fill(ROOM_SCAN, MUTED, 'line of the muted writer');
    await plainRoom.muteWriter(MUTED, ADMIN, at(60));

    expect(await shown(h)).toEqual([]);
  });
});

// --- through the Worker's entry ---------------------------------------------------------------------------

const MARKER = 'from-the-cache';

/** What the app asked for while it answered: every request it takes passes the limiter, and every read asks D1. */
interface Reached {
  limiter: number;
  statements: number;
}

function entry(extra: Record<string, unknown> = {}): { env: Record<string, unknown>; reached: Reached } {
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
    SOCIAL_ENABLED: 'true',
    [ROOM_ENABLED_VAR]: 'true',
    [ROOM_DAILY_CAP_VAR]: '400',
    ...extra,
  };
  return { env, reached };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

async function call(env: Record<string, unknown>, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await worker.fetch(new Request(`${SITE}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  return response;
}

const plant = (path: string): Promise<void> =>
  caches.default.put(`${SITE}${path}`, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));

async function stored(path: string): Promise<string | null> {
  const hit = await caches.default.match(`${SITE}${path}`);
  return hit === undefined ? null : hit.text();
}

describe("through the Worker's entry", () => {
  beforeEach(async () => {
    resetTokenMemory();
    for (const path of [ROOM, STATUS, `${ROOM}?before=3`, `${ROOM}?junk=1`, `${STATUS}?junk=1`]) {
      await caches.default.delete(`${SITE}${path}`);
    }
  });

  describe('the read with a query', () => {
    it('is answered as the one without, with the messages of the store, and stored under the path alone', async () => {
      const { newest } = await fill(ROOM_PAGE + 20);
      const { env, reached } = entry();

      const first = await call(env, `${ROOM}?before=${newest - 40}&limit=1000`);

      expect(first.status).toBe(200);
      const body = await first.text();
      expect(roomResponseSchema.parse(JSON.parse(body)).messages.map(({ id }) => id)).toEqual(
        Array.from({ length: ROOM_PAGE }, (_, index) => newest - index),
      );
      expect(await stored(ROOM)).toBe(body);
      expect(await stored(`${ROOM}?before=${newest - 40}&limit=1000`)).toBeNull();

      // Every other query is the same key: answered from what is stored, without the app.
      const afterMiss = { ...reached };
      for (const query of ['', '?before=3', '?junk=1&page=2', '?before=3&before=4']) {
        expect(await (await call(env, `${ROOM}${query}`)).text(), query).toBe(body);
      }
      expect(reached).toEqual(afterMiss);
    });

    it('is looked up by the path alone: what is stored there answers any query', async () => {
      const { env, reached } = entry();
      await plant(ROOM);
      await plant(STATUS);

      for (const query of ['', '?before=3', '?a=1&b=2', '?before=3&before=4']) {
        expect(await (await call(env, `${ROOM}${query}`)).text(), query).toBe(MARKER);
        expect(await (await call(env, `${STATUS}${query}`)).text(), query).toBe(MARKER);
      }
      expect(reached).toEqual({ limiter: 0, statements: 0 });
    });
  });

  describe('a HEAD of the read and of the status', () => {
    for (const path of [ROOM, STATUS]) {
      for (const query of ['', '?before=3']) {
        it(`of ${path}${query} is 405 with Allow: GET while nothing is cached, stores nothing, and never reaches the route`, async () => {
          await fill(3);
          const { env, reached } = entry();

          for (let n = 0; n < 3; n += 1) {
            const response = await call(env, `${path}${query}`, { method: 'HEAD' });
            expect(response.status).toBe(405);
            expect(response.headers.get('Allow')).toBe('GET');
            expect(await response.text()).toBe('');
          }

          expect(reached).toEqual({ limiter: 0, statements: 0 });
          expect(await stored(path)).toBeNull();
        });

        it(`of ${path}${query} is answered from what is cached, with no body, and never reaches the route`, async () => {
          const { env, reached } = entry();
          await plant(path);

          const response = await call(env, `${path}${query}`, { method: 'HEAD' });

          expect(response.status).toBe(200);
          expect(await response.text()).toBe('');
          expect(reached).toEqual({ limiter: 0, statements: 0 });
        });
      }

      it(`of ${path} is 405 where there is no cache at all, and never reaches the route`, async () => {
        // Revision 4: the HEAD is judged before the entry asks whether there is a cache.
        vi.stubGlobal('caches', undefined);
        const { env, reached } = entry();

        const response = await call(env, path, { method: 'HEAD' });

        expect(response.status).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET');
        expect(reached).toEqual({ limiter: 0, statements: 0 });
      });

      it(`of ${path} is the generic 404 while the room is off, like a GET, and asks the database nothing`, async () => {
        // Revision 5: off, the routes are not mounted, and a HEAD is what a HEAD of an unknown path is.
        const { env, reached } = entry({ [ROOM_ENABLED_VAR]: 'false' });
        const unknown = await call(env, '/api/social/no-such-path', { method: 'HEAD' });

        const response = await call(env, path, { method: 'HEAD' });

        expect(response.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(response.headers.get('Allow')).toBeNull();
        expect([...response.headers.entries()].sort()).toEqual([...unknown.headers.entries()].sort());
        expect((await call(env, path)).status).toBe(404);
        expect(reached.statements).toBe(0);
      });
    }

    it('a GET of the same paths does reach the route, so the count above is a count of the route', async () => {
      const { env, reached } = entry();

      expect((await call(env, ROOM)).status).toBe(200);

      expect(reached.limiter).toBeGreaterThan(0);
      expect(reached.statements).toBeGreaterThan(0);
    });
  });

  describe("the read's key after a write", () => {
    /** A session of the admin in the database the entry reads, and a write as the site sends one. */
    async function adminWrite(): Promise<(method: string, body?: unknown) => RequestInit> {
      const cookie = await world({ now: new Date().toISOString() }).signIn(ADMIN);
      return (method, body) => ({
        method,
        headers: { Origin: SITE, 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${cookie}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    it('is dropped when a message is written or taken away, so that the next read is the store again', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { env } = entry();
      const write = await adminWrite();
      await plant(ROOM);
      await plant(STATUS);

      const posted = await call(env, ROOM, write('POST', { text: 'the league looks good today' }));

      expect(posted.status).toBe(201);
      expect(await stored(ROOM)).toBeNull();
      expect(await stored(STATUS)).toBe(MARKER);
      const { message } = (await posted.json()) as { message: { id: number } };
      const texts = async (): Promise<string[]> =>
        roomResponseSchema.parse(await (await call(env, ROOM)).json()).messages.map(({ text }) => text);
      expect(await texts()).toEqual(['the league looks good today']);

      // The read is stored again; hiding the message drops it, and the next read no longer holds the line.
      expect(await stored(ROOM)).not.toBeNull();
      expect((await call(env, hidePath(message.id), write('DELETE'))).status).toBe(204);
      expect(await stored(ROOM)).toBeNull();
      expect(await texts()).toEqual([]);
    });

    it('is left as it is after a write that is refused', async () => {
      const { env } = entry();
      const write = await adminWrite();
      await plant(ROOM);

      const refused: [number, string, RequestInit][] = [
        [400, ROOM, write('POST', { text: 'the list is on evil.io' })],
        [400, ROOM, write('POST', { text: '' })],
        [404, hidePath(999_999), write('DELETE')],
        [404, mutePath(999_999), write('PUT')],
        [
          401,
          ROOM,
          { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body: '{"text":"gm"}' },
        ],
      ];
      for (const [status, path, init] of refused) {
        expect((await call(env, path, init)).status, `${init.method} ${path}`).toBe(status);
        expect(await stored(ROOM), `${init.method} ${path}`).toBe(MARKER);
      }
    });
  });
});
