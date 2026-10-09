import type {
  AgentPublic,
  DecisionPublic,
  Division,
  FeedItem,
  Fill,
  HoldingPublic,
  LeagueResponse,
  MarketStatus,
  Season,
  StandingRow,
} from '@prix/contracts';
import { SCORING_METHOD, STARTING_CASH_MICRO } from '@prix/contracts';
import { cashOf, fill, holding, row, shortOf } from './agent.ts';
import { fixtureId, SEASON, usd } from './league.ts';
import { EARLY_PRICES } from './prices.ts';

/**
 * The league in its first week, which is what production looks like when the board look ships
 * (docs/DECISIONS.md D-090): season 1 began on Monday 5 October 2026, and it is Thursday the 8th,
 * a few minutes after the daily round. Nine agents are in the Open division and Prix runs all of
 * them: `Index Core`, the first agent, and the eight of infra/seed/house-agents.json. None is
 * ranked, because an agent is ranked after five trading days and three decisions, and none has
 * more than two days. Returns are within a percent of zero and a sparkline has one or two
 * points. The Pro division is empty.
 *
 * Every figure follows from the rounds written out below: what an agent bought, at what price,
 * and how the market moved its portfolio by the next round. Nothing here is a forecast.
 */

export const EARLY_SEASON: Season = {
  id: SEASON.id,
  number: 1,
  startsAt: '2026-10-05T00:00:00.000Z',
  endsAt: '2026-11-02T00:00:00.000Z',
};

const WEDNESDAY = '2026-10-07';
const THURSDAY = '2026-10-08';
/** The daily tick the ranking is as of. Open agents decide at 15:00 UTC. */
export const EARLY_TICK = `${THURSDAY}T15:00Z`;
const EARLY_COMPUTED_AT = `${THURSDAY}T15:03:40.000Z`;

/** The market a few minutes after that round: open, nothing halted. */
export const EARLY_MARKET: MarketStatus = {
  open: true,
  closedReason: null,
  checkedAt: EARLY_COMPUTED_AT,
  lastTickId: EARLY_TICK,
  halted: [],
};

/** A buy of `amount` USD at `price`. */
type Buy = readonly [symbol: string, amount: number, price: number];

interface Round {
  day: string;
  /** How far the market moved the portfolio since the round before, in basis points. */
  moveBps?: number;
  /** Left out for a decision. */
  status?: 'no_decision';
  /** The reason the model gave. Null for a row without a decision. */
  reason: string | null;
  buys?: readonly Buy[];
}

interface EarlyAgent {
  name: string;
  createdAt: string;
  summary: string;
  /** Oldest first: one round a trading day since the agent was made. */
  rounds: readonly Round[];
}

const HOLD_CASH = 'No return is known yet, so the portfolio stays in cash.';

/**
 * `Index Core` was made on Tuesday after the round. Five more were made on Wednesday morning and
 * have two rounds; the last three were made on Wednesday evening and have one.
 */
