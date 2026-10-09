import { z } from 'zod';
import type { TokenSymbol } from './primitives.ts';
import { addressSchema, amountSchema, isoTimeSchema, signedAmountSchema, symbolSchema } from './primitives.ts';

/** What a symbol of the universe is. Section 21: Stock Tokens, and crypto assets from ETH and BTC on. */
export const assetKindSchema = z.enum(['stock', 'crypto']);
export type AssetKind = z.infer<typeof assetKindSchema>;

const universeEntryFields = {
  symbol: symbolSchema,
  name: z.string().min(1),
  /** The Standard Proxy of the symbol's Chainlink feed on Robinhood Chain. */
  feedAddress: addressSchema,
  feedDecimals: z.number().int().min(0).max(36),
  /** Where the addresses were read. */
  sourceUrl: z.url(),
  /** The UTC day the addresses were read. */
  readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

/** One Stock Token of the universe, with the source of every address. */
export const stockTokenSchema = z.strictObject({
  kind: z.literal('stock'),
  ...universeEntryFields,
  /** The Stock Token itself; its `oraclePaused()` halts the symbol during a corporate action. */
  tokenAddress: addressSchema,
  tokenDecimals: z.number().int().min(0).max(36),
});
export type StockToken = z.infer<typeof stockTokenSchema>;

/**
 * One crypto asset of the universe (section 21). Only its feed is read: there is no Stock Token, so no
 * `oraclePaused()`, and it is never an on-chain record's token (listings, wallets and chain records stay
 * Stock Tokens only).
 */
export const cryptoAssetSchema = z.strictObject({
  kind: z.literal('crypto'),
  ...universeEntryFields,
});
export type CryptoAsset = z.infer<typeof cryptoAssetSchema>;

/** One symbol of the universe: a Stock Token or a crypto asset. */
export const universeTokenSchema = z.discriminatedUnion('kind', [stockTokenSchema, cryptoAssetSchema]);
export type UniverseToken = z.infer<typeof universeTokenSchema>;

/** Narrows a universe entry to a Stock Token. */
export function isStockToken(entry: UniverseToken): entry is StockToken {
  return entry.kind === 'stock';
}

/** The reference price of one symbol at one moment. */
export const pricePointSchema = z.strictObject({
  symbol: symbolSchema,
  /** Chainlink reference price in micro-USD per share, rounded half up from the feed's own decimals. */
  priceMicro: amountSchema,
  /** When the feed last updated, as the feed reports it. */
  updatedAt: isoTimeSchema,
  /** Seconds between `updatedAt` and the snapshot. */
  ageSeconds: amountSchema,
  /** False when the feed is stale. A stale symbol is halted: valued at this price, not traded. */
  fresh: z.boolean(),
});
export type PricePoint = z.infer<typeof pricePointSchema>;

/** `held_for_review`: more symbols are on hold than the market can run without. */
export const marketClosedReasonSchema = z.enum(['feeds_stale', 'rpc_unavailable', 'feed_invalid', 'held_for_review']);
export type MarketClosedReason = z.infer<typeof marketClosedReasonSchema>;

/**
 * The state of the paper market at one moment. Every agent in a tick decides
 * from, and fills at, the same snapshot.
 */
export const marketSnapshotSchema = z.strictObject({
  takenAt: isoTimeSchema,
  chainId: z.number().int(),
  /** The block the prices were read at. Zero when the RPC was unavailable. */
  blockNumber: amountSchema,
  /**
   * True while an RPC endpoint answered for the present, every Stock Token feed answer is valid, at
   * most MAX_HALTED_FEEDS Stock Token symbols are halted, and some Stock Token feed has published
   * within `quietAfterSeconds`. Crypto feeds never decide it (section 21): a bad crypto feed halts its
   * own symbol.
   */
  open: z.boolean(),
  closedReason: marketClosedReasonSchema.nullable(),
  /** One entry per universe token, in universe order. Empty when the RPC was unavailable. */
  prices: z.array(pricePointSchema),
});
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

/** Recent returns of one symbol, from stored tick prices. Null where the league has no history yet. */
export const recentReturnsSchema = z.strictObject({
  symbol: symbolSchema,
  day1Bps: signedAmountSchema.nullable(),
  day5Bps: signedAmountSchema.nullable(),
  day20Bps: signedAmountSchema.nullable(),
});
export type RecentReturns = z.infer<typeof recentReturnsSchema>;

/** The closing prices of one earlier trading day, used to compute recent returns. */
export interface DailyPrices {
  day: string;
  prices: Record<TokenSymbol, number>;
}

/** How the rest of the system reads the market. `packages/market` implements it. */
export interface MarketPort {
  /** Never throws. An RPC failure returns a closed snapshot with `closedReason: 'rpc_unavailable'`. */
  takeSnapshot(now: Date): Promise<MarketSnapshot>;
}

/** What the site shows about the market. Stored as a single row and refreshed by the scheduler. */
export const marketStatusSchema = z.strictObject({
  open: z.boolean(),
  closedReason: marketClosedReasonSchema.nullable(),
  /** When the market was last checked. */
  checkedAt: isoTimeSchema,
  /** The most recent tick, if the league has had one. */
  lastTickId: z.string().nullable(),
  /** Symbols halted at the last check. */
  halted: z.array(symbolSchema),
});
export type MarketStatus = z.infer<typeof marketStatusSchema>;

/** What `createMarket` in `packages/market` takes. */
export interface MarketConfig {
  /** RPC endpoints in the order to try them: the keyed endpoint first, the public one as fallback. */
  rpcUrls: readonly string[];
  /** A Stock Token feed whose last update is older than this is stale: FEED_STALE_AFTER_SECONDS. */
  staleAfterSeconds: number;
  /** A crypto feed whose last update is older than this is stale: CRYPTO_FEED_STALE_AFTER_SECONDS. */
  cryptoStaleAfterSeconds: number;
  /** The market is closed when no Stock Token feed has published for this long: MARKET_QUIET_AFTER_SECONDS. */
  quietAfterSeconds: number;
  /** For tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Called once for every endpoint that did not answer for the present, so that a closed market
   * says why in the Worker's log. `endpoint` is the position in `rpcUrls`, never the URL, which may
   * carry a key. Must not throw; `takeSnapshot` ignores anything it throws.
   */
  onEndpointFailure?(failure: MarketEndpointFailure): void;
}

/** Why one endpoint did not give a snapshot. */
export interface MarketEndpointFailure {
  endpoint: number;
  /**
   * `http`: an HTTP status other than 200. `rpc_error`: a JSON-RPC error in the answer.
   * `timeout`: no answer in time. `network`: the request failed before an answer.
   * `malformed`: an answer that could not be read. `behind`: the node's newest block is too old
   * or too far in the future (`lagSeconds` says by how much).
   */
  kind: 'http' | 'rpc_error' | 'timeout' | 'network' | 'malformed' | 'behind';
  /** The HTTP status for `http`, the JSON-RPC error code for `rpc_error`. */
  code?: number;
  lagSeconds?: number;
}

// --- what packages/market exports, besides UNIVERSE -----------------------------------------------

export type CreateMarket = (config: MarketConfig) => MarketPort;
/** Returns one entry per symbol of `prices`, in the same order as the universe. */
export type ComputeRecentReturns = (
  prices: Readonly<Record<TokenSymbol, number>>,
  history: readonly DailyPrices[],
) => RecentReturns[];
/** The prices of a snapshot by symbol, halted symbols included. */
export type ToPriceMap = (snapshot: MarketSnapshot) => Record<TokenSymbol, number>;
/** The symbols of a snapshot whose `fresh` is false. */
export type HaltedSymbols = (snapshot: MarketSnapshot) => TokenSymbol[];
