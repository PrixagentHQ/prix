import type { ApiApp, ReputationApiDeps } from '@prix/contracts';
import { agentNameKey, createAgentInputSchema } from '@prix/contracts';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { ApiFailure, errorResponse, failures } from '../errors.ts';
import { clientNetwork, requireWriter } from '../guard.ts';
import { readInput } from '../input.ts';
import { registerListingRoutes } from './routes-listings.ts';
import { registerRecordRoutes } from './routes-records.ts';

export { checkClaimNonce, createClaimNonce, networkKey } from './claim.ts';
export { createAgentCreationGuard } from './creation-guard.ts';
export { createClaimVerifier } from './verify-claim.ts';

const BASE = '/api/reputation';

/**
 * The Phase 2 routes, all under `/api/reputation`. The app answers to the full path and to the path
 * with that prefix cut off, so the operator may mount it either way. Errors are shaped like Phase 1's.
 */
export function createReputationApp(deps: ReputationApiDeps): ApiApp {
  const app = new Hono();
  registerRecordRoutes(app, deps);
  registerListingRoutes(app, deps);
  app.notFound(() => errorResponse(failures.routeNotFound()));
  app.onError((error) => {
    if (error instanceof ApiFailure) return errorResponse(error);
    // The route and the kind of error, never the text of the error: it could repeat a request.
    console.error(
      JSON.stringify({ event: 'reputation_api_error', error: error instanceof Error ? error.name : 'unknown' }),
    );
    return errorResponse(failures.internal());
  });

  return {
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`)) {
        url.pathname = url.pathname.slice(BASE.length) || '/';
        return app.fetch(new Request(url, request));
      }
      return app.fetch(request);
    },
  };
}

/**
 * The sybil limits of section 8, in front of `POST /api/agents`. Only a signed-in wallet and an active
 * season are checked here: everything else is still the Phase 1 route's to refuse. What was reserved is
 * given back when the response is not a 201.
 */
export function createAgentCreationMiddleware(deps: ReputationApiDeps): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.raw.headers.get('cookie') === null) return next();
    // The route's own gate runs first: origin, type, session, `write` rule, the wallet's daily count and
    // six rows of the day's budget. Nothing is reserved for a request the route would refuse anyway.
    const session = await requireWriter(deps, c.req.raw, 6);
    const now = deps.now();
    const season = await deps.store.getActiveSeason(now.toISOString());
    if (season === null) return next();

    // A name that a listing already uses is refused before any counter is taken. A body that is not
    // valid is left to the route, which says why.
    let name: string | null = null;
    try {
      name = (await readInput(createAgentInputSchema, c.req.raw.clone())).name;
    } catch {
      name = null;
    }
    if (name === null) return next();
    if (await deps.reputation.nameKeyTaken(agentNameKey(name))) throw failures.nameTaken();

    const reservation = await deps.guard.reserve({
      owner: session.address,
      networkSubject: clientNetwork(c.req.raw),
      seasonId: season.id,
      now,
    });
    try {
      await next();
    } catch (error) {
      await deps.guard.release(reservation);
      throw error;
    }
    if (c.res.status !== 201) await deps.guard.release(reservation);
    return undefined;
  };
}
