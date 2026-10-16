import { ARBITRUM_CHAIN_ID, ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT } from '@prix/contracts';
import { PUBLIC_RPC_URLS, UNIVERSE } from '@prix/market';
import { RPC_MAX_RESPONSE_BYTES } from '@prix/market/body';
import { arbitrumResultMaxBytes, snapshotResultMaxBytes } from '@prix/market/wire';
import { describe, expect, it } from 'vitest';
import { decodeMulticallResult, type Hex } from '../support/abi.ts';
import {
  ARB_OFFICIAL,
  ARB_PAIR_ONE,
  ARB_PAIR_TWO,
  robinhoodFailures,
  robinhoodLines,
} from '../support/fake-arbitrum.ts';
import { TEST_PRICES } from '../support/fixtures.ts';
import {
  oneResultExtra,
  oneResultShort,
  paddedAfter,
  paddedInside,
  type Reshape,
  type Reshaped,
  reshaping,
  unchanged,
} from '../support/wire-faults.ts';
import { arbitrumReadOf, isUnread, pointOf, robinhoodPoints, type Scene, scene } from './support.ts';

/**
 * An answer that decodes but is not the answer to the question is `malformed`, on both chains, from
 * the official endpoint and from each endpoint of the pair (docs/CONTRACTS.md section 23, rule 2: a
 * read counts only if it decodes; sections 20 and 23, rule 1: the 256 KB cap; security review of the
 * second-chain read).
 *
 * Two kinds, both under the 256 KB cap, so that cap does not catch them:
 * - oversized: the honest answer padded to just under 256 KB, inside one inner answer or after the
 *   last word. An honest read is a few kilobytes, so this is over any maximum a read can have. An ABI
 *   decoder ignores the padding, which is why a reader that only decodes takes it.
 * - miscounted: one result short, or one too many.
 *
 * `reshaping` (tests/support/wire-faults.ts) changes the fake chains' honest answer; each test first
 * checks that the answer it sent is the fault it names.
 *
 * The maximum itself is packages/market's own (`arbitrumResultMaxBytes` and `snapshotResultMaxBytes`
 * of `@prix/market/wire`; the contract names no number). Its suite checks only what any maximum must
 * do: hold an honest answer, refuse before the body cap does, and refuse one word more.
 */

const ARBITRUM_SYMBOLS = ['BNB', 'HYPE', 'SOL'] as const;
const [OFFICIAL, PUBLICNODE, DRPC] = PUBLIC_RPC_URLS as [string, string, string];
const ROBINHOOD_ENDPOINTS = [OFFICIAL, PUBLICNODE, DRPC] as const;
/** The size of an oversized response: just under the cap of sections 20 and 23. */
const BODY_BYTES = RPC_MAX_RESPONSE_BYTES - 2_048;

interface Fault {
  label: string;
  kind: 'oversized' | 'miscounted';
  reshape: Reshape;
}

const FAULTS: readonly Fault[] = [
  { label: 'padded inside one inner answer to just under 256 KB', kind: 'oversized', reshape: paddedInside },
  { label: 'padded after its last word to just under 256 KB', kind: 'oversized', reshape: paddedAfter },
  { label: 'one result short', kind: 'miscounted', reshape: oneResultShort },
  { label: 'with one result too many', kind: 'miscounted', reshape: oneResultExtra },
];

