import type {
  Address,
  CreatePollTallyJob,
  CreatePollTallyJobFor,
  HolderPoll,
  IsoTime,
  PollTallyFailStep,
  PollTallyJobDeps,
  PollTallyOutcome,
  PollTiersRead,
  SocialJobOutcome,
  TallyPoll,
  Tier,
} from '@prix/contracts';
import {
  HOLDER_POLLS,
  openPollAt,
  POLL_MIN_TIER,
  POLL_PRUNE_AT,
  POLL_PURGE_MAX_POLLS,
  POLL_PURGE_PER_RUN,
  POLL_TALLY_BLOCK_MARGIN,
  POLL_TALLY_DELAY_MODULO_SECONDS,
  POLL_TALLY_FAILED_ERROR,
  POLL_TALLY_JOB_OUTCOMES,
  POLL_TALLY_MAX_CHAIN_READS,
  POLL_TALLY_MAX_FETCHES,
  POLL_TALLY_MAX_PAGES,
  POLL_TALLY_MAX_RUN_SECONDS,
  POLL_TALLY_PAGE,
  POLL_TALLY_SETTLE_SECONDS,
  pollExpiredLogDue,
  pollLeaders,
  pollPruneDue,
  pollsToTallyAt,
  pollsWatchedAt,
  pollTallyDueAt,
  pollTallyExpired,
  pollTallyStepAnswer,
  pollWalletExcluded,
} from '@prix/contracts';
import { guardSocialJob, logSafe } from './common.ts';

/**
 * The holders' poll tally (docs/contracts/phase-6-holders.md section 5, revision 4): `tallyPoll` counts one
 * closed poll whole in one run or writes nothing, and `createPollTallyJob` is the social job `poll_tally` that
 * runs it after the close, then purges the counted poll's votes, and prunes the open poll of wallets that no
 * longer hold. The admin route `POST /api/admin/polls/:id/tally` takes `tallyPoll`'s same path.
 *
 * Every chain read of a run is at one block: the first read is at the head, the run's block is that head less
 * POLL_TALLY_BLOCK_MARGIN, the first page is read again there, and every later page is read there; an answer at
 * another block fails the run at `block`. A run reads at most POLL_TALLY_MAX_CHAIN_READS times, sends at most
 * POLL_TALLY_MAX_FETCHES fetches (the holding reader counts them, see token/poll-holding.ts), and fails at
 * `read` once its reads pass POLL_TALLY_MAX_RUN_SECONDS from the first. No line it logs holds an address, and
 * the tally's delay d is never logged.
 */

const JOB = 'poll_tally';

/** The error the job throws inside its guard for a failed tally or prune (revision 3, HB-5). */
export class PollTallyFailed extends Error {
  readonly step: PollTallyFailStep;

  constructor(step: PollTallyFailStep) {
    super(`The poll tally failed at ${step}.`);
    this.name = POLL_TALLY_FAILED_ERROR;
    this.step = step;
  }
}

type TallyDeps = PollTallyJobDeps;

interface TieredVoter {
  wallet: Address;
  option: string;
  tier: Tier;
}

/**
 * What a run's reads give. `readMs` (revision 8b, R8-SEC-3; revision 8c, CR8B-4) is the whole milliseconds from
 * the start of the run's first `tiersNow` call to the end of its last one or to the failure, null while no
 * `tiersNow` call has started. `chainRead` is true once the run has called `tiersNow` (revision 8f, R8E-B4: the job
 * tells F3's `waiting` from gating's by it). `noVoter` is F3's `waiting` (revision 8e, R8D-SEC-5): the first
 * `listVoters` page held no voter while polls are switched off, and no chain read was made.
 */
type VoterRead =
  | { kind: 'read'; voters: TieredVoter[]; block: number; readMs: number | null }
  | { kind: 'waiting'; readMs: number | null; noVoter: boolean }
  | { kind: 'failed'; step: PollTallyFailStep; readMs: number | null };

/**
 * Called once before a run's first `listVoters` (revision 7, R4, HB1F2-SEC-1): from then on the run has
 * reached its reads, and the job answers `done` to the social step whatever follows (`pollTallyStepAnswer`).
 */
type ReachedReads = () => void;

const noMark: ReachedReads = () => {};

