import {
  agentSocialResponseSchema,
  FORK_LINK_WINDOW_SECONDS,
  FORKS_PER_PARENT_PER_DAY,
  familyResponseSchema,
  forkSourceResponseSchema,
  linkForkResponseSchema,
} from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEASON_1, testAddress } from '../support/fixtures.ts';
import { addAgent, counterValue, setHidden, setPromptPublic } from './support/agents.ts';
import { db, meteredDb, resetDb, storesOn } from './support/d1.ts';
import { createSocialHttp, type Reply } from './support/http.ts';

/**
 * Forks (docs/contracts/phase-6-social.md section 5.2): the lineage link and its eleven rules in
 * order, the counter that is given back, and the reads that carry no figure and no prompt.
 */

const plain = storesOn(db);
const NOW = '2026-10-20T12:00:00.000Z';
const FRESH = '2026-10-20T11:55:00.000Z';
const LATER = '2026-10-20T11:58:00.000Z';
const PARENT_PROMPT = 'Hold the five largest companies equally and rebalance once a week. PARENT-PROMPT-MARKER-77.';
const OWNER_PARENT = testAddress(2001);
const OWNER_CHILD = testAddress(2002);
const DAY_KEY = (parentId: string) => `d:2026-10-20:fork:${parentId}`;

async function world(options: { houseOwners?: string[] } = {}) {
  const http = createSocialHttp(plain, { now: NOW, houseOwners: options.houseOwners });
  const parent = await addAgent(plain, 1, {
    name: 'Quiet Value',
    owner: OWNER_PARENT,
    prompt: PARENT_PROMPT,
    createdAt: '2026-10-05T08:00:00.000Z',
  });
  const child = await addAgent(plain, 2, { name: 'Fresh Take', owner: OWNER_CHILD, createdAt: FRESH });
  const cookie = await http.signIn(OWNER_CHILD);
  return { http, parent, child, cookie };
}

