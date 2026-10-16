import {
  ROOM_AUDIT_ACTIONS,
  ROOM_PICTURE_AUDIT_ACTIONS,
  ROOM_PICTURE_BYTES_FAILURE_CODE,
  ROOM_PICTURE_BYTES_RETRY_SECONDS,
  ROOM_PICTURE_DELETES_PER_CALL,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_REPORTED_SHOWN,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURES_ADMIN_PATH,
  type RoomPictureMessageRecord,
  roomAdminWithPicturesResponseSchema,
  roomPictureAdminPath,
  roomPictureHeaders,
  roomPictureReportHidesKey,
  roomPictureReportsKey,
  roomPicturesAdminResponseSchema,
} from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  createHarness,
  DAY,
  errorOf,
  type Harness,
  HOLDER,
  OTHER,
  type Reply,
  type RequestOptions,
  START,
  stepsOf,
  THIRD,
} from './test-support.ts';
import { gifBytes } from './test-support-pictures.ts';

/**
 * The admin's side of pictures against docs/contracts/phase-6-pictures.md section 9: a hide and a mute
 * with their deletes, keep, the switch, the reported list and the admin's look. A store and the bytes in
 * memory, no D1, no KV.
 */

const POSTED = '2026-10-20T11:00:00.000Z';
const GIF = gifBytes();
const IMG = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' };
const OFF = `${ROOM_PICTURES_ADMIN_PATH}/off`;
const REPORTS_KEY = roomPictureReportsKey(DAY);
const HIDES_KEY = roomPictureReportHidesKey(DAY, 12);
const hidePath = (id: number): string => `/api/social/admin/room/messages/${id}`;
const mutePath = (id: number): string => `${hidePath(id)}/mute`;
const keepPath = (id: number): string => `${ROOM_PICTURES_ADMIN_PATH}/${id}/keep`;

/** Every JSON line written to either stream of the console while `run` ran, the audit lines among them. */
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

/** A picture of `author` whose bytes KV holds. */
function withBytes(h: Harness, author: string, at = POSTED): RoomPictureMessageRecord {
  const picture = h.pictures.seedPicture(author, at, { bytes: GIF.length });
  h.bytes.held.set(picture.picture?.key ?? '', { bytes: GIF, ttlSeconds: ROOM_PICTURE_TTL_SECONDS });
  return picture;
}

async function asAdmin(h: Harness, method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
  const cookie = await h.signIn(ADMIN);
  h.trace.length = 0;
  return h.fetch(method, path, { cookie, ...options });
}

