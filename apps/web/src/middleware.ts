import { defineMiddleware } from 'astro:middleware';
import { PRIVATE_CACHE_CONTROL, readSessionCookie } from './lib/session.ts';

/**
 * Security headers for every response the site Worker produces.
 *
 * The Content-Security-Policy of a page comes from Astro (`security.csp` in astro.config.mjs),
 * which knows the hash of every script and style on it. This file adds the policy for every
 * other response, and the headers that do not depend on the page.
 *
 * It also marks every response to a request that carries the session cookie as private, so
 * that no cache stores a page made for one person (docs/CONTRACTS.md section 15). This is the
 * place that can do it for certain: a header that a component sets while a page is streaming
 * can arrive after Astro has copied the headers.
 *
 * Files under /_astro/ and public files are served by Workers static assets and never reach
 * this code. public/_headers gives them the same headers. Keep the two in step.
 */

const STATIC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // For browsers that do not read frame-ancestors.
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
};

/** For a response that is not a page Astro rendered: a redirect, an error, anything without markup. */
const FALLBACK_POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** `astro dev` injects inline scripts and styles, and Astro sends no policy there. Framing stays forbidden. */
const DEV_POLICY = "frame-ancestors 'none'";

const FIXTURES = typeof __PRIX_FIXTURES__ !== 'undefined' && __PRIX_FIXTURES__;
const THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]']);

function secure(response: Response, personal: boolean): Response {
  let secured = response;
  try {
    secured.headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    // The headers of some responses cannot be changed. A copy can.
    secured = new Response(response.body, response);
  }
  for (const [name, value] of Object.entries(STATIC_HEADERS)) secured.headers.set(name, value);
  if (!secured.headers.has('Content-Security-Policy')) {
    secured.headers.set('Content-Security-Policy', import.meta.env.DEV ? DEV_POLICY : FALLBACK_POLICY);
  }
  if (import.meta.env.PROD) secured.headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (FIXTURES) secured.headers.set('X-Prix-Fixtures', '1');
  // What this Worker answers depends on whether the request carries a session.
  secured.headers.append('Vary', 'Cookie');
  if (personal) secured.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
  // Cloudflare adds the script of its Web Analytics to every page it proxies, unless the page
  // says that it must not be changed on the way. The policy above blocks that script, so it
  // only ever left an error in the console; `no-transform` keeps it from being added at all.
  const control = secured.headers.get('Cache-Control');
  if (control === null) {
    secured.headers.set('Cache-Control', 'public, max-age=0, must-revalidate, no-transform');
  } else if (!/\bno-transform\b/i.test(control)) {
    secured.headers.set('Cache-Control', `${control}, no-transform`);
  }
  return secured;
}

/**
 * The types this Worker compresses: its pages and the few text answers it writes itself.
 * Fonts, images and built files never reach this code (Workers static assets serves them).
 */
const COMPRESSIBLE =
  /^(text\/(?!event-stream)|application\/(json|xml|rss\+xml|atom\+xml|manifest\+json)|image\/svg\+xml)/i;

/** True when the visitor's Accept-Encoding takes gzip with a weight above zero. */
function acceptsGzip(acceptEncoding: string | null | undefined): boolean {
  if (!acceptEncoding) return false;
  let gzip: number | null = null;
  let star: number | null = null;
  for (const part of acceptEncoding.split(',')) {
    const [rawName = '', ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    let weight = 1;
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key?.trim().toLowerCase() === 'q') {
        const parsed = Number.parseFloat(value ?? '');
        weight = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (name === 'gzip' || name === 'x-gzip') gzip = Math.max(gzip ?? 0, weight);
    else if (name === '*') star = weight;
  }
  return (gzip ?? star ?? 0) > 0;
}

/**
 * The Accept-Encoding the visitor sent. In front of a Worker, Cloudflare may rewrite the header
 * to a canonical value and keeps the original in `request.cf.clientAcceptEncoding`.
 */
function visitorAcceptEncoding(request: Request): string | null {
  const cf = (request as Request & { cf?: { clientAcceptEncoding?: unknown } }).cf;
  const original = cf?.clientAcceptEncoding;
  return typeof original === 'string' ? original : request.headers.get('Accept-Encoding');
}

/**
 * Gzips the body of a page in the Worker itself.
 *
 * Every response says `no-transform` (above), and Cloudflare does not compress a response that
 * says it, so the HTML left uncompressed: 80 KB for the home page where gzip makes 12 KB
 * (docs/DECISIONS.md D-110). A body the Worker has already encoded passes Cloudflare unchanged,
 * and `no-transform` stays, so the Web Analytics script is still not added.
 *
 * `encodeBody: 'manual'` tells the Workers runtime that the bytes are already gzip: without it
 * the runtime would compress them a second time because of the Content-Encoding header.
 */
function compress(request: Request, response: Response): Response {
  if (import.meta.env.DEV) return response;
  if (request.method === 'HEAD' || response.body === null) return response;
  if (response.status === 204 || response.status === 206 || response.status === 304) return response;
  if (response.headers.has('Content-Encoding')) return response;
  if (!COMPRESSIBLE.test(response.headers.get('Content-Type') ?? '')) return response;
  // The answer depends on Accept-Encoding whether or not this visitor gets gzip.
  response.headers.append('Vary', 'Accept-Encoding');
  if (!acceptsGzip(visitorAcceptEncoding(request))) return response;

  const headers = new Headers(response.headers);
  headers.set('Content-Encoding', 'gzip');
  headers.delete('Content-Length');
  const etag = headers.get('ETag');
  if (etag && !etag.startsWith('W/')) headers.set('ETag', `W/${etag}`);
  const init: ResponseInit & { encodeBody?: 'automatic' | 'manual' } = {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: 'manual',
  };
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), init);
}

export const onRequest = defineMiddleware(async (context, next) => {
  // A build with sample data must never answer on a public host name.
  if (FIXTURES && !THIS_MACHINE.has(context.url.hostname)) {
    return secure(
      new Response('This build serves sample data and answers only on this machine.', { status: 503 }),
      false,
    );
  }
  const personal = readSessionCookie(context.request).present;
  return compress(context.request, secure(await next(), personal));
});
