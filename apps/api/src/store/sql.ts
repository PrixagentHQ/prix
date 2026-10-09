/**
 * Every SQL statement of the product. Nothing outside this folder contains SQL
 * (docs/CONTRACTS.md section 3). The schema is infra/migrations.
 *
 * Reading this file:
 *   - `?1`, `?2` are bound values, numbered so one value can be used twice. Nothing is ever
 *     concatenated into a statement except the fixed column lists below.
 *   - A statement on a hot path names its index with INDEXED BY. If a later migration drops
 *     or changes that index, the statement fails loudly instead of scanning the table.
 *   - CROSS JOIN is SQLite's way to fix the join order: the left table is the outer loop.
 *   - The conditions of a partial index are repeated as literals, never bound, because SQLite
 *     uses a partial index only when it can see that the statement implies its condition.
 */

const AGENT_COLUMNS = [
  'id',
  'owner',
  'name',
  'name_key',
  'division',
  'prompt',
  'prompt_public',
  'summary',
  'summary_status',
  'model_key_id',
  'status',
  'paused_reason',
  'hidden',
  'created_at',
  'updated_at',
  'strategy_changed_at',
  'prompt_change_day',
  'prompt_change_count',
] as const;

const AGENT_SELECT = AGENT_COLUMNS.join(', ');
const AGENT_SELECT_A = AGENT_COLUMNS.map((column) => `a.${column}`).join(', ');

const MODEL_KEY_SELECT = 'id, owner, provider, model, last4, ciphertext, iv, key_version, created_at';
const SEASON_SELECT = 'id, number, starts_at, ends_at';
const TICK_SELECT = 'id, season_id, daily, snapshot, status, created_at, completed_at';
/**
 * A league row. The summary and the owner come from the agent's row, which the read joins for
 * the name already. The owner is for the house mark only: no response carries it.
 */
const STANDING_SELECT =
  'p.agent_id, a.name, a.summary AS summary, a.owner AS owner, p.agent_created_at AS created_at, p.rank, p.stats, p.last_tick_id, p.last_status, p.portfolio';

/**
 * The official score behind a rank (docs/contracts/phase-6-social.md section 3): the agent's
 * season_scores row, joined by its primary key, so the order of the read does not change. Every
 * column is null when there is no row; the store maps a missing or v1 row to `official: null`.
 */
const OFFICIAL_JOIN =
  'LEFT JOIN season_scores AS s ON s.season_id = p.season_id AND s.division = p.division AND s.agent_id = p.agent_id';
const OFFICIAL_SELECT =
  's.method AS official_method, s.unranked_reason AS official_unranked_reason, s.score_milli AS official_score_milli, s.confidence AS official_confidence, s.scored_day AS official_scored_day';

/**
 * The order of docs/CONTRACTS.md section 9: higher return, lower drawdown, fewer trades,
 * older agent, lower agent id. Timestamps and ids are ASCII, so SQLite's byte order is the
 * plain string order the contract asks for.
 */
const SECTION_9_ORDER =
  'p.season_return_bps DESC, p.max_drawdown_bps ASC, p.trade_count ASC, p.agent_created_at ASC, p.agent_id ASC';

// --- sign-in --------------------------------------------------------------------------------------

/**
 * A row in siwe_nonces is a nonce that has been used. One insert that the primary key refuses
 * a second time: of any number of concurrent calls, exactly one gets a row back.
 * ?1 nonce, ?2 expires at. A returned row means this call was the first to use the nonce.
 */
export const USE_NONCE = `
INSERT INTO siwe_nonces (nonce, expires_at) VALUES (?1, ?2)
ON CONFLICT (nonce) DO NOTHING
RETURNING nonce`;

export const PUT_SESSION = 'INSERT INTO sessions (token_hash, address, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)';

export const GET_SESSION = `
SELECT token_hash, address, created_at, expires_at FROM sessions
WHERE token_hash = ?1 AND expires_at > ?2`;

export const DELETE_SESSION = 'DELETE FROM sessions WHERE token_hash = ?1';

export const TOUCH_USER = 'INSERT INTO users (address, created_at) VALUES (?1, ?2) ON CONFLICT (address) DO NOTHING';

/**
 * No index, on purpose: the migration says why. The walk stops at `limit` expired nonces, so
 * it reads at most the live nonces of the last five minutes and the ones it deletes.
 * ?1 now, ?2 limit.
 */
