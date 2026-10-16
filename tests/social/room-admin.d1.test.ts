import {
  API_WRITE_ROWS_PER_DAY,
  ROOM_AUDIT_ACTIONS,
  ROOM_KEEP,
  ROOM_PAGE,
  ROOM_PRUNE_PER_RUN,
  ROOM_REFUSALS,
  ROOM_WRITE_MIN_TOKENS,
  roomAdminWithPicturesResponseSchema,
  roomResponseSchema,
  WALLET_WRITES_PER_DAY,
} from '@prix/contracts';
import { createRoomPruneJob } from '@prix/runtime/social/room-prune';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import { createRoomPictureStore } from '../../apps/api/src/store/room-pictures.ts';
import type { Reply, RoomHarness } from './api/harness.ts';
import { ADMIN, createRoomHarness, emptyRoomTables, errorOf, recordStatements, roomLedger } from './api/harness.ts';
import { db, jobDeps, storesOn } from './support/d1.ts';

/**
 * Taking a message away (docs/contracts/phase-6-room.md section 7): the admin's three writes by a
 * message's id and the admins' read, through the real routes and the real store on a local D1; and the
 * prune job on the real table.
 *
 * The order of a write is section 7's, at revision 5: from the site; an admin's session, the generic 404
 * to anyone else; the id and the message, by a read; for the mute, 400 `admin`; then the `write` rule of
 * the limiter for the admin's address; then the store's write; then the audit, only when the write changed
 * something. None of the three passes `requireWriter`: nothing of a day's budget is booked for them, so a
 * hide is never refused because the admin wallet's writes of the day or the API's rows of the day are
 * spent. A 404 and a 400 cost a read and never reach the limiter; a write that changes nothing answers 204.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';
const SECOND_ADMIN = '0x00000000000000000000000000000000000009a2';
const WRITER = '0x00000000000000000000000000000000000005b2';
const OTHER_WRITER = '0x00000000000000000000000000000000000005b3';
const LINE = 'a line that an admin takes away';

const metered = recordStatements(db);
const plainRoom = createRoomStore(db);

function world(options: Parameters<typeof createRoomHarness>[1] = {}): RoomHarness {
  const h = createRoomHarness(
    // From Phase 6.4 on the admin's read, hide and mute go through the pictures' store, whatever the
    // switch of pictures says: the real one, on the same counted database.
    { ...storesOn(metered.db), room: createRoomStore(metered.db), pictures: createRoomPictureStore(metered.db) },
    { now: NOW, adminAddresses: [ADMIN, SECOND_ADMIN], ...options },
  );
  for (const writer of [WRITER, OTHER_WRITER]) h.holdings.set(writer, ROOM_WRITE_MIN_TOKENS);
  return h;
}

const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
const hidePath = (id: number | string): string => `/api/social/admin/room/messages/${id}`;
const mutePath = (id: number | string): string => `/api/social/admin/room/messages/${id}/mute`;
const WRITES = [
  ['DELETE', hidePath],
  ['PUT', mutePath],
  ['DELETE', mutePath],
] as const;

const messageRow = (id: number) =>
  db.prepare('SELECT hidden_at, hidden_by FROM room_messages WHERE id = ?1').bind(id).first<{
    hidden_at: string | null;
    hidden_by: string | null;
  }>();
const writerRow = (address: string) =>
  db.prepare('SELECT muted_at, muted_by, cut_at FROM room_writers WHERE address = ?1').bind(address).first<{
    muted_at: string | null;
    muted_by: string | null;
    cut_at: string | null;
  }>();

/** What a write spent of the admin's own: its write of the day and the day's rows. */
const spent = async (address: string): Promise<{ walletWrites: number; dayRows: number }> => {
  const { walletWrites, dayRows } = await roomLedger(db, address, NOW);
  return { walletWrites, dayRows };
};

const seen = (reply: Reply) => ({
  status: reply.status,
  text: reply.text,
  headers: [...reply.headers.entries()].map(([name, value]) => `${name}: ${value}`).sort(),
});

let logs: MockInstance<typeof console.log>;
/** The audit lines so far: `admin_action` lines of the log, parsed. */
function audits(): { admin: string; action: string; target: string }[] {
  return logs.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => line.event === 'admin_action')
    .map(({ admin, action, target }) => ({ admin: String(admin), action: String(action), target: String(target) }));
}

