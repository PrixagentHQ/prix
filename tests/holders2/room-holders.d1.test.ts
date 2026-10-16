import type { Address, HoldersGate, RoomApiDeps, Tier } from '@prix/contracts';
import { ROOM_REFUSALS, roomMeResponseSchema, roomResponseSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRoomStore } from '../../apps/api/src/store/room.ts';
import type { RoomHarness, RoomParts } from '../social/api/harness.ts';
import { createRoomHarness, emptyRoomTables, errorOf } from '../social/api/harness.ts';
import { db, storesOn } from '../social/support/d1.ts';

/**
 * Phase 6.8, F (docs/contracts/phase-6-holders-2.md section 2, qa cases 2 to 4): the room's real routes behind
 * `createApp`, the real room store and the token rows on a local D1. The holding the write reads is the
 * test's own (a tier and whole tokens by address); the Holder mark comes from `token_holders` joined by the
 * store. The attacks: a client that claims a tier (a body field, a query, a header, a cookie), the cap at
 * each tier, and a tier that drops between two messages.
 */

const NOW = '2026-10-20T12:10:30.000Z';
const DAY = '2026-10-20';
const PRIX = '0xa74ac6e9f2f8493344923c23972d496364241044' as Address;
const WRITER = '0x00000000000000000000000000000000000005b2';
const READER = '0x00000000000000000000000000000000000005b3';
const ON: HoldersGate = { gatingOn: true, token: PRIX };

interface World {
  h: RoomHarness;
  tiers: Map<string, Tier>;
  reads: { address: string; cachedOnly: boolean }[];
}

function world(holders: boolean): World {
  const tiers = new Map<string, Tier>();
  const reads: World['reads'] = [];
  const holding: RoomApiDeps['holding'] = async (address, read) => {
    reads.push({ address, cachedOnly: read?.cachedOnly === true });
    return { gatingOn: true, tokens: 50_000, tier: tiers.get(address.toLowerCase()) ?? 0, checkedAt: NOW };
  };
  const parts: RoomParts = { ...storesOn(db), room: createRoomStore(db) };
  const h = createRoomHarness(parts, {
    now: NOW,
    prixAddress: PRIX,
    holding,
    ...(holders ? { holders: { gate: async () => ON } } : {}),
  });
  return { h, tiers, reads };
}

/** A writer who wrote `count` messages today, the last long ago: no wait of 20 seconds stands. */
async function wrote(address: string, count: number): Promise<void> {
  await db
    .prepare(
      'INSERT OR REPLACE INTO room_writers (address, last_at, day, count, muted_at, muted_by, cut_at) VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL)',
    )
    .bind(address, '2026-10-20T01:00:00.000Z', DAY, count)
    .run();
}

