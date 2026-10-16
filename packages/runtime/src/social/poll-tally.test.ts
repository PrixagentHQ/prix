import type {
  Address,
  HolderPoll,
  PollResultRecord,
  PollStore,
  PollTallyJobDeps,
  PollTiersRead,
  PollVoter,
  Tier,
} from '@prix/contracts';
import {
  HOLDER_POLLS,
  POLL_MAX_VOTERS,
  POLL_PRUNE_AT,
  POLL_PURGE_PER_RUN,
  POLL_TALLY_BLOCK_MARGIN,
  POLL_TALLY_FAILED_ERROR,
  POLL_TALLY_MAX_CHAIN_READS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_PAGE,
  SOCIAL_JOB_SKIP_AFTER_FAILURES,
  socialFailureCursor,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { createPollTallyJob, tallyPoll } from './poll-tally.ts';

/**
 * The `poll_tally` job and `tallyPoll` against docs/contracts/phase-6-holders.md section 5 (revision 4): one
 * closed poll counted whole in one run or not at all, every chain read at one block 50 below the first head,
 * the fetch cap, the run's 8 seconds, the delay d, the purge, the prune while open, the expired line, and no
 * address in any log. Run with `pnpm --filter @prix/runtime test`.
 */

const POLL = HOLDER_POLLS[0] as HolderPoll;
const CLOSES = Date.parse(POLL.closesAt);
const D = 1_234;
const DUE = new Date(CLOSES + (60 + D) * 1000);
const HEAD = 89_400_000;
const ADMIN = '0xadadadadadadadadadadadadadadadadadadadad';
const HOUSE = '0x4040404040404040404040404040404040404040';

const wallet = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;
const OPTIONS = POLL.options.map((option) => option.id);

interface LogLine {
  event: string;
  data: Record<string, string | number | boolean | null> | undefined;
}

/** An in-memory PollStore that keeps the rules of section 4.2 and counts statements. */
function storeOf(votes: { wallet: Address; option: string; at?: string }[], results: PollResultRecord[] = []) {
  const rows = new Map<string, { option: string; at: string }>();
  for (const vote of votes) rows.set(vote.wallet, { option: vote.option, at: vote.at ?? '2026-10-17T00:00:00.000Z' });
  const stored = [...results];
  const calls: string[] = [];
  let statements = 0;
  let failList: number | null = null;
  const store: PollStore = {
    async putVote() {
      throw new Error('the tally never votes');
    },
    async getVote() {
      throw new Error('the tally never reads one vote');
    },
    async castCounts() {
      calls.push('castCounts');
      statements += 1;
      const counts: Record<string, number> = {};
      for (const row of rows.values()) counts[row.option] = (counts[row.option] ?? 0) + 1;
      return counts;
    },
    async listVoters(_pollId, after, before, limit) {
      calls.push(`listVoters:${before}`);
      statements += 1;
      if (failList !== null && calls.filter((c) => c.startsWith('listVoters')).length === failList) {
        throw new Error('D1 list failed');
      }
      const page: PollVoter[] = [...rows.entries()]
        .filter(([w, row]) => (after === null || w > after) && row.at < before)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, limit)
        .map(([w, row]) => ({ wallet: w as Address, option: row.option }));
      return page;
    },
    async getResults(pollIds) {
      calls.push('getResults');
      statements += 1;
      return stored.filter((result) => pollIds.includes(result.pollId));
    },
    async putResult(result) {
      calls.push('putResult');
      statements += 4;
      if (stored.some((r) => r.pollId === result.pollId)) return false;
      stored.push(result);
      return true;
    },
    async deleteVotes(_pollId, limit) {
      calls.push('deleteVotes');
      statements += 1;
      const doomed = [...rows.keys()].sort().slice(0, limit);
      for (const w of doomed) rows.delete(w);
      return doomed.length;
    },
    async pruneVoters(_pollId, wallets) {
      calls.push('pruneVoters');
      statements += 2;
      let deleted = 0;
      for (const w of wallets) if (rows.delete(w)) deleted += 1;
      return deleted;
    },
  };
  return {
    store,
    calls,
    results: stored,
    rows,
    statements: () => statements,
    failListAt(n: number) {
      failList = n;
    },
  };
}

