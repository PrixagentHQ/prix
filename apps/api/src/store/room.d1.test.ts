import { env } from 'cloudflare:workers';
import {
  ROOM_KEEP,
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PAGE,
  ROOM_PRUNE_PER_RUN,
  ROOM_SCAN,
  ROOM_SECONDS_BETWEEN,
  roomDayKey,
  roomHourKey,
  roomTurnRefusal,
} from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createReputationStore } from './reputation.ts';
import { createRoomStore } from './room.ts';

/**
 * The room's D1 store on a local D1 database, inside the Workers runtime: the rules of
 * docs/contracts/phase-6-room.md sections 2, 5, 6 and 7 that only SQL can get wrong.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const db = (env as unknown as { DB: D1Database }).DB;

const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';
const ADMIN = '0x00000000000000000000000000000000000009a1';
const DAY = '2026-10-11';
const NEXT_DAY = '2026-10-12';

/** A time of DAY, `seconds` after 10:00:00 UTC, as `toISOString()` writes it. */
function at(seconds: number, day: string = DAY): string {
  return new Date(Date.parse(`${day}T10:00:00.000Z`) + seconds * 1_000).toISOString();
}

/** What a method asked of D1: every statement it prepared, and how many batches it sent. */
interface Asked {
  statements: string[];
  batches: number;
}

/** The database, with every statement and every batch written down. */
function watched(): { db: D1Database; asked: Asked } {
  const asked: Asked = { statements: [], batches: 0 };
  const proxy = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare') {
        return (sql: string) => {
          asked.statements.push(sql);
          return target.prepare(sql);
        };
      }
      if (name === 'batch') {
        return (list: D1PreparedStatement[]) => {
          asked.batches += 1;
          return target.batch(list);
        };
      }
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, asked };
}

/** One D1 call or one D1 batch: either one batch, or one statement and no batch. */
function isOneCall(asked: Asked): boolean {
  return asked.batches === 1 || (asked.batches === 0 && asked.statements.length === 1);
}

/** `count` messages of `author`, in one statement, each a second after the one before. */
async function seed(count: number, author: string = ALICE): Promise<void> {
  await db
    .prepare(
      `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO room_messages (at, author, text)
       SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-01T00:00:00.000Z', '+' || i || ' seconds'), ?2, 'line ' || i FROM n`,
    )
    .bind(count, author)
    .run();
}

/** A muted writer with one message from before the mute. */
async function seedMuted(): Promise<void> {
  const room = createRoomStore(db);
  await room.putMessage(ALICE, 'before the mute', at(0));
  await room.muteWriter(ALICE, ADMIN, at(10));
}

async function ids(): Promise<{ lowest: number; highest: number; count: number }> {
  const row = await db
    .prepare('SELECT MIN(id) AS lowest, MAX(id) AS highest, COUNT(*) AS count FROM room_messages')
    .first<{ lowest: number | null; highest: number | null; count: number }>();
  return { lowest: row?.lowest ?? 0, highest: row?.highest ?? 0, count: row?.count ?? 0 };
}

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM room_messages'),
    db.prepare('DELETE FROM room_writers'),
    db.prepare("DELETE FROM counters WHERE key LIKE 'd:%:room:%'"),
  ]);
});

