import type { RankTapeDay, Rivalry } from '@prix/contracts';
import { SOCIAL_CURSOR, SOCIAL_JOB_MAX_STATEMENTS } from '@prix/contracts';
import { rivalryEngine } from '@prix/reputation/rivalry';
import { createRankTapeJob, createRivalryMatchJob } from '@prix/runtime/social/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, jobDeps, meteredDb, resetDb, SEASON_1, storesOn } from './support/d1.ts';
import { dayAt, League } from './support/league.ts';

/**
 * The rank_tape and rivalry_match jobs (docs/contracts/phase-6-social.md section 5.4) on the real
 * database. The league is the real one; the ranks of the day are then set by hand, so that the two
 * jobs meet the table of the rivalry example: A and B trade the first places, F sits far below.
 */

const plain = storesOn(db);

async function setRanks(ranks: Record<string, number>): Promise<void> {
  await db.prepare('UPDATE portfolios SET rank = NULL').run();
  for (const [id, rank] of Object.entries(ranks)) {
    await db.prepare('UPDATE portfolios SET rank = ?1 WHERE agent_id = ?2').bind(rank, id).run();
  }
}

/** Ranks of the example: A1 B2 on days 0, 2, 3, 4; B1 A2 on days 1 and 5; A1 B4 from day 6. F always 5. */
function example(i: number, a: string, b: string, f: string): Record<string, number> {
  if (i === 1 || i === 5) return { [b]: 1, [a]: 2, [f]: 5 };
  if (i >= 6) return { [a]: 1, [b]: 4, [f]: 5 };
  return { [a]: 1, [b]: 2, [f]: 5 };
}

function setup(now: string) {
  const metered = meteredDb(db);
  const stores = storesOn(metered.db);
  const world = jobDeps(stores, { now });
  return {
    metered,
    world,
    tape: createRankTapeJob(world.deps),
    rivalry: createRivalryMatchJob(world.deps),
    async runCounted(job: { run(now: Date): Promise<string> }, at: string) {
      metered.reset();
      const outcome = await job.run(new Date(at));
      return { outcome, statements: metered.meter.statements, writes: metered.meter.writes };
    },
  };
}

async function tapeOf(seasonId = SEASON_1.id): Promise<RankTapeDay[]> {
  return plain.social.listTape(seasonId, 'open', '2099-01-01', 100);
}

