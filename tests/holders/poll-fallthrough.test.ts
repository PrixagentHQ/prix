import {
  type Address,
  HOLDER_POLLS,
  type HolderPoll,
  POLL_PURGE_MAX_POLLS,
  POLL_TALLY_LOOKBACK_DAYS,
  type PollResult,
  type PollTallyJobDeps,
  type PollTiersRead,
} from '@prix/contracts';
import { createPollTallyJobFor } from '@prix/runtime/social/poll-tally';
import { describe, expect, it } from 'vitest';

/**
 * F3 inside the job's run (docs/contracts/phase-6-holders.md section 5 step 2 and section 25, qa row (6);
 * revisions 8e and 8f: R8D-SEC-5, R8E-SEC-3, R8E-B4; the readers of 8f: F8F-B3 (ii), R8F-SEC-3). A poll store
 * and a holding reader in memory, several polls of the test's own, the clock fixed.
 */

const BASE = HOLDER_POLLS[0] as HolderPoll;
const DAY = 86_400_000;
/** A run at 12:30 UTC: not the 00:00 to 00:04 run of the expired line, not the first five minutes of the hour. */
const NOW = new Date('2026-11-10T12:30:00.000Z');

function closedAgo(id: string, ms: number): HolderPoll {
  const closes = NOW.getTime() - ms;
  return { ...BASE, id, opensAt: new Date(closes - 5 * DAY).toISOString(), closesAt: new Date(closes).toISOString() };
}

const voter = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;

interface World {
  deps: PollTallyJobDeps;
  lines: { event: string; data?: Record<string, unknown> }[];
  listed: string[];
  written: string[];
  deleted: string[];
  chainReads: number;
}

function world(options: {
  voters: Record<string, number>;
  counted?: string[];
  pollsEnabled: boolean;
  gatingOn?: boolean;
  chainFails?: boolean;
}): World {
  const lines: World['lines'] = [];
  const listed: string[] = [];
  const written: string[] = [];
  const deleted: string[] = [];
  const results = new Set(options.counted ?? []);
  const state = { chainReads: 0 };
  const votesLeft = new Map(Object.entries(options.voters));
  const polls = {
    async listVoters(pollId: string, after: string | null, _before: string, limit: number) {
      listed.push(pollId);
      const n = options.voters[pollId] ?? 0;
      return Array.from({ length: n }, (_, i) => ({ wallet: voter(0x100 + i), option: 'index-core' }))
        .filter((row) => after === null || row.wallet > after)
        .slice(0, limit);
    },
    async getResults(ids: readonly string[]) {
      return ids.filter((id) => results.has(id)).map((pollId) => ({ pollId }) as unknown as PollResult);
    },
    async putResult(result: { pollId: string }) {
      written.push(result.pollId);
      results.add(result.pollId);
      return true;
    },
    async deleteVotes(pollId: string, limit: number) {
      const left = votesLeft.get(pollId) ?? 0;
      const gone = Math.min(left, limit);
      votesLeft.set(pollId, left - gone);
      if (gone > 0) deleted.push(pollId);
      return gone;
    },
    async castCounts() {
      return {};
    },
    async pruneVoters() {
      return 0;
    },
  };
  const holding = {
    async tiersNow(wallets: readonly Address[], atBlock: number | null): Promise<PollTiersRead> {
      state.chainReads += 1;
      if (options.chainFails === true) throw new Error('rpc_unavailable');
      if (options.gatingOn === false) return { gatingOn: false, tiers: wallets.map(() => 0 as const), blockNumber: 0 };
      return { gatingOn: true, tiers: wallets.map(() => 2 as const), blockNumber: atBlock ?? 10_000 };
    },
  };
  const deps = {
    polls,
    holding,
    adminAddresses: [],
    houseOwners: [],
    tallyDelaySeconds: async () => 0,
    social: { async putCursor() {} },
    reputation: {
      async getJobState() {
        return null;
      },
    },
    pollsEnabled: options.pollsEnabled,
    now: () => new Date(NOW.getTime()),
    log: (event: string, data?: Record<string, unknown>) => {
      lines.push({ event, data });
    },
  } as unknown as PollTallyJobDeps;
  const out: World = {
    deps,
    lines,
    listed,
    written,
    deleted,
    get chainReads() {
      return state.chainReads;
    },
  };
  return out;
}

