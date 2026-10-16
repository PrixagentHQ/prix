import type { MarketEndpointFailure } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  ARBITRUM_CONFIRMING_RPC_URLS,
  ARBITRUM_OFFICIAL_RPC_URL,
  ARBITRUM_SEQUENCER_GRACE_SECONDS,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  FEED_STALE_AFTER_SECONDS,
  MARKET_QUIET_AFTER_SECONDS,
} from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { createMarketWith } from '@prix/market/market';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarketConfig, logMarketEndpointFailure, workerRpcUrls } from '../../apps/api/src/market-config.ts';
import { FakeRpc } from '../support/fake-rpc.ts';
import { utc } from '../support/fixtures.ts';

/** The Worker's log line for `MarketConfig.onEndpointFailure` (docs/DECISIONS.md D-098). */

afterEach(() => {
  vi.restoreAllMocks();
});

function lines(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])));
}

describe('the log line of a market endpoint that failed', () => {
  it('writes one structured line with the endpoint index, the kind, the code and the lag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logMarketEndpointFailure({ endpoint: 0, kind: 'http', code: 429 });
    logMarketEndpointFailure({ endpoint: 1, kind: 'behind', lagSeconds: 95 });
    expect(lines(warn)).toEqual([
      { event: 'market_endpoint_failed', endpoint: 0, kind: 'http', code: 429, lagSeconds: null },
      { event: 'market_endpoint_failed', endpoint: 1, kind: 'behind', code: null, lagSeconds: 95 },
    ]);
  });

  it('never writes the URL or anything else the failure carries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = {
      endpoint: 0,
      kind: 'network',
      url: 'https://rpc.example/v2/secret-key',
      message: 'fetch failed for https://rpc.example/v2/secret-key',
    } as MarketEndpointFailure;
    logMarketEndpointFailure(failure);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('secret-key');
    expect(lines(warn)).toEqual([
      { event: 'market_endpoint_failed', endpoint: 0, kind: 'network', code: null, lagSeconds: null },
    ]);
  });

  it('writes a value that is not a plain number or a known kind as null or "unknown"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const odd = {
      endpoint: Number.NaN,
      kind: 'https://rpc.example/v2/secret-key',
      code: '429',
      lagSeconds: Number.POSITIVE_INFINITY,
    } as unknown as MarketEndpointFailure;
    logMarketEndpointFailure(odd);
    expect(lines(warn)).toEqual([
      { event: 'market_endpoint_failed', endpoint: null, kind: 'unknown', code: null, lagSeconds: null },
    ]);
  });

  it('never throws, even when the console does', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console down');
    });
    expect(() => logMarketEndpointFailure({ endpoint: 0, kind: 'timeout' })).not.toThrow();
  });
});