async function countOf(address: string): Promise<number> {
  const row = await db
    .prepare('SELECT count FROM room_writers WHERE address = ?1')
    .bind(address)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function storeTier(address: string, tier: number, token: string = PRIX, checkedAt = '2026-10-20T11:00:00.000Z') {
  await db
    .prepare(
      `INSERT OR REPLACE INTO token_holders (address, balance, total_supply, decimals, tier, max_agents, token_address, checked_at, slots_dirty)
       VALUES (?1, '0', '1000000000000000000000000000', 18, ?2, 1, ?3, ?4, 0)`,
    )
    .bind(address, tier, token, checkedAt)
    .run();
}

const post = (h: RoomHarness, cookie: string, init: { body?: unknown; path?: string } = {}) =>
  h.fetch('POST', init.path ?? '/api/social/room', {
    cookie,
    body: init.body ?? { text: 'the league looks calm today' },
  });

beforeEach(async () => {
  await emptyRoomTables(db);
  await db.prepare('DELETE FROM token_holders').run();
});

describe('the cap of a wallet by tier, on the real store', () => {
  for (const [tier, cap] of [
    [0, 30],
    [1, 60],
    [2, 90],
    [3, 120],
  ] as const) {
    it(`tier ${tier} writes its ${cap}th message and is refused wallet_day at the next`, async () => {
      const w = world(true);
      w.tiers.set(WRITER, tier);
      const cookie = await w.h.signIn(WRITER);
      await wrote(WRITER, cap - 1);
      const last = await post(w.h, cookie);
      expect(last.status, last.text).toBe(201);
      expect(last.json.left).toBe(0);
      expect(await countOf(WRITER)).toBe(cap);
      w.h.advance(60_000);
      const refused = await post(w.h, cookie);
      expect(refused.status).toBe(ROOM_REFUSALS.wallet_day);
      expect(errorOf(refused)).toMatchObject({ field: 'wallet_day' });
      expect(refused.text).not.toContain(String(cap));
      expect(await countOf(WRITER)).toBe(cap);
      // The write asked the stored holding only.
      expect(w.reads.filter((read) => read.address.toLowerCase() === WRITER).every((read) => read.cachedOnly)).toBe(
        true,
      );
    });
  }

  it('a tier that drops between two messages refuses the next one at once', async () => {
    const w = world(true);
    w.tiers.set(WRITER, 1);
    const cookie = await w.h.signIn(WRITER);
    await wrote(WRITER, 44);
    expect((await post(w.h, cookie)).status).toBe(201);
    w.tiers.set(WRITER, 0);
    w.h.advance(60_000);
    const refused = await post(w.h, cookie);
    expect(refused.status).toBe(ROOM_REFUSALS.wallet_day);
    expect(await countOf(WRITER)).toBe(45);
    const me = roomMeResponseSchema.parse((await w.h.fetch('GET', '/api/social/room/me', { cookie })).json);
    expect(me).toMatchObject({ left: 0, dayCap: 30 });
  });

  it('ROOM_HOLDERS off keeps 30 for a tier 3 wallet and sends no dayCap', async () => {
    const w = world(false);
    w.tiers.set(WRITER, 3);
    const cookie = await w.h.signIn(WRITER);
    await wrote(WRITER, 30);
    expect((await post(w.h, cookie)).status).toBe(ROOM_REFUSALS.wallet_day);
    const me = (await w.h.fetch('GET', '/api/social/room/me', { cookie })).json;
    expect(me).not.toHaveProperty('dayCap');
  });
});

describe('a client that claims a tier is not believed', () => {
  it('a body field, a query, a header or a cookie claiming tier 3 gives a tier 0 wallet no 31st message', async () => {
    const w = world(true);
    const cookie = await w.h.signIn(WRITER);
    await wrote(WRITER, 30);
    const attempts = [
      { body: { text: 'hello there all', tier: 3, holder: true, dayCap: 120 } },
      { path: '/api/social/room?tier=3&dayCap=120' },
      { body: { text: 'hello there all' } },
    ];
    for (const attempt of attempts) {
      w.h.advance(60_000);
      const reply = await post(w.h, cookie, attempt);
      expect(reply.status, reply.text).not.toBe(201);
    }
    expect(await countOf(WRITER)).toBe(30);
  });

  it('the public read marks only a stored row of the gate token, whatever the request carries', async () => {
    const w = world(true);
    const a = await w.h.signIn(WRITER);
    const b = await w.h.signIn(READER);
    w.tiers.set(WRITER, 1);
    w.tiers.set(READER, 0);
    // READER's own holding claims tier 3 at write time but it is not stored; WRITER's stored row is tier 1.
    await storeTier(WRITER, 1);
    await storeTier(READER, 3, '0x1234567890abcdef1234567890abcdef12345678');
    expect((await post(w.h, a, { body: { text: 'first line here' } })).status).toBe(201);
    w.h.advance(30_000);
    expect((await post(w.h, b, { body: { text: 'second line here' } })).status).toBe(201);
    let read = 0;
    for (const path of ['/api/social/room', '/api/social/room?holder=1&tier=3']) {
      w.h.advance(60_000);
      const reply = await w.h.fetch('GET', path, { cookie: b });
      // A query the read does not know is either refused or ignored; never believed.
      if (path.includes('?') && reply.status !== 200) {
        expect(reply.status).toBe(400);
        continue;
      }
      read += 1;
      const parsed = roomResponseSchema.parse(reply.json);
      const marks = Object.fromEntries(parsed.messages.map((m) => [m.text, m.holder]));
      expect(marks).toEqual({ 'first line here': true, 'second line here': false });
      expect(reply.text).not.toMatch(/"tier"/);
    }
    expect(read).toBeGreaterThan(0);
  });
});
