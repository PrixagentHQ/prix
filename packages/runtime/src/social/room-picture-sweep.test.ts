import type { RoomPictureSweepJobDeps } from '@prix/contracts';
import {
  ROOM_PICTURE_DELETES_PER_CALL,
  ROOM_PICTURE_LOG_EVENTS,
  ROOM_PICTURE_SWEEP_JOB,
  ROOM_PICTURE_SWEEP_PER_RUN,
  SOCIAL_JOB_SKIP_AFTER_FAILURES,
  socialFailureCursor,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createRoomPictureSweepJob } from './room-picture-sweep.ts';

/**
 * The `room_picture_sweep` job against docs/contracts/phase-6-pictures.md section 9 and the comment at
 * `RoomPictureSweepJobDeps`: its name, one `listOwedDeletes(ROOM_PICTURE_SWEEP_PER_RUN)` a run, the gate
 * between that list and the first delete, the deletes one after another up to the first that throws, one
 * `markGone` for those that answered, its outcomes, a count as its only log, and a failure that never
 * leaves the job.
 *
 * Run it with `pnpm --filter @prix/runtime test`: the root config collects `tests/**` only.
 */

const NOW = new Date('2026-10-11T12:03:00.000Z');
const TODAY = '2026-10-11';
const FAILURES = socialFailureCursor(ROOM_PICTURE_SWEEP_JOB);

interface LogLine {
  event: string;
  data: Record<string, string | number | boolean | null> | undefined;
}