interface HoldingOptions {
  gatingOn?: boolean;
  /** The block the n-th call (1-based) answers instead of the asked one. */
  blockAt?: Record<number, number>;
  throwAt?: number;
  /** Fetches each call adds to the run's count; absent, no count is reported. */
  fetchesPerRead?: number;
}

function holdingOf(tiers: (w: Address) => Tier, options: HoldingOptions = {}) {
  const calls: { wallets: readonly Address[]; atBlock: number | null }[] = [];
  let fetches = 0;
  const holding = {
    async tiersNow(wallets: readonly Address[], atBlock: number | null): Promise<PollTiersRead & { fetches?: number }> {
      calls.push({ wallets: [...wallets], atBlock });
      if (atBlock === null) fetches = 0;
      const n = calls.length;
      if (options.throwAt === n) throw new Error(`rpc failed for ${wallets[0] ?? ''}`);
      const blockNumber = options.blockAt?.[n] ?? (atBlock === null ? HEAD : atBlock);
      const read: PollTiersRead = {
        gatingOn: options.gatingOn ?? true,
        tiers: wallets.map((w) => tiers(w)),
        blockNumber,
      };
      if (options.fetchesPerRead === undefined) return read;
      fetches += options.fetchesPerRead;
      return { ...read, fetches };
    },
  };
  return { holding, calls };
}

function harness(
  store: PollStore,
  holding: PollTallyJobDeps['holding'],
  clock: { now: Date; step?: number },
  failuresToday: number | null = null,
) {
  const lines: LogLine[] = [];
  const cursors: { name: string; body: string }[] = [];
  const stateReads: string[] = [];
  const delays: string[] = [];
  let ticks = 0;
  const deps: PollTallyJobDeps = {
    polls: store,
    holding,
    adminAddresses: [ADMIN.toUpperCase().replace('0X', '0x')],
    houseOwners: [HOUSE],
    async tallyDelaySeconds(pollId) {
      delays.push(pollId);
      return D;
    },
    social: {
      async putCursor(cursor) {
        cursors.push({ name: cursor.name, body: cursor.body });
      },
    },
    reputation: {
      async getJobState(name) {
        stateReads.push(name);
        return failuresToday === null
          ? null
          : JSON.stringify({ day: clock.now.toISOString().slice(0, 10), failures: failuresToday });
      },
    },
    now: () => {
      const at = new Date(clock.now.getTime() + ticks * (clock.step ?? 0));
      ticks += 1;
      return at;
    },
    log: (event, data) => {
      lines.push({ event, data });
    },
  };
  return { deps, lines, cursors, stateReads, delays };
}

/** `count` voters spread over the four options, with tiers by `tierOf`. */
function voters(count: number, from = 1): { wallet: Address; option: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    wallet: wallet(from + i),
    option: OPTIONS[i % OPTIONS.length] as string,
  }));
}

