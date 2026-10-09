import type { MarketConfig, MarketEndpointFailure } from '@prix/contracts';
import { CRYPTO_FEED_STALE_AFTER_SECONDS, FEED_STALE_AFTER_SECONDS, MARKET_QUIET_AFTER_SECONDS } from '@prix/contracts';
import { rpcEndpoints } from '@prix/market';

/**
 * The Worker's answer to `MarketConfig.onEndpointFailure` (docs/DECISIONS.md D-098): one
 * structured line per endpoint that did not answer for the present, so that a market reported
 * closed with `rpc_unavailable` can be explained from the log.
 *
 * The line is built from four named fields and nothing else. The URL of an endpoint can carry a
 * key, so nothing that the failure carries besides those four ever reaches the log: a value that
 * is not a plain number becomes null, and a kind that is not one of the contract's becomes
 * "unknown". The function never throws, as the contract asks of the callback.
 */

const KINDS: ReadonlySet<string> = new Set<MarketEndpointFailure['kind']>([
  'http',
  'rpc_error',
  'timeout',
  'network',
  'malformed',
  'behind',
]);

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function logMarketEndpointFailure(failure: MarketEndpointFailure): void {
  try {
    const kind: unknown = failure.kind;
    const line = {
      event: 'market_endpoint_failed',
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

/** What `createMarket` gets in the Worker: the endpoints in order, the contract's limits, and the log line above. */
export function createMarketConfig(rpcUrls: readonly string[]): MarketConfig {
  return {
    rpcUrls,
    staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
    // Section 21: a crypto feed has its own staleness and only ever halts its own symbol.
    cryptoStaleAfterSeconds: CRYPTO_FEED_STALE_AFTER_SECONDS,
    quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
    onEndpointFailure: logMarketEndpointFailure,
  };
}
