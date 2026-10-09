-- Prix, Phase 1. The data model of docs/CONTRACTS.md sections 3 and 15, for Cloudflare D1.
--
-- Rules this file follows:
--   * A migration that has been applied is never edited. A change is a new, higher-numbered file.
--   * Seasons are seeded per environment with the command in infra/seed/README.md, not here.
--   * Every timestamp is the text of Date.prototype.toISOString(), so text order is time order.
--     A tick id (2026-10-06T15:00Z) sorts in time order as well.
--   * A boolean is 0 or 1. Money is integer micro-USD. A JSON column holds the JSON of a schema
--     from packages/contracts, validated by the store when it is written.
--   * Tables with a text key are WITHOUT ROWID: the key is the table, so a row costs one
--     written row instead of two. D1 bills one more written row for every index that holds a
--     changed column, so every index below is there for a query named beside it.
--   * There are no foreign keys. apps/api/src/store is the only code that writes, each of its
--     methods is one statement or one transaction, and nothing here is deleted except nonces,
--     sessions, model keys and symbol holds.

-- One row per wallet that has signed in.
CREATE TABLE users (
  address TEXT NOT NULL PRIMARY KEY,
  created_at TEXT NOT NULL,
  -- spendWalletWrite: the UTC day of the count and how many state-changing requests the wallet made on it.
  write_day TEXT NOT NULL DEFAULT '',
  write_count INTEGER NOT NULL DEFAULT 0 CHECK (write_count >= 0)
) STRICT, WITHOUT ROWID;

-- Sign-in nonces that have been used. A nonce is stateless (docs/CONTRACTS.md section 15):
-- issuing one writes nothing, and a row is written only when a valid sign-in uses it. A row
-- that exists is a nonce that was used: useNonce is an insert that the key refuses a second time.
--
-- There is no index on expires_at, on purpose. An index would add a written row to every
-- sign-in and another to every delete, and written rows are the scarce allowance. A nonce
-- lives five minutes, so the table holds a few minutes of sign-ins and deleteExpired can
-- afford to walk it.
CREATE TABLE siwe_nonces (
  nonce TEXT NOT NULL PRIMARY KEY,
  expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Sessions, by the SHA-256 of the token. The token itself is never stored.
CREATE TABLE sessions (
  token_hash TEXT NOT NULL PRIMARY KEY,
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- deleteExpired: the oldest expired sessions, without reading the live ones.
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- Agents: every field of agentRecordSchema as a column, and division_seq. Never deleted.
--
-- division_seq numbers the agents of one division 1, 2, 3 in the order they were created.
-- createAgent writes it, and because no agent is ever deleted the highest number of a
-- division is the number of agents in it. The limit on agents per division is therefore one
-- index seek, not a count over the division.
CREATE TABLE agents (
  id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('open', 'pro')),
  prompt TEXT NOT NULL,
  prompt_public INTEGER NOT NULL CHECK (prompt_public IN (0, 1)),
  summary TEXT,
  summary_status TEXT NOT NULL CHECK (summary_status IN ('pending', 'ready', 'failed')),
  model_key_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  paused_reason TEXT CHECK (
    paused_reason IS NULL OR paused_reason IN ('owner', 'key_removed', 'key_failing', 'admin')
  ),
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  strategy_changed_at TEXT NOT NULL,
  prompt_change_day TEXT,
  prompt_change_count INTEGER NOT NULL CHECK (prompt_change_count >= 0),
  division_seq INTEGER NOT NULL CHECK (division_seq > 0)
) STRICT, WITHOUT ROWID;

-- One agent per wallet. Also serves getAgentByOwner and the pause in deleteModelKey.
CREATE UNIQUE INDEX agents_owner ON agents (owner);

-- createAgent: the number of agents in a division, read from the end of the index.
CREATE UNIQUE INDEX agents_division ON agents (division, division_seq);

-- The seats of a division: createAgent counts the agents that are not hidden. Hiding one frees its seat.
CREATE INDEX agents_division_visible ON agents (division) WHERE hidden = 0;

-- One agent per name key.
CREATE UNIQUE INDEX agents_name_key ON agents (name_key);

-- listAgentsNeedingSummary: only the agents that wait for a summary are in this index,
-- oldest first, so an idle scheduler step reads at most the rows it returns.
CREATE INDEX agents_summary_pending ON agents (strategy_changed_at, id)
  WHERE summary_status = 'pending' AND status = 'active' AND hidden = 0;

-- Model keys: every field of modelKeyRecordSchema as a column. Ciphertext only.
CREATE TABLE model_keys (
  id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  last4 TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- listModelKeys: the keys of one wallet, oldest first. putModelKey counts a wallet's keys in it.
CREATE INDEX model_keys_owner ON model_keys (owner, created_at);

-- Seasons. A season runs from starts_at up to, and not including, ends_at.
CREATE TABLE seasons (
  id TEXT NOT NULL PRIMARY KEY,
  number INTEGER NOT NULL CHECK (number > 0),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
) STRICT, WITHOUT ROWID;

-- listSeasons, and one season per number.
CREATE UNIQUE INDEX seasons_number ON seasons (number);

-- getActiveSeason and getLatestStartedSeason: the newest season that has started.
CREATE UNIQUE INDEX seasons_starts_at ON seasons (starts_at);

-- The current state of one agent in one season.
--
-- season_return_bps, max_drawdown_bps, trade_count, trading_days and decided_count are copies
-- of the same fields of the stats JSON, written with it, so that ranking runs in SQL.
-- agent_created_at is a copy of agents.created_at, which never changes: the league order of
-- docs/CONTRACTS.md section 9 breaks ties on it, and an index cannot reach into another table.
-- key_failures counts the agent's latest rows in a row in which its key or model was refused.
-- It lives here and not on the agent because writeDecision rewrites this row anyway, so
-- keeping the count costs no written row.
CREATE TABLE portfolios (
  agent_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('open', 'pro')),
  portfolio TEXT NOT NULL,
  stats TEXT NOT NULL,
  last_tick_id TEXT,
  last_asked_tick_id TEXT,
  last_status TEXT,
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  season_return_bps INTEGER NOT NULL,
  max_drawdown_bps INTEGER NOT NULL,
  trade_count INTEGER NOT NULL,
  trading_days INTEGER NOT NULL,
  decided_count INTEGER NOT NULL,
  key_failures INTEGER NOT NULL CHECK (key_failures >= 0),
  agent_created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, season_id)
) STRICT, WITHOUT ROWID;

