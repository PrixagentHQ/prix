import {
  agentNameKey,
  agentPublicSchema,
  agentResponseSchema,
  leagueResponseSchema,
  MAX_AGENTS_OPEN,
  MAX_AGENTS_PRO,
  MAX_BODY_BYTES,
  MAX_PROMPT_CHANGES_PER_DAY,
  meResponseSchema,
  PROMPT_MAX,
  PROMPT_MAX_BYTES,
} from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api, Client } from '../support/api.ts';
import {
  ADMIN_WALLET,
  createApi,
  expectError,
  expectNoStore,
  expectShape,
  PROMPT,
  TEST_API_KEY,
} from '../support/api.ts';
import { testWallet } from '../support/eth.ts';
import { SEASON_1, startingPortfolio, startingStats, testId } from '../support/fixtures.ts';

/**
 * Agents, from docs/CONTRACTS.md sections 4 and 15: creating one, every refusal, what an
 * owner may change, the caps of revision 3, and the rule that nothing in a request is trusted
 * for a score, a rank or a balance.
 */

const wallet = testWallet(1);
const other = testWallet(2);

describe('POST /api/agents', () => {
  let api: Api;
  let client: Client;
  beforeEach(async () => {
    api = createApi();
    client = await api.signedIn(wallet);
  });

  const open = (name = 'Slow Compounder') => ({ name, prompt: PROMPT, division: 'open' });

  it('creates an Open agent with the starting portfolio and starting stats', async () => {
    const reply = await client.post('/api/agents', open());
    const { agent } = expectShape(agentResponseSchema, reply, 201);
    expectNoStore(reply);
    expect(agent).toMatchObject({
      name: 'Slow Compounder',
      division: 'open',
      status: 'active',
      pausedReason: null,
      hidden: false,
      prompt: PROMPT,
      promptPublic: false,
      summary: null,
      summaryStatus: 'pending',
      modelKeyId: null,
      createdAt: api.now().toISOString(),
      lastDecision: null,
    });

    const stored = await api.store.getAgent(agent.id);
    expect(stored).toMatchObject({
      owner: wallet.address,
      nameKey: agentNameKey('Slow Compounder'),
      division: 'open',
      // The strategy is as old as the agent, and it has not been changed yet.
      strategyChangedAt: api.now().toISOString(),
      promptChangeDay: null,
      promptChangeCount: 0,
    });
    expect(await api.store.getPortfolio(agent.id, SEASON_1.id)).toEqual({
      portfolio: startingPortfolio(),
      stats: startingStats(),
      lastTickId: null,
      rank: null,
      official: null,
    });
  });

  it('shows the new agent to its owner in GET /api/me, with the private prompt', async () => {
    const created = (await client.post('/api/agents', open())).json.agent;
    const me = expectShape(meResponseSchema, await client.get('/api/me'));
    expect(me.agent).toEqual(created);
    expect(me.agent?.prompt).toBe(PROMPT);
  });

  it('puts the new agent on the league at once, without a rank', async () => {
    const created = (await client.post('/api/agents', open())).json.agent;
    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open'));
    expect(league.state).toBeNull();
    expect(league.rows).toEqual([
      {
        rank: null,
        unrankedReason: null,
        agentId: created.id,
        name: 'Slow Compounder',
        seasonReturnBps: 0,
        maxDrawdownBps: 0,
        tradeCount: 0,
        tradingDays: 0,
        equityMicro: 10_000_000_000,
        spark: [],
        lastStatus: null,
        // Revision 5: what the agent is. Its summary is not written yet, and no wallet is a house wallet here.
        summary: null,
        createdAt: created.createdAt,
        house: false,
        // Section 17.2: before its first row an agent holds cash only.
        topHoldings: [],
        cashWeightBps: 10_000,
        // Phase 6: the official figures, null in a v1 season.
        scoreMilli: null,
        confidence: null,
        scoredDay: null,
      },
    ]);
    expect((await api.client().get('/api/league?division=pro')).json.rows).toEqual([]);
  });

  it('gives the new agent a public page that does not show the prompt', async () => {
    const created = (await client.post('/api/agents', open())).json.agent;
    const reply = await api.client().get(`/api/agents/${created.id}`);
    const page = expectShape(agentPublicSchema, reply);
    expect(page).toMatchObject({
      id: created.id,
      name: 'Slow Compounder',
      division: 'open',
      model: { kind: 'house' },
      status: 'active',
      prompt: null,
      summary: null,
      summaryStatus: 'pending',
      rank: null,
      unrankedReason: null,
      rankedCount: 0,
      holdings: [],
      cashMicro: 10_000_000_000,
      cashWeightBps: 10_000,
      asOfTickId: null,
      decisions: [],
      method: 'v1',
      scoreMilli: null,
      confidence: null,
      scoredDay: null,
      stats: startingStats(),
      season: SEASON_1,
    });
    expect(reply.text).not.toContain(PROMPT);
    // The owner is shown shortened, never in full.
    expect(reply.text).not.toContain(wallet.address);
    expect(page.ownerShort.toLowerCase().startsWith(wallet.address.slice(0, 6))).toBe(true);
    expect(page.ownerShort.toLowerCase().endsWith(wallet.address.slice(-4))).toBe(true);
    expect(page.ownerShort.length).toBeLessThan(20);
  });

  it('keeps a prompt exactly as it was written, markup and line breaks included', async () => {
    const prompt = 'Buy <b>quality</b> & hold.\n\tSell only when a holding doubles. <script>alert(1)</script>';
    const reply = await client.post('/api/agents', { ...open(), prompt });
    expect(reply.status).toBe(201);
    expect(reply.json.agent.prompt).toBe(prompt);
    expect((await client.get('/api/me')).json.agent.prompt).toBe(prompt);
  });

  it('allows one agent per wallet', async () => {
    expect((await client.post('/api/agents', open('First Agent'))).status).toBe(201);
    expectError(await client.post('/api/agents', open('Second Agent')), 409, 'owner_has_agent');
    expect(api.store.agents.size).toBe(1);
  });

  it('creates one agent when a wallet sends two requests at once', async () => {
    const replies = await Promise.all([
      client.post('/api/agents', open('First Agent')),
      client.post('/api/agents', open('Second Agent')),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect(api.store.agents.size).toBe(1);
    expect(api.store.portfolios.size).toBe(1);
  });

  it.each([
    'slow compounder',
    'SLOW COMPOUNDER',
    'Slow-Compounder',
    'slow.compounder',
    'S l o w Compounder',
    'Slow_Compounder',
  ])(
    'refuses the name "%s" when "Slow Compounder" exists: names differ by more than case and punctuation',
    async (name) => {
      expect((await client.post('/api/agents', open())).status).toBe(201);
      const second = await api.signedIn(other);
      expectError(await second.post('/api/agents', open(name)), 409, 'name_taken');
      expect(api.store.agents.size).toBe(1);
    },
  );

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['markup', '<b>Agent</b>'],
    ['a leading space', ' Agent One'],
    ['double spaces', 'Agent  One'],
    ['letters outside ASCII', 'Agént One'],
    ['a look-alike of the product', 'Prix Official'],
    ['a look-alike of staff', 'Agent Admin'],
    ['the product name', 'PRIX'],
    ['a reserved partner name', 'Robinhood'],
    ['a reserved name with punctuation', 'r.o.b.i.n.h.o.o.d'],
    ['only punctuation between two letters', 'a._-b'],
  ])('refuses a name that is %s as invalid input on the field "name"', async (_why, name) => {
    const reply = await client.post('/api/agents', open(name));
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('name');
    expect(api.store.agents.size).toBe(0);
  });

  it.each([
    ['too short', 'Buy low.'],
    ['too long', 'a'.repeat(PROMPT_MAX + 1)],
    ['carrying a control character', `${PROMPT}\u0000`],
    ['carrying an escape character', `${PROMPT}\u001b[31m`],
  ])('refuses a prompt that is %s as invalid input on the field "prompt"', async (_why, prompt) => {
    const reply = await client.post('/api/agents', { ...open(), prompt });
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('prompt');
    expect(api.store.agents.size).toBe(0);
  });

  it('accepts a prompt of exactly the largest size', async () => {
    const reply = await client.post('/api/agents', { ...open(), prompt: 'a'.repeat(PROMPT_MAX) });
    expect(reply.status).toBe(201);
  });

  it('caps a prompt in bytes as well as in characters', async () => {
    // 1,500 characters of three bytes each: inside PROMPT_MAX, over PROMPT_MAX_BYTES.
    const heavy = '\u20ac'.repeat(1_500);
    expect(heavy.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(new TextEncoder().encode(heavy).length).toBeGreaterThan(PROMPT_MAX_BYTES);
    const reply = await client.post('/api/agents', { ...open(), prompt: heavy });
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('prompt');
    expect(api.store.agents.size).toBe(0);
    // 1,300 such characters are 3,900 bytes: allowed.
    expect((await client.post('/api/agents', { ...open(), prompt: '\u20ac'.repeat(1_300) })).status).toBe(201);
  });

  it('refuses a prompt with characters that reorder text on screen', async () => {
    const reply = await client.post('/api/agents', { ...open(), prompt: `${PROMPT} \u202eevil` });
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('prompt');
  });

  it('refuses a body larger than the limit before it is parsed', async () => {
    // Valid JSON of a valid shape, apart from its size: an oversized body is refused whatever it holds.
    const padded = JSON.stringify({ ...open(), prompt: PROMPT }).replace('{', `{${' '.repeat(MAX_BODY_BYTES)}`);
    expect(new TextEncoder().encode(padded).length).toBeGreaterThan(MAX_BODY_BYTES);
    expectError(await client.post('/api/agents', undefined, { rawBody: padded }), 400, 'invalid_input');
    // Not even valid JSON, and far over the limit.
    expectError(
      await client.post('/api/agents', undefined, { rawBody: 'x'.repeat(MAX_BODY_BYTES * 4) }),
      400,
      'invalid_input',
    );
    expect(api.store.agents.size).toBe(0);
    // The same request without the padding is accepted.
    expect((await client.post('/api/agents', open())).status).toBe(201);
  });

  it.each([
    ['rank', 1],
    ['seasonReturnBps', 9_999],
    ['equityMicro', 99_000_000_000],
    ['cashMicro', 99_000_000_000],
    ['portfolio', { cashMicro: 99_000_000_000, holdings: {} }],
    ['stats', { seasonReturnBps: 9_999 }],
    ['holdings', { NVDA: 1_000_000_000 }],
    ['tier', 'gold'],
    ['owner', other.address],
    ['id', testId('agent', 1)],
    ['status', 'active'],
    ['hidden', false],
    ['summary', 'The best agent in the league.'],
    ['summaryStatus', 'ready'],
    ['promptPublic', true],
    ['createdAt', '2020-01-01T00:00:00.000Z'],
    ['seasonId', SEASON_1.id],
  ])('refuses a request that claims "%s": the server decides, the client does not', async (field, value) => {
    const reply = await client.post('/api/agents', { ...open(), [field]: value });
    expectError(reply, 400, 'invalid_input');
    expect(api.store.agents.size).toBe(0);
    expect(api.store.portfolios.size).toBe(0);
  });

  it('refuses a division it does not know, and a missing one', async () => {
    expectError(await client.post('/api/agents', { ...open(), division: 'elite' }), 400, 'invalid_input');
    expectError(await client.post('/api/agents', { name: 'Slow Compounder', prompt: PROMPT }), 400, 'invalid_input');
    expect(api.store.agents.size).toBe(0);
  });

  it('refuses an Open agent with a model key and a Pro agent without one', async () => {
    const withKey = await client.post('/api/agents', { ...open(), modelKeyId: testId('key', 1) });
    expectError(withKey, 400, 'invalid_input');
    expect(withKey.json.error.field).toBe('modelKeyId');
    const withoutKey = await client.post('/api/agents', { ...open(), division: 'pro' });
    expectError(withoutKey, 400, 'invalid_input');
    expect(withoutKey.json.error.field).toBe('modelKeyId');
    expect(api.store.agents.size).toBe(0);
  });

  it("answers 404 for a Pro agent that names a key which is not the wallet's", async () => {
    const reply = await client.post('/api/agents', { ...open(), division: 'pro', modelKeyId: testId('key', 77) });
    expectError(reply, 404, 'not_found');
    expect(api.store.agents.size).toBe(0);
  });

  it('answers 409 league_full when the Open division has as many agents as it takes', async () => {
    expect(MAX_AGENTS_OPEN).toBe(200);
    for (let n = 1; n <= MAX_AGENTS_OPEN - 1; n += 1) await api.seedAgent({ n });
    // One place is left.
    expect((await client.post('/api/agents', open('Last One In'))).status).toBe(201);
    const late = await api.signedIn(other);
    const reply = await late.post('/api/agents', open('One Too Many'));
    expectError(reply, 409, 'league_full');
    expect(api.store.agents.size).toBe(MAX_AGENTS_OPEN);
    expect(api.store.portfolios.size).toBe(MAX_AGENTS_OPEN);
    expect((await late.get('/api/me')).json.agent).toBeNull();
    // The name was not taken by the refused request.
    expect([...api.store.agents.values()].some((agent) => agent.name === 'One Too Many')).toBe(false);
  });

  it('answers 409 league_full for the Pro division on its own, smaller cap', async () => {
    expect(MAX_AGENTS_PRO).toBe(50);
    for (let n = 1; n <= MAX_AGENTS_PRO; n += 1) await api.seedAgent({ n, division: 'pro' });
    const keyId = (
      await client.post('/api/model-keys', { provider: 'openai', model: 'gpt-test-1', apiKey: TEST_API_KEY })
    ).json.modelKey.id;
    const pro = await client.post('/api/agents', { ...open('Own Model'), division: 'pro', modelKeyId: keyId });
    expectError(pro, 409, 'league_full');
    expect(api.store.agents.size).toBe(MAX_AGENTS_PRO);
    // A full Pro division does not close the Open one.
    expect((await client.post('/api/agents', open('Open Instead'))).status).toBe(201);
  });

  it('counts paused agents toward the cap, and a hidden agent frees its seat (section 15)', async () => {
    for (let n = 1; n < MAX_AGENTS_OPEN; n += 1) {
      await api.seedAgent({ n, overrides: { status: 'paused', pausedReason: 'owner' } });
    }
    await api.seedAgent({ n: MAX_AGENTS_OPEN, overrides: { hidden: true } });
    expectShape(agentResponseSchema, await client.post('/api/agents', open()), 201);
  });

  it('refuses an agent when paused agents fill the cap', async () => {
    for (let n = 1; n <= MAX_AGENTS_OPEN; n += 1) {
      await api.seedAgent({ n, overrides: { status: 'paused', pausedReason: 'owner' } });
    }
    expectError(await client.post('/api/agents', open()), 409, 'league_full');
  });

  it('takes the cap from the server, whatever a request claims', async () => {
    for (let n = 1; n <= MAX_AGENTS_OPEN; n += 1) await api.seedAgent({ n });
    const reply = await client.post('/api/agents', open(), {
      headers: { 'X-Max-Agents': '100000', 'X-League-Full': 'false' },
    });
    expectError(reply, 409, 'league_full');
    expectError(await client.post('/api/agents', { ...open(), maxInDivision: 100_000 }), 400, 'invalid_input');
  });

  it.each([
    ['not JSON', '{"name": "Slow Compounder", '],
    ['an array', '[]'],
    ['a string', '"agent"'],
    ['null', 'null'],
    ['empty', ''],
  ])('refuses a body that is %s as invalid input', async (_why, rawBody) => {
    expectError(await client.post('/api/agents', undefined, { rawBody }), 400, 'invalid_input');
    expect(api.store.agents.size).toBe(0);
  });

  it('answers 401 without a session', async () => {
    expectError(await api.client().post('/api/agents', open()), 401, 'unauthorized');
    expect(api.store.agents.size).toBe(0);
  });

  it.each([
    ['no Origin header', { origin: null }],
    ['another origin', { origin: 'https://prix.evil.test' }],
    ['the site origin as a prefix of another host', { origin: 'https://prix.test.evil.test' }],
    ['no content type', { contentType: null }],
    ['a form content type', { contentType: 'application/x-www-form-urlencoded' }],
    ['a text content type', { contentType: 'text/plain' }],
  ])('answers 403 for a signed-in request with %s', async (_why, options) => {
    expectError(await client.post('/api/agents', open(), options), 403, 'forbidden');
    expect(api.store.agents.size).toBe(0);
  });

  it('answers 429 when the write limit of the wallet is reached', async () => {
    api.limiter.denied.add('write');
    expectError(await client.post('/api/agents', open()), 429, 'rate_limited');
    expect(api.limiter.asked).toContainEqual({ rule: 'write', subject: wallet.address });
    expect(api.store.agents.size).toBe(0);
  });

  it('answers 503 when no season is active, and still serves the league of the last season', async () => {
    api.setNow(SEASON_1.endsAt);
    const late = await api.signedIn(other);
    expectError(await late.post('/api/agents', open()), 503, 'no_active_season');
    expect(api.store.agents.size).toBe(0);

    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league'));
    expect(league.season).toEqual(SEASON_1);
    expect(league.seasonEnded).toBe(true);
  });

  it('never returns a stack trace when the database fails', async () => {
    api.store.failing = { method: 'createAgent', times: 1 };
    const reply = await client.post('/api/agents', open());
    expectError(reply, 500, 'internal');
    expect(reply.text).not.toContain('failed on purpose');
    expect(reply.text).not.toContain(PROMPT);
    // The next request works: one failure does not poison the app.
    expect((await client.post('/api/agents', open())).status).toBe(201);
  });
});

describe('PATCH /api/agents/:id', () => {
  let api: Api;
  let client: Client;
  let agentId: string;
  beforeEach(async () => {
    api = createApi();
    client = await api.signedIn(wallet);
    const reply = await client.post('/api/agents', { name: 'Slow Compounder', prompt: PROMPT, division: 'open' });
    expect(reply.status).toBe(201);
    agentId = reply.json.agent.id;
    // The scheduler has written a summary in the meantime.
    await api.store.updateAgent(
      agentId,
      { summary: 'Holds large companies.', summaryStatus: 'ready' },
      api.now().toISOString(),
    );
  });

  const stored = async () => {
    const agent = await api.store.getAgent(agentId);
    if (!agent) throw new Error('the agent is gone');
    return agent;
  };

  it('renames the agent and moves its name key', async () => {
    const reply = await client.patch(`/api/agents/${agentId}`, { name: 'Patient Capital' });
    const { agent } = expectShape(agentResponseSchema, reply);
    expectNoStore(reply);
    expect(agent.name).toBe('Patient Capital');
    expect(await stored()).toMatchObject({ name: 'Patient Capital', nameKey: 'patientcapital' });
    expect((await api.client().get(`/api/agents/${agentId}`)).json.name).toBe('Patient Capital');
    // A rename does not touch the summary.
    expect(agent).toMatchObject({ summary: 'Holds large companies.', summaryStatus: 'ready' });
  });

  it('lets the owner change the punctuation of its own name', async () => {
    const reply = await client.patch(`/api/agents/${agentId}`, { name: 'Slow-Compounder' });
    expect(reply.status).toBe(200);
    expect((await stored()).name).toBe('Slow-Compounder');
  });

  it('refuses a rename to a name another agent has', async () => {
    const second = await api.signedIn(other);
    expect((await second.post('/api/agents', { name: 'Fast Trader', prompt: PROMPT, division: 'open' })).status).toBe(
      201,
    );
    expectError(await client.patch(`/api/agents/${agentId}`, { name: 'fast-trader' }), 409, 'name_taken');
    expect((await stored()).name).toBe('Slow Compounder');
  });

  it('refuses a rename to a reserved name', async () => {
    const reply = await client.patch(`/api/agents/${agentId}`, { name: 'Official Prix' });
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('name');
  });

  it('clears the summary and asks for a new one when the prompt changes', async () => {
    const prompt = 'Hold cash until a company falls by a fifth in a week, then buy it and wait.';
    const reply = await client.patch(`/api/agents/${agentId}`, { prompt });
    const { agent } = expectShape(agentResponseSchema, reply);
    expect(agent).toMatchObject({ prompt, summary: null, summaryStatus: 'pending' });
    expect(await stored()).toMatchObject({ prompt, summary: null, summaryStatus: 'pending' });
    // The public page no longer shows the summary of the old strategy.
    expect((await api.client().get(`/api/agents/${agentId}`)).json).toMatchObject({
      summary: null,
      summaryStatus: 'pending',
      prompt: null,
    });
  });

  describe('the cap on prompt changes', () => {
    const change = (n: number) =>
      client.patch(`/api/agents/${agentId}`, {
        prompt: `Strategy number ${n}: hold cash until a company falls by a fifth.`,
      });

    it(`allows ${MAX_PROMPT_CHANGES_PER_DAY} changes a UTC day, counted on the agent, and answers 429 rate_limited for the next`, async () => {
      for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) expect((await change(n)).status).toBe(200);
      expect(await stored()).toMatchObject({
        promptChangeDay: api.now().toISOString().slice(0, 10),
        promptChangeCount: MAX_PROMPT_CHANGES_PER_DAY,
      });
      const before = await stored();
      const refused = await change(99);
      expectError(refused, 429, 'rate_limited');
      expect(refused.headers.get('retry-after')).not.toBeNull();
      expect(await stored()).toEqual(before);
    });

    it('does not count a change of anything but the prompt, or a prompt sent unchanged', async () => {
      for (let n = 0; n < MAX_PROMPT_CHANGES_PER_DAY + 2; n += 1) {
        expect((await client.patch(`/api/agents/${agentId}`, { promptPublic: n % 2 === 0 })).status).toBe(200);
      }
      expect((await client.patch(`/api/agents/${agentId}`, { prompt: PROMPT })).status).toBe(200);
      expect((await stored()).promptChangeCount).toBe(0);
    });

    it('starts the count again on the next UTC day', async () => {
      for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) await change(n);
      expectError(await change(50), 429, 'rate_limited');
      const next = new Date(api.now().getTime() + 24 * 3_600_000).toISOString();
      api.setNow(next);
      // The session lasts a week, so the owner is still signed in.
      expect((await change(51)).status).toBe(200);
      expect(await stored()).toMatchObject({ promptChangeDay: next.slice(0, 10), promptChangeCount: 1 });
    });

    it('sets the strategy time with every change, so a round that has started does not trade it', async () => {
      const before = (await stored()).strategyChangedAt;
      api.setNow(new Date(api.now().getTime() + 60_000).toISOString());
      expect((await change(1)).status).toBe(200);
      expect((await stored()).strategyChangedAt).toBe(api.now().toISOString());
      expect((await stored()).strategyChangedAt > before).toBe(true);
    });
  });

  it('publishes the full prompt when the owner asks, and hides it again', async () => {
    const page = () => api.client().get(`/api/agents/${agentId}`);
    expect((await page()).json.prompt).toBeNull();
    expect((await client.patch(`/api/agents/${agentId}`, { promptPublic: true })).status).toBe(200);
    expect((await page()).json.prompt).toBe(PROMPT);
    expect((await stored()).summaryStatus).toBe('ready');
    expect((await client.patch(`/api/agents/${agentId}`, { promptPublic: false })).status).toBe(200);
    const hidden = await page();
    expect(hidden.json.prompt).toBeNull();
    expect(hidden.text).not.toContain(PROMPT);
  });

  it('pauses with the reason "owner" and resumes', async () => {
    const paused = await client.patch(`/api/agents/${agentId}`, { paused: true });
    expect(paused.json.agent).toMatchObject({ status: 'paused', pausedReason: 'owner' });
    expect(await stored()).toMatchObject({ status: 'paused', pausedReason: 'owner' });
    const resumed = await client.patch(`/api/agents/${agentId}`, { paused: false });
    expect(resumed.json.agent).toMatchObject({ status: 'active', pausedReason: null });
    expect(await stored()).toMatchObject({ status: 'active', pausedReason: null });
  });

  it('does not let the owner resume an agent that an admin paused', async () => {
    await api.store.updateAgent(agentId, { status: 'paused', pausedReason: 'admin' }, api.now().toISOString());
    const reply = await client.patch(`/api/agents/${agentId}`, { paused: false });
    expect(reply.status).toBeLessThan(500);
    expect(await stored()).toMatchObject({ status: 'paused', pausedReason: 'admin' });
  });

  it('does not let the owner turn an admin pause into an owner pause and then resume', async () => {
    await api.store.updateAgent(agentId, { status: 'paused', pausedReason: 'admin' }, api.now().toISOString());
    await client.patch(`/api/agents/${agentId}`, { paused: true });
    await client.patch(`/api/agents/${agentId}`, { paused: false });
    expect(await stored()).toMatchObject({ status: 'paused', pausedReason: 'admin' });
  });

  it('does not let the owner resume an agent that was paused because its key kept failing, without a new key', async () => {
    await api.store.updateAgent(agentId, { status: 'paused', pausedReason: 'key_failing' }, api.now().toISOString());
    await client.patch(`/api/agents/${agentId}`, { paused: false });
    expect(await stored()).toMatchObject({ status: 'paused', pausedReason: 'key_failing' });
  });

  it("does not let the owner unhide an agent: hidden is the admin's alone", async () => {
    await api.store.updateAgent(agentId, { hidden: true }, api.now().toISOString());
    await client.patch(`/api/agents/${agentId}`, { paused: true });
    await client.patch(`/api/agents/${agentId}`, { paused: false });
    expect((await stored()).hidden).toBe(true);
    expectError(await api.client().get(`/api/agents/${agentId}`), 404, 'not_found');
  });

  it('does not let the owner resume an agent whose key was removed without a new key', async () => {
    await api.store.updateAgent(agentId, { status: 'paused', pausedReason: 'key_removed' }, api.now().toISOString());
    await client.patch(`/api/agents/${agentId}`, { paused: false });
    expect(await stored()).toMatchObject({ status: 'paused', pausedReason: 'key_removed' });
  });

  it.each([
    ['division', 'pro'],
    ['hidden', false],
    ['status', 'active'],
    ['pausedReason', null],
    ['summary', 'Returns 40% a year, guaranteed.'],
    ['summaryStatus', 'ready'],
    ['owner', other.address],
    ['rank', 1],
    ['seasonReturnBps', 9_999],
    ['stats', { seasonReturnBps: 9_999 }],
    ['portfolio', { cashMicro: 99_000_000_000, holdings: {} }],
    ['createdAt', '2020-01-01T00:00:00.000Z'],
  ])('refuses a change of "%s" and changes nothing', async (field, value) => {
    const before = await stored();
    const portfolioBefore = await api.store.getPortfolio(agentId, SEASON_1.id);
    const reply = await client.patch(`/api/agents/${agentId}`, { name: 'Patient Capital', [field]: value });
    expectError(reply, 400, 'invalid_input');
    expect(await stored()).toEqual(before);
    expect(await api.store.getPortfolio(agentId, SEASON_1.id)).toEqual(portfolioBefore);
  });

  it('answers 404 when a Pro agent is pointed at the key of another wallet, and changes nothing', async () => {
    const theirs = await api.signedIn(other);
    const theirKey = (
      await theirs.post('/api/model-keys', { provider: 'openai', model: 'gpt-test-1', apiKey: TEST_API_KEY })
    ).json.modelKey.id;
    const stranger = await api.signedIn(testWallet(3));
    const myKey = (
      await stranger.post('/api/model-keys', { provider: 'openai', model: 'gpt-test-2', apiKey: TEST_API_KEY })
    ).json.modelKey.id;
    const created = await stranger.post('/api/agents', {
      name: 'Own Key Agent',
      prompt: PROMPT,
      division: 'pro',
      modelKeyId: myKey,
    });
    const proId = created.json.agent.id;
    expectError(await stranger.patch(`/api/agents/${proId}`, { modelKeyId: theirKey }), 404, 'not_found');
    expect((await api.store.getAgent(proId))?.modelKeyId).toBe(myKey);
  });

  it('refuses an empty change', async () => {
    expectError(await client.patch(`/api/agents/${agentId}`, {}), 400, 'invalid_input');
  });

  it("answers 404 for a model key that is not the wallet's, and gives an Open agent no key", async () => {
    expectError(await client.patch(`/api/agents/${agentId}`, { modelKeyId: testId('key', 1) }), 404, 'not_found');
    expect((await stored()).modelKeyId).toBeNull();
    // Its own key does not turn an Open agent into one that runs on an owner's model either.
    const keyId = (
      await client.post('/api/model-keys', { provider: 'openai', model: 'gpt-test-1', apiKey: TEST_API_KEY })
    ).json.modelKey.id;
    const reply = await client.patch(`/api/agents/${agentId}`, { modelKeyId: keyId });
    expectError(reply, 400, 'invalid_input');
    expect((await stored()).modelKeyId).toBeNull();
    expect((await api.client().get(`/api/agents/${agentId}`)).json.model).toEqual({ kind: 'house' });
  });

  it('answers 403 to another wallet, and changes nothing', async () => {
    const before = await stored();
    const intruder = await api.signedIn(other);
    for (const body of [
      { name: 'Taken Over' },
      { prompt: `${PROMPT} Changed.` },
      { paused: true },
      { promptPublic: true },
    ]) {
      expectError(await intruder.patch(`/api/agents/${agentId}`, body), 403, 'forbidden');
    }
    expect(await stored()).toEqual(before);
  });

  it('answers 404 to another wallet when the agent is hidden or unknown, as if it were not there', async () => {
    const intruder = await api.signedIn(other);
    await api.store.updateAgent(agentId, { hidden: true }, api.now().toISOString());
    const before = await stored();
    const hidden = await intruder.patch(`/api/agents/${agentId}`, { paused: true });
    expectError(hidden, 404, 'not_found');
    const unknown = await intruder.patch(`/api/agents/${testId('agent', 404)}`, { paused: true });
    expectError(unknown, 404, 'not_found');
    // The same answer for both: a stranger cannot learn that a hidden agent exists.
    expect(hidden.json).toEqual(unknown.json);
    expect(await stored()).toEqual(before);
    // An admin is not the owner either.
    const admin = await api.signedIn(ADMIN_WALLET);
    expectError(await admin.patch(`/api/agents/${agentId}`, { paused: true }), 404, 'not_found');
  });

  it('answers 404 for a malformed id in the path', async () => {
    for (const id of ['1', 'AGENTAAAAAAB', 'agentaaaaaa1', `${agentId}x`, '..%2Fme', "x'%20OR%201=1"]) {
      expectError(await client.patch(`/api/agents/${id}`, { paused: true }), 404, 'not_found');
    }
    expect((await stored()).status).toBe('active');
  });

  it('answers 401 without a session, 403 without the site origin, 404 for an agent that does not exist', async () => {
    expectError(await api.client().patch(`/api/agents/${agentId}`, { paused: true }), 401, 'unauthorized');
    expectError(await client.patch(`/api/agents/${agentId}`, { paused: true }, { origin: null }), 403, 'forbidden');
    expectError(
      await client.patch(`/api/agents/${agentId}`, { paused: true }, { contentType: 'text/plain' }),
      403,
      'forbidden',
    );
    expectError(await client.patch(`/api/agents/${testId('agent', 404)}`, { paused: true }), 404, 'not_found');
    expect((await stored()).status).toBe('active');
  });

  it('answers 429 when the write limit of the wallet is reached', async () => {
    api.limiter.denied.add('write');
    expectError(await client.patch(`/api/agents/${agentId}`, { paused: true }), 429, 'rate_limited');
    expect((await stored()).status).toBe('active');
  });
});