function noAddressIn(lines: LogLine[]): void {
  for (const line of lines) {
    expect(JSON.stringify(line)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  }
}

describe('tallyPoll', () => {
  it('answers open before the close + 60 s + d, reading nothing, and tallies at that time', async () => {
    const s = storeOf(voters(8));
    const h = holdingOf(() => 1);
    for (const at of [CLOSES - 1, CLOSES, CLOSES + 59_999, CLOSES + 60_000, DUE.getTime() - 1]) {
      const { deps, delays } = harness(s.store, h.holding, { now: new Date(at) });
      expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'open', step: null });
      // d is not even derived before the settle has passed.
      expect(delays).toEqual(at < CLOSES + 60_000 ? [] : [POLL.id]);
    }
    expect(s.calls).toEqual([]);
    expect(h.calls).toEqual([]);
    const { deps, lines } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'done', step: null });
    for (const line of lines) expect(JSON.stringify(line)).not.toContain(String(D));
  });

  it('counts tiers 1 to 3, casts every voter, and never counts a wallet of Prix own', async () => {
    const tiers: Record<string, Tier> = {};
    const list = [
      { wallet: wallet(1), option: 'big-tech-equal', tier: 0 as Tier },
      { wallet: wallet(2), option: 'big-tech-equal', tier: 1 as Tier },
      { wallet: wallet(3), option: 'index-core', tier: 2 as Tier },
      { wallet: wallet(4), option: 'index-core', tier: 3 as Tier },
      { wallet: wallet(5), option: 'dip-buyer', tier: 3 as Tier },
      { wallet: ADMIN as Address, option: 'momentum-five', tier: 3 as Tier },
      { wallet: HOUSE as Address, option: 'momentum-five', tier: 3 as Tier },
    ];
    for (const v of list) tiers[v.wallet] = v.tier;
    const s = storeOf(list);
    const h = holdingOf((w) => tiers[w] ?? 0);
    const { deps, lines } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'done', step: null });
    expect(s.results).toHaveLength(1);
    const result = s.results[0] as PollResultRecord;
    expect(result.pollId).toBe(POLL.id);
    expect(result.cast).toEqual({ 'big-tech-equal': 2, 'index-core': 2, 'momentum-five': 2, 'dip-buyer': 1 });
    expect(result.counted).toEqual({ 'big-tech-equal': 1, 'index-core': 2, 'momentum-five': 0, 'dip-buyer': 1 });
    expect(result.leaders).toEqual(['index-core']);
    expect(result.firstBlock).toBe(HEAD - POLL_TALLY_BLOCK_MARGIN);
    expect(result.lastBlock).toBe(HEAD - POLL_TALLY_BLOCK_MARGIN);
    expect(result.countedAt).toBe(DUE.toISOString());
    const tallied = lines.find((line) => line.event === 'poll_tallied');
    expect(tallied?.data).toEqual({ poll: POLL.id, voters: 7, counted: 4 });
    noAddressIn(lines);
  });

  it('reads the first page at the head, then every read at the head less 50, and only votes made before the close', async () => {
    const s = storeOf(voters(POLL_TALLY_PAGE + 5));
    const h = holdingOf(() => 1);
    const { deps } = harness(s.store, h.holding, { now: DUE });
    await tallyPoll(deps, POLL);
    expect(h.calls.map((c) => c.atBlock)).toEqual([null, HEAD - 50, HEAD - 50]);
    expect(h.calls[0]?.wallets).toEqual(h.calls[1]?.wallets);
    for (const call of s.calls.filter((c) => c.startsWith('listVoters')))
      expect(call).toBe(`listVoters:${POLL.closesAt}`);
  });

  it('never reads a vote made at or after the close', async () => {
    const s = storeOf([
      { wallet: wallet(1), option: 'dip-buyer' },
      { wallet: wallet(2), option: 'dip-buyer', at: POLL.closesAt },
    ]);
    const h = holdingOf(() => 2);
    const { deps } = harness(s.store, h.holding, { now: DUE });
    await tallyPoll(deps, POLL);
    expect(s.results[0]?.cast['dip-buyer']).toBe(1);
  });

  it('counts 4,000 voters in one run: 11 chain reads and at most 18 statements with the job', async () => {
    const s = storeOf(voters(POLL_MAX_VOTERS));
    const h = holdingOf((w) => (Number.parseInt(w.slice(2), 16) % 2 === 0 ? 1 : 0));
    const { deps } = harness(s.store, h.holding, { now: DUE });
    const outcome = await createPollTallyJob(deps).run(DUE);
    expect(outcome).toBe('done');
    expect(h.calls).toHaveLength(POLL_TALLY_MAX_CHAIN_READS);
    // The job's results read, the skip gate, the tally's own results read, 11 pages and the result's 4 rows.
    expect(s.statements() + 1).toBeLessThanOrEqual(18);
    const result = s.results[0] as PollResultRecord;
    expect(Object.values(result.cast).reduce((a, b) => a + b, 0)).toBe(POLL_MAX_VOTERS);
    expect(Object.values(result.counted).reduce((a, b) => a + b, 0)).toBe(POLL_MAX_VOTERS / 2);
  });

  it('still tallies when one endpoint is 3 blocks behind the other, since every read is 50 below the head', async () => {
    const s = storeOf(voters(POLL_TALLY_PAGE * 2));
    // The head read answers the leading endpoint's head; later reads are pinned and answer that block.
    const h = holdingOf(() => 1, { blockAt: { 1: HEAD + 3 } });
    const { deps } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'done', step: null });
    expect(s.results[0]?.firstBlock).toBe(HEAD + 3 - 50);
  });

  it('fails at block and writes nothing when a later read answers another block', async () => {
    const s = storeOf(voters(POLL_TALLY_PAGE * 3));
    const h = holdingOf(() => 1, { blockAt: { 3: HEAD - 49 } });
    const { deps, lines } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'failed', step: 'block' });
    expect(s.results).toHaveLength(0);
    expect(lines.find((line) => line.event === 'poll_tally_failed')?.data).toEqual({ poll: POLL.id, step: 'block' });
  });

  it('fails at read when its reads pass 8 seconds from the first', async () => {
    const s = storeOf(voters(POLL_TALLY_PAGE * 4));
    const h = holdingOf(() => 1);
    // Each call of the clock moves 2.5 s on: five reads pass 8 s from the first.
    const { deps } = harness(s.store, h.holding, { now: DUE, step: 2_500 });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'failed', step: 'read' });
    expect(s.results).toHaveLength(0);
    expect(h.calls.length).toBeLessThan(5);
    // The same run with a still clock counts all.
    const still = harness(s.store, holdingOf(() => 1).holding, { now: DUE });
    expect(await tallyPoll(still.deps, POLL)).toEqual({ outcome: 'done', step: null });
  });

  it('fails at read before its 31st fetch', async () => {
    const s = storeOf(voters(POLL_MAX_VOTERS));
    // Three fetches a read, as with one endpoint failing on every call: 30 after 10 reads.
    const h = holdingOf(() => 1, { fetchesPerRead: 3 });
    const { deps } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'failed', step: 'read' });
    expect(h.calls).toHaveLength(POLL_TALLY_MAX_FETCHES / 3);
    expect(s.results).toHaveLength(0);
  });

  it('writes nothing and names the step when a chain read throws on page 3, and the next run counts all', async () => {
    const s = storeOf(voters(POLL_TALLY_PAGE * 3));
    const bad = holdingOf(() => 1, { throwAt: 4 });
    const first = harness(s.store, bad.holding, { now: DUE });
    expect(await tallyPoll(first.deps, POLL)).toEqual({ outcome: 'failed', step: 'read' });
    expect(s.results).toHaveLength(0);
    expect(first.lines).toEqual([{ event: 'poll_tally_failed', data: { poll: POLL.id, step: 'read' } }]);
    const good = holdingOf(() => 1);
    const second = harness(s.store, good.holding, { now: DUE });
    expect(await tallyPoll(second.deps, POLL)).toEqual({ outcome: 'done', step: null });
    expect(Object.values(s.results[0]?.counted ?? {}).reduce((a, b) => a + b, 0)).toBe(POLL_TALLY_PAGE * 3);
  });

  it('names results, list and write when the store fails there', async () => {
    const failing = (method: keyof PollStore, step: string) => async () => {
      const s = storeOf(voters(3));
      const store = {
        ...s.store,
        [method]: async () => {
          throw new Error('D1 failed');
        },
      };
      const { deps } = harness(store, holdingOf(() => 1).holding, { now: DUE });
      expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'failed', step });
    };
    await failing('getResults', 'results')();
    await failing('listVoters', 'list')();
    await failing('putResult', 'write')();
  });

  it('waits with gating off, writing nothing', async () => {
    const s = storeOf(voters(5));
    const h = holdingOf(() => 3, { gatingOn: false });
    const { deps, lines } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'waiting', step: null });
    expect(s.results).toHaveLength(0);
    expect(lines.map((line) => line.event)).toEqual(['poll_tally_waiting']);
  });

  it('answers already when a result is there, and never writes twice', async () => {
    const s = storeOf(voters(5));
    const h = holdingOf(() => 1);
    const { deps } = harness(s.store, h.holding, { now: DUE });
    expect((await tallyPoll(deps, POLL)).outcome).toBe('done');
    expect((await tallyPoll(deps, POLL)).outcome).toBe('already');
    expect(s.calls.filter((c) => c === 'putResult')).toHaveLength(1);
  });

  it('answers already when putResult finds a result written meanwhile', async () => {
    const s = storeOf(voters(5));
    const store = { ...s.store, putResult: async () => false };
    const { deps } = harness(store, holdingOf(() => 1).holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'already', step: null });
  });

  it('tallies a poll with no voter as zeros, after one head read', async () => {
    const s = storeOf([]);
    const h = holdingOf(() => 1);
    const { deps } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'done', step: null });
    expect(h.calls).toEqual([{ wallets: [], atBlock: null }]);
    expect(s.results[0]?.counted).toEqual({ 'big-tech-equal': 0, 'index-core': 0, 'momentum-five': 0, 'dip-buyer': 0 });
    expect(s.results[0]?.leaders).toEqual([]);
  });
});

