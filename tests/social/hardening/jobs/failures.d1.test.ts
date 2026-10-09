import type { ModelResponse, SocialJob, SocialJobDeps } from '@prix/contracts';
import { SOCIAL_JOB_SKIP_AFTER_FAILURES, socialFailureCursor } from '@prix/contracts';
import {
  createManagerValueJob,
  createModelWarJob,
  createRankTapeJob,
  createRivalryMatchJob,
  createStrategyDnaJob,
  runSocialStep,
} from '@prix/runtime/social/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { decisionJson } from '../../../support/fakes.ts';
import type { ModelScript } from '../../support/d1.ts';
import { db, jobDeps, resetDb, SEASON_1, storesOn, warWorld } from '../../support/d1.ts';
import { dayAt, League } from '../../support/league.ts';
import { createWar, dailyTick, GEMMA, GPT_OSS, LLAMA, WAR_ID } from '../../support/war.ts';

/**
 * Security review 6, finding 4 (docs/contracts/phase-6-social.md section 4.2): a social job that throws
 * answers `failed` and the step goes on to the next job; a job that failed SOCIAL_JOB_SKIP_AFTER_FAILURES
 * runs in a row is skipped until the next UTC day; the war job never asks the models twice for one
 * war-day, even when the batch that should have stored it failed.
 */

const plain = storesOn(db);
const at = (i: number, time = '21:00:00.000Z') => `${dayAt(i)}T${time}`;

async function failureRow(job: Parameters<typeof socialFailureCursor>[0]): Promise<unknown> {
  const body = await plain.reputation.getJobState(socialFailureCursor(job));
  return body === null ? null : JSON.parse(body);
}

describe('a job that throws', () => {
  beforeEach(async () => {
    await resetDb([{ season: SEASON_1, method: null }]);
    const league = new League(plain, { agents: 3 });
    await league.addAgents();
    await league.playDay(0);
  });

  it('answers failed, and the step runs the later jobs while the first job throws, until the daily skip stops it', async () => {
    const world = jobDeps(plain, { now: at(0) });
    const broken: SocialJobDeps = {
      ...world.deps,
      social: {
        ...plain.social,
        getOpenWar: async () => {
          throw new Error('the war table is gone: secret-token-4242');
        },
      },
    };
    const jobs: SocialJob[] = [
      createModelWarJob(broken),
      createRankTapeJob(world.deps),
      createRivalryMatchJob(world.deps),
      createStrategyDnaJob(world.deps),
      createManagerValueJob(world.deps),
    ];
    expect(await jobs[0]?.run(new Date(at(0)))).toBe('failed');

    const steps: string[] = [];
    for (let step = 0; step < 8; step++) {
      const result = await runSocialStep(jobs, new Date(at(0)));
      steps.push(`${result.ran}:${result.outcome}`);
      if (result.ran === null || result.outcome === 'failed') break;
    }
    // The war job failed while the tape and the matches still ran after it in the same steps.
    expect(steps.slice(0, 2)).toEqual(['rank_tape:done', 'rivalry_match:done']);
    expect(await plain.social.countTapeDays(SEASON_1.id, 'open')).toBe(1);
    const failed = world.logs.filter((l) => l.event === 'social_job_failed');
    for (const line of failed) expect(line.data).toMatchObject({ job: 'model_war' });
    expect(JSON.stringify(world.logs)).not.toContain('secret-token-4242');

    // Contract 6.1 (section 4.2): after SOCIAL_JOB_SKIP_AFTER_FAILURES failures in a row today the war
    // job is skipped until the next UTC day, though it throws before its gate. It fails exactly that
    // often, its count stops there, and the step ends idle once the other jobs have done their work.
    expect(failed).toHaveLength(SOCIAL_JOB_SKIP_AFTER_FAILURES);
    expect(await failureRow('model_war')).toEqual({ day: dayAt(0), failures: SOCIAL_JOB_SKIP_AFTER_FAILURES });
    expect(world.logs.some((l) => l.event === 'social_job_skipped' && l.data?.job === 'model_war')).toBe(true);
    expect(steps).not.toContain('model_war:failed');
    expect(steps.at(-1)).toBe('null:idle');
    expect(await jobs[0]?.run(new Date(at(0, '23:55:00.000Z')))).toBe('idle');
    expect(world.logs.filter((l) => l.event === 'social_job_failed')).toHaveLength(SOCIAL_JOB_SKIP_AFTER_FAILURES);
  });

  it('is skipped after three failures in a row until the next UTC day, and a run that works clears the count', async () => {
    const world = jobDeps(plain, { now: at(0) });
    let attempts = 0;
    const failing: SocialJobDeps = {
      ...world.deps,
      social: {
        ...plain.social,
        writeTape: async () => {
          attempts += 1;
          throw new Error('the tape write failed');
        },
      },
    };
    const job = createRankTapeJob(failing);
    const outcomes: string[] = [];
    for (let run = 0; run < SOCIAL_JOB_SKIP_AFTER_FAILURES; run++) outcomes.push(await job.run(new Date(at(0))));
    expect(outcomes).toEqual(['failed', 'failed', 'failed']);
    expect(attempts).toBe(3);
    expect(await failureRow('rank_tape')).toEqual({ day: dayAt(0), failures: 3 });

    // The fourth run of the day does not try again and writes nothing.
    const before = await plain.reputation.getJobState(socialFailureCursor('rank_tape'));
    expect(await job.run(new Date(at(0, '21:30:00.000Z')))).toBe('idle');
    expect(await job.run(new Date(at(0, '23:55:00.000Z')))).toBe('idle');
    expect(attempts).toBe(3);
    expect(await plain.reputation.getJobState(socialFailureCursor('rank_tape'))).toBe(before);
    expect(world.logs.some((l) => l.event === 'social_job_skipped' && l.data?.job === 'rank_tape')).toBe(true);

    // The next UTC day it runs again, and its count starts again.
    expect(await job.run(new Date(at(1, '00:05:00.000Z')))).toBe('failed');
    expect(attempts).toBe(4);
    expect(await failureRow('rank_tape')).toEqual({ day: dayAt(1), failures: 1 });

    // A run that does its work clears the count.
    expect(await createRankTapeJob(world.deps).run(new Date(at(1, '00:10:00.000Z')))).toBe('done');
    expect(await failureRow('rank_tape')).toEqual({ day: dayAt(1), failures: 0 });
    expect(await plain.social.countTapeDays(SEASON_1.id, 'open')).toBe(1);
  });
});

