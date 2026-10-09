import type {
  AgentRecord,
  AgentStats,
  AgentWork,
  DailyPrices,
  DecisionRow,
  LeagueState,
  MarketSnapshot,
  MarketStatus,
  ModelKeyRecord,
  OfficialScore,
  PortfolioRecord,
  PortfolioState,
  PriceMap,
  Season,
  SessionRecord,
  StandingSource,
  SymbolHold,
  Tick,
} from '@prix/contracts';
import { utcDayOfTick } from '@prix/contracts';

/**
 * The shape of a row as D1 returns it, and the function that turns it into the contract's type.
 * A JSON column was validated when it was written and is trusted here (docs/CONTRACTS.md section 3).
 */

function fromJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

export interface SessionRow {
  token_hash: string;
  address: string;
  created_at: string;
  expires_at: string;
}

export function toSession(row: SessionRow): SessionRecord {
  return { tokenHash: row.token_hash, address: row.address, createdAt: row.created_at, expiresAt: row.expires_at };
}

export interface AgentRow {
  id: string;
  owner: string;
  name: string;
  name_key: string;
  division: AgentRecord['division'];
  prompt: string;
  prompt_public: number;
  summary: string | null;
  summary_status: AgentRecord['summaryStatus'];
  model_key_id: string | null;
  status: AgentRecord['status'];
  paused_reason: AgentRecord['pausedReason'];
  hidden: number;
  created_at: string;
  updated_at: string;
  strategy_changed_at: string;
  prompt_change_day: string | null;
  prompt_change_count: number;
}

export function toAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    nameKey: row.name_key,
    division: row.division,
    prompt: row.prompt,
    promptPublic: row.prompt_public === 1,
    summary: row.summary,
    summaryStatus: row.summary_status,
    modelKeyId: row.model_key_id,
    status: row.status,
    pausedReason: row.paused_reason,
    hidden: row.hidden === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    strategyChangedAt: row.strategy_changed_at,
    promptChangeDay: row.prompt_change_day,
    promptChangeCount: row.prompt_change_count,
  };
}

export interface AgentWorkRow extends AgentRow {
  portfolio: string;
  stats: string;
  key_failures: number;
}

export function toAgentWork(row: AgentWorkRow): AgentWork {
  return {
    agent: toAgent(row),
    portfolio: fromJson<PortfolioState>(row.portfolio),
    stats: fromJson<AgentStats>(row.stats),
    keyFailures: row.key_failures,
  };
}

export interface ModelKeyRow {
  id: string;
  owner: string;
  provider: ModelKeyRecord['provider'];
  model: string;
  last4: string;
  ciphertext: string;
  iv: string;
  key_version: number;
  created_at: string;
}

export function toModelKey(row: ModelKeyRow): ModelKeyRecord {
  return {
    id: row.id,
    owner: row.owner,
    provider: row.provider,
    model: row.model,
    last4: row.last4,
    ciphertext: row.ciphertext,
    iv: row.iv,
    keyVersion: row.key_version,
    createdAt: row.created_at,
  };
}

export interface SeasonRow {
  id: string;
  number: number;
  starts_at: string;
  ends_at: string;
}

export function toSeason(row: SeasonRow): Season {
  return { id: row.id, number: row.number, startsAt: row.starts_at, endsAt: row.ends_at };
}

export interface TickRow {
  id: string;
  season_id: string;
  daily: number;
  snapshot: string;
  status: Tick['status'];
  created_at: string;
  completed_at: string | null;
}

