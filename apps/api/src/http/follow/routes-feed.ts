import type {
  AgentFeedResponse,
  FeedQuery,
  FollowApiDeps,
  FollowingFeedResponse,
  LeagueFeedResponse,
} from '@prix/contracts';
import { feedQuerySchema, idSchema } from '@prix/contracts';
import type { Hono } from 'hono';
import { failures, json } from '../errors.ts';
import { readSession, requireSession } from '../guard.ts';
import { matches, readQuery } from '../input.ts';
import { readSessionToken } from '../session.ts';
import type { FeedCursorSigner } from './feed-cursor.ts';
import { createFeedCursorSigner } from './feed-cursor.ts';

/**
 * The query of a feed read, with its cursor checked: a cursor this API did not sign is answered with
 * 400 `invalid_input` on the field `cursor` here, before the route reads a session, an agent or a row
 * (docs/CONTRACTS.md section 20). So no invented cursor ever costs a database read.
 */
async function readFeedQuery(signer: FeedCursorSigner, url: string): Promise<FeedQuery> {
  const query = readQuery(feedQuerySchema, url);
  if (query.cursor !== undefined && (await signer.verify(query.cursor)) === null) {
    throw failures.invalidInput(
      'This page link is not one the feed gave out. Load the feed again from its first page.',
      'cursor',
    );
  }
  return query;
}

/** Signs the next page's cursor, which the feed port gives as the unsigned `tickId~agentId`. */
async function withSignedCursor<T extends { nextCursor: string | null }>(
  signer: FeedCursorSigner,
  page: T,
): Promise<T> {
  if (page.nextCursor === null) return page;
  const [tickId, agentId, rest] = page.nextCursor.split('~');
  if (tickId === undefined || agentId === undefined || rest !== undefined) {
    throw new Error('the feed port gave a next cursor that is not tickId~agentId');
  }
  return { ...page, nextCursor: await signer.sign({ tickId, agentId }) };
}

export function registerFeedRoutes(routes: Hono, deps: FollowApiDeps): void {
  // Built once with the routes; the key is derived on first use and kept for the life of the isolate.
  const signer = createFeedCursorSigner(deps.config.nonceSecret);

  routes.get('/agents/:id/feed', async (c) => {
    const id = c.req.param('id');
    if (!matches(idSchema, id)) throw failures.agentNotFound();
    const query = await readFeedQuery(signer, c.req.url);
    // Any session cookie makes the answer private. Only a request without one may be cached,
    // and it is always the answer for a viewer who is not signed in.
    const hasCookie = readSessionToken(c.req.raw) !== null;
    const session = hasCookie ? await readSession(deps, c.req.raw) : null;
    const feed = await deps.feed.agentFeed(id, session?.address ?? null, query);
    if (feed === null) throw failures.agentNotFound();
    return json<AgentFeedResponse>(await withSignedCursor(signer, feed), 200, hasCookie ? 'private' : 'public');
  });

  // The league feed is the same for everyone (docs/CONTRACTS.md section 17). This route reads no
  // session and no cookie, so nothing about the person who asks can reach the answer, and the
  // answer is public whoever asks. The query is the strict one of the other feeds: it has no
  // parameter for a delay.
  routes.get('/feed/league', async (c) => {
    const query = await readFeedQuery(signer, c.req.url);
    const feed = await deps.feed.leagueFeed(query);
    return json<LeagueFeedResponse>(await withSignedCursor(signer, feed), 200, 'public');
  });

  routes.get('/feed', async (c) => {
    // The cursor is checked before the session is read: a refused cursor costs no database read.
    const query = await readFeedQuery(signer, c.req.url);
    const session = await requireSession(deps, c.req.raw);
    const feed = await deps.feed.followingFeed(session.address, query);
    return json<FollowingFeedResponse>(await withSignedCursor(signer, feed), 200, 'private');
  });
}
