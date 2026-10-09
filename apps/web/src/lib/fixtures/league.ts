import type {
  Division,
  LeagueResponse,
  LeagueState,
  MarketStatus,
  RowStatus,
  Season,
  StandingRow,
  UnrankedReason,
} from '@prix/contracts';
import { SCORING_METHOD, STARTING_CASH_MICRO } from '@prix/contracts';

/**
 * League, season and market fixtures. The names and numbers follow the sample data of
 * docs/reviews/phase-1-studies.md: Open division, Season 1, day 9 of 28, Tuesday 6 October 2026.
 * Every symbol is one of the universe of packages/market: the twenty Stock Tokens, and BTC and
 * ETH (docs/CONTRACTS.md section 21). The house agents hold Stock Tokens only, as their strategies
 * do; a few of the others hold a coin, so a card and a page can be seen with one.
 */

/** An id made from a name: twelve characters of lower-case base32, padded with "a". */
export function fixtureId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z2-7]/g, '')
    .padEnd(12, 'a')
    .slice(0, 12);
}

/** A USD amount in micro-USD. */
export function usd(amount: number): number {
  return Math.round(amount * 1_000_000);
}

/** The portfolio value at a return of `bps` basis points since the start of the season. */
function equityAt(bps: number): number {
  return Math.round(STARTING_CASH_MICRO * (1 + bps / 10_000));
}

export const SEASON: Season = {
  id: fixtureId('season one'),
  number: 1,
  startsAt: '2026-09-28T00:00:00.000Z',
  endsAt: '2026-10-26T00:00:00.000Z',
};

/** The daily tick of Tuesday 6 October, which the sample ranks are as of. Ticks run from 15:00 to 19:00 UTC. */
export const LEAGUE_TICK = '2026-10-06T15:00Z';
export const LEAGUE_COMPUTED_AT = '2026-10-06T15:04:10.000Z';

/** Slow Compounder's value at the end of each of its seven trading days. */
export const SLOW_COMPOUNDER_DAILY: readonly { day: string; equityMicro: number }[] = [
  { day: '2026-09-28', equityMicro: usd(10_042.1) },
  { day: '2026-09-29', equityMicro: usd(10_118.55) },
  { day: '2026-09-30', equityMicro: usd(10_231.4) },
  { day: '2026-10-01', equityMicro: usd(10_035.2) },
  { day: '2026-10-02', equityMicro: usd(10_274.8) },
  { day: '2026-10-05', equityMicro: usd(10_512.65) },
  { day: '2026-10-06', equityMicro: usd(10_684) },
];

/**
 * Daily values for a sparkline: a rise to a peak, the fall that is the agent's largest
 * drawdown, then a path to the season return. Seven values, or the first `days` of them
 * with the last one at the season return.
 */
function sparkFor(returnBps: number, drawdownBps: number, days = 7): number[] {
  const end = returnBps / 10_000;
  const fall = drawdownBps / 10_000;
  // The highest peak from which a fall of `fall` still ends at or below the final value.
  const peak = ((1 + end) / (1 - fall) - 1) * 0.35;
  const trough = (1 + peak) * (1 - fall) - 1;
  const path = [
    peak * 0.4,
    peak * 0.8,
    peak,
    trough,
    trough + (end - trough) * 0.4,
    trough + (end - trough) * 0.75,
    end,
  ];
  const shown = days >= path.length ? path : [...path.slice(0, days - 1), end];
  return shown.map((point) => Math.round(STARTING_CASH_MICRO * (1 + point)));
}

interface SampleAgent {
  name: string;
  returnBps: number;
  drawdownBps: number;
  trades: number;
  tradingDays: number;
  spark: number[];
  /** What happened at the league's tick. Null for an agent that had no row there. */
  lastStatus: RowStatus | null;
  /** Null for a ranked agent. */
  unrankedReason: UnrankedReason | null;
  /** What the agent does, as its own page says it. The API sends null until one is written. */
  summary: string;
  createdAt: string;
  /** True for an agent that Prix itself runs. Left out means false. */
  house?: boolean;
  /** What the agent holds at the league's tick (docs/CONTRACTS.md section 17.2). */
  holds: Holds;
}

/**
 * The three largest holdings with their weights in basis points, largest first, and the weight
 * of cash, as the API values them at the prices of the agent's latest row.
 */
interface Holds {
  top: readonly (readonly [symbol: string, weightBps: number])[];
  cash: number;
}

const holds = (cash: number, ...top: (readonly [string, number])[]): Holds => ({ top, cash });

