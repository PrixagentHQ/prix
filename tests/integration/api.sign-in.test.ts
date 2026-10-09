import {
  CHAIN_ID,
  meResponseSchema,
  NONCE_TTL_SECONDS,
  nonceResponseSchema,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  SIWE_STATEMENT,
  sessionResponseSchema,
} from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api, Reply } from '../support/api.ts';
import {
  ADMIN_WALLET,
  createApi,
  expectError,
  expectNoStore,
  expectShape,
  NONCE_SECRET,
  OTHER_NONCE_SECRET,
  SITE_HOST,
  SITE_ORIGIN,
} from '../support/api.ts';
import { sha256Hex, siweMessage, testWallet } from '../support/eth.ts';

/**
 * Sign-in and sessions, from docs/CONTRACTS.md sections 4, 11 and 15. The wallet is a test
 * wallet that signs real EIP-191 signatures; nothing is mocked inside the API.
 *
 * Revision 3 makes the nonce stateless: random bytes, an expiry and an HMAC under
 * NONCE_SECRET. Issuing one writes nothing, and the database only learns of a nonce when a
 * valid sign-in uses it.
 */

const wallet = testWallet(1);
const stranger = testWallet(2);

/** The message a wallet would sign for the nonce the server described. */
async function signedBody(api: Api, change: Partial<Parameters<typeof siweMessage>[0]> = {}) {
  const nonce = (await api.client().get('/api/siwe/nonce')).json;
  const message = siweMessage({
    domain: nonce.domain,
    address: wallet.checksumAddress,
    statement: nonce.statement,
    uri: nonce.uri,
    chainId: nonce.chainId,
    nonce: nonce.nonce,
    issuedAt: api.now().toISOString(),
    ...change,
  });
  return { message, signature: await wallet.signMessage(message), nonce: nonce.nonce as string };
}

describe('GET /api/siwe/nonce', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi();
  });

  it('returns a nonce with everything the sign-in message must contain', async () => {
    const reply = await api.client().get('/api/siwe/nonce');
    const body = expectShape(nonceResponseSchema, reply);
    expect(body.domain).toBe(SITE_HOST);
    expect(new URL(body.uri).origin).toBe(SITE_ORIGIN);
    expect(body.chainId).toBe(CHAIN_ID);
    expect(body.chainId).toBe(4663);
    expect(body.statement).toBe(SIWE_STATEMENT);
    // Section 15: 56 letters and digits. EIP-4361 asks for at least eight alphanumeric characters.
    expect(body.nonce).toMatch(/^[A-Za-z0-9]{56}$/);
    expect(body.expiresAt).toBe(new Date(api.now().getTime() + NONCE_TTL_SECONDS * 1_000).toISOString());
  });

  it('writes nothing: a nonce is stateless, so asking for one cannot use up the database', async () => {
    const client = api.client();
    const before = api.store.dump();
    api.store.resetCalls();
    for (let i = 0; i < 25; i += 1) expect((await client.get('/api/siwe/nonce')).status).toBe(200);
    expect(api.store.dump()).toBe(before);
    expect(api.store.rowCount()).toBe(0);
    // Not one call reached the store, reads included.
    expect(api.store.calls).toEqual({});
  });

  it('gives a different, unpredictable nonce every time', async () => {
    const client = api.client();
    const nonces = new Set<string>();
    for (let i = 0; i < 20; i += 1) nonces.add((await client.get('/api/siwe/nonce')).json.nonce);
    expect(nonces.size).toBe(20);
    // No two share a long run of characters: the random part is not a counter with a fixed tail.
    const [first = '', second = ''] = [...nonces];
    expect(first.slice(0, 16)).not.toBe(second.slice(0, 16));
  });

  it('is never cached: Cache-Control is no-store', async () => {
    expectNoStore(await api.client().get('/api/siwe/nonce'));
  });

  it('does not carry the secret that signs it', async () => {
    const reply = await api.client().get('/api/siwe/nonce');
    expect(reply.text).not.toContain(NONCE_SECRET);
    expect(reply.text).not.toContain(NONCE_SECRET.slice(0, 16));
  });
});

