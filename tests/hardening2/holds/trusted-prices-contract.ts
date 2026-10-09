import type { Store, Tick } from '@prix/contracts';
import { TRUSTED_PRICE_LOOKBACK_TICKS } from '@prix/contracts';
import { expect, it } from 'vitest';
import { makeSnapshot, makeTick, TEST_PRICES } from '../../support/fixtures.ts';

/**
 * `Store.getLastTrustedPrices(beforeTickId)` (docs/CONTRACTS.md section 20): the newest fresh
 * point of each symbol in the newest TRUSTED_PRICE_LOOKBACK_TICKS ticks before the given one.
 * Shared by the memory store (Node) and the D1 store (Workers runtime), so both follow one text.
 */

/** Tick `n` of a run of ticks: five rounds a day, 15:00 to 19:00 UTC, from 2026-10-06. */
export function nthTickTime(n: number): Date {
  const day = Math.floor(n / 5);
  const hour = 15 + (n % 5);
  const date = new Date(Date.UTC(2026, 9, 6 + day, hour, 0, 5));
  return date;
}

/** A tick whose prices are TEST_PRICES scaled by `scale`, with the given symbols stale. */
export function tickAt(n: number, stale: readonly string[] = [], scale = 1 + n / 1_000): Tick {
  const now = nthTickTime(n);
  const prices = Object.fromEntries(
    Object.entries(TEST_PRICES).map(([symbol, price]) => [symbol, Math.round(price * scale)]),
  );
  return makeTick(now, { status: 'complete', snapshot: makeSnapshot(now, { prices, stale }) });
}

const price = (tick: Tick, symbol: string): number => {
  const point = tick.snapshot.prices.find((entry) => entry.symbol === symbol);
  if (point === undefined) throw new Error(`no ${symbol} in ${tick.id}`);
  return point.priceMicro;
};

/**
 * Registers the tests. `fresh` gives an empty store each time (D1 clears its tables first).
 */
export function trustedPricesContract(fresh: () => Promise<Store>): void {
  it('is empty before the first tick', async () => {
    const store = await fresh();
    expect(await store.getLastTrustedPrices('2026-10-06T15:00Z')).toEqual({});
  });

  it('gives the newest fresh point of each symbol before the tick, never one at or after it', async () => {
    const store = await fresh();
    const t0 = tickAt(0);
    const t1 = tickAt(1, ['NVDA']);
    const t2 = tickAt(2, ['NVDA', 'AAPL']);
    const t3 = tickAt(3);
    for (const tick of [t0, t1, t2, t3]) expect(await store.createTick(tick)).toBe(true);

    const trusted = await store.getLastTrustedPrices(t3.id);
    // NVDA was stale at t1 and t2: its last trusted price is the one of t0.
    expect(trusted.NVDA).toEqual({ priceMicro: price(t0, 'NVDA'), tickId: t0.id });
    // AAPL was stale at t2 only.
    expect(trusted.AAPL).toEqual({ priceMicro: price(t1, 'AAPL'), tickId: t1.id });
    // Every other symbol was fresh at t2, the newest tick before t3. t3 itself never counts.
    expect(trusted.MSFT).toEqual({ priceMicro: price(t2, 'MSFT'), tickId: t2.id });
    expect(Object.keys(trusted).sort()).toEqual(Object.keys(TEST_PRICES).sort());

    // Before t1 only t0 counts.
    const early = await store.getLastTrustedPrices(t1.id);
    expect(early.NVDA).toEqual({ priceMicro: price(t0, 'NVDA'), tickId: t0.id });
    expect(early.AAPL).toEqual({ priceMicro: price(t0, 'AAPL'), tickId: t0.id });
  });

  it('keeps looking for a universe symbol a newer tick lacks, however many other symbols that tick carries', async () => {
    // Section 21: the count of symbols found is taken over the universe. A newest tick that lacks
    // one universe symbol and carries three symbols outside it must not end the search early.
    const store = await fresh();
    const t0 = tickAt(0);
    const now = nthTickTime(1);
    const prices: Record<string, number> = {
      ...Object.fromEntries(
        Object.entries(TEST_PRICES)
          .filter(([symbol]) => symbol !== 'NVDA')
          .map(([symbol, value]) => [symbol, Math.round(value * 1.001)]),
      ),
      XAA: 1_000_000,
      XBB: 2_000_000,
      XCC: 3_000_000,
    };
    const t1 = makeTick(now, { status: 'complete', snapshot: makeSnapshot(now, { prices }) });
    for (const tick of [t0, t1]) expect(await store.createTick(tick)).toBe(true);

    const trusted = await store.getLastTrustedPrices(tickAt(2).id);
    expect(trusted.NVDA).toEqual({ priceMicro: price(t0, 'NVDA'), tickId: t0.id });
    expect(trusted.MSFT).toEqual({ priceMicro: price(t1, 'MSFT'), tickId: t1.id });
  });

  it(`looks back at most ${TRUSTED_PRICE_LOOKBACK_TICKS} ticks`, async () => {
    const store = await fresh();
    const count = TRUSTED_PRICE_LOOKBACK_TICKS + 5;
    const ticks: Tick[] = [];
    for (let n = 0; n < count; n += 1) {
      // AAPL is fresh only in the five oldest ticks, outside the window. AMD is fresh only in
      // the oldest tick inside the window.
      const oldestInside = count - TRUSTED_PRICE_LOOKBACK_TICKS;
      const stale = [...(n >= 5 ? ['AAPL'] : []), ...(n === oldestInside ? [] : ['AMD'])];
      ticks.push(tickAt(n, stale));
    }
    for (const tick of ticks) expect(await store.createTick(tick)).toBe(true);
    const after = tickAt(count);

    const trusted = await store.getLastTrustedPrices(after.id);
    expect(trusted.AAPL).toBeUndefined();
    const inside = ticks[count - TRUSTED_PRICE_LOOKBACK_TICKS] as Tick;
    expect(trusted.AMD).toEqual({ priceMicro: price(inside, 'AMD'), tickId: inside.id });
    const newest = ticks[count - 1] as Tick;
    expect(trusted.NVDA).toEqual({ priceMicro: price(newest, 'NVDA'), tickId: newest.id });
  });

  it('does not count a point the hold kept at its trusted price, because it is stored not fresh', async () => {
    const store = await fresh();
    const t0 = tickAt(0);
    const held = tickAt(1);
    // What applyHolds stores for a held symbol: the trusted price, marked not fresh.
    held.snapshot.prices = held.snapshot.prices.map((point) =>
      point.symbol === 'TSLA' ? { ...point, priceMicro: price(t0, 'TSLA'), fresh: false } : point,
    );
    for (const tick of [t0, held]) expect(await store.createTick(tick)).toBe(true);
    const trusted = await store.getLastTrustedPrices(tickAt(2).id);
    expect(trusted.TSLA).toEqual({ priceMicro: price(t0, 'TSLA'), tickId: t0.id });
  });
}