/** Checks the test's own fault: what was sent is what the label says, and it still decodes. */
function expectFault(sent: readonly Reshaped[], fault: Fault): void {
  expect(sent.length).toBeGreaterThan(0);
  for (const answer of sent) {
    const honest = decodeMulticallResult(answer.functionName, answer.honest);
    const changed = decodeMulticallResult(answer.functionName, answer.result);
    if (honest === null || changed === null) throw new Error(`the ${fault.label} answer does not decode`);
    expect(answer.bodyBytes).toBeLessThan(RPC_MAX_RESPONSE_BYTES);
    if (fault.kind === 'oversized') {
      expect(answer.bodyBytes).toBeGreaterThan(RPC_MAX_RESPONSE_BYTES - 4_096);
      // The same results, in the same order, each beginning with the honest bytes.
      expect(changed.blockNumber).toBe(honest.blockNumber);
      expect(changed.answers).toHaveLength(honest.answers.length);
      changed.answers.forEach((inner, index) => {
        const was = honest.answers[index] ?? null;
        expect(inner === was || (inner !== null && was !== null && inner.startsWith(was)), `result ${index}`).toBe(
          true,
        );
      });
    } else {
      expect(Math.abs(changed.answers.length - honest.answers.length)).toBe(1);
    }
  }
}

function arbitrumFailures(s: Scene) {
  return s.failures.filter((failure) => failure.chainId === ARBITRUM_CHAIN_ID).sort((a, b) => a.endpoint - b.endpoint);
}

function expectArbitrumUnread(snapshot: Awaited<ReturnType<Scene['take']>>): void {
  for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
}

/** Section 23, rules 4 and 7: at most three requests, each endpoint once, and the market as Robinhood says. */
async function expectMarketUntouched(s: Scene, snapshot: Awaited<ReturnType<Scene['take']>>): Promise<void> {
  const healthy = await scene().take();
  expect(snapshot).toMatchObject({ open: true, closedReason: null, blockNumber: healthy.blockNumber });
  expect(robinhoodPoints(snapshot)).toEqual(robinhoodPoints(healthy));
  expect(robinhoodFailures(s.failures)).toEqual([]);
  expect(s.rpc.arbitrum.requests.length).toBeLessThanOrEqual(ARBITRUM_MAX_REQUESTS_PER_SNAPSHOT);
  for (const url of [ARB_OFFICIAL, ARB_PAIR_ONE, ARB_PAIR_TWO]) {
    expect(s.rpc.arbitrum.requestsTo(url).length, url).toBeLessThanOrEqual(1);
  }
}

describe('the faults of this suite change nothing else', () => {
  it('an honest answer, decoded and encoded again, is the same bytes and gives the same snapshot', async () => {
    const healthy = await scene().take({ rpcUrls: ROBINHOOD_ENDPOINTS });
    const s = scene();
    const wire = reshaping(s.rpc.fetch, [ARB_OFFICIAL, OFFICIAL], unchanged, BODY_BYTES);
    const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: ROBINHOOD_ENDPOINTS });
    expect(wire.sent.map((answer) => answer.url).sort()).toEqual([ARB_OFFICIAL, OFFICIAL].sort());
    for (const answer of wire.sent) expect(answer.result, answer.url).toBe(answer.honest);
    expect(snapshot).toEqual(healthy);
    expect(s.failures).toEqual([]);
  });
});