describe('POST /api/siwe/verify', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi();
  });

  it('signs a wallet in and sets the session cookie with every attribute of the contract', async () => {
    const client = api.client();
    const reply = await client.signIn(wallet);
    const body = expectShape(sessionResponseSchema, reply);
    expect(body.address).toBe(wallet.address);
    expectNoStore(reply);

    expect(SESSION_COOKIE).toBe('__Host-prix_session');
    const cookie = reply.setCookies.find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie, 'no session cookie was set').toBeDefined();
    const attributes = (cookie as string).split(';').map((part) => part.trim().toLowerCase());
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('secure');
    expect(attributes).toContain('samesite=lax');
    expect(attributes).toContain('path=/');
    expect(attributes).toContain(`max-age=${SESSION_TTL_SECONDS}`);
    // A `__Host-` cookie names no Domain, or a browser refuses it.
    expect(attributes.some((part) => part.startsWith('domain='))).toBe(false);
    // The old, unprefixed cookie is not set beside it.
    expect(reply.setCookies.some((line) => line.startsWith('prix_session='))).toBe(false);
  });

  it('uses a session id of 32 random bytes as 43 base64url characters, and stores only its SHA-256', async () => {
    const client = api.client();
    await client.signIn(wallet);
    const token = client.cookie as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.store.dump()).not.toContain(token);
    const session = await api.store.getSession(await sha256Hex(token), api.now().toISOString());
    expect(session).toMatchObject({
      address: wallet.address,
      createdAt: api.now().toISOString(),
      expiresAt: new Date(api.now().getTime() + SESSION_TTL_SECONDS * 1_000).toISOString(),
    });
    // The token is in the cookie only, never in the body.
    expect(api.transcript.filter((entry) => entry.split('\n\n').slice(1).join('\n\n').includes(token))).toEqual([]);
  });

  it('stores and returns the address in lower case, whatever the case in the message', async () => {
    const client = api.client();
    const reply = await client.signIn(wallet);
    expect(wallet.checksumAddress).not.toBe(wallet.address);
    expect(reply.json.address).toBe(wallet.address);
    const me = expectShape(meResponseSchema, await client.get('/api/me'));
    expect(me.address).toBe(wallet.address);
    expect(api.store.users.has(wallet.address)).toBe(true);
  });

  it('gives two sign-ins two different sessions', async () => {
    const first = await api.signedIn(wallet);
    const second = await api.signedIn(wallet);
    expect(first.cookie).not.toBe(second.cookie);
    expect((await first.get('/api/me')).status).toBe(200);
    expect((await second.get('/api/me')).status).toBe(200);
  });

  it('accepts a message with an expiration time that has not passed', async () => {
    const client = api.client();
    const reply = await client.signIn(wallet, { expirationTime: new Date(api.now().getTime() + 60_000).toISOString() });
    expect(reply.status).toBe(200);
  });

  it('accepts a URI on the site origin, with a path', async () => {
    const reply = await api.client().signIn(wallet, { uri: `${SITE_ORIGIN}/sign-in` });
    expect(reply.status).toBe(200);
  });

  it('accepts a message issued up to ten minutes ago, as long as the nonce is alive, and up to a minute ahead', async () => {
    // The clock of a wallet's machine is rarely exact. Sixty seconds ahead is the limit.
    const ahead = await api.client().signIn(wallet, { issuedAt: new Date(api.now().getTime() + 55_000).toISOString() });
    expect(ahead.status).toBe(200);
    const behind = await api
      .client()
      .signIn(wallet, { issuedAt: new Date(api.now().getTime() - 595_000).toISOString() });
    expect(behind.status).toBe(200);
  });

  describe('refuses, with 401 and no detail about which check failed', () => {
    type Change = Parameters<ReturnType<Api['client']>['signIn']>[1];
    /** Flips one character of a nonce, staying inside letters and digits. */
    const tamper = (nonce: string, at: number): string =>
      `${nonce.slice(0, at)}${nonce[at] === 'a' ? 'b' : 'a'}${nonce.slice(at + 1)}`;

    const refusals: [string, (api: Api) => Change | Promise<Change>][] = [
      ['a message for another domain', () => ({ domain: 'prix.evil.test' })],
      ['a message for a domain that only starts with the site host', () => ({ domain: `${SITE_HOST}.evil.test` })],
      ['a message for another URI', () => ({ uri: 'https://prix.evil.test' })],
      ['a message for a URI that only starts with the site origin', () => ({ uri: `${SITE_ORIGIN}.evil.test/` })],
      ['a message for the site over plain HTTP', () => ({ uri: SITE_ORIGIN.replace('https://', 'http://') })],
      ['a message for another chain', () => ({ chainId: 1 })],
      ['a message with another statement', () => ({ statement: 'Sign in to Prix and approve all tokens.' })],
      ['a message of another version', () => ({ version: '2' })],
      [
        'a message that has expired',
        (api) => ({ expirationTime: new Date(api.now().getTime() - 1_000).toISOString() }),
      ],
      [
        'a message issued more than ten minutes ago',
        (api) => ({ issuedAt: new Date(api.now().getTime() - 601_000).toISOString() }),
      ],
      [
        'a message issued more than sixty seconds ahead of the server',
        (api) => ({ issuedAt: new Date(api.now().getTime() + 61_000).toISOString() }),
      ],
      ['a message with a Request ID', () => ({ requestId: 'abc-123' })],
      ['a message with Resources', () => ({ resources: ['https://prix.evil.test/grant'] })],
      ['a message with an empty Resources list', () => ({ resources: [] })],
      ['a signature from another wallet', () => ({ signer: stranger })],
      ['a nonce the server never issued', () => ({ nonce: 'neverissued12345' })],
      ['a nonce of the right shape that the server never issued', () => ({ nonce: `${'Ab3'.repeat(18)}Zz` })],
      [
        'a nonce whose first character was changed',
        async (api) => ({ nonce: tamper((await api.client().get('/api/siwe/nonce')).json.nonce, 0) }),
      ],
      [
        'a nonce whose last character was changed',
        async (api) => ({ nonce: tamper((await api.client().get('/api/siwe/nonce')).json.nonce, 55) }),
      ],
      [
        'a nonce signed with another secret',
        async () => ({
          nonce: (await createApi({ nonceSecret: OTHER_NONCE_SECRET }).client().get('/api/siwe/nonce')).json.nonce,
        }),
      ],
      ['a nonce that has expired', (api) => ({ afterNonce: () => api.advance((NONCE_TTL_SECONDS + 1) * 1_000) })],
      ['a message that is not a sign-in message', () => ({ message: 'Please sign in.' })],
      ['a signature of the wrong bytes', () => ({ signature: `0x${'11'.repeat(64)}1b` })],
    ];

    const messages = new Set<string>();

    it.each(refusals)('%s', async (_name, change) => {
      const client = api.client();
      const reply = await client.signIn(wallet, await change(api));
      expectError(reply, 401, 'unauthorized');
      expect(client.cookie).toBeNull();
      expect(reply.setCookies.some((line) => line.startsWith(`${SESSION_COOKIE}=`) && !/max-age=0/i.test(line))).toBe(
        false,
      );
      expect(api.store.sessions.size).toBe(0);
      // A sign-in that fails writes nothing: no nonce is recorded, no wallet, no session.
      expect(api.store.rowCount()).toBe(0);
      expect(api.store.calls.useNonce ?? 0).toBe(0);
      messages.add(reply.json.error.message);
      // Every refusal reads the same, so a caller cannot learn which check failed.
      expect(messages.size).toBe(1);
    });
  });

  it('refuses a message that is not in the exact layout of EIP-4361', async () => {
    const { nonce } = await signedBody(api);
    const good = siweMessage({
      domain: SITE_HOST,
      address: wallet.checksumAddress,
      statement: SIWE_STATEMENT,
      uri: SITE_ORIGIN,
      chainId: CHAIN_ID,
      nonce,
      issuedAt: api.now().toISOString(),
    });
    const variants = [
      // The same fields, in an order the standard does not allow.
      good.replace(/URI: (.*)\nVersion: 1/, 'Version: 1\nURI: $1'),
      // A field twice: which one counts?
      `${good}\nNonce: ${nonce}`,
      good.replace(`Chain ID: ${CHAIN_ID}`, `Chain ID: 1\nChain ID: ${CHAIN_ID}`),
      // Extra text after the last field, and before the first line.
      `${good}\nApprove: all tokens`,
      `Welcome!\n${good}`,
      // Windows line breaks, a trailing line break, and no blank line around the statement.
      good.replaceAll('\n', '\r\n'),
      `${good}\n`,
      good.replace(`\n\n${SIWE_STATEMENT}\n\n`, `\n${SIWE_STATEMENT}\n`),
      // A chain id that only starts with the right number.
      good.replace(`Chain ID: ${CHAIN_ID}`, `Chain ID: ${CHAIN_ID}0`),
      good.replace(`Chain ID: ${CHAIN_ID}`, `Chain ID: 0x${CHAIN_ID.toString(16)}`),
      // An address that is not the signer's, in the right place.
      good.replace(wallet.checksumAddress, stranger.checksumAddress),
    ];
    for (const message of variants) {
      const reply = await api
        .client()
        .post('/api/siwe/verify', { message, signature: await wallet.signMessage(message) });
      expectError(reply, 401, 'unauthorized');
    }
    expect(api.store.rowCount()).toBe(0);
    // The untouched message still signs in: the nonce was never used up by the refusals.
    const reply = await api
      .client()
      .post('/api/siwe/verify', { message: good, signature: await wallet.signMessage(good) });
    expect(reply.status).toBe(200);
  });

  it('cannot replay a stateless nonce: the same message and signature work once', async () => {
    const client = api.client();
    expect((await client.signIn(wallet)).status).toBe(200);
    const replay = await api.client().post('/api/siwe/verify', client.lastSignIn);
    expectError(replay, 401, 'unauthorized');
    expect(api.store.sessions.size).toBe(1);
    // The use of the nonce is the one thing sign-in remembers about it.
    expect(api.store.nonces.size).toBe(1);
  });

  it('cannot reuse a nonce in a new message, even with a fresh signature', async () => {
    const first = await signedBody(api);
    const used = await api.client().post('/api/siwe/verify', { message: first.message, signature: first.signature });
    expect(used.status).toBe(200);
    api.advance(30_000);
    const message = siweMessage({
      domain: SITE_HOST,
      address: stranger.checksumAddress,
      statement: SIWE_STATEMENT,
      uri: SITE_ORIGIN,
      chainId: CHAIN_ID,
      nonce: first.nonce,
      issuedAt: api.now().toISOString(),
    });
    const reply = await api
      .client()
      .post('/api/siwe/verify', { message, signature: await stranger.signMessage(message) });
    expectError(reply, 401, 'unauthorized');
    expect(api.store.sessions.size).toBe(1);
    expect(api.store.users.has(stranger.address)).toBe(false);
  });

  it('records a used nonce with the expiry of the nonce, so the cleanup can delete it', async () => {
    const issued = (await api.client().get('/api/siwe/nonce')).json;
    const message = siweMessage({
      domain: issued.domain,
      address: wallet.checksumAddress,
      statement: issued.statement,
      uri: issued.uri,
      chainId: issued.chainId,
      nonce: issued.nonce,
      issuedAt: api.now().toISOString(),
    });
    await api.client().post('/api/siwe/verify', { message, signature: await wallet.signMessage(message) });
    expect([...api.store.nonces.values()]).toEqual([issued.expiresAt]);
    // What is stored is not something a reader of the database could sign in with again.
    expect(api.store.nonces.size).toBe(1);
  });

  it('lets exactly one of two simultaneous uses of a nonce sign in', async () => {
    const body = await signedBody(api);
    const replies = await Promise.all([
      api.client().post('/api/siwe/verify', { message: body.message, signature: body.signature }),
      api.client().post('/api/siwe/verify', { message: body.message, signature: body.signature }),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
    expect(api.store.sessions.size).toBe(1);
  });

  it('does not use up the nonce when the signature is wrong', async () => {
    const client = api.client();
    const { message } = await signedBody(api);
    const bad = await client.post('/api/siwe/verify', { message, signature: await stranger.signMessage(message) });
    expectError(bad, 401, 'unauthorized');
    expect(api.store.calls.useNonce ?? 0).toBe(0);
    // The nonce is used last, so the honest wallet can still use it.
    const good = await client.post('/api/siwe/verify', { message, signature: await wallet.signMessage(message) });
    expect(good.status).toBe(200);
  });

  it('answers 400 for a body of the wrong shape: an unknown field, a malformed signature or no JSON at all', async () => {
    // Section 15: the body shape is checked before the message, and is the one failure of this
    // route that is not a 401.
    const { message, signature } = await signedBody(api);
    const fresh = api.client();
    const invalid = (reply: Reply) => expectError(reply, 400, 'invalid_input');
    invalid(await fresh.post('/api/siwe/verify', { message, signature, address: stranger.address }));
    invalid(await fresh.post('/api/siwe/verify', { message, signature: '0x1234' }));
    invalid(await fresh.post('/api/siwe/verify', { message, signature: signature.slice(2) }));
    invalid(await fresh.post('/api/siwe/verify', { message }));
    invalid(await fresh.post('/api/siwe/verify', { signature }));
    invalid(await fresh.post('/api/siwe/verify', { message: '', signature }));
    invalid(await fresh.post('/api/siwe/verify', { message: 'm'.repeat(2_001), signature }));
    invalid(await fresh.post('/api/siwe/verify', { message: 7, signature }));
    invalid(await fresh.post('/api/siwe/verify', [message, signature]));
    invalid(await fresh.post('/api/siwe/verify', undefined, { rawBody: '{"message":' }));
    invalid(await fresh.post('/api/siwe/verify', undefined, { rawBody: '' }));
    expect(fresh.cookie).toBeNull();
    expect(api.store.rowCount()).toBe(0);
    // A refused body did not cost the nonce.
    expect((await fresh.post('/api/siwe/verify', { message, signature })).status).toBe(200);
  });

  it('refuses a request without the site origin, or without a JSON content type, with 403', async () => {
    const client = api.client();
    await client.signIn(wallet);
    const body = client.lastSignIn;
    for (const options of [
      { origin: null },
      { origin: 'https://prix.evil.test' },
      { origin: `${SITE_ORIGIN}.evil.test` },
      { origin: 'null' },
      { contentType: null },
      { contentType: 'text/plain' },
      { contentType: 'application/x-www-form-urlencoded' },
    ]) {
      const reply = await api.client().post('/api/siwe/verify', body, options);
      expectError(reply, 403, 'forbidden');
    }
  });

  it('checks the rate limit first, by IP address, and answers 429', async () => {
    api.limiter.denied.add('sign_in');
    const client = api.client('198.51.100.23');
    const reply = await client.post('/api/siwe/verify', {
      message: 'not even a message',
      signature: `0x${'11'.repeat(65)}`,
    });
    expectError(reply, 429, 'rate_limited');
    expect(api.limiter.asked).toContainEqual({ rule: 'sign_in', subject: '198.51.100.23' });
    expect(api.store.sessions.size).toBe(0);
    // The limit comes before the body shape too.
    expectError(await client.post('/api/siwe/verify', { nothing: true }), 429, 'rate_limited');
  });

  it('takes the IP address from CF-Connecting-IP and from no other header', async () => {
    const client = api.client('198.51.100.40');
    await client.post(
      '/api/siwe/verify',
      { message: 'not even a message', signature: `0x${'11'.repeat(65)}` },
      { headers: { 'X-Forwarded-For': '203.0.113.200', 'X-Real-IP': '203.0.113.201', Forwarded: 'for=203.0.113.202' } },
    );
    const subjects = api.limiter.asked.filter((ask) => ask.rule === 'sign_in').map((ask) => ask.subject);
    expect(subjects.length).toBeGreaterThan(0);
    for (const subject of subjects) expect(subject).not.toMatch(/^203\.0\.113\.20[0-2]$/);
    expect(subjects).toContain('198.51.100.40');
  });
});

