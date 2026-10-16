import {
  isSocialSafeText,
  ROOM_AUDIT_ACTIONS,
  ROOM_PAGE,
  ROOM_REFUSALS,
  type RoomRefusalField,
  roomAdminWithPicturesResponseSchema,
  roomResponseSchema,
} from '@prix/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOM_SENTENCES } from './refusals.ts';
import {
  ADMIN,
  ADMIN_AS_CONFIGURED,
  createHarness,
  errorOf,
  type Harness,
  HOLDER,
  OTHER,
  type Reply,
  START,
  stepsOf,
  THIRD,
} from './test-support.ts';

/**
 * The admin's read and its three writes against docs/contracts/phase-6-room.md sections 7 and 8: the
 * generic 404 to anyone who is not an admin session, the answers by a message's id, and an audit line only
 * when something changed. A store in memory, no D1.
 */

const READ = '/api/social/admin/room';
const routes: [string, string][] = [
  ['GET', READ],
  ['DELETE', '/api/social/admin/room/messages/1'],
  ['PUT', '/api/social/admin/room/messages/1/mute'],
  ['DELETE', '/api/social/admin/room/messages/1/mute'],
];

interface AuditLine {
  event: string;
  admin: string;
  action: string;
  target: string;
}

/** The audit lines written from here on, as `audit` of the social routes writes them. */
function watchAudit(): AuditLine[] {
  const lines: AuditLine[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    const parsed = JSON.parse(String(line)) as AuditLine;
    if (parsed.event === 'admin_action') lines.push(parsed);
  });
  return lines;
}

