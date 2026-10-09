import { expect, test } from '@playwright/test';
import { CHAIN_ID, SESSION_COOKIE, SIWE_STATEMENT } from '@prix/contracts';
import { e2eRun } from '../support/e2e-wallets.ts';
import { siweMessage, testWallet } from '../support/eth.ts';

/**
 * The API of a local stack, driven directly with a signed message and no browser page. It
 * separates a defect of the API from a defect of a page: when arena.spec.ts fails and this
 * file passes, the page is at fault. Runs only with PRIX_BASE_URL (tests/playwright.config.ts
 * refuses prixagent.com). The session cookie is carried by hand: this client does not keep a
 * `Secure` cookie over plain http, a browser does.
 */

const BASE_URL = process.env.PRIX_BASE_URL;
const RUN = e2eRun();
const PROMPT = 'Hold the five largest companies in equal parts and change the portfolio at most once a week.';

test.skip(!BASE_URL, 'Set PRIX_BASE_URL to run the end-to-end test.');
test.setTimeout(400_000);

/** The sign-in routes allow 5 requests a minute per address (docs/CONTRACTS.md section 15): wait out a 429. */
async function patient<T extends { status(): number }>(call: () => Promise<T>): Promise<T> {
  let reply = await call();
  for (let attempt = 0; attempt < 3 && reply.status() === 429; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    reply = await call();
  }
  return reply;
}

function label(n: number): string {
  let value = Math.abs(Math.floor(n));
  let out = '';
  do {
    out = 'abcdefghijklmnopqrstuvwxyz'[value % 26] + out;
    value = Math.floor(value / 26);
  } while (value > 0);
  return out.slice(-10);
}

test('the API: nonce, verify, session, one agent per wallet, a taken name, sign out', async ({
  playwright,
}, testInfo) => {
  const origin = new URL(BASE_URL as string).origin;
  const api = await playwright.request.newContext({ baseURL: origin });
  const n = RUN * 10 + (testInfo.project.name === 'phone' ? 4 : 3);
  const wallet = testWallet(n);
  const wallet2 = testWallet(n + 1000);
  const name = `Probe ${label(n)}`;
  const writeHeaders = { origin, 'content-type': 'application/json' };

  async function signIn(w: ReturnType<typeof testWallet>): Promise<string> {
    const nonceReply = await patient(() => api.get('/api/siwe/nonce'));
    expect(nonceReply.status()).toBe(200);
    expect(nonceReply.headers()['cache-control']).toContain('no-store');
    const nonce = await nonceReply.json();
    expect(nonce.chainId).toBe(CHAIN_ID);
    expect(nonce.statement).toBe(SIWE_STATEMENT);
    const message = siweMessage({
      domain: nonce.domain,
      address: w.checksumAddress,
      statement: nonce.statement,
      uri: nonce.uri,
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date().toISOString(),
    });
    const signature = await w.signMessage(message);
    const verify = await patient(() =>
      api.post('/api/siwe/verify', { headers: writeHeaders, data: { message, signature } }),
    );
    expect(verify.status(), await verify.text()).toBe(200);
    expect((await verify.json()).address).toBe(w.address);
    const setCookie = verify.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookie).toHaveLength(1);
    const raw = setCookie[0]?.value ?? '';
    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/Path=\//i);
    expect(raw).not.toMatch(/Domain=/i);
    // A nonce is single use.
    const replay = await patient(() =>
      api.post('/api/siwe/verify', { headers: writeHeaders, data: { message, signature } }),
    );
    expect(replay.status()).toBe(401);
    return raw.split(';')[0] as string;
  }

  // Not signed in.
  expect((await api.get('/api/me')).status()).toBe(401);

  const cookie = await signIn(wallet);
  const me = await api.get('/api/me', { headers: { cookie } });
  expect(me.status()).toBe(200);
  const meBody = await me.json();
  expect(meBody.address).toBe(wallet.address);
  expect(meBody.agent ?? null).toBeNull();

  // A write needs the site origin.
  const noOrigin = await api.post('/api/agents', {
    headers: { cookie, 'content-type': 'application/json' },
    data: { name, prompt: PROMPT, division: 'open' },
  });
  expect(noOrigin.status()).toBe(403);

  // The server ignores what the client claims about its own score or tier: unknown fields are refused.
  const claim = await api.post('/api/agents', {
    headers: { ...writeHeaders, cookie },
    data: { name, prompt: PROMPT, division: 'open', score: 99, tier: 'gold' },
  });
  expect(claim.status()).toBe(400);

  const created = await api.post('/api/agents', {
    headers: { ...writeHeaders, cookie },
    data: { name, prompt: PROMPT, division: 'open' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const createdBody = await created.json();
  const agent = createdBody.agent ?? createdBody;
  expect(agent).toMatchObject({ name, division: 'open', status: 'active' });

  const second = await api.post('/api/agents', {
    headers: { ...writeHeaders, cookie },
    data: { name: `Second ${label(n)}`, prompt: PROMPT, division: 'open' },
  });
  expect(second.status()).toBe(409);
  expect((await second.json()).error.code).toBe('owner_has_agent');

  // Another wallet, the same name in other letters.
  const cookie2 = await signIn(wallet2);
  const taken = await api.post('/api/agents', {
    headers: { ...writeHeaders, cookie: cookie2 },
    data: { name: name.toUpperCase(), prompt: PROMPT, division: 'open' },
  });
  expect(taken.status()).toBe(409);
  expect((await taken.json()).error.code).toBe('name_taken');

  // The public view hides the prompt.
  const pub = await api.get(`/api/agents/${agent.id}`);
  expect(pub.status()).toBe(200);
  expect((await pub.json()).prompt).toBeNull();

  // Sign out clears the cookie; the old session no longer works.
  const out = await api.post('/api/siwe/logout', { headers: { ...writeHeaders, cookie } });
  expect(out.status()).toBe(204);
  expect((await api.get('/api/me', { headers: { cookie } })).status()).toBe(401);
  await api.dispose();
});
