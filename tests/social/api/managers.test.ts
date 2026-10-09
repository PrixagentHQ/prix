import type { AgentRecord } from '@prix/contracts';
import {
  creationPeriod,
  MANAGER_EXTRA_CREATIONS_PER_PERIOD,
  MANAGERS_CREATED_PER_DAY,
  MAX_MANAGERS_TOTAL,
  managerDetailResponseSchema,
  managerListResponseSchema,
  myManagersResponseSchema,
  NEW_MANAGERS_PER_NETWORK_PER_DAY,
  NEW_MANAGERS_PER_NETWORK_PER_PERIOD,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { networkKey } from '../../../apps/api/src/http/reputation/claim.ts';
import { SEASON_1 } from '../../support/fixtures.ts';
import { ADMIN, createHarness, errorOf, type Harness, START } from './harness.ts';
import { promptKeys } from './scan.ts';

const OWNER = '0x0000000000000000000000000000000000000d01';
const OTHER = '0x0000000000000000000000000000000000000d02';
const TODAY = '2026-10-20';
/** The rolling period of D-109 that the harness day falls in: the wallet cap counts per period, not per season. */
const PERIOD = creationPeriod(TODAY);
const WALLET_KEY = `p:${PERIOD}:mgr:${OWNER}`;
/** The harness sends every request from 203.0.113.9 and keys networks with this secret, as the guard does. */
const network = () => networkKey('203.0.113.9', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

async function agents(h: Harness): Promise<AgentRecord[]> {
  const out: AgentRecord[] = [];
  for (let n = 1; n <= 4; n++) out.push(await h.seedAgent(n));
  return out;
}

function create(list: AgentRecord[], name = 'Steady Mix') {
  return {
    name,
    targetsBps: { [list[0]?.id as string]: 4000, [list[1]?.id as string]: 3000 },
    schedule: 'weekly',
  };
}

async function created(h: Harness, list: AgentRecord[], cookie: string, name?: string) {
  const reply = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list, name) });
  expect(reply.status, reply.text).toBe(201);
  return managerDetailResponseSchema.parse(reply.json);
}

