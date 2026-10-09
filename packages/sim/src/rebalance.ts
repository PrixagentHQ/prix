import type { Fill, RebalanceInput, RebalanceResult, TokenSymbol } from '@prix/contracts';
import { BPS, FEE_BPS, MAX_WEIGHT_BPS, MIN_TRADE_BPS, SLIPPAGE_BPS } from '@prix/contracts';
import { B, ceilBps, compareSymbols, floorBps, label, M, minOf, toAmount, valueAt } from './math.ts';
import { readPortfolio, readPrice, writePortfolio } from './portfolio.ts';

const FEE = BigInt(FEE_BPS);
const SLIPPAGE = BigInt(SLIPPAGE_BPS);
const MIN_TRADE = BigInt(MIN_TRADE_BPS);
/** `B + FEE_BPS + SLIPPAGE_BPS`: what a buyer pays for 10,000 of notional, before rounding. */
const GROSS = B + FEE + SLIPPAGE;

/** One symbol that is held or targeted, as the engine works on it. `units` changes as fills happen. */
interface Line {
  symbol: TokenSymbol;
  price: bigint;
  units: bigint;
  /** Zero when the symbol is not targeted. */
  targetBps: bigint;
  halted: boolean;
  /** `target - current` in micro-USD at the equity before trading. Zero for a halted symbol, which never trades. */
  delta: bigint;
}

/**
 * Reads the targets. They arrive validated by `parseDecisionOutput`, so a target that breaks
 * a rule here is a programming error in the caller and throws; nothing is clamped or repaired.
 * A target of zero means the same as a symbol that is left out, and is dropped.
 */
function readTargets(targetsBps: Record<TokenSymbol, number>): Map<TokenSymbol, bigint> {
  const targets = new Map<TokenSymbol, bigint>();
  let total = 0;
  for (const symbol of Object.keys(targetsBps)) {
    const bps = targetsBps[symbol];
    if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > MAX_WEIGHT_BPS) {
      throw new Error(`@prix/sim: the target of ${label(symbol)} must be an integer from 0 to ${MAX_WEIGHT_BPS}`);
    }
    total += bps;
    if (bps > 0) targets.set(symbol, BigInt(bps));
  }
  if (total > BPS) {
    throw new Error(`@prix/sim: the targets add up to more than ${BPS} basis points`);
  }
  return targets;
}

function fill(line: Line, side: Fill['side'], units: bigint, notional: bigint, fee: bigint, slippage: bigint): Fill {
  const name = `the ${side} of ${label(line.symbol)}`;
  return {
    symbol: line.symbol,
    side,
    unitsMicro: toAmount(units, `${name}: unitsMicro`),
    priceMicro: toAmount(line.price, `${name}: priceMicro`),
    notionalMicro: toAmount(notional, `${name}: notionalMicro`),
    feeMicro: toAmount(fee, `${name}: feeMicro`),
    slippageMicro: toAmount(slippage, `${name}: slippageMicro`),
  };
}

/** What buying `wanted` micro-USD of a symbol comes to (section 7, step 6). */
function quoteBuy(wanted: bigint, price: bigint) {
  const units = (wanted * M) / price;
  const notional = valueAt(units, price);
  const slippage = ceilBps(notional, SLIPPAGE);
  const fee = ceilBps(notional, FEE);
  return { units, notional, slippage, fee, cost: notional + slippage + fee };
}

/**
 * Trades a portfolio toward target weights. docs/CONTRACTS.md section 7 specifies every step;
 * the step numbers below are the ones used there.
 *
 * Pure: it reads its input and builds a new result. It throws on a programming error (a missing
 * or invalid price, a portfolio or a target that is not valid) and when a number in the result
 * would not be a safe integer. It never returns a partly applied rebalance.
 */