async function generic404(h: Harness): Promise<string> {
  return (await h.fetch('GET', '/api/social/no-such-route')).text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('anyone who is not an admin session', () => {
  const routes: [string, string, RequestOptions][] = [
    ['GET', ROOM_PICTURES_ADMIN_PATH, {}],
    ['GET', roomPictureAdminPath(1), { headers: IMG }],
    ['PUT', keepPath(1), {}],
    ['PUT', OFF, {}],
    ['DELETE', OFF, {}],
  ];

  it.each(routes)(
    'gets the generic 404 on %s %s, with or without a session, whatever the switch says',
    async (method, path, options) => {
      for (const pictures of [true, false]) {
        const h = createHarness({ pictures });
        withBytes(h, OTHER);
        const text = await generic404(h);
        const before = h.ledger();
        for (const cookie of [undefined, await h.signIn(HOLDER)]) {
          h.trace.length = 0;
          const reply = await h.fetch(method, path, { ...options, ...(cookie === undefined ? {} : { cookie }) });
          expect(reply.status).toBe(404);
          expect(reply.text).toBe(text);
          expect(stepsOf(h.trace)).toEqual([]);
        }
        expect(h.ledger()).toEqual(before);
      }
    },
  );

  it.each(routes)('is mounted for an admin on %s %s while pictures are switched off', async (method, path, options) => {
    const h = createHarness({ pictures: false, given: false, roomEnabled: false });
    withBytes(h, OTHER);
    const reply = await asAdmin(h, method, path, options);
    expect([200, 204]).toContain(reply.status);
  });
});

describe('hiding a message (section 9)', () => {
  it('removes a picture in the store first, then deletes its bytes, then marks them gone', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    const key = picture.picture?.key ?? '';
    Object.assign(h.pictures.pictures.get(picture.id) ?? {}, { reports: 2 });
    let reply: Reply | null = null;
    const lines = await logged(async () => {
      reply = await asAdmin(h, 'DELETE', hidePath(picture.id));
    });
    expect((reply as Reply | null)?.status).toBe(204);
    expect(stepsOf(h.trace)).toEqual([
      'room.getMessage',
      `limiter:write:${ADMIN}`,
      `pictures.hideWithPicture:${picture.id}`,
      'bytes.delete',
      `pictures.markGone:${picture.id}`,
    ]);
    expect(h.bytes.deletes).toEqual([key]);
    expect(h.bytes.held.size).toBe(0);
    expect(h.pictures.pictures.get(picture.id)).toMatchObject({
      state: 'removed',
      key: null,
      goneAt: START,
      decidedBy: ADMIN,
    });
    expect(h.pictures.blocks.has(picture.picture?.sha256 ?? '')).toBe(true);
    // The audit line of a removal carries the picture's count of reports, a number, and no reporter.
    expect(lines).toEqual([
      { event: 'admin_action', admin: ADMIN, action: ROOM_AUDIT_ACTIONS.hide, target: String(picture.id), reports: 2 },
    ]);
  });

  it('hides a message of text as before: no delete, and an audit line with no count', async () => {
    const h = createHarness();
    const line = h.room.seed(HOLDER, 'a line', POSTED);
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'DELETE', hidePath(line.id))).status).toBe(204);
    });
    expect(stepsOf(h.trace)).toEqual([
      'room.getMessage',
      `limiter:write:${ADMIN}`,
      `pictures.hideWithPicture:${line.id}`,
    ]);
    expect(lines).toEqual([
      { event: 'admin_action', admin: ADMIN, action: ROOM_AUDIT_ACTIONS.hide, target: String(line.id) },
    ]);
    expect(h.trace).not.toContain('room.hideMessage');
  });

  it('still answers 204 when the delete throws: the picture is unservable, the key stays owed', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    h.bytes.fail.delete.add('*');
    let status = 0;
    const lines = await logged(async () => {
      status = (await asAdmin(h, 'DELETE', hidePath(picture.id))).status;
    });
    expect(status).toBe(204);
    expect(stepsOf(h.trace).slice(-2)).toEqual([`pictures.hideWithPicture:${picture.id}`, 'bytes.delete']);
    expect(h.pictures.pictures.get(picture.id)).toMatchObject({
      state: 'removed',
      key: picture.picture?.key,
      goneAt: null,
    });
    expect(lines.map((line) => line.event)).toEqual(['admin_action', ROOM_PICTURE_LOG_EVENTS.deleteFailed]);
    expect(lines[1]).toEqual({ event: ROOM_PICTURE_LOG_EVENTS.deleteFailed, id: picture.id });
    expect(JSON.stringify(lines[1])).not.toContain('pic/');
  });

  it('still answers 204 when the bytes cannot be marked gone, and leaves the delete to the sweep', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    h.pictures.fail.add('markGone');
    let status = 0;
    const lines = await logged(async () => {
      status = (await asAdmin(h, 'DELETE', hidePath(picture.id))).status;
    });
    expect(status).toBe(204);
    expect(lines.at(-1)).toEqual({ event: ROOM_PICTURE_LOG_EVENTS.deleteFailed, id: picture.id });
  });

  it('removes and audits the picture of a message an older API hid', async () => {
    const h = createHarness();
    const picture = h.pictures.seedPicture(HOLDER, POSTED, {}, START);
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'DELETE', hidePath(picture.id))).status).toBe(204);
    });
    expect(h.pictures.pictures.get(picture.id)?.state).toBe('removed');
    expect(lines.filter((line) => line.event === 'admin_action')).toHaveLength(1);
    expect(h.trace).toContain('bytes.delete');
  });

  it('tries an owed delete again at a second hide, and audits nothing: nothing changed', async () => {
    const h = createHarness();
    const picture = h.pictures.seedPicture(HOLDER, POSTED, { state: 'removed' }, START);
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'DELETE', hidePath(picture.id))).status).toBe(204);
    });
    expect(stepsOf(h.trace).slice(-2)).toEqual(['bytes.delete', `pictures.markGone:${picture.id}`]);
    expect(lines).toEqual([]);
  });

  it('asks KV nothing for a picture whose message is seven days old: the store gave up its key', async () => {
    const h = createHarness();
    const picture = h.pictures.seedPicture(HOLDER, '2026-10-13T12:00:00.000Z');
    await logged(async () => {
      expect((await asAdmin(h, 'DELETE', hidePath(picture.id))).status).toBe(204);
    });
    expect(h.trace.filter((step) => step.startsWith('bytes.') || step.startsWith('pictures.markGone'))).toEqual([]);
    expect(h.pictures.pictures.get(picture.id)).toMatchObject({ state: 'removed', key: null, goneAt: START });
  });

  it('answers the generic 404 when the prune took the message between the look and the write', async () => {
    const h = createHarness();
    const line = h.room.seed(HOLDER, 'a line', POSTED);
    const text = await generic404(h);
    h.room.afterGetMessage = () => void h.room.messages.splice(0);
    const lines = await logged(async () => {
      const reply = await asAdmin(h, 'DELETE', hidePath(line.id));
      expect(reply.status).toBe(404);
      expect(reply.text).toBe(text);
    });
    expect(lines).toEqual([]);
  });
});

