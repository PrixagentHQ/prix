import {
  UNIVERSE_SIZE,
  WAR_DEADLINE_DAYS_PER_TRADING_DAY,
  WAR_MODELS,
  WAR_RULES,
  warDetailResponseSchema,
} from '@prix/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEASON_1, testAddress } from '../support/fixtures.ts';
import { db, resetDb, storesOn } from './support/d1.ts';
import { ADMIN_ADDRESS, createSocialHttp, type SocialHttp } from './support/http.ts';
import { GEMMA, GPT_OSS, LLAMA, MISTRAL, modelById } from './support/war.ts';

/**
 * The admin routes for a Model War (docs/contracts/phase-6-social.md sections 5.3 and 6). No model has
 * passed the probe yet, so `probe` is null for every entry of WAR_MODELS and no war can be created; the
 * tests that create one set `probe` for the models they use, as the operator will, and put it back after.
 */

const plain = storesOn(db);
const TODAY = '2026-10-20';
const PROBE = { on: '2026-10-09', valid: 26, of: 27 };
const STRATEGY =
  'Hold a few large companies in roughly equal parts, and change the portfolio only when the picture clearly changes.';

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const body = (over: Record<string, unknown> = {}) => ({
  title: 'Four models, one strategy',
  strategy: STRATEGY,
  startsOn: '2026-10-21',
  tradingDays: 5,
  models: [LLAMA, GEMMA],
  ...over,
});

let http: SocialHttp;
let admin: string;

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
  http = createSocialHttp(plain, { now: `${TODAY}T12:00:00.000Z` });
  admin = await http.signIn(ADMIN_ADDRESS);
});

const post = (payload: unknown) => http.fetch('POST', '/api/social/admin/wars', { cookie: admin, body: payload });