export const DELETE_EXPIRED_NONCES = `
DELETE FROM siwe_nonces WHERE nonce IN (
  SELECT nonce FROM siwe_nonces WHERE expires_at <= ?1 LIMIT ?2
)`;

/** Index sessions_expires_at. ?1 now, ?2 limit. */
export const DELETE_EXPIRED_SESSIONS = `
DELETE FROM sessions WHERE token_hash IN (
  SELECT token_hash FROM sessions INDEXED BY sessions_expires_at
  WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2
)`;

// --- agents ---------------------------------------------------------------------------------------

/**
 * The highest number given in a division. Agents are numbered 1, 2, 3 within their division as
 * they are created and none is ever deleted: one seek at the end of index agents_division.
 * It numbers the next agent; it is not the count of seats taken.
 */
function divisionSeq(division: string): string {
  return `coalesce((
    SELECT division_seq FROM agents INDEXED BY agents_division
    WHERE division = ${division} ORDER BY division_seq DESC LIMIT 1
  ), 0)`;
}

/** The seats taken: agents that are not hidden, counted through index agents_division_visible. */
function divisionSize(division: string): string {
  return `(SELECT count(*) FROM agents INDEXED BY agents_division_visible WHERE division = ${division} AND hidden = 0)`;
}

/**
 * First statement of the createAgent batch: why a refusal happened.
 * ?1 owner, ?2 name key, ?3 division, ?4 the most agents the division may hold, ?5 the most agents
 * the wallet may own.
 */
export const CREATE_AGENT_CHECK = `
SELECT
  ((SELECT COUNT(*) FROM agents WHERE owner = ?1) >= ?5) AS owner_taken,
  EXISTS (SELECT 1 FROM agents WHERE name_key = ?2) AS name_taken,
  (${divisionSize('?3')} >= ?4) AS league_full`;

/**
 * The guard shared by the two inserts of createAgent. The agents table does not change between
 * them, so inside the one transaction either both insert or neither does. The unique indexes
 * agents_name_key and agents_division stand behind it (a wallet may own several agents since migration 0004, so the owner limit is counted here, in SQL, and no unique index backs it): a violation aborts the
 * whole batch. The limit on agents per division is decided here, in SQL, and nowhere else.
 */
function agentIsNew(
  id: string,
  owner: string,
  nameKey: string,
  division: string,
  max: string,
  maxOwner: string,
): string {
  return `
  (SELECT COUNT(*) FROM agents WHERE owner = ${owner}) < ${maxOwner}
  AND NOT EXISTS (SELECT 1 FROM agents WHERE name_key = ${nameKey})
  AND NOT EXISTS (SELECT 1 FROM agents WHERE id = ${id})
  AND ${divisionSize(division)} < ${max}`;
}

/**
 * Second statement of the createAgent batch, before the agent itself so that it still sees
 * the agents table as it was.
 * ?1 agent id, ?2 season id, ?3 division, ?4 portfolio JSON, ?5 stats JSON, ?6 return,
 * ?7 drawdown, ?8 trades, ?9 trading days, ?10 decided, ?11 created at, ?12 owner, ?13 name key,
 * ?14 the most agents the division may hold, ?15 the most agents the wallet may own.
 */
export const CREATE_AGENT_PORTFOLIO = `
INSERT INTO portfolios (
  agent_id, season_id, division, portfolio, stats, last_tick_id, last_asked_tick_id, last_status, rank,
  season_return_bps, max_drawdown_bps, trade_count, trading_days, decided_count, key_failures,
  agent_created_at, updated_at
)
SELECT ?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11
WHERE ${agentIsNew('?1', '?12', '?13', '?3', '?14', '?15')}`;

/** The number of the bound value that follows the agent's own columns in CREATE_AGENT. */
const CREATE_AGENT_MAX_PARAM = AGENT_COLUMNS.length + 1;
const CREATE_AGENT_MAX_OWNER_PARAM = AGENT_COLUMNS.length + 2;

/**
 * Third statement of the createAgent batch. The first values are the agent's columns in
 * AGENT_COLUMNS order, so ?2 is the owner, ?4 the name key and ?5 the division. The value
 * after them is the most agents the division may hold, then the most agents the wallet may own. The agent takes the next number of
 * its division.
 */
