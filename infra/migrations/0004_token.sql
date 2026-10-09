-- Prix, Phase 4. Token tiers. docs/contracts/phase-4-token.md section 2.
--
-- 1. agents is rebuilt, for two changes that SQLite cannot make in place:
--    * paused_reason gains 'slot_limit' (a CHECK cannot be altered);
--    * the unique index agents_owner goes, because a wallet may own several agents.
--    There are no foreign keys and no triggers on agents, so the rebuild is: new table, copy,
--    drop, rename, indexes. Row counts: one copy of every agent, so a few hundred rows at most.

CREATE TABLE agents_v2 (
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
    paused_reason IS NULL
    OR paused_reason IN ('owner', 'key_removed', 'key_failing', 'admin', 'slot_limit')
  ),
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  strategy_changed_at TEXT NOT NULL,
  prompt_change_day TEXT,
  prompt_change_count INTEGER NOT NULL CHECK (prompt_change_count >= 0),
  division_seq INTEGER NOT NULL CHECK (division_seq > 0)
) STRICT, WITHOUT ROWID;

INSERT INTO agents_v2 (
  id, owner, name, name_key, division, prompt, prompt_public, summary, summary_status,
  model_key_id, status, paused_reason, hidden, created_at, updated_at, strategy_changed_at,
  prompt_change_day, prompt_change_count, division_seq
)
SELECT
  id, owner, name, name_key, division, prompt, prompt_public, summary, summary_status,
  model_key_id, status, paused_reason, hidden, created_at, updated_at, strategy_changed_at,
  prompt_change_day, prompt_change_count, division_seq
FROM agents;

DROP TABLE agents;
ALTER TABLE agents_v2 RENAME TO agents;

-- getAgentByOwner (the oldest agent of a wallet), the count of a wallet's agents in createAgent,
-- and the slot window of applySlots (ROW_NUMBER over the owner's agents in creation order).
CREATE INDEX agents_owner_created ON agents (owner, created_at, id);

-- createAgent: the number of agents in a division, read from the end of the index.
CREATE UNIQUE INDEX agents_division ON agents (division, division_seq);

-- createAgent counts the seats of a division through this index (from 0001, dropped with the table).
CREATE INDEX agents_division_visible ON agents (division) WHERE hidden = 0;

-- One agent per name key.
CREATE UNIQUE INDEX agents_name_key ON agents (name_key);

-- listAgentsNeedingSummary: unchanged from 0001.
CREATE INDEX agents_summary_pending ON agents (created_at, id)
  WHERE summary_status = 'pending' AND status = 'active' AND hidden = 0;

-- releaseSlotPauses and the resume statement of applySlots: only agents paused for slots are in it.
CREATE INDEX agents_slot_paused ON agents (owner)
  WHERE paused_reason = 'slot_limit';

-- 2. The configuration: one row. The migration writes the defaults; an admin route changes it.
CREATE TABLE token_config (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  token_address TEXT CHECK (
    token_address IS NULL
    OR (length(token_address) = 42 AND token_address = lower(token_address))
  ),
  threshold_1_ppm INTEGER NOT NULL CHECK (threshold_1_ppm BETWEEN 1 AND 1000000),
  threshold_2_ppm INTEGER NOT NULL CHECK (threshold_2_ppm BETWEEN 1 AND 1000000),
  threshold_3_ppm INTEGER NOT NULL CHECK (threshold_3_ppm BETWEEN 1 AND 1000000),
  buy_url TEXT CHECK (buy_url IS NULL OR length(buy_url) <= 300),
  activated_at TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK (threshold_1_ppm < threshold_2_ppm AND threshold_2_ppm < threshold_3_ppm),
  CHECK (enabled = 0 OR token_address IS NOT NULL)
) STRICT;

INSERT INTO token_config (
  id, enabled, token_address, threshold_1_ppm, threshold_2_ppm, threshold_3_ppm,
  buy_url, activated_at, updated_at, updated_by
) VALUES (1, 0, NULL, 10, 100, 1000, NULL, NULL, '2026-10-06T00:00:00.000Z', 'migration');

-- After the first activation the token is fixed and a threshold may only fall. The route checks
-- it first and answers in words; this is the database refusing a route that forgot to.
CREATE TRIGGER token_config_locked BEFORE UPDATE ON token_config
WHEN OLD.activated_at IS NOT NULL AND (
  NEW.token_address IS NOT OLD.token_address
  OR NEW.activated_at IS NOT OLD.activated_at
  OR NEW.threshold_1_ppm > OLD.threshold_1_ppm
  OR NEW.threshold_2_ppm > OLD.threshold_2_ppm
  OR NEW.threshold_3_ppm > OLD.threshold_3_ppm
)
BEGIN
  SELECT RAISE(ABORT, 'token configuration is locked: the token is fixed and thresholds only fall');
END;

CREATE TRIGGER token_config_no_delete BEFORE DELETE ON token_config
BEGIN
  SELECT RAISE(ABORT, 'the token configuration row is never deleted');
END;

-- 3. The last read of each wallet that asked for its entitlements while gating was on.
-- balance and total_supply are decimal digits in the token's base units (up to 78 digits, so
-- not an INTEGER). token_address says which token the row was read from: after the address
-- changes (allowed only before activation) every old row counts as absent.
-- slots_dirty is 1 while the wallet's agents have not been matched to max_agents yet.
CREATE TABLE token_holders (
  address TEXT NOT NULL PRIMARY KEY,
  balance TEXT NOT NULL,
  total_supply TEXT NOT NULL,
  decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  max_agents INTEGER NOT NULL CHECK (max_agents > 0),
  token_address TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  slots_dirty INTEGER NOT NULL CHECK (slots_dirty IN (0, 1))
) STRICT, WITHOUT ROWID;

-- listDueHolders: the sweep reads holders above tier 0 whose read is old, oldest first.
-- A tier 0 wallet has at most one agent, so nothing about it has to be re-read on a schedule.
CREATE INDEX token_holders_due ON token_holders (checked_at, address) WHERE tier > 0;

-- applySlots: only the wallets whose slots changed are in it.
CREATE INDEX token_holders_dirty ON token_holders (address) WHERE slots_dirty = 1;
