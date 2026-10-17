import type {
  Address,
  HolderPoll,
  PollResultRecord,
  PollStore,
  PollTallyJobDeps,
  PollTiersRead,
  PollVoter,
  SocialJob,
  Tier,
} from '@prix/contracts';
import {
  HOLDER_POLLS,
  POLL_MAX_VOTERS,
  POLL_PRUNE_AT,
  POLL_PURGE_MAX_POLLS,
  POLL_PURGE_PER_RUN,
  POLL_TALLY_BLOCK_MARGIN,
  POLL_TALLY_CHAIN_BLOCKS_PER_SECOND,
  POLL_TALLY_FAILED_ERROR,
  POLL_TALLY_FETCH_LATENCY_MS,
  POLL_TALLY_MAX_CHAIN_READS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_MAX_RUN_SECONDS,
  POLL_TALLY_PAGE,
  POLL_TALLY_SLOW_ANSWER_MS,
  SOCIAL_JOB_SKIP_AFTER_FAILURES,
  socialFailureCursor,
} from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market/chain';
import { createTokenChainReader } from '@prix/market/token-balances';
import { encodeTokenResult } from '@prix/market/token-wire';
import { describe, expect, it } from 'vitest';
import { createPollFetchMeter, createPollHoldingReader } from '../token/poll-holding.ts';
import { createPollTallyJob, createPollTallyJobFor, tallyPoll } from './poll-tally.ts';
import { runSocialStep } from './step.ts';

/**
 * The `poll_tally` job and `tallyPoll` against docs/contracts/phase-6-holders.md section 5 (revision 4): one
 * closed poll counted whole in one run or not at all, every chain read at one block 50 below the first head,
 * the fetch cap, the run's 8 seconds, the delay d, the purge, the prune while open, the expired line, and no
 * address in any log. Revision 7 (R4, HB1F2-SEC-1): a run that has reached its reads answers `done` to the
 * social step whatever follows, so the jobs behind it do not run. Run with `pnpm --filter @prix/runtime test`.
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
    expect(tallied?.data).toEqual({ poll: POLL.id, voters: 7, counted: 4, readMs: expect.any(Number) });
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
    expect(lines.find((line) => line.event === 'poll_tally_failed')?.data).toEqual({
      poll: POLL.id,
      step: 'block',
      readMs: expect.any(Number),
    });
  });

  it('fails at read once its reads pass POLL_TALLY_MAX_RUN_SECONDS from the start of the first tiersNow', async () => {
    expect(POLL_TALLY_MAX_RUN_SECONDS).toBe(5);
    const s = storeOf(voters(POLL_TALLY_PAGE * 4));
    // The clock is read at the start and at the end of each read, one step a reading: the fifth read ends nine
    // steps after the first read started. At 560 ms a step that is 5,040 ms, past 5 s: failed at read.
    const slow = harness(s.store, holdingOf(() => 1).holding, { now: DUE, step: 560 });
    expect(await tallyPoll(slow.deps, POLL)).toEqual({ outcome: 'failed', step: 'read' });
    expect(s.results).toHaveLength(0);
    expect(slow.lines.find((line) => line.event === 'poll_tally_failed')?.data).toEqual({
      poll: POLL.id,
      step: 'read',
      readMs: 5_040,
    });
    // At 550 ms a step the fifth read ends 4,950 ms after the first started: the run is counted.
    const fast = harness(storeOf(voters(POLL_TALLY_PAGE * 4)).store, holdingOf(() => 1).holding, {
      now: DUE,
      step: 550,
    });
    expect(await tallyPoll(fast.deps, POLL)).toEqual({ outcome: 'done', step: null });
    expect(fast.lines.find((line) => line.event === 'poll_tallied')?.data).toMatchObject({ readMs: 4_950 });
  });

  it('fails at read before its 12th fetch', async () => {
    expect(POLL_TALLY_MAX_FETCHES).toBe(11);
    const s = storeOf(voters(POLL_MAX_VOTERS));
    // Three fetches a read, as with an endpoint the run never marks: 12 after 4 reads, so no fifth read.
    const h = holdingOf(() => 1, { fetchesPerRead: 3 });
    const { deps } = harness(s.store, h.holding, { now: DUE });
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'failed', step: 'read' });
    expect(h.calls).toHaveLength(Math.ceil(POLL_TALLY_MAX_FETCHES / 3));
    expect(s.results).toHaveLength(0);
  });

  it('writes nothing and names the step when a chain read throws on page 3, and the next run counts all', async () => {
    const s = storeOf(voters(POLL_TALLY_PAGE * 3));
    const bad = holdingOf(() => 1, { throwAt: 4 });
    const first = harness(s.store, bad.holding, { now: DUE });
    expect(await tallyPoll(first.deps, POLL)).toEqual({ outcome: 'failed', step: 'read' });
    expect(s.results).toHaveLength(0);
    expect(first.lines).toEqual([
      { event: 'poll_tally_failed', data: { poll: POLL.id, step: 'read', readMs: expect.any(Number) } },
    ]);
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

  it('tallies a poll with no voter as zeros, after one head read, while polls are switched on', async () => {
    const s = storeOf([]);
    const h = holdingOf(() => 1);
    const { deps } = harness(s.store, h.holding, { now: DUE });
    deps.pollsEnabled = true;
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

  it('answers idle for a tally that is open, and done for one that waits after its reads (revision 7)', async () => {
    const before = new Date(CLOSES + 120_000);
    const s = storeOf(voters(3));
    const { deps } = harness(s.store, holdingOf(() => 1).holding, { now: before });
    expect(await createPollTallyJob(deps).run(before)).toBe('idle');
    const g = storeOf(voters(3));
    const gated = harness(g.store, holdingOf(() => 1, { gatingOn: false }).holding, { now: DUE });
    expect(await createPollTallyJob(gated.deps).run(DUE)).toBe('done');
  });

  it('throws PollTallyFailed inside the guard for a failed tally, which counts it and skips after three', async () => {
    const s = storeOf(voters(3));
    const h = holdingOf(() => 1, { throwAt: 1 });
    const { deps, lines, cursors } = harness(s.store, h.holding, { now: DUE });
    // The guard answers failed; the run had reached its reads, so the step sees done (revision 7).
    expect(await createPollTallyJob(deps).run(DUE)).toBe('done');
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
    expect(lines.find((line) => line.event === 'poll_pruned')?.data).toEqual({
      poll: POLL.id,
      deleted: expect.any(Number),
      readMs: expect.any(Number),
    });
    noAddressIn(lines);
  });

  it('changes nothing when a read answers another block, and fails with its step', async () => {
    const s = storeOf(voters(POLL_PRUNE_AT));
    const h = holdingOf(() => 0, { blockAt: { 4: HEAD } });
    const { deps, lines } = harness(s.store, h.holding, { now: OPEN });
    // Failed inside the guard, done to the step: the run had reached its reads (revision 7).
    expect(await createPollTallyJob(deps).run(OPEN)).toBe('done');
    expect(s.rows.size).toBe(POLL_PRUNE_AT);
    expect(s.calls).not.toContain('pruneVoters');
    expect(lines.find((line) => line.event === 'poll_tally_failed')?.data).toEqual({
      poll: POLL.id,
      step: 'block',
      readMs: expect.any(Number),
    });
  });

  it('deletes nothing when every voter still holds, and waits with gating off, each done to the step', async () => {
    const s = storeOf(voters(POLL_PRUNE_AT));
    const { deps } = harness(s.store, holdingOf(() => 2).holding, { now: OPEN });
    expect(await createPollTallyJob(deps).run(OPEN)).toBe('done');
    expect(s.calls).not.toContain('pruneVoters');
    const g = harness(s.store, holdingOf(() => 0, { gatingOn: false }).holding, { now: OPEN });
    expect(await createPollTallyJob(g.deps).run(OPEN)).toBe('done');
    expect(s.rows.size).toBe(POLL_PRUNE_AT);
  });
});

/**
 * Revision 7 (R4, HB1F2-SEC-1), section 5 "A run that has reached its reads ends the step": from the run's
 * first `listVoters`, the job answers `done` to the social step whatever follows, so that `room_picture_sweep`
 * and `room_prune` behind it do not run on what the reads left of the invocation's 50 subrequests. A failure
 * is still logged `poll_tally_failed` and counted by the guard. Every other run keeps its answer.
 */
