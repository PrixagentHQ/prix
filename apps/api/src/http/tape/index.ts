import type { TapeApiDeps, TapeResponse, TapeView } from '@prix/contracts';
import {
  feedDelayOf,
  TAPE_CACHE_SECONDS,
  TAPE_ROWS,
  tapeCacheKey,
  tapeQuerySchema,
  tapeResponseSchema,
  tapeViewOf,
  visibleCutoff,
} from '@prix/contracts';
import type { Context, Hono } from 'hono';
import { toFeedItem } from '../follow/feed-read.ts';
import { readSession } from '../guard.ts';
import { readQuery } from '../input.ts';
import type { LiveDelay } from '../league/delay.ts';
import { delayFeedItems } from '../league/delay.ts';
import { readSessionToken } from '../session.ts';

/**
 * Phase 6.8, H: the holders' tape (docs/contracts/phase-6-holders-2.md section 3.1). Every agent's newest
 * decisions in one answer: as they are made for a viewer whose entitlements carry no feed delay, past the
 * delay for everyone else, and the Prix Live hold applied to every answer, for everyone, before it is ever
 * stored.
 *
 * Nothing of the request decides what is shown: the query must be empty, the view comes from
 * `entitlementsFor` of the session's wallet alone, and the cache key from the configured site origin and
 * that view alone. The tape is public, so there is no 401; a cookie that is not a valid session is no viewer.
 */

/** What every tape answer tells the browser: never keep a copy, the route keeps the shared one. */
const BROWSER_CACHE = 'private, no-store';

/** The Workers cache, when this runtime has one. Read at each request, never kept. */
function defaultCache(): Cache | null {
  try {
    return typeof caches === 'undefined' ? null : caches.default;
  } catch {
    return null;
  }
}

/** The request's execution context, or null when the caller gave none: nothing is stored then. */
function contextOf(c: Context): { waitUntil(promise: Promise<unknown>): void } | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

/** A copy of an answer with the browser's header: the stored copy's own header is never passed on. */
function forBrowser(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': BROWSER_CACHE,
    },
  });
}

export function registerTapeRoutes(routes: Hono, deps: TapeApiDeps, liveDelay: LiveDelay): void {
  routes.get('/tape', async (c) => {
    // 1. The query: strict and empty. Any parameter is 400 before anything is read.
    readQuery(tapeQuerySchema, c.req.url);

    // 2. The viewer: a valid session, or none. Never 401.
    const request = c.req.raw;
    const session = readSessionToken(request) === null ? null : await readSession(deps, request);
    const viewer = session?.address ?? null;

    // 3. The entitlements, without `cachedOnly`, as the agent feed asks; the view from them alone.
    const entitlements = await deps.entitlements.entitlementsFor(viewer);
    const view: TapeView = tapeViewOf(entitlements);

    // 4. The cache, under the view's key: made from the configured origin and the view, never the request.
    const cache = defaultCache();
    const key = tapeCacheKey(deps.config.siteOrigin, view);
    if (cache !== null) {
      try {
        const hit = await cache.match(key);
        if (hit !== undefined) return forBrowser(await hit.text());
      } catch {
        // A cache that cannot be read is a miss.
      }
    }

    // 5. A miss: the newest TAPE_ROWS rows the viewer's delay lets through, mapped as the league feed maps them.
    const at = deps.now();
    const rows = await deps.follow.listLeagueFeed({
      before: null,
      notAfter: visibleCutoff(at, entitlements.feedDelaySeconds),
      limit: TAPE_ROWS,
    });
    const mapped = rows.slice(0, TAPE_ROWS).map((row) => toFeedItem(row, deps.config.houseOwners));

    // 6. The Live hold, for everyone and with no exemption: the answer is shared. `linked` counts every
    //    agent as linked when `live_links` cannot be read.
    const items = await delayFeedItems(liveDelay, mapped, at);

    // 7. The answer, checked, stored under the view's key through `waitUntil` (a failed put never fails the
    //    request), and answered private. Step 6 has always run by here.
    const answer: TapeResponse = tapeResponseSchema.parse({
      view,
      delay: feedDelayOf(entitlements),
      items,
      asOf: at.toISOString(),
    });
    const body = JSON.stringify(answer);
    const ctx = contextOf(c);
    if (cache !== null && ctx !== null) {
      const stored = new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, s-maxage=${TAPE_CACHE_SECONDS}`,
        },
      });
      ctx.waitUntil(cache.put(key, stored).catch(() => undefined));
    }
    return forBrowser(body);
  });
}
