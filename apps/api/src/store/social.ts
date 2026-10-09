import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type {
  AgentStats,
  DnaObservation,
  FinalDay,
  LineageMember,
  LineageRow,
  ManagerBook,
  ManagerBookRow,
  ManagerDayWrite,
  ManagerListRow,
  ManagerPolicy,
  ManagerRebalance,
  ManagerRecord,
  ManagerWork,
  PortfolioState,
  RankTapeDay,
  Rivalry,
  RivalryEvent,
  SocialAgentRecord,
  SocialStore,
  StoredRivalryView,
  WarEntrant,
  WarPatch,
  WarRecord,
  WarRow,
} from '@prix/contracts';
import {
  agentStatsSchema,
  DailyLimitError,
  dnaProfileSchema,
  managerBookSchema,
  managerPolicySchema,
  managerRebalanceSchema,
  managerRecordSchema,
  rivalryEventSchema,
  rivalrySchema,
  utcDayOfTick,
  warEntrantSchema,
  warRecordSchema,
  warRowSchema,
} from '@prix/contracts';

/**
 * The Phase 6 side of D1: `createSocialStore(db)` implements `SocialStore` over
 * infra/migrations/0008_social.sql (docs/contracts/phase-6-social.md sections 2 and 5).
 *
 * Every method is one D1 call or one D1 batch, and a batch is a transaction. Every query uses an index of
 * 0001, 0002 or 0008, named beside it. No statement here selects agents.prompt: an agent is read with the
 * columns of AGENT_RECORD only. A read that names agents leaves hidden agents out; listAgentRecords alone
 * returns them, marked hidden. Every limit, guard and cap is a condition inside a statement.
 */

type Bound = string | number | null;

// --- helpers --------------------------------------------------------------------------------------------

function fromJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function flag(value: boolean): number {
  return value ? 1 : 0;
}

/** A limit, an offset or a count from the caller: a whole number, zero or more, or the statement fails here. */
function wholeNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`social store: ${name} must be a whole number, zero or more`);
  return value;
}

/** A number of neurons: finite and zero or more. */
function neuronsOf(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`social store: ${name} must be a finite number, zero or more`);
  return value;
}

/** The UTC day after `day`. */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

function rowsOf<T>(results: D1Result<unknown>[], index: number): T[] {
  const result = results[index];
  if (result === undefined) throw new Error(`social store: the batch returned no result for statement ${index}`);
  return result.results as T[];
}

/** True when a D1 error is the primary key of war_rows refusing a second row of a war, tick and slot. */
function isWarRowConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`;
  return /UNIQUE constraint failed: war_rows\./.test(text);
}

// --- agents as Phase 6 reads them ------------------------------------------------------------------------

/** The columns of a SocialAgentRecord. Never the prompt, the key, the summary or any figure. */
function agentRecordColumns(alias: string, prefix: string): string {
  return ['id', 'name', 'owner', 'division', 'hidden', 'created_at']
    .map((c) => `${alias}.${c} AS ${prefix}${c}`)
    .join(', ');
}

interface AgentRecordSql {
  id: string;
  name: string;
  owner: string;
  division: SocialAgentRecord['division'];
  hidden: number;
  created_at: string;
}

function toAgentRecord(row: Record<string, unknown>, prefix: string): SocialAgentRecord {
  const r = (column: keyof AgentRecordSql) => row[`${prefix}${column}`];
  return {
    id: r('id') as string,
    name: r('name') as string,
    owner: r('owner') as string,
    division: r('division') as SocialAgentRecord['division'],
    hidden: r('hidden') === 1,
    createdAt: r('created_at') as string,
  };
}

// --- shared ---------------------------------------------------------------------------------------------

/**
 * Final days: day_prices by its primary key after ?1, while index ticks_processing holds no tick.
 * The season is the one of the tick the prices came from (ticks primary key). ?1 after day, ?2 limit.
 */
const LIST_FINAL_DAYS = `
SELECT dp.day AS day, dp.tick_id AS tick_id, t.season_id AS season_id
FROM day_prices AS dp CROSS JOIN ticks AS t ON t.id = dp.tick_id
WHERE dp.day > ?1
  AND NOT EXISTS (SELECT 1 FROM ticks INDEXED BY ticks_processing WHERE status = 'processing')
ORDER BY dp.day
LIMIT ?2`;

const PUT_CURSOR = `
INSERT INTO job_state (name, body, updated_at) VALUES (?1, ?2, ?3)
ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`;

/** The agents primary key, once per id of the JSON array ?1. Hidden agents included, marked. */
const LIST_AGENT_RECORDS = `
SELECT ${agentRecordColumns('a', '')}
FROM json_each(?1) AS ids CROSS JOIN agents AS a ON a.id = ids.value`;

// --- Strategy DNA ---------------------------------------------------------------------------------------

/** The agents primary key in id order, visible ones only. ?1 after id ('' for the start), ?2 limit. */
const LIST_DNA_AGENTS = `
SELECT id, strategy_changed_at FROM agents
WHERE id > ?1 AND hidden = 0
ORDER BY id
LIMIT ?2`;

/**
 * The end-of-day read of the migration's comment: one seek per day at the end of the agent's key range of
 * decisions (primary key agent_id, tick_id), never json_each. ?1 agent id, ?2 the day after the last day
 * wanted, ?3 limit.
 */
const LIST_END_OF_DAY = `
WITH RECURSIVE eod (tick_id, n) AS (
  SELECT (SELECT max(tick_id) FROM decisions WHERE agent_id = ?1 AND tick_id < ?2), 1 WHERE ?3 >= 1
  UNION ALL
  SELECT (SELECT max(tick_id) FROM decisions WHERE agent_id = ?1 AND tick_id < substr(eod.tick_id, 1, 10)), eod.n + 1
  FROM eod WHERE eod.tick_id IS NOT NULL AND eod.n < ?3
)
SELECT d.tick_id, d.season_id, json_extract(d.body, '$.portfolio') AS portfolio,
       json_extract(d.body, '$.equityMicro') AS equity_micro
