import { socialStatusResponseSchema } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { sim } from '@prix/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/http/index.ts';
import { createTestVault, FakeRateLimiter } from '../support/fakes.ts';
import { HOUSE_MODEL_ID, SEASON_1, testAddress } from '../support/fixtures.ts';
import { db, resetDb, storesOn } from './support/d1.ts';
import { ADMIN_ADDRESS, createSocialHttp, type Reply, SITE_ORIGIN } from './support/http.ts';

/**
 * The switch (docs/contracts/phase-6-social.md section 4.1). While SOCIAL_ENABLED is off the public
 * routes are not mounted: every /api/social path falls to the generic 404, byte for byte the answer to
 * an unknown path. The admin routes are mounted always and answer exactly that same 404 to anyone who is
 * not an admin session, so nobody can find them by asking.
 */

const stores = storesOn(db);

/** Every Phase 6 route of section 6, with a method, a sample id and a body where one is read. */
const ID = 'aaaaaaaaaaab';
const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/api/social/status' },
  { method: 'GET', path: `/api/social/agents/${ID}` },
  { method: 'GET', path: `/api/social/agents/${ID}/fork-source` },
  { method: 'POST', path: `/api/social/agents/${ID}/lineage`, body: { parentId: ID } },
  { method: 'GET', path: `/api/social/families/${ID}` },
  { method: 'GET', path: `/api/social/families/${ID}?page=2` },
  { method: 'GET', path: '/api/social/rivalries' },
  { method: 'GET', path: '/api/social/rivalries?division=pro&page=1' },
  { method: 'GET', path: `/api/social/rivalries/seasonaaaaaa-${ID}-${ID}` },
  { method: 'GET', path: '/api/social/wars' },
  { method: 'GET', path: `/api/social/wars/${ID}` },
  { method: 'GET', path: '/api/social/managers' },
  { method: 'GET', path: `/api/social/managers/${ID}` },
  { method: 'GET', path: '/api/social/me/managers' },
  { method: 'POST', path: '/api/social/managers', body: { name: 'Quiet Mix' } },
  { method: 'PATCH', path: `/api/social/managers/${ID}`, body: { status: 'paused' } },
  { method: 'GET', path: '/api/social/anything/else' },
];
const ADMIN_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'POST', path: '/api/social/admin/wars', body: { title: 'x' } },
  { method: 'POST', path: `/api/social/admin/wars/${ID}/stop` },
  { method: 'POST', path: `/api/social/admin/managers/${ID}/hidden`, body: { hidden: true } },
];

function same(a: Reply, b: Reply): void {
  expect(a.status).toBe(b.status);
  expect(a.text).toBe(b.text);
  expect([...a.headers.entries()].sort()).toEqual([...b.headers.entries()].sort());
}