describe("the room's store: a writer's turn", () => {
  it('counts a first turn, answers ok with what is left of the day, and makes the row', async () => {
    const room = createRoomStore(db);
    expect(await room.getWriter(ALICE)).toBeNull();

    const turn = await room.takeTurn(ALICE, at(0), DAY);

    expect(turn).toEqual({ ok: true, left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1 });
    expect(await room.getWriter(ALICE)).toEqual({
      address: ALICE,
      lastAt: at(0),
      day: DAY,
      count: 1,
      mutedAt: null,
      mutedBy: null,
      cutAt: null,
    });
  });

  it('answers by what its write changed: a counted turn is ok though its row, read after it, would refuse', async () => {
    const room = createRoomStore(db);
    await room.takeTurn(ALICE, at(0), DAY);

    // A second turn, counted: the row it leaves carries `now` as its last message.
    const turn = await room.takeTurn(ALICE, at(ROOM_SECONDS_BETWEEN), DAY);

    const row = await room.getWriter(ALICE);
    expect(roomTurnRefusal(row, at(ROOM_SECONDS_BETWEEN), DAY)).toBe('too_soon');
    expect(turn).toEqual({ ok: true, left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 2 });
    expect(row?.count).toBe(2);
  });

  it('refuses a turn too soon, writes nothing, and takes one at the full wait', async () => {
    const room = createRoomStore(db);
    await room.takeTurn(ALICE, at(0), DAY);
    const before = await room.getWriter(ALICE);

    expect(await room.takeTurn(ALICE, at(ROOM_SECONDS_BETWEEN - 1), DAY)).toEqual({ ok: false, why: 'too_soon' });
    expect(await room.getWriter(ALICE)).toEqual(before);

    expect((await room.takeTurn(ALICE, at(ROOM_SECONDS_BETWEEN), DAY)).ok).toBe(true);
  });

  it("stops at the wallet's cap of the day, and starts the count again the next day", async () => {
    const room = createRoomStore(db);
    for (let n = 0; n < ROOM_MESSAGES_PER_WALLET_PER_DAY; n += 1) {
      const turn = await room.takeTurn(ALICE, at(n * ROOM_SECONDS_BETWEEN), DAY);
      expect(turn, `turn ${n + 1}`).toEqual({ ok: true, left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1 - n });
    }
    const late = at(ROOM_MESSAGES_PER_WALLET_PER_DAY * ROOM_SECONDS_BETWEEN);

    // Long after the last message, so the day's cap is the one reason left.
    expect(await room.takeTurn(ALICE, late, DAY)).toEqual({ ok: false, why: 'day' });
    expect((await room.getWriter(ALICE))?.count).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY);
    // Another wallet has a day of its own.
    expect((await room.takeTurn(BOB, late, DAY)).ok).toBe(true);

    expect(await room.takeTurn(ALICE, at(0, NEXT_DAY), NEXT_DAY)).toEqual({
      ok: true,
      left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1,
    });
    expect(await room.getWriter(ALICE)).toMatchObject({ day: NEXT_DAY, count: 1 });
  });

  it('refuses a muted writer first, whatever else its row says, and writes nothing', async () => {
    const room = createRoomStore(db);
    await room.takeTurn(ALICE, at(0), DAY);
    await room.muteWriter(ALICE, ADMIN, at(1));
    const before = await room.getWriter(ALICE);

    // Too soon as well: `muted` is the reason named, as `roomTurnRefusal` orders them.
    expect(await room.takeTurn(ALICE, at(2), DAY)).toEqual({ ok: false, why: 'muted' });
    expect(await room.takeTurn(ALICE, at(3_600), DAY)).toEqual({ ok: false, why: 'muted' });
    expect(await room.getWriter(ALICE)).toEqual(before);
  });

  it('stores and compares an address in lower case', async () => {
    const room = createRoomStore(db);
    const shouting = ALICE.toUpperCase().replace('0X', '0x');

    await room.takeTurn(shouting, at(0), DAY);

    expect((await room.getWriter(ALICE))?.address).toBe(ALICE);
    expect(await room.takeTurn(ALICE, at(1), DAY)).toEqual({ ok: false, why: 'too_soon' });
  });
});

