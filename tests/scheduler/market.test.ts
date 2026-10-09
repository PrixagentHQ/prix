import type { MarketClosedReason } from '@prix/contracts';
import { SUSPECT_MOVE_BPS, symbolHoldSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { decisionJson } from '../support/fakes.ts';
import type { SnapshotOptions } from '../support/fixtures.ts';
import { SEASON_1, startingStats, TEST_PRICES, TEST_SYMBOLS } from '../support/fixtures.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, expectReplayMatches } from '../support/scheduler.ts';

/**
 * Acceptance, docs/SPEC.md section 8: "With the feed stale, no paper trade fills and the
 * site says the market is closed." And the guard of docs/CONTRACTS.md section 5 against
 * stock splits: a price that jumps is held for review and not traded.
 */

const T13 = '2026-10-06T15:00Z';
const T14 = '2026-10-06T16:00Z';
const T15 = '2026-10-06T17:00Z';
const T16 = '2026-10-06T18:00Z';

describe('a closed market has no tick and no fill', () => {
  let world: World;
  beforeEach(async () => {
    world = createWorld();
    await world.addPro(1);
    await world.addOpen(11);
  });

  const closed: [string, SnapshotOptions, MarketClosedReason][] = [
    ['every feed is stale, as on a night or a weekend', { stale: [...TEST_SYMBOLS] }, 'feeds_stale'],
    ['three feeds are stale', { stale: ['AAPL', 'MSFT', 'NVDA'] }, 'feeds_stale'],
    ['the RPC does not answer', { rpcDown: true }, 'rpc_unavailable'],
    ['a feed answer cannot be trusted', { invalid: true }, 'feed_invalid'],
  ];

  it.each(closed)('when %s', async (_name, options, reason) => {
    world.feed.options = options;
    const reports = await world.run('2026-10-06T15:00:05.000Z', '2026-10-06T15:59:05.000Z');

    expect(reports[0]).toMatchObject({ action: 'market_closed', decided: 0, noDecision: 0, skipped: 0 });
    expect(reports.every((report) => report.action === 'market_closed' || report.action === 'idle')).toBe(true);
    expect(world.store.ticks.size).toBe(0);
    expect(world.store.decisions.size).toBe(0);
    expect(world.decisionCalls).toHaveLength(0);
    // Nothing moved in any portfolio.
    for (const row of world.store.portfolios.values()) {
      expect(row.portfolio).toEqual({ cashMicro: 10_000_000_000, holdings: {} });
      expect(row.stats.tradingDays).toBe(0);
    }
    // The site can say that the market is closed, and why.
    const status = await world.store.getMarketStatus();
    expect(status).toMatchObject({ open: false, closedReason: reason, lastTickId: null });
    expect(status?.checkedAt.slice(0, 13)).toBe('2026-10-06T15');
  });

  it('only checks the market in the first minutes of an hour', async () => {
    world.feed.options = { stale: [...TEST_SYMBOLS] };
    await world.run('2026-10-06T15:00:05.000Z', '2026-10-06T15:59:05.000Z');
    // Ten minutes of the creation window, one snapshot a minute at most.
    expect(world.market.calls.length).toBeGreaterThan(0);
    expect(world.market.calls.length).toBeLessThanOrEqual(10);
    expect(world.market.calls.every((at) => Number(at.slice(14, 16)) < 10)).toBe(true);
  });

  it('creates the tick when the market opens within the first minutes of the hour', async () => {
    world.feed.options = { stale: [...TEST_SYMBOLS] };
    expect((await world.step('2026-10-06T15:00:05.000Z')).action).toBe('market_closed');
    expect((await world.step('2026-10-06T15:01:05.000Z')).action).toBe('market_closed');
    world.feed.options = {};
    expect(await world.step('2026-10-06T15:02:05.000Z')).toMatchObject({ action: 'tick_created', tickId: T13 });
    expect(await world.store.getMarketStatus()).toMatchObject({ open: true, closedReason: null });
  });

  it('creates no tick when the market opens after the first minutes of the hour', async () => {
    world.feed.options = { stale: [...TEST_SYMBOLS] };
    await world.run('2026-10-06T15:00:05.000Z', '2026-10-06T15:09:05.000Z');
    world.feed.options = {};
    const late = await world.run('2026-10-06T15:10:05.000Z', '2026-10-06T15:59:05.000Z');
    expect(late.every((report) => report.action === 'idle')).toBe(true);
    expect(world.store.ticks.size).toBe(0);
    // The next hour has its tick.
    expect((await world.step('2026-10-06T16:00:05.000Z')).action).toBe('tick_created');
  });

  it('keeps the last tick in the market status when the market closes after a trading hour', async () => {
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.feed.options = { stale: [...TEST_SYMBOLS] };
    await world.step('2026-10-06T16:00:05.000Z');
    expect(await world.store.getMarketStatus()).toMatchObject({
      open: false,
      closedReason: 'feeds_stale',
      lastTickId: T13,
    });
    expect(world.store.ticks.size).toBe(1);
  });

  it('creates no tick outside the hours 15 to 19 UTC, even with an open market', async () => {
    for (const at of [
      '2026-10-06T00:00:05.000Z',
      '2026-10-06T14:00:05.000Z',
      '2026-10-06T14:59:59.000Z',
      '2026-10-06T20:00:05.000Z',
      '2026-10-06T22:00:05.000Z',
      '2026-10-06T23:30:00.000Z',
    ]) {
      expect((await world.step(at)).action).toBe('idle');
    }
    expect(world.store.ticks.size).toBe(0);
    expect(world.market.calls).toHaveLength(0);
  });

  it('creates no tick when no season is active', async () => {
    const before = await world.step('2026-10-04T15:00:05.000Z');
    const after = await world.step('2026-11-02T15:00:05.000Z');
    expect([before.action, after.action]).toEqual(['idle', 'idle']);
    expect(world.store.ticks.size).toBe(0);
  });
});

describe('a stale feed halts its symbol', () => {
  let world: World;
  beforeEach(() => {
    world = createWorld();
  });

  it('opens the market with two stale feeds and never fills those two symbols', async () => {
    world.feed.options = { stale: ['NVDA', 'TSLA'] };
    const buyer = await world.addOpen(1);
    const holder = await world.addOpen(2, {
      portfolio: { cashMicro: 5_000_000_000, holdings: { NVDA: 10_000_000, AAPL: 5_000_000 } },
    });
    world.answers.set(1, decisionJson({ NVDA: 40, TSLA: 20, MSFT: 20 }));
    world.answers.set(2, decisionJson({}));

    const tick = await world.runTick('2026-10-06T15:00:05.000Z');
    expect(tick.snapshot.prices.filter((point) => !point.fresh).map((point) => point.symbol)).toEqual(['NVDA', 'TSLA']);

    // A target for a halted symbol is accepted: the decision stands, and only MSFT trades.
    const bought = world.row(buyer, T13);
    expect(bought).toMatchObject({
      status: 'decided',
      code: null,
      targetsBps: { NVDA: 4_000, TSLA: 2_000, MSFT: 2_000 },
    });
    expect([...bought.halted].sort()).toEqual(['NVDA', 'TSLA']);
    expect(bought.fills.map((fill) => fill.symbol)).toEqual(['MSFT']);
    expect(Object.keys(bought.portfolio.holdings)).toEqual(['MSFT']);

    // Empty targets sell everything that is not halted. The halted holding stays and is valued.
    const held = world.row(holder, T13);
    expect(held.fills.map((fill) => [fill.symbol, fill.side])).toEqual([['AAPL', 'sell']]);
    expect(held.portfolio.holdings).toEqual({ NVDA: 10_000_000 });
    expect([...held.halted].sort()).toEqual(['NVDA', 'TSLA']);
    // 10 NVDA at 182.41 are still counted in the equity.
    expect(held.equityMicro).toBeGreaterThan(held.portfolio.cashMicro + 1_824_000_000);

    expect((await world.store.getMarketStatus())?.halted.sort()).toEqual(['NVDA', 'TSLA']);
    await expectReplayMatches(world, buyer);
    await expectReplayMatches(world, holder, {
      portfolio: { cashMicro: 5_000_000_000, holdings: { NVDA: 10_000_000, AAPL: 5_000_000 } },
      stats: startingStats(),
    });
  });

  it('tells the model which symbols are halted', async () => {
    world.feed.options = { stale: ['NVDA'] };
    await world.addOpen(1);
    await world.runTick('2026-10-06T15:00:05.000Z');
    const user = world.decisionCalls[0]?.request.messages.find((message) => message.role === 'user');
    expect(JSON.parse(user?.content ?? '{}').halted).toEqual(['NVDA']);
  });
});

describe('a price that jumps is held for review', () => {
  let world: World;
  const P = TEST_PRICES.NVDA as number;

  beforeEach(() => {
    world = createWorld();
    expect(SUSPECT_MOVE_BPS).toBe(3_000);
  });

  it('holds a symbol whose price halves, keeps the trusted price and does not trade it', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ NVDA: 20 }));
    await world.runTick('2026-10-06T15:00:05.000Z');
    const before = world.row(agent, T13);
    expect(before.fills.map((fill) => fill.symbol)).toEqual(['NVDA']);
    expect(await world.store.listSymbolHolds()).toEqual([]);

    // A two-for-one split: the feed now reports half the price.
    world.feed.prices = { ...TEST_PRICES, NVDA: P / 2 };
    world.answers.set(1, decisionJson({ NVDA: 40 }));
    const tick = await world.runTick('2026-10-06T16:00:05.000Z');

    const holds = await world.store.listSymbolHolds();
    expect(holds).toHaveLength(1);
    expect(symbolHoldSchema.safeParse(holds[0]).success).toBe(true);
    expect(holds[0]).toMatchObject({ symbol: 'NVDA', priceMicro: P, seenPriceMicro: P / 2, sinceTickId: T14 });

    // The stored snapshot carries the trusted price and marks the symbol as not fresh.
    const point = tick.snapshot.prices.find((entry) => entry.symbol === 'NVDA');
    expect(point).toMatchObject({ priceMicro: P, fresh: false });
    expect(tick.snapshot.prices.filter((entry) => !entry.fresh).map((entry) => entry.symbol)).toEqual(['NVDA']);
    expect(tick.snapshot.open).toBe(true);

    // The agent asked for more NVDA. Nothing trades, and its value does not halve.
    const row = world.row(agent, T14);
    expect(row).toMatchObject({ status: 'decided', fills: [], costMicro: 0, halted: ['NVDA'] });
    expect(row.portfolio).toEqual(before.portfolio);
    expect(row.equityMicro).toBe(before.equityMicro);
    expect((await world.store.getMarketStatus())?.halted).toEqual(['NVDA']);
    await expectReplayMatches(world, agent);
  });

  it('keeps the hold, with the first trusted price, at the following ticks', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ NVDA: 20 }));
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.feed.prices = { ...TEST_PRICES, NVDA: P / 2 };
    await world.runTick('2026-10-06T16:00:05.000Z');
    world.feed.prices = { ...TEST_PRICES, NVDA: Math.round(P * 0.52) };
    const tick = await world.runTick('2026-10-06T17:00:05.000Z');

    expect(await world.store.listSymbolHolds()).toHaveLength(1);
    expect((await world.store.listSymbolHolds())[0]).toMatchObject({
      priceMicro: P,
      seenPriceMicro: P / 2,
      sinceTickId: T14,
    });
    expect(tick.snapshot.prices.find((entry) => entry.symbol === 'NVDA')).toMatchObject({
      priceMicro: P,
      fresh: false,
    });
    expect(world.row(agent, T15).fills).toEqual([]);
    expect(world.row(agent, T15).equityMicro).toBe(world.row(agent, T13).equityMicro);
  });

  it('uses the price of the feed again from the next tick after an admin releases the hold', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ NVDA: 20 }));
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.feed.prices = { ...TEST_PRICES, NVDA: P / 2 };
    await world.runTick('2026-10-06T16:00:05.000Z');
    await world.runTick('2026-10-06T17:00:05.000Z');

    // What POST /api/admin/holds/NVDA/release does: it marks the hold released. It does not delete it.
    expect(await world.store.releaseSymbolHold('NVDA', '2026-10-06T17:30:00.000Z')).toBe(true);
    expect((await world.store.listSymbolHolds())[0]).toMatchObject({
      symbol: 'NVDA',
      releasedAt: '2026-10-06T17:30:00.000Z',
    });
    // At the next tick the scheduler takes the feed's price without comparing it, then deletes the row.
    const tick = await world.runTick('2026-10-06T18:00:05.000Z');
    expect(tick.snapshot.prices.find((entry) => entry.symbol === 'NVDA')).toMatchObject({
      priceMicro: P / 2,
      fresh: true,
    });
    expect(await world.store.listSymbolHolds()).toEqual([]);
    // Now the new price counts: the holding is worth half and the agent trades again.
    const row = world.row(agent, T16);
    expect(row.halted).toEqual([]);
    expect(row.equityMicro).toBeLessThan(world.row(agent, T15).equityMicro);
    expect(row.fills.map((fill) => [fill.symbol, fill.side])).toEqual([['NVDA', 'buy']]);
    await expectReplayMatches(world, agent);
  });

  it('does not re-create a released hold at the tick after, when the price stays where the feed has it', async () => {
    await world.addPro(1);
    world.answers.set(1, decisionJson({ NVDA: 20 }));
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.feed.prices = { ...TEST_PRICES, NVDA: P / 2 };
    await world.runTick('2026-10-06T16:00:05.000Z');
    expect(await world.store.listSymbolHolds()).toHaveLength(1);
    await world.store.releaseSymbolHold('NVDA', '2026-10-06T16:30:00.000Z');
    // The release tick: a move of 50% against the latest tick is taken, because the hold was released.
    const released = await world.runTick('2026-10-06T17:00:05.000Z');
    expect(released.snapshot.prices.find((entry) => entry.symbol === 'NVDA')).toMatchObject({ fresh: true });
    expect(await world.store.listSymbolHolds()).toEqual([]);
    // At the tick after, the same price is no jump from the latest tick, so nothing is held again.
    const next = await world.runTick('2026-10-06T18:00:05.000Z');
    expect(next.snapshot.prices.every((entry) => entry.fresh)).toBe(true);
    expect(await world.store.listSymbolHolds()).toEqual([]);
  });

  it('a second release of the same hold is refused, and a release of a symbol that is not held too', async () => {
    await world.addPro(1);
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.feed.prices = { ...TEST_PRICES, NVDA: P / 2 };
    await world.runTick('2026-10-06T16:00:05.000Z');
    expect(await world.store.releaseSymbolHold('NVDA', '2026-10-06T16:30:00.000Z')).toBe(true);
    expect(await world.store.releaseSymbolHold('NVDA', '2026-10-06T16:31:00.000Z')).toBe(false);
    expect(await world.store.releaseSymbolHold('MSFT', '2026-10-06T16:31:00.000Z')).toBe(false);
  });

  it('holds a move of 31% in either direction and lets a move of 29% through', async () => {
    await world.addPro(1);
    world.answers.set(1, decisionJson({}));
    await world.runTick('2026-10-06T15:00:05.000Z');
    world.feed.prices = {
      ...TEST_PRICES,
      AAPL: Math.round((TEST_PRICES.AAPL as number) * 1.31),
      AMD: Math.round((TEST_PRICES.AMD as number) * 0.69),
      AMZN: Math.round((TEST_PRICES.AMZN as number) * 1.29),
      MU: Math.round((TEST_PRICES.MU as number) * 0.71),
    };
    const tick = await world.runTick('2026-10-06T16:00:05.000Z');
    expect((await world.store.listSymbolHolds()).map((hold) => hold.symbol).sort()).toEqual(['AAPL', 'AMD']);
    const price = (symbol: string) => tick.snapshot.prices.find((entry) => entry.symbol === symbol);
    expect(price('AAPL')).toMatchObject({ priceMicro: TEST_PRICES.AAPL, fresh: false });
    expect(price('AMD')).toMatchObject({ priceMicro: TEST_PRICES.AMD, fresh: false });
    expect(price('AMZN')).toMatchObject({ priceMicro: world.feed.prices.AMZN, fresh: true });
    expect(price('MU')).toMatchObject({ priceMicro: world.feed.prices.MU, fresh: true });
  });

  it('has nothing to compare with at the first tick of a league, so it holds nothing', async () => {
    await world.addPro(1);
    world.feed.prices = { ...TEST_PRICES, NVDA: 1_000_000 };
    const tick = await world.runTick('2026-10-06T15:00:05.000Z');
    expect(await world.store.listSymbolHolds()).toEqual([]);
    expect(tick.snapshot.prices.every((entry) => entry.fresh)).toBe(true);
  });

  it('compares with the latest tick, even when that was on an earlier day', async () => {
    await world.addPro(1);
    await world.runTick('2026-10-06T19:00:05.000Z');
    world.feed.prices = { ...TEST_PRICES, NVDA: P * 3 };
    await world.runTick('2026-10-07T15:00:05.000Z');
    expect(
      (await world.store.listSymbolHolds()).map((hold) => [hold.symbol, hold.priceMicro, hold.sinceTickId]),
    ).toEqual([['NVDA', P, '2026-10-07T15:00Z']]);
    expect(await world.store.getLeagueState(SEASON_1.id, 'pro')).toMatchObject({ tickId: '2026-10-07T15:00Z' });
  });
});