describe('sessions', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi();
  });

  const unauthorized = (reply: Reply) => expectError(reply, 401, 'unauthorized');

  it('GET /api/me answers 401 without a session', async () => {
    unauthorized(await api.client().get('/api/me'));
  });

  it('GET /api/me returns the wallet of the session, and is never cached', async () => {
    const client = await api.signedIn(wallet);
    const reply = await client.get('/api/me');
    const me = expectShape(meResponseSchema, reply);
    expect(me).toEqual({ address: wallet.address, isAdmin: false, agent: null, modelKeys: [] });
    expectNoStore(reply);
  });

  it('says whether the wallet is an admin, from the server configuration only', async () => {
    const admin = await api.signedIn(ADMIN_WALLET);
    expect((await admin.get('/api/me')).json.isAdmin).toBe(true);
    const client = await api.signedIn(wallet);
    const reply = await client.get('/api/me', { headers: { 'X-Admin': 'true', 'X-Is-Admin': '1' } });
    expect(reply.json.isAdmin).toBe(false);
  });

  it('refuses a cookie that is not a session', async () => {
    const client = await api.signedIn(wallet);
    const token = client.cookie as string;
    for (const cookie of [
      '',
      'x',
      `${token}x`,
      token.slice(0, -1),
      'a'.repeat(43),
      wallet.address,
      await sha256Hex(token),
    ]) {
      const other = api.client();
      other.cookie = cookie;
      unauthorized(await other.get('/api/me'));
    }
  });

  it('does not accept the session under the old cookie name', async () => {
    const client = await api.signedIn(wallet);
    const reply = await api.client().get('/api/me', { headers: { Cookie: `prix_session=${client.cookie}` } });
    unauthorized(reply);
  });

  it('ends a session when it expires', async () => {
    const client = await api.signedIn(wallet);
    api.advance(SESSION_TTL_SECONDS * 1_000 - 1_000);
    expect((await client.get('/api/me')).status).toBe(200);
    api.advance(2_000);
    unauthorized(await client.get('/api/me'));
  });

  it('logs out: 204, the cookie is cleared and the session is gone from the store', async () => {
    const client = await api.signedIn(wallet);
    const token = client.cookie as string;
    const reply = await client.post('/api/siwe/logout');
    expect(reply.status).toBe(204);
    expect(reply.text).toBe('');
    expect(client.cookie).toBeNull();
    expect(api.store.sessions.size).toBe(0);
    // The old token no longer works, even if a copy of it survived somewhere.
    const thief = api.client();
    thief.cookie = token;
    unauthorized(await thief.get('/api/me'));
  });

  it('logging out needs the site origin and the JSON content type, though it has no body', async () => {
    const client = await api.signedIn(wallet);
    expectError(
      await client.post('/api/siwe/logout', undefined, { origin: 'https://prix.evil.test' }),
      403,
      'forbidden',
    );
    expectError(await client.post('/api/siwe/logout', undefined, { contentType: null }), 403, 'forbidden');
    expectError(await client.post('/api/siwe/logout', undefined, { contentType: 'text/plain' }), 403, 'forbidden');
    expect((await client.get('/api/me')).status).toBe(200);
  });

  it('keeps the sessions of two wallets apart', async () => {
    const first = await api.signedIn(wallet);
    const second = await api.signedIn(stranger);
    expect((await first.get('/api/me')).json.address).toBe(wallet.address);
    expect((await second.get('/api/me')).json.address).toBe(stranger.address);
    await first.post('/api/siwe/logout');
    expect((await second.get('/api/me')).status).toBe(200);
  });
});

describe('the API sends no CORS headers', () => {
  it('on a read, on a write, on a refusal and on a preflight from another origin', async () => {
    const api = createApi();
    const client = await api.signedIn(wallet);
    await client.get('/api/league', { origin: 'https://prix.evil.test' });
    await client.get('/api/me', { origin: 'https://prix.evil.test' });
    await client.post('/api/siwe/logout', undefined, { origin: 'https://prix.evil.test' });
    await api.client().send('OPTIONS', '/api/me', {
      origin: 'https://prix.evil.test',
      contentType: null,
      headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'content-type' },
    });
    await api.client().send('OPTIONS', '/api/agents', {
      origin: SITE_ORIGIN,
      contentType: null,
      headers: { 'Access-Control-Request-Method': 'POST' },
    });
    expect(api.transcript.length).toBeGreaterThan(5);
    for (const entry of api.transcript) {
      const head = entry.split('\n\n')[0] ?? '';
      expect(head.toLowerCase(), head.split('\n')[0]).not.toContain('access-control-');
    }
  });
});
