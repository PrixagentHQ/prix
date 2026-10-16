import { env as baseEnv } from 'cloudflare:workers';
import type { HolderPoll, PollApiDeps, PollTallyJobDeps, PollTallyOutcome, SocialJobOutcome } from '@prix/contracts';
import {
  HOLDER_POLLS,
  POLL_TALLY_DELAY_LABEL,
  SESSION_COOKIE,
  SOCIAL_CRON,
  TELEGRAM_WEBHOOK_URL,
} from '@prix/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
  createTallyDelay,
  POLLS_PATH,
  pollsDropRead,
  pollsSwitchOn,
  readTelegram,
  runCron,
  watchTelegramWebhook,
} from './index.ts';

/**
 * The holders round in the Worker entry (docs/contracts/phase-6-holders.md sections 4.4, 4.6, 5 and 7), through
 * what the entry exports: the switch read exactly, the extras handed to the app, the one cache key of
 * GET /api/polls and its HEAD rule, the drop after a vote and a tally, `poll_tally`'s place in the social step,
 * the tally's delay d, `readTelegram` without the username, and the webhook's watch.
 * Run: pnpm exec vitest run --config apps/api/vitest.workers.config.ts
 */
const ORIGIN = 'https://prix.test';
const ADMIN = '0x00000000000000000000000000000000000009a1';
const MARKER = 'from-the-cache';
const db = (baseEnv as unknown as { DB: D1Database }).DB;
const wranglerText = (baseEnv as unknown as { WRANGLER_JSONC: string }).WRANGLER_JSONC;

/** The app the entry builds, with a seam: the extras it was built from, and a test's own answer for a path. */
const app = vi.hoisted(() => ({
  extras: null as unknown,
  calls: [] as string[],
  answer: null as ((request: Request) => Response | null) | null,
}));
vi.mock('./http/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http/index.ts')>();
  return {
    ...actual,
    createApp: (...args: Parameters<typeof actual.createApp>) => {
      app.extras = args[1];
      const real = actual.createApp(...args) as { fetch(request: Request, ctx?: unknown): Promise<Response> };
      return {
        fetch: async (request: Request, ctx?: unknown): Promise<Response> => {
          app.calls.push(`${request.method} ${new URL(request.url).pathname}`);
          return app.answer?.(request) ?? real.fetch(request, ctx);
        },
      };
    },
  };
});

/** engine-runtime's three factories as the entry reads them by name, stood in for here (HB3-4). */
const runtime = vi.hoisted(() => ({
  jobDeps: null as PollTallyJobDeps | null,
  tallied: [] as string[],
  outcome: { outcome: 'done', step: null } as PollTallyOutcome,
  stepNames: [] as string[][],
  holdingConfig: null as (() => Promise<unknown>) | null,
}));
vi.mock('@prix/runtime/social/index', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  type Job = { name: string; run(now: Date): Promise<SocialJobOutcome> };
  const realStep = actual.runSocialStep as (jobs: readonly Job[], now: Date) => Promise<unknown>;
  return {
    ...actual,
    createPollTallyJob: (deps: PollTallyJobDeps): Job => {
      runtime.jobDeps = deps;
      return { name: 'poll_tally', run: async () => 'idle' };
    },
    tallyPoll: async (_deps: PollTallyJobDeps, poll: HolderPoll): Promise<PollTallyOutcome> => {
      runtime.tallied.push(poll.id);
      return runtime.outcome;
    },
    runSocialStep: (jobs: readonly Job[], now: Date) => {
      runtime.stepNames.push(jobs.map((job) => job.name));
      return realStep(jobs, now);
    },
  };
});
vi.mock('@prix/runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createPollHoldingReader: (deps: { config: () => Promise<unknown> }) => {
      runtime.holdingConfig = deps.config;
      return { tiersNow: async () => ({ gatingOn: false, tiers: [], blockNumber: 0 }) };
    },
  };
});

