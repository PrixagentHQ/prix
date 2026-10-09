import type { DnaInput } from '@prix/contracts';
import { DNA_MIN_DAYS, DNA_WINDOW_DAYS, dnaProfileSchema } from '@prix/contracts';
import { strategyDna } from '@prix/reputation/dna';
import { sim } from '@prix/sim';
import { describe, expect, it } from 'vitest';
import { createRng } from '../support/prng.ts';
import type { Prices } from './support/dna.ts';
import { day, flatPrices, input, obs, portfolioOf, priced, SEASON_A, SEASON_B, shares, usd } from './support/dna.ts';

/**
 * Strategy DNA, method dna-v1 (docs/contracts/phase-6-social.md section 5.1). Every expected number
 * below is worked out by hand in the comment above its test, from the rule in the document and not from
 * the code. Prices are whole dollars, holdings are whole shares, so the arithmetic can be followed.
 */

const AAPL_MSFT: Prices = { AAPL: 10, MSFT: 20 };

/** Eleven or ten days of the same prices, and the days of the observations that go with them. */
const run = (n: number, prices: Prices = AAPL_MSFT) => flatPrices(n, prices);

describe('positionsMilli', () => {
  // Prices AAPL 10 and MSFT 20, ten days, cash 6,000 each day.
  //   state X: AAPL 300 shares (3,000), MSFT 50 shares (1,000): weights 3/4 and 1/4,
  //            sum of squares 9/16 + 1/16 = 10/16, effective positions 16/10 = 1.6
  //   state Y: AAPL 200 shares (2,000), MSFT 100 shares (2,000): weights 1/2 and 1/2,
  //            sum of squares 1/2, effective positions 2
  //   six days of X and four of Y: (6 x 1.6 + 4 x 2) / 10 = 1.76, so 1760.
  it('is the mean effective number of positions times 1000', () => {
    const X = { AAPL: 300, MSFT: 50 };
    const Y = { AAPL: 200, MSFT: 100 };
    const observations = Array.from({ length: 10 }, (_, k) =>
      obs(k + 1, { cash: 6000, held: k < 6 ? X : Y, prices: AAPL_MSFT }),
    );
    const profile = strategyDna.profile(input(observations, run(10)));
    expect(profile.axes.positionsMilli).toEqual({ value: 1760, sample: 10, min: 10, note: null });
  });

  it('is exactly 1000 for a single holding, and counts SGOV as a holding', () => {
    // Everything in SGOV at 100 dollars: 100 shares. One position, no cash.
    const observations = Array.from({ length: 10 }, (_, k) =>
      obs(k + 1, { cash: 0, held: { SGOV: 100 }, prices: { SGOV: 100 } }),
    );
    const profile = strategyDna.profile(input(observations, run(10, { SGOV: 100 })));
    expect(profile.axes.positionsMilli.value).toBe(1000);
    // Cash is cash: SGOV is not part of it.
    expect(profile.axes.cashBps.value).toBe(0);
  });

  it('says no_holdings, and no value, for an agent that held only cash', () => {
    const observations = Array.from({ length: 10 }, (_, k) => obs(k + 1, { cash: 10_000 }));
    const profile = strategyDna.profile(input(observations, run(10)));
    expect(profile.axes.positionsMilli).toEqual({ value: null, sample: 0, min: 10, note: 'no_holdings' });
    expect(profile.axes.momentumMilli.value).toBeNull();
    expect(profile.axes.momentumMilli.note).toBe('no_holdings');
    expect(profile.axes.cashBps.value).toBe(10_000);
  });
});