describe("the room's store: the public read", () => {
  it('answers the newest messages first, at most the limit', async () => {
    const room = createRoomStore(db);
    await seed(ROOM_PAGE + 3);
    const { highest } = await ids();

    const page = await room.listNewest(ROOM_PAGE, ROOM_SCAN);

    expect(page).toHaveLength(ROOM_PAGE);
    expect(page.map((message) => message.id)).toEqual(Array.from({ length: ROOM_PAGE }, (_, n) => highest - n));
  });

  it('keeps a hidden message hidden, with the time and the admin of its first hiding', async () => {
    const room = createRoomStore(db);
    const kept = await room.putMessage(ALICE, 'stays', at(0));
    const gone = await room.putMessage(ALICE, 'goes', at(30));

    expect(await room.hideMessage(gone.id, ADMIN, at(40))).toBe('hidden');
    expect(await room.hideMessage(gone.id, BOB, at(50))).toBe('already');
    expect(await room.hideMessage(gone.id + 1_000, ADMIN, at(60))).toBe('none');

    expect(await room.getMessage(gone.id)).toMatchObject({ hiddenAt: at(40), hiddenBy: ADMIN });
    expect((await room.listNewest(ROOM_PAGE, ROOM_SCAN)).map((message) => message.id)).toEqual([kept.id]);
  });

  it("takes a muted writer's earlier messages out of the read, and a lift leaves them out", async () => {
    const room = createRoomStore(db);
    const early = await room.putMessage(ALICE, 'before the mute', at(0));
    const other = await room.putMessage(BOB, 'somebody else', at(5));
    const shown = async () => (await room.listNewest(ROOM_PAGE, ROOM_SCAN)).map((message) => message.id);
    expect(await shown()).toEqual([other.id, early.id]);

    expect(await room.muteWriter(ALICE, ADMIN, at(10))).toBe(true);
    expect(await shown()).toEqual([other.id]);
    // A second mute changes nothing: the cut stays where the first one set it.
    expect(await room.muteWriter(ALICE, BOB, at(600))).toBe(false);
    expect(await room.getWriter(ALICE)).toMatchObject({ mutedAt: at(10), mutedBy: ADMIN, cutAt: at(10) });

    expect(await room.unmuteWriter(ALICE)).toBe(true);
    expect(await room.unmuteWriter(ALICE)).toBe(false);
    expect(await room.getWriter(ALICE)).toMatchObject({ mutedAt: null, mutedBy: null, cutAt: at(10) });
    expect(await shown()).toEqual([other.id]);

    // What the writer writes after the lift is shown; what it wrote before stays out.
    const late = await room.putMessage(ALICE, 'after the lift', at(700));
    expect(await shown()).toEqual([late.id, other.id]);
  });

  it('leaves out a message written at the very time of the cut', async () => {
    const room = createRoomStore(db);
    await room.putMessage(ALICE, 'at the cut', at(10));
    await room.muteWriter(ALICE, ADMIN, at(10));
    await room.unmuteWriter(ALICE);

    expect(await room.listNewest(ROOM_PAGE, ROOM_SCAN)).toEqual([]);
  });

  it('moves the cut at the lift to a message stored after the mute, so the lift never shows it', async () => {
    const room = createRoomStore(db);
    const early = await room.putMessage(ALICE, 'before the mute', at(0));
    const other = await room.putMessage(BOB, 'somebody else', at(5));
    await room.muteWriter(ALICE, ADMIN, at(10));
    // A message whose time is after the mute's: its request read the clock later and reached D1 first.
    const straggler = await room.putMessage(ALICE, 'while the mute was on its way', at(11));
    const shown = async () => (await room.listNewest(ROOM_PAGE, ROOM_SCAN)).map((message) => message.id);
    expect(await shown()).toEqual([other.id]);

    expect(await room.unmuteWriter(ALICE)).toBe(true);

    expect(await room.getWriter(ALICE)).toMatchObject({ mutedAt: null, mutedBy: null, cutAt: at(11) });
    expect(await shown()).toEqual([other.id]);
    const marks = Object.fromEntries(
      (await room.listAllMessages(null, ROOM_PAGE)).map(({ id, muted, cut }) => [id, { muted, cut }]),
    );
    expect(marks[straggler.id]).toEqual({ muted: false, cut: true });
    expect(marks[early.id]).toEqual({ muted: false, cut: true });
    expect(marks[other.id]).toEqual({ muted: false, cut: false });
    // What the writer writes after the lift is shown.
    const late = await room.putMessage(ALICE, 'after the lift', at(700));
    expect(await shown()).toEqual([late.id, other.id]);
  });

  it('never moves the cut backwards at a lift: a newest message older than the cut leaves it', async () => {
    const room = createRoomStore(db);
    await room.putMessage(ALICE, 'long before the mute', at(50));
    await room.muteWriter(ALICE, ADMIN, at(100));

    expect(await room.unmuteWriter(ALICE)).toBe(true);

    expect(await room.getWriter(ALICE)).toMatchObject({ mutedAt: null, cutAt: at(100) });
    // A second mute and lift, later: the cut is the later mute's, and a lift still does not take it back.
    await room.muteWriter(ALICE, ADMIN, at(300));
    expect(await room.unmuteWriter(ALICE)).toBe(true);
    expect(await room.getWriter(ALICE)).toMatchObject({ mutedAt: null, cutAt: at(300) });
  });

  it('lifts the mute of a writer with no message, and leaves its cut', async () => {
    const room = createRoomStore(db);
    await room.putMessage(ALICE, "somebody else's, later than the mute", at(900));
    await room.muteWriter(BOB, ADMIN, at(20));

    expect(await room.unmuteWriter(BOB)).toBe(true);

    expect(await room.getWriter(BOB)).toMatchObject({ mutedAt: null, mutedBy: null, cutAt: at(20) });
    expect(await room.unmuteWriter(BOB)).toBe(false);
  });

  it("is one statement at the lift, which reads the writer's messages by the index on the author", async () => {
    const { db: seen, asked } = watched();
    await seedMuted();

    await createRoomStore(seen).unmuteWriter(ALICE);

    expect(asked.batches).toBe(0);
    expect(asked.statements).toHaveLength(1);
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${asked.statements[0]}`).bind(ALICE).all<{ detail: string }>();
    const steps = plan.results.map((step) => step.detail);
    expect(steps.some((step) => /room_messages_author/.test(step))).toBe(true);
    expect(steps.filter((step) => /\bSCAN\b/.test(step))).toEqual([]);
  });

  it('mutes a wallet that never took a turn, and makes its row', async () => {
    const room = createRoomStore(db);

    expect(await room.muteWriter(BOB, ADMIN, at(0))).toBe(true);

    expect(await room.getWriter(BOB)).toEqual({
      address: BOB,
      lastAt: null,
      day: null,
      count: 0,
      mutedAt: at(0),
      mutedBy: ADMIN,
      cutAt: at(0),
    });
  });

  it('does not go below the newest scan ids when they are all hidden: the page is shorter, not the read longer', async () => {
    const room = createRoomStore(db);
    await seed(ROOM_SCAN + 5);
    const { highest } = await ids();
    await db
      .prepare('UPDATE room_messages SET hidden_at = ?1, hidden_by = ?2 WHERE id > ?3')
      .bind(at(0), ADMIN, highest - ROOM_SCAN)
      .run();

    // Five messages that nobody hid lie below the edge. None of them fills the page.
    expect(await room.listNewest(ROOM_PAGE, ROOM_SCAN)).toEqual([]);
  });

  it('takes its edge from the newest id less the scan, not from a count of rows', async () => {
    const room = createRoomStore(db);
    await seed(ROOM_SCAN + 5);
    const { highest } = await ids();
    // Rows missing among the newest ids: a count of rows would reach below the edge to make up for them.
    await db
      .prepare('DELETE FROM room_messages WHERE id > ?1 AND id <= ?2')
      .bind(highest - ROOM_SCAN + 10, highest - ROOM_SCAN + 20)
      .run();

    const page = await room.listNewest(ROOM_SCAN + 5, ROOM_SCAN);

    expect(page).toHaveLength(ROOM_SCAN - 10);
    expect(Math.min(...page.map((message) => message.id))).toBe(highest - ROOM_SCAN + 1);
  });

  it('is one statement, which walks the messages by their key and reads each writer by its key', async () => {
    const { db: seen, asked } = watched();
    await seed(3);

    await createRoomStore(seen).listNewest(ROOM_PAGE, ROOM_SCAN);

    expect(asked.batches).toBe(0);
    expect(asked.statements).toHaveLength(1);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${asked.statements[0]}`)
      .bind(ROOM_PAGE, ROOM_SCAN)
      .all<{ detail: string }>();
    const steps = plan.results.map((step) => step.detail);
    // The messages: a range of the primary key above the edge. No step reads a whole table.
    expect(steps.some((step) => /SEARCH m USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(step))).toBe(true);
    expect(steps.some((step) => /SEARCH w USING PRIMARY KEY \(address=\?\)/.test(step))).toBe(true);
    expect(steps.filter((step) => /\bSCAN\b/.test(step))).toEqual([]);
  });

  it('answers an empty room with an empty page', async () => {
    expect(await createRoomStore(db).listNewest(ROOM_PAGE, ROOM_SCAN)).toEqual([]);
  });
});

