import type { AgentRecord } from '@prix/contracts';
import {
  entitlementsOfTier,
  OPEN_PREVIEW_ENTITLEMENTS,
  SCORING_METHOD,
  TOKEN_CACHE_SECONDS,
  TOKEN_CONFIG_CACHE_SECONDS,
  TOKEN_STALE_GRACE_SECONDS,
  tokenMeResponseSchema,
} from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_WALLET, expectError, expectShape, PROMPT } from '../support/api.ts';
import { testWallet } from '../support/eth.ts';
import { makeRow, makeTick, SEASON_1, startingStats, utc } from '../support/fixtures.ts';
import {
  BALANCE_OF_TIER,
  createTokenHarness,
  OTHER_TOKEN,
  SLOTS,
  THRESHOLDS,
  TOKEN,
  type TokenHarness,
} from './support.ts';

/**
 * docs/contracts/phase-4-token.md section 5.4, items 1 to 3, and the `cachedOnly` option of
 * section 5.2. The chain is the fake of ./support.ts, read by the real reader; the clock is the
 * test's own.
 */

const alice = testWallet(11);
const bob = testWallet(12);

let h: TokenHarness;
beforeEach(() => {
  h = createTokenHarness();
});

const body = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  prompt: PROMPT,
  division: 'open',
  ...extra,
});

describe('no gated route trusts the client (item 1)', () => {
  beforeEach(async () => {
    await h.configure({ enabled: true, tokenAddress: TOKEN });
  });

  it('refuses a body that names a tier, slots or a balance with 400', async () => {
    h.chain.setTier(alice.address, 0);
    const client = await h.signedIn(alice);
    for (const [field, value] of [
      ['tier', 3],
      ['maxAgents', 25],
      ['balance', BALANCE_OF_TIER[3].toString()],
    ] as const) {
      expectError(await client.post('/api/agents', body('Forger One', { [field]: value })), 400, 'invalid_input');
    }
    expect(h.agentsOf(alice.address)).toHaveLength(0);
  });

  it('gives the second agent of a tier 0 wallet 409, whatever headers and query say about a tier', async () => {
    h.chain.setTier(alice.address, 0);
    const client = await h.signedIn(alice);
    expect((await client.post('/api/agents', body('First One'))).status).toBe(201);
    const claims = {
      'X-Tier': '3',
      'X-Prix-Tier': '3',
      'X-Max-Agents': '25',
      'X-Token-Balance': BALANCE_OF_TIER[3].toString(),
      'X-Entitlements': JSON.stringify({ tier: 3, maxAgents: 25 }),
    };
    const reply = await client.post('/api/agents?tier=3&maxAgents=25&balance=1', body('Second One'), {
      headers: claims,
    });
    expectError(reply, 409, 'owner_has_agent');
    expect(h.agentsOf(alice.address)).toHaveLength(1);
  });

  it('lets a tier 1 wallet have three agents and refuses the fourth', async () => {
    await h.grant(bob, 1);
    const client = await h.signedIn(bob);
    for (const name of ['Bob One', 'Bob Two', 'Bob Three']) {
      expect((await client.post('/api/agents', body(name))).status, name).toBe(201);
    }
    expectError(await client.post('/api/agents', body('Bob Four')), 409, 'owner_has_agent');
    expect(h.agentsOf(bob.address)).toHaveLength(SLOTS[1]);
  });

  it('asks the chain only about the signed-in wallet and only about the configured token', async () => {
    h.chain.setTier(alice.address, 1);
    const client = await h.signedIn(alice);
    await client.post('/api/agents', body('Chain One'));
    await client.get(`/api/token/me?token=${OTHER_TOKEN}&wallet=${bob.address}&tier=3`, {
      headers: { 'X-Token': OTHER_TOKEN, 'X-Wallet': bob.address },
    });
    expect(h.chain.calls.length).toBeGreaterThan(0);
    expect(h.chain.calls.every((call) => call.hasToken)).toBe(true);
    expect([...h.chain.askedWallets()]).toEqual([alice.address]);
  });

  it('reports the tier the chain gave and ignores a tier in the query of /api/token/me', async () => {
    h.chain.setTier(alice.address, 0);
    const client = await h.signedIn(alice);
    const me = expectShape(
      tokenMeResponseSchema,
      await client.get('/api/token/me?tier=3&maxAgents=25', { headers: { 'X-Tier': '3' } }),
    );
    expect(me.tier).toBe(0);
    expect(me.entitlements.maxAgents).toBe(SLOTS[0]);
    expect(me.balance).toBe('0');
  });

  it('never reads the chain for a visitor who is not signed in', async () => {
    const visitor = h.client();
    expect((await visitor.get('/api/token')).status).toBe(200);
    expectError(await visitor.get('/api/token/me'), 401, 'unauthorized');
    expect(h.chain.calls).toHaveLength(0);
    expect(await h.service.entitlementsFor(null)).toEqual(entitlementsOfTier(0));
    expect(h.chain.calls).toHaveLength(0);
  });

  it('gives a wallet the open preview, and reads no chain, while gating is off', async () => {
    await h.configure({ enabled: false });
    h.chain.setTier(alice.address, 3);
    const client = await h.signedIn(alice);
    expect((await client.post('/api/agents', body('Preview One'))).status).toBe(201);
    expectError(await client.post('/api/agents', body('Preview Two')), 409, 'owner_has_agent');
    expect(h.chain.calls).toHaveLength(0);
  });
});

