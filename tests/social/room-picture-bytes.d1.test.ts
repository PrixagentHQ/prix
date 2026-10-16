import {
  ROOM_PICTURE_BYTES_FAILURE_CODE,
  ROOM_PICTURE_BYTES_RETRY_SECONDS,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_RATE_PER_MINUTE,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_VIEW_SAMPLE,
  ROOM_PICTURES_ADMIN_PATH,
  ROOM_PICTURES_PATH,
  ROOM_SCAN,
  roomPictureAdminPath,
  roomPictureHeaders,
  roomPicturePath,
  roomPictureViewsKey,
} from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import type { Reply } from './api/harness.ts';
import { errorOf } from './api/harness.ts';
import { db } from './support/d1.ts';
import {
  GIF_SCRIPT,
  GIF_SMALLEST,
  gifTinted,
  hex,
  JPEG_SMALLEST,
  PNG_SMALLEST,
  parsesAsScript,
} from './support/picture-files.ts';
import type { PictureWorld, WorldOptions } from './support/pictures.ts';
import {
  ADMIN,
  counterOf,
  createPictureWorld,
  emptyPictureTables,
  eventsOf,
  pictureRow,
  seedCount,
  seedPicture,
  seedWriter,
  withOver,
} from './support/pictures.ts';

/**
 * Serving a picture (docs/contracts/phase-6-pictures.md sections 7 and 9, at revision 3): the public bytes
 * route and the admin's look, behind `createApp`, on the real gate of the D1 store and the real bytes port
 * over a KV of the test's own.
 *
 * What makes a stored file that is also a script inert is here and nowhere else: the type from the row
 * with `nosniff`, and the generic 404, before D1 and KV, to every request that is not an `<img>` on the
 * site's own pages. D1 decides and KV only holds bytes: every reason a picture is not served is one
 * answer, and for none of them is KV asked.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';
const VIEWS_KEY = roomPictureViewsKey(DAY);
/** 12:10:30 UTC to 00:00 UTC. */
const TO_MIDNIGHT = 11 * 3_600 + 49 * 60 + 30;

const WRITER = '0x00000000000000000000000000000000000005b2';
const SECOND = '0x00000000000000000000000000000000000005b3';

function world(options: WorldOptions = {}): PictureWorld {
  return createPictureWorld(db, { now: NOW, ...options });
}

const at = (secondsAgo: number): string => new Date(Date.parse(NOW) - secondsAgo * 1_000).toISOString();
const since = (w: PictureWorld, mark: number): string[] => w.trace.slice(mark);
/** What a request asked of the database, of KV and of the `picture` rule. */
const reached = (w: PictureWorld, mark: number): string[] =>
  since(w, mark).filter((step) => step.startsWith('d1 ') || step.startsWith('kv.') || step === 'limit.picture');
const headersOf = (reply: Reply): [string, string][] =>
  [...reply.headers.entries()].map(([name, value]): [string, string] => [name.toLowerCase(), value]).sort();
const wanted = (headers: Record<string, string>): [string, string][] =>
  Object.entries(headers)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort();

/** The generic 404 of the app, as an unknown path gets it: every refusal of a picture must be this, byte for byte. */
async function generic(w: PictureWorld): Promise<{ status: number; headers: [string, string][]; text: string }> {
  const reply = await w.fetch('GET', '/api/social/no-such-path');
  return { status: reply.status, headers: headersOf(reply), text: reply.text };
}
function expectGeneric(reply: Reply, unknown: Awaited<ReturnType<typeof generic>>, name = ''): void {
  expect(reply.status, name).toBe(404);
  expect(reply.text, name).toBe(unknown.text);
  expect(headersOf(reply), name).toEqual(unknown.headers);
  expect(errorOf(reply).code, name).toBe('not_found');
  expect(reply.headers.get('Cache-Control'), name).toBe('no-store');
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
  vi.restoreAllMocks();
});

