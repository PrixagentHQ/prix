import {
  CRYPTO_FEED_STALE_AFTER_SECONDS,
  CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL,
  FEED_STALE_AFTER_SECONDS,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market';
import { describe, expect, it } from 'vitest';
import { TEST_PRICES } from '../support/fixtures.ts';
import { arbitrumReadOf, NOW_SECONDS, pointOf, scene } from './support.ts';

/**
 * Per-symbol staleness, docs/CONTRACTS.md section 23: BTC and ETH 90,000 s, SOL 7,200 s, BNB 21,600 s,
 * HYPE 43,200 s, from `MarketConfig.cryptoStaleAfterSecondsBySymbol`. A crypto feed older than its own
 * value is priced and not fresh, halting that symbol alone. A crypto symbol with no usable value is
 * halted. Ages are measured from the snapshot time.
 */

const LIMITS: [string, number][] = [
  ['BTC', 90_000],
  ['ETH', 90_000],
  ['SOL', 7_200],
  ['BNB', 21_600],
  ['HYPE', 43_200],
];

describe('the staleness table of section 23', () => {
  it('has one value for each crypto symbol, as the operator set them', () => {
    expect(CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL).toEqual(Object.fromEntries(LIMITS));
    expect(CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL.BTC).toBe(CRYPTO_FEED_STALE_AFTER_SECONDS);
  });

  it('covers every crypto symbol of the universe, and no Stock Token', () => {
    const crypto = UNIVERSE.filter((token) => token.kind === 'crypto').map((token) => token.symbol);
    expect([...crypto].sort()).toEqual(Object.keys(CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL).sort());
  });

  it('keeps each new coin well inside its 24 hour heartbeat and above its largest measured gap', () => {
    const gaps: Record<string, number> = { SOL: 4_023, BNB: 9_816, HYPE: 22_601 };
    for (const [symbol, gap] of Object.entries(gaps)) {
      const limit = (CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL as Readonly<Record<string, number>>)[symbol];
      expect(limit, symbol).toBeGreaterThan(gap);
      expect(limit, symbol).toBeLessThan(86_400);
    }
  });
});

describe('a crypto feed is judged by its own staleness', () => {
  for (const [symbol, limit] of LIMITS) {
    it(`${symbol}: fresh at ${limit} s, priced and not fresh at ${limit + 1} s, and the market stays open`, async () => {
      const atLimit = scene();
      atLimit.setFeed(symbol, { updatedAt: NOW_SECONDS - limit });
      const fresh = await atLimit.take();
      expect(pointOf(fresh, symbol)).toMatchObject({ priceMicro: TEST_PRICES[symbol], fresh: true, ageSeconds: limit });

      const past = scene();
      past.setFeed(symbol, { updatedAt: NOW_SECONDS - limit - 1 });
      const stale = await past.take();
      expect(pointOf(stale, symbol)).toMatchObject({ priceMicro: TEST_PRICES[symbol], fresh: false });
      expect(stale).toMatchObject({ open: true, closedReason: null });
      expect(stale.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual([symbol]);
    });
  }

  it('does not judge SOL by the 90,000 s of BTC: an eight hour old SOL is not fresh, an eight hour old BTC is', async () => {
    const s = scene();
    s.setFeed('SOL', { updatedAt: NOW_SECONDS - 8 * 3_600 });
    s.setFeed('BTC', { updatedAt: NOW_SECONDS - 8 * 3_600 });
    const snapshot = await s.take();
    expect(pointOf(snapshot, 'SOL')?.fresh).toBe(false);
    expect(pointOf(snapshot, 'BTC')?.fresh).toBe(true);
  });

  it('a stale coin is a staleness, not an Arbitrum problem', async () => {
    const s = scene();
    s.setFeed('HYPE', { updatedAt: NOW_SECONDS - 50_000 });
    const snapshot = await s.take();
    expect(arbitrumReadOf(snapshot)?.problem).toBeNull();
    expect(pointOf(snapshot, 'SOL')?.fresh).toBe(true);
  });

  it('takes the table it is given, not a constant of its own', async () => {
    const s = scene();
    s.setFeed('BNB', { updatedAt: NOW_SECONDS - 600 });
    const snapshot = await s.take({
      cryptoStaleAfterSecondsBySymbol: { ...CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL, BNB: 599 },
    });
    expect(pointOf(snapshot, 'BNB')?.fresh).toBe(false);
    expect(pointOf(snapshot, 'SOL')?.fresh).toBe(true);
  });

  it('keeps the Stock Tokens on FEED_STALE_AFTER_SECONDS', async () => {
    const s = scene();
    s.setFeed('NVDA', { updatedAt: NOW_SECONDS - FEED_STALE_AFTER_SECONDS });
    const snapshot = await s.take({
      cryptoStaleAfterSecondsBySymbol: { ...CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL, NVDA: 10 },
    });
    expect(pointOf(snapshot, 'NVDA')?.fresh).toBe(true);
  });
});

describe('a crypto symbol without a usable staleness fails closed', () => {
  const unusable: [string, unknown][] = [
    ['missing', undefined],
    ['not a number', Number.NaN],
    ['negative', -1],
    ['a string', '7200'],
  ];

  for (const [label, value] of unusable) {
    it(`SOL ${label}: SOL alone is halted, priced, and the market stays open`, async () => {
      const table: Record<string, unknown> = { ...CRYPTO_FEED_STALE_AFTER_SECONDS_BY_SYMBOL };
      if (value === undefined) delete table.SOL;
      else table.SOL = value;
      const s = scene();
      const snapshot = await s.take({ cryptoStaleAfterSecondsBySymbol: table as Record<string, number> });
      expect(pointOf(snapshot, 'SOL')?.fresh).toBe(false);
      expect(snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual(['SOL']);
      expect(snapshot).toMatchObject({ open: true, closedReason: null });
    });
  }
});
