// Sample answers of GET /api/polls and /api/polls/status, for fixture builds only (PRIX_FIXTURES=1).
// SAMPLE DATA: the counts below are made up to show each state of the page, and are never shown in
// production. A fixture build picks one with ?state= on the page address:
//
//   open        the first poll open, with votes cast, and nothing closed (the default)
//   openEmpty   the first poll open with no vote cast yet
//   counting    the poll closed, its count not done, within the lookback
//   uncounted   the poll closed and past the lookback with no count
//   closed      the poll counted, one option chosen
//   tie         the poll counted, two options tied
//   none        the poll counted, no vote counted
//   noneOpen    nothing open and nothing closed
//   error       the read failed (502)
//   failed      the status probe failed (the route answers 503)
//   off         the switch is off (the route answers the site's 404)
import { HOLDER_POLLS, type PollPublic, type PollsResponse } from '@prix/contracts';
import type { PollsRead, PollsSwitch } from './read-polls.ts';

const poll = HOLDER_POLLS[0];
if (!poll) throw new Error('The contract has no poll.');

const MIN_TOKENS = 10_000;
const base = {
  id: poll.id,
  question: poll.question,
  options: poll.options.map((option) => ({ id: option.id, name: option.name, agentId: option.agentId })),
  opensAt: poll.opensAt,
  closesAt: poll.closesAt,
};
const SAMPLE_CAST = { 'big-tech-equal': 41, 'index-core': 27, 'momentum-five': 1, 'dip-buyer': 12 };
const ZERO = { 'big-tech-equal': 0, 'index-core': 0, 'momentum-five': 0, 'dip-buyer': 0 };

function counted(counts: Record<string, number>, leaders: string[]): PollPublic['result'] {
  return {
    cast: SAMPLE_CAST,
    counted: counts,
    leaders,
    countedAt: '2026-10-21T20:41:07.000Z',
    firstBlock: 91_000_000,
    lastBlock: 91_000_000,
  };
}

const states: Record<string, PollsResponse> = {
  open: { minTokens: MIN_TOKENS, polls: [{ ...base, state: 'open', cast: SAMPLE_CAST, result: null }] },
  openEmpty: { minTokens: MIN_TOKENS, polls: [{ ...base, state: 'open', cast: ZERO, result: null }] },
  counting: { minTokens: MIN_TOKENS, polls: [{ ...base, state: 'counting', cast: SAMPLE_CAST, result: null }] },
  uncounted: { minTokens: MIN_TOKENS, polls: [{ ...base, state: 'uncounted', cast: SAMPLE_CAST, result: null }] },
  closed: {
    minTokens: MIN_TOKENS,
    polls: [
      {
        ...base,
        state: 'closed',
        cast: null,
        result: counted({ 'big-tech-equal': 38, 'index-core': 25, 'momentum-five': 1, 'dip-buyer': 9 }, [
          'big-tech-equal',
        ]),
      },
    ],
  },
  tie: {
    minTokens: MIN_TOKENS,
    polls: [
      {
        ...base,
        state: 'closed',
        cast: null,
        result: counted({ 'big-tech-equal': 20, 'index-core': 20, 'momentum-five': 0, 'dip-buyer': 7 }, [
          'big-tech-equal',
          'index-core',
        ]),
      },
    ],
  },
  none: { minTokens: MIN_TOKENS, polls: [{ ...base, state: 'closed', cast: null, result: counted(ZERO, []) }] },
  noneOpen: { minTokens: MIN_TOKENS, polls: [] },
};

/**
 * The status probe in a fixture build. On /polls it follows `?state=`; on any other page it is on only
 * with `?polls=on`, so that the footer and /token of every other fixture page stay as they were.
 */
export function pollsFixtureSwitch(url: URL): PollsSwitch {
  if (!/^\/polls\/?$/.test(url.pathname)) return url.searchParams.get('polls') === 'on' ? 'on' : 'off';
  const state = url.searchParams.get('state');
  if (state === 'off') return 'off';
  if (state === 'failed') return 'failed';
  return 'on';
}

/**
 * The read in a fixture build. On /polls it follows `?state=`; on any other page (/token's own `?state=` is the
 * token's) it follows `?pollstate=`, open by default, so /token can show the poll open, closed or none open.
 */
export function pollsFixtureRead(url: URL): PollsRead {
  const onPolls = /^\/polls\/?$/.test(url.pathname);
  const state = url.searchParams.get(onPolls ? 'state' : 'pollstate') ?? 'open';
  if (state === 'error') return { ok: false, status: 502 };
  const data = Object.hasOwn(states, state) ? states[state] : states.open;
  return data ? { ok: true, data } : { ok: false, status: 502 };
}