describe('selling removes the entitlement (item 2)', () => {
  async function fourAgents(
    wallet = alice,
  ): Promise<{ agents: AgentRecord[]; client: Awaited<ReturnType<TokenHarness['signedIn']>> }> {
    await h.configure({ enabled: true, tokenAddress: TOKEN });
    await h.grant(wallet, 2);
    const client = await h.signedIn(wallet);
    for (const name of ['Keep One', 'Keep Two', 'Keep Three', 'Newest One']) {
      expect((await client.post('/api/agents', body(name))).status, name).toBe(201);
      // Creation order is the order of the slots; a second apart so it never ties.
      h.advanceSeconds(1);
    }
    return { agents: h.agentsOf(wallet.address), client };
  }

  /** A decision row, an equity and a rank for every agent, as a league that has run for days has. */
  async function giveRecords(agents: readonly AgentRecord[]): Promise<void> {
    const at = utc('2026-10-06T15:00:00.000Z');
    expect(await h.store.createTick(makeTick(at, { daily: true }))).toBe(true);
    const tickId = '2026-10-06T15:00Z';
    let index = 0;
    for (const agent of agents) {
      index += 1;
      const stats = {
        ...startingStats(),
        seasonReturnBps: index * 100,
        tradingDays: 5,
        decidedCount: 6,
        equityMicro: 10_000_000_000 + index * 100_000_000,
      };
      expect(await h.store.writeDecision(makeRow({ agent, tickId, status: 'decided' }), stats, 0)).toBe(true);
    }
    await h.store.rerank(SEASON_1.id, 'open', tickId, at.toISOString(), SCORING_METHOD);
  }

  async function records(agents: readonly AgentRecord[]) {
    const portfolios = [];
    for (const agent of agents) portfolios.push(await h.store.getPortfolio(agent.id, SEASON_1.id));
    return { decisions: h.store.decisions.size, portfolios };
  }

  async function dropAndSweep(tier: 0 | 1 | 2 | 3, wallet = alice) {
    h.chain.setTier(wallet.address, tier);
    h.advanceSeconds(31 * 60);
    return h.service.sweep(h.api.now());
  }

  it('pauses the newest agent of a wallet that fell to tier 1, keeps every record, and resumes it on a rise', async () => {
    const { agents } = await fourAgents();
    await giveRecords(agents);
    const before = await records(agents);
    expect(before.portfolios.every((row) => row?.rank !== null)).toBe(true);

    const drop = await dropAndSweep(1);
    expect(drop).toMatchObject({ action: 'swept', paused: 1, resumed: 0 });
    const after = h.agentsOf(alice.address);
    expect(after.slice(0, 3).map((agent) => agent.status)).toEqual(['active', 'active', 'active']);
    expect(after[3]).toMatchObject({ id: agents[3]?.id, status: 'paused', pausedReason: 'slot_limit' });
    // Nothing was deleted: the same agents, decisions, portfolios and ranks.
    expect(after.map((agent) => agent.id)).toEqual(agents.map((agent) => agent.id));
    expect(await records(agents)).toEqual(before);

    // A rise waits for a second read an hour later.
    expect(await dropAndSweep(2)).toMatchObject({ resumed: 0 });
    h.advanceSeconds(31 * 60);
    const rise = await dropAndSweep(2);
    expect(rise).toMatchObject({ action: 'swept', paused: 0, resumed: 1 });
    const resumed = h.agentsOf(alice.address)[3];
    expect(resumed).toMatchObject({ status: 'active', pausedReason: null });
    // The round in progress does not use a resumed agent.
    expect(resumed?.strategyChangedAt).toBe(h.api.now().toISOString());
    expect(await records(agents)).toEqual(before);
  });

  it('changes nothing on a second sweep with the same balances', async () => {
    await fourAgents();
    await dropAndSweep(1);
    const snapshot = JSON.stringify(h.agentsOf(alice.address));
    h.advanceSeconds(31 * 60);
    const again = await h.service.sweep(h.api.now());
    expect(again).toMatchObject({ paused: 0, resumed: 0 });
    expect(JSON.stringify(h.agentsOf(alice.address))).toBe(snapshot);
  });

  it('keeps an agent that its owner paused paused, in the slots and beyond them', async () => {
    const { agents } = await fourAgents();
    const second = agents[1] as AgentRecord;
    expect(
      await h.store.updateAgent(second.id, { status: 'paused', pausedReason: 'owner' }, h.api.now().toISOString()),
    ).toBe('updated');

    await dropAndSweep(1);
    let now = h.agentsOf(alice.address);
    expect(now[1]).toMatchObject({ status: 'paused', pausedReason: 'owner' });
    // Three slots are numbered over all four agents, so the newest is still beyond them and is paused for slots.
    expect(now[3]).toMatchObject({ status: 'paused', pausedReason: 'slot_limit' });

    await dropAndSweep(2);
    h.advanceSeconds(31 * 60);
    await dropAndSweep(2);
    now = h.agentsOf(alice.address);
    expect(now[1]).toMatchObject({ status: 'paused', pausedReason: 'owner' });
    expect(now[3]).toMatchObject({ status: 'active', pausedReason: null });
  });

  it('never resumes an agent that its owner paused beyond the slots, and never marks it for slots', async () => {
    const { agents } = await fourAgents();
    const newest = agents[3] as AgentRecord;
    await h.store.updateAgent(newest.id, { status: 'paused', pausedReason: 'owner' }, h.api.now().toISOString());
    await dropAndSweep(1);
    expect(h.agentsOf(alice.address)[3]).toMatchObject({ status: 'paused', pausedReason: 'owner' });
    await dropAndSweep(3);
    expect(h.agentsOf(alice.address)[3]).toMatchObject({ status: 'paused', pausedReason: 'owner' });
  });

  it('pauses every agent beyond the first when a wallet falls to tier 0, and keeps the oldest', async () => {
    const { agents } = await fourAgents();
    expect(await dropAndSweep(0)).toMatchObject({ paused: 3 });
    const now = h.agentsOf(alice.address);
    expect(now[0]).toMatchObject({ id: agents[0]?.id, status: 'active' });
    expect(now.slice(1).map((agent) => agent.pausedReason)).toEqual(['slot_limit', 'slot_limit', 'slot_limit']);
  });
});

