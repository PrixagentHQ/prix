import type {
  JudgeSequencer,
  MarketConfig,
  MarketEndpointFailure,
  MarketSnapshot,
  OtherChainRead,
  PricePoint,
} from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  FEED_STALE_AFTER_SECONDS,
  MARKET_QUIET_AFTER_SECONDS,
} from '@prix/contracts';
import * as marketIndex from '@prix/market';
import { UNIVERSE } from '@prix/market';
import { createMarketWith, type MarketLogLine } from '@prix/market/market';
import * as marketRules from '@prix/market/rules';
import { ARB_L2_BLOCK, ARBITRUM_FEEDS, isArbitrumUrl, TEST_ARBITRUM } from '../support/fake-arbitrum.ts';
import { FakeRpc } from '../support/fake-rpc.ts';
import { TEST_PRICES, utc } from '../support/fixtures.ts';

/**
 * The scene of the section 23 suites: one fake Robinhood Chain and one fake Arbitrum One behind a
 * single `fetch`, as in the Worker, every feed answering the price of TEST_PRICES at NOW. Nothing is
 * live. The Arbitrum feeds are set by the addresses of the contract, not from `UNIVERSE`, so a
 * universe without them fails on what the market returns, not in the set-up.
 */

/** Monday 2026-10-12, 15:00:05 UTC: the first round after a weekend. */
export const NOW = utc('2026-10-12T15:00:05.000Z');
export const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
export const ROBINHOOD_URL = 'https://rpc-keyed.test/v2/secret-key';

/** Every feed of the scene has 8 decimals; an answer is the price in micro-USD times 100. */
export function answerOf(priceMicro: number): bigint {
  return BigInt(priceMicro) * 100n;
}

export const ROBINHOOD_SYMBOLS: readonly string[] = Object.freeze(
  Object.keys(TEST_PRICES).filter((symbol) => !(symbol in ARBITRUM_FEEDS)),
);

export interface Scene {
  rpc: FakeRpc;
  failures: MarketEndpointFailure[];
  logs: MarketLogLine[];
  /** Every URL fetched, in order. */
  fetched: string[];
  /** Changes the feed of a symbol on every endpoint of its chain. */
  setFeed(symbol: string, patch: Partial<{ answer: bigint; updatedAt: number; reverts: boolean }>): void;
  take(options?: {
    now?: Date;
    rpcUrls?: readonly string[];
    cryptoStaleAfterSecondsBySymbol?: MarketConfig['cryptoStaleAfterSecondsBySymbol'];
    timeoutMs?: number;
    fetch?: typeof fetch;
  }): Promise<MarketSnapshot>;
}

export function feedAddressOf(symbol: string): string {
  const arbitrum = (ARBITRUM_FEEDS as Record<string, string>)[symbol];
  if (arbitrum !== undefined) return arbitrum;
  const token = UNIVERSE.find((entry) => entry.symbol === symbol);
  if (token === undefined) throw new Error(`no feed for ${symbol}`);
  return token.feedAddress.toLowerCase();
}

export function scene(): Scene {
  const rpc = new FakeRpc();
  rpc.blockTimestamp = NOW_SECONDS - 2;
  for (const [symbol, price] of Object.entries(TEST_PRICES)) {
    rpc.setFeed(feedAddressOf(symbol), { answer: answerOf(price), updatedAt: NOW_SECONDS - 60, decimals: 8 });
  }
  const failures: MarketEndpointFailure[] = [];
  const logs: MarketLogLine[] = [];
  const fetched: string[] = [];
  return {
    rpc,
    failures,
    logs,
    fetched,
    setFeed(symbol, patch) {
      const address = feedAddressOf(symbol);
      const current = rpc.feeds.get(address);
      if (current === undefined) throw new Error(`the fake has no feed for ${symbol}`);
      rpc.setFeed(address, { ...current, ...patch });
    },
    take(options = {}) {
      const inner = options.fetch ?? rpc.fetch;
      const fetchFn: typeof fetch = async (input, init) => {
        fetched.push(new Request(input, init).url.replace(/\/+$/, ''));
        return inner(input, init);
      };
      const market = createMarketWith(
        {
          rpcUrls: options.rpcUrls ?? [ROBINHOOD_URL],
          arbitrum: TEST_ARBITRUM,
          staleAfterSeconds: FEED_STALE_AFTER_SECONDS,
          cryptoStaleAfterSecondsBySymbol:
            options.cryptoStaleAfterSecondsBySymbol ?? CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
          quietAfterSeconds: MARKET_QUIET_AFTER_SECONDS,
          fetch: fetchFn,
          onEndpointFailure: (failure) => failures.push(failure),
        },
        {
          pause: async () => {},
          log: (line) => logs.push(line),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
      );
      return market.takeSnapshot(options.now ?? NOW);
    },
  };
}

export function pointOf(snapshot: MarketSnapshot, symbol: string): PricePoint | undefined {
  return snapshot.prices.find((point) => point.symbol === symbol);
}

/** The Arbitrum read of a snapshot: its one `otherChains` entry for chain 42161. */
export function arbitrumReadOf(snapshot: MarketSnapshot): OtherChainRead | undefined {
  return snapshot.otherChains?.find((read) => read.chainId === ARBITRUM_CHAIN_ID);
}

/** A trusted read from the official endpoint, alone, at the fake's head. */
export const OFFICIAL_READ: OtherChainRead = Object.freeze({
  chainId: ARBITRUM_CHAIN_ID,
  blockNumber: ARB_L2_BLOCK,
  endpoint: 0,
  confirmedBy: null,
  problem: null,
});

/** The points of a snapshot that are not read on Arbitrum One: Stock Tokens, BTC and ETH. */
export function robinhoodPoints(snapshot: MarketSnapshot): PricePoint[] {
  return snapshot.prices.filter((point) => !(point.symbol in ARBITRUM_FEEDS));
}

/** True when an Arbitrum point is unread (section 23, rule 7): no price and not fresh. */
export function isUnread(point: PricePoint | undefined): boolean {
  return point !== undefined && point.priceMicro === 0 && point.fresh === false;
}

/** The requests that reached the Robinhood endpoints. */
export function robinhoodFetches(fetched: readonly string[]): string[] {
  return fetched.filter((url) => !isArbitrumUrl(url));
}

/**
 * `judgeSequencer` of packages/market (the `JudgeSequencer` type of section 23). The contract names
 * the type, not the module, so it is looked up in `@prix/market` and `@prix/market/rules`.
 */
export function judgeSequencer(): JudgeSequencer {
  const found =
    (marketRules as Record<string, unknown>).judgeSequencer ?? (marketIndex as Record<string, unknown>).judgeSequencer;
  if (typeof found !== 'function') {
    throw new Error('packages/market exports no judgeSequencer (docs/CONTRACTS.md section 23, JudgeSequencer)');
  }
  return found as JudgeSequencer;
}
