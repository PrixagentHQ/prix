import type { MarketEndpointFailure } from '@prix/contracts';
import { CRYPTO_FEED_STALE_AFTER_SECONDS, FEED_STALE_AFTER_SECONDS, MARKET_QUIET_AFTER_SECONDS } from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarketConfig, logMarketEndpointFailure, workerRpcUrls } from '../../apps/api/src/market-config.ts';

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
    expect(config.cryptoStaleAfterSeconds).toBe(CRYPTO_FEED_STALE_AFTER_SECONDS);
    expect(config.quietAfterSeconds).toBe(MARKET_QUIET_AFTER_SECONDS);
    config.onEndpointFailure?.({ endpoint: 0, kind: 'rpc_error', code: -32603 });
    expect(lines(warn)).toEqual([
      { event: 'market_endpoint_failed', endpoint: 0, kind: 'rpc_error', code: -32603, lagSeconds: null },
    ]);
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