describe('a 200 of the bytes', () => {
  for (const [type, file] of [
    ['jpeg', JPEG_SMALLEST],
    ['png', PNG_SMALLEST],
    ['gif', GIF_SMALLEST],
  ] as const) {
    it(`carries exactly the headers of roomPictureHeaders for a ${type}, and the stored bytes`, async () => {
      const w = world();
      const picture = await seedPicture(w, WRITER, file);

      const reply = await w.image(roomPicturePath(picture.id));

      expect(reply.status, reply.text).toBe(200);
      // The whole list, not single headers: nothing more is sent and nothing less.
      expect(headersOf(reply)).toEqual(wanted(roomPictureHeaders(picture.id, type, picture.bytes.length)));
      expect(hex(reply.bytes)).toBe(hex(picture.bytes));
    });
  }

  it("says the whole set out, so that a change of the contract's function shows here too", async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);

    const reply = await w.image(roomPicturePath(picture.id));

    expect(headersOf(reply)).toEqual(
      wanted({
        'Content-Type': 'image/gif',
        'Content-Length': String(GIF_SMALLEST.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Content-Disposition': `attachment; filename="prix-chat-${picture.id}.gif"`,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'X-Robots-Tag': 'noindex, noimageindex, noarchive',
        'Accept-Ranges': 'none',
      }),
    );
    for (const never of ['etag', 'last-modified', 'vary', 'set-cookie', 'access-control-allow-origin', 'location']) {
      expect(reply.headers.get(never), never).toBeNull();
    }
  });

  it('takes the type and the length from the row the server wrote, never from what KV holds', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, PNG_SMALLEST);
    // KV now holds a GIF of the PNG's own length under the key: the row still says PNG.
    const other = new Uint8Array(picture.bytes.length);
    other.set(GIF_SMALLEST.subarray(0, Math.min(GIF_SMALLEST.length, other.length)));
    w.kv.held.set(picture.key, other.buffer as ArrayBuffer);

    const reply = await w.image(roomPicturePath(picture.id));

    expect(reply.status).toBe(200);
    expect(reply.headers.get('Content-Type')).toBe('image/png');
    expect(reply.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(reply.headers.get('Content-Length')).toBe(String(picture.bytes.length));
  });

  it('takes nothing of the request: a claimed type, a Range and a condition change nothing', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const plain = await w.image(roomPicturePath(picture.id));

    const reply = await w.image(`${roomPicturePath(picture.id)}?type=text/html&download=0`, {
      headers: {
        Accept: 'text/html',
        Range: 'bytes=0-9',
        'If-None-Match': '*',
        'If-Modified-Since': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'If-Range': '"x"',
        'X-Content-Type': 'text/html',
      },
    });

    // Never 206, never 304: the whole picture, with the same headers.
    expect(reply.status).toBe(200);
    expect(headersOf(reply)).toEqual(headersOf(plain));
    expect(hex(reply.bytes)).toBe(hex(picture.bytes));
  });

  it('reads no session, and asks D1 once before KV once', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const mark = w.trace.length;

    const reply = await w.image(roomPicturePath(picture.id), { cookie });

    expect(reply.status).toBe(200);
    const asked = reached(w, mark);
    // The limiter's rule, the gate in one statement, then the one read of KV: no key is read before
    // D1 has answered it in this request.
    expect(asked.map((step) => step.split(' ')[0])).toEqual(['limit.picture', 'd1', 'kv.get']);
    expect(asked.some((step) => /\bsessions\b/.test(step))).toBe(false);
    expect(w.kv.gets).toEqual([picture.key]);
    // The gate is answered by the primary: no statement of it runs in a D1 session.
    expect(since(w, mark).some((step) => step.includes('withSession'))).toBe(false);
  });
});

