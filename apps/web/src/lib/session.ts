import { SESSION_COOKIE } from '@prix/contracts';

/**
 * What the site Worker can tell about a visitor's session from the request alone.
 *
 * The site never decides who somebody is: only the API can turn the cookie into a wallet.
 * This file answers two cheaper questions, the same way for the middleware and for
 * `readAccount`: is the answer personal, and is it worth asking the API at all.
 */

/** 32 random bytes in base64url are 43 characters (docs/CONTRACTS.md section 15). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface SessionCookieState {
  /** True when the request names the session cookie at all, whatever its value. */
  present: boolean;
  /** True when the value has the shape of a session token. The API refuses any other value. */
  wellFormed: boolean;
}

/** Reads the first cookie with the session's name, as the API does. */
export function readSessionCookie(request: Request): SessionCookieState {
  const header = request.headers.get('cookie');
  if (!header) return { present: false, wellFormed: false };
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    return { present: true, wellFormed: TOKEN_SHAPE.test(part.slice(at + 1).trim()) };
  }
  return { present: false, wellFormed: false };
}

/** What a response made for one person carries, so that no cache stores it. */
export const PRIVATE_CACHE_CONTROL = 'private, no-store';
