import type { TapeResponse } from '@prix/contracts';
import { TAPE_PATH, tapeResponseSchema } from '@prix/contracts';
import { type Context, type Read, socialRead } from '../social/client.ts';

/**
 * The holders' tape's one read (docs/contracts/phase-6-holders-2.md, section 3.2). Server side only, through
 * the `API` binding with the visitor's cookie, as every Phase 6 read is: the API decides from the session
 * whether the visitor sees decisions as they are made or past the delay, and nothing the page sends says
 * what a wallet holds. A call never throws; the answer is parsed with the contract's schema, and it is made
 * once per request, so the route file (pages/tape.astro), the page and /league can all ask it. Under
 * __PRIX_FIXTURES__ it answers from ./fixtures.ts (`?fixture=tape-<state>`).
 *
 * No script in the browser asks `/api/tape`.
 */
export function fetchTape(context: Context): Promise<Read<TapeResponse>> {
  return socialRead(context, TAPE_PATH, tapeResponseSchema);
}

/**
 * Whether /league shows its link to the tape: whenever the tape's read did not answer 404. A tape that is
 * switched off is the generic 404, and the page then has no link to it.
 */
export function tapeLinkShown(result: Read<unknown>): boolean {
  return result.ok || result.status !== 404;
}
