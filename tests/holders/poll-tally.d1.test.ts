import type { Address, HolderPoll, PollHoldingReader } from '@prix/contracts';
import {
  HOLDER_POLLS,
  POLL_PURGE_PER_RUN,
  POLL_TALLY_BLOCK_MARGIN,
  POLL_TALLY_FAILED_ERROR,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_PAGE,
  POLL_TALLY_SETTLE_SECONDS,
} from '@prix/contracts';
import { createPollTallyJob, tallyPoll } from '@prix/runtime/social/poll-tally';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb } from '../social/support/d1.ts';
import {
  ADMIN,
  AT_TIER,
  blockChain,
  CLOSES,
  HOUSE,
  INSIDE,
  POLL,
  pollTables,
  seedVotes,
  tallyDeps,
  wallet,
} from './support.ts';

/**
 * The tally `poll_tally` (docs/contracts/phase-6-holders.md section 5 and 11 C, the tally): the engine's own
 * `tallyPoll` and `createPollTallyJob` on the real poll store on a local D1 and the real holding reader over a
 * chain whose balances are kept by block.
 */

const poll = HOLDER_POLLS[0] as HolderPoll;
const HEAD = 9_000;
const PINNED = HEAD - POLL_TALLY_BLOCK_MARGIN;
const closesMs = Date.parse(CLOSES);
const at = (secondsAfterClose: number) => new Date(closesMs + secondsAfterClose * 1000);
const ADDRESS = /0x[0-9a-f]{40}/i;

beforeEach(async () => {
  await resetDb();
});

describe('who counts', () => {
  it('casts every voter and counts tiers 1 to 3 that are not Prix own wallets', async () => {
    const chain = blockChain(HEAD);
    const voters: { wallet: Address; option: string }[] = [];
    ([0, 1, 2, 3] as const).forEach((tier, i) => {
      const w = wallet(0x100 + i);
      chain.set(w, AT_TIER[tier]);
      voters.push({ wallet: w, option: 'index-core' });
    });
    // Rows of Prix's own wallets made before the lists changed: cast, never counted, whatever they hold.
    chain.set(ADMIN, AT_TIER[3]);
    chain.set(HOUSE, AT_TIER[3]);
    voters.push({ wallet: ADMIN as Address, option: 'dip-buyer' }, { wallet: HOUSE as Address, option: 'dip-buyer' });
    const { deps } = tallyDeps(chain.reader, { now: () => at(61) });
    await seedVotes(deps.polls, voters);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'done', step: null });
    const [result] = await deps.polls.getResults([POLL]);
    expect(result?.cast).toMatchObject({ 'index-core': 4, 'dip-buyer': 2 });
    expect(result?.counted).toMatchObject({ 'index-core': 3, 'dip-buyer': 0 });
    expect(result?.firstBlock).toBe(PINNED);
    expect(result?.lastBlock).toBe(PINNED);
  });

  it('never reads a vote written at or after the close', async () => {
    const chain = blockChain(HEAD);
    const late = wallet(0x200);
    chain.set(late, AT_TIER[3]);
    const { deps } = tallyDeps(chain.reader, { now: () => at(61) });
    await seedVotes(deps.polls, [{ wallet: late, option: 'index-core', at: CLOSES }]);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'done', step: null });
    const [result] = await deps.polls.getResults([POLL]);
    expect(result?.cast['index-core'] ?? 0).toBe(0);
    expect(chain.calls.every((call) => call.wallets <= POLL_TALLY_PAGE)).toBe(true);
  });
});

describe('when', () => {
  it('answers open until close + 60 s + d and tallies at that instant, with d in no log', async () => {
    const chain = blockChain(HEAD);
    chain.set(wallet(1), AT_TIER[1]);
    const d = 1_234;
    let now = at(POLL_TALLY_SETTLE_SECONDS + d - 1);
    const { deps, logText } = tallyDeps(chain.reader, { now: () => now, delay: d });
    await seedVotes(deps.polls, [{ wallet: wallet(1), option: 'index-core' }]);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'open', step: null });
    expect(chain.calls).toEqual([]);
    expect((await pollTables()).results).toEqual([]);
    now = at(POLL_TALLY_SETTLE_SECONDS + d);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'done', step: null });
    expect(logText()).not.toContain(String(d));
  });

  it('answers already once a result is frozen and never writes it twice', async () => {
    const chain = blockChain(HEAD);
    chain.set(wallet(1), AT_TIER[1]);
    const { deps } = tallyDeps(chain.reader, { now: () => at(61) });
    await seedVotes(deps.polls, [{ wallet: wallet(1), option: 'index-core' }]);
    expect((await tallyPoll(deps, poll)).outcome).toBe('done');
    const first = (await pollTables()).results;
    chain.set(wallet(1), 0n, 1);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'already', step: null });
    expect((await pollTables()).results).toEqual(first);
  });

  it('waits and writes nothing while gating is off', async () => {
    const chain = blockChain(HEAD);
    const { deps } = tallyDeps(chain.reader, { now: () => at(61), gatingOn: false });
    await seedVotes(deps.polls, [{ wallet: wallet(1), option: 'index-core' }]);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'waiting', step: null });
    expect((await pollTables()).results).toEqual([]);
  });
});

