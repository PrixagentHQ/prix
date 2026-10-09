import { creationPeriod, isSocialSafeText } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEASON_1, testAddress } from '../../../support/fixtures.ts';
import { addAgent, counterValue } from '../../support/agents.ts';
import { db, resetDb, storesOn } from '../../support/d1.ts';
import { createSocialHttp } from '../../support/http.ts';

/**
 * Security review 6, finding 7 (docs/contracts/phase-6-social.md sections 5.5 and 6): a paper manager's
 * name passes the word rules of every Phase 6 string, and a name refused for its words gets the answer
 * of a blocked word, 409 `name_not_allowed`, like the words of the abuse list. A name refused for its
 * shape stays 400 `invalid_input`. Nothing is created and nothing is counted.
 */

const plain = storesOn(db);
const NOW = '2026-10-20T12:00:00.000Z';
const WALLET = testAddress(5101);

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

async function world() {
  const http = createSocialHttp(plain, { now: NOW });
  const a = await addAgent(plain, 1, { name: 'Named Agent 1', owner: testAddress(1001) });
  const b = await addAgent(plain, 2, { name: 'Named Agent 2', owner: testAddress(1002) });
  const cookie = await http.signIn(WALLET);
  const create = (name: unknown, extra: Record<string, unknown> = {}) =>
    http.fetch('POST', '/api/social/managers', {
      cookie,
      body: { name, targetsBps: { [a.id]: 3000, [b.id]: 3000 }, schedule: 'weekly', ...extra },
    });
  return { http, create };
}

describe('the name of a paper manager', () => {
  it('answers 409 name_not_allowed for a word Phase 6 never uses', async () => {
    const { create } = await world();
    for (const name of ['Season Mix', 'Best Picks', 'Safest Mix', 'Odds Maker', 'Buy Low Mix', 'Prize Pool']) {
      expect(isSocialSafeText(name), name).toBe(false);
      const reply = await create(name);
      expect(reply.status, `${name}: ${reply.text}`).toBe(409);
      expect(reply.json.error.code, name).toBe('name_not_allowed');
      expect(reply.text, name).not.toContain(name);
    }
    expect((await db.prepare('SELECT count(*) AS n FROM managers').first<{ n: number }>())?.n).toBe(0);
    expect(await counterValue(`p:${creationPeriod('2026-10-20')}:mgr:${WALLET}`)).toBe(0);
  });

  it('answers 409 name_not_allowed for a word only a paper manager may not use', async () => {
    const { create } = await world();
    for (const name of ['Capital Mix', 'Alpha Fund', 'Wealth Club', 'Index ETF', 'Asset Pool']) {
      const reply = await create(name);
      expect(reply.status, `${name}: ${reply.text}`).toBe(409);
      expect(reply.json.error.code, name).toBe('name_not_allowed');
    }
  });

  it('keeps 400 invalid_input for a name refused for its shape, and for a body that is not valid otherwise', async () => {
    const { create } = await world();
    for (const name of ['ab', 'Two  Spaces', 'Prix Staff', 42, '']) {
      const reply = await create(name);
      expect(reply.status, String(name)).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
    }
    // A refused word does not hide another refusal of the body: an unknown key is still 400.
    const extra = await create('Calm Mix', { owner: WALLET });
    expect(extra.status).toBe(400);
  });

  it('still creates a manager under a name that passes every rule', async () => {
    const { create } = await world();
    const reply = await create('Between Value Mix');
    expect(reply.status, reply.text).toBe(201);
  });
});
