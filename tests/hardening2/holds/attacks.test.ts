import { SUSPECT_MOVE_BPS, symbolHoldSchema } from '@prix/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { decisionJson } from '../../support/fakes.ts';
import { TEST_PRICES } from '../../support/fixtures.ts';
import type { World } from '../../support/scheduler.ts';
import { createWorld, expectReplayMatches } from '../../support/scheduler.ts';

/**
 * Security review of 2026-10-08 (the newest reads), finding 1, and docs/CONTRACTS.md section 20:
 * the suspect-move hold compares every new point with the last trusted price of its symbol, not
 * with the latest tick, so a symbol paused or stale for a round is still compared; a symbol whose
 * last trusted price is older than the previous trading day is held for review.
 *
 * The scheduler runs for real against the memory store, with a feed the test scripts: a lying
 * fallback endpoint or a compromised provider is a feed that says what the test wants.
 */

const P = TEST_PRICES.NVDA as number;
const nvda = (tick: { snapshot: { prices: { symbol: string; priceMicro: number; fresh: boolean }[] } }) =>
  tick.snapshot.prices.find((point) => point.symbol === 'NVDA');

describe('the two-round attack on the suspect-move hold', () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
    expect(SUSPECT_MOVE_BPS).toBe(3_000);
  });

  it('holds a symbol that was paused for one round and then comes back at ten times its price', async () => {
    const agent = await world.addPro(1);
    world.answers.set(1, decisionJson({ NVDA: 20 }));
    await world.runTick('2026-10-06T17:00:05.000Z');
    const before = world.row(agent, '2026-10-06T17:00Z');
    expect(before.fills.map((fill) => fill.symbol)).toEqual(['NVDA']);

    // 18:00: the feed says NVDA is paused, at its real price. One halted symbol keeps the market open.
    world.feed.options = { stale: ['NVDA'] };
    const paused = await world.runTick('2026-10-06T18:00:05.000Z');
    expect(paused.snapshot.open).toBe(true);
    expect(nvda(paused)).toMatchObject({ priceMicro: P, fresh: false });
    expect(await world.store.listSymbolHolds()).toEqual([]);

    // 19:00: NVDA is fresh again, at ten times the price.
    world.feed.options = {};
    world.feed.prices = { ...TEST_PRICES, NVDA: P * 10 };
    const jumped = await world.runTick('2026-10-06T19:00:05.000Z');

    const holds = await world.store.listSymbolHolds();
    expect(holds).toHaveLength(1);
    expect(symbolHoldSchema.safeParse(holds[0]).success).toBe(true);
    expect(holds[0]).toMatchObject({
      symbol: 'NVDA',
      priceMicro: P,
      seenPriceMicro: P * 10,
      sinceTickId: '2026-10-06T19:00Z',
    });
    expect(nvda(jumped)).toMatchObject({ priceMicro: P, fresh: false });
    // The agent holding NVDA does not jump up the league.
    const row = world.row(agent, '2026-10-06T19:00Z');
    expect(row.halted).toEqual(['NVDA']);
    expect(row.equityMicro).toBe(before.equityMicro);
    await expectReplayMatches(world, agent);
  });

  it('holds +29% while paused followed by +29% fresh: the second is compared with the last trusted price', async () => {
    await world.addPro(1);
    await world.runTick('2026-10-06T17:00:05.000Z');
    const once = Math.round(P * 1.29);
    const twice = Math.round(once * 1.29);

    world.feed.options = { stale: ['NVDA'] };
    world.feed.prices = { ...TEST_PRICES, NVDA: once };
    const first = await world.runTick('2026-10-06T18:00:05.000Z');
    // Within the limit of the trusted price, and not fresh: taken, but it does not become trusted.
    expect(nvda(first)).toMatchObject({ priceMicro: once, fresh: false });
    expect(await world.store.listSymbolHolds()).toEqual([]);

    world.feed.options = {};
    world.feed.prices = { ...TEST_PRICES, NVDA: twice };
    const second = await world.runTick('2026-10-06T19:00:05.000Z');
    expect(
      (await world.store.listSymbolHolds()).map((hold) => [hold.symbol, hold.priceMicro, hold.seenPriceMicro]),
    ).toEqual([['NVDA', P, twice]]);
    expect(nvda(second)).toMatchObject({ priceMicro: P, fresh: false });
  });

  it('lets two fresh rounds of +29% through: each is within the limit of a price that was fresh (finding 2 is the guard)', async () => {
    // Every point here is fresh, so each one becomes the last trusted price of the next round.
    // The hold cannot tell this from a real rally; the guard against a lying endpoint that
    // serves fresh prices is the second endpoint that must agree (docs/CONTRACTS.md section 20).
    await world.addPro(1);
    await world.runTick('2026-10-06T17:00:05.000Z');
    const once = Math.round(P * 1.29);
    const twice = Math.round(once * 1.29);
    world.feed.prices = { ...TEST_PRICES, NVDA: once };
    await world.runTick('2026-10-06T18:00:05.000Z');
    world.feed.prices = { ...TEST_PRICES, NVDA: twice };
    const second = await world.runTick('2026-10-06T19:00:05.000Z');
    expect(await world.store.listSymbolHolds()).toEqual([]);
    expect(nvda(second)).toMatchObject({ priceMicro: twice, fresh: true });
  });
});

