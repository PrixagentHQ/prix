import type { CreateMarket, MarketConfig, MarketEndpointFailure, MarketPort, MarketSnapshot } from '@prix/contracts';
import { endpointHost, isThirdPartyEndpoint, type ReadOutcome, RPC_TIMEOUT_MS, readSnapshot } from './chain.ts';
import {
  agreedSnapshot,
  buildSnapshot,
  closedSnapshot,
  isTransient,
  nodeIsCurrent,
  nodeLagSeconds,
  unixSeconds,
} from './rules.ts';
import { UNIVERSE } from './universe.ts';

/** The universe's crypto symbols: a difference on one of them between two endpoints only unreads it. */
const CRYPTO_SYMBOLS: ReadonlySet<string> = new Set(
  UNIVERSE.filter((token) => token.kind === 'crypto').map((token) => token.symbol),
);

/**
 * The pause before the one retry of an endpoint that failed in a way that may pass (`isTransient`).
 * Short enough that a scheduler step, which runs every minute, still ends long before the next:
 * the worst case of two endpoints, each tried twice at `RPC_TIMEOUT_MS`, is under 35 seconds. With a
 * keyed endpoint and the three public ones (`PUBLIC_RPC_URLS`) it is under 70 seconds, and only when
 * every endpoint hangs to its limit; a refusal or a closed connection answers at once.
 */
export const RETRY_PAUSE_MS = 750;

/**
 * One line of the Worker log about the endpoint behind a snapshot (docs/CONTRACTS.md section 20).
 * Endpoints are named by their position in `rpcUrls`, never by URL, which may carry a key.
 * - `market_endpoint_used`: the endpoint whose snapshot was returned, and the endpoint that agreed
 *   with it when it was a third party (null for the keyed or the official endpoint, accepted alone).
 * - `market_endpoint_rejected`: a third party's snapshot that was not accepted, because the second
 *   endpoint disagreed, or because no second independent endpoint answered. The market is then
 *   closed with `rpc_unavailable`.
 */
export type MarketLogLine =
  | { event: 'market_endpoint_used'; endpoint: number; confirmedBy: number | null }
  | {
      event: 'market_endpoint_rejected';
      endpoint: number;
      confirmedBy: number | null;
      reason: 'disagreed' | 'unconfirmed';
    };

