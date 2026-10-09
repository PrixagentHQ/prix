import type { WarModel } from '@prix/contracts';
import { UNIVERSE_SIZE, WAR_MODELS, warDetailResponseSchema, warListResponseSchema } from '@prix/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createHarness, errorOf, type Harness } from './harness.ts';
import { promptKeys } from './scan.ts';

const STRATEGY = 'Hold the largest companies by weight, keep a tenth in cash, and change little from day to day.';

// The contract admits no model yet (every probe is null). These tests admit three for their run.
const saved = new Map<WarModel, WarModel['probe']>();
beforeEach(() => {
  for (const model of WAR_MODELS) saved.set(model, model.probe);
  for (const id of [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/google/gemma-4-26b-a4b-it',
    'openai/gpt-oss-120b',
  ]) {
    const model = WAR_MODELS.find((entry) => entry.id === id);
    if (model) model.probe = { on: '2026-10-15', valid: 27, of: 27 };
  }
});
afterEach(() => {
  for (const [model, probe] of saved) model.probe = probe;
});

const WORKERS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/google/gemma-4-26b-a4b-it'];

function input(models: string[] = WORKERS) {
  return { title: 'Ten days of the same plan', strategy: STRATEGY, startsOn: '2026-10-21', tradingDays: 10, models };
}

async function admin(h: Harness) {
  return h.signIn(ADMIN);
}

describe('POST /api/social/admin/wars', () => {
  it('creates a scheduled war with frozen rules and answers 201', async () => {
    const h = createHarness();
    const cookie = await admin(h);
    const reply = await h.fetch('POST', '/api/social/admin/wars', { cookie, body: input() });
    expect(reply.status).toBe(201);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const body = warDetailResponseSchema.parse(reply.json);
    expect(body.war).toMatchObject({
      number: 1,
      status: 'scheduled',
      stopReason: null,
      strategy: STRATEGY,
      startsOn: '2026-10-21',
      tradingDays: 10,
      deadlineDay: '2026-11-20',
      method: 'v1',
      systemMessageSha256: null,
    });
    expect(body.war.strategySha256).toMatch(/^[0-9a-f]{64}$/);
    // Section 21: a new war freezes the whole universe, the crypto assets included.
    expect(body.war.rules.universe).toHaveLength(UNIVERSE_SIZE);
    expect(body.war.rules.universe).toEqual(expect.arrayContaining(['BTC', 'ETH']));
    expect(body.entrants.map((e) => [e.slot, e.modelId])).toEqual([
      ['A', WORKERS[0]],
      ['B', WORKERS[1]],
    ]);
    expect(body.entrants[0]).toMatchObject({ probedOn: '2026-10-15', maxOutputTokens: 300, days: 0 });
    expect(body.standings).toHaveLength(2);
    expect(promptKeys(reply.json)).toEqual([]);
  });

  it('refuses a second open war with 409 invalid_input on wars', async () => {
    const h = createHarness();
    const cookie = await admin(h);
    expect((await h.fetch('POST', '/api/social/admin/wars', { cookie, body: input() })).status).toBe(201);
    const second = await h.fetch('POST', '/api/social/admin/wars', { cookie, body: input() });
    expect(second.status).toBe(409);
    expect(errorOf(second)).toMatchObject({ code: 'invalid_input', field: 'wars' });
  });

  it('refuses an unprobed model, and a Groq model while Groq is not configured', async () => {
    const h = createHarness();
    const cookie = await admin(h);
    const unprobed = await h.fetch('POST', '/api/social/admin/wars', {
      cookie,
      body: input([WORKERS[0] as string, '@cf/zai-org/glm-4.7-flash']),
    });
    expect(unprobed.status).toBe(400);
    expect(errorOf(unprobed).code).toBe('invalid_input');
    const groq = await h.fetch('POST', '/api/social/admin/wars', {
      cookie,
      body: input([WORKERS[0] as string, 'openai/gpt-oss-120b']),
    });
    expect(groq.status).toBe(400);
    expect(errorOf(groq)).toMatchObject({ code: 'invalid_input', field: 'models' });

    const configured = createHarness({ groqConfigured: true });
    const ok = await configured.fetch('POST', '/api/social/admin/wars', {
      cookie: await admin(configured),
      body: input([WORKERS[0] as string, 'openai/gpt-oss-120b']),
    });
    expect(ok.status).toBe(201);
    expect(warDetailResponseSchema.parse(ok.json).entrants[1]).toMatchObject({ provider: 'groq', extra: {} });
  });

  it('refuses a start day in the past and a title with a forbidden word', async () => {
    const h = createHarness();
    const cookie = await admin(h);
    const past = await h.fetch('POST', '/api/social/admin/wars', {
      cookie,
      body: { ...input(), startsOn: '2026-10-19' },
    });
    expect(past.status).toBe(400);
    expect(errorOf(past).field).toBe('startsOn');
    const title = await h.fetch('POST', '/api/social/admin/wars', { cookie, body: { ...input(), title: 'Who wins' } });
    expect(title.status).toBe(400);
  });

  it('answers a non-admin exactly as an unknown path, before reading the body', async () => {
    for (const on of [true, false]) {
      const h = createHarness({ on });
      const user = await h.signIn('0x0000000000000000000000000000000000000c01');
      for (const [path, cookie, body] of [
        ['/api/social/admin/wars', undefined, input()],
        ['/api/social/admin/wars', user, input()],
        ['/api/social/admin/wars', user, undefined],
        ['/api/social/admin/wars/warxaaaaaaaa/stop', user, undefined],
        ['/api/social/admin/managers/mgrxaaaaaaaa/hidden', user, { hidden: true }],
      ] as const) {
        const denied = await h.fetch('POST', path, {
          ...(cookie === undefined ? {} : { cookie }),
          ...(body === undefined ? { rawBody: '{not json' } : { body }),
        });
        const unknown = await h.fetch('POST', '/api/social/admin/nothing', {
          ...(cookie === undefined ? {} : { cookie }),
          rawBody: '{}',
        });
        expect(denied.status).toBe(404);
        expect(denied.text).toBe(unknown.text);
        expect([...denied.headers]).toEqual([...unknown.headers]);
      }
      expect(h.social.calls).toEqual([]);
    }
  });

  it('creates a war while the switch is off', async () => {
    const h = createHarness({ on: false });
    const reply = await h.fetch('POST', '/api/social/admin/wars', { cookie: await admin(h), body: input() });
    expect(reply.status).toBe(201);
    expect((await h.fetch('GET', '/api/social/wars')).status).toBe(404);
  });
});