describe('a last trusted price older than the previous trading day', () => {
  let world: World;

  beforeEach(async () => {
    world = createWorld();
    await world.addPro(1);
    // Monday: NVDA fresh. Tuesday: NVDA paused all day.
    await world.runTick('2026-10-05T19:00:05.000Z');
    world.feed.options = { stale: ['NVDA'] };
    await world.runTick('2026-10-06T15:00:05.000Z');
    await world.runTick('2026-10-06T19:00:05.000Z');
    world.feed.options = {};
  });

  it('holds the symbol for review when it comes back on Wednesday, even with a small move', async () => {
    world.feed.prices = { ...TEST_PRICES, NVDA: Math.round(P * 1.05) };
    const tick = await world.runTick('2026-10-07T15:00:05.000Z');
    expect(
      (await world.store.listSymbolHolds()).map((hold) => [hold.symbol, hold.priceMicro, hold.sinceTickId]),
    ).toEqual([['NVDA', P, '2026-10-07T15:00Z']]);
    expect(nvda(tick)).toMatchObject({ priceMicro: P, fresh: false });
  });

  it('holds it at a later round of Wednesday too, after a first round in which it was still paused', async () => {
    // Wednesday 15:00: still paused, at the trusted price. Every other symbol is fresh, so after
    // this round no trusted price but NVDA's is older than Wednesday.
    world.feed.options = { stale: ['NVDA'] };
    await world.runTick('2026-10-07T15:00:05.000Z');
    expect(await world.store.listSymbolHolds()).toEqual([]);
    world.feed.options = {};
    world.feed.prices = { ...TEST_PRICES, NVDA: Math.round(P * 1.05) };
    const tick = await world.runTick('2026-10-07T16:00:05.000Z');
    expect(
      (await world.store.listSymbolHolds()).map((hold) => [hold.symbol, hold.priceMicro, hold.sinceTickId]),
    ).toEqual([['NVDA', P, '2026-10-07T16:00Z']]);
    expect(nvda(tick)).toMatchObject({ priceMicro: P, fresh: false });
  });

  it('holds nothing when the price it comes back with is the trusted price itself', async () => {
    const tick = await world.runTick('2026-10-07T15:00:05.000Z');
    expect(await world.store.listSymbolHolds()).toEqual([]);
    expect(nvda(tick)).toMatchObject({ priceMicro: P, fresh: true });
  });

  it('compares as usual when the trusted price is from the previous trading day, even over a weekend', async () => {
    // Wednesday, NVDA fresh at 15:00; the next round is on Monday 2026-10-12.
    await world.runTick('2026-10-07T15:00:05.000Z');
    world.feed.options = { stale: ['NVDA'] };
    await world.runTick('2026-10-07T19:00:05.000Z');
    world.feed.options = {};
    world.feed.prices = { ...TEST_PRICES, NVDA: Math.round(P * 1.05) };
    const monday = await world.runTick('2026-10-12T15:00:05.000Z');
    expect(await world.store.listSymbolHolds()).toEqual([]);
    expect(nvda(monday)).toMatchObject({ priceMicro: Math.round(P * 1.05), fresh: true });
  });
});
