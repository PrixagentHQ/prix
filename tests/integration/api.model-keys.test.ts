import {
  agentPublicSchema,
  agentResponseSchema,
  idSchema,
  MAX_MODEL_KEYS_PER_WALLET,
  meResponseSchema,
  modelKeyAad,
  modelKeyResponseSchema,
  PROVIDERS,
  providersResponseSchema,
} from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api, Client } from '../support/api.ts';
import {
  createApi,
  expectError,
  expectNoSecret,
  expectNoStore,
  expectPublicCache,
  expectShape,
  HOUSE_MODEL,
  OTHER_API_KEY,
  PROMPT,
  TEST_API_KEY,
} from '../support/api.ts';
import { testWallet } from '../support/eth.ts';
import { makeRow, makeTick, testId, utc } from '../support/fixtures.ts';

/**
 * Model keys, from docs/CONTRACTS.md sections 4, 12 and 15. A model key is the most sensitive
 * data in the product: it is sealed before it is stored, no response ever carries it, and
 * the only way to name a provider is the allowlist.
 */

const wallet = testWallet(1);
const other = testWallet(2);

const keyInput = (apiKey = TEST_API_KEY) => ({ provider: 'openai', model: 'gpt-test-1', apiKey });

describe('GET /api/providers', () => {
  it('lists exactly the allowlist, with no URL anywhere', async () => {
    const api = createApi();
    const reply = await api.client().get('/api/providers');
    const body = expectShape(providersResponseSchema, reply);
    expectPublicCache(reply);
    expect(body.providers).toEqual(PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label })));
    expect(body.houseModel).toBe(HOUSE_MODEL);
    expect(reply.text).not.toMatch(/https?:\/\//);
  });
});

