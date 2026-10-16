import { ARBITRUM_CHAIN_ID, CHAIN_ID } from './constants.ts';
import type { TokenSymbol } from './primitives.ts';
import { addressSchema, amountSchema, isoTimeSchema, signedAmountSchema, symbolSchema } from './primitives.ts';
import { z } from './zod.ts';

/** What a symbol of the universe is. Section 21: Stock Tokens, and crypto assets from ETH and BTC on. */
export const assetKindSchema = z.enum(['stock', 'crypto']);
export type AssetKind = z.infer<typeof assetKindSchema>;

/**
 * A chain a price feed is read on (section 23): Robinhood Chain (CHAIN_ID) for every Stock Token, ETH
 * and BTC; Arbitrum One (ARBITRUM_CHAIN_ID) for SOL, BNB and HYPE.
 */
export const feedChainIdSchema = z.union([z.literal(CHAIN_ID), z.literal(ARBITRUM_CHAIN_ID)]);
export type FeedChainId = z.infer<typeof feedChainIdSchema>;

const universeEntryFields = {
  symbol: symbolSchema,
  name: z.string().min(1),
  /** The Standard Proxy of the symbol's Chainlink feed on its feed chain (`feedChainOf`). */
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
  /**
   * The chain its feed is read on (section 23). `sourceUrl` is Chainlink's feed page for that chain's
   * network (`?network=robinhood` or `?network=arbitrum`).
   */
  chainId: feedChainIdSchema,
});
export type CryptoAsset = z.infer<typeof cryptoAssetSchema>;

/** One symbol of the universe: a Stock Token or a crypto asset. */
export const universeTokenSchema = z.discriminatedUnion('kind', [stockTokenSchema, cryptoAssetSchema]);
export type UniverseToken = z.infer<typeof universeTokenSchema>;

/** Narrows a universe entry to a Stock Token. */
export function isStockToken(entry: UniverseToken): entry is StockToken {
  return entry.kind === 'stock';
}

/** The chain an entry's feed is read on: Robinhood Chain for every Stock Token, the entry's own for a crypto asset. */
export function feedChainOf(entry: UniverseToken): FeedChainId {
  return entry.kind === 'stock' ? CHAIN_ID : entry.chainId;
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
 * Why the points of a second feed chain were not read for a tick (section 23). Each one makes only that
 * chain's points unread (`priceMicro` 0, `fresh` false, then the last trusted price, section 21 rules 3
 * and 9); none closes the market.
 * - `rpc_unavailable`: the official endpoint gave nothing for the present, and neither did the pair.
 * - `unconfirmed`: the official endpoint gave nothing, and only one endpoint of the pair answered.
 * - `disagreed`: both endpoints of the pair answered at the pinned block, with different answers.
 * - `sequencer_down`: the sequencer uptime feed answered other than 0.
 * - `sequencer_grace`: the sequencer is up, for ARBITRUM_SEQUENCER_GRACE_SECONDS or less.
 * - `sequencer_unknown`: the uptime feed was not read, or its `startedAt` is 0 (not initialised) or
 *   in the future.
 */
export const otherChainProblemSchema = z.enum([
  'rpc_unavailable',
  'unconfirmed',
  'disagreed',
  'sequencer_down',
  'sequencer_grace',
  'sequencer_unknown',
]);
export type OtherChainProblem = z.infer<typeof otherChainProblemSchema>;