const link = (
  http: ReturnType<typeof createSocialHttp>,
  childId: string,
  parentId: unknown,
  cookie?: string,
): Promise<Reply> => http.fetch('POST', `/api/social/agents/${childId}/lineage`, { body: { parentId }, cookie });

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('the link, rule by rule', () => {
  it('links a fresh fork to its parent: 201, no cache, the lineage of the child', async () => {
    const { http, parent, child, cookie } = await world();
    const reply = await link(http, child.id, parent.id, cookie);
    expect(reply.status, reply.text).toBe(201);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    const body = linkForkResponseSchema.parse(reply.json);
    expect(body.agentId).toBe(child.id);
    expect(body.lineage).toMatchObject({ depth: 1, childCount: 0, children: [] });
    expect(body.lineage.parent).toMatchObject({ id: parent.id, name: 'Quiet Value', house: false });
    expect(body.lineage.root).toMatchObject({ id: parent.id });
    // The parent now lists the child.
    const page = agentSocialResponseSchema.parse((await http.fetch('GET', `/api/social/agents/${parent.id}`)).json);
    expect(page.lineage).toMatchObject({ depth: 0, parent: null, root: null, childCount: 1 });
    expect(page.lineage.children.map((c) => c.id)).toEqual([child.id]);
  });

  it('1: needs a signed-in wallet, and a request from the site', async () => {
    const { http, parent, child, cookie } = await world();
    expect((await link(http, child.id, parent.id)).json.error.code).toBe('unauthorized');
    const foreign = await http.fetch('POST', `/api/social/agents/${child.id}/lineage`, {
      body: { parentId: parent.id },
      cookie,
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
    expect(await db.prepare('SELECT count(*) AS n FROM agent_lineage').first()).toEqual({ n: 0 });
  });

  it('2: reads a strict body: no extra key, no missing or malformed parent', async () => {
    const { http, parent, child, cookie } = await world();
    for (const body of [
      {},
      { parentId: parent.id, extra: 1 },
      { parentId: parent.id, rootId: parent.id, depth: 1 },
      { parentId: parent.id, createdAt: '2020-01-01T00:00:00.000Z' },
      { parentId: 'short' },
      { parentId: 7 },
      { parent: parent.id },
    ]) {
      const reply = await http.fetch('POST', `/api/social/agents/${child.id}/lineage`, { body, cookie });
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
    }
    const broken = await http.fetch('POST', `/api/social/agents/${child.id}/lineage`, {
      rawBody: '{"parentId"',
      cookie,
    });
    expect(broken.status).toBe(400);
  });

  it('3: knows the child only if it exists, is visible and is the wallet’s own: otherwise 404', async () => {
    const { http, parent, child, cookie } = await world();
    const stranger = await addAgent(plain, 3, { name: 'Other Take', owner: testAddress(2003), createdAt: FRESH });
    const hidden = await addAgent(plain, 4, {
      name: 'Hidden Take',
      owner: OWNER_CHILD,
      createdAt: FRESH,
      hidden: true,
    });
    for (const id of [stranger.id, hidden.id, 'aaaaaaaaaaaz', 'not-an-id']) {
      const reply = await link(http, id, parent.id, cookie);
      expect(reply.status, id).toBe(404);
      expect(reply.json.error.code).toBe('not_found');
    }
    expect(child.id).not.toBe(stranger.id);
  });

  it('4: links only in the first 600 seconds after the fork was created, else 409 invalid_input on parentId', async () => {
    const { http, parent, child, cookie } = await world();
    expect(FORK_LINK_WINDOW_SECONDS).toBe(600);
    http.setNow('2026-10-20T12:05:00.000Z'); // 600 s after 11:55:00 exactly: still inside
    const inside = await link(http, child.id, parent.id, cookie);
    expect(inside.status, inside.text).toBe(201);

    const late = await addAgent(plain, 5, { name: 'Late Take', owner: testAddress(2005), createdAt: FRESH });
    const lateCookie = await http.signIn(late.owner);
    http.setNow('2026-10-20T12:05:01.000Z');
    const outside = await link(http, late.id, parent.id, lateCookie);
    expect(outside.status).toBe(409);
    expect(outside.json.error).toMatchObject({ code: 'invalid_input', field: 'parentId' });
    expect(outside.headers.get('Cache-Control')).toBe('no-store');
    expect(await db.prepare('SELECT count(*) AS n FROM agent_lineage').first()).toEqual({ n: 1 });
  });

  it('5: needs a parent that exists, is visible, is not the child and is older than the child: otherwise 404', async () => {
    const { http, parent, child, cookie } = await world();
    const hidden = await addAgent(plain, 6, {
      name: 'Hidden Parent',
      owner: testAddress(2006),
      createdAt: '2026-10-05T09:00:00.000Z',
      hidden: true,
    });
    const younger = await addAgent(plain, 7, {
      name: 'Younger One',
      owner: testAddress(2007),
      createdAt: '2026-10-20T11:59:00.000Z',
    });
    const same = await addAgent(plain, 8, { name: 'Same Time', owner: testAddress(2008), createdAt: FRESH });
    for (const id of ['aaaaaaaaaaaz', hidden.id, child.id, younger.id, same.id]) {
      const reply = await link(http, child.id, id, cookie);
      expect(reply.status, id).toBe(404);
      expect(reply.json.error.code).toBe('not_found');
    }
    expect((await link(http, child.id, parent.id, cookie)).status).toBe(201);
  });

  it('6: refuses a fork whose name contains the name key of its parent, else 409 on name', async () => {
    const { http, parent } = await world();
    const copycat = await addAgent(plain, 9, { name: 'Quiet Value Two', owner: testAddress(2009), createdAt: FRESH });
    const cookie = await http.signIn(copycat.owner);
    const reply = await link(http, copycat.id, parent.id, cookie);
    expect(reply.status).toBe(409);
    expect(reply.json.error).toMatchObject({ code: 'invalid_input', field: 'name' });
    // The key is compared as letters and digits: other spacing and case do not help.
    const sneaky = await addAgent(plain, 10, { name: 'QUIET.VALUE x', owner: testAddress(2010), createdAt: FRESH });
    expect((await link(http, sneaky.id, parent.id, await http.signIn(sneaky.owner))).json.error.field).toBe('name');
    expect(await db.prepare('SELECT count(*) AS n FROM agent_lineage').first()).toEqual({ n: 0 });
  });

  it('6: also guards the name of the root of the family, and a key shorter than four characters guards nothing', async () => {
    const { http, parent, child, cookie } = await world();
    expect((await link(http, child.id, parent.id, cookie)).status).toBe(201);
    // A grandchild of "Quiet Value" through "Fresh Take" must not carry either name.
    const g1 = await addAgent(plain, 11, { name: 'Quiet Value Again', owner: testAddress(2011), createdAt: LATER });
    const r1 = await link(http, g1.id, child.id, await http.signIn(g1.owner));
    expect(r1.json.error).toMatchObject({ field: 'name' });
    const g2 = await addAgent(plain, 12, { name: 'Fresh Take Again', owner: testAddress(2012), createdAt: LATER });
    expect((await link(http, g2.id, child.id, await http.signIn(g2.owner))).json.error).toMatchObject({
      field: 'name',
    });
    const g3 = await addAgent(plain, 13, { name: 'Plain Third', owner: testAddress(2013), createdAt: LATER });
    const ok = await link(http, g3.id, child.id, await http.signIn(g3.owner));
    expect(ok.status, ok.text).toBe(201);

    // A parent whose name key has three characters guards nothing.
    const zed = await addAgent(plain, 14, {
      name: 'Zed',
      owner: testAddress(2014),
      createdAt: '2026-10-05T10:00:00.000Z',
    });
    const z = await addAgent(plain, 15, { name: 'Zed Clone', owner: testAddress(2015), createdAt: FRESH });
    expect((await link(http, z.id, zed.id, await http.signIn(z.owner))).status).toBe(201);
    // Four characters guard.
    const abcd = await addAgent(plain, 16, {
      name: 'Abcd',
      owner: testAddress(2016),
      createdAt: '2026-10-05T10:00:00.000Z',
    });
    const y = await addAgent(plain, 17, { name: 'Abcd Clone', owner: testAddress(2017), createdAt: FRESH });
    expect((await link(http, y.id, abcd.id, await http.signIn(y.owner))).json.error.field).toBe('name');
  });

  it('7: refuses the published prompt copied as it is, else 409 on prompt, and asks nothing of a private prompt', async () => {
    const { http, parent } = await world();
    await setPromptPublic(parent.id, true);
    const same = await addAgent(plain, 18, {
      name: 'Exact Copy',
      owner: testAddress(2018),
      createdAt: FRESH,
      prompt: PARENT_PROMPT,
    });
    const refused = await link(http, same.id, parent.id, await http.signIn(same.owner));
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: 'invalid_input', field: 'prompt' });
    const changed = await addAgent(plain, 19, { name: 'Own Words', owner: testAddress(2019), createdAt: FRESH });
    expect((await link(http, changed.id, parent.id, await http.signIn(changed.owner))).status).toBe(201);

    // A private prompt: an identical one links without a word, so the route is no oracle for it.
    await setPromptPublic(parent.id, false);
    const secret = await addAgent(plain, 20, {
      name: 'Lucky Guess',
      owner: testAddress(2020),
      createdAt: FRESH,
      prompt: PARENT_PROMPT,
    });
    const linked = await link(http, secret.id, parent.id, await http.signIn(secret.owner));
    expect(linked.status, linked.text).toBe(201);
    expect(linked.text).not.toContain('PARENT-PROMPT-MARKER');
  });

  it('8: counts links per parent per day, 20 a day, and answers 429 with Retry-After on the 21st', async () => {
    const { http, parent } = await world();
    expect(FORKS_PER_PARENT_PER_DAY).toBe(20);
    for (let k = 0; k < FORKS_PER_PARENT_PER_DAY; k++) {
      const fork = await addAgent(plain, 100 + k, {
        name: `Spin Off ${k}`,
        owner: testAddress(3000 + k),
        createdAt: FRESH,
      });
      const reply = await link(http, fork.id, parent.id, await http.signIn(fork.owner));
      expect(reply.status, `link ${k}: ${reply.text}`).toBe(201);
    }
    expect(await counterValue(DAY_KEY(parent.id))).toBe(20);
    const extra = await addAgent(plain, 200, { name: 'One Too Many', owner: testAddress(3100), createdAt: FRESH });
    const reply = await link(http, extra.id, parent.id, await http.signIn(extra.owner));
    expect(reply.status).toBe(429);
    expect(reply.json.error).toMatchObject({ code: 'rate_limited', field: 'parentId' });
    expect(Number(reply.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await counterValue(DAY_KEY(parent.id))).toBe(20);
    // Another parent has its own count.
    const other = await addAgent(plain, 201, {
      name: 'Other Parent',
      owner: testAddress(3101),
      createdAt: '2026-10-05T09:00:00.000Z',
    });
    expect((await link(http, extra.id, other.id, await http.signIn(extra.owner))).status).toBe(201);
    // And tomorrow the parent can be forked again.
    http.setNow('2026-10-21T00:10:00.000Z');
    const next = await addAgent(plain, 202, {
      name: 'Next Day',
      owner: testAddress(3102),
      createdAt: '2026-10-21T00:05:00.000Z',
    });
    expect((await link(http, next.id, parent.id, await http.signIn(next.owner))).status).toBe(201);
  });

  it('9: a link that already exists is refused and the count it took is given back', async () => {
    const { http, parent, child, cookie } = await world();
    expect((await link(http, child.id, parent.id, cookie)).status).toBe(201);
    expect(await counterValue(DAY_KEY(parent.id))).toBe(1);
    const other = await addAgent(plain, 21, {
      name: 'Another Parent',
      owner: testAddress(2021),
      createdAt: '2026-10-06T08:00:00.000Z',
    });
    const again = await link(http, child.id, other.id, cookie);
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: 'invalid_input', field: 'parentId' });
    // The second try took a count on the other parent and gave it back; the first parent is untouched.
    expect(await counterValue(DAY_KEY(other.id))).toBe(0);
    expect(await counterValue(DAY_KEY(parent.id))).toBe(1);
    // A link cannot be changed: the child still has its first parent.
    const page = agentSocialResponseSchema.parse((await http.fetch('GET', `/api/social/agents/${child.id}`)).json);
    expect(page.lineage.parent).toMatchObject({ id: parent.id });
  });

  it('gives the count back when the store fails after it was taken', async () => {
    const metered = meteredDb(db);
    const http = createSocialHttp(storesOn(metered.db), { now: NOW });
    const parent = await addAgent(plain, 1, {
      name: 'Quiet Value',
      owner: OWNER_PARENT,
      createdAt: '2026-10-05T08:00:00.000Z',
    });
    const first = await addAgent(plain, 2, { name: 'Fresh Take', owner: OWNER_CHILD, createdAt: FRESH });
    const second = await addAgent(plain, 3, { name: 'Second Take', owner: testAddress(2003), createdAt: FRESH });
    const cookie = await http.signIn(OWNER_CHILD);
    const cookie2 = await http.signIn(testAddress(2003));
    // A successful link first, to learn which statement stores the lineage.
    metered.reset();
    expect((await link(http, first.id, parent.id, cookie)).status).toBe(201);
    const index = metered.meter.log.findIndex((sql) => /insert into agent_lineage/i.test(sql));
    expect(index).toBeGreaterThan(0);
    expect(await counterValue(DAY_KEY(parent.id))).toBe(1);
    // The same steps for the second fork, with the database failing once, at the lineage insert.
    metered.reset();
    metered.failAfter(index, new Error('database exploded: secret-token-2468'), true);
    const failed = await link(http, second.id, parent.id, cookie2);
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain('secret-token-2468');
    expect(await counterValue(DAY_KEY(parent.id))).toBe(1);
    expect(await db.prepare('SELECT count(*) AS n FROM agent_lineage').first()).toEqual({ n: 1 });
    // And the link can be made again.
    expect((await link(http, second.id, parent.id, cookie2)).status).toBe(201);
    expect(await counterValue(DAY_KEY(parent.id))).toBe(2);
  });
});