describe("step 2: only an <img> on the site's own pages", () => {
  const DESTS: [string, string | null][] = [
    ['script', 'script'],
    ['style', 'style'],
    ['document', 'document'],
    ['iframe', 'iframe'],
    ['object', 'object'],
    ['embed', 'embed'],
    ['worker', 'worker'],
    ['serviceworker', 'serviceworker'],
    ['empty', 'empty'],
    ['absent', null],
    ['an empty value', ''],
    ['frame', 'frame'],
    ['sharedworker', 'sharedworker'],
    ['audio', 'audio'],
    ['video', 'video'],
    ['font', 'font'],
    ['manifest', 'manifest'],
    ['IMAGE in capitals', 'IMAGE'],
    ['image with a second value', 'image, script'],
    ['image with a word after it', 'image x'],
  ];

  for (const [name, dest] of DESTS) {
    it(`answers the generic 404 with no D1 and no KV when Sec-Fetch-Dest is ${name}`, async () => {
      const w = world();
      // The stored file is the GIF that is also a script: this rule is what makes it inert.
      const picture = await seedPicture(w, WRITER, GIF_SCRIPT);
      expect(parsesAsScript(picture.bytes)).toBe(true);
      const unknown = await generic(w);
      const mark = w.trace.length;

      const reply = await w.image(roomPicturePath(picture.id), { headers: { 'Sec-Fetch-Dest': dest } });

      expectGeneric(reply, unknown);
      expect(reached(w, mark)).toEqual([]);
      expect(reply.text).not.toContain('planted');
    });
  }

  const SITES: [string, string | null][] = [
    ['absent', null],
    ['cross-site', 'cross-site'],
    ['same-site', 'same-site'],
    ['none', 'none'],
    ['an empty value', ''],
    ['SAME-ORIGIN in capitals', 'SAME-ORIGIN'],
  ];
  for (const [name, site] of SITES) {
    it(`answers the generic 404 with no D1 and no KV when Sec-Fetch-Site is ${name}`, async () => {
      const w = world();
      const picture = await seedPicture(w, WRITER, GIF_SCRIPT);
      const unknown = await generic(w);
      const mark = w.trace.length;

      const reply = await w.image(roomPicturePath(picture.id), { headers: { 'Sec-Fetch-Site': site } });

      expectGeneric(reply, unknown);
      expect(reached(w, mark)).toEqual([]);
    });
  }

  it('serves that same file to an <img>, as a GIF that no browser may sniff', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SCRIPT);

    const reply = await w.image(roomPicturePath(picture.id));

    expect(reply.status).toBe(200);
    expect(reply.headers.get('Content-Type')).toBe('image/gif');
    expect(reply.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(reply.headers.get('Content-Disposition')).toMatch(/^attachment; /);
    expect(reply.headers.get('Content-Security-Policy')).toContain('sandbox');
  });

  it('is asked before anything else: a navigation with a session, a good id and a full allowance is still the 404', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const unknown = await generic(w);
    const mark = w.trace.length;

    // What a browser sends when the address is opened as a page.
    const reply = await w.image(roomPicturePath(picture.id), {
      cookie,
      headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
    });

    expectGeneric(reply, unknown);
    expect(reached(w, mark)).toEqual([]);
  });
});

describe("step 3: the id's shape", () => {
  it('answers the generic 404 for anything that is no id, before the limiter and D1', async () => {
    const w = world();
    await seedPicture(w, WRITER, GIF_SMALLEST);
    const unknown = await generic(w);

    for (const id of ['0', '012', 'abc', '1e3', '-1', '1.0', '1234567890123456', 'off', '12abc']) {
      const mark = w.trace.length;
      const reply = await w.image(`${ROOM_PICTURES_PATH}/${id}`);
      expectGeneric(reply, unknown, id);
      expect(reached(w, mark), id).toEqual([]);
    }
  });
});

describe('step 4: the picture rule of the limiter', () => {
  it('is asked for the network a request comes from: an IPv4 address whole, the /48 of an IPv6 one', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const path = roomPicturePath(picture.id);

    await w.image(path, { ip: '198.51.100.7' });
    // Two addresses of one /48 in two of its 65,536 /64 networks, then a third in another /48.
    await w.image(path, { ip: '2001:db8:aaaa:1::1' });
    await w.image(path, { ip: '2001:db8:aaaa:ffff:1:2:3:4' });
    await w.image(path, { ip: '2001:db8:aaab:1::1' });

    const [v4, first, second, other] = w.pictureRule.asked;
    expect(v4).toBe('198.51.100.7');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    // The subject names three groups and no fourth: never the /64 of `clientSubject`.
    expect(first).toBe('2001:db8:aaaa::');
    expect(w.pictureRule.asked).toHaveLength(4);
    expect(ROOM_PICTURE_RATE_PER_MINUTE).toBe(10);
  });

  it('answers 429 rate_limited when the rule refuses, with no D1 and no KV', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    w.pictureRule.allow = false;
    const mark = w.trace.length;

    const reply = await w.image(roomPicturePath(picture.id));

    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(reply.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
    expect(reached(w, mark)).toEqual(['limit.picture']);
  });
});