describe('a war-day whose write failed', () => {
  const D1 = '2026-10-12';
  const D2 = '2026-10-13';
  const GOOD = decisionJson({ NVDA: 20, MSFT: 20 }, 'Holds two large companies in equal parts.');
  const ok = (neurons: number | null = 12): ModelResponse => ({
    ok: true,
    text: GOOD,
    inputTokens: 1_500,
    outputTokens: 60,
    neurons,
  });
  const script: ModelScript = { [LLAMA]: () => ok(), [GEMMA]: () => ok(), [GPT_OSS]: () => ok(null) };
  const count = async (table: string): Promise<number> =>
    ((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()) as { n: number }).n;

  beforeEach(async () => {
    await resetDb([{ season: SEASON_1, method: null }]);
  });

  it('is marked missed, and the models are not asked again', async () => {
    await createWar(plain);
    await dailyTick(plain, D1);
    const models = warWorld(script);
    const world = jobDeps(plain, { now: `${D1}T15:30:00.000Z`, war: models.deps });
    const failing: SocialJobDeps = {
      ...world.deps,
      social: {
        ...plain.social,
        writeWarDay: async () => {
          throw new Error('the war batch failed');
        },
      },
    };
    expect(await createModelWarJob(failing).run(new Date(`${D1}T15:30:00.000Z`))).toBe('failed');
    expect(models.calls).toHaveLength(3);
    expect(await count('war_rows')).toBe(0);

    // The next run finds the war-day recorded without its rows: missed, and nobody is asked.
    const job = createModelWarJob(world.deps);
    expect(await job.run(new Date(`${D1}T15:35:00.000Z`))).toBe('done');
    expect(models.calls).toHaveLength(3);
    expect(world.logs.some((l) => l.event === 'war_day_missed')).toBe(true);
    expect(await job.run(new Date(`${D1}T15:40:00.000Z`))).toBe('idle');
    expect(await job.run(new Date(`${D1}T20:00:00.000Z`))).toBe('idle');
    expect(models.calls).toHaveLength(3);
    expect(await count('war_rows')).toBe(0);
    expect((await plain.social.listWarEntrants(WAR_ID)).map((e) => e.days)).toEqual([0, 0, 0]);

    // The next day is a war-day as usual.
    await dailyTick(plain, D2);
    expect(await job.run(new Date(`${D2}T15:30:00.000Z`))).toBe('done');
    expect(models.calls).toHaveLength(6);
    expect(await count('war_rows')).toBe(3);
    expect((await plain.social.listWarEntrants(WAR_ID)).map((e) => e.days)).toEqual([1, 1, 1]);
  });
});