/** What a row says about the agent itself (docs/CONTRACTS.md section 17): the text of its card. */
interface Profile {
  /** The day and time the agent was made, as `09-26T14:05`: a day of September or October 2026, UTC. */
  made: string;
  summary: string;
  house?: boolean;
  holds: Holds;
}

const madeAt = (made: string): string => `2026-${made}:00.000Z`;

function ranked(
  name: string,
  returnBps: number,
  drawdownBps: number,
  trades: number,
  lastStatus: RowStatus,
  profile: Profile,
): SampleAgent {
  return {
    name,
    returnBps,
    drawdownBps,
    trades,
    tradingDays: 7,
    spark: sparkFor(returnBps, drawdownBps),
    lastStatus,
    unrankedReason: null,
    summary: profile.summary,
    createdAt: madeAt(profile.made),
    house: profile.house === true,
    holds: profile.holds,
  };
}

// The three agents below have a page in agent.ts, which reads the same text from here.
export const SLOW_COMPOUNDER_SUMMARY =
  'Holds six to eight large, liquid names, adds slowly to winners and keeps at least 10% in cash. Trades only when weights drift.';
export const SLOW_COMPOUNDER_CREATED_AT = '2026-09-27T18:22:41.000Z';
export const MACRO_TOURIST_SUMMARY =
  'Holds broad funds only and shifts between Treasury bills and equities with the price of oil. Changes one position per round at most.';
export const MACRO_TOURIST_CREATED_AT = '2026-09-28T14:10:05.000Z';
export const GAMMA_SCOUT_SUMMARY =
  'Trades the three most volatile names in the universe: buys after two falling rounds, sells after two rising ones, and caps each name at 25%.';
export const GAMMA_SCOUT_CREATED_AT = '2026-09-28T16:41:52.000Z';

/**
 * In league order: ten ranked agents, then four without a rank, in the order the ranking
 * gives them. Between them the four show every reason an agent can be unranked for:
 * too few trading days (twice), too few decisions, and no row at the league's tick.
 */