describe('the step answer of a run that has reached its reads (revision 7)', () => {
  const OPEN = new Date('2026-10-18T10:02:00.000Z');

  /** The social step as the entry orders it: poll_tally, then room_picture_sweep, then room_prune last. */
  async function stepAfter(job: SocialJob, now: Date) {
    const behind: string[] = [];
    const recorder = (name: 'room_picture_sweep' | 'room_prune'): SocialJob => ({
      name,
      run: async () => {
        behind.push(name);
        return 'idle';
      },
    });
    const result = await runSocialStep([job, recorder('room_picture_sweep'), recorder('room_prune')], now);
    return { result, behind };
  }

  const ENDS = { ran: 'poll_tally', outcome: 'done' };
  const BOTH_BEHIND = ['room_picture_sweep', 'room_prune'];

  describe('the tally', () => {
    it('ends the step when putResult answers false after its reads (already)', async () => {
      const s = storeOf(voters(5));
      const store = { ...s.store, putResult: async () => false };
      const { deps } = harness(store, holdingOf(() => 1).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
    });

    it('ends the step when the first chain read finds gating off (waiting)', async () => {
      const s = storeOf(voters(5));
      const { deps, lines } = harness(s.store, holdingOf(() => 3, { gatingOn: false }).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
      expect(lines.map((line) => line.event)).toEqual(['poll_tally_waiting']);
      expect(s.results).toHaveLength(0);
    });

    it('ends the step after a failure at list, and the guard still logs and counts it', async () => {
      const s = storeOf(voters(5));
      s.failListAt(1);
      const { deps, lines, cursors } = harness(s.store, holdingOf(() => 1).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
      expect(lines.map((line) => line.event)).toEqual(['poll_tally_failed', 'social_job_failed']);
      expect(lines[0]?.data).toEqual({ poll: POLL.id, step: 'list' });
      expect(lines[1]?.data).toEqual({ job: 'poll_tally', error: POLL_TALLY_FAILED_ERROR });
      expect(cursors).toHaveLength(1);
      expect(cursors[0]?.name).toBe(socialFailureCursor('poll_tally'));
      expect(JSON.parse(cursors[0]?.body ?? '{}')).toMatchObject({ failures: 1 });
    });

    it('ends the step after a chain read that throws (read)', async () => {
      const s = storeOf(voters(5));
      const { deps, lines, cursors } = harness(s.store, holdingOf(() => 1, { throwAt: 1 }).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
      expect(lines.map((line) => line.event)).toEqual(['poll_tally_failed', 'social_job_failed']);
      expect(cursors).toHaveLength(1);
      expect(s.results).toHaveLength(0);
    });

    it('ends the step after the fetch cap at its last read (read)', async () => {
      const s = storeOf(voters(POLL_MAX_VOTERS));
      const { deps } = harness(s.store, holdingOf(() => 1, { fetchesPerRead: 3 }).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
      expect(s.results).toHaveLength(0);
    });

    it('ends the step after a read at another block (block)', async () => {
      const s = storeOf(voters(POLL_TALLY_PAGE * 3));
      const { deps, lines } = harness(s.store, holdingOf(() => 1, { blockAt: { 3: HEAD - 49 } }).holding, {
        now: DUE,
      });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
      expect(lines[0]?.data).toEqual({ poll: POLL.id, step: 'block', readMs: expect.any(Number) });
    });

    it('ends the step after a failure at write', async () => {
      const s = storeOf(voters(5));
      const store = {
        ...s.store,
        putResult: async () => {
          throw new Error('D1 failed');
        },
      };
      const { deps, lines } = harness(store, holdingOf(() => 1).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
      expect(lines[0]?.data).toEqual({ poll: POLL.id, step: 'write', readMs: expect.any(Number) });
    });

    it('ends the step when it wrote its result (done)', async () => {
      const s = storeOf(voters(5));
      const { deps } = harness(s.store, holdingOf(() => 1).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({ result: ENDS, behind: [] });
      expect(s.results).toHaveLength(1);
    });
  });

  describe('the prune while open', () => {
    it('ends the step when it deleted none', async () => {
      const s = storeOf(voters(POLL_PRUNE_AT));
      const { deps } = harness(s.store, holdingOf(() => 2).holding, { now: OPEN });
      expect(await stepAfter(createPollTallyJob(deps), OPEN)).toEqual({ result: ENDS, behind: [] });
      expect(s.calls).not.toContain('pruneVoters');
      expect(s.rows.size).toBe(POLL_PRUNE_AT);
    });

    it('ends the step when every voter it would prune is already gone (pruneVoters deleted none)', async () => {
      const s = storeOf(voters(POLL_PRUNE_AT));
      const store = { ...s.store, pruneVoters: async () => 0 };
      const { deps } = harness(store, holdingOf(() => 0).holding, { now: OPEN });
      expect(await stepAfter(createPollTallyJob(deps), OPEN)).toEqual({ result: ENDS, behind: [] });
    });

    it('ends the step when gating is off (waiting)', async () => {
      const s = storeOf(voters(POLL_PRUNE_AT));
      const { deps } = harness(s.store, holdingOf(() => 0, { gatingOn: false }).holding, { now: OPEN });
      expect(await stepAfter(createPollTallyJob(deps), OPEN)).toEqual({ result: ENDS, behind: [] });
      expect(s.rows.size).toBe(POLL_PRUNE_AT);
    });

    it('ends the step after a failure at list, read, block or write, each still counted by the guard', async () => {
      const cases: { step: string; make: () => { store: PollStore; holding: PollTallyJobDeps['holding'] } }[] = [
        {
          step: 'list',
          make: () => {
            const s = storeOf(voters(POLL_PRUNE_AT));
            s.failListAt(2);
            return { store: s.store, holding: holdingOf(() => 0).holding };
          },
        },
        {
          step: 'read',
          make: () => ({
            store: storeOf(voters(POLL_PRUNE_AT)).store,
            holding: holdingOf(() => 0, { throwAt: 3 }).holding,
          }),
        },
        {
          step: 'block',
          make: () => ({
            store: storeOf(voters(POLL_PRUNE_AT)).store,
            holding: holdingOf(() => 0, { blockAt: { 4: HEAD } }).holding,
          }),
        },
        {
          step: 'write',
          make: () => {
            const s = storeOf(voters(POLL_PRUNE_AT));
            const store = {
              ...s.store,
              pruneVoters: async () => {
                throw new Error('D1 failed');
              },
            };
            return { store, holding: holdingOf(() => 0).holding };
          },
        },
      ];
      for (const { step, make } of cases) {
        const { store, holding } = make();
        const { deps, lines, cursors } = harness(store, holding, { now: OPEN });
        expect(await stepAfter(createPollTallyJob(deps), OPEN)).toEqual({ result: ENDS, behind: [] });
        expect(lines.map((line) => line.event)).toEqual(['poll_tally_failed', 'social_job_failed']);
        // Every one of these failed after the run's first tiersNow had started, so each carries readMs.
        expect(lines[0]?.data).toEqual({ poll: POLL.id, step, readMs: expect.any(Number) });
        expect(cursors).toHaveLength(1);
      }
    });

    it('ends the step when it deleted rows (done)', async () => {
      const s = storeOf(voters(POLL_PRUNE_AT));
      const { deps } = harness(s.store, holdingOf(() => 0).holding, { now: OPEN });
      expect(await stepAfter(createPollTallyJob(deps), OPEN)).toEqual({ result: ENDS, behind: [] });
      expect(s.rows.size).toBe(0);
    });
  });

  describe('a run that never reached its reads keeps its answer', () => {
    it('a tally still open hands the step on as idle', async () => {
      const before = new Date(CLOSES + 120_000);
      const s = storeOf(voters(3));
      const { deps } = harness(s.store, holdingOf(() => 1).holding, { now: before });
      expect(await stepAfter(createPollTallyJob(deps), before)).toEqual({
        result: { ran: null, outcome: 'idle' },
        behind: BOTH_BEHIND,
      });
      expect(s.calls.some((c) => c.startsWith('listVoters'))).toBe(false);
    });

    it('an already at step 2 hands the step on as idle', async () => {
      const s = storeOf(voters(3));
      let reads = 0;
      const store: PollStore = {
        ...s.store,
        async getResults(pollIds) {
          reads += 1;
          // The job's own read finds none; tallyPoll's read at step 2 finds the one written meanwhile.
          if (reads === 1) return [];
          return pollIds.map((pollId) => ({
            pollId,
            cast: {},
            counted: {},
            leaders: [],
            countedAt: DUE.toISOString(),
            firstBlock: 1,
            lastBlock: 1,
          }));
        },
      };
      const { deps } = harness(store, holdingOf(() => 1).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({
        result: { ran: null, outcome: 'idle' },
        behind: BOTH_BEHIND,
      });
      expect(s.calls.some((c) => c.startsWith('listVoters'))).toBe(false);
    });

    it('a failure at results or at the delay read stays failed and hands the step on', async () => {
      const s = storeOf(voters(3));
      let reads = 0;
      const store: PollStore = {
        ...s.store,
        async getResults() {
          reads += 1;
          if (reads === 1) return [];
          throw new Error('D1 failed');
        },
      };
      const atResults = harness(store, holdingOf(() => 1).holding, { now: DUE });
      expect(await stepAfter(createPollTallyJob(atResults.deps), DUE)).toEqual({
        result: { ran: 'poll_tally', outcome: 'failed' },
        behind: BOTH_BEHIND,
      });
      expect(atResults.lines[0]?.data).toEqual({ poll: POLL.id, step: 'results' });

      const atDelay = harness(storeOf(voters(3)).store, holdingOf(() => 1).holding, { now: DUE });
      atDelay.deps.tallyDelaySeconds = async () => {
        throw new Error('no key');
      };
      expect(await stepAfter(createPollTallyJob(atDelay.deps), DUE)).toEqual({
        result: { ran: 'poll_tally', outcome: 'failed' },
        behind: BOTH_BEHIND,
      });
    });

    it('a prune below POLL_PRUNE_AT is idle and one whose castCounts failed is failed', async () => {
      const few = storeOf(voters(POLL_PRUNE_AT - 1));
      const below = harness(few.store, holdingOf(() => 0).holding, { now: OPEN });
      expect(await stepAfter(createPollTallyJob(below.deps), OPEN)).toEqual({
        result: { ran: null, outcome: 'idle' },
        behind: BOTH_BEHIND,
      });

      const s = storeOf(voters(POLL_PRUNE_AT));
      const store = {
        ...s.store,
        castCounts: async () => {
          throw new Error('D1 failed');
        },
      };
      const broken = harness(store, holdingOf(() => 0).holding, { now: OPEN });
      expect(await stepAfter(createPollTallyJob(broken.deps), OPEN)).toEqual({
        result: { ran: 'poll_tally', outcome: 'failed' },
        behind: BOTH_BEHIND,
      });
    });

    it('a run the skip gate stopped is idle, with no read', async () => {
      const s = storeOf(voters(3));
      const h = holdingOf(() => 1);
      const { deps } = harness(s.store, h.holding, { now: DUE }, SOCIAL_JOB_SKIP_AFTER_FAILURES);
      expect(await stepAfter(createPollTallyJob(deps), DUE)).toEqual({
        result: { ran: null, outcome: 'idle' },
        behind: BOTH_BEHIND,
      });
      expect(h.calls).toEqual([]);
    });
  });
});

/** The social step as the entry orders it, for the blocks below: poll_tally, room_picture_sweep, room_prune. */
async function stepWith(job: SocialJob, now: Date) {
  const behind: string[] = [];
  const recorder = (name: 'room_picture_sweep' | 'room_prune'): SocialJob => ({
    name,
    run: async () => {
      behind.push(name);
      return 'idle';
    },
  });
  const result = await runSocialStep([job, recorder('room_picture_sweep'), recorder('room_prune')], now);
  return { result, behind };
}

const counted = (pollId: string): PollResultRecord => ({
  pollId,
  cast: { 'dip-buyer': 1 },
  counted: { 'dip-buyer': 1 },
  leaders: ['dip-buyer'],
  countedAt: DUE.toISOString(),
  firstBlock: 1,
  lastBlock: 1,
});

/** A poll like the first, under another id, closing `hoursBefore` hours before it. */
const pollBefore = (id: string, hoursBefore: number): HolderPoll => ({
  ...POLL,
  id,
  closesAt: new Date(CLOSES - hoursBefore * 3_600_000).toISOString(),
});

/**
 * Revision 8e (F3, R8D-SEC-5) and revision 8f (R8E-B4, R8E-SEC-3), section 5 step 2: while `pollsEnabled` is not
 * true, a closed poll whose first `listVoters` page holds no voter writes nothing, makes no chain read and answers
 * `waiting`; the job answers `idle` to the step and goes on to the next watched poll, (b), (c) and (d). A run that
 * made a chain read (gating off) still answers `done`.
 */
describe('a closed poll with no voter while polls are switched off (F3)', () => {
  it('writes nothing, reads no chain, logs poll_tally_waiting and answers waiting; absent counts as off', async () => {
    for (const pollsEnabled of [false, undefined]) {
      const s = storeOf([]);
      const h = holdingOf(() => 1);
      const { deps, lines } = harness(s.store, h.holding, { now: DUE });
      if (pollsEnabled !== undefined) deps.pollsEnabled = pollsEnabled;
      expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'waiting', step: null });
      expect(h.calls).toEqual([]);
      expect(s.results).toHaveLength(0);
      expect(s.calls).toEqual(['getResults', `listVoters:${POLL.closesAt}`]);
      expect(lines).toEqual([{ event: 'poll_tally_waiting', data: { poll: POLL.id } }]);
    }
  });

  it('writes the zero result when polls are switched on', async () => {
    const s = storeOf([]);
    const { deps } = harness(s.store, holdingOf(() => 1).holding, { now: DUE });
    deps.pollsEnabled = true;
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'done', step: null });
    expect(s.results).toHaveLength(1);
  });

  it('tallies a poll with voters whatever pollsEnabled says', async () => {
    for (const pollsEnabled of [false, true, undefined]) {
      const s = storeOf(voters(5));
      const { deps } = harness(s.store, holdingOf(() => 1).holding, { now: DUE });
      if (pollsEnabled !== undefined) deps.pollsEnabled = pollsEnabled;
      expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'done', step: null });
      expect(s.results).toHaveLength(1);
    }
  });

  it('answers idle to the step, so room_picture_sweep and room_prune run in the same invocation', async () => {
    const s = storeOf([]);
    const h = holdingOf(() => 1);
    const { deps } = harness(s.store, h.holding, { now: DUE });
    deps.pollsEnabled = false;
    expect(await stepWith(createPollTallyJob(deps), DUE)).toEqual({
      result: { ran: null, outcome: 'idle' },
      behind: ['room_picture_sweep', 'room_prune'],
    });
    expect(h.calls).toEqual([]);
    expect(s.results).toHaveLength(0);
  });

  it('tells F3 from gating by the chain read: voters, polls off, gating off answer waiting after the read and done to the step (R8E-B4)', async () => {
    const s = storeOf(voters(5));
    const h = holdingOf(() => 3, { gatingOn: false });
    const { deps, lines } = harness(s.store, h.holding, { now: DUE });
    deps.pollsEnabled = false;
    expect(await tallyPoll(deps, POLL)).toEqual({ outcome: 'waiting', step: null });
    expect(h.calls).toHaveLength(1);
    expect(lines.map((line) => line.event)).toEqual(['poll_tally_waiting']);
    const again = harness(storeOf(voters(5)).store, holdingOf(() => 3, { gatingOn: false }).holding, { now: DUE });
    again.deps.pollsEnabled = false;
    expect(await stepWith(createPollTallyJob(again.deps), DUE)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      behind: [],
    });
  });

  it('falls through a waiting poll to the purge of a counted poll with votes left, in the same run (R8E-SEC-3)', async () => {
    const waiting = POLL;
    const older = pollBefore('older-poll', 24);
    const s = storeOf(voters(150));
    const store: PollStore = {
      ...s.store,
      // The waiting poll has no voter; the counted poll's votes are the rows the purge deletes.
      listVoters: async (pollId, after, before, limit) =>
        pollId === waiting.id ? [] : s.store.listVoters(pollId, after, before, limit),
      getResults: async (pollIds) => {
        s.calls.push('getResults');
        return pollIds.includes(older.id) ? [counted(older.id)] : [];
      },
    };
    const h = holdingOf(() => 1);
    const { deps } = harness(store, h.holding, { now: DUE });
    deps.pollsEnabled = false;
    expect(await stepWith(createPollTallyJobFor(deps, [older, waiting]), DUE)).toEqual({
      result: { ran: 'poll_tally', outcome: 'more' },
      behind: [],
    });
    expect(s.calls).toContain('deleteVotes');
    expect(s.rows.size).toBe(50);
    expect(h.calls).toEqual([]);
  });

  it('falls through a waiting poll to the next watched poll without a result, which is tallied', async () => {
    const empty = POLL;
    const later = { ...pollBefore('later-poll', -1), closesAt: new Date(CLOSES + 3_600_000).toISOString() };
    const s = storeOf(voters(5));
    const store: PollStore = {
      ...s.store,
      listVoters: async (pollId, after, before, limit) =>
        pollId === empty.id ? [] : s.store.listVoters(pollId, after, before, limit),
    };
    const now = new Date(Date.parse(later.closesAt) + (60 + D) * 1000);
    const { deps } = harness(store, holdingOf(() => 1).holding, { now });
    deps.pollsEnabled = false;
    expect(await createPollTallyJobFor(deps, [empty, later]).run(now)).toBe('done');
    expect(s.results.map((result) => result.pollId)).toEqual([later.id]);
  });

  /** A poll like the first, under another id, closing `hoursAfter` hours after it. */
  const pollAfter = (id: string, hoursAfter: number): HolderPoll => ({
    ...POLL,
    id,
    closesAt: new Date(CLOSES + hoursAfter * 3_600_000).toISOString(),
  });

  it('takes the next poll of pollsToTallyAt(now) only: a poll past its lookback with voters is never tallied by the job (R8F-SEC-3)', async () => {
    // Past its lookback (POLL_TALLY_LOOKBACK_DAYS 7) but still watched (30 days); the run is outside 00:00 to 00:04.
    const stale = pollBefore('stale-poll', 8 * 24);
    const waiting = POLL;
    const s = storeOf(voters(5));
    const listed: string[] = [];
    const store: PollStore = {
      ...s.store,
      listVoters: async (pollId, after, before, limit) => {
        listed.push(pollId);
        return pollId === waiting.id ? [] : s.store.listVoters(pollId, after, before, limit);
      },
    };
    const h = holdingOf(() => 1);
    const { deps, lines } = harness(store, h.holding, { now: DUE });
    deps.pollsEnabled = false;
    expect(await stepWith(createPollTallyJobFor(deps, [stale, waiting]), DUE)).toEqual({
      result: { ran: null, outcome: 'idle' },
      behind: ['room_picture_sweep', 'room_prune'],
    });
    expect(listed).toEqual([waiting.id]);
    expect(h.calls).toEqual([]);
    expect(s.results).toHaveLength(0);
    expect(lines.map((line) => line.event)).toEqual(['poll_tally_waiting']);
  });

  it('ends the run on gating waiting, made after a chain read: the next poll is not tallied and the step sees done (F8F-B3 i)', async () => {
    const first = POLL;
    const second = pollAfter('second-poll', 1);
    const s = storeOf(voters(5));
    const listed: string[] = [];
    const store: PollStore = {
      ...s.store,
      listVoters: async (pollId, after, before, limit) => {
        listed.push(pollId);
        return s.store.listVoters(pollId, after, before, limit);
      },
    };
    const now = new Date(Date.parse(second.closesAt) + (60 + D) * 1000);
    const h = holdingOf(() => 1, { gatingOn: false });
    const { deps } = harness(store, h.holding, { now });
    deps.pollsEnabled = false;
    expect(await stepWith(createPollTallyJobFor(deps, [first, second]), now)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      behind: [],
    });
    expect(listed).toEqual([first.id]);
    expect(h.calls).toHaveLength(1);
    expect(s.results).toHaveLength(0);
  });

  it('sets the reached-reads flag again after a fall-through: a later tally that fails at read ends the step with done (F8F-B3 ii)', async () => {
    const empty = POLL;
    const later = pollAfter('later-poll', 1);
    const s = storeOf(voters(5));
    const store: PollStore = {
      ...s.store,
      listVoters: async (pollId, after, before, limit) =>
        pollId === empty.id ? [] : s.store.listVoters(pollId, after, before, limit),
    };
    const now = new Date(Date.parse(later.closesAt) + (60 + D) * 1000);
    const h = holdingOf(() => 1, { throwAt: 1 });
    const { deps, lines } = harness(store, h.holding, { now });
    deps.pollsEnabled = false;
    expect(await stepWith(createPollTallyJobFor(deps, [empty, later]), now)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      behind: [],
    });
    expect(h.calls).toHaveLength(1);
    expect(s.results).toHaveLength(0);
    expect(lines.map((line) => line.event)).toEqual(['poll_tally_waiting', 'poll_tally_failed', 'social_job_failed']);
  });

  it('sets the reached-reads flag again for a prune after a fall-through: a prune that deletes none ends the step with done (F8F-B3 ii)', async () => {
    const empty = POLL;
    const open = pollAfter('open-poll', 7 * 24);
    // The first minute of an hour, after the empty poll's due time, while the later poll is open.
    const now = new Date(Math.ceil((DUE.getTime() + 1) / 3_600_000) * 3_600_000 + 60_000);
    const s = storeOf(voters(POLL_PRUNE_AT));
    const store: PollStore = {
      ...s.store,
      listVoters: async (pollId, after, before, limit) =>
        pollId === empty.id ? [] : s.store.listVoters(pollId, after, before, limit),
      castCounts: async (pollId) => (pollId === empty.id ? {} : s.store.castCounts(pollId)),
    };
    const h = holdingOf(() => 1);
    const { deps } = harness(store, h.holding, { now });
    deps.pollsEnabled = false;
    expect(await stepWith(createPollTallyJobFor(deps, [empty, open]), now)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      behind: [],
    });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(s.calls).not.toContain('pruneVoters');
    expect(s.rows.size).toBe(POLL_PRUNE_AT);
  });
});