describe('muting a writer (section 9)', () => {
  it("removes the writer's pictures in the store first, deletes their bytes newest first, and marks them once", async () => {
    const h = createHarness();
    const first = withBytes(h, HOLDER);
    const second = withBytes(h, HOLDER);
    const line = h.room.seed(HOLDER, 'a line', POSTED);
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'PUT', mutePath(line.id))).status).toBe(204);
    });
    expect(stepsOf(h.trace)).toEqual([
      'room.getMessage',
      `limiter:write:${ADMIN}`,
      `pictures.muteWithPictures:${ROOM_PICTURE_DELETES_PER_CALL}`,
      'bytes.delete',
      'bytes.delete',
      `pictures.markGone:${second.id},${first.id}`,
    ]);
    expect(h.bytes.deletes).toEqual([second.picture?.key, first.picture?.key]);
    expect(h.pictures.blocks.size).toBe(0);
    expect(h.room.writers.get(HOLDER)?.mutedAt).toBe(START);
    // A mute's audit line carries no count: it judges a writer, not a picture.
    expect(lines).toEqual([
      { event: 'admin_action', admin: ADMIN, action: ROOM_AUDIT_ACTIONS.mute, target: String(line.id) },
    ]);
    expect(h.trace).not.toContain('room.muteWriter');
  });

  it('logs a delete that throws, goes on with the others, and marks only those that answered', async () => {
    const h = createHarness();
    const first = withBytes(h, HOLDER);
    const second = withBytes(h, HOLDER);
    const third = withBytes(h, HOLDER);
    h.bytes.fail.delete.add(second.picture?.key ?? '');
    let status = 0;
    const lines = await logged(async () => {
      status = (await asAdmin(h, 'PUT', mutePath(first.id))).status;
    });
    expect(status).toBe(204);
    expect(h.bytes.deletes).toHaveLength(3);
    expect(stepsOf(h.trace).at(-1)).toBe(`pictures.markGone:${third.id},${first.id}`);
    expect(lines.at(-1)).toEqual({ event: ROOM_PICTURE_LOG_EVENTS.deleteFailed, id: second.id });
    expect(h.pictures.pictures.get(second.id)).toMatchObject({ state: 'removed', key: second.picture?.key });
  });

  it('marks nothing when no delete answered', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    h.bytes.fail.delete.add('*');
    await logged(async () => {
      expect((await asAdmin(h, 'PUT', mutePath(picture.id))).status).toBe(204);
    });
    expect(h.trace.filter((step) => step.startsWith('pictures.markGone'))).toEqual([]);
  });

  it('audits a second mute that removed a picture, and not one that changed nothing', async () => {
    const h = createHarness();
    const line = h.room.seed(HOLDER, 'a line', POSTED);
    h.room.setWriter(HOLDER, { mutedAt: POSTED, mutedBy: ADMIN, cutAt: POSTED });
    const quiet = await logged(async () => {
      expect((await asAdmin(h, 'PUT', mutePath(line.id))).status).toBe(204);
    });
    expect(quiet).toEqual([]);
    // A picture stored while the first mute was on its way.
    withBytes(h, HOLDER);
    const loud = await logged(async () => {
      expect((await asAdmin(h, 'PUT', mutePath(line.id))).status).toBe(204);
    });
    expect(loud.filter((entry) => entry.event === 'admin_action')).toHaveLength(1);
  });

  it('books nothing against a budget of the day, with pictures to delete', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    Object.assign(h.limits, { walletWritesLeft: 0, rowsLeft: 0 });
    await logged(async () => {
      expect((await asAdmin(h, 'PUT', mutePath(picture.id))).status).toBe(204);
      expect((await asAdmin(h, 'DELETE', hidePath(picture.id))).status).toBe(204);
    });
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
  });
});

