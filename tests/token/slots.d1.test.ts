import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { AgentRecord, Tier, TokenHolder } from '@prix/contracts';
import { entitlementsOfTier, SCORING_METHOD } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { createTokenStore } from '../../apps/api/src/store/token.ts';
import { makeAgent, makeRow, makeTick, SEASON_1, startingPortfolio, startingStats, utc } from '../support/fixtures.ts';

/**
 * The slots of docs/contracts/phase-4-token.md section 5.4 item 2, on the real migrations in the
 * Workers pool: `applySlots` pauses the agents beyond a wallet's slots, resumes the ones that fit
 * again, never deletes, never touches an agent paused for another reason, and a second call
 * changes nothing. The D1 store also takes `maxPerOwner` (the contract suite of tests/workers runs
 * the same case against both stores).
 */
const db = (env as unknown as { DB: D1Database }).DB;
const OWNER = '0x00000000000000000000000000000000000a11ce';
const TOKEN = '0x000000000000000000000000000000000000070c';
const T0 = '2026-10-06T14:00:00.000Z';
const TICK = '2026-10-06T15:00Z';

async function emptyDatabase(): Promise<void> {
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
}

const store = createD1Store(db);
const tokens = createTokenStore(db);

function holder(tier: Tier, checkedAt = T0): TokenHolder {
  return {
    address: OWNER,
    balance: '1',
    totalSupply: '1000',
    decimals: 18,
    tier,
    maxAgents: entitlementsOfTier(tier).maxAgents,
    tokenAddress: TOKEN,
    checkedAt,
  };
}

async function agentRows(): Promise<AgentRecord[]> {
  const rows: AgentRecord[] = [];
  for (let n = 1; n <= 4; n += 1) {
    const agent = await store.getAgent(makeAgent({ n }).id);
    if (agent) rows.push(agent);
  }
  return rows;
}

async function counts() {
  const one = async (table: string) =>
    (await db.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())?.c ?? -1;
  return { agents: await one('agents'), portfolios: await one('portfolios'), decisions: await one('decisions') };
}

async function ranks(): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let n = 1; n <= 4; n += 1) out.push((await store.getPortfolio(makeAgent({ n }).id, SEASON_1.id))?.rank ?? null);
  return out;
}

describe('applySlots on D1', () => {
  beforeEach(async () => {
    await emptyDatabase();
    // The owner has the slots of tier 2 and four agents, created a minute apart, with decisions and ranks.
    expect(await store.createTick(makeTick(utc('2026-10-06T15:00:00.000Z'), { daily: true }))).toBe(true);
    for (let n = 1; n <= 4; n += 1) {
      const agent = makeAgent({ n, owner: OWNER, createdAt: `2026-10-05T08:0${n}:00.000Z` });
      expect(await store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 200, 10)).toBe(
        'created',
      );
      const stats = {
        ...startingStats(),
        seasonReturnBps: n * 100,
        tradingDays: 5,
        decidedCount: 6,
        equityMicro: 10_000_000_000 + n * 100_000_000,
      };
      expect(await store.writeDecision(makeRow({ agent, tickId: TICK, status: 'decided' }), stats, 0)).toBe(true);
    }
    await store.rerank(SEASON_1.id, 'open', TICK, '2026-10-06T15:30:00.000Z', SCORING_METHOD);
    await tokens.putHolders([holder(2)]);
    expect(await tokens.applySlots(T0)).toEqual({ paused: 0, resumed: 0 });
  });

  it('pauses the newest agent when the slots fall to three, deletes nothing, and a second call changes nothing', async () => {
    const before = await counts();
    const ranksBefore = await ranks();
    expect(before).toMatchObject({ agents: 4 });
    expect(ranksBefore.every((rank) => rank !== null)).toBe(true);

    await tokens.putHolders([holder(1, '2026-10-06T15:00:00.000Z')]);
    expect(await tokens.applySlots('2026-10-06T15:00:01.000Z')).toEqual({ paused: 1, resumed: 0 });
    const agents = await agentRows();
    expect(agents.map((agent) => [agent.status, agent.pausedReason])).toEqual([
      ['active', null],
      ['active', null],
      ['active', null],
      ['paused', 'slot_limit'],
    ]);
    expect(await counts()).toEqual(before);
    expect(await ranks()).toEqual(ranksBefore);

    const frozen = JSON.stringify(await agentRows());
    expect(await tokens.applySlots('2026-10-06T15:05:00.000Z')).toEqual({ paused: 0, resumed: 0 });
    expect(JSON.stringify(await agentRows())).toBe(frozen);
    expect(await counts()).toEqual(before);
    expect(await tokens.countOwnerAgents(OWNER)).toEqual({ total: 4, pausedForSlots: 1 });
  });

  it('resumes the paused agent on a rise, with strategyChangedAt set to now, and then changes nothing', async () => {
    await tokens.putHolders([holder(1, '2026-10-06T15:00:00.000Z')]);
    await tokens.applySlots('2026-10-06T15:00:01.000Z');
    const before = await counts();

    await tokens.putHolders([holder(2, '2026-10-06T16:00:00.000Z')]);
    const now = '2026-10-06T16:00:01.000Z';
    expect(await tokens.applySlots(now)).toEqual({ paused: 0, resumed: 1 });
    const fourth = (await agentRows())[3];
    expect(fourth).toMatchObject({ status: 'active', pausedReason: null, strategyChangedAt: now });
    expect(await counts()).toEqual(before);
    expect(await tokens.applySlots('2026-10-06T16:05:00.000Z')).toEqual({ paused: 0, resumed: 0 });
  });

  it('leaves an agent paused by its owner alone, in both directions', async () => {
    const second = makeAgent({ n: 2 });
    expect(await store.updateAgent(second.id, { status: 'paused', pausedReason: 'owner' }, T0)).toBe('updated');
    await tokens.putHolders([holder(1, '2026-10-06T15:00:00.000Z')]);
    expect(await tokens.applySlots('2026-10-06T15:00:01.000Z')).toEqual({ paused: 1, resumed: 0 });
    expect((await agentRows()).map((agent) => agent.pausedReason)).toEqual([null, 'owner', null, 'slot_limit']);

    await tokens.putHolders([holder(3, '2026-10-06T16:00:00.000Z')]);
    expect(await tokens.applySlots('2026-10-06T16:00:01.000Z')).toEqual({ paused: 0, resumed: 1 });
    expect((await agentRows()).map((agent) => agent.pausedReason)).toEqual([null, 'owner', null, null]);
  });

  it('pauses all but the oldest agent at tier 0 and releases them when gating is switched off', async () => {
    await tokens.putHolders([holder(0, '2026-10-06T15:00:00.000Z')]);
    expect(await tokens.applySlots('2026-10-06T15:00:01.000Z')).toEqual({ paused: 3, resumed: 0 });
    expect((await agentRows())[0]).toMatchObject({ status: 'active' });
    expect(await tokens.releaseSlotPauses('2026-10-06T15:10:00.000Z')).toBe(3);
    expect((await agentRows()).every((agent) => agent.status === 'active' && agent.pausedReason === null)).toBe(true);
    expect((await counts()).agents).toBe(4);
  });
});