describe('cashBps', () => {
  // Ten days with equity 10,000. Days 1 to 5: cash 5,000 and AAPL 500 shares: share 0.5.
  // Days 6 to 10: cash 2,000 and AAPL 800 shares: share 0.2. Mean (5 x 0.5 + 5 x 0.2) / 10 = 0.35: 3500.
  it('is the mean cash share of equity in basis points', () => {
    const observations = Array.from({ length: 10 }, (_, k) =>
      k < 5
        ? obs(k + 1, { cash: 5000, held: { AAPL: 500 }, prices: AAPL_MSFT })
        : obs(k + 1, { cash: 2000, held: { AAPL: 800 }, prices: AAPL_MSFT }),
    );
    const profile = strategyDna.profile(input(observations, run(10)));
    expect(profile.axes.cashBps).toEqual({ value: 3500, sample: 10, min: 10, note: null });
  });

  it('needs no prices: it is measured from equity alone, on a day without a price too', () => {
    const observations = Array.from({ length: 10 }, (_, k) =>
      obs(k + 1, { cash: 2500, held: { AAPL: 750 }, prices: AAPL_MSFT }),
    );
    // No day has prices at all. Cash is 2,500 of 10,000.
    const profile = strategyDna.profile(input(observations, [], { asOfDay: day(10) }));
    expect(profile.axes.cashBps.value).toBe(2500);
    expect(profile.axes.cashBps.sample).toBe(10);
    expect(profile.axes.positionsMilli.value).toBeNull();
  });
});

describe('turnoverBps and holdingDays', () => {
  // Eleven days at constant prices (AAPL 10), equity 10,000 each day.
  //   state X: AAPL 400 shares (4,000), cash 6,000.   state Y: AAPL 200 shares (2,000), cash 8,000.
  // Day 1 is X, bought from the opening portfolio: an opening day, left out. Days 2 to 11 alternate
  // Y, X, Y, X, Y, X, Y, X, Y, X: ten days, each moving 200 shares = 2,000 dollars, 1,000 one way.
  //   turnover = sum of one-way / mean equity x 20 / n x 10,000
  //            = 10,000 / 10,000 x 20 / 10 x 10,000 = 20,000
  //   invested on the ten days: 5 x 2,000 + 5 x 4,000 = 30,000, mean 3,000; sold on days 2, 4, 6, 8, 10:
  //   5 x 2,000 = 10,000; holding days = 3,000 x 10 / 10,000 = 3.
  const X = { AAPL: 400 };
  const Y = { AAPL: 200 };
  const alternating = Array.from({ length: 11 }, (_, k) =>
    k % 2 === 0
      ? obs(k + 1, { cash: 6000, held: X, prices: AAPL_MSFT })
      : obs(k + 1, { cash: 8000, held: Y, prices: AAPL_MSFT }),
  );

  it('works out the net turnover per 20 priced days and the implied holding period', () => {
    const profile = strategyDna.profile(input(alternating, run(11)));
    expect(profile.axes.turnoverBps).toEqual({ value: 20_000, sample: 10, min: 10, note: null });
    expect(profile.axes.holdingDays).toEqual({ value: 3, sample: 10, min: 10, note: null });
  });

  it('leaves the opening days out: days of cash before the first purchase are not turnover', () => {
    // Days 1 to 3 hold only cash, day 4 buys X (the first trade: its prior state is the opening
    // portfolio), then days 5 to 14 alternate Y, X, ... exactly as above: ten counted days, 20,000.
    const observations = [
      obs(1, { cash: 10_000 }),
      obs(2, { cash: 10_000 }),
      obs(3, { cash: 10_000 }),
      obs(4, { cash: 6000, held: X, prices: AAPL_MSFT }),
      ...Array.from({ length: 10 }, (_, k) =>
        k % 2 === 0
          ? obs(5 + k, { cash: 8000, held: Y, prices: AAPL_MSFT })
          : obs(5 + k, { cash: 6000, held: X, prices: AAPL_MSFT }),
      ),
    ];
    const profile = strategyDna.profile(input(observations, run(14)));
    expect(profile.axes.turnoverBps).toEqual({ value: 20_000, sample: 10, min: 10, note: null });
    expect(profile.observedDays).toBe(14);
  });

  it('says longer_than_window for holding days when nothing was sold', () => {
    // Eleven days of buying 10 shares a day and never selling.
    const observations = Array.from({ length: 11 }, (_, k) =>
      obs(k + 1, { cash: 9000 - k * 100, held: { AAPL: 100 + k * 10 }, prices: AAPL_MSFT, equity: 10_000 }),
    );
    const profile = strategyDna.profile(input(observations, run(11)));
    expect(profile.axes.holdingDays).toEqual({ value: null, sample: 10, min: 10, note: 'longer_than_window' });
    expect(profile.axes.turnoverBps.value).not.toBeNull();
  });

  it('says longer_than_window when the implied period is longer than the window it was measured on', () => {
    // Invested about 5,000 dollars a day and one sale of a single share (10 dollars) in ten days:
    // 5,000 x 10 / 10 = 5,000 days, far above the 10 days of the sample.
    const observations = Array.from({ length: 11 }, (_, k) =>
      obs(k + 1, {
        cash: 5000,
        held: { AAPL: k === 5 ? 499 : 500 },
        prices: AAPL_MSFT,
        equity: k === 5 ? 9990 : 10_000,
      }),
    );
    const profile = strategyDna.profile(input(observations, run(11)));
    expect(profile.axes.holdingDays.value).toBeNull();
    expect(profile.axes.holdingDays.note).toBe('longer_than_window');
  });

  it('starts again at a season boundary: the first day of a new season has the opening portfolio as its prior state', () => {
    // Six days in season A and six in season B, holding the same AAPL 400 shares throughout.
    // Day 1 and day 7 are first days of a season, so they are opening days: 5 + 5 = 10 counted days.
    // Had day 7 been compared with day 6 it would count too, and the sample would be 11.
    const observations = Array.from({ length: 12 }, (_, k) =>
      obs(k + 1, { cash: 6000, held: X, prices: AAPL_MSFT, season: k < 6 ? SEASON_A : SEASON_B }),
    );
    const profile = strategyDna.profile(input(observations, run(12)));
    expect(profile.axes.turnoverBps.sample).toBe(10);
    expect(profile.axes.turnoverBps.value).toBe(0);
  });
});

