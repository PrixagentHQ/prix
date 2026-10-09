import type {
  AgentExpectation,
  AgentPatch,
  AgentRecord,
  AgentStats,
  AgentWork,
  AiUse,
  DailyPrices,
  DecisionRow,
  Division,
  LeagueState,
  MarketStatus,
  ModelKeyRecord,
  OfficialScore,
  PortfolioRecord,
  PortfolioState,
  RowStatus,
  Season,
  SeasonMethod,
  SeasonScoreRow,
  SessionRecord,
  StandingSource,
  Store,
  SymbolHold,
  Tick,
  TrustedPrice,
  TrustedPrices,
} from '@prix/contracts';
import {
  agentRecordSchema,
  agentStatsSchema,
  decisionRowSchema,
  leagueStateSchema,
  MIN_DECISIONS_TO_RANK,
  MIN_TRADING_DAYS_TO_RANK,
  marketStatusSchema,
  modelKeyRecordSchema,
  portfolioStateSchema,
  seasonSchema,
  symbolHoldSchema,
  TRUSTED_PRICE_LOOKBACK_TICKS,
  tickSchema,
  utcDayOfTick,
} from '@prix/contracts';

/**
 * An in-memory `Store` that follows the comments of `packages/contracts/src/store.ts` and
 * the table notes of docs/CONTRACTS.md section 3.
 *
 * It follows revision 3 (docs/CONTRACTS.md section 15): a nonce is only recorded once it has
 * been used, a division and a wallet have caps that are decided here, a model key is returned
 * to its owner only, a hold is released before it is deleted, a row is refused when it would
 * break tick order, and an agent created at or after a tick's snapshot is not in that tick.
 *
 * Atomic guarantees. Every method does all of its reading and writing in one synchronous
 * block, with no `await` inside, so two overlapping calls can never interleave: exactly one
 * `useNonce` wins, `createTick` never overwrites, and `writeDecision` refuses a second
 * row for the same agent and tick without writing anything.
 *
 * Like a database, it copies everything on the way in and on the way out, so a caller that
 * mutates an object it passed or received cannot change what is stored. Like the D1 store,
 * it validates every JSON document against its schema when it is written, so a malformed
 * row from a builder fails loudly here instead of corrupting a record.
 */

