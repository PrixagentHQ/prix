import type { MarketSnapshot, OtherChainRead, Tick, TrustedPrices } from '@prix/contracts';
import { MAX_HALTED_FEEDS, SUSPECT_MOVE_BPS } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyHolds } from '../../packages/runtime/src/holds.ts';
import { decisionJson } from '../support/fakes.ts';
import { makeSnapshot, makeTick, TEST_ARBITRUM_SYMBOLS, TEST_PRICES, utc } from '../support/fixtures.ts';
import type { World } from '../support/scheduler.ts';
import { createWorld, expectReplayMatches } from '../support/scheduler.ts';

/**
 * SOL, BNB and HYPE in the scheduler, docs/CONTRACTS.md section 23, rules 7, 10 and 12, with section
 * 21, rules 3, 9 and 11. A coin left unread by an Arbitrum problem takes its last trusted price before
 * the tick is stored, valued and not traded, and begins no hold. A coin's first price is its anchor.
 * SUSPECT_MOVE_BPS and the hold rules apply to them as to every symbol, a weekend included, and an
 * admin releases the hold. Their halts never count against MAX_HALTED_FEEDS.
 *
 * `applyHolds` is called without its crypto set, so the scheduler's own view of the universe decides.
 */

const MONDAY = utc('2026-10-12T15:00:05.000Z');
const MONDAY_TICK = '2026-10-12T15:00Z';
const FRIDAY_TICK = '2026-10-09T19:00Z';
const FRIDAY = utc('2026-10-09T19:00:05.000Z');

const unread = (symbols: readonly string[]): Record<string, number> =>
  Object.fromEntries(symbols.map((symbol) => [symbol, 0]));

function monday(prices: Record<string, number> = {}, stale: readonly string[] = []): MarketSnapshot {
  return makeSnapshot(MONDAY, { prices: { ...TEST_PRICES, ...prices }, stale });
}

function friday(prices: Record<string, number> = TEST_PRICES): Tick {
  return makeTick(FRIDAY, { status: 'complete', snapshot: makeSnapshot(FRIDAY, { prices }) });
}

function trusted(drop: readonly string[] = []): TrustedPrices {
  const out: Record<string, { priceMicro: number; tickId: string }> = {};
  for (const [symbol, price] of Object.entries(TEST_PRICES)) {
    if (!drop.includes(symbol)) out[symbol] = { priceMicro: price, tickId: FRIDAY_TICK };
  }
  return out;
}

const run = (snapshot: MarketSnapshot, trustedPrices: TrustedPrices, latest: Tick | null) =>
  applyHolds(
    snapshot,
    { trusted: trustedPrices, latest, previousTradingDay: latest === null ? null : '2026-10-09' },
    [],
    MONDAY_TICK,
    MONDAY.toISOString(),
  );

const point = (snapshot: MarketSnapshot, symbol: string) => snapshot.prices.find((entry) => entry.symbol === symbol);

