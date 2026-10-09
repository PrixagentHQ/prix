import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { AgentStats, DecisionRow } from '@prix/contracts';
import { SCORING_METHOD } from '@prix/contracts';
import { scoring } from '@prix/reputation';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../../apps/api/src/store/index.ts';
import { makeAgent, makeRow, makeTick, SEASON_1, startingPortfolio, startingStats, utc } from '../support/fixtures.ts';
import { describeStoreContract } from '../support/store-contract.ts';

/**
 * The D1 store of `platform`, on a local D1 database inside the Workers runtime, held to the
 * same contract as the in-memory store of the tests, plus the one thing only SQL can get wrong:
 * the ranking it computes must be the ranking of `scoring.rankAgents`.
 */
const db = (env as unknown as { DB: D1Database }).DB;

/**
 * A fresh database for each test: every table is dropped, with its triggers (decisions are insert
 * only, so a delete is refused by design), and the migrations are applied again.
 */
async function emptyDatabase(): Promise<void> {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  // Tables of the runtime itself (_cf_*) are not ours to drop.
  for (const { name } of tables.results) {
    if (!name.startsWith('_cf_')) await db.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
  }
  const bindings = env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
}

async function seedSeason(): Promise<void> {
  await db
    .prepare('INSERT INTO seasons (id, number, starts_at, ends_at) VALUES (?, ?, ?, ?)')
    .bind(SEASON_1.id, SEASON_1.number, SEASON_1.startsAt, SEASON_1.endsAt)
    .run();
}

describeStoreContract('D1 store on a local database', async () => {
  await emptyDatabase();
  return {
    store: createD1Store(db),
    // The contract suite seeds the season itself, after the database was emptied above.
    seedSeason: async () => {
      await seedSeason();
    },
  };
});

describe('rerank and listStandings in SQL give the order of scoring.rankAgents', () => {
  it('ranks the same agents in the same order, with the same ranks, as the scoring engine', async () => {
    await emptyDatabase();
    await seedSeason();
    const store = createD1Store(db);
    const ticks = ['2026-10-06T15:00:00.000Z', '2026-10-07T15:00:00.000Z', '2026-10-08T15:00:00.000Z'];
    for (const at of ticks) await store.createTick(makeTick(utc(at), { daily: true }));
    const lastTick = '2026-10-08T15:00Z';

    // Twelve agents with returns that tie on purpose, so the tie-breaks are used.
    const returns = [900, 900, 900, 450, 450, -120, 0, 0, 2_000, 2_000, 15, 15];
    const drawdowns = [300, 100, 100, 50, 50, 400, 0, 0, 100, 700, 5, 5];
    const trades = [4, 9, 9, 2, 2, 1, 0, 0, 6, 6, 3, 3];
    const agents = [];
    for (let n = 1; n <= returns.length; n += 1) {
      const agent = makeAgent({ n, createdAt: `2026-10-05T0${n % 10}:00:00.000Z` });
      const stats: AgentStats = {
        ...startingStats(),
        seasonReturnBps: returns[n - 1] as number,
        maxDrawdownBps: drawdowns[n - 1] as number,
        tradeCount: trades[n - 1] as number,
        // The last two agents do not meet the thresholds and must be unranked.
        tradingDays: n > 10 ? 2 : 5,
        decidedCount: n > 10 ? 1 : 6,
        equityMicro: 10_000_000_000 + (returns[n - 1] as number) * 1_000_000,
      };
      expect(await store.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 200)).toBe('created');
      const row: DecisionRow = makeRow({ agent, tickId: lastTick, status: 'decided' });
      expect(await store.writeDecision(row, stats, 0)).toBe(true);
      agents.push({ agent, stats });
    }

    const state = await store.rerank(SEASON_1.id, 'open', lastTick, '2026-10-08T15:30:00.000Z', SCORING_METHOD);
    const table = await store.listStandings(SEASON_1.id, 'open', 100, 0);
    expect(table).toHaveLength(agents.length);

    const expected = scoring.rankAgents(
      agents.map(({ agent, stats }) => ({
        agentId: agent.id,
        name: agent.name,
        createdAt: agent.createdAt,
        stats,
        lastStatus: 'decided' as const,
      })),
    );

    const ranked = expected.filter((entry) => entry.rank !== null);
    expect(state.rankedCount).toBe(ranked.length);
    expect(table.filter((row) => row.rank !== null).map((row) => [row.agentId, row.rank])).toEqual(
      ranked.map((entry) => [entry.agentId, entry.rank]),
    );
    // The unranked ones follow, in the order of the contract: the same five keys.
    expect(table.map((row) => row.agentId)).toEqual(expected.map((entry) => entry.agentId));
  });
});

/**
 * A D1 database that records the SQL of every statement the store prepares, and the values it
 * binds, and passes everything on to the real one.
 */
function recordingDb(): { db: D1Database; statements: { sql: string; values: unknown[] }[] } {
  const statements: { sql: string; values: unknown[] }[] = [];
  const recording = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          const entry = { sql: query, values: [] as unknown[] };
          statements.push(entry);
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === 'bind') {
                return (...values: unknown[]) => {
                  entry.values = values;
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: recording, statements };
}

describe('the holdings of a league page (docs/CONTRACTS.md section 17.2)', () => {
  it('reads the prices of each distinct tick of a page once, in one statement, not one per row', async () => {
    await emptyDatabase();
    await seedSeason();
    const setup = createD1Store(db);
    const T1 = '2026-10-06T15:00Z';
    const T2 = '2026-10-06T16:00Z';
    await setup.createTick(makeTick(utc('2026-10-06T15:00:00.000Z')));
    await setup.createTick(makeTick(utc('2026-10-06T16:00:00.000Z')));
    // Six agents: four at the later tick, one at the earlier one, one with no row yet.
    for (let n = 1; n <= 6; n += 1) {
      const agent = makeAgent({ n });
      expect(await setup.createAgent(agent, SEASON_1.id, startingPortfolio(), startingStats(), 200)).toBe('created');
      if (n <= 5) {
        expect(await setup.writeDecision(makeRow({ agent, tickId: n === 5 ? T1 : T2 }), startingStats(), 0)).toBe(true);
      }
    }

    const { db: recorded, statements } = recordingDb();
    const table = await createD1Store(recorded).listStandings(SEASON_1.id, 'open', 100, 0);
    expect(table).toHaveLength(6);
    expect(table.every((row) => row.portfolio !== undefined && row.prices !== undefined)).toBe(true);
    // The page, then the prices of its two distinct ticks.
    expect(statements).toHaveLength(2);
    const ticks = statements[1];
    expect(ticks?.sql).toContain('ticks');
    expect(JSON.parse(String(ticks?.values[0])).sort()).toEqual([T1, T2]);

    // A page of agents without a row reads no tick at all.
    statements.length = 0;
    const offset = table.findIndex((row) => row.lastTickId === null);
    const last = await createD1Store(recorded).listStandings(SEASON_1.id, 'open', 1, offset);
    expect(last.map((row) => [row.lastTickId, row.prices])).toEqual([[null, {}]]);
    expect(statements).toHaveLength(1);
  });
});
