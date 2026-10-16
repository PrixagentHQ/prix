import {
  ROOM_PICTURE_BYTES_FAILURE_CODE,
  ROOM_PICTURE_BYTES_RETRY_SECONDS,
  ROOM_PICTURE_CONTENT_TYPES,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_REFUSALS,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURE_TYPES,
  ROOM_PICTURE_VIEW_SAMPLE,
  ROOM_SCAN,
  type RoomPictureMessageRecord,
  roomPictureHeaders,
  roomPicturePath,
  roomPictureViewsKey,
} from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  stepsOf,
} from './test-support.ts';
import { gifBytes } from './test-support-pictures.ts';

/**
 * The bytes of a picture against docs/contracts/phase-6-pictures.md section 7: the nine steps in their
 * order, the whole header set of a 200, and what every other answer is. No D1, no KV.
 */

const VIEWS_KEY = roomPictureViewsKey(DAY);
const POSTED = '2026-10-20T11:00:00.000Z';
const GIF = gifBytes();
const IMG = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' };
const NETWORK = '203.0.113.9';
const CAP = 1_000;

/** A harness with pictures on and one picture of HOLDER whose bytes KV holds. */
function shown(fields: Parameters<Harness['pictures']['seedPicture']>[2] = {}): {
  h: Harness;
  picture: RoomPictureMessageRecord;
} {
  const h = createHarness({ pictures: true, pictureViewsCap: CAP });
  const picture = h.pictures.seedPicture(HOLDER, POSTED, { bytes: GIF.length, ...fields });
  const key = picture.picture?.key;
  if (typeof key === 'string') h.bytes.held.set(key, { bytes: GIF, ttlSeconds: ROOM_PICTURE_TTL_SECONDS });
  h.trace.length = 0;
  return { h, picture };
}

function get(h: Harness, id: number | string, options: RequestOptions = {}): Promise<Reply> {
  return h.fetch('GET', typeof id === 'number' ? roomPicturePath(id) : id, { headers: IMG, ...options });
}

async function generic404(h: Harness): Promise<string> {
  const unknown = await h.fetch('GET', '/api/social/no-such-route');
  h.trace.length = 0;
  return unknown.text;
}

