import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { AgentPatch, PriceMap, Store, TrustedPrice } from '@prix/contracts';
import {
  agentNameKey,
  agentStatsSchema,
  DailyLimitError,
  decisionRowSchema,
  MIN_DECISIONS_TO_RANK,
  MIN_TRADING_DAYS_TO_RANK,
  marketStatusSchema,
  portfolioStateSchema,
  TRUSTED_PRICE_LOOKBACK_TICKS,
  tickSchema,
} from '@prix/contracts';
import { UNIVERSE } from '@prix/market/universe';
import type {
  AgentRow,
  AgentWorkRow,
  BodyRow,
  DailyPricesRow,
  ModelKeyRow,
  PortfolioRow,
  SeasonRow,
  SessionRow,
  StandingRowSql,
  StandingWithTickSql,
  SymbolHoldRow,
  TickRow,
} from './rows.ts';
import {
  pricesOfSnapshot,
  toAgent,
  toAgentWork,
  toDailyPrices,
  toDecisionRow,
  toLeagueState,
  toMarketStatus,
  toModelKey,
  toPortfolioRecord,
  toSeason,
  toSession,
  toStandingSource,
  toSymbolHold,
  toTick,
} from './rows.ts';
import type { AgentPatchField } from './sql.ts';
import * as sql from './sql.ts';

type Bound = string | number | null;

/** The order in which a patch's fields are written. Fixed, so the same patch gives the same SQL. */
const PATCH_FIELDS = Object.keys(sql.AGENT_PATCH_COLUMNS) as AgentPatchField[];

function flag(value: boolean): number {
  return value ? 1 : 0;
}

/** The value a patch field is bound as. A boolean is stored as 0 or 1. */
function patchValue(value: string | number | boolean | null): Bound {
  return typeof value === 'boolean' ? flag(value) : value;
}

/**
 * A limit or a count from the caller: a whole number, zero or more. Anything else would
 * compare as NULL in SQL and quietly refuse or allow everything, so it fails here instead.
 */
function wholeNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`store: ${name} must be a whole number, zero or more`);
  }
  return value;
}

/** The rows that one statement of a batch returned. */
function rowsOf<T>(results: D1Result<unknown>[], index: number): T[] {
  const result = results[index];
  if (result === undefined) throw new Error(`store: the batch returned no result for statement ${index}`);
  return result.results as T[];
}

/**
 * The D1 implementation of `Store`. docs/CONTRACTS.md section 3 lists the tables,
 * infra/migrations creates them and ./sql.ts holds every statement.
 *
 * Every method is one D1 call or one D1 batch, and a batch is a transaction. Every guarantee
 * that must survive a retry or two overlapping calls is a condition inside a statement and a
 * key or unique index behind it. None of them is a read followed by a write from the Worker.
 */
/** The symbols `getLastTrustedPrices` looks for: the whole universe, Stock Tokens and crypto assets. */
const UNIVERSE_SYMBOLS: ReadonlySet<string> = new Set(UNIVERSE.map((token) => token.symbol));

