import type { DnaProfile } from '@prix/contracts';
import {
  agentNameKey,
  agentSocialResponseSchema,
  FORKS_PER_PARENT_PER_DAY,
  familyResponseSchema,
  forkSourceResponseSchema,
  linkForkResponseSchema,
  socialStatusResponseSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createHarness, errorOf, type Harness, HOUSE, START } from './harness.ts';
import { promptKeys } from './scan.ts';

const OWNER = '0x0000000000000000000000000000000000000b01';
const OTHER = '0x0000000000000000000000000000000000000b02';
const EARLIER = '2026-10-10T09:00:00.000Z';
const JUST_NOW = '2026-10-20T11:58:00.000Z';

function dnaOf(agentId: string): DnaProfile {
  const axis = { value: null, sample: 3, min: 10, note: 'not_enough_history' as const };
  return {
    method: 'dna-v1',
    agentId,
    status: 'forming',
    asOfDay: '2026-10-18',
    windowStartDay: '2026-10-06',
    strategySinceDay: '2026-10-06',
    pricedDays: 9,
    observedDays: 3,
    firstTickId: null,
    lastTickId: null,
    axes: {
      positionsMilli: axis,
      cashBps: axis,
      turnoverBps: axis,
      holdingDays: axis,
      swingBps: axis,
      deepestFallBps: axis,
      momentumMilli: axis,
    },
    computedAt: '2026-10-20T03:00:00.000Z',
  };
}

async function family(h: Harness) {
  const root = await h.seedAgent(1, { createdAt: EARLIER, owner: HOUSE });
  const parent = await h.seedAgent(2, { createdAt: '2026-10-11T09:00:00.000Z' });
  const child = await h.seedAgent(3, { createdAt: '2026-10-12T09:00:00.000Z' });
  h.social.lineage.set(parent.id, {
    agentId: parent.id,
    parentId: root.id,
    rootId: root.id,
    depth: 1,
    createdAt: parent.createdAt,
  });
  h.social.lineage.set(child.id, {
    agentId: child.id,
    parentId: parent.id,
    rootId: root.id,
    depth: 2,
    createdAt: child.createdAt,
  });
  return { root, parent, child };
}

describe('GET /api/social/status', () => {
  it('answers on while the routes are mounted, cached 30 s', async () => {
    const h = createHarness();
    const reply = await h.fetch('GET', '/api/social/status');
    expect(reply.status).toBe(200);
    expect(socialStatusResponseSchema.parse(reply.json)).toEqual({ on: true });
    expect(reply.headers.get('cache-control')).toBe('public, max-age=30');
  });

  it('is the generic 404 while the switch is off', async () => {
    const h = createHarness({ on: false });
    const off = await h.fetch('GET', '/api/social/status');
    const unknown = await h.fetch('GET', '/api/nothing-here');
    expect(off.status).toBe(404);
    expect(off.text).toBe(unknown.text);
    expect([...off.headers]).toEqual([...unknown.headers]);
  });
});

