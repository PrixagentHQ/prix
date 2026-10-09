# Worked examples for `sim.rebalance`

Four cases, each worked step by step from docs/CONTRACTS.md section 7, with every intermediate number. They exist so that `qa` can check the engine against numbers that did not come out of the engine.

How these numbers were made: each case was worked from the text of section 7, one step at a time, outside the engine's code. `sim.rebalance` was then run on the same input and returned exactly the result shown.

Cases 1 to 3 are the ones the brief asks for. Case 4 is a short extra for the two rules the others do not reach: a halted symbol, and the recomputed buy of step 6.

## Reading the numbers

- Cash, values, notionals, fees and slippage are micro-USD. `10_000_000_000` is 10,000 USD.
- Holdings and fill sizes are micro-shares. `20_000_000` is 20 shares.
- Prices are micro-USD per share. `187_430_000` is 187.43 USD.
- Targets are basis points. `4_000` is 40%.
- `M = 1_000_000`, `B = 10_000`, `FEE_BPS = 10`, `SLIPPAGE_BPS = 10`, `MIN_TRADE_BPS = 50`, `MAX_WEIGHT_BPS = 4_000`, and `B + FEE_BPS + SLIPPAGE_BPS = 10_020`.
- `value(units, price) = floor(units * price / M)`.
- Symbols and prices are labels and numbers chosen to show the arithmetic. The engine does not know the universe.
- Symbols are ordered by plain string comparison, so `AAPL < HOOD < MSFT < NVDA < PLTR < TSLA`.

## Case 1. A plain rebalance

One sell and two buys. The cash after the sell pays for both buys in full, so nothing is scaled.

```json
{
  "portfolio": { "cashMicro": 2500000000, "holdings": { "AAPL": 20000000, "MSFT": 9500000 } },
  "prices": { "AAPL": 187430000, "MSFT": 412170000, "NVDA": 131290000 },
  "targetsBps": { "AAPL": 2500, "MSFT": 4000, "NVDA": 3000 },
  "halted": []
}
```

Step 1. Equity and the smallest trade.

- `value(AAPL) = floor(20_000_000 * 187_430_000 / M) = 3_748_600_000`
- `value(MSFT) = floor(9_500_000 * 412_170_000 / M) = 3_915_615_000`
- `V = 2_500_000_000 + 3_748_600_000 + 3_915_615_000 = 10_164_215_000`
- `minTrade = floor(10_164_215_000 * 50 / B) = 50_821_075`

Step 2. Current value, target value and delta.

| Symbol | current | target = floor(V * targetBps / B) | delta |
|---|---|---|---|
| AAPL | 3_748_600_000 | floor(10_164_215_000 * 2_500 / B) = 2_541_053_750 | -1_207_546_250 |
| MSFT | 3_915_615_000 | floor(10_164_215_000 * 4_000 / B) = 4_065_686_000 | 150_071_000 |
| NVDA | 0 | floor(10_164_215_000 * 3_000 / B) = 3_049_264_500 | 3_049_264_500 |

Step 3. Every `|delta|` is at least `minTrade = 50_821_075`, so all three trade. AAPL sells; MSFT and NVDA buy.

Step 4. Sell AAPL.

- `sellUnits = min(20_000_000, floor(1_207_546_250 * M / 187_430_000)) = min(20_000_000, 6_442_651) = 6_442_651`
- `notional = floor(6_442_651 * 187_430_000 / M) = floor(1_207_546_076.93) = 1_207_546_076`
- `slippage = min(ceil(1_207_546_076 * 10 / B), notional) = min(1_207_547, 1_207_546_076) = 1_207_547`
- `fee = min(ceil(1_207_546_076 * 10 / B), notional - slippage) = min(1_207_547, 1_206_338_529) = 1_207_547`
- `cash = 2_500_000_000 + 1_207_546_076 - 1_207_547 - 1_207_547 = 3_705_130_982`
- AAPL units left: `20_000_000 - 6_442_651 = 13_557_349`