FROM eod CROSS JOIN decisions AS d ON d.agent_id = ?1 AND d.tick_id = eod.tick_id`;

const PUT_DNA = `
INSERT INTO strategy_dna (agent_id, method, as_of_day, body, computed_at) VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (agent_id) DO UPDATE SET
  method = excluded.method, as_of_day = excluded.as_of_day, body = excluded.body, computed_at = excluded.computed_at`;

/** Two primary-key reads. */
const GET_DNA = `
SELECT d.body FROM strategy_dna AS d CROSS JOIN agents AS a ON a.id = d.agent_id
WHERE d.agent_id = ?1 AND a.hidden = 0`;

// --- forks ----------------------------------------------------------------------------------------------

const PUT_LINEAGE = `
INSERT INTO agent_lineage (agent_id, parent_id, root_id, depth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (agent_id) DO NOTHING
RETURNING agent_id`;

/** Two primary-key reads: the row and its agent, which must be visible. */
const GET_LINEAGE = `
SELECT l.agent_id, l.parent_id, l.root_id, l.depth, l.created_at
FROM agent_lineage AS l CROSS JOIN agents AS a ON a.id = l.agent_id
WHERE l.agent_id = ?1 AND a.hidden = 0`;

/** A member's parent id, or null when the parent is hidden. */
const VISIBLE_PARENT = `CASE WHEN EXISTS (SELECT 1 FROM agents AS pa WHERE pa.id = l.parent_id AND pa.hidden = 0)
  THEN l.parent_id ELSE NULL END AS parent_id`;

/** Index agent_lineage_parent, then agents by primary key. ?1 parent id. */
const COUNT_CHILDREN = `
SELECT count(*) AS n FROM agent_lineage AS l INDEXED BY agent_lineage_parent
CROSS JOIN agents AS a ON a.id = l.agent_id
WHERE l.parent_id = ?1 AND a.hidden = 0`;

/** Index agent_lineage_parent read backwards: newest first. ?1 parent id, ?2 limit, ?3 offset. */
const LIST_CHILDREN = `
SELECT ${agentRecordColumns('a', '')}, l.depth, ${VISIBLE_PARENT}
FROM agent_lineage AS l INDEXED BY agent_lineage_parent
CROSS JOIN agents AS a ON a.id = l.agent_id
WHERE l.parent_id = ?1 AND a.hidden = 0
ORDER BY l.created_at DESC, l.agent_id DESC
LIMIT ?2 OFFSET ?3`;

/** Index agent_lineage_root. ?1 root id. */
const COUNT_FAMILY = `
SELECT count(*) AS n FROM agent_lineage AS l INDEXED BY agent_lineage_root
CROSS JOIN agents AS a ON a.id = l.agent_id
WHERE l.root_id = ?1 AND a.hidden = 0`;

/** Index agent_lineage_root: creation order. ?1 root id, ?2 limit, ?3 offset. */
const LIST_FAMILY = `
SELECT ${agentRecordColumns('a', '')}, l.depth, ${VISIBLE_PARENT}
FROM agent_lineage AS l INDEXED BY agent_lineage_root
CROSS JOIN agents AS a ON a.id = l.agent_id
WHERE l.root_id = ?1 AND a.hidden = 0
ORDER BY l.created_at, l.agent_id
LIMIT ?2 OFFSET ?3`;

// --- rank tape and rivalries ------------------------------------------------------------------------------

/**
 * One tape row of one division, built in SQL from portfolios.rank (index portfolios_league, the ranked
 * part of the division) with json_group_array, visible agents only, in rank order. Written only while the
 * ranks are still those of the day: in a v1 season no tick of a later day exists (ticks primary key); in a
 * v2 season the division's league state is scored as of the day, or the division has no visible agent (no
 * league state, or agentCount 0), and its row is recorded empty, as in v1. Otherwise nothing is written,
 * and the day stays missing: it is never invented. A second write of the same day changes nothing.
 * ?1 season id, ?2 division, ?3 day, ?4 method, ?5 now.
 */
const WRITE_TAPE_DAY = `
INSERT INTO rivalry_days (season_id, division, day, method, ranks, ranked_count, created_at)
SELECT season_id, division, day, method, ranks, ranked_count, created_at FROM (
  SELECT ?1 AS season_id, ?2 AS division, ?3 AS day, ?4 AS method,
    json_group_array(json_array(r.agent_id, r.rank)) AS ranks, count(*) AS ranked_count, ?5 AS created_at
  FROM (
    SELECT p.agent_id AS agent_id, p.rank AS rank
    FROM portfolios AS p INDEXED BY portfolios_league
    CROSS JOIN agents AS a ON a.id = p.agent_id
    WHERE p.season_id = ?1 AND p.division = ?2 AND (p.rank IS NULL) = 0 AND a.hidden = 0
    ORDER BY p.rank
  ) AS r
)
WHERE CASE ?4
  WHEN 'v2' THEN coalesce(
    (SELECT coalesce(json_extract(body, '$.scoredDay') = ?3, 0) OR coalesce(json_extract(body, '$.agentCount'), 0) = 0
     FROM league_state WHERE season_id = ?1 AND division = ?2), 1)
  ELSE NOT EXISTS (SELECT 1 FROM ticks WHERE id > ?3 || 'U')
END
ON CONFLICT (season_id, division, day) DO NOTHING`;

/**
 * rivalry_days primary key read backwards. Agents hidden since are taken out of the ranks (agents primary
 * key per entry). ?1 season id, ?2 division, ?3 through day, ?4 limit.
 */
const LIST_TAPE = `
SELECT d.season_id, d.division, d.day, d.method,
  (SELECT json_group_array(json(j.value)) FROM json_each(d.ranks) AS j
   WHERE EXISTS (SELECT 1 FROM agents AS a WHERE a.id = json_extract(j.value, '$[0]') AND a.hidden = 0)) AS ranks
FROM rivalry_days AS d
WHERE d.season_id = ?1 AND d.division = ?2 AND d.day <= ?3
ORDER BY d.day DESC
LIMIT ?4`;

/** rivalry_days primary key prefix. */
const COUNT_TAPE_DAYS = 'SELECT count(*) AS n FROM rivalry_days WHERE season_id = ?1 AND division = ?2';

const RIVALRY_COLUMNS =
  'r.season_id, r.agent_a, r.agent_b, r.division, r.status, r.formed_day, r.ended_day, r.end_reason, r.leader, r.lead_changes, r.last_day, r.series';

/** Both agents of a rivalry `r`, by primary key, each visible. */
const RIVALRY_AGENTS = `
CROSS JOIN agents AS xa ON xa.id = r.agent_a
CROSS JOIN agents AS xb ON xb.id = r.agent_b`;
const RIVALRY_AGENTS_VISIBLE = 'xa.hidden = 0 AND xb.hidden = 0';
const RIVALRY_VIEW_SELECT = `${RIVALRY_COLUMNS}, ${agentRecordColumns('xa', 'xa_')}, ${agentRecordColumns('xb', 'xb_')}`;

/**
 * Index rivalries_active: the active rivalries of a division, oldest season first (seasons primary key),
 * both agents visible. ?1 division, ?2 limit.
 */
const LIST_ACTIVE_RIVALRIES = `
SELECT ${RIVALRY_COLUMNS}
FROM rivalries AS r INDEXED BY rivalries_active
${RIVALRY_AGENTS}
WHERE r.division = ?1 AND r.status = 'active' AND ${RIVALRY_AGENTS_VISIBLE}
ORDER BY (SELECT s.starts_at FROM seasons AS s WHERE s.id = r.season_id), r.season_id, r.agent_a, r.agent_b
LIMIT ?2`;

/**
 * Every rivalry the day changes, in one statement: ?1 a JSON array of rows (`series` as JSON text), ?2 now.
 * rivalries primary key per row. Rows apply in array order, so a later row of the same pair wins.
 */
const UPSERT_RIVALRIES = `
INSERT INTO rivalries (season_id, agent_a, agent_b, division, status, formed_day, ended_day, end_reason, leader,
  lead_changes, last_day, series, updated_at)
SELECT json_extract(r.value, '$.seasonId'), json_extract(r.value, '$.agentA'), json_extract(r.value, '$.agentB'),
  json_extract(r.value, '$.division'), json_extract(r.value, '$.status'), json_extract(r.value, '$.formedDay'),
  json_extract(r.value, '$.endedDay'), json_extract(r.value, '$.endReason'), json_extract(r.value, '$.leader'),
  json_extract(r.value, '$.leadChanges'), json_extract(r.value, '$.lastDay'), json_extract(r.value, '$.series'), ?2
FROM json_each(?1) AS r
WHERE true
ON CONFLICT (season_id, agent_a, agent_b) DO UPDATE SET
  division = excluded.division, status = excluded.status, formed_day = excluded.formed_day,
  ended_day = excluded.ended_day, end_reason = excluded.end_reason, leader = excluded.leader,
  lead_changes = excluded.lead_changes, last_day = excluded.last_day, series = excluded.series,
  updated_at = excluded.updated_at`;

/**
 * Every event of the day, in one statement: ?1 a JSON array of events (`detail` as JSON text). Insert only;
 * the rivalry_events primary key makes a second write of the same event change nothing.
 */
const INSERT_RIVALRY_EVENTS = `
INSERT INTO rivalry_events (season_id, agent_a, agent_b, day, seq, kind, subject, rank_a, rank_b, detail)
SELECT json_extract(e.value, '$.seasonId'), json_extract(e.value, '$.agentA'), json_extract(e.value, '$.agentB'),
  json_extract(e.value, '$.day'), json_extract(e.value, '$.seq'), json_extract(e.value, '$.kind'),
  json_extract(e.value, '$.subject'), json_extract(e.value, '$.rankA'), json_extract(e.value, '$.rankB'),
  json_extract(e.value, '$.detail')
FROM json_each(?1) AS e
WHERE true
ON CONFLICT (season_id, agent_a, agent_b, day, seq) DO NOTHING`;

/** Index rivalries_list: active first, newest formed first. ?1 season id, ?2 division, ?3 limit, ?4 offset. */
const LIST_RIVALRIES = `
SELECT ${RIVALRY_VIEW_SELECT}
FROM rivalries AS r INDEXED BY rivalries_list
${RIVALRY_AGENTS}
WHERE r.season_id = ?1 AND r.division = ?2 AND ${RIVALRY_AGENTS_VISIBLE}
ORDER BY r.status, r.formed_day DESC, r.agent_a, r.agent_b
LIMIT ?3 OFFSET ?4`;

/** Indexes rivalries_agent_a and rivalries_agent_b: one agent from either side. ?1 agent id, ?2 season id. */
const LIST_AGENT_RIVALRIES = `
SELECT ${RIVALRY_VIEW_SELECT}
FROM rivalries AS r INDEXED BY rivalries_agent_a
${RIVALRY_AGENTS}
WHERE r.agent_a = ?1 AND r.season_id = ?2 AND r.status = 'active' AND ${RIVALRY_AGENTS_VISIBLE}
UNION ALL
SELECT ${RIVALRY_VIEW_SELECT}
FROM rivalries AS r INDEXED BY rivalries_agent_b
${RIVALRY_AGENTS}
WHERE r.agent_b = ?1 AND r.season_id = ?2 AND r.status = 'active' AND ${RIVALRY_AGENTS_VISIBLE}`;

/** Primary keys. ?1 season id, ?2 agent a, ?3 agent b. */
const GET_RIVALRY = `
SELECT ${RIVALRY_VIEW_SELECT}
FROM rivalries AS r
${RIVALRY_AGENTS}
WHERE r.season_id = ?1 AND r.agent_a = ?2 AND r.agent_b = ?3 AND ${RIVALRY_AGENTS_VISIBLE}`;

/** rivalry_events primary key read backwards. ?1 season id, ?2 agent a, ?3 agent b, ?4 limit. */
const LIST_RIVALRY_EVENTS = `
SELECT season_id, agent_a, agent_b, day, seq, kind, subject, rank_a, rank_b, detail
FROM rivalry_events
WHERE season_id = ?1 AND agent_a = ?2 AND agent_b = ?3
ORDER BY day DESC, seq DESC
LIMIT ?4`;

interface RivalrySql {
  season_id: string;
  agent_a: string;
  agent_b: string;
  division: Rivalry['division'];
  status: Rivalry['status'];
  formed_day: string;
  ended_day: string | null;
  end_reason: Rivalry['endReason'];
  leader: string | null;
  lead_changes: number;
  last_day: string;
  series: string;
}

function toRivalry(row: RivalrySql): Rivalry {
  return {
    seasonId: row.season_id,
    division: row.division,
    agentA: row.agent_a,
    agentB: row.agent_b,
    status: row.status,
    formedDay: row.formed_day,
    endedDay: row.ended_day,
    endReason: row.end_reason,
    leader: row.leader,
    leadChanges: row.lead_changes,
    lastDay: row.last_day,
    series: fromJson<Rivalry['series']>(row.series),
  };
}

function toRivalryView(row: RivalrySql & Record<string, unknown>): StoredRivalryView {
  return { rivalry: toRivalry(row), agentA: toAgentRecord(row, 'xa_'), agentB: toAgentRecord(row, 'xb_') };
}

interface RivalryEventSql {
  season_id: string;
  agent_a: string;
  agent_b: string;
  day: string;
  seq: number;
  kind: RivalryEvent['kind'];
  subject: string | null;
  rank_a: number | null;
  rank_b: number | null;
  detail: string;
}

function toRivalryEvent(row: RivalryEventSql): RivalryEvent {
  return {
    seasonId: row.season_id,
    agentA: row.agent_a,
    agentB: row.agent_b,
    day: row.day,
    seq: row.seq,
    kind: row.kind,
    subject: row.subject,
    rankA: row.rank_a,
    rankB: row.rank_b,
    detail: fromJson<RivalryEvent['detail']>(row.detail),
  };
}

// --- Model Wars ------------------------------------------------------------------------------------------

/**
 * First statement of createWar: the war with the next number (index wars_number, one seek at its end),
 * unless index wars_open holds a war. The number is written into the body too. A returned row means it was
 * created. ?1 id, ?2 status, ?3 starts on, ?4 body without number, ?5 created at.
 */
const CREATE_WAR = `
INSERT INTO wars (id, number, status, starts_on, body, created_at, updated_at)
SELECT ?1, n.next, ?2, ?3, json_set(?4, '$.number', n.next), ?5, ?5
FROM (SELECT coalesce((SELECT max(number) FROM wars), 0) + 1 AS next) AS n
WHERE NOT EXISTS (SELECT 1 FROM wars INDEXED BY wars_open WHERE status IN ('scheduled', 'running'))
RETURNING number`;

/** Later statements of createWar: an entrant, only if the war row of this batch exists. */
const CREATE_WAR_ENTRANT = `
INSERT INTO war_entrants (war_id, slot, model_id, body, portfolio, stats, last_tick_id, days, rejected_days, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
WHERE EXISTS (SELECT 1 FROM wars WHERE id = ?1)`;

/** Index wars_open: at most ACTIVE_WARS_MAX rows. */
const GET_OPEN_WAR = `
SELECT body FROM wars INDEXED BY wars_open
WHERE status IN ('scheduled', 'running')
ORDER BY created_at, id
LIMIT 1`;

const GET_WAR = 'SELECT body FROM wars WHERE id = ?1';

/** Index wars_number read backwards. ?1 limit, ?2 offset. */
const LIST_WARS = `
SELECT body FROM wars INDEXED BY wars_number
ORDER BY number DESC
LIMIT ?1 OFFSET ?2`;

/** war_entrants primary key: slot order. */
const LIST_WAR_ENTRANTS = `
SELECT body, portfolio, stats, last_tick_id, days, rejected_days FROM war_entrants
WHERE war_id = ?1 ORDER BY slot`;

/** war_rows primary key: tick and slot order. ?2 the most rows a war can have. */
const LIST_WAR_ROWS = 'SELECT body FROM war_rows WHERE war_id = ?1 ORDER BY tick_id, slot LIMIT ?2';

/** The ticks primary key over one UTC day. ?1 day. */
const GET_DAILY_TICK_OF = `
SELECT id, status FROM ticks
WHERE id > ?1 || 'T' AND id < ?1 || 'U' AND daily = 1
ORDER BY id DESC
LIMIT 1`;

const GET_WAR_NEURONS = 'SELECT neurons FROM war_usage WHERE day = ?1';

/**
 * One statement decides and writes: adds ?2 to the day ?1 only while the total stays at or under ?3.
 * A first reservation larger than the maximum inserts nothing. A returned row means it was reserved.
 */
const RESERVE_WAR_NEURONS = `
INSERT INTO war_usage (day, neurons) SELECT ?1, ?2 WHERE ?2 <= ?3
ON CONFLICT (day) DO UPDATE SET neurons = neurons + excluded.neurons
WHERE neurons + excluded.neurons <= ?3
RETURNING neurons`;

/** Adds ?2, negative to give back, never below zero. */
const ADJUST_WAR_NEURONS = `
INSERT INTO war_usage (day, neurons) VALUES (?1, max(?2, 0))
ON CONFLICT (day) DO UPDATE SET neurons = max(neurons + ?2, 0)`;

/** Insert only, and no ON CONFLICT: a second row of a war, tick and slot fails and rolls the batch back. */
const INSERT_WAR_ROW = `
INSERT INTO war_rows (war_id, tick_id, slot, status, code, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

/** ?1 war id, ?2 slot, ?3 portfolio, ?4 stats, ?5 last tick, ?6 days, ?7 rejected days, ?8 now. */
const UPDATE_WAR_ENTRANT = `
UPDATE war_entrants SET portfolio = ?3, stats = ?4, last_tick_id = ?5, days = ?6, rejected_days = ?7, updated_at = ?8
WHERE war_id = ?1 AND slot = ?2`;

/** The fields of a WarPatch, in a fixed order, so the same patch gives the same SQL. */
const WAR_PATCH_FIELDS = [
  'status',
  'stopReason',
  'systemMessageSha256',
  'promptVersion',
  'firstTickId',
  'lastTickId',
  'endedAt',
] as const;

const warPatchSchema = warRecordSchema
  .pick({
    status: true,
    stopReason: true,
    systemMessageSha256: true,
    promptVersion: true,
    firstTickId: true,
    lastTickId: true,
    endedAt: true,
  })
  .partial();

/**
 * The UPDATE of a war: the patch's fields are set inside the body with json_set and the status column
 * follows the body. ?1 war id, ?2 now, the patch values from ?3 in WAR_PATCH_FIELDS order.
 */
function updateWarStatement(patch: WarPatch): { statement: string; values: Bound[] } {
  const fields = WAR_PATCH_FIELDS.filter((field) => patch[field] !== undefined);
  const values: Bound[] = fields.map((field) => patch[field] ?? null);
  const paths = fields.map((field, index) => `'$.${field}', ?${index + 3}`);
  const sets = ['updated_at = ?2'];
  if (paths.length > 0) sets.push(`body = json_set(body, ${paths.join(', ')})`);
  const status = fields.indexOf('status');
  if (status >= 0) sets.push(`status = ?${status + 3}`);
  return { statement: `UPDATE wars SET ${sets.join(', ')} WHERE id = ?1`, values };
}

/** The part of an entrant that never changes, stored as its body. */
function entrantBody(entrant: WarEntrant): string {
  const { portfolio: _p, stats: _s, lastTickId: _l, days: _d, rejectedDays: _r, ...frozen } = entrant;
  return JSON.stringify(frozen);
}

interface WarEntrantSql {
  body: string;
  portfolio: string;
  stats: string;
  last_tick_id: string | null;
  days: number;
  rejected_days: number;
}

function toWarEntrant(row: WarEntrantSql): WarEntrant {
  return {
    ...fromJson<Omit<WarEntrant, 'portfolio' | 'stats' | 'lastTickId' | 'days' | 'rejectedDays'>>(row.body),
    portfolio: fromJson<PortfolioState>(row.portfolio),
    stats: fromJson<AgentStats>(row.stats),
    lastTickId: row.last_tick_id,
    days: row.days,
    rejectedDays: row.rejected_days,
  };
}

// --- paper managers ------------------------------------------------------------------------------------------

const MANAGER_COLUMNS = [
  'id',
  'owner',
  'name',
  'name_key',
  'status',
  'hidden',
  'policy_version',
  'created_at',
  'created_day',
  'updated_at',
] as const;
const MANAGER_SELECT = MANAGER_COLUMNS.join(', ');
const MANAGER_SELECT_M = MANAGER_COLUMNS.map((c) => `m.${c}`).join(', ');
const POLICY_SELECT_POL =
  'pol.manager_id AS pol_manager_id, pol.version AS pol_version, pol.targets AS pol_targets, pol.schedule AS pol_schedule, pol.set_at AS pol_set_at, pol.set_day AS pol_set_day';
const BOOK_SELECT_B =
  'b.book AS b_book, b.stats AS b_stats, b.last_day AS b_last_day, b.vol_milli_bps AS b_vol_milli_bps';

/**
 * Why createManager refuses, decided in the same batch as the insert, which repeats the conditions.
 * ?1 owner, ?2 name key, ?3 the most active or paused managers the owner may have, ?4 the most managers.
 */
function managerRefusals(): { ownerLimit: string; nameTaken: string; full: string } {
  return {
    // Index managers_owner, over that wallet's few managers.
    ownerLimit: `(SELECT count(*) FROM managers INDEXED BY managers_owner WHERE owner = ?1 AND status IN ('active', 'paused')) >= ?3`,
    // Indexes managers_name_key, agents_name_key and listings_name_key.
    nameTaken: `(EXISTS (SELECT 1 FROM managers WHERE name_key = ?2)
      OR EXISTS (SELECT 1 FROM agents WHERE name_key = ?2)
      OR EXISTS (SELECT 1 FROM listings WHERE name_key = ?2))`,
    // At most MAX_MANAGERS_TOTAL open managers: active or paused and not hidden (security review 6,
    // finding 2). A closed or hidden manager frees its place. Index managers_public (the visible ones).
    full: `(SELECT count(*) FROM managers INDEXED BY managers_public
      WHERE hidden = 0 AND status IN ('active', 'paused')) >= ?4`,
  };
}

const REFUSALS = managerRefusals();

const CREATE_MANAGER_CHECK = `
SELECT (${REFUSALS.ownerLimit}) AS owner_limit, ${REFUSALS.nameTaken} AS name_taken, (${REFUSALS.full}) AS is_full`;

/** ?1 owner, ?2 name key, ?3, ?4 as above, then the manager's columns from ?5 in MANAGER_COLUMNS order. */
const CREATE_MANAGER = `
INSERT INTO managers (${MANAGER_SELECT})
SELECT ${MANAGER_COLUMNS.map((_, index) => `?${index + 5}`).join(', ')}
WHERE NOT (${REFUSALS.ownerLimit}) AND NOT ${REFUSALS.nameTaken} AND NOT (${REFUSALS.full})
RETURNING id`;

/** The first policy, only if the manager row of this batch exists at version 1 or later. */
const CREATE_MANAGER_POLICY = `
INSERT INTO manager_policies (manager_id, version, targets, schedule, set_at, set_day)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
WHERE EXISTS (SELECT 1 FROM managers WHERE id = ?1 AND policy_version = ?2)`;

const GET_MANAGER = `SELECT ${MANAGER_SELECT} FROM managers WHERE id = ?1`;

/** Index managers_owner. */
const LIST_MANAGERS_BY_OWNER = `
SELECT ${MANAGER_SELECT} FROM managers INDEXED BY managers_owner
WHERE owner = ?1 ORDER BY created_at, id LIMIT 100`;

/** manager_policies primary key, read from its end. */
const GET_LATEST_POLICY = `
SELECT manager_id AS pol_manager_id, version AS pol_version, targets AS pol_targets, schedule AS pol_schedule,
  set_at AS pol_set_at, set_day AS pol_set_day
FROM manager_policies WHERE manager_id = ?1 ORDER BY version DESC LIMIT 1`;

/** First statement of putPolicy: the policy, only as the manager's next version. ?1 to ?6 the policy's columns. */
const PUT_POLICY = `
INSERT INTO manager_policies (manager_id, version, targets, schedule, set_at, set_day)
SELECT ?1, ?2, ?3, ?4, ?5, ?6
WHERE EXISTS (SELECT 1 FROM managers WHERE id = ?1 AND policy_version = ?2 - 1)
ON CONFLICT (manager_id, version) DO NOTHING
RETURNING version`;

/** Second statement of putPolicy: moves the version only if the policy row of that version is there. */
const MOVE_POLICY_VERSION = `
UPDATE managers SET policy_version = ?2, updated_at = ?3
WHERE id = ?1 AND policy_version = ?2 - 1
  AND EXISTS (SELECT 1 FROM manager_policies WHERE manager_id = ?1 AND version = ?2)`;

/** A closed manager never changes. ?1 id, ?2 owner or null for an admin, ?3 status, ?4 now. */
const SET_MANAGER_STATUS = `
UPDATE managers SET status = ?3, updated_at = ?4
WHERE id = ?1 AND status <> 'closed' AND (?2 IS NULL OR owner = ?2)
RETURNING id`;

const SET_MANAGER_HIDDEN = 'UPDATE managers SET hidden = ?2, updated_at = ?3 WHERE id = ?1 RETURNING id';

/**
 * Index managers_valued: active, visible managers in id order, with the policy in force on ?2 (the latest
 * version set before ?2, manager_policies primary key) and the book of season ?1 (manager_books primary key).
 * A manager without a policy in force yet is not returned. ?3 after id, ?4 limit.
 */
const LIST_MANAGERS_TO_VALUE = `
SELECT ${MANAGER_SELECT_M}, ${POLICY_SELECT_POL}, ${BOOK_SELECT_B}
FROM managers AS m INDEXED BY managers_valued
CROSS JOIN manager_policies AS pol ON pol.manager_id = m.id AND pol.version = (
  SELECT max(v.version) FROM manager_policies AS v WHERE v.manager_id = m.id AND v.set_day < ?2
)
LEFT JOIN manager_books AS b ON b.manager_id = m.id AND b.season_id = ?1
WHERE m.id > ?3 AND m.status = 'active' AND m.hidden = 0
ORDER BY m.id
LIMIT ?4`;

/**
 * Each agent's stats.daily point of day ?2 in season ?1, computed in SQL: the portfolio by primary key and
 * json_each over its at most 56 daily points. Null for an unknown or hidden agent or a day without a point.
 * ?3 JSON array of agent ids.
 */
const AGENT_VALUES_ON = `
SELECT ids.value AS agent_id, (
  SELECT json_extract(d.value, '$.equityMicro')
  FROM portfolios AS p CROSS JOIN json_each(p.stats, '$.daily') AS d
  WHERE p.agent_id = ids.value AND p.season_id = ?1 AND json_extract(d.value, '$.day') = ?2
    AND EXISTS (SELECT 1 FROM agents AS a WHERE a.id = p.agent_id AND a.hidden = 0)
  LIMIT 1
) AS value
FROM json_each(?3) AS ids`;

/*
 * The books and rebalances of one chunk, in three statements whatever the chunk's size (?3 below is a JSON
 * array with one object per manager: id, prev (the last day as read, or null), book and stats as JSON
 * text, the stats' figures, vol, and reason and rebalance (JSON text) when the manager traded). Every
 * guard is a condition of its statement, so a second run of the day writes nothing.
 */

/** A first valued day of the season: inserted, or nothing if a book is already there. ?1 season, ?2 day, ?3 rows, ?4 now. */
const INSERT_MANAGER_BOOKS = `
INSERT INTO manager_books (manager_id, season_id, book, stats, last_day, valued_days, return_bps, max_drawdown_bps,
  vol_milli_bps, updated_at)
SELECT json_extract(w.value, '$.id'), ?1, json_extract(w.value, '$.book'), json_extract(w.value, '$.stats'), ?2,
  json_extract(w.value, '$.valuedDays'), json_extract(w.value, '$.returnBps'), json_extract(w.value, '$.maxDrawdownBps'),
  json_extract(w.value, '$.vol'), ?4
FROM json_each(?3) AS w
WHERE json_extract(w.value, '$.prev') IS NULL
ON CONFLICT (manager_id, season_id) DO NOTHING`;

/**
 * A later valued day: compare and set on last_day, by the manager_books primary key per row.
 * ?1 season, ?2 day, ?3 rows, ?4 now.
 */
const UPDATE_MANAGER_BOOKS = `
UPDATE manager_books SET book = json_extract(w.value, '$.book'), stats = json_extract(w.value, '$.stats'),
  last_day = ?2, valued_days = json_extract(w.value, '$.valuedDays'), return_bps = json_extract(w.value, '$.returnBps'),
  max_drawdown_bps = json_extract(w.value, '$.maxDrawdownBps'), vol_milli_bps = json_extract(w.value, '$.vol'),
  updated_at = ?4
FROM json_each(?3) AS w
WHERE manager_books.manager_id = json_extract(w.value, '$.id') AND manager_books.season_id = ?1
  AND json_extract(w.value, '$.prev') IS NOT NULL AND manager_books.last_day = json_extract(w.value, '$.prev')`;

/**
 * The rebalances of the day, each only once its book stands at that day (manager_books primary key); at most
 * one per manager, season and day (manager_rebalances primary key). ?1 season, ?2 day, ?3 rows.
 */
const INSERT_MANAGER_REBALANCES = `
INSERT INTO manager_rebalances (manager_id, season_id, day, reason, body)
SELECT json_extract(w.value, '$.id'), ?1, ?2, json_extract(w.value, '$.reason'), json_extract(w.value, '$.rebalance')
FROM json_each(?3) AS w
WHERE json_extract(w.value, '$.reason') IS NOT NULL
  AND EXISTS (SELECT 1 FROM manager_books AS b
    WHERE b.manager_id = json_extract(w.value, '$.id') AND b.season_id = ?1 AND b.last_day = ?2)
ON CONFLICT (manager_id, season_id, day) DO NOTHING`;

/**
 * Index managers_public read backwards: visible managers, newest first, with their current policy and
 * their book of season ?1, both by primary key. ?2 limit, ?3 offset.
 */
const LIST_MANAGERS = `
SELECT ${MANAGER_SELECT_M}, ${POLICY_SELECT_POL}, ${BOOK_SELECT_B}
FROM managers AS m INDEXED BY managers_public
CROSS JOIN manager_policies AS pol ON pol.manager_id = m.id AND pol.version = m.policy_version
LEFT JOIN manager_books AS b ON b.manager_id = m.id AND b.season_id = ?1
WHERE m.hidden = 0
ORDER BY m.created_at DESC, m.id DESC
LIMIT ?2 OFFSET ?3`;

const GET_MANAGER_BOOK = `
SELECT ${BOOK_SELECT_B} FROM manager_books AS b WHERE b.manager_id = ?1 AND b.season_id = ?2`;

/** manager_rebalances primary key read backwards. */
const LIST_MANAGER_REBALANCES = `
SELECT body FROM manager_rebalances WHERE manager_id = ?1 AND season_id = ?2 ORDER BY day DESC LIMIT ?3`;

interface ManagerSql {
  id: string;
  owner: string;
  name: string;
  name_key: string;
  status: ManagerRecord['status'];
  hidden: number;
  policy_version: number;
  created_at: string;
  created_day: string;
  updated_at: string;
}

function toManager(row: ManagerSql): ManagerRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    nameKey: row.name_key,
    status: row.status,
    hidden: row.hidden === 1,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    createdDay: row.created_day,
    updatedAt: row.updated_at,
  };
}

interface PolicySql {
  pol_manager_id: string;
  pol_version: number;
  pol_targets: string;
  pol_schedule: ManagerPolicy['schedule'];
  pol_set_at: string;
  pol_set_day: string;
}

function toPolicy(row: PolicySql): ManagerPolicy {
  return {
    managerId: row.pol_manager_id,
    version: row.pol_version,
    targetsBps: fromJson<ManagerPolicy['targetsBps']>(row.pol_targets),
    schedule: row.pol_schedule,
    setAt: row.pol_set_at,
    setDay: row.pol_set_day,
  };
}

interface BookSql {
  b_book: string | null;
  b_stats: string | null;
  b_last_day: string | null;
  b_vol_milli_bps: number | null;
}

function toBookRow(row: BookSql): ManagerBookRow | null {
  if (row.b_book === null || row.b_stats === null) return null;
  return {
    book: fromJson<ManagerBook>(row.b_book),
    stats: fromJson<AgentStats>(row.b_stats),
    lastDay: row.b_last_day,
    volMilliBps: row.b_vol_milli_bps ?? 0,
  };
}

function toListRow(row: ManagerSql & PolicySql & BookSql): ManagerListRow {
  return { manager: toManager(row), policy: toPolicy(row), book: toBookRow(row) };
}

/** One manager of a chunk, as the JSON the three statements of applyManagerDays read with json_each. */
interface ManagerDayRow {
  id: string;
  prev: string | null;
  /** JSON text, stored as it is. */
  book: string;
  /** JSON text, stored as it is. */
  stats: string;
  valuedDays: number;
  returnBps: number;
  maxDrawdownBps: number;
  vol: number;
  reason: string | null;
  /** JSON text of the rebalance, or null when the manager did not trade. */
  rebalance: string | null;
}

// --- the store -----------------------------------------------------------------------------------------------

/** The most ids listAgentRecords and agentValuesOn take in one call. */
const MAX_IDS = 100;
/** The most rows a war can have: WAR_TRADING_DAYS_MAX x WAR_ENTRANTS_MAX. */
const MAX_WAR_ROWS = 80;

export function createSocialStore(db: D1Database): SocialStore {
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

  function ids(list: readonly string[], name: string): string {
    if (list.length > MAX_IDS) throw new Error(`social store: ${name} takes at most ${MAX_IDS} ids`);
    return JSON.stringify(list);
  }

  function cursorStatement(cursor: { name: string; body: string }, now: string): D1PreparedStatement {
    if (!cursor.name.startsWith('social:')) throw new Error('social store: a cursor name starts with social:');
    return prepare(PUT_CURSOR, cursor.name, cursor.body, now);
  }

  function lineageMember(row: Record<string, unknown>): LineageMember {
    return {
      agent: toAgentRecord(row, ''),
      depth: row.depth as number,
      parentId: (row.parent_id as string | null) ?? null,
    };
  }

  const store: SocialStore = {
    // --- shared --------------------------------------------------------------------------------------------

    async listFinalDays(afterDay, limit) {
      const rows = await all<{ day: string; tick_id: string; season_id: string }>(
        LIST_FINAL_DAYS,
        afterDay ?? '',
        wholeNumber(limit, 'limit'),
      );
      return rows.map((row): FinalDay => ({ day: row.day, tickId: row.tick_id, seasonId: row.season_id }));
    },

    async putCursor(cursor, now) {
      await cursorStatement(cursor, now).run();
    },

    async listAgentRecords(agentIds) {
      if (agentIds.length === 0) return [];
      const rows = await all<Record<string, unknown>>(LIST_AGENT_RECORDS, ids(agentIds, 'listAgentRecords'));
      return rows.map((row) => toAgentRecord(row, ''));
    },

    // --- Strategy DNA ---------------------------------------------------------------------------------------

    async listDnaAgents(afterId, limit) {
      const rows = await all<{ id: string; strategy_changed_at: string }>(
        LIST_DNA_AGENTS,
        afterId ?? '',
        wholeNumber(limit, 'limit'),
      );
      return rows.map((row) => ({ id: row.id, strategyChangedAt: row.strategy_changed_at }));
    },

    async listEndOfDay(agentIds, throughDay, limit) {
      const observations = new Map<string, DnaObservation[]>();
      if (agentIds.length === 0) return observations;
      const before = nextDay(throughDay);
      const n = wholeNumber(limit, 'limit');
      const results = await db.batch(agentIds.map((id) => prepare(LIST_END_OF_DAY, id, before, n)));
      agentIds.forEach((id, index) => {
        const rows = rowsOf<{ tick_id: string; season_id: string; portfolio: string; equity_micro: number }>(
          results,
          index,
        );
        observations.set(
          id,
          rows
            .map(
              (row): DnaObservation => ({
                day: utcDayOfTick(row.tick_id),
                tickId: row.tick_id,
                seasonId: row.season_id,
                portfolio: fromJson<PortfolioState>(row.portfolio),
                equityMicro: row.equity_micro,
              }),
            )
            .sort((a, b) => (a.tickId < b.tickId ? -1 : 1)),
        );
      });
      return observations;
    },

    async putDnaProfiles(profiles, cursor, now) {
      const statements = profiles.map((profile) => {
        const checked = dnaProfileSchema.parse(profile);
        return prepare(
          PUT_DNA,
          checked.agentId,
          checked.method,
          checked.asOfDay,
          JSON.stringify(checked),
          checked.computedAt,
        );
      });
      await db.batch([...statements, cursorStatement(cursor, now)]);
    },

    async getDna(agentId) {
      const row = await first<{ body: string }>(GET_DNA, agentId);
      return row === null ? null : dnaProfileSchema.parse(fromJson<unknown>(row.body));
    },

    // --- forks ----------------------------------------------------------------------------------------------

    async putLineage(row) {
      const stored = await all<{ agent_id: string }>(
        PUT_LINEAGE,
        row.agentId,
        row.parentId,
        row.rootId,
        wholeNumber(row.depth, 'depth'),
        row.createdAt,
      );
      return stored.length === 1 ? 'stored' : 'exists';
    },

    async getLineage(agentId) {
      const row = await first<{
        agent_id: string;
        parent_id: string;
        root_id: string;
        depth: number;
        created_at: string;
      }>(GET_LINEAGE, agentId);
      if (row === null) return null;
      const lineage: LineageRow = {
        agentId: row.agent_id,
        parentId: row.parent_id,
        rootId: row.root_id,
        depth: row.depth,
        createdAt: row.created_at,
      };
      return lineage;
    },

    async countChildren(parentId) {
      return (await first<{ n: number }>(COUNT_CHILDREN, parentId))?.n ?? 0;
    },

    async listChildren(parentId, limit, offset) {
      const rows = await all<Record<string, unknown>>(
        LIST_CHILDREN,
        parentId,
        wholeNumber(limit, 'limit'),
        wholeNumber(offset, 'offset'),
      );
      return rows.map(lineageMember);
    },

    async countFamily(rootId) {
      return (await first<{ n: number }>(COUNT_FAMILY, rootId))?.n ?? 0;
    },

    async listFamily(rootId, limit, offset) {
      const rows = await all<Record<string, unknown>>(
        LIST_FAMILY,
        rootId,
        wholeNumber(limit, 'limit'),
        wholeNumber(offset, 'offset'),
      );
      return rows.map(lineageMember);
    },

    // --- rank tape and rivalries ----------------------------------------------------------------------------

    async writeTape(seasonId, day, method, cursor, now) {
      await db.batch([
        prepare(WRITE_TAPE_DAY, seasonId, 'open', day, method, now),
        prepare(WRITE_TAPE_DAY, seasonId, 'pro', day, method, now),
        cursorStatement(cursor, now),
      ]);
    },

    async listTape(seasonId, division, throughDay, limit) {
      const rows = await all<{
        season_id: string;
        division: RankTapeDay['division'];
        day: string;
        method: RankTapeDay['method'];
        ranks: string;
      }>(LIST_TAPE, seasonId, division, throughDay, wholeNumber(limit, 'limit'));
      return rows.reverse().map(
        (row): RankTapeDay => ({
          seasonId: row.season_id,
          division: row.division,
          day: row.day,
          method: row.method,
          // The tape is written in rank order; the sort keeps that true whatever order SQL aggregated in.
          ranks: fromJson<[string, number][]>(row.ranks).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)),
        }),
      );
    },

    async countTapeDays(seasonId, division) {
      return (await first<{ n: number }>(COUNT_TAPE_DAYS, seasonId, division))?.n ?? 0;
    },

    async listActiveRivalries(division, limit) {
      const rows = await all<RivalrySql>(LIST_ACTIVE_RIVALRIES, division, wholeNumber(limit, 'limit'));
      return rows.map(toRivalry);
    },

    async applyRivalryDay(result, cursor, now) {
      // One statement for every upsert and one for every event, whatever their number: a day on which many
      // rivalries form stays inside the statement limit of a job.
      const upserts = result.upserts.map((upsert) => {
        const r = rivalrySchema.parse(upsert);
        if (!(r.agentA < r.agentB)) throw new Error('social store: a rivalry names the lower agent id first');
        return { ...r, series: JSON.stringify(r.series) };
      });
      const events = result.events.map((event) => {
        const e = rivalryEventSchema.parse(event);
        return { ...e, detail: JSON.stringify(e.detail) };
      });
      const statements: D1PreparedStatement[] = [];
      if (upserts.length > 0) statements.push(prepare(UPSERT_RIVALRIES, JSON.stringify(upserts), now));
      if (events.length > 0) statements.push(prepare(INSERT_RIVALRY_EVENTS, JSON.stringify(events)));
      statements.push(cursorStatement(cursor, now));
      await db.batch(statements);
    },

    async listRivalries(seasonId, division, limit, offset) {
      const rows = await all<RivalrySql & Record<string, unknown>>(
        LIST_RIVALRIES,
        seasonId,
        division,
        wholeNumber(limit, 'limit'),
        wholeNumber(offset, 'offset'),
      );
      return rows.map(toRivalryView);
    },

    async listAgentRivalries(agentId, seasonId) {
      const rows = await all<RivalrySql & Record<string, unknown>>(LIST_AGENT_RIVALRIES, agentId, seasonId);
      return rows
        .map(toRivalryView)
        .sort(
          (x, y) =>
            (x.rivalry.formedDay < y.rivalry.formedDay ? -1 : x.rivalry.formedDay > y.rivalry.formedDay ? 1 : 0) ||
            (x.rivalry.agentA < y.rivalry.agentA ? -1 : x.rivalry.agentA > y.rivalry.agentA ? 1 : 0) ||
            (x.rivalry.agentB < y.rivalry.agentB ? -1 : 1),
        );
    },

    async getRivalry(seasonId, agentA, agentB, eventLimit) {
      const [lo, hi] = agentA < agentB ? [agentA, agentB] : [agentB, agentA];
      const results = await db.batch([
        prepare(GET_RIVALRY, seasonId, lo, hi),
        prepare(LIST_RIVALRY_EVENTS, seasonId, lo, hi, wholeNumber(eventLimit, 'eventLimit')),
      ]);
      const row = rowsOf<RivalrySql & Record<string, unknown>>(results, 0)[0];
      if (row === undefined) return null;
      return { view: toRivalryView(row), events: rowsOf<RivalryEventSql>(results, 1).map(toRivalryEvent) };
    },

    // --- Model Wars -----------------------------------------------------------------------------------------

    async createWar(war, entrants) {
      const checked = warRecordSchema.omit({ number: true }).parse(war);
      const statements = [
        prepare(CREATE_WAR, checked.id, checked.status, checked.startsOn, JSON.stringify(checked), checked.createdAt),
      ];
      for (const entrant of entrants) {
        const e = warEntrantSchema.parse(entrant);
        if (e.warId !== checked.id) throw new Error('social store: an entrant belongs to another war');
        statements.push(
          prepare(
            CREATE_WAR_ENTRANT,
            e.warId,
            e.slot,
            e.modelId,
            entrantBody(e),
            JSON.stringify(e.portfolio),
            JSON.stringify(e.stats),
            e.lastTickId,
            e.days,
            e.rejectedDays,
            checked.createdAt,
          ),
        );
      }
      const results = await db.batch(statements);
      const created = rowsOf<{ number: number }>(results, 0)[0];
      return created === undefined ? { result: 'war_open' } : { result: 'created', number: created.number };
    },

    async getOpenWar() {
      const row = await first<{ body: string }>(GET_OPEN_WAR);
      return row === null ? null : fromJson<WarRecord>(row.body);
    },

    async getWar(id) {
      const row = await first<{ body: string }>(GET_WAR, id);
      return row === null ? null : fromJson<WarRecord>(row.body);
    },

    async listWars(limit, offset) {
      const rows = await all<{ body: string }>(LIST_WARS, wholeNumber(limit, 'limit'), wholeNumber(offset, 'offset'));
      return rows.map((row) => fromJson<WarRecord>(row.body));
    },

    async listWarEntrants(warId) {
      const rows = await all<WarEntrantSql>(LIST_WAR_ENTRANTS, warId);
      return rows.map(toWarEntrant);
    },

    async listWarRows(warId) {
      const rows = await all<{ body: string }>(LIST_WAR_ROWS, warId, MAX_WAR_ROWS);
      return rows.map((row) => fromJson<WarRow>(row.body));
    },

    async getDailyTickOf(day) {
      const row = await first<{ id: string; status: 'processing' | 'complete' }>(GET_DAILY_TICK_OF, day);
      return row === null ? null : { id: row.id, status: row.status };
    },

    async getWarNeurons(day) {
      return (await first<{ neurons: number }>(GET_WAR_NEURONS, day))?.neurons ?? 0;
    },

    async reserveWarNeurons(day, neurons, max) {
      const reserved = await first<{ neurons: number }>(
        RESERVE_WAR_NEURONS,
        day,
        neuronsOf(neurons, 'neurons'),
        neuronsOf(max, 'max'),
      );
      return reserved !== null;
    },

    async adjustWarNeurons(day, delta) {
      if (!Number.isFinite(delta)) throw new Error('social store: delta must be a finite number');
      await prepare(ADJUST_WAR_NEURONS, day, delta).run();
    },

    async writeWarDay(warId, rows, entrants, patch, now) {
      const statements: D1PreparedStatement[] = [];
      for (const row of rows) {
        const r = warRowSchema.parse(row);
        if (r.warId !== warId) throw new Error('social store: a war row belongs to another war');
        statements.push(
          prepare(INSERT_WAR_ROW, r.warId, r.tickId, r.slot, r.status, r.code, JSON.stringify(r), r.createdAt),
        );
      }
      for (const entrant of entrants) {
        const e = warEntrantSchema.parse(entrant);
        if (e.warId !== warId) throw new Error('social store: an entrant belongs to another war');
        statements.push(
          prepare(
            UPDATE_WAR_ENTRANT,
            e.warId,
            e.slot,
            JSON.stringify(e.portfolio),
            JSON.stringify(e.stats),
            e.lastTickId,
            e.days,
            e.rejectedDays,
            now,
          ),
        );
      }
      const update = updateWarStatement(warPatchSchema.parse(patch));
      statements.push(prepare(update.statement, warId, now, ...update.values));
      try {
        await db.batch(statements);
        return true;
      } catch (error) {
        // The key of war_rows refused a row: the batch rolled back as a whole, nothing was written.
        if (isWarRowConflict(error)) return false;
        throw error;
      }
    },

    async updateWar(id, patch, now) {
      const update = updateWarStatement(warPatchSchema.parse(patch));
      await prepare(update.statement, id, now, ...update.values).run();
    },

    // --- paper managers -------------------------------------------------------------------------------------

    async createManager(manager, policy, limits) {
      const m = managerRecordSchema.parse(manager);
      const p = managerPolicySchema.parse(policy);
      if (p.managerId !== m.id) throw new Error('social store: the policy belongs to another manager');
      const maxForOwner = wholeNumber(limits.maxForOwner, 'maxForOwner');
      const maxTotal = wholeNumber(limits.maxTotal, 'maxTotal');
      const guard: Bound[] = [m.owner, m.nameKey, maxForOwner, maxTotal];
      const results = await db.batch([
        prepare(CREATE_MANAGER_CHECK, ...guard),
        prepare(
          CREATE_MANAGER,
          ...guard,
          m.id,
          m.owner,
          m.name,
          m.nameKey,
          m.status,
          flag(m.hidden),
          m.policyVersion,
          m.createdAt,
          m.createdDay,
          m.updatedAt,
        ),
        prepare(
          CREATE_MANAGER_POLICY,
          p.managerId,
          p.version,
          JSON.stringify(p.targetsBps),
          p.schedule,
          p.setAt,
          p.setDay,
        ),
      ]);
      const refused = rowsOf<{ owner_limit: number; name_taken: number; is_full: number }>(results, 0)[0];
      if (refused?.owner_limit === 1) return 'owner_limit';
      if (refused?.name_taken === 1) return 'name_taken';
      if (refused?.is_full === 1) return 'full';
      if (rowsOf<{ id: string }>(results, 1).length === 1) return 'created';
      // Every limit passed and still nothing was inserted: the id is in use. Ids are random, so this is a bug.
      throw new Error('social store: createManager found its manager id in use');
    },

    async getManager(id) {
      const row = await first<ManagerSql>(GET_MANAGER, id);
      return row === null ? null : toManager(row);
    },

    async listManagersByOwner(owner) {
      const rows = await all<ManagerSql>(LIST_MANAGERS_BY_OWNER, owner);
      return rows.map(toManager);
    },

    async getLatestPolicy(managerId) {
      const row = await first<PolicySql>(GET_LATEST_POLICY, managerId);
      return row === null ? null : toPolicy(row);
    },

    async putPolicy(policy, now) {
      const p = managerPolicySchema.parse(policy);
      const results = await db.batch([
        prepare(PUT_POLICY, p.managerId, p.version, JSON.stringify(p.targetsBps), p.schedule, p.setAt, p.setDay),
        prepare(MOVE_POLICY_VERSION, p.managerId, p.version, now),
      ]);
      return rowsOf<{ version: number }>(results, 0).length === 1 ? 'stored' : 'changed';
    },

    async setManagerStatus(id, owner, status, now) {
      const changed = await all<{ id: string }>(SET_MANAGER_STATUS, id, owner, status, now);
      return changed.length === 1;
    },

    async setManagerHidden(id, hidden, now) {
      const changed = await all<{ id: string }>(SET_MANAGER_HIDDEN, id, flag(hidden), now);
      return changed.length === 1;
    },

    async listManagersToValue(seasonId, day, afterId, limit) {
      const rows = await all<ManagerSql & PolicySql & BookSql>(
        LIST_MANAGERS_TO_VALUE,
        seasonId,
        day,
        afterId ?? '',
        wholeNumber(limit, 'limit'),
      );
      return rows.map((row): ManagerWork => {
        const book = toBookRow(row);
        return {
          manager: toManager(row),
          policy: toPolicy(row),
          book: book?.book ?? null,
          stats: book?.stats ?? null,
          lastDay: book?.lastDay ?? null,
        };
      });
    },

    async agentValuesOn(seasonId, day, agentIds) {
      const values: Record<string, number | null> = {};
      if (agentIds.length === 0) return values;
      const rows = await all<{ agent_id: string; value: number | null }>(
        AGENT_VALUES_ON,
        seasonId,
        day,
        ids(agentIds, 'agentValuesOn'),
      );
      for (const id of agentIds) values[id] = null;
      for (const row of rows) values[row.agent_id] = row.value ?? null;
      return values;
    },

    async applyManagerDays(seasonId, day, writes, cursor, now) {
      // Three statements for the whole chunk, whatever its size, then the cursor.
      const rows = writes.map((write) => managerDayRow(day, write));
      const statements: D1PreparedStatement[] = [];
      if (rows.length > 0) {
        const json = JSON.stringify(rows);
        statements.push(
          prepare(UPDATE_MANAGER_BOOKS, seasonId, day, json, now),
          prepare(INSERT_MANAGER_BOOKS, seasonId, day, json, now),
          prepare(INSERT_MANAGER_REBALANCES, seasonId, day, json),
        );
      }
      statements.push(cursorStatement(cursor, now));
      await db.batch(statements);
    },

    async listManagers(seasonId, limit, offset) {
      const rows = await all<ManagerSql & PolicySql & BookSql>(
        LIST_MANAGERS,
        seasonId,
        wholeNumber(limit, 'limit'),
        wholeNumber(offset, 'offset'),
      );
      return rows.map(toListRow);
    },

    async getManagerBook(managerId, seasonId) {
      const row = await first<BookSql>(GET_MANAGER_BOOK, managerId, seasonId);
      return row === null ? null : toBookRow(row);
    },

    async listManagerRebalances(managerId, seasonId, limit) {
      const rows = await all<{ body: string }>(
        LIST_MANAGER_REBALANCES,
        managerId,
        seasonId,
        wholeNumber(limit, 'limit'),
      );
      return rows.map((row) => fromJson<ManagerRebalance>(row.body));
    },
  };

  /** One manager's valued day as a row of the chunk's JSON: its book and, when it traded, its rebalance. */
  function managerDayRow(day: string, write: ManagerDayWrite): ManagerDayRow {
    const { result } = write;
    const book = managerBookSchema.parse(result.book);
    const stats = agentStatsSchema.parse(result.stats);
    let rebalance: string | null = null;
    if (result.reason !== null) {
      rebalance = JSON.stringify(
        managerRebalanceSchema.parse({
          day,
          reason: result.reason,
          policyVersion: book.policyVersion,
          targetsBps: result.targetsUsed ?? {},
          fills: result.fills,
          exited: result.exited,
          equityBeforeMicro: result.equityBeforeMicro,
          equityAfterMicro: result.equityMicro,
          costMicro: result.costMicro,
        }),
      );
    }
    return {
      id: write.managerId,
      prev: write.prevDay,
      book: JSON.stringify(book),
      stats: JSON.stringify(stats),
      valuedDays: stats.tradingDays,
      returnBps: stats.seasonReturnBps,
      maxDrawdownBps: stats.maxDrawdownBps,
      vol: wholeNumber(write.volMilliBps, 'volMilliBps'),
      reason: result.reason,
      rebalance,
    };
  }

  return withDailyLimit(store);
}

/** True if a database error says that a daily limit of the plan is used up. Mirrors the Phase 1 store. */
function isDailyLimitMessage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`.toLowerCase();
  if (!text.includes('d1')) return false;
  return /daily|per day|quota|free tier|free plan/.test(text) && /limit|exceed|quota/.test(text);
}

/** Every method throws DailyLimitError for a used-up daily limit; any other error passes through unchanged. */
function withDailyLimit(store: SocialStore): SocialStore {
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
  return wrapped as unknown as SocialStore;
}