describe('the tape and the matches of a v1 season, day by day', () => {
  let league: League;
  let ids: [string, string, string];
  const at = (i: number) => `${dayAt(i)}T21:00:00.000Z`;

  beforeEach(async () => {
    await resetDb([{ season: SEASON_1, method: null }]);
    league = new League(plain, { agents: 3 });
    await league.addAgents();
    ids = league.agents.map((agent) => agent.id) as [string, string, string];
  });

  async function playUpTo(last: number, t = setup(at(0))): Promise<ReturnType<typeof setup>> {
    for (let i = 0; i <= last; i++) {
      await league.playTick(i);
      await league.closeDay(i);
      await setRanks(example(i, ...ids));
      const tapeRun = await t.runCounted(t.tape, at(i));
      expect(tapeRun.outcome, `tape day ${i}`).toBe('done');
      expect(tapeRun.statements, `tape day ${i}`).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
      const rivalryRun = await t.runCounted(t.rivalry, at(i));
      expect(rivalryRun.outcome, `rivalry day ${i}`).toBe('done');
      expect(rivalryRun.statements, `rivalry day ${i}`).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
    }
    return t;
  }

  it('records the official ranks of each final day, both divisions, and moves its cursor with them', async () => {
    await playUpTo(2);
    const tape = await tapeOf();
    expect(tape.map((t) => t.day)).toEqual([dayAt(0), dayAt(1), dayAt(2)]);
    const [a, b, f] = ids;
    expect(tape[0]?.ranks).toEqual([
      [a, 1],
      [b, 2],
      [f, 5],
    ]);
    expect(tape[1]?.ranks).toEqual([
      [b, 1],
      [a, 2],
      [f, 5],
    ]);
    expect(tape[0]).toMatchObject({ seasonId: SEASON_1.id, division: 'open', method: 'v1' });
    expect(await plain.social.countTapeDays(SEASON_1.id, 'open')).toBe(3);
    expect(await plain.social.countTapeDays(SEASON_1.id, 'pro')).toBe(3);
    const cursor = JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.tape)) as string);
    expect(cursor).toEqual({ tapedDay: dayAt(2), missed: [] });
    expect(JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.rivalry)) as string)).toEqual({
      matchedDay: dayAt(2),
    });
  });

  it('forms the rivalry on the fifth close day, with an overtake and an end, and replay agrees with what is stored', async () => {
    const t = await playUpTo(13);
    const [a, b] = ids;
    const stored = (await plain.social.getRivalry(SEASON_1.id, a, b, 50)) as NonNullable<
      Awaited<ReturnType<typeof plain.social.getRivalry>>
    >;
    const row = stored.view.rivalry;
    expect(row).toMatchObject({
      status: 'ended',
      formedDay: dayAt(4),
      endedDay: dayAt(13),
      endReason: 'apart',
      leadChanges: 2,
    });
    // Events, newest first: ended, the overtake of A on day 6, the overtake of B on day 5, formed.
    expect(stored.events.map((e) => `${e.kind}@${e.day}`)).toEqual([
      `ended@${dayAt(13)}`,
      `overtake@${dayAt(6)}`,
      `overtake@${dayAt(5)}`,
      `formed@${dayAt(4)}`,
    ]);
    expect(stored.events.find((e) => e.kind === 'formed')?.detail).toEqual({
      gap: 1,
      closeDays: 5,
      swaps: 2,
      windowDays: 5,
    });

    // What the engine makes of the stored tape is what the jobs stored.
    const replayed = rivalryEngine.replay({ tapes: await tapeOf() });
    expect(replayed.rivalries).toHaveLength(1);
    const replayedRow = replayed.rivalries[0] as Rivalry;
    expect(replayedRow).toEqual(row);
    expect([...stored.events].reverse()).toEqual(replayed.events);

    // Both jobs are now idle at no more than two reads and no write.
    const tapeIdle = await t.runCounted(t.tape, at(14));
    expect(tapeIdle).toMatchObject({ outcome: 'idle', writes: 0 });
    expect(tapeIdle.statements).toBeLessThanOrEqual(2);
    const rivalryIdle = await t.runCounted(t.rivalry, at(14));
    expect(rivalryIdle).toMatchObject({ outcome: 'idle', writes: 0 });
    expect(rivalryIdle.statements).toBeLessThanOrEqual(2);
  });

  it('shows an active rivalry to the agent page read and leaves it out when an agent is hidden', async () => {
    await playUpTo(5);
    const [a, b] = ids;
    const active = await plain.social.listAgentRivalries(a, SEASON_1.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.rivalry).toMatchObject({ status: 'active', leader: b, leadChanges: 1 });
    expect((await plain.social.listRivalries(SEASON_1.id, 'open', 10, 0)).map((v) => v.rivalry.agentA)).toEqual([a]);

    await db.prepare('UPDATE agents SET hidden = 1 WHERE id = ?1').bind(b).run();
    expect(await plain.social.listAgentRivalries(a, SEASON_1.id)).toEqual([]);
    expect(await plain.social.listRivalries(SEASON_1.id, 'open', 10, 0)).toEqual([]);
    expect(await plain.social.getRivalry(SEASON_1.id, a, b, 10)).toBeNull();
    await db.prepare('UPDATE agents SET hidden = 0 WHERE id = ?1').bind(b).run();
    expect(await plain.social.listAgentRivalries(a, SEASON_1.id)).toHaveLength(1);
  });

  it('never writes a Phase 1 to 5 table: the tape and the matches change their own tables and cursors only', async () => {
    await league.playTick(0);
    await league.closeDay(0);
    await setRanks(example(0, ...ids));
    const guarded = ['agents', 'portfolios', 'decisions', 'ticks', 'season_scores', 'league_state', 'day_prices'];
    const dump = async () => {
      const out: Record<string, unknown> = {};
      for (const table of guarded) out[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
      return JSON.stringify(out);
    };
    const before = await dump();
    const t = setup(at(0));
    await t.tape.run(new Date(at(0)));
    await t.rivalry.run(new Date(at(0)));
    expect(await dump()).toBe(before);
  });
});

