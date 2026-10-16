import type { RoomAuthorHolder } from '@prix/contracts';
import {
  ROOM_MESSAGES_PER_WALLET_PER_DAY,
  ROOM_PICTURES_PATH,
  ROOM_REFUSALS,
  ROOM_WALLET_DAY_CAP_BY_TIER,
  roomMeResponseSchema,
  roomMeWithPicturesResponseSchema,
  roomPicturePostResponseSchema,
  roomPostResponseSchema,
  roomResponseSchema,
  roomWithPicturesResponseSchema,
  TOKEN_STALE_GRACE_SECONDS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { ROOM_SENTENCES } from './refusals.ts';
import {
  ADMIN,
  createHarness,
  DAY,
  errorOf,
  type Harness,
  HOLDER,
  OTHER,
  START,
  settled,
  TOKEN,
} from './test-support.ts';
import { gifBytes } from './test-support-pictures.ts';

/**
 * Phase 6.8, F: holders in the Community chat (docs/contracts/phase-6-holders-2.md section 2). The Holder
 * mark on the room's public read from the stored row, and the wallet's cap of the day by tier on the write,
 * the upload and `me`. A store in memory, no D1.
 */

const ROOM = '/api/social/room';
const ME = '/api/social/room/me';
/** A stored row read an hour before the harness's clock, of the gate's token. */
function row(tier: number, fields: Partial<RoomAuthorHolder> = {}): RoomAuthorHolder {
  return { tier, tokenAddress: TOKEN, checkedAt: '2026-10-20T11:00:00.000Z', ...fields };
}

/** A writer who has written `count` messages today, the last long ago. */
function wrote(h: Harness, address: string, count: number): void {
  h.room.setWriter(address, { lastAt: '2026-10-20T01:00:00.000Z', day: DAY, count });
}

describe('the Holder mark on the public read', () => {
  async function marks(h: Harness): Promise<Record<string, boolean | undefined>> {
    const reply = await h.fetch('GET', ROOM);
    expect(reply.status).toBe(200);
    const parsed = roomResponseSchema.parse(reply.json);
    const out: Record<string, boolean | undefined> = {};
    for (const message of parsed.messages) out[message.text] = message.holder;
    return out;
  }

  it('marks a writer at tier 1 and no other, from the stored row', async () => {
    const h = createHarness({ holders: true });
    h.room.seed(HOLDER, 'tier one', START);
    h.room.seed(OTHER, 'tier zero', START);
    h.room.seed('0x00000000000000000000000000000000000000f1', 'no row', START);
    h.room.seed('0x00000000000000000000000000000000000000f2', 'other token', START);
    h.room.seed('0x00000000000000000000000000000000000000f3', 'at the grace', START);
    h.room.seed(ADMIN, 'admin', START);
    h.room.tokenRows.set(HOLDER, row(1));
    h.room.tokenRows.set(OTHER, row(0));
    h.room.tokenRows.set('0x00000000000000000000000000000000000000f2', row(3, { tokenAddress: `0x${'9'.repeat(40)}` }));
    const graceAgo = new Date(Date.parse(START) - TOKEN_STALE_GRACE_SECONDS * 1_000).toISOString();
    h.room.tokenRows.set('0x00000000000000000000000000000000000000f3', row(2, { checkedAt: graceAgo }));
    h.room.tokenRows.set(ADMIN, row(3));
    expect(await marks(h)).toEqual({
      'tier one': true,
      'tier zero': false,
      'no row': false,
      'other token': false,
      'at the grace': false,
      admin: false,
    });
    expect(h.gate.asked).toBe(1);
    // The read asks no holding: the mark is the stored row's, never a read of the chain.
    expect(h.holding.asked).toEqual([]);
    expect(h.entitlements.asked).toEqual([]);
  });

  it('marks nobody while the gate is off', async () => {
    const h = createHarness({ holders: true });
    h.gate.gatingOn = false;
    h.room.seed(HOLDER, 'tier one', START);
    h.room.tokenRows.set(HOLDER, row(3));
    expect(await marks(h)).toEqual({ 'tier one': false });
  });

  it('sends no holder field while ROOM_HOLDERS is off, and asks no gate', async () => {
    const h = createHarness({ holders: false });
    h.room.seed(HOLDER, 'tier one', START);
    h.room.tokenRows.set(HOLDER, row(1));
    const reply = await h.fetch('GET', ROOM);
    expect(reply.json.messages[0]).not.toHaveProperty('holder');
    expect(h.gate.asked).toBe(0);
  });

  it('counts absent deps as off: no holder field', async () => {
    for (const h of [createHarness(), createHarness({ holders: true, holdersGate: false })]) {
      h.room.seed(HOLDER, 'tier one', START);
      h.room.tokenRows.set(HOLDER, row(1));
      const reply = await h.fetch('GET', ROOM);
      expect(reply.json.messages[0]).not.toHaveProperty('holder');
    }
  });

  it('marks picture rows too while pictures are on', async () => {
    const h = createHarness({ holders: true, pictures: true });
    h.room.seed(HOLDER, 'tier one', START);
    h.room.seed(OTHER, 'tier zero', START);
    h.room.tokenRows.set(HOLDER, row(1));
    const reply = await h.fetch('GET', ROOM);
    const parsed = roomWithPicturesResponseSchema.parse(reply.json);
    expect(parsed.messages.map((message) => [message.text, message.holder])).toEqual([
      ['tier zero', false],
      ['tier one', true],
    ]);
    expect(h.gate.asked).toBe(1);
  });
});

describe('the cap of a day by tier on the write', () => {
  async function post(h: Harness, address: string): Promise<{ status: number; json: unknown; field?: string }> {
    const cookie = await h.signIn(address);
    const reply = await h.fetch('POST', ROOM, { cookie, body: { text: 'hello' } });
    return { status: reply.status, json: reply.json, field: reply.json?.error?.field };
  }

  it('lets a tier 1 wallet write its 31st to 60th message, refused at the 61st', async () => {
    const h = createHarness({ holders: true });
    h.holding.tiers.set(HOLDER, 1);
    wrote(h, HOLDER, 30);
    const thirtyFirst = await post(h, HOLDER);
    expect(thirtyFirst.status).toBe(201);
    const parsed = roomPostResponseSchema.parse(thirtyFirst.json);
    expect(parsed.left).toBe(ROOM_WALLET_DAY_CAP_BY_TIER[1] - 31);
    expect(parsed.message.holder).toBe(true);
    wrote(h, HOLDER, 60);
    const sixtyFirst = await post(h, HOLDER);
    expect(sixtyFirst.status).toBe(ROOM_REFUSALS.wallet_day);
    expect(sixtyFirst.field).toBe('wallet_day');
    // The holding is the stored one: never a read of the chain on a write.
    expect(h.holding.asked.every((ask) => ask.options?.cachedOnly === true)).toBe(true);
    // The 61st is refused at step 4, by the same cap, before any turn is asked.
    expect(h.room.dayCaps).toEqual([60]);
  });

  it('refuses a tier 0 wallet at its 31st, and its answer carries holder false', async () => {
    const h = createHarness({ holders: true });
    wrote(h, OTHER, 29);
    const thirtieth = await post(h, OTHER);
    expect(thirtieth.status).toBe(201);
    expect(roomPostResponseSchema.parse(thirtieth.json).message.holder).toBe(false);
    wrote(h, OTHER, 30);
    const thirtyFirst = await post(h, OTHER);
    expect(thirtyFirst.status).toBe(ROOM_REFUSALS.wallet_day);
  });

  it('keeps 30 for a tier 3 wallet while ROOM_HOLDERS is off, and sends no holder', async () => {
    const h = createHarness({ holders: false });
    h.holding.tiers.set(HOLDER, 3);
    wrote(h, HOLDER, 29);
    const ok = await post(h, HOLDER);
    expect(ok.status).toBe(201);
    expect(roomPostResponseSchema.parse(ok.json).message).not.toHaveProperty('holder');
    wrote(h, HOLDER, 30);
    expect((await post(h, HOLDER)).status).toBe(ROOM_REFUSALS.wallet_day);
  });

  it('keeps 30 for deps built without the two new fields', async () => {
    const h = createHarness();
    h.holding.tiers.set(HOLDER, 3);
    wrote(h, HOLDER, 30);
    expect((await post(h, HOLDER)).status).toBe(ROOM_REFUSALS.wallet_day);
  });

  it('keeps 30 while the gate is off in the holding', async () => {
    const h = createHarness({ holders: true });
    h.holding.tiers.set(HOLDER, 3);
    h.holding.gatingOn = false;
    // With the gate off nobody but an admin writes at all; the refusal is the gate's.
    expect((await post(h, HOLDER)).field).toBe('gate_off');
  });

  it('says the wallet_day refusal with no figure', async () => {
    const h = createHarness({ holders: true });
    wrote(h, OTHER, 30);
    const cookie = await h.signIn(OTHER);
    const reply = await h.fetch('POST', ROOM, { cookie, body: { text: 'hello' } });
    expect(errorOf(reply).message).toBe(ROOM_SENTENCES.wallet_day);
    expect(ROOM_SENTENCES.wallet_day).toBe(
      'This wallet has written all the messages its holding allows today. Write again after 00:00 UTC.',
    );
    expect(ROOM_SENTENCES.wallet_day.replace('00:00 UTC', '')).not.toMatch(/\d/);
  });

  it("an admin's answer carries no mark and left 30", async () => {
    const h = createHarness({ holders: true });
    const reply = await post(h, ADMIN);
    expect(reply.status).toBe(201);
    const parsed = roomPostResponseSchema.parse(reply.json);
    expect(parsed.left).toBe(ROOM_MESSAGES_PER_WALLET_PER_DAY);
    expect(parsed.message.holder).toBe(false);
    expect(parsed.message.admin).toBe(true);
  });
});

describe('me answers the cap of the day', () => {
  it('follows the tier, read without cachedOnly, while ROOM_HOLDERS is on', async () => {
    const h = createHarness({ holders: true });
    h.holding.tiers.set(HOLDER, 2);
    wrote(h, HOLDER, 40);
    const reply = await h.fetch('GET', ME, { cookie: await h.signIn(HOLDER) });
    expect(roomMeResponseSchema.parse(reply.json)).toEqual({ write: 'yes', left: 50, dayCap: 90 });
    expect(h.holding.asked.map((ask) => ask.options?.cachedOnly)).toEqual([undefined]);
  });

  it('sends no dayCap while ROOM_HOLDERS is off', async () => {
    const h = createHarness({ holders: false });
    h.holding.tiers.set(HOLDER, 2);
    wrote(h, HOLDER, 10);
    const reply = await h.fetch('GET', ME, { cookie: await h.signIn(HOLDER) });
    expect(reply.json).toEqual({ write: 'yes', left: 20 });
  });

  it("an admin's dayCap is 30", async () => {
    const h = createHarness({ holders: true });
    const reply = await h.fetch('GET', ME, { cookie: await h.signIn(ADMIN) });
    expect(reply.json).toEqual({ write: 'yes', left: 30, dayCap: 30 });
  });

  it('with pictures on, meWithPictures carries the same', async () => {
    const h = createHarness({ holders: true, pictures: true });
    h.holding.tiers.set(HOLDER, 3);
    wrote(h, HOLDER, 100);
    const reply = await h.fetch('GET', ME, { cookie: await h.signIn(HOLDER) });
    const parsed = roomMeWithPicturesResponseSchema.parse(reply.json);
    expect(parsed.left).toBe(20);
    expect(parsed.dayCap).toBe(120);
    const off = createHarness({ holders: false, pictures: true });
    const offReply = await off.fetch('GET', ME, { cookie: await off.signIn(HOLDER) });
    expect(offReply.json).not.toHaveProperty('dayCap');
  });
});

describe('a picture counts against the same day', () => {
  it('passes the cap of its cachedOnly holding and carries holder', async () => {
    const h = createHarness({ holders: true, pictures: true });
    h.room.firstAt.set(HOLDER, '2026-10-20T10:00:00.000Z');
    h.holding.tiers.set(HOLDER, 1);
    wrote(h, HOLDER, 45);
    const cookie = await h.signIn(HOLDER);
    const reply = await h.fetch('POST', ROOM_PICTURES_PATH, { bytes: gifBytes(), cookie });
    await settled(h);
    expect(reply.status).toBe(201);
    const parsed = roomPicturePostResponseSchema.parse(reply.json);
    expect(parsed.left).toBe(60 - 46);
    expect(parsed.message.holder).toBe(true);
    expect(h.pictures.dayCaps).toEqual([60]);
    expect(h.holding.asked.map((ask) => ask.options?.cachedOnly)).toEqual([true]);
  });

  it('is refused at the tier 0 cap with wallet_day', async () => {
    const h = createHarness({ holders: true, pictures: true });
    h.room.firstAt.set(HOLDER, '2026-10-20T10:00:00.000Z');
    wrote(h, HOLDER, 30);
    const cookie = await h.signIn(HOLDER);
    const reply = await h.fetch('POST', ROOM_PICTURES_PATH, { bytes: gifBytes(), cookie });
    await settled(h);
    expect(reply.status).toBe(ROOM_REFUSALS.wallet_day);
    expect(errorOf(reply).field).toBe('wallet_day');
  });
});
