import { agentResponseSchema, MAX_PROMPT_CHANGES_PER_DAY, meResponseSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api, Client } from '../support/api.ts';
import { createApi, expectError, expectShape, OTHER_API_KEY, PROMPT, TEST_API_KEY } from '../support/api.ts';
import { testWallet } from '../support/eth.ts';

/**
 * Two rules of docs/CONTRACTS.md section 15 that protect the ranking.
 *
 * The prompt-change cap: a strategy may be changed MAX_PROMPT_CHANGES_PER_DAY times in one
 * UTC day, counted in `promptChangeDay` and `promptChangeCount`, and the next change is 429.
 *
 * `strategyChangedAt`: set when an agent is created, when its prompt or model key changes and
 * when it is resumed. The scheduler compares it with the time of a tick's snapshot, so an
 * owner cannot see the prices of a round and then change what the agent does in it
 * (tests/scheduler/membership.test.ts). Here the API half: the time moves exactly when the
 * strategy does, and never because a request says so.
 */

const wallet = testWallet(1);
const T0 = '2026-10-06T14:00:00.000Z';

const promptNumber = (n: number): string => `${PROMPT} Revision ${n}.`;

describe('the prompt-change cap', () => {
  let api: Api;
  let client: Client;
  let agentId: string;

  beforeEach(async () => {
    api = createApi({ now: T0 });
    client = await api.signedIn(wallet);
    const reply = await client.post('/api/agents', { name: 'Slow Compounder', prompt: PROMPT, division: 'open' });
    expect(reply.status).toBe(201);
    agentId = reply.json.agent.id;
  });

  const stored = async () => {
    const agent = await api.store.getAgent(agentId);
    if (!agent) throw new Error('the agent is gone');
    return agent;
  };
  const change = (n: number) => client.patch(`/api/agents/${agentId}`, { prompt: promptNumber(n) });

  it('allows three changes in a UTC day and answers 429 to the fourth, which changes nothing', async () => {
    expect(MAX_PROMPT_CHANGES_PER_DAY).toBe(3);
    for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) {
      api.advance(60_000);
      const reply = await change(n);
      expectShape(agentResponseSchema, reply);
      expect(await stored()).toMatchObject({
        prompt: promptNumber(n),
        promptChangeDay: '2026-10-06',
        promptChangeCount: n,
      });
    }
    api.advance(60_000);
    const before = await stored();
    const refused = await change(4);
    expectError(refused, 429, 'rate_limited');
    expect(await stored()).toEqual(before);
    // The refusal does not repeat the strategy it refused.
    expect(refused.text).not.toContain('Revision 4');
    // The owner still sees the last prompt that was accepted.
    expect(expectShape(meResponseSchema, await client.get('/api/me')).agent?.prompt).toBe(promptNumber(3));
  });

  it('keeps refusing for the rest of the UTC day and allows a change again on the next one', async () => {
    for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) expect((await change(n)).status).toBe(200);
    api.setNow('2026-10-06T23:59:59.000Z');
    expectError(await change(4), 429, 'rate_limited');
    // Midnight UTC, not 24 hours after the first change.
    api.setNow('2026-10-07T00:00:00.000Z');
    expect((await change(5)).status).toBe(200);
    expect(await stored()).toMatchObject({
      prompt: promptNumber(5),
      promptChangeDay: '2026-10-07',
      promptChangeCount: 1,
    });
    expect((await change(6)).status).toBe(200);
    expect((await change(7)).status).toBe(200);
    expectError(await change(8), 429, 'rate_limited');
  });

  it('counts only prompt changes: a rename, a pause and publishing the prompt stay possible', async () => {
    for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) expect((await change(n)).status).toBe(200);
    expect((await client.patch(`/api/agents/${agentId}`, { name: 'Patient Capital' })).status).toBe(200);
    expect((await client.patch(`/api/agents/${agentId}`, { promptPublic: true })).status).toBe(200);
    expect((await client.patch(`/api/agents/${agentId}`, { paused: true })).status).toBe(200);
    expect((await client.patch(`/api/agents/${agentId}`, { paused: false })).status).toBe(200);
    expect(await stored()).toMatchObject({ promptChangeCount: MAX_PROMPT_CHANGES_PER_DAY, name: 'Patient Capital' });
  });

  it('applies none of a request whose prompt change is over the cap', async () => {
    for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) expect((await change(n)).status).toBe(200);
    const before = await stored();
    const reply = await client.patch(`/api/agents/${agentId}`, {
      prompt: promptNumber(9),
      name: 'Sneaked In',
      promptPublic: true,
    });
    expectError(reply, 429, 'rate_limited');
    expect(await stored()).toEqual(before);
  });

  it('counts per agent: the changes of one wallet do not use up those of another', async () => {
    for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) expect((await change(n)).status).toBe(200);
    const second = await api.signedIn(testWallet(2));
    const created = await second.post('/api/agents', { name: 'Fast Trader', prompt: PROMPT, division: 'open' });
    expect((await second.patch(`/api/agents/${created.json.agent.id}`, { prompt: promptNumber(1) })).status).toBe(200);
  });

  it.each([
    ['promptChangeCount', 0],
    ['promptChangeDay', '2020-01-01'],
    ['promptChangeDay', null],
    ['strategyChangedAt', '2020-01-01T00:00:00.000Z'],
  ])('refuses a request that claims "%s": the count is the server\'s', async (field, value) => {
    for (let n = 1; n <= MAX_PROMPT_CHANGES_PER_DAY; n += 1) expect((await change(n)).status).toBe(200);
    const before = await stored();
    const reply = await client.patch(`/api/agents/${agentId}`, { prompt: promptNumber(9), [field]: value });
    expectError(reply, 400, 'invalid_input');
    expect(await stored()).toEqual(before);
    const header = await client.patch(
      `/api/agents/${agentId}`,
      { prompt: promptNumber(9) },
      { headers: { 'X-Prompt-Change-Count': '0', 'X-Now': '2026-10-08T00:00:00.000Z' } },
    );
    expectError(header, 429, 'rate_limited');
  });
});

