/**
 * Plain HTTP on the site, decided in one pure function so that it can be tested.
 *
 * The zone's "Always Use HTTPS" switch is off, so the site sends a request whose URL is plain
 * http to https itself (infra/README.md, "Plain HTTP"). Only the requests that reach the Worker
 * are covered: every page and every path that matches no static file. A file that Workers static
 * assets serves (/_astro/*, /sw.js) is answered before any code of this Worker runs.
 */

/** The site's one public origin. A redirect is built from it, never from the request's Host. */
export const SITE_ORIGIN = 'https://prixagent.com';

const PRODUCTION_HOST = new URL(SITE_ORIGIN).hostname;

/**
 * Strict-Transport-Security for every response of the site, in src/middleware.ts and, for static
 * files, in public/_headers. A test keeps the two equal. `includeSubDomains` binds every subdomain
 * of prixagent.com to HTTPS in a browser that has seen it once.
 */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/**
 * The redirect for a request whose URL is plain http on the production host, or null when the
 * request passes through: https, any other host (this machine among them), or a build that is
 * not production (`astro dev`, a fixtures build).
 *
 * 301 for GET and HEAD; 308 for any other method, which a browser repeats with its method and body.
 * The Location is the fixed origin followed by the request's path and query: a path such as
 * `//evil.example` stays a path of prixagent.com.
 */
export function httpsRedirect(url: URL, method: string, options: { production: boolean }): Response | null {
  if (!options.production) return null;
  if (url.protocol !== 'http:') return null;
  if (url.hostname !== PRODUCTION_HOST) return null;
  const upper = method.toUpperCase();
  const status = upper === 'GET' || upper === 'HEAD' ? 301 : 308;
  return new Response(null, { status, headers: { Location: `${SITE_ORIGIN}${url.pathname}${url.search}` } });
}
