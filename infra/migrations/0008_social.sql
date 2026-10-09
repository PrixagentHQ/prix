-- Prix, Phase 6: the social strategy layer. docs/contracts/phase-6-social.md section 2.
-- Adds tables only. Nothing in 0001 to 0007 is changed. Conventions of 0001: STRICT, WITHOUT ROWID for
-- text keys, ISO timestamps, 0/1 booleans, no foreign keys, every index named for its query.
-- Cursors live in job_state (0002) under names starting 'social:'; counters in counters (0002).
-- The official rank of a v2 season (revision 6, part A) needs no migration.

-- --- Strategy DNA -------------------------------------------------------------------------------------

-- The latest profile of each agent, replaced once a day by the strategy_dna job. body is dnaProfileSchema
-- JSON and names its method. The inputs (decisions, day_prices) are insert-only, so any row recomputes.
-- No secondary index: an upsert writes one row.
CREATE TABLE strategy_dna (
  agent_id TEXT NOT NULL PRIMARY KEY,
  method TEXT NOT NULL,
  as_of_day TEXT NOT NULL,
  body TEXT NOT NULL,
  computed_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- --- forks --------------------------------------------------------------------------------------------

-- One row per fork, written once by POST /api/social/agents/:id/lineage. root_id and depth are stored so
-- that no read recurses. Names are joined from agents, never stored. A cycle is impossible: the parent is
-- older than the child and a row never changes.
CREATE TABLE agent_lineage (
  agent_id TEXT NOT NULL PRIMARY KEY,
  parent_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 1),
  created_at TEXT NOT NULL,
  CHECK (parent_id <> agent_id)
) STRICT, WITHOUT ROWID;

-- countChildren, listChildren: the children of one agent, newest first.
CREATE INDEX agent_lineage_parent ON agent_lineage (parent_id, created_at, agent_id);

-- countFamily, listFamily: every fork under one root, in creation order.
CREATE INDEX agent_lineage_root ON agent_lineage (root_id, created_at, agent_id);

CREATE TRIGGER agent_lineage_no_update BEFORE UPDATE ON agent_lineage
BEGIN
  SELECT RAISE(ABORT, 'lineage is insert only: a row is never updated');
END;

CREATE TRIGGER agent_lineage_no_delete BEFORE DELETE ON agent_lineage
BEGIN
  SELECT RAISE(ABORT, 'lineage is insert only: a row is never deleted');
END;

-- --- rank tape and rivalries --------------------------------------------------------------------------

-- The rank tape: one row per season, division and final day. ranks is JSON [[agentId, rank], ...] in rank
-- order, visible ranked agents only, built in SQL with json_group_array from portfolios.rank, which holds the
-- official rank of the season's method. A day whose ranks had already moved on is never written.
CREATE TABLE rivalry_days (
  season_id TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('open', 'pro')),
  day TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('v1', 'v2')),
  ranks TEXT NOT NULL,
  ranked_count INTEGER NOT NULL CHECK (ranked_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (season_id, division, day)
) STRICT, WITHOUT ROWID;

-- One row per pair per season, agent_a < agent_b. series is JSON [[day, rankA|null, rankB|null], ...]
-- from the window that formed it; the match job appends one point a day while it is active.
CREATE TABLE rivalries (
  season_id TEXT NOT NULL,
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('open', 'pro')),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  formed_day TEXT NOT NULL,
  ended_day TEXT,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('apart', 'season_end')),
  leader TEXT,
  lead_changes INTEGER NOT NULL CHECK (lead_changes >= 0),
  last_day TEXT NOT NULL,
  series TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (season_id, agent_a, agent_b),
  CHECK (agent_a < agent_b)
) STRICT, WITHOUT ROWID;

-- listAgentRivalries: an agent's rivalries from either side, one season.
CREATE INDEX rivalries_agent_a ON rivalries (agent_a, season_id);
CREATE INDEX rivalries_agent_b ON rivalries (agent_b, season_id);

-- listActiveRivalries: the active rivalries of a division, every season.
CREATE INDEX rivalries_active ON rivalries (division, season_id, agent_a, agent_b) WHERE status = 'active';

-- listRivalries: one page of a season and division, active first, newest formed first.
CREATE INDEX rivalries_list ON rivalries (season_id, division, status, formed_day DESC, agent_a, agent_b);

