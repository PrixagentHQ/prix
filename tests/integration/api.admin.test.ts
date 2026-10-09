import type { AgentStats } from '@prix/contracts';
import { holdsResponseSchema, leagueResponseSchema, meResponseSchema, SCORING_METHOD } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api, Client } from '../support/api.ts';
import { ADMIN_WALLET, createApi, expectError, expectNoStore, expectShape, PROMPT } from '../support/api.ts';
import { testWallet } from '../support/eth.ts';
import { makeTick, SEASON_1, testId, utc } from '../support/fixtures.ts';

/**
 * The admin routes of docs/CONTRACTS.md section 4, and the rule that a hidden agent does
 * not exist for the public: its page is 404 and the league leaves it out.
 */

const owner = testWallet(1);
const bystander = testWallet(2);
const T2 = '2026-10-06T14:00Z';
const NOW = '2026-10-06T14:10:00.000Z';

const ranked = (seasonReturnBps: number): Partial<AgentStats> => ({
  seasonReturnBps,
  equityMicro: 10_000_000_000 + seasonReturnBps * 1_000_000,
  tradingDays: 5,
  decidedCount: 5,
});

describe('hiding an agent', () => {
  let api: Api;
  let admin: Client;
  let ownerClient: Client;
  let agentId: string;

  beforeEach(async () => {
    api = createApi({ now: NOW });
    admin = await api.signedIn(ADMIN_WALLET);
    ownerClient = await api.signedIn(owner);
    const created = await ownerClient.post('/api/agents', {
      name: 'Slow Compounder',
      prompt: PROMPT,
      division: 'open',
    });
    expect(created.status).toBe(201);
    agentId = created.json.agent.id;
  });

  const hide = (client: Client, hidden: boolean, id = agentId) =>
    client.post(`/api/admin/agents/${id}/hidden`, { hidden });
  const publicPage = () => api.client().get(`/api/agents/${agentId}`);
  const leagueIds = async () =>
    expectShape(leagueResponseSchema, await api.client().get('/api/league')).rows.map((row) => row.agentId);

  it('is visible to everyone before it is hidden', async () => {
    expect((await publicPage()).status).toBe(200);
    expect(await leagueIds()).toEqual([agentId]);
  });

  it('answers 404 on the public page of a hidden agent, exactly as for an agent that never existed', async () => {
    const reply = await hide(admin, true);
    expect(reply.status).toBe(204);
    expect(reply.text).toBe('');

    const hidden = await publicPage();
    expectError(hidden, 404, 'not_found');
    const never = await api.client().get(`/api/agents/${testId('agent', 404)}`);
    expectError(never, 404, 'not_found');
    // Same body, so the answer does not reveal that a hidden agent is there.
    expect(hidden.json).toEqual(never.json);
    expect(hidden.text).not.toContain('Slow Compounder');
  });

  it('answers 404 to the owner and to an admin too on the public page', async () => {
    await hide(admin, true);
    expectError(await ownerClient.get(`/api/agents/${agentId}`), 404, 'not_found');
    expectError(await admin.get(`/api/agents/${agentId}`), 404, 'not_found');
  });

  it('leaves a hidden agent out of the league', async () => {
    await hide(admin, true);
    expect(await leagueIds()).toEqual([]);
    const reply = await api.client().get('/api/league');
    expect(reply.text).not.toContain('Slow Compounder');
    expect(reply.text).not.toContain(agentId);
  });

  it('still shows a hidden agent to its owner in GET /api/me, marked hidden and nothing else: hidden is not paused', async () => {
    await hide(admin, true);
    const reply = await ownerClient.get('/api/me');
    const me = expectShape(meResponseSchema, reply);
    expectNoStore(reply);
    expect(me.agent).toMatchObject({
      id: agentId,
      hidden: true,
      status: 'active',
      pausedReason: null,
      prompt: PROMPT,
    });
  });

  it('does not schedule a hidden agent, so it gets no more rows, and does not pause it', async () => {
    await hide(admin, true);
    await api.store.createTick(makeTick(utc('2026-10-06T15:00:00.000Z'), { daily: true }));
    expect(await api.store.countPendingAgents('2026-10-06T15:00Z', 'open')).toBe(0);
    expect(await api.store.getAgent(agentId)).toMatchObject({ hidden: true, status: 'active', pausedReason: null });
  });

  it('unhiding restores exactly what the agent was: nothing else was changed by hiding', async () => {
    await ownerClient.patch(`/api/agents/${agentId}`, { paused: true });
    const before = await api.store.getAgent(agentId);
    await hide(admin, true);
    await hide(admin, false);
    expect(await api.store.getAgent(agentId)).toEqual({ ...before, hidden: false });
    expect((await publicPage()).status).toBe(200);
  });

  it('does not let the owner bring a hidden agent back', async () => {
    await hide(admin, true);
    await ownerClient.patch(`/api/agents/${agentId}`, { paused: false });
    await ownerClient.patch(`/api/agents/${agentId}`, { paused: true });
    await ownerClient.patch(`/api/agents/${agentId}`, { paused: false });
    await ownerClient.patch(`/api/agents/${agentId}`, { name: 'Renamed Agent' });
    // Whatever the owner does to the agent, it stays hidden, off the page and off the schedule.
    expect((await api.store.getAgent(agentId))?.hidden).toBe(true);
    expectError(await publicPage(), 404, 'not_found');
    expect(await leagueIds()).toEqual([]);
    // The owner cannot use the admin route either.
    expectError(await hide(ownerClient, false), 403, 'forbidden');
    expect((await api.store.getAgent(agentId))?.hidden).toBe(true);
  });

  it('still counts the hidden agent as the one agent of its wallet', async () => {
    await hide(admin, true);
    const again = await ownerClient.post('/api/agents', { name: 'Second Try', prompt: PROMPT, division: 'open' });
    expectError(again, 409, 'owner_has_agent');
  });

  it('keeps the name of a hidden agent taken', async () => {
    await hide(admin, true);
    const other = await api.signedIn(bystander);
    expectError(
      await other.post('/api/agents', { name: 'slow compounder', prompt: PROMPT, division: 'open' }),
      409,
      'name_taken',
    );
  });

  it('makes the agent visible and active again when an admin unhides it', async () => {
    await hide(admin, true);
    expect((await hide(admin, false)).status).toBe(204);
    expect(await api.store.getAgent(agentId)).toMatchObject({ hidden: false, status: 'active', pausedReason: null });
    expect((await publicPage()).status).toBe(200);
    expect(await leagueIds()).toEqual([agentId]);
  });

  it('shows an agent that its owner had paused again when an admin unhides it, and leaves it paused', async () => {
    await ownerClient.patch(`/api/agents/${agentId}`, { paused: true });
    await hide(admin, true);
    await hide(admin, false);
    const agent = await api.store.getAgent(agentId);
    expect(agent?.hidden).toBe(false);
    // Hidden is separate from paused: unhiding restores exactly what the agent was, so the owner's pause stays.
    expect(agent).toMatchObject({ status: 'paused', pausedReason: 'owner' });
  });

  it('reranks the division at once, so the table is right without waiting for a round', async () => {
    await api.store.createTick(makeTick(utc('2026-10-06T14:00:00.000Z'), { status: 'complete' }));
    const leader = await api.seedAgent({ n: 1, stats: ranked(900), tickId: T2 });
    const second = await api.seedAgent({ n: 2, stats: ranked(300), tickId: T2 });
    const third = await api.seedAgent({ n: 3, stats: ranked(100), tickId: T2 });
    await api.store.rerank(SEASON_1.id, 'open', T2, NOW, SCORING_METHOD);
    const table = async () => {
      const body = expectShape(leagueResponseSchema, await api.client().get('/api/league'));
      return {
        ranks: body.rows.filter((row) => row.rank !== null).map((row) => [row.agentId, row.rank]),
        state: body.state,
      };
    };
    expect((await table()).ranks).toEqual([
      [leader.id, 1],
      [second.id, 2],
      [third.id, 3],
    ]);

    expect((await hide(admin, true, leader.id)).status).toBe(204);
    const after = await table();
    expect(after.ranks).toEqual([
      [second.id, 1],
      [third.id, 2],
    ]);
    expect(after.state).toMatchObject({ tickId: T2, rankedCount: 2, method: 'v1' });
    expect((await api.client().get(`/api/agents/${second.id}`)).json).toMatchObject({ rank: 1, rankedCount: 2 });

    // Unhidden, the agent is on the table again. It has a row at the league's tick, so it is ranked.
    expect((await hide(admin, false, leader.id)).status).toBe(204);
    expect((await table()).ranks).toEqual([
      [leader.id, 1],
      [second.id, 2],
      [third.id, 3],
    ]);
  });

  it('refuses everyone who is not an admin', async () => {
    expectError(await hide(api.client(), true), 401, 'unauthorized');
    expectError(await hide(ownerClient, true), 403, 'forbidden');
    expectError(await hide(await api.signedIn(bystander), true), 403, 'forbidden');
    expect((await api.store.getAgent(agentId))?.hidden).toBe(false);
  });

  it('does not take a claim of being an admin from the request', async () => {
    const reply = await ownerClient.post(
      `/api/admin/agents/${agentId}/hidden`,
      { hidden: true },
      {
        headers: {
          'X-Admin': 'true',
          'X-Admin-Address': ADMIN_WALLET.address,
          'X-Forwarded-User': ADMIN_WALLET.address,
        },
      },
    );
    expectError(reply, 403, 'forbidden');
    const withField = await ownerClient.post(`/api/admin/agents/${agentId}/hidden`, { hidden: true, isAdmin: true });
    expectError(withField, 403, 'forbidden');
    expect((await api.store.getAgent(agentId))?.hidden).toBe(false);
  });

  it('refuses a malformed request from an admin, and 404 for an agent that does not exist', async () => {
    expectError(await admin.post(`/api/admin/agents/${agentId}/hidden`, { hidden: 'yes' }), 400, 'invalid_input');
    expectError(
      await admin.post(`/api/admin/agents/${agentId}/hidden`, { hidden: true, reason: 'spam' }),
      400,
      'invalid_input',
    );
    expectError(await admin.post(`/api/admin/agents/${agentId}/hidden`, {}), 400, 'invalid_input');
    expectError(await hide(admin, true, testId('agent', 404)), 404, 'not_found');
    expectError(
      await admin.post(`/api/admin/agents/${agentId}/hidden`, { hidden: true }, { origin: null }),
      403,
      'forbidden',
    );
    expect((await api.store.getAgent(agentId))?.hidden).toBe(false);
  });
});

