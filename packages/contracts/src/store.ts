import type { AgentPatch, AgentRecord } from './agents.ts';
import type { DailyPrices, MarketStatus } from './market.ts';
import type { ModelKeyRecord } from './models.ts';
import type { PortfolioState } from './portfolio.ts';
import type {
  Address,
  AgentId,
  Division,
  IsoTime,
  ModelKeyId,
  SeasonId,
  TickId,
  TokenSymbol,
  UtcDay,
} from './primitives.ts';
import type { AgentStats, LeagueState, OfficialScore, StandingSource } from './scoring.ts';
import type { AgentWork, DecisionRow, Season, SymbolHold, Tick } from './ticks.ts';

/** How far back `getLastTrustedPrices` looks: eight trading days of five rounds. */
export const TRUSTED_PRICE_LOOKBACK_TICKS = 40;

/** A price that was fresh when it was taken, and the tick it came from. */
export interface TrustedPrice {
  priceMicro: number;
  tickId: TickId;
}

/** The last trusted price of each symbol that has one. */
export type TrustedPrices = Readonly<Partial<Record<TokenSymbol, TrustedPrice>>>;

export interface SessionRecord {
  /** SHA-256 of the session token, in hex. The token itself is never stored. */
  tokenHash: string;
  address: Address;
  createdAt: IsoTime;
  expiresAt: IsoTime;
}

export interface PortfolioRecord {
  portfolio: PortfolioState;
  stats: AgentStats;
  /** The tick of the agent's latest row this season. Null before the first one. */
  lastTickId: TickId | null;
  /** The published rank from the last ranking. Null if the agent was not ranked then. */
  rank: number | null;
  /** v2 seasons only: the agent's season_scores row, read by primary key. Null when there is none. */
  official?: OfficialScore | null;
}

/**
 * Everything the product stores, behind one interface. `platform` implements it for D1 in
 * `apps/api/src/store/`. The API and the scheduler depend on this interface only, so they
 * can be tested against an in-memory store. docs/CONTRACTS.md section 3 lists the tables.
 *
 * Every method is one D1 call or one D1 batch. A batch is a transaction. No method loads
 * every agent into the Worker: anything that touches a whole division happens in SQL.
 */
export interface Store {
  // --- sign-in -----------------------------------------------------------------------------

  /**
   * Records that a sign-in nonce has been used. True the first time, false if it was used
   * before. Atomic. The API calls it only after it has checked the nonce's own signature and
   * expiry and the wallet's signature, so nobody without a valid sign-in can make it write.
   */
  useNonce(nonce: string, expiresAt: IsoTime): Promise<boolean>;
  putSession(session: SessionRecord): Promise<void>;
  /** Null for an unknown or expired session. */
  getSession(tokenHash: string, now: IsoTime): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Records the wallet on its first sign-in. Does nothing afterwards. */
  touchUser(address: Address, now: IsoTime): Promise<void>;
  /** Deletes expired nonces and expired sessions, at most `limit` rows of each. */
  deleteExpired(now: IsoTime, limit: number): Promise<void>;

  // --- agents ------------------------------------------------------------------------------

  /**
   * Creates the agent, and its portfolio for `seasonId` with `portfolio` and `stats`, in one batch.
   * A wallet owns at most `maxPerOwner` agents (default 1 as in Phase 1; Phase 4 passes the wallet's
   * `Entitlements.maxAgents`), and a name key belongs to one agent. Both are decided in SQL in the same batch.
   */
  createAgent(
    agent: AgentRecord,
    seasonId: SeasonId,
    portfolio: PortfolioState,
    stats: AgentStats,
    /** The most agents the agent's division may hold. Decided in SQL, in the same batch. */
    maxInDivision: number,
    /** Phase 4. `owner_has_agent` then means "the wallet is at its limit". */
    maxPerOwner?: number,
  ): Promise<'created' | 'owner_has_agent' | 'name_taken' | 'league_full'>;
  getAgent(id: AgentId): Promise<AgentRecord | null>;
  /** Every agent of the wallet in creation order (created_at, then id): the oldest keep the slots. */
  listAgentsByOwner(owner: Address): Promise<AgentRecord[]>;
  /** The oldest agent of the wallet (Phase 4: a wallet may own several). */
  getAgentByOwner(owner: Address): Promise<AgentRecord | null>;
  /**
   * With `expect`, the patch applies only while the agent's prompt-change counters are still
   * the ones the caller read, in the same statement: two requests that read the same count
   * cannot both pass the daily cap. `changed` means they were not; the caller reads again.
   */
  updateAgent(
    id: AgentId,
    patch: AgentPatch,
    now: IsoTime,
    expect?: AgentExpectation,
  ): Promise<'updated' | 'name_taken' | 'not_found' | 'changed'>;
  /** Active, visible agents whose summary is pending, oldest first. */
  listAgentsNeedingSummary(limit: number): Promise<AgentRecord[]>;

