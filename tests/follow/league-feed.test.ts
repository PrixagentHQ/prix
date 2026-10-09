import {
  agentFeedResponseSchema,
  entitlementsOfTier,
  FEED_PAGE_MAX,
  feedCursorSchema,
  followingFeedResponseSchema,
  leagueFeedResponseSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { expectError, expectPublicCache, expectShape } from '../support/api.ts';
import type { Harness } from './support.ts';
import { CUT, createHarness, followAgent, readAll, TICK_IDS, VISIBLE_TICK_IDS, wallet } from './support.ts';

/**
 * GET /api/feed/league (docs/CONTRACTS.md section 17, docs/contracts/phase-3-follow.md "After
 * the board look"): the newest decisions of every visible agent, the same answer for everyone.
 * It is stored and served to all, so nothing about the person who asks may reach it.
 */

const DELAY = 86_400;
const VIEWER = wallet(51);
const OWNER = wallet(52);
const WHALE = wallet(53);
const HOUSE = wallet(54);

const PATH = '/api/feed/league';

/** Gating on: a visitor and a tier 0 wallet are held back a day, a tier 3 wallet is not. */
function gated(options: { houseOwners?: readonly string[] } = {}): Harness {
  return createHarness({
    base: entitlementsOfTier(0),
    byAddress: { [WHALE.address]: entitlementsOfTier(3) },
    houseOwners: options.houseOwners,
  });
}

const keyOf = (item: { tickId: string; agentId: string }): string => `${item.tickId}~${item.agentId}`;

describe('GET /api/feed/league', () => {
  it('lists the decisions of every agent, newest tick first and then agent id descending', async () => {
    const h = createHarness();
    const first = await h.seedAgent(1);
    const second = await h.seedAgent(2);
    const reply = await h.anonymous().get(`${PATH}?limit=${FEED_PAGE_MAX}`);
    const body = expectShape(leagueFeedResponseSchema, reply);
    expectPublicCache(reply);

    expect(body.items).toHaveLength(TICK_IDS.length * 2);
    const keys = body.items.map(keyOf);
    expect(keys).toEqual([...keys].sort().reverse());
    expect(new Set(body.items.map((item) => item.agentId))).toEqual(new Set([first.id, second.id]));
    expect(body.nextCursor).toBeNull();
    // No token exists in the preview, so nothing is held back and the page says so.
    expect(body.delay).toEqual({ seconds: 0, gatingOn: false });
    for (const item of body.items) expect(item.simulated).toBe(true);
  });

  it('gives a holder, an owner and a visitor the same answer: the cookie changes nothing', async () => {
    const h = gated();
    const agent = await h.seedAgent(1);
    const owned = await h.seedAgent(2, { owner: OWNER.address });

    const visitor = await h.anonymous().get(PATH);
    const body = expectShape(leagueFeedResponseSchema, visitor);
    // The cut of a visitor who is not signed in: nothing written inside the last day.
    expect(body.delay).toEqual({ seconds: DELAY, gatingOn: true });
    expect(body.items).toHaveLength(VISIBLE_TICK_IDS.length * 2);
    for (const item of body.items) expect(item.at <= CUT, `${item.at} is inside the delay`).toBe(true);
    expect(new Set(body.items.map((item) => item.agentId))).toEqual(new Set([agent.id, owned.id]));

    // A tier 3 wallet sees every row of the agent's own feed, and the league feed as anyone does.
    const whale = await h.as(WHALE);
    const own = expectShape(agentFeedResponseSchema, await whale.get(`/api/agents/${agent.id}/feed`));
    expect(own.items).toHaveLength(TICK_IDS.length);
    // The owner of an agent sees its own feed without the delay, and the league feed as anyone does.
    const owner = await h.as(OWNER);
    const ownerFeed = expectShape(agentFeedResponseSchema, await owner.get(`/api/agents/${owned.id}/feed`));
    expect(ownerFeed.items).toHaveLength(TICK_IDS.length);

    for (const client of [whale, owner, await h.as(VIEWER)]) {
      const reply = await client.get(PATH);
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual(body);
      // Public with a cookie too: the Worker stores this answer and serves it to everyone.
      expectPublicCache(reply);
      expect(reply.headers.get('Set-Cookie')).toBeNull();
      expect(reply.headers.get('Vary')).toBeNull();
    }
  });

  it('reads no session: a forged cookie is answered like no cookie, and no session is looked up', async () => {
    const h = gated();
    await h.seedAgent(1);
    const expected = (await h.anonymous().get(PATH)).json;
    const signedIn = await h.as(WHALE);
    const forged = h.anonymous();
    forged.cookie = 'tier3-forged-session-token';

    h.api.store.calls.getSession = 0;
    expect((await forged.get(PATH)).json).toEqual(expected);
    expect((await signedIn.get(PATH)).json).toEqual(expected);
    expect(h.api.store.calls.getSession).toBe(0);
    // The feed of followed agents is another route, and it stays behind the session.
    expectError(await forged.get('/api/feed'), 401, 'unauthorized');
    expectError(await h.anonymous().get('/api/feed'), 401, 'unauthorized');
  });

  it('leaves a hidden agent out', async () => {
    const h = createHarness();
    const shown = await h.seedAgent(1);
    const hidden = await h.seedAgent(2, { hidden: true });
    const body = expectShape(leagueFeedResponseSchema, await h.anonymous().get(`${PATH}?limit=${FEED_PAGE_MAX}`));
    expect(body.items).toHaveLength(TICK_IDS.length);
    expect(new Set(body.items.map((item) => item.agentId))).toEqual(new Set([shown.id]));
    expect(JSON.stringify(body)).not.toContain(hidden.id);
    expect(JSON.stringify(body)).not.toContain(hidden.name);
  });

  it('walks every item once with the cursor, in pages of the limit', async () => {
    const h = createHarness();
    await h.seedAgent(1);
    await h.seedAgent(2);
    await h.seedAgent(3);
    const client = h.anonymous();
    const total = TICK_IDS.length * 3;

    const first = expectShape(leagueFeedResponseSchema, await client.get(`${PATH}?limit=7`));
    expect(first.items).toHaveLength(7);
    // Section 20: the cursor is the key of the last item, signed: `<tickId>~<agentId>~<16 base32>`.
    const boundary = keyOf(first.items[6] as { tickId: string; agentId: string });
    const cursor = first.nextCursor as string;
    expect(feedCursorSchema.safeParse(cursor).success).toBe(true);
    expect(cursor.startsWith(`${boundary}~`)).toBe(true);
    expect(cursor).toMatch(/~[a-z2-7]{16}$/);
    // The same boundary is always signed the same way.
    expect((await client.get(`${PATH}?limit=7`)).json).toMatchObject({ nextCursor: cursor });
    const second = expectShape(
      leagueFeedResponseSchema,
      await client.get(`${PATH}?limit=7&cursor=${encodeURIComponent(cursor)}`),
    );
    expect(second.items).toHaveLength(7);
    expect(keyOf(second.items[0] as { tickId: string; agentId: string }) < boundary).toBe(true);
    // The bare key without its signature is refused, like any cursor the API did not sign.
    expectError(await client.get(`${PATH}?limit=7&cursor=${encodeURIComponent(boundary)}`), 400, 'invalid_input');

    const all = await readAll(client, PATH, 7);
    const keys = all.map(keyOf);
    expect(keys).toHaveLength(total);
    expect(new Set(keys).size).toBe(total);
    expect(keys).toEqual([...keys].sort().reverse());
    // A page of exactly what is left has no next page.
    const whole = await readAll(client, PATH, 11);
    expect(whole.map(keyOf)).toEqual(keys);
  });

  it('uses the default page of the other feeds and refuses their bad queries', async () => {
    const h = gated();
    await h.seedAgent(1);
    await h.seedAgent(2);
    await h.seedAgent(3);
    await h.seedAgent(4);
    const client = h.anonymous();
    const body = expectShape(leagueFeedResponseSchema, await client.get(PATH));
    // Four agents with six visible rows each: the default page is 20 and there is more.
    expect(body.items).toHaveLength(20);
    expect(body.nextCursor).not.toBeNull();
    for (const query of ['delay=0', 'tier=3', 'division=open', 'limit=0', `limit=${FEED_PAGE_MAX + 1}`, 'cursor=x']) {
      expectError(await client.get(`${PATH}?${query}`), 400, 'invalid_input');
    }
  });
});

describe('the house mark on feed items', () => {
  // Written in capitals on purpose: the variable may be, and the comparison must not care.
  const houseOwners = [HOUSE.address.toUpperCase().replace('0X', '0x')];

  it('marks every item of a house agent, and no other, on all three feeds', async () => {
    const h = gated({ houseOwners });
    const house = await h.seedAgent(1, { owner: HOUSE.address });
    const other = await h.seedAgent(2, { owner: OWNER.address });
    const viewer = await h.as(VIEWER);
    followAgent(h, VIEWER.address, house.id);
    followAgent(h, VIEWER.address, other.id);

    const league = expectShape(leagueFeedResponseSchema, await h.anonymous().get(PATH));
    const following = expectShape(followingFeedResponseSchema, await viewer.get('/api/feed'));
    expect(league.items.length).toBeGreaterThan(0);
    expect(following.items.length).toBeGreaterThan(0);
    for (const item of [...league.items, ...following.items]) {
      expect(item.house, `${item.agentName} at ${item.tickId}`).toBe(item.agentId === house.id);
    }

    const houseFeed = expectShape(agentFeedResponseSchema, await viewer.get(`/api/agents/${house.id}/feed`));
    const otherFeed = expectShape(agentFeedResponseSchema, await viewer.get(`/api/agents/${other.id}/feed`));
    expect(houseFeed.items.length).toBeGreaterThan(0);
    expect(houseFeed.items.every((item) => item.house === true)).toBe(true);
    expect(otherFeed.items.every((item) => item.house === false)).toBe(true);
  });

  it('holds a house agent back like any other: the mark is the only difference', async () => {
    const h = gated({ houseOwners });
    await h.seedAgent(1, { owner: HOUSE.address });
    await h.seedAgent(2, { owner: OWNER.address });
    const body = expectShape(leagueFeedResponseSchema, await h.anonymous().get(PATH));
    expect(body.items.filter((item) => item.house === true)).toHaveLength(VISIBLE_TICK_IDS.length);
    expect(body.items.filter((item) => item.house === false)).toHaveLength(VISIBLE_TICK_IDS.length);
  });

  it('says house false on every item when no wallet is a house wallet', async () => {
    const h = createHarness();
    await h.seedAgent(1, { owner: HOUSE.address });
    const body = expectShape(leagueFeedResponseSchema, await h.anonymous().get(PATH));
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.house === false)).toBe(true);
  });

  it('puts no owner address into a feed answer', async () => {
    const h = gated({ houseOwners });
    const house = await h.seedAgent(1, { owner: HOUSE.address });
    const viewer = await h.as(VIEWER);
    followAgent(h, VIEWER.address, house.id);
    for (const path of [PATH, '/api/feed', `/api/agents/${house.id}/feed`]) {
      const reply = await viewer.get(path);
      expect(reply.status).toBe(200);
      expect(reply.text.toLowerCase()).not.toContain(HOUSE.address.slice(2).toLowerCase());
      expect(reply.text).not.toContain('owner');
    }
  });
});