describe('symbols held for review', () => {
  let api: Api;
  let admin: Client;
  const hold = {
    symbol: 'NVDA',
    priceMicro: 182_410_000,
    seenPriceMicro: 91_205_000,
    sinceTickId: T2,
    releasedAt: null,
    createdAt: NOW,
  };

  beforeEach(async () => {
    api = createApi({ now: NOW });
    admin = await api.signedIn(ADMIN_WALLET);
    await api.store.putSymbolHold(hold);
  });

  it('lists the holds for an admin', async () => {
    const reply = await admin.get('/api/admin/holds');
    expect(expectShape(holdsResponseSchema, reply).holds).toEqual([hold]);
    expectNoStore(reply);
  });

  it('releases a hold: 204, and the row stays, marked released, for the scheduler to take at the next tick', async () => {
    const reply = await admin.post('/api/admin/holds/NVDA/release');
    expect(reply.status).toBe(204);
    expect(await api.store.listSymbolHolds()).toEqual([{ ...hold, releasedAt: NOW }]);
    expect(expectShape(holdsResponseSchema, await admin.get('/api/admin/holds')).holds).toEqual([
      { ...hold, releasedAt: NOW },
    ]);
  });

  it('answers 404 to a second release of the same hold, and does not move releasedAt', async () => {
    expect((await admin.post('/api/admin/holds/NVDA/release')).status).toBe(204);
    expectError(await admin.post('/api/admin/holds/NVDA/release'), 404, 'not_found');
    expect(await api.store.listSymbolHolds()).toEqual([{ ...hold, releasedAt: NOW }]);
  });

  it('answers 404 when the symbol is not held', async () => {
    expectError(await admin.post('/api/admin/holds/MSFT/release'), 404, 'not_found');
    expect(await api.store.listSymbolHolds()).toEqual([hold]);
  });

  it('refuses everyone who is not an admin', async () => {
    const user = await api.signedIn(owner);
    expectError(await api.client().get('/api/admin/holds'), 401, 'unauthorized');
    expectError(await user.get('/api/admin/holds'), 403, 'forbidden');
    expectError(await api.client().post('/api/admin/holds/NVDA/release'), 401, 'unauthorized');
    expectError(await user.post('/api/admin/holds/NVDA/release'), 403, 'forbidden');
    expectError(
      await admin.post('/api/admin/holds/NVDA/release', undefined, { origin: 'https://prix.evil.test' }),
      403,
      'forbidden',
    );
    expect(await api.store.listSymbolHolds()).toEqual([hold]);
  });
});
