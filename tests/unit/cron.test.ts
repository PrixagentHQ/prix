import { CRON_LEAGUE, CRON_PLAN, PRIX_CRONS, SOCIAL_CRON, stepsFor } from '@prix/contracts';
import { describe, expect, it } from 'vitest';

/**
 * `stepsFor` (packages/contracts/src/cron.ts). A clock left behind by another release, after a
 * rollback or a changed expression, must run no step: before, an unknown expression ran the
 * league step, so an old clock ran the league a second time (Phase 6 security review, finding 1).
 */
describe('stepsFor', () => {
  it('gives each known expression its plan, in order', () => {
    expect(stepsFor('* * * * *')).toEqual(['league']);
    expect(stepsFor('*/2 * * * *')).toEqual(['reputation', 'emit']);
    expect(stepsFor('1-59/2 * * * *')).toEqual(['deliver']);
    expect(stepsFor('7,37 * * * *')).toEqual(['token']);
    expect(stepsFor(SOCIAL_CRON)).toEqual(['social']);
    expect(stepsFor(CRON_LEAGUE)).toEqual(['league']);
    for (const cron of PRIX_CRONS) expect(stepsFor(cron)).toEqual(CRON_PLAN[cron]);
  });

  it('gives no step for an expression the plan does not name', () => {
    // A clock of some other release: close to the fifth clock of Phase 6, but not it.
    expect(stepsFor('4-59/5 * * * *')).toEqual([]);
    expect(stepsFor('')).toEqual([]);
    expect(stepsFor('*/5 * * * *')).toEqual([]);
    expect(stepsFor(' * * * * *')).toEqual([]);
  });
});
