import type { RoomPruneJobDeps, SocialJob } from '@prix/contracts';
import { ROOM_KEEP, ROOM_PRUNE_PER_RUN } from '@prix/contracts';
import { guardSocialJob, logSafe } from './common.ts';

/**
 * The `room_prune` job (docs/contracts/phase-6-room.md section 7): the seventh and last job of the social
 * step. A run is one statement of the store, `pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)`, which deletes
 * the room's messages beyond the newest ROOM_KEEP. `idle` when it deleted none, `more` when it deleted
 * the whole ROOM_PRUNE_PER_RUN, `done` otherwise. It reads no switch: a room that was switched off still
 * ages out.
 *
 * It sees a count and nothing else, and logs that count only: never a message's text, never an address.
 *
 * It never calls the guard's skip gate. The gate stands between a job's idle check and its first write,
 * and here the one statement is both: a read before it would double what an idle run costs, on each of
 * the step's 288 runs a day. A failure is still counted and logged by the guard, by the error's name
 * only, and after SOCIAL_JOB_SKIP_AFTER_FAILURES failures of a UTC day a failing run answers `idle`.
 */
export function createRoomPruneJob(deps: RoomPruneJobDeps): SocialJob {
  const name = 'room_prune';
  return {
    name,
    run: (now) =>
      guardSocialJob(deps, name, now, async () => {
        const deleted = await deps.room.pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN);
        // Anything but a positive count is nothing deleted: no log line, and the step goes on.
        if (!(deleted > 0)) return 'idle';
        logSafe(deps, 'room_pruned', { deleted });
        return deleted >= ROOM_PRUNE_PER_RUN ? 'more' : 'done';
      }),
  };
}
