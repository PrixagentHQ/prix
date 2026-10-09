import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type {
  Address,
  AgentStats,
  AgentTrackRecord,
  ChainEvent,
  Confidence,
  DayPrices,
  ListingDay,
  ListingOfWallet,
  ListingPublic,
  ListingRecord,
  ListingStatus,
  ListingSyncUpdate,
  PortfolioState,
  ReputationStore,
  ScoreBreakdown,
  ScoreSource,
  ScoringDivision,
  Season,
  SeasonArchiveEntry,
  SeasonMethod,
  SeasonMethodRecord,
  SeasonResultRow,
  SeasonScoreRow,
  TrackRecordSeason,
  UnrankedReason,
} from '@prix/contracts';
import {
  CHAIN_EXCLUSIONS,
  CHAIN_METHOD,
  CONFIDENCE_HIGH_DAYS,
  CONFIDENCE_MEDIUM_DAYS,
  creationPeriod,
  explorerAddressUrl,
  isHouseOwner,
  MAX_LISTINGS_TOTAL,
  MIN_TRADING_DAYS_V2,
  SHRINK_DAYS,
  VOL_FLOOR_BPS,
} from '@prix/contracts';

/**
 * The Phase 2 side of D1 (docs/contracts/phase-2-reputation.md sections 2 and 6). Every query below uses
 * an index of infra/migrations/0002_reputation.sql or of 0001; the index is named beside the query.
 * Every public read hides hidden agents and hidden or removed listings with NOT EXISTS lookups by key.
 */

type Row = Record<string, unknown>;
type Param = string | number | null;

/** Hidden agent, or hidden or removed listing, for a row of season_scores aliased `s`. Both lookups are by primary key. */
const NOT_HIDDEN_S = `
  NOT EXISTS (SELECT 1 FROM agents ha WHERE s.division <> 'chain' AND ha.id = s.agent_id AND ha.hidden = 1)
  AND NOT EXISTS (SELECT 1 FROM listings hl WHERE s.division = 'chain' AND hl.id = s.agent_id AND (hl.hidden = 1 OR hl.status = 'removed'))`;

const SCORE_COLUMNS = `s.season_id, s.division, s.agent_id, s.name, s.agent_created_at, s.method, s.n_days, s.sum_bps,
  s.sumsq_bps, s.return_bps, s.max_drawdown_bps, s.trading_days, s.decided_count, s.score_milli, s.confidence,
  s.unranked_reason, s.rank, s.scored_day`;

/**
 * The owner of the agent of a row of season_scores aliased `s`, by the primary key of agents, so
 * that the row can say `house` (docs/CONTRACTS.md section 17.1). Null in the `chain` division: a
 * listed agent is never a house agent. The owner is read to set the mark and reaches no response.
 */
const OWNER_OF_S = `(SELECT oa.owner FROM agents oa WHERE s.division <> 'chain' AND oa.id = s.agent_id) AS owner`;

const LISTING_COLUMNS = `id, wallet, claimant, name, name_key, message, signature, signature_kind, status, hidden, verified,
  claimed_at, sync_state, synced_block, synced_at, window_blocks, sync_errors, event_count, balances, record_day,
  record_block, index_micro`;