beforeAll(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('the switch is off', () => {
  it('answers every public Phase 6 path with the generic 404, byte for byte the answer to an unknown path', async () => {
    const off = createSocialHttp(stores, { on: false });
    const user = await off.signIn(testAddress(101));
    const unknown = await off.fetch('GET', '/api/this-path-does-not-exist');
    expect(unknown.status).toBe(404);
    for (const route of ROUTES) {
      for (const cookie of [undefined, user]) {
        const reply = await off.fetch(route.method, route.path, { body: route.body, cookie });
        same(reply, unknown);
      }
    }
  });

  it('answers the same through the real application, which mounts no Phase 6 route at all', async () => {
    const limiter = new FakeRateLimiter();
    const app = createApp({
      store: stores.store,
      sim,
      scoring,
      sealer: createTestVault().sealer,
      rateLimiter: limiter,
      config: {
        siteOrigin: SITE_ORIGIN,
        adminAddresses: [ADMIN_ADDRESS],
        houseModel: HOUSE_MODEL_ID,
        nonceSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      now: () => new Date('2026-10-20T12:00:00.000Z'),
    });
    const get = async (method: string, path: string): Promise<Reply> => {
      const headers = new Headers({ 'CF-Connecting-IP': '203.0.113.50' });
      if (method !== 'GET') {
        headers.set('Origin', SITE_ORIGIN);
        headers.set('Content-Type', 'application/json');
      }
      const response = await app.fetch(
        new Request(`${SITE_ORIGIN}${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' }),
      );
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, json: null };
    };
    const unknown = await get('GET', '/api/this-path-does-not-exist');
    expect(unknown.status).toBe(404);
    for (const route of [...ROUTES, ...ADMIN_ROUTES]) same(await get(route.method, route.path), unknown);
  });
});

describe('the admin routes, switch off or on', () => {
  it.each([false, true])(
    'answer a request that is not an admin session like an unknown path (switch on: %s)',
    async (on) => {
      const http = createSocialHttp(stores, { on });
      const unknown = await http.fetch('GET', '/api/this-path-does-not-exist');
      const user = await http.signIn(testAddress(102));
      const garbage = 'not-a-session-token-0123456789012345678901234567';
      for (const route of ADMIN_ROUTES) {
        for (const cookie of [undefined, user, garbage]) {
          same(await http.fetch(route.method, route.path, { body: route.body, cookie }), unknown);
        }
      }
    },
  );

  it('checks the session before the body is read: a bad body, a wrong media type and a foreign origin change nothing', async () => {
    const http = createSocialHttp(stores, { on: false });
    const unknown = await http.fetch('GET', '/api/this-path-does-not-exist');
    const user = await http.signIn(testAddress(103));
    for (const route of ADMIN_ROUTES) {
      same(await http.fetch(route.method, route.path, { rawBody: '{"broken', cookie: user }), unknown);
      same(
        await http.fetch(route.method, route.path, { rawBody: '{}', cookie: user, contentType: 'text/plain' }),
        unknown,
      );
      same(
        await http.fetch(route.method, route.path, { rawBody: '{}', cookie: user, origin: 'https://evil.example' }),
        unknown,
      );
      same(await http.fetch(route.method, route.path, { rawBody: '{}', cookie: user, origin: null }), unknown);
    }
  });

  it('is there for the admin: it answers the admin, even with the switch off, and with its own errors', async () => {
    const http = createSocialHttp(stores, { on: false });
    const admin = await http.signIn(ADMIN_ADDRESS);
    const created = await http.fetch('POST', '/api/social/admin/wars', { cookie: admin, body: { title: 'x' } });
    expect(created.status).toBe(400);
    expect(created.json.error.code).toBe('invalid_input');
    const stopped = await http.fetch('POST', `/api/social/admin/wars/${ID}/stop`, { cookie: admin });
    expect(stopped.status).toBe(404);
    expect(stopped.json.error.code).toBe('not_found');
    // The public routes are still not there for the admin.
    const unknown = await http.fetch('GET', '/api/this-path-does-not-exist', { cookie: admin });
    same(await http.fetch('GET', '/api/social/wars', { cookie: admin }), unknown);
  });

  it('matches the admin address without regard to case', async () => {
    const http = createSocialHttp(stores, {
      on: false,
      adminAddresses: [ADMIN_ADDRESS.toUpperCase().replace('0X', '0x')],
    });
    const admin = await http.signIn(ADMIN_ADDRESS);
    const reply = await http.fetch('POST', '/api/social/admin/wars', { cookie: admin, body: { title: 'x' } });
    expect(reply.status).toBe(400);
  });
});

describe('the switch is on', () => {
  it('answers /api/social/status with {on: true}, cached for 30 seconds, and reads no session', async () => {
    const http = createSocialHttp(stores, { on: true });
    const reply = await http.fetch('GET', '/api/social/status');
    expect(reply.status).toBe(200);
    expect(socialStatusResponseSchema.parse(reply.json)).toEqual({ on: true });
    expect(reply.headers.get('Cache-Control')).toBe('public, max-age=30');
  });
});
