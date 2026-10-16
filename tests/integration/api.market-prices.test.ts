import { marketPricesResponseSchema, UNIVERSE_SIZE } from '@prix/contracts';
import { UNIVERSE } from '@prix/market/universe';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '../support/api.ts';
import { createApi, expectPublicCache, expectShape } from '../support/api.ts';
import { makeSnapshot, makeTick, TEST_PRICES, utc } from '../support/fixtures.ts';

/**
 * GET /api/market/prices, the price strip of docs/CONTRACTS.md section 17.2: the universe at the
 * latest round, each symbol with its name, its price, whether its feed was fresh, and its change
 * since the last stored daily price before the round's day. Ticks are put into the store directly,
 * the way the scheduler leaves them.
 */

const NOW = '2026-10-07T16:10:00.000Z';

/** TEST_PRICES with some symbols moved by the given basis points. */
function moved(changes: Record<string, number>): Record<string, number> {
  const prices: Record<string, number> = { ...TEST_PRICES };
  for (const [symbol, bps] of Object.entries(changes)) {
    prices[symbol] = Math.round(((prices[symbol] as number) * (10_000 + bps)) / 10_000);
  }
  return prices;
}

async function addTick(api: Api, at: string, options: Parameters<typeof makeSnapshot>[1] = {}): Promise<void> {
  const now = utc(at);
  const tick = makeTick(now, { status: 'complete', snapshot: makeSnapshot(now, options) });
  expect(await api.store.createTick(tick)).toBe(true);
}

