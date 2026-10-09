import type { MarketSnapshot, Tick, TokenSymbol, TrustedPrices } from '@prix/contracts';
import { describe, expect, it } from 'vitest';
import { applyHolds } from '../../packages/runtime/src/holds.ts';
import { decisionJson } from '../support/fakes.ts';
import { makeSnapshot, makeTick, TEST_PRICES, utc } from '../support/fixtures.ts';
import { createWorld } from '../support/scheduler.ts';

/**
 * The first price of a new symbol is an anchor, not a trade (security review of section 21): BTC and
 * ETH enter the league in the first round after the deploy with no trusted price and no point in the
 * latest tick. That round they are priced but not fresh: valued, not traded. From the next round the
 * anchor is what the suspect-move check compares with, and the symbol trades if it passes.
 */

const NOW = utc('2026-10-08T15:00:05.000Z');
const TICK = '2026-10-08T15:00Z';
const LATEST = '2026-10-08T14:00Z';
const ETH = 2_468_830_000;
const BTC = 81_628_300_000;
const CRYPTO = new Set(['BTC', 'ETH']);
const STOCKS: Record<string, number> = Object.fromEntries(
  Object.entries(TEST_PRICES).filter(([symbol]) => !CRYPTO.has(symbol)),
);
const WITH_COINS = { ...STOCKS, BTC, ETH };

function trustedStocks(): TrustedPrices {
  const trusted: Record<string, { priceMicro: number; tickId: string }> = {};
  for (const [symbol, price] of Object.entries(STOCKS)) trusted[symbol] = { priceMicro: price, tickId: LATEST };
  return trusted;
}

function latestTick(prices: Record<string, number>, stale: readonly string[] = []): Tick {
  const at = utc('2026-10-08T14:00:05.000Z');
  return makeTick(at, { snapshot: makeSnapshot(at, { prices, stale }) });
}

const run = (snapshot: MarketSnapshot, latest: Tick, establishedSymbols?: ReadonlySet<TokenSymbol>) =>
  applyHolds(
    snapshot,
    { trusted: trustedStocks(), latest, previousTradingDay: '2026-10-07', establishedSymbols },
    [],
    TICK,
    NOW.toISOString(),
    CRYPTO,
  );

const point = (snapshot: MarketSnapshot, symbol: string) => snapshot.prices.find((entry) => entry.symbol === symbol);

describe('a symbol with no trusted price and no point in the latest tick', () => {
  it('enters priced but not fresh, begins no hold and does not close the market', () => {
    const result = run(makeSnapshot(NOW, { prices: WITH_COINS }), latestTick(STOCKS));
    expect(point(result.snapshot, 'BTC')).toMatchObject({ priceMicro: BTC, fresh: false });
    expect(point(result.snapshot, 'ETH')).toMatchObject({ priceMicro: ETH, fresh: false });
    expect(point(result.snapshot, 'AAPL')).toMatchObject({ fresh: true });
    expect(result.newHolds).toEqual([]);
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('is still taken fresh at the first tick of a league, when there is no latest tick at all', () => {
    const result = applyHolds(
      makeSnapshot(NOW, { prices: WITH_COINS }),
      { trusted: {}, latest: null, previousTradingDay: null },
      [],
      TICK,
      NOW.toISOString(),
      CRYPTO,
    );
    expect(point(result.snapshot, 'BTC')).toMatchObject({ priceMicro: BTC, fresh: true });
    expect(result.newHolds).toEqual([]);
  });
});

describe('the round after the anchor', () => {
  const anchored = latestTick(WITH_COINS, ['BTC', 'ETH']);
  const established = new Set(Object.keys(STOCKS));

  it('trades a new symbol whose price is within SUSPECT_MOVE_BPS of its anchor', () => {
    const prices = { ...WITH_COINS, BTC: Math.round(BTC * 1.29) };
    const result = run(makeSnapshot(NOW, { prices }), anchored, established);
    expect(point(result.snapshot, 'BTC')).toMatchObject({ priceMicro: prices.BTC, fresh: true });
    expect(point(result.snapshot, 'ETH')).toMatchObject({ priceMicro: ETH, fresh: true });
    expect(result.newHolds).toEqual([]);
  });

  it('holds a new symbol that moved more than SUSPECT_MOVE_BPS from its anchor, at the anchor', () => {
    const up = Math.round(BTC * 1.31);
    const result = run(makeSnapshot(NOW, { prices: { ...WITH_COINS, BTC: up } }), anchored, established);
    expect(result.newHolds).toMatchObject([{ symbol: 'BTC', priceMicro: BTC, seenPriceMicro: up }]);
    expect(point(result.snapshot, 'BTC')).toMatchObject({ priceMicro: BTC, fresh: false });
  });

  it('still holds an established symbol with no trusted price for review on any change', () => {
    const result = run(
      makeSnapshot(NOW, { prices: { ...WITH_COINS, BTC: BTC + 1 } }),
      anchored,
      new Set([...established, 'BTC']),
    );
    expect(result.newHolds).toMatchObject([{ symbol: 'BTC', priceMicro: BTC, seenPriceMicro: BTC + 1 }]);
  });

  it('treats every symbol as established when the history does not say which are', () => {
    const result = run(makeSnapshot(NOW, { prices: { ...WITH_COINS, BTC: BTC + 1 } }), anchored);
    expect(result.newHolds).toMatchObject([{ symbol: 'BTC', priceMicro: BTC }]);
  });
});

describe('the scheduler when the coins join a running league', () => {
  it('values the coins without trading them in their first round, then trades them', async () => {
    const world = createWorld();
    world.feed.prices = { ...STOCKS };
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ AAPL: 10 }));
    await world.runTick('2026-10-06T15:00:05.000Z');

    // The deploy adds BTC and ETH: their first round is the anchor.
    world.feed.prices = { ...WITH_COINS };
    world.answers.set(1, decisionJson({ AAPL: 10, BTC: 20 }));
    const first = await world.runTick('2026-10-06T16:00:05.000Z');
    expect(first.snapshot.open).toBe(true);
    expect(point(first.snapshot, 'BTC')).toMatchObject({ priceMicro: BTC, fresh: false });
    expect(await world.store.listSymbolHolds()).toEqual([]);
    const anchorRow = world.row(agent, '2026-10-06T16:00Z');
    expect(anchorRow.fills.map((fill) => fill.symbol)).not.toContain('BTC');
    expect(anchorRow.halted).toEqual(expect.arrayContaining(['BTC', 'ETH']));

    // The next round passes the check against the anchor: BTC trades.
    world.feed.prices = { ...WITH_COINS, BTC: Math.round(BTC * 1.05) };
    const second = await world.runTick('2026-10-06T17:00:05.000Z');
    expect(point(second.snapshot, 'BTC')).toMatchObject({ fresh: true });
    expect(await world.store.listSymbolHolds()).toEqual([]);
    expect(world.row(agent, '2026-10-06T17:00Z').fills.map((fill) => fill.symbol)).toContain('BTC');
  });

  it('holds a coin whose second price jumps from its anchor', async () => {
    const world = createWorld();
    world.feed.prices = { ...STOCKS };
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.feed.prices = { ...WITH_COINS };
    await world.runTick('2026-10-06T16:00:05.000Z');
    world.feed.prices = { ...WITH_COINS, ETH: ETH * 2 };
    const second = await world.runTick('2026-10-06T17:00:05.000Z');
    expect(point(second.snapshot, 'ETH')).toMatchObject({ priceMicro: ETH, fresh: false });
    expect(await world.store.listSymbolHolds()).toMatchObject([{ symbol: 'ETH', priceMicro: ETH }]);
  });
});