export function rebalance(input: RebalanceInput): RebalanceResult {
  const { cash: cashBefore, held } = readPortfolio(input.portfolio);
  const targets = readTargets(input.targetsBps);
  const halted = new Set<TokenSymbol>(input.halted);

  // Every symbol that is held or targeted, in ascending order. Each one must have a price.
  const unitsBySymbol = new Map<TokenSymbol, bigint>();
  for (const { symbol, units } of held) unitsBySymbol.set(symbol, units);
  const symbols = [...new Set<TokenSymbol>([...unitsBySymbol.keys(), ...targets.keys()])].sort(compareSymbols);
  const lines: Line[] = symbols.map((symbol) => ({
    symbol,
    price: readPrice(input.prices, symbol),
    units: unitsBySymbol.get(symbol) ?? 0n,
    targetBps: targets.get(symbol) ?? 0n,
    halted: halted.has(symbol),
    delta: 0n,
  }));

  // Step 1. The equity before trading, halted symbols included, and the smallest change that trades.
  let equityBefore = cashBefore;
  for (const line of lines) equityBefore += valueAt(line.units, line.price);
  const minTrade = floorBps(equityBefore, MIN_TRADE);

  // Step 2. The change wanted in every symbol that is not halted.
  const tradable = lines.filter((line) => !line.halted);
  for (const line of tradable) {
    line.delta = floorBps(equityBefore, line.targetBps) - valueAt(line.units, line.price);
  }

  let cash = cashBefore;
  let cost = 0n;
  const fills: Fill[] = [];

  // Steps 3 and 4. Sells, in ascending symbol order.
  for (const line of tradable) {
    let sellUnits = 0n;
    if (line.targetBps === 0n) {
      // A held symbol with no target is sold in full, however small it is.
      sellUnits = line.units;
    } else if (line.delta < 0n && -line.delta >= minTrade) {
      sellUnits = minOf(line.units, (-line.delta * M) / line.price);
    }
    if (sellUnits === 0n) continue;

    const notional = valueAt(sellUnits, line.price);
    const slippage = minOf(ceilBps(notional, SLIPPAGE), notional);
    const fee = minOf(ceilBps(notional, FEE), notional - slippage);
    cash += notional - slippage - fee;
    cost += slippage + fee;
    line.units -= sellUnits;
    fills.push(fill(line, 'sell', sellUnits, notional, fee, slippage));
  }

  // Step 5. Buys are scaled together when the cash after the sells cannot pay for all of them.
  const buys = tradable.filter((line) => line.delta > 0n && line.delta >= minTrade);
  let wantedTotal = 0n;
  for (const line of buys) wantedTotal += line.delta;
  const cashAfterSells = cash;
  const scaled = wantedTotal * GROSS > cashAfterSells * B;

  // Step 6. Buys, in ascending symbol order.
  for (const line of buys) {
    const wanted = scaled ? (line.delta * cashAfterSells * B) / (wantedTotal * GROSS) : line.delta;
    let quote = quoteBuy(wanted, line.price);
    if (quote.cost > cash) {
      // Recomputed once, with room for the two amounts that are rounded up.
      quote = quoteBuy(cash > 2n ? ((cash - 2n) * B) / GROSS : 0n, line.price);
    }
    if (quote.units === 0n || quote.notional === 0n) continue;

    cash -= quote.cost;
    cost += quote.slippage + quote.fee;
    line.units += quote.units;
    fills.push(fill(line, 'buy', quote.units, quote.notional, quote.fee, quote.slippage));
  }

  // Step 7. The new portfolio and its value at the same prices.
  let equityAfter = cash;
  for (const line of lines) equityAfter += valueAt(line.units, line.price);

  return {
    portfolio: writePortfolio(cash, lines),
    fills,
    equityBeforeMicro: toAmount(equityBefore, 'equityBeforeMicro'),
    equityAfterMicro: toAmount(equityAfter, 'equityAfterMicro'),
    costMicro: toAmount(cost, 'costMicro'),
  };
}