export function toTick(row: TickRow): Tick {
  return {
    id: row.id,
    seasonId: row.season_id,
    daily: row.daily === 1,
    snapshot: fromJson<MarketSnapshot>(row.snapshot),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** The last tick of one day: its id and its snapshot. */
export interface DailyPricesRow {
  id: string;
  snapshot: string;
}

/** The prices of that tick by symbol, halted symbols included, under the tick's UTC day. */
export function toDailyPrices(row: DailyPricesRow): DailyPrices {
  const prices: DailyPrices['prices'] = {};
  for (const point of fromJson<MarketSnapshot>(row.snapshot).prices) prices[point.symbol] = point.priceMicro;
  return { day: utcDayOfTick(row.id), prices };
}

export interface SymbolHoldRow {
  symbol: string;
  price_micro: number;
  seen_price_micro: number;
  since_tick_id: string;
  released_at: string | null;
  created_at: string;
}

export function toSymbolHold(row: SymbolHoldRow): SymbolHold {
  return {
    symbol: row.symbol,
    priceMicro: row.price_micro,
    seenPriceMicro: row.seen_price_micro,
    sinceTickId: row.since_tick_id,
    releasedAt: row.released_at,
    createdAt: row.created_at,
  };
}

/**
 * The season_scores columns that a league read joins by primary key (docs/contracts/phase-6-social.md
 * section 3). All null when the agent has no row.
 */
export interface OfficialColumns {
  official_method: string | null;
  official_unranked_reason: OfficialScore['unrankedReason'];
  official_score_milli: number | null;
  official_confidence: OfficialScore['confidence'];
  official_scored_day: string | null;
}

/** The official v2 score of a row, or null when there is no season_scores row or it is v1. */
export function toOfficialScore(row: OfficialColumns): OfficialScore | null {
  if (row.official_method !== 'v2') return null;
  return {
    unrankedReason: row.official_unranked_reason,
    scoreMilli: row.official_score_milli,
    confidence: row.official_confidence,
    scoredDay: row.official_scored_day,
  };
}

export interface PortfolioRow extends OfficialColumns {
  portfolio: string;
  stats: string;
  last_tick_id: string | null;
  rank: number | null;
}

export function toPortfolioRecord(row: PortfolioRow): PortfolioRecord {
  return {
    portfolio: fromJson<PortfolioState>(row.portfolio),
    stats: fromJson<AgentStats>(row.stats),
    lastTickId: row.last_tick_id,
    rank: row.rank,
    official: toOfficialScore(row),
  };
}

export interface StandingRowSql extends OfficialColumns {
  agent_id: string;
  name: string;
  summary: string | null;
  owner: string;
  created_at: string;
  rank: number | null;
  stats: string;
  last_tick_id: string | null;
  last_status: StandingSource['lastStatus'];
  portfolio: string;
}

/**
 * `prices` are the reference prices of the tick of the agent's latest row (docs/CONTRACTS.md
 * section 17.2), empty when it has none. Rows of one tick share one map; nothing changes it.
 */
export function toStandingSource(row: StandingRowSql, prices: PriceMap): StandingSource {
  return {
    agentId: row.agent_id,
    name: row.name,
    createdAt: row.created_at,
    rank: row.rank,
    stats: fromJson<AgentStats>(row.stats),
    lastTickId: row.last_tick_id,
    lastStatus: row.last_status,
    summary: row.summary,
    owner: row.owner,
    portfolio: fromJson<PortfolioState>(row.portfolio),
    prices,
    official: toOfficialScore(row),
  };
}

/** A standing read with the snapshot of its latest row's tick: null when it has no row. */
export interface StandingWithTickSql extends StandingRowSql {
  snapshot: string | null;
}

/** The prices of a stored snapshot by symbol, halted symbols included. */
export function pricesOfSnapshot(snapshot: string): PriceMap {
  const prices: PriceMap = {};
  for (const point of fromJson<MarketSnapshot>(snapshot).prices) prices[point.symbol] = point.priceMicro;
  return prices;
}

/** A row that carries one JSON document in a column named `body`. */
export interface BodyRow {
  body: string;
}

export function toDecisionRow(row: BodyRow): DecisionRow {
  return fromJson<DecisionRow>(row.body);
}

/**
 * A league state as stored. A v1 state is returned without `scoredDay`, as before the official rank
 * (docs/contracts/phase-6-social.md section 3): the stored body names it null, and a v1 reader never
 * looks at it. A v2 state keeps it, null before the season's first scored day.
 */
export function toLeagueState(row: BodyRow): LeagueState {
  const state = fromJson<LeagueState>(row.body);
  if (state.method !== 'v2' && (state.scoredDay === null || state.scoredDay === undefined)) {
    const { scoredDay: _unused, ...v1 } = state;
    return v1;
  }
  return state;
}

export function toMarketStatus(row: BodyRow): MarketStatus {
  return fromJson<MarketStatus>(row.body);
}
