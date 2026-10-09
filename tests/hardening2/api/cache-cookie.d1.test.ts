import { env as baseEnv } from 'cloudflare:workers';
import { formatFeedCursor, SESSION_COOKIE } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import worker from '../../../apps/api/src/index.ts';

/**
 * The cache in front of the agent read and the agent feed (docs/CONTRACTS.md section 20; security
 * review of 2026-10-08, the newest reads, finding 3). Only the session cookie itself skips the cache:
 * any other Cookie header is served what is stored, so no spelling of a request reaches the database.
 * Runs in the Workers runtime (tests/vitest.workers.config.ts), through the entry's `fetch`.
 */
const ORIGIN = 'https://prix.test';
const MARKER = 'from-the-cache';
const AGENT = 'abcdefghijkl';

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

async function call(path: string, cookie?: string): Promise<Response> {
  const init = cookie === undefined ? {} : { headers: { Cookie: cookie } };
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  return response;
}

async function plant(key: string): Promise<void> {
  await caches.default.put(key, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));
}

const served = async (response: Response) => (await response.text()) === MARKER;

/** A value of the session cookie's shape: 43 characters of base64url. */
const SESSION = `${SESSION_COOKIE}=${'A'.repeat(43)}`;
const OTHER_COOKIES = ['theme=dark', 'a=b; c=d', `${SESSION_COOKIE}x=${'A'.repeat(43)}`, `${SESSION_COOKIE}=short`];

describe('the agent read and the agent feed behind the cache', () => {
  for (const path of [`/api/agents/${AGENT}`, `/api/agents/${AGENT}/feed`]) {
    it(`serves ${path} from the cache for any Cookie header but the session cookie`, async () => {
      await plant(`${ORIGIN}${path}`);
      expect(await served(await call(path))).toBe(true);
      for (const cookie of OTHER_COOKIES) {
        expect(await served(await call(path, cookie)), cookie).toBe(true);
      }
    });

    it(`skips the cache of ${path} when the session cookie is present, alone or among others`, async () => {
      await plant(`${ORIGIN}${path}`);
      for (const cookie of [SESSION, `theme=dark; ${SESSION}`, `${SESSION}; theme=dark`]) {
        expect(await served(await call(path, cookie)), cookie).toBe(false);
      }
    });
  }

  it('answers a league feed cursor it did not sign with 400 and stores nothing', async () => {
    const forged = formatFeedCursor({ tickId: '2026-10-06T15:00Z', agentId: AGENT }, 'aaaaaaaaaaaaaaaa');
    const key = `${ORIGIN}/api/feed/league?limit=20&cursor=${encodeURIComponent(forged)}`;
    await caches.default.delete(key);
    const response = await call(`/api/feed/league?cursor=${encodeURIComponent(forged)}`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; field: string | null } };
    expect(body.error).toMatchObject({ code: 'invalid_input', field: 'cursor' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await caches.default.match(key)).toBeUndefined();
  });
});
