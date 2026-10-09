import type { SocialJobDeps } from '@prix/contracts';
import { SOCIAL_JOB_SKIP_AFTER_FAILURES, socialFailureCursor } from '@prix/contracts';
import { createModelWarJob } from '@prix/runtime/social/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, jobDeps, resetDb, SEASON_1, storesOn } from '../../support/d1.ts';

/**
 * Contract 6.1, security review 6, finding 4 (docs/contracts/phase-6-social.md section 4.2): the daily
 * skip of a failing social job also engages for a job that throws before it reaches its skip gate.
 */

const plain = storesOn(db);
const DAY = '2026-10-20';
const at = (time: string) => new Date(`${DAY}T${time}`);

async function failureRow(): Promise<unknown> {
  const body = await plain.reputation.getJobState(socialFailureCursor('model_war'));
  return body === null ? null : JSON.parse(body);
}

beforeEach(async () => {
  await resetDb([{ season: SEASON_1, method: null }]);
});

describe('a job that throws before its skip gate', () => {
  it('is skipped after three failures in a row, writes nothing more, and runs again the next UTC day', async () => {
    const world = jobDeps(plain, { now: `${DAY}T15:30:00.000Z` });
    let attempts = 0;
    const broken: SocialJobDeps = {
      ...world.deps,
      social: Object.assign(Object.create(plain.social) as SocialJobDeps['social'], {
        getOpenWar: async () => {
          attempts += 1;
          throw new Error('the war table is gone');
        },
      }),
    };
    const job = createModelWarJob(broken);
    const outcomes: string[] = [];
    for (let run = 0; run < SOCIAL_JOB_SKIP_AFTER_FAILURES; run++) outcomes.push(await job.run(at('15:30:00.000Z')));
    expect(outcomes).toEqual(['failed', 'failed', 'failed']);
    expect(await failureRow()).toEqual({ day: DAY, failures: 3 });

    const before = await plain.reputation.getJobState(socialFailureCursor('model_war'));
    expect(await job.run(at('15:35:00.000Z'))).toBe('idle');
    expect(await job.run(at('23:55:00.000Z'))).toBe('idle');
    // The count is not written again, and the step is told nothing failed.
    expect(await plain.reputation.getJobState(socialFailureCursor('model_war'))).toBe(before);
    expect(world.logs.filter((l) => l.event === 'social_job_failed')).toHaveLength(3);
    expect(world.logs.some((l) => l.event === 'social_job_skipped' && l.data?.job === 'model_war')).toBe(true);

    // The next UTC day it fails and counts again from one.
    const next = new Date(Date.parse(`${DAY}T00:05:00.000Z`) + 86_400_000);
    expect(await job.run(next)).toBe('failed');
    expect(await failureRow()).toEqual({ day: next.toISOString().slice(0, 10), failures: 1 });
    expect(attempts).toBeGreaterThanOrEqual(6);
  });
});
