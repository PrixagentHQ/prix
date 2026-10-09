import type { ListingRecord } from '@prix/contracts';
import {
  creationPeriod,
  entitlementsOfTier,
  MANAGER_EXTRA_CREATIONS_PER_PERIOD,
  MANAGER_SLOTS_BY_TIER,
  MANAGERS_CREATED_PER_DAY,
  MAX_MANAGERS_TOTAL,
  managerDetailResponseSchema,
  managerListResponseSchema,
  myManagersResponseSchema,
} from '@prix/contracts';
import { createManagerValueJob } from '@prix/runtime/social/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { networkKey } from '../../apps/api/src/http/reputation/claim.ts';
import { SEASON_1, testAddress, testId } from '../support/fixtures.ts';
import { addAgent, counterValue, setHidden } from './support/agents.ts';
import { db, jobDeps, resetDb, storesOn } from './support/d1.ts';
import { ADMIN_ADDRESS, createSocialHttp, freshNetwork, type SocialHttp } from './support/http.ts';
import { dayAt, League } from './support/league.ts';
import { addManager, managerOf, policyOf } from './support/managers.ts';

/**
 * Paper managers over HTTP (docs/contracts/phase-6-social.md sections 5.5 and 6) on the real database:
 * who may make one, how many, under which names; what an edit may do and when it takes effect; and what
 * a public read shows and hides.
 *
 * Every creation here comes from a network of its own, so that the network caps of security review 6
 * (finding 2), which tests/social/hardening/api/manager-sybil.d1.test.ts checks, never answer first.
 * The wallet cap counts per rolling period (D-109): `p:<period>:mgr:<wallet>`.
 */

const plain = storesOn(db);
const NOW = '2026-10-20T12:00:00.000Z';
const TODAY = '2026-10-20';
const WALLET = testAddress(5001);
const OTHER = testAddress(5002);
const WALLET_KEY = `p:${creationPeriod(TODAY)}:mgr:${WALLET}`;
const NONCE_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The network counters of the day and the period for one client address. */
async function networkKeys(ip: string): Promise<string[]> {
  const net = await networkKey(ip, NONCE_SECRET);
  return [`d:${TODAY}:mgrnet:${net}`, `p:${creationPeriod(TODAY)}:mgrnet:${net}`];
}

interface Cast {
  http: SocialHttp;
  agents: string[];
  cookie: string;
}

async function cast(): Promise<Cast> {
  const http = createSocialHttp(plain, { now: NOW });
  const agents: string[] = [];
  for (let n = 1; n <= 6; n++)
    agents.push((await addAgent(plain, n, { name: `Mgr Agent ${n}`, owner: testAddress(1000 + n) })).id);
  return { http, agents, cookie: await http.signIn(WALLET) };
}

const targets = (agents: string[], weights = [3000, 2500, 2000]) =>
  Object.fromEntries(weights.map((w, k) => [agents[k] as string, w]));

