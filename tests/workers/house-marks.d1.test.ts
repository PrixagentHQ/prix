import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { AgentRecord, ListingRecord, ScoringDivision, SeasonScoreRow } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../../apps/api/src/index.ts';
import { createFollowStore } from '../../apps/api/src/store/follow.ts';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { createReputationStore } from '../../apps/api/src/store/reputation.ts';
import { makeAgent, SEASON_1, startingPortfolio, startingStats, testAddress, testId } from '../support/fixtures.ts';

/**
 * docs/CONTRACTS.md section 17.1 on a local D1 database: a row of season results, a track record
 * and a follow say `house`, set with `isHouseOwner` from the agent's owner, which reaches no
 * response. A listed on-chain agent is never a house agent.
 */
const db = (env as unknown as { DB: D1Database }).DB;

const HOUSE_WALLET = testAddress(0xa11ce);
// A wallet holds one agent, so the second house agent has a wallet of its own.
const HOUSE_WALLET_2 = testAddress(0xa11cf);
const USER_WALLET = testAddress(0xb0b);
const FOLLOWER = testAddress(0xf011);
// Written in mixed case, as the Worker variable may be: the test is case-blind.
const HOUSE_OWNERS = [HOUSE_WALLET.toUpperCase().replace('0X', '0x'), HOUSE_WALLET_2];

const store = createD1Store(db);
const marked = createReputationStore(db, { houseOwners: HOUSE_OWNERS });
const unmarked = createReputationStore(db);
const follow = createFollowStore(db, { houseOwners: HOUSE_OWNERS });

let house: AgentRecord;
let user: AgentRecord;
let unscored: AgentRecord;
const LISTING_ID = testId('listing', 1);

function score(agentId: string, name: string, division: ScoringDivision, returnBps: number): SeasonScoreRow {
  return {
    seasonId: SEASON_1.id,
    division,
    agentId,
    name,
    agentCreatedAt: '2026-10-05T08:00:00.000Z',
    method: 'v2',
    moments: { n: 12, sumBps: 600, sumSqBps: 40_000 },
    returnBps,
    maxDrawdownBps: 100,
    tradingDays: 12,
    decidedCount: 8,
    tradeCount: 3,
    scoreMilli: returnBps,
    confidence: 'low',
    unrankedReason: null,
    scoredDay: '2026-10-20',
    updatedAt: '2026-10-20T01:00:00.000Z',
  };
}

