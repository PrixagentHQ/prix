import type { FollowApiDepsWithLounge, LoungeResponse } from '@prix/contracts';
import { loungeAccountAnswer, loungeResponseSchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { json } from '../errors.ts';
import { requireSession } from '../guard.ts';

/**
 * Phase 6.8, G: the account page's link to the lounge (docs/contracts/phase-6-holders-2.md section 4.5).
 * Registered by `createFollowRoutes` only while `deps.lounge` is not null; it does nothing when called
 * without one. A session (401 without), never cached. The invite link is sent in state `open` and in no
 * other: the tier is `entitlementsFor` of the session's wallet, read without `cachedOnly`, and the link is
 * the wallet's own `notify_chats` row. Nothing of the request says either.
 */
export function registerLoungeRoutes(routes: Hono, deps: FollowApiDepsWithLounge): void {
  const lounge = deps.lounge ?? null;
  if (lounge === null) return;
  routes.get('/lounge', async (c) => {
    const session = await requireSession(deps, c.req.raw);
    const address = session.address.toLowerCase();
    const [entitlements, chat] = await Promise.all([
      deps.entitlements.entitlementsFor(address),
      deps.follow.getChat(address),
    ]);
    const answer: LoungeResponse = loungeResponseSchema.parse(
      loungeAccountAnswer(lounge.config, entitlements, chat !== null),
    );
    return json<LoungeResponse>(answer, 200, 'private', { 'Cache-Control': 'private, no-store' });
  });
}
