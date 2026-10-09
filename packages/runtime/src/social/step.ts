import type { RunSocialStep, SocialJobName } from '@prix/contracts';

/**
 * Phase 6 scheduled step (docs/contracts/phase-6-social.md section 4.2): runs the jobs in the given
 * order and returns after the first that answers `more` or `done`. A job that answers `failed` does not
 * end the step: the next job runs, so one broken job never stops the others (security review 6,
 * finding 4). Never throws: a job that throws anyway counts as `failed`, logged with its name only.
 * When no job did work, the step answers the first failure, or `idle`.
 */
export const runSocialStep: RunSocialStep = async (jobs, now) => {
  let failed: SocialJobName | null = null;
  for (const job of jobs) {
    let outcome: Awaited<ReturnType<typeof job.run>>;
    try {
      outcome = await job.run(now);
    } catch {
      console.warn(JSON.stringify({ event: 'social_job_failed', job: job.name }));
      outcome = 'failed';
    }
    if (outcome === 'more' || outcome === 'done') return { ran: job.name, outcome };
    if (outcome === 'failed' && failed === null) failed = job.name;
  }
  return failed === null ? { ran: null, outcome: 'idle' } : { ran: failed, outcome: 'failed' };
};