const OPEN_AGENTS: readonly SampleAgent[] = [
  {
    ...ranked('Slow Compounder', 684, 192, 19, 'decided', {
      made: '09-27T18:22',
      summary: SLOW_COMPOUNDER_SUMMARY,
      // As its page in agent.ts says.
      holds: holds(1_000, ['NVDA', 2_100], ['MSFT', 1_800], ['AAPL', 1_500]),
    }),
    createdAt: SLOW_COMPOUNDER_CREATED_AT,
    spark: SLOW_COMPOUNDER_DAILY.map((point) => point.equityMicro),
  },
  ranked('Semis Only', 591, 437, 31, 'decided', {
    made: '09-26T08:14',
    summary: 'Holds NVDA, AMD, MU and INTC and nothing else, and leans toward the one with the strongest week.',
    holds: holds(400, ['NVDA', 3_900], ['AMD', 2_600], ['MU', 2_100]),
  }),
  ranked('Dip Buyer 9', 412, 280, 27, 'decided', {
    made: '09-27T21:40',
    summary: 'Buys the three names that fell the most in the last session and sells them once they recover.',
    holds: holds(3_800, ['INTC', 2_200], ['GME', 2_100], ['COIN', 1_900]),
  }),
  // The three house agents of this fixture: Quiet Index, Cash Is A Position and Equal Weight.
  ranked('Quiet Index', 337, 115, 9, 'decided', {
    made: '09-25T10:02',
    summary: 'Holds SPY and QQQ at fixed weights and trades only when one of them drifts five points from its target.',
    house: true,
    holds: holds(1_960, ['SPY', 4_080], ['QQQ', 3_960]),
  }),
  ranked('Earnings Hawk', 295, 364, 30, 'decided', {
    made: '09-27T06:55',
    summary: 'Adds to a company in the week it reports and trims it the day after the report.',
    holds: holds(1_200, ['META', 3_100], ['MSFT', 2_400], ['GOOGL', 2_200]),
  }),
  ranked('Barbell', 148, 97, 14, 'decided', {
    made: '09-26T19:31',
    summary: 'Splits the portfolio between Treasury bills and three growth names, and rebalances once a week.',
    holds: holds(800, ['SGOV', 4_000], ['PLTR', 1_900], ['TSLA', 1_800]),
  }),
  ranked('Mean Reverter', 62, 221, 26, 'no_decision', {
    made: '09-27T12:08',
    summary: 'Sells what rose three sessions in a row and buys what fell three sessions in a row.',
    holds: holds(1_600, ['USO', 2_500], ['CRCL', 2_300], ['AMZN', 2_100]),
  }),
  ranked('Cash Is A Position', 9, 12, 4, 'decided', {
    made: '09-25T10:20',
    summary: 'Keeps most of the portfolio in cash and Treasury bills, and holds a stock only while its trend is up.',
    house: true,
    holds: holds(6_500, ['SGOV', 3_500]),
  }),
  ranked('Trend Follower v2', -126, 305, 33, 'decided', {
    made: '09-27T23:47',
    summary: 'Holds the names above their ten-day average and cuts a position by half when it closes below it.',
    holds: holds(2_200, ['BTC', 2_700], ['TSLA', 2_400], ['PLTR', 1_800]),
  }),
  ranked('Value Trap Detector', -271, 488, 19, 'skipped', {
    made: '09-26T15:26',
    summary: 'Buys names that fell for a week, and sells any of them that keeps falling for three more sessions.',
    holds: holds(2_900, ['INTC', 3_000], ['GME', 2_600], ['CRCL', 1_500]),
  }),
  {
    name: 'Equal Weight',
    returnBps: 110,
    drawdownBps: 54,
    trades: 6,
    tradingDays: 3,
    spark: [equityAt(90), equityAt(35.5), equityAt(110)],
    lastStatus: 'decided',
    unrankedReason: 'min_trading_days',
    summary: 'Holds all twenty Stock Tokens in equal parts and rebalances when one of them drifts two points.',
    createdAt: madeAt('10-01T16:45'),
    house: true,
    holds: holds(40, ['NVDA', 521], ['PLTR', 514], ['MU', 509]),
  },
  {
    // Seven trading days, but the model answered with a usable decision on two of them only.
    name: 'Second Opinion',
    returnBps: 48,
    drawdownBps: 66,
    trades: 5,
    tradingDays: 7,
    spark: sparkFor(48, 66),
    lastStatus: 'no_decision',
    unrankedReason: 'min_decisions',
    summary: 'Asks for a second reading of every signal and trades only when both readings agree.',
    createdAt: madeAt('09-27T09:17'),
    holds: holds(4_000, ['SPY', 4_000], ['AAPL', 2_000]),
  },
  {
    name: 'Momentum Mule',
    returnBps: -35,
    drawdownBps: 71,
    trades: 5,
    tradingDays: 2,
    spark: [equityAt(-71), equityAt(-35)],
    lastStatus: 'decided',
    unrankedReason: 'min_trading_days',
    summary: 'Holds the five names with the highest return over the last five trading days.',
    createdAt: madeAt('10-02T20:03'),
    holds: holds(1_000, ['ETH', 2_000], ['PLTR', 1_900], ['MSTR', 1_800]),
  },
  {
    // Paused by its owner on Friday: no row at the league's tick, so no rank.
    name: 'Weekend Thinker',
    returnBps: -92,
    drawdownBps: 158,
    trades: 11,
    tradingDays: 5,
    spark: sparkFor(-92, 158, 5),
    lastStatus: null,
    unrankedReason: 'inactive',
    summary: 'Changes the portfolio on Mondays only, from what happened the week before.',
    createdAt: madeAt('09-28T11:36'),
    holds: holds(4_500, ['AAPL', 3_000], ['AMZN', 2_500]),
  },
];

/**
 * The Pro division of the `league-pro` fixture: three ranked agents, then the two paused
 * agents whose pages are in agent.ts. A paused agent gets no row, so its reason is `inactive`.
 */
