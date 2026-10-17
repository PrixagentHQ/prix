import type { HolderPoll, PollHoldingReader, PollTallyJobDeps, SocialJob, SocialJobName } from '@prix/contracts';
import {
  HOLDER_POLLS,
  POLL_PRUNE_AT,
  POLL_TALLY_FAILED_ERROR,
  SOCIAL_JOB_SKIP_AFTER_FAILURES,
  socialFailureCursor,
} from '@prix/contracts';
import { runSocialStep } from '@prix/runtime/social/index';
import { createPollTallyJob, tallyPoll } from '@prix/runtime/social/poll-tally';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDb } from '../social/support/d1.ts';
import { AT_TIER, blockChain, CLOSES, INSIDE, POLL, pollTables, seedVotes, tallyDeps, wallet } from './support.ts';

/**
 * Revision 7 of the holders contract (R4, HB1F2-SEC-1; docs/contracts/phase-6-holders.md sections 4.6, 5 "A run
 * that has reached its reads ends the step", 11 C and 12 gate 5): the real `poll_tally` job inside the real
 * `runSocialStep`, followed by the three jobs that stand behind it in the entry's list (`holders_lounge_sweep`,
 * `room_picture_sweep`, `room_prune`), each a recorder.
 *
 * A run that has called `listVoters` answers `done` to the step whatever follows, so none of the three runs in
 * that invocation; every other run keeps its answer, and an `idle` or `failed` one still hands the invocation
 * on. Each case of the first group fails against revision 3's answers (the job answering the guard's outcome).
 */

const poll = HOLDER_POLLS[0] as HolderPoll;
const HEAD = 9_000;
const closesMs = Date.parse(CLOSES);
const at = (secondsAfterClose: number) => new Date(closesMs + secondsAfterClose * 1000);
/** A run in the first five minutes of an hour while the poll is open: the prune is due. */
const PRUNE_AT = new Date('2026-10-19T13:02:00.000Z');
const BEHIND: readonly SocialJobName[] = ['holders_lounge_sweep', 'room_picture_sweep', 'room_prune'];

beforeEach(async () => {
  await resetDb();
});

/** The step with `poll_tally` first and recorders for the jobs behind it; what ran behind it, in order. */
async function step(job: SocialJob, now: Date) {
  const ran: string[] = [];
  const behind: SocialJob[] = BEHIND.map((name) => ({
    name,
    run: async () => {
      ran.push(name);
      return 'idle' as const;
    },
  }));
  const result = await runSocialStep([job, ...behind], now);
  return { result, ran };
}

/** The guard's count of today's failures of `poll_tally`, as it stored it. */
function failuresOf(deps: PollTallyJobDeps): Promise<string | null> {
  return deps.reputation.getJobState(socialFailureCursor('poll_tally'));
}

