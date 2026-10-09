import {
  creationPeriod,
  MANAGER_EXTRA_CREATIONS_PER_PERIOD,
  NEW_MANAGERS_PER_NETWORK_PER_DAY,
  NEW_MANAGERS_PER_NETWORK_PER_PERIOD,
} from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { networkKey } from '../../../../apps/api/src/http/reputation/claim.ts';
import { SEASON_1, testAddress } from '../../../support/fixtures.ts';
import { addAgent, counterValue } from '../../support/agents.ts';
import { db, resetDb, storesOn } from '../../support/d1.ts';
import { createSocialHttp, type SocialHttp } from '../../support/http.ts';

/**
 * Security review 6, finding 2 (docs/contracts/phase-6-social.md section 5.5): creating a paper manager
 * passes the per-network limits of agent creation, and the per-wallet cap counts per rolling period
 * (D-109), not per season. Every counter taken for a creation is given back unless the answer is 201.
 */

const plain = storesOn(db);
const NOW = '2026-10-20T12:00:00.000Z';
const TODAY = '2026-10-20';
const PERIOD = creationPeriod(TODAY);
/** The address every request of the shared harness comes from, and the secret it is keyed with. */
const CLIENT_IP = '203.0.113.9';
const NONCE_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

interface World {
  http: SocialHttp;
  agents: string[];
  net: string;
}

async function world(): Promise<World> {
  const http = createSocialHttp(plain, { now: NOW });
  const agents: string[] = [];
  for (let n = 1; n <= 3; n++) {
    agents.push((await addAgent(plain, n, { name: `Sybil Agent ${n}`, owner: testAddress(1000 + n) })).id);
  }
  return { http, agents, net: await networkKey(CLIENT_IP, NONCE_SECRET) };
}

const targets = (agents: string[]) => ({ [agents[0] as string]: 3000, [agents[1] as string]: 3000 });

async function create(w: World, wallet: string, name: string) {
  return w.http.fetch('POST', '/api/social/managers', {
    cookie: await w.http.signIn(wallet),
    body: { name, targetsBps: targets(w.agents), schedule: 'weekly' },
  });
}

const keys = (w: World, wallet: string) => ({
  netDay: `d:${TODAY}:mgrnet:${w.net}`,
  netPeriod: `p:${PERIOD}:mgrnet:${w.net}`,
  wallet: `p:${PERIOD}:mgr:${wallet}`,
  all: `d:${TODAY}:mgrnew`,
});

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('paper managers pass the sybil limits of agent creation', () => {
  it('refuses the fourth creation from one network in a day with 429, and gives back every counter of it', async () => {
    const w = await world();
    expect(NEW_MANAGERS_PER_NETWORK_PER_DAY).toBe(3);
    for (let k = 1; k <= NEW_MANAGERS_PER_NETWORK_PER_DAY; k++) {
      const made = await create(w, testAddress(7000 + k), `Network Mix ${k}`);
      expect(made.status, made.text).toBe(201);
    }
    const fourth = testAddress(7004);
    const refused = await create(w, fourth, 'Network Mix 4');
    expect(refused.status, refused.text).toBe(429);
    expect(refused.json.error.code).toBe('rate_limited');
    expect(refused.json.error.message).toBe(
      'Too many paper managers were created from this network today. Try again after 00:00 UTC.',
    );
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(refused.headers.get('Cache-Control')).toBe('no-store');

    const k = keys(w, fourth);
    expect(await counterValue(k.netDay)).toBe(NEW_MANAGERS_PER_NETWORK_PER_DAY);
    expect(await counterValue(k.netPeriod)).toBe(NEW_MANAGERS_PER_NETWORK_PER_DAY);
    expect(await counterValue(k.all)).toBe(NEW_MANAGERS_PER_NETWORK_PER_DAY);
    // The refused wallet keeps all of its own creations.
    expect(await counterValue(k.wallet)).toBe(0);
    expect((await db.prepare('SELECT count(*) AS n FROM managers').first<{ n: number }>())?.n).toBe(3);
  });

  it('refuses a creation past the network cap of the rolling period, and gives back every counter of it', async () => {
    const w = await world();
    const wallet = testAddress(7101);
    const k = keys(w, wallet);
    for (let n = 0; n < NEW_MANAGERS_PER_NETWORK_PER_PERIOD; n++) {
      expect(await plain.reputation.takeCounter(k.netPeriod, NEW_MANAGERS_PER_NETWORK_PER_PERIOD, TODAY, NOW)).toBe(
        true,
      );
    }
    const refused = await create(w, wallet, 'Period Mix');
    expect(refused.status, refused.text).toBe(429);
    expect(refused.json.error.code).toBe('rate_limited');
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(refused.json.error.message).not.toMatch(/season/i);
    expect(await counterValue(k.netPeriod)).toBe(NEW_MANAGERS_PER_NETWORK_PER_PERIOD);
    expect(await counterValue(k.netDay)).toBe(0);
    expect(await counterValue(k.wallet)).toBe(0);
    expect(await counterValue(k.all)).toBe(0);
  });

  it('gives back the network counters too when a creation is refused after they were taken', async () => {
    const w = await world();
    const wallet = testAddress(7201);
    const k = keys(w, wallet);
    // The name of an agent is taken: the store refuses after every counter was taken.
    const refused = await create(w, wallet, 'Sybil Agent 1');
    expect(refused.status, refused.text).toBe(409);
    expect(refused.json.error.code).toBe('name_taken');
    for (const key of Object.values(k)) expect(await counterValue(key), key).toBe(0);
  });

  it('counts a 201 on every counter, the wallet under its rolling period and no longer under the season', async () => {
    const w = await world();
    const wallet = testAddress(7301);
    const made = await create(w, wallet, 'Counted Mix');
    expect(made.status, made.text).toBe(201);
    for (const key of Object.values(keys(w, wallet))) expect(await counterValue(key), key).toBe(1);
    expect(await counterValue(`s:${SEASON_1.id}:mgr:${wallet}`)).toBe(0);
  });

  it('caps the creations of one wallet at slots + 2 a rolling period, with a sentence that does not say season', async () => {
    const w = await world();
    const wallet = testAddress(7401);
    const k = keys(w, wallet);
    // One slot before gating: the wallet has used its slot and both extra creations in this period.
    for (let n = 0; n < 1 + MANAGER_EXTRA_CREATIONS_PER_PERIOD; n++) {
      expect(await plain.reputation.takeCounter(k.wallet, 1 + MANAGER_EXTRA_CREATIONS_PER_PERIOD, TODAY, NOW)).toBe(
        true,
      );
    }
    const refused = await create(w, wallet, 'One Too Many');
    expect(refused.status, refused.text).toBe(403);
    expect(refused.json.error.code).toBe('forbidden');
    expect(refused.json.error.message).not.toMatch(/season/i);
    expect(await counterValue(k.netDay)).toBe(0);
    expect(await counterValue(k.netPeriod)).toBe(0);
    expect(await counterValue(k.all)).toBe(0);
  });
});
