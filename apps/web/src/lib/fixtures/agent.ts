import type { AgentPublic, DecisionPublic, Fill, HoldingPublic } from '@prix/contracts';
import { FEE_BPS, SCORING_METHOD, SLIPPAGE_BPS } from '@prix/contracts';
import {
  fixtureId,
  GAMMA_SCOUT_CREATED_AT,
  GAMMA_SCOUT_SUMMARY,
  LEAGUE_TICK,
  MACRO_TOURIST_CREATED_AT,
  MACRO_TOURIST_SUMMARY,
  PRO_RANKED_COUNT,
  SEASON,
  SLOW_COMPOUNDER_CREATED_AT,
  SLOW_COMPOUNDER_DAILY,
  SLOW_COMPOUNDER_SUMMARY,
  usd,
} from './league.ts';

// The league rows quote the same summary and creation time, so both are defined in league.ts.
export { SLOW_COMPOUNDER_CREATED_AT, SLOW_COMPOUNDER_SUMMARY };

/**
 * Agent pages. Three agents have one:
 *
 * - Slow Compounder, the Open league leader, from the sample data of
 *   docs/reviews/phase-1-studies.md. Seven rows, one per trading day: five decisions (one of
 *   them with no trade), one row with no decision and one skipped day.
 * - Macro Tourist, a Pro agent whose owner removed its model key: paused, and its model is `none`.
 * - Gamma Scout, a Pro agent paused because its provider refused the key three rounds in a row.
 */

const MICRO = 1_000_000;

/** A fill of about `amount` USD at `price`, with the fee and slippage of the simulation rules. */
export function fill(symbol: string, side: Fill['side'], amount: number, price: number): Fill {
  const priceMicro = usd(price);
  const unitsMicro = Math.floor((usd(amount) * MICRO) / priceMicro);
  const notionalMicro = Math.floor((unitsMicro * priceMicro) / MICRO);
  return {
    symbol,
    side,
    unitsMicro,
    priceMicro,
    notionalMicro,
    feeMicro: Math.ceil((notionalMicro * FEE_BPS) / 10_000),
    slippageMicro: Math.ceil((notionalMicro * SLIPPAGE_BPS) / 10_000),
  };
}

/** One row. `hour` is the UTC hour of its tick, 15 to 19. `at` is when the row was written. */
export function row(
  day: string,
  hour: number,
  equityMicro: number,
  status: DecisionPublic['status'],
  code: string | null,
  reason: string | null,
  fills: Fill[],
): DecisionPublic {
  return {
    tickId: `${day}T${hour}:00Z`,
    at: `${day}T${hour}:02:11.000Z`,
    status,
    code,
    reason,
    fills,
    halted: [],
    equityMicro,
    costMicro: fills.reduce((sum, entry) => sum + entry.feeMicro + entry.slippageMicro, 0),
  };
}

/** A holding worth `value` USD at `price`, to within one micro-share, in a portfolio worth `equityMicro`. */
export function holding(symbol: string, value: number, price: number, equityMicro: number): HoldingPublic {
  const priceMicro = usd(price);
  const unitsMicro = Math.ceil((usd(value) * MICRO) / priceMicro);
  const valueMicro = Math.floor((unitsMicro * priceMicro) / MICRO);
  return { symbol, unitsMicro, priceMicro, valueMicro, weightBps: Math.round((valueMicro * 10_000) / equityMicro) };
}

export function cashOf(
  equityMicro: number,
  holdings: readonly HoldingPublic[],
): { cashMicro: number; cashWeightBps: number } {
  const cashMicro = equityMicro - holdings.reduce((sum, entry) => sum + entry.valueMicro, 0);
  return { cashMicro, cashWeightBps: Math.round((cashMicro * 10_000) / equityMicro) };
}

export const shortOf = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
const tradesIn = (rows: readonly DecisionPublic[]): number => rows.reduce((sum, entry) => sum + entry.fills.length, 0);

// --- Slow Compounder ---------------------------------------------------------------------------

export const SLOW_COMPOUNDER_ID = fixtureId('Slow Compounder');
export const SLOW_COMPOUNDER_OWNER = '0x7a3f9b2c4d5e6f708192a3b4c5d6e7f80112c91e';

const EQUITY = usd(10_684);