const AGENTS: readonly EarlyAgent[] = [
  {
    name: 'Index Core',
    createdAt: '2026-10-06T16:12:09.000Z',
    summary: 'Holds SPY and QQQ at 45% each and trades only when one of them drifts five points from its target.',
    rounds: [
      {
        day: WEDNESDAY,
        reason: 'Starts with SPY and QQQ at 45% each and keeps a tenth in cash.',
        // The model asked for 45% each; the 40% limit on one name cuts both to 40%, and the rest stays in cash.
        buys: [
          ['QQQ', 4_000, 601.2],
          ['SPY', 4_000, 668.4],
        ],
      },
      {
        day: THURSDAY,
        moveBps: 52,
        reason: 'Both funds are within five points of their targets, so nothing is traded.',
      },
    ],
  },
  {
    name: 'Semis Rotation',
    createdAt: '2026-10-07T09:41:17.000Z',
    summary:
      'Holds the two strongest of NVDA, AMD, MU and INTC over the last five trading days at 30% each and keeps the rest in cash.',
    rounds: [
      {
        day: WEDNESDAY,
        reason: 'No return is known yet, so the portfolio starts with NVDA and AMD at 30% each.',
        buys: [
          ['AMD', 3_000, 212.35],
          ['NVDA', 3_000, 182.41],
        ],
      },
      // The model's answer could not be read as a decision, so the portfolio was left as it was.
      { day: THURSDAY, moveBps: 89, status: 'no_decision', reason: null },
    ],
  },
  {
    name: 'Treasury First',
    createdAt: '2026-10-07T09:44:02.000Z',
    summary: 'Keeps 40% in SGOV at all times and adds 30% in SPY while its five-day return is above zero.',
    rounds: [
      {
        day: WEDNESDAY,
        reason: 'Puts 40% in SGOV. The five-day return of SPY is not known yet, so SPY gets 30%.',
        buys: [
          ['SGOV', 4_000, 100.42],
          ['SPY', 3_000, 668.4],
        ],
      },
      { day: THURSDAY, moveBps: 23, reason: 'SGOV and SPY are at their targets, so nothing is traded.' },
    ],
  },
  {
    name: 'Dip Buyer',
    createdAt: '2026-10-07T09:47:30.000Z',
    summary:
      'Holds the three symbols that fell the most over the last trading day at 20% each, never SGOV or USO, and keeps the rest in cash.',
    rounds: [
      { day: WEDNESDAY, reason: HOLD_CASH },
      {
        day: THURSDAY,
        reason: 'INTC, COIN and MSTR fell the most over the last trading day and get 20% each.',
        buys: [
          ['COIN', 2_000, 318.6],
          ['INTC', 2_000, 36.12],
          ['MSTR', 2_000, 341.75],
        ],
      },
    ],
  },
  {
    name: 'Momentum Five',
    createdAt: '2026-10-07T09:52:11.000Z',
    summary: 'Holds the five symbols with the highest five-day return at 18% each and never holds SGOV.',
    rounds: [
      { day: WEDNESDAY, reason: HOLD_CASH },
      {
        day: THURSDAY,
        reason: 'Ranked by the one-day return, NVDA, AMD, PLTR, META and MU lead and get 18% each.',
        buys: [
          ['AMD', 1_800, 214.6],
          ['META', 1_800, 739.52],
          ['MU', 1_800, 168.59],
          ['NVDA', 1_800, 184.03],
          ['PLTR', 1_800, 186.4],
        ],
      },
    ],
  },
  {
    name: 'Oil And Idle',
    createdAt: '2026-10-07T16:20:45.000Z',
    summary: 'Keeps 40% in SGOV and holds 35% in USO only while its last trading day was up.',
    rounds: [
      {
        day: THURSDAY,
        reason: 'Puts 40% in SGOV. USO fell over the last trading day, so that part stays in cash.',
        buys: [['SGOV', 4_000, 100.43]],
      },
    ],
  },
  {
    name: 'Big Tech Equal',
    createdAt: '2026-10-07T16:24:13.000Z',
    summary:
      'Holds AAPL, MSFT, GOOGL, AMZN, META and NVDA at 15% each and trades only when a holding drifts three points.',
    rounds: [
      {
        day: THURSDAY,
        reason: 'Starts with the six names at 15% each and keeps a tenth in cash.',
        buys: [
          ['AAPL', 1_500, 247.85],
          ['AMZN', 1_500, 236.02],
          ['GOOGL', 1_500, 254.11],
          ['META', 1_500, 739.52],
          ['MSFT', 1_500, 512.3],
          ['NVDA', 1_500, 184.03],
        ],
      },
    ],
  },
  {
    name: 'Crypto Proxies',
    createdAt: '2026-10-07T16:27:50.000Z',
    summary:
      'Holds COIN, MSTR and CRCL at 25% each and steps out of one for a round after it falls more than eight percent in a day.',
    rounds: [
      {
        day: THURSDAY,
        reason: 'None of the three fell more than eight percent over the last trading day, so each gets 25%.',
        buys: [
          ['COIN', 2_500, 318.6],
          ['CRCL', 2_500, 172.66],
          ['MSTR', 2_500, 341.75],
        ],
      },
    ],
  },
  {
    name: 'Crowd Favourites',
    createdAt: '2026-10-07T16:31:26.000Z',
    summary: 'Holds GME, PLTR and TSLA at 25% each and trades only when a holding drifts five points.',
    rounds: [
      {
        day: THURSDAY,
        reason: 'Starts with GME, PLTR and TSLA at 25% each and keeps the rest in cash.',
        buys: [
          ['GME', 2_500, 41.87],
          ['PLTR', 2_500, 186.4],
          ['TSLA', 2_500, 438.2],
        ],
      },
    ],
  },
];

interface Played {
  agent: EarlyAgent;
  id: string;
  /** Newest first, as the API sends them. */
  rows: DecisionPublic[];
  daily: { day: string; equityMicro: number }[];
  equityMicro: number;
  peakMicro: number;
  returnBps: number;
  drawdownBps: number;
  trades: number;
  decided: number;
  noDecision: number;
  lastStatus: DecisionPublic['status'];
}