describe('GET /api/market/prices', () => {
  let api: Api;
  beforeEach(() => {
    api = createApi({ now: NOW });
  });

  const read = async () => {
    const reply = await api.client().get('/api/market/prices');
    expectPublicCache(reply);
    return expectShape(marketPricesResponseSchema, reply);
  };

  it('answers a null round and no prices before the first round', async () => {
    expect(await read()).toEqual({ tickId: null, takenAt: null, prices: [] });
  });

  it('gives the UNIVERSE_SIZE symbols of the latest round in universe order, Stock Tokens then crypto assets, each with the name the universe gives', async () => {
    await addTick(api, '2026-10-06T19:00:00.000Z');
    await addTick(api, '2026-10-07T15:00:00.000Z', { prices: moved({ NVDA: 125 }) });
    await addTick(api, '2026-10-07T16:00:00.000Z', { prices: moved({ NVDA: 250, TSLA: -80 }) });

    const body = await read();
    expect(body.tickId).toBe('2026-10-07T16:00Z');
    expect(body.takenAt).toBe('2026-10-07T16:00:00.000Z');
    expect(body.prices).toHaveLength(UNIVERSE_SIZE);
    expect(body.prices.map((entry) => entry.symbol)).toEqual(UNIVERSE.map((token) => token.symbol));
    expect(body.prices.map((entry) => entry.name)).toEqual(UNIVERSE.map((token) => token.name));
    // Sections 21 and 23: the 20 Stock Tokens by symbol, then BTC and ETH, then BNB, HYPE and SOL.
    expect(body.prices.slice(-5).map((entry) => entry.symbol)).toEqual(['BTC', 'ETH', 'BNB', 'HYPE', 'SOL']);
    const nvda = body.prices.find((entry) => entry.symbol === 'NVDA');
    expect(nvda).toEqual({
      symbol: 'NVDA',
      name: UNIVERSE.find((token) => token.symbol === 'NVDA')?.name,
      priceMicro: moved({ NVDA: 250 }).NVDA,
      // Since the last price of Tuesday, not since the round before.
      changeBps: 250,
      fresh: true,
    });
    expect(body.prices.find((entry) => entry.symbol === 'TSLA')?.changeBps).toBe(-80);
    expect(body.prices.find((entry) => entry.symbol === 'AAPL')?.changeBps).toBe(0);
  });

  it('compares with the last price of the latest earlier day that has one, not with the day before', async () => {
    // Friday, then the round of Monday, after a weekend without rounds.
    api.setNow('2026-10-12T15:20:00.000Z');
    await addTick(api, '2026-10-09T18:00:00.000Z', { prices: moved({ AMD: 400 }) });
    await addTick(api, '2026-10-09T19:00:00.000Z');
    await addTick(api, '2026-10-12T15:00:00.000Z', { prices: moved({ AMD: -100 }) });
    const amd = (await read()).prices.find((entry) => entry.symbol === 'AMD');
    expect(amd?.changeBps).toBe(-100);
  });

  it('gives a null change on the first day, when no earlier price is stored', async () => {
    await addTick(api, '2026-10-07T15:00:00.000Z');
    const body = await read();
    expect(body.prices).toHaveLength(UNIVERSE_SIZE);
    for (const entry of body.prices) expect(entry.changeBps, entry.symbol).toBeNull();
  });

  it('gives a null change for a symbol the earlier day has no price for', async () => {
    const { SPCX: _left, ...without } = TEST_PRICES;
    await addTick(api, '2026-10-06T19:00:00.000Z', { prices: without });
    await addTick(api, '2026-10-07T15:00:00.000Z');
    const body = await read();
    expect(body.prices.find((entry) => entry.symbol === 'SPCX')?.changeBps).toBeNull();
    expect(body.prices.find((entry) => entry.symbol === 'SPY')?.changeBps).toBe(0);
  });

  it('marks a stale feed and still gives its price', async () => {
    await addTick(api, '2026-10-07T15:00:00.000Z', { stale: ['MSTR'] });
    const body = await read();
    const mstr = body.prices.find((entry) => entry.symbol === 'MSTR');
    expect(mstr).toMatchObject({ priceMicro: TEST_PRICES.MSTR, fresh: false });
    expect(body.prices.filter((entry) => !entry.fresh).map((entry) => entry.symbol)).toEqual(['MSTR']);
  });

  it('gives a crypto asset its price and its change like any symbol', async () => {
    await addTick(api, '2026-10-06T19:00:00.000Z');
    await addTick(api, '2026-10-07T15:00:00.000Z', { prices: moved({ BTC: 310, ETH: -45 }) });
    const body = await read();
    expect(body.prices.find((entry) => entry.symbol === 'BTC')).toMatchObject({
      priceMicro: moved({ BTC: 310 }).BTC,
      changeBps: 310,
      fresh: true,
    });
    expect(body.prices.find((entry) => entry.symbol === 'ETH')?.changeBps).toBe(-45);
  });

  it('gives a null change to the coins on their first day while every Stock Token has one (no backfill)', async () => {
    // The day before the coins joined: the stored round has the 20 Stock Tokens only.
    const { BTC: _btc, ETH: _eth, ...stocksOnly } = TEST_PRICES;
    await addTick(api, '2026-10-06T19:00:00.000Z', { prices: stocksOnly });
    await addTick(api, '2026-10-07T15:00:00.000Z');
    const body = await read();
    expect(body.prices).toHaveLength(UNIVERSE_SIZE);
    for (const entry of body.prices) {
      if (entry.symbol === 'BTC' || entry.symbol === 'ETH') expect(entry.changeBps, entry.symbol).toBeNull();
      else expect(entry.changeBps, entry.symbol).toBe(0);
    }
  });

  it('marks a stale crypto feed alone and still gives its price', async () => {
    await addTick(api, '2026-10-07T15:00:00.000Z', { stale: ['ETH'] });
    const body = await read();
    expect(body.prices.find((entry) => entry.symbol === 'ETH')).toMatchObject({
      priceMicro: TEST_PRICES.ETH,
      fresh: false,
    });
    expect(body.prices.filter((entry) => !entry.fresh).map((entry) => entry.symbol)).toEqual(['ETH']);
  });

  it('gives no prices for a round at which the chain could not be read', async () => {
    await addTick(api, '2026-10-06T19:00:00.000Z');
    await addTick(api, '2026-10-07T15:00:00.000Z', { rpcDown: true });
    expect(await read()).toEqual({ tickId: '2026-10-07T15:00Z', takenAt: '2026-10-07T15:00:00.000Z', prices: [] });
  });

  it('makes two reads at most: the latest tick and one row of daily prices', async () => {
    await addTick(api, '2026-10-06T19:00:00.000Z');
    await addTick(api, '2026-10-07T15:00:00.000Z');
    api.store.resetCalls();
    await read();
    expect(api.store.calls).toEqual({ getLatestTick: 1, listDailyPrices: 1 });

    const empty = createApi({ now: NOW });
    empty.store.resetCalls();
    await empty.client().get('/api/market/prices');
    expect(empty.store.calls).toEqual({ getLatestTick: 1 });
  });
});