Step 5. Is the cash enough?

- `W = 150_071_000 + 3_049_264_500 = 3_199_335_500`
- `A = 3_705_130_982`
- `W * 10_020 = 32_057_341_710_000`, `A * B = 37_051_309_820_000`
- `W * 10_020` is not greater than `A * B`, so the buys are not scaled: `wanted = delta`.

Step 6. Buy MSFT, then NVDA.

MSFT, `wanted = 150_071_000`:

- `buyUnits = floor(150_071_000 * M / 412_170_000) = 364_099`
- `notional = floor(364_099 * 412_170_000 / M) = floor(150_070_684.83) = 150_070_684`
- `slippage = ceil(150_070_684 * 10 / B) = 150_071`
- `fee = ceil(150_070_684 * 10 / B) = 150_071`
- `cost = 150_070_684 + 150_071 + 150_071 = 150_370_826`, which is not more than the cash left, 3_705_130_982
- `cash = 3_705_130_982 - 150_370_826 = 3_554_760_156`
- MSFT units: `9_500_000 + 364_099 = 9_864_099`

NVDA, `wanted = 3_049_264_500`:

- `buyUnits = floor(3_049_264_500 * M / 131_290_000) = 23_225_413`
- `notional = floor(23_225_413 * 131_290_000 / M) = floor(3_049_264_472.77) = 3_049_264_472`
- `slippage = ceil(3_049_264_472 * 10 / B) = 3_049_265`
- `fee = ceil(3_049_264_472 * 10 / B) = 3_049_265`
- `cost = 3_049_264_472 + 3_049_265 + 3_049_265 = 3_055_363_002`, which is not more than the cash left, 3_554_760_156
- `cash = 3_554_760_156 - 3_055_363_002 = 499_397_154`
- NVDA units: `0 + 23_225_413 = 23_225_413`

Step 7. The result.

- `value(AAPL) = floor(13_557_349 * 187_430_000 / M) = 2_541_053_923`
- `value(MSFT) = floor(9_864_099 * 412_170_000 / M) = 4_065_685_684`
- `value(NVDA) = floor(23_225_413 * 131_290_000 / M) = 3_049_264_472`
- `equityAfterMicro = 499_397_154 + 2_541_053_923 + 4_065_685_684 + 3_049_264_472 = 10_155_401_233`
- `costMicro = 2 * 1_207_547 + 2 * 150_071 + 2 * 3_049_265 = 8_813_766`

Two things worth checking here:

- The equity fell by `10_164_215_000 - 10_155_401_233 = 8_813_767`, which is `costMicro + 1`. The extra micro-USD is rounding, not a charge: AAPL was worth 3_748_600_000 as one position, and the part sold plus the part kept floor to `1_207_546_076 + 2_541_053_923 = 3_748_599_999`. `equityBefore - equityAfter` is therefore not always equal to `costMicro`.
- MSFT, which was bought, is worth 4_065_685_684 afterwards. That is at most `floor(V * 4_000 / B) = 4_065_686_000`.

```json
{
  "portfolio": {
    "cashMicro": 499397154,
    "holdings": { "AAPL": 13557349, "MSFT": 9864099, "NVDA": 23225413 }
  },
  "fills": [
    { "symbol": "AAPL", "side": "sell", "unitsMicro": 6442651, "priceMicro": 187430000, "notionalMicro": 1207546076, "feeMicro": 1207547, "slippageMicro": 1207547 },
    { "symbol": "MSFT", "side": "buy", "unitsMicro": 364099, "priceMicro": 412170000, "notionalMicro": 150070684, "feeMicro": 150071, "slippageMicro": 150071 },
    { "symbol": "NVDA", "side": "buy", "unitsMicro": 23225413, "priceMicro": 131290000, "notionalMicro": 3049264472, "feeMicro": 3049265, "slippageMicro": 3049265 }
  ],
  "equityBeforeMicro": 10164215000,
  "equityAfterMicro": 10155401233,
  "costMicro": 8813766
}
```