beforeEach(async () => {
  await emptyRoomTables(db);
  metered.reset();
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("who the admin's writes are for", () => {
  it('refuses a request that is not from the site before it reads anything', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    metered.reset();

    for (const [method, path] of WRITES) {
      const reply = await h.fetch(method, path(message.id), { cookie: admin, origin: 'https://evil.example' });
      expect(reply.status, `${method} ${path(message.id)}`).toBe(403);
    }

    expect(metered.meter.statements).toBe(0);
    expect((await messageRow(message.id))?.hidden_at).toBeNull();
    // The writer's row is there since its first message was stored (Phase 6.4: `putMessage` makes it, for
    // `first_at`); what this pins is that it carries no mute and no cut.
    expect(await writerRow(WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: null });
  });

  it('answers anyone who is not an admin exactly as an unknown path, reads nothing of the room and spends nothing', async () => {
    const h = world();
    const holder = await h.signIn(WRITER);
    const message = await plainRoom.putMessage(OTHER_WRITER, LINE, NOW);

    for (const cookie of [holder, undefined]) {
      for (const [method, path] of WRITES) {
        const unknown = seen(await h.fetch(method, '/api/social/admin/no-such-path', { cookie }));
        expect(unknown.status).toBe(404);
        metered.reset();
        expect(seen(await h.fetch(method, path(message.id), { cookie })), `${method} ${path(message.id)}`).toEqual(
          unknown,
        );
        expect(metered.meter.log.filter((sql) => /room_/.test(sql))).toEqual([]);
        expect(metered.meter.writes).toBe(0);
      }
      const unknownRead = seen(await h.fetch('GET', '/api/social/admin/no-such-path', { cookie }));
      metered.reset();
      expect(seen(await h.fetch('GET', '/api/social/admin/room', { cookie }))).toEqual(unknownRead);
      expect(metered.meter.log.filter((sql) => /room_/.test(sql))).toEqual([]);
    }

    expect((await messageRow(message.id))?.hidden_at).toBeNull();
    // The row its stored message made (Phase 6.4), with no mute and no cut in it.
    expect(await writerRow(OTHER_WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: null });
    expect(await spent(WRITER)).toEqual({ walletWrites: 0, dayRows: 0 });
    expect(audits()).toEqual([]);
  });
});

describe("a 404 and a 400 of the admin's writes spend nothing", () => {
  it('answers the generic 404 for an id that is no id, before the limiter is asked', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    await plainRoom.putMessage(WRITER, LINE, NOW);
    const unknown = seen(await h.fetch('DELETE', '/api/social/admin/no-such-path', { cookie: admin }));

    for (const id of ['0', '01', 'abc', '1e3', '-1', '1.5', '9'.repeat(16), ' 1', '1x']) {
      for (const [method, path] of WRITES) {
        metered.reset();
        const reply = await h.fetch(method, path(encodeURIComponent(id)), { cookie: admin });
        expect(seen(reply), `${method} ${id}`).toEqual(unknown);
        expect(metered.meter.writes, `${method} ${id}`).toBe(0);
      }
    }

    expect(h.limiter.writesAsked(ADMIN)).toBe(0);
    expect(await spent(ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    expect(audits()).toEqual([]);
  });

  it('answers the generic 404 for an id no message has, before the limiter is asked', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    const unknown = seen(await h.fetch('DELETE', '/api/social/admin/no-such-path', { cookie: admin }));

    for (const [method, path] of WRITES) {
      metered.reset();
      expect(seen(await h.fetch(method, path(message.id + 1), { cookie: admin })), method).toEqual(unknown);
      expect(metered.meter.writes, method).toBe(0);
    }

    expect(h.limiter.writesAsked(ADMIN)).toBe(0);
    expect(await spent(ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    expect(audits()).toEqual([]);
  });

  it("answers 400 `admin` for the mute of an admin's message, before the limiter is asked, and mutes nobody", async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const own = await plainRoom.putMessage(ADMIN, 'a line of the first admin', NOW);
    // An admin's address is compared in lower case, however the message's author is stored.
    await db
      .prepare('INSERT INTO room_messages (at, author, text) VALUES (?1, ?2, ?3)')
      .bind(NOW, `0x${SECOND_ADMIN.slice(2).toUpperCase()}`, 'a line of the second admin')
      .run();
    const others = own.id + 1;

    for (const id of [own.id, others]) {
      metered.reset();
      const reply = await h.fetch('PUT', mutePath(id), { cookie: admin });
      expect(reply.status).toBe(ROOM_REFUSALS.admin);
      expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field: 'admin' });
      expect(reply.headers.get('Retry-After')).toBeNull();
      expect(metered.meter.writes).toBe(0);
    }

    expect(h.limiter.writesAsked(ADMIN)).toBe(0);
    expect(await spent(ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    // Nobody is muted and nobody is cut. (A writer's row exists since its first stored message, Phase 6.4.)
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM room_writers WHERE muted_at IS NOT NULL OR cut_at IS NOT NULL')
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(audits()).toEqual([]);
  });
});

describe('hiding a message', () => {
  it('hides it for good: 204, the first admin and time kept, the limiter asked once, nothing booked, the audit once', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    h.setNow(at(60));

    const reply = await h.fetch('DELETE', hidePath(message.id), { cookie: admin });

    expect(reply.status).toBe(204);
    expect(reply.text).toBe('');
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(await messageRow(message.id)).toEqual({ hidden_at: at(60), hidden_by: ADMIN });
    // Revision 5: the limiter's `write` rule once, and no budget of the day.
    expect(h.limiter.writesAsked(ADMIN)).toBe(1);
    expect(await spent(ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    expect(audits()).toEqual([{ admin: ADMIN, action: ROOM_AUDIT_ACTIONS.hide, target: String(message.id) }]);
  });

  it('answers 204 to a second hide, which spends nothing of a day and is not audited', async () => {
    const h = world();
    const first = await h.signIn(ADMIN);
    const second = await h.signIn(SECOND_ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    expect((await h.fetch('DELETE', hidePath(message.id), { cookie: first })).status).toBe(204);
    h.setNow(at(120));

    const again = await h.fetch('DELETE', hidePath(message.id), { cookie: second });

    expect(again.status).toBe(204);
    // It was hidden once: the first admin and the first time stay.
    expect(await messageRow(message.id)).toEqual({ hidden_at: NOW, hidden_by: ADMIN });
    expect(await spent(SECOND_ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    expect(audits()).toEqual([{ admin: ADMIN, action: ROOM_AUDIT_ACTIONS.hide, target: String(message.id) }]);
  });

  it("is never refused for a spent budget: the three writes pass with the admin wallet's writes of the day and the API's rows of the day used up, and book nothing", async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    await db
      .prepare('UPDATE users SET write_day = ?2, write_count = ?3 WHERE address = ?1')
      .bind(ADMIN, DAY, WALLET_WRITES_PER_DAY)
      .run();
    await db.prepare('INSERT INTO api_writes (day, rows) VALUES (?1, ?2)').bind(DAY, API_WRITE_ROWS_PER_DAY).run();
    const full = { walletWrites: WALLET_WRITES_PER_DAY, dayRows: API_WRITE_ROWS_PER_DAY };
    expect(await spent(ADMIN)).toEqual(full);

    expect((await h.fetch('DELETE', hidePath(message.id), { cookie: admin })).status).toBe(204);
    expect((await h.fetch('PUT', mutePath(message.id), { cookie: admin })).status).toBe(204);
    expect((await h.fetch('DELETE', mutePath(message.id), { cookie: admin })).status).toBe(204);

    expect(await messageRow(message.id)).toEqual({ hidden_at: NOW, hidden_by: ADMIN });
    expect(await writerRow(WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: NOW });
    expect(await spent(ADMIN)).toEqual(full);
    expect(audits().map((line) => line.action)).toEqual([
      ROOM_AUDIT_ACTIONS.hide,
      ROOM_AUDIT_ACTIONS.mute,
      ROOM_AUDIT_ACTIONS.unmute,
    ]);
  });

  it("does not hide, mute or lift when the limiter's write rule refuses, and audits nothing", async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    await plainRoom.muteWriter(OTHER_WRITER, SECOND_ADMIN, NOW);
    const ofMuted = await plainRoom.putMessage(OTHER_WRITER, 'a line of a muted writer', NOW);
    h.limiter.writesAllowed = 0;

    const hide = await h.fetch('DELETE', hidePath(message.id), { cookie: admin });
    const mute = await h.fetch('PUT', mutePath(message.id), { cookie: admin });
    const lift = await h.fetch('DELETE', mutePath(ofMuted.id), { cookie: admin });

    for (const limited of [hide, mute, lift]) {
      expect(limited.status).toBe(429);
      expect(errorOf(limited).code).toBe('rate_limited');
    }
    expect(h.limiter.writesAsked(ADMIN)).toBe(3);
    expect((await messageRow(message.id))?.hidden_at).toBeNull();
    // The writer's row is there since its first message was stored (Phase 6.4: `putMessage` makes it, for
    // `first_at`); what this pins is that it carries no mute and no cut.
    expect(await writerRow(WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: null });
    expect((await writerRow(OTHER_WRITER))?.muted_at).toBe(NOW);
    expect(audits()).toEqual([]);
  });
});

describe('muting a writer, and lifting the mute', () => {
  it("mutes the writer of a message by the message's id: 204, the cut set to the mute, nothing booked, the audit once", async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    // A writer with no row of its own gets one.
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    h.setNow(at(60));

    const reply = await h.fetch('PUT', mutePath(message.id), { cookie: admin });

    expect(reply.status).toBe(204);
    expect(await writerRow(WRITER)).toEqual({ muted_at: at(60), muted_by: ADMIN, cut_at: at(60) });
    expect(await writerRow(OTHER_WRITER)).toBeNull();
    expect(h.limiter.writesAsked(ADMIN)).toBe(1);
    expect(await spent(ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    // The audit's target is the message's id: no address but the admin's own is in the line.
    expect(audits()).toEqual([{ admin: ADMIN, action: ROOM_AUDIT_ACTIONS.mute, target: String(message.id) }]);
    expect(logs.mock.calls.flat().join('\n')).not.toContain(WRITER);
  });

  it('answers 204 to the mute of a muted writer, which spends nothing of a day, changes nothing and is not audited', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    expect((await h.fetch('PUT', mutePath(message.id), { cookie: admin })).status).toBe(204);
    h.setNow(at(300));

    const again = await h.fetch('PUT', mutePath(message.id), { cookie: await h.signIn(SECOND_ADMIN) });

    expect(again.status).toBe(204);
    expect(await writerRow(WRITER)).toEqual({ muted_at: NOW, muted_by: ADMIN, cut_at: NOW });
    expect(await spent(SECOND_ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    expect(audits().map((line) => line.action)).toEqual([ROOM_AUDIT_ACTIONS.mute]);
  });

  it('lifts a mute: 204 and audited once; a second lift books nothing and is not audited', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    expect((await h.fetch('PUT', mutePath(message.id), { cookie: admin })).status).toBe(204);
    h.setNow(at(600));

    const lifted = await h.fetch('DELETE', mutePath(message.id), { cookie: admin });

    expect(lifted.status).toBe(204);
    expect(await writerRow(WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: NOW });
    expect(audits().map((line) => line.action)).toEqual([ROOM_AUDIT_ACTIONS.mute, ROOM_AUDIT_ACTIONS.unmute]);
    expect(audits()[1]).toEqual({ admin: ADMIN, action: ROOM_AUDIT_ACTIONS.unmute, target: String(message.id) });

    const again = await h.fetch('DELETE', mutePath(message.id), { cookie: admin });
    expect(again.status).toBe(204);
    expect(h.limiter.writesAsked(ADMIN)).toBe(3);
    expect(await spent(ADMIN)).toEqual({ walletWrites: 0, dayRows: 0 });
    expect(audits()).toHaveLength(2);
  });

  // Revision 5, with the real statement of apps/api/src/store/room.ts behind the real route.
  it("moves the cut to the writer's newest message when the mute is lifted: a message with a time after the mute's is in no public read after the lift", async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const shown = async (): Promise<string[]> =>
      roomResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json).messages.map(({ text }) => text);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);
    await plainRoom.putMessage(OTHER_WRITER, 'a line of another writer', NOW);
    h.setNow(at(60));
    expect((await h.fetch('PUT', mutePath(message.id), { cookie: admin })).status).toBe(204);
    // Stored while the mute was on its way: its request read the clock after the admin's did.
    const straggler = 'a line with a time after the mute';
    await plainRoom.putMessage(WRITER, straggler, at(61));
    expect(await shown()).toEqual(['a line of another writer']);
    h.setNow(at(600));

    expect((await h.fetch('DELETE', mutePath(message.id), { cookie: admin })).status).toBe(204);

    expect(await writerRow(WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: at(61) });
    expect(await shown()).toEqual(['a line of another writer']);
    // What the writer writes after the lift shows; the straggler never does.
    await plainRoom.putMessage(WRITER, 'a line after the lift', at(601));
    expect(await shown()).toEqual(['a line after the lift', 'a line of another writer']);
    expect(h.transcript.filter((entry) => entry.startsWith('GET /api/social/room ')).join('\n')).not.toContain(
      straggler,
    );

    // The cut never moves backwards: a second mute and lift with no newer message leave it at the second mute.
    h.setNow(at(900));
    expect((await h.fetch('PUT', mutePath(message.id), { cookie: admin })).status).toBe(204);
    expect((await h.fetch('DELETE', mutePath(message.id), { cookie: admin })).status).toBe(204);
    expect(await writerRow(WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: at(900) });
    expect(await shown()).toEqual(['a line of another writer']);
  });

  it('answers 204 to the lift for a writer who was never muted, and audits nothing', async () => {
    const h = world();
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);

    const reply = await h.fetch('DELETE', mutePath(message.id), { cookie: await h.signIn(ADMIN) });

    expect(reply.status).toBe(204);
    // The writer's row is there since its first message was stored (Phase 6.4: `putMessage` makes it, for
    // `first_at`); what this pins is that it carries no mute and no cut.
    expect(await writerRow(WRITER)).toEqual({ muted_at: null, muted_by: null, cut_at: null });
    expect(audits()).toEqual([]);
  });

  it('never refuses the lift for an admin: a wallet muted before it became one is unmuted this way', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(SECOND_ADMIN, 'written before it was an admin', NOW);
    await plainRoom.muteWriter(SECOND_ADMIN, ADMIN, at(10));
    h.setNow(at(60));

    // Muting it again is refused as for every admin; lifting is not.
    expect(errorOf(await h.fetch('PUT', mutePath(message.id), { cookie: admin })).field).toBe('admin');
    const lifted = await h.fetch('DELETE', mutePath(message.id), { cookie: admin });

    expect(lifted.status).toBe(204);
    expect(await writerRow(SECOND_ADMIN)).toEqual({ muted_at: null, muted_by: null, cut_at: at(10) });
    expect(audits()).toEqual([{ admin: ADMIN, action: ROOM_AUDIT_ACTIONS.unmute, target: String(message.id) }]);
  });

  it('stops the writer from writing until the mute is lifted', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const writer = await h.signIn(WRITER);
    const post = (text: string) => h.fetch('POST', '/api/social/room', { cookie: writer, body: { text } });
    const first = await post('a first line of the writer');
    expect(first.status, first.text).toBe(201);
    h.setNow(at(60));

    expect((await h.fetch('PUT', mutePath(first.json.message.id), { cookie: admin })).status).toBe(204);
    const muted = await post('a line while muted');
    expect(muted.status).toBe(ROOM_REFUSALS.muted);
    expect(errorOf(muted).field).toBe('muted');

    expect((await h.fetch('DELETE', mutePath(first.json.message.id), { cookie: admin })).status).toBe(204);
    h.setNow(at(120));
    expect((await post('a line after the lift')).status).toBe(201);
  });

  it("puts no message's text and no writer's address into a log line", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = world();
    const admin = await h.signIn(ADMIN);
    const message = await plainRoom.putMessage(WRITER, LINE, NOW);

    await h.fetch('PUT', mutePath(message.id), { cookie: admin });
    await h.fetch('DELETE', mutePath(message.id), { cookie: admin });
    await h.fetch('DELETE', hidePath(message.id), { cookie: admin });
    await h.fetch('GET', '/api/social/admin/room', { cookie: admin });
    await h.fetch('GET', '/api/social/room');

    const logged = [...logs.mock.calls, ...errors.mock.calls, ...warnings.mock.calls].flat().join('\n');
    expect(audits()).toHaveLength(3);
    expect(logged).not.toContain(WRITER);
    expect(logged).not.toContain(LINE);
  });
});

