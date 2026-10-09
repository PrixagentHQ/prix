import { env as baseEnv } from 'cloudflare:workers';
import type { CronStep } from '@prix/contracts';
import { CRON_PLAN, SESSION_COOKIE, SOCIAL_CRON } from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, newSessionToken } from '../../apps/api/src/http/session.ts';
import worker, { runCron } from '../../apps/api/src/index.ts';
import { createD1Store } from '../../apps/api/src/store/index.ts';

/**
 * Phase 6 in the Worker entry (docs/contracts/phase-6-social.md sections 4.1, 4.2 and 10): the
 * switch, the admin routes, and the fifth clock. Everything goes through what the entry exports.
 */
const ORIGIN = 'https://prix.test';
const ADMIN = '0x00000000000000000000000000000000000009a1';
const SOMEONE = '0x00000000000000000000000000000000000005b2';

const db = (baseEnv as unknown as { DB: D1Database }).DB;
const allow = { limit: async () => ({ success: true }) };

/** A fresh env each time, so the entry builds its wiring again from what the test gives it. */
function envWith(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...extra,
  };
}

const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

async function call(env: Record<string, unknown>, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, env as never, ctx as never);
  await Promise.all(pending.splice(0));
  return response;
}

interface Seen {
  status: number;
  type: string | null;
  control: string | null;
  text: string;
}

async function seen(response: Response): Promise<Seen> {
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    control: response.headers.get('cache-control'),
    text: await response.text(),
  };
}

/** A session cookie for `address`, stored as the sign-in route stores one. */
async function sessionFor(address: string): Promise<string> {
  const token = newSessionToken();
  const now = Date.now();
  await createD1Store(db).putSession({
    tokenHash: await hashToken(token),
    address: address as never,
    createdAt: new Date(now).toISOString() as never,
    expiresAt: new Date(now + 3_600_000).toISOString() as never,
  });
  return `${SESSION_COOKIE}=${token}`;
}

function post(cookie: string | null, body: unknown = {}): RequestInit {
  const headers: Record<string, string> = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (cookie !== null) headers.Cookie = cookie;
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

const UNKNOWN = '/api/no-such-path';

const PUBLIC_SOCIAL: readonly [string, RequestInit?][] = [
  ['/api/social/status'],
  ['/api/social/agents/abcdefghijkl'],
  ['/api/social/agents/abcdefghijkl/fork-source'],
  ['/api/social/families/abcdefghijkl?page=1'],
  ['/api/social/rivalries?division=open'],
  ['/api/social/rivalries/abcdefghijkl'],
  ['/api/social/wars'],
  ['/api/social/wars/abcdefghijkl'],
  ['/api/social/managers'],
  ['/api/social/managers/abcdefghijkl'],
  ['/api/social/me/managers'],
  ['/api/social/managers', { method: 'POST' }],
  ['/api/social/managers/abcdefghijkl', { method: 'PATCH' }],
  ['/api/social/agents/abcdefghijkl/lineage', { method: 'POST' }],
];

const ADMIN_SOCIAL: readonly string[] = [
  '/api/social/admin/wars',
  '/api/social/admin/wars/abcdefghijkl/stop',
  '/api/social/admin/managers/abcdefghijkl/hidden',
];

describe('the clocks', () => {
  // First in the file: the entry checks its clocks at most once in five minutes per isolate.
  it('starts one clock for every entry of CRON_PLAN, so a fifth entry gets a clock of its own', async () => {
    const started: string[] = [];
    const clock = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        start: async (cron: string) => {
          expect(cron).toBe(name);
          started.push(cron);
        },
      }),
    };
    await call(envWith({ CLOCK: clock }), UNKNOWN);
    expect(started.sort()).toEqual(Object.keys(CRON_PLAN).sort());
  });
});

describe('the switch SOCIAL_ENABLED', () => {
  for (const value of [undefined, 'false', 'FALSE', 'yes', ' true-ish ']) {
    it(`answers every public /api/social path exactly as an unknown path while it is ${String(value)}`, async () => {
      const env = envWith(value === undefined ? {} : { SOCIAL_ENABLED: value });
      const unknown = await seen(await call(env, UNKNOWN));
      expect(unknown.status).toBe(404);
      for (const [path, init] of PUBLIC_SOCIAL) {
        expect(await seen(await call(env, path, init)), path).toEqual(unknown);
      }
    });
  }

  it('leaves the Phase 1 to 5 reads as they were', async () => {
    const off = envWith({ SOCIAL_ENABLED: 'false' });
    for (const path of ['/api/seasons', '/api/providers', '/api/token', '/api/reputation/seasons']) {
      const response = await call(off, path);
      expect(response.status, path).not.toBe(404);
    }
  });

  for (const value of ['false', 'true']) {
    it(`answers the admin routes to anyone who is not an admin exactly as an unknown path (switch ${value})`, async () => {
      const env = envWith({ SOCIAL_ENABLED: value });
      const unknown = await seen(await call(env, UNKNOWN, post(null)));
      const someone = await sessionFor(SOMEONE);
      for (const path of ADMIN_SOCIAL) {
        expect(await seen(await call(env, path, post(null))), path).toEqual(unknown);
        expect(await seen(await call(env, path, post(someone))), path).toEqual(unknown);
        expect(await seen(await call(env, path, post(`${SESSION_COOKIE}=not-a-session`))), path).toEqual(unknown);
      }
    });
  }
});