describe("the room's store: the room's two counts", () => {
  const HOUR_KEY = roomHourKey(DAY, 10);
  const DAY_KEY = roomDayKey(DAY);

  it('counts 0 for a key with no row', async () => {
    expect(await createRoomStore(db).getCounts(HOUR_KEY, DAY_KEY)).toEqual({ hour: 0, day: 0 });
  });

  it('reads one row and counts 0 for the other', async () => {
    const counters = createReputationStore(db);
    await counters.takeCounter(DAY_KEY, 100, DAY, at(0));
    await counters.takeCounter(DAY_KEY, 100, DAY, at(1));

    expect(await createRoomStore(db).getCounts(HOUR_KEY, DAY_KEY)).toEqual({ hour: 0, day: 2 });
    // Another hour of the same day is another key.
    expect(await createRoomStore(db).getCounts(roomHourKey(DAY, 11), DAY_KEY)).toEqual({ hour: 0, day: 2 });
  });

  it('reads both, each under its own key, and takes neither', async () => {
    const counters = createReputationStore(db);
    for (let n = 0; n < 3; n += 1) await counters.takeCounter(HOUR_KEY, 100, DAY, at(n));
    for (let n = 0; n < 7; n += 1) await counters.takeCounter(DAY_KEY, 100, DAY, at(n));
    const room = createRoomStore(db);

    expect(await room.getCounts(HOUR_KEY, DAY_KEY)).toEqual({ hour: 3, day: 7 });
    // Looked at, and not taken: a second look finds the same.
    expect(await room.getCounts(HOUR_KEY, DAY_KEY)).toEqual({ hour: 3, day: 7 });
  });

  it('is one statement', async () => {
    const { db: seen, asked } = watched();

    await createRoomStore(seen).getCounts(HOUR_KEY, DAY_KEY);

    expect(asked).toEqual({ statements: [expect.stringContaining('counters')], batches: 0 });
  });
});

