import type {
  ChainEvent,
  ChainRecordEngine,
  ChainRecordInput,
  ChainRecordResult,
  DayPrices,
  ListingDay,
  RawTransfer,
  UniverseToken,
  UtcDay,
} from '@prix/contracts';
import { isStockToken, STARTING_CASH_MICRO } from '@prix/contracts';

/**
 * The estimated record of a listed on-chain agent, method `chain-v1`.
 * Transfers are flows: only the price move of what was held at the start of a day counts.
 * It leaves out everything in CHAIN_EXCLUSIONS. docs/contracts/phase-2-reputation.md section 5.
 */

/**
 * A day counts as exposed only when the holdings at its start are worth at least this much
 * (100 USD, in micro-USD). Below it the wallet is dust and earns no record day.
 * The operator may move this constant to the contract.
 */
export const MIN_EXPOSED_START_VALUE_MICRO = 100_000_000n;

/** The input of the engine plus the optional claim day: days before it never count as exposed. */
export type ChainBuildInput = ChainRecordInput & { claimDay?: UtcDay };

type Balances = Map<string, bigint>;
/** Every Stock Token of the universe has 18 decimals (packages/market/RESEARCH.md). */
const WEI_PER_TOKEN = 10n ** 18n;

/**
 * The symbols a record may count, each with its wei per token. Null means every symbol at 10^18,
 * the behaviour of `chainRecord`, which trusts its input to hold Stock Tokens only.
 */
type Units = ReadonlyMap<string, bigint> | null;

const counts = (units: Units, symbol: string): boolean => units === null || units.has(symbol);

function holdingsValue(b: Balances, prices: DayPrices | null, units: Units): bigint {
  if (!prices) return 0n;
  let total = 0n;
  for (const [symbol, wei] of b) {
    const p = prices.pricesMicro[symbol];
    const unit = units === null ? WEI_PER_TOKEN : units.get(symbol);
    if (unit !== undefined && wei > 0n && typeof p === 'number' && Number.isFinite(p) && p > 0) {
      total += (wei * BigInt(Math.floor(p))) / unit;
    }
  }
  return total;
}

function parseWei(s: string): bigint {
  return /^\d+$/.test(s) ? BigInt(s) : 0n;
}

/** Applies one event. Returns true if the balance would have gone below zero and was clamped. */
function apply(b: Balances, e: ChainEvent): boolean {
  const amount = parseWei(e.amountWei);
  const cur = b.get(e.symbol) ?? 0n;
  if (e.direction === 'in') {
    b.set(e.symbol, cur + amount);
    return false;
  }
  if (amount > cur) {
    b.set(e.symbol, 0n);
    return true;
  }
  b.set(e.symbol, cur - amount);
  return false;
}

/** Math.round(num / den) for BigInt with den > 0: a half rounds toward positive infinity. */
function roundDiv(num: bigint, den: bigint): bigint {
  const n = 2n * num + den;
  const d = 2n * den;
  let q = n / d;
  if (n % d !== 0n && n < 0n) q -= 1n;
  return q;
}

