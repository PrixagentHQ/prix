import { creationPeriod, WALLET_SEASONING_SECONDS } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { networkKey } from '../../../../apps/api/src/http/reputation/claim.ts';
import { SEASON_1, testAddress } from '../../../support/fixtures.ts';
import { addAgent, counterValue } from '../../support/agents.ts';
import { db, resetDb, type Stores, storesOn } from '../../support/d1.ts';
import { createSocialHttp, type SocialHttp } from '../../support/http.ts';

/**
 * Contract 6.1 (docs/contracts/phase-6-social.md section 5.5): creating a paper manager checks wallet
 * seasoning before any counter, with the 429 and Retry-After of agent creation; and the counters are
 * given back only when the creation itself failed, never when the read of the detail after it fails.
 */

const plain = storesOn(db);
const NOW = '2026-10-20T12:00:00.000Z';
const TODAY = '2026-10-20';
const PERIOD = creationPeriod(TODAY);
const CLIENT_IP = '203.0.113.9';
const NONCE_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

async function agents(stores: Stores): Promise<Record<string, number>> {
  const a = await addAgent(stores, 1, { name: 'Season Agent 1', owner: testAddress(1101) });
  const b = await addAgent(stores, 2, { name: 'Season Agent 2', owner: testAddress(1102) });
  return { [a.id]: 3000, [b.id]: 3000 };
}

async function keys(wallet: string) {
  const net = await networkKey(CLIENT_IP, NONCE_SECRET);
  return [`p:${PERIOD}:mgr:${wallet}`, `d:${TODAY}:mgrnet:${net}`, `p:${PERIOD}:mgrnet:${net}`, `d:${TODAY}:mgrnew`];
}

/** The wallet's first sign-in, as the sign-in route writes it. */
async function firstSignIn(address: string, at: string): Promise<void> {
  await db.prepare('INSERT INTO users (address, created_at) VALUES (?1, ?2)').bind(address, at).run();
}

async function create(http: SocialHttp, wallet: string, targetsBps: Record<string, number>, name = 'Fresh Mix') {
  return http.fetch('POST', '/api/social/managers', {
    cookie: await http.signIn(wallet),
    body: { name, targetsBps, schedule: 'weekly' },
  });
}

describe('wallet seasoning on paper manager creation', () => {
  it('refuses a wallet that signed in for the first time a minute ago with 429 and Retry-After, before any counter', async () => {
    const http = createSocialHttp(plain, { now: NOW });
    const targets = await agents(plain);
    const wallet = testAddress(8101);
    await firstSignIn(wallet, new Date(Date.parse(NOW) - 60_000).toISOString());

    const refused = await create(http, wallet, targets);
    expect(refused.status, refused.text).toBe(429);
    expect(refused.json.error.code).toBe('rate_limited');
    expect(refused.json.error.message).toBe(
      `A new wallet can create a paper manager ${WALLET_SEASONING_SECONDS / 60} minutes after its first sign-in. Try again in 9 minutes.`,
    );
    expect(Number(refused.headers.get('Retry-After'))).toBe(WALLET_SEASONING_SECONDS - 60);
    for (const key of await keys(wallet)) expect(await counterValue(key), key).toBe(0);
    expect((await db.prepare('SELECT count(*) AS n FROM managers').first<{ n: number }>())?.n).toBe(0);
  });

  it('lets the same wallet create once its seasoning time has passed', async () => {
    const http = createSocialHttp(plain, { now: NOW });
    const targets = await agents(plain);
    const wallet = testAddress(8102);
    await firstSignIn(wallet, new Date(Date.parse(NOW) - 60_000).toISOString());
    expect((await create(http, wallet, targets)).status).toBe(429);

    http.setNow(new Date(Date.parse(NOW) + WALLET_SEASONING_SECONDS * 1000).toISOString());
    const made = await create(http, wallet, targets);
    expect(made.status, made.text).toBe(201);
  });
});

describe('the counters of a manager creation', () => {
  it('are kept when the manager was created and only the read of its detail failed', async () => {
    const failing: Stores = {
      ...plain,
      social: Object.assign(Object.create(plain.social) as Stores['social'], {
        getManagerBook: async () => {
          throw new Error('the detail read failed');
        },
      }),
    };
    const http = createSocialHttp(failing, { now: NOW });
    const targets = await agents(plain);
    const wallet = testAddress(8201);

    const reply = await create(http, wallet, targets, 'Detail Fails');
    expect(reply.status).toBe(500);
    expect(reply.text).not.toContain('the detail read failed');
    // The manager exists, so every count of its creation stays taken.
    expect((await db.prepare('SELECT count(*) AS n FROM managers').first<{ n: number }>())?.n).toBe(1);
    for (const key of await keys(wallet)) expect(await counterValue(key), key).toBe(1);
  });
});