export const CREATE_AGENT = `
INSERT INTO agents (${AGENT_SELECT}, division_seq)
SELECT ${AGENT_COLUMNS.map((_, index) => `?${index + 1}`).join(', ')}, ${divisionSeq('?5')} + 1
WHERE ${agentIsNew('?1', '?2', '?4', '?5', `?${CREATE_AGENT_MAX_PARAM}`, `?${CREATE_AGENT_MAX_OWNER_PARAM}`)}
RETURNING id`;

export const GET_AGENT = `SELECT ${AGENT_SELECT} FROM agents WHERE id = ?1`;

/** The oldest agent of the wallet. Index agents_owner_created (owner, created_at, id) after 0004. */
export const GET_AGENT_BY_OWNER = `SELECT ${AGENT_SELECT} FROM agents WHERE owner = ?1 ORDER BY created_at, id LIMIT 1`;

export const LIST_AGENTS_BY_OWNER = `SELECT ${AGENT_SELECT} FROM agents INDEXED BY agents_owner_created WHERE owner = ?1 ORDER BY created_at, id LIMIT 100`;

/** First statement of the updateAgent batch when the name changes. ?1 agent id, ?2 new name key. */
export const UPDATE_AGENT_CHECK = `
SELECT
  EXISTS (SELECT 1 FROM agents WHERE id = ?1) AS found,
  EXISTS (SELECT 1 FROM agents WHERE name_key = ?2 AND id <> ?1) AS name_taken`;

/** The columns an AgentPatch may set, by the patch's field. */
export const AGENT_PATCH_COLUMNS = {
  name: 'name',
  nameKey: 'name_key',
  prompt: 'prompt',
  promptPublic: 'prompt_public',
  summary: 'summary',
  summaryStatus: 'summary_status',
  modelKeyId: 'model_key_id',
  status: 'status',
  pausedReason: 'paused_reason',
  hidden: 'hidden',
  strategyChangedAt: 'strategy_changed_at',
  promptChangeDay: 'prompt_change_day',
  promptChangeCount: 'prompt_change_count',
} as const;

export type AgentPatchField = keyof typeof AGENT_PATCH_COLUMNS;

/**
 * The UPDATE of updateAgent. Only the columns of the patch are named, so only the indexes that
 * hold one of them are written. `?1` is the agent id, `?2` is `now`, the patch values follow
 * from `?3` in the order of `fields`. If `nameKeyParam` is given, it is the number of the bound
 * name key and the update is refused while another agent has that key.
 */
export function updateAgentSql(
  fields: readonly AgentPatchField[],
  nameKeyParam: number | null,
  expect = false,
): string {
  const sets = fields.map((field, index) => `${AGENT_PATCH_COLUMNS[field]} = ?${index + 3}`);
  const guard =
    nameKeyParam === null
      ? ''
      : ` AND NOT EXISTS (SELECT 1 FROM agents AS other WHERE other.name_key = ?${nameKeyParam} AND other.id <> ?1)`;
  // With an expectation, the day and the count follow the patch values: ?(n+3) and ?(n+4).
  const day = fields.length + 3;
  const expected = expect ? ` AND prompt_change_day IS ?${day} AND prompt_change_count = ?${day + 1}` : '';
  return `UPDATE agents SET ${['updated_at = ?2', ...sets].join(', ')} WHERE id = ?1${guard}${expected} RETURNING id`;
}

/** Index agents_summary_pending, which holds exactly these agents in this order. ?1 limit. */
export const LIST_AGENTS_NEEDING_SUMMARY = `
SELECT ${AGENT_SELECT} FROM agents INDEXED BY agents_summary_pending
WHERE summary_status = 'pending' AND status = 'active' AND hidden = 0
ORDER BY strategy_changed_at, id
LIMIT ?1`;

// --- model keys -----------------------------------------------------------------------------------

/**
 * One statement decides and writes: the key is stored only while its owner has fewer than
 * the limit. Index model_keys_owner, over that wallet's few keys. The nine values are in
 * MODEL_KEY_SELECT order, so ?2 is the owner. ?10 is the most keys a wallet may hold.
 * A returned row means the key was stored.
 */
export const PUT_MODEL_KEY = `
INSERT INTO model_keys (${MODEL_KEY_SELECT})
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
WHERE (SELECT count(*) FROM model_keys INDEXED BY model_keys_owner WHERE owner = ?2) < ?10
RETURNING id`;

/** Index model_keys_owner. */
export const LIST_MODEL_KEYS = `
SELECT ${MODEL_KEY_SELECT} FROM model_keys INDEXED BY model_keys_owner
WHERE owner = ?1 ORDER BY created_at, id`;

