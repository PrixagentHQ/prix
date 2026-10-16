import type { CreateMarket, MarketConfig, MarketEndpointFailure, MarketPort, MarketSnapshot } from '@prix/contracts';
import { ARBITRUM_CHAIN_ID } from '@prix/contracts';
import {
  type ArbitrumAnswer,
  createDecodedAnswers,
  type DecodedAnswers,
  endpointHost,
  isThirdPartyEndpoint,
  type ReadOutcome,
  RPC_TIMEOUT_MS,
  readArbitrum,
  readSnapshot,
} from './chain.ts';
import {
  agreedSnapshot,
  arbitrumAnswersAgree,
  buildSnapshot,
  closedSnapshot,
  isTransient,
  nodeIsCurrent,
  nodeLagSeconds,
  type OtherChainSource,
  unixSeconds,
  withOtherChain,
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
 * every endpoint hangs to its limit; a refusal or a closed connection answers at once. The Arbitrum
 * read runs at the same time and never retries: at most three requests in a row, each within
 * `RPC_TIMEOUT_MS`, so it never makes the snapshot slower than the Robinhood read's worst case.
 */
export const RETRY_PAUSE_MS = 750;

/**
 * One line of the Worker log about the endpoint behind a snapshot (docs/CONTRACTS.md sections 20 and
 * 23). Endpoints are named by their position, never by URL, which may carry a key.
 * - `chainId`: absent for Robinhood Chain, where `endpoint` counts in `rpcUrls`; 42161 for Arbitrum
 *   One, where it counts as `ArbitrumReadConfig` says (0 official, 1 and 2 the pair).
 * - `market_endpoint_used`: the endpoint whose read was used, and the endpoint that agreed with it
 *   when it needed one (null for the keyed or the official endpoint, accepted alone).
 * - `market_endpoint_rejected`: a read that was not accepted, because the second endpoint disagreed,
 *   or because no second endpoint answered. On Robinhood Chain the market is then closed with
 *   `rpc_unavailable`; on Arbitrum only SOL, BNB and HYPE are unread for the tick.
 */
export type MarketLogLine =
  | { event: 'market_endpoint_used'; chainId?: typeof ARBITRUM_CHAIN_ID; endpoint: number; confirmedBy: number | null }
  | {
      event: 'market_endpoint_rejected';
      chainId?: typeof ARBITRUM_CHAIN_ID;
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

/** The three Arbitrum endpoints in position order (0 official, 1 and 2 the pair), or null when the config has none usable. */
function arbitrumUrls(config: MarketConfig): [string, string, string] | null {
  const arbitrum: unknown = config.arbitrum;
  if (typeof arbitrum !== 'object' || arbitrum === null) return null;
  const { officialRpcUrl, confirmingRpcUrls } = arbitrum as Partial<MarketConfig['arbitrum']>;
  if (typeof officialRpcUrl !== 'string' || !Array.isArray(confirmingRpcUrls)) return null;
  const [first, second] = confirmingRpcUrls as unknown[];
  if (typeof first !== 'string' || typeof second !== 'string') return null;
  return [officialRpcUrl, first, second];
}

/**
 * Reads the market from the chain. docs/CONTRACTS.md section 5 specifies it, with the market
 * rules of section 15, `MarketConfig.onEndpointFailure`, and sections 20, 21 and 23.
 *
 * `takeSnapshot` never throws. It reads Robinhood Chain and Arbitrum One at the same time, waits for
 * both, and dates the snapshot once, at `now`.
 *
 * Robinhood Chain (every Stock Token, ETH and BTC; it alone opens and closes the market): each
 * endpoint is tried in order with one batched read each, and the first that answers for the present
 * is taken. A failure that may pass (a timeout, a lost connection, a rate limit, a server error) is
 * tried once more on the same endpoint after `RETRY_PAUSE_MS`; a refusal, an unreadable answer and a
 * node that is behind are not. Every endpoint that gives no snapshot is reported once to
 * `onEndpointFailure`, by its position, with the failure that ended it. If none answers, the market is
 * closed with `rpc_unavailable`, the reason that wins over every other, and the snapshot has no prices.
 * A snapshot from the keyed endpoint or the official one is taken alone. One from a third-party
 * fallback (`isThirdPartyEndpoint`) is taken only when the next endpoint on another host that answers
 * for the present agrees on every Stock Token feed and on the open state (`agreedSnapshot`; a crypto
 * feed on which the two differ is returned unread, never closing the market, and the Arbitrum points
 * are not compared); if it disagrees, or none answers, the market is closed with `rpc_unavailable`.
 *
 * Arbitrum One (SOL, BNB and HYPE, section 23): the official endpoint at `latest`, taken alone; when it
 * gives nothing, the first endpoint of the pair at `latest`, then the second at the first one's L2
 * block (a hex tag, never `latest`), taken only when the two answers are byte-identical. When the
 * first of the pair gives nothing, the second is still asked at `latest`, only to tell `unconfirmed`
 * from `rpc_unavailable`; its answer is never used. Each endpoint once, no retry: at most
 * ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT requests. A read counts only when it says chain 42161, decodes
 * and is current. Then the sequencer and each feed are judged (`withOtherChain`). Any problem makes
 * the three points unread and is named in `otherChains`; it never changes `open`, `closedReason`, or a
 * Stock Token, ETH or BTC point. Failures reach `onEndpointFailure` with `chainId` 42161.
 *
 * Each chain's calldata is encoded once for the universe, not once for a request, and an answer two
 * endpoints of one snapshot give in the same bytes is decoded once (`DecodedAnswers` in `./chain.ts`):
 * an alarm has 10 ms of CPU. Neither changes a byte of a request or anything a snapshot says.
 *
 * Every returned read is logged as `market_endpoint_used` and every refused one as
 * `market_endpoint_rejected`, by position only (`MarketLogLine`). A snapshot is not cached here: the
 * scheduler takes one per tick and stores it.
 *
 * Every threshold comes from `config`: `staleAfterSeconds` halts a Stock Token,
 * `cryptoStaleAfterSecondsBySymbol` halts a crypto asset, `quietAfterSeconds` closes the market and
 * `arbitrum.sequencerGraceSeconds` holds Arbitrum after an outage. This package holds no value for any
 * of them. A threshold that is missing or not a number fails closed: for a crypto asset, that halts
 * the symbol and leaves the market as the Stock Tokens say (docs/CONTRACTS.md sections 21 and 23).
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
    decoded: DecodedAnswers,
  ): Promise<{ snapshot: MarketSnapshot } | { failure: MarketEndpointFailure }> {
    try {
      return await tryEndpoint(rpcUrl, endpoint, now, decoded);
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
    decoded: DecodedAnswers,
  ): Promise<{ snapshot: MarketSnapshot } | { failure: MarketEndpointFailure }> {
    const nowSeconds = unixSeconds(now);
    let outcome: ReadOutcome = await readSnapshot(rpcUrl, UNIVERSE, config.fetch, timeoutMs, decoded);
    if (!outcome.ok && isTransient(outcome.failure)) {
      await pause(RETRY_PAUSE_MS);
      outcome = await readSnapshot(rpcUrl, UNIVERSE, config.fetch, timeoutMs, decoded);
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
        cryptoStaleAfterSecondsBySymbol: config.cryptoStaleAfterSecondsBySymbol,
        quietAfterSeconds: config.quietAfterSeconds,
      }),
    };
  }

  /** The Robinhood Chain side of a snapshot: every endpoint in order under the section 20 rule. */
  async function readRobinhood(now: Date, decoded: DecodedAnswers): Promise<MarketSnapshot> {
    const urls = config.rpcUrls;
    for (let endpoint = 0; endpoint < urls.length; endpoint++) {
      const rpcUrl = urls[endpoint] as string;
      const result = await attempt(rpcUrl, endpoint, now, decoded);
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
        const check = await attempt(secondUrl, second, now, decoded);
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
  }

  /**
   * One Arbitrum request to the endpoint at `position`, judged: a decoded answer for chain 42161 whose
   * block is current, or the failure, which is reported with `chainId` 42161. No retry. Never throws.
   */
  async function arbitrumAt(
    url: string,
    position: number,
    block: bigint | 'latest',
    nowSeconds: number,
    decoded: DecodedAnswers,
  ): Promise<ArbitrumAnswer | null> {
    let failure: MarketEndpointFailure;
    try {
      const outcome = await readArbitrum(url, block, UNIVERSE, config.fetch, timeoutMs, undefined, decoded);
      if (outcome.ok) {
        const { blockTimestamp } = outcome.answer;
        if (nodeIsCurrent(blockTimestamp, nowSeconds)) return outcome.answer;
        failure = {
          chainId: ARBITRUM_CHAIN_ID,
          endpoint: position,
          kind: 'behind',
          lagSeconds: nodeLagSeconds(blockTimestamp, nowSeconds),
        };
      } else {
        failure = { chainId: ARBITRUM_CHAIN_ID, endpoint: position, ...outcome.failure };
      }
    } catch {
      failure = { chainId: ARBITRUM_CHAIN_ID, endpoint: position, kind: 'network' };
    }
    report(config, failure);
    return null;
  }

  /**
   * The Arbitrum One side of a snapshot (section 23, rules 1 to 4): which read is taken, or why none
   * is. At most three requests, each endpoint once.
   */
  async function readArbitrumSide(now: Date, decoded: DecodedAnswers): Promise<OtherChainSource> {
    const urls = arbitrumUrls(config);
    // Without a usable Arbitrum config nothing is asked, and the three coins are unread (fail closed).
    if (urls === null) return { problem: 'rpc_unavailable' };
    const [official, first, second] = urls;
    const nowSeconds = unixSeconds(now);
    const take = (answer: ArbitrumAnswer, endpoint: number, confirmedBy: number | null): OtherChainSource => {
      log({ event: 'market_endpoint_used', chainId: ARBITRUM_CHAIN_ID, endpoint, confirmedBy });
      return {
        taken: {
          l2BlockNumber: answer.l2BlockNumber,
          sequencer: answer.sequencer,
          reads: answer.reads,
          endpoint,
          confirmedBy,
        },
      };
    };

    const alone = await arbitrumAt(official, 0, 'latest', nowSeconds, decoded);
    if (alone !== null) return take(alone, 0, null);

    const pinned = await arbitrumAt(first, 1, 'latest', nowSeconds, decoded);
    if (pinned === null) {
      // Only to tell `unconfirmed` from `rpc_unavailable`: one answer alone is never taken.
      const lone = await arbitrumAt(second, 2, 'latest', nowSeconds, decoded);
      if (lone === null) return { problem: 'rpc_unavailable' };
      log({
        event: 'market_endpoint_rejected',
        chainId: ARBITRUM_CHAIN_ID,
        endpoint: 2,
        confirmedBy: null,
        reason: 'unconfirmed',
      });
      return { problem: 'unconfirmed' };
    }
    const check = await arbitrumAt(second, 2, pinned.l2BlockNumber, nowSeconds, decoded);
    if (check === null) {
      log({
        event: 'market_endpoint_rejected',
        chainId: ARBITRUM_CHAIN_ID,
        endpoint: 1,
        confirmedBy: null,
        reason: 'unconfirmed',
      });
      return { problem: 'unconfirmed' };
    }
    if (!arbitrumAnswersAgree(pinned.raw, check.raw)) {
      log({
        event: 'market_endpoint_rejected',
        chainId: ARBITRUM_CHAIN_ID,
        endpoint: 1,
        confirmedBy: 2,
        reason: 'disagreed',
      });
      return { problem: 'disagreed' };
    }
    return take(pinned, 1, 2);
  }

  /** `readArbitrumSide`, with anything it throws turned into an unread Arbitrum. */
  async function arbitrumSide(now: Date, decoded: DecodedAnswers): Promise<OtherChainSource> {
    try {
      return await readArbitrumSide(now, decoded);
    } catch {
      return { problem: 'rpc_unavailable' };
    }
  }

  return {
    async takeSnapshot(now: Date): Promise<MarketSnapshot> {
      // An unusable `now` cannot date a snapshot. Report closed at the current time and read nothing.
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        return closedSnapshot(new Date(), 'rpc_unavailable');
      }
      // An answer two endpoints of this snapshot give in the same bytes is decoded once.
      const decoded = createDecodedAnswers();
      // Both chains at the same time; the snapshot waits for both (section 23, rule 4).
      const [robinhood, arbitrum] = await Promise.all([readRobinhood(now, decoded), arbitrumSide(now, decoded)]);
      try {
        return withOtherChain(robinhood, {
          universe: UNIVERSE,
          source: arbitrum,
          cryptoStaleAfterSecondsBySymbol: config.cryptoStaleAfterSecondsBySymbol,
          sequencerGraceSeconds: config.arbitrum?.sequencerGraceSeconds ?? Number.NaN,
        });
      } catch {
        // Nothing in withOtherChain should throw. If it does, Arbitrum is unread; Robinhood stands.
        return withOtherChain(robinhood, {
          universe: UNIVERSE,
          source: { problem: 'rpc_unavailable' },
          cryptoStaleAfterSecondsBySymbol: {},
          sequencerGraceSeconds: Number.NaN,
        });
      }
    },
  };
}

/** The market of the product: `createMarketWith` with the real pause, time limit and log. */
export const createMarket: CreateMarket = (config) => createMarketWith(config);
