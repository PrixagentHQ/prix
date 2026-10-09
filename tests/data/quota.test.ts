import { describe, expect, it } from 'vitest';
import { hashApiKey } from '../../apps/api/src/http/data/keys.ts';
import type { DataHarness } from './support/harness.ts';
import { ADMIN_WALLET, createDataHarness, lc, OTHER_ADDRESS, TX_B, testWallet } from './support/harness.ts';

/** docs/contracts/phase-5-data.md section 8 item 3: the quota belongs to the wallet. */

const alice = testWallet(701);
const bob = testWallet(702);
const DAY = '2026-10-06';
const QUOTA = 50;

async function keys(h: DataHarness, wallet: ReturnType<typeof testWallet>, count: number) {
  const cookie = await h.login(wallet);
  const out: { secret: string; id: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const reply = await h.send('POST', '/api/data/keys', { cookie, body: { label: `key ${i}` } });
    expect(reply.status, reply.text).toBe(201);
    out.push({ secret: reply.json.secret, id: reply.json.key.id });
  }
  return { cookie, keys: out };
}

const seasons = (h: DataHarness, key: string) => h.send('GET', '/api/v1/seasons', { key });

describe('one quota per wallet, across all its keys', () => {
  it('uses 50 calls across five keys and refuses call 51 with quota_exceeded, whichever key makes it', async () => {
    const h = await createDataHarness();
    const { keys: five } = await keys(h, alice, 5);
    for (let i = 0; i < QUOTA; i += 1) {
      const reply = await seasons(h, (five[i % 5] as { secret: string }).secret);
      expect(reply.status, `call ${i + 1}: ${reply.text}`).toBe(200);
      expect(reply.headers.get('X-Prix-Quota-Limit')).toBe(String(QUOTA));
      expect(reply.headers.get('X-Prix-Quota-Remaining')).toBe(String(QUOTA - 1 - i));
    }
    for (const key of five) {
      const reply = await seasons(h, key.secret);
      expect(reply.status).toBe(429);
      expect(reply.json.error.code).toBe('quota_exceeded');
      expect(Number(reply.headers.get('Retry-After'))).toBeGreaterThan(0);
    }
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: QUOTA, paidN: 0 });
  });

  it('revoking every key and creating a new one does not reset the count', async () => {
    const h = await createDataHarness();
    const { cookie, keys: three } = await keys(h, alice, 3);
    for (let i = 0; i < QUOTA; i += 1)
      expect((await seasons(h, (three[0] as { secret: string }).secret)).status).toBe(200);
    expect((await seasons(h, (three[1] as { secret: string }).secret)).status).toBe(429);
    for (const key of three) {
      expect((await h.send('DELETE', `/api/data/keys/${key.id}`, { cookie })).status).toBe(204);
    }
    // A revoked key stops at once, with the same answer as a key that never existed.
    const revoked = await seasons(h, (three[0] as { secret: string }).secret);
    expect(revoked.status).toBe(401);
    expect(revoked.json.error.code).toBe('invalid_key');
    const fresh = await h.send('POST', '/api/data/keys', { cookie, body: { label: 'fresh' } });
    expect(fresh.status).toBe(201);
    const after = await seasons(h, fresh.json.secret);
    expect(after.status).toBe(429);
    expect(after.json.error.code).toBe('quota_exceeded');
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: QUOTA, paidN: 0 });
  });

  it('a second wallet is unaffected by the first one using its quota', async () => {
    const h = await createDataHarness();
    const a = await keys(h, alice, 1);
    const b = await keys(h, bob, 1);
    for (let i = 0; i < QUOTA; i += 1) await seasons(h, (a.keys[0] as { secret: string }).secret);
    expect((await seasons(h, (a.keys[0] as { secret: string }).secret)).status).toBe(429);
    const reply = await seasons(h, (b.keys[0] as { secret: string }).secret);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('X-Prix-Quota-Remaining')).toBe(String(QUOTA - 1));
  });

  it('the count starts again on the next UTC day', async () => {
    const h = await createDataHarness();
    const { keys: one } = await keys(h, alice, 1);
    const key = (one[0] as { secret: string }).secret;
    for (let i = 0; i < QUOTA; i += 1) await seasons(h, key);
    expect((await seasons(h, key)).status).toBe(429);
    h.api.setNow('2026-10-07T00:00:01.000Z');
    expect((await seasons(h, key)).status).toBe(200);
  });

  it('a tool call over MCP counts against the same wallet quota as HTTP', async () => {
    const h = await createDataHarness();
    const { keys: one } = await keys(h, alice, 1);
    const key = (one[0] as { secret: string }).secret;
    await seasons(h, key);
    const reply = await h.send('POST', '/api/v1/mcp', {
      key,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_seasons', arguments: {} } },
    });
    expect(reply.json.result.isError).not.toBe(true);
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: 2, paidN: 0 });
  });

  it('GET /api/v1/me is not metered, and says what was used', async () => {
    const h = await createDataHarness();
    const { keys: one } = await keys(h, alice, 1);
    const key = (one[0] as { secret: string }).secret;
    await seasons(h, key);
    await seasons(h, key);
    for (let i = 0; i < 3; i += 1) expect((await h.send('GET', '/api/v1/me', { key })).status).toBe(200);
    const me = await h.send('GET', '/api/v1/me', { key });
    expect(me.json.data).toMatchObject({ usedFree: 2, quotaPerDay: QUOTA, remainingFree: QUOTA - 2 });
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: 2, paidN: 0 });
  });
});