/** A key is returned to its owner and to nobody else. ?1 key id, ?2 owner. */
export const GET_MODEL_KEY = `SELECT ${MODEL_KEY_SELECT} FROM model_keys WHERE id = ?1 AND owner = ?2`;

/**
 * First statement of the deleteModelKey batch: the agent that used the key loses it and is
 * paused with reason `key_removed`, whatever its pause reason was. Every agent of the owner
 * that uses the key is paused, and no other agent. The planner uses the owner index (agents_owner, or agents_owner_created after 0004), so no scan of the
 * agents is needed. It does nothing unless the key exists and is the owner's.
 * ?1 key id, ?2 owner, ?3 now.
 */
export const DETACH_AGENT_OF_KEY = `
UPDATE agents
SET model_key_id = NULL, status = 'paused', paused_reason = 'key_removed', updated_at = ?3
WHERE owner = ?2 AND model_key_id = ?1
  AND EXISTS (SELECT 1 FROM model_keys WHERE id = ?1 AND owner = ?2)`;

/** Second statement of the deleteModelKey batch. ?1 key id, ?2 owner. */
export const DELETE_MODEL_KEY = 'DELETE FROM model_keys WHERE id = ?1 AND owner = ?2 RETURNING id';

// --- seasons, market, ticks -----------------------------------------------------------------------

/** Index seasons_starts_at: reads the newest season that has started, and no other. ?1 now. */
export const GET_ACTIVE_SEASON = `
SELECT ${SEASON_SELECT} FROM (
  SELECT ${SEASON_SELECT} FROM seasons INDEXED BY seasons_starts_at
  WHERE starts_at <= ?1 ORDER BY starts_at DESC LIMIT 1
)
WHERE ends_at > ?1`;

/** Index seasons_starts_at. ?1 now. */
export const GET_LATEST_STARTED_SEASON = `
SELECT ${SEASON_SELECT} FROM seasons INDEXED BY seasons_starts_at
WHERE starts_at <= ?1 ORDER BY starts_at DESC LIMIT 1`;

export const GET_SEASON = `SELECT ${SEASON_SELECT} FROM seasons WHERE id = ?1`;

/** A season is 28 days, so this table has a handful of rows. */
export const LIST_SEASONS = `SELECT ${SEASON_SELECT} FROM seasons ORDER BY number`;

export const GET_MARKET_STATUS = 'SELECT body FROM market_status WHERE id = 1';

export const PUT_MARKET_STATUS = `
INSERT INTO market_status (id, body) VALUES (1, ?1)
ON CONFLICT (id) DO UPDATE SET body = excluded.body`;

export const GET_TICK = `SELECT ${TICK_SELECT} FROM ticks WHERE id = ?1`;

/** The primary key, read from its end. */
export const GET_LATEST_TICK = `SELECT ${TICK_SELECT} FROM ticks ORDER BY id DESC LIMIT 1`;

/**
 * The prices of the newest ticks before one, newest first: the primary key read from just below
 * ?1, at most ?2 rows (TRUSTED_PRICE_LOOKBACK_TICKS), with no sort. The store keeps the newest fresh
 * point of each symbol. Only the prices leave the database: json_extract is a scalar function,
 * so unlike json_each it adds no rows read. ?1 before tick id, ?2 limit.
 */
export const LIST_TRUSTED_PRICE_TICKS = `
SELECT id, json_extract(snapshot, '$.prices') AS prices FROM ticks
WHERE id < ?1 ORDER BY id DESC LIMIT ?2`;

/** The primary key refuses a second tick for the same hour. A returned row means it was created. */
export const CREATE_TICK = `
INSERT INTO ticks (${TICK_SELECT}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT (id) DO NOTHING
RETURNING id`;

/** Index ticks_processing, which holds only unfinished ticks. Runs every minute. */
export const LIST_PROCESSING_TICKS = `
SELECT ${TICK_SELECT} FROM ticks INDEXED BY ticks_processing
WHERE status = 'processing' ORDER BY id`;

/** Does nothing to a tick that is already complete, so the first completion time stays. */
export const COMPLETE_TICK = `
UPDATE ticks SET status = 'complete', completed_at = ?2
WHERE id = ?1 AND status = 'processing'`;

/**
 * The primary key, over the at most 24 tick ids of one day.
 * ?1 season id, ?2 the day's first possible tick id, ?3 its last.
 */