/** The log line's fields of a run's read time: `readMs` only when a `tiersNow` call has started. */
const withReadMs = (
  data: Record<string, string | number | boolean | null>,
  readMs: number | null,
): Record<string, string | number | boolean | null> => (readMs === null ? data : { ...data, readMs });

/**
 * Reads every voter of a poll written before `before` and its tier, at one block (section 5 step 3). The
 * pages go by wallet order, POLL_TALLY_PAGE a page, at most POLL_TALLY_MAX_PAGES; the last page may only find
 * the end. Nothing is written here. `reached` is called before the first `listVoters`, so a list that throws
 * has reached its reads too. `waitOnNoVoter` (the tally's, revision 8e F3): a first page with no voter answers
 * `waiting` with no chain read.
 */
async function readVoterTiers(
  deps: TallyDeps,
  pollId: string,
  before: IsoTime,
  reached: ReachedReads,
  waitOnNoVoter: boolean,
): Promise<VoterRead> {
  reached();
  const voters: TieredVoter[] = [];
  let block: number | null = null;
  let reads = 0;
  let fetches = 0;
  let started: number | null = null;
  let ended: number | null = null;

  const readMs = (): number | null =>
    started === null ? null : Math.max(0, Math.floor((ended ?? deps.now().getTime()) - started));
  const failedRead = (step: PollTallyFailStep): VoterRead => ({ kind: 'failed', step, readMs: readMs() });

  /** One `tiersNow`, inside the run's bounds of reads, fetches and seconds. */
  const tiersAt = async (
    wallets: readonly Address[],
    atBlock: number | null,
  ): Promise<{ ok: true; read: PollTiersRead } | { ok: false; result: VoterRead }> => {
    if (reads >= POLL_TALLY_MAX_CHAIN_READS || fetches >= POLL_TALLY_MAX_FETCHES) {
      return { ok: false, result: failedRead('read') };
    }
    const start = deps.now().getTime();
    if (started === null) started = start;
    let read: PollTiersRead & { fetches?: unknown };
    try {
      read = await deps.holding.tiersNow(wallets, atBlock);
    } catch {
      ended = deps.now().getTime();
      return { ok: false, result: failedRead('read') };
    }
    ended = deps.now().getTime();
    reads += 1;
    if (typeof read.fetches === 'number' && Number.isFinite(read.fetches)) fetches = read.fetches;
    // The run fails at `read` once its reads pass POLL_TALLY_MAX_RUN_SECONDS from the start of its first call.
    if (ended - started > POLL_TALLY_MAX_RUN_SECONDS * 1000) {
      return { ok: false, result: failedRead('read') };
    }
    if (read.gatingOn !== true) return { ok: false, result: { kind: 'waiting', readMs: readMs(), noVoter: false } };
    if (!Array.isArray(read.tiers) || read.tiers.length !== wallets.length) {
      return { ok: false, result: failedRead('read') };
    }
    if (!Number.isSafeInteger(read.blockNumber) || read.blockNumber < 0)
      return { ok: false, result: failedRead('read') };
    return { ok: true, read };
  };

  /** The head read: the run's block is its block less the margin. */
  const pinBlock = async (wallets: readonly Address[]): Promise<number | VoterRead> => {
    const head = await tiersAt(wallets, null);
    if (!head.ok) return head.result;
    const pinned = head.read.blockNumber - POLL_TALLY_BLOCK_MARGIN;
    return pinned < 0 ? failedRead('read') : pinned;
  };

  let after: Address | null = null;
  for (let page = 1; page <= POLL_TALLY_MAX_PAGES; page += 1) {
    let listed: Awaited<ReturnType<TallyDeps['polls']['listVoters']>>;
    try {
      listed = await deps.polls.listVoters(pollId, after, before, POLL_TALLY_PAGE);
    } catch {
      return failedRead('list');
    }
    // F3 (revision 8e, R8D-SEC-5): while polls are switched off, a first page with no voter reads no chain.
    if (listed.length === 0 && page === 1 && waitOnNoVoter && deps.pollsEnabled !== true) {
      return { kind: 'waiting', readMs: null, noVoter: true };
    }
    if (listed.length === 0) break;
    // More voters than one run can read (the cap keeps it from happening): count nothing rather than part.
    if (page === POLL_TALLY_MAX_PAGES || listed.length > POLL_TALLY_PAGE) return failedRead('list');
    const wallets = listed.map((voter) => voter.wallet);
    let at: number;
    if (block === null) {
      const pinned = await pinBlock(wallets);
      if (typeof pinned !== 'number') return pinned;
      at = pinned;
      block = pinned;
    } else {
      at = block;
    }
    const answer = await tiersAt(wallets, at);
    if (!answer.ok) return answer.result;
    if (answer.read.blockNumber !== at) return failedRead('block');
    listed.forEach((voter, index) => {
      voters.push({ wallet: voter.wallet, option: voter.option, tier: answer.read.tiers[index] as Tier });
    });
    after = listed[listed.length - 1]?.wallet ?? after;
    if (listed.length < POLL_TALLY_PAGE) break;
  }
  if (block === null) {
    // No voter: one read at the head still says whether gating is on and which block the result names.
    const pinned = await pinBlock([]);
    if (typeof pinned !== 'number') return pinned;
    block = pinned;
  }
  return { kind: 'read', voters, block, readMs: readMs() };
}

