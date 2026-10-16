/**
 * Phase 6 scheduled work (docs/contracts/phase-6-social.md section 4.2), imported as
 * `@prix/runtime/social/index`. The Worker builds the five jobs from `SocialJobDeps` and runs them in
 * this order: model_war, rank_tape, rivalry_match, strategy_dna, manager_value. They run whatever
 * SOCIAL_ENABLED says.
 *
 * Phase 6.3 adds `room_prune` (docs/contracts/phase-6-room.md section 7), built from `RoomPruneJobDeps`:
 * the last job of the list, and it runs whatever ROOM_ENABLED says.
 *
 * Phase 6.4 adds `room_picture_sweep` (docs/contracts/phase-6-pictures.md section 9), built from
 * `RoomPictureSweepJobDeps`: it stands before `room_prune`, which stays last, and it runs whatever the
 * switches say.
 *
 * Phase 6.7 adds `poll_tally` (docs/contracts/phase-6-holders.md section 5), built from `PollTallyJobDeps`:
 * it stands before `room_picture_sweep`, `room_prune` stays last, and it runs whatever POLLS_ENABLED says.
 * `tallyPoll` is the same path for the admin route `POST /api/admin/polls/:id/tally`. The holding reader is
 * `createPollHoldingReader` of `@prix/runtime/token/poll-holding` (and of `@prix/runtime`).
 *
 * Phase 6.8 adds `holders_lounge_sweep` (docs/contracts/phase-6-holders-2.md section 4.6), built from
 * `LoungeSweepJobDeps`: it stands before `room_picture_sweep` (after the first holders wave's `poll_tally`
 * once both waves are merged), and `room_prune` stays last. The entry reads `createLoungeSweepJob` and the
 * lounge's Telegram port, `createTelegramLoungePort`, by name from this module's namespace.
 */
export { createTelegramLoungePort } from '../holders/lounge-telegram.ts';
export { createStrategyDnaJob } from './dna-job.ts';
export { createLoungeSweepJob } from './lounge-sweep.ts';
export { createManagerValueJob } from './manager-job.ts';
export { createPollTallyJob, tallyPoll } from './poll-tally.ts';
export { createRivalryMatchJob } from './rivalry-job.ts';
export { createRoomPictureSweepJob } from './room-picture-sweep.ts';
export { createRoomPruneJob } from './room-prune.ts';
export { runSocialStep } from './step.ts';
export { createRankTapeJob } from './tape-job.ts';
export { createModelWarJob } from './war-job.ts';
