import { entitlementsOfTier, OWNER_HOLDS_WRITE_ROWS, ownerHoldsSettingSchema } from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, errorOf, HOLDER, OTHER, stepsOf } from './holders-test-support.ts';
import { ownerHoldsFor } from './token/owner-holds.ts';

// Part B of docs/contracts/phase-6-holders.md: the owner's switch and the mark of GET /api/agents/:id.

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));
});
afterEach(() => vi.restoreAllMocks());

const PATH = '/api/token/me/owner-holds';

describe('GET and PUT /api/token/me/owner-holds', () => {
  it('answers 401 without a session', async () => {
    const h = createHarness();
    expect((await h.fetch('GET', PATH)).status).toBe(401);
    expect((await h.fetch('PUT', PATH, { body: { show: true } })).status).toBe(401);
  });

  it('reads the choice, off by default, never cached', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    const reply = await h.fetch('GET', PATH, { cookie });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(ownerHoldsSettingSchema.parse(reply.json)).toEqual({ show: false });
  });

  it('writes the choice once booked, and reads it back', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    h.trace.length = 0;
    const put = await h.fetch('PUT', PATH, { cookie, body: { show: true } });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ show: true });
    expect(stepsOf(h.trace)).toEqual([
      `limiter:write:${HOLDER}`,
      'store.spendWalletWrite',
      `store.spendApiWrites:${OWNER_HOLDS_WRITE_ROWS}`,
      'ownerHolds.set:true:2026-10-18T12:00:00.000Z',
    ]);
    expect((await h.fetch('GET', PATH, { cookie })).json).toEqual({ show: true });
    // Only the signed-in wallet's own row.
    const other = await h.signIn(OTHER);
    expect((await h.fetch('GET', PATH, { cookie: other })).json).toEqual({ show: false });
  });

  it('refuses another site with 403 and a body other than { show } with 400, writing nothing', async () => {
    const h = createHarness();
    const cookie = await h.signIn(HOLDER);
    const foreign = await h.fetch('PUT', PATH, { cookie, body: { show: true }, origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    const wrong = await h.fetch('PUT', PATH, { cookie, body: { show: true, wallet: OTHER } });
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).code).toBe('invalid_input');
    expect(h.ownerHolds.shown.size).toBe(0);
  });

  it('answers the generic 404 on both routes while ApiDeps.ownerHolds is absent', async () => {
    const h = createHarness({ ownerHoldsGiven: false });
    const cookie = await h.signIn(HOLDER);
    for (const method of ['GET', 'PUT'] as const) {
      const reply = await h.fetch(method, PATH, { cookie, body: method === 'PUT' ? { show: true } : undefined });
      expect(reply.status).toBe(404);
      expect(errorOf(reply).message).toBe('There is no such API route. Check the address and the method.');
    }
    // And without a session too: 404, never 401, so the page reads the route as absent.
    expect((await h.fetch('GET', PATH)).status).toBe(404);
  });
});

describe('ownerHoldsFor (the mark of GET /api/agents/:id)', () => {
  function deps(options: { shown?: boolean; tier?: 0 | 1 | 2 | 3; gatingOn?: boolean; fail?: boolean } = {}) {
    const asked: unknown[] = [];
    const reads: string[] = [];
    return {
      asked,
      reads,
      value: {
        ownerHolds: {
          async getShowHolds() {
            reads.push('get');
            if (options.fail === true) throw new Error('D1_ERROR: no such column: show_holds');
            return options.shown ?? true;
          },
          async setShowHolds() {},
        },
        entitlements: {
          async entitlementsFor(address: string | null, read?: { cachedOnly?: boolean }) {
            asked.push({ address, read });
            return { ...entitlementsOfTier(options.tier ?? 2), gatingOn: options.gatingOn ?? true };
          },
        },
      },
    };
  }

  it('is true at a stored tier 2 and 3 with the mark on, asked with cachedOnly', async () => {
    for (const tier of [2, 3] as const) {
      const d = deps({ tier });
      expect(await ownerHoldsFor(d.value, HOLDER, false)).toBe(true);
      expect(d.asked).toEqual([{ address: HOLDER, read: { cachedOnly: true } }]);
    }
  });

  it('is false with the mark off at tier 3, and the entitlements are then not asked', async () => {
    const d = deps({ shown: false, tier: 3 });
    expect(await ownerHoldsFor(d.value, HOLDER, false)).toBe(false);
    expect(d.asked).toEqual([]);
  });

  it('is false at tiers 0 and 1, and while gating is off', async () => {
    expect(await ownerHoldsFor(deps({ tier: 0 }).value, HOLDER, false)).toBe(false);
    expect(await ownerHoldsFor(deps({ tier: 1 }).value, HOLDER, false)).toBe(false);
    expect(await ownerHoldsFor(deps({ tier: 3, gatingOn: false }).value, HOLDER, false)).toBe(false);
  });

  it('is false for a house agent at tier 3, reading nothing', async () => {
    const d = deps({ tier: 3 });
    expect(await ownerHoldsFor(d.value, HOLDER, true)).toBe(false);
    expect(d.reads).toEqual([]);
    expect(d.asked).toEqual([]);
  });

  it('is false with no entitlements dep or no store', async () => {
    const d = deps({ tier: 3 });
    expect(await ownerHoldsFor({ ownerHolds: d.value.ownerHolds }, HOLDER, false)).toBe(false);
    expect(await ownerHoldsFor({ entitlements: d.value.entitlements }, HOLDER, false)).toBe(false);
  });

  it('a store read that fails answers false and logs owner_holds_read_failed once, with no address', async () => {
    const d = deps({ fail: true, tier: 3 });
    expect(await ownerHoldsFor(d.value, HOLDER, false)).toBe(false);
    const lines = logs.filter((line) => line.includes('owner_holds_read_failed'));
    expect(lines).toHaveLength(1);
    expect(logs.join('\n')).not.toMatch(/0x[0-9a-f]{40}/i);
    expect(logs.join('\n')).not.toContain('show_holds');
    expect(d.asked).toEqual([]);
  });
});