describe('POST /api/social/admin/wars/:id/stop', () => {
  it('stops an open war with reason admin and answers 204', async () => {
    const h = createHarness();
    const cookie = await admin(h);
    const created = warDetailResponseSchema.parse(
      (await h.fetch('POST', '/api/social/admin/wars', { cookie, body: input() })).json,
    );
    const reply = await h.fetch('POST', `/api/social/admin/wars/${created.war.id}/stop`, { cookie });
    expect(reply.status).toBe(204);
    expect(h.social.wars.get(created.war.id)).toMatchObject({ status: 'stopped', stopReason: 'admin' });
    expect((await h.fetch('POST', '/api/social/admin/wars/warzzzzzzzzz/stop', { cookie })).status).toBe(404);
  });
});

describe('GET /api/social/wars and /wars/:id', () => {
  it('lists wars newest first and shows one with its standings, cached 30 s', async () => {
    const h = createHarness();
    const cookie = await admin(h);
    const created = warDetailResponseSchema.parse(
      (await h.fetch('POST', '/api/social/admin/wars', { cookie, body: input() })).json,
    );
    const list = await h.fetch('GET', '/api/social/wars');
    expect(list.headers.get('cache-control')).toBe('public, max-age=30');
    const body = warListResponseSchema.parse(list.json);
    expect(body.wars).toHaveLength(1);
    expect(body.wars[0]).toMatchObject({ id: created.war.id, number: 1, daysDone: 0 });
    expect(body.wars[0]?.entrants).toHaveLength(2);

    const detail = await h.fetch('GET', `/api/social/wars/${created.war.id}`);
    expect(detail.headers.get('cache-control')).toBe('public, max-age=30');
    const war = warDetailResponseSchema.parse(detail.json);
    expect(war.war.id).toBe(created.war.id);
    expect(war.entrants[0]).not.toHaveProperty('portfolio');
    expect(promptKeys(detail.json)).toEqual([]);
    expect((await h.fetch('GET', '/api/social/wars/warzzzzzzzzz')).status).toBe(404);
    expect((await h.fetch('GET', '/api/social/wars/x')).status).toBe(404);
  });
});