/** A vote that counts: its wallet holds tier 1 or above at the run's block and is not a wallet of Prix's own. */
function counts(deps: TallyDeps, voter: TieredVoter): boolean {
  return voter.tier >= POLL_MIN_TIER && !pollWalletExcluded(voter.wallet, deps.adminAddresses, deps.houseOwners);
}

const OPEN: PollTallyOutcome = { outcome: 'open', step: null };

/**
 * One tally of one poll (section 5, steps 1 to 4). Never throws: a failure logs `poll_tally_failed` with the
 * poll's id and the step and answers `{ outcome: 'failed', step }`, having written nothing.
 */
export const tallyPoll: TallyPoll = async (deps, poll) => (await tallyPollRun(deps, poll, noMark)).outcome;

/**
 * `tallyPoll` with the job's mark of a run that has reached its reads (revision 7). `chainRead` is false only for
 * F3's `waiting` (revision 8e; revision 8f, R8E-B4: told from gating's `waiting` by the run's chain read), which the
 * job answers `idle` and falls through (R8E-SEC-3).
 */
async function tallyPollRun(
  deps: TallyDeps,
  poll: HolderPoll,
  reached: ReachedReads,
): Promise<{ outcome: PollTallyOutcome; noVoterWait: boolean }> {
  const run = await tallyPollSteps(deps, poll, reached);
  return 'noVoterWait' in run ? run : { outcome: run, noVoterWait: false };
}

async function tallyPollSteps(
  deps: TallyDeps,
  poll: HolderPoll,
  reached: ReachedReads,
): Promise<PollTallyOutcome | { outcome: PollTallyOutcome; noVoterWait: true }> {
  const failed = (step: PollTallyFailStep, readMs: number | null = null): PollTallyOutcome => {
    logSafe(deps, 'poll_tally_failed', withReadMs({ poll: poll.id, step }, readMs));
    return { outcome: 'failed', step };
  };
  try {
    // 1. Not before the close + POLL_TALLY_SETTLE_SECONDS + d. d is read only once the settle has passed.
    const now = deps.now();
    if (now.getTime() < Date.parse(poll.closesAt) + POLL_TALLY_SETTLE_SECONDS * 1000) return OPEN;
    let delay: number;
    try {
      delay = await deps.tallyDelaySeconds(poll.id);
    } catch {
      return failed('read');
    }
    if (!Number.isSafeInteger(delay) || delay < 0 || delay >= POLL_TALLY_DELAY_MODULO_SECONDS) return failed('read');
    if (!pollTallyDueAt(poll, now, delay)) return OPEN;

    // 2. A result there answers `already`.
    let present: boolean;
    try {
      present = (await deps.polls.getResults([poll.id])).some((result) => result.pollId === poll.id);
    } catch {
      return failed('results');
    }
    if (present) return { outcome: 'already', step: null };

    // 3. Every voter written before the close, at one block.
    const run = await readVoterTiers(deps, poll.id, poll.closesAt, reached, true);
    if (run.kind === 'waiting') {
      logSafe(deps, 'poll_tally_waiting', { poll: poll.id });
      const waiting: PollTallyOutcome = { outcome: 'waiting', step: null };
      return run.noVoter ? { outcome: waiting, noVoterWait: true } : waiting;
    }
    if (run.kind === 'failed') return failed(run.step, run.readMs);

    // 4. Cast and counted by option, every option of the poll present, zeros included.
    const cast: Record<string, number> = {};
    const counted: Record<string, number> = {};
    for (const option of poll.options) {
      cast[option.id] = 0;
      counted[option.id] = 0;
    }
    let total = 0;
    let voters = 0;
    for (const voter of run.voters) {
      if (!(voter.option in cast)) continue;
      voters += 1;
      cast[voter.option] = (cast[voter.option] ?? 0) + 1;
      if (counts(deps, voter)) {
        counted[voter.option] = (counted[voter.option] ?? 0) + 1;
        total += 1;
      }
    }
    let written: boolean;
    try {
      written = await deps.polls.putResult({
        pollId: poll.id,
        cast,
        counted,
        leaders: pollLeaders(poll, counted),
        countedAt: deps.now().toISOString(),
        firstBlock: run.block,
        lastBlock: run.block,
      });
    } catch {
      return failed('write', run.readMs);
    }
    if (!written) return { outcome: 'already', step: null };
    logSafe(deps, 'poll_tallied', withReadMs({ poll: poll.id, voters, counted: total }, run.readMs));
    return { outcome: 'done', step: null };
  } catch {
    // Every step above names its own failure; this only keeps the promise that nothing throws.
    return failed('read');
  }
}

