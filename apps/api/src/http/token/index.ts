import type { ApiDeps, TokenApiDeps } from '@prix/contracts';
import { Hono } from 'hono';
import { registerTokenAdminRoutes } from './admin.ts';
import { registerTokenMeRoutes } from './me.ts';
import { registerTokenPublicRoutes } from './public.ts';

/**
 * The six routes of Phase 4, to be mounted at the root of /api. Thin handlers over TokenService:
 * the tier, the token address and the thresholds are computed there, from the chain and the
 * configuration row, and no request field, header or cookie other than the session reaches them.
 */
export function createTokenRoutes(deps: ApiDeps & { token: TokenApiDeps }, admins: ReadonlySet<string>): Hono {
  const app = new Hono();
  registerTokenPublicRoutes(app, deps);
  registerTokenMeRoutes(app, deps);
  registerTokenAdminRoutes(app, deps, admins);
  return app;
}