/** What a test may replace. The product passes nothing and gets the real pause, time limit and log. */
export interface MarketTiming {
  pause?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  log?: (line: MarketLogLine) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The product's log: one JSON line; a rejection as a warning. */
function writeLog(line: MarketLogLine): void {
  if (line.event === 'market_endpoint_rejected') console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

/**
 * Hands one failure to the hook. Whatever the hook does, throwing or returning a promise that
 * rejects, changes nothing here.
 */
function report(config: MarketConfig, failure: MarketEndpointFailure): void {
  const hook = config.onEndpointFailure;
  if (hook === undefined) return;
  try {
    const returned: unknown = hook.call(config, failure);
    if (returned instanceof Promise) returned.catch(() => undefined);
  } catch {
    // The contract says the hook must not throw. If it does, the snapshot is still the snapshot.
  }
}

/**
 * Reads the market from the chain. docs/CONTRACTS.md section 5 specifies it, with the market
 * rules of section 15 and `MarketConfig.onEndpointFailure`.
 *
 * `takeSnapshot` never throws. It tries each endpoint in order with one batched read each, and
 * takes the first that answers for the present. A failure that may pass (a timeout, a lost
 * connection, a rate limit, a server error) is tried once more on the same endpoint after
 * `RETRY_PAUSE_MS`; a refusal, an unreadable answer and a node that is behind are not. Every
 * endpoint that gives no snapshot is reported once to `onEndpointFailure`, by its position, with
 * the failure that ended it. If none answers, the market is closed with `rpc_unavailable`, the
 * reason that wins over every other. A snapshot is not cached here: the scheduler takes one per
 * tick and stores it.
 *
 * A snapshot from the keyed endpoint or the official one is taken alone. One from a third-party
 * fallback (`isThirdPartyEndpoint`) is taken only when the next endpoint on another host that
 * answers for the present agrees on every Stock Token feed and on the open state (`agreedSnapshot`;
 * a crypto feed on which the two differ is returned unread, never closing the market); if it disagrees, or none
 * answers, the market is closed with `rpc_unavailable` (docs/CONTRACTS.md section 20). Every
 * returned snapshot from an endpoint is logged as `market_endpoint_used`, and every refused third
 * party as `market_endpoint_rejected`, by position only (`MarketLogLine`).
 *
 * Every threshold comes from `config`: `staleAfterSeconds` halts a Stock Token, `cryptoStaleAfterSeconds`
 * halts a crypto asset, and `quietAfterSeconds` closes the market. This package holds no value for any
 * of them. A threshold that is missing or not a number fails closed: for a crypto asset, that halts
 * the symbol and leaves the market as the Stock Tokens say (docs/CONTRACTS.md section 21).
 */
export function createMarketWith(config: MarketConfig, timing: MarketTiming = {}): MarketPort {
  const pause = timing.pause ?? sleep;
  const timeoutMs = timing.timeoutMs ?? RPC_TIMEOUT_MS;
  const sink = timing.log ?? writeLog;

  /** A log line is never worth a failed snapshot. */
  function log(line: MarketLogLine): void {
    try {
      sink(line);
    } catch {
      // ignored
    }
  }

  /** `tryEndpoint`, with anything it throws turned into a failure of that endpoint. */
  async function attempt(
    rpcUrl: string,
    endpoint: number,
    now: Date,
  ): Promise<{ snapshot: MarketSnapshot } | { failure: MarketEndpointFailure }> {
    try {
      return await tryEndpoint(rpcUrl, endpoint, now);
    } catch {
      // Nothing in tryEndpoint should throw. If something does, this endpoint gave no snapshot.
      return { failure: { endpoint, kind: 'network' } };
    }
  }

  /** One endpoint, with its one retry. Returns the snapshot, or the failure that ended the endpoint. */
  async function tryEndpoint(
    rpcUrl: string,
    endpoint: number,
    now: Date,
  ): Promise<{ snapshot: MarketSnapshot } | { failure: MarketEndpointFailure }> {
    const nowSeconds = unixSeconds(now);
    let outcome: ReadOutcome = await readSnapshot(rpcUrl, UNIVERSE, config.fetch, timeoutMs);
    if (!outcome.ok && isTransient(outcome.failure)) {
      await pause(RETRY_PAUSE_MS);
      outcome = await readSnapshot(rpcUrl, UNIVERSE, config.fetch, timeoutMs);
    }
    if (!outcome.ok) return { failure: { endpoint, ...outcome.failure } };
    const { blockNumber, blockTimestamp, reads } = outcome.reads;
    // A node that is behind, or a halted sequencer, has not answered for the present.
    if (!nodeIsCurrent(blockTimestamp, nowSeconds)) {
      return { failure: { endpoint, kind: 'behind', lagSeconds: nodeLagSeconds(blockTimestamp, nowSeconds) } };
    }
    return {
      snapshot: buildSnapshot({
        now,
        universe: UNIVERSE,
        blockNumber,
        reads,
        staleAfterSeconds: config.staleAfterSeconds,
        cryptoStaleAfterSeconds: config.cryptoStaleAfterSeconds,
        quietAfterSeconds: config.quietAfterSeconds,
      }),
    };
  }

  return {
    async takeSnapshot(now: Date): Promise<MarketSnapshot> {
      // An unusable `now` cannot date a snapshot. Report closed at the current time and read nothing.
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        return closedSnapshot(new Date(), 'rpc_unavailable');
      }
      const urls = config.rpcUrls;
      for (let endpoint = 0; endpoint < urls.length; endpoint++) {
        const rpcUrl = urls[endpoint] as string;
        const result = await attempt(rpcUrl, endpoint, now);
        if ('failure' in result) {
          report(config, result.failure);
          continue;
        }
        // The keyed endpoint and the official one are accepted alone.
        if (!isThirdPartyEndpoint(rpcUrl)) {
          log({ event: 'market_endpoint_used', endpoint, confirmedBy: null });
          return result.snapshot;
        }
        // A third party's snapshot needs a second, independent endpoint to say the same in this
        // step: the next endpoint on another host that answers for the present. Endpoints are still
        // tried in order, each once with its one retry, and none twice in a step.
        const host = endpointHost(rpcUrl);
        for (let second = endpoint + 1; second < urls.length; second++) {
          const secondUrl = urls[second] as string;
          const secondHost = endpointHost(secondUrl);
          if (host === null || secondHost === null || secondHost === host) continue;
          const check = await attempt(secondUrl, second, now);
          if ('failure' in check) {
            report(config, check.failure);
            continue;
          }
          // A crypto point on which the two differ is returned unread; it never closes the market.
          const agreed = agreedSnapshot(result.snapshot, check.snapshot, CRYPTO_SYMBOLS);
          if (agreed !== null) {
            log({ event: 'market_endpoint_used', endpoint, confirmedBy: second });
            return agreed;
          }
          // One of the two lies or is broken, and nothing here can tell which: fail closed.
          log({ event: 'market_endpoint_rejected', endpoint, confirmedBy: second, reason: 'disagreed' });
          return closedSnapshot(now, 'rpc_unavailable');
        }
        log({ event: 'market_endpoint_rejected', endpoint, confirmedBy: null, reason: 'unconfirmed' });
        return closedSnapshot(now, 'rpc_unavailable');
      }
      return closedSnapshot(now, 'rpc_unavailable');
    },
  };
}

/** The market of the product: `createMarketWith` with the real pause, time limit and log. */
export const createMarket: CreateMarket = (config) => createMarketWith(config);