const events = (w: World) => w.lines.map((l) => l.event);

describe('F3: a waiting answer of (a) falls through (R8E-SEC-3)', () => {
  it('a waiting poll with no voter beside a counted poll with votes left: the purge deletes in the same run', async () => {
    const waiting = closedAgo('poll-waiting', 2 * DAY);
    const counted = closedAgo('poll-counted', 3 * DAY);
    const w = world({
      voters: { 'poll-waiting': 0, 'poll-counted': 5 },
      counted: ['poll-counted'],
      pollsEnabled: false,
    });
    const answer = await createPollTallyJobFor(w.deps, [counted, waiting]).run(NOW);
    expect(answer).toBe('more');
    expect(events(w)).toContain('poll_tally_waiting');
    expect(events(w)).toContain('poll_votes_purged');
    expect(w.deleted).toEqual(['poll-counted']);
    expect(w.written).toEqual([]);
    expect(w.chainReads).toBe(0);
  });

  it('with polls switched on, the same poll gets its zero result and the run ends there', async () => {
    const waiting = closedAgo('poll-waiting', 2 * DAY);
    const counted = closedAgo('poll-counted', 3 * DAY);
    const w = world({
      voters: { 'poll-waiting': 0, 'poll-counted': 5 },
      counted: ['poll-counted'],
      pollsEnabled: true,
    });
    const answer = await createPollTallyJobFor(w.deps, [counted, waiting]).run(NOW);
    expect(answer).toBe('done');
    expect(w.written).toEqual(['poll-waiting']);
    expect(w.deleted).toEqual([]);
  });

  it('a waiting poll with no voter beside a later closed poll with voters: the second is tallied in the same run', async () => {
    const first = closedAgo('poll-first', 3 * DAY);
    const second = closedAgo('poll-second', 2 * DAY);
    const w = world({ voters: { 'poll-first': 0, 'poll-second': 3 }, pollsEnabled: false });
    const answer = await createPollTallyJobFor(w.deps, [first, second]).run(NOW);
    expect(answer).toBe('done');
    expect(w.written).toEqual(['poll-second']);
    expect(events(w)).toContain('poll_tally_waiting');
    expect(events(w)).toContain('poll_tallied');
  });

  it("F8F-B3 (ii): the later poll's listVoters sets the reached-reads flag again, so a failed read still ends the step", async () => {
    const first = closedAgo('poll-first', 3 * DAY);
    const second = closedAgo('poll-second', 2 * DAY);
    const w = world({ voters: { 'poll-first': 0, 'poll-second': 3 }, pollsEnabled: false, chainFails: true });
    const answer = await createPollTallyJobFor(w.deps, [first, second]).run(NOW);
    expect(answer).toBe('done');
    expect(w.written).toEqual([]);
    expect(w.lines.find((l) => l.event === 'poll_tally_failed')?.data).toMatchObject({
      poll: 'poll-second',
      step: 'read',
    });
  });

  it('a waiting poll alone answers idle to the step (the room jobs behind it run)', async () => {
    const only = closedAgo('poll-only', 2 * DAY);
    const w = world({ voters: { 'poll-only': 0 }, pollsEnabled: false });
    expect(await createPollTallyJobFor(w.deps, [only]).run(NOW)).toBe('idle');
    expect(w.chainReads).toBe(0);
    expect(events(w)).toEqual(['poll_tally_waiting']);
  });
});

describe("R8E-B4: F3's waiting is told from gating's by the run's chain read", () => {
  it('polls off, voters on the first page, gating off: the tally waits after its chain read and the step gets done', async () => {
    const closed = closedAgo('poll-gated', 2 * DAY);
    const w = world({ voters: { 'poll-gated': 4 }, pollsEnabled: false, gatingOn: false });
    const answer = await createPollTallyJobFor(w.deps, [closed]).run(NOW);
    expect(answer).toBe('done');
    expect(w.chainReads).toBeGreaterThan(0);
    expect(w.written).toEqual([]);
    expect(events(w)).toContain('poll_tally_waiting');
  });
});

