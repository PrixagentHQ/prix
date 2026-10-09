import { scoring } from '@prix/reputation';
import {
  createManagerValueJob,
  createModelWarJob,
  createRankTapeJob,
  createRivalryMatchJob,
  createStrategyDnaJob,
  runSocialStep,
} from '@prix/runtime/social/index';
import { sim } from '@prix/sim';
import { createManagerEngine } from '@prix/sim/manager';
import { describe, expect, it } from 'vitest';
import { decisionJson } from '../support/fakes.ts';
import { db, jobDeps, resetDb, SEASON_1, storesOn, warWorld } from './support/d1.ts';
import { dayAt, League } from './support/league.ts';
import { addManager } from './support/managers.ts';
import { createWar, GEMMA, GPT_OSS, LLAMA } from './support/war.ts';

/**
 * Score integrity (docs/contracts/phase-6-social.md section 11, rule 9): no Phase 6 code writes
 * `portfolios`, `decisions`, `season_scores` or any Phase 1 to 5 table, except part A's rank copy in
 * `rerank`. The same fifteen-day league runs twice, once with every social job running at every step
 * and once without them; every table that is not Phase 6's is then identical, row for row.
 */

const SOCIAL_TABLES = new Set([
  'strategy_dna',
  'agent_lineage',
  'rivalry_days',
  'rivalries',
  'rivalry_events',
  'wars',
  'war_entrants',
  'war_rows',
  'war_usage',
  'managers',
  'manager_policies',
  'manager_books',
  'manager_rebalances',
]);

const DAYS = 15;
const ok = (neurons: number) => ({
  ok: true as const,
  text: decisionJson({ NVDA: 20, MSFT: 20 }, 'Holds two large companies in equal parts.'),
  inputTokens: 1500,
  outputTokens: 60,
  neurons,
});

async function dumpTables(): Promise<Record<string, unknown[]>> {
  const names = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>()
  ).results
    .map((row) => row.name)
    .filter((name) => !name.startsWith('_cf_') && !name.startsWith('d1_') && !SOCIAL_TABLES.has(name));
  const out: Record<string, unknown[]> = {};
  for (const name of names) {
    const columns = (await db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all<{ name: string }>()).results
      .map((c) => `"${c.name}"`)
      .join(', ');
    const where = name === 'job_state' ? "WHERE name NOT LIKE 'social:%'" : '';
    out[name] = (await db.prepare(`SELECT * FROM ${name} ${where} ORDER BY ${columns}`).all()).results;
  }
  return out;
}

async function simulate(withSocial: boolean): Promise<void> {
  await resetDb([{ season: SEASON_1, method: 'v2' }]);
  const stores = storesOn(db);
  const league = new League(stores, { agents: 12, pros: 3, seed: 21 });
  await league.addAgents();

  const models = warWorld({ [LLAMA]: () => ok(20), [GEMMA]: () => ok(6), [GPT_OSS]: () => ok(0) });
  const world = jobDeps(stores, { now: `${dayAt(0)}T21:00:00.000Z`, war: models.deps });
  const jobs = [
    createModelWarJob(world.deps),
    createRankTapeJob(world.deps),
    createRivalryMatchJob(world.deps),
    createStrategyDnaJob(world.deps),
    createManagerValueJob({ ...world.deps, manager: createManagerEngine({ sim, scoring }) }),
  ];

  if (withSocial) {
    const ids = league.agents.map((a) => a.id);
    for (let n = 1; n <= 5; n++) {
      await addManager(
        stores,
        n,
        { [ids[n] as string]: 3000, [ids[n + 3] as string]: 3000 },
        n % 2 === 0 ? 'hold' : 'weekly',
      );
    }
    await createWar(stores, [LLAMA, GEMMA, GPT_OSS], { startsOn: dayAt(2), deadlineDay: dayAt(20), tradingDays: 5 });
  }

  for (let i = 0; i < DAYS; i++) {
    await league.playDay(i);
    if (!withSocial) continue;
    const at = new Date(`${dayAt(i)}T21:00:00.000Z`);
    for (let step = 0; step < 15; step++) {
      const result = await runSocialStep(jobs, at);
      if (result.ran === null) break;
    }
  }
  if (withSocial) {
    // The days of the league are over; give the lagging jobs (DNA is two days behind) their last steps.
    const at = new Date(`${dayAt(DAYS + 2)}T01:00:00.000Z`);
    for (let step = 0; step < 15; step++) if ((await runSocialStep(jobs, at)).ran === null) break;
  }
}

describe('the social jobs and the league', () => {
  it('leaves every Phase 1 to 5 table exactly as it is without them, over 15 simulated days', async () => {
    await simulate(false);
    const without = await dumpTables();

    await simulate(true);
    const withJobs = await dumpTables();

    // The comparison covers the tables that matter most, by name, and then all of them.
    for (const table of ['portfolios', 'season_scores', 'decisions', 'league_state', 'day_prices', 'ticks', 'agents']) {
      expect(without[table]?.length, table).toBeGreaterThan(0);
      expect(withJobs[table], table).toEqual(without[table]);
    }
    expect(Object.keys(withJobs)).toEqual(Object.keys(without));
    for (const table of Object.keys(without)) expect(withJobs[table], table).toEqual(without[table]);

    // The run with the jobs did real work: they wrote their own tables.
    const count = async (table: string) =>
      ((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()) as { n: number }).n;
    expect(await count('strategy_dna')).toBe(15);
    expect(await count('rivalry_days')).toBeGreaterThanOrEqual(2 * 10);
    expect(await count('manager_books')).toBe(5);
    expect(await count('war_rows')).toBeGreaterThanOrEqual(3);
    expect(await count('war_usage')).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