interface PortfolioRow {
  agentId: string;
  seasonId: string;
  division: Division;
  portfolio: PortfolioState;
  stats: AgentStats;
  lastTickId: string | null;
  lastAskedTickId: string | null;
  lastStatus: RowStatus | null;
  rank: number | null;
  /** Rows in a row in which the provider refused the key or the model. */
  keyFailures: number;
  updatedAt: string;
}

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryStore implements Store {
  readonly users = new Map<string, string>();
  /** Nonces that have been used, with the expiry of each. An issued nonce is not stored. */
  readonly nonces = new Map<string, string>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly agents = new Map<string, AgentRecord>();
  readonly modelKeys = new Map<string, ModelKeyRecord>();
  readonly seasons = new Map<string, Season>();
  readonly portfolios = new Map<string, PortfolioRow>();
  readonly ticks = new Map<string, Tick>();
  readonly decisions = new Map<string, DecisionRow>();
  readonly leagueStates = new Map<string, LeagueState>();
  readonly holds = new Map<string, SymbolHold>();
  readonly aiUsage = new Map<string, number>();
  /** Rows the HTTP API has taken from each day's write budget. */
  readonly apiWriteRows = new Map<string, number>();
  /** State-changing requests per wallet and day. */
  readonly walletWrites = new Map<string, number>();
  marketStatus: MarketStatus | null = null;
  /** The time of the last `touchScheduler`. Null before the first one. */
  schedulerTouchedAt: string | null = null;

  /** How often each method was called, for the checks on the statement budget of a step. */
  /** Phase 6 part A: the scoring method of a season, set with `seedSeasonMethod`. A season without an entry is v1. */
  readonly seasonMethods = new Map<string, SeasonMethod>();
  /** Phase 6 part A: `season_scores` rows with their published rank, set with `seedSeasonScores`. */
  readonly seasonScores = new Map<string, SeasonScoreRow & { rank: number | null }>();
  readonly calls: Record<string, number> = {};
  /** When set, the named method rejects, to prove that callers survive a failing database. */
  failing: { method: string; times: number; error?: Error } | null = null;

  private enter(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    if (this.failing && this.failing.method === method && this.failing.times > 0) {
      this.failing.times -= 1;
      throw this.failing.error ?? new Error(`MemoryStore: ${method} failed on purpose`);
    }
  }

  /** Total calls since the last `resetCalls()`. */
  callCount(): number {
    return Object.values(this.calls).reduce((sum, value) => sum + value, 0);
  }

  resetCalls(): void {
    for (const key of Object.keys(this.calls)) delete this.calls[key];
  }

  /** Everything that is stored, as one JSON text: what a leak of the database would show. */
  dump(): string {
    return JSON.stringify({
      users: [...this.users],
      nonces: [...this.nonces],
      sessions: [...this.sessions],
      agents: [...this.agents],
      modelKeys: [...this.modelKeys],
      seasons: [...this.seasons],
      portfolios: [...this.portfolios],
      ticks: [...this.ticks],
      decisions: [...this.decisions],
      leagueStates: [...this.leagueStates],
      seasonMethods: [...this.seasonMethods],
      seasonScores: [...this.seasonScores],
      holds: [...this.holds],
      aiUsage: [...this.aiUsage],
      marketStatus: this.marketStatus,
      schedulerTouchedAt: this.schedulerTouchedAt,
    });
  }

  /** How many rows the store holds in all: what a request that "writes nothing" must not change. */
  rowCount(): number {
    return (
      this.users.size +
      this.nonces.size +
      this.sessions.size +
      this.agents.size +
      this.modelKeys.size +
      this.portfolios.size +
      this.ticks.size +
      this.decisions.size +
      this.leagueStates.size +
      this.holds.size +
      this.aiUsage.size
    );
  }

  /** Sets the scoring method of a season, as a `season_methods` row does. Not part of the `Store` interface. */
  seedSeasonMethod(seasonId: string, method: SeasonMethod): void {
    this.seasonMethods.set(seasonId, method);
  }

  /**
   * Sets `season_scores` rows, each with the rank the v2 ranking gave it (null when unranked).
   * A later call with the same season, division and agent replaces the row. Not part of the `Store` interface.
   */
  seedSeasonScores(rows: ReadonlyArray<SeasonScoreRow & { rank?: number | null }>): void {
    for (const row of rows) {
      const { rank, ...score } = row;
      this.seasonScores.set(`${row.seasonId}|${row.division}|${row.agentId}`, { ...copy(score), rank: rank ?? null });
    }
  }

  /** Seasons are seeded with a command, not through the `Store` interface. */
  seedSeason(season: Season): void {
    this.seasons.set(season.id, seasonSchema.parse(copy(season)));
  }

  // --- sign-in -----------------------------------------------------------------------------

  async useNonce(nonce: string, expiresAt: string): Promise<boolean> {
    this.enter('useNonce');
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAt);
    return true;
  }

  async putSession(session: SessionRecord): Promise<void> {
    this.enter('putSession');
    if (this.sessions.has(session.tokenHash)) throw new Error('MemoryStore: duplicate session');
    this.sessions.set(session.tokenHash, copy(session));
  }

  async getSession(tokenHash: string, now: string): Promise<SessionRecord | null> {
    this.enter('getSession');
    const row = this.sessions.get(tokenHash);
    if (!row || row.expiresAt <= now) return null;
    return copy(row);
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.enter('deleteSession');
    this.sessions.delete(tokenHash);
  }

  async touchUser(address: string, now: string): Promise<void> {
    this.enter('touchUser');
    if (!this.users.has(address)) this.users.set(address, now);
  }

  async deleteExpired(now: string, limit: number): Promise<void> {
    this.enter('deleteExpired');
    let removed = 0;
    for (const [nonce, expiresAt] of this.nonces) {
      if (removed >= limit) break;
      if (expiresAt <= now) {
        this.nonces.delete(nonce);
        removed += 1;
      }
    }
    removed = 0;
    for (const [hash, row] of this.sessions) {
      if (removed >= limit) break;
      if (row.expiresAt <= now) {
        this.sessions.delete(hash);
        removed += 1;
      }
    }
  }

  // --- agents ------------------------------------------------------------------------------

  async createAgent(
    agent: AgentRecord,
    seasonId: string,
    portfolio: PortfolioState,
    stats: AgentStats,
    maxInDivision: number,
    /** Phase 4: how many agents the wallet may own. One until the token says more. */
    maxPerOwner = 1,
  ): Promise<'created' | 'owner_has_agent' | 'name_taken' | 'league_full'> {
    this.enter('createAgent');
    const record = agentRecordSchema.parse(copy(agent));
    const startPortfolio = portfolioStateSchema.parse(copy(portfolio));
    const startStats = agentStatsSchema.parse(copy(stats));
    let ownedByWallet = 0;
    for (const existing of this.agents.values()) {
      if (existing.owner === record.owner) ownedByWallet += 1;
    }
    if (ownedByWallet >= maxPerOwner) return 'owner_has_agent';
    for (const existing of this.agents.values()) {
      if (existing.nameKey === record.nameKey) return 'name_taken';
    }
    // Paused agents count; a hidden agent frees its seat (docs/CONTRACTS.md section 15).
    let inDivision = 0;
    for (const existing of this.agents.values()) {
      if (existing.division === record.division && !existing.hidden) inDivision += 1;
    }
    if (inDivision >= maxInDivision) return 'league_full';
    if (this.agents.has(record.id)) throw new Error('MemoryStore: duplicate agent id');
    if (!this.seasons.has(seasonId)) throw new Error('MemoryStore: unknown season');
    this.agents.set(record.id, record);
    this.portfolios.set(`${record.id}|${seasonId}`, {
      agentId: record.id,
      seasonId,
      division: record.division,
      portfolio: startPortfolio,
      stats: startStats,
      lastTickId: null,
      lastAskedTickId: null,
      lastStatus: null,
      rank: null,
      keyFailures: 0,
      updatedAt: record.createdAt,
    });
    return 'created';
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    this.enter('getAgent');
    const agent = this.agents.get(id);
    return agent ? copy(agent) : null;
  }

  async listAgentsByOwner(owner: string): Promise<AgentRecord[]> {
    this.enter('listAgentsByOwner');
    return [...this.agents.values()]
      .filter((a) => a.owner === owner)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map(copy);
  }

  async getAgentByOwner(owner: string): Promise<AgentRecord | null> {
    this.enter('getAgentByOwner');
    // The oldest agent of the wallet: creation time, then id (docs/contracts/phase-4-token.md section 5.3).
    let oldest: AgentRecord | null = null;
    for (const agent of this.agents.values()) {
      if (agent.owner !== owner) continue;
      if (
        oldest === null ||
        agent.createdAt < oldest.createdAt ||
        (agent.createdAt === oldest.createdAt && agent.id < oldest.id)
      ) {
        oldest = agent;
      }
    }
    return oldest ? copy(oldest) : null;
  }

  async updateAgent(
    id: string,
    patch: AgentPatch,
    now: string,
    expectation?: AgentExpectation,
  ): Promise<'updated' | 'name_taken' | 'not_found' | 'changed'> {
    this.enter('updateAgent');
    const agent = this.agents.get(id);
    if (!agent) return 'not_found';
    if (
      expectation !== undefined &&
      (agent.promptChangeDay !== expectation.promptChangeDay ||
        agent.promptChangeCount !== expectation.promptChangeCount)
    ) {
      return 'changed';
    }
    if (patch.nameKey !== undefined) {
      for (const other of this.agents.values()) {
        if (other.id !== id && other.nameKey === patch.nameKey) return 'name_taken';
      }
    }
    const next: AgentRecord = { ...agent, updatedAt: now };
    const target = next as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) target[key] = copy(value);
    }
    this.agents.set(id, agentRecordSchema.parse(next));
    return 'updated';
  }

  async listAgentsNeedingSummary(limit: number): Promise<AgentRecord[]> {
    this.enter('listAgentsNeedingSummary');
    return [...this.agents.values()]
      .filter((agent) => agent.status === 'active' && !agent.hidden && agent.summaryStatus === 'pending')
      .sort((a, b) => order(a.createdAt, b.createdAt) || order(a.id, b.id))
      .slice(0, limit)
      .map(copy);
  }

  // --- model keys --------------------------------------------------------------------------

  async putModelKey(key: ModelKeyRecord, maxPerOwner: number): Promise<'stored' | 'key_limit_reached'> {
    this.enter('putModelKey');
    const record = modelKeyRecordSchema.parse(copy(key));
    let owned = 0;
    for (const existing of this.modelKeys.values()) {
      if (existing.owner === record.owner) owned += 1;
    }
    if (owned >= maxPerOwner) return 'key_limit_reached';
    if (this.modelKeys.has(record.id)) throw new Error('MemoryStore: duplicate model key id');
    this.modelKeys.set(record.id, record);
    return 'stored';
  }

  async listModelKeys(owner: string): Promise<ModelKeyRecord[]> {
    this.enter('listModelKeys');
    return [...this.modelKeys.values()].filter((key) => key.owner === owner).map(copy);
  }

  async getModelKey(id: string, owner: string): Promise<ModelKeyRecord | null> {
    this.enter('getModelKey');
    const key = this.modelKeys.get(id);
    return key && key.owner === owner ? copy(key) : null;
  }

  async deleteModelKey(id: string, owner: string, now: string): Promise<boolean> {
    this.enter('deleteModelKey');
    const key = this.modelKeys.get(id);
    if (!key || key.owner !== owner) return false;
    this.modelKeys.delete(id);
    for (const agent of this.agents.values()) {
      if (agent.modelKeyId !== id) continue;
      agent.status = 'paused';
      agent.pausedReason = 'key_removed';
      agent.modelKeyId = null;
      agent.updatedAt = now;
    }
    return true;
  }

  // --- seasons, market, ticks --------------------------------------------------------------

  async getActiveSeason(now: string): Promise<Season | null> {
    this.enter('getActiveSeason');
    for (const season of this.seasons.values()) {
      if (season.startsAt <= now && now < season.endsAt) return copy(season);
    }
    return null;
  }

  async getLatestStartedSeason(now: string): Promise<Season | null> {
    this.enter('getLatestStartedSeason');
    let latest: Season | null = null;
    for (const season of this.seasons.values()) {
      if (season.startsAt <= now && (latest === null || season.startsAt > latest.startsAt)) latest = season;
    }
    return latest ? copy(latest) : null;
  }

  async getSeason(id: string): Promise<Season | null> {
    this.enter('getSeason');
    const season = this.seasons.get(id);
    return season ? copy(season) : null;
  }

  async listSeasons(): Promise<Season[]> {
    this.enter('listSeasons');
    return [...this.seasons.values()].sort((a, b) => a.number - b.number).map(copy);
  }

  async getMarketStatus(): Promise<MarketStatus | null> {
    this.enter('getMarketStatus');
    return this.marketStatus ? copy(this.marketStatus) : null;
  }

  async putMarketStatus(status: MarketStatus): Promise<void> {
    this.enter('putMarketStatus');
    this.marketStatus = marketStatusSchema.parse(copy(status));
  }

  async getTick(id: string): Promise<Tick | null> {
    this.enter('getTick');
    const tick = this.ticks.get(id);
    return tick ? copy(tick) : null;
  }

  async getLatestTick(): Promise<Tick | null> {
    this.enter('getLatestTick');
    let latest: Tick | null = null;
    for (const tick of this.ticks.values()) {
      if (latest === null || tick.id > latest.id) latest = tick;
    }
    return latest ? copy(latest) : null;
  }

  async getLastTrustedPrices(beforeTickId: string): Promise<TrustedPrices> {
    this.enter('getLastTrustedPrices');
    const window = [...this.ticks.values()]
      .filter((tick) => tick.id < beforeTickId)
      .sort((a, b) => order(b.id, a.id))
      .slice(0, TRUSTED_PRICE_LOOKBACK_TICKS);
    const trusted: Partial<Record<string, TrustedPrice>> = {};
    for (const tick of window) {
      for (const point of tick.snapshot.prices) {
        if (point.fresh && trusted[point.symbol] === undefined) {
          trusted[point.symbol] = { priceMicro: point.priceMicro, tickId: tick.id };
        }
      }
    }
    return trusted;
  }

  async createTick(tick: Tick): Promise<boolean> {
    this.enter('createTick');
    const record = tickSchema.parse(copy(tick));
    if (this.ticks.has(record.id)) return false;
    this.ticks.set(record.id, record);
    return true;
  }

  async listProcessingTicks(): Promise<Tick[]> {
    this.enter('listProcessingTicks');
    return [...this.ticks.values()]
      .filter((tick) => tick.status === 'processing')
      .sort((a, b) => order(a.id, b.id))
      .map(copy);
  }

  async completeTick(id: string, completedAt: string): Promise<void> {
    this.enter('completeTick');
    const tick = this.ticks.get(id);
    if (!tick) return;
    tick.status = 'complete';
    tick.completedAt = completedAt;
    tickSchema.parse(tick);
  }

  async hasDailyTick(seasonId: string, day: string): Promise<boolean> {
    this.enter('hasDailyTick');
    for (const tick of this.ticks.values()) {
      if (tick.seasonId === seasonId && tick.daily && utcDayOfTick(tick.id) === day) return true;
    }
    return false;
  }

  async listDailyPrices(beforeDay: string, limit: number): Promise<DailyPrices[]> {
    this.enter('listDailyPrices');
    const lastOfDay = new Map<string, Tick>();
    for (const tick of this.ticks.values()) {
      const day = utcDayOfTick(tick.id);
      if (day >= beforeDay) continue;
      const seen = lastOfDay.get(day);
      if (!seen || tick.id > seen.id) lastOfDay.set(day, tick);
    }
    return [...lastOfDay.entries()]
      .sort((a, b) => order(b[0], a[0]))
      .slice(0, limit)
      .map(([day, tick]) => ({
        day,
        prices: Object.fromEntries(tick.snapshot.prices.map((point) => [point.symbol, point.priceMicro])),
      }));
  }

  // --- symbols held for review -------------------------------------------------------------

  async listSymbolHolds(): Promise<SymbolHold[]> {
    this.enter('listSymbolHolds');
    return [...this.holds.values()].sort((a, b) => order(a.symbol, b.symbol)).map(copy);
  }

  async putSymbolHold(hold: SymbolHold): Promise<void> {
    this.enter('putSymbolHold');
    const record = symbolHoldSchema.parse(copy(hold));
    if (!this.holds.has(record.symbol)) this.holds.set(record.symbol, record);
  }

  async deleteSymbolHold(symbol: string): Promise<boolean> {
    this.enter('deleteSymbolHold');
    return this.holds.delete(symbol);
  }

  async releaseSymbolHold(symbol: string, releasedAt: string): Promise<boolean> {
    this.enter('releaseSymbolHold');
    const hold = this.holds.get(symbol);
    if (!hold || hold.releasedAt !== null) return false;
    this.holds.set(symbol, symbolHoldSchema.parse({ ...hold, releasedAt }));
    return true;
  }

  // --- scheduler work ----------------------------------------------------------------------

  private pending(tickId: string, division: Division): PortfolioRow[] {
    const tick = this.ticks.get(tickId);
    if (!tick) return [];
    const rows: PortfolioRow[] = [];
    for (const row of this.portfolios.values()) {
      if (row.seasonId !== tick.seasonId || row.division !== division) continue;
      const agent = this.agents.get(row.agentId);
      if (agent?.status !== 'active' || agent.hidden) continue;
      // Membership is fixed at the snapshot: an agent created at or after it is not in the tick.
      if (agent.createdAt >= tick.createdAt) continue;
      // An agent whose latest row is at this tick or at a later one has nothing pending here.
      if (row.lastTickId !== null && row.lastTickId >= tickId) continue;
      rows.push(row);
    }
    // Asked longest ago first, never asked before all others, ties by agent id.
    return rows.sort((a, b) => {
      if (a.lastAskedTickId === null && b.lastAskedTickId !== null) return -1;
      if (a.lastAskedTickId !== null && b.lastAskedTickId === null) return 1;
      return order(a.lastAskedTickId ?? '', b.lastAskedTickId ?? '') || order(a.agentId, b.agentId);
    });
  }

  async listPendingAgents(tickId: string, division: Division, limit: number): Promise<AgentWork[]> {
    this.enter('listPendingAgents');
    return this.pending(tickId, division)
      .slice(0, limit)
      .map((row) => ({
        agent: copy(this.agents.get(row.agentId) as AgentRecord),
        portfolio: copy(row.portfolio),
        stats: copy(row.stats),
        keyFailures: row.keyFailures,
      }));
  }

  async countPendingAgents(tickId: string, division: Division): Promise<number> {
    this.enter('countPendingAgents');
    return this.pending(tickId, division).length;
  }

  async writeDecision(row: DecisionRow, stats: AgentStats, keyFailures: number): Promise<boolean> {
    this.enter('writeDecision');
    const record = decisionRowSchema.parse(copy(row));
    const nextStats = agentStatsSchema.parse(copy(stats));
    if (!Number.isSafeInteger(keyFailures) || keyFailures < 0) {
      throw new Error('MemoryStore: keyFailures must be a count');
    }
    const key = `${record.agentId}|${record.tickId}`;
    if (this.decisions.has(key)) return false;
    const portfolio = this.portfolios.get(`${record.agentId}|${record.seasonId}`);
    // No portfolio in the row's season: nothing is written.
    if (!portfolio) return false;
    // A row for an earlier tick than the agent's latest would break tick order: nothing is written.
    if (portfolio.lastTickId !== null && portfolio.lastTickId >= record.tickId) return false;
    this.decisions.set(key, record);
    portfolio.portfolio = copy(record.portfolio);
    portfolio.stats = nextStats;
    portfolio.lastTickId = record.tickId;
    portfolio.lastStatus = record.status;
    portfolio.keyFailures = keyFailures;
    // A skipped row does not count as being asked.
    if (record.status !== 'skipped') portfolio.lastAskedTickId = record.tickId;
    portfolio.updatedAt = record.createdAt;
    return true;
  }

  async touchScheduler(now: string): Promise<void> {
    this.enter('touchScheduler');
    this.schedulerTouchedAt = now;
  }

  /**
   * Written from docs/CONTRACTS.md section 9 on its own, without `scoring.rankAgents`, the
   * way the D1 store ranks in SQL: the thresholds as values and the five-key order.
   */
  private standingOrder(a: PortfolioRow, b: PortfolioRow): number {
    const agentA = this.agents.get(a.agentId) as AgentRecord;
    const agentB = this.agents.get(b.agentId) as AgentRecord;
    return (
      b.stats.seasonReturnBps - a.stats.seasonReturnBps ||
      a.stats.maxDrawdownBps - b.stats.maxDrawdownBps ||
      a.stats.tradeCount - b.stats.tradeCount ||
      order(agentA.createdAt, agentB.createdAt) ||
      order(a.agentId, b.agentId)
    );
  }

  private visibleRows(seasonId: string, division: Division): PortfolioRow[] {
    return [...this.portfolios.values()].filter((row) => {
      if (row.seasonId !== seasonId || row.division !== division) return false;
      const agent = this.agents.get(row.agentId);
      return agent !== undefined && !agent.hidden;
    });
  }

  async rerank(
    seasonId: string,
    division: Division,
    tickId: string,
    computedAt: string,
    method: string,
  ): Promise<LeagueState> {
    this.enter('rerank');
    const seasonMethod = this.seasonMethods.get(seasonId);
    const v2 = seasonMethod === 'v2';
    const visible = this.visibleRows(seasonId, division);
    let rankedCount: number;
    if (v2) {
      // Phase 6 part A: the published rank is the official v2 rank, copied from season_scores for
      // visible agents. Nothing is computed, and the `method` argument is ignored.
      const official = new Map<string, number>();
      for (const score of this.seasonScores.values()) {
        if (score.seasonId !== seasonId || score.division !== division || score.rank === null) continue;
        if (this.agents.get(score.agentId)?.hidden === false) official.set(score.agentId, score.rank);
      }
      for (const row of this.portfolios.values()) {
        if (row.seasonId !== seasonId || row.division !== division) continue;
        row.rank = official.get(row.agentId) ?? null;
      }
      rankedCount = [...this.portfolios.values()].filter(
        (row) => row.seasonId === seasonId && row.division === division && row.rank !== null,
      ).length;
    } else {
      for (const row of this.portfolios.values()) {
        if (row.seasonId === seasonId && row.division === division) row.rank = null;
      }
      const ranked = visible
        .filter(
          (row) =>
            row.lastTickId !== null &&
            row.lastTickId >= tickId &&
            row.stats.tradingDays >= MIN_TRADING_DAYS_TO_RANK &&
            row.stats.decidedCount >= MIN_DECISIONS_TO_RANK,
        )
        .sort((a, b) => this.standingOrder(a, b));
      ranked.forEach((row, index) => {
        row.rank = index + 1;
      });
      rankedCount = ranked.length;
    }
    const scoredDays = [...this.seasonScores.values()]
      .filter(
        (score) =>
          score.seasonId === seasonId &&
          score.division === division &&
          score.method === 'v2' &&
          score.scoredDay !== null,
      )
      .map((score) => score.scoredDay as string)
      .sort(order);
    const state = leagueStateSchema.parse({
      seasonId,
      division,
      tickId,
      computedAt,
      method: seasonMethod ?? method,
      rankedCount,
      agentCount: visible.length,
      // Like the D1 store, a v1 state leaves scoredDay out; a v2 state has the latest scored day or null.
      ...(v2 ? { scoredDay: scoredDays[scoredDays.length - 1] ?? null } : {}),
    });
    this.leagueStates.set(`${seasonId}|${division}`, state);
    return copy(state);
  }

  // --- reads -------------------------------------------------------------------------------

  async getPortfolio(agentId: string, seasonId: string): Promise<PortfolioRecord | null> {
    this.enter('getPortfolio');
    const row = this.portfolios.get(`${agentId}|${seasonId}`);
    if (!row) return null;
    const official = this.officialOf(row);
    return copy({
      portfolio: row.portfolio,
      stats: row.stats,
      lastTickId: row.lastTickId,
      rank: row.rank,
      official,
    });
  }

  /**
   * Phase 6 part A: in a v2 season the season_scores row of the agent as an `OfficialScore`, null when
   * there is no v2 row. A v1 season returns null too (docs/contracts/phase-6-social.md section 3).
   */
  private officialOf(row: PortfolioRow): OfficialScore | null {
    if (this.seasonMethods.get(row.seasonId) !== 'v2') return null;
    const score = this.seasonScores.get(`${row.seasonId}|${row.division}|${row.agentId}`);
    if (score?.method !== 'v2') return null;
    return {
      unrankedReason: score.unrankedReason,
      scoreMilli: score.scoreMilli,
      confidence: score.confidence,
      scoredDay: score.scoredDay,
    };
  }

  async listDecisions(agentId: string, seasonId: string, limit: number): Promise<DecisionRow[]> {
    this.enter('listDecisions');
    return [...this.decisions.values()]
      .filter((row) => row.agentId === agentId && row.seasonId === seasonId)
      .sort((a, b) => order(b.tickId, a.tickId))
      .slice(0, limit)
      .map(copy);
  }

  async getLeagueState(seasonId: string, division: Division): Promise<LeagueState | null> {
    this.enter('getLeagueState');
    const state = this.leagueStates.get(`${seasonId}|${division}`);
    return state ? copy(state) : null;
  }

  private toStanding(row: PortfolioRow): StandingSource {
    const agent = this.agents.get(row.agentId) as AgentRecord;
    // Section 17.2: the prices of the tick of the latest row, halted symbols included.
    const prices: Record<string, number> = {};
    const tick = row.lastTickId === null ? undefined : this.ticks.get(row.lastTickId);
    for (const point of tick?.snapshot.prices ?? []) prices[point.symbol] = point.priceMicro;
    const official = this.officialOf(row);
    return copy({
      agentId: row.agentId,
      name: agent.name,
      createdAt: agent.createdAt,
      rank: row.rank,
      stats: row.stats,
      lastTickId: row.lastTickId,
      lastStatus: row.lastStatus,
      // Revision 5: the summary for the card, and the owner for the house mark.
      summary: agent.summary,
      owner: agent.owner,
      portfolio: row.portfolio,
      prices,
      official,
    });
  }

  async listStandings(seasonId: string, division: Division, limit: number, offset: number): Promise<StandingSource[]> {
    this.enter('listStandings');
    const visible = this.visibleRows(seasonId, division);
    const ranked = visible.filter((row) => row.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number));
    const unranked = visible.filter((row) => row.rank === null).sort((a, b) => this.standingOrder(a, b));
    return [...ranked, ...unranked].slice(offset, offset + limit).map((row) => this.toStanding(row));
  }

  async getStanding(agentId: string, seasonId: string): Promise<StandingSource | null> {
    this.enter('getStanding');
    const row = this.portfolios.get(`${agentId}|${seasonId}`);
    const agent = this.agents.get(agentId);
    if (!row || !agent || agent.hidden) return null;
    return this.toStanding(row);
  }

  // --- budgets -----------------------------------------------------------------------------

  async spendApiWrites(day: string, rows: number, max: number): Promise<boolean> {
    this.enter('spendApiWrites');
    if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('MemoryStore: rows must be a positive count');
    const used = this.apiWriteRows.get(day) ?? 0;
    if (used + rows > max) return false;
    this.apiWriteRows.set(day, used + rows);
    return true;
  }

  async spendWalletWrite(address: string, day: string, max: number): Promise<boolean> {
    this.enter('spendWalletWrite');
    const key = `${address.toLowerCase()}|${day}`;
    const used = this.walletWrites.get(key) ?? 0;
    if (used >= max) return false;
    this.walletWrites.set(key, used + 1);
    return true;
  }

  async getAiNeurons(day: string, use: AiUse): Promise<number> {
    this.enter('getAiNeurons');
    return this.aiUsage.get(`${use}|${day}`) ?? 0;
  }

  async addAiNeurons(day: string, use: AiUse, neurons: number): Promise<void> {
    this.enter('addAiNeurons');
    if (!Number.isFinite(neurons) || neurons < 0) throw new Error('MemoryStore: neurons must be zero or positive');
    const key = `${use}|${day}`;
    this.aiUsage.set(key, (this.aiUsage.get(key) ?? 0) + neurons);
  }
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A fresh store with the given seasons seeded. */
export function createMemoryStore(seasons: readonly Season[] = []): MemoryStore {
  const store = new MemoryStore();
  for (const season of seasons) store.seedSeason(season);
  return store;
}