describe('swingBps', () => {
  // Eleven days of cash only. The equity rises 1 percent, falls 1 percent, and so on, starting from
  // the 10,000 dollars of the opening portfolio: returns +100, -100, +100, ... , +100 basis points.
  // Six are +100 and five are -100: n = 11, sum 100, sum of squares 11 x 10,000 = 110,000.
  //   sample variance = (110,000 - 100 x 100 / 11) / 10 = 10,909.09, standard deviation 104.45, rounded 104.
  function equities(): number[] {
    const out: number[] = [];
    let equity = usd(10_000);
    for (let k = 0; k < 11; k++) {
      equity = Math.round(k % 2 === 0 ? (equity * 101) / 100 : (equity * 99) / 100);
      out.push(equity);
    }
    return out;
  }
  const cashOnly = (i: number, equityMicro: number) => ({
    ...obs(i, { cash: 0 }),
    portfolio: { cashMicro: equityMicro, holdings: {} },
    equityMicro,
  });

  it('is the sample standard deviation of the daily returns in basis points', () => {
    const observations = equities().map((e, k) => cashOnly(k + 1, e));
    const profile = strategyDna.profile(input(observations, run(11)));
    expect(profile.axes.swingBps).toEqual({ value: 104, sample: 11, min: 10, note: null });
  });

  it('measures the first day of a season against the 10,000 dollars of the opening portfolio', () => {
    // Season A: day 1 ends at 12,000 (+2,000 bps from the start), then stays. Season B starts and
    // stays at 10,000. Returns: +2000, then eleven zeros: n = 12, sum 2,000, sum of squares 4,000,000,
    //   variance (4,000,000 - 2,000 x 2,000 / 12) / 11 = 333,333.3, standard deviation 577.35, rounded 577.
    // Had day 7 been measured against day 6 it would be -1,667 bps and the number would differ.
    const observations = Array.from({ length: 12 }, (_, k) => ({
      ...cashOnly(k + 1, usd(k < 6 ? 12_000 : 10_000)),
      seasonId: k < 6 ? SEASON_A : SEASON_B,
    }));
    const profile = strategyDna.profile(input(observations, run(12)));
    expect(profile.axes.swingBps.value).toBe(577);
    expect(profile.axes.swingBps.sample).toBe(12);
  });
});