describe('the server ignores what the client claims about its quota', () => {
  it('a quota, tier or key in a header, query or body changes nothing', async () => {
    const h = await createDataHarness();
    const { keys: one } = await keys(h, alice, 1);
    const key = (one[0] as { secret: string }).secret;
    const claims = { 'X-Prix-Quota-Limit': '99999', 'X-Prix-Tier': '3', 'X-Quota': '99999' };
    const reply = await h.send('GET', '/api/v1/me?quota=99999&tier=3', { key, headers: claims });
    expect(reply.status).toBe(400); // strict input: unknown fields are refused
    const plain = await h.send('GET', '/api/v1/me', { key, headers: claims });
    expect(plain.json.data.quotaPerDay).toBe(QUOTA);
    expect(plain.json.data.tier).toBe(0);
    // A key in the query string is never read.
    const viaQuery = await h.send('GET', `/api/v1/seasons?key=${key}`);
    expect(viaQuery.status).toBe(401);
    expect(viaQuery.json.error.code).toBe('missing_key');
  });

  it('the quota comes from the entitlements port of the wallet', async () => {
    const h = await createDataHarness();
    h.entitlements.overrides.set(alice.address, { apiDailyQuota: 2, tier: 0 });
    const { keys: one } = await keys(h, alice, 1);
    const key = (one[0] as { secret: string }).secret;
    expect((await seasons(h, key)).status).toBe(200);
    expect((await seasons(h, key)).status).toBe(200);
    expect((await seasons(h, key)).status).toBe(429);
  });
});

describe('credits continue the calls once the free quota is used', () => {
  it('a wallet with credits goes on as paid calls, 1,000 micro each, and the header says so', async () => {
    const h = await createDataHarness();
    const { keys: one } = await keys(h, alice, 1);
    const key = (one[0] as { secret: string }).secret;
    await h.data.creditPayment({
      txHash: lc(TX_B),
      owner: alice.address,
      amountMicro: 5_000,
      blockNumber: 1,
      creditedAt: h.api.now().toISOString(),
    });
    for (let i = 0; i < QUOTA; i += 1) await seasons(h, key);
    const paid = await seasons(h, key);
    expect(paid.status).toBe(200);
    expect(paid.headers.get('X-Prix-Credits-Micro')).toBe('4000');
    expect(paid.headers.get('X-Prix-Quota-Remaining')).toBe('0');
    expect((await h.data.getCredits(alice.address)).balanceMicro).toBe(4_000);
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: QUOTA, paidN: 1 });
  });
});

