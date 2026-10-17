import type { ApiErrorCode, PollMeResponse } from '@prix/contracts';
import type { PollCall, PollTransport } from './poll-client.ts';

/**
 * Fixtures for the vote control, reached only when the site is built with PRIX_FIXTURES=1. `?pollfixture=<name>`
 * on the page URL selects the state of GET /api/polls/me and of the vote:
 *
 *   can-vote       a holder that has not voted; the vote is stored (the default)
 *   voted          a holder whose vote is Index Core; a change is stored
 *   not-holder     signed in, below the first amount
 *   gate-off       signed in, tiers are off
 *   signed-out     every call answers 401
 *   closed         GET /api/polls/me names no open poll
 *   refused-closed a holder; the vote answers poll_closed
 *   refused-not-open a holder; the vote answers poll_not_open
 *   full          a holder; the vote answers poll_full
 *   rate-limited   a holder; the vote answers 429
 *   fail           every call answers 500
 *
 * An unknown name makes every call fail, so a typing mistake is seen at once.
 */

const NAMES = [
  'can-vote',
  'voted',
  'not-holder',
  'gate-off',
  'signed-out',
  'closed',
  'refused-closed',
  'refused-not-open',
  'full',
  'rate-limited',
  'fail',
] as const;
type Name = (typeof NAMES)[number];

const POLL = 'model-war-2-strategy';

const STATUS: Partial<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  invalid_input: 400,
  rate_limited: 429,
  internal: 500,
};

function failure(code: ApiErrorCode, message: string, field: string | null = null, status?: number): Response {
  return Response.json({ error: { code, message, field } }, { status: status ?? STATUS[code] ?? 500 });
}

function known(name: string): name is Name {
  return (NAMES as readonly string[]).includes(name);
}

function meFor(name: Name): PollMeResponse {
  if (name === 'closed') return { pollId: null, option: null, canVote: false, refusal: null };
  if (name === 'not-holder') return { pollId: POLL, option: null, canVote: false, refusal: 'poll_not_holder' };
  if (name === 'gate-off') return { pollId: POLL, option: null, canVote: false, refusal: 'poll_gate_off' };
  return { pollId: POLL, option: name === 'voted' ? 'index-core' : null, canVote: true, refusal: null };
}

function vote(name: Name, call: PollCall): Response {
  if (name === 'refused-closed') return failure('invalid_input', 'Closed.', 'poll_closed', 409);
  if (name === 'refused-not-open') return failure('invalid_input', 'Not open.', 'poll_not_open', 409);
  if (name === 'full') return failure('invalid_input', 'Full.', 'poll_full', 409);
  if (name === 'rate-limited') return failure('rate_limited', 'Too many requests.');
  const option = (call.body as { option?: unknown } | undefined)?.option;
  if (typeof option !== 'string') return failure('invalid_input', 'No option.', 'option');
  return Response.json({ pollId: POLL, option });
}

/** A transport that answers from fixtures. `pageUrl` is the page the script runs on. */
export function createPollFixtureTransport(pageUrl: URL): PollTransport {
  const name = (pageUrl.searchParams.get('pollfixture') ?? 'can-vote').trim();
  return async (call) => {
    if (!known(name)) return failure('internal', `Unknown poll fixture: ${name}`);
    if (name === 'fail') return failure('internal', 'The fixture is set to fail every call.');
    if (name === 'signed-out') return failure('unauthorized', 'Sign in to continue.');
    if (call.method === 'GET' && call.path === '/api/polls/me') return Response.json(meFor(name));
    if (call.method === 'POST' && call.path === `/api/polls/${POLL}/vote`) return vote(name, call);
    return failure('internal', 'No such fixture route.');
  };
}
