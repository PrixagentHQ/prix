import type {
  Address,
  ApiError,
  HolderPoll,
  PollApiDeps,
  PollMeResponse,
  PollPublic,
  PollRefusal,
  PollResultRecord,
  PollsResponse,
  PollTallyOutcome,
  PollVoteResponse,
  SessionRecord,
} from '@prix/contracts';
import {
  HOLDER_POLLS,
  openPollAt,
  POLL_MAX_VOTERS,
  POLL_MIN_TIER,
  POLL_REFUSALS,
  POLL_VOTE_WRITE_ROWS,
  pollById,
  pollLeaders,
  pollPublicStateAt,
  pollStateAt,
  pollVoteBodySchema,
  pollWalletExcluded,
  wholeTokensAtPpm,
} from '@prix/contracts';
import { Hono } from 'hono';
import { failures, json } from '../errors.ts';
import { assertFromSite, enforceLimit, readSession, requireSession, sameSiteOr404, spendWrite } from '../guard.ts';
import { readInput } from '../input.ts';

/**
 * The holders' poll (docs/contracts/phase-6-holders.md sections 4.3 and 4.4), with the `/api` prefix removed
 * as in every route file. `POST /admin/polls/:id/tally` is mounted always; the vote, `/polls`, `/polls/me`
 * and `/polls/status` only while `pollsEnabled`, so that while POLLS_ENABLED is off each of them is the
 * generic 404.
 *
 * Nothing of a request decides a tier, a count or a result: the tier comes from the entitlements port, the
 * counts from the store, the state from the server's clock. No public read carries an address, and no log
 * line names one.
 */
export function createPollRoutes(deps: PollApiDeps): Hono {
  const app = new Hono();
  registerPollAdminRoutes(app, deps);
  if (deps.pollsEnabled) registerPollPublicRoutes(app, deps);
  return app;
}

/**
 * One sentence for each refusal: what happened and what to do next. Written here, by hand; nothing of a
 * request or a record is ever put into one. The page shows its own sentence by the field.
 */
export const POLL_SENTENCES: Record<PollRefusal, string> = {
  poll_unknown_option: 'That option is not part of this poll. Reload the page and choose one of its options.',
  poll_not_open: 'This poll is not open yet. Try again once it opens.',
  poll_closed: 'This poll is closed, so it takes no more votes. Its result is shown once it is counted.',
  poll_gate_off: 'Voting opens when $PRIX tiers are on. Try again later.',
  poll_not_holder:
    "This wallet cannot vote in this poll: voting needs a holder's wallet, and Prix's own wallets do not vote. A new holding counts about an hour after Prix first sees it.",
  poll_full: 'This poll is full for now. Try again in an hour.',
};

/**
 * Every refusal of the poll is `invalid_input` with a field of `POLL_REFUSALS` and the status the contract
 * puts beside it (section 0, rule 5). The shared error map gives `invalid_input` 400 and nothing else, so the
 * answer is built here, in the shape and with the headers of every other error, and never cached.
 */
export function pollRefusal(field: PollRefusal): Response {
  const body: ApiError = { error: { code: 'invalid_input', message: POLL_SENTENCES[field], field } };
  return json(body, POLL_REFUSALS[field], 'private');
}

/** Step 5's rule, shared by the vote and `me`: null when a vote by this wallet would pass it now. */
async function holderRefusal(
  deps: PollApiDeps,
  address: Address,
): Promise<Extract<PollRefusal, 'poll_gate_off' | 'poll_not_holder'> | null> {
  // Prix's own wallets do not vote (revision 2, H-SEC-6): asked before the entitlements, so it reads nothing.
  if (pollWalletExcluded(address, deps.config.adminAddresses, deps.config.houseOwners)) return 'poll_not_holder';
  // Without `cachedOnly`: the hour before a tier rises applies to a vote.
  const entitlements = await deps.entitlements.entitlementsFor(address);
  if (!entitlements.gatingOn) return 'poll_gate_off';
  if (entitlements.tier < POLL_MIN_TIER) return 'poll_not_holder';
  return null;
}

/** Counts of every option of the poll, a missing option at zero; nothing that is not the poll's own option. */
function countsOf(poll: HolderPoll, stored: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const option of poll.options) out[option.id] = Math.max(0, stored[option.id] ?? 0);
  return out;
}

