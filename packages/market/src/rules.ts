/**
 * The decision logic of the market: price conversion, validity, staleness and the open rule.
 *
 * Everything here is pure: no clock, no network, no randomness. The same input gives the same
 * output on any machine. docs/CONTRACTS.md section 5, as section 15 changed it, is the rule;
 * RESEARCH.md explains the feeds.
 *
 * Two thresholds decide freshness, and neither lives in this package. Both arrive through
 * `MarketConfig` and are passed down to these functions as arguments:
 * - `staleAfterSeconds` (the contract's FEED_STALE_AFTER_SECONDS) halts one symbol. A feed older
 *   than its 24 hour heartbeat plus a margin has missed a heartbeat in an open market.
 * - `quietAfterSeconds` (the contract's MARKET_QUIET_AFTER_SECONDS) closes the market. The age of
 *   one feed cannot tell an open market from a closed one: these feeds publish on a 0.5% move or
 *   on the heartbeat, so a calm symbol is many hours old in a market that is wide open. The age
 *   of the newest update across the whole universe can. RESEARCH.md, section 5.
 *
 * Section 21 adds crypto assets. Their feeds publish around the clock, so they never decide whether
 * the market is open: `oraclePaused`, the open rule, the quiet rule and MAX_HALTED_FEEDS cover Stock
 * Tokens only, and a crypto feed that is stale (`cryptoStaleAfterSeconds`, the contract's
 * CRYPTO_FEED_STALE_AFTER_SECONDS), invalid or unread halts only its own symbol. RESEARCH.md, section 11.
 */
import type {
  AssetKind,
  MarketClosedReason,
  MarketEndpointFailure,
  MarketSnapshot,
  PricePoint,
  UniverseToken,
} from '@prix/contracts';
import { CHAIN_ID, isStockToken, MAX_HALTED_FEEDS, MIN_PRICE_MICRO } from '@prix/contracts';

/** A feed whose `updatedAt` is further ahead of the snapshot time than this is invalid. */
export const FUTURE_TOLERANCE_SECONDS = 300;

/**
 * An RPC node whose latest block is older than this has not answered for the present: it is behind,
 * or the sequencer is down. The endpoint is treated as failed. Robinhood Chain has no Chainlink
 * sequencer uptime feed (RESEARCH.md, section 3), so the block time is the only such signal.
 */
export const NODE_LAG_TOLERANCE_SECONDS = 300;

/** The newest round of one feed, as `latestRoundData()` returned it. */
export interface FeedRound {
  answer: bigint;
  /** Unix seconds. */
  updatedAt: bigint;
}

/** What one batched read returned for one universe token. `null` marks a call that failed or did not decode. */
export interface FeedRead {
  round: FeedRound | null;
  /** The feed's own `decimals()`. */
  decimals: number | null;
  /** The token's `oraclePaused()`: true while Robinhood has frozen the feed for a corporate action. */
  oraclePaused: boolean | null;
}

/** Why a feed answer cannot be used. Any one of these closes the market with `feed_invalid`. */
export type FeedProblem =
  | 'read_failed'
  | 'decimals_mismatch'
  | 'answer_not_positive'
  | 'price_below_minimum'
  | 'price_not_safe'
  | 'updated_at_zero'
  | 'updated_at_in_future';

/**
 * The feed's answer scaled to six decimals, rounded half up, in BigInt.
 * `(answer * 1_000_000 * 2 + 10^feedDecimals) / (2 * 10^feedDecimals)`. Meant for a positive answer.
 */
export function toPriceMicro(answer: bigint, feedDecimals: number): bigint {
  const scale = 10n ** BigInt(feedDecimals);
  return (answer * 1_000_000n * 2n + scale) / (2n * scale);
}

/** Whole Unix seconds of a date, rounded down. */
export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Returns the reason a feed read is invalid, or null when it is usable.
 * The rules of docs/CONTRACTS.md sections 5 and 15: the read failed or reverted, the feed's own
 * decimals differ from the universe entry, the answer is zero or negative, the price is below one
 * cent or does not fit a safe integer, `updatedAt` is zero, or `updatedAt` is more than five
 * minutes ahead.
 */
