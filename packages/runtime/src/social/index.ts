/**
 * Phase 6 scheduled work (docs/contracts/phase-6-social.md section 4.2), imported as
 * `@prix/runtime/social/index`. The Worker builds the five jobs from `SocialJobDeps` and runs them in
 * this order: model_war, rank_tape, rivalry_match, strategy_dna, manager_value. They run whatever
 * SOCIAL_ENABLED says.
 */
export { createStrategyDnaJob } from './dna-job.ts';
export { createManagerValueJob } from './manager-job.ts';
export { createRivalryMatchJob } from './rivalry-job.ts';
export { runSocialStep } from './step.ts';
export { createRankTapeJob } from './tape-job.ts';
export { createModelWarJob } from './war-job.ts';