  // --- model keys --------------------------------------------------------------------------

  /** Stores the key unless the owner already has `maxPerOwner` keys. Decided in SQL. */
  putModelKey(key: ModelKeyRecord, maxPerOwner: number): Promise<'stored' | 'key_limit_reached'>;
  listModelKeys(owner: Address): Promise<ModelKeyRecord[]>;
  /** Null unless the key exists and belongs to `owner`. */
  getModelKey(id: ModelKeyId, owner: Address): Promise<ModelKeyRecord | null>;
  /**
   * Deletes the row. An agent that used the key is paused with reason `key_removed` and its
   * `modelKeyId` becomes null, in the same batch. False if the key was not the owner's.
   */
  deleteModelKey(id: ModelKeyId, owner: Address, now: IsoTime): Promise<boolean>;

  // --- seasons, market, ticks --------------------------------------------------------------

  /** The season that contains `now`. */
  getActiveSeason(now: IsoTime): Promise<Season | null>;
  /** The latest season that had started at `now`, whether or not it has ended. */
  getLatestStartedSeason(now: IsoTime): Promise<Season | null>;
  getSeason(id: SeasonId): Promise<Season | null>;
  listSeasons(): Promise<Season[]>;
  getMarketStatus(): Promise<MarketStatus | null>;
  putMarketStatus(status: MarketStatus): Promise<void>;
  getTick(id: TickId): Promise<Tick | null>;
  /** The newest tick, whatever its status. */
  getLatestTick(): Promise<Tick | null>;
  /**
   * The last trusted price of each symbol: its point in the newest tick before `beforeTickId` in which it was
   * fresh, looking back at most `TRUSTED_PRICE_LOOKBACK_TICKS` ticks. A symbol without one is absent. The
   * suspect-move hold compares every new point with this, not with the latest tick, so a symbol that was
   * paused or stale for a round is still compared (security review of 2026-10-08, the newest reads, finding 1).
   */
  getLastTrustedPrices(beforeTickId: TickId): Promise<TrustedPrices>;
  /** False if the tick already existed. Never overwrites. */
  createTick(tick: Tick): Promise<boolean>;
  /** Ticks whose status is still "processing", oldest first. */
  listProcessingTicks(): Promise<Tick[]>;
  completeTick(id: TickId, completedAt: IsoTime): Promise<void>;
  /** True if the season already has a daily tick on that UTC day. */
  hasDailyTick(seasonId: SeasonId, day: UtcDay): Promise<boolean>;
  /** The prices of the last tick of each earlier trading day, newest first. */
  listDailyPrices(beforeDay: UtcDay, limit: number): Promise<DailyPrices[]>;

  // --- symbols held for review -------------------------------------------------------------

  listSymbolHolds(): Promise<SymbolHold[]>;
  /** Does nothing if the symbol is already held. */
  putSymbolHold(hold: SymbolHold): Promise<void>;
  /** False if the symbol was not held. */
  deleteSymbolHold(symbol: TokenSymbol): Promise<boolean>;
  /** Sets `releasedAt`. False if the symbol was not held or was already released. */
  releaseSymbolHold(symbol: TokenSymbol, releasedAt: IsoTime): Promise<boolean>;

  // --- scheduler work ----------------------------------------------------------------------

