import type { Address, HoldersGate, RoomApiDeps, Tier } from '@prix/contracts';
import { ROOM_REFUSALS, roomMeResponseSchema, roomResponseSchema, TOKEN_STALE_GRACE_SECONDS } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import { createRoomPictureStore } from '../../apps/api/src/store/room-pictures.ts';
import type { RoomHarness, RoomParts } from '../social/api/harness.ts';
import { ADMIN, createRoomHarness, emptyRoomTables } from '../social/api/harness.ts';
import { db, storesOn } from '../social/support/d1.ts';

/**
 * Phase 6.8, F (docs/contracts/phase-6-holders-2.md section 2, qa cases 2 to 4) on a local D1: the stores'
 * `dayCap`, the write's and `me`'s answers by tier, a forged claim in a header or a cookie, and the public
 * read's mark from the stored row at its edges (another token, exactly the grace, the gate off, an admin).
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';
const PRIX = '0xa74ac6e9f2f8493344923c23972d496364241044' as Address;
const OTHER_TOKEN = '0x1234567890abcdef1234567890abcdef12345678';
const W1 = '0x00000000000000000000000000000000000006a1';
const W2 = '0x00000000000000000000000000000000000006a2';
const W3 = '0x00000000000000000000000000000000000006a3';
const W4 = '0x00000000000000000000000000000000000006a4';
const W5 = '0x00000000000000000000000000000000000006a5';

async function wrote(address: string, count: number, firstAt: string | null = '2026-10-10T00:00:00.000Z') {
  await db
    .prepare(
      'INSERT OR REPLACE INTO room_writers (address, last_at, day, count, muted_at, muted_by, cut_at, first_at) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5)',
    )
    .bind(address, '2026-10-20T01:00:00.000Z', DAY, count, firstAt)
    .run();
}

async function countOf(address: string): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM room_writers WHERE address = ?1')
    .bind(address)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function storeTier(address: string, tier: number, checkedAt: string, token: string = PRIX) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO token_holders (address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, slots_dirty)
       VALUES (?1, '0', '1000000000000000000000000000', 18, ?2, 1, ?3, ?4, 0)`,
    )
    .bind(address, tier, token, checkedAt)
    .run();
}

function world(options: { holders?: boolean; gate?: HoldersGate } = {}) {
  const tiers = new Map<string, Tier>();
  const holding: RoomApiDeps['holding'] = async (address) => ({
    gatingOn: true,
    tokens: 50_000,
    tier: tiers.get(address.toLowerCase()) ?? 0,
    checkedAt: NOW,
  });
  const parts: RoomParts = { ...storesOn(db), room: createRoomStore(db) };
  const gate = options.gate ?? { gatingOn: true, token: PRIX };
  const h: RoomHarness = createRoomHarness(parts, {
    now: NOW,
    prixAddress: PRIX,
    holding,
    ...(options.holders === false ? {} : { holders: { gate: async () => gate } }),
  });
  return { h, tiers };
}

beforeEach(async () => {
  await emptyRoomTables(db);
  await db.prepare('DELETE FROM token_holders').run();
});

describe('case 4: the stores decide with dayCap in their one statement', () => {
  it('takeTurn with dayCap 60: the 60th turn counts, the 61st writes nothing; without the argument, 30', async () => {
    const room = createRoomStore(db);
    await wrote(W1, 59);
    expect(await room.takeTurn(W1, NOW, DAY, 60)).toEqual({ ok: true, left: 0 });
    expect(await countOf(W1)).toBe(60);
    const later = '2026-10-20T12:20:00.000Z';
    expect(await room.takeTurn(W1, later, DAY, 60)).toEqual({ ok: false, why: 'day' });
    expect(await countOf(W1)).toBe(60);
    await wrote(W2, 30);
    expect(await room.takeTurn(W2, NOW, DAY)).toEqual({ ok: false, why: 'day' });
    await wrote(W3, 29);
    expect(await room.takeTurn(W3, NOW, DAY)).toEqual({ ok: true, left: 0 });
  });

  it('takePictureTurn with dayCap 60: a picture counts against the same day; without the argument, 30', async () => {
    const pictures = createRoomPictureStore(db);
    await wrote(W1, 59);
    const first = await pictures.takePictureTurn(W1, NOW, DAY, 60);
    expect(first).toMatchObject({ ok: true, left: 0 });
    expect(await countOf(W1)).toBe(60);
    expect(await pictures.takePictureTurn(W1, '2026-10-20T12:20:00.000Z', DAY, 60)).toEqual({ ok: false, why: 'day' });
    expect(await countOf(W1)).toBe(60);
    await wrote(W2, 30);
    expect(await pictures.takePictureTurn(W2, NOW, DAY)).toEqual({ ok: false, why: 'day' });
    expect(await countOf(W2)).toBe(30);
  });
});

describe('case 3: the write and me by tier', () => {
  it('a tier 1 write answers holder true and left from 60; me answers dayCap 60', async () => {
    const { h, tiers } = world();
    tiers.set(W1, 1);
    const cookie = await h.signIn(W1);
    await wrote(W1, 10);
    const reply = await h.fetch('POST', '/api/social/room', { cookie, body: { text: 'a calm day in the league' } });
    expect(reply.status, reply.text).toBe(201);
    expect(reply.json).toMatchObject({ left: 49 });
    expect(JSON.stringify(reply.json)).toContain('"holder":true');
    const me = roomMeResponseSchema.parse((await h.fetch('GET', '/api/social/room/me', { cookie })).json);
    expect(me).toMatchObject({ dayCap: 60, left: 49 });
  });

  it('a tier 0 write answers holder false; with the switch off no holder and no dayCap field at all', async () => {
    const on = world();
    const cookie = await on.h.signIn(W2);
    const reply = await on.h.fetch('POST', '/api/social/room', { cookie, body: { text: 'a calm day in the league' } });
    expect(reply.status).toBe(201);
    expect(JSON.stringify(reply.json)).toContain('"holder":false');

    await emptyRoomTables(db);
    const off = world({ holders: false });
    off.tiers.set(W3, 3);
    const offCookie = await off.h.signIn(W3);
    const offReply = await off.h.fetch('POST', '/api/social/room', {
      cookie: offCookie,
      body: { text: 'a calm day here' },
    });
    expect(offReply.status).toBe(201);
    expect(offReply.text).not.toContain('holder');
    const me = await off.h.fetch('GET', '/api/social/room/me', { cookie: offCookie });
    expect(me.text).not.toContain('dayCap');
    expect(me.json).toMatchObject({ left: 29 });
  });

  it("an admin's dayCap is 30 whatever it holds", async () => {
    const { h, tiers } = world();
    tiers.set(ADMIN.toLowerCase(), 3);
    const cookie = await h.signIn(ADMIN);
    const me = roomMeResponseSchema.parse((await h.fetch('GET', '/api/social/room/me', { cookie })).json);
    expect(me).toMatchObject({ dayCap: 30 });
  });

  it('a tier 0 wallet at 30 claiming tier 3 in a header or a cookie writes no 31st message', async () => {
    const { h } = world();
    const cookie = await h.signIn(W4);
    await wrote(W4, 30);
    for (const forged of [
      { extraHeaders: { 'X-Prix-Tier': '3', 'X-Holder': 'true', 'X-Day-Cap': '120' } },
      { extraCookie: 'prix_tier=3; dayCap=120; holder=1' },
    ]) {
      h.advance(60_000);
      const reply = await h.fetch('POST', '/api/social/room', {
        cookie,
        body: { text: 'let me write more' },
        ...forged,
      });
      expect(reply.status, reply.text).toBe(ROOM_REFUSALS.wallet_day);
    }
    expect(await countOf(W4)).toBe(30);
    const me = roomMeResponseSchema.parse(
      (await h.fetch('GET', '/api/social/room/me', { cookie, extraHeaders: { 'X-Prix-Tier': '3' } })).json,
    );
    expect(me).toMatchObject({ dayCap: 30, left: 0 });
  });
});

describe('case 2: the public read marks a stored row of the gate token, younger than the grace, never an admin', () => {
  it('tier 1 true; another token, exactly the grace, no row, tier 0 and an admin at tier 3 false', async () => {
    const { h } = world();
    const writers = [W1, W2, W3, W4, W5, ADMIN];
    for (const [index, writer] of writers.entries()) {
      const cookie = await h.signIn(writer);
      const reply = await h.fetch('POST', '/api/social/room', {
        cookie,
        body: { text: `line number ${'abcdef'[index]}` },
      });
      expect(reply.status, reply.text).toBe(201);
      h.advance(1_000);
    }
    h.advance(120_000);
    const readAt = Date.parse(NOW) + writers.length * 1_000 + 120_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    await storeTier(W1, 1, iso(readAt - 60_000));
    await storeTier(W2, 2, iso(readAt - 60_000), OTHER_TOKEN);
    await storeTier(W3, 1, iso(readAt - TOKEN_STALE_GRACE_SECONDS * 1000));
    await storeTier(W5, 0, iso(readAt - 60_000));
    await storeTier(ADMIN.toLowerCase(), 3, iso(readAt - 60_000));
    const reply = await h.fetch('GET', '/api/social/room');
    expect(reply.status).toBe(200);
    const parsed = roomResponseSchema.parse(reply.json);
    const marks = Object.fromEntries(parsed.messages.map((message) => [message.text, message.holder]));
    expect(marks).toEqual({
      'line number a': true,
      'line number b': false,
      'line number c': false,
      'line number d': false,
      'line number e': false,
      'line number f': false,
    });
    expect(reply.text).not.toMatch(/"tier"|10,000|\$PRIX holds/);
  });

  it('the gate off marks nobody, and the switch off sends no holder field', async () => {
    const off = world({ gate: { gatingOn: false, token: PRIX } });
    const cookie = await off.h.signIn(W1);
    expect((await off.h.fetch('POST', '/api/social/room', { cookie, body: { text: 'gate is off now' } })).status).toBe(
      201,
    );
    off.h.advance(120_000);
    await storeTier(W1, 3, new Date(Date.parse(NOW) + 60_000).toISOString());
    const gateOff = roomResponseSchema.parse((await off.h.fetch('GET', '/api/social/room')).json);
    expect(gateOff.messages.every((message) => message.holder === false)).toBe(true);

    const none = world({ holders: false });
    none.h.advance(300_000);
    const plain = await none.h.fetch('GET', '/api/social/room');
    expect(plain.status).toBe(200);
    expect(plain.text).not.toContain('holder');
  });
});