-- Insert only. detail is JSON of the integers the sentence uses.
CREATE TABLE rivalry_events (
  season_id TEXT NOT NULL,
  agent_a TEXT NOT NULL,
  agent_b TEXT NOT NULL,
  day TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('formed', 'overtake', 'ended')),
  subject TEXT,
  rank_a INTEGER CHECK (rank_a IS NULL OR rank_a > 0),
  rank_b INTEGER CHECK (rank_b IS NULL OR rank_b > 0),
  detail TEXT NOT NULL,
  PRIMARY KEY (season_id, agent_a, agent_b, day, seq)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER rivalry_events_no_update BEFORE UPDATE ON rivalry_events
BEGIN
  SELECT RAISE(ABORT, 'rivalry events are insert only: a row is never updated');
END;

CREATE TRIGGER rivalry_events_no_delete BEFORE DELETE ON rivalry_events
BEGIN
  SELECT RAISE(ABORT, 'rivalry events are insert only: a row is never deleted');
END;

-- --- Model Wars ---------------------------------------------------------------------------------------

-- One war. body is warRecordSchema JSON. status is copied out for the partial index.
CREATE TABLE wars (
  id TEXT NOT NULL PRIMARY KEY,
  number INTEGER NOT NULL CHECK (number > 0),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'complete', 'stopped')),
  starts_on TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- createWar takes the next number; listWars reads it backwards.
CREATE UNIQUE INDEX wars_number ON wars (number);

-- getOpenWar and the cap of one open war: at most ACTIVE_WARS_MAX rows are ever in this index.
CREATE INDEX wars_open ON wars (created_at, id) WHERE status IN ('scheduled', 'running');

-- One entrant: one model in one slot. body is the frozen part of warEntrantSchema; portfolio and stats
-- change once per war-day.
CREATE TABLE war_entrants (
  war_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('A', 'B', 'C', 'D')),
  model_id TEXT NOT NULL,
  body TEXT NOT NULL,
  portfolio TEXT NOT NULL,
  stats TEXT NOT NULL,
  last_tick_id TEXT,
  days INTEGER NOT NULL DEFAULT 0 CHECK (days >= 0),
  rejected_days INTEGER NOT NULL DEFAULT 0 CHECK (rejected_days >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (war_id, slot)
) STRICT, WITHOUT ROWID;

-- A model enters a war once.
CREATE UNIQUE INDEX war_entrants_model ON war_entrants (war_id, model_id);

-- What one entrant did at one war-day. Insert only. A war-day is written in one batch, so a refused insert
-- rolls the whole day back for every entrant. body is warRowSchema JSON.
CREATE TABLE war_rows (
  war_id TEXT NOT NULL,
  tick_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('A', 'B', 'C', 'D')),
  status TEXT NOT NULL CHECK (status IN ('decided', 'no_decision', 'skipped')),
  code TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (war_id, tick_id, slot)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER war_rows_no_update BEFORE UPDATE ON war_rows
BEGIN
  SELECT RAISE(ABORT, 'war rows are insert only: a row is never updated');
END;

CREATE TRIGGER war_rows_no_delete BEFORE DELETE ON war_rows
BEGIN
  SELECT RAISE(ABORT, 'war rows are insert only: a row is never deleted');
END;

-- Workers AI neurons spent by wars per UTC day. Apart from ai_usage, whose CHECK allows only 'decision' and
-- 'summary'. The war job reads both and reserves before any call.
CREATE TABLE war_usage (
  day TEXT NOT NULL PRIMARY KEY,
  neurons REAL NOT NULL CHECK (neurons >= 0)
) STRICT, WITHOUT ROWID;

-- --- paper managers -----------------------------------------------------------------------------------

