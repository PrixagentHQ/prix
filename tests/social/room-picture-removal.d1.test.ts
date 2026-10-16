import { env as baseEnv } from 'cloudflare:workers';
import {
  API_WRITE_ROWS_PER_DAY,
  ROOM_PICTURE_DELETES_PER_CALL,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_SWEEP_JOB,
  ROOM_PICTURE_SWEEP_PER_RUN,
  ROOM_PICTURE_TEXT,
  ROOM_PICTURE_TTL_SECONDS,
  ROOM_PICTURES_ADMIN_PATH,
  ROOM_SECONDS_BETWEEN,
  roomAdminWithPicturesResponseSchema,
  roomMeWithPicturesResponseSchema,
  roomPicturePath,
  roomPictureViewsKey,
  roomResponseSchema,
  roomWithPicturesResponseSchema,
  socialJobNameSchema,
  WALLET_WRITES_PER_DAY,
} from '@prix/contracts';
import { createRoomPictureSweepJob } from '@prix/runtime/social/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import type { Reply } from './api/harness.ts';
import { errorOf } from './api/harness.ts';
import { db, jobDeps, storesOn } from './support/d1.ts';
import { GIF_SMALLEST, gifTinted, JPEG_SMALLEST, PNG_SMALLEST } from './support/picture-files.ts';
import type { PictureWorld, SeededPicture, WorldOptions } from './support/pictures.ts';
import {
  ADMIN,
  createPictureWorld,
  emptyPictureTables,
  eventsOf,
  pictureRow,
  pictureRows,
  seedCount,
  seedPicture,
  seedWriter,
} from './support/pictures.ts';