function envWith(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const pass = { limit: async () => ({ success: true }) };
  return {
    ...(baseEnv as unknown as Record<string, unknown>),
    DB: db,
    SITE_ORIGIN: ORIGIN,
    ADMIN_ADDRESSES: ADMIN,
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET: btoa('n'.repeat(32)),
    RATE_SIGN_IN: pass,
    RATE_WRITE: pass,
    RATE_READ: pass,
    SOCIAL_ENABLED: 'true',
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

async function plant(path: string): Promise<void> {
  await caches.default.put(
    `${ORIGIN}${path}`,
    new Response(MARKER, { headers: { 'Cache-Control': 'public, max-age=30' } }),
  );
}

async function stored(path: string): Promise<string | null> {
  const hit = await caches.default.match(`${ORIGIN}${path}`);
  return hit === undefined ? null : hit.text();
}

/** The poll's routes as api-core will answer them, so that this file tests the ENTRY alone. */
function answerPolls(request: Request): Response | null {
  const url = new URL(request.url);
  const json = (body: unknown, status = 200, cache = 'no-store'): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
    });
  if (url.pathname === POLLS_PATH) return json({ polls: [], minTokens: 10_000 }, 200, 'public, max-age=30');
  if (url.pathname === '/api/polls/me') return json({ pollId: null, option: null, canVote: false, refusal: null });
  if (/\/vote$/.test(url.pathname)) {
    return url.searchParams.has('refuse') ? json({ error: 'poll_closed' }, 409) : json({ pollId: 'p', option: 'o' });
  }
  if (/\/tally$/.test(url.pathname)) return json({ outcome: url.searchParams.get('outcome') ?? 'done', step: null });
  return null;
}

beforeEach(async () => {
  app.extras = null;
  app.calls = [];
  app.answer = answerPolls;
  runtime.tallied = [];
  runtime.stepNames = [];
  for (const path of [POLLS_PATH, `${POLLS_PATH}/me`, `${POLLS_PATH}/status`])
    await caches.default.delete(`${ORIGIN}${path}`);
});

describe('apps/api/wrangler.jsonc', () => {
  it('keeps POLLS_ENABLED "false" until the gates hold', () => {
    expect(wranglerText).toMatch(/"POLLS_ENABLED": "false"/);
  });

  it('keeps traces off: logs only, because the bot token is in the path of every Telegram URL', () => {
    expect(wranglerText).not.toMatch(/"traces"\s*:\s*\{[^}]*"enabled"\s*:\s*true/);
    expect(wranglerText).toMatch(/Logs only, never traces/);
  });
});

describe('POLLS_ENABLED', () => {
  it('is on only while it reads exactly "true"', () => {
    expect(pollsSwitchOn('true')).toBe(true);
    for (const value of [undefined, '', 'false', 'TRUE', ' true', 'true ', '1', 'on']) {
      expect(pollsSwitchOn(value), String(value)).toBe(false);
    }
  });

  for (const [value, on] of [
    [undefined, false],
    ['false', false],
    ['True', false],
    ['true', true],
  ] as const) {
    it(`hands the app polls deps with pollsEnabled ${on} while it reads ${JSON.stringify(value)}`, async () => {
      await call(envWith(value === undefined ? {} : { POLLS_ENABLED: value }), '/api/health');
      const polls = (app.extras as { polls?: PollApiDeps }).polls;
      expect(polls).toBeDefined();
      expect(polls?.pollsEnabled).toBe(on);
      expect(polls?.ownerHolds).toBeDefined();
    });
  }

  it('hands the app the tier-1 threshold from the token configuration and the tally that takes the job’s path', async () => {
    await call(envWith(), '/api/health');
    const polls = (app.extras as { polls: PollApiDeps }).polls;
    expect(await polls.tierOnePpm()).toBeGreaterThan(0);
    const poll = HOLDER_POLLS[0] as HolderPoll;
    runtime.outcome = { outcome: 'open', step: null };
    expect(await polls.tally(poll)).toEqual({ outcome: 'open', step: null });
    expect(runtime.tallied).toEqual([poll.id]);
  });
});

