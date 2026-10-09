import type { AgentRecord, DnaObservation } from '@prix/contracts';
import { DNA_LAG_DAYS, DNA_METHOD, DNA_MOMENTUM_LOOKBACK_DAYS, DNA_WINDOW_DAYS, SOCIAL_CURSOR } from '@prix/contracts';
import { strategyDna } from '@prix/reputation/dna';
import { createStrategyDnaJob } from '@prix/runtime/social/index';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, jobDeps, resetDb, SEASON_1, storesOn } from './support/d1.ts';
import { dayAt, League } from './support/league.ts';

/**
 * Strategy DNA on the real database (docs/contracts/phase-6-social.md section 5.1): the batch of
 * end-of-day reads, which seeks the last row of each UTC day with a recursive query, equals the same
 * thing worked out in JavaScript from the agent's rows; and every stored profile is reproduced, byte
 * for byte, by the pure engine from the stored inputs.
 */

const stores = storesOn(db);
const DAYS = 16;
let league: League;

/** The last row of each UTC day of the agent, oldest first, the last `limit` days up to `throughDay`. */
async function reference(agentId: string, throughDay: string, limit: number): Promise<DnaObservation[]> {
  const rows = await stores.store.listDecisions(agentId, SEASON_1.id, 5000);
  const byDay = new Map<string, DnaObservation>();
  for (const row of [...rows].sort((a, b) => (a.tickId < b.tickId ? -1 : 1))) {
    const day = row.tickId.slice(0, 10);
    if (day > throughDay) continue;
    byDay.set(day, {
      day,
      tickId: row.tickId,
      seasonId: row.seasonId,
      portfolio: row.portfolio,
      equityMicro: row.equityMicro,
    });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-limit);
}

beforeAll(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
  league = new League(stores, { agents: 7, pros: 3, seed: 5 });
  await league.addAgents();
  const [firstPro, secondPro] = league.pro;
  for (let i = 0; i < DAYS; i++) {
    // The first Pro agent misses the daily tick on days 4 and 9: its last row of those days is the 17:00 one.
    // The second Pro agent decides at 15:00 only on day 6. An Open agent is absent on days 10 to 12.
    const skip: Partial<Record<number, Set<string>>> = {};
    if (firstPro && (i === 4 || i === 9)) skip[19] = new Set([firstPro.id]);
    if (secondPro && i === 6) {
      skip[17] = new Set([secondPro.id]);
      skip[19] = new Set([secondPro.id]);
    }
    if (i >= 10 && i <= 12) skip[19] = new Set([...(skip[19] ?? []), (league.open[0] as AgentRecord).id]);
    await league.playDay(i, { skip });
  }
});

describe('listEndOfDay equals the reference worked out from the rows', () => {
  it('returns the last row of each UTC day, oldest first, for every agent', async () => {
    const ids = league.agents.map((agent) => agent.id);
    const found = await stores.social.listEndOfDay(ids, dayAt(DAYS - 1), 100);
    for (const id of ids) {
      expect(found.get(id), id).toEqual(await reference(id, dayAt(DAYS - 1), 100));
    }
    // Pro agents decide three times a day, and the answer is still one row a day.
    const pro = league.pro[2] as AgentRecord;
    expect(found.get(pro.id)).toHaveLength(DAYS);
    expect(found.get(pro.id)?.every((o) => o.tickId.endsWith('T19:00Z'))).toBe(true);
  });

  it('takes the 17:00 row on a day an agent missed the daily tick, and the 15:00 row when it missed both', async () => {
    const [first, second] = league.pro as [AgentRecord, AgentRecord];
    const found = await stores.social.listEndOfDay([first.id, second.id], dayAt(DAYS - 1), 100);
    expect(found.get(first.id)?.find((o) => o.day === dayAt(4))?.tickId).toBe(`${dayAt(4)}T17:00Z`);
    expect(found.get(second.id)?.find((o) => o.day === dayAt(6))?.tickId).toBe(`${dayAt(6)}T15:00Z`);
  });

  it('leaves out a day on which the agent made no row at all', async () => {
    const quiet = league.open[0] as AgentRecord;
    const days = (await stores.social.listEndOfDay([quiet.id], dayAt(DAYS - 1), 100)).get(quiet.id)?.map((o) => o.day);
    expect(days).toHaveLength(DAYS - 3);
    for (const i of [10, 11, 12]) expect(days).not.toContain(dayAt(i));
  });

  it('honours the day it is read through and the number of days it is asked for', async () => {
    const ids = league.agents.map((agent) => agent.id);
    for (const [through, limit] of [
      [dayAt(9), 100],
      [dayAt(9), 4],
      [dayAt(DAYS - 1), 1],
      [dayAt(0), 5],
      [dayAt(3), 41],
    ] as const) {
      const found = await stores.social.listEndOfDay(ids, through, limit);
      for (const id of ids)
        expect(found.get(id), `${id} ${through} ${limit}`).toEqual(await reference(id, through, limit));
    }
  });

  it('answers an agent without rows, and a day before every row, with an empty list', async () => {
    const found = await stores.social.listEndOfDay(['agentnobodyaa'], dayAt(DAYS - 1), 10);
    expect(found.get('agentnobodyaa') ?? []).toEqual([]);
    const early = await stores.social.listEndOfDay([league.agents[0]?.id as string], '2026-09-01', 10);
    expect(early.get(league.agents[0]?.id as string) ?? []).toEqual([]);
  });

  it('is one batch of reads with one statement per agent, and writes nothing', async () => {
    const { meteredDb } = await import('./support/d1.ts');
    const metered = meteredDb(db);
    const social = storesOn(metered.db).social;
    const ids = league.agents.slice(0, 10).map((agent) => agent.id);
    await social.listEndOfDay(ids, dayAt(DAYS - 1), 41);
    expect(metered.meter.calls).toBe(1);
    expect(metered.meter.statements).toBe(ids.length);
    expect(metered.meter.writes).toBe(0);
  });
});