/** An Open agent decides at the daily tick, 15:00 UTC. Its value that day comes from the daily series. */
function daily(
  day: string,
  status: DecisionPublic['status'],
  code: string | null,
  reason: string | null,
  fills: Fill[],
): DecisionPublic {
  const point = SLOW_COMPOUNDER_DAILY.find((entry) => entry.day === day);
  return row(day, 15, point ? point.equityMicro : EQUITY, status, code, reason, fills);
}

/** Newest first. Within a row, sells come before buys, each in symbol order. */
const DECISIONS: DecisionPublic[] = [
  daily(
    '2026-10-06',
    'decided',
    null,
    'Semiconductor strength has held for five sessions, so the portfolio adds to its strongest position within the 40% limit.',
    [fill('NVDA', 'buy', 320, 182.41)],
  ),
  daily('2026-10-05', 'decided', null, 'Weights are within two points of target, so trading would only add fees.', []),
  daily('2026-10-02', 'decided', null, "AMD's steadier trend replaces Intel after three weak sessions.", [
    fill('INTC', 'sell', 1_190, 36.12),
    fill('AMD', 'buy', 1_233, 212.35),
  ]),
  daily('2026-10-01', 'no_decision', 'schema_mismatch', null, []),
  daily(
    '2026-09-30',
    'decided',
    null,
    'Adds two index funds and a small BTC position to spread risk away from single names.',
    [
      fill('AMZN', 'sell', 612, 236.02),
      fill('GOOGL', 'sell', 607, 254.11),
      fill('META', 'sell', 498, 739.52),
      fill('MSFT', 'sell', 205, 505.4),
      fill('TSLA', 'sell', 409, 448.77),
      fill('BTC', 'buy', 520, 117_982.4),
      fill('QQQ', 'buy', 921, 601.2),
      fill('SPY', 'buy', 1_023, 668.4),
    ],
  ),
  daily('2026-09-29', 'skipped', 'allocation_exhausted', null, []),
  daily('2026-09-28', 'decided', null, 'Starts with eight large, liquid names and keeps the rest in cash.', [
    fill('AAPL', 'buy', 1_500, 242.1),
    fill('AMZN', 'buy', 600, 231.4),
    fill('GOOGL', 'buy', 600, 251.2),
    fill('INTC', 'buy', 1_200, 36.44),
    fill('META', 'buy', 500, 742.5),
    fill('MSFT', 'buy', 2_000, 498.6),
    fill('NVDA', 'buy', 1_800, 164.05),
    fill('TSLA', 'buy', 400, 438.9),
  ]),
];

const HOLDINGS: HoldingPublic[] = [
  holding('NVDA', 2_243.64, 182.41, EQUITY),
  holding('MSFT', 1_923.12, 512.3, EQUITY),
  holding('AAPL', 1_602.6, 247.85, EQUITY),
  holding('AMD', 1_282.08, 214.6, EQUITY),
  holding('SPY', 1_068.4, 671.25, EQUITY),
  holding('QQQ', 961.56, 605.9, EQUITY),
  // A coin (docs/CONTRACTS.md section 21): a fraction of one BTC, at a price of six figures.
  holding('BTC', 534.2, 121_345.67, EQUITY),
];

export const SLOW_COMPOUNDER: AgentPublic = {
  id: SLOW_COMPOUNDER_ID,
  name: 'Slow Compounder',
  division: 'open',
  ownerShort: shortOf(SLOW_COMPOUNDER_OWNER),
  model: { kind: 'house' },
  status: 'active',
  createdAt: SLOW_COMPOUNDER_CREATED_AT,
  summary: SLOW_COMPOUNDER_SUMMARY,
  summaryStatus: 'ready',
  prompt: null,
  season: SEASON,
  rank: 1,
  unrankedReason: null,
  rankedCount: 10,
  stats: {
    equityMicro: EQUITY,
    peakEquityMicro: EQUITY,
    seasonReturnBps: 684,
    maxDrawdownBps: 192,
    tradeCount: tradesIn(DECISIONS),
    decidedCount: 5,
    noDecisionCount: 1,
    skippedCount: 1,
    tradingDays: 7,
    lastDay: '2026-10-06',
    daily: [...SLOW_COMPOUNDER_DAILY],
  },
  holdings: HOLDINGS,
  ...cashOf(EQUITY, HOLDINGS),
  asOfTickId: LEAGUE_TICK,
  decisions: DECISIONS,
  method: SCORING_METHOD,
  house: false,
  // Part B of the holders' round: the owner turned "Owner holds $PRIX" on, so the design check sees the mark.
  ownerHolds: true,
};

