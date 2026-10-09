import {
  agentFeedResponseSchema,
  agentPublicSchema,
  entitlementsOfTier,
  followingFeedResponseSchema,
  OPEN_PREVIEW_ENTITLEMENTS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { expectError, expectNoStore, expectPublicCache, expectShape } from '../support/api.ts';
import type { Harness } from './support.ts';
import { CUT, createHarness, FOLLOW_NOW, followAgent, readAll, TICK_IDS, VISIBLE_TICK_IDS, wallet } from './support.ts';

const DELAY = 86_400;
const VIEWER = wallet(41);
const OWNER = wallet(42);
const WHALE = wallet(43);

function gated(): Harness {
  return createHarness({
    base: entitlementsOfTier(0),
    byAddress: { [WHALE.address]: entitlementsOfTier(3) },
  });
}

/** No item of the answer was written inside the delay. */
function expectNothingInsideDelay(items: { at: string }[]): void {
  const cut = new Date(new Date(FOLLOW_NOW).getTime() - DELAY * 1000).toISOString();
  expect(cut).toBe(CUT);
  for (const item of items) expect(item.at <= cut, `${item.at} is inside the delay`).toBe(true);
}

describe('the feed delay is decided on the server', () => {
  it('uses the contract: tier 0 has gating on and a delay of 86,400 seconds', () => {
    expect(entitlementsOfTier(0)).toMatchObject({ gatingOn: true, feedDelaySeconds: DELAY });
    expect(entitlementsOfTier(3).feedDelaySeconds).toBe(0);
  });

  it('shows a tier 0 viewer nothing written in the last 86,400 seconds, on both routes', async () => {
    const h = gated();
    const agent = await h.seedAgent(1);
    const client = await h.as(VIEWER);
    followAgent(h, VIEWER.address, agent.id);

    const own = expectShape(agentFeedResponseSchema, await client.get(`/api/agents/${agent.id}/feed`));
    expect(own.items.map((item) => item.tickId).sort()).toEqual([...VISIBLE_TICK_IDS].sort());
    expectNothingInsideDelay(own.items);
    expect(own.delay).toEqual({ seconds: DELAY, gatingOn: true });

    const following = expectShape(followingFeedResponseSchema, await client.get('/api/feed'));
    expect(following.items.map((item) => item.tickId).sort()).toEqual([...VISIBLE_TICK_IDS].sort());
    expectNothingInsideDelay(following.items);
    expect(following.delay).toEqual({ seconds: DELAY, gatingOn: true });
  });

  it('shows a visitor who is not signed in the delayed feed too', async () => {
    const h = gated();
    const agent = await h.seedAgent(1);
    const body = expectShape(agentFeedResponseSchema, await h.anonymous().get(`/api/agents/${agent.id}/feed`));
    expectNothingInsideDelay(body.items);
    expect(body.items).toHaveLength(VISIBLE_TICK_IDS.length);
  });

  it.each(['/api/agents/AGENT/feed', '/api/feed'])(
    'answers 400 for ?delay=0, ?tier=3 and an unknown parameter on %s',
    async (template) => {
      const h = gated();
      const agent = await h.seedAgent(1);
      const client = await h.as(VIEWER);
      const path = template.replace('AGENT', agent.id);
      for (const query of ['delay=0', 'tier=3', 'delaySeconds=0', 'foo=bar', 'gatingOn=false']) {
        expectError(await client.get(`${path}?${query}`), 400, 'invalid_input');
      }
    },
  );

  it('ignores an X-Tier header and other claims in headers', async () => {
    const h = gated();
    const agent = await h.seedAgent(1);
    const client = await h.as(VIEWER);
    followAgent(h, VIEWER.address, agent.id);
    for (const path of [`/api/agents/${agent.id}/feed`, '/api/feed']) {
      const reply = await client.get(path, {
        headers: { 'X-Tier': '3', 'X-Feed-Delay': '0', 'X-Delay': '0', 'X-Entitlements': JSON.stringify({ tier: 3 }) },
      });
      expect(reply.status).toBe(200);
      expect(reply.json.items).toHaveLength(VISIBLE_TICK_IDS.length);
      expect(reply.json.delay).toEqual({ seconds: DELAY, gatingOn: true });
    }
  });

  it('ignores a forged cookie: it is the same as no session', async () => {
    const h = gated();
    const agent = await h.seedAgent(1);
    const forged = h.anonymous();
    forged.cookie = 'tier3-forged-session-token';
    const reply = await forged.get(`/api/agents/${agent.id}/feed`);
    expect(reply.status).toBe(200);
    expect(reply.json.items).toHaveLength(VISIBLE_TICK_IDS.length);
    expectNothingInsideDelay(reply.json.items);
    expectError(await forged.get('/api/feed'), 401, 'unauthorized');
  });

  it('shows everything to a tier 3 viewer', async () => {
    const h = gated();
    const agent = await h.seedAgent(1);
    const client = await h.as(WHALE);
    followAgent(h, WHALE.address, agent.id);
    const own = expectShape(agentFeedResponseSchema, await client.get(`/api/agents/${agent.id}/feed`));
    expect(own.items).toHaveLength(TICK_IDS.length);
    expect(own.delay).toEqual({ seconds: 0, gatingOn: true });
    const following = expectShape(followingFeedResponseSchema, await client.get('/api/feed'));
    expect(following.items).toHaveLength(TICK_IDS.length);
  });

  it('shows everything to the agent owner, who has tier 0', async () => {
    const h = gated();
    const agent = await h.seedAgent(1, { owner: OWNER.address });
    const client = await h.as(OWNER);
    const own = expectShape(agentFeedResponseSchema, await client.get(`/api/agents/${agent.id}/feed`));
    expect(own.items).toHaveLength(TICK_IDS.length);
    // Another tier 0 wallet still sees the delayed feed of the same agent.
    const other = await h.as(VIEWER);
    const delayed = expectShape(agentFeedResponseSchema, await other.get(`/api/agents/${agent.id}/feed`));
    expect(delayed.items).toHaveLength(VISIBLE_TICK_IDS.length);
  });

  it('shows every item with gatingOn false under the open preview entitlements', async () => {
    const h = createHarness({ base: OPEN_PREVIEW_ENTITLEMENTS });
    const agent = await h.seedAgent(1);
    followAgent(h, VIEWER.address, agent.id);
    const client = await h.as(VIEWER);
    const own = expectShape(agentFeedResponseSchema, await client.get(`/api/agents/${agent.id}/feed`));
    expect(own.items).toHaveLength(TICK_IDS.length);
    expect(own.delay).toEqual({ seconds: 0, gatingOn: false });
    const following = expectShape(followingFeedResponseSchema, await client.get('/api/feed'));
    expect(following.items).toHaveLength(TICK_IDS.length);
    expect(following.delay.gatingOn).toBe(false);
  });
});

describe('the cut, the cursor and the cache', () => {
  it('cuts before paging: two pages joined by nextCursor have no duplicate and no hole, newest first', async () => {
    const h = gated();
    const one = await h.seedAgent(1);
    const two = await h.seedAgent(2);
    const client = await h.as(VIEWER);
    followAgent(h, VIEWER.address, one.id);
    followAgent(h, VIEWER.address, two.id);

    const everything = await readAll(client, '/api/feed', 30);
    expect(everything).toHaveLength(VISIBLE_TICK_IDS.length * 2);
    for (const limit of [1, 2, 5, 7]) {
      const paged = await readAll(client, '/api/feed', limit);
      const keys = paged.map((item) => `${item.tickId}~${item.agentId}`);
      expect(new Set(keys).size, `duplicate at limit ${limit}`).toBe(keys.length);
      expect(keys, `hole or order at limit ${limit}`).toEqual(
        everything.map((item) => `${item.tickId}~${item.agentId}`),
      );
      expect(keys).toEqual([...keys].sort().reverse());
      expectNothingInsideDelay(paged);
    }
    // The first page of a feed whose newest rows are all hidden is not empty: the cut came first.
    const firstPage = expectShape(followingFeedResponseSchema, await client.get('/api/feed?limit=3'));
    expect(firstPage.items).toHaveLength(3);
    expect(firstPage.nextCursor).not.toBeNull();
    // An agent feed pages the same way.
    const agentPaged = await readAll(client, `/api/agents/${one.id}/feed`, 4);
    expect(agentPaged.map((item) => item.tickId)).toEqual([...VISIBLE_TICK_IDS].reverse());
  });

  it('answers a session request private and a request without a cookie public for 30 seconds', async () => {
    const h = gated();
    const agent = await h.seedAgent(1);
    const signedIn = await h.as(VIEWER);
    followAgent(h, VIEWER.address, agent.id);
    expectNoStore(await signedIn.get(`/api/agents/${agent.id}/feed`));
    expectNoStore(await signedIn.get('/api/feed'));
    const visitor = await h.anonymous().get(`/api/agents/${agent.id}/feed`);
    expectPublicCache(visitor);
    expect(visitor.headers.get('Cache-Control')).toBe('public, max-age=30');
  });

  it('answers 404 for a hidden agent and for an unknown one', async () => {
    const h = gated();
    const hidden = await h.seedAgent(1, { hidden: true });
    expectError(await h.anonymous().get(`/api/agents/${hidden.id}/feed`), 404, 'not_found');
    expectError(await h.anonymous().get('/api/agents/aaaaaaaaaaaa/feed'), 404, 'not_found');
  });

  it('drops the decisions inside the delay from GET /api/agents/:id for a tier 0 viewer', async () => {
    const h = gated();
    const agent = await h.seedAgent(1, { owner: OWNER.address });
    const viewer = await h.as(VIEWER);
    const page = expectShape(agentPublicSchema, await viewer.get(`/api/agents/${agent.id}`));
    expect(page.decisions.map((decision) => decision.tickId).sort()).toEqual([...VISIBLE_TICK_IDS].sort());
    expectNothingInsideDelay(page.decisions);

    const visitor = expectShape(agentPublicSchema, await h.anonymous().get(`/api/agents/${agent.id}`));
    expect(visitor.decisions).toHaveLength(VISIBLE_TICK_IDS.length);

    const whale = await h.as(WHALE);
    const all = expectShape(agentPublicSchema, await whale.get(`/api/agents/${agent.id}`));
    expect(all.decisions).toHaveLength(TICK_IDS.length);
    const owner = await h.as(OWNER);
    const own = expectShape(agentPublicSchema, await owner.get(`/api/agents/${agent.id}`));
    expect(own.decisions).toHaveLength(TICK_IDS.length);
  });
});
