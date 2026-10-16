import { API_WRITE_ROWS_PER_DAY, WALLET_WRITES_PER_DAY } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api, Client } from '../support/api.ts';
import { createApi, expectError, PROMPT } from '../support/api.ts';
import { testWallet } from '../support/eth.ts';

/** The rules added after the security review, docs/CONTRACTS.md section 15, last block. */

const wallet = testWallet(1);
const DAY = '2026-10-06';
const body = (name = 'Slow Compounder') => ({ name, prompt: PROMPT, division: 'open' });

describe('the daily budgets of the HTTP API', () => {
  let api: Api;
  let client: Client;
  beforeEach(async () => {
    api = createApi();
    client = await api.signedIn(wallet);
  });

  it('answers 503 daily_limit and writes nothing when the day has no rows left', async () => {
    api.store.apiWriteRows.set(DAY, API_WRITE_ROWS_PER_DAY - 1);
    expectError(await client.post('/api/agents', body()), 503, 'daily_limit');
    expect(api.store.agents.size).toBe(0);
  });

  it('answers 503 daily_limit and writes nothing when the wallet has used its writes', async () => {
    api.store.walletWrites.set(`${wallet.address.toLowerCase()}|${DAY}`, WALLET_WRITES_PER_DAY);
    expectError(await client.post('/api/agents', body()), 503, 'daily_limit');
    expect(api.store.agents.size).toBe(0);
  });
});

describe('sign-in limits and sign-out', () => {
  it('takes the global sign-in count in verify, and not in the nonce route', async () => {
    const api = createApi();
    const client = api.client('198.51.100.7');
    await client.get('/api/siwe/nonce');
    expect(api.limiter.asked.map((entry) => entry.rule)).not.toContain('sign_in_global');
    expect(api.limiter.asked.map((entry) => entry.rule)).toContain('sign_in');
    expect((await client.signIn(wallet)).status).toBe(200);
    expect(api.limiter.asked.map((entry) => entry.rule)).toContain('sign_in_global');
  });

  it('answers 204 to a sign-out with no session, and with a session that is already gone', async () => {
    const api = createApi();
    const reply = await api.client().post('/api/siwe/logout');
    expect(reply.status).toBe(204);
    const client = await api.signedIn(wallet);
    api.store.sessions.clear();
    expect((await client.post('/api/siwe/logout')).status).toBe(204);
    expect(client.cookie).toBeNull();
  });
});

describe('agent names that look like the product', () => {
  // A reserved name may be refused by the schema before the word list is asked (400), or by the list (409).
  it.each(['Prix Alpha', 'Pons', 'House'])('refuses the reserved name %s', async (name) => {
    const api = createApi();
    const client = await api.signedIn(wallet);
    const reply = await client.post('/api/agents', body(name));
    expect([400, 409]).toContain(reply.status);
    expect(reply.json.error.code).toBe(reply.status === 400 ? 'invalid_input' : 'name_not_allowed');
    expect(api.store.agents.size).toBe(0);
  });

  // "House" is a product label (docs/CONTRACTS.md section 17.1): refused as a whole word anywhere in a name.
  it.each(['House Momentum', 'The House Fund', 'Value h0use', 'Big-HOUSE Index'])(
    'refuses %s, with house as a word, as name_not_allowed, 409',
    async (name) => {
      const api = createApi();
      const client = await api.signedIn(wallet);
      expectError(await client.post('/api/agents', body(name)), 409, 'name_not_allowed');
      expect(api.store.agents.size).toBe(0);
    },
  );

  it.each(['Lighthouse Value', 'Warehouse Index', 'Housed Growth'])(
    'accepts %s, where house is only part of a word',
    async (name) => {
      const api = createApi();
      const client = await api.signedIn(wallet);
      expect((await client.post('/api/agents', body(name))).status).toBe(201);
    },
  );

  it.each(['Prlx Capital', 'Pr1x Bot'])('refuses the look-alike %s as name_not_allowed, 409', async (name) => {
    const api = createApi();
    const client = await api.signedIn(wallet);
    expectError(await client.post('/api/agents', body(name)), 409, 'name_not_allowed');
    expect(api.store.agents.size).toBe(0);
  });
});
