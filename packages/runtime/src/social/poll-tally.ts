import type {
  Address,
  CreatePollTallyJob,
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
  openPollAt,
  POLL_MIN_TIER,
  POLL_PRUNE_AT,
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

type VoterRead =
  | { kind: 'read'; voters: TieredVoter[]; block: number }
  | { kind: 'waiting' }
  | { kind: 'failed'; step: PollTallyFailStep };

const failedRead = (step: PollTallyFailStep): VoterRead => ({ kind: 'failed', step });

/**
 * Reads every voter of a poll written before `before` and its tier, at one block (section 5 step 3). The
 * pages go by wallet order, POLL_TALLY_PAGE a page, at most POLL_TALLY_MAX_PAGES; the last page may only find
 * the end. Nothing is written here.
 */
async function readVoterTiers(deps: TallyDeps, pollId: string, before: IsoTime): Promise<VoterRead> {
  const voters: TieredVoter[] = [];
  let block: number | null = null;
  let reads = 0;
  let fetches = 0;
  let started: number | null = null;

  /** One `tiersNow`, inside the run's bounds of reads, fetches and seconds. */
  const tiersAt = async (
    wallets: readonly Address[],
    atBlock: number | null,
  ): Promise<{ ok: true; read: PollTiersRead } | { ok: false; result: VoterRead }> => {
    if (reads >= POLL_TALLY_MAX_CHAIN_READS || fetches >= POLL_TALLY_MAX_FETCHES) {
      return { ok: false, result: failedRead('read') };
    }
    if (started === null) started = deps.now().getTime();
    let read: PollTiersRead & { fetches?: unknown };
    try {
      read = await deps.holding.tiersNow(wallets, atBlock);
    } catch {
      return { ok: false, result: failedRead('read') };
    }
    reads += 1;
    if (typeof read.fetches === 'number' && Number.isFinite(read.fetches)) fetches = read.fetches;
    if (deps.now().getTime() - started > POLL_TALLY_MAX_RUN_SECONDS * 1000) {
      return { ok: false, result: failedRead('read') };
    }
    if (read.gatingOn !== true) return { ok: false, result: { kind: 'waiting' } };
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
  return { kind: 'read', voters, block };
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
export const tallyPoll: TallyPoll = async (deps, poll) => {
  const failed = (step: PollTallyFailStep): PollTallyOutcome => {
    logSafe(deps, 'poll_tally_failed', { poll: poll.id, step });
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
    const run = await readVoterTiers(deps, poll.id, poll.closesAt);
    if (run.kind === 'waiting') {
      logSafe(deps, 'poll_tally_waiting', { poll: poll.id });
      return { outcome: 'waiting', step: null };
    }
    if (run.kind === 'failed') return failed(run.step);

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
      return failed('write');
    }
    if (!written) return { outcome: 'already', step: null };
    logSafe(deps, 'poll_tallied', { poll: poll.id, voters, counted: total });
    return { outcome: 'done', step: null };
  } catch {
    // Every step above names its own failure; this only keeps the promise that nothing throws.
    return failed('read');
  }
};

/**
 * Prune while open (section 5, revision 3, H2-SEC-1): from POLL_PRUNE_AT votes, in the first five minutes of
 * an hour, every voter is read at one block by the tally's own path and the votes of wallets below tier 1 or of
 * Prix's own are deleted in one `pruneVoters` after the last page. `done` when a row was deleted, `idle`
 * otherwise; a failure logs `poll_tally_failed` with its step and throws `PollTallyFailed`.
 */
async function prune(deps: TallyDeps, poll: HolderPoll, now: Date): Promise<SocialJobOutcome> {
  const fail = (step: PollTallyFailStep): never => {
    logSafe(deps, 'poll_tally_failed', { poll: poll.id, step });
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

  const run = await readVoterTiers(deps, poll.id, now.toISOString());
  if (run.kind === 'waiting') {
    logSafe(deps, 'poll_tally_waiting', { poll: poll.id });
    return 'idle';
  }
  if (run.kind === 'failed') return fail(run.step);

  const gone = run.voters.filter((voter) => !counts(deps, voter)).map((voter) => voter.wallet);
  if (gone.length === 0) return 'idle';
  let deleted: number;
  try {
    deleted = await deps.polls.pruneVoters(poll.id, gone);
  } catch {
    return fail('write');
  }
  if (!(deleted > 0)) return 'idle';
  logSafe(deps, 'poll_pruned', { poll: poll.id, deleted });
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
 */
export const createPollTallyJob: CreatePollTallyJob = (deps) => ({
  name: JOB,
  run: (now) =>
    guardSocialJob(deps, JOB, now, async (skip) => {
      const watched = pollsWatchedAt(now);
      const open = openPollAt(now);
      const pruneDue = open !== null && pollPruneDue(now);
      if (watched.length === 0 && !pruneDue) return 'idle';

      const results = watched.length === 0 ? [] : await deps.polls.getResults(watched.map((poll) => poll.id));
      const counted = new Set(results.map((result) => result.pollId));
      const toTally = pollsToTallyAt(now)
        .filter((poll) => !counted.has(poll.id))
        .sort(byClose)[0];
      const expired = pollExpiredLogDue(now)
        ? watched.filter((poll) => !counted.has(poll.id) && pollTallyExpired(poll, now))
        : [];
      const purgeable = watched.filter((poll) => counted.has(poll.id)).sort(byClose);
      if (toTally === undefined && expired.length === 0 && purgeable.length === 0 && !pruneDue) return 'idle';

      if (await skip()) return 'idle';

      // (a) the tally.
      if (toTally !== undefined) {
        const outcome = await tallyPoll(deps, toTally);
        const answer = POLL_TALLY_JOB_OUTCOMES[outcome.outcome];
        if (answer === 'throw') throw new PollTallyFailed(outcome.step ?? 'read');
        return answer;
      }
      // (b) the expired line, once a day.
      if (expired.length > 0) {
        for (const poll of expired) logSafe(deps, 'poll_tally_expired', { poll: poll.id });
        return 'idle';
      }
      // (c) the purge of a counted poll's votes.
      for (const poll of purgeable) {
        const deleted = await deps.polls.deleteVotes(poll.id, POLL_PURGE_PER_RUN);
        if (deleted > 0) {
          logSafe(deps, 'poll_votes_purged', { poll: poll.id, deleted });
          return 'more';
        }
      }
      // (d) the prune of the open poll.
      if (pruneDue && open !== null) return prune(deps, open, now);
      return 'idle';
    }),
});
