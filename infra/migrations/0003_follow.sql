-- Prix, Phase 3, Follow. docs/contracts/phase-3-follow.md section 2.

-- Who follows whom. One row per (wallet, agent). A wallet follows at most 25 agents:
-- putFollow enforces it in SQL, by counting the wallet's rows through the primary key.
CREATE TABLE follows (
  address TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (address, agent_id)
) STRICT, WITHOUT ROWID;

-- listEmitCandidates: the followers of an agent that want a note. Only rows with notify = 1
-- are in it, so a follower who has notes off costs no written index row.
CREATE INDEX follows_notify ON follows (agent_id, address) WHERE notify = 1;

-- The number of followers of an agent, kept by two triggers so that the agent's page never
-- counts rows: a count of a popular agent would read every follower on every uncached view.
CREATE TABLE follow_counts (
  agent_id TEXT NOT NULL PRIMARY KEY,
  followers INTEGER NOT NULL CHECK (followers >= 0)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER follows_count_insert AFTER INSERT ON follows
BEGIN
  INSERT INTO follow_counts (agent_id, followers) VALUES (NEW.agent_id, 1)
  ON CONFLICT (agent_id) DO UPDATE SET followers = followers + 1;
END;

CREATE TRIGGER follows_count_delete AFTER DELETE ON follows
BEGIN
  UPDATE follow_counts SET followers = followers - 1 WHERE agent_id = OLD.agent_id;
END;

-- The Telegram chat of a wallet. One chat per wallet and one wallet per chat: the unique
-- index below is what stops one chat from collecting the notes of many wallets.
CREATE TABLE notify_chats (
  address TEXT NOT NULL PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  linked_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- redeemLinkCode: is the chat already linked? deleteChatById: the wallet of a chat.
CREATE UNIQUE INDEX notify_chats_chat ON notify_chats (chat_id);

-- An open link code: one per wallet, replaced when the wallet asks again. Only the SHA-256
-- of the code, in hex, is stored. The code itself exists in the wallet's response and in the
-- link the person opens, nowhere else.
CREATE TABLE notify_link_codes (
  address TEXT NOT NULL PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- redeemLinkCode: find the code by its hash.
CREATE UNIQUE INDEX notify_link_codes_hash ON notify_link_codes (code_hash);

-- Notes waiting to be sent. The key is the table: one note per wallet, tick and agent, which is
-- what makes the emitter safe to run twice. A sent note is deleted. There is no secondary
-- index on purpose: the table holds minutes of work, and every index adds a written row to
-- every note.
CREATE TABLE notify_outbox (
  address TEXT NOT NULL,
  tick_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  queued_at TEXT NOT NULL,
  PRIMARY KEY (address, tick_id, agent_id)
) STRICT, WITHOUT ROWID;

-- Where the emitter stands: one row, rewritten only by a run that did work. The first run
-- sets done_tick_id to the newest complete tick and emits nothing for earlier ticks.
CREATE TABLE notify_state (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  done_tick_id TEXT,
  work_tick_id TEXT,
  after_agent_id TEXT NOT NULL,
  after_address TEXT NOT NULL,
  queue_day TEXT NOT NULL,
  queued_today INTEGER NOT NULL CHECK (queued_today >= 0)
) STRICT;

INSERT INTO notify_state (id, done_tick_id, work_tick_id, after_agent_id, after_address, queue_day, queued_today)
VALUES (1, NULL, NULL, '', '', '1970-01-01', 0);

-- The one change to a Phase 1 table, an index and nothing else: the emitter reads the decided
-- rows of one tick. Only decided rows are in it, about 450 a day, so it adds one written row
-- to each of them. The decisions table stays insert only.
CREATE INDEX decisions_decided_by_tick ON decisions (tick_id, agent_id) WHERE status = 'decided';
