import type { FollowApiDeps } from '@prix/contracts';
import { Hono } from 'hono';
import { registerFeedRoutes } from './routes-feed.ts';
import { registerFollowRoutes } from './routes-follows.ts';
import { registerNotifyRoutes } from './routes-notify.ts';
import { registerResultsRoutes } from './routes-results.ts';

/**
 * The Phase 3 routes, with the `/api` prefix removed as in Phase 1's route files. The operator mounts
 * them on the same router, so the guard, the rate limit and the error handler apply.
 * docs/contracts/phase-3-follow.md section 3.
 */
export function createFollowRoutes(deps: FollowApiDeps): Hono {
  const routes = new Hono();
  registerFollowRoutes(routes, deps);
  registerFeedRoutes(routes, deps);
  registerNotifyRoutes(routes, deps);
  registerResultsRoutes(routes, deps);
  return routes;
}

export { createFeedReadPort } from './feed-read.ts';
