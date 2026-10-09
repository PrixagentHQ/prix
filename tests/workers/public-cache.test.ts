import { env as baseEnv } from 'cloudflare:workers';
import { SESSION_COOKIE } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFeedCursorSigner } from '../../apps/api/src/http/follow/feed-cursor.ts';
import worker from '../../apps/api/src/index.ts';

/**
 * The cache in front of the five public reads (docs/CONTRACTS.md section 15), through what the
 * entry exports: its `fetch`. A marker answer is put in the Workers cache under the key a request
 * should get; the marker coming back shows a lookup, and the real answer shows none.
 */
const ORIGIN = 'https://prix.test';
const MARKER = 'from-the-cache';

const allow = { limit: async () => ({ success: true }) };
const env = {
  ...(baseEnv as unknown as Record<string, unknown>),
  SITE_ORIGIN: ORIGIN,
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

async function plant(key: string): Promise<void> {
  await caches.default.put(key, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));
}

const served = async (response: Response) => (await response.text()) === MARKER;

describe('the public cache of the API entry', () => {
  it('serves a public read from the cache, with a session cookie or without one', async () => {
    await plant(`${ORIGIN}/api/market`);
    expect(await served(await call('/api/market'))).toBe(true);
    const cookie = { headers: { Cookie: `${SESSION_COOKIE}=x` } };
    expect(await served(await call('/api/market', cookie))).toBe(true);
  });

  it('looks HEAD up like GET, and never looks a POST up', async () => {
    await plant(`${ORIGIN}/api/seasons`);
    const head = await call('/api/seasons', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(await served(await call('/api/seasons', { method: 'POST' }))).toBe(false);
  });

  it('answers 404 for an /api path with a percent sign, before the cache is asked', async () => {
    await plant(`${ORIGIN}/api/market`);
    const response = await call('/api/%6darket');
    expect(response.status).toBe(404);
    expect(await served(response)).toBe(false);
  });

  it('looks up a league query with its defaults filled in, and not a junk parameter, a duplicate or a page past the last', async () => {
    await plant(`${ORIGIN}/api/league?division=open&page=1`);
    expect(await served(await call('/api/league?division=open'))).toBe(true);
    expect(await served(await call('/api/league?division=open&junk=1'))).toBe(false);
    expect(await served(await call('/api/league?division=open&division=pro'))).toBe(false);
    expect(await served(await call('/api/league?division=open&page=10000'))).toBe(false);
  });

  // The league feed of docs/CONTRACTS.md section 17: the same for everyone, so shared whatever the cookie.
  const FEED = `${ORIGIN}/api/feed/league`;
  const cookie = { headers: { Cookie: `${SESSION_COOKIE}=x` } };
  // Section 20: only cursors the API signed, under the NONCE_SECRET of this env, are good cursors.
  const signer = createFeedCursorSigner(env.NONCE_SECRET);
  const CURSOR_AT = { tickId: '2026-10-06T15:00Z', agentId: 'aaaaaaaaaaaa' };
  let CURSOR = '';
  let ELSEWHERE = '';
  beforeAll(async () => {
    CURSOR = await signer.sign(CURSOR_AT);
    ELSEWHERE = await signer.sign({ ...CURSOR_AT, tickId: '2026-10-06T16:00Z' });
  });
  /** Of the right shape, and not signed by the API. */
  const FORGED = '2026-10-06T15:00Z~aaaaaaaaaaaa~aaaaaaaaaaaaaaaa';

  it('serves the league feed from the cache with a session cookie and without one', async () => {
    await plant(`${FEED}?limit=20`);
    expect(await served(await call('/api/feed/league'))).toBe(true);
    expect(await served(await call('/api/feed/league', cookie))).toBe(true);
    // The default limit is filled in, so the two spellings of the first page share one answer.
    expect(await served(await call('/api/feed/league?limit=20', cookie))).toBe(true);
  });

  it('keys the league feed by its path and its two parameters, in one order', async () => {
    await plant(`${FEED}?limit=20`);
    await plant(`${FEED}?limit=20&cursor=${encodeURIComponent(CURSOR)}`);
    await caches.default.delete(`${FEED}?limit=5`);
    await caches.default.delete(`${FEED}?limit=5&cursor=${encodeURIComponent(CURSOR)}`);
    const cursor = encodeURIComponent(CURSOR);

    expect(await served(await call(`/api/feed/league?cursor=${cursor}`, cookie))).toBe(true);
    expect(await served(await call(`/api/feed/league?cursor=${cursor}&limit=20`))).toBe(true);
    expect(await served(await call(`/api/feed/league?limit=20&cursor=${cursor}`))).toBe(true);
    // Another limit and another cursor are other pages: the stored one is not served for them.
    const other = await call('/api/feed/league?limit=5');
    expect(other.status).toBe(200);
    expect(await served(other)).toBe(false);
    expect(await served(await call(`/api/feed/league?limit=5&cursor=${cursor}`))).toBe(false);
    const elsewhere = encodeURIComponent(ELSEWHERE);
    expect(await served(await call(`/api/feed/league?cursor=${elsewhere}`))).toBe(false);
  });

  it('never looks up a cursor the API did not sign, even one of the right shape, and answers it with 400', async () => {
    const forged = encodeURIComponent(FORGED);
    const agentFeed = `${ORIGIN}/api/agents/${CURSOR_AT.agentId}/feed`;
    await plant(`${FEED}?limit=20&cursor=${forged}`);
    await plant(`${agentFeed}?cursor=${forged}`);
    await plant(`${agentFeed}?cursor=${forged}&limit=20`);
    for (const path of [
      `/api/feed/league?cursor=${forged}`,
      `/api/agents/${CURSOR_AT.agentId}/feed?cursor=${forged}`,
      `/api/agents/${CURSOR_AT.agentId}/feed?cursor=${forged}&limit=20`,
    ]) {
      const response = await call(path);
      expect(await served(response), path).toBe(false);
      expect(response.status, path).toBe(400);
      expect(response.headers.get('Cache-Control'), path).toBe('no-store');
    }
  });

  it('does not look up a league feed query the route refuses, and answers it with 400', async () => {
    await plant(`${FEED}?limit=20`);
    for (const query of ['delay=0', 'limit=20&junk=1', 'limit=20&limit=20', 'limit=0', 'limit=31', 'cursor=nope']) {
      const response = await call(`/api/feed/league?${query}`, cookie);
      expect(response.status, query).toBe(400);
      expect(await served(response), query).toBe(false);
      expect(response.headers.get('Cache-Control'), query).toBe('no-store');
    }
  });

  it('never confuses the league feed with GET /api/feed, which stays private', async () => {
    await plant(`${FEED}?limit=20`);
    // Even an answer planted under the private feed's own address is never looked up.
    await plant(`${ORIGIN}/api/feed`);
    await plant(`${ORIGIN}/api/feed?limit=20`);
    for (const init of [{}, cookie]) {
      for (const path of ['/api/feed', '/api/feed?limit=20', '/api/feed/']) {
        const response = await call(path, init);
        expect(await served(response), path).toBe(false);
        expect(response.status === 401 || response.status === 404, `${path}: ${response.status}`).toBe(true);
      }
    }
    // And the league feed is never stored under a key without its limit.
    expect(await caches.default.match(FEED)).toBeUndefined();
  });

  it('stores the league feed of a miss under the same key for a request with a cookie', async () => {
    const key = `${FEED}?limit=7`;
    await caches.default.delete(key);
    const first = await call('/api/feed/league?limit=7', cookie);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=30');
    const body = (await first.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    const stored = await caches.default.match(key);
    expect(stored).toBeDefined();
    expect(await stored?.json()).toEqual(body);
    // The next visitor, signed in or not, is served what was stored.
    await plant(key);
    expect(await served(await call('/api/feed/league?limit=7'))).toBe(true);
  });

  it('stores a public 200 of a miss, and does not store an error', async () => {
    await caches.default.delete(`${ORIGIN}/api/providers`);
    const first = await call('/api/providers');
    expect(first.status).toBe(200);
    expect(await caches.default.match(`${ORIGIN}/api/providers`)).toBeDefined();
    const bad = await call('/api/league?division=nope');
    expect(bad.status).toBe(400);
    expect(await caches.default.match(`${ORIGIN}/api/league?division=nope`)).toBeUndefined();
  });
});
