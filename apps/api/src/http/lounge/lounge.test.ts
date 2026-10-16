import { entitlementsOfTier, loungeResponseSchema } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { INVITE, loungeHarness, USER, WALLET } from '../follow/test-support-lounge.ts';

/**
 * GET /api/lounge (docs/contracts/phase-6-holders-2.md section 4.5): mounted only while the lounge is given,
 * a session, the three states by the session's own tier and link, the invite link only in `open`, never cached.
 */

describe('GET /api/lounge', () => {
  it('is the generic 404 while the lounge is absent from the deps', async () => {
    const h = loungeHarness({ lounge: false });
    const reply = await h.get('/api/lounge', await h.signIn(WALLET));
    expect(reply.status).toBe(404);
    expect(h.trace).toEqual([]);
  });

  it('is 401 without a session, before anything is read', async () => {
    const h = loungeHarness();
    expect((await h.get('/api/lounge')).status).toBe(401);
    expect((await h.get('/api/lounge', 'not-a-session')).status).toBe(401);
    expect(h.trace).toEqual([]);
  });

  it('answers not_holder below tier 1 and while the gate is off, with no link', async () => {
    const h = loungeHarness();
    h.chats.set(USER, { wallet: WALLET, enabled: true });
    const cookie = await h.signIn(WALLET);
    const below = await h.get('/api/lounge', cookie);
    expect(await below.json()).toEqual({ state: 'not_holder', url: null });
    h.tiers.set(WALLET, entitlementsOfTier(3));
    h.gatingOn.value = false;
    expect(await (await h.get('/api/lounge', cookie)).json()).toEqual({ state: 'not_holder', url: null });
    expect(h.trace).toContain('entitlements:full');
    expect(h.trace).not.toContain('entitlements:cachedOnly');
  });

  it('answers link_telegram for a holder with no linked chat', async () => {
    const h = loungeHarness();
    h.tiers.set(WALLET, entitlementsOfTier(1));
    const reply = await h.get('/api/lounge', await h.signIn(WALLET));
    expect(await reply.json()).toEqual({ state: 'link_telegram', url: null });
  });

  it('answers open with the invite link for a linked holder, paused notes included, never cached', async () => {
    const h = loungeHarness();
    h.tiers.set(WALLET, entitlementsOfTier(1));
    h.chats.set(USER, { wallet: WALLET, enabled: false });
    const reply = await h.get('/api/lounge', await h.signIn(WALLET));
    expect(reply.status).toBe(200);
    expect(loungeResponseSchema.parse(await reply.json())).toEqual({ state: 'open', url: INVITE });
    expect(reply.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('never answers for another wallet than the session', async () => {
    const h = loungeHarness();
    h.tiers.set(WALLET, entitlementsOfTier(1));
    h.chats.set(USER, { wallet: WALLET, enabled: true });
    const other = await h.signIn('0x00000000000000000000000000000000000000c2');
    const reply = await h.get('/api/lounge?address=0x00000000000000000000000000000000000000b1', other);
    expect(await reply.json()).toEqual({ state: 'not_holder', url: null });
  });
});
