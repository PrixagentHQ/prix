import type { FeedChainId, MarketConfig, MarketEndpointFailure } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  ARBITRUM_CONFIRMING_RPC_URLS,
  ARBITRUM_OFFICIAL_RPC_URL,
  ARBITRUM_SEQUENCER_GRACE_SECONDS,
  CHAIN_ID,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  FEED_STALE_AFTER_SECONDS,
  MARKET_QUIET_AFTER_SECONDS,
} from '@prix/contracts';
import { rpcEndpoints } from '@prix/market';

/**
 * The Worker's answer to `MarketConfig.onEndpointFailure` (docs/DECISIONS.md D-098): one
 * structured line per endpoint that did not answer for the present, so that a market reported
 * closed with `rpc_unavailable` can be explained from the log.
 *
 * The line is built from five named fields and nothing else. The URL of an endpoint can carry a
 * key, so nothing that the failure carries besides those five ever reaches the log: a value that
 * is not a plain number becomes null, a kind that is not one of the contract's becomes "unknown",
 * and a chain that is not one of the contract's feed chains becomes null. `chainId` says which
 * list `endpoint` counts in (section 23): absent means Robinhood Chain (`rpcUrls`), and 42161
 * means Arbitrum One (0 the official endpoint, 1 and 2 the confirming pair). The line says the
 * chain as the failure does: a failure without a `chainId` writes none, as `market_endpoint_used`
 * and `market_endpoint_rejected` of packages/market do for Robinhood Chain. The function never
 * throws, as the contract asks of the callback.
 */

const KINDS: ReadonlySet<string> = new Set<MarketEndpointFailure['kind']>([
  'http',
  'rpc_error',
  'timeout',
  'network',
  'malformed',
  'behind',
]);

const FEED_CHAINS: ReadonlySet<unknown> = new Set<FeedChainId>([CHAIN_ID, ARBITRUM_CHAIN_ID]);

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Absent stays absent, which the contract reads as Robinhood Chain; anything that is not a feed chain is null. */
function feedChain(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' && FEED_CHAINS.has(value) ? value : null;
}

export function logMarketEndpointFailure(failure: MarketEndpointFailure): void {
  try {
    const kind: unknown = failure.kind;
    const line = {
      event: 'market_endpoint_failed',
      chainId: feedChain(failure.chainId),
      endpoint: finite(failure.endpoint),
      kind: typeof kind === 'string' && KINDS.has(kind) ? kind : 'unknown',
      code: finite(failure.code),
      lagSeconds: finite(failure.lagSeconds),
    };
    console.warn(JSON.stringify(line));
  } catch {
    // A log line is never worth a failed snapshot.
  }
}

/**
 * The endpoints of every chain read of the Worker, in order: `rpcEndpoints` of packages/market,
 * so a valid keyed `RPC_URL` first, then every public endpoint. A keyed value that is not an https
 * URL is left out and `onIgnored` is called once, with nothing: the value holds a key and is never
 * logged.
 */
export function workerRpcUrls(keyed: string | undefined, onIgnored: () => void): string[] {
  const urls = rpcEndpoints(keyed);
  const given = typeof keyed === 'string' ? keyed.trim() : '';
  if (given !== '' && urls[0] !== given) onIgnored();
  return urls;
}

/**
 * What `createMarket` gets in the Worker: the Robinhood endpoints in order, Arbitrum One's public
 * endpoints and sequencer grace from the contract (section 23; no key, no secret), the contract's
 * limits, and the log line above.
 */
export function createMarketConfig(rpcUrls: readonly string[]): MarketConfig {
  return {
    rpcUrls,
    arbitrum: {
      officialRpcUrl: ARBITRUM_OFFICIAL_RPC_URL,
      confirmingRpcUrls: ARBITRUM_CONFIRMING_RPC_URLS,
      sequencerGraceSeconds: ARBITRUM_SEQUENCER_GRACE_SECONDS,
    },
    staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
    // Sections 21 and 23: each crypto feed has its own staleness and only ever halts its own symbol.
    cryptoStaleAfterSecondsBySymbol: CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
    quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    onEndpointFailure: logMarketEndpointFailure,
  };
}