describe('coins left unread by an Arbitrum problem', () => {
  it('are valued at their last trusted price, not fresh, and begin no hold', () => {
    const result = run(monday(unread(TEST_ARBITRUM_SYMBOLS), TEST_ARBITRUM_SYMBOLS), trusted(), friday());
    for (const symbol of TEST_ARBITRUM_SYMBOLS) {
      expect(point(result.snapshot, symbol), symbol).toMatchObject({ priceMicro: TEST_PRICES[symbol], fresh: false });
    }
    expect(result.newHolds).toEqual([]);
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('never close the market, even beside MAX_HALTED_FEEDS halted Stock Tokens and both other coins', () => {
    expect(MAX_HALTED_FEEDS).toBe(2);
    const halted = [...TEST_ARBITRUM_SYMBOLS, 'BTC', 'ETH'];
    const snapshot = monday({ ...unread(halted) }, [...halted, 'AAPL', 'MSFT']);
    const result = run(snapshot, trusted(), friday());
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
    expect(result.newHolds).toEqual([]);
  });

  it('take the latest tick price when the lookback has none, and are left out when no tick ever priced them', () => {
    const fromLatest = run(monday(unread(['SOL']), ['SOL']), trusted(['SOL']), friday());
    expect(point(fromLatest.snapshot, 'SOL')).toMatchObject({ priceMicro: TEST_PRICES.SOL, fresh: false });

    const { SOL: _sol, ...withoutSol } = TEST_PRICES;
    const never = run(monday(unread(['SOL']), ['SOL']), trusted(['SOL']), friday(withoutSol));
    expect(point(never.snapshot, 'SOL')).toBeUndefined();
    expect(never.snapshot.open).toBe(true);
  });
});

describe('holds on SOL, BNB and HYPE', () => {
  it('holds a HYPE move of more than SUSPECT_MOVE_BPS after a weekend, at the trusted price', () => {
    expect(SUSPECT_MOVE_BPS).toBe(3_000);
    const hype = TEST_PRICES.HYPE as number;
    const up = Math.round(hype * 1.31);
    const result = run(monday({ HYPE: up }), trusted(), friday());
    expect(result.newHolds).toMatchObject([{ symbol: 'HYPE', priceMicro: hype, seenPriceMicro: up, releasedAt: null }]);
    expect(point(result.snapshot, 'HYPE')).toMatchObject({ priceMicro: hype, fresh: false });
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('lets a HYPE move of less than SUSPECT_MOVE_BPS through', () => {
    const hype = TEST_PRICES.HYPE as number;
    const result = run(monday({ HYPE: Math.round(hype * 0.71) }), trusted(), friday());
    expect(result.newHolds).toEqual([]);
    expect(point(result.snapshot, 'HYPE')?.fresh).toBe(true);
  });

  it('holds SOL and BNB on a large move as well, and three held coins never close the market', () => {
    const moved = {
      SOL: (TEST_PRICES.SOL as number) * 2,
      BNB: Math.round((TEST_PRICES.BNB as number) / 2),
      HYPE: (TEST_PRICES.HYPE as number) * 3,
    };
    const result = run(monday(moved, ['AAPL', 'MSFT']), trusted(), friday());
    expect(result.newHolds.map((hold) => hold.symbol).sort()).toEqual(['BNB', 'HYPE', 'SOL']);
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('keeps a held coin at its trusted price while the hold is open, and uses the feed after release', () => {
    const hype = TEST_PRICES.HYPE as number;
    const hold = {
      symbol: 'HYPE',
      priceMicro: hype,
      seenPriceMicro: hype * 2,
      sinceTickId: MONDAY_TICK,
      releasedAt: null,
      createdAt: MONDAY.toISOString(),
    };
    const held = applyHolds(
      monday({ HYPE: hype * 2 }),
      { trusted: trusted(), latest: friday(), previousTradingDay: '2026-10-09' },
      [hold],
      MONDAY_TICK,
      MONDAY.toISOString(),
    );
    expect(point(held.snapshot, 'HYPE')).toMatchObject({ priceMicro: hype, fresh: false });
    const released = applyHolds(
      monday({ HYPE: hype * 2 }),
      { trusted: trusted(), latest: friday(), previousTradingDay: '2026-10-09' },
      [{ ...hold, releasedAt: '2026-10-12T15:30:00.000Z' }],
      '2026-10-12T16:00Z',
      '2026-10-12T16:00:05.000Z',
    );
    expect(point(released.snapshot, 'HYPE')).toMatchObject({ priceMicro: hype * 2, fresh: true });
    expect(released.newHolds).toEqual([]);
  });
});

describe('the first round with the new coins', () => {
  const { BNB: _b, HYPE: _h, SOL: _s, ...stage1 } = TEST_PRICES;

  it('prices them but does not trade them: their first price is the anchor', () => {
    const result = run(monday(), trusted(TEST_ARBITRUM_SYMBOLS), friday(stage1));
    for (const symbol of TEST_ARBITRUM_SYMBOLS) {
      expect(point(result.snapshot, symbol), symbol).toMatchObject({ priceMicro: TEST_PRICES[symbol], fresh: false });
    }
    expect(result.newHolds).toEqual([]);
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
  });

  it('leaves them out when Arbitrum is unread in that round, so nobody can hold or target them', () => {
    const result = run(
      monday(unread(TEST_ARBITRUM_SYMBOLS), TEST_ARBITRUM_SYMBOLS),
      trusted(TEST_ARBITRUM_SYMBOLS),
      friday(stage1),
    );
    for (const symbol of TEST_ARBITRUM_SYMBOLS) expect(point(result.snapshot, symbol), symbol).toBeUndefined();
    expect(result.snapshot).toMatchObject({ open: true, closedReason: null });
  });
});

describe('the scheduler with SOL, BNB and HYPE', () => {
  let world: World;
  const read: OtherChainRead = {
    chainId: 42161,
    blockNumber: 391_234_567,
    endpoint: 0,
    confirmedBy: null,
    problem: null,
  };

  beforeEach(() => {
    world = createWorld();
    world.feed.prices = { ...TEST_PRICES };
    world.feed.options = { otherChains: [read] };
  });

  it('fills a Pro agent in SOL at the reference price, and keeps the Arbitrum provenance in the stored tick', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ SOL: 20, HYPE: 10 }));
    const tick = await world.runTick('2026-10-06T15:00:05.000Z');
    expect(tick.snapshot.otherChains).toEqual([read]);
    const row = world.row(agent, '2026-10-06T15:00Z');
    expect(row.status).toBe('decided');
    expect(row.fills.map((fill) => fill.symbol).sort()).toEqual(['HYPE', 'SOL']);
    expect(row.fills.find((fill) => fill.symbol === 'SOL')?.priceMicro).toBe(TEST_PRICES.SOL);
  });

  it('values a SOL holder at its last trusted price when Arbitrum is unread, trades nothing in it, and replays', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ SOL: 20 }));
    await world.runTick('2026-10-06T15:00:05.000Z');
    const before = world.row(agent, '2026-10-06T15:00Z');
    expect(before.fills.map((fill) => fill.symbol)).toEqual(['SOL']);

    world.feed.prices = { ...TEST_PRICES, ...unread(TEST_ARBITRUM_SYMBOLS) };
    world.feed.options = {
      stale: [...TEST_ARBITRUM_SYMBOLS],
      otherChains: [{ chainId: 42161, blockNumber: 0, endpoint: null, confirmedBy: null, problem: 'rpc_unavailable' }],
    };
    world.answers.set(1, decisionJson({ SOL: 40 }));
    const tick = await world.runTick('2026-10-06T16:00:05.000Z');

    expect(tick.snapshot).toMatchObject({ open: true, closedReason: null });
    expect(point(tick.snapshot, 'SOL')).toMatchObject({ priceMicro: TEST_PRICES.SOL, fresh: false });
    expect(tick.snapshot.otherChains?.[0]?.problem).toBe('rpc_unavailable');
    expect(await world.store.listSymbolHolds()).toEqual([]);
    const row = world.row(agent, '2026-10-06T16:00Z');
    expect(row).toMatchObject({ status: 'decided', fills: [] });
    expect(row.halted).toEqual(expect.arrayContaining([...TEST_ARBITRUM_SYMBOLS]));
    expect(row.portfolio).toEqual(before.portfolio);
    expect(row.equityMicro).toBe(before.equityMicro);
    await expectReplayMatches(world, agent);
  });
});