describe('deepestFallBps', () => {
  // Cash only, equity in dollars: 10,000, 11,000, 9,900, 10,500, 8,800, 9,000, 9,500, 9,800, 9,900,
  // 9,950, 10,000. The running peak is 11,000 from day 2; the lowest point after it is 8,800:
  // (11,000 - 8,800) / 11,000 = 20 percent, so 2,000 basis points.
  const equities = [10_000, 11_000, 9900, 10_500, 8800, 9000, 9500, 9800, 9900, 9950, 10_000];
  const cashOnly = (i: number, dollars: number, season = SEASON_A) => ({
    ...obs(i, { cash: dollars, season }),
  });

  it('is the largest fall from a running peak, in basis points of the peak', () => {
    const observations = equities.map((e, k) => cashOnly(k + 1, e));
    const profile = strategyDna.profile(input(observations, run(11)));
    expect(profile.axes.deepestFallBps).toEqual({ value: 2000, sample: 11, min: 10, note: null });
  });

  it('forgets the peak at a season boundary', () => {
    // Season A sits at 12,000 for six days. Season B starts lower and only rises: 9,000, 9,500, ...
    // Carrying the 12,000 peak over would read a 25 percent fall on the first day of B. The peak of
    // "observation equity" restarts with the season, so there is no fall at all.
    const observations = [
      ...Array.from({ length: 6 }, (_, k) => cashOnly(k + 1, 12_000, SEASON_A)),
      ...[9000, 9500, 9800, 9900, 10_000, 10_100].map((e, k) => cashOnly(7 + k, e, SEASON_B)),
    ];
    const profile = strategyDna.profile(input(observations, run(12)));
    expect(profile.axes.deepestFallBps.value).toBe(0);
  });
});

describe('momentumMilli', () => {
  // Thirty priced days. Days 1 to 20: XXX, YYY and ZZZ all cost 100. From day 21: XXX 150, YYY 100,
  // ZZZ 50. Each observed day (21 to 30) looks 20 priced days back, to day 1 to 10, where every price is
  // 100: the trailing returns are XXX +50 percent, YYY 0, ZZZ -50 percent. Their percentile ranks among
  // the three are ZZZ 0, YYY 0.5, XXX 1.
  const before = flatPrices(20, { XXX: 100, YYY: 100, ZZZ: 100 });
  const later = (prices: Prices) => Array.from({ length: 10 }, (_, k) => priced(21 + k, prices));

  it('is the weighted mean of 2 x percentile - 1 over the held symbols', () => {
    // Hold XXX 20 shares (3,000) and ZZZ 20 shares (1,000), cash 6,000. Weights 3/4 and 1/4:
    // 3/4 x (2 x 1 - 1) + 1/4 x (2 x 0 - 1) = 3/4 - 1/4 = 0.5, so 500.
    const prices = { XXX: 150, YYY: 100, ZZZ: 50 };
    const observations = Array.from({ length: 10 }, (_, k) =>
      obs(21 + k, { cash: 6000, held: { XXX: 20, ZZZ: 20 }, prices }),
    );
    const profile = strategyDna.profile(input(observations, [...before, ...later(prices)]));
    expect(profile.axes.momentumMilli).toEqual({ value: 500, sample: 10, min: 10, note: null });
  });

  it('gives tied trailing returns the average of their ranks', () => {
    // XXX and YYY both gained 50 percent, ZZZ lost 50. XXX and YYY share positions 2 and 3: average
    // rank 2.5, percentile (2.5 - 1) / (3 - 1) = 0.75. Holding XXX only: 2 x 0.75 - 1 = 0.5, so 500.
    // An order-by-position rank would give XXX 0.5 or 1 and the number 0 or 1,000.
    const prices = { XXX: 150, YYY: 150, ZZZ: 50 };
    const observations = Array.from({ length: 10 }, (_, k) => obs(21 + k, { cash: 4000, held: { XXX: 40 }, prices }));
    const profile = strategyDna.profile(input(observations, [...before, ...later(prices)]));
    expect(profile.axes.momentumMilli.value).toBe(500);
  });

  it('says needs_market_history until 20 priced days exist before the first sampled day', () => {
    const prices = { XXX: 150, YYY: 100, ZZZ: 50 };
    const observations = Array.from({ length: 10 }, (_, k) =>
      obs(6 + k, { cash: 6000, held: { XXX: 20, ZZZ: 20 }, prices }),
    );
    // Fifteen priced days in all: the first sampled day has only five before it.
    const profile = strategyDna.profile(input(observations, flatPrices(15, prices)));
    expect(profile.axes.momentumMilli).toMatchObject({ value: null, note: 'needs_market_history' });
    // The other axes do not wait for it.
    expect(profile.axes.positionsMilli.value).not.toBeNull();
  });
});

