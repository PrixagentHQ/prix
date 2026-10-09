import { REPUTATION_CRON } from './phase2-reputation.ts';
import { FOLLOW_CRON_DELIVER, type FOLLOW_CRON_EMIT } from './phase3-follow.ts';
import { TOKEN_CRON } from './phase4-token.ts';
import { SOCIAL_CRON } from './phase6-social.ts';

// The schedules of the whole product, in one place. They are run by the alarms of the Durable Object
// Clock, one object per entry (D-073). Every trigger is its own invocation with its own 10 ms of CPU
// and 50 subrequests (docs/CONTRACTS.md section 2); the steps that share a trigger share that budget,
// which is why the plan is fixed here and not left to each phase.
//
// apps/api/src/index.ts keeps one Clock per entry of CRON_PLAN (wrangler.jsonc lists no cron trigger),
// and each alarm runs the steps of its entry in order, each step in its own try and catch.
//
//   "* * * * *"       the Phase 1 scheduler step. Alone, because it spends the model-call budget.
//   "*" + "/2 * * * *"  (even minutes) the Phase 2 reputation step, then the Phase 3 emit step. Both are
//                     idle at the cost of a read or two; the worst runs are about 4 ms and 2 ms of CPU.
//                     At 03:10 UTC the same invocation also calls createDataStore(env.DB).prune(utcDay)
//                     of Phase 5, after the two steps.
//   "1-59/2 * * * *"  (odd minutes) the Phase 3 deliver step. Alone: it sends up to 20 notes.
//   "7,37 * * * *"    the Phase 4 token sweep. Alone: it reads the chain.
//   "3-58/5 * * * *"  the Phase 6 social step: the first of its five jobs that is not idle. Alone: the
//                     war job may make four model calls.

export const CRON_LEAGUE = '* * * * *';

export type CronStep = 'league' | 'reputation' | 'emit' | 'deliver' | 'token' | 'social';

export const CRON_PLAN: Readonly<Record<string, readonly CronStep[]>> = {
  [CRON_LEAGUE]: ['league'],
  [REPUTATION_CRON]: ['reputation', 'emit'],
  [FOLLOW_CRON_DELIVER]: ['deliver'],
  [TOKEN_CRON]: ['token'],
  [SOCIAL_CRON]: ['social'],
};

/** What to put in `triggers.crons` of the Wrangler file. */
export const PRIX_CRONS: readonly string[] = Object.keys(CRON_PLAN);

/**
 * An expression this product does not know runs no step. Since D-073 the schedules are clocks, and a
 * clock left behind by another release (a rollback, a changed expression) must stop, not run the
 * league a second time (Phase 6 security review, finding 1). `Clock.alarm` deletes such a clock.
 */
export function stepsFor(cron: string): readonly CronStep[] {
  // Own entries only: 'toString' or '__proto__' must not reach an inherited member of the object.
  return Object.hasOwn(CRON_PLAN, cron) ? (CRON_PLAN[cron] ?? []) : [];
}

/** The emit step of Phase 3 rides the reputation trigger on purpose; this stops compiling if they drift apart. */
export const EMIT_RIDES_REPUTATION_TRIGGER: typeof FOLLOW_CRON_EMIT extends typeof REPUTATION_CRON ? true : never =
  true;