/** Plays an agent's rounds: the market moves the portfolio, then the round's fills cost their fee and slippage. */
function play(agent: EarlyAgent): Played {
  let equity = STARTING_CASH_MICRO;
  let peak = STARTING_CASH_MICRO;
  let drawdownBps = 0;
  const rows: DecisionPublic[] = [];
  const daily: Played['daily'] = [];
  for (const round of agent.rounds) {
    const fills: Fill[] = (round.buys ?? []).map(([symbol, amount, price]) => fill(symbol, 'buy', amount, price));
    equity = Math.round(equity * (1 + (round.moveBps ?? 0) / 10_000));
    equity -= fills.reduce((sum, entry) => sum + entry.feeMicro + entry.slippageMicro, 0);
    peak = Math.max(peak, equity);
    drawdownBps = Math.max(drawdownBps, Math.round(((peak - equity) * 10_000) / peak));
    const failed = round.status === 'no_decision';
    rows.unshift(
      row(
        round.day,
        15,
        equity,
        failed ? 'no_decision' : 'decided',
        failed ? 'schema_mismatch' : null,
        round.reason,
        fills,
      ),
    );
    daily.push({ day: round.day, equityMicro: equity });
  }
  return {
    agent,
    id: fixtureId(agent.name),
    rows,
    daily,
    equityMicro: equity,
    peakMicro: peak,
    returnBps: Math.round(((equity - STARTING_CASH_MICRO) * 10_000) / STARTING_CASH_MICRO),
    drawdownBps,
    trades: rows.reduce((sum, entry) => sum + entry.fills.length, 0),
    decided: rows.filter((entry) => entry.status === 'decided').length,
    noDecision: rows.filter((entry) => entry.status === 'no_decision').length,
    lastStatus: rows[0]?.status ?? 'decided',
  };
}

/** The order of docs/CONTRACTS.md section 9, which is also the order of agents without a rank. */
function leagueOrder(a: Played, b: Played): number {
  return (
    b.returnBps - a.returnBps ||
    a.drawdownBps - b.drawdownBps ||
    a.trades - b.trades ||
    (a.agent.createdAt < b.agent.createdAt ? -1 : a.agent.createdAt > b.agent.createdAt ? 1 : a.id < b.id ? -1 : 1)
  );
}

const PLAYED: readonly Played[] = AGENTS.map(play).sort(leagueOrder);

function playedBy(name: string): Played {
  const found = PLAYED.find((entry) => entry.agent.name === name);
  if (!found) throw new Error(`No early agent is called ${name}.`);
  return found;
}

const SEMIS = playedBy('Semis Rotation');

/** What Semis Rotation holds on Thursday: the two names it bought on Wednesday, at Thursday's prices. */
const SEMIS_HOLDINGS: HoldingPublic[] = (() => {
  const invested = SEMIS.equityMicro - usd(3_988);
  return [
    holding('AMD', Math.round(invested * 0.505) / 1_000_000, 214.6, SEMIS.equityMicro),
    holding('NVDA', Math.round(invested * 0.495) / 1_000_000, 184.03, SEMIS.equityMicro),
  ];
})();

/**
 * What an agent holds after Thursday's round, largest first: every name it bought, grown by the
 * market's moves since the round it was bought in, at Thursday's prices (the price strip, prices.ts).
 * Semis Rotation holds what its page says.
 */
function holdingsOf(entry: Played): HoldingPublic[] {
  if (entry === SEMIS) return [...SEMIS_HOLDINGS].sort((a, b) => b.valueMicro - a.valueMicro);
  const held: HoldingPublic[] = [];
  entry.agent.rounds.forEach((round, index) => {
    const grown = entry.agent.rounds
      .slice(index + 1)
      .reduce((factor, next) => factor * (1 + (next.moveBps ?? 0) / 10_000), 1);
    for (const [symbol, amount, price] of round.buys ?? []) {
      held.push(holding(symbol, amount * grown, EARLY_PRICES[symbol] ?? price, entry.equityMicro));
    }
  });
  return held.sort((a, b) => b.valueMicro - a.valueMicro || (a.symbol < b.symbol ? -1 : 1));
}

/** The card's part of the holdings (docs/CONTRACTS.md section 17.2): three names and the cash weight. */
function cardHoldings(entry: Played): Pick<StandingRow, 'topHoldings' | 'cashWeightBps'> {
  const held = holdingsOf(entry);
  return {
    topHoldings: held.slice(0, 3).map((item) => ({ symbol: item.symbol, weightBps: item.weightBps })),
    cashWeightBps: cashOf(entry.equityMicro, held).cashWeightBps,
  };
}

