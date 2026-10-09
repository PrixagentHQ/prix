import type { ApiErrorCode, MeResponse } from '@prix/contracts';
import { SESSION_COOKIE } from '@prix/contracts/constants';
import { text } from '../content/index.ts';
import { apiErrorText } from '../content/states.ts';
import type { ApiContext } from '../lib/api.ts';
import { createApi } from '../lib/api.ts';

/**
 * Server-side helpers of the account screens. Nothing here is imported by a browser script:
 * it reads the copy deck, which stays on the server.
 */

/** Every API error code. The record makes the compiler fail here when the contract adds one. */
const ERROR_CODES: Record<ApiErrorCode, true> = {
  unauthorized: true,
  forbidden: true,
  not_found: true,
  invalid_input: true,
  rate_limited: true,
  name_taken: true,
  name_not_allowed: true,
  owner_has_agent: true,
  league_full: true,
  key_limit_reached: true,
  daily_limit: true,
  no_active_season: true,
  internal: true,
};
const API_ERROR_CODES = Object.keys(ERROR_CODES) as ApiErrorCode[];

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;

/** Who is asking, as the API answers it. The page shows a different screen for each. */
export type Session =
  /** No session cookie: the visitor has not signed in on this browser. */
  | { state: 'signed-out' }
  /** A cookie the API no longer accepts. */
  | { state: 'ended' }
  /** The API could not say. The page says the account could not be loaded. */
  | { state: 'failed'; code: ApiErrorCode }
  | { state: 'signed-in'; me: MeResponse };

function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get('cookie') ?? '';
  return header.split(';').some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

/**
 * The signed-in wallet with its agent and its keys. A visitor without the cookie costs no API
 * call, and the call for a visitor with one is the same call `readAccount` makes for the
 * masthead, so a page view still reads `/api/me` once.
 *
 * This decides what the page shows and nothing else. The API checks every action again.
 */
export async function readSession(context: ApiContext): Promise<Session> {
  const cookie = hasSessionCookie(context.request);
  if (!cookie && !FIXTURES) return { state: 'signed-out' };
  const me = await createApi(context).me();
  if (me.ok) return { state: 'signed-in', me: me.data };
  if (me.error.code === 'unauthorized') return { state: cookie ? 'ended' : 'signed-out' };
  return { state: 'failed', code: me.error.code };
}

/**
 * Where a person goes after signing in: a path on this site, or `fallback`. Anything that
 * could leave the site, or that names the API, is refused.
 */
export function safeNext(value: string | null, fallback: string): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const base = 'https://prix.invalid';
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname.startsWith('/api/') || url.pathname === '/sign-in') return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

/** The address of the sign-in page that returns to `next`. */
export function signInHref(next: string): string {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

/** The page being rendered, as a path: what `next` carries so the person returns to it. */
export function herePath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/**
 * The sentence a form shows for each API error code, as JSON for its script. A form passes
 * its own sentence for a code where what the person was doing makes a more exact one.
 * A code the deck has no sentence for is left out, and the script then uses `internal`.
 */
export function errorSentences(overrides: Partial<Record<ApiErrorCode, string>> = {}): string {
  const sentences: Record<string, string> = {
    offline: text('errors.offline', 'Prix could not be reached. Check your connection and try again.'),
  };
  for (const code of API_ERROR_CODES) {
    const sentence = overrides[code] ?? (apiErrorText(code) as string | undefined);
    if (sentence) sentences[code] = sentence;
  }
  sentences.daily_limit =
    overrides.daily_limit ??
    text(
      'errors.dailyLimit',
      'Prix has used up a daily limit of its hosting, so the league is paused. It resumes after 00:00 UTC.',
    );
  return JSON.stringify(sentences);
}
