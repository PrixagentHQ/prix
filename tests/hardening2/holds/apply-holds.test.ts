import type { MarketSnapshot, SymbolHold, Tick, TrustedPrices } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { applyHolds } from '../../../packages/runtime/src/holds.ts';
import { makeSnapshot, makeTick, TEST_PRICES, utc } from '../../support/fixtures.ts';

/**
 * `applyHolds` alone (packages/runtime/src/holds.ts), by docs/CONTRACTS.md section 20: every new
 * point is compared with the last trusted price of its symbol, and a symbol whose last trusted
 * price is older than the previous trading day, or that has none while the league has a history,
 * is held for review when its price changed.
 */

const NOW = utc('2026-10-08T15:00:05.000Z');
const TICK = '2026-10-08T15:00Z';
const P = TEST_PRICES.NVDA as number;

function market(prices: Record<string, number> = {}, stale: readonly string[] = []): MarketSnapshot {
  return makeSnapshot(NOW, { prices: { ...TEST_PRICES, ...prices }, stale });
}

/** The latest tick: yesterday 19:00, every symbol at TEST_PRICES unless said otherwise. */
function latest(stale: readonly string[] = [], prices: Record<string, number> = {}): Tick {
  const at = utc('2026-10-07T19:00:05.000Z');
  return makeTick(at, { snapshot: makeSnapshot(at, { prices: { ...TEST_PRICES, ...prices }, stale }) });
}

/** Every symbol trusted at TEST_PRICES at the given tick. */
function trustedAt(
  tickId: string,
  change: Partial<Record<string, { priceMicro: number; tickId: string } | null>> = {},
) {
  const trusted: Record<string, { priceMicro: number; tickId: string }> = {};
  for (const [symbol, price] of Object.entries(TEST_PRICES)) trusted[symbol] = { priceMicro: price, tickId };
  for (const [symbol, value] of Object.entries(change)) {
    if (value === null || value === undefined) delete trusted[symbol];
    else trusted[symbol] = value;
  }
  return trusted as TrustedPrices;
}

/** The tick under test is 2026-10-08T15:00Z; the latest tick, when there is one, is of the day before. */
const run = (snapshot: MarketSnapshot, trusted: TrustedPrices, last: Tick | null, holds: SymbolHold[] = []) =>
  applyHolds(
    snapshot,
    { trusted, latest: last, previousTradingDay: last === null ? null : '2026-10-07' },
    holds,
    TICK,
    NOW.toISOString(),
  );

const point = (snapshot: MarketSnapshot, symbol: string) => snapshot.prices.find((entry) => entry.symbol === symbol);