describe('GET /api/social/agents/:id', () => {
  it('answers 404 for a malformed, unknown or hidden agent', async () => {
    const h = createHarness();
    await h.seedAgent(1, { overrides: { hidden: true } });
    for (const id of ['NOT-AN-ID', 'agentzzzzzzz', 'agentaaaaaab']) {
      const reply = await h.fetch('GET', `/api/social/agents/${id}`);
      expect(reply.status).toBe(404);
      expect(errorOf(reply).code).toBe('not_found');
    }
  });

  it('shows the DNA, the lineage and nothing private, cached 30 s', async () => {
    const h = createHarness();
    const { root, parent, child } = await family(h);
    h.social.dna.set(parent.id, dnaOf(parent.id));
    const reply = await h.fetch('GET', `/api/social/agents/${parent.id}`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('public, max-age=30');
    const body = agentSocialResponseSchema.parse(reply.json);
    expect(body.dna?.agentId).toBe(parent.id);
    expect(body.lineage.depth).toBe(1);
    expect(body.lineage.parent).toMatchObject({ id: root.id, house: true, depth: 0 });
    expect(body.lineage.root).toMatchObject({ id: root.id, depth: 0 });
    expect(body.lineage.childCount).toBe(1);
    expect(body.lineage.children.map((c) => c.id)).toEqual([child.id]);
    expect(body.lineage.children[0]?.ownerShort).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect(promptKeys(reply.json)).toEqual([]);
    expect(reply.text).not.toContain(parent.prompt);
    expect(reply.text).not.toContain(parent.owner);
  });

  it('shows a hidden parent and root as not shown, and leaves hidden children out', async () => {
    const h = createHarness();
    const { root, parent, child } = await family(h);
    await h.store.updateAgent(root.id, { hidden: true }, START);
    await h.store.updateAgent(child.id, { hidden: true }, START);
    const reply = await h.fetch('GET', `/api/social/agents/${parent.id}`);
    const body = agentSocialResponseSchema.parse(reply.json);
    expect(body.lineage.parent).toEqual({ shown: false });
    expect(body.lineage.root).toEqual({ shown: false });
    expect(body.lineage.children).toEqual([]);
    expect(reply.text).not.toContain(root.id);
    expect(reply.text).not.toContain(child.id);
  });

  it('a plain agent has depth 0 and no parent or root', async () => {
    const h = createHarness();
    const agent = await h.seedAgent(5);
    const body = agentSocialResponseSchema.parse((await h.fetch('GET', `/api/social/agents/${agent.id}`)).json);
    expect(body).toMatchObject({ agentId: agent.id, dna: null, dnaWindowDays: 40, dnaMinDays: 10, rivalries: [] });
    expect(body.lineage).toEqual({ depth: 0, parent: null, root: null, childCount: 0, children: [] });
  });
});

describe('GET /api/social/agents/:id/fork-source', () => {
  it('sends the prompt only while it is published', async () => {
    const h = createHarness();
    const { root, parent } = await family(h);
    const closed = await h.fetch('GET', `/api/social/agents/${parent.id}/fork-source`);
    const body = forkSourceResponseSchema.parse(closed.json);
    expect(body.parent.prompt).toBeNull();
    expect(body).toMatchObject({ rootId: root.id, forkDepth: 2 });
    expect(closed.text).not.toContain(parent.prompt);
    expect(closed.headers.get('cache-control')).toBe('public, max-age=30');

    await h.store.updateAgent(parent.id, { promptPublic: true }, START);
    const open = forkSourceResponseSchema.parse(
      (await h.fetch('GET', `/api/social/agents/${parent.id}/fork-source`)).json,
    );
    expect(open.parent.prompt).toBe(parent.prompt);
    expect(promptKeys((await h.fetch('GET', `/api/social/agents/${parent.id}/fork-source`)).json)).toEqual([
      'parent.prompt',
    ]);
  });

  it('a root forks at depth 1 and names itself as root; a hidden agent is 404', async () => {
    const h = createHarness();
    const agent = await h.seedAgent(7);
    const body = forkSourceResponseSchema.parse(
      (await h.fetch('GET', `/api/social/agents/${agent.id}/fork-source`)).json,
    );
    expect(body).toMatchObject({ rootId: agent.id, forkDepth: 1, dna: null });
    expect(Object.keys(body.parent).sort()).toEqual(
      ['createdAt', 'division', 'house', 'id', 'name', 'ownerShort', 'prompt', 'summary', 'summaryStatus'].sort(),
    );
    await h.store.updateAgent(agent.id, { hidden: true }, START);
    expect((await h.fetch('GET', `/api/social/agents/${agent.id}/fork-source`)).status).toBe(404);
  });
});

describe('POST /api/social/agents/:id/lineage', () => {
  async function setup(h: Harness, child: { name?: string; createdAt?: string; prompt?: string } = {}) {
    const parent = await h.seedAgent(10, {
      createdAt: EARLIER,
      overrides: { name: 'Steady Momentum', nameKey: agentNameKey('Steady Momentum') },
    });
    const name = child.name ?? 'Quiet Harbor';
    const fork = await h.seedAgent(11, {
      owner: OWNER,
      createdAt: child.createdAt ?? JUST_NOW,
      overrides: { name, nameKey: agentNameKey(name), ...(child.prompt === undefined ? {} : { prompt: child.prompt }) },
    });
    const cookie = await h.signIn(OWNER);
    return { parent, fork, cookie };
  }

  it('links a fresh fork to its parent and answers 201 with the lineage', async () => {
    const h = createHarness();
    const { parent, fork, cookie } = await setup(h);
    const reply = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie,
      body: { parentId: parent.id },
    });
    expect(reply.status).toBe(201);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const body = linkForkResponseSchema.parse(reply.json);
    expect(body.agentId).toBe(fork.id);
    expect(body.lineage).toMatchObject({ depth: 1, parent: { id: parent.id }, root: { id: parent.id } });
    expect(h.social.lineage.get(fork.id)).toMatchObject({ parentId: parent.id, rootId: parent.id, depth: 1 });
    expect(promptKeys(reply.json)).toEqual([]);
  });

  it('takes root and depth from the parent', async () => {
    const h = createHarness();
    const { root, child } = await family(h);
    const fork = await h.seedAgent(20, { owner: OWNER, createdAt: JUST_NOW });
    const cookie = await h.signIn(OWNER);
    const reply = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie,
      body: { parentId: child.id },
    });
    expect(reply.status).toBe(201);
    expect(h.social.lineage.get(fork.id)).toMatchObject({ parentId: child.id, rootId: root.id, depth: 3 });
  });

  it('needs a session, the site and a strict body', async () => {
    const h = createHarness();
    const { parent, fork, cookie } = await setup(h);
    const path = `/api/social/agents/${fork.id}/lineage`;
    expect((await h.fetch('POST', path, { body: { parentId: parent.id } })).status).toBe(401);
    expect(
      (await h.fetch('POST', path, { cookie, origin: 'https://evil.test', body: { parentId: parent.id } })).status,
    ).toBe(403);
    const extra = await h.fetch('POST', path, { cookie, body: { parentId: parent.id, depth: 9 } });
    expect(extra.status).toBe(400);
    expect(errorOf(extra).code).toBe('invalid_input');
  });

  it('answers 404 for a child that is not the wallet’s, hidden, or unknown', async () => {
    const h = createHarness();
    const { parent, fork } = await setup(h);
    const other = await h.signIn(OTHER);
    const reply = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie: other,
      body: { parentId: parent.id },
    });
    expect(reply.status).toBe(404);
    const cookie = await h.signIn(OWNER);
    expect(
      (await h.fetch('POST', '/api/social/agents/agentzzzzzzz/lineage', { cookie, body: { parentId: parent.id } }))
        .status,
    ).toBe(404);
    await h.store.updateAgent(fork.id, { hidden: true }, START);
    expect(
      (await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, { cookie, body: { parentId: parent.id } }))
        .status,
    ).toBe(404);
  });

  it('refuses a child older than the link window with 409 invalid_input on parentId', async () => {
    const h = createHarness();
    const { parent, fork, cookie } = await setup(h, { createdAt: '2026-10-20T11:49:59.000Z' });
    const reply = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie,
      body: { parentId: parent.id },
    });
    expect(reply.status).toBe(409);
    expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field: 'parentId' });
  });

  it('answers 404 for a parent that is unknown, hidden, the child itself or younger', async () => {
    const h = createHarness();
    const { parent, fork, cookie } = await setup(h);
    const younger = await h.seedAgent(12, { createdAt: '2026-10-20T11:59:00.000Z' });
    for (const parentId of ['agentzzzzzzz', fork.id, younger.id]) {
      const reply = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, { cookie, body: { parentId } });
      expect(reply.status, parentId).toBe(404);
    }
    await h.store.updateAgent(parent.id, { hidden: true }, START);
    expect(
      (await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, { cookie, body: { parentId: parent.id } }))
        .status,
    ).toBe(404);
    expect(h.counters.size).toBe(0);
  });

  it('refuses a name that contains the parent’s or the root’s name key', async () => {
    const h = createHarness();
    const { parent, fork, cookie } = await setup(h, { name: 'Steady-Momentum 2' });
    const reply = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie,
      body: { parentId: parent.id },
    });
    expect(reply.status).toBe(409);
    expect(errorOf(reply)).toMatchObject({ code: 'invalid_input', field: 'name' });

    const h2 = createHarness();
    const { root, parent: mid } = await family(h2);
    await h2.store.updateAgent(mid.id, { name: 'Mid Way', nameKey: 'midway' }, START);
    const rootKey = agentNameKey(root.name);
    const name = `My ${root.name} copy`;
    const forkOfMid = await h2.seedAgent(30, {
      owner: OWNER,
      createdAt: JUST_NOW,
      overrides: { name, nameKey: agentNameKey(name) },
    });
    expect(agentNameKey(name)).toContain(rootKey);
    const cookie2 = await h2.signIn(OWNER);
    const refused = await h2.fetch('POST', `/api/social/agents/${forkOfMid.id}/lineage`, {
      cookie: cookie2,
      body: { parentId: mid.id },
    });
    expect(refused.status).toBe(409);
    expect(errorOf(refused).field).toBe('name');
  });

  it('refuses a byte-identical prompt only while the parent’s is published', async () => {
    const h = createHarness();
    const parentPrompt = 'Hold the five largest companies by weight and rebalance once a week.';
    const parent = await h.seedAgent(40, { createdAt: EARLIER, overrides: { prompt: parentPrompt } });
    const fork = await h.seedAgent(41, { owner: OWNER, createdAt: JUST_NOW, overrides: { prompt: parentPrompt } });
    const cookie = await h.signIn(OWNER);
    await h.store.updateAgent(parent.id, { promptPublic: true }, START);
    const refused = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie,
      body: { parentId: parent.id },
    });
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toMatchObject({ code: 'invalid_input', field: 'prompt' });
    expect(refused.text).not.toContain(parentPrompt);
    await h.store.updateAgent(parent.id, { promptPublic: false }, START);
    const linked = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie,
      body: { parentId: parent.id },
    });
    expect(linked.status).toBe(201);
  });

  it('caps links per parent per day and gives the count back when the link already exists', async () => {
    const h = createHarness();
    const { parent, fork, cookie } = await setup(h);
    const key = `d:2026-10-20:fork:${parent.id}`;
    expect(
      (await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, { cookie, body: { parentId: parent.id } }))
        .status,
    ).toBe(201);
    expect(h.counters.get(key)).toBe(1);
    const again = await h.fetch('POST', `/api/social/agents/${fork.id}/lineage`, {
      cookie,
      body: { parentId: parent.id },
    });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('invalid_input');
    expect(h.counters.get(key)).toBe(1);

    h.counters.set(key, FORKS_PER_PARENT_PER_DAY);
    const other = await h.seedAgent(13, { owner: OTHER, createdAt: JUST_NOW });
    const otherCookie = await h.signIn(OTHER);
    const capped = await h.fetch('POST', `/api/social/agents/${other.id}/lineage`, {
      cookie: otherCookie,
      body: { parentId: parent.id },
    });
    expect(capped.status).toBe(429);
    expect(errorOf(capped).code).toBe('rate_limited');
    expect(capped.headers.get('retry-after')).not.toBeNull();
  });
});

