import type { MarketSnapshot } from '@prix/contracts';
import {
  ARBITRUM_CHAIN_ID,
  MARKET_QUIET_AFTER_SECONDS,
  marketSnapshotSchema,
  otherChainReadSchema,
} from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { ARB_OFFICIAL, ARB_PAIR_TWO, ARBITRUM_FEEDS, type FakeArbitrum } from '../support/fake-arbitrum.ts';
import { TEST_PRICES } from '../support/fixtures.ts';
import {
  answerOf,
  arbitrumReadOf,
  isUnread,
  NOW_SECONDS,
  pointOf,
  ROBINHOOD_SYMBOLS,
  robinhoodPoints,
  scene,
} from './support.ts';

/**
 * docs/CONTRACTS.md section 23, rules 6 to 8 and 10: an Arbitrum problem makes only SOL, BNB and
 * HYPE unread for the tick. It never closes the market, never changes `open` or `closedReason`, and
 * never touches a Stock Token, ETH or BTC. Every snapshot that has prices carries `otherChains`, one
 * entry for Arbitrum One; a closed snapshot with no prices leaves it out.
 */

const ARBITRUM_SYMBOLS = ['BNB', 'HYPE', 'SOL'] as const;

type Break = (arbitrum: FakeArbitrum) => void;

const PROBLEMS: [string, Break][] = [
  ['rpc_unavailable', (a) => a.set({ mode: 'network_error' })],
  [
    'unconfirmed',
    (a) => {
      a.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
      a.setEndpoint(ARB_PAIR_TWO, { mode: 'http_429' });
    },
  ],
  [
    'disagreed',
    (a) => {
      a.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
      a.patchFeedAt(ARB_PAIR_TWO, ARBITRUM_FEEDS.BNB, { answer: answerOf(TEST_PRICES.BNB as number) * 2n });
    },
  ],
  ['sequencer_down', (a) => a.set({ sequencer: { answer: 1n, startedAt: BigInt(NOW_SECONDS - 60) } })],
  ['sequencer_grace', (a) => a.set({ sequencer: { answer: 0n, startedAt: BigInt(NOW_SECONDS - 60) } })],
  ['sequencer_unknown', (a) => a.set({ sequencer: 'reverts' })],
];

/** The Robinhood market states the suite crosses with every Arbitrum problem. */
const ROBINHOOD_STATES: [string, (s: ReturnType<typeof scene>) => void, Partial<MarketSnapshot>][] = [
  ['open', () => {}, { open: true, closedReason: null }],
  [
    'closed for a weekend (feeds_stale)',
    (s) => {
      for (const symbol of ROBINHOOD_SYMBOLS) {
        if (symbol !== 'BTC' && symbol !== 'ETH') s.setFeed(symbol, { updatedAt: NOW_SECONDS - 40 * 3_600 });
      }
    },
    { open: false, closedReason: 'feeds_stale' },
  ],
  ['closed with feed_invalid', (s) => s.setFeed('NVDA', { answer: 0n }), { open: false, closedReason: 'feed_invalid' }],
];