describe('the poll_tally job', () => {
  it('is named poll_tally', () => {
    const s = storeOf([]);
    expect(createPollTallyJob(harness(s.store, holdingOf(() => 1).holding, { now: DUE }).deps).name).toBe('poll_tally');
  });

  it('is idle with no read at all before the close, in the first minute after it, and past 30 days', async () => {
    const times = [
      new Date('2026-10-17T12:07:00.000Z'),
      new Date(CLOSES + 30_000),
      new Date(CLOSES + 30 * 86_400_000 + 1),
    ];
    for (const now of times) {
      const s = storeOf(voters(5));
      const h = holdingOf(() => 1);
      const { deps, stateReads } = harness(s.store, h.holding, { now });
      expect(await createPollTallyJob(deps).run(now)).toBe('idle');
      expect(s.calls).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(stateReads).toEqual([]);
    }
  });

  it('answers idle for a tally that is open, already or waiting', async () => {
    const before = new Date(CLOSES + 120_000);
    const s = storeOf(voters(3));
    const { deps } = harness(s.store, holdingOf(() => 1).holding, { now: before });
    expect(await createPollTallyJob(deps).run(before)).toBe('idle');
    const g = storeOf(voters(3));
    const gated = harness(g.store, holdingOf(() => 1, { gatingOn: false }).holding, { now: DUE });
    expect(await createPollTallyJob(gated.deps).run(DUE)).toBe('idle');
  });

  it('throws PollTallyFailed inside the guard for a failed tally, which counts it and skips after three', async () => {
    const s = storeOf(voters(3));
    const h = holdingOf(() => 1, { throwAt: 1 });
    const { deps, lines, cursors } = harness(s.store, h.holding, { now: DUE });
    expect(await createPollTallyJob(deps).run(DUE)).toBe('failed');
    expect(lines.map((line) => line.event)).toEqual(['poll_tally_failed', 'social_job_failed']);
    expect(lines[1]?.data).toEqual({ job: 'poll_tally', error: POLL_TALLY_FAILED_ERROR });
    expect(cursors[0]?.name).toBe(socialFailureCursor('poll_tally'));
    const skipped = harness(s.store, h.holding, { now: DUE }, SOCIAL_JOB_SKIP_AFTER_FAILURES);
    expect(await createPollTallyJob(skipped.deps).run(DUE)).toBe('idle');
    expect(skipped.lines.map((line) => line.event)).toEqual(['social_job_skipped']);
  });

  it('logs poll_tally_expired only in the 00:00 to 00:04 UTC run past the lookback, and never tallies by itself', async () => {
    const past = Date.parse('2026-10-29T00:00:00.000Z');
    for (const [now, expected] of [
      [new Date(past + 3 * 60_000), ['poll_tally_expired']],
      [new Date(past + 5 * 60_000), []],
      [new Date(past + 12 * 3_600_000), []],
    ] as const) {
      const s = storeOf(voters(3));
      const h = holdingOf(() => 1);
      const { deps, lines } = harness(s.store, h.holding, { now });
      expect(await createPollTallyJob(deps).run(now)).toBe('idle');
      expect(lines.map((line) => line.event)).toEqual(expected);
      if (expected.length > 0) expect(lines[0]?.data).toEqual({ poll: POLL.id });
      expect(h.calls).toEqual([]);
      expect(s.results).toHaveLength(0);
    }
  });

  it('purges the votes of a counted poll 100 a run, and never the counts or the result', async () => {
    const result: PollResultRecord = {
      pollId: POLL.id,
      cast: { 'dip-buyer': 250 },
      counted: { 'dip-buyer': 250 },
      leaders: ['dip-buyer'],
      countedAt: DUE.toISOString(),
      firstBlock: 1,
      lastBlock: 1,
    };
    const s = storeOf(voters(250), [result]);
    const later = new Date(DUE.getTime() + 3_600_000);
    const outcomes: string[] = [];
    for (let run = 0; run < 4; run++) {
      const { deps } = harness(s.store, holdingOf(() => 1).holding, { now: later });
      outcomes.push(await createPollTallyJob(deps).run(later));
    }
    expect(outcomes).toEqual(['more', 'more', 'more', 'idle']);
    expect(s.rows.size).toBe(0);
    expect(s.results).toEqual([result]);
    expect(POLL_PURGE_PER_RUN).toBe(100);
  });
});