describe("the admins' read", () => {
  const read = (h: RoomHarness, cookie: string, query = '') =>
    h.fetch('GET', `/api/social/admin/room${query}`, { cookie });

  it('gives every message with its whole address, and says for each what keeps it from the public', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    const beforeMute = await plainRoom.putMessage(WRITER, 'written before the mute', NOW);
    const hidden = await plainRoom.putMessage(OTHER_WRITER, 'a hidden line', at(1));
    const ofAdmin = await plainRoom.putMessage(ADMIN, 'a line of an admin', at(2));
    h.setNow(at(60));
    expect((await h.fetch('PUT', mutePath(beforeMute.id), { cookie: admin })).status).toBe(204);
    expect((await h.fetch('DELETE', hidePath(hidden.id), { cookie: admin })).status).toBe(204);

    const whileMuted = await read(h, admin);

    expect(whileMuted.status).toBe(200);
    expect(whileMuted.headers.get('Cache-Control')).toBe('no-store');
    // Since Phase 6.4 the admins' read is `roomAdminWithPicturesResponseSchema` (docs/contracts/phase-6-pictures.md
    // section 19): each message says its picture, and a message of text says null.
    expect(roomAdminWithPicturesResponseSchema.parse(whileMuted.json)).toEqual({
      messages: [
        {
          id: ofAdmin.id,
          at: at(2),
          author: ADMIN,
          text: 'a line of an admin',
          hidden: false,
          muted: false,
          cut: false,
          admin: true,
          picture: null,
        },
        {
          id: hidden.id,
          at: at(1),
          author: OTHER_WRITER,
          text: 'a hidden line',
          hidden: true,
          muted: false,
          cut: false,
          admin: false,
          picture: null,
        },
        {
          id: beforeMute.id,
          at: NOW,
          author: WRITER,
          text: 'written before the mute',
          hidden: false,
          muted: true,
          cut: true,
          admin: false,
          picture: null,
        },
      ],
      older: null,
    });

    // After the lift the writer is muted no more, and what it wrote before the mute is still cut.
    expect((await h.fetch('DELETE', mutePath(beforeMute.id), { cookie: admin })).status).toBe(204);
    const afterLift = await plainRoom.putMessage(WRITER, 'written after the lift', at(120));
    const atTheCut = await plainRoom.putMessage(WRITER, 'written at the very time of the mute', at(60));
    const lifted = roomAdminWithPicturesResponseSchema.parse((await read(h, admin)).json);
    const flags = (id: number) => {
      const message = lifted.messages.find((entry) => entry.id === id);
      return message === undefined ? null : { muted: message.muted, cut: message.cut };
    };
    expect(flags(beforeMute.id)).toEqual({ muted: false, cut: true });
    expect(flags(atTheCut.id)).toEqual({ muted: false, cut: true });
    expect(flags(afterLift.id)).toEqual({ muted: false, cut: false });
  });

  it('pages by `before`, ROOM_PAGE at a time, and is the generic 404 to anyone else', async () => {
    const h = world();
    const admin = await h.signIn(ADMIN);
    await db
      .prepare(
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'line ' || i FROM n`,
      )
      .bind(ROOM_PAGE + 5, NOW, WRITER)
      .run();
    const newest = (await db.prepare('SELECT MAX(id) AS id FROM room_messages').first<{ id: number }>())?.id ?? 0;

    const first = roomAdminWithPicturesResponseSchema.parse((await read(h, admin)).json);
    expect(first.messages.map((message) => message.id)).toEqual(
      Array.from({ length: ROOM_PAGE }, (_, index) => newest - index),
    );
    expect(first.older).toBe(newest - ROOM_PAGE + 1);
    const second = roomAdminWithPicturesResponseSchema.parse((await read(h, admin, `?before=${first.older}`)).json);
    expect(second.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 5 }, (_, index) => newest - ROOM_PAGE - index),
    );
    expect(second.older).toBeNull();

    expect((await read(h, admin, '?before=abc')).status).toBe(400);
    const holder = await h.signIn(WRITER);
    const unknown = seen(await h.fetch('GET', '/api/social/admin/no-such-path', { cookie: holder }));
    expect(seen(await read(h, holder))).toEqual(unknown);
  });
});

describe('the prune job, on the real table', () => {
  const stores = storesOn(metered.db);
  const count = async (): Promise<number> =>
    (await db.prepare('SELECT COUNT(*) AS n FROM room_messages').first<{ n: number }>())?.n ?? -1;
  const edges = () =>
    db
      .prepare('SELECT MIN(id) AS oldest, MAX(id) AS newest FROM room_messages')
      .first<{ oldest: number; newest: number }>();

  async function fill(messages: number): Promise<void> {
    await db
      .prepare(
        `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO room_messages (at, author, text) SELECT ?2, ?3, 'a line to age out ' || i FROM n`,
      )
      .bind(messages, NOW, WRITER)
      .run();
  }

  function job() {
    const world_ = jobDeps(stores, { now: at(3_600) });
    const { log, social, reputation, now } = world_.deps;
    return {
      logs: world_.logs,
      run: () =>
        createRoomPruneJob({ log, social, reputation, now, room: createRoomStore(metered.db) }).run(
          new Date(at(3_600)),
        ),
    };
  }

  it('deletes the messages beyond the newest ROOM_KEEP, at most ROOM_PRUNE_PER_RUN a run, and is idle after', async () => {
    await fill(ROOM_KEEP + ROOM_PRUNE_PER_RUN + 50);
    await plainRoom.muteWriter(WRITER, ADMIN, NOW);
    const before = await edges();
    const { run, logs: lines } = job();

    expect(await run()).toBe('more');
    expect(await count()).toBe(ROOM_KEEP + 50);
    expect(await run()).toBe('done');
    expect(await count()).toBe(ROOM_KEEP);
    metered.reset();
    expect(await run()).toBe('idle');
    // An idle run is one batch, and it deletes nothing: the delete of messages as before and, since
    // Phase 6.4, the delete of the reports at or below the same edge (docs/contracts/phase-6-pictures.md
    // section 19: `pruneMessages` is one batch of the two).
    const idle = metered.meter.log.filter((sql) => /room_messages/.test(sql));
    expect(idle).toHaveLength(2);
    expect(idle.filter((sql) => /^delete from room_messages\b/i.test(sql))).toHaveLength(1);
    expect(idle.filter((sql) => /^delete from room_picture_reports\b/i.test(sql))).toHaveLength(1);
    expect(await count()).toBe(ROOM_KEEP);

    // What is left is the newest ROOM_KEEP, by id; a writer's row and its mute are not the job's.
    const after = await edges();
    expect(after?.newest).toBe(before?.newest);
    expect(after?.oldest).toBe((before?.newest ?? 0) - ROOM_KEEP + 1);
    expect((await writerRow(WRITER))?.muted_at).toBe(NOW);
    // It logs a count and nothing else.
    expect(lines).toEqual([
      { event: 'room_pruned', data: { deleted: ROOM_PRUNE_PER_RUN } },
      { event: 'room_pruned', data: { deleted: 50 } },
    ]);
    expect(JSON.stringify(lines)).not.toContain(WRITER);
    expect(JSON.stringify(lines)).not.toContain('a line to age out');
  });

  it('deletes nothing from a room of exactly ROOM_KEEP, one from a room of one more, nothing from an empty one', async () => {
    expect(await job().run()).toBe('idle');

    await fill(ROOM_KEEP);
    expect(await job().run()).toBe('idle');
    expect(await count()).toBe(ROOM_KEEP);

    const oldest = (await edges())?.oldest ?? 0;
    await plainRoom.putMessage(WRITER, 'one more', at(1));
    expect(await job().run()).toBe('done');
    expect(await count()).toBe(ROOM_KEEP);
    expect((await edges())?.oldest).toBe(oldest + 1);
  });

  it('counts a hidden message like any other: it ages out by its id', async () => {
    await fill(ROOM_KEEP + 1);
    const oldest = (await edges())?.oldest ?? 0;
    await plainRoom.hideMessage(oldest + 1, ADMIN, NOW);

    expect(await job().run()).toBe('done');

    expect(await plainRoom.getMessage(oldest)).toBeNull();
    expect((await plainRoom.getMessage(oldest + 1))?.hiddenAt).toBe(NOW);
  });
});