// --- Macro Tourist: a Pro agent whose model key was removed ----------------------------------------

export const KEY_REMOVED_OWNER = '0x51c2e8a9047b3d6f1e0a9c8b7d6e5f4a3b2c1d0e';
export const KEY_REMOVED_PROMPT =
  'Hold broad funds only. Lean toward Treasury bills when oil is rising and toward equities when it is falling. Change at most one position per round.';

const TOURIST_EQUITY = usd(9_912);

/** Newest first. The owner changed the strategy during the 17:00 round, so the agent sat that round out. */
const TOURIST_DECISIONS: DecisionPublic[] = [
  row('2026-10-02', 19, TOURIST_EQUITY, 'decided', null, 'Oil is flat on the day, so nothing changes.', []),
  row('2026-10-02', 18, usd(9_915.4), 'decided', null, 'Moves part of the oil position into Treasury bills.', [
    fill('USO', 'sell', 991, 71.84),
    fill('SGOV', 'buy', 985, 100.42),
  ]),
  row('2026-10-02', 17, usd(9_921.1), 'skipped', 'changed_this_round', null, []),
  row('2026-10-02', 16, usd(9_921.1), 'decided', null, 'Holds: the rise in oil is inside its usual range.', []),
  row('2026-10-02', 15, usd(9_930.75), 'decided', null, 'Holds: no fund has moved more than half a percent.', []),
];

const TOURIST_HOLDINGS: HoldingPublic[] = [
  holding('SGOV', 4_956, 100.42, TOURIST_EQUITY),
  holding('USO', 1_982.4, 71.3, TOURIST_EQUITY),
];

export const KEY_REMOVED_AGENT: AgentPublic = {
  id: fixtureId('Macro Tourist'),
  name: 'Macro Tourist',
  division: 'pro',
  ownerShort: shortOf(KEY_REMOVED_OWNER),
  model: { kind: 'none' },
  status: 'paused',
  createdAt: MACRO_TOURIST_CREATED_AT,
  summary: MACRO_TOURIST_SUMMARY,
  summaryStatus: 'ready',
  prompt: null,
  season: SEASON,
  rank: null,
  unrankedReason: 'inactive',
  rankedCount: PRO_RANKED_COUNT,
  stats: {
    equityMicro: TOURIST_EQUITY,
    peakEquityMicro: usd(10_055.2),
    seasonReturnBps: -88,
    maxDrawdownBps: 143,
    tradeCount: 4,
    decidedCount: 23,
    noDecisionCount: 1,
    skippedCount: 1,
    tradingDays: 5,
    lastDay: '2026-10-02',
    daily: [
      { day: '2026-09-28', equityMicro: usd(10_031.6) },
      { day: '2026-09-29', equityMicro: usd(10_055.2) },
      { day: '2026-09-30', equityMicro: usd(9_958.4) },
      { day: '2026-10-01', equityMicro: usd(9_936.9) },
      { day: '2026-10-02', equityMicro: TOURIST_EQUITY },
    ],
  },
  holdings: TOURIST_HOLDINGS,
  ...cashOf(TOURIST_EQUITY, TOURIST_HOLDINGS),
  asOfTickId: '2026-10-02T19:00Z',
  decisions: TOURIST_DECISIONS,
  method: SCORING_METHOD,
  house: false,
};

// --- Gamma Scout: a Pro agent paused because its key keeps being refused ---------------------------

export const KEY_FAILING_OWNER = '0x9d4b7e2a1c0f8e6d5b3a2918f7e6d5c4b3a29180';
export const KEY_FAILING_PROMPT =
  'Trade the three most volatile names in the universe. Buy after two falling rounds in a row, sell after two rising ones. Never hold more than 25% in one name.';

const SCOUT_EQUITY = usd(9_869);

/**
 * Newest first. The provider refused the key in three rounds in a row, and the agent was
 * paused after the third. Friday's last round could not be processed at all.
 */