describe("the room's store: the admins' list", () => {
  it('lists every message below the cursor, newest first, hidden ones too', async () => {
    const room = createRoomStore(db);
    await seed(7);
    const { highest } = await ids();
    await room.hideMessage(highest - 1, ADMIN, at(0));

    const first = await room.listAllMessages(null, 3);
    expect(first.map((message) => message.id)).toEqual([highest, highest - 1, highest - 2]);
    expect(first[1]?.hiddenAt).toBe(at(0));

    const second = await room.listAllMessages(highest - 2, 3);
    expect(second.map((message) => message.id)).toEqual([highest - 3, highest - 4, highest - 5]);

    const last = await room.listAllMessages(highest - 5, 3);
    expect(last.map((message) => message.id)).toEqual([highest - 6]);
    expect(await room.listAllMessages(highest - 6, 3)).toEqual([]);
  });

  it('says `muted` while the writer is muted, and `cut` for what it wrote at or before its cut', async () => {
    const room = createRoomStore(db);
    const early = await room.putMessage(ALICE, 'before the mute', at(0));
    const other = await room.putMessage(BOB, 'somebody else', at(5));
    const marks = async () =>
      Object.fromEntries(
        (await room.listAllMessages(null, ROOM_PAGE)).map(({ id, muted, cut }) => [id, { muted, cut }]),
      );

    expect(await marks()).toEqual({
      [early.id]: { muted: false, cut: false },
      [other.id]: { muted: false, cut: false },
    });

    await room.muteWriter(ALICE, ADMIN, at(10));
    expect(await marks()).toEqual({
      [early.id]: { muted: true, cut: true },
      [other.id]: { muted: false, cut: false },
    });

    // Lifted: the writer is muted no more, and its earlier message is still kept from the public.
    await room.unmuteWriter(ALICE);
    const late = await room.putMessage(ALICE, 'after the lift', at(700));
    expect(await marks()).toEqual({
      [early.id]: { muted: false, cut: true },
      [other.id]: { muted: false, cut: false },
      [late.id]: { muted: false, cut: false },
    });
  });
});