describe('the prune while open', () => {
  const OPEN = new Date('2026-10-18T10:02:00.000Z');

  it('runs only in the first five minutes of an hour and only from 3,600 votes', async () => {
    const few = storeOf(voters(POLL_PRUNE_AT - 1));
    const h = holdingOf(() => 0);
    const { deps } = harness(few.store, h.holding, { now: OPEN });
    expect(await createPollTallyJob(deps).run(OPEN)).toBe('idle');
    expect(few.calls).toEqual(['castCounts']);
    expect(h.calls).toEqual([]);

    const many = storeOf(voters(POLL_PRUNE_AT));
    const late = new Date('2026-10-18T10:05:00.000Z');
    const off = harness(many.store, h.holding, { now: late });
    expect(await createPollTallyJob(off.deps).run(late)).toBe('idle');
    expect(many.calls).toEqual([]);
  });

  it('deletes the votes of wallets below tier 1 and of Prix own at one block, in one batch after the last page', async () => {
    const list = voters(POLL_PRUNE_AT);
    list[0] = { wallet: ADMIN as Address, option: 'dip-buyer' };
    const s = storeOf(list);
    const holdsAt = (w: Address): Tier => (w === ADMIN ? 3 : Number.parseInt(w.slice(2), 16) % 3 === 0 ? 0 : 1);
    const h = holdingOf(holdsAt);
    const { deps, lines } = harness(s.store, h.holding, { now: OPEN });
    expect(await createPollTallyJob(deps).run(OPEN)).toBe('done');
    expect(s.calls.filter((c) => c === 'pruneVoters')).toHaveLength(1);
    expect(s.calls.at(-1)).toBe('pruneVoters');
    expect(new Set(h.calls.slice(1).map((c) => c.atBlock))).toEqual(new Set([HEAD - 50]));
    expect(s.rows.has(ADMIN)).toBe(false);
    for (const w of s.rows.keys()) expect(holdsAt(w as Address)).toBeGreaterThanOrEqual(1);
    for (const call of s.calls.filter((c) => c.startsWith('listVoters')))
      expect(call).toBe(`listVoters:${OPEN.toISOString()}`);
    // The skip gate, castCounts, the pages, the batch's 2: inside the prune's 16 with the guard's clear.
    expect(s.statements() + 1).toBeLessThanOrEqual(16);
    expect(lines.find((line) => line.event === 'poll_pruned')?.data).toMatchObject({ poll: POLL.id });
    noAddressIn(lines);
  });

  it('changes nothing when a read answers another block, and fails with its step', async () => {
    const s = storeOf(voters(POLL_PRUNE_AT));
    const h = holdingOf(() => 0, { blockAt: { 4: HEAD } });
    const { deps, lines } = harness(s.store, h.holding, { now: OPEN });
    expect(await createPollTallyJob(deps).run(OPEN)).toBe('failed');
    expect(s.rows.size).toBe(POLL_PRUNE_AT);
    expect(s.calls).not.toContain('pruneVoters');
    expect(lines.find((line) => line.event === 'poll_tally_failed')?.data).toEqual({ poll: POLL.id, step: 'block' });
  });

  it('is idle when every voter still holds, and waits with gating off', async () => {
    const s = storeOf(voters(POLL_PRUNE_AT));
    const { deps } = harness(s.store, holdingOf(() => 2).holding, { now: OPEN });
    expect(await createPollTallyJob(deps).run(OPEN)).toBe('idle');
    expect(s.calls).not.toContain('pruneVoters');
    const g = harness(s.store, holdingOf(() => 0, { gatingOn: false }).holding, { now: OPEN });
    expect(await createPollTallyJob(g.deps).run(OPEN)).toBe('idle');
    expect(s.rows.size).toBe(POLL_PRUNE_AT);
  });
});