export const HAS_DAILY_TICK = `
SELECT EXISTS (
  SELECT 1 FROM ticks WHERE id >= ?2 AND id <= ?3 AND season_id = ?1 AND daily = 1
) AS found`;

/**
 * The last tick of each earlier day, newest first. Each step of the recursion is one seek at
 * the end of a key range: `max(id)` below a day (a day is a prefix of its tick ids, so it sorts
 * before all of them). The statement reads about three rows per day returned, however long
 * the history is.
 *
 * The snapshot comes back whole and the store takes the prices out of it. Doing that here with
 * json_each was measured: D1 counts every array element as a row read, one per symbol of the
 * universe a day (UNIVERSE_SIZE, twenty-two with the crypto assets of section 21), which
 * costs more of the daily allowance than the parsing saves. For the same reason there is no
 * ORDER BY: the store sorts the few rows it gets.
 * ?1 before day, ?2 limit.
 */
export const LIST_DAILY_PRICES = `
WITH RECURSIVE last_ticks (id, n) AS (
  SELECT (SELECT max(id) FROM ticks WHERE id < ?1), 1 WHERE ?2 >= 1
  UNION ALL
  SELECT (SELECT max(id) FROM ticks WHERE id < substr(last_ticks.id, 1, 10)), last_ticks.n + 1
  FROM last_ticks
  WHERE last_ticks.id IS NOT NULL AND last_ticks.n < ?2
)
SELECT t.id, t.snapshot
FROM last_ticks CROSS JOIN ticks AS t ON t.id = last_ticks.id`;

// --- symbols held for review ----------------------------------------------------------------------

/** At most one row per universe symbol: UNIVERSE_SIZE rows (twenty-two) at the very most. */
export const LIST_SYMBOL_HOLDS = `
SELECT symbol, price_micro, seen_price_micro, since_tick_id, released_at, created_at
FROM symbol_holds ORDER BY symbol`;

/** Keeps the row a symbol already has, released or not. */
export const PUT_SYMBOL_HOLD = `
INSERT INTO symbol_holds (symbol, price_micro, seen_price_micro, since_tick_id, released_at, created_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (symbol) DO NOTHING`;

export const DELETE_SYMBOL_HOLD = 'DELETE FROM symbol_holds WHERE symbol = ?1 RETURNING symbol';

/**
 * One guarded UPDATE: a hold is released once, and the first release time stays.
 * ?1 symbol, ?2 released at. A returned row means this call released the hold.
 */
export const RELEASE_SYMBOL_HOLD = `
UPDATE symbol_holds SET released_at = ?2
WHERE symbol = ?1 AND released_at IS NULL
RETURNING symbol`;

// --- scheduler work -------------------------------------------------------------------------------

/**
 * An agent is pending for a tick while its portfolio in the tick's season has no row at that
 * tick or later. writeDecision moves `last_tick_id` in the same transaction that inserts the
 * row and refuses a row that is not newer, so this is "no row for the tick yet".
 *
 * Membership is fixed at the snapshot (docs/CONTRACTS.md section 15): an agent created at or
 * after the tick's `created_at` is not in the tick. Both are toISOString() text, so text
 * order is time order. A paused agent and a hidden agent are not scheduled.
 */
const PENDING_WHERE = `
  p.season_id = (SELECT season_id FROM ticks WHERE id = ?1)
  AND p.division = ?2
  AND (p.last_tick_id IS NULL OR p.last_tick_id < ?1)
  AND p.agent_created_at < (SELECT created_at FROM ticks WHERE id = ?1)
  AND a.status = 'active' AND a.hidden = 0`;

/**
 * Index portfolios_pending, which is in the fair order already: never asked first (null sorts
 * first), then asked longest ago, then by agent id. The scan stops after `limit` agents.
 * ?1 tick id, ?2 division, ?3 limit.
 */
export const LIST_PENDING_AGENTS = `
SELECT ${AGENT_SELECT_A}, p.portfolio, p.stats, p.key_failures
FROM portfolios AS p INDEXED BY portfolios_pending
CROSS JOIN agents AS a ON a.id = p.agent_id
WHERE ${PENDING_WHERE}
ORDER BY p.last_asked_tick_id ASC, p.agent_id ASC
LIMIT ?3`;

/** Index portfolios_pending, one division of one season. ?1 tick id, ?2 division. */
export const COUNT_PENDING_AGENTS = `
SELECT count(*) AS n
FROM portfolios AS p INDEXED BY portfolios_pending
CROSS JOIN agents AS a ON a.id = p.agent_id
WHERE ${PENDING_WHERE}`;

