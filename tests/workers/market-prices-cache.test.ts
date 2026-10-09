import { env as baseEnv } from 'cloudflare:workers';
import { marketPricesResponseSchema, SESSION_COOKIE } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import worker from '../../apps/api/src/index.ts';

/**
 * The cache in front of GET /api/market/prices (docs/CONTRACTS.md section 17.2): cached 30
 * seconds like the other public reads, under its path alone. A marker answer is planted in the
 * Workers cache under the key; the marker coming back shows a lookup, the real answer shows none.
 */
const ORIGIN = 'https://prix.test';
const MARKER = 'from-the-cache';
const KEY = `${ORIGIN}/api/market/prices`;

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

const served = async (response: Response) => (await response.text()) === MARKER;

describe('the cache of the price strip', () => {
  it('stores the answer under the path alone and serves it for 30 seconds', async () => {
    await caches.default.delete(KEY);
    const first = await call('/api/market/prices');
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=30');
    // An empty database: no round yet.
    expect(marketPricesResponseSchema.parse(await first.json())).toEqual({ tickId: null, takenAt: null, prices: [] });
    const stored = await caches.default.match(KEY);
    expect(stored?.headers.get('Cache-Control')).toBe('public, max-age=30');
    await stored?.text();
  });

  it('looks the same key up whatever query or cookie a request adds', async () => {
    await caches.default.put(KEY, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));
    expect(await served(await call('/api/market/prices'))).toBe(true);
    expect(await served(await call('/api/market/prices?junk=1&tick=2026-10-07T15:00Z'))).toBe(true);
    expect(await served(await call('/api/market/prices', { headers: { Cookie: `${SESSION_COOKIE}=x` } }))).toBe(true);
    await caches.default.delete(KEY);
  });

  it('keeps the price strip and the market status apart', async () => {
    await caches.default.put(KEY, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));
    await caches.default.delete(`${ORIGIN}/api/market`);
    expect(await served(await call('/api/market'))).toBe(false);
    expect(await served(await call('/api/market/prices/'))).toBe(false);
    await caches.default.delete(KEY);
  });
});