function registerPollPublicRoutes(app: Hono, deps: PollApiDeps): void {
  const { polls } = deps;

  app.get('/polls/status', () => json({ on: true as const }, 200, 'public'));

  // Public, cached 30 seconds under its path alone, no per-wallet data; nothing of the request is read.
  app.get('/polls', async () => {
    const now = deps.now();
    const listed = HOLDER_POLLS.filter((poll) => pollStateAt(poll, now) !== 'upcoming');
    const closedIds = listed.filter((poll) => pollStateAt(poll, now) === 'closed').map((poll) => poll.id);
    const [results, ppm] = await Promise.all([
      closedIds.length === 0 ? Promise.resolve([] as PollResultRecord[]) : polls.getResults(closedIds),
      deps.tierOnePpm(),
    ]);
    const byPoll = new Map(results.map((result) => [result.pollId, result]));
    const rows: PollPublic[] = [];
    for (const poll of listed) {
      const result = byPoll.get(poll.id) ?? null;
      const state = pollPublicStateAt(poll, now, result !== null);
      if (state === null) continue;
      const counted = result === null ? null : countsOf(poll, result.counted);
      rows.push({
        id: poll.id,
        question: poll.question,
        options: poll.options.map((option) => ({ id: option.id, name: option.name, agentId: option.agentId })),
        opensAt: poll.opensAt,
        closesAt: poll.closesAt,
        state,
        cast: result === null ? countsOf(poll, await polls.castCounts(poll.id)) : null,
        result:
          result === null || counted === null
            ? null
            : {
                cast: countsOf(poll, result.cast),
                counted,
                leaders: pollLeaders(poll, counted),
                countedAt: result.countedAt,
                firstBlock: result.firstBlock,
                lastBlock: result.lastBlock,
              },
      });
    }
    // The open poll first, then the closed ones by newest close.
    rows.sort((a, b) => {
      if (a.state === 'open' && b.state !== 'open') return -1;
      if (b.state === 'open' && a.state !== 'open') return 1;
      return b.closesAt.localeCompare(a.closesAt);
    });
    return json<PollsResponse>({ polls: rows, minTokens: wholeTokensAtPpm(ppm) }, 200, 'public');
  });

  // A session, never cached, the `read` rule for the address: the open poll, the wallet's own choice, and
  // whether a vote would pass step 5 now.
  app.get('/polls/me', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const address = session.address as Address;
    await enforceLimit(deps, 'read', address);
    const poll = openPollAt(deps.now());
    if (poll === null) {
      return json<PollMeResponse>({ pollId: null, option: null, canVote: false, refusal: null }, 200, 'private');
    }
    const option = await polls.getVote(poll.id, address);
    const refusal = await holderRefusal(deps, address);
    return json<PollMeResponse>({ pollId: poll.id, option, canVote: refusal === null, refusal }, 200, 'private');
  });

  // Section 4.3, in this order, and nothing of a later step before an earlier one has passed.
  app.post('/polls/:id/vote', async (c) => {
    // 1. From the site, a session (401 before the limiter), then the `read` rule for the address.
    assertFromSite(deps, c.req.raw);
    const session = await requireSession(deps, c.req.raw);
    const address = session.address as Address;
    await enforceLimit(deps, 'read', address);
    // 2. The poll: the generic 404 for an id no poll has.
    const poll = pollById(c.req.param('id'));
    if (poll === null) throw failures.routeNotFound();
    // 3. The body; an option that is not the poll's own.
    const { option } = await readInput(pollVoteBodySchema, c.req.raw);
    if (!poll.options.some((entry) => entry.id === option)) return pollRefusal('poll_unknown_option');
    // 4. The route's one reading of the clock.
    const now = deps.now();
    const state = pollStateAt(poll, now);
    if (state === 'upcoming') return pollRefusal('poll_not_open');
    if (state === 'closed') return pollRefusal('poll_closed');
    // 5. Prix's own wallets, then the tier without `cachedOnly`.
    const refusal = await holderRefusal(deps, address);
    if (refusal !== null) return pollRefusal(refusal);
    // 6. The `write` rule, the wallet's write of the day and the day's rows, spent once.
    await spendWrite(deps, address, POLL_VOTE_WRITE_ROWS);
    // 7. One batch; the cap is decided inside it.
    if ((await polls.putVote(poll.id, address, option, now.toISOString(), POLL_MAX_VOTERS)) === 'full') {
      return pollRefusal('poll_full');
    }
    // 8. The entry drops the cached GET /api/polls on this 200.
    return json<PollVoteResponse>({ pollId: poll.id, option }, 200, 'private');
  });
}

/** An admin's session, or the generic 404: byte for byte the answer to an unknown path. */
async function adminOr404(deps: PollApiDeps, request: Request): Promise<SessionRecord> {
  const session = await readSession(deps, request);
  const wanted = session?.address.toLowerCase();
  if (session === null || !deps.config.adminAddresses.some((entry) => entry.toLowerCase() === wanted)) {
    throw failures.routeNotFound();
  }
  return session;
}

function registerPollAdminRoutes(app: Hono, deps: PollApiDeps): void {
  // Revision 2, H-SEC-4: the job's own `tallyPoll` for one poll, whatever the lookback says. Mounted whatever
  // POLLS_ENABLED says. It answers the tally's outcome as it is and never throws.
  app.post('/admin/polls/:id/tally', async (c) => {
    // From the site, or the generic 404 like anyone who is not an admin.
    sameSiteOr404(deps, c.req.raw);
    const admin = await adminOr404(deps, c.req.raw);
    const poll = pollById(c.req.param('id'));
    if (poll === null) throw failures.routeNotFound();
    // A tally reads the chain, so it is counted per admin wallet as a write is.
    await enforceLimit(deps, 'write', admin.address);
    let outcome: PollTallyOutcome;
    try {
      outcome = await deps.tally(poll);
    } catch {
      // `tallyPoll` never throws; if it ever does, nothing was frozen by this answer. No error text is logged.
      outcome = { outcome: 'failed', step: 'read' };
    }
    // The poll's id and the outcome only: no address in a log line of this round.
    console.log(
      JSON.stringify({
        event: 'admin_action',
        action: 'poll_tally',
        target: poll.id,
        outcome: outcome.outcome,
        step: outcome.step,
      }),
    );
    return json<PollTallyOutcome>({ outcome: outcome.outcome, step: outcome.step }, 200, 'private');
  });
}