/**
 * What both statements of the writeDecision batch ask of the agent's portfolio in the row's
 * season: its latest row is older than the tick. A second row for the same tick is refused,
 * and so is a row for an earlier tick, so an agent's rows are always in tick order.
 */
function isNewerThanLatestRow(tick: string): string {
  return `(last_tick_id IS NULL OR last_tick_id < ${tick})`;
}

/**
 * First statement of the writeDecision batch: the row itself, written only while the agent
 * has a portfolio in the row's season whose latest row is older than the tick. The primary
 * key of `decisions` stands behind it. A returned row means the decision was applied by this
 * call.
 * ?1 agent id, ?2 tick id, ?3 season id, ?4 division, ?5 status, ?6 code, ?7 body JSON,
 * ?8 created at.
 */
export const WRITE_DECISION_ROW = `
INSERT INTO decisions (agent_id, tick_id, season_id, division, status, code, body, created_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
WHERE EXISTS (
  SELECT 1 FROM portfolios
  WHERE agent_id = ?1 AND season_id = ?3 AND ${isNewerThanLatestRow('?2')}
)
ON CONFLICT (agent_id, tick_id) DO NOTHING
RETURNING tick_id`;

/**
 * Second statement of the writeDecision batch: the agent's new state. The portfolio is still
 * as the first statement saw it, so the same condition holds or fails for both, and the state
 * moves only if the row of this season and tick is there: both write or neither does.
 * A skipped row does not count as being asked.
 * ?1 agent id, ?2 season id, ?3 tick id, ?4 status, ?5 portfolio JSON, ?6 stats JSON,
 * ?7 return, ?8 drawdown, ?9 trades, ?10 trading days, ?11 decided, ?12 the row's created at,
 * ?13 key failures.
 */
export const WRITE_DECISION_PORTFOLIO = `
UPDATE portfolios SET
  portfolio = ?5,
  stats = ?6,
  last_tick_id = ?3,
  last_asked_tick_id = CASE WHEN ?4 = 'skipped' THEN last_asked_tick_id ELSE ?3 END,
  last_status = ?4,
  season_return_bps = ?7,
  max_drawdown_bps = ?8,
  trade_count = ?9,
  trading_days = ?10,
  decided_count = ?11,
  key_failures = ?13,
  updated_at = ?12
WHERE agent_id = ?1 AND season_id = ?2 AND ${isNewerThanLatestRow('?3')}
  AND EXISTS (SELECT 1 FROM decisions WHERE agent_id = ?1 AND tick_id = ?3 AND season_id = ?2)`;

/** The single row of scheduler_state, rewritten. ?1 now. */
export const TOUCH_SCHEDULER = `
INSERT INTO scheduler_state (id, touched_at) VALUES (1, ?1)
ON CONFLICT (id) DO UPDATE SET touched_at = excluded.touched_at`;

/**
 * An agent is ranked if it is visible, has its latest row at the tick or at a later one, and
 * meets both thresholds. `p` is the portfolio; the thresholds are bound values from
 * packages/contracts. The first term is written so that it is 0 and never NULL for an agent
 * without a row: RERANK_CLEAR negates this condition, and NOT NULL would keep a rank.
 * ?3 tick id, ?4 minimum trading days, ?5 minimum decisions.
 */
function rankedWhere(p: string): string {
  return `(${p}.last_tick_id IS NOT NULL AND ${p}.last_tick_id >= ?3)
    AND ${p}.trading_days >= ?4 AND ${p}.decided_count >= ?5
    AND EXISTS (SELECT 1 FROM agents AS a WHERE a.id = ${p}.agent_id AND a.hidden = 0)`;
}

/**
 * True while the season ?1 is a v2 season: its season_methods row (a primary-key read) says so.
 * The v1 statements of the rerank batch run only when it is false and the v2 ones only when it
 * is true, so one batch serves both methods and exactly one half of it writes.
 * docs/contracts/phase-6-social.md section 3.
 */
const SEASON_IS_V2 = `EXISTS (SELECT 1 FROM season_methods WHERE season_id = ?1 AND method = 'v2')`;

/**
 * First statement of the rerank batch: take the rank from every agent that no longer has one
 * coming. Index portfolios_league, the ranked part of one division. Not in a v2 season.
 * ?1 season id, ?2 division, ?3 to ?5 as in rankedWhere.
 */
