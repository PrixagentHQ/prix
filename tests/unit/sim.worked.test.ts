import type { PortfolioState, RebalanceInput } from '@prix/contracts';
import { STARTING_CASH_MICRO } from '@prix/contracts';
import { sim } from '@prix/sim';
import { describe, expect, it } from 'vitest';

/**
 * Worked cases for docs/CONTRACTS.md section 7. Every expected number below was computed by
 * hand from the seven steps of `rebalance`, with the arithmetic shown in the comments.
 * M = 1,000,000 and B = 10,000. Fee and slippage are 10 basis points each, the smallest
 * trade is 50 basis points of the portfolio.
 */

const fresh = (): PortfolioState => ({ cashMicro: 10_000_000_000, holdings: {} });

function run(input: RebalanceInput) {
  return sim.rebalance(input);
}

describe('sim.newPortfolio and sim.valuePortfolio', () => {
  it('starts with 10,000 USD in cash and no holdings', () => {
    expect(STARTING_CASH_MICRO).toBe(10_000_000_000);
    expect(sim.newPortfolio()).toEqual({ cashMicro: 10_000_000_000, holdings: {} });
  });

  it('returns a new object every time', () => {
    const first = sim.newPortfolio();
    first.holdings.NVDA = 1;
    first.cashMicro = 0;
    expect(sim.newPortfolio()).toEqual({ cashMicro: 10_000_000_000, holdings: {} });
  });

  it('values cash plus the floor value of every holding', () => {
    // 1,500,000 micro-shares at 33.333333 USD = floor(1.5 * 33,333,333) = 49,999,999 (and a half, floored).
    // 3 micro-shares at 0.01 USD = floor(3 * 10,000 / 1,000,000) = 0.
    const portfolio = { cashMicro: 1_000_000, holdings: { AAA: 1_500_000, BBB: 3 } };
    expect(sim.valuePortfolio(portfolio, { AAA: 33_333_333, BBB: 10_000 })).toBe(1_000_000 + 49_999_999 + 0);
  });

  it('values an all-cash portfolio without any price', () => {
    expect(sim.valuePortfolio(fresh(), {})).toBe(10_000_000_000);
  });

  it('throws when a held symbol has no price', () => {
    expect(() => sim.valuePortfolio({ cashMicro: 0, holdings: { NVDA: 1_000_000 } }, { MSFT: 400_000_000 })).toThrow();
  });
});