describe('step 5: the gate, one answer for every reason', () => {
  const set = (id: number, sql: string, ...values: unknown[]): Promise<unknown> =>
    db
      .prepare(`UPDATE room_messages SET ${sql} WHERE id = ?1`)
      .bind(id, ...values)
      .run();
  const writer = (sql: string, ...values: unknown[]): Promise<unknown> =>
    db
      .prepare(`UPDATE room_writers SET ${sql} WHERE address = ?1`)
      .bind(WRITER, ...values)
      .run();

  const reasons: [string, (w: PictureWorld, id: number) => Promise<unknown>][] = [
    ['its message is hidden', (_w, id) => set(id, 'hidden_at = ?2, hidden_by = ?3', NOW, ADMIN)],
    ['it is hidden after reports', (_w, id) => set(id, "pic_state = 'reported', pic_reports = 3")],
    ['an admin removed it', (_w, id) => set(id, "pic_state = 'removed'")],
    ['its key is gone', (_w, id) => set(id, 'pic_key = NULL, pic_gone_at = ?2', NOW)],
    ['its writer is muted now', () => writer('muted_at = ?2, muted_by = ?3, cut_at = ?2', NOW, ADMIN)],
    ["it was written at or before its writer's cut", () => writer('cut_at = ?2', NOW)],
    ['its message is seven days old', (_w, id) => set(id, 'at = ?2', at(ROOM_PICTURE_TTL_SECONDS))],
    ['pictures are switched off', (w) => w.deps.pictures.setPicturesOff(ADMIN, 'admin', NOW)],
    [
      `it is no longer among the newest ${ROOM_SCAN} ids`,
      () =>
        db
          .prepare(
            `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
             INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'line ' || i FROM n`,
          )
          .bind(ROOM_SCAN, NOW, SECOND)
          .run(),
    ],
  ];

  for (const [name, arrange] of reasons) {
    it(`answers the generic 404 when ${name}, and never asks KV`, async () => {
      const w = world();
      await seedWriter(w, WRITER);
      const picture = await seedPicture(w, WRITER, GIF_SMALLEST, { at: at(600) });
      expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
      await arrange(w, picture.id);
      const unknown = await generic(w);
      const gets = w.kv.gets.length;

      const reply = await w.image(roomPicturePath(picture.id));

      expectGeneric(reply, unknown);
      // D1 decides, whatever KV still holds: the bytes are there, and nothing asked for them.
      expect(w.kv.held.has(picture.key)).toBe(true);
      expect(w.kv.gets).toHaveLength(gets);
    });
  }

  it('answers the same for an id no message has, and for a message of text', async () => {
    const w = world();
    const { firstId } = await seedWriter(w, WRITER);
    const unknown = await generic(w);

    expectGeneric(await w.image(roomPicturePath(firstId)), unknown);
    expectGeneric(await w.image(roomPicturePath(firstId + 1_000)), unknown);
    expect(w.kv.calls()).toBe(0);
  });

  it('never serves a picture whose writer is an admin wallet now', async () => {
    const before = world();
    const picture = await seedPicture(before, WRITER, GIF_SMALLEST);
    expect((await before.image(roomPicturePath(picture.id))).status).toBe(200);

    const w = world({ adminAddresses: [ADMIN, WRITER] });
    w.kv.held.set(picture.key, picture.bytes.slice().buffer as ArrayBuffer);
    const unknown = await generic(w);

    expectGeneric(await w.image(roomPicturePath(picture.id)), unknown);
    expect(w.kv.gets).toEqual([]);
  });

  it('serves a picture that an admin kept, one a second under seven days old, and the oldest of the newest ids', async () => {
    const w = world();
    const kept = await seedPicture(w, WRITER, gifTinted(1), { state: 'kept', at: at(ROOM_PICTURE_TTL_SECONDS - 1) });
    await db
      .prepare(
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'line ' || i FROM n`,
      )
      .bind(ROOM_SCAN - 1, NOW, SECOND)
      .run();

    expect((await w.image(roomPicturePath(kept.id))).status).toBe(200);
  });

  it('holds from the statement of a hide on, with a KV that still answers after its delete', async () => {
    // Cloudflare: a deleted key may be handed out for a minute or more where it was read lately.
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    w.kv.keepsAfterDelete = true;
    const admin = await w.signIn(ADMIN);
    const unknown = await generic(w);
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    const gets = w.kv.gets.length;

    const hidden = await w.fetch('DELETE', `/api/social/admin/room/messages/${picture.id}`, { cookie: admin });

    expect(hidden.status).toBe(204);
    expect(w.kv.deletes).toEqual([picture.key]);
    // KV still has the bytes, and would answer them.
    expect(w.kv.held.has(picture.key)).toBe(true);
    expectGeneric(await w.image(roomPicturePath(picture.id)), unknown);
    expectGeneric(await w.image(roomPictureAdminPath(picture.id), { cookie: admin }), unknown);
    expect(w.kv.gets).toHaveLength(gets);
  });
});

describe('steps 5 and 6: the views of a day', () => {
  it(`counts one view in ${ROOM_PICTURE_VIEW_SAMPLE} as ${ROOM_PICTURE_VIEW_SAMPLE}, by the server's own draw`, async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);

    w.random.value = 0.999;
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    w.random.value = 1 / ROOM_PICTURE_VIEW_SAMPLE;
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    expect(await counterOf(db, VIEWS_KEY)).toBe(0);

    w.random.value = 1 / ROOM_PICTURE_VIEW_SAMPLE - 0.000_001;
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    w.random.value = 0;
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    expect(await counterOf(db, VIEWS_KEY)).toBe(2 * ROOM_PICTURE_VIEW_SAMPLE);
  });

  it('answers 429 picture_views_day to 00:00 UTC once the cap is reached, whatever the picture, with no KV read', async () => {
    const w = world({ viewsCap: '50' });
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    await seedCount(db, VIEWS_KEY, 50, NOW);

    for (const path of [roomPicturePath(picture.id), roomPicturePath(picture.id + 500)]) {
      const reply = await w.image(path);
      expect(reply.status, path).toBe(429);
      expect(errorOf(reply), path).toMatchObject({ code: 'invalid_input', field: 'picture_views_day' });
      expect(reply.headers.get('Retry-After'), path).toBe(String(TO_MIDNIGHT));
      expect(reply.headers.get('Cache-Control'), path).toBe('no-store');
    }
    expect(w.kv.calls()).toBe(0);

    // One below the cap is served.
    await seedCount(db, VIEWS_KEY, 49, NOW);
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
  });

  it('writes room_picture_views_cap once, with the count, by the request whose sample crossed the cap', async () => {
    const w = world({ viewsCap: '50' });
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    w.random.value = 0;
    const lines = (): unknown[] => eventsOf(logged).filter((line) => line.event === ROOM_PICTURE_LOG_EVENTS.viewsCap);

    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    expect(lines()).toEqual([]);
    // This one crosses it: it is still served, and says so once.
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(200);
    expect(lines()).toEqual([{ event: 'room_picture_views_cap', count: 50 }]);
    for (let n = 0; n < 5; n += 1) expect((await w.image(roomPicturePath(picture.id))).status).toBe(429);

    expect(lines()).toHaveLength(1);
    expect(await counterOf(db, VIEWS_KEY)).toBe(50);
  });

  it('serves no view that cannot be counted: 503 internal, Retry-After 5, and KV is not read', async () => {
    const w = world({
      wrapPictures: (store) =>
        withOver(store, {
          addViews: async () => {
            throw new Error('D1 is away');
          },
        }),
    });
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    w.random.value = 0;

    const reply = await w.image(roomPicturePath(picture.id));

    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toMatchObject({ code: ROOM_PICTURE_BYTES_FAILURE_CODE, field: null });
    expect(ROOM_PICTURE_BYTES_FAILURE_CODE).toBe('internal');
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_PICTURE_BYTES_RETRY_SECONDS));
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(w.kv.gets).toEqual([]);
  });
});