## Case 2. Buys scaled because cash is short

The targets add up to exactly 100%. After the sell has paid its fee and slippage, the cash cannot cover both buys and their costs, so step 5 scales them.

```json
{
  "portfolio": { "cashMicro": 120000000, "holdings": { "TSLA": 40000000 } },
  "prices": { "AAPL": 187430000, "MSFT": 412170000, "TSLA": 251370000 },
  "targetsBps": { "AAPL": 4000, "MSFT": 4000, "TSLA": 2000 },
  "halted": []
}
```

Step 1.

- `value(TSLA) = floor(40_000_000 * 251_370_000 / M) = 10_054_800_000`
- `V = 120_000_000 + 10_054_800_000 = 10_174_800_000`
- `minTrade = floor(10_174_800_000 * 50 / B) = 50_874_000`

Step 2.

| Symbol | current | target = floor(V * targetBps / B) | delta |
|---|---|---|---|
| AAPL | 0 | floor(10_174_800_000 * 4_000 / B) = 4_069_920_000 | 4_069_920_000 |
| MSFT | 0 | floor(10_174_800_000 * 4_000 / B) = 4_069_920_000 | 4_069_920_000 |
| TSLA | 10_054_800_000 | floor(10_174_800_000 * 2_000 / B) = 2_034_960_000 | -8_019_840_000 |

Step 3. Every `|delta|` is at least `minTrade = 50_874_000`. TSLA sells; AAPL and MSFT buy.

Step 4. Sell TSLA.

- `sellUnits = min(40_000_000, floor(8_019_840_000 * M / 251_370_000)) = min(40_000_000, 31_904_523) = 31_904_523`
- `notional = floor(31_904_523 * 251_370_000 / M) = floor(8_019_839_946.51) = 8_019_839_946`
- `slippage = min(ceil(8_019_839_946 * 10 / B), notional) = 8_019_840`
- `fee = min(ceil(8_019_839_946 * 10 / B), notional - slippage) = min(8_019_840, 8_011_820_106) = 8_019_840`
- `cash = 120_000_000 + 8_019_839_946 - 8_019_840 - 8_019_840 = 8_123_800_266`
- TSLA units left: `40_000_000 - 31_904_523 = 8_095_477`

Step 5. Is the cash enough?

- `W = 4_069_920_000 + 4_069_920_000 = 8_139_840_000`
- `A = 8_123_800_266`
- `W * 10_020 = 81_561_196_800_000`, `A * B = 81_238_002_660_000`
- `W * 10_020` is greater than `A * B`, so every buy is scaled:
  `wanted = floor(delta * A * B / (W * 10_020))`
- For AAPL and for MSFT alike:
  `wanted = floor(4_069_920_000 * 8_123_800_266 * 10_000 / (8_139_840_000 * 10_020))`
  `= floor(330_632_171_785_987_200_000_000 / 81_561_196_800_000) = 4_053_792_547`
  (the remainder is 73_746_950_400_000). The numerator is far outside the safe integer range, which is why this is BigInt arithmetic.

Step 6. Buy AAPL, then MSFT.

AAPL, `wanted = 4_053_792_547`:

- `buyUnits = floor(4_053_792_547 * M / 187_430_000) = 21_628_301`
- `notional = floor(21_628_301 * 187_430_000 / M) = floor(4_053_792_456.43) = 4_053_792_456`
- `slippage = ceil(4_053_792_456 * 10 / B) = 4_053_793`
- `fee = ceil(4_053_792_456 * 10 / B) = 4_053_793`
- `cost = 4_053_792_456 + 4_053_793 + 4_053_793 = 4_061_900_042`, which is not more than the cash left, 8_123_800_266
- `cash = 8_123_800_266 - 4_061_900_042 = 4_061_900_224`
- AAPL units: `21_628_301`

MSFT, `wanted = 4_053_792_547`:

- `buyUnits = floor(4_053_792_547 * M / 412_170_000) = 9_835_244`
- `notional = floor(9_835_244 * 412_170_000 / M) = floor(4_053_792_519.48) = 4_053_792_519`
- `slippage = ceil(4_053_792_519 * 10 / B) = 4_053_793`
- `fee = ceil(4_053_792_519 * 10 / B) = 4_053_793`
- `cost = 4_053_792_519 + 4_053_793 + 4_053_793 = 4_061_900_105`, which is not more than the cash left, 4_061_900_224, so nothing is recomputed
- `cash = 4_061_900_224 - 4_061_900_105 = 119`
- MSFT units: `9_835_244`

Step 7.

- `value(AAPL) = floor(21_628_301 * 187_430_000 / M) = 4_053_792_456`
- `value(MSFT) = floor(9_835_244 * 412_170_000 / M) = 4_053_792_519`
- `value(TSLA) = floor(8_095_477 * 251_370_000 / M) = 2_034_960_053`
- `equityAfterMicro = 119 + 4_053_792_456 + 4_053_792_519 + 2_034_960_053 = 10_142_545_147`
- `costMicro = 2 * 8_019_840 + 2 * 4_053_793 + 2 * 4_053_793 = 32_254_852`

The equity fell by `10_174_800_000 - 10_142_545_147 = 32_254_853`, again `costMicro + 1`: the TSLA sold plus the TSLA kept floor to `8_019_839_946 + 2_034_960_053 = 10_054_799_999`.

```json
{
  "portfolio": {
    "cashMicro": 119,
    "holdings": { "AAPL": 21628301, "MSFT": 9835244, "TSLA": 8095477 }
  },
  "fills": [
    { "symbol": "TSLA", "side": "sell", "unitsMicro": 31904523, "priceMicro": 251370000, "notionalMicro": 8019839946, "feeMicro": 8019840, "slippageMicro": 8019840 },
    { "symbol": "AAPL", "side": "buy", "unitsMicro": 21628301, "priceMicro": 187430000, "notionalMicro": 4053792456, "feeMicro": 4053793, "slippageMicro": 4053793 },
    { "symbol": "MSFT", "side": "buy", "unitsMicro": 9835244, "priceMicro": 412170000, "notionalMicro": 4053792519, "feeMicro": 4053793, "slippageMicro": 4053793 }
  ],
  "equityBeforeMicro": 10174800000,
  "equityAfterMicro": 10142545147,
  "costMicro": 32254852
}
```

## Case 3. Closing very small positions

Three holdings are left without a target. Each is far below `minTrade`, and each is still sold in full, because a held symbol with a target of zero always is. The fourth holding has a target close to what it is worth, and does not trade.

The three small positions show the three ways the sell formulas round: an ordinary small sale, a sale worth one micro-USD where the two `min` clamps apply, and a sale worth nothing at all.

```json
{
  "portfolio": { "cashMicro": 6000000000, "holdings": { "AAPL": 37, "HOOD": 1, "MSFT": 9700000, "PLTR": 1 } },
  "prices": { "AAPL": 187430000, "HOOD": 250000, "MSFT": 412170000, "PLTR": 1500000 },
  "targetsBps": { "MSFT": 4000 },
  "halted": []
}
```

Step 1.

- `value(AAPL) = floor(37 * 187_430_000 / M) = floor(6_934.91) = 6_934`
- `value(HOOD) = floor(1 * 250_000 / M) = floor(0.25) = 0`
- `value(MSFT) = floor(9_700_000 * 412_170_000 / M) = 3_998_049_000`
- `value(PLTR) = floor(1 * 1_500_000 / M) = floor(1.5) = 1`
- `V = 6_000_000_000 + 6_934 + 0 + 3_998_049_000 + 1 = 9_998_055_935`
- `minTrade = floor(9_998_055_935 * 50 / B) = floor(49_990_279.675) = 49_990_279`

Step 2.

