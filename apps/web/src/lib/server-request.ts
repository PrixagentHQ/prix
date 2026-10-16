/**
 * The request the site sends to prix-api through its `API` service binding, built from nothing.
 * src/lib/api-server.ts sends it; this file names no binding, so a test can build one too.
 *
 * It carries four things from the visitor's own request (docs/CONTRACTS.md section 15), and one thing that
 * Cloudflare read about it:
 *
 * - `Cookie`, whole. The API reads the session from it with its own parser, so the site and
 *   the API can never disagree about which session a request carries.
 * - `CF-Connecting-IP`. Cloudflare sets it on the visitor's request, and the API counts its
 *   rate limits by it. Without it the API refuses, which is the safe side.
 * - `Origin`, on a request that changes state. The API accepts such a request only from the
 *   site's own origin. The header is passed on and never made up here: a write that some other
 *   site caused, or one attempted while rendering an ordinary page view, reaches the API
 *   without the right origin and is refused.
 * - The visitor's country as Cloudflare read it (`request.cf.country`), never the incoming
 *   `CF-IPCountry` header.
 *
 * No other header of the visitor travels.
 */

/** One call, as src/lib/api.ts describes it (`ApiCall`). */
export interface ServerCall {
  method: string;
  /** Path and query, for example /api/league?division=open. */
  path: string;
  /** The JSON body, for a request that has one. */
  body?: unknown;
}

/** A two-character code as Cloudflare writes one: a country, or its own T1 and XX. */
const COUNTRY = /^[A-Z][A-Z0-9]$/;

/** The country Cloudflare read for this request, upper case, or null when it read none. */
export function countryCloudflareRead(visitor: Request): string | null {
  const cf = (visitor as { cf?: { country?: unknown } | null }).cf;
  const country = typeof cf?.country === 'string' ? cf.country.trim().toUpperCase() : '';
  return COUNTRY.test(country) ? country : null;
}

export function serverRequest(visitor: Request, origin: string, call: ServerCall): Request {
  const sent = visitor.headers;
  const headers = new Headers({ accept: 'application/json' });
  const cookie = sent.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const address = sent.get('cf-connecting-ip');
  if (address) headers.set('cf-connecting-ip', address);
  const country = countryCloudflareRead(visitor);
  if (country !== null) headers.set('cf-ipcountry', country);
  if (call.method !== 'GET') {
    // The API requires this of every request that changes state, with or without a body.
    headers.set('content-type', 'application/json');
    const from = sent.get('origin');
    if (from) headers.set('origin', from);
  }
  const init: RequestInit & { cf?: { country: string } } = {
    method: call.method,
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  };
  // `cf` is part of a Worker's Request and not of the DOM's: the callee of a service binding gets it as sent.
  if (country !== null) init.cf = { country };
  return new Request(new URL(call.path, origin), init);
}