export const RERANK_CLEAR = `
UPDATE portfolios INDEXED BY portfolios_league SET rank = NULL
WHERE season_id = ?1 AND division = ?2 AND (rank IS NULL) = 0
  AND NOT (${rankedWhere('portfolios')})
  AND NOT ${SEASON_IS_V2}`;

/**
 * Second statement of the rerank batch: number the ranked agents 1, 2, 3 in the order of
 * section 9 with a window function, and write only the ranks that changed. Index
 * portfolios_league, one division of one season. Not in a v2 season.
 * ?1 season id, ?2 division, ?3 to ?5 as in rankedWhere.
 */
export const RERANK_ASSIGN = `
UPDATE portfolios SET rank = ranked.new_rank
FROM (
  SELECT p.agent_id AS agent_id, row_number() OVER (ORDER BY ${SECTION_9_ORDER}) AS new_rank
  FROM portfolios AS p INDEXED BY portfolios_league
  WHERE p.season_id = ?1 AND p.division = ?2 AND ${rankedWhere('p')} AND NOT ${SEASON_IS_V2}
) AS ranked
WHERE portfolios.agent_id = ranked.agent_id AND portfolios.season_id = ?1
  AND portfolios.rank IS NOT ranked.new_rank
  AND NOT ${SEASON_IS_V2}`;

/**
 * Third statement of the rerank batch, v2 seasons only: take the rank from every agent whose
 * season_scores row is missing, unranked or belongs to a hidden agent. Index portfolios_league,
 * the ranked part of one division; the season_scores probe is its primary key.
 * ?1 season id, ?2 division.
 */
export const RERANK_CLEAR_V2 = `
UPDATE portfolios INDEXED BY portfolios_league SET rank = NULL
WHERE season_id = ?1 AND division = ?2 AND (rank IS NULL) = 0
  AND ${SEASON_IS_V2}
  AND NOT EXISTS (
    SELECT 1 FROM season_scores AS s CROSS JOIN agents AS a ON a.id = s.agent_id
    WHERE s.season_id = ?1 AND s.division = ?2 AND s.agent_id = portfolios.agent_id
      AND s.rank IS NOT NULL AND a.hidden = 0
  )`;

/**
 * Fourth statement of the rerank batch, v2 seasons only: copy the official rank of every
 * visible, ranked season_scores row of the division onto its portfolio, writing only the ranks
 * that changed. season_scores by its primary key prefix, portfolios by primary key.
 * ?1 season id, ?2 division.
 */
export const RERANK_COPY_V2 = `
UPDATE portfolios SET rank = s.rank
FROM season_scores AS s
WHERE ${SEASON_IS_V2}
  AND s.season_id = ?1 AND s.division = ?2 AND s.rank IS NOT NULL
  AND EXISTS (SELECT 1 FROM agents AS a WHERE a.id = s.agent_id AND a.hidden = 0)
  AND portfolios.agent_id = s.agent_id AND portfolios.season_id = ?1
  AND portfolios.rank IS NOT s.rank`;

/**
 * Fifth statement of the rerank batch: replace the league state, with both counts taken in
 * SQL after the ranks were written. Index portfolios_league for both counts. The method is the
 * season's own (season_methods), ?5 only for a season without a row. `scoredDay` is the day the
 * official v2 ranks are as of, null in a v1 season (the store leaves it out of a v1 state).
 * ?1 season id, ?2 division, ?3 tick id, ?4 computed at, ?5 method.
 */
export const RERANK_STATE = `
INSERT INTO league_state (season_id, division, body)
VALUES (?1, ?2, json_object(
  'seasonId', ?1,
  'division', ?2,
  'tickId', ?3,
  'computedAt', ?4,
  'method', coalesce((SELECT method FROM season_methods WHERE season_id = ?1), ?5),
  'scoredDay', (
    SELECT max(scored_day) FROM season_scores
    WHERE season_id = ?1 AND division = ?2 AND method = 'v2'
  ),
  'rankedCount', (
    SELECT count(*) FROM portfolios INDEXED BY portfolios_league
    WHERE season_id = ?1 AND division = ?2 AND (rank IS NULL) = 0
  ),
  'agentCount', (
    SELECT count(*) FROM portfolios AS p INDEXED BY portfolios_league
    CROSS JOIN agents AS a ON a.id = p.agent_id
    WHERE p.season_id = ?1 AND p.division = ?2 AND a.hidden = 0
  )
))
ON CONFLICT (season_id, division) DO UPDATE SET body = excluded.body
RETURNING body`;