/**
 * Prune while open (section 5, revision 3, H2-SEC-1): from POLL_PRUNE_AT votes, in the first five minutes of
 * an hour, every voter is read at one block by the tally's own path and the votes of wallets below tier 1 or of
 * Prix's own are deleted in one `pruneVoters` after the last page. `done` when a row was deleted, `idle`
 * otherwise; a failure logs `poll_tally_failed` with its step and throws `PollTallyFailed`. Once its reads
 * have begun, the job turns `idle` and `failed` into `done` for the step (revision 7, `pollTallyStepAnswer`).
 */
async function prune(deps: TallyDeps, poll: HolderPoll, now: Date, reached: ReachedReads): Promise<SocialJobOutcome> {
  const fail = (step: PollTallyFailStep, readMs: number | null = null): never => {
    logSafe(deps, 'poll_tally_failed', withReadMs({ poll: poll.id, step }, readMs));
    throw new PollTallyFailed(step);
  };
  let sum = 0;
  try {
    const cast = await deps.polls.castCounts(poll.id);
    for (const value of Object.values(cast)) if (Number.isSafeInteger(value) && value > 0) sum += value;
  } catch {
    return fail('list');
  }
  if (sum < POLL_PRUNE_AT) return 'idle';

  const run = await readVoterTiers(deps, poll.id, now.toISOString(), reached, false);
  if (run.kind === 'waiting') {
    logSafe(deps, 'poll_tally_waiting', { poll: poll.id });
    return 'idle';
  }
  if (run.kind === 'failed') return fail(run.step, run.readMs);

  const gone = run.voters.filter((voter) => !counts(deps, voter)).map((voter) => voter.wallet);
  if (gone.length === 0) return 'idle';
  let deleted: number;
  try {
    deleted = await deps.polls.pruneVoters(poll.id, gone);
  } catch {
    return fail('write', run.readMs);
  }
  if (!(deleted > 0)) return 'idle';
  logSafe(deps, 'poll_pruned', withReadMs({ poll: poll.id, deleted }, run.readMs));
  return 'done';
}

const byClose = (a: HolderPoll, b: HolderPoll): number => Date.parse(a.closesAt) - Date.parse(b.closesAt);