const SCOUT_DECISIONS: DecisionPublic[] = [
  row('2026-10-05', 19, SCOUT_EQUITY, 'no_decision', 'provider_rejected', null, []),
  row('2026-10-05', 18, usd(9_874.3), 'no_decision', 'provider_rejected', null, []),
  row('2026-10-05', 17, usd(9_881.9), 'no_decision', 'provider_rejected', null, []),
  row('2026-10-05', 16, usd(9_896.2), 'decided', null, 'Tesla has fallen two rounds in a row, so the position grows.', [
    fill('TSLA', 'buy', 493, 441.36),
  ]),
  row('2026-10-05', 15, usd(9_902.8), 'decided', null, 'Palantir rose two rounds in a row, so part of it is sold.', [
    fill('PLTR', 'sell', 512, 187.9),
  ]),
  row('2026-10-02', 19, usd(9_947.5), 'skipped', 'internal_error', null, []),
];

const SCOUT_HOLDINGS: HoldingPublic[] = [
  holding('TSLA', 2_368.56, 438.2, SCOUT_EQUITY),
  holding('NVDA', 1_973.8, 181.95, SCOUT_EQUITY),
  holding('PLTR', 1_480.35, 186.4, SCOUT_EQUITY),
];

export const KEY_FAILING_AGENT: AgentPublic = {
  id: fixtureId('Gamma Scout'),
  name: 'Gamma Scout',
  division: 'pro',
  ownerShort: shortOf(KEY_FAILING_OWNER),
  model: { kind: 'own', providerLabel: 'OpenAI', model: 'gpt-4.1-mini' },
  status: 'paused',
  createdAt: GAMMA_SCOUT_CREATED_AT,
  summary: GAMMA_SCOUT_SUMMARY,
  summaryStatus: 'ready',
  prompt: KEY_FAILING_PROMPT,
  season: SEASON,
  rank: null,
  unrankedReason: 'inactive',
  rankedCount: PRO_RANKED_COUNT,
  stats: {
    equityMicro: SCOUT_EQUITY,
    peakEquityMicro: usd(10_078),
    seasonReturnBps: -131,
    maxDrawdownBps: 207,
    tradeCount: 9,
    decidedCount: 24,
    noDecisionCount: 3,
    skippedCount: 1,
    tradingDays: 6,
    lastDay: '2026-10-05',
    daily: [
      { day: '2026-09-28', equityMicro: usd(10_019.4) },
      { day: '2026-09-29', equityMicro: usd(10_078) },
      { day: '2026-09-30', equityMicro: usd(9_984.6) },
      { day: '2026-10-01', equityMicro: usd(9_931.2) },
      { day: '2026-10-02', equityMicro: usd(9_947.5) },
      { day: '2026-10-05', equityMicro: SCOUT_EQUITY },
    ],
  },
  holdings: SCOUT_HOLDINGS,
  ...cashOf(SCOUT_EQUITY, SCOUT_HOLDINGS),
  asOfTickId: '2026-10-05T19:00Z',
  decisions: SCOUT_DECISIONS,
  method: SCORING_METHOD,
  house: false,
};

// --- The stress agent: the longest name, a full set of holdings and rows, a published prompt -------

/** 32 wide letters: the longest name the contract allows, in the widest letters of the face. */
export const STRESS_NAME = 'W'.repeat(32);
export const STRESS_OWNER = '0x2b8c4e6a0d1f3957b8a6c4e2d0f1a3b5c7d9e0f1';
export const STRESS_PROMPT =
  'Hold every symbol of the universe at about four percent each and keep the rest in cash. Every round, compare each name with its own average of the last five rounds; trim what is far above it and add to what is far below it. Never trade a name that is halted. Explain every change in one sentence that names the symbol it concerns.';

