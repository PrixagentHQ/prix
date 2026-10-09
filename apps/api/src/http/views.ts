import type {
  AgentOwnerView,
  AgentRecord,
  AgentStats,
  DecisionPublic,
  DecisionRow,
  HoldingPublic,
  LeagueState,
  MarketSnapshot,
  ModelKeyPublic,
  ModelKeyRecord,
  OfficialScore,
  PortfolioState,
  PriceMap,
  ScoringEngine,
  Season,
  SimEngine,
  StandingConfidence,
  StandingRow,
  StandingSource,
  Store,
  TickId,
  UnrankedReason,
  UtcDay,
} from '@prix/contracts';
import { BPS, isHouseOwner, MICRO, SPARK_MAX_POINTS } from '@prix/contracts';

/**
 * What a response says about a record. Every function here names its fields one by one, so a
 * new column in a record never reaches a response by accident. No function here reads a
 * ciphertext, and only `toOwnerView` reads a prompt without asking whether it is published.
 */

/** A stored key as a response may show it: the last four characters at most. */
export function toModelKeyPublic(key: ModelKeyRecord): ModelKeyPublic {
  return { id: key.id, provider: key.provider, model: key.model, last4: key.last4, createdAt: key.createdAt };
}

export function toDecisionPublic(row: DecisionRow): DecisionPublic {
  return {
    tickId: row.tickId,
    at: row.createdAt,
    status: row.status,
    code: row.code,
    reason: row.reason,
    fills: row.fills,
    halted: row.halted,
    equityMicro: row.equityMicro,
    costMicro: row.costMicro,
  };
}

/** An agent as its owner sees it. The only view that carries a private prompt. */
export function toOwnerView(agent: AgentRecord, lastDecision: DecisionRow | null): AgentOwnerView {
  return {
    id: agent.id,
    name: agent.name,
    division: agent.division,
    status: agent.status,
    pausedReason: agent.pausedReason,
    hidden: agent.hidden,
    prompt: agent.prompt,
    promptPublic: agent.promptPublic,
    summary: agent.summary,
    summaryStatus: agent.summaryStatus,
    modelKeyId: agent.modelKeyId,
    createdAt: agent.createdAt,
    lastDecision: lastDecision === null ? null : toDecisionPublic(lastDecision),
  };
}

/** 0x7a3f…c91e */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The active season, or the latest one that has started when none is active. */
export async function currentSeason(store: Store, now: string): Promise<Season | null> {
  return (await store.getActiveSeason(now)) ?? (await store.getLatestStartedSeason(now));
}

/** The agent's latest row in the season on show, for its owner. */
export async function latestDecision(store: Store, agentId: string, now: string): Promise<DecisionRow | null> {
  const season = await currentSeason(store, now);
  if (season === null) return null;
  const rows = await store.listDecisions(agentId, season.id, 1);
  return rows[0] ?? null;
}

/**
 * The rank and the reason for having none, as a table and an agent's page show them.
 *
 * Before the division's first ranking both are null. After it, a stored rank is shown as it is,
 * with no reason beside it. An agent without a stored rank gets the reason from
 * `scoring.unrankedReason`, which is told whether the agent has a row at the league's tick or
 * at a later one: a round in progress must not make an agent that already decided in it look
 * inactive. That reason can be null too, for an agent that has met both thresholds since the
 * last ranking and gets its rank at the next one.
 *
 * The rank is never computed here. It is the one the last ranking published.
 */