describe('the strategy_dna job and the stored profiles', () => {
  const now = `${dayAt(DAYS + 1)}T01:00:00.000Z`;

  it('computes every visible agent as of the latest priced day at least two days back, in chunks of ten', async () => {
    const world = jobDeps(stores, { now });
    const job = createStrategyDnaJob(world.deps);
    const outcomes: string[] = [];
    for (let run = 0; run < 5; run++) {
      const outcome = await job.run(world.clock.now);
      outcomes.push(outcome);
      if (outcome !== 'more') break;
    }
    // Ten agents: one chunk of ten, then a chunk of none that finishes the pass; or one short chunk.
    expect(outcomes.at(-1)).toBe('done');
    const lag = dayAt(DAYS + 1 - DNA_LAG_DAYS);
    const asOf = dayAt(DAYS - 1) <= lag ? dayAt(DAYS - 1) : lag;
    for (const agent of league.agents) {
      const profile = await stores.social.getDna(agent.id);
      expect(profile, agent.id).not.toBeNull();
      expect(profile).toMatchObject({ method: DNA_METHOD, agentId: agent.id, asOfDay: asOf });
    }
    const cursor = JSON.parse((await stores.reputation.getJobState(SOCIAL_CURSOR.dna)) as string);
    expect(cursor).toMatchObject({ method: DNA_METHOD, asOfDay: asOf, done: true });
  });

  it('writes a profile that the pure engine reproduces byte for byte from the stored inputs', async () => {
    for (const agent of league.agents) {
      const stored = await stores.social.getDna(agent.id);
      if (stored === null) throw new Error('no profile');
      const observations =
        (await stores.social.listEndOfDay([agent.id], stored.asOfDay, DNA_WINDOW_DAYS + 1)).get(agent.id) ?? [];
      const prices = (await stores.reputation.listDayPrices(null, stored.asOfDay)).slice(
        -(DNA_WINDOW_DAYS + DNA_MOMENTUM_LOOKBACK_DAYS),
      );
      const recomputed = strategyDna.profile({
        agentId: agent.id,
        asOfDay: stored.asOfDay,
        strategySinceDay: agent.strategyChangedAt.slice(0, 10),
        observations,
        pricedDays: prices,
        computedAt: stored.computedAt,
      });
      expect(JSON.stringify(recomputed), agent.id).toBe(JSON.stringify(stored));
    }
  });

  it('makes a ready profile only from ten observed days, and the profiles here are real', async () => {
    const quiet = (await stores.social.getDna(league.open[0]?.id as string)) as NonNullable<
      Awaited<ReturnType<typeof stores.social.getDna>>
    >;
    expect(quiet.status).toBe('ready');
    expect(quiet.observedDays).toBeGreaterThanOrEqual(10);
    const nonNull = Object.values(quiet.axes).filter((axis) => axis.value !== null).length;
    expect(nonNull).toBeGreaterThanOrEqual(5);
  });

  it('keeps the row of a hidden agent and computes no new profile for it', async () => {
    const hidden = league.open[1] as AgentRecord;
    const rowOf = async () =>
      (await db.prepare('SELECT body FROM strategy_dna WHERE agent_id = ?1').bind(hidden.id).first<{ body: string }>())
        ?.body ?? null;
    const before = await rowOf();
    expect(before).not.toBeNull();
    await db.prepare('UPDATE agents SET hidden = 1 WHERE id = ?1').bind(hidden.id).run();
    // A new pass: bump the method in the cursor so that the job starts over.
    await stores.reputation.putJobState(
      SOCIAL_CURSOR.dna,
      JSON.stringify({ method: 'dna-v0', asOfDay: dayAt(DAYS - 1), afterAgentId: null, done: true }),
      now,
    );
    const world = jobDeps(stores, { now: `${dayAt(DAYS + 2)}T01:00:00.000Z` });
    const job = createStrategyDnaJob(world.deps);
    for (let run = 0; run < 5; run++) if ((await job.run(world.clock.now)) !== 'more') break;
    // The row is kept as it was, and it is not served while the agent is hidden.
    expect(await rowOf()).toBe(before);
    expect(await stores.social.getDna(hidden.id)).toBeNull();
    const visible = league.agents.find((a) => a.id !== hidden.id) as AgentRecord;
    expect((await stores.social.getDna(visible.id))?.computedAt).toBe(world.clock.now.toISOString());
  });
});
