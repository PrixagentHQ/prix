import type { PollMeResponse } from '@prix/contracts';
import type { ApiResult } from '../../lib/api.ts';

/**
 * The pure rules of the vote control (docs/contracts/phase-6-holders.md sections 4.3 to 4.5): which state
 * the control shows for an answer of GET /api/polls/me, and which sentence a refused vote gets. No word is
 * written here: each name is a `<template data-message>` the server rendered from the copy deck. No value
 * of @prix/contracts is imported, so the browser's script carries no zod.
 */

/** What the control shows, by the answer of GET /api/polls/me. */
export type ControlState =
  /** Signed in, and a vote would pass the holder step: the vote buttons and the current choice. */
  | { kind: 'vote'; option: string | null }
  /** Signed in, below the first amount: `polls.needTokens`. */
  | { kind: 'needTokens' }
  /** Signed in, tiers are off: `polls.gateOff`. */
  | { kind: 'gateOff' }
  /** Not signed in (401): `polls.signIn`. */
  | { kind: 'signIn' }
  /** This poll is not the open one any more: `polls.refusedClosed`. */
  | { kind: 'closed' }
  /** The read failed: `polls.loadFailed`. */
  | { kind: 'loadFailed' };

/** The state for the control of `pollId`, from the answer of GET /api/polls/me. */
export function controlStateOf(pollId: string, answer: ApiResult<PollMeResponse>): ControlState {
  if (!answer.ok) return answer.error.code === 'unauthorized' ? { kind: 'signIn' } : { kind: 'loadFailed' };
  const me = answer.data;
  if (me.pollId !== pollId) return { kind: 'closed' };
  if (me.canVote) return { kind: 'vote', option: me.option };
  if (me.refusal === 'poll_gate_off') return { kind: 'gateOff' };
  return { kind: 'needTokens' };
}

/**
 * The message a refused vote shows. A refusal of the poll is `invalid_input` with a field of POLL_REFUSALS
 * (section 0 rule 5); not signed in is the session's 401; too many requests the limiter's 429. Anything else
 * is `failed` ("Your vote was not saved. Try again."). The API's own message is never shown.
 */
export type RefusalMessage =
  | 'refusedClosed'
  | 'refusedNotOpen'
  | 'refusedFull'
  | 'refusedUnknownOption'
  | 'refusedRateLimited'
  | 'needTokens'
  | 'gateOff'
  | 'session'
  | 'failed';

const BY_FIELD: Readonly<Record<string, RefusalMessage>> = {
  poll_closed: 'refusedClosed',
  poll_not_open: 'refusedNotOpen',
  poll_full: 'refusedFull',
  poll_unknown_option: 'refusedUnknownOption',
  poll_not_holder: 'needTokens',
  poll_gate_off: 'gateOff',
};

export function refusalMessageOf(failure: {
  status: number;
  error: { code: string; field: string | null };
}): RefusalMessage {
  const { code, field } = failure.error;
  if (code === 'unauthorized') return 'session';
  if (code === 'rate_limited') return 'refusedRateLimited';
  if (code === 'invalid_input' && field !== null && Object.hasOwn(BY_FIELD, field)) return BY_FIELD[field] ?? 'failed';
  return 'failed';
}

/** After a refusal the vote buttons stay only where another press could pass: never for a closed poll. */
export function keepsButtons(message: RefusalMessage): boolean {
  return message === 'refusedRateLimited' || message === 'refusedFull' || message === 'failed';
}