describe('minimums, notes and the status of a profile', () => {
  const held = { AAPL: 300, MSFT: 50 };
  const make = (n: number) => Array.from({ length: n }, (_, k) => obs(k + 1, { cash: 6000, held, prices: AAPL_MSFT }));

  it('is forming below 10 observations: every axis has no value, its sample and a note', () => {
    const profile = strategyDna.profile(input(make(9), run(9)));
    expect(profile.status).toBe('forming');
    for (const axis of Object.values(profile.axes)) {
      expect(axis.value).toBeNull();
      expect(axis.min).toBe(DNA_MIN_DAYS);
      expect(axis.note).not.toBeNull();
    }
    expect(profile.axes.cashBps.sample).toBe(9);
  });

  it('is ready from 10 observations, and carries its method, window and ticks', () => {
    const profile = strategyDna.profile(input(make(10), run(10)));
    expect(profile.status).toBe('ready');
    expect(profile).toMatchObject({
      method: 'dna-v1',
      agentId: 'agentaaaaaaa',
      asOfDay: day(10),
      windowStartDay: day(1),
      strategySinceDay: day(0),
      pricedDays: 10,
      observedDays: 10,
      firstTickId: `${day(1)}T19:00Z`,
      lastTickId: `${day(10)}T19:00Z`,
    });
    expect(dnaProfileSchema.safeParse(profile).success).toBe(true);
  });

  it('gives each axis its own minimum: an axis with 9 usable days has no value while another has', () => {
    // Ten observations, one of them on a day without prices: the cash share and the swing use all
    // ten (equity alone), the positions use nine and say so.
    const priceDays = run(10).filter((_, k) => k !== 4);
    const profile = strategyDna.profile(input(make(10), priceDays, { asOfDay: day(10) }));
    expect(profile.axes.cashBps).toMatchObject({ sample: 10 });
    expect(profile.axes.cashBps.value).not.toBeNull();
    expect(profile.axes.swingBps.sample).toBe(10);
    expect(profile.axes.positionsMilli).toEqual({ value: null, sample: 9, min: 10, note: 'not_enough_history' });
  });

  it('counts a day with a held symbol unpriced like a day without prices', () => {
    const priceDays = run(10).map((d, k) => (k === 4 ? { ...d, pricesMicro: { AAPL: d.pricesMicro.AAPL ?? 0 } } : d));
    const profile = strategyDna.profile(input(make(10), priceDays));
    expect(profile.axes.positionsMilli.sample).toBe(9);
    expect(profile.axes.cashBps.sample).toBe(10);
  });
});

