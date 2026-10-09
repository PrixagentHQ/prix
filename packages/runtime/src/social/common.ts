import type { SocialJobDeps, SocialJobName, SocialJobOutcome, UtcDay } from '@prix/contracts';
import { SOCIAL_JOB_SKIP_AFTER_FAILURES, socialFailureCursor } from '@prix/contracts';

/**
 * What every Phase 6 job shares: the guard that keeps a job from throwing, a log that cannot break
 * a run, cursor bodies read without trust, and UTC day arithmetic.
 */

export type LogData = Record<string, string | number | boolean | null>;

const DAY_MS = 86_400_000;

/** A log line that never breaks a run. Never pass a key, a prompt or model output. */
export function logSafe(deps: Pick<SocialJobDeps, 'log'>, event: string, data?: LogData): void {
  try {
    deps.log(event, data);
  } catch {
    // A broken log sink must not break a job.
  }
}

/** The name of an error and nothing else: a message can carry text that does not belong in a log. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Called by a job once its idle checks have found work, before its first write or model call. True when
 * the job failed SOCIAL_JOB_SKIP_AFTER_FAILURES runs in a row today: the run then answers `idle` and
 * writes nothing. One read of the job's failure row; an idle run never calls it, so an idle check keeps
 * its two reads.
 */
export type SkipGate = () => Promise<boolean>;

interface FailureCount {
  day: UtcDay;
  failures: number;
}

/** The failures of `today` in a failure row; a row of another day counts as none. */
function failuresToday(body: string | null, today: UtcDay): number {
  const raw = parseBody(body);
  const failures = raw.failures;
  if (dayField(raw.day) !== today || typeof failures !== 'number' || !Number.isSafeInteger(failures)) return 0;
  return Math.max(0, failures);
}

/**
 * A job never throws (docs/contracts/phase-6-social.md section 4.2, security review 6, finding 4). A
 * failure is logged as `social_job_failed` with the job name and the error's name only, counted by one
 * upsert of the job_state row `socialFailureCursor(job)`, and answers `failed`, so the step goes on to the
 * next job. A job that failed SOCIAL_JOB_SKIP_AFTER_FAILURES runs in a row today is skipped by its gate
 * until the next UTC day, and so is a job that throws before it reaches its gate: such a run answers
 * `idle` and writes nothing once today's count is reached. A run that does work clears the count.
 */
export async function guardSocialJob(
  deps: Pick<SocialJobDeps, 'log' | 'social' | 'reputation'>,
  job: SocialJobName,
  now: Date,
  run: (skip: SkipGate) => Promise<SocialJobOutcome>,
): Promise<SocialJobOutcome> {
  const name = socialFailureCursor(job);
  const today = utcDayOf(now);
  const nowIso = now.toISOString();
  /** The failures of today as the gate read them; null while the gate has not run. */
  let known: number | null = null;

  const putCount = (count: FailureCount): Promise<void> =>
    deps.social.putCursor({ name, body: JSON.stringify(count) }, nowIso);

  const skip: SkipGate = async () => {
    known = failuresToday(await deps.reputation.getJobState(name), today);
    if (known < SOCIAL_JOB_SKIP_AFTER_FAILURES) return false;
    logSafe(deps, 'social_job_skipped', { job, failures: known });
    return true;
  };

  let outcome: SocialJobOutcome;
  try {
    outcome = await run(skip);
  } catch (error) {
    let logged = false;
    try {
      const reachedGate = known !== null;
      const before = known ?? failuresToday(await deps.reputation.getJobState(name), today);
      // A job that throws before its gate is skipped here instead (contract 6.1): once it failed
      // SOCIAL_JOB_SKIP_AFTER_FAILURES runs in a row today, a run answers `idle` and writes nothing,
      // as a run stopped by the gate does. The read is the one the count needs anyway.
      if (!reachedGate && before >= SOCIAL_JOB_SKIP_AFTER_FAILURES) {
        logSafe(deps, 'social_job_skipped', { job, failures: before });
        return 'idle';
      }
      logSafe(deps, 'social_job_failed', { job, error: errorName(error) });
      logged = true;
      await putCount({ day: today, failures: before + 1 });
    } catch (countError) {
      if (!logged) logSafe(deps, 'social_job_failed', { job, error: errorName(error) });
      // The database that failed the job may fail the count too; the job still answers failed.
      logSafe(deps, 'social_job_failure_count_failed', { job, error: errorName(countError) });
    }
    return 'failed';
  }
  if (outcome !== 'idle' && known !== null && known > 0) {
    try {
      await putCount({ day: today, failures: 0 });
    } catch (countError) {
      logSafe(deps, 'social_job_failure_count_failed', { job, error: errorName(countError) });
    }
  }
  return outcome;
}

/** A cursor body as stored: any field may be missing or wrong, so every reader checks what it uses. */
export function parseBody(body: string | null): Record<string, unknown> {
  if (body === null) return {};
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A UTC day read from a cursor, or null when it is not one. */
export function dayField(value: unknown): UtcDay | null {
  return typeof value === 'string' && DAY_PATTERN.test(value) ? value : null;
}

/** An id read from a cursor, or null. */
export function idField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

export function utcDayOf(date: Date | string): UtcDay {
  return (typeof date === 'string' ? date : date.toISOString()).slice(0, 10);
}

/** The UTC day `days` days after `day` (before it when negative). */
export function addDays(day: UtcDay, days: number): UtcDay {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