describe('POST /api/model-keys', () => {
  let api: Api;
  let client: Client;
  beforeEach(async () => {
    api = createApi();
    client = await api.signedIn(wallet);
  });

  it('stores a key and answers with its last four characters and nothing more', async () => {
    const reply = await client.post('/api/model-keys', keyInput());
    const { modelKey } = expectShape(modelKeyResponseSchema, reply, 201);
    expectNoStore(reply);
    expect(modelKey).toEqual({
      id: modelKey.id,
      provider: 'openai',
      model: 'gpt-test-1',
      last4: TEST_API_KEY.slice(-4),
      createdAt: api.now().toISOString(),
    });
    expect(idSchema.safeParse(modelKey.id).success).toBe(true);
    expect(Object.keys(reply.json)).toEqual(['modelKey']);
  });

  it('stores ciphertext only, bound to the row, its owner, its provider and its key version', async () => {
    const { modelKey } = (await client.post('/api/model-keys', keyInput())).json;
    const record = await api.store.getModelKey(modelKey.id, wallet.address);
    expect(record).toMatchObject({
      id: modelKey.id,
      owner: wallet.address,
      provider: 'openai',
      model: 'gpt-test-1',
      last4: TEST_API_KEY.slice(-4),
    });
    if (!record) return;
    expectNoSecret(api.store.dump(), [TEST_API_KEY], 'the database');
    // The scheduler's half can open it, so it really is the key that was sealed.
    expect(await api.vault.opener.open(record)).toBe(TEST_API_KEY);
    expect(record.keyVersion).toBe(api.vault.sealer.keyVersion);
    // Moved to another row or another owner, the same ciphertext does not open.
    expect(await api.vault.opener.open({ ...record, id: testId('key', 5) })).toBeNull();
    expect(await api.vault.opener.open({ ...record, owner: other.address })).toBeNull();
    // Moved to another provider it does not open either: a changed row cannot send the key to another company.
    for (const provider of PROVIDERS) {
      if (provider.id === 'openai') continue;
      expect(await api.vault.opener.open({ ...record, provider: provider.id }), provider.id).toBeNull();
    }
    expect(await api.vault.opener.open({ ...record, keyVersion: record.keyVersion + 1 })).toBeNull();
    expect(modelKeyAad(record)).toBe(`${record.id}:${wallet.address}:openai:${record.keyVersion}`);
  });

  it('returns a stored key to its owner only, through the store as well', async () => {
    const { modelKey } = (await client.post('/api/model-keys', keyInput())).json;
    expect(await api.store.getModelKey(modelKey.id, other.address)).toBeNull();
    expect(await api.store.listModelKeys(other.address)).toEqual([]);
  });

  it('never shows a key again: not in any response, not in the database', async () => {
    const first = (await client.post('/api/model-keys', keyInput())).json.modelKey;
    await client.post('/api/model-keys', { provider: 'anthropic', model: 'claude-test', apiKey: OTHER_API_KEY });
    const me = expectShape(meResponseSchema, await client.get('/api/me'));
    expect(me.modelKeys).toHaveLength(2);
    expect(me.modelKeys.map((key) => key.last4).sort()).toEqual(
      [OTHER_API_KEY.slice(-4), TEST_API_KEY.slice(-4)].sort(),
    );

    const pro = await client.post('/api/agents', {
      name: 'Own Model',
      prompt: PROMPT,
      division: 'pro',
      modelKeyId: first.id,
    });
    expect(pro.status).toBe(201);
    await client.get('/api/me');
    await api.client().get(`/api/agents/${pro.json.agent.id}`);
    await api.client().get('/api/league?division=pro');
    await client.patch(`/api/agents/${pro.json.agent.id}`, { paused: true });
    await client.delete(`/api/model-keys/${first.id}`);
    await client.get('/api/me');

    expect(api.transcript.length).toBeGreaterThan(8);
    expectNoSecret(api.transcript.join('\n'), [TEST_API_KEY, OTHER_API_KEY], 'a response');
    expectNoSecret(api.store.dump(), [TEST_API_KEY, OTHER_API_KEY], 'the database');
  });

  it('seals every key with a fresh nonce, even the same key twice', async () => {
    const a = (await client.post('/api/model-keys', keyInput())).json.modelKey;
    const b = (await client.post('/api/model-keys', keyInput())).json.modelKey;
    const [first, second] = await Promise.all([
      api.store.getModelKey(a.id, wallet.address),
      api.store.getModelKey(b.id, wallet.address),
    ]);
    expect(first?.iv).not.toBe(second?.iv);
    expect(first?.ciphertext).not.toBe(second?.ciphertext);
  });

  it.each(['baseUrl', 'baseURL', 'base_url', 'url', 'endpoint', 'apiBase', 'host', 'proxy'])(
    'refuses a request that carries "%s": no input accepts a URL for a model',
    async (field) => {
      const reply = await client.post('/api/model-keys', { ...keyInput(), [field]: 'https://models.evil.test/v1' });
      expectError(reply, 400, 'invalid_input');
      expect(api.store.modelKeys.size).toBe(0);
      expectNoSecret(reply.text, [TEST_API_KEY], 'the refusal');
    },
  );

  it.each([
    'https://models.evil.test/v1',
    'models.evil.test',
    'custom',
    'azure',
    'OpenAI',
    'openai ',
    'openai/../evil',
    '',
  ])('refuses the provider "%s": only the allowlist names a provider', async (provider) => {
    const reply = await client.post('/api/model-keys', { ...keyInput(), provider });
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('provider');
    expect(api.store.modelKeys.size).toBe(0);
  });

  it('refuses a provider that is not a string', async () => {
    for (const provider of [null, 1, { id: 'openai', baseUrl: 'https://models.evil.test' }, ['openai']]) {
      expectError(await client.post('/api/model-keys', { ...keyInput(), provider }), 400, 'invalid_input');
    }
    expect(api.store.modelKeys.size).toBe(0);
  });

  it('accepts every provider of the allowlist', async () => {
    // A wallet stores three keys at most, so each provider gets a wallet of its own.
    for (const [index, provider] of PROVIDERS.entries()) {
      const owner = await api.signedIn(testWallet(50 + index));
      const reply = await owner.post('/api/model-keys', { ...keyInput(), provider: provider.id });
      expect(reply.status, provider.id).toBe(201);
    }
  });

  it.each([
    ['too short', 'short-key'],
    ['too long', `fixture-key-${'a'.repeat(300)}`],
    ['with a space', 'fixture key with spaces 0123456789'],
    ['with a line break', 'fixture-key-0123456789\nInjected: header'],
    ['outside ASCII', 'fixture-key-0123456789-ключ'],
  ])('refuses a key that is %s, and does not repeat it in the answer', async (_why, apiKey) => {
    const reply = await client.post('/api/model-keys', keyInput(apiKey));
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('apiKey');
    expect(reply.text).not.toContain(apiKey);
    expect(reply.text).not.toContain(apiKey.slice(0, 12));
    expect(api.store.modelKeys.size).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['with a space', 'gpt test'],
    ['with a query string', 'gpt-test?key=1'],
    ['too long', 'g'.repeat(81)],
    // Section 15: nothing shaped like an address or a path that climbs.
    ['an address', '//models.evil.test/v1'],
    ['a name with two slashes in it', 'vendor//model'],
    ['a URL without its scheme', 'models.evil.test//v1'],
    ['a path that climbs', '../../v1/files'],
    ['a name with two dots in it', 'vendor/..model'],
    ['a name that ends in two dots', 'gpt-test..'],
    ['a URL', 'https://models.evil.test/v1'],
  ])('refuses a model name that is %s', async (_why, model) => {
    const reply = await client.post('/api/model-keys', { ...keyInput(), model });
    expectError(reply, 400, 'invalid_input');
    expect(reply.json.error.field).toBe('model');
    expectNoSecret(reply.text, [TEST_API_KEY], 'the refusal');
  });

  it('accepts the model names providers really use: a slash, a colon, a single dot', async () => {
    const names = ['gpt-4.1-mini', 'vendor/model-name:free', 'models/gemini-2.5-flash'];
    for (const [index, model] of names.entries()) {
      const owner = await api.signedIn(testWallet(70 + index));
      const reply = await owner.post('/api/model-keys', { ...keyInput(), model });
      expect(reply.status, model).toBe(201);
      expect(reply.json.modelKey.model).toBe(model);
    }
  });

  it('does not repeat the key when another field is wrong', async () => {
    const reply = await client.post('/api/model-keys', { ...keyInput(), provider: 'custom', extra: true });
    expect(reply.status).toBe(400);
    expectNoSecret(reply.text, [TEST_API_KEY], 'the refusal');
  });

  it('does not repeat the key when the database fails', async () => {
    api.store.failing = { method: 'putModelKey', times: 1 };
    const reply = await client.post('/api/model-keys', keyInput());
    expectError(reply, 500, 'internal');
    expectNoSecret(reply.text, [TEST_API_KEY], 'the error');
  });

  it('answers 401 without a session and 403 without the site origin or the JSON content type', async () => {
    expectError(await api.client().post('/api/model-keys', keyInput()), 401, 'unauthorized');
    expectError(await client.post('/api/model-keys', keyInput(), { origin: null }), 403, 'forbidden');
    expectError(
      await client.post('/api/model-keys', keyInput(), { origin: 'https://prix.evil.test' }),
      403,
      'forbidden',
    );
    expectError(await client.post('/api/model-keys', keyInput(), { contentType: 'text/plain' }), 403, 'forbidden');
    expect(api.store.modelKeys.size).toBe(0);
    expectNoSecret(api.transcript.join('\n'), [TEST_API_KEY], 'a refusal');
  });

  it('answers 429 when the write limit of the wallet is reached: storing a key is a write', async () => {
    api.limiter.denied.add('write');
    expectError(await client.post('/api/model-keys', keyInput()), 429, 'rate_limited');
    expect(api.limiter.asked).toContainEqual({ rule: 'write', subject: wallet.address });
    expect(api.store.modelKeys.size).toBe(0);
    // The `key_write` rule of revision 2 is gone: the limiter is asked only for rules that exist.
    for (const ask of api.limiter.asked) expect(['sign_in', 'sign_in_global', 'write', 'read']).toContain(ask.rule);
  });

  it.each([
    ['a double slash', 'vendor//model'],
    ['an address', '//evil.test/v1'],
    ['a path that climbs', '../../v1/other'],
    ['two dots inside', 'gpt..4'],
  ])('refuses a model name with %s, and stores nothing', async (_why, model) => {
    expectError(await client.post('/api/model-keys', { ...keyInput(), model }), 400, 'invalid_input');
    expect(api.store.modelKeys.size).toBe(0);
  });

  it('accepts a model name with one slash and a colon, as OpenRouter spells them', async () => {
    const reply = await client.post('/api/model-keys', {
      provider: 'openrouter',
      model: 'vendor/model:variant',
      apiKey: TEST_API_KEY,
    });
    expect(reply.status).toBe(201);
  });

  it('answers 409 key_limit_reached for the key after the third, and stores nothing', async () => {
    expect(MAX_MODEL_KEYS_PER_WALLET).toBe(3);
    for (let n = 1; n <= MAX_MODEL_KEYS_PER_WALLET; n += 1) {
      expect((await client.post('/api/model-keys', { ...keyInput(), model: `gpt-test-${n}` })).status).toBe(201);
    }
    const reply = await client.post('/api/model-keys', keyInput(OTHER_API_KEY));
    expectError(reply, 409, 'key_limit_reached');
    expectNoSecret(reply.text, [OTHER_API_KEY, TEST_API_KEY], 'the refusal');
    expect(api.store.modelKeys.size).toBe(MAX_MODEL_KEYS_PER_WALLET);
    expectNoSecret(api.store.dump(), [OTHER_API_KEY], 'the database');
    expect(expectShape(meResponseSchema, await client.get('/api/me')).modelKeys).toHaveLength(
      MAX_MODEL_KEYS_PER_WALLET,
    );
  });

  it('counts the keys per wallet, and frees a place when a key is deleted', async () => {
    const ids: string[] = [];
    for (let n = 1; n <= MAX_MODEL_KEYS_PER_WALLET; n += 1) {
      ids.push((await client.post('/api/model-keys', { ...keyInput(), model: `gpt-test-${n}` })).json.modelKey.id);
    }
    // Another wallet is not affected.
    const second = await api.signedIn(other);
    expect((await second.post('/api/model-keys', keyInput(OTHER_API_KEY))).status).toBe(201);
    expectError(await client.post('/api/model-keys', keyInput()), 409, 'key_limit_reached');
    expect((await client.delete(`/api/model-keys/${ids[0]}`)).status).toBe(204);
    expect((await client.post('/api/model-keys', keyInput())).status).toBe(201);
    expectError(await client.post('/api/model-keys', keyInput()), 409, 'key_limit_reached');
  });

  it('stores exactly three keys when a wallet sends five at once', async () => {
    const replies = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        client.post('/api/model-keys', { ...keyInput(), model: `gpt-test-${index}` }),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 201, 201, 409, 409]);
    expect(api.store.modelKeys.size).toBe(MAX_MODEL_KEYS_PER_WALLET);
  });

  it('takes the cap from the server, whatever a request claims', async () => {
    for (let n = 1; n <= MAX_MODEL_KEYS_PER_WALLET; n += 1) {
      expect((await client.post('/api/model-keys', { ...keyInput(), model: `gpt-test-${n}` })).status).toBe(201);
    }
    expectError(await client.post('/api/model-keys', { ...keyInput(), maxPerOwner: 99 }), 400, 'invalid_input');
    expectError(
      await client.post('/api/model-keys', keyInput(), { headers: { 'X-Max-Keys': '99', 'X-Tier': 'gold' } }),
      409,
      'key_limit_reached',
    );
  });
});

