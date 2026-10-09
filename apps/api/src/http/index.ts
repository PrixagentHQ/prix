import type {
  ApiApp,
  ApiDeps,
  FollowApiDeps,
  PushApiDeps,
  RateLimitRule,
  ReputationApiDeps,
  SocialApiDeps,
  TokenApiDeps,
} from '@prix/contracts';
import { Hono } from 'hono';
import { ApiFailure, errorResponse, failures, isDailyLimitError } from './errors.ts';
import { createFollowRoutes } from './follow/index.ts';
import { assertBodyDeclaredSmall, clientSubject, enforceLimit } from './guard.ts';
import { createPushRoutes } from './push/index.ts';
import { createAgentCreationMiddleware, createReputationApp } from './reputation/index.ts';
import { registerAccountRoutes } from './routes-account.ts';
import { registerAdminRoutes } from './routes-admin.ts';
import { registerPublicRoutes } from './routes-public.ts';
import { registerSessionRoutes } from './routes-session.ts';
import { warmSignIn } from './siwe.ts';
import { createSocialAdminRoutes, createSocialRoutes } from './social/index.ts';
import { createTokenRoutes } from './token/index.ts';

export { warmSignIn } from './siwe.ts';

/** The two steps of signing in. They are limited by `sign_in`; every other request by `read`. */
const SIGN_IN_PATHS: ReadonlySet<string> = new Set(['/api/siwe/nonce', '/api/siwe/verify']);

// The first signature recovery in a fresh Worker is the slow one. It is done here, when the
// module loads and outside any request, so no sign-in pays for it inside its CPU limit.
void warmSignIn();

/** What the later phases add to the app. A phase that is absent has no routes. */
export interface AppExtras {
  reputation?: ReputationApiDeps;
  follow?: FollowApiDeps;
  token?: TokenApiDeps;
  push?: PushApiDeps;
  /** Phase 6 public and owner routes: given only while SOCIAL_ENABLED is on (docs/contracts/phase-6-social.md 4.1). */
  social?: SocialApiDeps;
  /** Phase 6 admin routes: always given, so a war can run before launch; anyone else gets the generic 404. */
  socialAdmin?: SocialApiDeps;
}

/**
 * The HTTP API. docs/CONTRACTS.md sections 4 and 15 list the routes and their rules.
 *
 * Every rule that matters is enforced here and nowhere else, so nothing in a request is
 * trusted for a price, a fill, a score, a rank, a tier or a balance:
 *
 * - every request is rate limited by address before anything else happens: the two sign-in
 *   steps by `sign_in`, everything else by `read`, and every write again by wallet, by `write`;
 * - a body larger than `MAX_BODY_BYTES` is refused before it is parsed;
 * - every input is validated with the strict schemas of `packages/contracts`;
 * - a request that changes state must come from the site, with the JSON content type;
 * - a route that names a record checks that the record belongs to the signed-in wallet;
 * - a model key is sealed before it is stored, and this folder has no code that opens one.
 *
 * The API sends no CORS headers, and answers a preflight like any unknown route, so a script on
 * another site can read nothing and write nothing.
 *
 * It depends on the ports in `ApiDeps` only. No route moves, holds or orders anything real.
 */
export function createApp(deps: ApiDeps, extras: AppExtras = {}): ApiApp {
  const admins: ReadonlySet<string> = new Set(deps.config.adminAddresses.map((address) => address.toLowerCase()));

  const routes = new Hono();
  if (extras.reputation !== undefined) {
    // Phase 2: the sybil limits in front of POST /api/agents, then its own routes under /api/reputation.
    const creation = createAgentCreationMiddleware(extras.reputation);
    routes.use('/agents', (c, next) => (c.req.method === 'POST' ? creation(c, next) : next()));
    const reputation = createReputationApp(extras.reputation);
    routes.all('/reputation/*', (c) => reputation.fetch(c.req.raw));
  }
  registerPublicRoutes(routes, deps);
  registerSessionRoutes(routes, deps);
  registerAccountRoutes(routes, deps, admins);
  registerAdminRoutes(routes, deps, admins);
  // Phase 3 and Phase 4 routes sit at the root of /api, behind the same guard and error handler.
  if (extras.follow !== undefined) routes.route('/', createFollowRoutes(extras.follow));
  if (extras.push !== undefined) routes.route('/', createPushRoutes(extras.push));
  if (extras.token !== undefined) routes.route('/', createTokenRoutes({ ...deps, token: extras.token }, admins));
  // Phase 6 (docs/contracts/phase-6-social.md section 10): the admin routes whatever the switch says,
  // the public and owner routes only while it is on. Off, every public /api/social path is the generic 404.
  if (extras.socialAdmin !== undefined) routes.route('/', createSocialAdminRoutes(extras.socialAdmin));
  if (extras.social !== undefined) routes.route('/', createSocialRoutes(extras.social));

  const app = new Hono();

  app.use('*', async (c, next) => {
    // `c.req.path` is the path the router itself matches, after it has decoded percent-encoding.
    // The rule is chosen from that and never from the URL as it was written: `/api/siwe/%6eonce`
    // reaches the nonce route, and must be counted as the sign-in step it is.
    const rule: RateLimitRule = SIGN_IN_PATHS.has(c.req.path) ? 'sign_in' : 'read';
    await enforceLimit(deps, rule, clientSubject(c.req.raw));
    assertBodyDeclaredSmall(c.req.raw);
    await next();
  });

  app.route('/api', routes);

  app.notFound(() => errorResponse(failures.routeNotFound()));

  app.onError((error, c) => {
    if (error instanceof ApiFailure) return errorResponse(error);
    // A used-up daily limit of the free plan is not a fault of the request and not a bug. The
    // answer says so, and says when it ends.
    const dailyLimit = isDailyLimitError(error);
    // The log line names the route and the kind of error, never the error's text: a message
    // from deeper down could repeat part of a request, and a request can carry a key or a prompt.
    console.error(
      JSON.stringify({
        event: dailyLimit ? 'api_daily_limit' : 'api_error',
        method: c.req.method,
        route: c.req.routePath,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return errorResponse(dailyLimit ? failures.dailyLimit(deps.now()) : failures.internal());
  });

  return { fetch: async (request) => app.fetch(request) };
}
