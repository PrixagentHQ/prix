import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { AgentRecord, FeedRow, FeedStoreQuery } from '@prix/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFollowStore, LEAGUE_FEED_STATEMENTS } from '../../apps/api/src/store/follow.ts';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import {
  makeAgent,
  makeRow,
  makeTick,
  SEASON_1,
  startingPortfolio,
  startingStats,
  testAddress,
  testId,
  utc,
} from '../support/fixtures.ts';

/**
 * `FollowStore.listLeagueFeed` on a local D1 database inside the Workers runtime
 * (docs/CONTRACTS.md section 17): what it returns, in which order, and that it is one bounded
 * read of the index `decisions_decided_by_tick` of migration 0003, with no sort.
 */
const db = (env as unknown as { DB: D1Database }).DB;

const T1 = '2026-10-06T15:00Z';
const T2 = '2026-10-06T16:00Z';
const T3 = '2026-10-07T15:00Z';
const LATER = '2026-10-08T00:00:00.000Z';

const store = createD1Store(db);
const follow = createFollowStore(db);

let open1: AgentRecord;
let open2: AgentRecord;
let pro: AgentRecord;
let hidden: AgentRecord;
let quiet: AgentRecord;

const keyOf = (entry: FeedRow): string => `${entry.row.tickId}~${entry.row.agentId}`;
const query = (change: Partial<FeedStoreQuery> = {}): FeedStoreQuery => ({
  before: null,
  notAfter: LATER,
  limit: 100,
  ...change,
});

async function addAgent(agent: AgentRecord): Promise<AgentRecord> {
  expect(await store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 200)).toBe('created');
  return agent;
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

  open1 = await addAgent(makeAgent({ n: 1, owner: testAddress(501) }));
  open2 = await addAgent(makeAgent({ n: 2, owner: testAddress(502) }));
  pro = await addAgent(makeAgent({ n: 3, owner: testAddress(503), division: 'pro', modelKeyId: testId('key', 3) }));
  hidden = await addAgent(makeAgent({ n: 4, owner: testAddress(504), overrides: { hidden: true } }));
  quiet = await addAgent(makeAgent({ n: 5, owner: testAddress(505) }));

  for (const id of [T1, T2, T3]) {
    await store.createTick(makeTick(utc(`${id.slice(0, 16)}:00.000Z`), { status: 'complete' }));
  }
  const write = async (agent: AgentRecord, tickId: string, extra: Partial<Parameters<typeof makeRow>[0]> = {}) => {
    const row = makeRow({ agent, tickId, fillCount: 1, ...extra });
    expect(await store.writeDecision(row, startingStats(), 0), `${agent.id} at ${tickId}`).toBe(true);
  };
  // A row is written one second into its round unless the test says otherwise.
  for (const tickId of [T1, T2, T3]) {
    await write(open1, tickId);
    await write(pro, tickId);
    await write(hidden, tickId);
  }
  await write(open2, T1);
  // Written forty minutes into the round, later than the others of the same tick.
  await write(open2, T2, { createdAt: '2026-10-06T16:40:00.000Z' });
  // Rows that are not decisions never reach a feed.
  await write(quiet, T1, { status: 'no_decision' });
  await write(quiet, T2, { status: 'skipped' });
});