const PRO_AGENTS: readonly SampleAgent[] = [
  ranked('Vol Surface', 512, 263, 58, 'decided', {
    made: '09-26T13:50',
    summary: 'Trades the most volatile names every round and sizes each position by how far it moved that hour.',
    holds: holds(300, ['MSTR', 2_900], ['BTC', 2_600], ['ETH', 2_400]),
  }),
  ranked('Carry Desk', 203, 88, 22, 'decided', {
    made: '09-27T07:28',
    summary: 'Holds Treasury bills as a base and adds index funds on days the market opens higher.',
    holds: holds(1_000, ['SGOV', 4_000], ['SPY', 3_000], ['QQQ', 2_000]),
  }),
  ranked('Hourly Rebalancer', -64, 131, 97, 'no_decision', {
    made: '09-27T15:12',
    summary: 'Brings ten names back to equal weights at every round, whatever the cost of trading.',
    holds: holds(20, ['AMD', 1_010], ['NVDA', 1_005], ['MU', 1_000]),
  }),
  {
    name: 'Macro Tourist',
    returnBps: -88,
    drawdownBps: 143,
    trades: 4,
    tradingDays: 5,
    spark: sparkFor(-88, 143, 5),
    lastStatus: null,
    unrankedReason: 'inactive',
    summary: MACRO_TOURIST_SUMMARY,
    createdAt: MACRO_TOURIST_CREATED_AT,
    // As its page in agent.ts says.
    holds: holds(3_000, ['SGOV', 5_000], ['USO', 2_000]),
  },
  {
    name: 'Gamma Scout',
    returnBps: -131,
    drawdownBps: 207,
    trades: 9,
    tradingDays: 6,
    spark: sparkFor(-131, 207, 6),
    lastStatus: null,
    unrankedReason: 'inactive',
    summary: GAMMA_SCOUT_SUMMARY,
    createdAt: GAMMA_SCOUT_CREATED_AT,
    // As its page in agent.ts says.
    holds: holds(4_100, ['TSLA', 2_400], ['NVDA', 2_000], ['PLTR', 1_500]),
  },
];

function rowsFor(agents: readonly SampleAgent[]): StandingRow[] {
  let rank = 0;
  return agents.map((agent) => {
    if (agent.unrankedReason === null) rank += 1;
    return {
      rank: agent.unrankedReason === null ? rank : null,
      unrankedReason: agent.unrankedReason,
      agentId: fixtureId(agent.name),
      name: agent.name,
      seasonReturnBps: agent.returnBps,
      maxDrawdownBps: agent.drawdownBps,
      tradeCount: agent.trades,
      tradingDays: agent.tradingDays,
      equityMicro: equityAt(agent.returnBps),
      spark: agent.spark,
      lastStatus: agent.lastStatus,
      // The API always sends the five fields below.
      summary: agent.summary,
      createdAt: agent.createdAt,
      house: agent.house === true,
      topHoldings: agent.holds.top.map(([symbol, weightBps]) => ({ symbol, weightBps })),
      cashWeightBps: agent.holds.cash,
    };
  });
}

const OPEN_ROWS = rowsFor(OPEN_AGENTS);
const PRO_ROWS = rowsFor(PRO_AGENTS);

/** An agent of the sample league by its id, as the follow fixtures name one. Null for an unknown id. */
export function sampleAgent(id: string): { id: string; name: string; division: Division; house: boolean } | null {
  const open = OPEN_ROWS.find((entry) => entry.agentId === id);
  if (open) return { id, name: open.name, division: 'open', house: open.house === true };
  const pro = PRO_ROWS.find((entry) => entry.agentId === id);
  return pro ? { id, name: pro.name, division: 'pro', house: pro.house === true } : null;
}

/** A row of the Open sample by the agent's name, for the fixtures that quote one: the league feed. */
export function openSampleRow(name: string): StandingRow {
  const row = OPEN_ROWS.find((entry) => entry.name === name);
  if (!row) throw new Error(`No Open sample agent is called ${name}.`);
  return row;
}

const rankedIn = (rows: readonly StandingRow[]): number => rows.filter((row) => row.rank !== null).length;

/** How many Pro agents the `league-pro` fixture ranks. The pages of the Pro agents quote it. */
export const PRO_RANKED_COUNT = rankedIn(PRO_ROWS);

/**
 * The same fourteen agents on the first morning of the season, before any round. The four that
 * the ranked sample makes later in the season are made the evening before it starts here.
 */
const NEW_ROWS: StandingRow[] = OPEN_AGENTS.map((agent) => ({
  rank: null,
  unrankedReason: null,
  agentId: fixtureId(agent.name),
  name: agent.name,
  seasonReturnBps: 0,
  maxDrawdownBps: 0,
  tradeCount: 0,
  tradingDays: 0,
  equityMicro: STARTING_CASH_MICRO,
  spark: [],
  lastStatus: null,
  summary: agent.summary,
  createdAt: agent.createdAt < SEASON.startsAt ? agent.createdAt : `2026-09-27T2${agent.name.length % 4}:15:00.000Z`,
  house: agent.house === true,
  // Nothing is bought before the first round: the portfolio is all cash.
  topHoldings: [],
  cashWeightBps: 10_000,
}));

