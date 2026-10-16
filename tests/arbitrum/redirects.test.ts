import { ARBITRUM_CHAIN_ID, ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT } from '@prix/contracts';
import { PUBLIC_RPC_URLS } from '@prix/market';
import { describe, expect, it } from 'vitest';
import {
  ARB_OFFICIAL,
  ARB_PAIR_ONE,
  ARB_PAIR_TWO,
  isArbitrumUrl,
  robinhoodFailures,
} from '../support/fake-arbitrum.ts';
import { TEST_PRICES } from '../support/fixtures.ts';
import { type Hop, type Redirect, redirecting } from '../support/wire-faults.ts';
import {
  answerOf,
  arbitrumReadOf,
  isUnread,
  pointOf,
  ROBINHOOD_URL,
  robinhoodPoints,
  type Scene,
  scene,
} from './support.ts';

/**
 * No chain read follows a redirect (docs/CONTRACTS.md section 23, rule 4: each endpoint once, at most
 * ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT requests a snapshot; security review of the second-chain read).
 * A request that `fetch` sends on is one more request, to a host nobody named, whose answer would be
 * taken as the endpoint's own: for the official Arbitrum endpoint, alone. So every request says
 * `redirect: 'manual'`, and a 3xx is what `MarketEndpointFailure` calls it: `http`, an HTTP status
 * other than 200, with its code.
 *
 * The fake chains never redirect. `redirecting` (tests/support/wire-faults.ts) does what `fetch`
 * does with one, and sends a followed request to a chain that lies about every price.
 */

const ARBITRUM_SYMBOLS = ['BNB', 'HYPE', 'SOL'] as const;
const ARBITRUM_ENDPOINTS = [ARB_OFFICIAL, ARB_PAIR_ONE, ARB_PAIR_TWO] as const;
/** Where the redirects point: hosts that are in no config. */
const ELSEWHERE_ARBITRUM = 'https://elsewhere.test/arbitrum';
const ELSEWHERE_ROBINHOOD = 'https://elsewhere.test/robinhood';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

/** The host behind the redirects: a chain that answers three times the price of every symbol. */
function liar(): typeof fetch {
  const lying = scene();
  for (const [symbol, price] of Object.entries(TEST_PRICES)) lying.setFeed(symbol, { answer: answerOf(price) * 3n });
  return async (input, init) =>
    String(input).startsWith(ELSEWHERE_ARBITRUM)
      ? lying.rpc.fetch(ARB_OFFICIAL, init)
      : lying.rpc.fetch(ROBINHOOD_URL, init);
}

function redirectsOf(urls: readonly string[], status: number, location: string): Map<string, Redirect> {
  return new Map(urls.map((url, index) => [url, { status, location: `${location}/${index}` }]));
}

/** The requests the market itself made to Arbitrum endpoints, in order. */
function arbitrumHops(hops: readonly Hop[]): Hop[] {
  return hops.filter((hop) => hop.followedFrom === null && isArbitrumUrl(hop.url));
}

/** The requests `fetch` sent on after a redirect. There must be none. */
function sentOn(hops: readonly Hop[]): Hop[] {
  return hops.filter((hop) => hop.followedFrom !== null);
}

function arbitrumFailures(s: Scene) {
  return s.failures.filter((failure) => failure.chainId === ARBITRUM_CHAIN_ID).sort((a, b) => a.endpoint - b.endpoint);
}

describe('every chain request says redirect: manual', () => {
  it('to each of the three Arbitrum endpoints', async () => {
    const s = scene();
    // The official endpoint gives nothing, so the pair is asked too.
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    const wire = redirecting(s.rpc.fetch, new Map(), liar());
    await s.take({ fetch: wire.fetch });
    const hops = arbitrumHops(wire.hops);
    expect(hops.map((hop) => hop.url)).toEqual([...ARBITRUM_ENDPOINTS]);
    for (const hop of hops) expect(hop.redirect, hop.url).toBe('manual');
  });

  it('to each Robinhood Chain endpoint, the retry included', async () => {
    const s = scene();
    const [official, publicnode, drpc] = PUBLIC_RPC_URLS as [string, string, string];
    // The official endpoint fails, so it is tried again and the two fallbacks are read.
    s.rpc.setMode(official, 'http_500');
    const wire = redirecting(s.rpc.fetch, new Map(), liar());
    const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: [official, publicnode, drpc] });
    expect(snapshot.open).toBe(true);
    const hops = wire.hops.filter((hop) => !isArbitrumUrl(hop.url));
    expect(new Set(hops.map((hop) => hop.url))).toEqual(new Set([official, publicnode, drpc]));
    for (const hop of hops) expect(hop.redirect, hop.url).toBe('manual');
  });
});