-- Never deleted: a closed manager keeps its record. owner never reaches a public response.
CREATE TABLE managers (
  id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  created_at TEXT NOT NULL,
  created_day TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- One manager per name. createManager also checks agents.name_key and listings.name_key in SQL.
CREATE UNIQUE INDEX managers_name_key ON managers (name_key);

-- listManagersByOwner and the slot count.
CREATE INDEX managers_owner ON managers (owner, created_at, id);

-- listManagersToValue: active, visible managers in id order.
CREATE INDEX managers_valued ON managers (id) WHERE status = 'active' AND hidden = 0;

-- listManagers: visible managers, newest first.
CREATE INDEX managers_public ON managers (created_at, id) WHERE hidden = 0;

-- Insert only. targets is JSON {agentId: bps}. A version takes effect at the first final day after set_day.
CREATE TABLE manager_policies (
  manager_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  targets TEXT NOT NULL,
  schedule TEXT NOT NULL CHECK (schedule IN ('weekly', 'hold')),
  set_at TEXT NOT NULL,
  set_day TEXT NOT NULL,
  PRIMARY KEY (manager_id, version)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER manager_policies_no_update BEFORE UPDATE ON manager_policies
BEGIN
  SELECT RAISE(ABORT, 'manager policies are insert only: a row is never updated');
END;

CREATE TRIGGER manager_policies_no_delete BEFORE DELETE ON manager_policies
BEGIN
  SELECT RAISE(ABORT, 'manager policies are insert only: a row is never deleted');
END;

-- The season book and record of one manager. book is managerBookSchema, stats is agentStatsSchema
-- (tradingDays = valued days, decidedCount = rebalance days, tradeCount = fills). The figure columns are
-- copies for the list. No secondary index: the list joins by primary key.
CREATE TABLE manager_books (
  manager_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  book TEXT NOT NULL,
  stats TEXT NOT NULL,
  last_day TEXT,
  valued_days INTEGER NOT NULL CHECK (valued_days >= 0),
  return_bps INTEGER NOT NULL,
  max_drawdown_bps INTEGER NOT NULL CHECK (max_drawdown_bps >= 0),
  vol_milli_bps INTEGER NOT NULL CHECK (vol_milli_bps >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (manager_id, season_id)
) STRICT, WITHOUT ROWID;

-- Allocation history. Insert only; at most one row per manager, season and day. body is managerRebalanceSchema.
CREATE TABLE manager_rebalances (
  manager_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  day TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('start', 'policy', 'scheduled', 'exit')),
  body TEXT NOT NULL,
  PRIMARY KEY (manager_id, season_id, day)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER manager_rebalances_no_update BEFORE UPDATE ON manager_rebalances
BEGIN
  SELECT RAISE(ABORT, 'manager rebalances are insert only: a row is never updated');
END;

CREATE TRIGGER manager_rebalances_no_delete BEFORE DELETE ON manager_rebalances
BEGIN
  SELECT RAISE(ABORT, 'manager rebalances are insert only: a row is never deleted');
END;

-- Counter keys used by Phase 6 in counters (0002):
--   'd:<day>:fork:<parentId>'      forks linked to one parent today (FORKS_PER_PARENT_PER_DAY)
--   's:<seasonId>:mgr:<address>'   managers a wallet created this season (slots + MANAGER_EXTRA_CREATIONS_PER_SEASON)
--   'd:<day>:mgrnew'               managers created today, everyone (MANAGERS_CREATED_PER_DAY)
--   'd:<day>:mgrpol:<managerId>'   policy changes of one manager today (MANAGER_POLICY_CHANGES_PER_DAY)
-- job_state names: 'social:dna', 'social:tape', 'social:rivalry', 'social:managers'.

-- The end-of-day read of the DNA job (apps/api/src/store/social.ts, not a migration), for one agent:
--   ?1 agent id, ?2 the day after the last day wanted ('YYYY-MM-DD'), ?3 limit (DNA_WINDOW_DAYS + 1).
-- WITH RECURSIVE eod (tick_id, n) AS (
--   SELECT (SELECT max(tick_id) FROM decisions WHERE agent_id = ?1 AND tick_id < ?2), 1 WHERE ?3 >= 1
--   UNION ALL
--   SELECT (SELECT max(tick_id) FROM decisions WHERE agent_id = ?1 AND tick_id < substr(eod.tick_id, 1, 10)), eod.n + 1
--   FROM eod WHERE eod.tick_id IS NOT NULL AND eod.n < ?3
-- )
-- SELECT d.tick_id, d.season_id, json_extract(d.body, '$.portfolio') AS portfolio,
--        json_extract(d.body, '$.equityMicro') AS equity_micro
-- FROM eod CROSS JOIN decisions AS d ON d.agent_id = ?1 AND d.tick_id = eod.tick_id;
-- No json_each: D1 counts every array element as a row read (apps/api/src/store/sql.ts, LIST_DAILY_PRICES).