export function standingOf(
  scoring: ScoringEngine,
  state: LeagueState | null,
  storedRank: number | null,
  stats: AgentStats,
  lastTickId: TickId | null,
  official?: OfficialScore | null,
): OfficialStanding {
  if (state === null) return { ...NO_STANDING };
  // A season scored by v2 publishes the rank copied from season_scores (docs/contracts/phase-6-social.md
  // section 3): the rank is as of `scoredDay`, the figures beside it stay the live ones.
  if (state.method === 'v2') {
    if (state.scoredDay === null || state.scoredDay === undefined) return { ...NO_STANDING };
    const score = official ?? null;
    const figures = {
      scoreMilli: score?.scoreMilli ?? null,
      confidence: score?.confidence ?? null,
      scoredDay: score?.scoredDay ?? null,
    };
    if (storedRank !== null) return { rank: storedRank, unrankedReason: null, ...figures };
    // An agent without a season_scores row after the first pass has too few trading days.
    return { rank: null, unrankedReason: score === null ? 'min_trading_days' : score.unrankedReason, ...figures };
  }
  const v1 = { scoreMilli: null, confidence: null, scoredDay: null };
  if (storedRank !== null) return { rank: storedRank, unrankedReason: null, ...v1 };
  // Tick ids sort in time order as text.
  const hasRowAtTick = lastTickId !== null && lastTickId >= state.tickId;
  return { rank: null, unrankedReason: scoring.unrankedReason(stats, hasRowAtTick), ...v1 };
}

/** The rank, the reason for having none, and the official v2 figures behind the rank (null in a v1 season). */
export interface OfficialStanding {
  rank: number | null;
  unrankedReason: UnrankedReason | null;
  scoreMilli: number | null;
  confidence: StandingConfidence | null;
  scoredDay: UtcDay | null;
}

const NO_STANDING: OfficialStanding = {
  rank: null,
  unrankedReason: null,
  scoreMilli: null,
  confidence: null,
  scoredDay: null,
};

/**
 * The holdings of a league row (docs/CONTRACTS.md section 17.2): `topHoldingsOf` the source's
 * portfolio at the prices of its latest row. Nothing when the source carries no portfolio, or
 * when a held symbol has no price (its tick could not be read): one row without holdings is
 * better than a league page that fails.
 */
function holdingsOfSource(
  sim: SimEngine | undefined,
  source: StandingSource,
): Partial<Pick<StandingRow, 'topHoldings' | 'cashWeightBps'>> {
  if (sim === undefined || source.portfolio === undefined) return {};
  const prices = source.prices ?? {};
  for (const symbol of Object.keys(source.portfolio.holdings)) {
    if (prices[symbol] === undefined) return {};
  }
  return topHoldingsOf(sim, source.portfolio, prices);
}

/**
 * A league row. `houseOwners` is `ApiConfig.houseOwners`: the row of an agent of one of these
 * wallets says `house: true`. The owner is read for that test and goes no further. With `sim`,
 * the row carries its top holdings and its cash weight (section 17.2).
 */
export function toStandingRow(
  scoring: ScoringEngine,
  state: LeagueState | null,
  source: StandingSource,
  houseOwners?: readonly string[],
  sim?: SimEngine,
): StandingRow {
  const atLeagueTick = state !== null && source.lastTickId === state.tickId;
  return {
    ...standingOf(scoring, state, source.rank, source.stats, source.lastTickId, source.official),
    agentId: source.agentId,
    name: source.name,
    seasonReturnBps: source.stats.seasonReturnBps,
    maxDrawdownBps: source.stats.maxDrawdownBps,
    tradeCount: source.stats.tradeCount,
    tradingDays: source.stats.tradingDays,
    equityMicro: source.stats.equityMicro,
    // The league never resets (D-109), so only the latest points travel on a row; the record page keeps the rest.
    spark: source.stats.daily.slice(-SPARK_MAX_POINTS).map((point) => point.equityMicro),
    lastStatus: atLeagueTick ? source.lastStatus : null,
    summary: source.summary ?? null,
    createdAt: source.createdAt,
    house: isHouseOwner(houseOwners, source.owner),
    ...holdingsOfSource(sim, source),
  };
}

/** The reference prices of a snapshot by symbol, halted symbols included. */
export function pricesOf(snapshot: MarketSnapshot): PriceMap {
  const prices: PriceMap = {};
  for (const point of snapshot.prices) prices[point.symbol] = point.priceMicro;
  return prices;
}