/**
 * The `poll_tally` social job (section 5, "The job's run"), under `guardSocialJob`:
 * 1. the polls closed at least 60 s and less than POLL_WATCH_DAYS ago; none, and no prune due: `idle` with no
 *    read at all;
 * 2. one `getResults` of those;
 * 3. the guard's skip gate, then the first that applies: (a) the oldest watched poll without a result within
 *    the lookback, tallied; (b) in the 00:00 to 00:04 UTC run only, `poll_tally_expired` for each watched poll
 *    without a result past the lookback; (c) the votes of a counted poll deleted POLL_PURGE_PER_RUN a run;
 *    (d) the prune of the open poll.
 *
 * The writer's reading of (c), reported to the operator: the purge applies only while it deletes something. The
 * watched polls with a result are tried oldest first, and a poll whose votes are gone hands the run on, so
 * that a counted poll's empty purge does not keep a later poll's purge, or the open poll's prune, from running
 * during its thirty days.
 *
 * What the step sees (revision 7, R4, HB1F2-SEC-1, section 5 "A run that has reached its reads ends the
 * step"): a flag is set before the run's first `listVoters` (the tally's step 3, or the prune once its sum is
 * at least POLL_PRUNE_AT) and read after the guard answers, and `pollTallyStepAnswer` turns the guard's
 * `idle` or `failed` into `done`, so that the jobs behind it do not run on what the reads left of the
 * invocation's subrequests. A failure is still logged and counted by the guard; every other run keeps its
 * answer.
 */
export const createPollTallyJobFor: CreatePollTallyJobFor = (deps, polls) => ({
  name: JOB,
  run: async (now) => {
    let reachedReads = false;
    const reached: ReachedReads = () => {
      reachedReads = true;
    };
    const guarded = await guardSocialJob(deps, JOB, now, async (skip) => {
      const watched = pollsWatchedAt(now, polls);
      const open = openPollAt(now, polls);
      const pruneDue = open !== null && pollPruneDue(now);
      if (watched.length === 0 && !pruneDue) return 'idle';

      const results = watched.length === 0 ? [] : await deps.polls.getResults(watched.map((poll) => poll.id));
      const counted = new Set(results.map((result) => result.pollId));
      const toTally = pollsToTallyAt(now, polls)
        .filter((poll) => !counted.has(poll.id))
        .sort(byClose);
      const expired = pollExpiredLogDue(now)
        ? watched.filter((poll) => !counted.has(poll.id) && pollTallyExpired(poll, now))
        : [];
      const purgeable = watched.filter((poll) => counted.has(poll.id)).sort(byClose);
      if (toTally.length === 0 && expired.length === 0 && purgeable.length === 0 && !pruneDue) return 'idle';

      if (await skip()) return 'idle';

      // (a) the tally of the oldest poll of pollsToTallyAt(now) without a result (within the lookback; a poll past
      // it is never tallied by the job, R8F-SEC-3). Only an F3 `waiting` answer, made with no chain read, does not
      // end the run's choice: the run goes on to the next poll of pollsToTallyAt(now) without a result, then to (b),
      // (c) and (d), as if (a) had not applied (revision 8f, R8E-SEC-3). Gating's `waiting`, after a chain read,
      // ends the run with `done` as before (F8F-B3 i). The reached-reads flag is cleared for the F3 case at that
      // moment only: a later `listVoters` of the same run (the next poll's tally or the prune) sets it again, and
      // the run then answers `done` to the step (F8F-B3 ii).
      for (const poll of toTally) {
        const run = await tallyPollRun(deps, poll, reached);
        if (run.noVoterWait) {
          reachedReads = false;
          continue;
        }
        const answer = POLL_TALLY_JOB_OUTCOMES[run.outcome.outcome];
        if (answer === 'throw') throw new PollTallyFailed(run.outcome.step ?? 'read');
        return answer;
      }
      // (b) the expired line, once a day.
      if (expired.length > 0) {
        for (const poll of expired) logSafe(deps, 'poll_tally_expired', { poll: poll.id });
        return 'idle';
      }
      // (c) the purge of a counted poll's votes: at most POLL_PURGE_MAX_POLLS tries, oldest first (revision 8, R8-4).
      for (const poll of purgeable.slice(0, POLL_PURGE_MAX_POLLS)) {
        const deleted = await deps.polls.deleteVotes(poll.id, POLL_PURGE_PER_RUN);
        if (deleted > 0) {
          logSafe(deps, 'poll_votes_purged', { poll: poll.id, deleted });
          return 'more';
        }
      }
      // (d) the prune of the open poll.
      if (pruneDue && open !== null) return prune(deps, open, now, reached);
      return 'idle';
    });
    return pollTallyStepAnswer(guarded, reachedReads);
  },
});

/** The `poll_tally` social job over HOLDER_POLLS (revision 8b, R8B-8). */
export const createPollTallyJob: CreatePollTallyJob = (deps) => createPollTallyJobFor(deps, HOLDER_POLLS);