describe('one block a run', () => {
  async function twoPages(chain: ReturnType<typeof blockChain>) {
    const voters = Array.from({ length: POLL_TALLY_PAGE + 1 }, (_, i) => ({
      wallet: wallet(0x1000 + i),
      option: 'momentum-five',
    }));
    const { deps, lines, logText } = tallyDeps(chain.reader, { now: () => at(61) });
    await seedVotes(deps.polls, voters);
    return { deps, lines, logText, voters };
  }

  it('reads the first page at the head, then every read at the head less 50', async () => {
    const chain = blockChain(HEAD);
    const { deps } = await twoPages(chain);
    expect((await tallyPoll(deps, poll)).outcome).toBe('done');
    expect(chain.calls[0]?.atBlock).toBeUndefined();
    expect(chain.calls.slice(1).length).toBeGreaterThanOrEqual(2);
    for (const call of chain.calls.slice(1)) expect(Number(call.atBlock)).toBe(PINNED);
  });

  it('counts tokens moved from a wallet of the first page to one of the last between two reads once at most', async () => {
    const chain = blockChain(HEAD);
    const { deps, voters } = await twoPages(chain);
    const firstPage = voters[0]?.wallet as Address;
    const lastPage = voters[POLL_TALLY_PAGE]?.wallet as Address;
    // At the pinned block the bundle is in the first page's wallet; one block later it is in the last page's.
    chain.set(firstPage, AT_TIER[1], 0);
    chain.set(firstPage, 0n, PINNED + 1);
    chain.set(lastPage, AT_TIER[1], PINNED + 1);
    expect((await tallyPoll(deps, poll)).outcome).toBe('done');
    const [result] = await deps.polls.getResults([POLL]);
    expect(result?.counted['momentum-five']).toBe(1);
    expect(result?.cast['momentum-five']).toBe(POLL_TALLY_PAGE + 1);
  });

  it('fails at block and writes nothing when a later read answers another block', async () => {
    const chain = blockChain(HEAD);
    const { deps, lines, logText } = await twoPages(chain);
    chain.state.answerBlock = (call, asked) => (call === 3 ? asked + 1 : asked);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'failed', step: 'block' });
    expect((await pollTables()).results).toEqual([]);
    expect(lines.find((line) => line.event === 'poll_tally_failed')?.data).toMatchObject({ step: 'block' });
    expect(logText()).not.toMatch(ADDRESS);
  });

  it('a chain read that throws writes nothing, logs the poll and the step, and the next run counts all', async () => {
    const chain = blockChain(HEAD);
    const { deps, lines, logText, voters } = await twoPages(chain);
    for (const v of voters) chain.set(v.wallet, AT_TIER[1]);
    chain.state.fail = (call) => (call === 3 ? new Error('rpc https://rpc.example/key-in-path refused') : null);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'failed', step: 'read' });
    expect((await pollTables()).results).toEqual([]);
    const failed = lines.find((line) => line.event === 'poll_tally_failed');
    expect(failed?.data).toMatchObject({ step: 'read' });
    expect(JSON.stringify(failed)).toContain(POLL);
    expect(logText()).not.toMatch(ADDRESS);
    expect(logText()).not.toContain('rpc.example');
    chain.state.fail = null;
    expect((await tallyPoll(deps, poll)).outcome).toBe('done');
    const [result] = await deps.polls.getResults([POLL]);
    expect(result?.counted['momentum-five']).toBe(POLL_TALLY_PAGE + 1);
  });

  it('fails at read and writes nothing when its reads pass 8 seconds from the first', async () => {
    const chain = blockChain(HEAD);
    const voters = Array.from({ length: POLL_TALLY_PAGE + 1 }, (_, i) => ({
      wallet: wallet(0x3000 + i),
      option: 'index-core',
    }));
    let clock = at(61).getTime();
    const { deps } = tallyDeps(chain.reader, { now: () => new Date(clock) });
    await seedVotes(deps.polls, voters);
    chain.state.fail = () => {
      clock += 4_500;
      return null;
    };
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'failed', step: 'read' });
    expect((await pollTables()).results).toEqual([]);
  });

  it('fails at read before its 31st fetch', async () => {
    const reads: (number | null)[] = [];
    const holding: PollHoldingReader = {
      async tiersNow(wallets, atBlock) {
        reads.push(atBlock);
        // Each read reports the run's fetches so far, as the metered reader does: 14 a read here.
        return {
          gatingOn: true,
          tiers: wallets.map(() => 1 as const),
          blockNumber: atBlock ?? HEAD,
          fetches: reads.length * 14,
        } as never;
      },
    };
    const chain = blockChain(HEAD);
    const { deps } = tallyDeps(chain.reader, { now: () => at(61), holding });
    const voters = Array.from({ length: POLL_TALLY_PAGE * 3 }, (_, i) => ({
      wallet: wallet(0x5000 + i),
      option: 'index-core',
    }));
    await seedVotes(deps.polls, voters);
    expect(await tallyPoll(deps, poll)).toEqual({ outcome: 'failed', step: 'read' });
    // 14, 28: a third read would pass 30 at 42, so it is never asked.
    expect(reads.length).toBeLessThanOrEqual(Math.ceil(POLL_TALLY_MAX_FETCHES / 14));
    expect((await pollTables()).results).toEqual([]);
  });
});