describe('depth, root, families', () => {
  it('computes the root and the depth on the server, from the parent, and lists the family in creation order', async () => {
    const { http, parent, child, cookie } = await world();
    expect((await link(http, child.id, parent.id, cookie)).status).toBe(201);
    const grand = await addAgent(plain, 30, { name: 'Third Gen', owner: testAddress(2030), createdAt: LATER });
    const reply = await link(http, grand.id, child.id, await http.signIn(grand.owner));
    expect(reply.status).toBe(201);
    const lineage = linkForkResponseSchema.parse(reply.json).lineage;
    expect(lineage.depth).toBe(2);
    expect(lineage.parent).toMatchObject({ id: child.id, depth: 1 });
    expect(lineage.root).toMatchObject({ id: parent.id, depth: 0 });

    const family = familyResponseSchema.parse((await http.fetch('GET', `/api/social/families/${parent.id}`)).json);
    expect(family.rootId).toBe(parent.id);
    expect(family.root).toMatchObject({ id: parent.id, depth: 0 });
    expect(family.members.map((m) => [m.id, m.parentId, m.depth])).toEqual([
      [child.id, parent.id, 1],
      [grand.id, child.id, 2],
    ]);
    expect(family.memberCount).toBe(2);
    expect(family.hasMore).toBe(false);
    // The fork source of the grandchild's parent says what the next fork would be.
    const source = forkSourceResponseSchema.parse(
      (await http.fetch('GET', `/api/social/agents/${grand.id}/fork-source`)).json,
    );
    expect(source).toMatchObject({ rootId: parent.id, forkDepth: 3 });
  });

  it('a house agent can be forked, and the fork is not a house agent', async () => {
    const { http, parent, child, cookie } = await world({
      houseOwners: [OWNER_PARENT.toUpperCase().replace('0X', '0x')],
    });
    const reply = await link(http, child.id, parent.id, cookie);
    expect(reply.status).toBe(201);
    expect(reply.json.lineage.parent.house).toBe(true);
    const page = await http.fetch('GET', `/api/social/agents/${parent.id}`);
    expect(page.json.lineage.children[0]).toMatchObject({ id: child.id, house: false });
  });

  it('shows a hidden parent and a hidden root as not shown, without an id or a name, and unhiding restores them', async () => {
    const { http, parent, child, cookie } = await world();
    await link(http, child.id, parent.id, cookie);
    const grand = await addAgent(plain, 31, { name: 'Deep Fork', owner: testAddress(2031), createdAt: LATER });
    await link(http, grand.id, child.id, await http.signIn(grand.owner));

    await setHidden(parent.id, true);
    let page = await http.fetch('GET', `/api/social/agents/${grand.id}`);
    expect(page.json.lineage.root).toEqual({ shown: false });
    expect(page.json.lineage.parent).toMatchObject({ id: child.id });
    expect(page.text).not.toContain(parent.id);
    expect(page.text).not.toContain('Quiet Value');
    // The hidden agent is unknown, its source too, and so is its family: a hidden root is a path that
    // names a hidden agent, the 404 of an id nobody has (contract 6.1, security review 6, finding 6).
    expect((await http.fetch('GET', `/api/social/agents/${parent.id}`)).status).toBe(404);
    expect((await http.fetch('GET', `/api/social/agents/${parent.id}/fork-source`)).status).toBe(404);
    const family = await http.fetch('GET', `/api/social/families/${parent.id}`);
    const nobody = await http.fetch('GET', '/api/social/families/aaaaaaaaaaaz');
    expect(family.status).toBe(404);
    expect(family.text).toBe(nobody.text);
    for (const secret of [parent.id, child.id, grand.id, 'Quiet Value']) expect(family.text).not.toContain(secret);

    await setHidden(parent.id, false);
    await setHidden(child.id, true);
    page = await http.fetch('GET', `/api/social/agents/${grand.id}`);
    expect(page.json.lineage.parent).toEqual({ shown: false });
    expect(page.json.lineage.root).toMatchObject({ id: parent.id });
    // A hidden member is left out of every list.
    const members = (await http.fetch('GET', `/api/social/families/${parent.id}`)).json.members;
    expect(members.map((m: { id: string }) => m.id)).toEqual([grand.id]);
    expect((await http.fetch('GET', `/api/social/agents/${parent.id}`)).json.lineage.children).toEqual([]);

    await setHidden(child.id, false);
    page = await http.fetch('GET', `/api/social/agents/${grand.id}`);
    expect(page.json.lineage.parent).toMatchObject({ id: child.id });
    expect((await http.fetch('GET', `/api/social/agents/${parent.id}`)).json.lineage.children).toHaveLength(1);
  });

  it('answers an unknown family with 404 and pages a long family', async () => {
    const { http, parent } = await world();
    expect((await http.fetch('GET', '/api/social/families/aaaaaaaaaaaz')).status).toBe(404);
    expect((await http.fetch('GET', '/api/social/families/nope')).status).toBe(404);
    // 26 members, written straight to the store: the daily count of a parent would stop 26 links.
    for (let k = 0; k < 26; k++) {
      const fork = await addAgent(plain, 400 + k, {
        name: `Bulk Fork ${k}`,
        owner: testAddress(4000 + k),
        createdAt: `2026-10-10T10:${String(k).padStart(2, '0')}:00.000Z`,
      });
      await plain.social.putLineage({
        agentId: fork.id,
        parentId: parent.id,
        rootId: parent.id,
        depth: 1,
        createdAt: `2026-10-10T10:${String(k).padStart(2, '0')}:30.000Z`,
      });
    }
    const first = familyResponseSchema.parse((await http.fetch('GET', `/api/social/families/${parent.id}`)).json);
    expect(first).toMatchObject({ page: 1, hasMore: true, memberCount: 26 });
    expect(first.members).toHaveLength(24);
    const second = familyResponseSchema.parse(
      (await http.fetch('GET', `/api/social/families/${parent.id}?page=2`)).json,
    );
    expect(second).toMatchObject({ page: 2, hasMore: false });
    expect(second.members).toHaveLength(2);
    // Pages never repeat a member.
    const ids = [...first.members, ...second.members].map((m) => m.id);
    expect(new Set(ids).size).toBe(26);
    // A page query is strict.
    for (const query of ['?page=0', '?page=101', '?page=x', '?page=1&extra=1']) {
      expect((await http.fetch('GET', `/api/social/families/${parent.id}${query}`)).status, query).toBe(400);
    }
  });
});