describe('applyHolds with the last trusted prices', () => {
  it('compares with the trusted price, not with the stale point of the latest tick', () => {
    const result = run(market({ NVDA: P * 10 }), trustedAt('2026-10-07T18:00Z'), latest(['NVDA']));
    expect(result.newHolds).toMatchObject([
      { symbol: 'NVDA', priceMicro: P, seenPriceMicro: P * 10, sinceTickId: TICK },
    ]);
    expect(point(result.snapshot, 'NVDA')).toMatchObject({ priceMicro: P, fresh: false });
  });

  it('compares a point that is not fresh in the new snapshot too', () => {
    const result = run(market({ NVDA: P * 2 }, ['NVDA']), trustedAt('2026-10-07T19:00Z'), latest());
    expect(result.newHolds.map((hold) => hold.symbol)).toEqual(['NVDA']);
    expect(point(result.snapshot, 'NVDA')).toMatchObject({ priceMicro: P, fresh: false });
  });

  it('lets a move within the limit through', () => {
    const result = run(market({ NVDA: Math.round(P * 1.29) }), trustedAt('2026-10-07T19:00Z'), latest());
    expect(result.newHolds).toEqual([]);
    expect(point(result.snapshot, 'NVDA')).toMatchObject({ priceMicro: Math.round(P * 1.29), fresh: true });
  });

  it('holds a changed price whose trusted price is older than the previous trading day', () => {
    const trusted = trustedAt('2026-10-07T19:00Z', { NVDA: { priceMicro: P, tickId: '2026-10-06T19:00Z' } });
    const result = run(market({ NVDA: P + 1 }), trusted, latest(['NVDA']));
    expect(result.newHolds).toMatchObject([{ symbol: 'NVDA', priceMicro: P, seenPriceMicro: P + 1 }]);
  });

  it('uses the previous trading day it is given, which the trusted prices alone cannot show', () => {
    // Today's 15:00 exists and every symbol but NVDA was fresh in it; the tick under test is 16:00.
    // NVDA was last fresh two trading days ago. Nothing in the trusted prices is from yesterday.
    const today = makeTick(utc('2026-10-08T15:00:05.000Z'), {
      snapshot: makeSnapshot(utc('2026-10-08T15:00:05.000Z'), { stale: ['NVDA'] }),
    });
    const trusted = trustedAt('2026-10-08T15:00Z', { NVDA: { priceMicro: P, tickId: '2026-10-06T17:00Z' } });
    const snapshot = makeSnapshot(utc('2026-10-08T16:00:05.000Z'), { prices: { ...TEST_PRICES, NVDA: P + 1 } });
    const at = (previousTradingDay: string) =>
      applyHolds(
        snapshot,
        { trusted, latest: today, previousTradingDay },
        [],
        '2026-10-08T16:00Z',
        '2026-10-08T16:00:05.000Z',
      );
    expect(at('2026-10-07').newHolds.map((hold) => hold.symbol)).toEqual(['NVDA']);
    // Had the market been shut on 2026-10-07, the same trusted price is from the previous trading day.
    expect(at('2026-10-06').newHolds).toEqual([]);
  });

  it('holds a changed price that has no trusted price while the league has a history, at the price of the latest tick', () => {
    const result = run(market({ NVDA: P * 3 }), trustedAt('2026-10-07T19:00Z', { NVDA: null }), latest(['NVDA']));
    expect(result.newHolds).toMatchObject([{ symbol: 'NVDA', priceMicro: P, seenPriceMicro: P * 3 }]);
  });

  it('holds nothing at the first tick of a league', () => {
    const result = run(market({ NVDA: 1_000_000 }), {}, null);
    expect(result.newHolds).toEqual([]);
    expect(result.snapshot.prices.every((entry) => entry.fresh)).toBe(true);
  });

  it('closes the market with held_for_review when more than two symbols are halted', () => {
    const trusted = trustedAt('2026-10-07T19:00Z');
    const result = run(market({ NVDA: P * 2, AAPL: 1, TSLA: 1 }), trusted, latest());
    expect(result.newHolds).toHaveLength(3);
    expect(result.snapshot).toMatchObject({ open: false, closedReason: 'held_for_review' });
  });

  it('takes a released symbol without a comparison, and keeps an active hold at its price', () => {
    const holds: SymbolHold[] = [
      {
        symbol: 'NVDA',
        priceMicro: P,
        seenPriceMicro: P * 2,
        sinceTickId: '2026-10-07T15:00Z',
        releasedAt: '2026-10-07T20:00:00.000Z',
        createdAt: '2026-10-07T15:00:05.000Z',
      },
      {
        symbol: 'AAPL',
        priceMicro: 1_000_000,
        seenPriceMicro: 2_000_000,
        sinceTickId: '2026-10-07T15:00Z',
        releasedAt: null,
        createdAt: '2026-10-07T15:00:05.000Z',
      },
    ];
    const result = run(market({ NVDA: P * 2 }), trustedAt('2026-10-06T19:00Z'), latest(), holds);
    expect(result.released).toEqual(['NVDA']);
    expect(result.newHolds).toEqual([]);
    expect(point(result.snapshot, 'NVDA')).toMatchObject({ priceMicro: P * 2, fresh: true });
    expect(point(result.snapshot, 'AAPL')).toMatchObject({ priceMicro: 1_000_000, fresh: false });
  });
});