function expectGeneric404(reply: Reply, text: string): void {
  expect(reply.status).toBe(404);
  expect(reply.text).toBe(text);
  expect(reply.headers.get('Cache-Control')).toBe('no-store');
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a shown picture (section 7)', () => {
  it('runs its steps in their order: the limiter by the network, the gate, the draw, the bytes', async () => {
    const { h, picture } = shown();
    const reply = await get(h, picture.id);
    expect(reply.status).toBe(200);
    expect(h.trace).toEqual([
      `limiter:read:${NETWORK}`,
      `limiter:picture:${NETWORK}`,
      'clock',
      `pictures.getServable:${picture.id}:${ROOM_SCAN}:${VIEWS_KEY}`,
      'random',
      'bytes.get',
    ]);
    expect([...reply.raw]).toEqual([...GIF]);
  });

  it.each(ROOM_PICTURE_TYPES)('answers exactly the header set of the contract for a %s', async (type) => {
    const { h, picture } = shown({ type });
    const reply = await get(h, picture.id);
    expect(reply.status).toBe(200);
    const expected = Object.entries(roomPictureHeaders(picture.id, type, GIF.length)).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]);
    expect([...reply.headers.entries()].sort()).toEqual(expected.sort());
    expect(reply.headers.get('Content-Type')).toBe(ROOM_PICTURE_CONTENT_TYPES[type]);
  });

  it('takes the type from the row and never from the bytes or from the request', async () => {
    // The row says PNG; the bytes KV holds are a GIF; the request asks for something else again.
    const { h, picture } = shown({ type: 'png' });
    const reply = await get(h, picture.id, { headers: { ...IMG, Accept: 'text/html', 'Content-Type': 'text/html' } });
    expect(reply.headers.get('Content-Type')).toBe('image/png');
    expect(reply.headers.get('Content-Disposition')).toBe(`attachment; filename="prix-chat-${picture.id}.png"`);
    expect(reply.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('reads no session and no query, and ignores a range and a condition', async () => {
    const { h, picture } = shown();
    const cookie = await h.signIn(HOLDER);
    const reply = await get(h, `${roomPicturePath(picture.id)}?type=text/html&download=0`, {
      cookie,
      headers: {
        ...IMG,
        Range: 'bytes=0-3',
        'If-None-Match': '*',
        'If-Modified-Since': 'Tue, 20 Oct 2026 11:00:00 GMT',
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.raw.length).toBe(GIF.length);
    expect(h.trace).not.toContain('store.getSession');
    for (const name of [
      'ETag',
      'Last-Modified',
      'Vary',
      'Set-Cookie',
      'Content-Range',
      'Access-Control-Allow-Origin',
    ]) {
      expect(reply.headers.get(name), name).toBeNull();
    }
  });
});

describe('step 1: a HEAD never runs the route', () => {
  it('answers 405 with the one method that reads it, and asks nothing', async () => {
    const { h, picture } = shown();
    const reply = await h.fetch('HEAD', roomPicturePath(picture.id), { headers: IMG });
    expect(reply.status).toBe(405);
    expect(reply.headers.get('Allow')).toBe('GET');
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(reply.raw.length).toBe(0);
    expect(stepsOf(h.trace)).toEqual([]);
  });
});

describe('step 2: only an <img> on the site itself', () => {
  it.each<[string, Record<string, string | null>]>([
    ['no Sec-Fetch-Dest', { 'Sec-Fetch-Dest': null }],
    ['no Sec-Fetch-Site', { 'Sec-Fetch-Site': null }],
    ['neither header', { 'Sec-Fetch-Dest': null, 'Sec-Fetch-Site': null }],
    ['an empty destination', { 'Sec-Fetch-Dest': 'empty' }],
    ['a script', { 'Sec-Fetch-Dest': 'script' }],
    ['a style', { 'Sec-Fetch-Dest': 'style' }],
    ['a document', { 'Sec-Fetch-Dest': 'document' }],
    ['a frame', { 'Sec-Fetch-Dest': 'iframe' }],
    ['an object', { 'Sec-Fetch-Dest': 'object' }],
    ['an embed', { 'Sec-Fetch-Dest': 'embed' }],
    ['a worker', { 'Sec-Fetch-Dest': 'worker' }],
    ['a service worker', { 'Sec-Fetch-Dest': 'serviceworker' }],
    ['the value in capitals', { 'Sec-Fetch-Dest': 'IMAGE' }],
    ['two values', { 'Sec-Fetch-Dest': 'image, script' }],
    ['another site', { 'Sec-Fetch-Site': 'cross-site' }],
    ['the same site and another origin', { 'Sec-Fetch-Site': 'same-site' }],
    ['a request typed into the address bar', { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Dest': 'document' }],
  ])('answers the generic 404 to %s, with no D1, no KV and no count', async (_name, headers) => {
    const { h, picture } = shown();
    const text = await generic404(h);
    const reply = await get(h, picture.id, { headers: { ...IMG, ...headers } });
    expectGeneric404(reply, text);
    expect(stepsOf(h.trace)).toEqual([]);
  });
});

describe('step 3: the id', () => {
  it.each(['abc', '0', '01', '-1', '1.5', '1e3', '9999999999999999'])(
    'answers the generic 404 for the id %s before the limiter is asked',
    async (id) => {
      const { h } = shown();
      const text = await generic404(h);
      expectGeneric404(await get(h, `/api/social/room/pictures/${id}`), text);
      expect(stepsOf(h.trace)).toEqual([]);
    },
  );
});

describe('step 4: the limiter', () => {
  it.each<[string, string]>([
    ['198.51.100.7', '198.51.100.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1::'],
    ['2001:db8:1:ffff::1', '2001:db8:1::'],
  ])('counts a request from %s against the network %s', async (ip, subject) => {
    const { h, picture } = shown();
    expect((await get(h, picture.id, { ip })).status).toBe(200);
    expect(h.pictureLimiter.asked).toEqual([subject]);
  });

  it('answers 429 when the rule refuses, and asks neither D1 nor KV', async () => {
    const { h, picture } = shown();
    h.pictureLimiter.denied = true;
    const reply = await get(h, picture.id);
    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(reply.headers.get('Retry-After')).toBe('60');
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(stepsOf(h.trace)).toEqual([`limiter:picture:${NETWORK}`]);
  });
});

describe('step 5: the gate', () => {
  it("answers 429 once the day's views have reached the cap, whatever the picture, with no KV read", async () => {
    const { h, picture } = shown();
    h.counters.set(VIEWS_KEY, CAP);
    for (const id of [picture.id, 999]) {
      h.trace.length = 0;
      const reply = await get(h, id);
      expect(reply.status).toBe(ROOM_PICTURE_REFUSALS.picture_views_day);
      expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field: 'picture_views_day' });
      expect(errorOf(reply).message.length).toBeGreaterThan(20);
      expect(reply.headers.get('Retry-After')).toBe(String(12 * 3_600));
      expect(reply.headers.get('Cache-Control')).toBe('no-store');
      expect(stepsOf(h.trace)).toEqual([
        `limiter:picture:${NETWORK}`,
        `pictures.getServable:${id}:${ROOM_SCAN}:${VIEWS_KEY}`,
      ]);
    }
  });

  it('serves one view below the cap', async () => {
    const { h, picture } = shown();
    h.counters.set(VIEWS_KEY, CAP - 1);
    expect((await get(h, picture.id)).status).toBe(200);
  });

  type Arrange = (h: Harness, picture: RoomPictureMessageRecord) => void;
  it.each<[string, Arrange]>([
    [
      'a picture hidden by reports',
      (h, p) => void Object.assign(h.pictures.pictures.get(p.id) ?? {}, { state: 'reported' }),
    ],
    ['a removed picture', (h, p) => void Object.assign(h.pictures.pictures.get(p.id) ?? {}, { state: 'removed' })],
    ['a picture whose key is gone', (h, p) => void Object.assign(h.pictures.pictures.get(p.id) ?? {}, { key: null })],
    [
      'a hidden message',
      (h, p) => void Object.assign(h.room.messages.find((m) => m.id === p.id) ?? {}, { hiddenAt: START }),
    ],
    ['a muted writer', (h) => h.room.setWriter(HOLDER, { mutedAt: START, cutAt: START })],
    [
      'pictures switched off',
      (h) => void Object.assign(h.pictures, { off: { at: START, by: null, why: 'reports_day' } }),
    ],
    ['a picture seven days old', (h) => h.setNow('2026-10-27T11:00:00.000Z')],
    [
      'a picture below the newest 200 ids',
      (h) => {
        for (let n = 0; n < ROOM_SCAN; n += 1) h.room.seed(HOLDER, 'a line', POSTED);
      },
    ],
  ])('answers the generic 404 for %s, the same for every reason, and never asks KV', async (_name, arrange) => {
    const { h, picture } = shown();
    arrange(h, picture);
    const text = await generic404(h);
    expectGeneric404(await get(h, picture.id), text);
    expect(stepsOf(h.trace).at(-1)).toMatch(/^pictures\.getServable:/);
  });

  it('answers the generic 404 for an id no message has', async () => {
    const { h } = shown();
    const text = await generic404(h);
    expectGeneric404(await get(h, 77), text);
    expect(stepsOf(h.trace).at(-1)).toMatch(/^pictures\.getServable:77:/);
  });

  it('never serves a picture whose writer is an admin wallet now', async () => {
    const h = createHarness({ pictures: true });
    const picture = h.pictures.seedPicture(ADMIN, POSTED, { bytes: GIF.length });
    h.bytes.held.set(picture.picture?.key ?? '', { bytes: GIF, ttlSeconds: ROOM_PICTURE_TTL_SECONDS });
    const text = await generic404(h);
    expectGeneric404(await get(h, picture.id), text);
    expect(stepsOf(h.trace).at(-1)).toMatch(/^pictures\.getServable:/);
  });
});

describe('step 6: the views, counted by a sample', () => {
  it('counts a view once in 25 by adding 25, before the bytes are read', async () => {
    const { h, picture } = shown();
    h.draw.value = 0;
    expect((await get(h, picture.id)).status).toBe(200);
    expect(stepsOf(h.trace).slice(-3)).toEqual([
      'random',
      `pictures.addViews:${VIEWS_KEY}:${ROOM_PICTURE_VIEW_SAMPLE}`,
      'bytes.get',
    ]);
    expect(h.counters.get(VIEWS_KEY)).toBe(ROOM_PICTURE_VIEW_SAMPLE);
  });

  it.each<[number, boolean]>([
    [0, true],
    [1 / ROOM_PICTURE_VIEW_SAMPLE - 0.0001, true],
    [1 / ROOM_PICTURE_VIEW_SAMPLE, false],
    [0.5, false],
    [0.999999, false],
  ])('with a draw of %f it counts: %s', async (value, counts) => {
    const { h, picture } = shown();
    h.draw.value = value;
    expect((await get(h, picture.id)).status).toBe(200);
    expect(h.draw.asked).toBe(1);
    expect(h.counters.has(VIEWS_KEY)).toBe(counts);
  });

  it.each<[string, number, number | null]>([
    ['reaches the cap exactly', CAP - ROOM_PICTURE_VIEW_SAMPLE, CAP],
    ['passes the cap', CAP - 1, CAP - 1 + ROOM_PICTURE_VIEW_SAMPLE],
    ['stays below the cap', CAP - ROOM_PICTURE_VIEW_SAMPLE - 1, null],
  ])('logs the cap once, with the count, when the sample %s', async (_name, before, count) => {
    const { h, picture } = shown();
    h.counters.set(VIEWS_KEY, before);
    h.draw.value = 0;
    const lines = await logged(async () => {
      expect((await get(h, picture.id)).status).toBe(200);
    });
    expect(lines).toEqual(count === null ? [] : [{ event: ROOM_PICTURE_LOG_EVENTS.viewsCap, count }]);
  });

  it('serves no view that cannot be counted: 503, and KV is not asked', async () => {
    const { h, picture } = shown();
    h.draw.value = 0;
    h.pictures.fail.add('addViews');
    const reply = await get(h, picture.id);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toMatchObject({ code: ROOM_PICTURE_BYTES_FAILURE_CODE, field: null });
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_PICTURE_BYTES_RETRY_SECONDS));
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(h.trace).not.toContain('bytes.get');
  });
});

describe('steps 7 and 8: the bytes', () => {
  it('answers the generic 404 when KV has no such key, and does not touch the row', async () => {
    const { h, picture } = shown();
    h.bytes.held.clear();
    const before = h.ledger();
    const text = await generic404(h);
    expectGeneric404(await get(h, picture.id), text);
    expect(h.trace.at(-1)).toBe('bytes.get');
    expect(h.ledger()).toEqual(before);
  });

  it('answers 503 when KV throws', async () => {
    const { h, picture } = shown();
    h.bytes.fail.get = true;
    const reply = await get(h, picture.id);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toMatchObject({ code: ROOM_PICTURE_BYTES_FAILURE_CODE, field: null });
    expect(errorOf(reply).message.length).toBeGreaterThan(20);
    expect(reply.headers.get('Retry-After')).toBe(String(ROOM_PICTURE_BYTES_RETRY_SECONDS));
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers the generic 404 and a log line when KV holds another length than the row says', async () => {
    const { h, picture } = shown({ bytes: GIF.length + 1 });
    const text = await generic404(h);
    let reply: Reply | null = null;
    const lines = await logged(async () => {
      reply = await get(h, picture.id);
    });
    if (reply === null) throw new Error('no reply');
    expectGeneric404(reply, text);
    expect(lines).toEqual([{ event: ROOM_PICTURE_LOG_EVENTS.lengthMismatch, id: picture.id }]);
  });
});