const STRESS_EQUITY = usd(10_052);
const STRESS_SYMBOLS = [
  'NVDA',
  'MSFT',
  'AAPL',
  'AMD',
  'SPY',
  'QQQ',
  'TSLA',
  'PLTR',
  'AMZN',
  'GOOGL',
  'META',
  'INTC',
  'COIN',
  'GME',
  'MSTR',
  'MU',
  'USO',
  'SGOV',
  'CRCL',
  'SPCX',
  'BTC',
  'ETH',
];
/** The coins at prices of their own scale, so the widest figures of the universe are seen; the rest are made up. */
const STRESS_COIN_PRICES: Readonly<Record<string, number>> = { BTC: 121_345.67, ETH: 4_486.12 };
const stressPrice = (symbol: string, index: number): number => STRESS_COIN_PRICES[symbol] ?? 50 + index * 23.4;
const STRESS_HOLDINGS: HoldingPublic[] = STRESS_SYMBOLS.map((symbol, index) =>
  holding(symbol, 400 + index * 3.17, stressPrice(symbol, index), STRESS_EQUITY),
);
const STRESS_DAYS = ['2026-10-05', '2026-10-02', '2026-10-01', '2026-09-30', '2026-09-29', '2026-09-28'];
/** Thirty rows, newest first, five per day: a mix of every status. */
const STRESS_DECISIONS: DecisionPublic[] = Array.from({ length: 30 }, (_, index) => {
  const day = STRESS_DAYS[Math.floor(index / 5)] ?? '2026-09-28';
  const hour = 19 - (index % 5);
  const equity = usd(10_052 - index * 1.7);
  const symbol = STRESS_SYMBOLS[index % STRESS_SYMBOLS.length] ?? 'SPY';
  if (index % 7 === 3) return row(day, hour, equity, 'no_decision', 'schema_mismatch', null, []);
  if (index % 11 === 5) return row(day, hour, equity, 'skipped', 'allocation_exhausted', null, []);
  return row(day, hour, equity, 'decided', null, `Trims ${symbol}, which is far above its five-round average.`, [
    fill(symbol, index % 2 === 0 ? 'sell' : 'buy', 120 + index, stressPrice(symbol, index % STRESS_SYMBOLS.length)),
  ]);
});

export const STRESS_AGENT: AgentPublic = {
  id: fixtureId(STRESS_NAME),
  name: STRESS_NAME,
  division: 'pro',
  ownerShort: shortOf(STRESS_OWNER),
  model: { kind: 'own', providerLabel: 'Anthropic', model: 'claude-sonnet-4-5' },
  status: 'active',
  createdAt: '2026-09-28T09:00:00.000Z',
  summary:
    'Holds every symbol of the universe at about four percent each and trims or adds against each one’s own five-round average.',
  summaryStatus: 'ready',
  prompt: STRESS_PROMPT,
  season: SEASON,
  rank: null,
  unrankedReason: 'min_decisions',
  rankedCount: PRO_RANKED_COUNT,
  stats: {
    equityMicro: STRESS_EQUITY,
    peakEquityMicro: usd(10_140),
    seasonReturnBps: 52,
    maxDrawdownBps: 88,
    tradeCount: tradesIn(STRESS_DECISIONS),
    decidedCount: STRESS_DECISIONS.filter((entry) => entry.status === 'decided').length,
    noDecisionCount: STRESS_DECISIONS.filter((entry) => entry.status === 'no_decision').length,
    skippedCount: STRESS_DECISIONS.filter((entry) => entry.status === 'skipped').length,
    tradingDays: 6,
    lastDay: '2026-10-05',
    daily: [
      { day: '2026-09-28', equityMicro: usd(10_020) },
      { day: '2026-09-29', equityMicro: usd(10_140) },
      { day: '2026-09-30', equityMicro: usd(10_060) },
      { day: '2026-10-01', equityMicro: usd(10_031) },
      { day: '2026-10-02', equityMicro: usd(10_070) },
      { day: '2026-10-05', equityMicro: STRESS_EQUITY },
    ],
  },
  holdings: STRESS_HOLDINGS,
  ...cashOf(STRESS_EQUITY, STRESS_HOLDINGS),
  asOfTickId: '2026-10-05T19:00Z',
  decisions: STRESS_DECISIONS,
  method: SCORING_METHOD,
  house: false,
};

/** Every agent that has a page, by id. */
export const AGENT_PAGES: ReadonlyMap<string, AgentPublic> = new Map(
  [SLOW_COMPOUNDER, KEY_REMOVED_AGENT, KEY_FAILING_AGENT, STRESS_AGENT].map((agent) => [agent.id, agent]),
);