describe('PUT /api/social/admin/room/pictures/:id/keep', () => {
  it("keeps a reported picture: the limiter, the store, an audit line by the message's id", async () => {
    const h = createHarness();
    const picture = h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported', reports: 3 });
    h.pictures.reports.push({ messageId: picture.id, reporter: OTHER, at: POSTED });
    const lines = await logged(async () => {
      const reply = await asAdmin(h, 'PUT', keepPath(picture.id));
      expect(reply.status).toBe(204);
      expect(reply.headers.get('Cache-Control')).toBe('no-store');
    });
    expect(stepsOf(h.trace)).toEqual([`limiter:write:${ADMIN}`, `pictures.keepPicture:${picture.id}`]);
    expect(h.pictures.pictures.get(picture.id)).toMatchObject({ state: 'kept', decidedBy: ADMIN, decidedAt: START });
    expect(h.pictures.extras.get(OTHER)?.reportStrikes).toBe(1);
    expect(lines).toEqual([
      { event: 'admin_action', admin: ADMIN, action: ROOM_PICTURE_AUDIT_ACTIONS.keep, target: String(picture.id) },
    ]);
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
  });

  it('answers 204 for a picture that was kept already, and audits nothing', async () => {
    const h = createHarness();
    const picture = h.pictures.seedPicture(HOLDER, POSTED, { state: 'kept' });
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'PUT', keepPath(picture.id))).status).toBe(204);
    });
    expect(lines).toEqual([]);
  });

  it('answers the generic 404 for a removed picture, a message of text and an id no message has', async () => {
    const h = createHarness();
    const removed = h.pictures.seedPicture(HOLDER, POSTED, { state: 'removed' });
    const line = h.room.seed(HOLDER, 'a line', POSTED);
    const text = await generic404(h);
    const lines = await logged(async () => {
      for (const id of [removed.id, line.id, 99]) {
        const reply = await asAdmin(h, 'PUT', keepPath(id));
        expect(reply.status).toBe(404);
        expect(reply.text).toBe(text);
        expect(stepsOf(h.trace).at(-1)).toBe(`pictures.keepPicture:${id}`);
      }
    });
    expect(lines).toEqual([]);
  });

  it('answers the generic 404 for an id that is none, before the limiter', async () => {
    const h = createHarness();
    const text = await generic404(h);
    const reply = await asAdmin(h, 'PUT', `${ROOM_PICTURES_ADMIN_PATH}/abc/keep`);
    expect(reply.text).toBe(text);
    expect(stepsOf(h.trace)).toEqual([]);
  });

  it('is refused from another site and by the limiter, with nothing written', async () => {
    const h = createHarness();
    const picture = h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported' });
    expect((await asAdmin(h, 'PUT', keepPath(picture.id), { origin: 'https://evil.test' })).status).toBe(403);
    h.limiter.denied.add('write');
    expect((await asAdmin(h, 'PUT', keepPath(picture.id))).status).toBe(429);
    expect(h.pictures.pictures.get(picture.id)?.state).toBe('reported');
  });
});