describe('the ceiling for everyone', () => {
  it('at the ceiling every wallet gets 503 api_busy and the wallet count is given back', async () => {
    const h = await createDataHarness({ config: { apiDailyCeiling: 4, paidDailyCeiling: 1 } });
    const a = (await keys(h, alice, 1)).keys[0] as { secret: string };
    const b = (await keys(h, bob, 1)).keys[0] as { secret: string };
    for (let i = 0; i < 3; i += 1) expect((await seasons(h, a.secret)).status).toBe(200);
    const busyA = await seasons(h, a.secret);
    expect(busyA.status).toBe(503);
    expect(busyA.json.error.code).toBe('api_busy');
    expect(Number(busyA.headers.get('Retry-After'))).toBeGreaterThan(0);
    const busyB = await seasons(h, b.secret);
    expect(busyB.status).toBe(503);
    expect(busyB.json.error.code).toBe('api_busy');
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: 3, paidN: 0 });
    expect(await h.data.getUsage(DAY, bob.address)).toEqual({ freeN: 0, paidN: 0 });
  });

  it('a paid call is given back too when the ceiling refuses it', async () => {
    const h = await createDataHarness({ config: { apiDailyCeiling: 1 } });
    h.entitlements.overrides.set(alice.address, { apiDailyQuota: 1 });
    const a = (await keys(h, alice, 1)).keys[0] as { secret: string };
    await h.data.creditPayment({
      txHash: lc(TX_B),
      owner: alice.address,
      amountMicro: 5_000,
      blockNumber: 1,
      creditedAt: h.api.now().toISOString(),
    });
    expect((await seasons(h, a.secret)).status).toBe(200);
    expect((await seasons(h, a.secret)).status).toBe(503);
    expect((await h.data.getCredits(alice.address)).balanceMicro).toBe(5_000);
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: 1, paidN: 0 });
  });

  it('a wallet that is over its own quota does not use up the ceiling', async () => {
    const h = await createDataHarness({ config: { apiDailyCeiling: 3, paidDailyCeiling: 1 } });
    h.entitlements.overrides.set(alice.address, { apiDailyQuota: 1 });
    const a = (await keys(h, alice, 1)).keys[0] as { secret: string };
    const b = (await keys(h, bob, 1)).keys[0] as { secret: string };
    expect((await seasons(h, a.secret)).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await seasons(h, a.secret)).json.error.code).toBe('quota_exceeded');
    expect(h.data.global.get(`${DAY}|api`)).toBe(1);
    expect((await seasons(h, b.secret)).status).toBe(200);
  });
});

describe('what a refusal and a server error cost', () => {
  it('a call refused for quota, for bad input or for a missing key changes no counter and writes nothing', async () => {
    const h = await createDataHarness();
    h.entitlements.overrides.set(alice.address, { apiDailyQuota: 1 });
    const a = (await keys(h, alice, 1)).keys[0] as { secret: string };
    expect((await seasons(h, a.secret)).status).toBe(200);
    const before = { counters: h.data.counters(), writes: h.data.writes };
    expect((await seasons(h, a.secret)).status).toBe(429);
    expect((await h.send('GET', '/api/v1/agents/not-an-id!', { key: a.secret })).status).toBe(400);
    expect((await h.send('GET', '/api/v1/seasons')).status).toBe(401);
    expect((await h.send('GET', '/api/v1/seasons', { key: `prix_${'a'.repeat(52)}` })).status).toBe(401);
    expect({ counters: h.data.counters(), writes: h.data.writes }).toEqual(before);
  });

  it('a handler 5xx gives the call back, and a 404 is a served call', async () => {
    const h = await createDataHarness();
    const a = (await keys(h, alice, 1)).keys[0] as { secret: string };
    h.chain.fail = true;
    const failed = await h.send('GET', `/api/v1/trust/developers/${OTHER_ADDRESS}`, { key: a.secret });
    expect(failed.status).toBe(503);
    expect(failed.json.error.code).toBe('chain_unavailable');
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: 0, paidN: 0 });
    const missing = await h.send('GET', '/api/v1/agents/aaaaaaaaaaaa', { key: a.secret });
    expect(missing.status).toBe(404);
    expect(await h.data.getUsage(DAY, alice.address)).toEqual({ freeN: 1, paidN: 0 });
  });

  it('a 5xx on a paid call gives the credits back', async () => {
    const h = await createDataHarness();
    h.entitlements.overrides.set(alice.address, { apiDailyQuota: 1 });
    const a = (await keys(h, alice, 1)).keys[0] as { secret: string };
    await h.data.creditPayment({
      txHash: lc(TX_B),
      owner: alice.address,
      amountMicro: 3_000,
      blockNumber: 1,
      creditedAt: h.api.now().toISOString(),
    });
    expect((await seasons(h, a.secret)).status).toBe(200);
    h.chain.fail = true;
    expect((await h.send('GET', `/api/v1/trust/tokens/${OTHER_ADDRESS}`, { key: a.secret })).status).toBe(503);
    expect((await h.data.getCredits(alice.address)).balanceMicro).toBe(3_000);
    expect((await h.data.getUsage(DAY, alice.address)).paidN).toBe(0);
  });
});