describe('the market config of the Worker', () => {
  it('keeps the endpoints in order, takes the limits of the contract and logs every endpoint failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = createMarketConfig(['https://keyed.example/v2/secret-key', 'https://public.example']);
    expect(config.rpcUrls).toEqual(['https://keyed.example/v2/secret-key', 'https://public.example']);
    expect(config.staleAfterSeconds).toBe(FEED_STALE_AFTER_SECONDS);
    expect(config.cryptoStaleAfterSecondsBySymbol).toEqual(CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL);
    expect(config.quietAfterSeconds).toBe(MARKET_QUIET_AFTER_SECONDS);
    config.onEndpointFailure?.({ endpoint: 0, kind: 'rpc_error', code: -32603 });
    expect(lines(warn)).toEqual([
      { event: 'market_endpoint_failed', endpoint: 0, kind: 'rpc_error', code: -32603, lagSeconds: null },
    ]);
  });

  it('reads Arbitrum One through the endpoints, the pair and the grace of section 23, and no other', () => {
    const config = createMarketConfig(['https://keyed.example/v2/secret-key']);
    expect(config.arbitrum).toEqual({
      officialRpcUrl: ARBITRUM_OFFICIAL_RPC_URL,
      confirmingRpcUrls: [...ARBITRUM_CONFIRMING_RPC_URLS],
      sequencerGraceSeconds: ARBITRUM_SEQUENCER_GRACE_SECONDS,
    });
    // D-127: the confirming pair is publicnode and dRPC, on two hosts, no key in either URL.
    expect(config.arbitrum.confirmingRpcUrls).toEqual([
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org',
    ]);
    expect(config.arbitrum.officialRpcUrl).toBe('https://arb1.arbitrum.io/rpc');
    // The keyed Robinhood endpoint never reaches Arbitrum.
    expect(JSON.stringify(config.arbitrum)).not.toContain('secret-key');
  });

  it('gives every crypto symbol of section 23 its own staleness', () => {
    const config = createMarketConfig([]);
    expect(config.cryptoStaleAfterSecondsBySymbol).toEqual({
      BTC: 90_000,
      ETH: 90_000,
      SOL: 7_200,
      BNB: 21_600,
      HYPE: 43_200,
    });
  });

  it('logs an Arbitrum endpoint failure by its position, with no URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = createMarketConfig(['https://keyed.example/v2/secret-key']);
    config.onEndpointFailure?.({
      chainId: ARBITRUM_CHAIN_ID,
      endpoint: 2,
      kind: 'http',
      code: 429,
      url: 'https://arbitrum.drpc.org',
    } as MarketEndpointFailure);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]?.[0]);
    expect(text).not.toContain('drpc');
    expect(text).not.toContain('https:');
    expect(lines(warn)[0]).toMatchObject({ event: 'market_endpoint_failed', endpoint: 2, kind: 'http', code: 429 });
  });

  it('says the chain of an Arbitrum endpoint failure: chainId 42161, and none for Robinhood Chain', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logMarketEndpointFailure({ chainId: ARBITRUM_CHAIN_ID, endpoint: 0, kind: 'http', code: 307 });
    logMarketEndpointFailure({ chainId: ARBITRUM_CHAIN_ID, endpoint: 2, kind: 'behind', lagSeconds: 400 });
    logMarketEndpointFailure({ endpoint: 2, kind: 'timeout' });
    expect(ARBITRUM_CHAIN_ID).toBe(42161);
    expect(lines(warn)).toEqual([
      {
        event: 'market_endpoint_failed',
        chainId: ARBITRUM_CHAIN_ID,
        endpoint: 0,
        kind: 'http',
        code: 307,
        lagSeconds: null,
      },
      {
        event: 'market_endpoint_failed',
        chainId: ARBITRUM_CHAIN_ID,
        endpoint: 2,
        kind: 'behind',
        code: null,
        lagSeconds: 400,
      },
      // Absent means Robinhood Chain (section 23): the same position in the other list.
      { event: 'market_endpoint_failed', endpoint: 2, kind: 'timeout', code: null, lagSeconds: null },
    ]);
    expect('chainId' in (lines(warn)[2] as object)).toBe(false);
  });

  it('writes a chain that is not a feed chain as null, never as given', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const chainId of [1, '42161', 'https://rpc.example/v2/secret-key', null, Number.NaN]) {
      logMarketEndpointFailure({ chainId, endpoint: 0, kind: 'network' } as unknown as MarketEndpointFailure);
    }
    expect(warn.mock.calls.map((call) => String(call[0])).join(' ')).not.toContain('secret-key');
    for (const line of lines(warn)) {
      expect(line).toEqual({
        event: 'market_endpoint_failed',
        chainId: null,
        endpoint: 0,
        kind: 'network',
        code: null,
        lagSeconds: null,
      });
    }
  });

  it('carries chainId 42161 in the line of every Arbitrum failure a snapshot reports', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = new FakeRpc();
    const now = utc('2026-10-12T15:00:05.000Z');
    rpc.blockTimestamp = Math.floor(now.getTime() / 1_000) - 2;
    // Robinhood Chain answers nothing either: its lines must not say Arbitrum.
    rpc.setMode('https://keyed.example/v2/secret-key', 'http_500');
    rpc.arbitrum.set({ mode: 'http_429' });
    const config = createMarketConfig(['https://keyed.example/v2/secret-key']);
    const market = createMarketWith({ ...config, fetch: rpc.fetch }, { pause: async () => {}, log: () => {} });
    const snapshot = await market.takeSnapshot(now);
    expect(snapshot.open).toBe(false);
    // The Worker's own Arbitrum endpoints were asked, each once, and nothing else on that chain.
    expect(rpc.arbitrum.requests.map((request) => request.url)).toEqual([
      ARBITRUM_OFFICIAL_RPC_URL,
      ...ARBITRUM_CONFIRMING_RPC_URLS,
    ]);
    const failed = lines(warn).filter(
      (line) => (line as { event?: unknown }).event === 'market_endpoint_failed',
    ) as Record<string, unknown>[];
    const arbitrum = failed.filter((line) => line.chainId !== undefined);
    expect(arbitrum.sort((a, b) => Number(a.endpoint) - Number(b.endpoint))).toEqual(
      [0, 1, 2].map((endpoint) => ({
        event: 'market_endpoint_failed',
        chainId: ARBITRUM_CHAIN_ID,
        endpoint,
        kind: 'http',
        code: 429,
        lagSeconds: null,
      })),
    );
    expect(failed.filter((line) => line.chainId === undefined)).toEqual([
      { event: 'market_endpoint_failed', endpoint: 0, kind: 'http', code: 500, lagSeconds: null },
    ]);
    expect(warn.mock.calls.map((call) => String(call[0])).join(' ')).not.toContain('secret-key');
  });
});

describe('the endpoints of every chain read of the Worker', () => {
  const KEYED = 'https://rpc.example.test/v2/secret-key';

  it('uses the public endpoints in their order when no keyed endpoint is set', () => {
    const ignored = vi.fn();
    expect(workerRpcUrls(undefined, ignored)).toEqual([...PUBLIC_RPC_URLS]);
    expect(workerRpcUrls('  ', ignored)).toEqual([...PUBLIC_RPC_URLS]);
    expect(ignored).not.toHaveBeenCalled();
  });

  it('puts a valid keyed endpoint first, then every public one in order', () => {
    const ignored = vi.fn();
    expect(workerRpcUrls(` ${KEYED} `, ignored)).toEqual([KEYED, ...PUBLIC_RPC_URLS]);
    expect(PUBLIC_RPC_URLS.length).toBeGreaterThanOrEqual(3);
    expect(ignored).not.toHaveBeenCalled();
  });

  it('leaves out a keyed value that is not an https URL and says so once, without the value', () => {
    for (const bad of ['http://rpc.example.test/v2/secret-key', 'not a url secret-key']) {
      const ignored = vi.fn();
      expect(workerRpcUrls(bad, ignored)).toEqual([...PUBLIC_RPC_URLS]);
      expect(ignored).toHaveBeenCalledTimes(1);
      expect(ignored.mock.calls[0]).toEqual([]);
    }
  });
});
