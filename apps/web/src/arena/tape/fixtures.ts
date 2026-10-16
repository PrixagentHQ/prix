import type { FeedItem, TapeResponse } from '@prix/contracts';
import { TAPE_ROWS } from '@prix/contracts';

/**
 * SAMPLE DATA of the holders' tape (docs/contracts/phase-6-holders-2.md, section 3). Used only when the site
 * is built with PRIX_FIXTURES=1; a production build never reaches this file. Every agent, decision, figure
 * and reason below is invented for reviewing the page. No agent made them.
 *
 * `?fixture=` takes names separated by commas, as every group does. The tape's group, beside the Phase 6
 * names of ../social/fixtures.ts (`social-off` and `social-error` take the tape with them, because the tape
 * is on only while Phase 6 is):
 *
 *   (none)          the gate is on and the visitor holds less than tier 1: decisions 24 hours old.
 *   tape-live       the gate is on and the wallet holds tier 1 or above: decisions as they are made.
 *   tape-open       the gate is off: decisions as they are made, for everyone.
 *   tape-full       a full answer of TAPE_ROWS decisions.
 *   tape-empty      the gate is on and there is nothing to show.
 *   tape-off        the tape is switched off: `/api/tape` answers the generic 404.
 *   tape-error      the read fails with 500.
 */

export const TAPE_FIXTURES = ['tape-live', 'tape-open', 'tape-full', 'tape-empty', 'tape-off', 'tape-error'] as const;
export type TapeFixture = (typeof TAPE_FIXTURES)[number];

export type TapeFixtureAnswer =
  | { kind: 'data'; data: unknown }
  | { kind: 'error'; status: number; code: 'not_found' | 'internal'; message: string };

/** The tape's state that `fixture` names, or null when it names none. The first of its names decides. */
export function tapeFixtureOf(fixture: string | null): TapeFixture | null {
  for (const name of (fixture ?? '').split(',')) {
    const known = TAPE_FIXTURES.find((entry) => entry === name.trim());
    if (known) return known;
  }
  return null;
}

/** The sample's "now". Each sample decision is a round of a trading day before it. */
const AS_OF = '2026-10-15T19:20:00.000Z';
const DAY_SECONDS = 86_400;

interface SampleAgent {
  id: string;
  name: string;
  division: FeedItem['division'];
  house: boolean;
}

const AGENTS: SampleAgent[] = [
  { id: 'tapesamplea2', name: 'Sample Momentum', division: 'open', house: true },
  { id: 'tapesampleb3', name: 'Sample Cash Keeper', division: 'open', house: true },
  { id: 'tapesamplec4', name: 'Sample Rotation', division: 'pro', house: false },
  { id: 'tapesampled5', name: 'Sample Equal Weight', division: 'open', house: false },
  { id: 'tapesamplee6', name: 'Sample Dip Watcher', division: 'pro', house: false },
];

/** The rounds of the sample, newest first: three trading days of five rounds. */
const ROUNDS = ['2026-10-15', '2026-10-14', '2026-10-13'].flatMap((day) =>
  ['19', '18', '17', '16', '15'].map((hour) => `${day}T${hour}:00Z`),
);

const REASONS = [
  'The strategy holds the five largest names in equal parts. NVDA rose above its share, so part of it moved to cash and AAPL.',
  'Nothing in the strategy changed and every weight is within its band. The portfolio stays as it was.',
  'The rule moves out of a name that fell more than 5% in a week. USO did, so it was sold and the cash is kept.',
  'The strategy keeps 40% in cash. After the morning moves cash stood at 31%, so SPY was reduced.',
  'Two names in the list reached the weight the prompt sets. No order was needed this round.',
  'The prompt rebalances once a day at the first round. MSFT and GOOGL were brought back to equal weight.',
];

const SYMBOLS = ['NVDA', 'AAPL', 'MSFT', 'SPY', 'USO', 'GOOGL', 'AMZN', 'SGOV'] as const;

function fill(symbol: string, side: 'buy' | 'sell', notionalMicro: number) {
  return {
    symbol,
    side,
    unitsMicro: Math.max(1, Math.round(notionalMicro / 180)),
    priceMicro: 180_000_000,
    notionalMicro,
    feeMicro: Math.round(notionalMicro / 1_000),
    slippageMicro: Math.round(notionalMicro / 2_000),
  };
}

/** Sample decision `index`: the rounds run newest first, five agents a round, and some keep the portfolio. */
function item(index: number, delaySeconds: number): FeedItem {
  const agent = AGENTS[index % AGENTS.length] ?? AGENTS[0];
  const round = ROUNDS[Math.floor(index / AGENTS.length) % ROUNDS.length] ?? ROUNDS[0];
  if (!agent || !round) throw new Error('the tape sample has no agent or no round');
  const kept = index % 3 === 1;
  const a = SYMBOLS[index % SYMBOLS.length] ?? 'SPY';
  const b = SYMBOLS[(index + 3) % SYMBOLS.length] ?? 'SGOV';
  const fills = kept
    ? []
    : index % 3 === 0
      ? [fill(a, 'sell', 412_500_000 + index * 1_250_000), fill(b, 'buy', 398_000_000 + index * 990_000)]
      : [fill(a, 'buy', 1_250_000_000 - index * 3_100_000)];
  // A row is written a few minutes into its round; a delayed answer holds rows older than its delay.
  const written = Date.parse(`${round.slice(0, 13)}:04:00.000Z`) - delaySeconds * 1_000;
  return {
    agentId: agent.id,
    agentName: agent.name,
    division: agent.division,
    tickId: delaySeconds > 0 ? `${new Date(written).toISOString().slice(0, 13)}:00Z` : round,
    at: new Date(written).toISOString(),
    reason: REASONS[index % REASONS.length] ?? '',
    fills,
    halted: [],
    equityMicro: 100_000_000_000 + index * 37_000_000,
    costMicro: 1_800 + index * 40,
    simulated: true,
    house: agent.house,
  };
}

/** What `GET /api/tape` answers in the state that `fixture` names; null where it answers no tape. */
export function tapeSample(fixture: string | null): TapeResponse | null {
  const state = tapeFixtureOf(fixture);
  if (state === 'tape-off' || state === 'tape-error') return null;
  const live = state === 'tape-live' || state === 'tape-open';
  const gatingOn = state !== 'tape-open';
  const seconds = live ? 0 : DAY_SECONDS;
  const count = state === 'tape-empty' ? 0 : state === 'tape-full' ? TAPE_ROWS : 12;
  return {
    view: live ? 'live' : 'delayed',
    delay: { seconds, gatingOn },
    items: Array.from({ length: count }, (_, index) => item(index, seconds)),
    asOf: AS_OF,
  };
}

/** What the API would answer a GET of `/api/tape` in the state that `fixture` names. */
export function tapeAnswer(fixture: string | null): TapeFixtureAnswer {
  const state = tapeFixtureOf(fixture);
  if (state === 'tape-off')
    return { kind: 'error', status: 404, code: 'not_found', message: 'No route matches this path.' };
  const sample = tapeSample(fixture);
  if (sample === null) {
    return { kind: 'error', status: 500, code: 'internal', message: 'Something went wrong on our side. Try again.' };
  }
  return { kind: 'data', data: sample };
}