describe('steps 7 and 8: what KV answers', () => {
  it('answers the generic 404 when KV has no such key, and does not touch the row', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST, { inKv: false });
    const row = await pictureRow(db, picture.id);
    const unknown = await generic(w);
    const mark = w.trace.length;

    expectGeneric(await w.image(roomPicturePath(picture.id)), unknown);

    expect(await pictureRow(db, picture.id)).toEqual(row);
    expect(since(w, mark).filter((step) => /^d1 (insert|update|delete|replace)\b/i.test(step))).toEqual([]);
  });

  it('answers 503 internal with Retry-After 5 when KV throws, and while there is no binding at all', async () => {
    const failing = world();
    const picture = await seedPicture(failing, WRITER, GIF_SMALLEST);
    failing.kv.fail.add('get');
    const unbound = world({ kv: null });

    for (const w of [failing, unbound]) {
      const reply = await w.image(roomPicturePath(picture.id));
      expect(reply.status).toBe(503);
      expect(errorOf(reply)).toMatchObject({ code: 'internal', field: null });
      expect(reply.headers.get('Retry-After')).toBe('5');
      expect(reply.headers.get('Cache-Control')).toBe('no-store');
      expect(reply.headers.get('Content-Type')).toMatch(/^application\/json/);
    }
  });

  it('answers the generic 404 and writes the id to the log when KV holds bytes of another length', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    w.kv.held.set(picture.key, new Uint8Array(picture.bytes.length + 1).buffer as ArrayBuffer);
    const unknown = await generic(w);

    expectGeneric(await w.image(roomPicturePath(picture.id)), unknown);

    expect(eventsOf(logged).filter((line) => line.event === ROOM_PICTURE_LOG_EVENTS.lengthMismatch)).toEqual([
      { event: 'room_picture_length_mismatch', id: picture.id },
    ]);
  });
});