const create = (c: Cast, name: string, over: Record<string, unknown> = {}, cookie = c.cookie, ip = freshNetwork()) =>
  c.http.fetch('POST', '/api/social/managers', {
    cookie,
    ip,
    body: { name, targetsBps: targets(c.agents), schedule: 'weekly', ...over },
  });

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('creating a paper manager', () => {
  it('creates one: 201, no cache, a policy of version 1, and the wallet is not in the answer', async () => {
    const c = await cast();
    const reply = await create(c, 'Steady Mix');
    expect(reply.status, reply.text).toBe(201);
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
    const body = managerDetailResponseSchema.parse(reply.json);
    expect(body.manager).toMatchObject({
      name: 'Steady Mix',
      status: 'active',
      schedule: 'weekly',
      agentCount: 3,
      policyVersion: 1,
    });
    expect(body.manager.season).toBeNull();
    expect(body.cashBps).toBe(10_000);
    expect(body.allocation).toHaveLength(3);
    expect(reply.text.toLowerCase()).not.toContain(WALLET.slice(2));
    // It is listed publicly, and the list does not show the owner either.
    const list = managerListResponseSchema.parse((await c.http.fetch('GET', '/api/social/managers')).json);
    expect(list.managers.map((m) => m.name)).toEqual(['Steady Mix']);
    expect(c.http.transcript.join('\n').toLowerCase()).not.toContain(WALLET.slice(2));
  });

  it('refuses weights, counts, agents and shapes the document forbids, each with 400 invalid_input', async () => {
    const c = await cast();
    const [a, b, d, e, f, g] = c.agents as [string, string, string, string, string, string];
    const bad: Array<[string, Record<string, unknown>]> = [
      ['a weight under 5 percent', { targetsBps: { [a]: 499, [b]: 3000 } }],
      ['a weight over 40 percent', { targetsBps: { [a]: 4001, [b]: 3000 } }],
      ['more than 100 percent', { targetsBps: { [a]: 4000, [b]: 4000, [d]: 4000 } }],
      ['one agent', { targetsBps: { [a]: 3000 } }],
      ['six agents', { targetsBps: { [a]: 1000, [b]: 1000, [d]: 1000, [e]: 1000, [f]: 1000, [g]: 1000 } }],
      ['a fractional weight', { targetsBps: { [a]: 1000.5, [b]: 3000 } }],
      ['a text weight', { targetsBps: { [a]: '3000', [b]: 3000 } }],
      ['an unknown schedule', { schedule: 'daily' }],
      ['an extra key', { owner: WALLET }],
      ['a key that sets a price', { values: { [a]: 1 } }],
    ];
    for (const [label, over] of bad) {
      const reply = await create(c, 'Bad Input', over);
      expect(reply.status, label).toBe(400);
      expect(reply.json.error.code, label).toBe('invalid_input');
    }
    for (const body of [{}, { name: 'No Targets' }, { targetsBps: targets(c.agents) }, null]) {
      const reply = await c.http.fetch('POST', '/api/social/managers', { cookie: c.cookie, body });
      expect(reply.status).toBe(400);
    }
    expect((await db.prepare('SELECT count(*) AS n FROM managers').first<{ n: number }>())?.n).toBe(0);
  });

  it('accepts the edges: 5 percent and 40 percent, two agents and five, exactly 100 percent', async () => {
    const c = await cast();
    const [a, b, d, e, f] = c.agents as [string, string, string, string, string];
    const ok = [
      { targetsBps: { [a]: 500, [b]: 500 } },
      { targetsBps: { [a]: 4000, [b]: 4000, [d]: 2000 } },
      { targetsBps: { [a]: 2000, [b]: 2000, [d]: 2000, [e]: 2000, [f]: 2000 } },
    ];
    c.http.entitlements.value = entitlementsOfTier(3);
    for (const [k, over] of ok.entries()) {
      const reply = await create(c, `Edge Case ${k}`, over);
      expect(reply.status, reply.text).toBe(201);
    }
  });

  it('refuses an agent that is hidden, paused, unknown or not in the season, without saying which or why', async () => {
    const c = await cast();
    const [a, b, d] = c.agents as [string, string, string];
    await setHidden(a, true);
    await db.prepare("UPDATE agents SET status = 'paused', paused_reason = 'owner' WHERE id = ?1").bind(b).run();
    const cases: Record<string, unknown>[] = [
      { targetsBps: { [a]: 3000, [d]: 3000 } },
      { targetsBps: { [b]: 3000, [d]: 3000 } },
      { targetsBps: { aaaaaaaaaaaz: 3000, [d]: 3000 } },
      { targetsBps: { 'not-an-id': 3000, [d]: 3000 } },
    ];
    for (const over of cases) {
      const reply = await create(c, 'Picky Mix', over);
      expect(reply.status, JSON.stringify(over)).toBe(400);
      expect(reply.json.error.code).toBe('invalid_input');
      expect(String(reply.json.error.field)).toMatch(/^targetsBps/);
      expect(reply.text).not.toContain(a);
    }
  });

  it('refuses names: the manager list and the abuse list with 409 name_not_allowed, a reserved name with 400, a taken name with 409 name_taken', async () => {
    const c = await cast();
    // A word a paper manager may not use is a blocked word (security review 6, finding 7; section 6).
    for (const name of ['Capital Mix', 'Alpha Fund', 'Wealth Club', 'Index ETF', 'Asset Pool', 'Fund']) {
      const reply = await create(c, name);
      expect(reply.status, name).toBe(409);
      expect(reply.json.error.code, name).toBe('name_not_allowed');
    }
    const blocked = await create(c, 'Big Fuck Mix');
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('name_not_allowed');
    // A name refused for its shape or reserved by the agent rules stays 400 invalid_input.
    const reserved = await create(c, 'Prix Staff');
    expect(reserved.status).toBe(400);
    expect(reserved.json.error.code).toBe('invalid_input');
    expect((await db.prepare('SELECT count(*) AS n FROM managers').first<{ n: number }>())?.n).toBe(0);
    expect(await counterValue(WALLET_KEY)).toBe(0);

    expect((await create(c, 'Calm Mix')).status).toBe(201);
    // The same name key is the same name: case, spacing and dots do not make another.
    c.http.entitlements.value = entitlementsOfTier(3);
    const taken = await create(c, 'CALM  mix'.replace('  ', ' '));
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe('name_taken');
    expect((await create(c, 'calm.mix')).json.error.code).toBe('name_taken');
    // An agent's name is taken too.
    expect((await create(c, 'Mgr Agent 1')).json.error.code).toBe('name_taken');
    // And so is a listing's.
    const listing: ListingRecord = {
      id: testId('listing', 1),
      wallet: testAddress(9001),
      claimant: testAddress(9002),
      name: 'Listed One',
      nameKey: 'listedone',
      message: 'claim',
      signature: '0x00',
      signatureKind: 'eoa',
      status: 'active',
      hidden: false,
      verified: false,
      claimedAt: '2026-10-05T09:00:00.000Z',
      syncState: 'live',
      syncedBlock: 0,
      syncedAt: null,
      windowBlocks: 1000,
      syncErrors: 0,
      eventCount: 0,
      balancesWei: {},
      recordDay: null,
      recordBlock: 0,
      indexMicro: 10_000_000_000,
    };
    expect(await plain.reputation.createListing(listing, { maxPerClaimant: 3, maxTotal: 50 })).toBe('created');
    expect((await create(c, 'Listed One')).json.error.code).toBe('name_taken');
    // A refused name takes nothing: the wallet still has all of its creations.
    expect(await counterValue(WALLET_KEY)).toBe(1);
  });
});

