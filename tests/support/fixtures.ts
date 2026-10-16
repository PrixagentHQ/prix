import type {
  AgentRecord,
  AgentStats,
  DecisionRow,
  Division,
  MarketSnapshot,
  OtherChainRead,
  PortfolioState,
  PriceMap,
  RowStatus,
  Season,
  Tick,
} from '@prix/contracts';
import {
  agentNameKey,
  CHAIN_ID,
  FEED_STALE_AFTER_SECONDS,
  MAX_HALTED_FEEDS,
  STARTING_CASH_MICRO,
  tickIdFor,
} from '@prix/contracts';

/**
 * Fixtures shared by every suite. Nothing here reads a clock or a random source:
 * every id, time and price is fixed, so a failing test fails the same way every time.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** A valid 12-character id. Ids made with the same prefix sort in the order of `n`. */
export function testId(prefix: string, n: number): string {
  let rest = '';
  let value = n;
  for (let i = 0; i < 12 - prefix.length; i += 1) {
    rest = LETTERS[value % 26] + rest;
    value = Math.floor(value / 26);
  }
  const id = prefix + rest;
  if (!/^[a-z2-7]{12}$/.test(id)) throw new Error(`testId: "${id}" is not a valid id`);
  return id;
}

/** A lower-case address that belongs to nobody. */
export function testAddress(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

/**
 * The test universe: the UNIVERSE_SIZE symbols of `UNIVERSE` in `packages/market`, in universe order
 * (the Stock Tokens by symbol, then BTC and ETH, docs/CONTRACTS.md section 21, then BNB, HYPE and SOL
 * from Arbitrum One, section 23), each with a starting price in micro-USD. tests/unit/market.test.ts
 * and tests/unit/universe-kinds.test.ts fail if the lists ever differ, so a regenerated universe is
 * noticed in one place.
 */
export const TEST_PRICES: Readonly<PriceMap> = Object.freeze({
  AAPL: 187_370_000,
  AMD: 164_250_000,
  AMZN: 201_800_000,
  COIN: 255_120_000,
  CRCL: 172_660_000,
  GME: 41_870_000,
  GOOGL: 176_930_000,
  INTC: 39_450_000,
  META: 588_310_000,
  MSFT: 431_220_000,
  MSTR: 243_050_000,
  MU: 168_590_000,
  NVDA: 182_410_000,
  PLTR: 73_920_000,
  QQQ: 702_640_000,
  SGOV: 100_260_000,
  SPCX: 80_260_000,
  SPY: 571_030_000,
  TSLA: 248_760_000,
  USO: 281_140_000,
  BTC: 121_480_250_000,
  ETH: 4_386_120_000,
  BNB: 612_340_000,
  HYPE: 38_710_000,
  SOL: 152_880_000,
});
export const TEST_SYMBOLS: readonly string[] = Object.freeze(Object.keys(TEST_PRICES));
/**
 * The crypto assets of the test universe (sections 21 and 23): their feeds never open or close the
 * market.
 */
export const TEST_CRYPTO_SYMBOLS: readonly string[] = Object.freeze(['BTC', 'ETH', 'BNB', 'HYPE', 'SOL']);
/** The crypto assets whose feeds are read on Arbitrum One (section 23). */
export const TEST_ARBITRUM_SYMBOLS: readonly string[] = Object.freeze(['BNB', 'HYPE', 'SOL']);
/** The Stock Tokens of the test universe, in universe order. */
export const TEST_STOCK_SYMBOLS: readonly string[] = Object.freeze(
  TEST_SYMBOLS.filter((symbol) => !TEST_CRYPTO_SYMBOLS.includes(symbol)),
);

/** Season 1 of the tests: Monday 2026-10-05 00:00 UTC, 28 days. */
export const SEASON_1: Season = Object.freeze({
  id: 'seasononeaaa',
  number: 1,
  startsAt: '2026-10-05T00:00:00.000Z',
  endsAt: '2026-11-02T00:00:00.000Z',
});

export function utc(iso: string): Date {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`utc: bad time ${iso}`);
  return date;
}