describe('POST /api/social/managers', () => {
  it('creates a paper manager and answers 201 with its detail, never cached', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    const reply = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) });
    expect(reply.status).toBe(201);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const body = managerDetailResponseSchema.parse(reply.json);
    expect(body.manager).toMatchObject({
      name: 'Steady Mix',
      status: 'active',
      schedule: 'weekly',
      agentCount: 2,
      season: null,
      policyVersion: 1,
    });
    expect(body.cashBps).toBe(10_000);
    expect(body.allocation.map((line) => [line.agent?.id, line.targetBps, line.currentBps])).toEqual([
      [list[0]?.id, 4000, 0],
      [list[1]?.id, 3000, 0],
    ]);
    expect(reply.text).not.toContain(OWNER);
    expect(promptKeys(reply.json)).toEqual([]);
    const stored = h.social.managers.get(body.manager.id);
    expect(stored).toMatchObject({ owner: OWNER, createdDay: '2026-10-20', hidden: false });
    // A 201 counts on every counter of section 5.5: the wallet per rolling period, the network per day
    // and per period, and everyone per day; nothing is counted per season any more (D-109).
    const net = await network();
    expect(h.counters.get('d:2026-10-20:mgrnew')).toBe(1);
    expect(h.counters.get(WALLET_KEY)).toBe(1);
    expect(h.counters.get(`d:${TODAY}:mgrnet:${net}`)).toBe(1);
    expect(h.counters.get(`p:${PERIOD}:mgrnet:${net}`)).toBe(1);
    expect([...h.counters.keys()].filter((key) => key.startsWith('s:'))).toEqual([]);
  });

  it('refuses ineligible agents with 400 invalid_input on targetsBps', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    await h.store.updateAgent(list[1]?.id as string, { status: 'paused', pausedReason: 'owner' }, START);
    const paused = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) });
    expect(paused.status).toBe(400);
    expect(errorOf(paused)).toMatchObject({ code: 'invalid_input', field: 'targetsBps' });

    await h.store.updateAgent(list[1]?.id as string, { status: 'active', hidden: true }, START);
    expect((await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) })).status).toBe(400);
    const unknown = {
      name: 'Steady Mix',
      targetsBps: { agentzzzzzzz: 2000, [list[0]?.id as string]: 2000 },
      schedule: 'hold',
    };
    expect((await h.fetch('POST', '/api/social/managers', { cookie, body: unknown })).status).toBe(400);
    expect(h.social.managers.size).toBe(0);
    expect(h.counters.size).toBe(0);
  });

  it('refuses bad weights and blocked names', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    const heavy = { ...create(list), targetsBps: { [list[0]?.id as string]: 4500, [list[1]?.id as string]: 1000 } };
    expect((await h.fetch('POST', '/api/social/managers', { cookie, body: heavy })).status).toBe(400);
    // A word a paper manager may not use is a blocked word: 409 name_not_allowed.
    const fund = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list, 'Growth Fund') });
    expect(fund.status).toBe(409);
    expect(errorOf(fund).code).toBe('name_not_allowed');
    // A name refused for its shape stays 400.
    const short = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list, 'X') });
    expect(short.status).toBe(400);
    expect(errorOf(short).code).toBe('invalid_input');
    expect(h.social.managers.size).toBe(0);
    expect([...h.counters.values()].every((n) => n === 0)).toBe(true);
    const blocked = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list, 'House Picks') });
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked).code).toBe('name_not_allowed');
  });

  it('holds a wallet to its slots, a taken name and the total cap, giving counters back', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    await created(h, list, cookie);
    const second = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list, 'Other Mix') });
    expect(second.status).toBe(403);
    expect(errorOf(second).code).toBe('forbidden');
    const net = await network();
    expect(h.counters.get('d:2026-10-20:mgrnew')).toBe(1);
    expect(h.counters.get(WALLET_KEY)).toBe(1);
    expect(h.counters.get(`d:${TODAY}:mgrnet:${net}`)).toBe(1);
    expect(h.counters.get(`p:${PERIOD}:mgrnet:${net}`)).toBe(1);

    const other = await h.signIn(OTHER);
    const taken = await h.fetch('POST', '/api/social/managers', { cookie: other, body: create(list) });
    expect(taken.status).toBe(409);
    expect(errorOf(taken).code).toBe('name_taken');

    // With the one made above, exactly MAX_MANAGERS_TOTAL open managers: the cap is reached, not passed.
    for (let i = 0; i < MAX_MANAGERS_TOTAL - 1; i++) {
      h.social.managers.set(`fill${i}`, {
        ...[...h.social.managers.values()][0],
        id: `fill${i}`,
        nameKey: `fill${i}`,
      } as never);
    }
    const full = await h.fetch('POST', '/api/social/managers', { cookie: other, body: create(list, 'Third Mix') });
    expect(full.status).toBe(409);
    expect(errorOf(full).code).toBe('league_full');
    expect(h.counters.get(`p:${PERIOD}:mgr:${OTHER}`)).toBe(0);

    // Only open managers count toward the total (contract 6.1): a closed or a hidden one frees its place.
    const [fill0, fill1] = [h.social.managers.get('fill0'), h.social.managers.get('fill1')];
    h.social.managers.set('fill0', { ...fill0, status: 'closed' } as never);
    const afterClose = await h.fetch('POST', '/api/social/managers', {
      cookie: other,
      body: create(list, 'Third Mix'),
    });
    expect(afterClose.status, afterClose.text).toBe(201);
    h.social.managers.set('fill1', { ...fill1, hidden: true } as never);
    const third = await h.signIn('0x0000000000000000000000000000000000000d03');
    const afterHide = await h.fetch('POST', '/api/social/managers', {
      cookie: third,
      body: create(list, 'Fourth Mix'),
    });
    expect(afterHide.status, afterHide.text).toBe(201);
    // Three creations used this network's day; a fresh allowance lets the next one reach the total cap.
    h.counters.set(`d:${TODAY}:mgrnet:${net}`, 0);
    const stillFull = await h.fetch('POST', '/api/social/managers', {
      cookie: await h.signIn('0x0000000000000000000000000000000000000d04'),
      body: create(list, 'Fifth Mix'),
    });
    expect(stillFull.status).toBe(409);
    expect(errorOf(stillFull).code).toBe('league_full');
  });

  it('caps creations per wallet and rolling period, per network and per day, giving every counter back', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    const net = await network();
    const counted = () => [...h.counters.entries()].filter(([, n]) => n > 0);

    // The wallet: slots + 2 creations a rolling period (one slot before gating), 403 with no season word.
    h.counters.set(WALLET_KEY, 1 + MANAGER_EXTRA_CREATIONS_PER_PERIOD);
    const period = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) });
    expect(period.status).toBe(403);
    expect(errorOf(period).code).toBe('forbidden');
    expect(errorOf(period).message).not.toMatch(/season/i);
    expect(counted()).toEqual([[WALLET_KEY, 3]]);
    h.counters.set(WALLET_KEY, 0);

    // The network: NEW_MANAGERS_PER_NETWORK_PER_DAY a day, then NEW_MANAGERS_PER_NETWORK_PER_PERIOD a period.
    h.counters.set(`d:${TODAY}:mgrnet:${net}`, NEW_MANAGERS_PER_NETWORK_PER_DAY);
    const netDay = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) });
    expect(netDay.status).toBe(429);
    expect(errorOf(netDay).code).toBe('rate_limited');
    expect(Number(netDay.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(h.counters.get(WALLET_KEY)).toBe(0);
    h.counters.set(`d:${TODAY}:mgrnet:${net}`, 0);
    h.counters.set(`p:${PERIOD}:mgrnet:${net}`, NEW_MANAGERS_PER_NETWORK_PER_PERIOD);
    const netPeriod = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) });
    expect(netPeriod.status).toBe(429);
    expect(errorOf(netPeriod).code).toBe('rate_limited');
    expect(errorOf(netPeriod).message).not.toMatch(/season/i);
    expect(Number(netPeriod.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(h.counters.get(WALLET_KEY)).toBe(0);
    expect(h.counters.get(`d:${TODAY}:mgrnet:${net}`)).toBe(0);
    h.counters.set(`p:${PERIOD}:mgrnet:${net}`, 0);

    // Everyone: MANAGERS_CREATED_PER_DAY a day.
    h.counters.set('d:2026-10-20:mgrnew', MANAGERS_CREATED_PER_DAY);
    const day = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) });
    expect(day.status).toBe(429);
    expect(errorOf(day).code).toBe('rate_limited');
    expect(counted()).toEqual([['d:2026-10-20:mgrnew', MANAGERS_CREATED_PER_DAY]]);
    expect(h.social.managers.size).toBe(0);
  });

  it('gives a wallet its creations back in the next rolling period, not before', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    h.counters.set(WALLET_KEY, 1 + MANAGER_EXTRA_CREATIONS_PER_PERIOD);
    // The last day of the period is still refused; the first day of the next one is a new count.
    const next = new Date((PERIOD + 1) * 28 * 86_400_000);
    h.setNow(new Date(next.getTime() - 60_000).toISOString());
    expect((await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) })).status).toBe(403);
    h.setNow(new Date(next.getTime() + 60_000).toISOString());
    const made = await h.fetch('POST', '/api/social/managers', { cookie, body: create(list) });
    expect(made.status, made.text).toBe(201);
    expect(h.counters.get(`p:${PERIOD + 1}:mgr:${OWNER}`)).toBe(1);
  });

  it('needs a session from the site', async () => {
    const h = createHarness();
    const list = await agents(h);
    expect((await h.fetch('POST', '/api/social/managers', { body: create(list) })).status).toBe(401);
  });
});