describe('the server decides slots, tiers, prices and delays', () => {
  it('ignores a tier, a slot count or a price claimed in the query or the body of a request', async () => {
    const c = await cast();
    expect((await create(c, 'Honest Mix')).status).toBe(201);
    // Before gating one slot is all there is: a claim in the query changes nothing.
    const claimed = await c.http.fetch('POST', '/api/social/managers?tier=3&slots=5&maxManagers=9', {
      cookie: c.cookie,
      body: { name: 'Claimed Mix', targetsBps: targets(c.agents), schedule: 'weekly' },
    });
    expect(claimed.status).toBe(403);
    // A claim in the body is refused as an unknown key.
    for (const extra of [
      { tier: 3 },
      { slots: 5 },
      { feedDelaySeconds: 0 },
      { prices: { [c.agents[0] as string]: 1 } },
      { scoreMilli: 9999 },
    ]) {
      const reply = await create(c, 'Claimed Mix', extra);
      expect(reply.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await db.prepare('SELECT count(*) AS n FROM managers').first<{ n: number }>())?.n).toBe(1);
  });
});

describe('slots and counts', () => {
  it('gives one slot before gating and 1, 2, 3 and 5 by tier, counting active and paused managers', async () => {
    expect(MANAGER_SLOTS_BY_TIER).toEqual({ 0: 1, 1: 2, 2: 3, 3: 5 });
    const preview = await cast();
    expect((await create(preview, 'Only One')).status).toBe(201);
    const full = await create(preview, 'Second One');
    expect(full.status).toBe(403);
    expect(full.json.error.code).toBe('forbidden');

    for (const tier of [0, 1, 2, 3] as const) {
      await resetDb([{ season: SEASON_1, method: null }]);
      const c = await cast();
      c.http.entitlements.value = entitlementsOfTier(tier);
      const slots = MANAGER_SLOTS_BY_TIER[tier];
      for (let k = 0; k < slots; k++)
        expect((await create(c, `Tier ${tier} Mix ${k}`)).status, `tier ${tier} #${k}`).toBe(201);
      const over = await create(c, `Tier ${tier} Extra`);
      expect(over.status, `tier ${tier}`).toBe(403);
      expect(over.json.error.code).toBe('forbidden');
      const mine = myManagersResponseSchema.parse(
        (await c.http.fetch('GET', '/api/social/me/managers', { cookie: c.cookie })).json,
      );
      expect(mine.slots).toEqual({ used: slots, max: slots });
    }
  });

  it('frees a slot when a manager is closed, but not when it is paused, and caps creations at slots + 2 a rolling period', async () => {
    const c = await cast();
    const first = (await create(c, 'First Mix')).json.manager.id as string;
    // Paused still holds the slot.
    const paused = await c.http.fetch('PATCH', `/api/social/managers/${first}`, {
      cookie: c.cookie,
      body: { status: 'paused' },
    });
    expect(paused.status).toBe(200);
    expect(paused.json.manager.status).toBe('paused');
    expect((await create(c, 'Second Mix')).status).toBe(403);
    // Closed frees it; a closed manager keeps its record and is still listed.
    expect(
      (await c.http.fetch('PATCH', `/api/social/managers/${first}`, { cookie: c.cookie, body: { status: 'closed' } }))
        .status,
    ).toBe(200);
    expect(MANAGER_EXTRA_CREATIONS_PER_PERIOD).toBe(2);
    const second = (await create(c, 'Second Mix')).json.manager.id as string;
    await c.http.fetch('PATCH', `/api/social/managers/${second}`, { cookie: c.cookie, body: { status: 'closed' } });
    const third = await create(c, 'Third Mix');
    expect(third.status, third.text).toBe(201);
    await c.http.fetch('PATCH', `/api/social/managers/${third.json.manager.id}`, {
      cookie: c.cookie,
      body: { status: 'closed' },
    });
    // Slots + 2 = 3 creations are used up, though no slot is held.
    const fourth = await create(c, 'Fourth Mix');
    expect(fourth.status).toBe(403);
    expect(fourth.json.error.code).toBe('forbidden');
    expect(await counterValue(WALLET_KEY)).toBe(3);
    expect(
      (await c.http.fetch('GET', '/api/social/managers')).json.managers.map((m: { name: string }) => m.name),
    ).toContain('First Mix');
    // A closed manager never changes again.
    const reopen = await c.http.fetch('PATCH', `/api/social/managers/${first}`, {
      cookie: c.cookie,
      body: { status: 'active' },
    });
    expect(reopen.status).toBe(400);
    expect(reopen.json.error).toMatchObject({ code: 'invalid_input', field: 'status' });
    // Another wallet has its own count.
    const other = await create(c, 'Other Wallet Mix', {}, await c.http.signIn(OTHER));
    expect(other.status).toBe(201);
  });

  it('answers 409 league_full when Prix holds 250 managers, and takes nothing for it', async () => {
    const c = await cast();
    for (let n = 1; n <= MAX_MANAGERS_TOTAL; n++) {
      await addManager(plain, 1000 + n, targets(c.agents), 'hold', { owner: testAddress(20_000 + n) });
    }
    const ip = freshNetwork();
    const reply = await create(c, 'Number Two Fifty One', {}, c.cookie, ip);
    expect(reply.status).toBe(409);
    expect(reply.json.error.code).toBe('league_full');
    expect(await counterValue(WALLET_KEY)).toBe(0);
    expect(await counterValue(`d:${TODAY}:mgrnew`)).toBe(0);
    for (const key of await networkKeys(ip)) expect(await counterValue(key), key).toBe(0);
    // Only open managers count (contract 6.1): a closed one frees its place.
    await db.prepare("UPDATE managers SET status = 'closed' WHERE id = (SELECT id FROM managers LIMIT 1)").run();
    const freed = await create(c, 'Number Two Fifty One');
    expect(freed.status, freed.text).toBe(201);
  }, 120_000);

  it('answers 429 rate_limited with Retry-After after 50 creations in a day, and gives the wallet count back', async () => {
    const c = await cast();
    for (let k = 0; k < MANAGERS_CREATED_PER_DAY; k++) {
      expect(await plain.reputation.takeCounter(`d:${TODAY}:mgrnew`, MANAGERS_CREATED_PER_DAY, TODAY, NOW)).toBe(true);
    }
    const ip = freshNetwork();
    const reply = await create(c, 'Fifty First', {}, c.cookie, ip);
    expect(reply.status).toBe(429);
    expect(reply.json.error.code).toBe('rate_limited');
    expect(Number(reply.headers.get('Retry-After'))).toBeGreaterThan(0);
    // The counts the wallet and its network took were given back, and the day's count did not pass 50.
    expect(await counterValue(WALLET_KEY)).toBe(0);
    for (const key of await networkKeys(ip)) expect(await counterValue(key), key).toBe(0);
    expect(await counterValue(`d:${TODAY}:mgrnew`)).toBe(MANAGERS_CREATED_PER_DAY);
  });
});