/** The starting portfolio, written out by hand from docs/CONTRACTS.md section 7. */
export function startingPortfolio(): PortfolioState {
  return { cashMicro: STARTING_CASH_MICRO, holdings: {} };
}

/** The starting stats, written out by hand from docs/CONTRACTS.md section 9. */
export function startingStats(): AgentStats {
  return {
    equityMicro: STARTING_CASH_MICRO,
    peakEquityMicro: STARTING_CASH_MICRO,
    seasonReturnBps: 0,
    maxDrawdownBps: 0,
    tradeCount: 0,
    decidedCount: 0,
    noDecisionCount: 0,
    skippedCount: 0,
    tradingDays: 0,
    lastDay: null,
    daily: [],
  };
}

export interface AgentOptions {
  n: number;
  division?: Division;
  owner?: string;
  name?: string;
  prompt?: string;
  modelKeyId?: string | null;
  createdAt?: string;
  overrides?: Partial<AgentRecord>;
}

/** The marker that makes every fixture prompt unique, so a fake model can tell agents apart. */
export function promptMarker(n: number): string {
  return `marker-${n}-end`;
}

export function makeAgent(options: AgentOptions): AgentRecord {
  const division = options.division ?? 'open';
  const name = options.name ?? `Agent ${testId('', options.n).slice(6)}`;
  const createdAt = options.createdAt ?? '2026-10-05T08:00:00.000Z';
  return {
    id: testId('agent', options.n),
    owner: options.owner ?? testAddress(1000 + options.n),
    name,
    nameKey: agentNameKey(name),
    division,
    prompt:
      options.prompt ??
      `Strategy ${promptMarker(options.n)}: hold the largest companies and change the portfolio rarely.`,
    promptPublic: false,
    summary: 'Holds the largest companies and trades rarely.',
    summaryStatus: 'ready',
    modelKeyId: options.modelKeyId ?? null,
    status: 'active',
    pausedReason: null,
    hidden: false,
    createdAt,
    updatedAt: createdAt,
    strategyChangedAt: createdAt,
    promptChangeDay: null,
    promptChangeCount: 0,
    ...options.overrides,
  };
}

export interface SnapshotOptions {
  prices?: Readonly<PriceMap>;
  /** Symbols whose feed is stale at this snapshot. */
  stale?: readonly string[];
  /** The market is quiet: no feed of the universe has published for hours, as on a weekend. */
  quiet?: boolean;
  /** A feed returned an answer that cannot be trusted. */
  invalid?: boolean;
  /** Every RPC endpoint failed. */
  rpcDown?: boolean;
  blockNumber?: number;
  staleAfterSeconds?: number;
  /** The provenance of a second feed chain (section 23); left out when not given, as in a stage 1 tick. */
  otherChains?: readonly OtherChainRead[];
}

/**
 * A market snapshot as `packages/market` returns one, by the rules of docs/CONTRACTS.md
 * section 15: the market is open if and only if the RPC answered, no feed answer is invalid,
 * at most MAX_HALTED_FEEDS Stock Token symbols are halted (section 21: crypto feeds never count) and some feed has published recently. The
 * reasons win in the order `rpc_unavailable`, `feed_invalid`, `feeds_stale`. An RPC failure
 * has no prices and block number zero.
 */
