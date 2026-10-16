import type { LoungeRead } from './read.ts';
import { loungeReadOf } from './read.ts';

/**
 * SAMPLE DATA. Used only when the site is built with PRIX_FIXTURES=1; a production build never reaches this
 * file. The invite link below is invented for reviewing the lounge's block on /following.
 *
 * The state is chosen by its own parameter, `?lounge=`, beside `?fixture=`: the follow client's and the
 * page's fixture transports answer 500 to a `fixture` name they do not know, so a name of this list there
 * would break every other read of /following. With no `lounge` parameter, or a value not in this list, the
 * API answers the generic 404, as it does while the lounge is off, and the block is absent.
 *
 *   ?lounge=open        a holder whose Telegram account is linked: the invite link
 *   ?lounge=link        a holder with no Telegram account linked; add `?fixture=signed-in,telegram-not-linked`
 *                       so that the Telegram settings beside it agree (the follow fixtures link one by default)
 *   ?lounge=not-holder  a wallet below 10,000 $PRIX, or the token gate off
 *   ?lounge=ended       the session has ended (401): the block is absent
 *   ?lounge=fails       a fault of the server (500): the block is absent
 */

export const LOUNGE_FIXTURES: Readonly<Record<string, { status: number; body: unknown }>> = {
  open: { status: 200, body: { state: 'open', url: 'https://t.me/+SampleInviteLink01' } },
  link: { status: 200, body: { state: 'link_telegram', url: null } },
  'not-holder': { status: 200, body: { state: 'not_holder', url: null } },
  ended: { status: 401, body: { error: { code: 'unauthorized', message: 'A sample answer.', field: null } } },
  fails: { status: 500, body: { error: { code: 'internal', message: 'A sample answer.', field: null } } },
};

const OFF = { status: 404, body: { error: { code: 'not_found', message: 'A sample answer.', field: null } } };

/** The read of GET /api/lounge for the value of `?lounge=`, through the same rule as a real answer. */
export function loungeFixture(lounge: string | null): LoungeRead {
  const known = lounge !== null && Object.hasOwn(LOUNGE_FIXTURES, lounge);
  const sample = (known ? LOUNGE_FIXTURES[lounge] : undefined) ?? OFF;
  return loungeReadOf(sample.status, sample.body);
}