const EARLY_ROWS: StandingRow[] = PLAYED.map((entry) => ({
  rank: null,
  // Two trading days at most, and a rank needs five.
  unrankedReason: 'min_trading_days',
  agentId: entry.id,
  name: entry.agent.name,
  seasonReturnBps: entry.returnBps,
  maxDrawdownBps: entry.drawdownBps,
  tradeCount: entry.trades,
  tradingDays: entry.daily.length,
  equityMicro: entry.equityMicro,
  spark: entry.daily.map((point) => point.equityMicro),
  lastStatus: entry.lastStatus,
  summary: entry.agent.summary,
  createdAt: entry.agent.createdAt,
  house: true,
  ...cardHoldings(entry),
}));

/** One of the nine agents by its id, as the follow fixtures name one. Null for an unknown id. */
export function earlyAgent(id: string): { id: string; name: string; division: Division; house: boolean } | null {
  const found = EARLY_ROWS.find((entry) => entry.agentId === id);
  return found ? { id, name: found.name, division: 'open', house: found.house === true } : null;
}

/** One page of the league in its first week: nine house agents in Open, nobody in Pro, nobody ranked. */
export function earlyLeagueResponse(division: Division, market: MarketStatus, page = 1): LeagueResponse {
  const rows = division === 'open' ? EARLY_ROWS : [];
  return {
    season: EARLY_SEASON,
    division,
    seasonEnded: false,
    market,
    // The ranking ran at the round and found nobody to rank. It runs for an empty division too.
    state: {
      seasonId: EARLY_SEASON.id,
      division,
      tickId: EARLY_TICK,
      computedAt: EARLY_COMPUTED_AT,
      method: SCORING_METHOD,
      rankedCount: 0,
      agentCount: rows.length,
    },
    rows: page === 1 ? rows : [],
    page,
    hasMore: false,
    round: null,
  };
}

/**
 * Every decision of the nine agents so far, as the league feed lists them: newest tick first,
 * then agent id descending. Thirteen items, each of a house agent. A row without a decision is
 * in no feed, so Thursday's row of Semis Rotation is not here.
 */
export const EARLY_FEED_ITEMS: FeedItem[] = PLAYED.flatMap((entry) =>
  entry.rows
    .filter((decision) => decision.status === 'decided')
    .map(
      (decision): FeedItem => ({
        agentId: entry.id,
        agentName: entry.agent.name,
        division: 'open',
        tickId: decision.tickId,
        at: decision.at,
        reason: decision.reason ?? '',
        fills: decision.fills,
        halted: decision.halted,
        equityMicro: decision.equityMicro,
        costMicro: decision.costMicro,
        simulated: true,
        house: true,
      }),
    ),
).sort((a, b) => (`${a.tickId}~${a.agentId}` < `${b.tickId}~${b.agentId}` ? 1 : -1));

// --- The page of one house agent in its first week ---------------------------------------------

/** The owner of a house agent in the fixtures. It is a made-up address that belongs to nobody. */
const HOUSE_OWNER = '0x4f0e2d6c8b1a39574e6f8091a2b3c4d5e6f70812';

/**
 * Semis Rotation on Thursday 8 October: a house agent with two points on its chart, no rank and
 * one decision. Its page is /agents/semisrotatio. Wednesday's round is the decision; Thursday's
 * row has none, because the model's answer could not be read.
 */
export const EARLY_HOUSE_AGENT: AgentPublic = {
  id: SEMIS.id,
  name: SEMIS.agent.name,
  division: 'open',
  ownerShort: shortOf(HOUSE_OWNER),
  model: { kind: 'house' },
  status: 'active',
  createdAt: SEMIS.agent.createdAt,
  summary: SEMIS.agent.summary,
  summaryStatus: 'ready',
  prompt: null,
  season: EARLY_SEASON,
  rank: null,
  unrankedReason: 'min_trading_days',
  rankedCount: 0,
  stats: {
    equityMicro: SEMIS.equityMicro,
    peakEquityMicro: SEMIS.peakMicro,
    seasonReturnBps: SEMIS.returnBps,
    maxDrawdownBps: SEMIS.drawdownBps,
    tradeCount: SEMIS.trades,
    decidedCount: SEMIS.decided,
    noDecisionCount: SEMIS.noDecision,
    skippedCount: 0,
    tradingDays: SEMIS.daily.length,
    lastDay: THURSDAY,
    daily: SEMIS.daily,
  },
  holdings: SEMIS_HOLDINGS,
  ...cashOf(SEMIS.equityMicro, SEMIS_HOLDINGS),
  asOfTickId: EARLY_TICK,
  decisions: SEMIS.rows,
  method: SCORING_METHOD,
  house: true,
};

/** How many wallets follow the agent in the fixtures. */
export const EARLY_HOUSE_AGENT_FOLLOWERS = 3;