describe('GET /api/social/families/:rootId', () => {
  it('lists visible members in pages, and answers a hidden root like an unknown one until it is shown again', async () => {
    const h = createHarness();
    const { root, parent, child } = await family(h);
    const first = await h.fetch('GET', `/api/social/families/${root.id}`);
    expect(first.headers.get('cache-control')).toBe('public, max-age=30');
    const body = familyResponseSchema.parse(first.json);
    expect(body).toMatchObject({ rootId: root.id, page: 1, hasMore: false, memberCount: 2 });
    expect(body.root?.id).toBe(root.id);
    expect(body.members.map((m) => [m.id, m.parentId, m.depth])).toEqual([
      [parent.id, root.id, 1],
      [child.id, parent.id, 2],
    ]);
    expect(promptKeys(first.json)).toEqual([]);

    // Security review 6, finding 6 (contract 6.1): a hidden root is a path that names a hidden agent,
    // so its family is the 404 of an id nobody has, and names none of its members.
    await h.store.updateAgent(root.id, { hidden: true }, START);
    const hidden = await h.fetch('GET', `/api/social/families/${root.id}`);
    const unknown = await h.fetch('GET', '/api/social/families/agentzzzzzzz');
    expect(hidden.status).toBe(404);
    expect(errorOf(hidden).code).toBe('not_found');
    expect(hidden.text).toBe(unknown.text);
    for (const id of [root.id, parent.id, child.id]) expect(hidden.text).not.toContain(id);

    await h.store.updateAgent(root.id, { hidden: false }, START);
    const shown = familyResponseSchema.parse((await h.fetch('GET', `/api/social/families/${root.id}`)).json);
    expect(shown.root?.id).toBe(root.id);
    expect(shown.members.map((m) => [m.id, m.parentId])).toEqual([
      [parent.id, root.id],
      [child.id, parent.id],
    ]);
  });

  it('answers 404 for an unknown or malformed root and 400 for a bad page', async () => {
    const h = createHarness();
    expect((await h.fetch('GET', '/api/social/families/agentzzzzzzz')).status).toBe(404);
    expect((await h.fetch('GET', '/api/social/families/x')).status).toBe(404);
    const agent = await h.seedAgent(1);
    expect((await h.fetch('GET', `/api/social/families/${agent.id}?page=0`)).status).toBe(400);
    expect((await h.fetch('GET', `/api/social/families/${agent.id}?page=2`)).json.members).toEqual([]);
  });
});