describe('the switch that needs no deploy (section 9)', () => {
  it('switches pictures off for an admin, and audits it once', async () => {
    const h = createHarness();
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'PUT', OFF)).status).toBe(204);
      expect(stepsOf(h.trace)).toEqual([`limiter:write:${ADMIN}`, 'pictures.setPicturesOff:admin']);
      expect((await asAdmin(h, 'PUT', OFF)).status).toBe(204);
    });
    expect(h.pictures.off).toEqual({ at: START, by: ADMIN, why: 'admin' });
    expect(lines).toEqual([
      { event: 'admin_action', admin: ADMIN, action: ROOM_PICTURE_AUDIT_ACTIONS.off, target: 'pictures' },
    ]);
  });

  it("switches pictures on, and gives the room its day's reports and its hour's hides again", async () => {
    const h = createHarness();
    h.pictures.off = { at: POSTED, by: null, why: 'reports_day' };
    h.counters.set(REPORTS_KEY, 100);
    h.counters.set(HIDES_KEY, 5);
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'DELETE', OFF)).status).toBe(204);
    });
    expect(stepsOf(h.trace)).toEqual([
      `limiter:write:${ADMIN}`,
      `pictures.clearPicturesOff:${REPORTS_KEY}:${HIDES_KEY}`,
    ]);
    expect(h.pictures.off).toBeNull();
    expect(h.counters.has(REPORTS_KEY)).toBe(false);
    expect(h.counters.has(HIDES_KEY)).toBe(false);
    expect(lines).toEqual([
      { event: 'admin_action', admin: ADMIN, action: ROOM_PICTURE_AUDIT_ACTIONS.on, target: 'pictures' },
    ]);
  });

  it('answers 204 and audits nothing when there was nothing to switch on', async () => {
    const h = createHarness();
    h.counters.set(REPORTS_KEY, 40);
    const lines = await logged(async () => {
      expect((await asAdmin(h, 'DELETE', OFF)).status).toBe(204);
    });
    expect(lines).toEqual([]);
    expect(h.counters.get(REPORTS_KEY)).toBe(40);
  });

  it.each(['PUT', 'DELETE'])(
    '%s is refused from another site and by the limiter, and books nothing',
    async (method) => {
      const h = createHarness();
      Object.assign(h.limits, { walletWritesLeft: 0, rowsLeft: 0 });
      expect((await asAdmin(h, method, OFF, { origin: 'https://evil.test' })).status).toBe(403);
      expect((await asAdmin(h, method, OFF)).status).toBe(204);
      h.limiter.denied.add('write');
      expect((await asAdmin(h, method, OFF)).status).toBe(429);
      expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
    },
  );

  it('keeps a reported picture while pictures are off', async () => {
    const h = createHarness();
    const picture = h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported' });
    h.pictures.off = { at: POSTED, by: null, why: 'reports_hour' };
    await logged(async () => {
      expect((await asAdmin(h, 'PUT', keepPath(picture.id))).status).toBe(204);
    });
    expect(h.pictures.pictures.get(picture.id)?.state).toBe('kept');
  });
});