describe('the flag flips with no deploy (item 3)', () => {
  it('moves from the open preview to the tier table, and back, within the configuration window', async () => {
    h.chain.setTier(alice.address, 2);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(OPEN_PREVIEW_ENTITLEMENTS);
    expect(h.chain.calls).toHaveLength(0);

    // Another isolate writes the row: this one holds the old row for TOKEN_CONFIG_CACHE_SECONDS.
    await h.configure({ enabled: true, tokenAddress: TOKEN });
    h.advanceSeconds(TOKEN_CONFIG_CACHE_SECONDS - 1);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(OPEN_PREVIEW_ENTITLEMENTS);

    h.advanceSeconds(2);
    // The first read only starts a rise; the second, an hour later, grants it.
    expect(await h.service.entitlementsFor(alice.address)).toEqual(entitlementsOfTier(0));
    h.advanceSeconds(61 * 60);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(entitlementsOfTier(2));
    expect(await h.service.entitlementsFor(null)).toEqual(entitlementsOfTier(0));

    await h.configure({ enabled: false });
    h.advanceSeconds(TOKEN_CONFIG_CACHE_SECONDS - 1);
    expect((await h.service.entitlementsFor(alice.address)).gatingOn).toBe(true);
    h.advanceSeconds(2);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(OPEN_PREVIEW_ENTITLEMENTS);
    expect(await h.service.entitlementsFor(null)).toEqual(OPEN_PREVIEW_ENTITLEMENTS);
  });

  it('is switched by PUT /api/admin/token/config, which only an admin may call and which verifies the token on the chain', async () => {
    const config = { enabled: true, tokenAddress: TOKEN, thresholdsPpm: THRESHOLDS, buyUrl: null };

    const plain = await h.signedIn(alice);
    expectError(await plain.send('PUT', '/api/admin/token/config', { body: config }), 403, 'forbidden');
    expect(h.tokenStore.config.enabled).toBe(false);

    const admin = await h.signedIn(ADMIN_WALLET);
    h.chain.setTier(alice.address, 2);
    const reply = await admin.send('PUT', '/api/admin/token/config', { body: config });
    expect(reply.status, reply.text).toBe(200);
    expect(h.chain.calls.every((call) => call.hasToken)).toBe(true);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(entitlementsOfTier(0));
    h.advanceSeconds(61 * 60);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(entitlementsOfTier(2));

    const off = await admin.send('PUT', '/api/admin/token/config', { body: { ...config, enabled: false } });
    expect(off.status, off.text).toBe(200);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(OPEN_PREVIEW_ENTITLEMENTS);
  });

  it('refuses an address that is not a token on the chain and writes nothing', async () => {
    const admin = await h.signedIn(ADMIN_WALLET);
    const reply = await admin.send('PUT', '/api/admin/token/config', {
      body: { enabled: false, tokenAddress: OTHER_TOKEN, thresholdsPpm: THRESHOLDS, buyUrl: null },
    });
    expect(reply.status).toBe(400);
    expect(h.tokenStore.config.tokenAddress).toBeNull();
    expect(h.tokenStore.writes.putConfig).toBe(0);
  });
});

