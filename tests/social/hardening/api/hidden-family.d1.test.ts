import { familyResponseSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEASON_1, testAddress } from '../../../support/fixtures.ts';
import { addAgent, setHidden } from '../../support/agents.ts';
import { db, resetDb, storesOn } from '../../support/d1.ts';
import { createSocialHttp } from '../../support/http.ts';

/**
 * Security review 6, finding 6 (docs/contracts/phase-6-social.md section 5.2): a path that names a
 * hidden agent answers 404, and the family of a hidden root is such a path. Its answer is byte for
 * byte the answer to an id nobody has. A family read never names a hidden agent, as a parent either.
 */

const plain = storesOn(db);
const NOW = '2026-10-20T12:00:00.000Z';

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

/** A root, its child and its grandchild, linked straight in the store. */
async function family() {
  const http = createSocialHttp(plain, { now: NOW });
  const root = await addAgent(plain, 1, { name: 'Root Of Kin', owner: testAddress(3001) });
  const child = await addAgent(plain, 2, {
    name: 'Middle Kin',
    owner: testAddress(3002),
    createdAt: '2026-10-06T08:00:00.000Z',
  });
  const grand = await addAgent(plain, 3, {
    name: 'Young Kin',
    owner: testAddress(3003),
    createdAt: '2026-10-07T08:00:00.000Z',
  });
  const at = '2026-10-08T08:00:00.000Z';
  expect(
    await plain.social.putLineage({ agentId: child.id, parentId: root.id, rootId: root.id, depth: 1, createdAt: at }),
  ).toBe('stored');
  expect(
    await plain.social.putLineage({ agentId: grand.id, parentId: child.id, rootId: root.id, depth: 2, createdAt: at }),
  ).toBe('stored');
  return { http, root, child, grand };
}

describe('the family of a hidden agent', () => {
  it('answers 404 for a hidden root, byte for byte the answer to an unknown id', async () => {
    const { http, root, child, grand } = await family();
    const before = await http.fetch('GET', `/api/social/families/${root.id}`);
    expect(before.status).toBe(200);
    expect(familyResponseSchema.parse(before.json).members.map((m) => m.id)).toEqual([child.id, grand.id]);

    await setHidden(root.id, true);
    const hidden = await http.fetch('GET', `/api/social/families/${root.id}`);
    const unknown = await http.fetch('GET', '/api/social/families/aaaaaaaaaaaz');
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(hidden.text).toBe(unknown.text);
    expect(hidden.headers.get('Cache-Control')).toBe(unknown.headers.get('Cache-Control'));
    expect(hidden.headers.get('Content-Type')).toBe(unknown.headers.get('Content-Type'));
    for (const secret of [root.id, 'Root Of Kin', child.id, grand.id]) expect(hidden.text).not.toContain(secret);

    // A later page is the same 404.
    const paged = await http.fetch('GET', `/api/social/families/${root.id}?page=2`);
    expect(paged.status).toBe(404);
    expect(paged.text).toBe(unknown.text);

    // Unhiding restores the family.
    await setHidden(root.id, false);
    expect((await http.fetch('GET', `/api/social/families/${root.id}`)).status).toBe(200);
  });

  it('never names a hidden parent of a member: its parentId is null', async () => {
    const { http, root, child, grand } = await family();
    await setHidden(child.id, true);
    const reply = await http.fetch('GET', `/api/social/families/${root.id}`);
    expect(reply.status).toBe(200);
    const body = familyResponseSchema.parse(reply.json);
    expect(body.members.map((m) => m.id)).toEqual([grand.id]);
    expect(body.members[0]?.parentId).toBeNull();
    expect(reply.text).not.toContain(child.id);
    expect(reply.text).not.toContain('Middle Kin');

    await setHidden(child.id, false);
    const shown = familyResponseSchema.parse((await http.fetch('GET', `/api/social/families/${root.id}`)).json);
    expect(shown.members.find((m) => m.id === grand.id)?.parentId).toBe(child.id);
    expect(shown.members.find((m) => m.id === child.id)?.parentId).toBe(root.id);
  });
});