describe('the window', () => {
  const held = { AAPL: 300, MSFT: 50 };
  // Prices for 50 days and an observation for each of them.
  const observations = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, k) => obs(from + k, { cash: 6000, held, prices: AAPL_MSFT }));

  it('is the last 40 priced days, and the profile is as of the latest of them', () => {
    const profile = strategyDna.profile(input(observations(1, 50), run(50)));
    expect(profile.windowStartDay).toBe(day(11));
    expect(profile.pricedDays).toBe(DNA_WINDOW_DAYS);
    expect(profile.observedDays).toBe(DNA_WINDOW_DAYS);
    expect(profile.firstTickId).toBe(`${day(11)}T19:00Z`);
    expect(profile.asOfDay).toBe(day(50));
  });

  it('never starts before the day of the strategy: older days are left out, and the latest one before it is the prior state', () => {
    // 25 observations (days 6 to 30), the strategy changed on day 20: the window is days 20 to 30, eleven
    // days. Day 19 is the prior state of day 20 and is not in the window. The prior state is not the
    // opening portfolio, so day 20 counts as a turnover day: eleven in all, not ten.
    const profile = strategyDna.profile(input(observations(6, 30), run(30), { strategySinceDay: day(20) }));
    expect(profile.windowStartDay).toBe(day(20));
    expect(profile.observedDays).toBe(11);
    expect(profile.pricedDays).toBe(11);
    expect(profile.strategySinceDay).toBe(day(20));
    expect(profile.axes.turnoverBps.sample).toBe(11);
    expect(profile.firstTickId).toBe(`${day(20)}T19:00Z`);
  });

  it('stays forming while the strategy is younger than 10 observed days', () => {
    const profile = strategyDna.profile(input(observations(1, 30), run(30), { strategySinceDay: day(25) }));
    expect(profile.status).toBe('forming');
    expect(profile.observedDays).toBe(6);
  });
});