describe('a Pro agent and its key', () => {
  let api: Api;
  let client: Client;
  let keyId: string;
  beforeEach(async () => {
    api = createApi();
    client = await api.signedIn(wallet);
    keyId = (await client.post('/api/model-keys', keyInput())).json.modelKey.id;
  });

  const createPro = (as: Client, modelKeyId: string) =>
    as.post('/api/agents', { name: 'Own Model', prompt: PROMPT, division: 'pro', modelKeyId });

  it('creates a Pro agent on the key of its owner; its page names the model once a provider has accepted it', async () => {
    const reply = await createPro(client, keyId);
    const { agent } = expectShape(agentResponseSchema, reply, 201);
    expect(agent).toMatchObject({ division: 'pro', modelKeyId: keyId, status: 'active' });
    // Until a row was decided with that model, the page does not name it (docs/CONTRACTS.md section 15).
    const before = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${agent.id}`));
    expect(JSON.stringify(before.model)).not.toContain('gpt-test-1');
    const stored = await api.store.getAgent(agent.id);
    if (!stored) throw new Error('agent missing');
    await api.store.createTick(makeTick(utc('2026-10-06T15:00:00.000Z'), { status: 'complete' }));
    await api.store.writeDecision(
      makeRow({ agent: stored, tickId: '2026-10-06T15:00Z', model: 'openai:gpt-test-1' }),
      scoring.initialStats(),
      0,
    );
    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${agent.id}`));
    expect(page.model).toEqual({ kind: 'own', providerLabel: 'OpenAI', model: 'gpt-test-1' });
  });

  it('answers 404 for a Pro agent on a key that belongs to another wallet, as for a key that does not exist', async () => {
    const intruder = await api.signedIn(other);
    const foreign = await createPro(intruder, keyId);
    expectError(foreign, 404, 'not_found');
    const unknown = await createPro(intruder, testId('key', 77));
    expectError(unknown, 404, 'not_found');
    // The same answer for both: a wallet cannot learn which key ids exist.
    expect(foreign.json).toEqual(unknown.json);
    expect(api.store.agents.size).toBe(0);
  });

  it('refuses to move an agent to a key that belongs to another wallet', async () => {
    const agentId = (await createPro(client, keyId)).json.agent.id;
    const stranger = await api.signedIn(other);
    const foreignKey = (await stranger.post('/api/model-keys', keyInput(OTHER_API_KEY))).json.modelKey.id;
    const reply = await client.patch(`/api/agents/${agentId}`, { modelKeyId: foreignKey });
    expectError(reply, 404, 'not_found');
    expect((await api.store.getAgent(agentId))?.modelKeyId).toBe(keyId);
  });

  it('deletes a key on request: the row is gone, the agent that used it is paused and has no key', async () => {
    const agentId = (await createPro(client, keyId)).json.agent.id;
    const reply = await client.delete(`/api/model-keys/${keyId}`);
    expect(reply.status).toBe(204);
    expect(reply.text).toBe('');
    expect(await api.store.getModelKey(keyId, wallet.address)).toBeNull();
    expect(api.store.modelKeys.size).toBe(0);
    const me = expectShape(meResponseSchema, await client.get('/api/me'));
    expect(me.modelKeys).toEqual([]);
    expect(me.agent).toMatchObject({ id: agentId, status: 'paused', pausedReason: 'key_removed', modelKeyId: null });
    // Its public page says that it has no model, instead of naming one that is gone.
    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${agentId}`));
    expect(page.model).toEqual({ kind: 'none' });
    expect(page.status).toBe('paused');
    // Deleting it again finds nothing.
    expectError(await client.delete(`/api/model-keys/${keyId}`), 404, 'not_found');
  });

  it('counts a delete as a write for the rate limit', async () => {
    api.limiter.asked.length = 0;
    api.limiter.denied.add('write');
    expectError(await client.delete(`/api/model-keys/${keyId}`), 429, 'rate_limited');
    expect(api.limiter.asked).toContainEqual({ rule: 'write', subject: wallet.address });
    expect(await api.store.getModelKey(keyId, wallet.address)).not.toBeNull();
  });

  it('answers 404 for a malformed key id in the path', async () => {
    for (const id of ['1', 'KEYAAAAAAAAB', `${keyId}x`, '..%2Fme']) {
      expectError(await client.delete(`/api/model-keys/${id}`), 404, 'not_found');
    }
    expect(api.store.modelKeys.size).toBe(1);
  });

  it('resumes an agent paused for a removed key when its owner sets a new key', async () => {
    const agentId = (await createPro(client, keyId)).json.agent.id;
    await client.delete(`/api/model-keys/${keyId}`);
    const newKey = (await client.post('/api/model-keys', keyInput(OTHER_API_KEY))).json.modelKey.id;
    const reply = await client.patch(`/api/agents/${agentId}`, { modelKeyId: newKey });
    const { agent } = expectShape(agentResponseSchema, reply);
    expect(agent).toMatchObject({ modelKeyId: newKey, status: 'active', pausedReason: null });
  });

  it('keeps an agent paused by its owner paused when the owner changes the key', async () => {
    const agentId = (await createPro(client, keyId)).json.agent.id;
    await client.patch(`/api/agents/${agentId}`, { paused: true });
    const newKey = (await client.post('/api/model-keys', keyInput(OTHER_API_KEY))).json.modelKey.id;
    const reply = await client.patch(`/api/agents/${agentId}`, { modelKeyId: newKey });
    expect(reply.json.agent).toMatchObject({ modelKeyId: newKey, status: 'paused', pausedReason: 'owner' });
  });

  it('does not delete a key for another wallet', async () => {
    const intruder = await api.signedIn(other);
    // The store answers one thing for "not yours" and "not there", and so does the API.
    expectError(await intruder.delete(`/api/model-keys/${keyId}`), 404, 'not_found');
    expect(await api.store.getModelKey(keyId, wallet.address)).not.toBeNull();
    expect((await intruder.get('/api/me')).json.modelKeys).toEqual([]);
  });

  it('answers 401 without a session and 403 without the site origin when deleting', async () => {
    expectError(await api.client().delete(`/api/model-keys/${keyId}`), 401, 'unauthorized');
    expectError(await client.delete(`/api/model-keys/${keyId}`, { origin: null }), 403, 'forbidden');
    // A request that changes state carries the JSON content type even when it has no body.
    expectError(await client.delete(`/api/model-keys/${keyId}`, { contentType: null }), 403, 'forbidden');
    expect(await api.store.getModelKey(keyId, wallet.address)).not.toBeNull();
  });
});