describe('a day the tape cannot keep', () => {
  const at = (i: number) => `${dayAt(i)}T21:00:00.000Z`;

  beforeEach(async () => {
    await resetDb([{ season: SEASON_1, method: null }]);
  });

  it('records a v1 day as missed when a tick of a later day has already moved the ranks, and never invents it', async () => {
    const league = new League(plain, { agents: 3 });
    await league.addAgents();
    // Four days pass before the tape looks: days 0, 1 and 2 are over, day 3 is the latest.
    for (let i = 0; i < 4; i++) await league.playDay(i);
    const t = setup(at(3));
    const outcomes: string[] = [];
    for (let run = 0; run < 6; run++) {
      const result = await t.runCounted(t.tape, at(3));
      expect(result.statements).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
      outcomes.push(result.outcome);
      if (result.outcome === 'idle') break;
    }
    expect(outcomes).toEqual(['more', 'more', 'more', 'done', 'idle']);
    const cursor = JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.tape)) as string);
    expect(cursor).toEqual({ tapedDay: dayAt(3), missed: [dayAt(0), dayAt(1), dayAt(2)] });
    // Only the latest day has a tape row, and the missed ones were not written at all.
    expect((await tapeOf()).map((row) => row.day)).toEqual([dayAt(3)]);
    expect(t.world.logs.filter((l) => l.event === 'rank_tape_missed')).toHaveLength(3);
    // The rivalry job passes over the days without a tape without a rivalry and without an error.
    const matched: string[] = [];
    for (let run = 0; run < 6; run++) {
      const result = await t.runCounted(t.rivalry, at(3));
      matched.push(result.outcome);
      if (result.outcome === 'idle') break;
    }
    expect(matched.at(-1)).toBe('idle');
    expect(JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.rivalry)) as string).matchedDay).toBe(dayAt(3));
    expect(await db.prepare('SELECT count(*) AS n FROM rivalries').first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('keeps only the last ten missed days in its cursor', async () => {
    const league = new League(plain, { agents: 2 });
    await league.addAgents();
    for (let i = 0; i < 14; i++) await league.playDay(i);
    const t = setup(at(13));
    for (let run = 0; run < 20; run++) if ((await t.tape.run(new Date(at(13)))) === 'idle') break;
    const cursor = JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.tape)) as string);
    expect(cursor.tapedDay).toBe(dayAt(13));
    expect(cursor.missed).toHaveLength(10);
    expect(cursor.missed.at(-1)).toBe(dayAt(12));
  });

  it('waits in a v2 season until the day is scored, then records it as missed after two days', async () => {
    await resetDb([{ season: SEASON_1, method: 'v2' }]);
    const league = new League(plain, { agents: 3 });
    await league.addAgents();
    await league.playTick(0);
    await league.closeDay(0, { score: false });
    const t = setup(at(0));
    // Day 0 has prices but is not scored: nothing is written and the tape waits.
    const wait = await t.runCounted(t.tape, at(0));
    expect(wait).toMatchObject({ outcome: 'idle', writes: 0 });
    // Two days later the day will not be scored any more: it is missed, not invented.
    const late = await t.runCounted(t.tape, `${dayAt(2)}T01:00:00.000Z`);
    expect(late.outcome).toBe('done');
    expect(await tapeOf()).toEqual([]);
    const cursor = JSON.parse((await plain.reputation.getJobState(SOCIAL_CURSOR.tape)) as string);
    expect(cursor).toEqual({ tapedDay: dayAt(0), missed: [dayAt(0)] });
  });

  it('records a v2 day as soon as it is scored, and the tape holds the official rank copied into portfolios', async () => {
    await resetDb([{ season: SEASON_1, method: 'v2' }]);
    // Twelve days of a league of twelve: enough for the first ranks of the v2 method.
    const league = new League(plain, { agents: 12, seed: 3 });
    await league.addAgents();
    const t = setup(at(0));
    let taped = 0;
    for (let i = 0; i < 12; i++) {
      await league.playDay(i);
      const result = await t.runCounted(t.tape, at(i));
      if (result.outcome === 'done') taped += 1;
    }
    // Every scored day was taped on the day (the open division is the only one with agents).
    expect(taped).toBe(12);
    const last = (await tapeOf()).at(-1) as RankTapeDay;
    expect(last.day).toBe(dayAt(11));
    expect(last.method).toBe('v2');
    // The tape is the official rank: it equals portfolios.rank of the day.
    const stored = (
      await db.prepare('SELECT agent_id, rank FROM portfolios WHERE rank IS NOT NULL ORDER BY rank').all<{
        agent_id: string;
        rank: number;
      }>()
    ).results;
    expect(last.ranks).toEqual(stored.map((r) => [r.agent_id, r.rank]));
    expect(stored.length).toBeGreaterThan(0);
  });
});