describe('determinism and safety', () => {
  const held = { AAPL: 300, MSFT: 50 };
  const base = () =>
    input(
      Array.from({ length: 24 }, (_, k) => obs(k + 1, { cash: 6000, held, prices: AAPL_MSFT })),
      run(24),
    );

  it('gives the same JSON, byte for byte, for the same input', () => {
    const a = JSON.stringify(strategyDna.profile(base()));
    const b = JSON.stringify(strategyDna.profile(base()));
    expect(a).toBe(b);
  });

  it('does not depend on the order in which the days arrive', () => {
    const forward = base();
    const shuffled: DnaInput = {
      ...forward,
      observations: createRng(11).shuffle(forward.observations),
      pricedDays: createRng(12).shuffle(forward.pricedDays),
    };
    expect(JSON.stringify(strategyDna.profile(shuffled))).toBe(JSON.stringify(strategyDna.profile(forward)));
  });

  it('does not change its input', () => {
    const value = base();
    const before = JSON.stringify(value);
    strategyDna.profile(value);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('never throws on input it cannot read: it returns a forming profile with empty axes', () => {
    const bad = {
      ...base(),
      observations: [{ day: 5 }, null, { ...obs(1, { cash: 1 }), equityMicro: Number.NaN }],
      pricedDays: [{ day: day(1), pricesMicro: null }, 7],
    } as unknown as DnaInput;
    const profile = strategyDna.profile(bad);
    expect(profile.status).toBe('forming');
    expect(profile.axes.positionsMilli.value).toBeNull();
    expect(() => strategyDna.profile(undefined as unknown as DnaInput)).not.toThrow();
    expect(() => strategyDna.profile({} as unknown as DnaInput)).not.toThrow();
  });

  it('keeps every axis in its range on random books', () => {
    const symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SGOV'];
    for (let seed = 1; seed <= 60; seed++) {
      const rng = createRng(seed * 7919);
      const days = rng.int(8, 60);
      const prices: Prices = {};
      for (const s of symbols) prices[s] = rng.int(5, 400);
      const priceDays = Array.from({ length: days }, (_, k) => {
        const row: Prices = {};
        for (const s of symbols) row[s] = Math.max(1, (prices[s] ?? 1) + rng.int(-3, 3) + k);
        return priced(k + 1, row);
      });
      const observations = priceDays.map((p, k) => {
        const held: Record<string, number> = {};
        let invested = 0;
        for (const s of symbols) {
          if (rng.chance(0.5)) {
            const count = rng.int(1, 8);
            const price = (p.pricesMicro[s] ?? 0) / 1_000_000;
            if (invested + count * price <= 9500) {
              held[s] = count;
              invested += count * price;
            }
          }
        }
        const cash = 10_000 - invested;
        return obs(k + 1, {
          cash,
          held,
          equity: 10_000 + rng.int(-900, 900),
          season: k < days / 2 ? SEASON_A : SEASON_B,
        });
      });
      const profile = strategyDna.profile(input(observations, priceDays));
      expect(dnaProfileSchema.safeParse(profile).success, `seed ${seed}`).toBe(true);
      const { axes } = profile;
      if (axes.positionsMilli.value !== null) {
        expect(axes.positionsMilli.value).toBeGreaterThanOrEqual(1000);
        expect(axes.positionsMilli.value).toBeLessThanOrEqual(symbols.length * 1000);
      }
      if (axes.cashBps.value !== null) {
        expect(axes.cashBps.value).toBeGreaterThanOrEqual(0);
        expect(axes.cashBps.value).toBeLessThanOrEqual(10_000);
      }
      if (axes.deepestFallBps.value !== null) {
        expect(axes.deepestFallBps.value).toBeGreaterThanOrEqual(0);
        expect(axes.deepestFallBps.value).toBeLessThanOrEqual(10_000);
      }
      if (axes.momentumMilli.value !== null) {
        expect(axes.momentumMilli.value).toBeGreaterThanOrEqual(-1000);
        expect(axes.momentumMilli.value).toBeLessThanOrEqual(1000);
      }
      if (axes.holdingDays.value !== null) expect(axes.holdingDays.value).toBeGreaterThanOrEqual(1);
      for (const axis of Object.values(axes)) {
        expect(axis.value === null || Number.isInteger(axis.value)).toBe(true);
        expect(Object.is(axis.value, -0)).toBe(false);
      }
      // Replaying the same input gives the same profile.
      expect(JSON.stringify(strategyDna.profile(input(observations, priceDays)))).toBe(JSON.stringify(profile));
    }
  });
});

describe('the valuation agrees with packages/sim', () => {
  // The profile values a holding as floor(units x price / 1,000,000) in BigInt, copied from the paper
  // engine. With holdings and prices large enough for the product to pass 2^53, two holdings give a
  // positions figure that depends on every floor. The expected figure is built from sim.valuePortfolio.
  it('values large holdings as sim.valuePortfolio does', () => {
    const rng = createRng(424242);
    for (let n = 0; n < 40; n++) {
      const symbols = ['AAPL', 'MSFT', 'NVDA'].slice(0, rng.int(2, 3));
      const holdings: Record<string, number> = {};
      const prices: Record<string, number> = {};
      for (const s of symbols) {
        // Up to 1e11 micro-shares and 2e10 micro-USD per share: the product passes 2^53 (9e15) by far,
        // while each value stays below 2e15, so the sum of three is still a safe integer.
        holdings[s] = rng.int(1_000_000, 100_000_000) * 1000 + rng.int(0, 999);
        prices[s] = rng.int(1_000_000, 20_000_000) * 1000 + rng.int(0, 999);
      }
      const observation = {
        day: '',
        tickId: '',
        seasonId: SEASON_A,
        portfolio: { cashMicro: 5_000_000_000, holdings },
        equityMicro: 10_000_000_000,
      };
      const observations = Array.from({ length: 10 }, (_, k) => ({
        ...observation,
        day: day(k + 1),
        tickId: `${day(k + 1)}T19:00Z`,
      }));
      const priceDays = Array.from({ length: 10 }, (_, k) => ({
        day: day(k + 1),
        tickId: `${day(k + 1)}T19:00Z`,
        pricesMicro: prices,
      }));
      const profile = strategyDna.profile(input(observations, priceDays));

      const sorted = Object.keys(holdings).sort();
      const values = sorted.map((s) =>
        sim.valuePortfolio({ cashMicro: 0, holdings: { [s]: holdings[s] as number } }, prices),
      );
      const total = values.reduce((sum, v) => sum + v, 0);
      let squares = 0;
      for (const v of values) squares += (v / total) ** 2;
      const expected = Math.round(1000 * (1 / squares));
      expect(profile.axes.positionsMilli.value, `case ${n}`).toBe(expected);
    }
  });

  it('keeps portfolioOf and shares honest (the builders are not the code under test)', () => {
    expect(portfolioOf(10, { AAPL: 2 })).toEqual({ cashMicro: 10_000_000, holdings: { AAPL: 2_000_000 } });
    expect(shares(1.5)).toBe(1_500_000);
  });
});