// --- reads ----------------------------------------------------------------------------------------

/** Two primary-key reads: the portfolio and its season_scores row. ?1 agent id, ?2 season id. */
export const GET_PORTFOLIO = `
SELECT p.portfolio, p.stats, p.last_tick_id, p.rank, ${OFFICIAL_SELECT}
FROM portfolios AS p
${OFFICIAL_JOIN}
WHERE p.agent_id = ?1 AND p.season_id = ?2`;

/** The primary key of decisions, read backwards from the agent's newest row. */
export const LIST_DECISIONS = `
SELECT body FROM decisions
WHERE agent_id = ?1 AND season_id = ?2
ORDER BY tick_id DESC
LIMIT ?3`;

export const GET_LEAGUE_STATE = 'SELECT body FROM league_state WHERE season_id = ?1 AND division = ?2';

/**
 * One page of a league table, read straight off index portfolios_league: its column order
 * is this ORDER BY, so there is no sort and the scan stops at the end of the page.
 * ?1 season id, ?2 division, ?3 limit, ?4 offset.
 */
export const LIST_STANDINGS = `
SELECT ${STANDING_SELECT}, ${OFFICIAL_SELECT}
FROM portfolios AS p INDEXED BY portfolios_league
CROSS JOIN agents AS a ON a.id = p.agent_id
${OFFICIAL_JOIN}
WHERE p.season_id = ?1 AND p.division = ?2 AND a.hidden = 0
ORDER BY (p.rank IS NULL), p.rank, ${SECTION_9_ORDER}
LIMIT ?3 OFFSET ?4`;

/**
 * The snapshots of the distinct ticks of one league page, so that every row gets the prices of its
 * latest row (docs/CONTRACTS.md section 17.2). One primary-key read per id; most rows of a page
 * share the league's tick, so a page reads one or two. D1 counts each json_each element as a row
 * read, which is the same handful. ?1 a JSON array of tick ids.
 */
export const LIST_TICK_SNAPSHOTS = `
SELECT id, snapshot FROM ticks WHERE id IN (SELECT value FROM json_each(?1))`;

/**
 * Four primary-key reads: the portfolio, the agent, the tick of its latest row, whose snapshot
 * gives the prices of the row (null when the agent has no row), and its season_scores row for the
 * official rank (docs/contracts/phase-6-social.md section 3). ?1 agent id, ?2 season id.
 */
export const GET_STANDING = `
SELECT ${STANDING_SELECT}, t.snapshot AS snapshot, ${OFFICIAL_SELECT}
FROM portfolios AS p
CROSS JOIN agents AS a ON a.id = p.agent_id
LEFT JOIN ticks AS t ON t.id = p.last_tick_id
${OFFICIAL_JOIN}
WHERE p.agent_id = ?1 AND p.season_id = ?2 AND a.hidden = 0`;

// --- budgets --------------------------------------------------------------------------------------

export const GET_AI_NEURONS = 'SELECT neurons FROM ai_usage WHERE day = ?1 AND use = ?2';

export const ADD_AI_NEURONS = `
INSERT INTO ai_usage (day, use, neurons) VALUES (?1, ?2, ?3)
ON CONFLICT (day, use) DO UPDATE SET neurons = neurons + excluded.neurons`;

/**
 * Adds ?2 rows to the day ?1 only while the sum stays at or under ?3. A returned row means it did.
 * A first spend larger than the maximum finds no row to update and inserts one, so the insert
 * is guarded too.
 */
export const SPEND_API_WRITES = `
INSERT INTO api_writes (day, rows) SELECT ?1, ?2 WHERE ?2 <= ?3
ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows
WHERE rows + excluded.rows <= ?3
RETURNING rows`;

/**
 * Counts one state-changing request of the wallet ?1 on day ?2 while the count is under ?3.
 * A wallet with no row gets one. A returned row means the request was counted.
 */
export const SPEND_WALLET_WRITE = `
INSERT INTO users (address, created_at, write_day, write_count)
SELECT ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?2, 1 WHERE ?3 > 0
ON CONFLICT (address) DO UPDATE SET
  write_day = excluded.write_day,
  write_count = CASE WHEN write_day = excluded.write_day THEN write_count + 1 ELSE 1 END
WHERE write_day <> excluded.write_day OR write_count < ?3
RETURNING write_count`;