describe('a HEAD, asked of the app itself', () => {
  it("never runs either bytes route: 405 with Allow: GET for the public path, the generic 404 for the admin's", async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const admin = await w.signIn(ADMIN);
    const unknown = await w.fetch('HEAD', '/api/social/no-such-path');
    const mark = w.trace.length;
    const image = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' };

    const open = await w.fetch('HEAD', roomPicturePath(picture.id), { headers: image });
    const look = await w.fetch('HEAD', roomPictureAdminPath(picture.id), { headers: image, cookie: admin });

    expect(open.status).toBe(405);
    expect(open.headers.get('Allow')).toBe('GET');
    expect(open.text).toBe('');
    expect(look.status).toBe(404);
    expect(headersOf(look)).toEqual(headersOf(unknown));
    expect(reached(w, mark)).toEqual([]);
  });
});

describe('while pictures are not enabled', () => {
  it("answers the public bytes path as an unknown path, and the admin's look still works", async () => {
    const w = world({ pictures: false });
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const admin = await w.signIn(ADMIN);
    const unknown = await generic(w);
    const mark = w.trace.length;

    expectGeneric(await w.image(roomPicturePath(picture.id)), unknown);
    expect(reached(w, mark)).toEqual([]);
    expect((await w.image(roomPictureAdminPath(picture.id), { cookie: admin })).status).toBe(200);
  });
});