describe('the purge tries at most POLL_PURGE_MAX_POLLS counted polls (R8-4)', () => {
  it('stops after the third empty try, and a fourth poll waits for a run whose window holds it', async () => {
    expect(POLL_PURGE_MAX_POLLS).toBe(3);
    const polls = [pollBefore('p1', 96), pollBefore('p2', 72), pollBefore('p3', 48), pollBefore('p4', 24)];
    const deleted: string[] = [];
    const s = storeOf([]);
    const store: PollStore = {
      ...s.store,
      getResults: async (pollIds) => pollIds.map((pollId) => counted(pollId)),
      deleteVotes: async (pollId) => {
        deleted.push(pollId);
        return pollId === 'p4' ? 10 : 0;
      },
    };
    const later = new Date(DUE.getTime() + 3_600_000);
    const { deps } = harness(store, holdingOf(() => 1).holding, { now: later });
    expect(await createPollTallyJobFor(deps, polls).run(later)).toBe('idle');
    expect(deleted).toEqual(['p1', 'p2', 'p3']);
    // The second try that deletes a row ends the run with more.
    const two: string[] = [];
    const store2: PollStore = {
      ...store,
      deleteVotes: async (pollId) => {
        two.push(pollId);
        return pollId === 'p2' ? 5 : 0;
      },
    };
    const again = harness(store2, holdingOf(() => 1).holding, { now: later });
    expect(await createPollTallyJobFor(again.deps, polls).run(later)).toBe('more');
    expect(two).toEqual(['p1', 'p2']);
  });
});