function rowsOf<T = Row>(result: { results?: unknown[] } | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function changesOf(result: { meta?: { changes?: number } } | undefined): number {
  return result?.meta?.changes ?? 0;
}

function milli(x: number): number {
  const v = Math.round(x * 1000);
  return v === 0 ? 0 : v;
}

/** The v2 breakdown of docs/contracts/phase-2-reputation.md section 5, for the all-time record of a read. */
function breakdownOf(n: number, sumBps: number, sumSqBps: number): ScoreBreakdown {
  if (n <= 0) return { n: 0, meanMilliBps: 0, volMilliBps: 0, ratioMilli: 0, shrinkMilli: 0, scoreMilli: 0 };
  const mean = sumBps / n;
  const variance = n < 2 ? 0 : Math.max(0, (sumSqBps - (sumBps * sumBps) / n) / (n - 1));
  const vol = Math.sqrt(variance);
  const ratio = mean / Math.max(vol, VOL_FLOOR_BPS);
  const shrink = n / (n + SHRINK_DAYS);
  return {
    n,
    meanMilliBps: milli(mean),
    volMilliBps: milli(vol),
    ratioMilli: milli(ratio),
    shrinkMilli: milli(shrink),
    scoreMilli: milli(ratio * shrink),
  };
}

function confidenceOf(n: number, eligible: boolean): Confidence {
  if (!eligible) return 'insufficient';
  if (n < CONFIDENCE_MEDIUM_DAYS) return 'low';
  return n < CONFIDENCE_HIGH_DAYS ? 'medium' : 'high';
}

/** `house` is the mark of section 17.1, decided by the caller from the agent's owner. */
function toResultRow(r: Row, house: boolean): SeasonResultRow {
  return {
    rank: (r.rank as number | null) ?? null,
    unrankedReason: (r.unranked_reason as UnrankedReason | null) ?? null,
    agentId: r.agent_id as string,
    name: r.name as string,
    division: r.division as ScoringDivision,
    method: r.method as SeasonMethod,
    returnBps: r.return_bps as number,
    maxDrawdownBps: r.max_drawdown_bps as number,
    tradingDays: r.trading_days as number,
    decidedCount: r.decided_count as number,
    scoreMilli: (r.score_milli as number | null) ?? null,
    confidence: (r.confidence as Confidence | null) ?? null,
    scoredDay: (r.scored_day as string | null) ?? null,
    house,
  };
}

function toListing(r: Row): ListingRecord {
  return {
    id: r.id as string,
    wallet: r.wallet as string,
    claimant: r.claimant as string,
    name: r.name as string,
    nameKey: r.name_key as string,
    message: r.message as string,
    signature: r.signature as string,
    signatureKind: r.signature_kind as ListingRecord['signatureKind'],
    status: r.status as ListingStatus,
    hidden: r.hidden === 1,
    verified: r.verified === 1,
    claimedAt: r.claimed_at as string,
    syncState: r.sync_state as ListingRecord['syncState'],
    syncedBlock: r.synced_block as number,
    syncedAt: (r.synced_at as string | null) ?? null,
    windowBlocks: r.window_blocks as number,
    syncErrors: r.sync_errors as number,
    eventCount: r.event_count as number,
    balancesWei: JSON.parse(r.balances as string) as ListingRecord['balancesWei'],
    recordDay: (r.record_day as string | null) ?? null,
    recordBlock: r.record_block as number,
    indexMicro: r.index_micro as number,
  };
}

function toEvent(r: Row): ChainEvent {
  return {
    block: r.block as number,
    logIndex: r.log_index as number,
    txHash: r.tx_hash as string,
    symbol: r.symbol as string,
    direction: r.direction as 'in' | 'out',
    amountWei: r.amount_wei as string,
    kind: r.kind as 'transfer' | 'swap',
    day: r.day as string,
  };
}

function toListingDay(r: Row): ListingDay {
  return {
    day: r.day as string,
    returnBps: r.return_bps as number,
    exposed: r.exposed === 1,
    indexMicro: r.index_micro as number,
    valueMicro: r.value_micro as number,
    eventCount: r.event_count as number,
    unpricedEventCount: r.unpriced_event_count as number,
  };
}

function toDayPrices(r: Row): DayPrices {
  return {
    day: r.day as string,
    tickId: r.tick_id as string,
    pricesMicro: JSON.parse(r.prices as string) as DayPrices['pricesMicro'],
  };
}

/** Insert or ignore of up to this many JSON rows per statement: D1 allows 100 bound parameters, not more. */
const JSON_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What the store needs beside the database. */
export interface ReputationStoreOptions {
  /**
   * `ApiConfig.houseOwners`: a result row and a track record of an agent of one of these wallets
   * say `house: true` (docs/CONTRACTS.md section 17.1). Left out: no agent is a house agent.
   */
  houseOwners?: readonly string[];
}

export function createReputationStore(db: D1Database, options: ReputationStoreOptions = {}): ReputationStore {
  const houseOf = (owner: unknown): boolean =>
    isHouseOwner(options.houseOwners, typeof owner === 'string' ? owner : undefined);
  const q = (sql: string, ...params: Param[]): D1PreparedStatement => db.prepare(sql).bind(...params);

  async function first<T = Row>(sql: string, ...params: Param[]): Promise<T | null> {
    return (await q(sql, ...params).first<T>()) ?? null;
  }

  async function all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
    return rowsOf<T>(await q(sql, ...params).all());
  }

  // --- archive counts ---------------------------------------------------------------------------

  const SEASON_SELECT = `SELECT se.id, se.number, se.starts_at, se.ends_at, m.method, m.length_days, m.frozen_at
    FROM seasons se LEFT JOIN season_methods m ON m.season_id = se.id`;

  async function archiveEntries(seasonId: string | null): Promise<SeasonArchiveEntry[]> {
    const seasons =
      seasonId === null
        ? await all(`${SEASON_SELECT} ORDER BY se.starts_at DESC`) // seasons_starts_at
        : await all(`${SEASON_SELECT} WHERE se.id = ?1`, seasonId); // seasons primary key
    if (seasons.length === 0) return [];
    // season_scores_rank: the (season_id, division) range of each season, hidden rows left out.
    const counts =
      seasonId === null
        ? await all(
            `SELECT s.season_id, s.division, count(*) AS n, coalesce(sum(s.rank IS NOT NULL), 0) AS ranked
             FROM season_scores s WHERE ${NOT_HIDDEN_S} GROUP BY s.season_id, s.division`,
          )
        : await all(
            `SELECT s.season_id, s.division, count(*) AS n, coalesce(sum(s.rank IS NOT NULL), 0) AS ranked
             FROM season_scores s WHERE s.season_id = ?1 AND ${NOT_HIDDEN_S} GROUP BY s.season_id, s.division`,
            seasonId,
          );
    const bySeason = new Map<string, SeasonArchiveEntry>();
    const entries = seasons.map((r): SeasonArchiveEntry => {
      const season: Season = {
        id: r.id as string,
        number: r.number as number,
        startsAt: r.starts_at as string,
        endsAt: r.ends_at as string,
      };
      const entry: SeasonArchiveEntry = {
        season,
        method: (r.method as SeasonMethod | null) ?? 'v1',
        lengthDays: (r.length_days as number | null) ?? 28,
        frozenAt: (r.frozen_at as string | null) ?? null,
        rankedCount: { open: 0, pro: 0, chain: 0 },
        agentCount: { open: 0, pro: 0, chain: 0 },
      };
      bySeason.set(season.id, entry);
      return entry;
    });
    for (const c of counts) {
      const entry = bySeason.get(c.season_id as string);
      const division = c.division as ScoringDivision;
      if (!entry) continue;
      entry.agentCount[division] = c.n as number;
      entry.rankedCount[division] = c.ranked as number;
    }
    // A running v1 season has no season_scores rows yet: its counts come from portfolios_league.
    for (const entry of entries) {
      if (entry.method !== 'v1' || entry.frozenAt !== null) continue;
      if (entry.agentCount.open + entry.agentCount.pro > 0) continue;
      const rows = await all(
        `SELECT p.division, count(*) AS n, coalesce(sum(p.rank IS NOT NULL), 0) AS ranked
         FROM portfolios p WHERE p.season_id = ?1
           AND NOT EXISTS (SELECT 1 FROM agents ha WHERE ha.id = p.agent_id AND ha.hidden = 1)
         GROUP BY p.division`,
        entry.season.id,
      );
      for (const r of rows) {
        const division = r.division as 'open' | 'pro';
        entry.agentCount[division] = r.n as number;
        entry.rankedCount[division] = r.ranked as number;
      }
    }
    return entries;
  }

  // --- listed agents -----------------------------------------------------------------------------

  /** The newest season that has a chain row, which is the season the listings' standing is from. */
  async function standingSeason(): Promise<{ id: string; method: SeasonMethod } | null> {
    const r = await first<{ id: string; method: SeasonMethod | null }>(
      `SELECT se.id, m.method FROM seasons se LEFT JOIN season_methods m ON m.season_id = se.id
       WHERE EXISTS (SELECT 1 FROM season_scores s WHERE s.season_id = se.id AND s.division = 'chain')
       ORDER BY se.starts_at DESC LIMIT 1`,
    );
    return r ? { id: r.id, method: r.method ?? 'v1' } : null;
  }

  async function listed(where: string, params: Param[], tail: string, tailParams: Param[]): Promise<ListingPublic[]> {
    const season = await standingSeason();
    // listings_public (or listings primary key) for the listing; season_scores primary key for its standing.
    const rows = await all(
      `SELECT l.id AS lid, l.name AS lname, l.wallet, l.verified, l.claimed_at, l.sync_state, l.synced_at, l.event_count,
         (SELECT d.day FROM listing_days d WHERE d.listing_id = l.id ORDER BY d.day LIMIT 1) AS record_from,
         ${SCORE_COLUMNS.replaceAll('s.agent_id', 's.agent_id AS sagent')}
       FROM listings l LEFT JOIN season_scores s
         ON s.season_id = ?1 AND s.division = 'chain' AND s.agent_id = l.id
       WHERE ${where} ${tail}`,
      season?.id ?? null,
      ...params,
      ...tailParams,
    );
    return rows.map((r): ListingPublic => {
      const standing =
        r.sagent === null || r.sagent === undefined
          ? null
          : toResultRow({ ...r, agent_id: r.sagent, name: r.name }, false);
      return {
        id: r.lid as string,
        name: r.lname as string,
        wallet: r.wallet as string,
        explorerUrl: explorerAddressUrl(r.wallet as string),
        verified: r.verified === 1,
        claimedAt: r.claimed_at as string,
        syncState: r.sync_state as ListingPublic['syncState'],
        syncedAt: (r.synced_at as string | null) ?? null,
        eventCount: r.event_count as number,
        estimated: true,
        recordMethod: CHAIN_METHOD,
        scoringMethod: season ? season.method : null,
        exclusions: [...CHAIN_EXCLUSIONS],
        recordFrom: (r.record_from as string | null) ?? null,
        standing,
      };
    });
  }

  function trackOf(rows: Row[]): AgentTrackRecord {
    const newest = rows[0] as Row;
    const seasons: TrackRecordSeason[] = rows.map((r) => ({
      season: {
        id: r.season_id as string,
        number: r.number as number,
        startsAt: r.starts_at as string,
        endsAt: r.ends_at as string,
      },
      method: r.method as SeasonMethod,
      frozen: r.frozen_at !== null && r.frozen_at !== undefined,
      rank: (r.rank as number | null) ?? null,
      unrankedReason: (r.unranked_reason as UnrankedReason | null) ?? null,
      returnBps: r.return_bps as number,
      maxDrawdownBps: r.max_drawdown_bps as number,
      tradingDays: r.trading_days as number,
      decidedCount: r.decided_count as number,
      breakdown: r.method === 'v2' ? breakdownOf(r.n_days as number, r.sum_bps as number, r.sumsq_bps as number) : null,
      confidence: (r.confidence as Confidence | null) ?? null,
    }));
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    let scored = 0;
    let product = 1;
    let tradingDays = 0;
    for (const r of rows) {
      product *= (10_000 + (r.return_bps as number)) / 10_000;
      tradingDays += r.trading_days as number;
      if (r.method === 'v2') {
        scored += 1;
        n += r.n_days as number;
        sum += r.sum_bps as number;
        sumSq += r.sumsq_bps as number;
      }
    }
    const returnBps = Math.round((product - 1) * 10_000);
    return {
      agentId: newest.agent_id as string,
      name: newest.name as string,
      division: newest.division as ScoringDivision,
      seasons,
      allTime: {
        seasons: rows.length,
        scoredSeasons: scored,
        returnBps: returnBps === 0 ? 0 : returnBps,
        tradingDays,
        breakdown: breakdownOf(n, sum, sumSq),
        confidence: confidenceOf(n, n >= MIN_TRADING_DAYS_V2),
      },
      method: newest.method as SeasonMethod,
      house: houseOf(newest.owner),
    };
  }

  // The eligible, visible rows of one division, as ScoringV2Engine.compare orders them.
  const ELIGIBLE = `SELECT s.agent_id, ROW_NUMBER() OVER (
      ORDER BY s.score_milli DESC, s.return_bps DESC, s.max_drawdown_bps, s.agent_created_at, s.agent_id) AS rn
    FROM season_scores s
    WHERE s.season_id = ?1 AND s.division = ?2 AND s.unranked_reason IS NULL AND s.method = 'v2'
      AND s.score_milli IS NOT NULL AND ${NOT_HIDDEN_S}`;

  return {
    // --- seasons ---------------------------------------------------------------------------------
    async getSeasonMethod(seasonId: string): Promise<SeasonMethodRecord> {
      const r = await first<{ method: SeasonMethod; length_days: number; frozen_at: string | null }>(
        'SELECT method, length_days, frozen_at FROM season_methods WHERE season_id = ?1',
        seasonId,
      );
      return r
        ? { seasonId, method: r.method, lengthDays: r.length_days, frozenAt: r.frozen_at }
        : { seasonId, method: 'v1', lengthDays: 28, frozenAt: null };
    },

    async putSeason(season: Season, method: SeasonMethod, lengthDays: number): Promise<boolean> {
      const [inserted] = await db.batch([
        q(
          'INSERT OR IGNORE INTO seasons (id, number, starts_at, ends_at) VALUES (?1, ?2, ?3, ?4)',
          season.id,
          season.number,
          season.startsAt,
          season.endsAt,
        ),
        q(
          `INSERT OR IGNORE INTO season_methods (season_id, method, length_days, frozen_at, created_at)
           SELECT ?1, ?2, ?3, NULL, ?4 WHERE changes() > 0`,
          season.id,
          method,
          lengthDays,
          season.startsAt,
        ),
      ]);
      return changesOf(inserted) > 0;
    },

    async rolloverAgents(input: {
      toSeasonId: string;
      portfolio: PortfolioState;
      stats: AgentStats;
      afterAgentId: string | null;
      limit: number;
      now: string;
    }): Promise<{ examined: number; lastAgentId: string | null }> {
      const after = input.afterAgentId ?? '';
      // agents primary key, in id order.
      const [ids] = await db.batch([
        q('SELECT id FROM agents WHERE id > ?1 ORDER BY id LIMIT ?2', after, input.limit),
        q(
          `INSERT OR IGNORE INTO portfolios (agent_id, season_id, division, portfolio, stats, last_tick_id,
             last_asked_tick_id, last_status, rank, season_return_bps, max_drawdown_bps, trade_count, trading_days,
             decided_count, key_failures, agent_created_at, updated_at)
           SELECT a.id, ?3, a.division, ?4, ?5, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, a.created_at, ?6
           FROM agents a WHERE a.id > ?1 ORDER BY a.id LIMIT ?2`,
          after,
          input.limit,
          input.toSeasonId,
          JSON.stringify(input.portfolio),
          JSON.stringify(input.stats),
          input.now,
        ),
      ]);
      const rows = rowsOf<{ id: string }>(ids);
      return { examined: rows.length, lastAgentId: rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null };
    },

    async markSeasonFrozen(seasonId: string, now: string): Promise<void> {
      await q(
        `INSERT INTO season_methods (season_id, method, length_days, frozen_at, created_at)
         VALUES (?1, 'v1', coalesce((SELECT max(1, CAST(round(julianday(ends_at) - julianday(starts_at)) AS INTEGER))
           FROM seasons WHERE id = ?1), 28), ?2, ?2)
         ON CONFLICT (season_id) DO UPDATE SET frozen_at = excluded.frozen_at WHERE season_methods.frozen_at IS NULL`,
        seasonId,
        now,
      ).run();
    },

    async hasProcessingTick(seasonId: string): Promise<boolean> {
      // ticks_processing holds only the unfinished ticks.
      const r = await first(
        `SELECT 1 AS x FROM ticks INDEXED BY ticks_processing WHERE status = 'processing' AND season_id = ?1 LIMIT 1`,
        seasonId,
      );
      return r !== null;
    },

    // --- scores ----------------------------------------------------------------------------------
    async listPaperScoreSources(
      seasonId: string,
      division: 'open' | 'pro',
      afterAgentId: string | null,
      limit: number,
    ): Promise<ScoreSource[]> {
      // agents primary key in id order, then portfolios by its primary key (agent_id, season_id).
      const rows = await all(
        `SELECT a.id, a.name, a.created_at, p.stats FROM agents a
         JOIN portfolios p ON p.agent_id = a.id AND p.season_id = ?1
         WHERE a.id > ?3 AND a.division = ?2 AND p.division = ?2 ORDER BY a.id LIMIT ?4`,
        seasonId,
        division,
        afterAgentId ?? '',
        limit,
      );
      return rows.map((r) => ({
        agentId: r.id as string,
        name: r.name as string,
        createdAt: r.created_at as string,
        stats: JSON.parse(r.stats as string) as AgentStats,
        chainDays: null,
      }));
    },

    async listChainScoreSources(
      fromDay: string,
      toDay: string,
      afterListingId: string | null,
      limit: number,
    ): Promise<ScoreSource[]> {
      // listings primary key in id order, then listing_days by its primary key range.
      const rows = await all(
        `SELECT l.id, l.name, l.claimed_at, d.day, d.return_bps, d.exposed, d.index_micro, d.value_micro,
           d.event_count, d.unpriced_event_count
         FROM (SELECT id, name, claimed_at FROM listings WHERE id > ?3 AND status = 'active' ORDER BY id LIMIT ?4) l
         LEFT JOIN listing_days d ON d.listing_id = l.id AND d.day >= ?1 AND d.day <= ?2
         ORDER BY l.id, d.day`,
        fromDay,
        toDay,
        afterListingId ?? '',
        limit,
      );
      const out: ScoreSource[] = [];
      for (const r of rows) {
        let source = out[out.length - 1];
        if (!source || source.agentId !== r.id) {
          source = {
            agentId: r.id as string,
            name: r.name as string,
            createdAt: r.claimed_at as string,
            stats: null,
            chainDays: [],
          };
          out.push(source);
        }
        if (r.day !== null) source.chainDays?.push(toListingDay(r));
      }
      return out;
    },

    async putScores(rows: readonly SeasonScoreRow[]): Promise<void> {
      if (rows.length === 0) return;
      // A season that is frozen is never rewritten: the insert selects nothing for it.
      const results = await db.batch(
        rows.map((r) =>
          q(
            `INSERT INTO season_scores (season_id, division, agent_id, name, agent_created_at, method, n_days, sum_bps,
               sumsq_bps, return_bps, max_drawdown_bps, trading_days, decided_count, trade_count, score_milli,
               confidence, unranked_reason, rank, scored_day, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL, ?18, ?19
             WHERE NOT EXISTS (SELECT 1 FROM season_methods WHERE season_id = ?1 AND frozen_at IS NOT NULL)
             ON CONFLICT (season_id, division, agent_id) DO UPDATE SET
               name = excluded.name, method = excluded.method, n_days = excluded.n_days, sum_bps = excluded.sum_bps,
               sumsq_bps = excluded.sumsq_bps, return_bps = excluded.return_bps,
               max_drawdown_bps = excluded.max_drawdown_bps, trading_days = excluded.trading_days,
               decided_count = excluded.decided_count, trade_count = excluded.trade_count,
               score_milli = excluded.score_milli, confidence = excluded.confidence,
               unranked_reason = excluded.unranked_reason, scored_day = excluded.scored_day,
               updated_at = excluded.updated_at`,
            r.seasonId,
            r.division,
            r.agentId,
            r.name,
            r.agentCreatedAt,
            r.method,
            r.moments.n,
            r.moments.sumBps,
            r.moments.sumSqBps,
            r.returnBps,
            r.maxDrawdownBps,
            r.tradingDays,
            r.decidedCount,
            r.tradeCount,
            r.scoreMilli,
            r.confidence,
            r.unrankedReason,
            r.scoredDay,
            r.updatedAt,
          ),
        ),
      );
      const refused = results.findIndex((res) => changesOf(res) === 0);
      if (refused >= 0) throw new Error(`putScores refused a row of a frozen season: ${rows[refused]?.seasonId}`);
    },

    async rankScores(seasonId: string, division: ScoringDivision): Promise<number> {
      // season_scores_rank for the (season, division) range; the other columns are on the key's own row.
      const results = await db.batch([
        // Rows that are ranked but no longer eligible lose their rank.
        q(
          `UPDATE season_scores AS s SET rank = NULL
           WHERE s.season_id = ?1 AND s.division = ?2 AND s.rank IS NOT NULL
             AND s.agent_id NOT IN (SELECT e.agent_id FROM (${ELIGIBLE}) e)`,
          seasonId,
          division,
        ),
        // Eligible rows get 1..k; a row that already has its rank is not written.
        q(
          `UPDATE season_scores SET rank = r.rn
           FROM (${ELIGIBLE}) AS r
           WHERE season_scores.season_id = ?1 AND season_scores.division = ?2
             AND season_scores.agent_id = r.agent_id AND season_scores.rank IS NOT r.rn`,
          seasonId,
          division,
        ),
        q(
          'SELECT count(*) AS n FROM season_scores WHERE season_id = ?1 AND division = ?2 AND rank IS NOT NULL',
          seasonId,
          division,
        ),
      ]);
      return rowsOf<{ n: number }>(results[2])[0]?.n ?? 0;
    },

    async freezeV1Chunk(
      seasonId: string,
      afterAgentId: string | null,
      limit: number,
      now: string,
    ): Promise<{ copied: number; lastAgentId: string | null }> {
      const after = afterAgentId ?? '';
      // agents primary key in id order, then portfolios by its primary key (agent_id, season_id).
      const [ids] = await db.batch([
        q(
          `SELECT a.id FROM agents a JOIN portfolios p ON p.agent_id = a.id AND p.season_id = ?1
           WHERE a.id > ?2 ORDER BY a.id LIMIT ?3`,
          seasonId,
          after,
          limit,
        ),
        q(
          `INSERT OR IGNORE INTO season_scores (season_id, division, agent_id, name, agent_created_at, method, n_days,
             sum_bps, sumsq_bps, return_bps, max_drawdown_bps, trading_days, decided_count, trade_count, score_milli,
             confidence, unranked_reason, rank, scored_day, updated_at)
           SELECT p.season_id, p.division, a.id, a.name, a.created_at, 'v1', 0, 0, 0, p.season_return_bps,
             p.max_drawdown_bps, p.trading_days, p.decided_count, p.trade_count, NULL, NULL,
             CASE WHEN p.rank IS NOT NULL THEN NULL WHEN p.trading_days < 5 THEN 'min_trading_days'
               WHEN p.decided_count < 3 THEN 'min_decisions' ELSE 'inactive' END,
             CASE WHEN a.hidden = 1 THEN NULL ELSE p.rank END, NULL, ?4
           FROM agents a JOIN portfolios p ON p.agent_id = a.id AND p.season_id = ?1
           WHERE a.id > ?2 ORDER BY a.id LIMIT ?3`,
          seasonId,
          after,
          limit,
          now,
        ),
      ]);
      const rows = rowsOf<{ id: string }>(ids);
      return { copied: rows.length, lastAgentId: rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null };
    },

    // --- day prices ------------------------------------------------------------------------------
    async captureDayPrices(day: string): Promise<boolean> {
      // ticks primary key range of one day: ids start with the day and 'T'.
      const tick = await first<{ id: string; snapshot: string }>(
        `SELECT id, snapshot FROM ticks WHERE id >= ?1 AND id < ?2 AND status = 'complete' ORDER BY id DESC LIMIT 1`,
        `${day}T`,
        `${day}U`,
      );
      if (!tick) return false;
      const prices: Record<string, number> = {};
      for (const p of (JSON.parse(tick.snapshot) as { prices: { symbol: string; priceMicro: number }[] }).prices) {
        prices[p.symbol] = p.priceMicro;
      }
      const result = await q(
        'INSERT OR IGNORE INTO day_prices (day, tick_id, prices) VALUES (?1, ?2, ?3)',
        day,
        tick.id,
        JSON.stringify(prices),
      ).run();
      return changesOf(result) > 0;
    },

    async listDayPrices(afterDay: string | null, toDay: string): Promise<DayPrices[]> {
      const rows = await all(
        'SELECT day, tick_id, prices FROM day_prices WHERE day > ?1 AND day <= ?2 ORDER BY day',
        afterDay ?? '',
        toDay,
      );
      return rows.map(toDayPrices);
    },

    async getDayPrices(day: string): Promise<DayPrices | null> {
      const r = await first('SELECT day, tick_id, prices FROM day_prices WHERE day = ?1', day);
      return r ? toDayPrices(r) : null;
    },

    async latestPricedDay(): Promise<string | null> {
      const r = await first<{ day: string }>('SELECT day FROM day_prices ORDER BY day DESC LIMIT 1');
      return r?.day ?? null;
    },

    // --- job state and counters ------------------------------------------------------------------
    async getJobState(name: string): Promise<string | null> {
      const r = await first<{ body: string }>('SELECT body FROM job_state WHERE name = ?1', name);
      return r?.body ?? null;
    },

    async putJobState(name: string, body: string, now: string): Promise<void> {
      await q(
        `INSERT INTO job_state (name, body, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        name,
        body,
        now,
      ).run();
    },

    async takeCounter(key: string, cap: number, day: string, now: string): Promise<boolean> {
      if (!key.startsWith(`d:${day}:`) && !key.startsWith(`p:${creationPeriod(day)}:`) && !key.startsWith('s:')) {
        throw new Error('takeCounter: a counter key starts with d:<day>:, p:<period>: or s:<seasonId>:');
      }
      if (cap < 1) return false;
      // One statement: the first take inserts 1, a later one adds 1 only while n is below the cap.
      const result = await q(
        `INSERT INTO counters (key, n, updated_at) VALUES (?1, 1, ?2)
         ON CONFLICT (key) DO UPDATE SET n = n + 1, updated_at = excluded.updated_at WHERE n < ?3`,
        key,
        now,
        cap,
      ).run();
      return changesOf(result) > 0;
    },

    async giveBackCounter(key: string): Promise<void> {
      await q('UPDATE counters SET n = n - 1 WHERE key = ?1 AND n > 0', key).run();
    },

    async deleteOldCounters(day: string, limit: number): Promise<number> {
      // The primary key range 'd:' up to 'd:<day>' holds every earlier day's counters.
      const days = await q(
        'DELETE FROM counters WHERE key IN (SELECT key FROM counters WHERE key >= ?1 AND key < ?2 LIMIT ?3)',
        'd:',
        `d:${day}`,
        limit,
      ).run();
      let deleted = changesOf(days);
      if (deleted >= limit) return deleted;
      // Period counters of earlier periods: the 'p:' key range, compared by the period as a number,
      // since 'p:999:' sorts after 'p:1000:' as text. The range holds one period's worth of rows
      // beside the earlier ones, as many as the networks that created an agent in it.
      const periods = await q(
        `DELETE FROM counters WHERE key IN (
           SELECT key FROM counters WHERE key >= 'p:' AND key < 'p;'
             AND CAST(substr(key, 3, instr(substr(key, 3), ':') - 1) AS INTEGER) < ?1
           LIMIT ?2)`,
        creationPeriod(day),
        limit - deleted,
      ).run();
      deleted += changesOf(periods);
      if (deleted >= limit) return deleted;
      // Season counters of frozen seasons: 's:<seasonId>:' key ranges, one per frozen season.
      const seasons = await q(
        `DELETE FROM counters WHERE key IN (
           SELECT c.key FROM season_methods m
           JOIN counters c ON c.key >= 's:' || m.season_id || ':' AND c.key < 's:' || m.season_id || ';'
           WHERE m.frozen_at IS NOT NULL LIMIT ?1)`,
        limit - deleted,
      ).run();
      return deleted + changesOf(seasons);
    },

    async getFirstSignIn(address: Address): Promise<string | null> {
      const r = await first<{ created_at: string }>('SELECT created_at FROM users WHERE address = ?1', address);
      return r?.created_at ?? null;
    },

    // --- listings --------------------------------------------------------------------------------
    async createListing(listing, limits) {
      const insert = q(
        `INSERT INTO listings (${LISTING_COLUMNS})
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
         WHERE NOT EXISTS (SELECT 1 FROM listings WHERE wallet = ?2)
           AND NOT EXISTS (SELECT 1 FROM listings WHERE name_key = ?5)
           AND NOT EXISTS (SELECT 1 FROM agents WHERE name_key = ?5)
           AND (SELECT count(*) FROM listings WHERE claimant = ?3) < ?23
           AND (SELECT count(*) FROM listings WHERE status = 'active' AND hidden = 0) < ?24`,
        listing.id,
        listing.wallet,
        listing.claimant,
        listing.name,
        listing.nameKey,
        listing.message,
        listing.signature,
        listing.signatureKind,
        listing.status,
        listing.hidden ? 1 : 0,
        listing.verified ? 1 : 0,
        listing.claimedAt,
        listing.syncState,
        listing.syncedBlock,
        listing.syncedAt,
        listing.windowBlocks,
        listing.syncErrors,
        listing.eventCount,
        JSON.stringify(listing.balancesWei),
        listing.recordDay,
        listing.recordBlock,
        listing.indexMicro,
        limits.maxPerClaimant,
        limits.maxTotal,
      );
      try {
        if (changesOf(await insert.run()) > 0) return 'created';
      } catch (error) {
        // A race on the unique wallet or name index: the diagnosis below says which.
        if (!String(error instanceof Error ? `${error.message} ${String(error.cause)}` : error).includes('UNIQUE')) {
          throw error;
        }
      }
      // listings_wallet, listings_name_key, agents_name_key, listings_claimant, listings_public.
      const why = await first<{ w: number; nl: number; na: number; c: number; t: number }>(
        `SELECT (SELECT count(*) FROM listings WHERE wallet = ?1) AS w,
           (SELECT count(*) FROM listings WHERE name_key = ?2) AS nl,
           (SELECT count(*) FROM agents WHERE name_key = ?2) AS na,
           (SELECT count(*) FROM listings WHERE claimant = ?3) AS c,
           (SELECT count(*) FROM listings WHERE status = 'active' AND hidden = 0) AS t`,
        listing.wallet,
        listing.nameKey,
        listing.claimant,
      );
      if (!why) return 'listings_full';
      if (why.w > 0) return 'wallet_listed';
      if (why.nl > 0 || why.na > 0) return 'name_taken';
      if (why.c >= limits.maxPerClaimant) return 'claimant_limit';
      return 'listings_full';
    },

    async replaceListingClaimant(listing, limits) {
      const update = await q(
        `UPDATE listings SET claimant = ?2, name = ?3, name_key = ?4, message = ?5, signature = ?6,
           signature_kind = ?7, claimed_at = ?8, verified = 0, status = 'active'
         WHERE wallet = ?1 AND claimant <> ?2
           AND NOT EXISTS (SELECT 1 FROM listings WHERE name_key = ?4 AND wallet <> ?1)
           AND NOT EXISTS (SELECT 1 FROM agents WHERE name_key = ?4)
           AND (SELECT count(*) FROM listings WHERE claimant = ?2) < ?9`,
        listing.wallet,
        listing.claimant,
        listing.name,
        listing.nameKey,
        listing.message,
        listing.signature,
        listing.signatureKind,
        listing.claimedAt,
        limits.maxPerClaimant,
      ).run();
      if (changesOf(update) > 0) return 'replaced';
      const why = await first<{ l: number; nl: number; na: number; c: number }>(
        `SELECT (SELECT count(*) FROM listings WHERE wallet = ?1 AND claimant <> ?2) AS l,
           (SELECT count(*) FROM listings WHERE name_key = ?3 AND wallet <> ?1) AS nl,
           (SELECT count(*) FROM agents WHERE name_key = ?3) AS na,
           (SELECT count(*) FROM listings WHERE claimant = ?2) AS c`,
        listing.wallet,
        listing.claimant,
        listing.nameKey,
      );
      if (!why || why.l === 0) return 'not_replaceable';
      if (why.nl > 0 || why.na > 0) return 'name_taken';
      if (why.c >= limits.maxPerClaimant) return 'claimant_limit';
      return 'not_replaceable';
    },

    async getListing(id: string): Promise<ListingRecord | null> {
      const r = await first(`SELECT ${LISTING_COLUMNS} FROM listings WHERE id = ?1`, id);
      return r ? toListing(r) : null;
    },

    async getListingByWallet(wallet: Address): Promise<ListingRecord | null> {
      const r = await first(`SELECT ${LISTING_COLUMNS} FROM listings WHERE wallet = ?1`, wallet);
      return r ? toListing(r) : null;
    },

    async listListingsByClaimant(claimant: Address): Promise<ListingRecord[]> {
      const rows = await all(
        `SELECT ${LISTING_COLUMNS} FROM listings WHERE claimant = ?1 ORDER BY claimed_at LIMIT ?2`,
        claimant,
        MAX_LISTINGS_TOTAL,
      );
      return rows.map(toListing);
    },

    async setListingStatus(id: string, claimant: Address, status: ListingStatus): Promise<boolean> {
      const r = await q('UPDATE listings SET status = ?3 WHERE id = ?1 AND claimant = ?2', id, claimant, status).run();
      return changesOf(r) > 0;
    },

    async setListingHidden(id: string, hidden: boolean): Promise<boolean> {
      const r = await q('UPDATE listings SET hidden = ?2 WHERE id = ?1', id, hidden ? 1 : 0).run();
      return changesOf(r) > 0;
    },

    async nextListingToSync(now: string, minAgeSeconds: number): Promise<ListingRecord | null> {
      const cutoff = new Date(Date.parse(now) - minAgeSeconds * 1000).toISOString();
      // listings_sync: (sync_state, synced_at, id) for active, visible listings. Backfill, then live, then error.
      const [backfill, live, error] = await db.batch([
        q(
          `SELECT ${LISTING_COLUMNS} FROM listings WHERE sync_state = 'backfill' AND status = 'active' AND hidden = 0
           ORDER BY synced_at, id LIMIT 1`,
        ),
        q(
          `SELECT ${LISTING_COLUMNS} FROM listings WHERE sync_state = 'live' AND status = 'active' AND hidden = 0
             AND (synced_at IS NULL OR synced_at <= ?1) ORDER BY synced_at, id LIMIT 1`,
          cutoff,
        ),
        q(
          `SELECT ${LISTING_COLUMNS} FROM listings WHERE sync_state = 'error' AND status = 'active' AND hidden = 0
             AND (synced_at IS NULL OR synced_at <= ?1) ORDER BY synced_at, id LIMIT 1`,
          cutoff,
        ),
      ]);
      const found = rowsOf(backfill)[0] ?? rowsOf(live)[0] ?? rowsOf(error)[0];
      return found ? toListing(found) : null;
    },

    async listEventsAfterBlock(listingId: string, block: number, limit: number): Promise<ChainEvent[]> {
      const rows = await all(
        `SELECT block, log_index, tx_hash, symbol, direction, amount_wei, kind, day FROM listing_events
         WHERE listing_id = ?1 AND block > ?2 ORDER BY block, log_index LIMIT ?3`,
        listingId,
        block,
        limit,
      );
      return rows.map(toEvent);
    },

    async nameKeyTaken(nameKey: string): Promise<boolean> {
      const r = await first<{ taken: number }>(
        `SELECT (EXISTS (SELECT 1 FROM listings WHERE name_key = ?1)
                 OR EXISTS (SELECT 1 FROM agents WHERE name_key = ?1)) AS taken`,
        nameKey,
      );
      return r?.taken === 1;
    },

    async applySync(update: ListingSyncUpdate): Promise<void> {
      const statements: D1PreparedStatement[] = [];
      // Rows travel as JSON in one parameter: D1 allows 100 bound parameters a statement.
      for (const part of chunks(update.events, JSON_CHUNK)) {
        statements.push(
          q(
            `INSERT OR IGNORE INTO listing_events (listing_id, block, log_index, tx_hash, symbol, direction, amount_wei, kind, day)
             SELECT ?1, json_extract(j.value, '$.block'), json_extract(j.value, '$.logIndex'),
               json_extract(j.value, '$.txHash'), json_extract(j.value, '$.symbol'),
               json_extract(j.value, '$.direction'), json_extract(j.value, '$.amountWei'),
               json_extract(j.value, '$.kind'), json_extract(j.value, '$.day')
             FROM json_each(?2) j`,
            update.listingId,
            JSON.stringify(part),
          ),
        );
      }
      for (const part of chunks(update.days, JSON_CHUNK)) {
        statements.push(
          q(
            `INSERT OR IGNORE INTO listing_days (listing_id, day, return_bps, exposed, index_micro, value_micro,
               event_count, unpriced_event_count)
             SELECT ?1, json_extract(j.value, '$.day'), json_extract(j.value, '$.returnBps'),
               json_extract(j.value, '$.exposed'), json_extract(j.value, '$.indexMicro'),
               json_extract(j.value, '$.valueMicro'), json_extract(j.value, '$.eventCount'),
               json_extract(j.value, '$.unpricedEventCount')
             FROM json_each(?2) j`,
            update.listingId,
            JSON.stringify(part.map((d) => ({ ...d, exposed: d.exposed ? 1 : 0 }))),
          ),
        );
      }
      statements.push(
        q(
          `UPDATE listings SET synced_block = ?2, synced_at = ?3, sync_state = ?4, window_blocks = ?5, sync_errors = ?6,
             verified = ?7, balances = ?8, record_day = ?9, record_block = ?10, index_micro = ?11, event_count = ?12
           WHERE id = ?1`,
          update.listingId,
          update.syncedBlock,
          update.syncedAt,
          update.syncState,
          update.windowBlocks,
          update.syncErrors,
          update.verified ? 1 : 0,
          JSON.stringify(update.balancesWei),
          update.recordDay,
          update.recordBlock,
          update.indexMicro,
          update.eventCount,
        ),
      );
      await db.batch(statements);
    },

    async listEventsNewest(listingId: string, limit: number): Promise<ChainEvent[]> {
      const rows = await all(
        `SELECT block, log_index, tx_hash, symbol, direction, amount_wei, kind, day FROM listing_events
         WHERE listing_id = ?1 ORDER BY block DESC, log_index DESC LIMIT ?2`,
        listingId,
        limit,
      );
      return rows.map(toEvent);
    },

    async listListingDays(listingId: string, fromDay: string, toDay: string): Promise<ListingDay[]> {
      const rows = await all(
        `SELECT day, return_bps, exposed, index_micro, value_micro, event_count, unpriced_event_count
         FROM listing_days WHERE listing_id = ?1 AND day >= ?2 AND day <= ?3 ORDER BY day`,
        listingId,
        fromDay,
        toDay,
      );
      return rows.map(toListingDay);
    },

    // --- RecordsReadPort -------------------------------------------------------------------------
    listSeasonArchive(): Promise<SeasonArchiveEntry[]> {
      return archiveEntries(null);
    },

    async getSeasonArchiveEntry(seasonId: string): Promise<SeasonArchiveEntry | null> {
      return (await archiveEntries(seasonId))[0] ?? null;
    },

    async listSeasonResults(
      seasonId: string,
      division: ScoringDivision,
      limit: number,
      offset: number,
    ): Promise<SeasonResultRow[] | null> {
      // seasons primary key, then season_scores_rank in its own order.
      const [season, rows] = await db.batch([
        q('SELECT id FROM seasons WHERE id = ?1', seasonId),
        q(
          `SELECT ${SCORE_COLUMNS}, ${OWNER_OF_S} FROM season_scores s WHERE s.season_id = ?1 AND s.division = ?2 AND ${NOT_HIDDEN_S}
           ORDER BY (s.rank IS NULL), s.rank, s.return_bps DESC, s.agent_created_at, s.agent_id LIMIT ?3 OFFSET ?4`,
          seasonId,
          division,
          limit,
          offset,
        ),
      ]);
      if (rowsOf(season).length === 0) return null;
      return rowsOf(rows).map((r) => toResultRow(r, houseOf(r.owner)));
    },

    async getTrackRecord(id: string): Promise<AgentTrackRecord | null> {
      // season_scores_agent for the rows, seasons and season_methods by primary key.
      const rows = await all(
        `SELECT ${SCORE_COLUMNS}, ${OWNER_OF_S}, se.number, se.starts_at, se.ends_at, m.frozen_at
         FROM season_scores s JOIN seasons se ON se.id = s.season_id
         LEFT JOIN season_methods m ON m.season_id = s.season_id
         WHERE s.agent_id = ?1 AND ${NOT_HIDDEN_S} ORDER BY se.starts_at DESC`,
        id,
      );
      if (rows.length > 0) return trackOf(rows);
      // Known and visible but not scored yet: an empty record, not a 404.
      const agent = await first<{ name: string; division: 'open' | 'pro'; owner: string }>(
        'SELECT name, division, owner FROM agents WHERE id = ?1 AND hidden = 0',
        id,
      );
      const listing = agent
        ? null
        : await first<{ name: string }>(
            `SELECT name FROM listings WHERE id = ?1 AND status = 'active' AND hidden = 0`,
            id,
          );
      const known = agent
        ? { name: agent.name, division: agent.division, house: houseOf(agent.owner) }
        : listing
          ? { name: listing.name, division: 'chain' as const, house: false }
          : null;
      if (!known) return null;
      // The method of the newest season of the league (seasons_starts_at), v1 without a row (D-109).
      const newest = await first<{ method: SeasonMethod | null }>(
        `SELECT m.method FROM seasons se LEFT JOIN season_methods m ON m.season_id = se.id
         ORDER BY se.starts_at DESC LIMIT 1`,
      );
      return {
        agentId: id,
        name: known.name,
        division: known.division,
        seasons: [],
        allTime: {
          seasons: 0,
          scoredSeasons: 0,
          returnBps: 0,
          tradingDays: 0,
          breakdown: breakdownOf(0, 0, 0),
          confidence: 'insufficient',
        },
        method: newest?.method ?? 'v1',
        house: known.house,
      };
    },

    listListedAgents(limit: number, offset: number): Promise<ListingPublic[]> {
      return listed(
        `l.status = 'active' AND l.hidden = 0`,
        [],
        'ORDER BY (s.rank IS NULL), s.rank, l.claimed_at, l.id LIMIT ?2 OFFSET ?3',
        [limit, offset],
      );
    },

    async getListedAgent(id: string): Promise<ListingPublic | null> {
      const rows = await listed(`l.id = ?2 AND l.status = 'active' AND l.hidden = 0`, [id], 'LIMIT 1', []);
      return rows[0] ?? null;
    },

    async listingsOf(wallet: Address): Promise<readonly ListingOfWallet[]> {
      // listings_claimant and listings_wallet, one read each.
      const [claimed, own] = await db.batch([
        q(
          `SELECT id, claimed_at, verified FROM listings WHERE claimant = ?1 AND status = 'active' AND hidden = 0
           ORDER BY claimed_at LIMIT ?2`,
          wallet,
          MAX_LISTINGS_TOTAL,
        ),
        q(
          `SELECT id, claimed_at, verified FROM listings WHERE wallet = ?1 AND status = 'active' AND hidden = 0 LIMIT ?2`,
          wallet,
          MAX_LISTINGS_TOTAL,
        ),
      ]);
      const seen = new Map<string, ListingOfWallet>();
      for (const r of [...rowsOf(claimed), ...rowsOf(own)]) {
        if (seen.size >= MAX_LISTINGS_TOTAL) break;
        const id = r.id as string;
        if (!seen.has(id)) {
          seen.set(id, { agentId: id, listedAt: r.claimed_at as string, verifiedBadge: r.verified === 1 });
        }
      }
      return [...seen.values()];
    },
  };
}