async function asAdmin(h: Harness, method: string, path: string): Promise<Reply> {
  return h.fetch(method, path, { cookie: await h.signIn(ADMIN) });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('anyone who is not an admin session', () => {
  it.each(routes)('gets the generic 404 on %s %s: no session', async (method, path) => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', START);
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    const before = h.ledger();
    const reply = await h.fetch(method, path);
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(unknown.text);
    expect(stepsOf(h.trace)).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it.each(routes)('gets the generic 404 on %s %s: a session of a holder', async (method, path) => {
    const h = createHarness();
    h.room.seed(OTHER, 'a line', START);
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    const cookie = await h.signIn(HOLDER);
    const before = h.ledger();
    h.trace.length = 0;
    const reply = await h.fetch(method, path, { cookie });
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(unknown.text);
    // Nothing of the room is read and nothing is spent for a stranger.
    expect(stepsOf(h.trace)).toEqual([]);
    expect(h.ledger()).toEqual(before);
  });

  it.each(routes)(
    'is answered on %s %s while the room is switched off, and an admin still is',
    async (method, path) => {
      const h = createHarness({ given: false, roomEnabled: false });
      h.room.seed(HOLDER, 'a line', START);
      const unknown = await h.fetch('GET', '/api/social/no-such-route');
      expect((await h.fetch(method, path, { cookie: await h.signIn(HOLDER) })).text).toBe(unknown.text);
      const reply = await asAdmin(h, method, path);
      expect([200, 204]).toContain(reply.status);
    },
  );
});

describe('GET /api/social/admin/room', () => {
  it('gives every message with its whole address and why the public does not see it, never cached', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'shown', '2026-10-20T10:00:00.000Z');
    h.room.seed(HOLDER, 'hidden', '2026-10-20T10:01:00.000Z', '2026-10-20T10:02:00.000Z');
    h.room.seed(OTHER, 'of a muted writer', '2026-10-20T10:03:00.000Z');
    h.room.seed(ADMIN, 'of an admin', '2026-10-20T10:04:00.000Z');
    h.room.seed(THIRD, 'written before a mute that was lifted', '2026-10-20T10:05:00.000Z');
    h.room.seed(THIRD, 'written after that mute', '2026-10-20T10:07:00.000Z');
    h.room.setWriter(OTHER, { mutedAt: START, mutedBy: ADMIN, cutAt: START });
    h.room.setWriter(THIRD, { mutedAt: null, mutedBy: null, cutAt: '2026-10-20T10:06:00.000Z' });
    const reply = await asAdmin(h, 'GET', READ);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    // From Phase 6.4 on every message says whether it is a picture: null for a message of text.
    const base = { hidden: false, muted: false, cut: false, admin: false, picture: null };
    expect(roomAdminWithPicturesResponseSchema.parse(reply.json)).toEqual({
      messages: [
        { ...base, id: 6, at: '2026-10-20T10:07:00.000Z', author: THIRD, text: 'written after that mute' },
        {
          ...base,
          id: 5,
          at: '2026-10-20T10:05:00.000Z',
          author: THIRD,
          text: 'written before a mute that was lifted',
          cut: true,
        },
        { ...base, id: 4, at: '2026-10-20T10:04:00.000Z', author: ADMIN, text: 'of an admin', admin: true },
        {
          ...base,
          id: 3,
          at: '2026-10-20T10:03:00.000Z',
          author: OTHER,
          text: 'of a muted writer',
          muted: true,
          cut: true,
        },
        { ...base, id: 2, at: '2026-10-20T10:01:00.000Z', author: HOLDER, text: 'hidden', hidden: true },
        { ...base, id: 1, at: '2026-10-20T10:00:00.000Z', author: HOLDER, text: 'shown' },
      ],
      older: null,
    });
    // And the public read of the same room shows none that carries one of the three.
    const shown = roomResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json);
    expect(shown.messages.map((message) => message.id)).toEqual([6, 4, 1]);
  });

  it('takes `cut` from the store and judges nothing of it itself', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    const rows = await h.pictures.listAllWithPictures(null, ROOM_PAGE + 1);
    vi.spyOn(h.pictures, 'listAllWithPictures').mockResolvedValue(rows.map((row) => ({ ...row, cut: true })));
    const page = roomAdminWithPicturesResponseSchema.parse((await asAdmin(h, 'GET', READ)).json);
    expect(page.messages.map((message) => message.cut)).toEqual([true]);
  });

  it('pages by `before`: ROOM_PAGE a page, and `older` only while there are older ones', async () => {
    const h = createHarness();
    for (let n = 1; n <= ROOM_PAGE + 3; n += 1) h.room.seed(HOLDER, `line ${n}`, START);
    const first = roomAdminWithPicturesResponseSchema.parse((await asAdmin(h, 'GET', READ)).json);
    expect(first.messages).toHaveLength(ROOM_PAGE);
    expect(first.messages[0]?.id).toBe(ROOM_PAGE + 3);
    expect(first.older).toBe(4);
    const second = roomAdminWithPicturesResponseSchema.parse(
      (await asAdmin(h, 'GET', `${READ}?before=${first.older}`)).json,
    );
    expect(second.messages.map((message) => message.id)).toEqual([3, 2, 1]);
    expect(second.older).toBeNull();
  });

  it('answers null for `older` when the page ends at the first message', async () => {
    const h = createHarness();
    for (let n = 1; n <= ROOM_PAGE; n += 1) h.room.seed(HOLDER, `line ${n}`, START);
    const page = roomAdminWithPicturesResponseSchema.parse((await asAdmin(h, 'GET', READ)).json);
    expect(page.messages).toHaveLength(ROOM_PAGE);
    expect(page.older).toBeNull();
  });

  it.each(['0', '01', 'abc', '-1', '1.5', ''])('refuses the cursor "%s" with 400', async (before) => {
    const h = createHarness();
    const reply = await asAdmin(h, 'GET', `${READ}?before=${before}`);
    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe('invalid_input');
    expect(h.trace.some((step) => step.startsWith('room.'))).toBe(false);
  });

  it('refuses a parameter it does not take', async () => {
    const h = createHarness();
    const reply = await asAdmin(h, 'GET', `${READ}?limit=5000`);
    expect(reply.status).toBe(400);
    expect(h.trace.some((step) => step.startsWith('room.'))).toBe(false);
  });
});