describe('a table with many rivalries', () => {
  const at = (i: number) => `${dayAt(i)}T21:00:00.000Z`;

  it('keeps every run of the rivalry job within the statement limit, on the day they form and every day after', async () => {
    await resetDb([{ season: SEASON_1, method: null }]);
    // 44 agents in 22 pairs. Pair k holds the ranks 2k+1 and 2k+2 and trades them every day: after five
    // days every pair is a rivalry (20 or more are ranked, so the gap is two places).
    const league = new League(plain, { agents: 44, seed: 5 });
    await league.addAgents();
    const ids = league.agents.map((agent) => agent.id);
    const t = setup(at(0));
    const runs: Array<{ day: number; job: string; statements: number }> = [];
    for (let i = 0; i < 8; i++) {
      await league.playTick(i);
      await league.closeDay(i);
      const ranks: Record<string, number> = {};
      for (let k = 0; k < 22; k++) {
        const flip = i % 2 === 1;
        ranks[ids[2 * k] as string] = 2 * k + (flip ? 2 : 1);
        ranks[ids[2 * k + 1] as string] = 2 * k + (flip ? 1 : 2);
      }
      await setRanks(ranks);
      for (const [job, name] of [
        [t.tape, 'tape'],
        [t.rivalry, 'rivalry'],
      ] as const) {
        const result = await t.runCounted(job, at(i));
        runs.push({ day: i, job: name, statements: result.statements });
      }
    }
    const rivalries = (
      await db.prepare("SELECT count(*) AS n FROM rivalries WHERE status = 'active'").first<{ n: number }>()
    )?.n;
    expect(rivalries).toBe(22);
    const worst = runs.reduce((most, run) => (run.statements > most.statements ? run : most));
    expect(worst.statements, `day ${worst.day} ${worst.job}`).toBeLessThanOrEqual(SOCIAL_JOB_MAX_STATEMENTS);
  }, 120_000);
});

describe('failures', () => {
  const at = (i: number) => `${dayAt(i)}T21:00:00.000Z`;

  it('never throws when the database fails at any statement of a run, and logs only the job and the error name', async () => {
    await resetDb([{ season: SEASON_1, method: null }]);
    const league = new League(plain, { agents: 3 });
    await league.addAgents();
    await league.playTick(0);
    await league.closeDay(0);
    await setRanks(example(0, ...(league.agents.map((a) => a.id) as [string, string, string])));
    const probe = setup(at(0));
    const full = (await probe.runCounted(probe.tape, at(0))).statements;
    expect(full).toBeGreaterThanOrEqual(4);
    // Reset the tape so that each failure point meets the same day.
    for (const jobName of ['tape', 'rivalry'] as const) {
      for (let after = 0; after < full; after++) {
        await db.prepare('DELETE FROM rivalry_days').run();
        await db.prepare("DELETE FROM job_state WHERE name LIKE 'social:%'").run();
        const t = setup(at(0));
        t.metered.failAfter(after, new Error('database exploded: secret-token-8675309'));
        const outcome = await (jobName === 'tape' ? t.tape : t.rivalry).run(new Date(at(0)));
        t.metered.clear();
        // Contract 6.1 (section 18.6): a run that met a failed statement answers `failed`, logged with the
        // job's name; a run that sent fewer statements than the failure point finishes as usual.
        const job = jobName === 'tape' ? 'rank_tape' : 'rivalry_match';
        const failed = t.world.logs.some((l) => l.event === 'social_job_failed' && l.data?.job === job);
        if (failed) expect(outcome, `${jobName} after ${after}`).toBe('failed');
        else expect(['idle', 'more', 'done'], `${jobName} after ${after}`).toContain(outcome);
        if (jobName === 'tape') expect(failed, `tape after ${after}`).toBe(true);
        expect(JSON.stringify(t.world.logs)).not.toContain('secret-token-8675309');
        // A failed batch writes nothing: no half-recorded day.
        const rows = (await db.prepare('SELECT count(*) AS n FROM rivalry_days').first<{ n: number }>())?.n;
        expect([0, 2]).toContain(rows);
        const cursor = await plain.reputation.getJobState(SOCIAL_CURSOR.tape);
        expect(cursor === null ? rows === 0 : rows === 2).toBe(true);
      }
    }
  });
});
