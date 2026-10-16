import type {
  ApiApp,
  ApiDeps,
  LiveLinkStore,
  PollApiDeps,
  PushApiDeps,
  RateLimitRule,
  ReputationApiDeps,
  RoomHoldersApiDeps,
  RoomPictureApiDeps,
  SocialApiDeps,
  TapeApiDeps,
  TokenApiDeps,
} from '@prix/contracts';
import { ROOM_PICTURES_PATH } from '@prix/contracts';
import type { ExecutionContext } from 'hono';
import { Hono } from 'hono';
import { ApiFailure, errorResponse, failures, isDailyLimitError } from './errors.ts';
import type { FollowRouteDeps } from './follow/index.ts';
import { createFollowRoutes } from './follow/index.ts';
import { assertBodyDeclaredSmall, clientSubject, enforceLimit } from './guard.ts';
import { createLiveDelay } from './league/delay.ts';
import { createPollRoutes } from './polls/index.ts';
import { createPushRoutes } from './push/index.ts';
import { createAgentCreationMiddleware, createReputationApp } from './reputation/index.ts';
import { registerAccountRoutes } from './routes-account.ts';
import { registerAdminRoutes } from './routes-admin.ts';
import { registerPublicRoutes } from './routes-public.ts';
import { registerSessionRoutes } from './routes-session.ts';
import { warmSignIn } from './siwe.ts';
import {
  createRoomAdminRoutes,
  createRoomPictureAdminRoutes,
  createRoomPictureRoutes,
  createRoomRoutes,
  createSocialAdminRoutes,
  createSocialRoutes,
} from './social/index.ts';
import { registerTapeRoutes } from './tape/index.ts';
import { createTokenRoutes } from './token/index.ts';

export type { FollowRouteDeps, LoungeRouteDeps } from './follow/index.ts';
export type { LiveDelay } from './league/delay.ts';
export { createLiveDelay } from './league/delay.ts';
export { warmSignIn } from './siwe.ts';

/** The two steps of signing in. They are limited by `sign_in`; every other request by `read`. */
const SIGN_IN_PATHS: ReadonlySet<string> = new Set(['/api/siwe/nonce', '/api/siwe/verify']);

// The first signature recovery in a fresh Worker is the slow one. It is done here, when the
// module loads and outside any request, so no sign-in pays for it inside its CPU limit.
void warmSignIn();

