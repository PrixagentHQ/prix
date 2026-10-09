import { SESSION_COOKIE, SESSION_TTL_SECONDS } from '@prix/contracts';

/** 32 random bytes in base64url are 43 characters. Anything else is not one of our tokens. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** A new session token: 32 random bytes, base64url. It goes into the cookie and nowhere else. */
export function newSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 of a token, in hex. This is what the store holds. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/** The session token of a request, or null when there is none or it cannot be one of ours. */
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return TOKEN_SHAPE.test(value) ? value : null;
  }
  return null;
}

/**
 * The attributes of the session cookie. The name, `SESSION_COOKIE`, starts with `__Host-`, so a
 * browser keeps the cookie only if it is Secure, has Path=/ and names no Domain. No other site
 * under the same parent domain can plant one.
 */
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';

/** The Set-Cookie value that starts a session. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** The Set-Cookie value that ends a session in the browser. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}
