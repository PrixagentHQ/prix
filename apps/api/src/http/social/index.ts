import type { SocialApiDeps, SocialStatusResponse } from '@prix/contracts';
import { Hono } from 'hono';
import { json } from '../errors.ts';
import { registerAgentRoutes } from './routes-agents.ts';
import { registerManagerAdminRoutes, registerManagerRoutes } from './routes-managers.ts';
import { registerRivalryRoutes } from './routes-rivalries.ts';
import { registerWarAdminRoutes, registerWarRoutes } from './routes-wars.ts';

// Phase 6.3, the room (docs/contracts/phase-6-room.md): its own switch, its own two factories. Phase 6.4,
// the pictures in it (docs/contracts/phase-6-pictures.md): a switch of their own, two factories more.
export {
  createRoomAdminRoutes,
  createRoomPictureAdminRoutes,
  createRoomPictureRoutes,
  createRoomRoutes,
} from './room/index.ts';

/**
 * Phase 6, the social strategy layer: docs/contracts/phase-6-social.md section 6. Every path is
 * under `/social`, with the `/api` prefix removed as in the other route files. The operator mounts
 * these on the same router as Phase 1, so the guard, the rate limit and the error handler apply.
 *
 * Everything here is paper. No route reads, shows or links a record of real money, no response
 * carries a private prompt, a key, an owner address or a hidden agent, and nothing in a request
 * is trusted for a price, a value, a rank, a slot or a date.
 */

/**
 * The public and owner routes. Mounted only while `SOCIAL_ENABLED` is on; while it is off every
 * one of these paths is the generic 404. Public reads read no session and are cached 30 seconds;
 * signed-in reads and writes are never cached.
 */
export function createSocialRoutes(deps: SocialApiDeps): Hono {
  const routes = new Hono();
  routes.get('/social/status', () => json<SocialStatusResponse>({ on: true }, 200, 'public'));
  registerAgentRoutes(routes, deps);
  registerRivalryRoutes(routes, deps);
  registerWarRoutes(routes, deps);
  registerManagerRoutes(routes, deps);
  return routes;
}

/**
 * The admin routes, mounted whatever the switch says so that a war can be created before launch.
 * Each one checks the session against `ADMIN_ADDRESSES` before it reads anything else, and answers
 * anyone else exactly as an unknown path.
 */
export function createSocialAdminRoutes(deps: SocialApiDeps): Hono {
  const routes = new Hono();
  registerWarAdminRoutes(routes, deps);
  registerManagerAdminRoutes(routes, deps);
  return routes;
}