function build(input: ChainBuildInput, units: Units): ChainRecordResult {
  const b: Balances = new Map();
  for (const [symbol, wei] of Object.entries(input.balancesWei)) {
    if (counts(units, symbol)) b.set(symbol, parseWei(wei));
  }
  const events = units === null ? input.events : input.events.filter((e) => counts(units, e.symbol));
  let next = 0;
  let prev: DayPrices | null = input.baseDayPrices;
  let index = BigInt(Math.floor(input.indexMicro));
  let recordDay = input.recordDay;
  const rows: ListingDay[] = [];

  for (const prices of input.days) {
    // Events of earlier days, including days without a price, are applied before this day starts.
    let clamped = 0;
    while (next < events.length && (events[next] as ChainEvent).day < prices.day) {
      if (apply(b, events[next] as ChainEvent)) clamped += 1;
      next += 1;
    }
    const last = rows[rows.length - 1];
    if (last) last.unpricedEventCount += clamped;

    const start = holdingsValue(b, prev, units);
    let returnBps = 0;
    let exposed = false;
    if (prev === null) {
      index = BigInt(STARTING_CASH_MICRO);
    } else if (start >= MIN_EXPOSED_START_VALUE_MICRO && (!input.claimDay || prices.day >= input.claimDay)) {
      exposed = true;
      returnBps = Number(roundDiv((holdingsValue(b, prices, units) - start) * 10_000n, start));
      returnBps = returnBps === 0 ? 0 : returnBps;
      index = (index * BigInt(10_000 + returnBps)) / 10_000n;
    }

    let eventCount = 0;
    let unpricedEventCount = 0;
    while (next < events.length && (events[next] as ChainEvent).day === prices.day) {
      eventCount += 1;
      if (apply(b, events[next] as ChainEvent)) unpricedEventCount += 1;
      next += 1;
    }
    rows.push({
      day: prices.day,
      returnBps,
      exposed,
      indexMicro: Number(index),
      valueMicro: Number(holdingsValue(b, prices, units)),
      eventCount,
      unpricedEventCount,
    });
    prev = prices;
    recordDay = prices.day;
  }

  const balancesWei: Record<string, string> = {};
  for (const [symbol, wei] of [...b].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (wei > 0n) balancesWei[symbol] = wei.toString();
  }
  return { newDays: rows, balancesWei, recordDay, indexMicro: Number(index) };
}

function classify(all: readonly RawTransfer[], dayOfBlock: (block: number) => UtcDay, units: Units): ChainEvent[] {
  // A transfer of a symbol the record does not count is left out before swaps are found.
  const raw = units === null ? all : all.filter((t) => counts(units, t.symbol));
  const byTx = new Map<string, RawTransfer[]>();
  for (const t of raw) {
    const list = byTx.get(t.txHash);
    if (list) list.push(t);
    else byTx.set(t.txHash, [t]);
  }
  const swapTx = new Set<string>();
  for (const [tx, list] of byTx) {
    const ins = list.filter((t) => t.direction === 'in');
    const outs = list.filter((t) => t.direction === 'out');
    if (ins.some((i) => outs.some((o) => o.symbol !== i.symbol))) swapTx.add(tx);
  }
  return [...raw]
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    .map((t) => ({
      block: t.block,
      logIndex: t.logIndex,
      txHash: t.txHash,
      symbol: t.symbol,
      direction: t.direction,
      amountWei: t.amountWei,
      kind: swapTx.has(t.txHash) ? ('swap' as const) : ('transfer' as const),
      day: dayOfBlock(t.block),
    }));
}

/**
 * The engine over the Stock Tokens of `universe` (section 21): only `kind === 'stock'` entries count,
 * each at its own `tokenDecimals`. A transfer, a checkpoint balance or a day price of a crypto asset,
 * or of a symbol outside the universe, is left out, so a coin price never moves a chain record.
 */
export function createChainRecord(universe: readonly UniverseToken[]): ChainRecordEngine & {
  build(input: ChainBuildInput): ChainRecordResult;
} {
  const units: ReadonlyMap<string, bigint> = new Map(
    universe.filter(isStockToken).map((t) => [t.symbol, 10n ** BigInt(t.tokenDecimals)] as const),
  );
  return {
    build: (input: ChainBuildInput) => build(input, units),
    classify: (raw, dayOfBlock) => classify(raw, dayOfBlock, units),
  };
}

/**
 * The engine without a universe: it counts every symbol it is given, at 18 decimals. Its callers must
 * pass Stock Token transfers only (the wallet reader reads Stock Token addresses only). Prefer
 * `createChainRecord(UNIVERSE)`, which enforces it.
 */
export const chainRecord: ChainRecordEngine & { build(input: ChainBuildInput): ChainRecordResult } = {
  build: (input: ChainBuildInput) => build(input, null),
  classify: (raw, dayOfBlock) => classify(raw, dayOfBlock, null),
};