describe('the per-read maximum of packages/market', () => {
  const bytesOf = (hex: string): number => (hex.length - 2) / 2;
  /** The honest answer with zero bytes after it, up to `bytes` in all. */
  const paddedTo =
    (bytes: number): Reshape =>
    ({ result }) =>
      `${result}${'00'.repeat(Math.max(0, bytes - bytesOf(result)))}` as Hex;

  it('holds an honest Arbitrum answer, bites before the body cap, and one word over it is malformed', async () => {
    const max = arbitrumResultMaxBytes(UNIVERSE);
    const s = scene();
    const wire = reshaping(s.rpc.fetch, [ARB_OFFICIAL], paddedTo(max + 32), BODY_BYTES);
    const snapshot = await s.take({ fetch: wire.fetch });
    expect(wire.sent).toHaveLength(1);
    for (const answer of wire.sent) {
      expect(bytesOf(answer.honest)).toBeLessThanOrEqual(max);
      expect(bytesOf(answer.result)).toBe(max + 32);
      expect(decodeMulticallResult(answer.functionName, answer.result)).toEqual(
        decodeMulticallResult(answer.functionName, answer.honest),
      );
    }
    // As hex in a JSON body, the maximum is under the 256 KB cap: it is the rule that refuses first.
    expect(2 * max).toBeLessThan(RPC_MAX_RESPONSE_BYTES);
    expect(arbitrumFailures(s)).toEqual([{ chainId: ARBITRUM_CHAIN_ID, endpoint: 0, kind: 'malformed' }]);
    expect(arbitrumReadOf(snapshot)).toMatchObject({ endpoint: 1, confirmedBy: 2, problem: null });
    await expectMarketUntouched(s, snapshot);
  });

  it('holds an honest Robinhood Chain answer, bites before the body cap, and one word over it is malformed', async () => {
    const max = snapshotResultMaxBytes(UNIVERSE);
    const healthy = await scene().take({ rpcUrls: ROBINHOOD_ENDPOINTS });
    const s = scene();
    const wire = reshaping(s.rpc.fetch, [OFFICIAL], paddedTo(max + 32), BODY_BYTES);
    const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: ROBINHOOD_ENDPOINTS });
    expect(wire.sent).toHaveLength(1);
    for (const answer of wire.sent) {
      expect(bytesOf(answer.honest)).toBeLessThanOrEqual(max);
      expect(bytesOf(answer.result)).toBe(max + 32);
      expect(decodeMulticallResult(answer.functionName, answer.result)).toEqual(
        decodeMulticallResult(answer.functionName, answer.honest),
      );
    }
    expect(2 * max).toBeLessThan(RPC_MAX_RESPONSE_BYTES);
    expect(robinhoodFailures(s.failures)).toEqual([{ endpoint: 0, kind: 'malformed' }]);
    expect(snapshot).toEqual(healthy);
  });
});