/**
 * Taking a picture away, and what a page is told of pictures (docs/contracts/phase-6-pictures.md sections
 * 2, 9 and 10, at revision 3), behind `createApp` on the real stores of a local D1 and the real bytes
 * port over a KV of the test's own.
 *
 * A hide and a mute make the picture unservable in the same D1 batch as the hide and the mute, before any
 * KV call, and answer 204 whatever KV then does: against a KV whose delete throws, one that has no
 * binding, and one that still answers after its delete. What a delete could not take is owed, and the
 * sweep job deletes it.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';

const WRITER = '0x00000000000000000000000000000000000005b2';
const SECOND = '0x00000000000000000000000000000000000005b3';
const hidePath = (id: number): string => `/api/social/admin/room/messages/${id}`;
const mutePath = (id: number): string => `/api/social/admin/room/messages/${id}/mute`;

function world(options: WorldOptions = {}): PictureWorld {
  return createPictureWorld(db, { now: NOW, ...options });
}

const at = (secondsAgo: number): string => new Date(Date.parse(NOW) - secondsAgo * 1_000).toISOString();
const since = (w: PictureWorld, mark: number): string[] => w.trace.slice(mark);
function expectNotFound(reply: Reply, name = ''): void {
  expect(reply.status, name).toBe(404);
  expect(errorOf(reply).code, name).toBe('not_found');
}

let logged: unknown[][] = [];
const events = (name: string): unknown[] => eventsOf(logged).filter((line) => line.event === name);
const audits = (): unknown[] => events('admin_action');

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

describe("an admin's hide of a picture message", () => {
  it('removes the picture in the batch of the hide, blocks its bytes, then deletes them and marks them gone', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, JPEG_SMALLEST, { at: at(600), reports: 2 });
    const admin = await w.signIn(ADMIN);
    const mark = w.trace.length;

    const reply = await w.fetch('DELETE', hidePath(picture.id), { cookie: admin });

    expect(reply.status).toBe(204);
    expect(await pictureRow(db, picture.id)).toMatchObject({
      hidden_at: NOW,
      pic_state: 'removed',
      pic_decided_by: ADMIN,
      pic_key: null,
      pic_gone_at: NOW,
    });
    expect(w.kv.deletes).toEqual([picture.key]);
    expect(w.kv.held.size).toBe(0);
    // The record of the removal: the hash and the facts, the writer, the admin, the count. No bytes.
    expect(await db.prepare('SELECT * FROM room_picture_blocks').first()).toEqual({
      sha256: picture.sha256,
      at: NOW,
      by: ADMIN,
      message_id: picture.id,
      author: WRITER,
      posted_at: at(600),
      type: 'jpeg',
      bytes: picture.bytes.length,
      width: 16,
      height: 16,
      frames: 1,
      reports: 2,
    });
    // D1 refuses the picture before KV is asked anything: the writes of the batch stand before the delete.
    const asked = since(w, mark);
    const removed = asked.findIndex((step) => /^d1 update room_messages\b.*pic_state/i.test(step));
    const deleted = asked.indexOf('kv.delete');
    expect(removed).toBeGreaterThan(-1);
    expect(deleted).toBeGreaterThan(removed);
    expect(asked.filter((step) => step.startsWith('kv.'))).toEqual(['kv.delete']);
    expect(audits()).toEqual([
      { event: 'admin_action', admin: ADMIN, action: 'room_hide', target: String(picture.id), reports: 2 },
    ]);
  });

  it('answers 204 when the delete throws, leaves the picture unservable and the delete owed, and says so with the id', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST, { at: at(600) });
    const admin = await w.signIn(ADMIN);
    w.kv.fail.add('delete');

    const reply = await w.fetch('DELETE', hidePath(picture.id), { cookie: admin });

    expect(reply.status).toBe(204);
    expect(await pictureRow(db, picture.id)).toMatchObject({
      hidden_at: NOW,
      pic_state: 'removed',
      pic_key: picture.key,
      pic_gone_at: null,
    });
    expect(events(ROOM_PICTURE_LOG_EVENTS.deleteFailed)).toEqual([
      { event: 'room_picture_delete_failed', id: picture.id },
    ]);
    // KV still holds the bytes, and no route hands them out.
    expect(w.kv.held.has(picture.key)).toBe(true);
    w.kv.fail.clear();
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(404);
    expect((await w.image(`${ROOM_PICTURES_ADMIN_PATH}/${picture.id}`, { cookie: admin })).status).toBe(404);
    expect(w.kv.gets).toEqual([]);
    expect(await w.deps.pictures.listOwedDeletes(10)).toEqual([{ id: picture.id, key: picture.key }]);
  });

  it('answers 204 while there is no KV binding at all, and leaves the delete owed', async () => {
    const seeded = world();
    const picture = await seedPicture(seeded, WRITER, GIF_SMALLEST, { at: at(600) });
    const w = world({ kv: null });
    const admin = await w.signIn(ADMIN);

    expect((await w.fetch('DELETE', hidePath(picture.id), { cookie: admin })).status).toBe(204);

    expect(await pictureRow(db, picture.id)).toMatchObject({ pic_state: 'removed', pic_key: picture.key });
    expect(events(ROOM_PICTURE_LOG_EVENTS.deleteFailed)).toHaveLength(1);
    expect((await w.image(roomPicturePath(picture.id))).status).toBe(404);
  });

  it('tries the delete again at a second hide while the key is owed, and audits nothing the second time', async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST, { at: at(600) });
    const admin = await w.signIn(ADMIN);
    w.kv.fail.add('delete');
    await w.fetch('DELETE', hidePath(picture.id), { cookie: admin });
    w.kv.fail.clear();

    expect((await w.fetch('DELETE', hidePath(picture.id), { cookie: admin })).status).toBe(204);

    expect(w.kv.deletes).toEqual([picture.key, picture.key]);
    expect(await pictureRow(db, picture.id)).toMatchObject({ pic_key: null, pic_gone_at: NOW });
    expect(audits()).toHaveLength(1);
  });

  it('gives up the key of a picture seven days old in its own batch, with no KV call', async () => {
    const w = world();
    const old = await seedPicture(w, WRITER, GIF_SMALLEST, { at: at(ROOM_PICTURE_TTL_SECONDS) });
    const admin = await w.signIn(ADMIN);

    expect((await w.fetch('DELETE', hidePath(old.id), { cookie: admin })).status).toBe(204);

    expect(await pictureRow(db, old.id)).toMatchObject({ pic_state: 'removed', pic_key: null, pic_gone_at: NOW });
    expect(w.kv.calls()).toBe(0);
    expect(await w.deps.pictures.listOwedDeletes(10)).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM room_picture_blocks').first()).toEqual({ n: 1 });
  });

  it("clears the writer's first message when it hides the one that set it: the writer cannot upload", async () => {
    const w = world();
    const { cookie, firstId } = await seedWriter(w, WRITER, { ageSeconds: 7_200 });
    const admin = await w.signIn(ADMIN);
    // Before the hide the wallet may upload.
    expect(
      roomMeWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room/me', { cookie })).json).picture,
    ).toBe('yes');

    expect((await w.fetch('DELETE', hidePath(firstId), { cookie: admin })).status).toBe(204);

    expect(
      (
        await db
          .prepare('SELECT first_at FROM room_writers WHERE address = ?1')
          .bind(WRITER)
          .first<{ first_at: string | null }>()
      )?.first_at,
    ).toBeNull();
    const refused = await w.upload(GIF_SMALLEST, { cookie });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).field).toBe('picture_new_writer');
    const me = roomMeWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room/me', { cookie })).json);
    expect(me).toMatchObject({ write: 'yes', picture: 'new_writer', picturesLeft: 0, report: false });

    // The next stored message starts the hour again.
    w.advance(60_000);
    expect((await w.fetch('POST', '/api/social/room', { cookie, body: { text: 'a second first line' } })).status).toBe(
      201,
    );
    w.advance(3_599_000);
    expect(errorOf(await w.upload(GIF_SMALLEST, { cookie })).field).toBe('picture_new_writer');
    w.advance(1_000);
    expect((await w.upload(GIF_SMALLEST, { cookie })).status).toBe(201);
  });

  it('leaves the first message as it is when it hides a later one', async () => {
    const w = world();
    const { cookie, firstAt } = await seedWriter(w, WRITER);
    const later = await createRoomStore(db).putMessage(WRITER, 'a later line', at(60));
    const admin = await w.signIn(ADMIN);

    expect((await w.fetch('DELETE', hidePath(later.id), { cookie: admin })).status).toBe(204);

    expect(
      (
        await db
          .prepare('SELECT first_at FROM room_writers WHERE address = ?1')
          .bind(WRITER)
          .first<{ first_at: string }>()
      )?.first_at,
    ).toBe(firstAt);
    expect((await w.upload(GIF_SMALLEST, { cookie })).status).toBe(201);
  });
});

describe("an admin's mute of a writer with pictures", () => {
  async function gallery(w: PictureWorld): Promise<{ fresh: SeededPicture[]; old: SeededPicture; text: number }> {
    const { firstId } = await seedWriter(w, WRITER, { ageSeconds: 9 * 86_400 });
    const old = await seedPicture(w, WRITER, gifTinted(1), { at: at(ROOM_PICTURE_TTL_SECONDS + 60) });
    const fresh = [
      await seedPicture(w, WRITER, gifTinted(2), { at: at(3 * 86_400) }),
      await seedPicture(w, WRITER, gifTinted(3), { at: at(3_600), state: 'reported', reports: 3 }),
      await seedPicture(w, WRITER, gifTinted(4), { at: at(600), state: 'kept' }),
    ];
    return { fresh, old, text: firstId };
  }

  it('removes every picture of the writer in the batch of the mute, deletes the keys newest first, and blocks no bytes', async () => {
    const w = world();
    const { fresh, old, text } = await gallery(w);
    const other = await seedPicture(w, SECOND, PNG_SMALLEST, { at: at(500) });
    const admin = await w.signIn(ADMIN);
    const mark = w.trace.length;

    const reply = await w.fetch('PUT', mutePath(text), { cookie: admin });

    expect(reply.status).toBe(204);
    for (const picture of fresh) {
      expect(await pictureRow(db, picture.id)).toMatchObject({ pic_state: 'removed', pic_key: null, pic_gone_at: NOW });
    }
    // Newest first, and none for the picture older than seven days: its key was given up in the batch.
    expect(w.kv.deletes).toEqual([...fresh].reverse().map((picture) => picture.key));
    expect(await pictureRow(db, old.id)).toMatchObject({ pic_state: 'removed', pic_key: null, pic_gone_at: NOW });
    // Another writer's picture is untouched.
    expect(await pictureRow(db, other.id)).toMatchObject({ pic_state: 'ok', pic_key: other.key });
    expect((await w.image(roomPicturePath(other.id))).status).toBe(200);
    // A mute judges a writer, not a picture: no block row.
    expect(await db.prepare('SELECT COUNT(*) AS n FROM room_picture_blocks').first()).toEqual({ n: 0 });
    const asked = since(w, mark);
    const firstDelete = asked.indexOf('kv.delete');
    expect(asked.findIndex((step) => /^d1 update room_messages\b.*pic_state/i.test(step))).toBeLessThan(firstDelete);
    expect(audits()).toEqual([{ event: 'admin_action', admin: ADMIN, action: 'room_mute', target: String(text) }]);
  });

  it('answers 204 when a delete throws, marks the others gone, and leaves that one owed', async () => {
    const w = world();
    const { fresh, text } = await gallery(w);
    const admin = await w.signIn(ADMIN);
    const stuck = fresh[1] as SeededPicture;
    const real = w.kv.delete.bind(w.kv);
    w.kv.delete = async (key: string) => {
      if (key === stuck.key) {
        w.kv.deletes.push(key);
        throw new Error('KV delete failed');
      }
      return real(key);
    };

    expect((await w.fetch('PUT', mutePath(text), { cookie: admin })).status).toBe(204);

    expect(w.kv.deletes).toHaveLength(3);
    expect(await pictureRow(db, stuck.id)).toMatchObject({
      pic_state: 'removed',
      pic_key: stuck.key,
      pic_gone_at: null,
    });
    for (const picture of [fresh[0], fresh[2]] as SeededPicture[]) {
      expect((await pictureRow(db, picture.id))?.pic_key).toBeNull();
    }
    expect(events(ROOM_PICTURE_LOG_EVENTS.deleteFailed)).toEqual([
      { event: 'room_picture_delete_failed', id: stuck.id },
    ]);
    expect(await w.deps.pictures.listOwedDeletes(10)).toEqual([{ id: stuck.id, key: stuck.key }]);
    // No picture of the writer is served, deleted or not.
    for (const picture of fresh) expect((await w.image(roomPicturePath(picture.id))).status).toBe(404);
    expect(w.kv.gets).toEqual([]);
  });

  it('hands back at most the 24 keys a span of seven days can hold', () => {
    // Three a day on each of the eight UTC days seven times 24 hours touch.
    expect(ROOM_PICTURE_DELETES_PER_CALL).toBe(3 * 8);
  });

  it('gives nothing back at a lift: the pictures stay removed, and the wallet writes again but adds no picture', async () => {
    const w = world();
    const { fresh, text } = await gallery(w);
    const admin = await w.signIn(ADMIN);
    await w.fetch('PUT', mutePath(text), { cookie: admin });

    expect((await w.fetch('DELETE', mutePath(text), { cookie: admin })).status).toBe(204);

    for (const picture of fresh) expect((await pictureRow(db, picture.id))?.pic_state).toBe('removed');
    const cookie = await w.signIn(WRITER);
    w.advance(ROOM_SECONDS_BETWEEN * 1_000);
    expect((await w.fetch('POST', '/api/social/room', { cookie, body: { text: 'back again' } })).status).toBe(201);
    w.advance(2 * 3_600_000);
    const refused = await w.upload(gifTinted(9), { cookie });
    expect(refused.status).toBe(403);
    expect(errorOf(refused).field).toBe('picture_not_allowed');
    const me = roomMeWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room/me', { cookie })).json);
    expect(me).toMatchObject({ write: 'yes', picture: 'no', report: false });
  });

  it('audits a second mute of a muted writer only when it removed a picture', async () => {
    const w = world();
    const { text } = await gallery(w);
    const admin = await w.signIn(ADMIN);
    await w.fetch('PUT', mutePath(text), { cookie: admin });
    expect(audits()).toHaveLength(1);

    // Nothing left to remove: no change, no line.
    await w.fetch('PUT', mutePath(text), { cookie: admin });
    expect(audits()).toHaveLength(1);

    // A picture that an older API let through after the mute.
    const late = await seedPicture(w, WRITER, gifTinted(8), { at: NOW });
    expect((await w.fetch('PUT', mutePath(text), { cookie: admin })).status).toBe(204);
    expect((await pictureRow(db, late.id))?.pic_state).toBe('removed');
    expect(audits()).toHaveLength(2);
  });
});

describe('a removal, a keep and the switch against a spent budget', () => {
  it('are never refused for it: none of them is booked against the day', async () => {
    const w = world();
    const { firstId } = await seedWriter(w, WRITER);
    const hidden = await seedPicture(w, WRITER, gifTinted(1), { at: at(900) });
    const kept = await seedPicture(w, SECOND, gifTinted(2), { at: at(800), state: 'reported', reports: 3 });
    const admin = await w.signIn(ADMIN);
    await db
      .prepare('UPDATE users SET write_day = ?2, write_count = ?3 WHERE address = ?1')
      .bind(ADMIN, DAY, WALLET_WRITES_PER_DAY)
      .run();
    await db.prepare('INSERT INTO api_writes (day, rows) VALUES (?1, ?2)').bind(DAY, API_WRITE_ROWS_PER_DAY).run();

    const answers = [
      await w.fetch('DELETE', hidePath(hidden.id), { cookie: admin }),
      await w.fetch('PUT', `${ROOM_PICTURES_ADMIN_PATH}/${kept.id}/keep`, { cookie: admin }),
      await w.fetch('PUT', `${ROOM_PICTURES_ADMIN_PATH}/off`, { cookie: admin }),
      await w.fetch('DELETE', `${ROOM_PICTURES_ADMIN_PATH}/off`, { cookie: admin }),
      await w.fetch('PUT', mutePath(firstId), { cookie: admin }),
    ];

    expect(answers.map((reply) => reply.status)).toEqual([204, 204, 204, 204, 204]);
    expect(
      (await db.prepare('SELECT rows FROM api_writes WHERE day = ?1').bind(DAY).first<{ rows: number }>())?.rows,
    ).toBe(API_WRITE_ROWS_PER_DAY);
  });
});

describe('the sweep of owed bytes', () => {
  it('deletes what a removal could not, marks it gone, and is idle when nothing is owed', async () => {
    const w = world();
    const pictures = [
      await seedPicture(w, WRITER, gifTinted(1), { at: at(900) }),
      await seedPicture(w, WRITER, gifTinted(2), { at: at(800) }),
    ];
    const admin = await w.signIn(ADMIN);
    w.kv.fail.add('delete');
    for (const picture of pictures) await w.fetch('DELETE', hidePath(picture.id), { cookie: admin });
    w.kv.fail.clear();
    const deletes = w.kv.deletes.length;
    const job = createRoomPictureSweepJob({
      ...jobDeps(storesOn(db), { now: NOW }).deps,
      pictures: w.deps.pictures,
      bytes: w.deps.bytes,
    });

    expect(job.name).toBe(ROOM_PICTURE_SWEEP_JOB);
    expect(await job.run(new Date(NOW))).toBe('done');

    // Newest first.
    expect(w.kv.deletes.slice(deletes)).toEqual([pictures[1]?.key, pictures[0]?.key]);
    expect(w.kv.held.size).toBe(0);
    for (const picture of pictures) expect((await pictureRow(db, picture.id))?.pic_key).toBeNull();
    expect(await job.run(new Date(NOW))).toBe('idle');
    expect(w.kv.deletes).toHaveLength(deletes + 2);
    expect(ROOM_PICTURE_SWEEP_PER_RUN).toBe(10);
  });

  it('marks gone only a picture that is removed: the id of a picture Prix still serves keeps its key and its row (revision 6, S2)', async () => {
    // `markGone` is bound to the state inside its statement, so that no caller, honest or not, can take
    // the key of a live picture and leave a row that says `ok` over bytes nobody can find.
    const w = world();
    const live = [
      { state: 'ok', picture: await seedPicture(w, WRITER, gifTinted(1), { at: at(900) }) },
      { state: 'reported', picture: await seedPicture(w, WRITER, gifTinted(2), { at: at(800), state: 'reported' }) },
      { state: 'kept', picture: await seedPicture(w, WRITER, gifTinted(3), { at: at(700), state: 'kept' }) },
    ];
    const removed = await seedPicture(w, WRITER, gifTinted(4), { at: at(600), state: 'removed', hiddenAt: at(60) });

    await w.deps.pictures.markGone([...live.map(({ picture }) => picture.id), removed.id], NOW);

    for (const { state, picture } of live) {
      expect(await pictureRow(db, picture.id), state).toMatchObject({
        pic_state: state,
        pic_key: picture.key,
        pic_gone_at: null,
      });
    }
    expect(await pictureRow(db, removed.id)).toMatchObject({ pic_state: 'removed', pic_key: null, pic_gone_at: NOW });
    // And the one the public sees is still served, from the key it had.
    const served = await w.image(roomPicturePath(live[0]?.picture.id ?? 0));
    expect(served.status).toBe(200);
    expect(w.kv.gets).toEqual([live[0]?.picture.key]);
  });

  it('is the eighth name of the schema of jobs, after room_prune, with poll_tally the ninth and holders_lounge_sweep the tenth and last', () => {
    // Both holders waves merged: docs/contracts/phase-6-holders.md (revision 4, HB3-3) adds poll_tally as the
    // ninth name, docs/contracts/phase-6-holders-2.md section 4.6 holders_lounge_sweep as the tenth.
    const names = socialJobNameSchema.options;
    expect(names).toHaveLength(10);
    expect(names.indexOf(ROOM_PICTURE_SWEEP_JOB)).toBe(7);
    expect(names.indexOf('poll_tally')).toBe(8);
    expect(names.at(-1)).toBe('holders_lounge_sweep');
    expect(names.indexOf('room_prune')).toBeLessThan(names.indexOf(ROOM_PICTURE_SWEEP_JOB));
    expect(names.indexOf(ROOM_PICTURE_SWEEP_JOB)).toBeLessThan(names.indexOf('poll_tally'));
  });
});

describe('what a page is told of pictures', () => {
  async function scene(w: PictureWorld) {
    await seedWriter(w, WRITER);
    return {
      shown: await seedPicture(w, WRITER, GIF_SMALLEST, { at: at(900) }),
      kept: await seedPicture(w, WRITER, PNG_SMALLEST, { at: at(800), state: 'kept' }),
      reported: await seedPicture(w, WRITER, gifTinted(3), { at: at(700), state: 'reported', reports: 3 }),
      old: await seedPicture(w, WRITER, gifTinted(4), { at: at(ROOM_PICTURE_TTL_SECONDS + 5) }),
      removed: await seedPicture(w, WRITER, gifTinted(5), { at: at(600), state: 'removed' }),
      hidden: await seedPicture(w, WRITER, gifTinted(6), { at: at(500), hiddenAt: NOW }),
    };
  }

  it('gives each message its picture as shown, reported or gone, and never a key, a hash, a count, an address or a URL', async () => {
    const w = world();
    const s = await scene(w);

    const reply = await w.fetch('GET', '/api/social/room');

    const read = roomWithPicturesResponseSchema.parse(reply.json);
    const state = (id: number): string | null | undefined =>
      read.messages.find((message) => message.id === id)?.picture?.state;
    expect(read.pictures).toBe('on');
    expect([state(s.shown.id), state(s.kept.id), state(s.reported.id), state(s.old.id)]).toEqual([
      'shown',
      'shown',
      'reported',
      'gone',
    ]);
    // A removed picture belongs to a hidden message when an admin removed it; a hidden message is not read.
    expect(read.messages.some((message) => message.id === s.hidden.id)).toBe(false);
    expect(read.messages.find((message) => message.picture === null)?.text).toBe('a first line');
    for (const message of read.messages.filter((entry) => entry.picture != null)) {
      expect(message.text).toBe(ROOM_PICTURE_TEXT);
      expect(Object.keys(message.picture ?? {}).sort()).toEqual([
        'bytes',
        'frames',
        'height',
        'state',
        'type',
        'width',
      ]);
    }
    expect(reply.text).not.toContain('pic/');
    expect(reply.text).not.toMatch(/[0-9a-f]{32}/);
    expect(reply.text).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(reply.text).not.toContain('/pictures');
    expect(reply.text).not.toMatch(/https?:/);
    expect(reply.text).not.toMatch(/"reports"|"sha|"key"/);
  });

  it('says `resting` once the views of the day have reached the cap, and `off` before that when the switch is set', async () => {
    const w = world({ viewsCap: '50' });
    await scene(w);
    const pictures = async (): Promise<string | undefined> =>
      roomWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room')).json).pictures;

    await seedCount(db, roomPictureViewsKey(DAY), 49, NOW);
    expect(await pictures()).toBe('on');
    await seedCount(db, roomPictureViewsKey(DAY), 50, NOW);
    expect(await pictures()).toBe('resting');
    await w.deps.pictures.setPicturesOff(ADMIN, 'admin', NOW);
    expect(await pictures()).toBe('off');
  });

  it('shows a picture of a wallet that is an admin now as gone, with the admin mark', async () => {
    const seeded = world();
    const s = await scene(seeded);
    const w = world({ adminAddresses: [ADMIN, WRITER] });

    const read = roomWithPicturesResponseSchema.parse((await w.fetch('GET', '/api/social/room')).json);

    const shown = read.messages.find((message) => message.id === s.shown.id);
    expect(shown?.admin).toBe(true);
    expect(shown?.picture?.state).toBe('gone');
  });

  it('answers as Phase 6.3 does while pictures are not enabled: neither field, and no picture message', async () => {
    const seeded = world();
    await scene(seeded);
    const w = world({ pictures: false });

    const reply = await w.fetch('GET', '/api/social/room');

    const read = roomResponseSchema.parse(reply.json);
    expect(read.messages.map((message) => message.text)).toEqual(['a first line']);
    expect(reply.text).not.toContain('picture');
    const me = await w.fetch('GET', '/api/social/room/me', { cookie: await w.signIn(WRITER) });
    expect(Object.keys(me.json).sort()).toEqual(['left', 'write']);
  });

  it('tells an admin wallet that it cannot upload and cannot report, whatever its row says', async () => {
    const w = world();
    await createRoomStore(db).putMessage(ADMIN, 'a line of an admin', at(3 * 86_400));
    w.holdings.set(ADMIN, 50);

    const me = roomMeWithPicturesResponseSchema.parse(
      (await w.fetch('GET', '/api/social/room/me', { cookie: await w.signIn(ADMIN) })).json,
    );

    expect(me).toMatchObject({ write: 'yes', picture: 'admin', picturesLeft: 0, report: false });
  });

  it("gives the admins' page each picture with its state and its count, and never the key", async () => {
    const w = world();
    const s = await scene(w);
    const admin = await w.signIn(ADMIN);

    const reply = await w.fetch('GET', '/api/social/admin/room', { cookie: admin });

    const read = roomAdminWithPicturesResponseSchema.parse(reply.json);
    const of = (id: number) => read.messages.find((message) => message.id === id)?.picture;
    expect(of(s.shown.id)).toMatchObject({ state: 'ok', reports: 0, viewable: true, bytesGone: false });
    expect(of(s.reported.id)).toMatchObject({ state: 'reported', reports: 3, viewable: true });
    expect(of(s.old.id)).toMatchObject({ state: 'ok', viewable: false, bytesGone: false });
    expect(of(s.removed.id)).toMatchObject({ state: 'removed', viewable: false, bytesGone: false });
    expect(of(s.hidden.id)).toMatchObject({ viewable: false });
    expect(reply.text).not.toContain('pic/');
    expect(reply.text).not.toContain(s.shown.sha256);
    expectNotFound(await w.fetch('GET', '/api/social/admin/room'));
  });
});

describe('the migration and the stores beside pictures', () => {
  it('stores no picture without its message and no picture message without its picture: one row is both', async () => {
    const w = world();
    const { cookie } = await seedWriter(w, WRITER);
    expect((await w.upload(GIF_SMALLEST, { cookie })).status).toBe(201);

    const rows = await pictureRows(db);
    expect(rows).toHaveLength(1);
    const columns = await db.prepare("SELECT name FROM pragma_table_info('room_messages')").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'pic_type',
        'pic_key',
        'pic_bytes',
        'pic_sha256',
        'pic_state',
        'pic_reports',
        'pic_gone_at',
      ]),
    );
  });

  it("fills first_at from each writer's oldest message that is not hidden, and leaves a writer with none at null", async () => {
    // The statement is the migration's own, read from 0013 as the test database was built from it
    // (revision 3: without `AND hidden_at IS NULL` a line hidden as spam before 0013 opened pictures).
    const migrations = (baseEnv as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] })
      .TEST_MIGRATIONS;
    const fill = migrations
      .filter((migration) => migration.name.startsWith('0013'))
      .flatMap((migration) => migration.queries)
      .find((query) => /UPDATE\s+room_writers\s+SET\s+first_at/i.test(query));
    expect(fill, 'migration 0013 has no fill of first_at').toBeDefined();
    const room = createRoomStore(db);
    const [A, B, C, D] = [
      WRITER,
      SECOND,
      '0x00000000000000000000000000000000000005b4',
      '0x00000000000000000000000000000000000005b5',
    ];
    const first = await room.putMessage(A, 'hidden as spam', at(5_000));
    await room.putMessage(A, 'a later line', at(4_000));
    const only = await room.putMessage(B, 'hidden as spam too', at(3_000));
    await room.putMessage(C, 'an old line', at(2_000));
    await room.putMessage(C, 'a newer line', at(1_000));
    await db
      .prepare('UPDATE room_messages SET hidden_at = ?1, hidden_by = ?2 WHERE id IN (?3, ?4)')
      .bind(NOW, ADMIN, first.id, only.id)
      .run();
    await db.prepare('INSERT INTO room_writers (address) VALUES (?1)').bind(D).run();
    await db.prepare("UPDATE room_writers SET first_at = 'before the migration'").run();

    await db.prepare(fill as string).run();

    const filled = await db
      .prepare('SELECT address, first_at FROM room_writers ORDER BY address')
      .all<{ address: string; first_at: string | null }>();
    expect(Object.fromEntries(filled.results.map((row) => [row.address, row.first_at]))).toEqual({
      [A]: at(4_000),
      [B]: null,
      [C]: at(2_000),
      [D]: null,
    });
  });

  it("deletes the reports of a pruned message with it: a reporter's address is nowhere after that", async () => {
    const w = world();
    const picture = await seedPicture(w, WRITER, GIF_SMALLEST, { at: at(900) });
    await db
      .prepare('INSERT INTO room_picture_reports (message_id, reporter, at) VALUES (?1, ?2, ?3)')
      .bind(picture.id, SECOND, NOW)
      .run();
    await createRoomStore(db).putMessage(SECOND, 'a newer line', NOW);

    // Keep the newest one: the picture's message is at the edge and goes.
    const pruned = await createRoomStore(db).pruneMessages(1, 100);

    expect(pruned).toBe(1);
    expect(await pictureRow(db, picture.id)).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM room_picture_reports').first()).toEqual({ n: 0 });
  });
});
