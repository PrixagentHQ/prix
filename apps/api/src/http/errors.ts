import type { ApiError, ApiErrorCode } from '@prix/contracts';
import { DailyLimitError, MAX_MODEL_KEYS_PER_WALLET, MAX_PROMPT_CHANGES_PER_DAY } from '@prix/contracts';

/** The status code of every error code. docs/CONTRACTS.md sections 4 and 15. */
const STATUS: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  name_taken: 409,
  name_not_allowed: 409,
  owner_has_agent: 409,
  league_full: 409,
  key_limit_reached: 409,
  rate_limited: 429,
  daily_limit: 503,
  no_active_season: 503,
  internal: 500,
};

/**
 * An error the client is told about. The message is written here, by hand, for the person
 * reading it. It never carries anything from a request, a record or a thrown error.
 */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly field: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: ApiErrorCode, message: string, field: string | null = null, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.field = field;
    this.headers = headers;
  }
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

/** Who may keep a copy of a response. Only a public read may be cached. */
export type CachePolicy = 'public' | 'private';

function cacheControl(policy: CachePolicy): string {
  return policy === 'public' ? 'public, max-age=30' : 'no-store';
}

/** A JSON response. The type argument is the response shape from `packages/contracts`. */
export function json<T>(body: T, status: number, policy: CachePolicy, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Cache-Control': cacheControl(policy), ...headers },
  });
}

/** A 204. Only routes for a signed-in wallet answer without a body, so it is never cached. */
export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

/** An error response in the shape of `apiErrorSchema`. An error is never cached. */
export function errorResponse(failure: ApiFailure): Response {
  const body: ApiError = { error: { code: failure.code, message: failure.message, field: failure.field } };
  return json(body, STATUS[failure.code], 'private', { ...failure.headers });
}

/** Whole seconds from `now` to the next 00:00 UTC, when every daily count starts again. At least one. */
export function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** True if a thrown value is the store's own DailyLimitError. Matched by type, never by text. */
export function isDailyLimitError(error: unknown): boolean {
  return error instanceof DailyLimitError;
}

// --- the sentences ------------------------------------------------------------------------------

export const failures = {
  unauthorized: () => new ApiFailure('unauthorized', 'You are not signed in. Sign in with your wallet and try again.'),
  /** One sentence for every failed sign-in check, so a response never says which check failed. */
  signInFailed: () =>
    new ApiFailure('unauthorized', 'Sign-in failed. Request a new sign-in message, sign it, and try again.'),
  badRequestOrigin: () =>
    new ApiFailure(
      'forbidden',
      'This request was refused. Send it from the Prix site, with the JSON content type, and try again.',
    ),
  /** The guard's answer to an upload of a picture that does not come from the chat's own page as that page sends it. */
  badPictureOrigin: () =>
    new ApiFailure(
      'forbidden',
      'This request was refused. Add the picture on the chat page of the Prix site, and try again.',
    ),
  notAdmin: () => new ApiFailure('forbidden', 'This wallet is not an admin. Sign in with an admin wallet.'),
  notYourAgent: () =>
    new ApiFailure('forbidden', 'This agent belongs to another wallet. Sign in with the wallet that created it.'),
  routeNotFound: () => new ApiFailure('not_found', 'There is no such API route. Check the address and the method.'),
  agentNotFound: () => new ApiFailure('not_found', 'No agent has this id. Check the link, or open the league.'),
  seasonNotFound: () =>
    new ApiFailure(
      'not_found',
      'Nothing in the league matches this request. Ask without a period to see the league as it is now.',
    ),
  modelKeyNotFound: () =>
    new ApiFailure('not_found', 'No model key with this id is stored for your wallet. Add a key, then use its id.'),
  holdNotFound: () =>
    new ApiFailure('not_found', 'This symbol is not waiting for a release. Reload the list of holds and try again.'),
  nameTaken: () => new ApiFailure('name_taken', 'Another agent already uses this name. Choose a different name.'),
  nameNotAllowed: () => new ApiFailure('name_not_allowed', 'This name is not allowed. Choose a different name.'),
  ownerHasAgent: () =>
    new ApiFailure(
      'owner_has_agent',
      'This wallet is at its limit of agents. Edit one of them, or see the token page for more slots.',
    ),
  leagueFull: () =>
    new ApiFailure(
      'league_full',
      'This division has as many agents as it can run right now. Choose the other division, or try again later.',
    ),
  keyLimitReached: () =>
    new ApiFailure(
      'key_limit_reached',
      `This wallet already stores ${MAX_MODEL_KEYS_PER_WALLET} model keys, which is the most it may. Delete one, then add the new key.`,
    ),
  noActiveSeason: () =>
    new ApiFailure('no_active_season', 'The league is not running yet, so new agents cannot join. Try again later.'),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiFailure('rate_limited', 'Too many requests. Wait a minute and try again.', null, {
      'Retry-After': String(retryAfterSeconds),
    }),
  promptChangeLimit: (now: Date) =>
    new ApiFailure(
      'rate_limited',
      `This strategy has already been changed ${MAX_PROMPT_CHANGES_PER_DAY} times today, which is the most allowed in a day. Change it again after 00:00 UTC.`,
      'prompt',
      { 'Retry-After': String(secondsToUtcMidnight(now)) },
    ),
  dailyLimit: (now: Date) =>
    new ApiFailure(
      'daily_limit',
      'Prix has used up a daily limit of its hosting, so the league is paused. Nothing was lost. Try again after 00:00 UTC.',
      null,
      { 'Retry-After': String(secondsToUtcMidnight(now)) },
    ),
  bodyTooLarge: () =>
    new ApiFailure('invalid_input', 'The request body is too large or is not text. Send a small JSON object.'),
  invalidInput: (message: string, field: string | null) => new ApiFailure('invalid_input', message, field),
  internal: () => new ApiFailure('internal', 'Something went wrong on our side. Try again in a moment.'),
};