describe('the purge bound (revision 8, R8-4)', () => {
  it(`tries at most POLL_PURGE_MAX_POLLS (${POLL_PURGE_MAX_POLLS}) counted polls a run, oldest first`, async () => {
    const counted = [1, 2, 3, 4].map((n) => closedAgo(`poll-${n}`, (20 - n) * DAY));
    const tried: string[] = [];
    const w = world({
      voters: { 'poll-1': 0, 'poll-2': 0, 'poll-3': 0, 'poll-4': 9 },
      counted: counted.map((p) => p.id),
      pollsEnabled: true,
    });
    const deleteVotes = w.deps.polls.deleteVotes.bind(w.deps.polls);
    (w.deps.polls as { deleteVotes: typeof deleteVotes }).deleteVotes = async (pollId, limit) => {
      tried.push(pollId);
      return deleteVotes(pollId, limit);
    };
    expect(await createPollTallyJobFor(w.deps, counted).run(NOW)).toBe('idle');
    expect(tried).toEqual(['poll-1', 'poll-2', 'poll-3']);
    expect(w.deleted).toEqual([]);
  });
});

describe('R8F-SEC-3: the fall-through never tallies a poll past its lookback', () => {
  it('a waiting poll beside a poll past its lookback that has voters: nothing is listed, read or written for it', async () => {
    const waiting = closedAgo('poll-waiting', 2 * DAY);
    const old = closedAgo('poll-old', (POLL_TALLY_LOOKBACK_DAYS + 1) * DAY);
    const w = world({ voters: { 'poll-waiting': 0, 'poll-old': 7 }, pollsEnabled: false });
    const answer = await createPollTallyJobFor(w.deps, [old, waiting]).run(NOW);
    expect(answer).toBe('idle');
    expect(w.listed).not.toContain('poll-old');
    expect(w.written).toEqual([]);
    expect(w.chainReads).toBe(0);
    expect(w.lines.filter((l) => l.data?.poll === 'poll-old')).toEqual([]);
  });

  it('in the 00:00 to 00:04 run the poll past its lookback gets only (b)’s expired line, after the waiting poll falls through', async () => {
    const at = new Date('2026-11-10T00:02:00.000Z');
    const closed = (id: string, ms: number): HolderPoll => {
      const closes = at.getTime() - ms;
      return {
        ...BASE,
        id,
        opensAt: new Date(closes - 5 * DAY).toISOString(),
        closesAt: new Date(closes).toISOString(),
      };
    };
    const waiting = closed('poll-waiting', 2 * DAY);
    const old = closed('poll-old', (POLL_TALLY_LOOKBACK_DAYS + 1) * DAY);
    const w = world({ voters: { 'poll-waiting': 0, 'poll-old': 7 }, pollsEnabled: false });
    w.deps.now = () => new Date(at.getTime());
    const answer = await createPollTallyJobFor(w.deps, [old, waiting]).run(at);
    expect(answer).toBe('idle');
    expect(w.listed).toEqual(['poll-waiting']);
    expect(w.written).toEqual([]);
    expect(w.chainReads).toBe(0);
    expect(w.lines.filter((l) => l.data?.poll === 'poll-old').map((l) => l.event)).toEqual(['poll_tally_expired']);
  });
});

describe("F8F-B3 (i): only F3's waiting falls through; gating's, after a chain read, ends the run", () => {
  it('gating off beside a later closed poll with voters: the first waits after its chain read, the second is not read, done', async () => {
    const first = closedAgo('poll-gated', 3 * DAY);
    const second = closedAgo('poll-later', 2 * DAY);
    const w = world({ voters: { 'poll-gated': 4, 'poll-later': 3 }, pollsEnabled: false, gatingOn: false });
    const answer = await createPollTallyJobFor(w.deps, [first, second]).run(NOW);
    expect(answer).toBe('done');
    expect(w.chainReads).toBe(1);
    expect(w.listed).not.toContain('poll-later');
    expect(w.written).toEqual([]);
    expect(w.lines.filter((l) => l.event === 'poll_tally_waiting').map((l) => l.data?.poll)).toEqual(['poll-gated']);
  });
});