describe('DELETE /api/social/admin/room/messages/:id', () => {
  it('hides a message: 204, audited by its id, and gone from the public read', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line to hide', '2026-10-20T10:00:00.000Z');
    const audit = watchAudit();
    const reply = await asAdmin(h, 'DELETE', '/api/social/admin/room/messages/1');
    expect(reply.status).toBe(204);
    expect(reply.text).toBe('');
    expect(h.room.messages[0]).toMatchObject({ hiddenAt: START, hiddenBy: ADMIN });
    expect(audit).toEqual([{ event: 'admin_action', admin: ADMIN, action: ROOM_AUDIT_ACTIONS.hide, target: '1' }]);
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
    expect(roomResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json).messages).toEqual([]);
  });

  it('answers 204 to a second hide and audits nothing', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line to hide', '2026-10-20T10:00:00.000Z', '2026-10-20T10:30:00.000Z');
    const audit = watchAudit();
    const reply = await asAdmin(h, 'DELETE', '/api/social/admin/room/messages/1');
    expect(reply.status).toBe(204);
    expect(h.room.messages[0]?.hiddenAt).toBe('2026-10-20T10:30:00.000Z');
    expect(audit).toEqual([]);
  });

  it.each(['7', '0', '01', 'abc', '1e3'])('answers the generic 404 for the id "%s" and audits nothing', async (id) => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', START);
    const audit = watchAudit();
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    const reply = await asAdmin(h, 'DELETE', `/api/social/admin/room/messages/${id}`);
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(unknown.text);
    expect(audit).toEqual([]);
    expect(h.room.messages[0]?.hiddenAt).toBeNull();
  });

  it('is a write like any other: from the site only', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', START);
    const cookie = await h.signIn(ADMIN);
    const reply = await h.fetch('DELETE', '/api/social/admin/room/messages/1', { cookie, origin: 'https://evil.test' });
    expect(reply.status).toBe(403);
    expect(h.room.messages[0]?.hiddenAt).toBeNull();
  });
});

describe('PUT and DELETE /api/social/admin/room/messages/:id/mute', () => {
  const MUTE = '/api/social/admin/room/messages/1/mute';

  it('mutes the writer of a message: 204, a cut at the time of the mute, audited by the message’s id', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    const audit = watchAudit();
    const reply = await asAdmin(h, 'PUT', MUTE);
    expect(reply.status).toBe(204);
    expect(h.room.writers.get(HOLDER)).toMatchObject({ mutedAt: START, mutedBy: ADMIN, cutAt: START });
    expect(audit).toEqual([{ event: 'admin_action', admin: ADMIN, action: ROOM_AUDIT_ACTIONS.mute, target: '1' }]);
    // No address of the writer travels in the audit line.
    expect(JSON.stringify(audit)).not.toContain(HOLDER);
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
  });

  it('answers 204 to a second mute, audits nothing and leaves the cut where it was', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    h.room.setWriter(HOLDER, {
      mutedAt: '2026-10-20T11:00:00.000Z',
      mutedBy: ADMIN,
      cutAt: '2026-10-20T11:00:00.000Z',
    });
    const audit = watchAudit();
    expect((await asAdmin(h, 'PUT', MUTE)).status).toBe(204);
    expect(audit).toEqual([]);
    expect(h.room.writers.get(HOLDER)?.cutAt).toBe('2026-10-20T11:00:00.000Z');
  });

  it('refuses a mute of an admin’s message with 400 and the field `admin`, whatever the case it is stored in', async () => {
    for (const author of [ADMIN, ADMIN.toUpperCase().replace('0X', '0x')]) {
      const h = createHarness();
      h.room.seed(author, 'a word from an admin', START);
      const audit = watchAudit();
      const reply = await asAdmin(h, 'PUT', MUTE);
      expect(reply.status).toBe(ROOM_REFUSALS.admin);
      expect(errorOf(reply).code).toBe('invalid_input');
      expect(errorOf(reply).field).toBe('admin');
      expect(h.trace).not.toContain('pictures.muteWithPictures:24');
      expect(h.room.writers.size).toBe(0);
      expect(audit).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it('lifts a mute: 204, audited, and a cut later than the writer’s newest message stays where it is', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    h.room.setWriter(HOLDER, {
      mutedAt: '2026-10-20T11:00:00.000Z',
      mutedBy: ADMIN,
      cutAt: '2026-10-20T11:00:00.000Z',
    });
    const audit = watchAudit();
    const reply = await asAdmin(h, 'DELETE', MUTE);
    expect(reply.status).toBe(204);
    expect(h.room.writers.get(HOLDER)).toMatchObject({
      mutedAt: null,
      mutedBy: null,
      cutAt: '2026-10-20T11:00:00.000Z',
    });
    expect(audit).toEqual([{ event: 'admin_action', admin: ADMIN, action: ROOM_AUDIT_ACTIONS.unmute, target: '1' }]);
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
    // What the writer wrote before the mute stays out of the public read.
    expect(roomResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json).messages).toEqual([]);
  });

  it('moves the cut to the writer’s newest message at the lift: one stored while the mute was on its way stays out', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'written before the mute', '2026-10-20T10:00:00.000Z');
    h.room.seed(OTHER, 'of another writer', '2026-10-20T10:01:00.000Z');
    watchAudit();
    const cookie = await h.signIn(ADMIN);
    const publicIds = async () =>
      roomResponseSchema.parse((await h.fetch('GET', '/api/social/room')).json).messages.map((message) => message.id);
    const adminPage = async () =>
      roomAdminWithPicturesResponseSchema.parse((await h.fetch('GET', READ, { cookie })).json).messages;

    // The mute carries the time START.
    expect((await h.fetch('PUT', MUTE, { cookie })).status).toBe(204);
    // A message whose time is after the mute's: its writer's turn was taken before the mute reached the store.
    const late = '2026-10-20T12:00:00.050Z';
    h.room.seed(HOLDER, 'stored while the mute was on its way', late);
    expect(await publicIds()).toEqual([2]);
    // Until the lift only the mute keeps it out.
    expect((await adminPage()).find((message) => message.id === 3)).toMatchObject({ muted: true, cut: false });

    expect((await h.fetch('DELETE', MUTE, { cookie })).status).toBe(204);
    expect(h.room.writers.get(HOLDER)).toMatchObject({ mutedAt: null, mutedBy: null, cutAt: late });
    // In no public read after the lift, and the admins' page says why.
    expect(await publicIds()).toEqual([2]);
    const after = await adminPage();
    expect(after.find((message) => message.id === 3)).toMatchObject({ hidden: false, muted: false, cut: true });
    expect(after.find((message) => message.id === 1)).toMatchObject({ hidden: false, muted: false, cut: true });
    expect(after.find((message) => message.id === 2)).toMatchObject({ hidden: false, muted: false, cut: false });

    // The writer writes again, and what it writes after the lift is shown.
    h.room.seed(HOLDER, 'written after the lift', '2026-10-20T12:05:00.000Z');
    expect(await publicIds()).toEqual([4, 2]);
  });

  it('answers 204 when there was no mute to lift, and audits nothing', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', START);
    const audit = watchAudit();
    expect((await asAdmin(h, 'DELETE', MUTE)).status).toBe(204);
    expect(audit).toEqual([]);
  });

  it.each([
    ['PUT', '7'],
    ['DELETE', '7'],
    ['PUT', '0'],
    ['DELETE', 'abc'],
  ])('answers the generic 404 to %s for the id "%s"', async (method, id) => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', START);
    const audit = watchAudit();
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    const reply = await asAdmin(h, method, `/api/social/admin/room/messages/${id}/mute`);
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(unknown.text);
    expect(audit).toEqual([]);
    expect(h.room.writers.size).toBe(0);
  });
});