export function createD1Store(db: D1Database): Store {
  function prepare(statement: string, ...values: Bound[]): D1PreparedStatement {
    return db.prepare(statement).bind(...values);
  }

  async function first<T>(statement: string, ...values: Bound[]): Promise<T | null> {
    return prepare(statement, ...values).first<T>();
  }

  async function all<T>(statement: string, ...values: Bound[]): Promise<T[]> {
    const result = await prepare(statement, ...values).all<T>();
    return result.results;
  }

  async function run(statement: string, ...values: Bound[]): Promise<void> {
    await prepare(statement, ...values).run();
  }

  const store: Store = {
    // --- sign-in ---------------------------------------------------------------------------------

    async useNonce(nonce, expiresAt) {
      const used = await all<{ nonce: string }>(sql.USE_NONCE, nonce, expiresAt);
      return used.length === 1;
    },

    async putSession(session) {
      await run(sql.PUT_SESSION, session.tokenHash, session.address, session.createdAt, session.expiresAt);
    },

    async getSession(tokenHash, now) {
      const row = await first<SessionRow>(sql.GET_SESSION, tokenHash, now);
      return row === null ? null : toSession(row);
    },

    async deleteSession(tokenHash) {
      await run(sql.DELETE_SESSION, tokenHash);
    },

    async touchUser(address, now) {
      await run(sql.TOUCH_USER, address, now);
    },

    async deleteExpired(now, limit) {
      await db.batch([
        prepare(sql.DELETE_EXPIRED_NONCES, now, limit),
        prepare(sql.DELETE_EXPIRED_SESSIONS, now, limit),
      ]);
    },

    // --- agents ----------------------------------------------------------------------------------

    async createAgent(agent, seasonId, portfolio, stats, maxInDivision, maxPerOwner = 1) {
      const portfolioJson = JSON.stringify(portfolioStateSchema.parse(portfolio));
      const checkedStats = agentStatsSchema.parse(stats);
      const max = wholeNumber(maxInDivision, 'maxInDivision');
      const maxOwner = wholeNumber(maxPerOwner, 'maxPerOwner');
      const results = await db.batch([
        prepare(sql.CREATE_AGENT_CHECK, agent.owner, agent.nameKey, agent.division, max, maxOwner),
        prepare(
          sql.CREATE_AGENT_PORTFOLIO,
          agent.id,
          seasonId,
          agent.division,
          portfolioJson,
          JSON.stringify(checkedStats),
          checkedStats.seasonReturnBps,
          checkedStats.maxDrawdownBps,
          checkedStats.tradeCount,
          checkedStats.tradingDays,
          checkedStats.decidedCount,
          agent.createdAt,
          agent.owner,
          agent.nameKey,
          max,
          maxOwner,
        ),
        prepare(
          sql.CREATE_AGENT,
          agent.id,
          agent.owner,
          agent.name,
          agent.nameKey,
          agent.division,
          agent.prompt,
          flag(agent.promptPublic),
          agent.summary,
          agent.summaryStatus,
          agent.modelKeyId,
          agent.status,
          agent.pausedReason,
          flag(agent.hidden),
          agent.createdAt,
          agent.updatedAt,
          agent.strategyChangedAt,
          agent.promptChangeDay,
          agent.promptChangeCount,
          max,
          maxOwner,
        ),
      ]);
      const refused = rowsOf<{ owner_taken: number; name_taken: number; league_full: number }>(results, 0)[0];
      if (refused?.owner_taken === 1) return 'owner_has_agent';
      if (refused?.name_taken === 1) return 'name_taken';
      if (refused?.league_full === 1) return 'league_full';
      if (rowsOf<{ id: string }>(results, 2).length === 1) return 'created';
      // The wallet and the name were free and the division had room, and still nothing was
      // inserted: the new id is already in use. Ids are random, so this is a bug in the
      // caller, not a refusal.
      throw new Error('store.createAgent: the agent id is already in use');
    },

    async getAgent(id) {
      const row = await first<AgentRow>(sql.GET_AGENT, id);
      return row === null ? null : toAgent(row);
    },

    async listAgentsByOwner(owner) {
      const { results } = await db.prepare(sql.LIST_AGENTS_BY_OWNER).bind(owner).all<AgentRow>();
      return results.map(toAgent);
    },

    async getAgentByOwner(owner) {
      const row = await first<AgentRow>(sql.GET_AGENT_BY_OWNER, owner);
      return row === null ? null : toAgent(row);
    },

    async updateAgent(id, patch, now, expect) {
      // A name and its key travel together: a new name without a key gets the key of that name,
      // so the stored key can never describe an older name.
      const full: AgentPatch =
        patch.name !== undefined && patch.nameKey === undefined
          ? { ...patch, nameKey: agentNameKey(patch.name) }
          : patch;
      const fields = PATCH_FIELDS.filter((field) => full[field] !== undefined);
      const values = fields.map((field) => patchValue(full[field] ?? null));
      const nameKey = full.nameKey;
      const expected: Bound[] = expect ? [expect.promptChangeDay, expect.promptChangeCount] : [];
      const withExpect = expect !== undefined;
      // Zero rows with an expectation: the agent either moved on (changed) or is not there.
      const missOrChanged = async () => {
        if (!withExpect) return 'not_found' as const;
        const found = await first<{ id: string }>('SELECT id FROM agents WHERE id = ?1', id);
        return found === null ? ('not_found' as const) : ('changed' as const);
      };

      if (nameKey === undefined) {
        const updated = await all<{ id: string }>(
          sql.updateAgentSql(fields, null, withExpect),
          id,
          now,
          ...values,
          ...expected,
        );
        return updated.length === 1 ? 'updated' : missOrChanged();
      }

      const nameKeyParam = fields.indexOf('nameKey') + 3;
      const results = await db.batch([
        prepare(sql.UPDATE_AGENT_CHECK, id, nameKey),
        prepare(sql.updateAgentSql(fields, nameKeyParam, withExpect), id, now, ...values, ...expected),
      ]);
      if (rowsOf<{ id: string }>(results, 1).length === 1) return 'updated';
      const check = rowsOf<{ found: number; name_taken: number }>(results, 0)[0];
      if (check?.found !== 1) return 'not_found';
      if (check.name_taken === 1) return 'name_taken';
      return withExpect ? 'changed' : 'name_taken';
    },

    async listAgentsNeedingSummary(limit) {
      const rows = await all<AgentRow>(sql.LIST_AGENTS_NEEDING_SUMMARY, limit);
      return rows.map(toAgent);
    },

    // --- model keys ------------------------------------------------------------------------------

    async putModelKey(key, maxPerOwner) {
      const stored = await all<{ id: string }>(
        sql.PUT_MODEL_KEY,
        key.id,
        key.owner,
        key.provider,
        key.model,
        key.last4,
        key.ciphertext,
        key.iv,
        key.keyVersion,
        key.createdAt,
        wholeNumber(maxPerOwner, 'maxPerOwner'),
      );
      return stored.length === 1 ? 'stored' : 'key_limit_reached';
    },

    async listModelKeys(owner) {
      const rows = await all<ModelKeyRow>(sql.LIST_MODEL_KEYS, owner);
      return rows.map(toModelKey);
    },

    async getModelKey(id, owner) {
      const row = await first<ModelKeyRow>(sql.GET_MODEL_KEY, id, owner);
      return row === null ? null : toModelKey(row);
    },

    async deleteModelKey(id, owner, now) {
      const results = await db.batch([
        prepare(sql.DETACH_AGENT_OF_KEY, id, owner, now),
        prepare(sql.DELETE_MODEL_KEY, id, owner),
      ]);
      return rowsOf<{ id: string }>(results, 1).length === 1;
    },

    // --- seasons, market, ticks ------------------------------------------------------------------

    async getActiveSeason(now) {
      const row = await first<SeasonRow>(sql.GET_ACTIVE_SEASON, now);
      return row === null ? null : toSeason(row);
    },

    async getLatestStartedSeason(now) {
      const row = await first<SeasonRow>(sql.GET_LATEST_STARTED_SEASON, now);
      return row === null ? null : toSeason(row);
    },

    async getSeason(id) {
      const row = await first<SeasonRow>(sql.GET_SEASON, id);
      return row === null ? null : toSeason(row);
    },

    async listSeasons() {
      const rows = await all<SeasonRow>(sql.LIST_SEASONS);
      return rows.map(toSeason);
    },

    async getMarketStatus() {
      const row = await first<BodyRow>(sql.GET_MARKET_STATUS);
      return row === null ? null : toMarketStatus(row);
    },

    async putMarketStatus(status) {
      await run(sql.PUT_MARKET_STATUS, JSON.stringify(marketStatusSchema.parse(status)));
    },

    async getTick(id) {
      const row = await first<TickRow>(sql.GET_TICK, id);
      return row === null ? null : toTick(row);
    },

    async getLatestTick() {
      const row = await first<TickRow>(sql.GET_LATEST_TICK);
      return row === null ? null : toTick(row);
    },

    async getLastTrustedPrices(beforeTickId) {
      const rows = await all<{ id: string; prices: string | null }>(
        sql.LIST_TRUSTED_PRICE_TICKS,
        beforeTickId,
        TRUSTED_PRICE_LOOKBACK_TICKS,
      );
      const trusted: Partial<Record<string, TrustedPrice>> = {};
      let found = 0;
      // Newest first. Once every symbol of the universe (Stock Tokens and crypto assets, section 21)
      // has its price, the older rows are not parsed. Only universe symbols count toward that, so a
      // symbol an old tick carries can never stop the search early. A symbol with no fresh point yet,
      // such as a crypto asset on its first days, makes the search parse every row of the lookback:
      // still at most TRUSTED_PRICE_LOOKBACK_TICKS rows read, whatever the universe's size.
      for (const row of rows) {
        if (found >= UNIVERSE_SYMBOLS.size) break;
        if (row.prices === null) continue;
        const points = JSON.parse(row.prices) as unknown;
        if (!Array.isArray(points)) continue;
        for (const point of points as { symbol?: unknown; priceMicro?: unknown; fresh?: unknown }[]) {
          const { symbol, priceMicro, fresh } = point;
          if (fresh !== true || typeof symbol !== 'string' || trusted[symbol] !== undefined) continue;
          if (typeof priceMicro !== 'number' || !Number.isSafeInteger(priceMicro) || priceMicro <= 0) continue;
          trusted[symbol] = { priceMicro, tickId: row.id };
          if (UNIVERSE_SYMBOLS.has(symbol)) found += 1;
        }
      }
      return trusted;
    },

    async createTick(tick) {
      const checked = tickSchema.parse(tick);
      const created = await all<{ id: string }>(
        sql.CREATE_TICK,
        checked.id,
        checked.seasonId,
        flag(checked.daily),
        JSON.stringify(checked.snapshot),
        checked.status,
        checked.createdAt,
        checked.completedAt,
      );
      return created.length === 1;
    },

    async listProcessingTicks() {
      const rows = await all<TickRow>(sql.LIST_PROCESSING_TICKS);
      return rows.map(toTick);
    },

    async completeTick(id, completedAt) {
      await run(sql.COMPLETE_TICK, id, completedAt);
    },

    async hasDailyTick(seasonId, day) {
      const row = await first<{ found: number }>(sql.HAS_DAILY_TICK, seasonId, `${day}T00:00Z`, `${day}T23:00Z`);
      return row?.found === 1;
    },

    async listDailyPrices(beforeDay, limit) {
      const rows = await all<DailyPricesRow>(sql.LIST_DAILY_PRICES, beforeDay, limit);
      // Newest first. At most `limit` rows, one per day, so the sort is over a handful of ids.
      return rows.sort((a, b) => (a.id < b.id ? 1 : -1)).map(toDailyPrices);
    },

    // --- symbols held for review -----------------------------------------------------------------

    async listSymbolHolds() {
      const rows = await all<SymbolHoldRow>(sql.LIST_SYMBOL_HOLDS);
      return rows.map(toSymbolHold);
    },

    async putSymbolHold(hold) {
      await run(
        sql.PUT_SYMBOL_HOLD,
        hold.symbol,
        hold.priceMicro,
        hold.seenPriceMicro,
        hold.sinceTickId,
        hold.releasedAt,
        hold.createdAt,
      );
    },

    async deleteSymbolHold(symbol) {
      const deleted = await all<{ symbol: string }>(sql.DELETE_SYMBOL_HOLD, symbol);
      return deleted.length === 1;
    },

    async releaseSymbolHold(symbol, releasedAt) {
      const released = await all<{ symbol: string }>(sql.RELEASE_SYMBOL_HOLD, symbol, releasedAt);
      return released.length === 1;
    },

    // --- scheduler work --------------------------------------------------------------------------

    async listPendingAgents(tickId, division, limit) {
      const rows = await all<AgentWorkRow>(sql.LIST_PENDING_AGENTS, tickId, division, limit);
      return rows.map(toAgentWork);
    },

    async countPendingAgents(tickId, division) {
      const row = await first<{ n: number }>(sql.COUNT_PENDING_AGENTS, tickId, division);
      return row?.n ?? 0;
    },

    async writeDecision(row, stats, keyFailures) {
      // The row is the record and can never be corrected afterwards, so it is checked here,
      // at the last moment before it is written (docs/CONTRACTS.md section 3).
      const checkedRow = decisionRowSchema.parse(row);
      const checkedStats = agentStatsSchema.parse(stats);
      const failures = wholeNumber(keyFailures, 'keyFailures');
      const results = await db.batch([
        prepare(
          sql.WRITE_DECISION_ROW,
          checkedRow.agentId,
          checkedRow.tickId,
          checkedRow.seasonId,
          checkedRow.division,
          checkedRow.status,
          checkedRow.code,
          JSON.stringify(checkedRow),
          checkedRow.createdAt,
        ),
        prepare(
          sql.WRITE_DECISION_PORTFOLIO,
          checkedRow.agentId,
          checkedRow.seasonId,
          checkedRow.tickId,
          checkedRow.status,
          JSON.stringify(checkedRow.portfolio),
          JSON.stringify(checkedStats),
          checkedStats.seasonReturnBps,
          checkedStats.maxDrawdownBps,
          checkedStats.tradeCount,
          checkedStats.tradingDays,
          checkedStats.decidedCount,
          checkedRow.createdAt,
          failures,
        ),
      ]);
      return rowsOf<{ tick_id: string }>(results, 0).length === 1;
    },

    async touchScheduler(now) {
      await run(sql.TOUCH_SCHEDULER, now);
    },

    async rerank(seasonId, division, tickId, computedAt, method) {
      const ranked: Bound[] = [seasonId, division, tickId, MIN_TRADING_DAYS_TO_RANK, MIN_DECISIONS_TO_RANK];
      // One batch for both methods: the v1 pair writes only outside a v2 season, the v2 pair only
      // inside one (docs/contracts/phase-6-social.md section 3).
      const results = await db.batch([
        prepare(sql.RERANK_CLEAR, ...ranked),
        prepare(sql.RERANK_ASSIGN, ...ranked),
        prepare(sql.RERANK_CLEAR_V2, seasonId, division),
        prepare(sql.RERANK_COPY_V2, seasonId, division),
        prepare(sql.RERANK_STATE, seasonId, division, tickId, computedAt, method),
      ]);
      const state = rowsOf<BodyRow>(results, 4)[0];
      if (state === undefined) throw new Error('store.rerank: the league state was not written');
      return toLeagueState(state);
    },

    // --- reads -----------------------------------------------------------------------------------

    async getPortfolio(agentId, seasonId) {
      const row = await first<PortfolioRow>(sql.GET_PORTFOLIO, agentId, seasonId);
      return row === null ? null : toPortfolioRecord(row);
    },

    async listDecisions(agentId, seasonId, limit) {
      const rows = await all<BodyRow>(sql.LIST_DECISIONS, agentId, seasonId, limit);
      return rows.map(toDecisionRow);
    },

    async getLeagueState(seasonId, division) {
      const row = await first<BodyRow>(sql.GET_LEAGUE_STATE, seasonId, division);
      return row === null ? null : toLeagueState(row);
    },

    async listStandings(seasonId, division, limit, offset) {
      const rows = await all<StandingRowSql>(sql.LIST_STANDINGS, seasonId, division, limit, offset);
      // The prices of each row's latest tick (docs/CONTRACTS.md section 17.2): one more statement
      // for the whole page, which reads each distinct tick once. Most rows share the league's tick.
      const tickIds = [...new Set(rows.flatMap((row) => (row.last_tick_id === null ? [] : [row.last_tick_id])))];
      const pricesByTick = new Map<string, PriceMap>();
      if (tickIds.length > 0) {
        const ticks = await all<DailyPricesRow>(sql.LIST_TICK_SNAPSHOTS, JSON.stringify(tickIds));
        for (const tick of ticks) pricesByTick.set(tick.id, pricesOfSnapshot(tick.snapshot));
      }
      const none: PriceMap = {};
      return rows.map((row) =>
        toStandingSource(row, row.last_tick_id === null ? none : (pricesByTick.get(row.last_tick_id) ?? none)),
      );
    },

    async getStanding(agentId, seasonId) {
      const row = await first<StandingWithTickSql>(sql.GET_STANDING, agentId, seasonId);
      return row === null ? null : toStandingSource(row, row.snapshot === null ? {} : pricesOfSnapshot(row.snapshot));
    },

    // --- budgets ---------------------------------------------------------------------------------

    async getAiNeurons(day, use) {
      const row = await first<{ neurons: number }>(sql.GET_AI_NEURONS, day, use);
      return row?.neurons ?? 0;
    },

    async spendApiWrites(day, rows, max) {
      return (await first<{ rows: number }>(sql.SPEND_API_WRITES, day, rows, max)) !== null;
    },

    async spendWalletWrite(address, day, max) {
      return (await first<{ write_count: number }>(sql.SPEND_WALLET_WRITE, address, day, max)) !== null;
    },

    async addAiNeurons(day, use, neurons) {
      await run(sql.ADD_AI_NEURONS, day, use, neurons);
    },
  };

  return withDailyLimit(store);
}

/** True if a database error says that a daily limit of the plan is used up. Cloudflare's wording lives here. */
function isDailyLimitMessage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`.toLowerCase();
  if (!text.includes('d1')) return false;
  return /daily|per day|quota|free tier|free plan/.test(text) && /limit|exceed|quota/.test(text);
}

/** Every method throws DailyLimitError for a used-up daily limit; any other error passes through unchanged. */
function withDailyLimit(store: Store): Store {
  const wrapped: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(store)) {
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await (method as (...a: unknown[]) => unknown).apply(store, args);
      } catch (error) {
        throw isDailyLimitMessage(error) ? new DailyLimitError() : error;
      }
    };
  }
  return wrapped as unknown as Store;
}