/**
 * Revision 8f (7), CR8C-2: the job's own fake fetch. Three endpoints at the URLs of PUBLIC_RPC_URLS behind one
 * fetch, each answer after POLL_TALLY_FETCH_LATENCY_MS on the real clock, `deps.now()` the real clock, and a head
 * that moves POLL_TALLY_CHAIN_BLOCKS_PER_SECOND blocks a second of it. The real chain reader, the run's meter and
 * the holding reader, as apps/api/src/poll-holding.ts wires them.
 */
describe('a tally on a fake chain on the real clock', () => {
  const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];
  const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
  const SUPPLY = 10n ** 27n;
  const BALANCE_OF = '70a08231';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const hostOf = (input: RequestInfo | URL): string =>
    new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host;

  type Behaviour = (call: number) => 'ok' | '429' | '429-stalled' | { slowMs: number } | { bodyAfterMs: number };

  function fakeChain(behaviour: Record<string, Behaviour>) {
    const start = Date.now();
    const head = () => 90_000_000 + Math.floor(((Date.now() - start) * POLL_TALLY_CHAIN_BLOCKS_PER_SECOND) / 1000);
    const sent: Record<string, number> = {};
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = hostOf(input);
      sent[host] = (sent[host] ?? 0) + 1;
      const act = behaviour[host]?.(sent[host] ?? 0) ?? 'ok';
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: unknown; params?: unknown[] };
      const [tx, tag] = (body.params ?? []) as [{ data?: string }, string | undefined];
      const atHead = head();
      const block = typeof tag === 'string' && tag.startsWith('0x') ? BigInt(tag) : BigInt(atHead);
      const count = String(tx?.data ?? '').split(BALANCE_OF).length - 1;
      const text = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: encodeTokenResult({
          blockNumber: block,
          blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
          totalSupply: SUPPLY,
          decimals: 18,
          balances: Array.from({ length: count }, () => 10n ** 23n),
        }),
      });
      if (act === '429') {
        await sleep(POLL_TALLY_FETCH_LATENCY_MS);
        return new Response('slow down', { status: 429 });
      }
      if (act === '429-stalled') {
        // 429 headers after the latency, then a body that never sends a byte (PF5-SEC-1).
        await sleep(POLL_TALLY_FETCH_LATENCY_MS);
        return new Response(new ReadableStream<Uint8Array>(), { status: 429 });
      }
      if (typeof act === 'object' && 'bodyAfterMs' in act) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            }, act.bodyAfterMs);
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      await sleep(typeof act === 'object' ? act.slowMs : POLL_TALLY_FETCH_LATENCY_MS);
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { fetchFn, sent: (url: string) => sent[new URL(url).host] ?? 0 };
  }

  const pastPoll: HolderPoll = {
    ...POLL,
    id: 'real-clock-poll',
    closesAt: new Date(Date.now() - 86_400_000).toISOString(),
  };
  const early = '2020-01-01T00:00:00.000Z';

  function tallyDepsOn(chain: ReturnType<typeof fakeChain>) {
    const s = storeOf(voters(POLL_MAX_VOTERS).map((voter) => ({ ...voter, at: early })));
    const meter = createPollFetchMeter(chain.fetchFn);
    const holding = createPollHoldingReader({
      chain: createTokenChainReader([OFFICIAL, PUBLICNODE, DRPC], meter.fetch),
      config: async () => ({ token: TOKEN, thresholdsPpm: [10, 100, 1_000] as const, gatingOn: true }),
      meter,
    });
    const { deps, lines } = harness(s.store, holding, { now: new Date() });
    deps.now = () => new Date();
    deps.tallyDelaySeconds = async () => 0;
    return { deps, lines, s };
  }

  it('tallies POLL_MAX_VOTERS voters with the official endpoint at 429, asked once, within the run seconds', async () => {
    const chain = fakeChain({ [new URL(OFFICIAL).host]: () => '429' });
    const { deps, lines, s } = tallyDepsOn(chain);
    expect(await tallyPoll(deps, pastPoll)).toEqual({ outcome: 'done', step: null });
    expect(chain.sent(OFFICIAL)).toBe(1);
    const readMs = Number(lines.find((line) => line.event === 'poll_tallied')?.data?.readMs);
    expect(readMs).toBeLessThanOrEqual(POLL_TALLY_MAX_RUN_SECONDS * 1000);
    expect(Object.values(s.results[0]?.cast ?? {}).reduce((a, b) => a + b, 0)).toBe(POLL_MAX_VOTERS);
  }, 20_000);

  it('tallies within the run seconds when the official endpoint answers 429 and never ends its body (PF5-SEC-1)', async () => {
    const chain = fakeChain({ [new URL(OFFICIAL).host]: () => '429-stalled' });
    const { deps, lines, s } = tallyDepsOn(chain);
    const bound = POLL_TALLY_MAX_RUN_SECONDS * 1000 + 2_000;
    const outcome = await Promise.race([tallyPoll(deps, pastPoll), sleep(bound).then(() => 'still pending' as const)]);
    expect(outcome).toEqual({ outcome: 'done', step: null });
    expect(chain.sent(OFFICIAL)).toBe(1);
    expect(Number(lines.find((line) => line.event === 'poll_tallied')?.data?.readMs)).toBeLessThanOrEqual(
      POLL_TALLY_MAX_RUN_SECONDS * 1000,
    );
    expect(Object.values(s.results[0]?.cast ?? {}).reduce((a, b) => a + b, 0)).toBe(POLL_MAX_VOTERS);
  }, 20_000);

  it('uses a slow official answer once and marks it: every call after 1,400 ms, asked once a run', async () => {
    const chain = fakeChain({ [new URL(OFFICIAL).host]: () => ({ slowMs: 1_400 }) });
    const { deps, lines } = tallyDepsOn(chain);
    expect(await tallyPoll(deps, pastPoll)).toEqual({ outcome: 'done', step: null });
    expect(chain.sent(OFFICIAL)).toBe(1);
    expect(Number(lines.find((line) => line.event === 'poll_tallied')?.data?.readMs)).toBeLessThanOrEqual(
      POLL_TALLY_MAX_RUN_SECONDS * 1000,
    );
  }, 20_000);

  it('marks the official endpoint whose headers come at once and whose body comes after 1,000 ms', async () => {
    expect(1_000).toBeGreaterThan(POLL_TALLY_SLOW_ANSWER_MS);
    const chain = fakeChain({ [new URL(OFFICIAL).host]: () => ({ bodyAfterMs: 1_000 }) });
    const { deps } = tallyDepsOn(chain);
    expect(await tallyPoll(deps, pastPoll)).toEqual({ outcome: 'done', step: null });
    expect(chain.sent(OFFICIAL)).toBe(1);
  }, 20_000);

  it('never marks a slow third party: official at 429, publicnode answering the head read after 1,000 ms', async () => {
    const chain = fakeChain({
      [new URL(OFFICIAL).host]: () => '429',
      [new URL(PUBLICNODE).host]: (n) => (n === 1 ? { slowMs: 1_000 } : 'ok'),
    });
    const { deps } = tallyDepsOn(chain);
    expect(await tallyPoll(deps, pastPoll)).toEqual({ outcome: 'done', step: null });
    expect(chain.sent(PUBLICNODE)).toBe(POLL_TALLY_MAX_CHAIN_READS);
    expect(chain.sent(DRPC)).toBe(POLL_TALLY_MAX_CHAIN_READS);
  }, 20_000);
});