export function makeSnapshot(now: Date, options: SnapshotOptions = {}): MarketSnapshot {
  const takenAt = now.toISOString();
  if (options.rpcDown) {
    return { takenAt, chainId: CHAIN_ID, blockNumber: 0, open: false, closedReason: 'rpc_unavailable', prices: [] };
  }
  const prices = options.prices ?? TEST_PRICES;
  const stale = new Set(options.stale ?? []);
  const staleAfter = options.staleAfterSeconds ?? FEED_STALE_AFTER_SECONDS;
  // Section 21: only Stock Token feeds open or close the market; a stale crypto feed halts its own symbol.
  const staleStocks = [...stale].filter((symbol) => !TEST_CRYPTO_SYMBOLS.includes(symbol)).length;
  // In a quiet market every feed is hours old but inside its 24 hour heartbeat: fresh, and silent.
  const freshAge = options.quiet ? 14 * 3_600 : 42;
  const points = Object.keys(prices).map((symbol) => {
    const ageSeconds = stale.has(symbol) ? staleAfter + 7_200 : freshAge;
    return {
      symbol,
      priceMicro: prices[symbol] as number,
      updatedAt: new Date(now.getTime() - ageSeconds * 1_000).toISOString(),
      ageSeconds,
      fresh: !stale.has(symbol),
    };
  });
  const closedReason = options.invalid
    ? 'feed_invalid'
    : staleStocks > MAX_HALTED_FEEDS || options.quiet
      ? 'feeds_stale'
      : null;
  return {
    takenAt,
    chainId: CHAIN_ID,
    blockNumber: options.blockNumber ?? 1_234_567,
    open: closedReason === null,
    closedReason,
    prices: points,
    ...(options.otherChains === undefined ? {} : { otherChains: options.otherChains.map((read) => ({ ...read })) }),
  };
}

export function makeTick(
  now: Date,
  options: { daily?: boolean; status?: Tick['status']; snapshot?: MarketSnapshot } = {},
): Tick {
  const status = options.status ?? 'processing';
  return {
    id: tickIdFor(now),
    seasonId: SEASON_1.id,
    daily: options.daily ?? false,
    snapshot: options.snapshot ?? makeSnapshot(now),
    status,
    createdAt: now.toISOString(),
    completedAt: status === 'complete' ? now.toISOString() : null,
  };
}

export interface RowOptions {
  agent: AgentRecord;
  tickId: string;
  status?: RowStatus;
  code?: string | null;
  portfolio?: PortfolioState;
  equityMicro?: number;
  fillCount?: number;
  createdAt?: string;
  model?: string | null;
}

/** The label the house model writes into a row: `house:` and the model id. */
export const HOUSE_MODEL_ID = '@cf/test/house-model';
export const HOUSE_LABEL = `house:${HOUSE_MODEL_ID}`;

/** A decision row that satisfies `decisionRowSchema`. Fills are placeholders of the right shape. */
export function makeRow(options: RowOptions): DecisionRow {
  const status = options.status ?? 'decided';
  const portfolio = options.portfolio ?? startingPortfolio();
  const fills = Array.from({ length: options.fillCount ?? 0 }, () => ({
    symbol: 'NVDA',
    side: 'buy' as const,
    unitsMicro: 1_000_000,
    priceMicro: 182_410_000,
    notionalMicro: 182_410_000,
    feeMicro: 182_410,
    slippageMicro: 182_410,
  }));
  return {
    agentId: options.agent.id,
    tickId: options.tickId,
    seasonId: SEASON_1.id,
    division: options.agent.division,
    status,
    code: options.code ?? (status === 'decided' ? null : status === 'skipped' ? 'not_reached' : 'invalid_json'),
    targetsBps: status === 'decided' ? {} : null,
    reason: status === 'decided' ? 'Keeps the portfolio as it is.' : null,
    fills: status === 'decided' ? fills : [],
    halted: [],
    portfolio,
    equityMicro: options.equityMicro ?? portfolio.cashMicro,
    costMicro: 0,
    model: options.model !== undefined ? options.model : status === 'skipped' ? null : HOUSE_LABEL,
    strategyAt: status === 'skipped' ? null : options.agent.strategyChangedAt,
    createdAt: options.createdAt ?? `${options.tickId.slice(0, 16)}:01.000Z`,
  };
}