for (const fault of FAULTS) {
  describe(`an Arbitrum answer ${fault.label}`, () => {
    it('from the official endpoint is malformed, and the pair is read instead', async () => {
      const s = scene();
      const wire = reshaping(s.rpc.fetch, [ARB_OFFICIAL], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch });
      expectFault(wire.sent, fault);
      expect(arbitrumFailures(s)).toEqual([{ chainId: ARBITRUM_CHAIN_ID, endpoint: 0, kind: 'malformed' }]);
      expect(arbitrumReadOf(snapshot)).toMatchObject({ endpoint: 1, confirmedBy: 2, problem: null });
      for (const symbol of ARBITRUM_SYMBOLS) {
        expect(pointOf(snapshot, symbol), symbol).toMatchObject({ priceMicro: TEST_PRICES[symbol], fresh: true });
      }
      await expectMarketUntouched(s, snapshot);
    });

    it('from the first of the pair is malformed, and nothing is taken from the pair', async () => {
      const s = scene();
      s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
      const wire = reshaping(s.rpc.fetch, [ARB_PAIR_ONE], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch });
      expectFault(wire.sent, fault);
      expect(arbitrumFailures(s)).toContainEqual({ chainId: ARBITRUM_CHAIN_ID, endpoint: 1, kind: 'malformed' });
      expect(['unconfirmed', 'rpc_unavailable']).toContain(arbitrumReadOf(snapshot)?.problem);
      expectArbitrumUnread(snapshot);
      await expectMarketUntouched(s, snapshot);
    });

    it('from the second of the pair is malformed, and the first stays unconfirmed', async () => {
      const s = scene();
      s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
      const wire = reshaping(s.rpc.fetch, [ARB_PAIR_TWO], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch });
      expectFault(wire.sent, fault);
      expect(arbitrumFailures(s)).toContainEqual({ chainId: ARBITRUM_CHAIN_ID, endpoint: 2, kind: 'malformed' });
      expect(arbitrumReadOf(snapshot)).toMatchObject({ problem: 'unconfirmed', confirmedBy: null });
      expectArbitrumUnread(snapshot);
      await expectMarketUntouched(s, snapshot);
    });

    it('from both of the pair, byte-identical, is no agreement: both are malformed', async () => {
      const s = scene();
      s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
      const wire = reshaping(s.rpc.fetch, [ARB_PAIR_ONE, ARB_PAIR_TWO], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch });
      expectFault(wire.sent, fault);
      expect(arbitrumFailures(s)).toEqual([
        { chainId: ARBITRUM_CHAIN_ID, endpoint: 0, kind: 'http', code: 500 },
        { chainId: ARBITRUM_CHAIN_ID, endpoint: 1, kind: 'malformed' },
        { chainId: ARBITRUM_CHAIN_ID, endpoint: 2, kind: 'malformed' },
      ]);
      expect(arbitrumReadOf(snapshot)).toEqual({
        chainId: ARBITRUM_CHAIN_ID,
        blockNumber: 0,
        endpoint: null,
        confirmedBy: null,
        problem: 'rpc_unavailable',
      });
      expectArbitrumUnread(snapshot);
      await expectMarketUntouched(s, snapshot);
    });
  });

  describe(`a Robinhood Chain answer ${fault.label}`, () => {
    it('from the official endpoint is malformed, and the two fallbacks are read instead', async () => {
      const healthy = await scene().take({ rpcUrls: ROBINHOOD_ENDPOINTS });
      const s = scene();
      const wire = reshaping(s.rpc.fetch, [OFFICIAL], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: ROBINHOOD_ENDPOINTS });
      expectFault(wire.sent, fault);
      expect(robinhoodFailures(s.failures)).toEqual([{ endpoint: 0, kind: 'malformed' }]);
      expect(snapshot).toEqual(healthy);
      expect(robinhoodLines(s.logs)).toEqual([{ event: 'market_endpoint_used', endpoint: 1, confirmedBy: 2 }]);
    });

    it('from the first fallback is malformed, and the second alone closes the market', async () => {
      const s = scene();
      s.rpc.setMode(OFFICIAL, 'http_500');
      const wire = reshaping(s.rpc.fetch, [PUBLICNODE], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: ROBINHOOD_ENDPOINTS });
      expectFault(wire.sent, fault);
      expect(robinhoodFailures(s.failures)).toContainEqual({ endpoint: 1, kind: 'malformed' });
      // Section 20: a third party's snapshot with no second endpoint to agree is not taken.
      expect(snapshot).toMatchObject({ open: false, closedReason: 'rpc_unavailable', prices: [] });
    });

    it('from the second fallback is malformed, and the first alone closes the market', async () => {
      const s = scene();
      s.rpc.setMode(OFFICIAL, 'http_500');
      const wire = reshaping(s.rpc.fetch, [DRPC], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: ROBINHOOD_ENDPOINTS });
      expectFault(wire.sent, fault);
      expect(robinhoodFailures(s.failures)).toContainEqual({ endpoint: 2, kind: 'malformed' });
      expect(snapshot).toMatchObject({ open: false, closedReason: 'rpc_unavailable', prices: [] });
    });

    it('from both fallbacks, the same answer, is no agreement: both are malformed and the market is closed', async () => {
      const s = scene();
      s.rpc.setMode(OFFICIAL, 'http_500');
      const wire = reshaping(s.rpc.fetch, [PUBLICNODE, DRPC], fault.reshape, BODY_BYTES);
      const snapshot = await s.take({ fetch: wire.fetch, rpcUrls: ROBINHOOD_ENDPOINTS });
      expectFault(wire.sent, fault);
      expect(robinhoodFailures(s.failures)).toEqual([
        { endpoint: 0, kind: 'http', code: 500 },
        { endpoint: 1, kind: 'malformed' },
        { endpoint: 2, kind: 'malformed' },
      ]);
      expect(snapshot).toMatchObject({ open: false, closedReason: 'rpc_unavailable', prices: [] });
    });
  });
}