/** A share of the whole in basis points, rounded down. The product can pass the safe range, so BigInt. */
function weightBps(partMicro: number, wholeMicro: number): number {
  if (wholeMicro <= 0) return 0;
  return Number((BigInt(partMicro) * BigInt(BPS)) / BigInt(wholeMicro));
}

/**
 * A portfolio valued at one set of prices. Every value comes from `sim.valuePortfolio`, so the
 * page and the engine can never disagree about what a holding is worth. Throws, like the
 * engine, if a held symbol has no price.
 */
export function valueHoldings(
  sim: SimEngine,
  portfolio: PortfolioState,
  prices: PriceMap,
): { holdings: HoldingPublic[]; cashWeightBps: number } {
  const equityMicro = sim.valuePortfolio(portfolio, prices);
  const holdings: HoldingPublic[] = [];
  for (const [symbol, unitsMicro] of Object.entries(portfolio.holdings)) {
    const valueMicro = sim.valuePortfolio({ cashMicro: 0, holdings: { [symbol]: unitsMicro } }, prices);
    holdings.push({
      symbol,
      unitsMicro,
      priceMicro: prices[symbol] ?? 0,
      valueMicro,
      weightBps: weightBps(valueMicro, equityMicro),
    });
  }
  holdings.sort((a, b) => b.valueMicro - a.valueMicro || (a.symbol < b.symbol ? -1 : 1));
  return { holdings, cashWeightBps: weightBps(portfolio.cashMicro, equityMicro) };
}

/** How many holdings a league row names (docs/CONTRACTS.md section 17.2). */
const TOP_HOLDINGS = 3;

/**
 * What a card of the board shows of a portfolio: its three largest holdings with their weights,
 * largest first, and the weight of cash. The result equals the first three entries of
 * `valueHoldings` and its cash weight, so a card and the agent's page always agree.
 *
 * A league page values a hundred portfolios inside the 10 ms CPU limit, so this does not value
 * every holding exactly. Every holding is first estimated in floating point; only the holdings
 * whose estimate comes near the third largest are valued with `sim.valuePortfolio`, and the order
 * and the weights come from those exact values alone. The estimate of a value `floor(u * p / M)`
 * is within one part in 2^50 of `u * p / M`, so a margin of one part in a million and two micro-USD
 * can never leave out a holding whose exact value is among the three largest.
 * Throws, like the engine, if a held symbol has no price.
 */
export function topHoldingsOf(
  sim: SimEngine,
  portfolio: PortfolioState,
  prices: PriceMap,
): Required<Pick<StandingRow, 'topHoldings' | 'cashWeightBps'>> {
  const equityMicro = sim.valuePortfolio(portfolio, prices);
  const estimates: { symbol: string; unitsMicro: number; estimate: number }[] = [];
  for (const [symbol, unitsMicro] of Object.entries(portfolio.holdings)) {
    estimates.push({ symbol, unitsMicro, estimate: (unitsMicro * (prices[symbol] ?? 0)) / MICRO });
  }
  estimates.sort((a, b) => b.estimate - a.estimate);
  // With three holdings or fewer, every one of them is valued.
  const third = estimates[TOP_HOLDINGS - 1]?.estimate;
  const floor = third === undefined ? Number.NEGATIVE_INFINITY : third - third * 1e-6 - 2;
  const exact: { symbol: string; valueMicro: number }[] = [];
  for (const entry of estimates) {
    if (entry.estimate < floor) break;
    const valueMicro = sim.valuePortfolio({ cashMicro: 0, holdings: { [entry.symbol]: entry.unitsMicro } }, prices);
    exact.push({ symbol: entry.symbol, valueMicro });
  }
  exact.sort((a, b) => b.valueMicro - a.valueMicro || (a.symbol < b.symbol ? -1 : 1));
  return {
    topHoldings: exact
      .slice(0, TOP_HOLDINGS)
      .map((entry) => ({ symbol: entry.symbol, weightBps: weightBps(entry.valueMicro, equityMicro) })),
    cashWeightBps: weightBps(portfolio.cashMicro, equityMicro),
  };
}