describe('a redirect from an Arbitrum endpoint', () => {
  it('from the official endpoint: one request, an http failure with code 307, and the pair is read instead', async () => {
    const s = scene();
    const wire = redirecting(s.rpc.fetch, redirectsOf([ARB_OFFICIAL], 307, ELSEWHERE_ARBITRUM), liar());
    const snapshot = await s.take({ fetch: wire.fetch });
    expect(sentOn(wire.hops)).toEqual([]);
    expect(arbitrumHops(wire.hops).map((hop) => hop.url)).toEqual([...ARBITRUM_ENDPOINTS]);
    expect(arbitrumFailures(s)).toEqual([{ chainId: ARBITRUM_CHAIN_ID, endpoint: 0, kind: 'http', code: 307 }]);
    expect(arbitrumReadOf(snapshot)).toMatchObject({ endpoint: 1, confirmedBy: 2, problem: null });
    // The pair's prices, never those of the host the redirect named.
    for (const symbol of ARBITRUM_SYMBOLS) {
      expect(pointOf(snapshot, symbol), symbol).toMatchObject({ priceMicro: TEST_PRICES[symbol], fresh: true });
    }
  });

  for (const status of REDIRECT_STATUSES) {
    it(`${status} from all three: three requests, none sent on, the coins unread, the market untouched`, async () => {
      const healthy = await scene().take();
      const s = scene();
      const wire = redirecting(s.rpc.fetch, redirectsOf(ARBITRUM_ENDPOINTS, status, ELSEWHERE_ARBITRUM), liar());
      const snapshot = await s.take({ fetch: wire.fetch });
      expect(sentOn(wire.hops)).toEqual([]);
      expect(arbitrumHops(wire.hops).map((hop) => hop.url)).toEqual([...ARBITRUM_ENDPOINTS]);
      expect(arbitrumFailures(s)).toEqual(
        [0, 1, 2].map((endpoint) => ({ chainId: ARBITRUM_CHAIN_ID, endpoint, kind: 'http', code: status })),
      );
      expect(arbitrumReadOf(snapshot)).toEqual({
        chainId: ARBITRUM_CHAIN_ID,
        blockNumber: 0,
        endpoint: null,
        confirmedBy: null,
        problem: 'rpc_unavailable',
      });
      for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
      // Section 23, rule 7: an Arbitrum problem never closes the market or touches another point.
      expect(snapshot).toMatchObject({ open: true, closedReason: null, blockNumber: healthy.blockNumber });
      expect(robinhoodPoints(snapshot)).toEqual(robinhoodPoints(healthy));
      expect(robinhoodFailures(s.failures)).toEqual([]);
    });
  }

  it('from the first of the pair: nothing is taken from the pair', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    const wire = redirecting(s.rpc.fetch, redirectsOf([ARB_PAIR_ONE], 307, ELSEWHERE_ARBITRUM), liar());
    const snapshot = await s.take({ fetch: wire.fetch });
    expect(sentOn(wire.hops)).toEqual([]);
    expect(arbitrumFailures(s)).toContainEqual({ chainId: ARBITRUM_CHAIN_ID, endpoint: 1, kind: 'http', code: 307 });
    expect(['unconfirmed', 'rpc_unavailable']).toContain(arbitrumReadOf(snapshot)?.problem);
    for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('from the second of the pair: the first stays unconfirmed', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    const wire = redirecting(s.rpc.fetch, redirectsOf([ARB_PAIR_TWO], 307, ELSEWHERE_ARBITRUM), liar());
    const snapshot = await s.take({ fetch: wire.fetch });
    expect(sentOn(wire.hops)).toEqual([]);
    expect(arbitrumFailures(s)).toContainEqual({ chainId: ARBITRUM_CHAIN_ID, endpoint: 2, kind: 'http', code: 307 });
    expect(arbitrumReadOf(snapshot)).toMatchObject({ problem: 'unconfirmed', confirmedBy: null });
    for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('keeps the cap of three requests whichever endpoints redirect', async () => {
    for (let mask = 0; mask < 8; mask++) {
      const redirected = ARBITRUM_ENDPOINTS.filter((_url, index) => (mask & (1 << index)) !== 0);
      const s = scene();
      const wire = redirecting(s.rpc.fetch, redirectsOf(redirected, 307, ELSEWHERE_ARBITRUM), liar());
      const snapshot = await s.take({ fetch: wire.fetch });
      const label = `redirecting: ${redirected.join(', ') || 'none'}`;
      // Every request that left for Arbitrum or because of it, followed ones included.
      const all = wire.hops.filter((hop) => isArbitrumUrl(hop.url) || hop.followedFrom !== null);
      expect(all.length, label).toBeLessThanOrEqual(ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT);
      expect(sentOn(wire.hops), label).toEqual([]);
      for (const url of ARBITRUM_ENDPOINTS) {
        expect(all.filter((hop) => hop.url === url).length, `${label}; ${url}`).toBeLessThanOrEqual(1);
      }
      expect(snapshot, label).toMatchObject({ open: true, closedReason: null });
    }
  });
});

describe('a redirect from a Robinhood Chain endpoint', () => {
  it('is an http failure of that endpoint, is never sent on, and the next endpoint is read', async () => {
    const healthy = await scene().take();
    const s = scene();
    const [official] = PUBLIC_RPC_URLS as [string, string, string];
    const wire = redirecting(s.rpc.fetch, redirectsOf([ROBINHOOD_URL], 307, ELSEWHERE_ROBINHOOD), liar());
    const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: [ROBINHOOD_URL, official] });
    expect(sentOn(wire.hops)).toEqual([]);
    expect(robinhoodFailures(s.failures)).toEqual([{ endpoint: 0, kind: 'http', code: 307 }]);
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    // The official endpoint's prices, never those of the host the redirect named.
    expect(robinhoodPoints(snapshot)).toEqual(robinhoodPoints(healthy));
  });
});