/** A fake that holds the given methods only: any other use throws, so the test sees it as a failed run. */
function only<T extends object>(label: string, methods: Partial<T>): T {
  return new Proxy(methods as T, {
    get(target, key, receiver) {
      if (!(key in target)) throw new Error(`unexpected use of ${label}.${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}

/** A key as the server makes one: `pic/` and 32 hex characters. Never to be seen in a log line. */
const keyOf = (id: number): string => `pic/${id.toString(16).padStart(32, '0')}`;

interface Options {
  /** How many pictures owe a delete: the ids 1 to `owed`. The list answers them newest first. */
  owed?: number;
  /** The ids whose delete throws, each time. */
  broken?: readonly number[];
  /** The failures of today in the job's own row before the first run. */
  failuresToday?: number;
  /** The list ignores its limit, as a store that is wrong would. */
  unbounded?: boolean;
  listThrows?: boolean;
  markThrows?: boolean;
}

/**
 * A store, a KV and a job_state in memory. The store answers as `RoomPictureStore` says: `listOwedDeletes`
 * the pictures that still have a key, newest first, and `markGone` takes the key away. The job_state row
 * is real, so a count the guard wrote is the count the next run's gate reads.
 */
function harness(options: Options = {}) {
  const owed = new Map<number, string>();
  for (let id = 1; id <= (options.owed ?? 0); id += 1) owed.set(id, keyOf(id));
  const broken = new Set(options.broken ?? []);
  const state = new Map<string, string>();
  if (options.failuresToday !== undefined) {
    state.set(FAILURES, JSON.stringify({ day: TODAY, failures: options.failuresToday }));
  }

  /** Every call of a port, in the order it was made. */
  const order: string[] = [];
  const lists: number[] = [];
  const deletes: string[] = [];
  const marks: { ids: number[]; now: string }[] = [];
  const cursors: { name: string; body: string }[] = [];
  const lines: LogLine[] = [];

  const deps: RoomPictureSweepJobDeps = {
    pictures: only<RoomPictureSweepJobDeps['pictures']>('pictures', {
      async listOwedDeletes(limit) {
        order.push('list');
        lists.push(limit);
        if (options.listThrows) throw new Error(`D1 failed near ${keyOf(1)}`);
        const newestFirst = [...owed.entries()].sort(([a], [b]) => b - a).map(([id, key]) => ({ id, key }));
        return options.unbounded ? newestFirst : newestFirst.slice(0, limit);
      },
      async markGone(ids, now) {
        order.push('mark');
        marks.push({ ids: [...ids], now });
        if (options.markThrows) throw new Error(`D1 failed near ${keyOf(1)}`);
        for (const id of ids) owed.delete(id);
      },
    }),
    bytes: only<RoomPictureSweepJobDeps['bytes']>('bytes', {
      async delete(key) {
        order.push('delete');
        deletes.push(key);
        const id = [...owed.entries()].find(([, value]) => value === key)?.[0];
        if (id !== undefined && broken.has(id)) throw new Error(`KV refused the delete of ${key}`);
      },
    }),
    social: only<RoomPictureSweepJobDeps['social']>('social', {
      async putCursor(cursor) {
        order.push('count');
        cursors.push({ name: cursor.name, body: cursor.body });
        state.set(cursor.name, cursor.body);
      },
    }),
    reputation: only<RoomPictureSweepJobDeps['reputation']>('reputation', {
      async getJobState(name) {
        order.push('gate');
        return state.get(name) ?? null;
      },
    }),
    now: () => NOW,
    log: (event, data) => {
      lines.push({ event, data });
    },
  };
  return { deps, order, lists, deletes, marks, cursors, lines, left: () => [...owed.keys()].sort((a, b) => b - a) };
}

/** The ids from `from` down to `to`: the list is newest first. */
const down = (from: number, to: number): number[] => Array.from({ length: from - to + 1 }, (_, index) => from - index);

describe('the room_picture_sweep job', () => {
  it('is named room_picture_sweep', () => {
    expect(createRoomPictureSweepJob(harness().deps).name).toBe('room_picture_sweep');
    expect(ROOM_PICTURE_SWEEP_JOB).toBe('room_picture_sweep');
  });

  it('asks the store once a run, for ROOM_PICTURE_SWEEP_PER_RUN owed deletes', async () => {
    const { deps, lists } = harness({ owed: 3 });
    await createRoomPictureSweepJob(deps).run(NOW);
    expect(lists).toEqual([ROOM_PICTURE_SWEEP_PER_RUN]);
  });

  it('is idle on an empty list, and then reads, deletes, marks, logs and writes nothing more', async () => {
    const { deps, order, lines, cursors } = harness({ owed: 0 });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('idle');
    // One statement a run: an idle run does not read the job's failure row either.
    expect(order).toEqual(['list']);
    expect(lines).toEqual([]);
    expect(cursors).toEqual([]);
  });

  it('answers done when it found fewer than ROOM_PICTURE_SWEEP_PER_RUN and every delete answered', async () => {
    const { deps, deletes, marks, left } = harness({ owed: 3 });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('done');
    expect(deletes).toEqual([keyOf(3), keyOf(2), keyOf(1)]);
    expect(marks).toEqual([{ ids: [3, 2, 1], now: NOW.toISOString() }]);
    expect(left()).toEqual([]);
  });

  it('answers more when it found ROOM_PICTURE_SWEEP_PER_RUN and every delete answered', async () => {
    const { deps, deletes, marks, left } = harness({ owed: ROOM_PICTURE_SWEEP_PER_RUN });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('more');
    expect(deletes).toHaveLength(ROOM_PICTURE_SWEEP_PER_RUN);
    expect(marks).toEqual([{ ids: down(ROOM_PICTURE_SWEEP_PER_RUN, 1), now: NOW.toISOString() }]);
    expect(left()).toEqual([]);
  });

  it('works a long list down over several runs, newest first, then is idle', async () => {
    const { deps, lists, marks, left } = harness({ owed: ROOM_PICTURE_SWEEP_PER_RUN + 3 });
    const job = createRoomPictureSweepJob(deps);
    expect([await job.run(NOW), await job.run(NOW), await job.run(NOW)]).toEqual(['more', 'done', 'idle']);
    expect(lists).toHaveLength(3);
    expect(marks.map((mark) => mark.ids)).toEqual([down(ROOM_PICTURE_SWEEP_PER_RUN + 3, 4), [3, 2, 1]]);
    expect(left()).toEqual([]);
  });

  it('deletes one key after another, and marks in one call after the last delete', async () => {
    const { deps, order } = harness({ owed: 3 });
    await createRoomPictureSweepJob(deps).run(NOW);
    expect(order).toEqual(['list', 'gate', 'delete', 'delete', 'delete', 'mark']);
  });

  it('reads the gate after the list and before the first delete', async () => {
    const { deps, order } = harness({ owed: 1 });
    await createRoomPictureSweepJob(deps).run(NOW);
    expect(order.slice(0, 3)).toEqual(['list', 'gate', 'delete']);
  });

  it('stops at the first delete that throws, marks what answered, and fails the run', async () => {
    // Five owed, newest first 5 4 3 2 1; the delete of 3 throws.
    const { deps, order, deletes, marks, cursors, lines, left } = harness({ owed: 5, broken: [3] });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('failed');
    // 2 and 1 are not tried: a failed run has spent one failing delete.
    expect(deletes).toEqual([keyOf(5), keyOf(4), keyOf(3)]);
    expect(marks).toEqual([{ ids: [5, 4], now: NOW.toISOString() }]);
    expect(left()).toEqual([3, 2, 1]);
    // The failure is thrown after `markGone`, so the guard counts it after the mark.
    expect(order).toEqual(['list', 'gate', 'delete', 'delete', 'delete', 'mark', 'count']);
    expect(cursors).toEqual([{ name: FAILURES, body: JSON.stringify({ day: TODAY, failures: 1 }) }]);
    expect(lines.map((line) => line.event)).toContain('social_job_failed');
    expect(lines.find((line) => line.event === 'social_job_failed')?.data).toEqual({
      job: 'room_picture_sweep',
      error: 'Error',
    });
  });

  it('marks nothing when the first delete throws, as with no KV binding, and fails the run', async () => {
    const { deps, order, deletes, marks, left } = harness({ owed: 4, broken: [4, 3, 2, 1] });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('failed');
    expect(deletes).toEqual([keyOf(4)]);
    expect(marks).toEqual([]);
    expect(order).toEqual(['list', 'gate', 'delete', 'count']);
    expect(left()).toEqual([4, 3, 2, 1]);
  });

  it('is skipped after SOCIAL_JOB_SKIP_AFTER_FAILURES failed runs in a row: one failing delete a run, then none', async () => {
    // The newest key always throws, so it holds back the older ones (the contract's price of the order).
    const { deps, deletes, marks, cursors, lines, left } = harness({ owed: 4, broken: [4] });
    const job = createRoomPictureSweepJob(deps);
    const outcomes: string[] = [];
    for (let run = 0; run < SOCIAL_JOB_SKIP_AFTER_FAILURES; run += 1) outcomes.push(await job.run(NOW));
    expect(outcomes).toEqual(Array.from({ length: SOCIAL_JOB_SKIP_AFTER_FAILURES }, () => 'failed'));
    expect(deletes).toEqual(Array.from({ length: SOCIAL_JOB_SKIP_AFTER_FAILURES }, () => keyOf(4)));
    expect(cursors.at(-1)).toEqual({
      name: FAILURES,
      body: JSON.stringify({ day: TODAY, failures: SOCIAL_JOB_SKIP_AFTER_FAILURES }),
    });

    const before = { deletes: deletes.length, cursors: cursors.length };
    expect(await job.run(NOW)).toBe('idle');
    expect(deletes).toHaveLength(before.deletes);
    expect(cursors).toHaveLength(before.cursors);
    expect(marks).toEqual([]);
    expect(lines.at(-1)).toEqual({
      event: 'social_job_skipped',
      data: { job: 'room_picture_sweep', failures: SOCIAL_JOB_SKIP_AFTER_FAILURES },
    });
    expect(left()).toEqual([4, 3, 2, 1]);
  });

  it('is skipped from a stored count: with the failures of today reached it lists, reads the gate and stops', async () => {
    const { deps, order, lines } = harness({ owed: 2, failuresToday: SOCIAL_JOB_SKIP_AFTER_FAILURES });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('idle');
    expect(order).toEqual(['list', 'gate']);
    expect(lines.map((line) => line.event)).toEqual(['social_job_skipped']);
  });

  it('runs again on the next UTC day after a day of failures', async () => {
    const { deps, deletes } = harness({ owed: 2, failuresToday: SOCIAL_JOB_SKIP_AFTER_FAILURES });
    const tomorrow = new Date('2026-10-12T00:03:00.000Z');
    expect(await createRoomPictureSweepJob(deps).run(tomorrow)).toBe('done');
    expect(deletes).toEqual([keyOf(2), keyOf(1)]);
  });

  it('clears the count of failures with a run that works', async () => {
    const { deps, cursors } = harness({ owed: 2, failuresToday: SOCIAL_JOB_SKIP_AFTER_FAILURES - 1 });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('done');
    expect(cursors).toEqual([{ name: FAILURES, body: JSON.stringify({ day: TODAY, failures: 0 }) }]);
  });

  it('writes no count when a run works and none was owed', async () => {
    const { deps, cursors } = harness({ owed: 2 });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('done');
    expect(cursors).toEqual([]);
  });

  it('logs the count it deleted and nothing else, never a key', async () => {
    const { deps, lines } = harness({ owed: 7 });
    await createRoomPictureSweepJob(deps).run(NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe(ROOM_PICTURE_LOG_EVENTS.swept);
    const values = Object.values(lines[0]?.data ?? {});
    expect(values).toEqual([7]);
    expect(JSON.stringify(lines)).not.toContain('pic/');
  });

  it('logs the count of a run that failed after some deletes answered, and no key of either kind', async () => {
    const { deps, lines } = harness({ owed: 5, broken: [3] });
    await createRoomPictureSweepJob(deps).run(NOW);
    expect(lines.map((line) => line.event)).toEqual([ROOM_PICTURE_LOG_EVENTS.swept, 'social_job_failed']);
    expect(Object.values(lines[0]?.data ?? {})).toEqual([2]);
    // The error KV threw names the key it refused: the name of the error is all that is logged.
    expect(JSON.stringify(lines)).not.toContain('pic/');
  });

  it('logs no swept line when no delete answered', async () => {
    const { deps, lines } = harness({ owed: 2, broken: [2] });
    await createRoomPictureSweepJob(deps).run(NOW);
    expect(lines.map((line) => line.event)).toEqual(['social_job_failed']);
    expect(JSON.stringify(lines)).not.toContain('pic/');
  });

  it('never throws when the list fails: a failed run, logged by the error name only', async () => {
    const { deps, order, lines, cursors } = harness({ owed: 2, listThrows: true });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('failed');
    expect(order).not.toContain('delete');
    expect(lines).toEqual([{ event: 'social_job_failed', data: { job: 'room_picture_sweep', error: 'Error' } }]);
    expect(cursors).toEqual([{ name: FAILURES, body: JSON.stringify({ day: TODAY, failures: 1 }) }]);
  });

  it('is under the guard when the list fails: after the failures of the day such a run is idle and writes nothing', async () => {
    const { deps, lines, cursors } = harness({
      owed: 2,
      listThrows: true,
      failuresToday: SOCIAL_JOB_SKIP_AFTER_FAILURES,
    });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('idle');
    expect(cursors).toEqual([]);
    expect(lines.map((line) => line.event)).not.toContain('social_job_failed');
  });

  it('fails the run when the mark fails, and the same keys are owed and deleted again by the next run', async () => {
    const { deps, deletes, lines, cursors, left } = harness({ owed: 2, markThrows: true });
    const job = createRoomPictureSweepJob(deps);
    expect(await job.run(NOW)).toBe('failed');
    expect(left()).toEqual([2, 1]);
    // Nothing was settled, so nothing is logged as swept.
    expect(lines.map((line) => line.event)).toEqual(['social_job_failed']);
    expect(cursors).toEqual([{ name: FAILURES, body: JSON.stringify({ day: TODAY, failures: 1 }) }]);
    // KV answers a delete of a key it no longer has as a delete: a second run tries the same two.
    await job.run(NOW);
    expect(deletes).toEqual([keyOf(2), keyOf(1), keyOf(2), keyOf(1)]);
  });

  it('never tries more than ROOM_PICTURE_SWEEP_PER_RUN deletes a run, whatever the store answers', async () => {
    const { deps, deletes, marks } = harness({ owed: ROOM_PICTURE_SWEEP_PER_RUN + 5, unbounded: true });
    expect(await createRoomPictureSweepJob(deps).run(NOW)).toBe('more');
    expect(deletes).toHaveLength(ROOM_PICTURE_SWEEP_PER_RUN);
    expect(marks.map((mark) => mark.ids)).toEqual([down(ROOM_PICTURE_SWEEP_PER_RUN + 5, 6)]);
    // `markGone` takes at most ROOM_PICTURE_DELETES_PER_CALL ids: a run's ids always fit.
    expect(ROOM_PICTURE_SWEEP_PER_RUN).toBeLessThanOrEqual(ROOM_PICTURE_DELETES_PER_CALL);
  });

  it('does not let a broken log sink break a run', async () => {
    const { deps, left } = harness({ owed: 2 });
    const job = createRoomPictureSweepJob({
      ...deps,
      log: () => {
        throw new Error('the log sink is gone');
      },
    });
    expect(await job.run(NOW)).toBe('done');
    expect(left()).toEqual([]);
  });
});