function listing(): ListingRecord {
  return {
    id: LISTING_ID,
    // The house wallet itself claims a listing: a listing is still not a house agent.
    wallet: testAddress(0xc4a1),
    claimant: HOUSE_WALLET,
    name: 'Listed One',
    nameKey: 'listed one',
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
}

beforeAll(async () => {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  for (const { name } of tables.results) {
    if (!name.startsWith('_cf_')) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  const bindings = env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  await db
    .prepare('INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?, ?, ?, ?)')
    .bind(SEASON_1.id, SEASON_1.number, SEASON_1.startsAt, SEASON_1.endsAt)
    .run();

  const add = async (agent: AgentRecord) => {
    expect(await store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 200)).toBe('created');
    return agent;
  };
  house = await add(makeAgent({ n: 1, owner: HOUSE_WALLET, name: 'Index Core' }));
  user = await add(makeAgent({ n: 2, owner: USER_WALLET, name: 'Quiet Value' }));
  unscored = await add(makeAgent({ n: 3, owner: HOUSE_WALLET_2, name: 'Late Start' }));

  expect(await marked.createListing(listing(), { maxPerClaimant: 3, maxTotal: 50 })).toBe('created');
  await marked.putScores([
    score(house.id, house.name, 'open', 400),
    score(user.id, user.name, 'open', 300),
    score(LISTING_ID, 'Listed One', 'chain', 200),
  ]);
  await marked.rankScores(SEASON_1.id, 'open');
  await marked.rankScores(SEASON_1.id, 'chain');

  for (const agent of [house, user]) {
    expect(await follow.putFollow(FOLLOWER, agent.id, false, '2026-10-06T10:00:00.000Z', 50)).toBe('created');
  }
});

describe('a row of season results', () => {
  it('says house for the agent of a house wallet and for no other', async () => {
    const rows = await marked.listSeasonResults(SEASON_1.id, 'open', 10, 0);
    expect(rows?.map((row) => [row.agentId, row.house])).toEqual([
      [house.id, true],
      [user.id, false],
    ]);
  });

  it('says false on every row when no wallet is a house wallet', async () => {
    const rows = await unmarked.listSeasonResults(SEASON_1.id, 'open', 10, 0);
    expect(rows?.map((row) => row.house)).toEqual([false, false]);
  });

  it('never marks a listed agent, in the chain division or in its standing', async () => {
    const rows = await marked.listSeasonResults(SEASON_1.id, 'chain', 10, 0);
    expect(rows?.map((row) => [row.agentId, row.house])).toEqual([[LISTING_ID, false]]);
    const listed = await marked.getListedAgent(LISTING_ID);
    expect(listed?.standing?.house).toBe(false);
  });

  it('carries no owner', async () => {
    const rows = (await marked.listSeasonResults(SEASON_1.id, 'open', 10, 0)) ?? [];
    for (const row of rows) expect(Object.keys(row)).not.toContain('owner');
  });
});

describe('a track record', () => {
  it('says house for a scored house agent and not for another', async () => {
    expect((await marked.getTrackRecord(house.id))?.house).toBe(true);
    expect((await marked.getTrackRecord(user.id))?.house).toBe(false);
  });

  it('says house for a house agent that has no score yet', async () => {
    const record = await marked.getTrackRecord(unscored.id);
    expect(record?.seasons).toEqual([]);
    expect(record?.house).toBe(true);
  });

  it('never marks a listed agent', async () => {
    expect((await marked.getTrackRecord(LISTING_ID))?.house).toBe(false);
  });

  it('says false when no wallet is a house wallet', async () => {
    expect((await unmarked.getTrackRecord(house.id))?.house).toBe(false);
  });
});

describe('a follow', () => {
  it('says house for a followed house agent and not for another, with no owner', async () => {
    const follows = await follow.listFollows(FOLLOWER);
    const byId = new Map(follows.map((entry) => [entry.agentId, entry]));
    expect(byId.get(house.id)?.house).toBe(true);
    expect(byId.get(user.id)?.house).toBe(false);
    for (const entry of follows) expect(Object.keys(entry)).not.toContain('owner');
  });

  it('says false when no wallet is a house wallet', async () => {
    const follows = await createFollowStore(db).listFollows(FOLLOWER);
    expect(follows.map((entry) => entry.house)).toEqual([false, false]);
  });
});

describe('through the Worker entry', () => {
  const allow = { limit: async () => ({ success: true }) };
  const entryEnv = {
    ...(env as unknown as Record<string, unknown>),
    SITE_ORIGIN: 'https://prix.test',
    HOUSE_MODEL: '@cf/test/model',
    HOUSE_MODEL_INPUT_NEURONS: '1',
    HOUSE_MODEL_OUTPUT_NEURONS: '1',
    KEY_ENCRYPTION_KEY: btoa('k'.repeat(32)),
    NONCE_SECRET: btoa('n'.repeat(32)),
    HOUSE_OWNERS: HOUSE_OWNERS.join(', '),
    RATE_SIGN_IN: allow,
    RATE_WRITE: allow,
    RATE_READ: allow,
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };

  async function read(path: string): Promise<Record<string, unknown>> {
    const response = await worker.fetch(
      new Request(`https://prix.test${path}`) as never,
      entryEnv as never,
      ctx as never,
    );
    await Promise.all(pending.splice(0));
    expect(response.status, path).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('hands HOUSE_OWNERS to the stores: the results and the track record of a house agent say house', async () => {
    const results = (await read(`/api/reputation/seasons/${SEASON_1.id}/results?division=open`)) as {
      rows: { agentId: string; house?: boolean }[];
    };
    expect(results.rows.map((row) => [row.agentId, row.house])).toEqual([
      [house.id, true],
      [user.id, false],
    ]);
    const record = (await read(`/api/reputation/agents/${house.id}/record`)) as { record: { house?: boolean } };
    expect(record.record.house).toBe(true);
    expect(JSON.stringify(results)).not.toContain(HOUSE_WALLET.slice(2));
  });
});