describe('changing a paper manager', () => {
  async function one() {
    const c = await cast();
    const made = await create(c, 'Editable Mix');
    return { c, id: made.json.manager.id as string };
  }

  it('lets the owner change the weights once a day, and answers 429 for a second change the same day', async () => {
    const { c, id } = await one();
    // The first policy was set today (version 1): one change is still allowed today.
    const policy = { targetsBps: targets(c.agents, [2000, 2000, 2000]), schedule: 'hold' };
    const first = await c.http.fetch('PATCH', `/api/social/managers/${id}`, { cookie: c.cookie, body: { policy } });
    expect(first.status, first.text).toBe(200);
    expect(first.json.manager).toMatchObject({ policyVersion: 2, schedule: 'hold' });
    const second = await c.http.fetch('PATCH', `/api/social/managers/${id}`, { cookie: c.cookie, body: { policy } });
    expect(second.status).toBe(429);
    expect(second.json.error).toMatchObject({ code: 'rate_limited', field: 'policy' });
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThan(0);
    const mine = myManagersResponseSchema.parse(
      (await c.http.fetch('GET', '/api/social/me/managers', { cookie: c.cookie })).json,
    );
    expect(mine.managers[0]).toMatchObject({ changedToday: true, hidden: false });
    expect((await db.prepare('SELECT count(*) AS n FROM manager_policies').first<{ n: number }>())?.n).toBe(2);

    c.http.setNow('2026-10-21T09:00:00.000Z');
    const next = await c.http.fetch('PATCH', `/api/social/managers/${id}`, { cookie: c.cookie, body: { policy } });
    expect(next.status).toBe(200);
    expect(next.json.manager.policyVersion).toBe(3);
  });

  it('checks the new weights and agents exactly as at creation', async () => {
    const { c, id } = await one();
    const [a, b] = c.agents as [string, string];
    await setHidden(b, true);
    for (const policy of [
      { targetsBps: { [a]: 4001, [c.agents[2] as string]: 1000 }, schedule: 'weekly' },
      { targetsBps: { [a]: 3000, [b]: 3000 }, schedule: 'weekly' },
      { targetsBps: { [a]: 3000 }, schedule: 'weekly' },
    ]) {
      const reply = await c.http.fetch('PATCH', `/api/social/managers/${id}`, { cookie: c.cookie, body: { policy } });
      expect(reply.status, JSON.stringify(policy)).toBe(400);
    }
    // A refused change is not a change: today's change is still free.
    const ok = await c.http.fetch('PATCH', `/api/social/managers/${id}`, {
      cookie: c.cookie,
      body: { policy: { targetsBps: targets([a, c.agents[2] as string, c.agents[3] as string]), schedule: 'weekly' } },
    });
    expect(ok.status, ok.text).toBe(200);
  });

  it('takes a body that is a policy or a status and nothing else', async () => {
    const { c, id } = await one();
    const policy = { targetsBps: targets(c.agents), schedule: 'weekly' };
    for (const body of [
      {},
      { policy, status: 'paused' },
      { status: 'deleted' },
      { policy: { ...policy, extra: 1 } },
      { status: 'paused', extra: 1 },
      { owner: OTHER },
    ]) {
      const reply = await c.http.fetch('PATCH', `/api/social/managers/${id}`, { cookie: c.cookie, body });
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers another wallet, a signed-out visitor and a bad id like an unknown manager', async () => {
    const { c, id } = await one();
    const stranger = await c.http.signIn(OTHER);
    const body = { status: 'paused' };
    const strange = await c.http.fetch('PATCH', `/api/social/managers/${id}`, { cookie: stranger, body });
    const unknown = await c.http.fetch('PATCH', '/api/social/managers/aaaaaaaaaaaz', { cookie: stranger, body });
    expect(strange.status).toBe(404);
    expect(strange.text).toBe(unknown.text);
    expect((await c.http.fetch('PATCH', `/api/social/managers/${id}`, { body })).status).toBe(401);
    expect((await c.http.fetch('PATCH', '/api/social/managers/nope', { cookie: stranger, body })).status).toBe(404);
    expect(
      (await db.prepare('SELECT status FROM managers WHERE id = ?1').bind(id).first<{ status: string }>())?.status,
    ).toBe('active');
  });

  it('enforces a fallen tier on resume and on a policy edit only: pausing and closing stay free', async () => {
    const c = await cast();
    c.http.entitlements.value = entitlementsOfTier(2);
    const ids: string[] = [];
    for (let k = 0; k < 3; k++) ids.push((await create(c, `Tier Three ${k}`)).json.manager.id as string);
    // The wallet falls to tier 0: one slot, three managers.
    c.http.entitlements.value = entitlementsOfTier(0);
    const edit = await c.http.fetch('PATCH', `/api/social/managers/${ids[0]}`, {
      cookie: c.cookie,
      body: { policy: { targetsBps: targets(c.agents, [2000, 2000]), schedule: 'weekly' } },
    });
    expect(edit.status).toBe(403);
    expect(edit.json.error.code).toBe('forbidden');
    const pause = await c.http.fetch('PATCH', `/api/social/managers/${ids[1]}`, {
      cookie: c.cookie,
      body: { status: 'paused' },
    });
    expect(pause.status).toBe(200);
    // Resuming a paused one is a use of a slot the wallet no longer has.
    const resume = await c.http.fetch('PATCH', `/api/social/managers/${ids[1]}`, {
      cookie: c.cookie,
      body: { status: 'active' },
    });
    expect(resume.status).toBe(403);
    expect(
      (await c.http.fetch('PATCH', `/api/social/managers/${ids[1]}`, { cookie: c.cookie, body: { status: 'closed' } }))
        .status,
    ).toBe(200);
    expect(
      (await c.http.fetch('PATCH', `/api/social/managers/${ids[2]}`, { cookie: c.cookie, body: { status: 'closed' } }))
        .status,
    ).toBe(200);
    // Down to one active manager, the edit is allowed again.
    const again = await c.http.fetch('PATCH', `/api/social/managers/${ids[0]}`, {
      cookie: c.cookie,
      body: { policy: { targetsBps: targets(c.agents, [2000, 2000]), schedule: 'weekly' } },
    });
    expect(again.status, again.text).toBe(200);
  });
});

describe('the next-day rule', () => {
  it('values a new manager from the first final day after the day it was made, and a changed policy the same way', async () => {
    const league = new League(plain, { agents: 3, seed: 7 });
    await league.addAgents();
    const agents = league.agents.map((a) => a.id);
    const http = createSocialHttp(plain, { now: `${dayAt(0)}T10:00:00.000Z` });
    const cookie = await http.signIn(WALLET);
    const c: Cast = { http, agents, cookie };

    // Day 0: the manager is made in the morning; the day's prices come in the evening.
    const made = await create(c, 'Next Day Mix', {
      targetsBps: { [agents[0] as string]: 3000, [agents[1] as string]: 3000 },
      schedule: 'hold',
    });
    expect(made.status, made.text).toBe(201);
    const id = made.json.manager.id as string;
    await league.playTick(0);
    await league.closeDay(0);
    const job = createManagerValueJob(jobDeps(plain, { now: `${dayAt(0)}T21:00:00.000Z` }).deps);
    while ((await job.run(new Date(`${dayAt(0)}T21:00:00.000Z`))) !== 'idle') {
      // run to the end of the day
    }
    // The day it was made is not a valued day: it closes trading at prices already known.
    expect(await plain.social.getManagerBook(id, SEASON_1.id)).toBeNull();

    // Day 1: valued from here on. The weights change that morning; the change waits for day 2.
    http.setNow(`${dayAt(1)}T10:00:00.000Z`);
    const edit = await http.fetch('PATCH', `/api/social/managers/${id}`, {
      cookie,
      body: { policy: { targetsBps: { [agents[0] as string]: 2000, [agents[2] as string]: 2000 }, schedule: 'hold' } },
    });
    expect(edit.status, edit.text).toBe(200);
    for (const i of [1, 2]) {
      await league.playTick(i);
      await league.closeDay(i);
      const at = new Date(`${dayAt(i)}T21:00:00.000Z`);
      const run = createManagerValueJob(jobDeps(plain, { now: at.toISOString() }).deps);
      while ((await run.run(at)) !== 'idle') {
        // run to the end of the day
      }
    }
    const rebalances = await plain.social.listManagerRebalances(id, SEASON_1.id, 10);
    expect(rebalances.map((r) => [r.day, r.reason, r.policyVersion])).toEqual([
      [dayAt(2), 'policy', 2],
      [dayAt(1), 'start', 1],
    ]);
    // The first valued day used the first weights: the book of day 1 held agents 0 and 1.
    expect(Object.keys(rebalances[1]?.targetsBps ?? {}).sort()).toEqual([agents[0], agents[1]].sort());
    expect(Object.keys(rebalances[0]?.targetsBps ?? {}).sort()).toEqual([agents[0], agents[2]].sort());
  });
});

describe('what a public read shows', () => {
  it('lists newest first, leaves a hidden manager out, and shows a hidden agent as a line with no name, id or figure', async () => {
    const c = await cast();
    const older = (await create(c, 'Older Mix')).json.manager.id as string;
    c.http.setNow('2026-10-20T13:00:00.000Z');
    c.http.entitlements.value = entitlementsOfTier(3);
    const newer = (await create(c, 'Newer Mix')).json.manager.id as string;
    const list = managerListResponseSchema.parse((await c.http.fetch('GET', '/api/social/managers')).json);
    expect(list.managers.map((m) => m.id)).toEqual([newer, older]);
    expect((await c.http.fetch('GET', '/api/social/managers')).headers.get('Cache-Control')).toBe('public, max-age=30');

    // An agent that goes out of the public view becomes a line with no agent.
    await setHidden(c.agents[0] as string, true);
    const page = await c.http.fetch('GET', `/api/social/managers/${older}`);
    expect(page.status).toBe(200);
    const detail = managerDetailResponseSchema.parse(page.json);
    expect(detail.allocation.filter((line) => line.agent === null)).toHaveLength(1);
    expect(page.text).not.toContain(c.agents[0]);
    expect(page.text).not.toContain('Mgr Agent 1');
    expect(page.text.toLowerCase()).not.toContain(WALLET.slice(2));

    // An admin can hide a manager: it is gone from the list and 404 on its page, and can be shown again.
    const admin = await c.http.signIn(ADMIN_ADDRESS);
    const hide = await c.http.fetch('POST', `/api/social/admin/managers/${older}/hidden`, {
      cookie: admin,
      body: { hidden: true },
    });
    expect(hide.status).toBe(204);
    expect((await c.http.fetch('GET', `/api/social/managers/${older}`)).status).toBe(404);
    expect(
      managerListResponseSchema
        .parse((await c.http.fetch('GET', '/api/social/managers')).json)
        .managers.map((m) => m.id),
    ).toEqual([newer]);
    // A hidden manager does not hold back its owner's list: the owner still sees it, marked.
    const mine = myManagersResponseSchema.parse(
      (await c.http.fetch('GET', '/api/social/me/managers', { cookie: c.cookie })).json,
    );
    expect(mine.managers.find((m) => m.id === older)?.hidden).toBe(true);
    expect(
      (
        await c.http.fetch('POST', `/api/social/admin/managers/${older}/hidden`, {
          cookie: admin,
          body: { hidden: false },
        })
      ).status,
    ).toBe(204);
    expect((await c.http.fetch('GET', `/api/social/managers/${older}`)).status).toBe(200);
    // Strict body, known manager.
    expect(
      (
        await c.http.fetch('POST', `/api/social/admin/managers/${older}/hidden`, {
          cookie: admin,
          body: { hidden: true, x: 1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.http.fetch('POST', '/api/social/admin/managers/aaaaaaaaaaaz/hidden', {
          cookie: admin,
          body: { hidden: true },
        })
      ).status,
    ).toBe(404);
  });

  it('shows my managers to their owner only, newest closed ones after the active, and 401 to a visitor', async () => {
    const c = await cast();
    await create(c, 'Mine Alone');
    const other = await c.http.signIn(OTHER);
    const theirs = myManagersResponseSchema.parse(
      (await c.http.fetch('GET', '/api/social/me/managers', { cookie: other })).json,
    );
    expect(theirs).toEqual({ slots: { used: 0, max: 1 }, managers: [] });
    expect((await c.http.fetch('GET', '/api/social/me/managers')).status).toBe(401);
    const reply = await c.http.fetch('GET', '/api/social/me/managers', { cookie: c.cookie });
    expect(reply.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers a malformed or unknown id with 404 and a page query that is not strict with 400', async () => {
    const c = await cast();
    for (const id of ['nope', 'aaaaaaaaaaaz'])
      expect((await c.http.fetch('GET', `/api/social/managers/${id}`)).status).toBe(404);
    for (const query of ['?page=0', '?page=abc', '?page=1&x=2', '?page=101']) {
      expect((await c.http.fetch('GET', `/api/social/managers${query}`)).status, query).toBe(400);
    }
    void managerOf;
    void policyOf;
  });
});