describe("the room's store: the prune", () => {
  it('keeps the newest ROOM_KEEP messages and deletes the ones below them', async () => {
    const room = createRoomStore(db);
    await seed(ROOM_KEEP + 7);
    const { highest } = await ids();

    expect(await room.pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)).toBe(7);

    expect(await ids()).toEqual({ lowest: highest - ROOM_KEEP + 1, highest, count: ROOM_KEEP });
    // Nothing is left to delete, and a second run says so.
    expect(await room.pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)).toBe(0);
  });

  it('deletes at most the limit a run, the oldest first', async () => {
    const room = createRoomStore(db);
    await seed(60);
    const { lowest, highest } = await ids();

    expect(await room.pruneMessages(10, 20)).toBe(20);
    expect(await ids()).toEqual({ lowest: lowest + 20, highest, count: 40 });
    expect(await room.pruneMessages(10, 20)).toBe(20);
    expect(await room.pruneMessages(10, 20)).toBe(10);
    expect(await ids()).toEqual({ lowest: highest - 9, highest, count: 10 });
  });

  it('deletes nothing from a room that holds fewer than it keeps, and nothing from an empty one', async () => {
    const room = createRoomStore(db);
    expect(await room.pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)).toBe(0);
    await seed(5);

    expect(await room.pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)).toBe(0);

    expect((await ids()).count).toBe(5);
  });

  it('never gives an id twice: a message written after a prune of everything gets a new one', async () => {
    const room = createRoomStore(db);
    await seed(3);
    const { highest } = await ids();
    await room.pruneMessages(0, 100);
    expect((await ids()).count).toBe(0);

    expect((await room.putMessage(ALICE, 'next', at(0))).id).toBe(highest + 1);
  });
});

describe("the room's store: one D1 call or one D1 batch a method", () => {
  it('holds for every method', async () => {
    await seed(3);
    const { highest } = await ids();
    const calls: [string, (room: ReturnType<typeof createRoomStore>) => Promise<unknown>][] = [
      ['listNewest', (room) => room.listNewest(ROOM_PAGE, ROOM_SCAN)],
      ['listAllMessages', (room) => room.listAllMessages(null, ROOM_PAGE)],
      ['getMessage', (room) => room.getMessage(highest)],
      ['getWriter', (room) => room.getWriter(ALICE)],
      ['getCounts', (room) => room.getCounts(roomHourKey(DAY, 10), roomDayKey(DAY))],
      ['takeTurn', (room) => room.takeTurn(ALICE, at(0), DAY)],
      ['putMessage', (room) => room.putMessage(ALICE, 'one more', at(0))],
      ['hideMessage', (room) => room.hideMessage(highest, ADMIN, at(1))],
      ['muteWriter', (room) => room.muteWriter(ALICE, ADMIN, at(2))],
      ['unmuteWriter', (room) => room.unmuteWriter(ALICE)],
      ['pruneMessages', (room) => room.pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)],
    ];
    for (const [name, call] of calls) {
      const { db: seen, asked } = watched();
      await call(createRoomStore(seen));
      expect(isOneCall(asked), `${name}: ${asked.statements.length} statements, ${asked.batches} batches`).toBe(true);
    }
  });
});