describe('the order of the three writes (section 7)', () => {
  const HIDE = '/api/social/admin/room/messages/1';
  const MUTE = `${HIDE}/mute`;
  type StoreWrite = 'pictures.hideWithPicture:1' | 'pictures.muteWithPictures:24' | 'room.unmuteWriter';
  const writes: [string, string, StoreWrite][] = [
    ['DELETE', HIDE, 'pictures.hideWithPicture:1'],
    ['PUT', MUTE, 'pictures.muteWithPictures:24'],
    ['DELETE', MUTE, 'room.unmuteWriter'],
  ];

  /** A room in which each of the three writes changes something: one message, its writer muted for the lift. */
  function roomFor(write: StoreWrite): Harness {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    if (write === 'room.unmuteWriter') {
      h.room.setWriter(HOLDER, {
        mutedAt: '2026-10-20T11:00:00.000Z',
        mutedBy: ADMIN,
        cutAt: '2026-10-20T11:00:00.000Z',
      });
    }
    return h;
  }

  /** Whether the store holds what `write` changes. */
  function changed(h: Harness, write: StoreWrite): boolean {
    if (write === 'pictures.hideWithPicture:1') return h.room.messages[0]?.hiddenAt === START;
    const mutedAt = h.room.writers.get(HOLDER)?.mutedAt ?? null;
    return write === 'pictures.muteWithPictures:24' ? mutedAt === START : mutedAt === null;
  }

  it.each(writes)('%s %s looks the message up, then asks the limiter, then writes', async (method, path, write) => {
    const h = roomFor(write);
    const cookie = await h.signIn(ADMIN);
    watchAudit();
    h.trace.length = 0;
    const reply = await h.fetch(method, path, { cookie });
    expect(reply.status).toBe(204);
    expect(stepsOf(h.trace)).toEqual(['room.getMessage', `limiter:write:${ADMIN}`, write]);
    expect(changed(h, write)).toBe(true);
  });

  describe.each([
    ['the admin wallet’s writes of the day', { walletWritesLeft: 0 }],
    ['the API’s rows of the day', { rowsLeft: 0 }],
  ])('when %s are spent', (_name, nothingLeft) => {
    it.each(writes)('%s %s still answers 204, writes and is audited', async (method, path, write) => {
      const h = roomFor(write);
      Object.assign(h.limits, nothingLeft);
      const audit = watchAudit();
      const reply = await asAdmin(h, method, path);
      expect(reply.status).toBe(204);
      expect(changed(h, write)).toBe(true);
      expect(audit).toHaveLength(1);
    });
  });

  it.each(writes)('%s %s books nothing against a budget of the day', async (method, path, write) => {
    const h = roomFor(write);
    h.limits.walletWritesLeft = 60;
    h.limits.rowsLeft = 40_000;
    watchAudit();
    expect((await asAdmin(h, method, path)).status).toBe(204);
    expect(changed(h, write)).toBe(true);
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
    expect(h.limits).toEqual({ walletWritesLeft: 60, rowsLeft: 40_000 });
    // Neither count of the day is even asked.
    expect(h.trace.filter((step) => step.startsWith('store.spend'))).toEqual([]);
  });

  it.each(writes)(
    '%s %s is refused by the limiter at its rate: 429, and nothing is written',
    async (method, path, write) => {
      const h = roomFor(write);
      const cookie = await h.signIn(ADMIN);
      const audit = watchAudit();
      h.limiter.denied.add('write');
      const before = h.ledger();
      h.trace.length = 0;
      const reply = await h.fetch(method, path, { cookie });
      expect(reply.status).toBe(429);
      expect(errorOf(reply).code).toBe('rate_limited');
      expect(reply.headers.get('Retry-After')).toBe('60');
      // The message is looked up first, and the limiter is the last thing asked.
      expect(stepsOf(h.trace)).toEqual(['room.getMessage', `limiter:write:${ADMIN}`]);
      expect(h.ledger()).toEqual(before);
      expect(audit).toEqual([]);
    },
  );

  it.each(writes)(
    '%s %s asks the limiter for the address as the session holds it, like every write of the wallet',
    async (method, path, write) => {
      const h = roomFor(write);
      const cookie = await h.signIn(ADMIN_AS_CONFIGURED);
      watchAudit();
      h.trace.length = 0;
      expect((await h.fetch(method, path, { cookie })).status).toBe(204);
      expect(stepsOf(h.trace)).toEqual(['room.getMessage', `limiter:write:${ADMIN_AS_CONFIGURED}`, write]);
    },
  );

  it('counts each of the three writes against the limiter’s `write` rule of the admin’s address', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z');
    h.room.seed(OTHER, 'another line', '2026-10-20T10:01:00.000Z');
    watchAudit();
    h.limiter.writesAllowed = 3;
    expect((await asAdmin(h, 'DELETE', HIDE)).status).toBe(204);
    expect((await asAdmin(h, 'PUT', MUTE)).status).toBe(204);
    expect((await asAdmin(h, 'DELETE', MUTE)).status).toBe(204);
    const fourth = await asAdmin(h, 'DELETE', '/api/social/admin/room/messages/2');
    expect(fourth.status).toBe(429);
    expect(errorOf(fourth).code).toBe('rate_limited');
    expect(h.room.messages[1]?.hiddenAt).toBeNull();
  });

  it.each(writes)('%s %s is refused before a session is read when it is not from the site', async (method, path) => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', START);
    const before = h.ledger();
    for (const address of [ADMIN, HOLDER]) {
      const cookie = await h.signIn(address);
      h.trace.length = 0;
      const reply = await h.fetch(method, path, { cookie, origin: 'https://evil.test' });
      expect(reply.status).toBe(403);
      expect(errorOf(reply).code).toBe('forbidden');
      expect(h.trace).not.toContain('store.getSession');
      expect(stepsOf(h.trace)).toEqual([]);
    }
    expect(h.ledger()).toEqual(before);
  });

  it.each(writes)('%s %s spends nothing for a message that is not there: the generic 404', async (method, path) => {
    const h = createHarness();
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    const audit = watchAudit();
    for (const id of ['7', '0', '01', 'abc']) {
      const cookie = await h.signIn(ADMIN);
      const before = h.ledger();
      h.trace.length = 0;
      const reply = await h.fetch(method, path.replace('/messages/1', `/messages/${id}`), { cookie });
      expect(reply.status, id).toBe(404);
      expect(reply.text, id).toBe(unknown.text);
      // An id that is no id never reaches the store; one that is costs the one read.
      expect(stepsOf(h.trace), id).toEqual(id === '7' ? ['room.getMessage'] : []);
      expect(h.ledger(), id).toEqual(before);
    }
    expect(h.spent).toEqual({ walletWrites: 0, rows: 0 });
    expect(audit).toEqual([]);
  });

  it('spends nothing for the mute of an admin’s message: 400 `admin` after the one read', async () => {
    const h = createHarness();
    h.room.seed(ADMIN, 'a word from an admin', START);
    const cookie = await h.signIn(ADMIN);
    const before = h.ledger();
    h.trace.length = 0;
    const reply = await h.fetch('PUT', MUTE, { cookie });
    expect(reply.status).toBe(ROOM_REFUSALS.admin);
    expect(errorOf(reply).field).toBe('admin');
    expect(reply.headers.get('Retry-After')).toBeNull();
    expect(stepsOf(h.trace)).toEqual(['room.getMessage']);
    expect(h.ledger()).toEqual(before);
  });

  it('never refuses the lifting of a mute for an admin’s message: a wallet muted before it became an admin', async () => {
    const h = createHarness();
    h.room.seed(ADMIN, 'written before this wallet was an admin', '2026-10-20T10:00:00.000Z');
    h.room.setWriter(ADMIN, {
      mutedAt: '2026-10-20T11:00:00.000Z',
      mutedBy: OTHER,
      cutAt: '2026-10-20T11:00:00.000Z',
    });
    const audit = watchAudit();
    const reply = await asAdmin(h, 'DELETE', MUTE);
    expect(reply.status).toBe(204);
    expect(h.room.writers.get(ADMIN)).toMatchObject({
      mutedAt: null,
      mutedBy: null,
      cutAt: '2026-10-20T11:00:00.000Z',
    });
    expect(audit).toEqual([{ event: 'admin_action', admin: ADMIN, action: ROOM_AUDIT_ACTIONS.unmute, target: '1' }]);
  });

  it.each([
    ['a second hide', 'DELETE', HIDE],
    ['a mute of a muted writer', 'PUT', MUTE],
    ['the lifting of no mute', 'DELETE', MUTE],
  ])('books nothing for %s, answers 204 and audits nothing', async (name, method, path) => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line', '2026-10-20T10:00:00.000Z', name === 'a second hide' ? START : null);
    if (method === 'PUT') h.room.setWriter(HOLDER, { mutedAt: START, mutedBy: ADMIN, cutAt: START });
    const audit = watchAudit();
    const before = h.ledger();
    const reply = await asAdmin(h, method, path);
    expect(reply.status).toBe(204);
    expect(h.ledger()).toEqual(before);
    expect(h.trace.filter((step) => step.startsWith('store.spend'))).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('answers the generic 404 when the message is gone between the look and the hide', async () => {
    const h = createHarness();
    h.room.seed(HOLDER, 'a line the prune job takes', START);
    const unknown = await h.fetch('GET', '/api/social/no-such-route');
    const audit = watchAudit();
    h.room.afterGetMessage = () => {
      h.room.messages.length = 0;
    };
    const reply = await asAdmin(h, 'DELETE', HIDE);
    expect(reply.status).toBe(404);
    expect(reply.text).toBe(unknown.text);
    expect(audit).toEqual([]);
  });
});

describe('the sentence of a refusal', () => {
  it('exists for every field of ROOM_REFUSALS and uses none of the words Phase 6 refuses', () => {
    const fields = Object.keys(ROOM_REFUSALS) as RoomRefusalField[];
    expect(Object.keys(ROOM_SENTENCES).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expect(ROOM_SENTENCES[field].length, field).toBeGreaterThan(20);
      expect(isSocialSafeText(ROOM_SENTENCES[field]), `${field}: ${ROOM_SENTENCES[field]}`).toBe(true);
    }
  });
});
