import { env as baseEnv } from 'cloudflare:workers';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashToken, newSessionToken } from '../../../../apps/api/src/http/session.ts';
import worker from '../../../../apps/api/src/index.ts';
import { createD1Store } from '../../../../apps/api/src/store/index.ts';
import { makeAgent, SEASON_1, startingPortfolio, startingStats, testAddress } from '../../../support/fixtures.ts';

/**
 * Security review 6, finding 5 (docs/contracts/phase-6-social.md section 7): when an agent write or an
 * admin hide succeeds, the entry also deletes the cached `/api/social/agents/:id` and
 * `/api/social/agents/:id/fork-source` at its location, so a prompt just made private or an agent just
 * hidden is not served from this location's cache for another 30 seconds. Through what the entry exports.
 */
const ORIGIN = 'https://prix.test';
const ADMIN = testAddress(0x9a10);
const OWNER = testAddress(0x9a11);
const MARKER = 'from-the-cache';

const db = (baseEnv as unknown as { DB: D1Database }).DB;
const store = createD1Store(db);
const allow = { limit: async () => ({ success: true }) };
const env = {
  ...(baseEnv as unknown as Record<string, unknown>),
  SITE_ORIGIN: ORIGIN,
  ADMIN_ADDRESSES: ADMIN,
  HOUSE_MODEL: '@cf/test/model',
  HOUSE_MODEL_INPUT_NEURONS: '1',
  HOUSE_MODEL_OUTPUT_NEURONS: '1',
  KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
  NONCE_SECRET: btoa('n'.repeat(32)),
  RATE_SIGN_IN: allow,
  RATE_WRITE: allow,
  RATE_READ: allow,
};
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  return response;
}

async function signIn(address: string): Promise<string> {
  const token = newSessionToken();
  const now = Date.now();
  await store.putSession({
    tokenHash: await hashToken(token),
    address,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
  });
  return token;
}

const write = (method: string, cookie: string, body: unknown): RequestInit => ({
  method,
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${cookie}` },
  body: JSON.stringify(body),
});

const socialKeys = (id: string) => [
  `${ORIGIN}/api/social/agents/${id}`,
  `${ORIGIN}/api/social/agents/${id}/fork-source`,
];

async function plant(id: string): Promise<void> {
  for (const key of socialKeys(id)) {
    await caches.default.put(key, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));
  }
}

async function cached(id: string): Promise<boolean[]> {
  return Promise.all(socialKeys(id).map(async (key) => (await caches.default.match(key)) !== undefined));
}

const agent = makeAgent({ n: 9101, name: 'Cached Kin', owner: OWNER, overrides: { promptPublic: true } });
const other = makeAgent({ n: 9102, name: 'Other Kin', owner: testAddress(0x9a12) });

beforeAll(async () => {
  await db
    .prepare('INSERT OR IGNORE INTO seasons (id, number, starts_at, ends_at) VALUES (?, ?, ?, ?)')
    .bind(SEASON_1.id, SEASON_1.number, SEASON_1.startsAt, SEASON_1.endsAt)
    .run();
  for (const record of [agent, other]) {
    const result = await store.createAgent(record, SEASON_1.id, startingPortfolio(), startingStats(), 1000, 1000);
    expect(result).toBe('created');
  }
});

describe('an agent write forgets the cached social reads of that agent', () => {
  it('deletes both social reads of the agent when its owner unpublishes the prompt', async () => {
    await plant(agent.id);
    await plant(other.id);
    expect(await cached(agent.id)).toEqual([true, true]);
    const reply = await call(`/api/agents/${agent.id}`, write('PATCH', await signIn(OWNER), { promptPublic: false }));
    expect(reply.status, await reply.clone().text()).toBe(200);
    expect(await cached(agent.id)).toEqual([false, false]);
    // Another agent's reads keep their 30 seconds.
    expect(await cached(other.id)).toEqual([true, true]);
  });

  it('deletes both social reads of the agent when an admin hides it', async () => {
    await plant(agent.id);
    const reply = await call(
      `/api/admin/agents/${agent.id}/hidden`,
      write('POST', await signIn(ADMIN), { hidden: true }),
    );
    expect(reply.status, await reply.clone().text()).toBe(204);
    expect(await cached(agent.id)).toEqual([false, false]);
  });

  it('keeps them when the write is refused', async () => {
    await plant(other.id);
    // Not the owner: refused, so nothing changed and nothing is forgotten.
    const reply = await call(`/api/agents/${other.id}`, write('PATCH', await signIn(OWNER), { paused: true }));
    expect(reply.status).toBe(403);
    expect(await cached(other.id)).toEqual([true, true]);
  });
});