-- The league order: listStandings reads one page of it, rerank walks one division of it.
-- Ranked agents first, by rank. Then the unranked ones, where rank is null for all, in the
-- order of section 9: higher return, lower drawdown, fewer trades, older agent, lower id.
CREATE INDEX portfolios_league ON portfolios (
  season_id,
  division,
  (rank IS NULL),
  rank,
  season_return_bps DESC,
  max_drawdown_bps,
  trade_count,
  agent_created_at,
  agent_id
);

-- The fair order of the scheduler: listPendingAgents and countPendingAgents.
-- Never asked first (null sorts first), then asked longest ago, then by agent id.
-- last_tick_id and agent_created_at are in the index so that "no row for this tick yet" and
-- "created before the tick's snapshot" are decided without reading the row. agent_created_at
-- never changes, so it adds no written row.
CREATE INDEX portfolios_pending ON portfolios (
  season_id,
  division,
  last_asked_tick_id,
  agent_id,
  last_tick_id,
  agent_created_at
);

-- One decision round. The id names the UTC hour (2026-10-06T15:00Z), so there is one per hour
-- at most, and ids sort in time order. The check is in two halves because D1 refuses a GLOB
-- pattern longer than 50 bytes.
CREATE TABLE ticks (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 17
    AND substr(id, 1, 8) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-'
    AND substr(id, 9) GLOB '[0-9][0-9]T[0-9][0-9]:00Z'
  ),
  season_id TEXT NOT NULL,
  daily INTEGER NOT NULL CHECK (daily IN (0, 1)),
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'complete')),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT, WITHOUT ROWID;

-- listProcessingTicks runs every minute. Only unfinished ticks are in this index.
CREATE INDEX ticks_processing ON ticks (id) WHERE status = 'processing';

-- What happened to one agent at one tick. The key refuses a second row for the same
-- agent and tick, which is what makes a scheduler retry safe. The key is the only index:
-- every read is one agent's rows, newest first, and an insert costs one written row.
CREATE TABLE decisions (
  agent_id TEXT NOT NULL,
  tick_id TEXT NOT NULL,
  season_id TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('open', 'pro')),
  status TEXT NOT NULL,
  code TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, tick_id)
) STRICT, WITHOUT ROWID;

-- The record is insert only. These two triggers make that true in the database itself.
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are insert only: a row is never updated');
END;

CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are insert only: a row is never deleted');
END;

-- What a league table is as of. Replaced at every ranking.
CREATE TABLE league_state (
  season_id TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('open', 'pro')),
  body TEXT NOT NULL,
  PRIMARY KEY (season_id, division)
) STRICT, WITHOUT ROWID;

-- Symbols held for review: every field of symbolHoldSchema as a column.
-- At most one row per symbol of the universe, so the table has 20 rows at the very most.
-- released_at is set when an admin releases the hold; the next tick then deletes the row.
CREATE TABLE symbol_holds (
  symbol TEXT NOT NULL PRIMARY KEY,
  price_micro INTEGER NOT NULL,
  seen_price_micro INTEGER NOT NULL,
  since_tick_id TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- A single row.
CREATE TABLE market_status (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL
) STRICT;

-- A single row. touchScheduler rewrites it before a step asks any model: a database that has
-- stopped taking writes fails here, at the cost of one written row, and not after the spend.
CREATE TABLE scheduler_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  touched_at TEXT NOT NULL
) STRICT;

-- House-model usage per UTC day and use. Neurons are computed from token counts and need not be whole.
CREATE TABLE ai_usage (
  day TEXT NOT NULL,
  use TEXT NOT NULL CHECK (use IN ('decision', 'summary')),
  neurons REAL NOT NULL CHECK (neurons >= 0),
  PRIMARY KEY (day, use)
) STRICT, WITHOUT ROWID;

-- Rows the HTTP API wrote on one UTC day, all wallets together (spendApiWrites). The scheduler never touches it.
CREATE TABLE api_writes (
  day TEXT NOT NULL PRIMARY KEY,
  rows INTEGER NOT NULL CHECK (rows >= 0)
) STRICT, WITHOUT ROWID;