/** Where the points of a second feed chain came from, in one snapshot (section 23). */
export const otherChainReadSchema = z.strictObject({
  chainId: feedChainIdSchema,
  /**
   * The L2 block every point of this chain was read at: on Arbitrum, `ArbSys.arbBlockNumber()`, never
   * Multicall3's `block.number`, which there is the Ethereum block. 0 when nothing was read.
   */
  blockNumber: amountSchema,
  /**
   * The endpoint whose read was used, by position: 0 the official endpoint, 1 and 2 the confirming
   * pair, in the order of `MarketConfig.arbitrum`. Never a URL. Null when nothing was read.
   */
  endpoint: z.number().int().min(0).max(2).nullable(),
  /** The endpoint of the pair that agreed, by position; null when the official endpoint was used alone or nothing agreed. */
  confirmedBy: z.number().int().min(0).max(2).nullable(),
  /** Null when this chain's points were read and trusted. */
  problem: otherChainProblemSchema.nullable(),
});
export type OtherChainRead = z.infer<typeof otherChainReadSchema>;

/**
 * The state of the paper market at one moment. Every agent in a tick decides
 * from, and fills at, the same snapshot.
 */
export const marketSnapshotSchema = z.strictObject({
  takenAt: isoTimeSchema,
  /** Robinhood Chain, CHAIN_ID: the chain that opens and closes the market. */
  chainId: z.number().int(),
  /** The Robinhood Chain block the prices were read at. Zero when the RPC was unavailable. */
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
  /**
   * One entry per second feed chain the universe reads (today Arbitrum One), in any snapshot that has
   * prices. Absent in every tick stored before section 23, and in a closed snapshot with no prices.
   */
  otherChains: z.array(otherChainReadSchema).max(4).optional(),
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

/**
 * How the market reads Arbitrum One (section 23). No key: public endpoints only (D-127). Positions in
 * `MarketEndpointFailure.endpoint` and `OtherChainRead` count `officialRpcUrl` as 0 and the pair as 1
 * and 2.
 */
export interface ArbitrumReadConfig {
  /** ARBITRUM_OFFICIAL_RPC_URL: a read from it is taken alone. */
  officialRpcUrl: string;
  /**
   * ARBITRUM_CONFIRMING_RPC_URLS: read only when the official endpoint gave nothing. The first read is
   * taken only when the second, pinned to the first's L2 block, gives the same answer.
   */
  confirmingRpcUrls: readonly [string, string];
  /** ARBITRUM_SEQUENCER_GRACE_SECONDS. */
  sequencerGraceSeconds: number;
}

/** What `createMarket` in `packages/market` takes. */
export interface MarketConfig {
  /**
   * Robinhood Chain endpoints in the order to try them: the keyed endpoint first, the public ones as
   * fallback (section 20). They read every Stock Token, ETH and BTC.
   */
  rpcUrls: readonly string[];
  /** Arbitrum One, for SOL, BNB and HYPE (section 23). */
  arbitrum: ArbitrumReadConfig;
  /** A Stock Token feed whose last update is older than this is stale: FEED_STALE_AFTER_SECONDS. */
  staleAfterSeconds: number;
  /**
   * The staleness of each crypto feed, by symbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL. A crypto
   * symbol without a usable value here is halted (fail closed).
   */
  cryptoStaleAfterSecondsBySymbol: Readonly<Record<TokenSymbol, number>>;
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
  /**
   * The chain of the endpoint (section 23). Absent means Robinhood Chain, where `endpoint` counts in
   * `rpcUrls`; for ARBITRUM_CHAIN_ID it counts as `ArbitrumReadConfig` says.
   */
  chainId?: FeedChainId;
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
/**
 * Section 23: what the Arbitrum sequencer uptime feed says about trusting that chain's prices at
 * `nowSeconds`. Pure, so `qa` tests it without a network. Null `read` (not read): `sequencer_unknown`.
 * `answer` other than 0: `sequencer_down`. `startedAt` 0 or after `nowSeconds`: `sequencer_unknown`.
 * `nowSeconds - startedAt <= graceSeconds`: `sequencer_grace`. Otherwise null: trusted.
 */
export type JudgeSequencer = (
  read: { answer: bigint; startedAt: bigint } | null,
  nowSeconds: number,
  graceSeconds: number,
) => Extract<OtherChainProblem, 'sequencer_down' | 'sequencer_grace' | 'sequencer_unknown'> | null;