/** The poll's votes as one statement writes them, with their counts (as the store's batch leaves them). */
async function fill(n: number) {
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO poll_votes (poll_id, wallet, option_id, created_at)
       SELECT ?1, printf('0x%040x', i), 'index-core', '2026-10-17T00:00:00.000Z' FROM n`,
    )
    .bind(POLL, n)
    .run();
  await db
    .prepare("INSERT INTO poll_counts (poll_id, option_id, votes) VALUES (?1, 'index-core', ?2)")
    .bind(POLL, n)
    .run();
}

/** A holding reader that answers every wallet at `tier`, at the block it is asked (the head when none). */
function everyoneAt(tier: 0 | 1, options: { gatingOn?: boolean; answerBlock?: (call: number) => number | null } = {}) {
  const calls: (number | null)[] = [];
  const holding: PollHoldingReader = {
    async tiersNow(wallets, atBlock) {
      calls.push(atBlock);
      const asked = atBlock ?? HEAD;
      return {
        gatingOn: options.gatingOn ?? true,
        tiers: wallets.map(() => tier),
        blockNumber: options.answerBlock?.(calls.length) ?? asked,
      } as never;
    },
  };
  return { holding, calls };
}

async function oneVoterTally(options: { delay?: number; gatingOn?: boolean } = {}) {
  const chain = blockChain(HEAD);
  chain.set(wallet(1), AT_TIER[1]);
  const built = tallyDeps(chain.reader, { now: () => at(120), ...options });
  await seedVotes(built.deps.polls, [{ wallet: wallet(1), option: 'index-core' }]);
  return { chain, ...built };
}

describe('revision 7: a run that has reached its reads ends the step with done', () => {
  it('a tally that wrote its result', async () => {
    const { deps } = await oneVoterTally();
    expect(await step(createPollTallyJob(deps), at(120))).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      ran: [],
    });
    expect((await pollTables()).results).not.toEqual([]);
  });

  it('a tally whose putResult answered false (already after its reads)', async () => {
    const { deps } = await oneVoterTally();
    expect((await tallyPoll(deps, poll)).outcome).toBe('done');
    const first = (await pollTables()).results;
    // Both results reads miss the frozen result, as a second run racing the first would.
    const racing: PollTallyJobDeps = { ...deps, polls: { ...deps.polls, getResults: async () => [] } };
    expect(await tallyPoll(racing, poll)).toEqual({ outcome: 'already', step: null });
    expect(await step(createPollTallyJob(racing), at(120))).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      ran: [],
    });
    expect((await pollTables()).results).toEqual(first);
  });

  it('a tally that read gating off (waiting), writing nothing', async () => {
    const { deps, lines } = await oneVoterTally({ gatingOn: false });
    expect(await step(createPollTallyJob(deps), at(120))).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      ran: [],
    });
    expect(lines.map((line) => line.event)).toContain('poll_tally_waiting');
    expect((await pollTables()).results).toEqual([]);
  });

  const failures: {
    step: 'list' | 'read' | 'block' | 'write';
    arrange: (built: Awaited<ReturnType<typeof oneVoterTally>>) => PollTallyJobDeps;
  }[] = [
    {
      step: 'list',
      arrange: ({ deps }) => ({
        ...deps,
        polls: {
          ...deps.polls,
          listVoters: async () => {
            throw new Error('d1 down');
          },
        },
      }),
    },
    {
      step: 'read',
      arrange: ({ deps, chain }) => {
        chain.state.fail = () => new Error('rpc down');
        return deps;
      },
    },
    {
      step: 'block',
      arrange: ({ deps, chain }) => {
        // The head read, then the page at the pinned block answered one block later.
        chain.state.answerBlock = (call, asked) => (call === 2 ? asked + 1 : asked);
        return deps;
      },
    },
    {
      step: 'write',
      arrange: ({ deps }) => ({
        ...deps,
        polls: {
          ...deps.polls,
          putResult: async () => {
            throw new Error('d1 down');
          },
        },
      }),
    },
  ];
  for (const failure of failures) {
    it(`a tally that failed at ${failure.step}: logged, counted by the guard, and still done to the step`, async () => {
      const built = await oneVoterTally();
      const deps = failure.arrange(built);
      expect(await step(createPollTallyJob(deps), at(120))).toEqual({
        result: { ran: 'poll_tally', outcome: 'done' },
        ran: [],
      });
      expect(built.lines.find((line) => line.event === 'poll_tally_failed')?.data).toMatchObject({
        poll: POLL,
        step: failure.step,
      });
      expect(built.lines.find((line) => line.event === 'social_job_failed')?.data).toMatchObject({
        job: 'poll_tally',
        error: POLL_TALLY_FAILED_ERROR,
      });
      expect(JSON.parse((await failuresOf(deps)) ?? '{}')).toMatchObject({ failures: 1 });
      expect((await pollTables()).results).toEqual([]);
    });
  }

  it('a prune that deleted rows', async () => {
    await fill(POLL_PRUNE_AT);
    const { holding } = everyoneAt(0);
    const { deps } = tallyDeps(blockChain(HEAD).reader, { now: () => PRUNE_AT, holding });
    expect(await step(createPollTallyJob(deps), PRUNE_AT)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      ran: [],
    });
    expect((await pollTables()).votes).toHaveLength(0);
  });

  it('a prune that deleted none', async () => {
    await fill(POLL_PRUNE_AT);
    const { holding, calls } = everyoneAt(1);
    const built = tallyDeps(blockChain(HEAD).reader, { now: () => PRUNE_AT, holding });
    // Prix's own wallets outside the filled range (0x…09a1 and 0x…04a1 are among the 3,600), so none is pruned.
    const deps: PollTallyJobDeps = { ...built.deps, adminAddresses: [wallet(0xffff1)], houseOwners: [wallet(0xffff2)] };
    expect(await step(createPollTallyJob(deps), PRUNE_AT)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      ran: [],
    });
    expect(calls.length).toBeGreaterThan(1);
    expect((await pollTables()).votes).toHaveLength(POLL_PRUNE_AT);
  });

  it('a prune that read gating off', async () => {
    await fill(POLL_PRUNE_AT);
    const { holding } = everyoneAt(0, { gatingOn: false });
    const { deps } = tallyDeps(blockChain(HEAD).reader, { now: () => PRUNE_AT, holding });
    expect(await step(createPollTallyJob(deps), PRUNE_AT)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      ran: [],
    });
    expect((await pollTables()).votes).toHaveLength(POLL_PRUNE_AT);
  });

  it('a prune that failed at block deletes nothing and is still done to the step', async () => {
    await fill(POLL_PRUNE_AT);
    const { holding } = everyoneAt(0, { answerBlock: (call) => (call === 4 ? HEAD + 1 : null) });
    const { deps, lines } = tallyDeps(blockChain(HEAD).reader, { now: () => PRUNE_AT, holding });
    expect(await step(createPollTallyJob(deps), PRUNE_AT)).toEqual({
      result: { ran: 'poll_tally', outcome: 'done' },
      ran: [],
    });
    expect(lines.find((line) => line.event === 'poll_tally_failed')?.data).toMatchObject({ step: 'block' });
    expect((await pollTables()).votes).toHaveLength(POLL_PRUNE_AT);
  });
});

describe('revision 7: every other run keeps its answer and hands the invocation on', () => {
  it('idle with no read before the close', async () => {
    const chain = blockChain(HEAD);
    const { deps } = tallyDeps(chain.reader, { now: () => new Date(INSIDE) });
    await seedVotes(deps.polls, [{ wallet: wallet(1), option: 'index-core' }]);
    expect(await step(createPollTallyJob(deps), new Date(INSIDE))).toEqual({
      result: { ran: null, outcome: 'idle' },
      ran: [...BEHIND],
    });
    expect(chain.calls).toEqual([]);
  });

  it('open before close + 60 s + d', async () => {
    const { deps, chain } = await oneVoterTally({ delay: 3_000 });
    expect(await step(createPollTallyJob(deps), at(120))).toEqual({
      result: { ran: null, outcome: 'idle' },
      ran: [...BEHIND],
    });
    expect(chain.calls).toEqual([]);
  });

  it('a failure at the job’s own results read stays failed', async () => {
    const { deps, chain } = await oneVoterTally();
    const broken: PollTallyJobDeps = {
      ...deps,
      polls: {
        ...deps.polls,
        getResults: async () => {
          throw new Error('d1 down');
        },
      },
    };
    expect(await step(createPollTallyJob(broken), at(120))).toEqual({
      result: { ran: 'poll_tally', outcome: 'failed' },
      ran: [...BEHIND],
    });
    expect(chain.calls).toEqual([]);
  });

  it('a failure at the tally’s results read (step 2) stays failed', async () => {
    const { deps, chain, lines } = await oneVoterTally();
    let reads = 0;
    const broken: PollTallyJobDeps = {
      ...deps,
      polls: {
        ...deps.polls,
        getResults: async (ids) => {
          reads += 1;
          if (reads === 2) throw new Error('d1 down');
          return deps.polls.getResults(ids);
        },
      },
    };
    expect(await step(createPollTallyJob(broken), at(120))).toEqual({
      result: { ran: 'poll_tally', outcome: 'failed' },
      ran: [...BEHIND],
    });
    expect(lines.find((line) => line.event === 'poll_tally_failed')?.data).toMatchObject({ step: 'results' });
    expect(chain.calls).toEqual([]);
  });

  it('a failure at the delay’s read (step 1) stays failed', async () => {
    const { deps, chain } = await oneVoterTally();
    const broken: PollTallyJobDeps = {
      ...deps,
      tallyDelaySeconds: async () => {
        throw new Error('no secret');
      },
    };
    expect(await step(createPollTallyJob(broken), at(120))).toEqual({
      result: { ran: 'poll_tally', outcome: 'failed' },
      ran: [...BEHIND],
    });
    expect(chain.calls).toEqual([]);
  });

  it('the purge: more while it deletes, then idle', async () => {
    const { deps } = await oneVoterTally();
    expect((await tallyPoll(deps, poll)).outcome).toBe('done');
    const job = createPollTallyJob(deps);
    expect(await step(job, at(420))).toEqual({ result: { ran: 'poll_tally', outcome: 'more' }, ran: [] });
    expect(await step(job, at(720))).toEqual({ result: { ran: null, outcome: 'idle' }, ran: [...BEHIND] });
  });

  it('a prune whose sum is below POLL_PRUNE_AT stays idle', async () => {
    await fill(POLL_PRUNE_AT - 1);
    const { holding, calls } = everyoneAt(0);
    const { deps } = tallyDeps(blockChain(HEAD).reader, { now: () => PRUNE_AT, holding });
    expect(await step(createPollTallyJob(deps), PRUNE_AT)).toEqual({
      result: { ran: null, outcome: 'idle' },
      ran: [...BEHIND],
    });
    expect(calls).toEqual([]);
  });

  it('a prune whose castCounts failed stays failed', async () => {
    await fill(POLL_PRUNE_AT);
    const { holding, calls } = everyoneAt(0);
    const built = tallyDeps(blockChain(HEAD).reader, { now: () => PRUNE_AT, holding });
    const broken: PollTallyJobDeps = {
      ...built.deps,
      polls: {
        ...built.deps.polls,
        castCounts: async () => {
          throw new Error('d1 down');
        },
      },
    };
    expect(await step(createPollTallyJob(broken), PRUNE_AT)).toEqual({
      result: { ran: 'poll_tally', outcome: 'failed' },
      ran: [...BEHIND],
    });
    expect(calls).toEqual([]);
  });

  it('a run the skip gate stopped, after three failed runs that each answered done, stays idle', async () => {
    const { deps, chain, lines } = await oneVoterTally();
    chain.state.fail = () => new Error('rpc down');
    const job = createPollTallyJob(deps);
    for (let run = 0; run < SOCIAL_JOB_SKIP_AFTER_FAILURES; run += 1) {
      expect((await step(job, at(120 + run * 300))).result).toEqual({ ran: 'poll_tally', outcome: 'done' });
    }
    expect(JSON.parse((await failuresOf(deps)) ?? '{}')).toMatchObject({ failures: SOCIAL_JOB_SKIP_AFTER_FAILURES });
    const before = chain.calls.length;
    expect(await step(job, at(120 + SOCIAL_JOB_SKIP_AFTER_FAILURES * 300))).toEqual({
      result: { ran: null, outcome: 'idle' },
      ran: [...BEHIND],
    });
    expect(chain.calls.length).toBe(before);
    expect(lines.map((line) => line.event)).toContain('social_job_skipped');
  });
});
