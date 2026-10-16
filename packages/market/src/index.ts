/**
 * The product's view of the chain. docs/CONTRACTS.md sections 5 and 13 fix the five functions and
 * `UNIVERSE`; section 15 adds that the public RPC endpoint comes from here. `FEED_SOURCE_URL` is
 * where every feed address of the universe was read, for the pages that cite it.
 *
 * The pure logic is importable for tests without a network: the decision rules as
 * `@prix/market/rules`, and the format of the one batched read as `@prix/market/wire`.
 */
export { PUBLIC_RPC_URL, PUBLIC_RPC_URLS, rpcEndpoints } from './chain.ts';
export { createMarket } from './market.ts';
export { computeRecentReturns, haltedSymbols, toPriceMap } from './returns.ts';
export {
  ARBITRUM_FEED_SOURCE_URL,
  ARBITRUM_SEQUENCER_FEED,
  FEED_SOURCE_URL,
  UNIVERSE,
} from './universe.ts';