| Symbol | current | target = floor(V * targetBps / B) | delta |
|---|---|---|---|
| AAPL | 6_934 | 0 | -6_934 |
| HOOD | 0 | 0 | 0 |
| MSFT | 3_998_049_000 | floor(9_998_055_935 * 4_000 / B) = floor(3_999_222_374.0) = 3_999_222_374 | 1_173_374 |
| PLTR | 1 | 0 | -1 |

Step 3.

- AAPL, HOOD and PLTR are held and have a target of zero. They are sold in full, although 6_934, 0 and 1 are all below `minTrade = 49_990_279`.
- MSFT has a target, and `|delta| = 1_173_374` is below `minTrade`. It does not trade.

Step 4. Sells, in ascending symbol order: AAPL, HOOD, PLTR.

AAPL, `sellUnits = 37` (all units):

- `notional = floor(37 * 187_430_000 / M) = 6_934`
- `slippage = min(ceil(6_934 * 10 / B), 6_934) = min(ceil(6.934), 6_934) = 7`
- `fee = min(ceil(6_934 * 10 / B), 6_934 - 7) = min(7, 6_927) = 7`
- `cash = 6_000_000_000 + 6_934 - 7 - 7 = 6_000_006_920`

HOOD, `sellUnits = 1` (all units):

- `notional = floor(1 * 250_000 / M) = 0`
- `slippage = min(ceil(0 * 10 / B), 0) = 0`
- `fee = min(ceil(0 * 10 / B), 0 - 0) = 0`
- `cash = 6_000_006_920 + 0 - 0 - 0 = 6_000_006_920`
- `sellUnits` is not zero, so this is a fill, with a notional of zero. The position is gone and nothing was received for it.

PLTR, `sellUnits = 1` (all units):

- `notional = floor(1 * 1_500_000 / M) = 1`
- `slippage = min(ceil(1 * 10 / B), 1) = min(ceil(0.001), 1) = min(1, 1) = 1`
- `fee = min(ceil(1 * 10 / B), 1 - 1) = min(1, 0) = 0`
- `cash = 6_000_006_920 + 1 - 1 - 0 = 6_000_006_920`
- The slippage takes the whole micro-USD and the fee is clamped to what is left, which is nothing. The cash added is zero, never negative.

Steps 5 and 6. No delta that trades is positive. There are no buys.

Step 7.

- `value(MSFT) = 3_998_049_000`, unchanged
- `equityAfterMicro = 6_000_006_920 + 3_998_049_000 = 9_998_055_920`
- `costMicro = (7 + 7) + (0 + 0) + (1 + 0) = 15`
- The equity fell by `9_998_055_935 - 9_998_055_920 = 15`.

```json
{
  "portfolio": {
    "cashMicro": 6000006920,
    "holdings": { "MSFT": 9700000 }
  },
  "fills": [
    { "symbol": "AAPL", "side": "sell", "unitsMicro": 37, "priceMicro": 187430000, "notionalMicro": 6934, "feeMicro": 7, "slippageMicro": 7 },
    { "symbol": "HOOD", "side": "sell", "unitsMicro": 1, "priceMicro": 250000, "notionalMicro": 0, "feeMicro": 0, "slippageMicro": 0 },
    { "symbol": "PLTR", "side": "sell", "unitsMicro": 1, "priceMicro": 1500000, "notionalMicro": 1, "feeMicro": 0, "slippageMicro": 1 }
  ],
  "equityBeforeMicro": 9998055935,
  "equityAfterMicro": 9998055920,
  "costMicro": 15
}
```

## Case 4. A halted symbol and the recomputed buy

An extra case with numbers small enough to check in your head. Amounts this small do not occur in the league; they are here because they reach two rules the other cases do not.

TSLA is halted. It is held, it has a target, and it is worth more than its target, so without the halt it would be sold. The buy of HOOD is not scaled in step 5, yet its cost comes to one micro-USD more than the cash, because the fee and the slippage are each rounded up. Step 6 then recomputes it once.