describe('with the probe of 2026-10-09 (docs/reviews/phase-6-war-models.md)', () => {
  it('admits Gemma and Mistral only: a war that asks for any other model cannot be created', async () => {
    expect(WAR_MODELS.filter((model) => model.probe !== null).map((model) => model.id)).toEqual([GEMMA, MISTRAL]);
    for (const models of [
      [LLAMA, GEMMA],
      [MISTRAL, GPT_OSS],
      [LLAMA, GPT_OSS],
      ['@cf/evil/model', GEMMA],
    ]) {
      const reply = await post(body({ models }));
      expect(reply.status, models.join()).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
    }
    expect((await db.prepare('SELECT count(*) AS n FROM wars').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('with models that passed the probe', () => {
  const before = new Map<string, unknown>();
  beforeAll(() => {
    for (const id of [LLAMA, GEMMA, MISTRAL, GPT_OSS]) {
      before.set(id, modelById(id).probe);
      (modelById(id) as { probe: unknown }).probe = PROBE;
    }
  });
  afterAll(() => {
    for (const id of [LLAMA, GEMMA, MISTRAL, GPT_OSS]) (modelById(id) as { probe: unknown }).probe = before.get(id);
  });

  it('creates a scheduled war: 201, no cache, the rules frozen, the settings of each model, nothing from the request but its words', async () => {
    const reply = await post(body({ models: [LLAMA, GEMMA, MISTRAL] }));
    expect(reply.status, reply.text).toBe(201);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    const detail = warDetailResponseSchema.parse(reply.json);
    expect(detail.war).toMatchObject({
      number: 1,
      title: 'Four models, one strategy',
      status: 'scheduled',
      stopReason: null,
      strategy: STRATEGY,
      startsOn: '2026-10-21',
      tradingDays: 5,
      method: 'v1',
      systemMessageSha256: null,
      promptVersion: null,
      firstTickId: null,
      lastTickId: null,
      endedAt: null,
    });
    expect(detail.war.strategySha256).toBe(await sha256Hex(STRATEGY));
    // The deadline is three calendar days per trading day after the start.
    expect(WAR_DEADLINE_DAYS_PER_TRADING_DAY).toBe(3);
    expect(detail.war.deadlineDay).toBe('2026-11-05');
    // The rules are the war rules plus the universe, taken from the server.
    expect(detail.war.rules).toMatchObject({ ...WAR_RULES });
    // Section 21: a new war freezes the whole universe, the crypto assets included.
    expect(detail.war.rules.universe).toHaveLength(UNIVERSE_SIZE);
    // A new war freezes the universe of its day: since section 23, the five coins after the Stock Tokens.
    expect(detail.war.rules.universe.slice(-5)).toEqual(['BTC', 'ETH', 'BNB', 'HYPE', 'SOL']);
    expect(detail.entrants.map((e) => [e.slot, e.modelId])).toEqual([
      ['A', LLAMA],
      ['B', GEMMA],
      ['C', MISTRAL],
    ]);
    const gemma = detail.entrants[1];
    expect(gemma).toMatchObject({
      provider: 'workers-ai',
      maker: 'Google',
      extra: { chat_template_kwargs: { enable_thinking: false } },
      maxOutputTokens: 300,
      inputNeuronsPerMillion: 9091,
      outputNeuronsPerMillion: 27_273,
      probedOn: PROBE.on,
      days: 0,
    });
    expect(detail.standings.map((s) => s.rank)).toEqual([null, null, null]);
    expect(detail.rows).toEqual([]);
    // The war is stored.
    const list = await http.fetch('GET', '/api/social/wars');
    expect(list.json.wars.map((x: { id: string }) => x.id)).toEqual([detail.war.id]);
  });

  it('allows one war at a time: a second is 409 invalid_input on wars, until the first is stopped', async () => {
    const first = await post(body());
    expect(first.status).toBe(201);
    const second = await post(body({ title: 'Another experiment' }));
    expect(second.status).toBe(409);
    expect(second.json.error).toMatchObject({ code: 'invalid_input', field: 'wars' });
    expect((await db.prepare('SELECT count(*) AS n FROM wars').first<{ n: number }>())?.n).toBe(1);

    const stop = await http.fetch('POST', `/api/social/admin/wars/${first.json.war.id}/stop`, { cookie: admin });
    expect(stop.status).toBe(204);
    expect(stop.headers.get('Cache-Control')).toBe('no-store');
    const stopped = warDetailResponseSchema.parse(
      (await http.fetch('GET', `/api/social/wars/${first.json.war.id}`)).json,
    );
    expect(stopped.war).toMatchObject({ status: 'stopped', stopReason: 'admin' });
    expect(stopped.war.endedAt).not.toBeNull();
    // Stopping again changes nothing; a war that has ended stays as it ended.
    const before = JSON.stringify((await http.fetch('GET', `/api/social/wars/${first.json.war.id}`)).json);
    expect(
      (await http.fetch('POST', `/api/social/admin/wars/${first.json.war.id}/stop`, { cookie: admin })).status,
    ).toBe(204);
    expect(JSON.stringify((await http.fetch('GET', `/api/social/wars/${first.json.war.id}`)).json)).toBe(before);

    const third = await post(body({ title: 'Another experiment', models: [GEMMA, MISTRAL] }));
    expect(third.status, third.text).toBe(201);
    expect(third.json.war.number).toBe(2);
    // Newest first in the list.
    expect((await http.fetch('GET', '/api/social/wars')).json.wars.map((w: { number: number }) => w.number)).toEqual([
      2, 1,
    ]);
  });

  it('leaves a completed war as it is when it is stopped', async () => {
    const made = await post(body());
    await db
      .prepare("UPDATE wars SET status = 'complete', body = json_set(body, '$.status', 'complete') WHERE id = ?1")
      .bind(made.json.war.id)
      .run();
    expect(
      (await http.fetch('POST', `/api/social/admin/wars/${made.json.war.id}/stop`, { cookie: admin })).status,
    ).toBe(204);
    expect((await http.fetch('GET', `/api/social/wars/${made.json.war.id}`)).json.war.status).toBe('complete');
    expect((await http.fetch('POST', '/api/social/admin/wars/aaaaaaaaaaaz/stop', { cookie: admin })).status).toBe(404);
    expect((await http.fetch('POST', '/api/social/admin/wars/nope/stop', { cookie: admin })).status).toBe(404);
  });

  it('reads a strict body and refuses titles, strategies, counts and models that the document forbids', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['an extra key', { owner: ADMIN_ADDRESS }],
      ['a model parameter', { temperature: 0 }],
      ['a model endpoint', { baseUrl: 'https://example.com/v1' }],
      ['a title with "best"', { title: 'The best model of the season' }],
      ['a title with "winner"', { title: 'Find the winner' }],
      ['a title that gives advice', { title: 'You should buy these' }],
      ['a title that is too short', { title: 'ab' }],
      ['a strategy that is too short', { strategy: 'Hold.' }],
      ['four trading days', { tradingDays: 4 }],
      ['twenty-one trading days', { tradingDays: 21 }],
      ['one model', { models: [LLAMA] }],
      ['five models', { models: [LLAMA, GEMMA, MISTRAL, GPT_OSS, '@cf/zai-org/glm-4.7-flash'] }],
      ['a model twice', { models: [LLAMA, LLAMA] }],
      ['a model that is not on the list', { models: [LLAMA, 'gpt-5'] }],
      ['a bad start day', { startsOn: '21 October' }],
      ['a start day in the past', { startsOn: '2026-10-19' }],
    ];
    for (const [label, over] of bad) {
      const reply = await post(body(over));
      expect(reply.status, label).toBe(400);
      expect(reply.json.error.code, label).toBe('invalid_input');
    }
    expect((await post(body({ startsOn: TODAY }))).status).toBe(201);
    expect((await db.prepare('SELECT count(*) AS n FROM wars').first<{ n: number }>())?.n).toBe(1);
  });

  it('refuses a Groq model without its key, and takes one with it', async () => {
    http.groq.configured = false;
    const refused = await post(body({ models: [LLAMA, GPT_OSS] }));
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatchObject({ code: 'invalid_input', field: 'models' });
    http.groq.configured = true;
    const taken = await post(body({ models: [LLAMA, GPT_OSS] }));
    expect(taken.status, taken.text).toBe(201);
    expect(taken.json.entrants.map((e: { provider: string }) => e.provider)).toEqual(['workers-ai', 'groq']);
    expect(taken.text).not.toMatch(/gsk_/);
  });

  it('is for a signed-in admin who writes from the site: a foreign origin or a missing media type is refused', async () => {
    const foreign = await http.fetch('POST', '/api/social/admin/wars', {
      cookie: admin,
      body: body(),
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).not.toBe(201);
    const noType = await http.fetch('POST', '/api/social/admin/wars', {
      cookie: admin,
      body: body(),
      contentType: 'text/plain',
    });
    expect(noType.status).not.toBe(201);
    expect((await db.prepare('SELECT count(*) AS n FROM wars').first<{ n: number }>())?.n).toBe(0);
    void testAddress;
  });
});
