import type { CreateFeedReadPort, FeedCursor, FeedItem, FeedQuery, FeedRow, FeedStoreQuery } from '@prix/contracts';
import {
  FOLLOW_FEED_WINDOW_DAYS,
  feedCursorBase,
  feedDelayOf,
  isHouseOwner,
  parseFeedCursor,
  visibleCutoff,
} from '@prix/contracts';

/**
 * One feed item. `houseOwners` is `ApiConfig.houseOwners`: the store returns the agent's owner
 * with every feed row, the mark is set from it here, and the owner itself reaches no response.
 * Exported for the holders' tape (docs/contracts/phase-6-holders-2.md section 3.1, step 5), which maps
 * its rows exactly as the league feed does.
 */
export function toFeedItem(feedRow: FeedRow, houseOwners: readonly string[] | undefined): FeedItem {
  const { row } = feedRow;
  return {
    agentId: row.agentId,
    agentName: feedRow.agentName,
    division: row.division,
    tickId: row.tickId,
    at: row.createdAt,
    reason: row.reason ?? '',
    fills: row.fills,
    halted: row.halted,
    equityMicro: row.equityMicro,
    costMicro: row.costMicro,
    simulated: true,
    house: isHouseOwner(houseOwners, feedRow.owner),
  };
}

/**
 * Drops the extra row and says where the next page starts. The store made the cut before the limit.
 *
 * `nextCursor` here is the unsigned `feedCursorBase` of the last item: this port holds no secret. The
 * feed routes sign it before it leaves the API (`routes-feed.ts`, docs/CONTRACTS.md section 20), and
 * they are the only callers of this port.
 */
function page(
  rows: readonly FeedRow[],
  limit: number,
  houseOwners: readonly string[] | undefined,
): { items: FeedItem[]; nextCursor: string | null } {
  const items = rows.slice(0, limit).map((row) => toFeedItem(row, houseOwners));
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined ? feedCursorBase({ tickId: last.tickId, agentId: last.agentId }) : null;
  return { items, nextCursor };
}

/**
 * Where a page starts. The route verified the cursor's signature before it called this port; only
 * the tick and the agent go on to the store.
 */
function before(query: FeedQuery): FeedCursor | null {
  const parsed = query.cursor === undefined ? null : parseFeedCursor(query.cursor);
  return parsed === null ? null : { tickId: parsed.tickId, agentId: parsed.agentId };
}

/**
 * The one place a feed delay is computed. It comes from `entitlements.entitlementsFor(viewer)` and from
 * nothing the client sent. Only the agent's owner is exempt, and only on the feed of that agent.
 */
export const createFeedReadPort: CreateFeedReadPort = (deps) => ({
  async agentFeed(agentId, viewer, query: FeedQuery) {
    const agent = await deps.store.getFeedAgent(agentId);
    if (agent === null) return null;
    const entitlements = await deps.entitlements.entitlementsFor(viewer);
    const isOwner = viewer !== null && viewer.toLowerCase() === agent.owner.toLowerCase();
    const delaySeconds = isOwner ? 0 : entitlements.feedDelaySeconds;
    const storeQuery: FeedStoreQuery = {
      before: before(query),
      notAfter: visibleCutoff(deps.now(), delaySeconds),
      limit: query.limit + 1,
    };
    const rows = await deps.store.listAgentFeed(agentId, storeQuery);
    const { items, nextCursor } = page(rows, query.limit, deps.houseOwners);
    return {
      items,
      nextCursor,
      delay: feedDelayOf(entitlements),
      agent: { id: agent.id, name: agent.name, division: agent.division },
      followerCount: agent.followers,
    };
  },

  async followingFeed(viewer, query) {
    const now = deps.now();
    const entitlements = await deps.entitlements.entitlementsFor(viewer);
    const since = new Date(now.getTime() - FOLLOW_FEED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 13);
    const rows = await deps.store.listFollowFeed(viewer, {
      before: before(query),
      notAfter: visibleCutoff(now, entitlements.feedDelaySeconds),
      limit: query.limit + 1,
      sinceTickId: `${since}:00Z`,
    });
    const { items, nextCursor } = page(rows, query.limit, deps.houseOwners);
    return { items, nextCursor, delay: feedDelayOf(entitlements) };
  },

  /**
   * The league feed takes no viewer, so there is none it could be cut for: the delay is the one
   * of a visitor who is not signed in. That is what lets one stored answer serve every request
   * (docs/CONTRACTS.md section 17). No owner is exempt here, a house wallet included.
   */
  async leagueFeed(query) {
    const entitlements = await deps.entitlements.entitlementsFor(null);
    const rows = await deps.store.listLeagueFeed({
      before: before(query),
      notAfter: visibleCutoff(deps.now(), entitlements.feedDelaySeconds),
      limit: query.limit + 1,
    });
    const { items, nextCursor } = page(rows, query.limit, deps.houseOwners);
    return { items, nextCursor, delay: feedDelayOf(entitlements) };
  },
});