describe('keys', () => {
  it('a key of a blocked wallet is invalid_key, with the same answer as an unknown key', async () => {
    const h = await createDataHarness();
    const a = (await keys(h, alice, 1)).keys[0] as { secret: string };
    expect((await seasons(h, a.secret)).status).toBe(200);
    const admin = await h.login(ADMIN_WALLET);
    const blocked = await h.send('POST', `/api/data/admin/blocks/${alice.address}`, { cookie: admin, body: {} });
    expect(blocked.status).toBe(204);
    const reply = await seasons(h, a.secret);
    const unknown = await seasons(h, `prix_${'b'.repeat(52)}`);
    expect(reply.status).toBe(401);
    expect(reply.json.error.code).toBe('invalid_key');
    expect(reply.json).toEqual(unknown.json);
    // A blocked wallet cannot make a new key either.
    const cookie = await h.login(alice);
    const again = await h.send('POST', '/api/data/keys', { cookie, body: { label: 'again' } });
    expect(again.status).toBe(403);
  });

  it('a wallet that is not an admin cannot block another wallet', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(bob);
    const reply = await h.send('POST', `/api/data/admin/blocks/${alice.address}`, { cookie, body: {} });
    expect(reply.status).toBe(403);
    expect(await h.data.isBlocked(alice.address)).toBe(false);
  });

  it('the key is stored only as a hash and the secret appears only in the response that created it', async () => {
    const h = await createDataHarness();
    const cookie = await h.login(alice);
    const created = await h.send('POST', '/api/data/keys', { cookie, body: { label: 'mine' } });
    const secret = created.json.secret as string;
    await seasons(h, secret);
    await h.send('GET', '/api/data/keys', { cookie });
    await h.send('GET', '/api/v1/me', { key: secret });
    await h.send('GET', '/api/data/usage', { cookie });
    await h.send('DELETE', `/api/data/keys/${created.json.key.id}`, { cookie });
    await seasons(h, secret);

    const dump = h.data.dump();
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(secret.slice(5));
    const [stored] = [...h.data.keys.values()];
    expect(stored?.keyHash).toBe(await hashApiKey(secret));
    expect(stored?.keyHash).not.toBe(secret);
    expect(stored?.prefix).toBe(secret.slice(0, 12));

    const withSecret = h.transcript.filter((entry) => entry.includes(secret));
    // Only the request that sent it back in a header is absent from the transcript; the one answer that holds it is the creation.
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0]?.startsWith('POST /api/data/keys ->')).toBe(true);
  });

  it('a key never reaches a log line', async () => {
    const h = await createDataHarness();
    const logged: string[] = [];
    const original = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    console.error = console.log;
    console.warn = console.log;
    try {
      const { keys: one } = await keys(h, alice, 1);
      const key = (one[0] as { secret: string }).secret;
      h.chain.fail = true;
      await seasons(h, key);
      await h.send('GET', `/api/v1/trust/developers/${OTHER_ADDRESS}`, { key });
      await h.send('GET', '/api/v1/seasons', { key: `${key}x` });
      expect(logged.join('\n')).not.toContain(key);
    } finally {
      console.log = original;
      console.error = originalError;
      console.warn = originalWarn;
    }
  });
});