describe('strategyChangedAt', () => {
  let api: Api;
  let client: Client;

  beforeEach(async () => {
    api = createApi({ now: T0 });
    client = await api.signedIn(wallet);
  });

  const createOpen = async (): Promise<string> => {
    const reply = await client.post('/api/agents', { name: 'Slow Compounder', prompt: PROMPT, division: 'open' });
    expect(reply.status).toBe(201);
    return reply.json.agent.id;
  };
  const addKey = async (apiKey: string): Promise<string> => {
    const reply = await client.post('/api/model-keys', { provider: 'openai', model: 'gpt-test-1', apiKey });
    expect(reply.status).toBe(201);
    return reply.json.modelKey.id;
  };
  const changedAt = async (id: string) => (await api.store.getAgent(id))?.strategyChangedAt;

  it('is the time of creation for a new agent', async () => {
    const id = await createOpen();
    expect(await changedAt(id)).toBe(T0);
  });

  it('moves to the time of the request when the prompt changes', async () => {
    const id = await createOpen();
    api.setNow('2026-10-06T15:03:20.000Z');
    expect((await client.patch(`/api/agents/${id}`, { prompt: promptNumber(1) })).status).toBe(200);
    expect(await changedAt(id)).toBe('2026-10-06T15:03:20.000Z');
  });

  it('does not move for a rename, for publishing the prompt or for a pause', async () => {
    const id = await createOpen();
    api.setNow('2026-10-06T15:03:20.000Z');
    expect((await client.patch(`/api/agents/${id}`, { name: 'Patient Capital' })).status).toBe(200);
    expect((await client.patch(`/api/agents/${id}`, { promptPublic: true })).status).toBe(200);
    expect((await client.patch(`/api/agents/${id}`, { paused: true })).status).toBe(200);
    expect(await changedAt(id)).toBe(T0);
  });

  it('moves when a paused agent is resumed: sitting out a round is not a way to pick one', async () => {
    const id = await createOpen();
    api.setNow('2026-10-06T14:30:00.000Z');
    expect((await client.patch(`/api/agents/${id}`, { paused: true })).status).toBe(200);
    api.setNow('2026-10-06T15:04:00.000Z');
    expect((await client.patch(`/api/agents/${id}`, { paused: false })).status).toBe(200);
    expect(await api.store.getAgent(id)).toMatchObject({
      status: 'active',
      pausedReason: null,
      strategyChangedAt: '2026-10-06T15:04:00.000Z',
    });
  });

  it('moves when the model key of a Pro agent changes', async () => {
    const firstKey = await addKey(TEST_API_KEY);
    const created = await client.post('/api/agents', {
      name: 'Own Model',
      prompt: PROMPT,
      division: 'pro',
      modelKeyId: firstKey,
    });
    expect(created.status).toBe(201);
    const id = created.json.agent.id;
    expect(await changedAt(id)).toBe(T0);

    api.setNow('2026-10-06T16:02:00.000Z');
    const secondKey = await addKey(OTHER_API_KEY);
    expect(await changedAt(id)).toBe(T0);
    expect((await client.patch(`/api/agents/${id}`, { modelKeyId: secondKey })).status).toBe(200);
    expect(await api.store.getAgent(id)).toMatchObject({
      modelKeyId: secondKey,
      strategyChangedAt: '2026-10-06T16:02:00.000Z',
    });
  });

  it('moves when a new key resumes an agent whose key was removed', async () => {
    const firstKey = await addKey(TEST_API_KEY);
    const created = await client.post('/api/agents', {
      name: 'Own Model',
      prompt: PROMPT,
      division: 'pro',
      modelKeyId: firstKey,
    });
    const id = created.json.agent.id;
    expect((await client.delete(`/api/model-keys/${firstKey}`)).status).toBe(204);
    api.setNow('2026-10-06T17:01:00.000Z');
    const secondKey = await addKey(OTHER_API_KEY);
    expect((await client.patch(`/api/agents/${id}`, { modelKeyId: secondKey })).status).toBe(200);
    expect(await api.store.getAgent(id)).toMatchObject({
      status: 'active',
      pausedReason: null,
      modelKeyId: secondKey,
      strategyChangedAt: '2026-10-06T17:01:00.000Z',
    });
  });

  it("is not part of any response: it is the scheduler's to read", async () => {
    const id = await createOpen();
    const me = await client.get('/api/me');
    const page = await api.client().get(`/api/agents/${id}`);
    expect(me.text).not.toContain('strategyChangedAt');
    expect(page.text).not.toContain('strategyChangedAt');
    expect(page.text).not.toContain('promptChange');
  });
});