```json
{
  "portfolio": { "cashMicro": 401, "holdings": { "TSLA": 300 } },
  "prices": { "HOOD": 1000000, "TSLA": 2000000 },
  "targetsBps": { "HOOD": 4000, "TSLA": 1000 },
  "halted": ["TSLA"]
}
```

Step 1. A halted symbol is valued like any other.

- `value(TSLA) = floor(300 * 2_000_000 / M) = 600`
- `V = 401 + 600 = 1_001`
- `minTrade = floor(1_001 * 50 / B) = floor(5.005) = 5`

Step 2. Only symbols that are not halted. TSLA is left out here and in every later step.

| Symbol | current | target = floor(V * targetBps / B) | delta |
|---|---|---|---|
| HOOD | 0 | floor(1_001 * 4_000 / B) = floor(400.4) = 400 | 400 |

Step 3. `400 >= 5`, so HOOD buys.

Step 4. There are no sells.

Step 5.

- `W = 400`, `A = 401`
- `W * 10_020 = 4_008_000`, `A * B = 4_010_000`
- `W * 10_020` is not greater than `A * B`, so the buy is not scaled: `wanted = 400`.

Step 6. Buy HOOD.

- `buyUnits = floor(400 * M / 1_000_000) = 400`
- `notional = floor(400 * 1_000_000 / M) = 400`
- `slippage = ceil(400 * 10 / B) = ceil(0.4) = 1`
- `fee = ceil(400 * 10 / B) = ceil(0.4) = 1`
- `cost = 400 + 1 + 1 = 402`, which is more than the cash left, 401. Recompute once:
- `wanted = floor((401 - 2) * B / 10_020) = floor(3_990_000 / 10_020) = floor(398.2) = 398`
- `buyUnits = floor(398 * M / 1_000_000) = 398`
- `notional = floor(398 * 1_000_000 / M) = 398`
- `slippage = ceil(398 * 10 / B) = ceil(0.398) = 1`
- `fee = ceil(398 * 10 / B) = ceil(0.398) = 1`
- `cost = 398 + 1 + 1 = 400`
- `cash = 401 - 400 = 1`
- HOOD units: `398`

Step 7.

- `value(HOOD) = 398`, `value(TSLA) = 600`
- `equityAfterMicro = 1 + 398 + 600 = 999`
- `costMicro = 1 + 1 = 2`
- TSLA still has 300 units, and no fill names it.

```json
{
  "portfolio": {
    "cashMicro": 1,
    "holdings": { "HOOD": 398, "TSLA": 300 }
  },
  "fills": [
    { "symbol": "HOOD", "side": "buy", "unitsMicro": 398, "priceMicro": 1000000, "notionalMicro": 398, "feeMicro": 1, "slippageMicro": 1 }
  ],
  "equityBeforeMicro": 1001,
  "equityAfterMicro": 999,
  "costMicro": 2
}
```

## Readings of section 7 that these cases depend on

Where the contract leaves a detail open, the engine does the following. Each is also in the build report.

- Ascending symbol order is plain string comparison by code unit, not a locale-aware comparison. It is the same on every machine.
- The holdings of the result are written in ascending symbol order, so the same portfolio always serializes to the same JSON, whatever order the input was in.
- A sell is a fill whenever `sellUnits` is above zero, also when its notional is zero (HOOD in case 3). A buy needs both `buyUnits` and `notional` above zero, as step 6 says.
- An entry with zero units in the input is not a holding. It needs no price and is not in the result.
- A target of zero means the same as no target.
- `rebalance` throws, and returns nothing, when a held or targeted symbol has no price; when a price is not a positive safe integer; when the cash or a holding is not a safe integer that is zero or positive; when a target is not an integer from 0 to 4_000, or the targets add up to more than 10_000; and when a number in the result would not be a safe integer. Targets arrive validated by `parseDecisionOutput`, so a bad target here is a bug in the caller, not a model's mistake.
