import { env } from 'cloudflare:workers';
import { ROOM_MESSAGES_PER_WALLET_PER_DAY, ROOM_PAGE, ROOM_SCAN } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRoomStore } from './room.ts';
import { createRoomPictureStore } from './room-pictures.ts';

/**
 * Phase 6.8 in the room's two stores (docs/contracts/phase-6-holders-2.md sections 2.1 and 2.2), on a local
 * D1 database: the stored token row joined to each message of the public read, and the wallet's cap of the
 * day handed to the one statement of a turn.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const db = (env as unknown as { DB: D1Database }).DB;

const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';
const CAROL = '0x00000000000000000000000000000000000000c3';
const TOKEN = '0xa74ac6e9f2f8493344923c23972d496364241044';
const DAY = '2026-10-16';
const NOW = `${DAY}T12:00:00.000Z`;
const OLD = '2026-10-01T00:00:00.000Z';

const room = createRoomStore(db);
const pictures = createRoomPictureStore(db);

async function message(author: string, text: string, at: string): Promise<void> {
  await db.prepare('INSERT INTO room_messages (at, author, text) VALUES (?1, ?2, ?3)').bind(at, author, text).run();
}

async function holder(address: string, tier: number, checkedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO token_holders (address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, slots_dirty)
       VALUES (?1, '0', '1000000000000000000000000000', 18, ?2, 1, ?3, ?4, 0)`,
    )
    .bind(address, tier, TOKEN, checkedAt)
    .run();
}

/** A writer with a first message long ago, `count` messages today and its last one long ago. */
async function writer(address: string, count: number): Promise<void> {
  await db
    .prepare('INSERT INTO room_writers (address, first_at, last_at, day, count) VALUES (?1, ?2, ?2, ?3, ?4)')
    .bind(address, OLD, DAY, count)
    .run();
}

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM room_messages'),
    db.prepare('DELETE FROM room_writers'),
    db.prepare('DELETE FROM token_holders'),
  ]);
});

describe("the author's stored token row on the public read", () => {
  beforeEach(async () => {
    await message(ALICE, 'one', '2026-10-16T10:00:00.000Z');
    await message(BOB, 'two', '2026-10-16T10:01:00.000Z');
    await message(CAROL, 'three', '2026-10-16T10:02:00.000Z');
    await holder(ALICE, 2, '2026-10-16T09:00:00.000Z');
    await holder(CAROL, 0, '2026-10-15T09:00:00.000Z');
  });

  const expected = [
    { author: CAROL, authorHolder: { tier: 0, tokenAddress: TOKEN, checkedAt: '2026-10-15T09:00:00.000Z' } },
    { author: BOB, authorHolder: null },
    { author: ALICE, authorHolder: { tier: 2, tokenAddress: TOKEN, checkedAt: '2026-10-16T09:00:00.000Z' } },
  ];

  it('is joined by `listNewest`: the row of its author, or null', async () => {
    const read = await room.listNewest(ROOM_PAGE, ROOM_SCAN);
    expect(read.map(({ author, authorHolder }) => ({ author, authorHolder }))).toEqual(expected);
  });

  it("is joined by `readRoom`'s first statement: the row of its author, or null", async () => {
    const read = await pictures.readRoom(ROOM_PAGE, ROOM_SCAN, 'views:test');
    expect(read.messages.map(({ author, authorHolder }) => ({ author, authorHolder }))).toEqual(expected);
  });

  it('changes neither the order nor the count of the messages', async () => {
    const read = await room.listNewest(ROOM_PAGE, ROOM_SCAN);
    expect(read.map((m) => m.text)).toEqual(['three', 'two', 'one']);
  });
});

describe("the wallet's cap of the day in `takeTurn`", () => {
  it('counts the 60th message of a cap of 60 and answers what is left', async () => {
    await writer(ALICE, 59);
    expect(await room.takeTurn(ALICE, NOW, DAY, 60)).toEqual({ ok: true, left: 0 });
  });

  it('answers what is left under the cap it was given', async () => {
    await writer(ALICE, 30);
    expect(await room.takeTurn(ALICE, NOW, DAY, 120)).toEqual({ ok: true, left: 89 });
  });

  it('refuses the 61st with `day` and writes nothing', async () => {
    await writer(ALICE, 60);
    expect(await room.takeTurn(ALICE, NOW, DAY, 60)).toEqual({ ok: false, why: 'day' });
    expect((await room.getWriter(ALICE))?.count).toBe(60);
  });

  it('keeps 30 when no cap is given', async () => {
    await writer(ALICE, ROOM_MESSAGES_PER_WALLET_PER_DAY - 1);
    expect(await room.takeTurn(ALICE, NOW, DAY)).toEqual({ ok: true, left: 0 });
    await writer(BOB, ROOM_MESSAGES_PER_WALLET_PER_DAY);
    expect(await room.takeTurn(BOB, NOW, DAY)).toEqual({ ok: false, why: 'day' });
  });
});

describe("the wallet's cap of the day in `takePictureTurn`", () => {
  it('counts a picture as the 60th message of a cap of 60', async () => {
    await writer(ALICE, 59);
    expect(await pictures.takePictureTurn(ALICE, NOW, DAY, 60)).toMatchObject({ ok: true, left: 0 });
  });

  it('refuses a picture past the cap with `day`', async () => {
    await writer(ALICE, 60);
    expect(await pictures.takePictureTurn(ALICE, NOW, DAY, 60)).toEqual({ ok: false, why: 'day' });
    expect((await room.getWriter(ALICE))?.count).toBe(60);
  });

  it('keeps 30 when no cap is given', async () => {
    await writer(ALICE, ROOM_MESSAGES_PER_WALLET_PER_DAY);
    expect(await pictures.takePictureTurn(ALICE, NOW, DAY)).toEqual({ ok: false, why: 'day' });
    await writer(BOB, ROOM_MESSAGES_PER_WALLET_PER_DAY - 1);
    expect(await pictures.takePictureTurn(BOB, NOW, DAY)).toMatchObject({ ok: true, left: 0 });
  });
});