describe('sim.rebalance, worked by hand', () => {
  it('buys two round positions from cash', () => {
    // V = 10,000,000,000. minTrade = 50,000,000.
    // MSFT: target 2,000,000,000 -> 8,000,000 units at 250 USD, notional 2,000,000,000,
    //       slippage 2,000,000, fee 2,000,000, cost 2,004,000,000. Cash 7,996,000,000.
    // NVDA: target 4,000,000,000 -> 40,000,000 units at 100 USD, notional 4,000,000,000,
    //       slippage 4,000,000, fee 4,000,000, cost 4,008,000,000. Cash 3,988,000,000.
    // W = 6,000,000,000; W * 10,020 = 6.012e13 <= cash * B = 1e14, so no scaling.
    const result = run({
      portfolio: fresh(),
      prices: { MSFT: 250_000_000, NVDA: 100_000_000 },
      targetsBps: { NVDA: 4_000, MSFT: 2_000 },
      halted: [],
    });
    expect(result).toEqual({
      portfolio: { cashMicro: 3_988_000_000, holdings: { MSFT: 8_000_000, NVDA: 40_000_000 } },
      fills: [
        {
          symbol: 'MSFT',
          side: 'buy',
          unitsMicro: 8_000_000,
          priceMicro: 250_000_000,
          notionalMicro: 2_000_000_000,
          feeMicro: 2_000_000,
          slippageMicro: 2_000_000,
        },
        {
          symbol: 'NVDA',
          side: 'buy',
          unitsMicro: 40_000_000,
          priceMicro: 100_000_000,
          notionalMicro: 4_000_000_000,
          feeMicro: 4_000_000,
          slippageMicro: 4_000_000,
        },
      ],
      equityBeforeMicro: 10_000_000_000,
      equityAfterMicro: 9_988_000_000,
      costMicro: 12_000_000,
    });
  });

  it('rounds units down and costs up at an awkward price', () => {
    // Target 33.33% of 10,000,000,000 = floor(1e10 * 3333 / 1e4) = 3,333,000,000.
    // buyUnits = floor(3,333,000,000 * 1e6 / 187,370,000) = 17,788,333
    //   (187.37 * 17,788,333 = 3,332,999,954.21; one more unit would pass the target).
    // notional = floor(17,788,333 * 187,370,000 / 1e6) = 3,332,999,954.
    // slippage = ceil(3,332,999,954 * 10 / 1e4) = ceil(3,332,999.954) = 3,333,000. Fee the same.
    // cost = 3,332,999,954 + 6,666,000 = 3,339,665,954. Cash = 6,660,334,046.
    const result = run({
      portfolio: fresh(),
      prices: { AAPL: 187_370_000 },
      targetsBps: { AAPL: 3_333 },
      halted: [],
    });
    expect(result.portfolio).toEqual({ cashMicro: 6_660_334_046, holdings: { AAPL: 17_788_333 } });
    expect(result.fills).toEqual([
      {
        symbol: 'AAPL',
        side: 'buy',
        unitsMicro: 17_788_333,
        priceMicro: 187_370_000,
        notionalMicro: 3_332_999_954,
        feeMicro: 3_333_000,
        slippageMicro: 3_333_000,
      },
    ]);
    expect(result.equityBeforeMicro).toBe(10_000_000_000);
    expect(result.equityAfterMicro).toBe(9_993_334_000);
    expect(result.costMicro).toBe(6_666_000);
  });

  it('sells first, then buys with the proceeds', () => {
    // Holding 100,000,000 NVDA at 100 USD = 10,000,000,000, no cash. V = 1e10.
    // NVDA: target 4e9, delta -6e9 -> sell floor(6e9 * 1e6 / 1e8) = 60,000,000 units,
    //       notional 6e9, slippage 6,000,000, fee 6,000,000. Cash A = 5,988,000,000.
    // MSFT: delta 4e9. W * 10,020 = 4.008e13 <= A * B = 5.988e13, so no scaling.
    //       buy floor(4e9 * 1e6 / 4e8) = 10,000,000 units, notional 4e9, cost 4,008,000,000.
    // Cash = 1,980,000,000.
    const result = run({
      portfolio: { cashMicro: 0, holdings: { NVDA: 100_000_000 } },
      prices: { MSFT: 400_000_000, NVDA: 100_000_000 },
      targetsBps: { MSFT: 4_000, NVDA: 4_000 },
      halted: [],
    });
    expect(result.portfolio).toEqual({ cashMicro: 1_980_000_000, holdings: { MSFT: 10_000_000, NVDA: 40_000_000 } });
    expect(result.fills.map((fill) => [fill.symbol, fill.side, fill.unitsMicro])).toEqual([
      ['NVDA', 'sell', 60_000_000],
      ['MSFT', 'buy', 10_000_000],
    ]);
    expect(result.equityAfterMicro).toBe(9_980_000_000);
    expect(result.costMicro).toBe(20_000_000);
  });

  it('sells part of a holding, rounding the units down', () => {
    // 60,000,000 NVDA at 123.45 USD = 7,407,000,000, cash 2,593,000,000. V = 1e10.
    // Target 25% = 2,500,000,000; delta = -4,907,000,000.
    // sellUnits = floor(4,907,000,000 * 1e6 / 123,450,000) = 39,748,886
    //   (123.45 * 39,748,886 = 4,906,999,976.7).
    // notional = 4,906,999,976. slippage = ceil(4,906,999.976) = 4,907,000. Fee the same.
    // Cash = 2,593,000,000 + 4,906,999,976 - 9,814,000 = 7,490,185,976.
    // Left: 20,251,114 units, worth floor(20,251,114 * 123.45) = 2,500,000,023.
    const result = run({
      portfolio: { cashMicro: 2_593_000_000, holdings: { NVDA: 60_000_000 } },
      prices: { NVDA: 123_450_000 },
      targetsBps: { NVDA: 2_500 },
      halted: [],
    });
    expect(result.portfolio).toEqual({ cashMicro: 7_490_185_976, holdings: { NVDA: 20_251_114 } });
    expect(result.fills).toEqual([
      {
        symbol: 'NVDA',
        side: 'sell',
        unitsMicro: 39_748_886,
        priceMicro: 123_450_000,
        notionalMicro: 4_906_999_976,
        feeMicro: 4_907_000,
        slippageMicro: 4_907_000,
      },
    ]);
    expect(result.equityBeforeMicro).toBe(10_000_000_000);
    expect(result.equityAfterMicro).toBe(9_990_185_999);
    expect(result.costMicro).toBe(9_814_000);
  });

  it('scales every buy when the targets need more cash than there is', () => {
    // All cash, targets 40% + 40% + 20% = 100%. W = 1e10 and W * 10,020 > cash * B, so
    // wanted_i = floor(delta_i * 1e10 * 1e4 / (1e10 * 10,020)) = floor(delta_i * 1e4 / 10,020).
    // AAPL: wanted 3,992,015,968 -> 19,960,079 units at 200 USD, notional 3,992,015,800,
    //       slippage ceil(3,992,015.8) = 3,992,016, fee the same, cost 3,999,999,832.
    // MSFT: wanted 3,992,015,968 -> 9,980,039 units at 400 USD, notional 3,992,015,600,
    //       slippage 3,992,016, fee the same, cost 3,999,999,632.
    // NVDA: wanted 1,996,007,984 -> 19,960,079 units at 100 USD, notional 1,996,007,900,
    //       slippage ceil(1,996,007.9) = 1,996,008, fee the same, cost 1,999,999,916.
    // Cash = 1e10 - 3,999,999,832 - 3,999,999,632 - 1,999,999,916 = 620.
    const result = run({
      portfolio: fresh(),
      prices: { AAPL: 200_000_000, MSFT: 400_000_000, NVDA: 100_000_000 },
      targetsBps: { NVDA: 2_000, AAPL: 4_000, MSFT: 4_000 },
      halted: [],
    });
    expect(result.portfolio).toEqual({
      cashMicro: 620,
      holdings: { AAPL: 19_960_079, MSFT: 9_980_039, NVDA: 19_960_079 },
    });
    expect(result.fills.map((fill) => [fill.symbol, fill.notionalMicro, fill.slippageMicro, fill.feeMicro])).toEqual([
      ['AAPL', 3_992_015_800, 3_992_016, 3_992_016],
      ['MSFT', 3_992_015_600, 3_992_016, 3_992_016],
      ['NVDA', 1_996_007_900, 1_996_008, 1_996_008],
    ]);
    expect(result.equityAfterMicro).toBe(9_980_039_920);
    expect(result.costMicro).toBe(19_960_080);
  });

  it('does not trade a change below 0.5% of the portfolio', () => {
    // 39,600,000 NVDA at 100 USD = 3,960,000,000 and 6,040,000,000 cash. V = 1e10.
    // Target 40% = 4e9, delta 40,000,000 < minTrade 50,000,000.
    const portfolio = { cashMicro: 6_040_000_000, holdings: { NVDA: 39_600_000 } };
    const result = run({ portfolio, prices: { NVDA: 100_000_000 }, targetsBps: { NVDA: 4_000 }, halted: [] });
    expect(result).toEqual({
      portfolio: { cashMicro: 6_040_000_000, holdings: { NVDA: 39_600_000 } },
      fills: [],
      equityBeforeMicro: 10_000_000_000,
      equityAfterMicro: 10_000_000_000,
      costMicro: 0,
    });
  });

  it('trades a change of exactly 0.5% of the portfolio', () => {
    // 39,500,000 NVDA = 3,950,000,000 and 6,050,000,000 cash. delta = 50,000,000 = minTrade.
    // buy 500,000 units, notional 50,000,000, slippage 50,000, fee 50,000, cost 50,100,000.
    const result = run({
      portfolio: { cashMicro: 6_050_000_000, holdings: { NVDA: 39_500_000 } },
      prices: { NVDA: 100_000_000 },
      targetsBps: { NVDA: 4_000 },
      halted: [],
    });
    expect(result.portfolio).toEqual({ cashMicro: 5_999_900_000, holdings: { NVDA: 40_000_000 } });
    expect(result.costMicro).toBe(100_000);
    expect(result.equityAfterMicro).toBe(9_999_900_000);
  });

  it('always sells a holding with no target in full, however small', () => {
    // 40,000 TSLA at 250 USD = 10,000,000, far below minTrade 50,000,000, and no target.
    // notional 10,000,000, slippage 10,000, fee 10,000. Cash 9,990,000,000 + 9,980,000.
    const result = run({
      portfolio: { cashMicro: 9_990_000_000, holdings: { TSLA: 40_000 } },
      prices: { TSLA: 250_000_000 },
      targetsBps: {},
      halted: [],
    });
    expect(result).toEqual({
      portfolio: { cashMicro: 9_999_980_000, holdings: {} },
      fills: [
        {
          symbol: 'TSLA',
          side: 'sell',
          unitsMicro: 40_000,
          priceMicro: 250_000_000,
          notionalMicro: 10_000_000,
          feeMicro: 10_000,
          slippageMicro: 10_000,
        },
      ],
      equityBeforeMicro: 10_000_000_000,
      equityAfterMicro: 9_999_980_000,
      costMicro: 20_000,
    });
  });

  it('never charges more than the notional of a dust sale', () => {
    // 150 micro-shares at 0.01 USD: notional floor(150 * 10,000 / 1e6) = 1.
    // slippage = min(ceil(1 * 10 / 1e4), 1) = 1. fee = min(1, 1 - 1) = 0. Cash rises by 0.
    const result = run({
      portfolio: { cashMicro: 5_000_000, holdings: { DUST: 150 } },
      prices: { DUST: 10_000 },
      targetsBps: {},
      halted: [],
    });
    expect(result.portfolio).toEqual({ cashMicro: 5_000_000, holdings: {} });
    expect(result.fills).toEqual([
      {
        symbol: 'DUST',
        side: 'sell',
        unitsMicro: 150,
        priceMicro: 10_000,
        notionalMicro: 1,
        feeMicro: 0,
        slippageMicro: 1,
      },
    ]);
    expect(result.equityBeforeMicro).toBe(5_000_001);
    expect(result.equityAfterMicro).toBe(5_000_000);
    expect(result.costMicro).toBe(1);
  });

  it('values a halted holding and does not trade it', () => {
    // NVDA 25,000,000 at 100 USD and TSLA 10,000,000 at 250 USD, 5e9 cash. V = 1e10.
    // Empty targets sell NVDA in full: notional 2.5e9, slippage 2,500,000, fee 2,500,000.
    // TSLA is halted and stays. Cash = 5e9 + 2,495,000,000.
    const result = run({
      portfolio: { cashMicro: 5_000_000_000, holdings: { NVDA: 25_000_000, TSLA: 10_000_000 } },
      prices: { NVDA: 100_000_000, TSLA: 250_000_000 },
      targetsBps: {},
      halted: ['TSLA'],
    });
    expect(result.portfolio).toEqual({ cashMicro: 7_495_000_000, holdings: { TSLA: 10_000_000 } });
    expect(result.fills.map((fill) => fill.symbol)).toEqual(['NVDA']);
    expect(result.equityBeforeMicro).toBe(10_000_000_000);
    expect(result.equityAfterMicro).toBe(9_995_000_000);
    expect(result.costMicro).toBe(5_000_000);
  });

  it('accepts a target for a halted symbol and leaves that holding as it is', () => {
    const result = run({
      portfolio: fresh(),
      prices: { NVDA: 100_000_000, TSLA: 250_000_000 },
      targetsBps: { TSLA: 4_000 },
      halted: ['TSLA'],
    });
    expect(result).toEqual({
      portfolio: { cashMicro: 10_000_000_000, holdings: {} },
      fills: [],
      equityBeforeMicro: 10_000_000_000,
      equityAfterMicro: 10_000_000_000,
      costMicro: 0,
    });
  });

  it('does nothing for an all-cash portfolio with no targets', () => {
    const result = run({ portfolio: fresh(), prices: {}, targetsBps: {}, halted: [] });
    expect(result).toEqual({
      portfolio: fresh(),
      fills: [],
      equityBeforeMicro: 10_000_000_000,
      equityAfterMicro: 10_000_000_000,
      costMicro: 0,
    });
  });

  it('throws on a programming error: a targeted symbol with no price', () => {
    expect(() => run({ portfolio: fresh(), prices: {}, targetsBps: { NVDA: 1_000 }, halted: [] })).toThrow();
  });

  it('throws when a number would not be a safe integer', () => {
    // 9e15 micro-shares at 1,000 USD are worth 9e18 micro-USD, far above 2^53.
    expect(() =>
      run({
        portfolio: { cashMicro: 9_000_000_000_000_000, holdings: { AAA: 9_000_000_000_000_000 } },
        prices: { AAA: 1_000_000_000 },
        targetsBps: { AAA: 4_000 },
        halted: [],
      }),
    ).toThrow();
  });
});
