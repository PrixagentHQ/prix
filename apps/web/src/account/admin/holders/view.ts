import type { HolderPoll, PollState, PollTallyOutcome } from '@prix/contracts';

/**
 * The pure rules of /admin/holders. No word is written here: each name is a `<template data-message>` the
 * server rendered from the copy deck. No value of @prix/contracts is imported, so the browser's script
 * carries no zod; the page passes the contract's `pollStateAt` in.
 */

/** The polls an administrator may ask to count: every poll of `HOLDER_POLLS` that has closed, newest close first. */
export function closedPollsAt(
  now: Date,
  polls: readonly HolderPoll[],
  stateAt: (poll: HolderPoll, now: Date) => PollState,
): HolderPoll[] {
  return polls.filter((poll) => stateAt(poll, now) === 'closed').sort((a, b) => b.closesAt.localeCompare(a.closesAt));
}

/** The deck's sentence names "UTC" after `{time}`, so the time is given without it. */
export function timeWithoutZone(formatted: string): string {
  return formatted.replace(/ UTC$/, '');
}

/** The message a tally's answer shows: its outcome, the step filled in for `failed`. */
export function tallyMessageOf(
  outcome: PollTallyOutcome,
  steps: Readonly<Record<string, string>>,
): { name: PollTallyOutcome['outcome']; slots: Record<string, string> } {
  if (outcome.outcome !== 'failed') return { name: outcome.outcome, slots: {} };
  const step = outcome.step !== null && Object.hasOwn(steps, outcome.step) ? steps[outcome.step] : undefined;
  return { name: 'failed', slots: { step: step ?? steps.read ?? '' } };
}

/** The three fields of the webhook's answer as the page writes them. An empty error is the deck's "None". */
export function webhookSlots(
  answer: { url: string; pendingUpdateCount: number; lastErrorMessage: string | null },
  none: string,
): Record<string, string> {
  return {
    url: answer.url,
    pending: String(answer.pendingUpdateCount),
    lastError:
      answer.lastErrorMessage === null || answer.lastErrorMessage.trim() === '' ? none : answer.lastErrorMessage,
  };
}
