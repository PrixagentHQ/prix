import { ownerHoldsSettingSchema } from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnerHoldsStore } from '../../apps/api/src/store/owner-holds.ts';
import { addAgent } from '../social/support/agents.ts';
import { db, resetDb, storesOn } from '../social/support/d1.ts';
import { SEASON_1 } from '../support/fixtures.ts';
import { createPollHarness, HOUSE, wallet } from './support.ts';

/**
 * Part B, "Owner holds $PRIX" (docs/contracts/phase-6-holders.md sections 3 and 11 B): GET /api/agents/:id and
 * GET/PUT /api/token/me/owner-holds behind `createApp`, on the real owner-holds store on a local D1.
 */

const OWNER = wallet(0xd1);
const ME = '/api/token/me/owner-holds';

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function agentOf(owner: string, n = 1) {
  return addAgent(storesOn(db, [HOUSE]), n, { owner });
}

describe('the mark on the agent read', () => {
  it('is true at a stored tier 2 and 3 with the mark on, asked with cachedOnly only', async () => {
    const store = createOwnerHoldsStore(db);
    const h = createPollHarness({ ownerHolds: store });
    const agent = await agentOf(OWNER);
    await store.setShowHolds(OWNER, true, '2026-10-17T00:00:00.000Z');
    for (const tier of [2, 3] as const) {
      h.tiers.set(OWNER, tier);
      const reply = await h.fetch('GET', `/api/agents/${agent.id}?t=${tier}`);
      expect(reply.status, reply.text).toBe(200);
      expect((reply.json as { ownerHolds?: boolean }).ownerHolds, `tier ${tier}`).toBe(true);
    }
    expect(h.tierReads.filter((read) => read.address === OWNER).length).toBeGreaterThan(0);
    expect(h.tierReads.filter((read) => read.address === OWNER).every((read) => read.cachedOnly)).toBe(true);
  });

  it('is false at tiers 0 and 1, with gating off, and with the mark off at tier 3 without asking the tier', async () => {
    const store = createOwnerHoldsStore(db);
    const h = createPollHarness({ ownerHolds: store });
    const agent = await agentOf(OWNER);
    await store.setShowHolds(OWNER, true, '2026-10-17T00:00:00.000Z');
    for (const tier of [0, 1] as const) {
      h.tiers.set(OWNER, tier);
      expect(
        ((await h.fetch('GET', `/api/agents/${agent.id}?t=${tier}`)).json as { ownerHolds?: boolean }).ownerHolds,
      ).toBe(false);
    }
    h.tiers.set(OWNER, 3);
    h.gate.on = false;
    expect(((await h.fetch('GET', `/api/agents/${agent.id}?g=off`)).json as { ownerHolds?: boolean }).ownerHolds).toBe(
      false,
    );
    h.gate.on = true;
    await store.setShowHolds(OWNER, false, '2026-10-17T00:00:00.000Z');
    const reads = h.tierReads.filter((read) => read.address === OWNER).length;
    expect(((await h.fetch('GET', `/api/agents/${agent.id}?m=off`)).json as { ownerHolds?: boolean }).ownerHolds).toBe(
      false,
    );
    expect(h.tierReads.filter((read) => read.address === OWNER).length).toBe(reads);
  });

  it('is false for a house agent at tier 3 with the mark on, and the tier is not asked', async () => {
    const store = createOwnerHoldsStore(db);
    const h = createPollHarness({ ownerHolds: store });
    const agent = await agentOf(HOUSE, 2);
    await store.setShowHolds(HOUSE, true, '2026-10-17T00:00:00.000Z');
    h.tiers.set(HOUSE, 3);
    const reply = await h.fetch('GET', `/api/agents/${agent.id}`);
    expect((reply.json as { ownerHolds?: boolean }).ownerHolds).toBe(false);
    expect(h.tierReads.filter((read) => read.address === HOUSE)).toEqual([]);
  });

  it('answers 200 with false and logs owner_holds_read_failed once, with no address, on a D1 without users.show_holds', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createOwnerHoldsStore(db);
    const h = createPollHarness({ ownerHolds: store });
    const agent = await agentOf(OWNER);
    h.tiers.set(OWNER, 3);
    await db.prepare('ALTER TABLE users DROP COLUMN show_holds').run();
    const reply = await h.fetch('GET', `/api/agents/${agent.id}`);
    expect(reply.status, reply.text).toBe(200);
    expect((reply.json as { ownerHolds?: boolean }).ownerHolds).toBe(false);
    const lines = errors.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((line) => line.includes('owner_holds_read_failed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/0x[0-9a-f]{40}/i);
  });
});

describe('GET and PUT /api/token/me/owner-holds', () => {
  it('refuses without a session and from another site, refuses another body, and reads the choice back', async () => {
    const h = createPollHarness({ ownerHolds: createOwnerHoldsStore(db) });
    expect((await h.fetch('GET', ME)).status).toBe(401);
    expect((await h.fetch('PUT', ME, { body: { show: true } })).status).toBe(401);
    const cookie = await h.signIn(OWNER);
    expect(ownerHoldsSettingSchema.parse((await h.fetch('GET', ME, { cookie })).json)).toEqual({ show: false });
    expect((await h.fetch('PUT', ME, { cookie, origin: 'https://evil.test', body: { show: true } })).status).toBe(403);
    for (const body of [{ show: 'yes' }, { show: true, extra: 1 }, {}]) {
      expect((await h.fetch('PUT', ME, { cookie, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect(ownerHoldsSettingSchema.parse((await h.fetch('GET', ME, { cookie })).json)).toEqual({ show: false });
    const writes = h.limiter.asks('write');
    const put = await h.fetch('PUT', ME, { cookie, body: { show: true } });
    expect(put.status, put.text).toBe(200);
    expect(ownerHoldsSettingSchema.parse(put.json)).toEqual({ show: true });
    expect(h.limiter.asks('write') - writes).toBe(1);
    expect(ownerHoldsSettingSchema.parse((await h.fetch('GET', ME, { cookie })).json)).toEqual({ show: true });
  });

  it('are the generic 404 while ApiDeps.ownerHolds is absent, and the agent read sends false', async () => {
    const h = createPollHarness({ tokenRoutes: true });
    const cookie = await h.signIn(OWNER);
    expect((await h.fetch('GET', ME, { cookie })).status).toBe(404);
    expect((await h.fetch('PUT', ME, { cookie, body: { show: true } })).status).toBe(404);
    const agent = await agentOf(OWNER);
    h.tiers.set(OWNER, 3);
    const reply = await h.fetch('GET', `/api/agents/${agent.id}`);
    expect(reply.status).toBe(200);
    expect((reply.json as { ownerHolds?: boolean }).ownerHolds ?? false).toBe(false);
  });
});
