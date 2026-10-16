import type { CreateRoomPictureSweepJob } from '@prix/contracts';
import { ROOM_PICTURE_LOG_EVENTS, ROOM_PICTURE_SWEEP_JOB, ROOM_PICTURE_SWEEP_PER_RUN } from '@prix/contracts';
import { guardSocialJob, logSafe } from './common.ts';

/**
 * The `room_picture_sweep` job (docs/contracts/phase-6-pictures.md section 9, and the comment at
 * `RoomPictureSweepJobDeps`): it deletes the bytes Prix still owes a delete, the pictures a hide or a mute
 * removed in D1 while KV's delete threw. D1 refuses those pictures already; this only takes their bytes
 * away before their seven days do. In the entry's list of jobs it stands before `room_prune`, which stays
 * last. It reads no switch: a removal is owed whatever the switches say.
 *
 * A run:
 * 1. one `listOwedDeletes(ROOM_PICTURE_SWEEP_PER_RUN)`, newest first. `idle` when that is empty: an idle
 *    run is that one statement and reads nothing more, on each of the step's runs of a day;
 * 2. the guard's skip gate, after the list and before the first delete: one read of the job's failure
 *    row, and `idle` with nothing deleted once the job failed SOCIAL_JOB_SKIP_AFTER_FAILURES runs in a
 *    row today;
 * 3. `bytes.delete` for each key, one after another, stopping at the first that throws. A failed run has
 *    spent one failing delete, so the bound is one failing delete a run, not a figure of the day;
 * 4. one `markGone` for those that answered, when there are any, at the run's own time;
 * 5. `more` when it found ROOM_PICTURE_SWEEP_PER_RUN and every delete answered, `done` when it found
 *    fewer; when a delete threw, what it threw is thrown again after the mark, so that the guard counts a
 *    failure and the step goes on to the next job.
 *
 * Every step can run twice. KV answers a delete of a key it no longer has as a delete, and `markGone` of
 * a key that is gone changes nothing: a run whose mark failed leaves the same pictures owed, and the next
 * run deletes and marks them again.
 *
 * The price of the order (the contract says it, revision 3): the list is newest first and the run stops
 * at the first delete that throws, so a key whose delete always throws holds back every older owed
 * delete. The seven days bound it.
 *
 * It sees ids and keys and logs neither: one line, `room_pictures_swept`, with the count it settled, after
 * the mark answered. A failure is logged by the guard, by the error's name only: the message of an error
 * KV threw may name a key.
 */
export const createRoomPictureSweepJob: CreateRoomPictureSweepJob = (deps) => ({
  name: ROOM_PICTURE_SWEEP_JOB,
  run: (now) =>
    guardSocialJob(deps, ROOM_PICTURE_SWEEP_JOB, now, async (skip) => {
      const listed = await deps.pictures.listOwedDeletes(ROOM_PICTURE_SWEEP_PER_RUN);
      if (listed.length === 0) return 'idle';
      if (await skip()) return 'idle';

      // A run never tries more than its share of the day's KV deletes, whatever the store answered.
      const owed = listed.slice(0, ROOM_PICTURE_SWEEP_PER_RUN);
      const answered: number[] = [];
      let failure: { error: unknown } | null = null;
      for (const picture of owed) {
        try {
          await deps.bytes.delete(picture.key);
        } catch (error) {
          failure = { error };
          break;
        }
        answered.push(picture.id);
      }

      if (answered.length > 0) {
        await deps.pictures.markGone(answered, now.toISOString());
        logSafe(deps, ROOM_PICTURE_LOG_EVENTS.swept, { deleted: answered.length });
      }
      if (failure !== null) throw failure.error;
      return listed.length >= ROOM_PICTURE_SWEEP_PER_RUN ? 'more' : 'done';
    }),
});