describe('GET /api/social/admin/room/pictures', () => {
  it('lists the reported pictures, oldest first, with whole addresses, and whether pictures are off', async () => {
    const h = createHarness();
    const first = h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported', reports: 3 });
    h.pictures.seedPicture(HOLDER, POSTED);
    const second = h.pictures.seedPicture(OTHER, POSTED, { state: 'reported', reports: 3 });
    h.pictures.reports.push({ messageId: first.id, reporter: THIRD, at: START });
    h.pictures.off = { at: START, by: null, why: 'reports_hour' };
    const reply = await asAdmin(h, 'GET', ROOM_PICTURES_ADMIN_PATH);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    const body = roomPicturesAdminResponseSchema.parse(reply.json);
    const facts = {
      type: 'gif',
      width: 16,
      height: 16,
      bytes: 37,
      frames: 1,
      state: 'reported',
      reports: 3,
      viewable: true,
      bytesGone: false,
    };
    expect(body).toEqual({
      off: { at: START, by: null, why: 'reports_hour' },
      reported: [
        {
          id: first.id,
          at: POSTED,
          author: HOLDER,
          picture: { ...facts, sha256Short: first.picture?.sha256.slice(0, 12) },
          reporters: [{ address: THIRD, at: START }],
        },
        {
          id: second.id,
          at: POSTED,
          author: OTHER,
          picture: { ...facts, sha256Short: second.picture?.sha256.slice(0, 12) },
          reporters: [],
        },
      ],
      more: false,
    });
    expect(reply.text).not.toContain('pic/');
    expect(reply.text).not.toContain(first.picture?.sha256 ?? 'none');
  });

  it('shows at most twenty and says that there are more', async () => {
    const h = createHarness();
    for (let n = 0; n <= ROOM_PICTURE_REPORTED_SHOWN; n += 1)
      h.pictures.seedPicture(HOLDER, POSTED, { state: 'reported' });
    const body = roomPicturesAdminResponseSchema.parse((await asAdmin(h, 'GET', ROOM_PICTURES_ADMIN_PATH)).json);
    expect(body.reported).toHaveLength(ROOM_PICTURE_REPORTED_SHOWN);
    expect(body.reported[0]?.id).toBe(1);
    expect(body.more).toBe(true);
    expect(body.off).toBeNull();
    expect(h.trace).toContain(`pictures.listReported:${ROOM_PICTURE_REPORTED_SHOWN + 1}`);
  });
});

describe('GET /api/social/admin/room?before= with pictures', () => {
  it('gives each picture message its facts, its state, its count of reports and whether its bytes are gone', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', POSTED);
    const live = h.pictures.seedPicture(HOLDER, POSTED, { reports: 1 });
    h.pictures.seedPicture(HOLDER, POSTED, { state: 'removed', key: null, goneAt: START });
    h.pictures.seedPicture(HOLDER, POSTED, { state: 'removed' });
    h.pictures.seedPicture(ADMIN, POSTED);
    h.pictures.seedPicture(HOLDER, '2026-10-13T12:00:00.000Z');
    h.pictures.seedPicture(HOLDER, POSTED, {}, START);
    const reply = await asAdmin(h, 'GET', '/api/social/admin/room');
    const body = roomAdminWithPicturesResponseSchema.parse(reply.json);
    const pictures = body.messages.map((message) => message.picture ?? null).reverse();
    expect(pictures[0]).toBeNull();
    expect(pictures[1]).toEqual({
      type: 'gif',
      width: 16,
      height: 16,
      bytes: 37,
      frames: 1,
      sha256Short: live.picture?.sha256.slice(0, 12),
      state: 'ok',
      reports: 1,
      viewable: true,
      bytesGone: false,
    });
    expect(pictures.slice(2).map((picture) => [picture?.state, picture?.viewable, picture?.bytesGone])).toEqual([
      ['removed', false, true],
      ['removed', false, false],
      ['ok', false, false],
      ['ok', false, false],
      ['ok', false, false],
    ]);
    expect(reply.text).not.toContain('pic/');
    expect(reply.text).not.toContain(live.picture?.sha256 ?? 'none');
    expect(h.trace).not.toContain('room.listAllMessages:null:51');
  });
});

