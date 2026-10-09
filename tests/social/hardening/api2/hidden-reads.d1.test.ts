import { forkSourceResponseSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEASON_1, testAddress } from '../../../support/fixtures.ts';
import { addAgent, setHidden } from '../../support/agents.ts';
import { db, resetDb, storesOn } from '../../support/d1.ts';
import { ADMIN_ADDRESS, createSocialHttp, SITE_ORIGIN } from '../../support/http.ts';
import { addManager } from '../../support/managers.ts';

/**
 * Contract 6.1, security review 6, findings 5 and 6 (docs/contracts/phase-6-social.md sections 5.2 and 7):
 * fork-source sends `rootId` null while the root is hidden; an admin hide of a paper manager deletes its
 * cached read and pages 1 to 3 of the manager list at this location.
 */

const plain = storesOn(db);
const NOW = '2026-10-20T12:00:00.000Z';
const MARKER = 'from-the-cache';

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('fork-source of an agent whose root is hidden', () => {
  it('sends rootId null while the root is hidden and its id again once it is shown', async () => {
    const http = createSocialHttp(plain, { now: NOW });
    const root = await addAgent(plain, 1, { name: 'Hidden Root', owner: testAddress(4001) });
    const child = await addAgent(plain, 2, { name: 'Visible Child', owner: testAddress(4002) });
    expect(
      await plain.social.putLineage({
        agentId: child.id,
        parentId: root.id,
        rootId: root.id,
        depth: 1,
        createdAt: '2026-10-08T08:00:00.000Z',
      }),
    ).toBe('stored');

    const before = await http.fetch('GET', `/api/social/agents/${child.id}/fork-source`);
    expect(before.status, before.text).toBe(200);
    expect(forkSourceResponseSchema.parse(before.json).rootId).toBe(root.id);

    await setHidden(root.id, true);
    const hidden = await http.fetch('GET', `/api/social/agents/${child.id}/fork-source`);
    expect(hidden.status, hidden.text).toBe(200);
    const body = forkSourceResponseSchema.parse(hidden.json);
    expect(body.rootId).toBeNull();
    expect(body.forkDepth).toBe(2);
    expect(hidden.text).not.toContain(root.id);

    await setHidden(root.id, false);
    const shown = await http.fetch('GET', `/api/social/agents/${child.id}/fork-source`);
    expect(forkSourceResponseSchema.parse(shown.json).rootId).toBe(root.id);
  });

  it('still names an agent with no lineage as its own root', async () => {
    const http = createSocialHttp(plain, { now: NOW });
    const solo = await addAgent(plain, 3, { name: 'Lone Root', owner: testAddress(4003) });
    const reply = await http.fetch('GET', `/api/social/agents/${solo.id}/fork-source`);
    expect(forkSourceResponseSchema.parse(reply.json).rootId).toBe(solo.id);
  });
});

describe('an admin hide of a paper manager', () => {
  const listKeys = [
    `${SITE_ORIGIN}/api/social/managers`,
    `${SITE_ORIGIN}/api/social/managers?page=1`,
    `${SITE_ORIGIN}/api/social/managers?page=2`,
    `${SITE_ORIGIN}/api/social/managers?page=3`,
  ];

  async function plant(keys: string[]): Promise<void> {
    for (const key of keys) {
      await caches.default.put(key, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));
    }
  }
  const cached = (keys: string[]) =>
    Promise.all(keys.map(async (key) => (await caches.default.match(key)) !== undefined));

  async function world() {
    const http = createSocialHttp(plain, { now: NOW });
    const a = await addAgent(plain, 1, { name: 'Held Agent 1', owner: testAddress(4101) });
    const b = await addAgent(plain, 2, { name: 'Held Agent 2', owner: testAddress(4102) });
    const targets = { [a.id]: 3000, [b.id]: 3000 };
    const manager = await addManager(plain, 1, targets);
    const other = await addManager(plain, 2, targets);
    return { http, manager, other };
  }

  it('deletes the cached read of the manager and pages 1 to 3 of the list, and nothing else', async () => {
    const { http, manager, other } = await world();
    const own = `${SITE_ORIGIN}/api/social/managers/${manager.id}`;
    const theirs = `${SITE_ORIGIN}/api/social/managers/${other.id}`;
    const page4 = `${SITE_ORIGIN}/api/social/managers?page=4`;
    await plant([own, theirs, page4, ...listKeys]);

    const reply = await http.fetch('POST', `/api/social/admin/managers/${manager.id}/hidden`, {
      cookie: await http.signIn(ADMIN_ADDRESS),
      body: { hidden: true },
    });
    expect(reply.status, reply.text).toBe(204);
    expect(await cached([own, ...listKeys])).toEqual([false, false, false, false, false]);
    // Another manager's read and a later page keep their 30 seconds.
    expect(await cached([theirs, page4])).toEqual([true, true]);
  });

  it('deletes nothing when the hide is refused', async () => {
    const { http, manager } = await world();
    const own = `${SITE_ORIGIN}/api/social/managers/${manager.id}`;
    await plant([own, ...listKeys]);
    // Not an admin: the generic 404, and the cache is untouched.
    const reply = await http.fetch('POST', `/api/social/admin/managers/${manager.id}/hidden`, {
      cookie: await http.signIn(testAddress(4199)),
      body: { hidden: true },
    });
    expect(reply.status).toBe(404);
    expect(await cached([own, ...listKeys])).toEqual([true, true, true, true, true]);
  });
});