describe('the fork source and the agent read', () => {
  it('carries a public prompt only while the owner publishes it, and never a figure, a rank or an equity', async () => {
    const { http, parent } = await world();
    const hidden = await http.fetch('GET', `/api/social/agents/${parent.id}/fork-source`);
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get('Cache-Control')).toBe('public, max-age=30');
    const privateBody = forkSourceResponseSchema.parse(hidden.json);
    expect(privateBody.parent.prompt).toBeNull();
    expect(hidden.text).not.toContain('PARENT-PROMPT-MARKER');

    await setPromptPublic(parent.id, true);
    const published = forkSourceResponseSchema.parse(
      (await http.fetch('GET', `/api/social/agents/${parent.id}/fork-source`)).json,
    );
    expect(published.parent.prompt).toBe(PARENT_PROMPT);
    expect(Object.keys(published.parent).sort()).toEqual(
      ['createdAt', 'division', 'house', 'id', 'name', 'ownerShort', 'prompt', 'summary', 'summaryStatus'].sort(),
    );
    expect(published).toMatchObject({ rootId: parent.id, forkDepth: 1, dna: null });

    await setPromptPublic(parent.id, false);
    const again = forkSourceResponseSchema.parse(
      (await http.fetch('GET', `/api/social/agents/${parent.id}/fork-source`)).json,
    );
    expect(again.parent.prompt).toBeNull();
  });

  it('answers a malformed, unknown or hidden agent with 404 on every read that names one', async () => {
    const { http } = await world();
    const hidden = await addAgent(plain, 40, {
      name: 'Gone Away',
      owner: testAddress(2040),
      createdAt: '2026-10-05T10:00:00.000Z',
      hidden: true,
    });
    for (const id of ['nope', 'aaaaaaaaaaaz', hidden.id]) {
      expect((await http.fetch('GET', `/api/social/agents/${id}`)).status, id).toBe(404);
      expect((await http.fetch('GET', `/api/social/agents/${id}/fork-source`)).status, id).toBe(404);
    }
  });
});