describe('the cache of GET /api/polls', () => {
  it('stores a miss under the path alone and serves every query and a session cookie from it', async () => {
    const env = envWith({ POLLS_ENABLED: 'true' });
    const first = await call(env, `${POLLS_PATH}?junk=1`);
    expect(first.status).toBe(200);
    expect(await stored(POLLS_PATH)).toBe(await first.text());
    await plant(POLLS_PATH);
    app.calls = [];
    expect(await (await call(env, `${POLLS_PATH}?x=2`)).text()).toBe(MARKER);
    expect(await (await call(env, POLLS_PATH, { headers: { Cookie: `${SESSION_COOKIE}=abc` } })).text()).toBe(MARKER);
    expect(app.calls).toEqual([]);
  });

  it('never stores /api/polls/me nor serves it from the cache', async () => {
    const env = envWith({ POLLS_ENABLED: 'true' });
    await plant(`${POLLS_PATH}/me`);
    expect(await (await call(env, `${POLLS_PATH}/me`)).text()).not.toBe(MARKER);
  });

  it('answers a HEAD with 405 and Allow: GET when nothing is cached, without the route, while the switch is on', async () => {
    const env = envWith({ POLLS_ENABLED: 'true' });
    const response = await call(env, POLLS_PATH, { method: 'HEAD' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(app.calls).toEqual([]);
    await plant(POLLS_PATH);
    const hit = await call(env, POLLS_PATH, { method: 'HEAD' });
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe('');
    expect(app.calls).toEqual([]);
  });

  it('hands a HEAD to the app while the switch is off', async () => {
    await call(envWith({ POLLS_ENABLED: 'false' }), POLLS_PATH, { method: 'HEAD' });
    expect(app.calls).toEqual([`HEAD ${POLLS_PATH}`]);
  });

  it('drops the stored read after a vote that answered 200 and after a tally that answered done, never otherwise', async () => {
    const env = envWith({ POLLS_ENABLED: 'true' });
    const post = { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } };
    await plant(POLLS_PATH);
    await call(env, '/api/polls/model-war-2-strategy/vote?refuse=1', post);
    expect(await stored(POLLS_PATH)).toBe(MARKER);
    await call(env, '/api/admin/polls/model-war-2-strategy/tally?outcome=already', post);
    expect(await stored(POLLS_PATH)).toBe(MARKER);
    await call(env, '/api/polls/model-war-2-strategy/vote', post);
    expect(await stored(POLLS_PATH)).toBeNull();
    await plant(POLLS_PATH);
    await call(env, '/api/admin/polls/model-war-2-strategy/tally?outcome=done', post);
    expect(await stored(POLLS_PATH)).toBeNull();
  });

  it('pollsDropRead: only a POST of the vote with 200, and of the tally with 200 and done', () => {
    expect(pollsDropRead('POST', '/api/polls/p/vote', 200, null)).toBe(true);
    expect(pollsDropRead('POST', '/api/polls/p/vote', 409, null)).toBe(false);
    expect(pollsDropRead('GET', '/api/polls/p/vote', 200, null)).toBe(false);
    expect(pollsDropRead('POST', '/api/polls/p/x/vote', 200, null)).toBe(false);
    expect(pollsDropRead('POST', '/api/admin/polls/p/tally', 200, 'done')).toBe(true);
    for (const outcome of ['already', 'open', 'waiting', 'failed', null]) {
      expect(pollsDropRead('POST', '/api/admin/polls/p/tally', 200, outcome)).toBe(false);
    }
  });
});

describe('poll_tally in the social step', () => {
  it('stands before room_picture_sweep, with room_prune last, and is built with the admin and house lists', async () => {
    await runCron(SOCIAL_CRON, envWith({ HOUSE_OWNERS: '0x00000000000000000000000000000000000000e1' }) as never);
    const names = runtime.stepNames.at(-1) ?? [];
    expect(names.at(-1)).toBe('room_prune');
    expect(names).toContain('poll_tally');
    const sweepAt = names.indexOf('room_picture_sweep');
    if (sweepAt >= 0) expect(names.indexOf('poll_tally')).toBeLessThan(sweepAt);
    // With the second holders wave merged, the lounge's sweep stands between poll_tally and room_picture_sweep
    // (docs/contracts/phase-6-holders-2.md section 4.6): after poll_tally come exactly these, as present.
    const after = ['holders_lounge_sweep', 'room_picture_sweep', 'room_prune'].filter((name) => names.includes(name));
    expect(names.slice(names.indexOf('poll_tally') + 1)).toEqual(after);
    expect(runtime.jobDeps?.adminAddresses).toEqual([ADMIN]);
    expect(runtime.jobDeps?.houseOwners).toEqual(['0x00000000000000000000000000000000000000e1']);
    expect(await runtime.holdingConfig?.()).toMatchObject({ thresholdsPpm: expect.any(Array) });
  });
});

describe("the tally's delay d (H3-SEC-3)", () => {
  async function reference(secret: string, pollId: string): Promise<number> {
    const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
    const keyBytes = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(POLL_TALLY_DELAY_LABEL),
      },
      material,
      256,
    );
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(pollId)));
    return (((mac[0] ?? 0) << 8) | (mac[1] ?? 0)) % 3600;
  }

  it('is HMAC-SHA-256 of the poll id under the HKDF key of NONCE_SECRET with the label, modulo 3,600', async () => {
    const secret = btoa('n'.repeat(32));
    const delay = createTallyDelay(secret);
    for (const id of ['model-war-2-strategy', 'other-poll']) {
      const d = await delay(id);
      expect(d).toBe(await reference(secret, id));
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(3600);
    }
    expect(await createTallyDelay(btoa('m'.repeat(32)))('model-war-2-strategy')).toBe(
      await reference(btoa('m'.repeat(32)), 'model-war-2-strategy'),
    );
  });
});

