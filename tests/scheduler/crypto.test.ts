import type { MarketSnapshot, SymbolHold, Tick, TrustedPrices } from '@prix/contracts';
import { MAX_HALTED_FEEDS, SUSPECT_MOVE_BPS } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyHolds } from '../../packages/runtime/src/holds.ts';
import { decisionJson } from '../support/fakes.ts';
import { makeSnapshot, makeTick, TEST_PRICES, utc } from '../support/fixtures.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, expectReplayMatches } from '../support/scheduler.ts';

/**
 * Crypto assets in the universe, docs/CONTRACTS.md section 21, rule 3: a crypto feed that is stale,
 * invalid or unread halts its own symbol and nothing else. A symbol with no readable price is valued
 * at its last trusted price before the tick is stored; with none, it holds no position to value.
 * SUSPECT_MOVE_BPS applies to crypto as to stocks, and a crypto hold never closes the market.
 */

const NOW = utc('2026-10-08T15:00:05.000Z');
const TICK = '2026-10-08T15:00Z';
const YESTERDAY = '2026-10-07T19:00Z';
const ETH = 2_468_830_000;
const BTC = 81_628_300_000;
const CRYPTO = new Set(['BTC', 'ETH']);
const WITH_COINS = { ...TEST_PRICES, BTC, ETH };

function market(prices: Record<string, number> = {}, stale: readonly string[] = []): MarketSnapshot {
  return makeSnapshot(NOW, { prices: { ...WITH_COINS, ...prices }, stale });
}

function latest(prices: Record<string, number> = {}): Tick {
  const at = utc('2026-10-07T19:00:05.000Z');
  return makeTick(at, { snapshot: makeSnapshot(at, { prices: { ...WITH_COINS, ...prices } }) });
}

function trustedAt(tickId: string, drop: readonly string[] = []): TrustedPrices {
  const trusted: Record<string, { priceMicro: number; tickId: string }> = {};
  for (const [symbol, price] of Object.entries(WITH_COINS)) {
    if (!drop.includes(symbol)) trusted[symbol] = { priceMicro: price, tickId };
  }
  return trusted;
}

const run = (snapshot: MarketSnapshot, trusted: TrustedPrices, last: Tick | null, holds: SymbolHold[] = []) =>
  applyHolds(
    snapshot,
    { trusted, latest: last, previousTradingDay: last === null ? null : '2026-10-07' },
    holds,
    TICK,
    NOW.toISOString(),
    CRYPTO,
  );

const point = (snapshot: MarketSnapshot, symbol: string) => snapshot.prices.find((entry) => entry.symbol === symbol);

describe('a crypto symbol with no readable price', () => {
  it('is valued at its last trusted price, not fresh, and begins no hold', () => {
    const result = run(market({ ETH: 0 }, ['ETH']), trustedAt(YESTERDAY), latest());
    expect(point(result.snapshot, 'ETH')).toMatchObject({ priceMicro: ETH, fresh: false });
    expect(result.newHolds).toEqual([]);
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
    expect(result.snapshot.prices.every((entry) => entry.priceMicro > 0)).toBe(true);
  });

  it('takes the latest tick price when the lookback has no trusted price for it', () => {
    const result = run(market({ ETH: 0 }, ['ETH']), trustedAt(YESTERDAY, ['ETH']), latest({ ETH: ETH + 5 }));
    expect(point(result.snapshot, 'ETH')).toMatchObject({ priceMicro: ETH + 5, fresh: false });
    expect(result.newHolds).toEqual([]);
  });

  it('is left out of the stored snapshot when no tick ever priced it, so nobody can hold or target it', () => {
    const result = run(market({ ETH: 0 }, ['ETH']), {}, null);
    expect(point(result.snapshot, 'ETH')).toBeUndefined();
    expect(point(result.snapshot, 'BTC')).toMatchObject({ priceMicro: BTC, fresh: true });
    expect(result.snapshot.prices).toHaveLength(Object.keys(WITH_COINS).length - 1);
    expect(result.snapshot.open).toBe(true);
  });
});

describe('holds on crypto', () => {
  it('holds a crypto move of more than SUSPECT_MOVE_BPS, as for a stock', () => {
    expect(SUSPECT_MOVE_BPS).toBe(3_000);
    const up = Math.round(ETH * 1.31);
    const result = run(market({ ETH: up }), trustedAt(YESTERDAY), latest());
    expect(result.newHolds).toMatchObject([{ symbol: 'ETH', priceMicro: ETH, seenPriceMicro: up }]);
    expect(point(result.snapshot, 'ETH')).toMatchObject({ priceMicro: ETH, fresh: false });
    const through = run(market({ ETH: Math.round(ETH * 1.29) }), trustedAt(YESTERDAY), latest());
    expect(through.newHolds).toEqual([]);
  });

  it('never closes the market for crypto holds: only Stock Token halts count against MAX_HALTED_FEEDS', () => {
    expect(MAX_HALTED_FEEDS).toBe(2);
    // Two stale Stock Tokens, and both coins jump: four halted symbols, two of them Stock Tokens.
    const snapshot = market({ ETH: ETH * 2, BTC: BTC * 2 }, ['AAPL', 'MSFT']);
    const result = run(snapshot, trustedAt(YESTERDAY), latest());
    expect(result.newHolds.map((hold) => hold.symbol).sort()).toEqual(['BTC', 'ETH']);
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('still closes the market when the held symbols push the Stock Token halts over MAX_HALTED_FEEDS', () => {
    const snapshot = market({ NVDA: (TEST_PRICES.NVDA as number) * 2 }, ['AAPL', 'MSFT']);
    const result = run(snapshot, trustedAt(YESTERDAY), latest());
    expect(result.snapshot).toMatchObject({ open: false, closedReason: 'held_for_review' });
  });
});

describe('the scheduler with an unread crypto feed', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
    world.feed.prices = { ...WITH_COINS };
  });

  it('stores the tick with the coin at its last trusted price and values the holder without an error', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ ETH: 20 }));
    await world.runTick('2026-10-06T15:00:05.000Z');
    const before = world.row(agent, '2026-10-06T15:00Z');
    expect(before.fills.map((fill) => fill.symbol)).toEqual(['ETH']);

    // The ETH feed cannot be read: the market halts ETH alone, with no price.
    world.feed.prices = { ...WITH_COINS, ETH: 0 };
    world.feed.options = { stale: ['ETH'] };
    world.answers.set(1, decisionJson({ ETH: 40 }));
    const tick = await world.runTick('2026-10-06T16:00:05.000Z');

    expect(tick.snapshot.open).toBe(true);
    expect(point(tick.snapshot, 'ETH')).toMatchObject({ priceMicro: ETH, fresh: false });
    expect(await world.store.listSymbolHolds()).toEqual([]);
    const row = world.row(agent, '2026-10-06T16:00Z');
    expect(row).toMatchObject({ status: 'decided', fills: [], halted: ['ETH'] });
    expect(row.portfolio).toEqual(before.portfolio);
    expect(row.equityMicro).toBe(before.equityMicro);
    await expectReplayMatches(world, agent);
  });
});