describe("the admin's look", () => {
  it('serves the same header set to an admin session, and is no view of the day', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, PNG_SMALLEST);
    const admin = await w.signIn(ADMIN);
    w.random.value = 0;
    const mark = w.trace.length;

    const reply = await w.image(roomPictureAdminPath(picture.id), { cookie: admin });

    expect(reply.status).toBe(200);
    expect(headersOf(reply)).toEqual(wanted(roomPictureHeaders(picture.id, 'png', picture.bytes.length)));
    expect(hex(reply.bytes)).toBe(hex(picture.bytes));
    expect(await counterOf(db, VIEWS_KEY)).toBe(0);
    expect(since(w, mark).filter((step) => /^d1 (insert|update|delete|replace)\b/i.test(step))).toEqual([]);
    expect(w.pictureRule.asked).toEqual(['203.0.113.9']);
  });

  it('answers anyone who is no admin as an unknown path, and reads no session before the two fetch headers', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const { cookie } = await seedWriter(w, WRITER);
    const admin = await w.signIn(ADMIN);
    const unknown = await generic(w);
    const path = roomPictureAdminPath(picture.id);

    expectGeneric(await w.image(path), unknown);
    expectGeneric(await w.image(path, { cookie }), unknown);
    expect(w.kv.gets).toEqual([]);

    const refused: Record<string, string | null>[] = [
      { 'Sec-Fetch-Dest': 'document' },
      { 'Sec-Fetch-Dest': 'script' },
      { 'Sec-Fetch-Dest': null },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': null },
    ];
    for (const headers of refused) {
      const mark = w.trace.length;
      expectGeneric(await w.image(path, { cookie: admin, headers }), unknown, JSON.stringify(headers));
      expect(reached(w, mark), JSON.stringify(headers)).toEqual([]);
    }
  });

  it('also serves a reported picture, one outside the newest ids, and any while pictures are off', async () => {
    const w = world();
    const reported = await seedPicture(w, WRITER, gifTinted(1), { state: 'reported', reports: 3 });
    await createRoomStore(db).putMessage(SECOND, 'a line', NOW);
    await db
      .prepare(
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'line ' || i FROM n`,
      )
      .bind(ROOM_SCAN + 5, NOW, SECOND)
      .run();
    await w.deps.pictures.setPicturesOff(ADMIN, 'admin', NOW);
    const admin = await w.signIn(ADMIN);
    const unknown = await generic(w);

    expect((await w.image(roomPictureAdminPath(reported.id), { cookie: admin })).status).toBe(200);
    // The public route refuses the same picture for three reasons at once.
    expectGeneric(await w.image(roomPicturePath(reported.id)), unknown);
  });

  it('refuses a removed picture, one of seven days, one of a hidden message, and one whose writer is an admin now', async () => {
    const w = world({ adminAddresses: [ADMIN, SECOND] });
    const admin = await w.signIn(ADMIN);
    const unknown = await generic(w);
    const pictures = [
      await seedPicture(w, WRITER, gifTinted(1), { state: 'removed' }),
      await seedPicture(w, WRITER, gifTinted(2), { at: at(ROOM_PICTURE_TTL_SECONDS) }),
      await seedPicture(w, WRITER, gifTinted(3), { hiddenAt: NOW }),
      await seedPicture(w, SECOND, gifTinted(4)),
    ];

    for (const picture of pictures) {
      expectGeneric(await w.image(roomPictureAdminPath(picture.id), { cookie: admin }), unknown, String(picture.id));
    }
    expect(w.kv.gets).toEqual([]);
  });

  it('answers 429 from the picture rule and 503 when KV throws, as the public route does', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    const admin = await w.signIn(ADMIN);

    w.kv.fail.add('get');
    const failed = await w.image(roomPictureAdminPath(picture.id), { cookie: admin });
    expect(failed.status).toBe(503);
    expect(errorOf(failed)).toMatchObject({ code: 'internal', field: null });
    expect(failed.headers.get('Retry-After')).toBe('5');

    w.pictureRule.allow = false;
    const limited = await w.image(roomPictureAdminPath(picture.id), { cookie: admin });
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
  });

  it('keeps `off` apart from an id: the switch is no picture', async () => {
    const w = world();
    const admin = await w.signIn(ADMIN);
    const unknown = await generic(w);

    expectGeneric(await w.image(`${ROOM_PICTURES_ADMIN_PATH}/off`, { cookie: admin }), unknown);
    expect(w.kv.calls()).toBe(0);
  });
});

describe('what the bytes routes write to the log', () => {
  it('names no address, no key and no hash', async () => {
    const w = world({ viewsCap: '25' });
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST);
    w.random.value = 0;
    await w.image(roomPicturePath(picture.id));
    w.kv.held.set(picture.key, new Uint8Array(3).buffer as ArrayBuffer);
    await seedCount(db, VIEWS_KEY, 0, NOW);
    await w.image(roomPicturePath(picture.id));

    const text = logged.map((call) => call.map(String).join(' ')).join('\n');
    expect(text).toContain('room_picture_views_cap');
    expect(text).toContain('room_picture_length_mismatch');
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(text).not.toMatch(/[0-9a-f]{32}/);
    expect(text).not.toContain('pic/');
  });
});