/** What the later phases add to the app. A phase that is absent has no routes. */
export interface AppExtras {
  reputation?: ReputationApiDeps;
  /**
   * Phase 3's routes. From Phase 6.8 on they take `FollowApiDepsWithLounge` (docs/contracts/phase-6-holders-2.md
   * section 4): the webhook judges join requests and `GET /api/lounge` is mounted while `lounge` is not null.
   * `FollowRouteDeps` is that type with the one read the join needs beside it (`lounge.holding`), optional.
   */
  follow?: FollowRouteDeps;
  token?: TokenApiDeps;
  push?: PushApiDeps;
  /** Phase 6 public and owner routes: given only while SOCIAL_ENABLED is on (docs/contracts/phase-6-social.md 4.1). */
  social?: SocialApiDeps;
  /** Phase 6 admin routes: always given, so a war can run before launch; anyone else gets the generic 404. */
  socialAdmin?: SocialApiDeps;
  /**
   * Phase 6.3, the room's status, read, `me` and write: given only while SOCIAL_ENABLED and ROOM_ENABLED
   * are both on (docs/contracts/phase-6-room.md section 8). Given with `roomEnabled` false, it mounts nothing.
   * From Phase 6.8 on it takes `RoomHoldersApiDeps`: the Holder mark and the caps by tier while
   * `roomHoldersOn` and `holdersGate` are given (docs/contracts/phase-6-holders-2.md section 2).
   */
  room?: RoomHoldersApiDeps;
  /** The room's admin routes: always given, so a switched-off room can still be cleaned; anyone else gets the generic 404. */
  roomAdmin?: RoomPictureApiDeps;
  /**
   * Phase 6.4, the upload of a picture, its bytes and the report: given only while SOCIAL_ENABLED,
   * ROOM_ENABLED and ROOM_PICTURES_ENABLED are all on (docs/contracts/phase-6-pictures.md section 10).
   * Given with `picturesEnabled` false, it mounts nothing. From this phase on `room` and `roomAdmin` take
   * the same type: the read and `me` carry pictures while pictures are enabled, and a hide and a mute
   * delete a picture's bytes whatever the switch says.
   */
  roomPictures?: RoomHoldersApiDeps;
  /** The admin's look at a picture, the reported list, keep and the switch: always given; anyone else gets the generic 404. */
  roomPicturesAdmin?: RoomPictureApiDeps;
  /**
   * The agents linked to a Prix Live wallet, whose day the public reads hold back until 20:00 UTC. Prix Live
   * is not part of this repository: its entry gives no links, and only the tests of the delay give some.
   */
  live?: { links?: LiveLinkStore | null; service?: null; enabled?: boolean };
  /**
   * Phase 6.7, the holders' poll (docs/contracts/phase-6-holders.md section 4.4, revision 3, HB-3). When given,
   * `createPollRoutes` is always mounted: the admin tally always, and the vote, `/polls`, `/polls/me` and
   * `/polls/status` only while `pollsEnabled`. Off, each of those four paths is the generic 404.
   */
  polls?: PollApiDeps;
  /**
   * Phase 6.8, the holders' tape (docs/contracts/phase-6-holders-2.md section 3.1): given by the entry only
   * while TAPE_ENABLED and SOCIAL_ENABLED are both on, and mounted whenever it is given. Absent, /api/tape
   * is the generic 404.
   */
  tape?: TapeApiDeps;
}

/**
 * The HTTP API. docs/CONTRACTS.md sections 4 and 15 list the routes and their rules.
 *
 * Every rule that matters is enforced here and nowhere else, so nothing in a request is
 * trusted for a price, a fill, a score, a rank, a tier or a balance:
 *
 * - every request is rate limited by address before anything else happens: the two sign-in
 *   steps by `sign_in`, everything else by `read`, and every write again by wallet, by `write`;
 * - a body larger than `MAX_BODY_BYTES` is refused before it is parsed; the one exemption is the upload
 *   of a picture, whose own first step judges the declared length before a byte is read;
 * - every input is validated with the strict schemas of `packages/contracts`;
 * - a request that changes state must come from the site, with the JSON content type; the upload of a
 *   picture has a guard of its own (`assertPictureFromSite`), and nothing of it is trusted but the bytes
 *   the contract's rule hands back;
 * - a route that names a record checks that the record belongs to the signed-in wallet;
 * - a model key is sealed before it is stored, and this folder has no code that opens one.
 *
 * The API sends no CORS headers, and answers a preflight like any unknown route, so a script on
 * another site can read nothing and write nothing.
 *
 * It depends on the ports in `ApiDeps` only. No route moves, holds or orders anything real.
 */
