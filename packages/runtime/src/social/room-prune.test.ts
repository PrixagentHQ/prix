import type { RoomPruneJobDeps, RoomStore } from '@prix/contracts';
import { ROOM_KEEP, ROOM_PRUNE_PER_RUN, SOCIAL_JOB_SKIP_AFTER_FAILURES, socialFailureCursor } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createRoomPruneJob } from './room-prune.ts';

/**
 * The `room_prune` job against the rules of docs/contracts/phase-6-room.md section 7 and of
 * `RoomPruneJobDeps`: its name, one `pruneMessages(ROOM_KEEP, ROOM_PRUNE_PER_RUN)` a run, its three
 * outcomes, a count as its only log, and a failure that never leaves the job.
 *
 * Run it with `pnpm --filter @prix/runtime test`: the root config collects `tests/**` only.
 */

const NOW = new Date('2026-10-10T12:03:00.000Z');
const TODAY = '2026-10-10';

/** What a message could leak: a whole address and a text. Neither may reach a log line. */
const ADDRESS = '0x1111111111111111111111111111111111111111';
const TEXT = 'a line somebody typed into the chat';

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

/** A room of `count` messages with the ids 1 to `count`, pruned as the store's contract says. */
function roomOf(count: number) {
  let lowest = 1;
  const newest = count;
  const calls: [number, number][] = [];
  const room = only<RoomStore>('room', {
    async pruneMessages(keep, limit) {
      calls.push([keep, limit]);
      const edge = newest - keep;
      const deleted = Math.max(0, Math.min(limit, edge - lowest + 1));
      lowest += deleted;
      return deleted;
    },
  });
  return { room, calls, left: () => newest - lowest + 1 };
}

function harness(room: RoomStore, failuresToday: number | null = null) {
  const lines: LogLine[] = [];
  const cursors: { name: string; body: string }[] = [];
  const stateReads: string[] = [];
  const deps: RoomPruneJobDeps = {
    room,
    social: only<RoomPruneJobDeps['social']>('social', {
      async putCursor(cursor) {
        cursors.push({ name: cursor.name, body: cursor.body });
      },
    }),
    reputation: only<RoomPruneJobDeps['reputation']>('reputation', {
      async getJobState(name) {
        stateReads.push(name);
        return failuresToday === null ? null : JSON.stringify({ day: TODAY, failures: failuresToday });
      },
    }),
    now: () => NOW,
    log: (event, data) => {
      lines.push({ event, data });
    },
  };
  return { deps, lines, cursors, stateReads };
}

const throwing = (): RoomStore =>
  only<RoomStore>('room', {
    async pruneMessages() {
      throw new Error(`D1 failed near ${ADDRESS}: ${TEXT}`);
    },
  });

describe('the room_prune job', () => {
  it('is named room_prune', () => {
    const { deps } = harness(roomOf(0).room);
    expect(createRoomPruneJob(deps).name).toBe('room_prune');
  });

  it('asks the store once a run, with ROOM_KEEP and ROOM_PRUNE_PER_RUN', async () => {
    const { room, calls } = roomOf(ROOM_KEEP + 3);
    const { deps } = harness(room);
    await createRoomPruneJob(deps).run(NOW);
    expect(calls).toEqual([[ROOM_KEEP, ROOM_PRUNE_PER_RUN]]);
  });

  it('is idle when nothing was deleted, and then logs and writes nothing', async () => {
    const { room, calls } = roomOf(ROOM_KEEP);
    const { deps, lines, cursors, stateReads } = harness(room);
    expect(await createRoomPruneJob(deps).run(NOW)).toBe('idle');
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([]);
    expect(cursors).toEqual([]);
    // One statement a run: an idle run reads nothing beside it.
    expect(stateReads).toEqual([]);
  });

  it('answers done when it deleted fewer than ROOM_PRUNE_PER_RUN', async () => {
    const { room, left } = roomOf(ROOM_KEEP + 1);
    const { deps } = harness(room);
    expect(await createRoomPruneJob(deps).run(NOW)).toBe('done');
    expect(left()).toBe(ROOM_KEEP);
  });

  it('answers more when it deleted ROOM_PRUNE_PER_RUN', async () => {
    const { room, left } = roomOf(ROOM_KEEP + ROOM_PRUNE_PER_RUN);
    const { deps } = harness(room);
    expect(await createRoomPruneJob(deps).run(NOW)).toBe('more');
    expect(left()).toBe(ROOM_KEEP);
  });

  it('works a long room down over several runs, then is idle', async () => {
    const { room, calls, left } = roomOf(ROOM_KEEP + ROOM_PRUNE_PER_RUN + 5);
    const { deps } = harness(room);
    const job = createRoomPruneJob(deps);
    expect([await job.run(NOW), await job.run(NOW), await job.run(NOW)]).toEqual(['more', 'done', 'idle']);
    expect(calls).toHaveLength(3);
    expect(left()).toBe(ROOM_KEEP);
  });

  it('logs the count it deleted and nothing else', async () => {
    const { room } = roomOf(ROOM_KEEP + 7);
    const { deps, lines } = harness(room);
    await createRoomPruneJob(deps).run(NOW);
    expect(lines).toHaveLength(1);
    const values = Object.values(lines[0]?.data ?? {});
    expect(values).toContain(7);
    for (const value of values) expect(typeof value).toBe('number');
  });

  it('never throws: a store that fails is a failed run, logged by the error name only', async () => {
    const { deps, lines, cursors } = harness(throwing());
    expect(await createRoomPruneJob(deps).run(NOW)).toBe('failed');
    expect(lines.map((line) => line.event)).toEqual(['social_job_failed']);
    expect(lines[0]?.data).toEqual({ job: 'room_prune', error: 'Error' });
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(ADDRESS);
    expect(logged).not.toContain(TEXT);
    // The guard counts the failure in the job's own row.
    expect(cursors).toEqual([
      { name: socialFailureCursor('room_prune'), body: JSON.stringify({ day: TODAY, failures: 1 }) },
    ]);
  });

  it('is under the guard: after SOCIAL_JOB_SKIP_AFTER_FAILURES failures of the day a failing run is idle and writes nothing', async () => {
    const { deps, lines, cursors } = harness(throwing(), SOCIAL_JOB_SKIP_AFTER_FAILURES);
    expect(await createRoomPruneJob(deps).run(NOW)).toBe('idle');
    expect(cursors).toEqual([]);
    expect(lines.map((line) => line.event)).not.toContain('social_job_failed');
    expect(JSON.stringify(lines)).not.toContain(TEXT);
  });

  it('does not let a broken log sink break a run', async () => {
    const { room } = roomOf(ROOM_KEEP + 2);
    const { deps } = harness(room);
    const job = createRoomPruneJob({
      ...deps,
      log: () => {
        throw new Error('the log sink is gone');
      },
    });
    expect(await job.run(NOW)).toBe('done');
  });
});