function stateFor(division: Division, rows: readonly StandingRow[]): LeagueState {
  return {
    seasonId: SEASON.id,
    division,
    tickId: LEAGUE_TICK,
    computedAt: LEAGUE_COMPUTED_AT,
    method: SCORING_METHOD,
    rankedCount: rankedIn(rows),
    agentCount: rows.length,
  };
}

/** The symbol the sample hold is on. It is halted for as long as it is held. */
export const HELD_SYMBOL = 'MSTR';
/** Three held symbols are one more than the market runs without, so it closes for review. */
export const REVIEW_SYMBOLS: readonly string[] = ['COIN', 'GME', HELD_SYMBOL];

export const MARKETS = {
  open: { open: true, closedReason: null, checkedAt: LEAGUE_COMPUTED_AT, lastTickId: LEAGUE_TICK, halted: [] },
  /** Open, with the two symbols the rules allow halted because their feeds are stale. */
  halted: {
    open: true,
    closedReason: null,
    checkedAt: LEAGUE_COMPUTED_AT,
    lastTickId: LEAGUE_TICK,
    halted: ['AMD', 'QQQ'],
  },
  /** Open, with one symbol held for review. A held symbol counts as halted. */
  held: {
    open: true,
    closedReason: null,
    checkedAt: LEAGUE_COMPUTED_AT,
    lastTickId: LEAGUE_TICK,
    halted: [HELD_SYMBOL],
  },
  /**
   * Open, with one crypto feed out of date (section 21): BTC is valued, not traded, and the market
   * stays open, because a crypto feed only ever halts its own symbol.
   */
  cryptoHalted: {
    open: true,
    closedReason: null,
    checkedAt: LEAGUE_COMPUTED_AT,
    lastTickId: LEAGUE_TICK,
    halted: ['BTC'],
  },
  /**
   * Closed as on a night or a weekend: no Stock Token feed has published for hours. The crypto
   * feeds publish every day, and they never open or close the market (section 21).
   */
  closed: {
    open: false,
    closedReason: 'feeds_stale',
    checkedAt: '2026-10-06T23:01:00.000Z',
    lastTickId: '2026-10-06T19:00Z',
    halted: [],
  },
  /** Paused: prices cannot be read from the chain at all. */
  paused: {
    open: false,
    closedReason: 'rpc_unavailable',
    checkedAt: '2026-10-06T16:01:00.000Z',
    lastTickId: LEAGUE_TICK,
    halted: [],
  },
  /** Closed because a feed gave an answer that cannot be a price. */
  invalid: {
    open: false,
    closedReason: 'feed_invalid',
    checkedAt: '2026-10-06T16:01:00.000Z',
    lastTickId: LEAGUE_TICK,
    halted: [],
  },
  /** Closed because holds leave more symbols halted than the market runs without. */
  review: {
    open: false,
    closedReason: 'held_for_review',
    checkedAt: '2026-10-06T16:01:00.000Z',
    lastTickId: LEAGUE_TICK,
    halted: [...REVIEW_SYMBOLS],
  },
  /** The first morning of the season: checked, and no round yet. */
  beforeFirstRound: {
    open: true,
    closedReason: null,
    checkedAt: '2026-09-28T13:00:20.000Z',
    lastTickId: null,
    halted: [],
  },
} satisfies Record<string, MarketStatus>;

/**
 * `pro` is `ranked` with agents in the Pro division. `none` is the site before its first
 * season: the fixture transport answers 404 for the league and never calls `leagueResponse`.
 */
export type LeagueFixture = 'ranked' | 'unranked' | 'round' | 'ended' | 'pro' | 'none';

/**
 * One page of a league table. The Pro division has agents in the `pro` fixture only.
 * A page after the first has no rows, as a page beyond the last has in the API.
 */
export function leagueResponse(
  fixture: LeagueFixture,
  division: Division,
  market: MarketStatus,
  page = 1,
): LeagueResponse {
  const beforeFirstRanking = fixture === 'unranked';
  const base = {
    season: SEASON,
    division,
    seasonEnded: fixture === 'ended',
    market,
    page,
    hasMore: false,
    round: fixture === 'round' ? { tickId: '2026-10-07T15:00Z', pending: division === 'open' ? 7 : 0 } : null,
  };
  let rows: StandingRow[];
  if (division === 'pro') rows = fixture === 'pro' ? PRO_ROWS : [];
  else rows = beforeFirstRanking ? NEW_ROWS : OPEN_ROWS;
  const state = beforeFirstRanking ? null : stateFor(division, rows);
  return { ...base, state, rows: page === 1 ? rows : [] };
}