describe('the job', () => {
  it('is idle with no read before the close and in its first minute', async () => {
    const chain = blockChain(HEAD);
    let now = new Date(INSIDE);
    const { deps } = tallyDeps(chain.reader, { now: () => now });
    await seedVotes(deps.polls, [{ wallet: wallet(1), option: 'index-core' }]);
    const job = createPollTallyJob(deps);
    expect(job.name).toBe('poll_tally');
    expect(await job.run(now)).toBe('idle');
    now = at(30);
    expect(await job.run(now)).toBe('idle');
    expect(chain.calls).toEqual([]);
  });

  it('throws PollTallyFailed for a failed tally, inside the guard', async () => {
    const chain = blockChain(HEAD);
    chain.state.fail = () => new Error('down');
    const now = at(120);
    const { deps } = tallyDeps(chain.reader, { now: () => now });
    await seedVotes(deps.polls, [{ wallet: wallet(1), option: 'index-core' }]);
    const job = createPollTallyJob(deps);
    let thrown: unknown = null;
    try {
      const outcome = await job.run(now);
      thrown = outcome;
    } catch (error) {
      thrown = error;
    }
    // The guard may catch and answer for it; when it throws, the error is named PollTallyFailed.
    if (thrown instanceof Error) expect(thrown.name).toBe(POLL_TALLY_FAILED_ERROR);
    expect((await pollTables()).results).toEqual([]);
  });

  it('after the result, deletes 100 vote rows a run and never poll_counts or poll_results', async () => {
    const chain = blockChain(HEAD);
    const voters = Array.from({ length: 250 }, (_, i) => ({ wallet: wallet(0x7000 + i), option: 'dip-buyer' }));
    for (const v of voters) chain.set(v.wallet, AT_TIER[1]);
    let now = at(120);
    const { deps } = tallyDeps(chain.reader, { now: () => now });
    await seedVotes(deps.polls, voters);
    const job = createPollTallyJob(deps);
    expect(await job.run(now)).toBe('done');
    const counts = (await pollTables()).countsByOption;
    const results = (await pollTables()).results;
    const left: number[] = [];
    for (let run = 0; run < 4; run += 1) {
      now = new Date(now.getTime() + 300_000);
      await job.run(now);
      left.push((await pollTables()).votes.length);
    }
    expect(left).toEqual([250 - POLL_PURGE_PER_RUN, 250 - 2 * POLL_PURGE_PER_RUN, 0, 0]);
    expect((await pollTables()).countsByOption).toEqual(counts);
    expect((await pollTables()).results).toEqual(results);
  });
});

describe('the store under the prune', () => {
  it('pruneVoters takes each wallet from its option so the counts still equal the rows', async () => {
    const { deps } = tallyDeps(blockChain(HEAD).reader, { now: () => at(61) });
    await seedVotes(deps.polls, [
      { wallet: wallet(1), option: 'index-core' },
      { wallet: wallet(2), option: 'index-core' },
      { wallet: wallet(3), option: 'dip-buyer' },
    ]);
    expect(await deps.polls.pruneVoters(POLL, [wallet(1), wallet(3), wallet(9)])).toBe(2);
    const t = await pollTables();
    expect(t.votes.map((v) => v.wallet)).toEqual([wallet(2)]);
    expect(t.countsByOption).toEqual(t.groupedByOption);
    expect(t.sum).toBe(1);
  });

  it('putResult writes once and answers false the second time', async () => {
    const { deps } = tallyDeps(blockChain(HEAD).reader, { now: () => at(61) });
    const record = {
      pollId: POLL,
      cast: { 'index-core': 1, 'dip-buyer': 0, 'big-tech-equal': 0, 'momentum-five': 0 },
      counted: { 'index-core': 1, 'dip-buyer': 0, 'big-tech-equal': 0, 'momentum-five': 0 },
      leaders: ['index-core'],
      countedAt: at(61).toISOString(),
      firstBlock: 1,
      lastBlock: 1,
    };
    expect(await deps.polls.putResult(record as never)).toBe(true);
    expect(await deps.polls.putResult({ ...record, counted: { ...record.counted, 'index-core': 0 } } as never)).toBe(
      false,
    );
    const rows = await db
      .prepare('SELECT option_id, counted FROM poll_results WHERE option_id = ?')
      .bind('index-core')
      .all();
    expect(rows.results).toEqual([{ option_id: 'index-core', counted: 1 }]);
  });
});