describe("the admin's look (section 9)", () => {
  it('serves a reported picture while pictures are off, with the header set, and counts no view', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    Object.assign(h.pictures.pictures.get(picture.id) ?? {}, { state: 'reported' });
    h.pictures.off = { at: START, by: null, why: 'reports_hour' };
    for (let n = 0; n < 300; n += 1) h.room.seed(OTHER, 'a line', POSTED);
    h.draw.value = 0;
    const reply = await asAdmin(h, 'GET', roomPictureAdminPath(picture.id), { headers: IMG });
    expect(reply.status).toBe(200);
    expect([...reply.raw]).toEqual([...GIF]);
    const expected = Object.entries(roomPictureHeaders(picture.id, 'gif', GIF.length)).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]);
    expect([...reply.headers.entries()].sort()).toEqual(expected.sort());
    expect(stepsOf(h.trace)).toEqual([
      'limiter:picture:203.0.113.9',
      `pictures.getAdminPicture:${picture.id}`,
      'bytes.get',
    ]);
  });

  it.each<[string, Record<string, string | null>]>([
    ['no Sec-Fetch-Dest', { 'Sec-Fetch-Dest': null }],
    ['a document', { 'Sec-Fetch-Dest': 'document' }],
    ['a script', { 'Sec-Fetch-Dest': 'script' }],
    ['another site', { 'Sec-Fetch-Site': 'cross-site' }],
  ])('answers the generic 404 to %s before the session is read', async (_name, headers) => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    const text = await generic404(h);
    const reply = await asAdmin(h, 'GET', roomPictureAdminPath(picture.id), { headers: { ...IMG, ...headers } });
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(text);
    expect(h.trace.filter((step) => !step.startsWith('limiter:read:'))).toEqual([]);
  });

  it('answers the generic 404 for a HEAD, always, and runs nothing', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    const reply = await asAdmin(h, 'HEAD', roomPictureAdminPath(picture.id), { headers: IMG });
    expect(reply.status).toBe(404);
    expect(h.trace.filter((step) => !step.startsWith('limiter:read:'))).toEqual([]);
  });

  it('answers the generic 404 for an id that is none, and for `off`, before the limiter', async () => {
    const h = createHarness();
    const text = await generic404(h);
    for (const id of ['abc', '0', 'off']) {
      const reply = await asAdmin(h, 'GET', `${ROOM_PICTURES_ADMIN_PATH}/${id}`, { headers: IMG });
      expect(reply.text).toBe(text);
      expect(stepsOf(h.trace)).toEqual([]);
    }
  });

  it('counts the look against the network of the request, and answers 429 when the rule refuses', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    h.pictureLimiter.denied = true;
    const reply = await asAdmin(h, 'GET', roomPictureAdminPath(picture.id), {
      headers: IMG,
      ip: '2001:db8:1:2:3:4:5:6',
    });
    expect(reply.status).toBe(429);
    expect(errorOf(reply).code).toBe('rate_limited');
    expect(h.pictureLimiter.asked).toEqual(['2001:db8:1::']);
    expect(stepsOf(h.trace)).toEqual(['limiter:picture:2001:db8:1::']);
  });

  it('answers the generic 404 for a removed picture and for one whose writer is an admin wallet now', async () => {
    const h = createHarness();
    const removed = h.pictures.seedPicture(HOLDER, POSTED, { state: 'removed' });
    const own = withBytes(h, ADMIN);
    const text = await generic404(h);
    for (const id of [removed.id, own.id, 99]) {
      const reply = await asAdmin(h, 'GET', roomPictureAdminPath(id), { headers: IMG });
      expect(reply.status).toBe(404);
      expect(reply.text).toBe(text);
      expect(stepsOf(h.trace).at(-1)).toBe(`pictures.getAdminPicture:${id}`);
    }
  });

  it('answers 503 when KV throws, and the generic 404 when KV has no such key', async () => {
    const h = createHarness();
    const picture = withBytes(h, HOLDER);
    h.bytes.fail.get = true;
    const failed = await asAdmin(h, 'GET', roomPictureAdminPath(picture.id), { headers: IMG });
    expect(failed.status).toBe(503);
    expect(errorOf(failed)).toMatchObject({ code: ROOM_PICTURE_BYTES_FAILURE_CODE, field: null });
    expect(failed.headers.get('Retry-After')).toBe(String(ROOM_PICTURE_BYTES_RETRY_SECONDS));
    h.bytes.fail.get = false;
    h.bytes.held.clear();
    expect((await asAdmin(h, 'GET', roomPictureAdminPath(picture.id), { headers: IMG })).status).toBe(404);
  });
});
