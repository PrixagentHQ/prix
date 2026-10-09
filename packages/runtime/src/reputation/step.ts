import type { RunReputationStep } from '@prix/contracts';

/**
 * Phase 2 scheduled step: runs the jobs in the given order and returns after the first that is not
 * idle. Never throws. A job that throws ends the step; it is logged with its name only.
 */
export const runReputationStep: RunReputationStep = async (jobs, now) => {
  for (const job of jobs) {
    try {
      const outcome = await job.run(now);
      if (outcome !== 'idle') return { ran: job.name, outcome };
    } catch {
      console.warn(JSON.stringify({ event: 'reputation_job_failed', job: job.name }));
      return { ran: job.name, outcome: 'idle' };
    }
  }
  return { ran: null, outcome: 'idle' };
};
