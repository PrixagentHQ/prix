import type { Address, FollowApiDepsWithLounge, IsoTime, LoungeApiDeps, Tier } from '@prix/contracts';
import { Hono } from 'hono';
import type { LiveDelay } from '../league/delay.ts';
import { NO_LIVE_DELAY } from '../league/delay.ts';
import { registerLoungeRoutes } from '../lounge/index.ts';
import { registerFeedRoutes } from './routes-feed.ts';
import { registerFollowRoutes } from './routes-follows.ts';
import { registerNotifyRoutes } from './routes-notify.ts';
import { registerResultsRoutes } from './routes-results.ts';
import { registerTelegramAdminRoutes } from './routes-telegram-admin.ts';

/**
 * The lounge's deps as the routes read them (docs/contracts/phase-6-holders-2.md section 4): the contract's
 * `LoungeApiDeps`, and the one read step 5 of the join names that the contract's type does not carry,
 * `TokenService.holdingOf(wallet)` for its `tier` and its `checkedAt`, taken together from that one answer
 * (H2-SEC-1). Optional: absent, no read is ever fresh, and every join request whose gate is on is ignored
 * (neither approved nor declined), which is the safe side.
 */
export interface LoungeRouteDeps extends LoungeApiDeps {
  holding?(address: Address): Promise<{ gatingOn: boolean; tier?: Tier; checkedAt?: IsoTime | null }>;
}

/** `FollowApiDepsWithLounge` with the lounge's routes deps. Every `FollowApiDepsWithLounge` is one. */
export interface FollowRouteDeps extends FollowApiDepsWithLounge {
  lounge?: LoungeRouteDeps | null;
}

/**
 * The Phase 3 routes, with the `/api` prefix removed as in Phase 1's route files. The operator mounts
 * them on the same router, so the guard, the rate limit and the error handler apply. `delay` is the
 * publication delay of Prix Live (docs/CONTRACTS.md section 24.8), applied to every feed.
 * docs/contracts/phase-3-follow.md section 3.
 *
 * Phase 6.8: the webhook also judges join requests to the lounge, and `GET /api/lounge` is registered only
 * while `deps.lounge` is not null (absent counts as null).
 */
export function createFollowRoutes(
  deps: FollowRouteDeps,
  delay: LiveDelay = NO_LIVE_DELAY,
  admins: ReadonlySet<string> = new Set(),
): Hono {
  const routes = new Hono();
  registerFollowRoutes(routes, deps);
  registerFeedRoutes(routes, deps, delay);
  registerNotifyRoutes(routes, deps);
  // The holders round's webhook routes (docs/contracts/phase-6-holders.md section 7): admins only.
  registerTelegramAdminRoutes(routes, deps, admins);
  registerResultsRoutes(routes, deps);
  if ((deps.lounge ?? null) !== null) registerLoungeRoutes(routes, deps);
  return routes;
}

export { createFeedReadPort } from './feed-read.ts';