describe('PATCH /api/social/managers/:id', () => {
  it('stores a new policy version once a day and refuses a second change with 429', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    const detail = await created(h, list, cookie);
    const policy = {
      policy: { targetsBps: { [list[2]?.id as string]: 2000, [list[3]?.id as string]: 2000 }, schedule: 'hold' },
    };
    const path = `/api/social/managers/${detail.manager.id}`;
    const first = await h.fetch('PATCH', path, { cookie, body: policy });
    expect(first.status, first.text).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = managerDetailResponseSchema.parse(first.json);
    expect(body.manager).toMatchObject({ policyVersion: 2, schedule: 'hold' });
    expect(h.social.policies.get(detail.manager.id)?.[1]).toMatchObject({ version: 2, setDay: '2026-10-20' });

    const second = await h.fetch('PATCH', path, { cookie, body: policy });
    expect(second.status).toBe(429);
    expect(errorOf(second).code).toBe('rate_limited');

    h.advance(24 * 3600 * 1000);
    expect((await h.fetch('PATCH', path, { cookie, body: policy })).status).toBe(200);
  });

  it('answers 404 to another wallet and for an unknown manager', async () => {
    const h = createHarness();
    const list = await agents(h);
    const detail = await created(h, list, await h.signIn(OWNER));
    const other = await h.signIn(OTHER);
    const reply = await h.fetch('PATCH', `/api/social/managers/${detail.manager.id}`, {
      cookie: other,
      body: { status: 'paused' },
    });
    expect(reply.status).toBe(404);
    expect(
      (await h.fetch('PATCH', '/api/social/managers/mgrzzzzzzzzz', { cookie: other, body: { status: 'paused' } }))
        .status,
    ).toBe(404);
  });

  it('pauses, resumes within the slots and keeps a closed manager closed', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    const detail = await created(h, list, cookie);
    const path = `/api/social/managers/${detail.manager.id}`;
    expect((await h.fetch('PATCH', path, { cookie, body: { status: 'paused' } })).json.manager.status).toBe('paused');
    expect((await h.fetch('PATCH', path, { cookie, body: { status: 'active' } })).json.manager.status).toBe('active');
    expect((await h.fetch('PATCH', path, { cookie, body: { status: 'closed' } })).json.manager.status).toBe('closed');
    const again = await h.fetch('PATCH', path, { cookie, body: { status: 'active' } });
    expect(again.status).toBe(400);
    expect(errorOf(again).code).toBe('invalid_input');
    const policy = await h.fetch('PATCH', path, { cookie, body: { policy: create(list) } });
    expect(policy.status).toBe(400);
  });

  it('refuses to resume past the slots of a fallen tier', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    h.entitlements.value = { ...h.entitlements.value, gatingOn: true, tier: 1 };
    const one = await created(h, list, cookie, 'First Mix');
    await created(h, list, cookie, 'Second Mix');
    await h.fetch('PATCH', `/api/social/managers/${one.manager.id}`, { cookie, body: { status: 'paused' } });
    h.entitlements.value = { ...h.entitlements.value, tier: 0 };
    const resume = await h.fetch('PATCH', `/api/social/managers/${one.manager.id}`, {
      cookie,
      body: { status: 'active' },
    });
    expect(resume.status).toBe(403);
    expect(errorOf(resume).code).toBe('forbidden');
  });
});

