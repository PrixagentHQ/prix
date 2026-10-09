import {
  agentPublicSchema,
  agentResponseSchema,
  leagueResponseSchema,
  marketResponseSchema,
  meResponseSchema,
  modelKeyResponseSchema,
  nonceResponseSchema,
  providersResponseSchema,
  sessionResponseSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import {
  createApi,
  expectNoSecret,
  expectNoStore,
  expectPublicCache,
  expectShape,
  PROMPT,
  TEST_API_KEY,
} from '../support/api.ts';
import { siweMessage, testWallet } from '../support/eth.ts';
import { SEASON_1 } from '../support/fixtures.ts';

/**
 * The path of the Phase 1 gate, through the API alone: a stranger signs in, writes a
 * prompt, gets an agent, and the agent is on the public league. Every step is written out,
 * so a failure names the step. The ranked half of the path is in
 * tests/scheduler/journey.test.ts, where five trading days are simulated.
 */
describe('from sign-in to an agent on the league', () => {
  it('works for an Open agent, step by step', async () => {
    const api = createApi();
    const wallet = testWallet(41);
    const visitor = api.client();

    // 1. A visitor sees an empty league. Nothing asks them to sign in for that.
    const before = expectShape(leagueResponseSchema, await visitor.get('/api/league'));
    expect(before.rows).toEqual([]);
    expect(before.season).toEqual(SEASON_1);
    expectShape(marketResponseSchema, await visitor.get('/api/market'));

    // 2. They ask for a nonce and sign the message the server describes. Nothing else is signed.
    const nonce = expectShape(nonceResponseSchema, await visitor.get('/api/siwe/nonce'));
    const message = siweMessage({
      domain: nonce.domain,
      address: wallet.checksumAddress,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: api.now().toISOString(),
    });
    const signature = await wallet.signMessage(message);

    // 3. The server verifies the signature and sets the session cookie.
    const session = await visitor.post('/api/siwe/verify', { message, signature });
    expect(expectShape(sessionResponseSchema, session).address).toBe(wallet.address);
    expect(visitor.cookie).not.toBeNull();

    // 4. The account page: a wallet with no agent yet.
    const empty = await visitor.get('/api/me');
    expect(expectShape(meResponseSchema, empty)).toEqual({
      address: wallet.address,
      isAdmin: false,
      agent: null,
      modelKeys: [],
    });
    expectNoStore(empty);

    // 5. They write a prompt and build an agent in the Open division.
    const created = await visitor.post('/api/agents', { name: 'First Light', prompt: PROMPT, division: 'open' });
    const { agent } = expectShape(agentResponseSchema, created, 201);
    expect(agent).toMatchObject({ name: 'First Light', division: 'open', status: 'active', prompt: PROMPT });

    // 6. The agent is on the public league at once, for anyone, without a rank yet.
    const anyone = api.client();
    const leagueReply = await anyone.get('/api/league?division=open');
    const league = expectShape(leagueResponseSchema, leagueReply);
    expectPublicCache(leagueReply);
    expect(league.rows.map((row) => [row.agentId, row.name, row.rank])).toEqual([[agent.id, 'First Light', null]]);

    // 7. It has a public page: the starting portfolio, no decisions, the prompt kept private.
    const pageReply = await anyone.get(`/api/agents/${agent.id}`);
    const page = expectShape(agentPublicSchema, pageReply);
    expectPublicCache(pageReply);
    expect(page).toMatchObject({
      id: agent.id,
      name: 'First Light',
      cashMicro: 10_000_000_000,
      holdings: [],
      decisions: [],
      prompt: null,
    });
    expect(pageReply.text).not.toContain(PROMPT);

    // 8. The owner sees it on the account page, with the prompt.
    const me = expectShape(meResponseSchema, await visitor.get('/api/me'));
    expect(me.agent).toMatchObject({ id: agent.id, prompt: PROMPT, hidden: false });

    // 9. Signing out ends the session.
    expect((await visitor.post('/api/siwe/logout')).status).toBe(204);
    expect((await visitor.get('/api/me')).status).toBe(401);

    // No response on the way was a server error.
    expect(api.transcript.filter((entry) => / -> 5\d\d\n/.test(entry))).toEqual([]);
  });

  it('works for a Pro agent with its own model key, and the key is never sent back', async () => {
    const api = createApi();
    const wallet = testWallet(42);
    const client = await api.signedIn(wallet);

    const providers = expectShape(providersResponseSchema, await client.get('/api/providers'));
    const provider = providers.providers[0];
    expect(provider).toBeDefined();

    const key = await client.post('/api/model-keys', {
      provider: provider?.id,
      model: 'model-test-1',
      apiKey: TEST_API_KEY,
    });
    const { modelKey } = expectShape(modelKeyResponseSchema, key, 201);

    const created = await client.post('/api/agents', {
      name: 'Own Engine',
      prompt: PROMPT,
      division: 'pro',
      modelKeyId: modelKey.id,
    });
    const { agent } = expectShape(agentResponseSchema, created, 201);

    const league = expectShape(leagueResponseSchema, await api.client().get('/api/league?division=pro'));
    expect(league.rows.map((row) => row.agentId)).toEqual([agent.id]);
    expect(expectShape(leagueResponseSchema, await api.client().get('/api/league?division=open')).rows).toEqual([]);

    const page = expectShape(agentPublicSchema, await api.client().get(`/api/agents/${agent.id}`));
    // No row has been decided with that model yet, so the page does not name it (contract section 15).
    expect(page.model).toEqual({ kind: 'own', providerLabel: provider?.label, model: '' });

    const me = expectShape(meResponseSchema, await client.get('/api/me'));
    expect(me.modelKeys).toEqual([modelKey]);

    expectNoSecret(api.transcript.join('\n'), [TEST_API_KEY], 'a response');
    expectNoSecret(api.store.dump(), [TEST_API_KEY], 'the database');
  });
});