export function createApp(deps: ApiDeps, extras: AppExtras = {}): ApiAppWithContext {
  const admins: ReadonlySet<string> = new Set(deps.config.adminAddresses.map((address) => address.toLowerCase()));

  // One copy of the linked agents per app, so per isolate, read at most every 30 seconds.
  const liveDelay = createLiveDelay(extras.live?.links);

  const routes = new Hono();
  if (extras.reputation !== undefined) {
    // Phase 2: the sybil limits in front of POST /api/agents, then its own routes under /api/reputation.
    const creation = createAgentCreationMiddleware(extras.reputation);
    routes.use('/agents', (c, next) => (c.req.method === 'POST' ? creation(c, next) : next()));
    const reputation = createReputationApp(extras.reputation);
    routes.all('/reputation/*', (c) => reputation.fetch(c.req.raw));
  }
  registerPublicRoutes(routes, deps, liveDelay);
  registerSessionRoutes(routes, deps);
  registerAccountRoutes(routes, deps, admins);
  registerAdminRoutes(routes, deps, admins);
  // Phase 3 and Phase 4 routes sit at the root of /api, behind the same guard and error handler.
  // The admins' set goes third, after the Live delay (docs/contracts/phase-6-holders.md section 7, HB3-2):
  // the webhook's two admin routes check it.
  if (extras.follow !== undefined) routes.route('/', createFollowRoutes(extras.follow, liveDelay, admins));
  if (extras.push !== undefined) routes.route('/', createPushRoutes(extras.push));
  if (extras.token !== undefined) routes.route('/', createTokenRoutes({ ...deps, token: extras.token }, admins));
  // Phase 6 (docs/contracts/phase-6-social.md section 10): the admin routes whatever the switch says,
  // the public and owner routes only while it is on. Off, every public /api/social path is the generic 404.
  if (extras.socialAdmin !== undefined) routes.route('/', createSocialAdminRoutes(extras.socialAdmin));
  if (extras.social !== undefined) routes.route('/', createSocialRoutes(extras.social));
  // Phase 6.3 (docs/contracts/phase-6-room.md section 8): the room's admin routes whatever its switch says,
  // its public and writer routes only while it is on. Off, each of those four paths is the generic 404.
  if (extras.roomAdmin !== undefined) routes.route('/', createRoomAdminRoutes(extras.roomAdmin));
  if (extras.room !== undefined) routes.route('/', createRoomRoutes(extras.room));
  // Phase 6.4 (docs/contracts/phase-6-pictures.md section 10): the admin's picture routes whatever any
  // switch says, the upload, the bytes and the report only while pictures are enabled.
  if (extras.roomPicturesAdmin !== undefined) {
    routes.route('/', createRoomPictureAdminRoutes(extras.roomPicturesAdmin));
  }
  if (extras.roomPictures !== undefined) routes.route('/', createRoomPictureRoutes(extras.roomPictures));
  // Phase 6.7 (docs/contracts/phase-6-holders.md section 4.4): what POLLS_ENABLED mounts is decided inside.
  if (extras.polls !== undefined) routes.route('/', createPollRoutes(extras.polls));
  // Phase 6.8 (docs/contracts/phase-6-holders-2.md section 3.1): the tape, with the Live hold of this app.
  if (extras.tape !== undefined) registerTapeRoutes(routes, extras.tape, liveDelay);

  const app = new Hono();

  app.use('*', async (c, next) => {
    // `c.req.path` is the path the router itself matches, after it has decoded percent-encoding.
    // The rule is chosen from that and never from the URL as it was written: `/api/siwe/%6eonce`
    // reaches the nonce route, and must be counted as the sign-in step it is.
    const rule: RateLimitRule = SIGN_IN_PATHS.has(c.req.path) ? 'sign_in' : 'read';
    await enforceLimit(deps, rule, clientSubject(c.req.raw));
    // The one exemption of the 16,384 bytes (docs/contracts/phase-6-pictures.md section 5): the upload of a
    // picture, by exactly this path and this method. Its own first step judges the declared length in
    // their place, before a byte is read, and where the route is not mounted nothing reads the body.
    if (!(c.req.method === 'POST' && c.req.path === ROOM_PICTURES_PATH)) assertBodyDeclaredSmall(c.req.raw);
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

  // The request's execution context goes on to the routes as it came (docs/contracts/phase-6-pictures.md
  // section 5): the upload of a picture hands its later steps to `waitUntil`. A caller that has none
  // hands none, and the one route that needs it then answers 500 with nothing spent.
  return { fetch: async (request, ctx) => app.fetch(request, undefined, ctx) };
}

/**
 * What `createApp` answers: `ApiApp`, whose `fetch` also takes the request's execution context. The
 * entry hands its `ctx` at every call.
 */
export interface ApiAppWithContext extends ApiApp {
  fetch(request: Request, ctx?: ExecutionContext): Promise<Response>;
}