  /**
   * Active, visible agents of the division that have no row for the tick yet, with their
   * portfolio and stats for the tick's season. Fair order: the agent that was asked longest
   * ago comes first, an agent that has never been asked before all others, ties by agent id.
   * A skipped row does not count as being asked.
   */
  listPendingAgents(tickId: TickId, division: Division, limit: number): Promise<AgentWork[]>;
  countPendingAgents(tickId: TickId, division: Division): Promise<number>;
  /**
   * Inserts the row and stores the agent's new portfolio, stats and `keyFailures`, in one batch.
   * False, and nothing written, if the agent already has a row for that tick or for a later
   * one, or has no portfolio in the row's season: a retry can never apply a decision twice,
   * and an agent's rows are always in tick order.
   */
  writeDecision(row: DecisionRow, stats: AgentStats, keyFailures: number): Promise<boolean>;
  /**
   * One small write that proves the database accepts writes. A step calls it before it asks
   * any model, so a database that has stopped taking writes cannot turn into model spend.
   */
  touchScheduler(now: IsoTime): Promise<void>;
  /**
   * Publishes the ranks of one division as of `tickId`, in SQL, and replaces its league state.
   * An agent is ranked if it is visible, has a row at `tickId` or at a later tick, and meets both thresholds.
   * The order is the one in docs/CONTRACTS.md section 9. Safe to run twice.
   * In a season whose season_methods row is v2, the published rank is instead the official v2 rank copied
   * from season_scores (visible agents only, null for the rest), `method` is ignored, and the league state
   * says method 'v2' with scoredDay = max(season_scores.scored_day) of the division (section 18).
   */
  rerank(
    seasonId: SeasonId,
    division: Division,
    tickId: TickId,
    computedAt: IsoTime,
    method: string,
  ): Promise<LeagueState>;

  // --- reads -------------------------------------------------------------------------------

  getPortfolio(agentId: AgentId, seasonId: SeasonId): Promise<PortfolioRecord | null>;
  /** The agent's rows in the season, newest first. */
  listDecisions(agentId: AgentId, seasonId: SeasonId, limit: number): Promise<DecisionRow[]>;
  getLeagueState(seasonId: SeasonId, division: Division): Promise<LeagueState | null>;
  /**
   * One page of a league table: ranked agents by rank, then the unranked ones in the order
   * of section 9. Hidden agents are left out.
   */
  listStandings(seasonId: SeasonId, division: Division, limit: number, offset: number): Promise<StandingSource[]>;
  /** One agent's standing. Null if it is hidden or has no portfolio in the season. */
  getStanding(agentId: AgentId, seasonId: SeasonId): Promise<StandingSource | null>;

  // --- budgets -----------------------------------------------------------------------------

  /**
   * Neurons of the house model counted so far on that UTC day, for one use. Decisions and
   * summaries are counted apart, each against its own daily budget, so that the daily round
   * cannot leave a new agent without its summary until midnight.
   */
  /**
   * Takes `rows` from the day's budget of rows the HTTP API may write, in one statement.
   * False when that would pass `max`: the caller then answers `daily_limit` and writes nothing.
   * The scheduler never calls this.
   */
  spendApiWrites(day: UtcDay, rows: number, max: number): Promise<boolean>;
  /** Counts one state-changing request of a wallet on that day. False when it has reached `max`. */
  spendWalletWrite(address: Address, day: UtcDay, max: number): Promise<boolean>;

  getAiNeurons(day: UtcDay, use: AiUse): Promise<number>;
  addAiNeurons(day: UtcDay, use: AiUse, neurons: number): Promise<void>;
}

/** What the house model was used for. */
export type AiUse = 'decision' | 'summary';

/** What must still be true of an agent for `updateAgent` to apply a patch. */
export interface AgentExpectation {
  promptChangeDay: string | null;
  promptChangeCount: number;
}

/**
 * Thrown by a store when the database answers that a daily limit of the plan is used up.
 * The API turns it into 503 `daily_limit`; the scheduler logs it and ends its step.
 */
export class DailyLimitError extends Error {
  readonly code = 'daily_limit';

  constructor(message = 'A daily limit of the database is used up.') {
    super(message);
    this.name = 'DailyLimitError';
  }
}