export function feedProblem(read: FeedRead, feedDecimals: number, nowSeconds: number): FeedProblem | null {
  if (read.round === null || read.decimals === null) return 'read_failed';
  if (read.decimals !== feedDecimals) return 'decimals_mismatch';
  const { answer, updatedAt } = read.round;
  if (answer <= 0n) return 'answer_not_positive';
  const priceMicro = toPriceMicro(answer, feedDecimals);
  if (priceMicro < BigInt(MIN_PRICE_MICRO)) return 'price_below_minimum';
  if (priceMicro > BigInt(Number.MAX_SAFE_INTEGER)) return 'price_not_safe';
  if (updatedAt <= 0n) return 'updated_at_zero';
  if (updatedAt > BigInt(nowSeconds + FUTURE_TOLERANCE_SECONDS)) return 'updated_at_in_future';
  return null;
}

/**
 * A feed is stale if the snapshot time minus `updatedAt` is more than `staleAfterSeconds`.
 * A threshold that is not a number makes every feed stale, so a bad setting fails closed.
 */
export function isStale(updatedAtSeconds: number, nowSeconds: number, staleAfterSeconds: number): boolean {
  return !(nowSeconds - updatedAtSeconds <= staleAfterSeconds);
}

/** One universe entry after the rules: its kind, its price point, and the problem if its answer is invalid. */
export interface JudgedFeed {
  /** Only a Stock Token feed opens or closes the market (docs/CONTRACTS.md section 21). */
  kind: AssetKind;
  point: PricePoint;
  problem: FeedProblem | null;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * Applies validity and staleness to one read. Never throws. `staleAfterSeconds` is the threshold of
 * the entry's kind: the caller passes the crypto threshold for a crypto entry. A Stock Token is also
 * halted while its oracle is paused or the pause flag could not be read; a crypto entry has no pause
 * flag, so `oraclePaused` is ignored for it.
 */
export function judgeFeed(
  token: UniverseToken,
  read: FeedRead,
  nowSeconds: number,
  staleAfterSeconds: number,
): JudgedFeed {
  const problem = feedProblem(read, token.feedDecimals, nowSeconds);
  const round = read.round;

  if (problem !== null || round === null) {
    // An invalid answer is still reported, as far as it can be shown, so the reason is visible.
    let priceMicro = 0;
    let updatedAt = EPOCH;
    let ageSeconds = Math.max(0, nowSeconds);
    if (round !== null) {
      // A crypto answer that is invalid in any way is reported unread, price zero, so the scheduler
      // values the symbol at its last trusted price (docs/CONTRACTS.md section 21, rule 3). An invalid
      // Stock Token answer closes the market, so its price is shown only to make the reason visible.
      if (isStockToken(token) && round.answer > 0n && read.decimals === token.feedDecimals) {
        const price = toPriceMicro(round.answer, token.feedDecimals);
        if (price <= BigInt(Number.MAX_SAFE_INTEGER)) priceMicro = Number(price);
      }
      if (round.updatedAt > 0n && round.updatedAt <= BigInt(nowSeconds + FUTURE_TOLERANCE_SECONDS)) {
        updatedAt = new Date(Number(round.updatedAt) * 1000).toISOString();
        ageSeconds = Math.max(0, nowSeconds - Number(round.updatedAt));
      }
    }
    return {
      kind: token.kind,
      point: { symbol: token.symbol, priceMicro, updatedAt, ageSeconds, fresh: false },
      problem: problem ?? 'read_failed',
    };
  }

  const updatedAtSeconds = Number(round.updatedAt);
  // Halted: the feed is stale by age, or, for a Stock Token, its issuer has paused it or the pause
  // flag could not be read.
  const paused = isStockToken(token) && read.oraclePaused !== false;
  const fresh = !paused && !isStale(updatedAtSeconds, nowSeconds, staleAfterSeconds);
  return {
    kind: token.kind,
    point: {
      symbol: token.symbol,
      priceMicro: Number(toPriceMicro(round.answer, token.feedDecimals)),
      updatedAt: new Date(updatedAtSeconds * 1000).toISOString(),
      ageSeconds: Math.max(0, nowSeconds - updatedAtSeconds),
      fresh,
    },
    problem: null,
  };
}

/**
 * True when no Stock Token feed has published within `quietAfterSeconds`: the underlying market is
 * shut, or every feed is down. Crypto feeds publish around the clock and are not counted
 * (docs/CONTRACTS.md section 21). A universe without a Stock Token is quiet, and so is a threshold
 * that is not a number, so a bad setting fails closed.
 */
export function marketIsQuiet(feeds: readonly JudgedFeed[], quietAfterSeconds: number): boolean {
  const stocks = feeds.filter((feed) => feed.kind === 'stock');
  if (stocks.length === 0) return true;
  const newestAge = Math.min(...stocks.map((feed) => feed.point.ageSeconds));
  return !(newestAge <= quietAfterSeconds);
}

/**
 * The open rule of docs/CONTRACTS.md section 15. With an RPC endpoint that answered for the
 * present, the market is open if and only if no feed answer is invalid, at most MAX_HALTED_FEEDS
 * symbols are halted, and some feed of the universe has published within `quietAfterSeconds`.
 *
 * Which reason wins, in the order the contract gives: `rpc_unavailable` is decided before this
 * function is reached, by `createMarket`. Here `feed_invalid` comes first, and a feed read that
 * failed or reverted is an invalid answer. `feeds_stale` is last and covers both ways of being
 * stale: too many halted symbols, and a quiet market. This package never answers
 * `held_for_review`; the scheduler gives that reason, and only to a snapshot returned open.
 *
 * Only Stock Token feeds count (docs/CONTRACTS.md section 21): a crypto feed that is invalid, unread
 * or stale is not fresh, so its own symbol is halted, and nothing else follows from it.
 */
export function decideOpen(
  feeds: readonly JudgedFeed[],
  quietAfterSeconds: number,
): { open: boolean; closedReason: MarketClosedReason | null } {
  const stocks = feeds.filter((feed) => feed.kind === 'stock');
  if (stocks.some((feed) => feed.problem !== null)) return { open: false, closedReason: 'feed_invalid' };
  const halted = stocks.filter((feed) => !feed.point.fresh).length;
  if (halted > MAX_HALTED_FEEDS || marketIsQuiet(stocks, quietAfterSeconds)) {
    return { open: false, closedReason: 'feeds_stale' };
  }
  return { open: true, closedReason: null };
}

/** True when the node's latest block is recent enough to speak for the present. */
export function nodeIsCurrent(blockTimestampSeconds: bigint | null, nowSeconds: number): boolean {
  if (blockTimestampSeconds === null) return false;
  const lag = BigInt(nowSeconds) - blockTimestampSeconds;
  return lag <= BigInt(NODE_LAG_TOLERANCE_SECONDS) && lag >= -BigInt(FUTURE_TOLERANCE_SECONDS);
}

/**
 * How many seconds the node's latest block is behind the snapshot time; negative when it is ahead.
 * Clamped to the safe integer range, so a nonsense timestamp still gives a number for the log.
 */
export function nodeLagSeconds(blockTimestampSeconds: bigint, nowSeconds: number): number {
  const lag = BigInt(nowSeconds) - blockTimestampSeconds;
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (lag > limit) return Number.MAX_SAFE_INTEGER;
  if (lag < -limit) return -Number.MAX_SAFE_INTEGER;
  return Number(lag);
}

/**
 * JSON-RPC codes that say the request itself is wrong, so the same request will fail again:
 * invalid request, method not found, invalid params, and a revert (3).
 */
const PERMANENT_RPC_CODES: ReadonlySet<number> = new Set([-32600, -32601, -32602, 3]);

/**
 * True when one more try of the same endpoint, after a short pause, may succeed (docs/DECISIONS.md
 * D-098). A timeout, a failed connection, a rate limit (HTTP 429 or 408, or a JSON-RPC error other
 * than one that says the request is wrong) and a server error (HTTP 5xx) may pass. A refusal (other
 * HTTP 4xx), an answer that could not be read, and a node that is behind are not retried: the
 * same answer would come back, and a lagging node does not catch up in a second.
 */
export function isTransient(failure: Pick<MarketEndpointFailure, 'kind' | 'code'>): boolean {
  switch (failure.kind) {
    case 'timeout':
    case 'network':
      return true;
    case 'http':
      return failure.code === 429 || failure.code === 408 || (failure.code !== undefined && failure.code >= 500);
    case 'rpc_error':
      return failure.code === undefined || !PERMANENT_RPC_CODES.has(failure.code);
    default:
      return false;
  }
}

export interface SnapshotInput {
  now: Date;
  universe: readonly UniverseToken[];
  /** The block the reads were made at. */
  blockNumber: bigint;
  /** One read per universe token, in universe order. */
  reads: readonly FeedRead[];
  /** `MarketConfig.staleAfterSeconds`: a Stock Token feed older than this halts its symbol. */
  staleAfterSeconds: number;
  /** `MarketConfig.cryptoStaleAfterSeconds`: a crypto feed older than this halts its symbol. */
  cryptoStaleAfterSeconds: number;
  /** `MarketConfig.quietAfterSeconds`: the market is closed when no Stock Token feed has published for this long. */
  quietAfterSeconds: number;
}

const FAILED_READ: FeedRead = { round: null, decimals: null, oraclePaused: null };

/** Builds the snapshot of an RPC that answered. Never throws for a valid `now`. */
export function buildSnapshot(input: SnapshotInput): MarketSnapshot {
  const nowSeconds = unixSeconds(input.now);
  const feeds = input.universe.map((token, index) =>
    judgeFeed(
      token,
      input.reads[index] ?? FAILED_READ,
      nowSeconds,
      isStockToken(token) ? input.staleAfterSeconds : input.cryptoStaleAfterSeconds,
    ),
  );
  const { open, closedReason } = decideOpen(feeds, input.quietAfterSeconds);
  const blockNumber =
    input.blockNumber >= 0n && input.blockNumber <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(input.blockNumber) : 0;
  return {
    takenAt: input.now.toISOString(),
    chainId: CHAIN_ID,
    blockNumber,
    open,
    closedReason,
    prices: feeds.map((feed) => feed.point),
  };
}

/** The snapshot of a market that could not be read: closed, block zero, no prices. */
export function closedSnapshot(now: Date, closedReason: MarketClosedReason): MarketSnapshot {
  return { takenAt: now.toISOString(), chainId: CHAIN_ID, blockNumber: 0, open: false, closedReason, prices: [] };
}

function samePoint(p: PricePoint, q: PricePoint): boolean {
  return (
    p.priceMicro === q.priceMicro && p.updatedAt === q.updatedAt && p.ageSeconds === q.ageSeconds && p.fresh === q.fresh
  );
}

/**
 * The snapshot to accept from two snapshots of the same moment, read from two endpoints, or null
 * when they disagree (docs/CONTRACTS.md sections 20 and 21). Used to accept a snapshot that a
 * third-party fallback endpoint served only when a second independent endpoint says the same: a
 * disagreement closes the market with `rpc_unavailable`, whichever of the two lies.
 *
 * The open state and reason, the chain, the time, the symbols in order, and every point of a symbol
 * outside `cryptoSymbols` (the Stock Tokens) must match exactly: price, update time, age and
 * freshness. The block numbers may differ. A crypto feed never opens or closes the market (section
 * 21, rule 2), so a crypto point on which the two differ does not refuse the snapshot: it is
 * returned unread, price zero and not fresh, and the scheduler values it at its last trusted price.
 * The returned snapshot is `a`, with only those points changed.
 */
export function agreedSnapshot(
  a: MarketSnapshot,
  b: MarketSnapshot,
  cryptoSymbols: ReadonlySet<string>,
): MarketSnapshot | null {
  if (a.takenAt !== b.takenAt || a.chainId !== b.chainId) return null;
  if (a.open !== b.open || a.closedReason !== b.closedReason) return null;
  if (a.prices.length !== b.prices.length) return null;
  const prices: PricePoint[] = [];
  for (const [i, p] of a.prices.entries()) {
    const q = b.prices[i];
    if (q === undefined || p.symbol !== q.symbol) return null;
    if (samePoint(p, q)) prices.push(p);
    else if (cryptoSymbols.has(p.symbol)) prices.push({ ...p, priceMicro: 0, fresh: false });
    else return null;
  }
  return { ...a, prices };
}

/** True when two snapshots agree on every point, crypto included (`agreedSnapshot` with no crypto symbols). */
export function snapshotsAgree(a: MarketSnapshot, b: MarketSnapshot): boolean {
  return agreedSnapshot(a, b, new Set()) !== null;
}