describe('readTelegram (H2-SEC-6)', () => {
  const secret = 'a'.repeat(64);
  it('builds telegram from the token and the secret with botUsername "" while the username is empty', () => {
    expect(
      readTelegram({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_USERNAME: '' }),
    ).toEqual({
      config: { botUsername: '', webhookSecret: secret },
      token: 't',
    });
    expect(
      readTelegram({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_USERNAME: '@PrixBot' })
        ?.config.botUsername,
    ).toBe('PrixBot');
  });

  it('is null without the token or with a secret outside Telegram’s alphabet', () => {
    expect(
      readTelegram({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_BOT_USERNAME: 'x' }),
    ).toBeNull();
    expect(
      readTelegram({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 'short', TELEGRAM_BOT_USERNAME: 'x' }),
    ).toBeNull();
    expect(
      readTelegram({
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_WEBHOOK_SECRET: `${'a'.repeat(40)}!`,
        TELEGRAM_BOT_USERNAME: 'x',
      }),
    ).toBeNull();
  });
});

describe("the webhook's watch at the watchdog's minute 13 (H3-SEC-8)", () => {
  const at = new Date('2026-10-16T13:13:00.000Z');
  function watched(url: string | null | Error) {
    const marks: string[] = [];
    const events: string[] = [];
    const port = {
      getWebhookInfo: async () => {
        if (url instanceof Error) throw url;
        return url === null ? null : { url, pendingUpdateCount: 0, lastErrorMessage: null };
      },
    };
    return { port, watch: { markMoved: async (time: string) => void marks.push(time) }, marks, events };
  }

  it('marks the watch and logs telegram_webhook_moved with no URL when the url is another', async () => {
    const w = watched('https://evil.example/hook');
    expect(await watchTelegramWebhook(w.port, w.watch, at, (e) => w.events.push(e))).toBe('moved');
    expect(w.marks).toEqual([at.toISOString()]);
    expect(w.events).toEqual(['telegram_webhook_moved']);
  });

  it('changes nothing and logs nothing for its own url or a null answer', async () => {
    for (const url of [TELEGRAM_WEBHOOK_URL, null]) {
      const w = watched(url);
      await watchTelegramWebhook(w.port, w.watch, at, (e) => w.events.push(e));
      expect(w.marks).toEqual([]);
      expect(w.events).toEqual([]);
    }
  });

  it('never throws', async () => {
    const w = watched(new Error('https://api.telegram.org/botSECRET/getWebhookInfo'));
    expect(await watchTelegramWebhook(w.port, w.watch, at, (e) => w.events.push(e))).toBe('unknown');
    expect(w.events.join(' ')).not.toContain('SECRET');
  });
});