describe('cachedOnly never reads the chain', () => {
  beforeEach(async () => {
    await h.configure({ enabled: true, tokenAddress: TOKEN });
    h.chain.setTier(alice.address, 3);
    h.tokenStore.writes = { putConfig: 0, putHolders: 0, applySlots: 0 };
  });

  async function seedRow(ageSeconds: number, tier: 0 | 1 | 2 | 3) {
    await h.tokenStore.putHolders([
      {
        address: alice.address,
        balance: BALANCE_OF_TIER[tier].toString(),
        totalSupply: (10n ** 27n).toString(),
        decimals: 18,
        tier,
        maxAgents: SLOTS[tier],
        tokenAddress: TOKEN,
        checkedAt: new Date(h.api.now().getTime() - ageSeconds * 1000).toISOString(),
      },
    ]);
    h.tokenStore.writes = { putConfig: 0, putHolders: 0, applySlots: 0 };
  }

  it('answers tier 0 for a wallet it has no memory of, with no chain call and no write', async () => {
    expect(await h.service.entitlementsFor(alice.address, { cachedOnly: true })).toEqual(entitlementsOfTier(0));
    expect(h.chain.calls).toHaveLength(0);
    expect(h.tokenStore.holders.size).toBe(0);
    expect(h.tokenStore.writes).toEqual({ putConfig: 0, putHolders: 0, applySlots: 0 });
  });

  it('uses a stored row of any age under the grace period, even when it is due for a read', async () => {
    await seedRow(TOKEN_CACHE_SECONDS * 4, 2);
    expect(await h.service.entitlementsFor(alice.address, { cachedOnly: true })).toEqual(entitlementsOfTier(2));
    expect(h.chain.calls).toHaveLength(0);
    expect(h.tokenStore.writes).toEqual({ putConfig: 0, putHolders: 0, applySlots: 0 });
  });

  it('answers tier 0 for a row older than the grace period', async () => {
    await seedRow(TOKEN_STALE_GRACE_SECONDS + 60, 2);
    expect(await h.service.entitlementsFor(alice.address, { cachedOnly: true })).toEqual(entitlementsOfTier(0));
    expect(h.chain.calls).toHaveLength(0);
  });

  it('uses the isolate memory a normal read left, and a normal read after it still makes exactly one chain call', async () => {
    expect(await h.service.entitlementsFor(alice.address)).toEqual(entitlementsOfTier(0));
    expect(h.chain.calls).toHaveLength(1);
    h.advanceSeconds(61 * 60);
    expect(await h.service.entitlementsFor(alice.address)).toEqual(entitlementsOfTier(3));
    expect(h.chain.calls).toHaveLength(2);
    h.chain.calls.length = 0;
    expect(await h.service.entitlementsFor(alice.address, { cachedOnly: true })).toEqual(entitlementsOfTier(3));
    expect(h.chain.calls).toHaveLength(0);
  });

  it('does not read the chain for a wallet whose chain is down either', async () => {
    h.chain.mode = 'down';
    expect(await h.service.entitlementsFor(alice.address, { cachedOnly: true })).toEqual(entitlementsOfTier(0));
    expect(h.chain.calls).toHaveLength(0);
  });
});
