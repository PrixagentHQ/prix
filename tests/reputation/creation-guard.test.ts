import type { ReputationStore } from '@prix/contracts';
import {
  agentPublicSchema,
  creationPeriod,
  leagueResponseSchema,
  NEW_AGENTS_PER_NETWORK_PER_DAY,
  WALLET_SEASONING_SECONDS,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/http/index.ts';
import { createAgentCreationGuard, createClaimVerifier } from '../../apps/api/src/http/reputation/index.ts';
import type { Api } from '../support/api.ts';
import { Client, createApi, expectError, expectShape, NONCE_SECRET, PROMPT, START_TIME } from '../support/api.ts';
import type { TestWallet } from '../support/eth.ts';
import { testWallet } from '../support/eth.ts';
import { SEASON_1 } from '../support/fixtures.ts';
import { reputationDeps, stubReputation } from './support.ts';

/**
 * The creation guard of Phase 2 and the house wallets (docs/CONTRACTS.md section 17, D-090): a
 * house wallet is not counted, so the agents Prix runs do not spend the allowance of the network
 * they are created from. Every other wallet is held to the limits as before, and everything else
 * about creating an agent applies to a house wallet as to anyone.
 *
 * The real guard and the real middleware run in front of the real `POST /api/agents`. Only the
 * reputation store is a fake: the first sign-in of each wallet and the counters.
 */

const HOUSE_A = testWallet(71);
const HOUSE_B = testWallet(72);
const PERSON = testWallet(73);
const SEASONED = testWallet(74);
/** One address for every request: all of them come from the same network. */
const NETWORK = '203.0.113.50';

const body = (name: string) => ({ name, prompt: PROMPT, division: 'open' });

interface Harness {
  api: Api;
  /** The counter keys that are taken at this moment. */
  counters: string[];
  /** Counter keys the fake refuses, as a counter at its cap does. Matched by prefix. */
  full: string[];
  /** How often the guard asked for a first sign-in or a counter. */
  asked: { firstSignIn: number; counter: number };
  signedIn(wallet: TestWallet): Promise<Client>;
}

function harness(houseOwners: readonly string[] | undefined): Harness {
  const base = createApi({ houseOwners });
  const counters: string[] = [];
  const full: string[] = [];
  const asked = { firstSignIn: 0, counter: 0 };
  const longAgo = new Date(Date.parse(START_TIME) - (WALLET_SEASONING_SECONDS + 60) * 1000).toISOString();
  const reputation: ReputationStore = stubReputation({
    nameKeyTaken: async () => false,
    // Only SEASONED signed in long enough ago. Every other wallet signed in this minute.
    getFirstSignIn: async (address: string) => {
      asked.firstSignIn += 1;
      return address === SEASONED.address ? longAgo : START_TIME;
    },
    takeCounter: async (key: string) => {
      asked.counter += 1;
      if (full.some((prefix) => key.startsWith(prefix))) return false;
      counters.push(key);
      return true;
    },
    giveBackCounter: async (key: string) => {
      const at = counters.indexOf(key);
      if (at >= 0) counters.splice(at, 1);
    },
  });
  const deps = reputationDeps(base, {
    reputation,
    verifier: createClaimVerifier({ contractWallets: false, rpcUrls: ['http://127.0.0.1:9'] }),
    guard: createAgentCreationGuard(reputation, NONCE_SECRET, houseOwners),
  });
  const config = { ...deps.config, ...(houseOwners === undefined ? {} : { houseOwners }) };
  const api: Api = { ...base, app: createApp({ ...deps, config }, { reputation: { ...deps, config } }) };
  return {
    api,
    counters,
    full,
    asked,
    async signedIn(wallet) {
      const client = new Client(api, NETWORK);
      expect((await client.signIn(wallet)).status).toBe(200);
      return client;
    },
  };
}

describe('the creation guard and the house wallets', () => {
  it('does not hold a house wallet back: no seasoning and no counter', async () => {
    const h = harness([HOUSE_A.address, HOUSE_B.address]);
    // Both signed in this second: any other wallet would wait out the seasoning time.
    const first = await h.signedIn(HOUSE_A);
    const reply = await first.post('/api/agents', body('Semis Rotation'));
    expect(reply.status, reply.text).toBe(201);
    const second = await h.signedIn(HOUSE_B);
    expect((await second.post('/api/agents', body('Treasury First'))).status).toBe(201);

    expect(h.counters).toEqual([]);
    expect(h.asked).toEqual({ firstSignIn: 0, counter: 0 });
  });

  it('still holds every other wallet to the seasoning time', async () => {
    const h = harness([HOUSE_A.address]);
    const person = await h.signedIn(PERSON);
    const reply = await person.post('/api/agents', body('Fresh Wallet'));
    expectError(reply, 429, 'rate_limited');
    expect(Number(reply.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(h.counters).toEqual([]);
    expect(await h.api.store.getAgentByOwner(PERSON.address)).toBeNull();
  });

  it('still counts every other wallet: three counters for one agent', async () => {
    const h = harness([HOUSE_A.address]);
    const seasoned = await h.signedIn(SEASONED);
    expect((await seasoned.post('/api/agents', body('Seasoned Wallet'))).status).toBe(201);
    const day = START_TIME.slice(0, 10);
    expect(h.counters).toHaveLength(3);
    expect(h.counters.filter((key) => key.startsWith(`d:${day}:net:`))).toHaveLength(1);
    expect(h.counters.filter((key) => key.startsWith(`p:${creationPeriod(day)}:net:`))).toHaveLength(1);
    expect(h.counters).toContain(`d:${day}:all`);
  });

  it('lets a house wallet create from a network whose allowance is spent, and refuses anyone else there', async () => {
    expect(NEW_AGENTS_PER_NETWORK_PER_DAY).toBe(3);
    const h = harness([HOUSE_A.address]);
    const day = START_TIME.slice(0, 10);
    h.full.push(`d:${day}:net:`, `p:${creationPeriod(day)}:net:`, `d:${day}:all`);

    const seasoned = await h.signedIn(SEASONED);
    expectError(await seasoned.post('/api/agents', body('Seasoned Wallet')), 429, 'rate_limited');
    const house = await h.signedIn(HOUSE_A);
    expect((await house.post('/api/agents', body('Dip Buyer'))).status).toBe(201);
    expect(h.counters).toEqual([]);
  });

  it('counts a wallet that is not named, whatever the request says about itself', async () => {
    const h = harness([HOUSE_A.address]);
    const person = await h.signedIn(PERSON);
    const reply = await person.post('/api/agents', body('Fresh Wallet'), {
      headers: { 'X-House': 'true', 'X-House-Owner': PERSON.address, 'X-Forwarded-For': HOUSE_A.address },
    });
    expectError(reply, 429, 'rate_limited');
    // The body is strict: a field the contract does not know is refused, and nothing was created.
    expectError(await person.post('/api/agents', { ...body('Fresh Wallet'), house: true }), 400, 'invalid_input');
    expect(await h.api.store.getAgentByOwner(PERSON.address)).toBeNull();
  });

  it('applies everything else to a house wallet as to anyone', async () => {
    const h = harness([HOUSE_A.address, HOUSE_B.address]);
    const house = await h.signedIn(HOUSE_A);
    // A name that fails validation.
    expectError(await house.post('/api/agents', body('x')), 400, 'invalid_input');
    expect((await house.post('/api/agents', body('Momentum Five'))).status).toBe(201);
    // One agent per wallet.
    expectError(await house.post('/api/agents', body('Momentum Six')), 409, 'owner_has_agent');
    // One agent per name.
    const other = await h.signedIn(HOUSE_B);
    expectError(await other.post('/api/agents', body('Momentum Five')), 409, 'name_taken');
    // The origin and the content type of a write.
    expectError(
      await other.post('/api/agents', body('Oil And Idle'), { origin: 'https://evil.example' }),
      403,
      'forbidden',
    );
    expect(h.counters).toEqual([]);
  });

  it('counts every wallet when no house wallet is named', async () => {
    const h = harness(undefined);
    const wallet = await h.signedIn(HOUSE_A);
    expectError(await wallet.post('/api/agents', body('Semis Rotation')), 429, 'rate_limited');
    expect(h.asked.firstSignIn).toBe(1);
  });

  it('takes nothing and gives nothing back when called directly', async () => {
    const taken: string[] = [];
    const guard = createAgentCreationGuard(
      stubReputation({
        takeCounter: async (key: string) => {
          taken.push(key);
          return true;
        },
        giveBackCounter: async () => {
          throw new Error('nothing was taken, so nothing may be given back');
        },
      }),
      NONCE_SECRET,
      // Written in capitals: the comparison does not care.
      [`0x${HOUSE_A.address.slice(2).toUpperCase()}`],
    );
    const reservation = await guard.reserve({
      owner: HOUSE_A.address,
      networkSubject: NETWORK,
      seasonId: SEASON_1.id,
      now: new Date(START_TIME),
    });
    expect(reservation).toEqual({ keys: [] });
    await guard.release(reservation);
    expect(taken).toEqual([]);
  });
});

describe('the house mark on a league row and on the agent read', () => {
  it('marks the agent of a house wallet, and carries the summary and the creation time of every row', async () => {
    const h = harness([HOUSE_A.address]);
    const house = await h.signedIn(HOUSE_A);
    const created = (await house.post('/api/agents', body('Big Tech Equal'))).json.agent;
    const seasoned = await h.signedIn(SEASONED);
    const other = (await seasoned.post('/api/agents', body('Somebody Else'))).json.agent;
    await h.api.store.updateAgent(
      other.id,
      { summary: 'Holds whatever fell the most.', summaryStatus: 'ready' },
      START_TIME,
    );

    const reply = await new Client(h.api, NETWORK).get('/api/league?division=open');
    const league = expectShape(leagueResponseSchema, reply);
    const rows = new Map(league.rows.map((row) => [row.agentId, row]));
    expect(rows.get(created.id)).toMatchObject({ house: true, summary: null, createdAt: created.createdAt });
    expect(rows.get(other.id)).toMatchObject({
      house: false,
      summary: 'Holds whatever fell the most.',
      createdAt: other.createdAt,
    });
    // The mark is all a response says about the wallet: no owner address is in the table.
    expect(reply.text.toLowerCase()).not.toContain(HOUSE_A.address.slice(2));
    expect(reply.text.toLowerCase()).not.toContain(SEASONED.address.slice(2));

    const anyone = new Client(h.api, NETWORK);
    expect(expectShape(agentPublicSchema, await anyone.get(`/api/agents/${created.id}`)).house).toBe(true);
    const page = await anyone.get(`/api/agents/${other.id}`);
    expect(expectShape(agentPublicSchema, page).house).toBe(false);
    // The agent read shows the owner in its short form only, as before.
    expect(page.text.toLowerCase()).not.toContain(SEASONED.address.slice(2));
  });
});