describe("the room's store: what Phase 6.4 changes (docs/contracts/phase-6-pictures.md section 19)", () => {
  /** A picture message as migration 0013 stores one: the columns of the message's own row. */
  async function seedPicture(author: string, when: string): Promise<number> {
    const row = await db
      .prepare(
        `INSERT INTO room_messages (at, author, text, pic_type, pic_key, pic_bytes, pic_width, pic_height, pic_frames, pic_sha256, pic_state)
         VALUES (?1, ?2, 'Picture', 'png', 'pic/00000000000000000000000000000001', 10, 1, 1, 1, 'aa', 'ok')
         RETURNING id`,
      )
      .bind(when, author)
      .first<{ id: number }>();
    return row?.id ?? 0;
  }
  const firstAt = async (address: string): Promise<string | null | undefined> =>
    (
      await db
        .prepare('SELECT first_at FROM room_writers WHERE address = ?1')
        .bind(address)
        .first<{ first_at: string | null }>()
    )?.first_at;

  beforeEach(async () => {
    await db.prepare('DELETE FROM room_picture_reports').run();
  });

  it('leaves picture messages out of `listNewest`: the read of a room whose pictures are not enabled', async () => {
    const room = createRoomStore(db);
    const before = await room.putMessage(ALICE, 'before', at(0));
    await seedPicture(BOB, at(1));
    const after = await room.putMessage(ALICE, 'after', at(2));

    expect((await room.listNewest(ROOM_PAGE, ROOM_SCAN)).map((message) => message.id)).toEqual([after.id, before.id]);
  });

  it("sets the writer's first_at with a stored message where it is null, and makes the row when there is none", async () => {
    const room = createRoomStore(db);
    expect(await firstAt(ALICE)).toBeUndefined();

    const message = await room.putMessage(ALICE, 'a first line', at(0));

    expect(message).toEqual({
      id: message.id,
      at: at(0),
      author: ALICE,
      text: 'a first line',
      hiddenAt: null,
      hiddenBy: null,
    });
    expect(await firstAt(ALICE)).toBe(at(0));
    // The row it made is a writer with no turn taken: the next turn finds it and counts as a first one does.
    expect(await room.getWriter(ALICE)).toEqual({
      address: ALICE,
      lastAt: null,
      day: null,
      count: 0,
      mutedAt: null,
      mutedBy: null,
      cutAt: null,
    });
    expect(await room.takeTurn(ALICE, at(0), DAY)).toEqual({ ok: true, left: ROOM_MESSAGES_PER_WALLET_PER_DAY - 1 });
  });

  it('leaves a first_at that is set, and sets it in the row a turn made', async () => {
    const room = createRoomStore(db);
    await room.takeTurn(ALICE, at(0), DAY);
    expect(await firstAt(ALICE)).toBeNull();

    await room.putMessage(ALICE, 'first', at(0));
    await room.putMessage(ALICE, 'second', at(60));

    expect(await firstAt(ALICE)).toBe(at(0));
    // The turn's own columns are as the turn left them.
    expect(await room.getWriter(ALICE)).toMatchObject({ lastAt: at(0), day: DAY, count: 1 });
  });

  it('does not set first_at with a turn that stored no message', async () => {
    const room = createRoomStore(db);

    await room.takeTurn(ALICE, at(0), DAY);

    expect(await firstAt(ALICE)).toBeNull();
  });

  it('race: of five first messages of one wallet at once, the first one stored sets first_at and the rest leave it', async () => {
    const room = createRoomStore(db);

    await Promise.all([0, 1, 2, 3, 4].map((n) => room.putMessage(ALICE, `line ${n}`, at(n))));

    const firstStored = await db
      .prepare('SELECT at FROM room_messages WHERE author = ?1 ORDER BY id LIMIT 1')
      .bind(ALICE)
      .first<{ at: string }>();
    expect(await firstAt(ALICE)).toBe(firstStored?.at);
    expect((await ids()).count).toBe(5);
  });

  it('deletes the reports of pictures at or below the edge of the prune, in the same batch, and answers the messages', async () => {
    const room = createRoomStore(db);
    await seed(ROOM_KEEP + 5);
    const { lowest, highest } = await ids();
    const edge = highest - ROOM_KEEP;
    await db
      .prepare(
        `INSERT INTO room_picture_reports (message_id, reporter, at) VALUES
           (?1, '${ALICE}', 'x'), (?1, '${BOB}', 'x'), (?2, '${ALICE}', 'x'), (?3, '${ALICE}', 'x')`,
      )
      .bind(lowest, edge, edge + 1)
      .run();
    const { db: seen, asked } = watched();

    const deleted = await createRoomStore(seen).pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN);

    expect(deleted).toBe(5);
    expect(asked.batches).toBe(1);
    const left = (
      await db.prepare('SELECT message_id FROM room_picture_reports ORDER BY message_id').all<{ message_id: number }>()
    ).results.map((row) => row.message_id);
    expect(left).toEqual([edge + 1]);
    expect((await room.getMessage(edge + 1))?.id).toBe(edge + 1);
  });

  it('deletes no report from a room that holds fewer messages than it keeps', async () => {
    const room = createRoomStore(db);
    await seed(3);
    const { lowest } = await ids();
    await db
      .prepare(`INSERT INTO room_picture_reports (message_id, reporter, at) VALUES (?1, '${ALICE}', 'x')`)
      .bind(lowest)
      .run();

    expect(await room.pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM room_picture_reports').first<{ n: number }>()).toEqual({ n: 1 });
  });
});