describe('GET /api/social/me/managers', () => {
  it('lists the wallet’s own managers with slots, never cached', async () => {
    const h = createHarness();
    const list = await agents(h);
    const cookie = await h.signIn(OWNER);
    const detail = await created(h, list, cookie);
    const reply = await h.fetch('GET', '/api/social/me/managers', { cookie });
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const body = myManagersResponseSchema.parse(reply.json);
    expect(body.slots).toEqual({ used: 1, max: 1 });
    expect(body.managers[0]).toMatchObject({ id: detail.manager.id, hidden: false, changedToday: false });
    expect((await h.fetch('GET', '/api/social/me/managers')).status).toBe(401);
  });
});

describe('GET /api/social/managers and /managers/:id', () => {
  it('lists visible managers newest first with season figures, without an owner', async () => {
    const h = createHarness();
    const list = await agents(h);
    const detail = await created(h, list, await h.signIn(OWNER));
    h.social.books.set(`${detail.manager.id}|${SEASON_1.id}`, {
      book: {
        cashMicro: 3_000_000_000,
        holdings: { [list[0]?.id as string]: 4_000_000, [list[1]?.id as string]: 3_000_000 },
        lastValue: { [list[0]?.id as string]: 1_000_000_000, [list[1]?.id as string]: 1_000_000_000 },
        missingDays: { [list[1]?.id as string]: 1 },
        policyVersion: 1,
        lastRebalanceDay: '2026-10-19',
      },
      stats: { ...h.deps.scoring.initialStats(), tradingDays: 1, equityMicro: 10_000_000_000 },
      lastDay: '2026-10-19',
      volMilliBps: 0,
    });
    const reply = await h.fetch('GET', '/api/social/managers');
    expect(reply.headers.get('cache-control')).toBe('public, max-age=30');
    const body = managerListResponseSchema.parse(reply.json);
    expect(body).toMatchObject({ seasonId: SEASON_1.id, page: 1, hasMore: false });
    expect(body.managers[0]?.season).toMatchObject({ seasonId: SEASON_1.id, valuedDays: 1 });
    expect(reply.text).not.toContain(OWNER);

    const one = await h.fetch('GET', `/api/social/managers/${detail.manager.id}`);
    expect(one.headers.get('cache-control')).toBe('public, max-age=30');
    const shown = managerDetailResponseSchema.parse(one.json);
    expect(shown.cashBps).toBe(3000);
    expect(shown.lastRebalanceDay).toBe('2026-10-19');
    expect(shown.allocation.map((line) => [line.currentBps, line.state])).toEqual([
      [4000, 'valued'],
      [3000, 'no_point_today'],
    ]);
    expect(one.text).not.toContain(OWNER);

    await h.store.updateAgent(list[0]?.id as string, { hidden: true }, START);
    const hiddenAgent = managerDetailResponseSchema.parse(
      (await h.fetch('GET', `/api/social/managers/${detail.manager.id}`)).json,
    );
    expect(hiddenAgent.allocation[0]?.agent).toBeNull();
    expect(JSON.stringify(hiddenAgent)).not.toContain(list[0]?.id as string);
  });

  it('answers 404 for a hidden or unknown manager and hides it from the list', async () => {
    const h = createHarness();
    const list = await agents(h);
    const detail = await created(h, list, await h.signIn(OWNER));
    const admin = await h.signIn(ADMIN);
    const hide = await h.fetch('POST', `/api/social/admin/managers/${detail.manager.id}/hidden`, {
      cookie: admin,
      body: { hidden: true },
    });
    expect(hide.status).toBe(204);
    expect((await h.fetch('GET', `/api/social/managers/${detail.manager.id}`)).status).toBe(404);
    expect(managerListResponseSchema.parse((await h.fetch('GET', '/api/social/managers')).json).managers).toEqual([]);
    expect((await h.fetch('GET', '/api/social/managers/mgrzzzzzzzzz')).status).toBe(404);
    expect(
      (
        await h.fetch('POST', '/api/social/admin/managers/mgrzzzzzzzzz/hidden', {
          cookie: admin,
          body: { hidden: true },
        })
      ).status,
    ).toBe(404);
  });
});