describe('the public cache of the Phase 6 reads', () => {
  const MARKER = 'from-the-cache';
  const plant = async (key: string) =>
    caches.default.put(key, new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }));
  const served = async (response: Response) => (await response.text()) === MARKER;

  it('looks a public read up by its path and known parameters, with a cookie or without', async () => {
    const env = envWith();
    await plant(`${ORIGIN}/api/social/rivalries?division=pro&page=2`);
    expect(await served(await call(env, '/api/social/rivalries?page=2&division=pro'))).toBe(true);
    const cookie = { headers: { Cookie: `${SESSION_COOKIE}=x` } };
    expect(await served(await call(env, '/api/social/rivalries?division=pro&page=2', cookie))).toBe(true);
    await plant(`${ORIGIN}/api/social/wars/abcdefghijkl`);
    expect(await served(await call(env, '/api/social/wars/abcdefghijkl'))).toBe(true);
  });

  it('never looks up a private read, an unknown parameter or a repeated one', async () => {
    const env = envWith();
    await plant(`${ORIGIN}/api/social/me/managers`);
    expect(await served(await call(env, '/api/social/me/managers'))).toBe(false);
    await plant(`${ORIGIN}/api/social/wars?page=3`);
    expect(await served(await call(env, '/api/social/wars?page=3&junk=1'))).toBe(false);
    expect(await served(await call(env, '/api/social/wars?page=3&page=4'))).toBe(false);
    expect(await served(await call(env, '/api/social/wars?page=3', { method: 'POST' }))).toBe(false);
  });
});

describe('the social step', () => {
  const logs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
  });

  /** An env whose database records every statement it is asked to prepare. */
  function recordingEnv(): { env: Record<string, unknown>; statements: string[] } {
    const statements: string[] = [];
    const recording = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { env: envWith({ DB: recording }), statements };
  }

  function captureLogs(): void {
    const keep = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(keep);
    vi.spyOn(console, 'warn').mockImplementation(keep);
    vi.spyOn(console, 'error').mockImplementation(keep);
  }

  // CRON_PLAN gets SOCIAL_CRON in the operator's merge commit; this plan is that plan.
  const plan: Readonly<Record<string, readonly string[]>> = {
    ...CRON_PLAN,
    [SOCIAL_CRON]: ['social'],
    '0 0 1 1 *': ['no-such-step'],
  };

  it('runs the social jobs on the social clock and never the token sweep', async () => {
    captureLogs();
    const { env, statements } = recordingEnv();
    await runCron(SOCIAL_CRON, env as never, plan);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((sql) => /\b(wars|job_state|day_prices)\b/.test(sql))).toBe(true);
    expect(statements.some((sql) => /\btoken_(config|holders)\b/.test(sql))).toBe(false);
    expect(logs.some((line) => line.includes('token'))).toBe(false);
  });

  it('runs nothing for a step it does not know, and says so', async () => {
    captureLogs();
    const { env, statements } = recordingEnv();
    await runCron('0 0 1 1 *', env as never, plan);
    expect(statements).toEqual([]);
    expect(logs.some((line) => line.includes('"step_unknown"') && line.includes('no-such-step'))).toBe(true);
    expect(logs.some((line) => line.includes('token'))).toBe(false);
  });

  it('runs the token sweep on the token clock still', async () => {
    captureLogs();
    const { env, statements } = recordingEnv();
    const token = Object.entries(CRON_PLAN).find(([, steps]) => steps.includes('token' as CronStep));
    expect(token).toBeDefined();
    await runCron(token?.[0] ?? '', env as never, plan);
    expect(statements.some((sql) => /\btoken_config\b/.test(sql))).toBe(true);
    expect(statements.some((sql) => /\bwars\b/.test(sql))).toBe(false);
  });
});

/** Every header of a response, sorted, so two answers can be compared byte for byte. */
function headersOf(response: Response): string[] {
  return [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).sort();
}

describe('the mount of the social routes in createApp', () => {
  // The public read is cached for 30 seconds by its path: one test's answer must not stand in for the next.
  beforeEach(async () => {
    await caches.default.delete(`${ORIGIN}/api/social/status`);
  });

  it('answers GET /api/social/status with 200 {"on":true} while the switch is "true"', async () => {
    const response = await call(envWith({ SOCIAL_ENABLED: 'true' }), '/api/social/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ on: true });
  });

  it('answers GET /api/social/status as the unknown path, body and headers byte for byte, while the switch is "false"', async () => {
    const env = envWith({ SOCIAL_ENABLED: 'false' });
    const unknown = await call(env, UNKNOWN);
    const status = await call(env, '/api/social/status');
    expect(status.status).toBe(404);
    expect(status.status).toBe(unknown.status);
    expect(headersOf(status)).toEqual(headersOf(unknown));
    const body = await status.text();
    expect(body).not.toBe('');
    expect(body).toBe(await unknown.text());
  });

  for (const value of ['true', 'false']) {
    it(`gives an admin session sending {} to POST /api/social/admin/wars a 400, not a 404 (switch ${value})`, async () => {
      const env = envWith({ SOCIAL_ENABLED: value });
      const admin = await sessionFor(ADMIN);
      const response = await call(env, '/api/social/admin/wars', post(admin, {}));
      expect(response.status).toBe(400);
    });

    it(`gives a signed-in non-admin the unknown path, body and headers byte for byte (switch ${value})`, async () => {
      const env = envWith({ SOCIAL_ENABLED: value });
      const someone = await sessionFor(SOMEONE);
      const unknown = await call(env, UNKNOWN, post(someone, {}));
      const refused = await call(env, '/api/social/admin/wars', post(someone, {}));
      expect(refused.status).toBe(404);
      expect(headersOf(refused)).toEqual(headersOf(unknown));
      expect(await refused.text()).toBe(await unknown.text());
    });
  }
});