describe('an Arbitrum problem never closes the market', () => {
  for (const [state, prepare, expected] of ROBINHOOD_STATES) {
    for (const [problem, breakIt] of PROBLEMS) {
      it(`${problem}, with the market ${state}: only SOL, BNB and HYPE are unread`, async () => {
        const healthy = scene();
        prepare(healthy);
        const before = await healthy.take();

        const s = scene();
        prepare(s);
        breakIt(s.rpc.arbitrum);
        const snapshot = await s.take();

        expect(marketSnapshotSchema.safeParse(snapshot).success).toBe(true);
        expect(snapshot).toMatchObject(expected);
        expect({ open: snapshot.open, closedReason: snapshot.closedReason }).toEqual({
          open: before.open,
          closedReason: before.closedReason,
        });
        // Every Stock Token, BTC and ETH exactly as with a healthy Arbitrum.
        expect(robinhoodPoints(snapshot)).toEqual(robinhoodPoints(before));
        expect(snapshot.blockNumber).toBe(before.blockNumber);
        for (const symbol of ARBITRUM_SYMBOLS) expect(isUnread(pointOf(snapshot, symbol)), symbol).toBe(true);
        expect(arbitrumReadOf(snapshot)?.problem).toBe(problem);
      });
    }
  }

  it('keeps the coins in the snapshot, in universe order, when they are unread', async () => {
    const s = scene();
    s.rpc.arbitrum.set({ mode: 'http_500' });
    const snapshot = await s.take();
    expect(snapshot.prices.map((point) => point.symbol).slice(-5)).toEqual(['BTC', 'ETH', 'BNB', 'HYPE', 'SOL']);
    expect(snapshot.prices).toHaveLength(25);
  });

  it('does not count unread coins against MAX_HALTED_FEEDS, with two Stock Tokens halted beside them', async () => {
    const s = scene();
    s.setFeed('AAPL', { updatedAt: NOW_SECONDS - 100_000 });
    s.setFeed('MSFT', { updatedAt: NOW_SECONDS - 100_000 });
    s.setFeed('BTC', { reverts: true });
    s.rpc.arbitrum.set({ mode: 'network_error' });
    const snapshot = await s.take();
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
    expect(snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual([
      'AAPL',
      'MSFT',
      'BTC',
      'BNB',
      'HYPE',
      'SOL',
    ]);
  });

  it('never opens a market that the Stock Tokens close, however fresh the coins are', async () => {
    const s = scene();
    for (const symbol of ROBINHOOD_SYMBOLS) {
      if (symbol !== 'BTC' && symbol !== 'ETH')
        s.setFeed(symbol, { updatedAt: NOW_SECONDS - MARKET_QUIET_AFTER_SECONDS - 1 });
    }
    for (const symbol of ARBITRUM_SYMBOLS) s.setFeed(symbol, { updatedAt: NOW_SECONDS - 1 });
    const snapshot = await s.take();
    expect(snapshot).toMatchObject({ open: false, closedReason: 'feeds_stale' });
    expect(pointOf(snapshot, 'SOL')).toMatchObject({ priceMicro: TEST_PRICES.SOL, fresh: true });
  });
});

describe('a trusted Arbitrum read is judged feed by feed', () => {
  it('unreads one invalid coin and keeps the other two', async () => {
    const s = scene();
    s.setFeed('SOL', { answer: 0n });
    const snapshot = await s.take();
    expect(arbitrumReadOf(snapshot)?.problem).toBeNull();
    expect(isUnread(pointOf(snapshot, 'SOL'))).toBe(true);
    expect(pointOf(snapshot, 'BNB')).toMatchObject({ priceMicro: TEST_PRICES.BNB, fresh: true });
    expect(pointOf(snapshot, 'HYPE')).toMatchObject({ priceMicro: TEST_PRICES.HYPE, fresh: true });
    expect(snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('unreads a coin whose feed reverts, or whose update is in the future, or zero', async () => {
    for (const patch of [{ reverts: true }, { updatedAt: NOW_SECONDS + 600 }, { updatedAt: 0 }, { answer: -5n }]) {
      const s = scene();
      s.setFeed('HYPE', patch);
      const snapshot = await s.take();
      expect(
        isUnread(pointOf(snapshot, 'HYPE')),
        JSON.stringify(patch, (_k, v) => String(v)),
      ).toBe(true);
      expect(snapshot.open).toBe(true);
    }
  });

  it('converts each answer by the formula of section 5', async () => {
    const s = scene();
    s.setFeed('SOL', { answer: 15_288_123_450n });
    const snapshot = await s.take();
    // 152.8812345 USD rounds half up to 152.881235.
    expect(pointOf(snapshot, 'SOL')?.priceMicro).toBe(152_881_235);
  });
});

describe('otherChains', () => {
  it('is on every snapshot that has prices, open or closed, with exactly one entry for Arbitrum One', async () => {
    for (const [state, prepare] of ROBINHOOD_STATES) {
      for (const [problem, breakIt] of [['none', () => {}] as [string, Break], ...PROBLEMS]) {
        const s = scene();
        prepare(s);
        breakIt(s.rpc.arbitrum);
        const snapshot = await s.take();
        const label = `${state} / ${problem}`;
        expect(snapshot.prices.length, label).toBeGreaterThan(0);
        expect(snapshot.otherChains, label).toHaveLength(1);
        expect(snapshot.otherChains?.[0]?.chainId, label).toBe(ARBITRUM_CHAIN_ID);
        expect(otherChainReadSchema.safeParse(snapshot.otherChains?.[0]).success, label).toBe(true);
      }
    }
  });

  it('is left out of a closed snapshot with no prices', async () => {
    const s = scene();
    s.rpc.setMode('https://rpc-keyed.test/v2/secret-key', 'network_error');
    const snapshot = await s.take();
    expect(snapshot).toMatchObject({ open: false, closedReason: 'rpc_unavailable', prices: [] });
    expect(snapshot.otherChains).toBeUndefined();
  });

  it('says the official endpoint alone for a read it took', async () => {
    const snapshot = await scene().take();
    expect(snapshot.otherChains?.[0]).toMatchObject({ endpoint: 0, confirmedBy: null, problem: null });
  });

  it('names endpoints by position only, never by URL', async () => {
    const s = scene();
    s.rpc.arbitrum.setEndpoint(ARB_OFFICIAL, { mode: 'http_500' });
    const snapshot = await s.take();
    const text = JSON.stringify(snapshot);
    for (const piece of ['https:', '.test', 'arbitrum.io', 'publicnode', 'drpc']) expect(text).not.toContain(piece);
  });
});