describe('FollowStore.listLeagueFeed on D1', () => {
  it('returns the decided rows of every visible agent of both divisions, newest tick first, then agent id descending', async () => {
    const rows = await follow.listLeagueFeed(query());
    expect(rows.map(keyOf)).toEqual([
      `${T3}~${pro.id}`,
      `${T3}~${open1.id}`,
      `${T2}~${pro.id}`,
      `${T2}~${open2.id}`,
      `${T2}~${open1.id}`,
      `${T1}~${pro.id}`,
      `${T1}~${open2.id}`,
      `${T1}~${open1.id}`,
    ]);
    expect(new Set(rows.map((entry) => entry.row.division))).toEqual(new Set(['open', 'pro']));
    for (const entry of rows) {
      expect(entry.row.status).toBe('decided');
      expect(entry.row.agentId).not.toBe(hidden.id);
      expect(entry.row.agentId).not.toBe(quiet.id);
    }
  });

  it('returns the name and the owner of the agent with every row', async () => {
    const rows = await follow.listLeagueFeed(query());
    const agents = new Map([open1, open2, pro].map((agent) => [agent.id, agent]));
    for (const entry of rows) {
      const agent = agents.get(entry.row.agentId);
      expect(entry.agentName).toBe(agent?.name);
      expect(entry.owner).toBe(agent?.owner);
    }
  });

  it('stops at the limit and continues strictly after the cursor', async () => {
    const all = await follow.listLeagueFeed(query());
    const first = await follow.listLeagueFeed(query({ limit: 3 }));
    expect(first.map(keyOf)).toEqual(all.slice(0, 3).map(keyOf));
    const last = first[2] as FeedRow;
    const second = await follow.listLeagueFeed(
      query({ limit: 3, before: { tickId: last.row.tickId, agentId: last.row.agentId } }),
    );
    expect(second.map(keyOf)).toEqual(all.slice(3, 6).map(keyOf));
    // A cursor between two agents of one tick: the tick is not skipped and not repeated.
    const mid = await follow.listLeagueFeed(query({ before: { tickId: T2, agentId: open2.id } }));
    expect(mid.map(keyOf)).toEqual(all.slice(4).map(keyOf));
    const end = all[all.length - 1] as FeedRow;
    expect(
      await follow.listLeagueFeed(query({ before: { tickId: end.row.tickId, agentId: end.row.agentId } })),
    ).toEqual([]);
  });

  it('leaves out every row written after the cut, also inside the hour of the cut', async () => {
    // The cut is half past four: the rows of the 16:00 round written at 16:00:01 are in, the one
    // written at 16:40 is not, and nothing of the next day is.
    const rows = await follow.listLeagueFeed(query({ notAfter: '2026-10-06T16:30:00.000Z' }));
    expect(rows.map(keyOf)).toEqual([
      `${T2}~${pro.id}`,
      `${T2}~${open1.id}`,
      `${T1}~${pro.id}`,
      `${T1}~${open2.id}`,
      `${T1}~${open1.id}`,
    ]);
    // A cut before the first round leaves nothing; a cut at the second a row was written keeps it.
    expect(await follow.listLeagueFeed(query({ notAfter: '2026-10-06T15:00:00.999Z' }))).toEqual([]);
    const exact = await follow.listLeagueFeed(query({ notAfter: '2026-10-06T15:00:01.000Z' }));
    expect(exact).toHaveLength(3);
  });

  it('drops a hidden agent the moment it is hidden, and shows it again when it is shown', async () => {
    await store.updateAgent(open2.id, { hidden: true }, LATER);
    const without = await follow.listLeagueFeed(query());
    expect(without.some((entry) => entry.row.agentId === open2.id)).toBe(false);
    expect(without).toHaveLength(6);
    await store.updateAgent(open2.id, { hidden: false }, LATER);
    expect(await follow.listLeagueFeed(query())).toHaveLength(8);
  });

  it('is one walk of the index decisions_decided_by_tick with a key read of the agent, and no sort', async () => {
    for (const [name, statement] of Object.entries(LEAGUE_FEED_STATEMENTS)) {
      const values = name === 'firstPage' ? [LATER, 21, T3] : [LATER, 21, T3, T2, open2.id];
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${statement}`)
        .bind(...values)
        .all<{ detail: string }>();
      const details = plan.results.map((line) => line.detail);
      const text = details.join(' | ');
      expect(details, text).toHaveLength(2);
      expect(text).toContain('SEARCH d USING INDEX decisions_decided_by_tick');
      expect(text).toMatch(/SEARCH a USING (INDEX sqlite_autoindex_agents_1|PRIMARY KEY)/);
      expect(text).not.toMatch(/TEMP B-TREE|SCAN/);
    }
  });
});

describe('the other feed reads on D1', () => {
  it('return the owner of the agent with every row too', async () => {
    const own = await follow.listAgentFeed(pro.id, query());
    expect(own).toHaveLength(3);
    for (const entry of own) expect(entry.owner).toBe(pro.owner);

    const reader = testAddress(900);
    expect(await follow.putFollow(reader, open1.id, false, LATER, 50)).toBe('created');
    expect(await follow.putFollow(reader, pro.id, false, LATER, 50)).toBe('created');
    const followed = await follow.listFollowFeed(reader, query({ sinceTickId: T1 }));
    expect(followed).toHaveLength(6);
    for (const entry of followed) {
      expect(entry.owner).toBe(entry.row.agentId === pro.id ? pro.owner : open1.owner);
    }
  });
});
