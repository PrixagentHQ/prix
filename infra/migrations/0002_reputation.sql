-- Prix, Phase 2. The data model of docs/contracts/phase-2-reputation.md section 2.
-- Adds tables only. Nothing in 0001 is changed.

-- The method and length of a season. A season with no row is v1 and 28 days.
-- frozen_at is set when the season is over and its season_scores rows are final.
CREATE TABLE season_methods (
  season_id TEXT NOT NULL PRIMARY KEY,
  method TEXT NOT NULL CHECK (method IN ('v1', 'v2')),
  length_days INTEGER NOT NULL CHECK (length_days > 0),
  frozen_at TEXT,
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- One row per agent (or listing) per season and division: the live v2 score, or the frozen result.
-- division 'chain' is the table of listed on-chain agents; its agent_id is a listing id.
-- n_days, sum_bps and sumsq_bps are the moments of the daily returns, so seasons can be pooled
-- without their daily series. A v1 row has null score_milli and confidence and zero moments.
-- rank is null for every row that is not eligible and for hidden ones.
CREATE TABLE season_scores (
  season_id TEXT NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('open', 'pro', 'chain')),
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_created_at TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('v1', 'v2')),
  n_days INTEGER NOT NULL CHECK (n_days >= 0),
  sum_bps INTEGER NOT NULL,
  sumsq_bps INTEGER NOT NULL CHECK (sumsq_bps >= 0),
  return_bps INTEGER NOT NULL,
  max_drawdown_bps INTEGER NOT NULL CHECK (max_drawdown_bps >= 0),
  trading_days INTEGER NOT NULL CHECK (trading_days >= 0),
  decided_count INTEGER NOT NULL CHECK (decided_count >= 0),
  trade_count INTEGER NOT NULL CHECK (trade_count >= 0),
  score_milli INTEGER,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('insufficient', 'low', 'medium', 'high')),
  unranked_reason TEXT CHECK (
    unranked_reason IS NULL OR unranked_reason IN ('min_trading_days', 'min_decisions', 'inactive')
  ),
  rank INTEGER CHECK (rank IS NULL OR rank > 0),
  scored_day TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (season_id, division, agent_id)
) STRICT, WITHOUT ROWID;

-- listSeasonResults, rankScores: one page of a results table. Ranked rows by rank, then the
-- unranked ones in the order of v1 section 9 (higher return, older agent, lower id).
CREATE INDEX season_scores_rank ON season_scores (
  season_id,
  division,
  (rank IS NULL),
  rank,
  return_bps DESC,
  agent_created_at,
  agent_id
);

-- getTrackRecord: every season of one agent or listing.
CREATE INDEX season_scores_agent ON season_scores (agent_id, season_id);

-- The prices of the last complete tick of each UTC day, written once a day by the day_prices job.
-- prices is a JSON object of micro-USD per token by symbol. The estimated record of a listed
-- agent reads this table and never the ticks table, whose snapshots are five times as many.
CREATE TABLE day_prices (
  day TEXT NOT NULL PRIMARY KEY,
  tick_id TEXT NOT NULL,
  prices TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- The cursor of each job: one row per job name, for example 'rollover:<seasonId>' or 'score:<seasonId>'.
-- body is JSON owned by the job.
CREATE TABLE job_state (
  name TEXT NOT NULL PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Counters for the sybil limits and the claim limits. The key says what is counted and when:
-- 'd:2026-10-07:net:<16 hex>' (a network, today), 'd:2026-10-07:all' (everyone, today),
-- 's:<seasonId>:net:<16 hex>' (a network, this season), 'd:2026-10-07:claimant:<address>'.
-- A network is HMAC-SHA-256 of the client IP address (an IPv6 address by its /64) under
-- NONCE_SECRET, cut to 16 hex: the address itself is never stored. No index: deleteOldCounters
-- walks the key range 'd:' up to today, which the primary key serves.
CREATE TABLE counters (
  key TEXT NOT NULL PRIMARY KEY,
  n INTEGER NOT NULL CHECK (n >= 0),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Listed on-chain agents. Never deleted: a listing that is removed keeps its row, so the record
-- and the claim stay checkable and the wallet cannot be claimed again by someone else's replay.
-- message and signature are the exact claim, public on the listing's page.
-- balances is JSON {SYMBOL: wei as a decimal string} after all events up to record_block.
-- Amounts are text because 18 decimals do not fit a 64-bit integer for more than 9 tokens.
CREATE TABLE listings (
  id TEXT NOT NULL PRIMARY KEY,
  wallet TEXT NOT NULL,
  claimant TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  message TEXT NOT NULL,
  signature TEXT NOT NULL,
  signature_kind TEXT NOT NULL CHECK (signature_kind IN ('eoa', 'contract')),
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  claimed_at TEXT NOT NULL,
  sync_state TEXT NOT NULL CHECK (sync_state IN ('backfill', 'live', 'error', 'too_active')),
  synced_block INTEGER NOT NULL CHECK (synced_block >= 0),
  synced_at TEXT,
  window_blocks INTEGER NOT NULL CHECK (window_blocks > 0),
  sync_errors INTEGER NOT NULL CHECK (sync_errors >= 0),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  balances TEXT NOT NULL,
  record_day TEXT,
  record_block INTEGER NOT NULL CHECK (record_block >= 0),
  index_micro INTEGER NOT NULL CHECK (index_micro >= 0)
) STRICT, WITHOUT ROWID;

-- One listing per wallet: also getListingByWallet and the replay of a claim.
CREATE UNIQUE INDEX listings_wallet ON listings (wallet);

-- One listing per name. createListing also checks agents.name_key (agents_name_key) in SQL.
CREATE UNIQUE INDEX listings_name_key ON listings (name_key);

-- createListing counts a claimant's listings; listListingsByClaimant reads them.
CREATE INDEX listings_claimant ON listings (claimant, claimed_at);

-- listListedAgents: the public list, at most MAX_LISTINGS_TOTAL rows.
CREATE INDEX listings_public ON listings (claimed_at, id) WHERE status = 'active' AND hidden = 0;

-- nextListingToSync: backfilling listings first, then the live ones synced longest ago
-- (a listing never synced has a null synced_at, which sorts first), then the ones in error.
CREATE INDEX listings_sync ON listings (sync_state, synced_at, id) WHERE status = 'active' AND hidden = 0;

-- The Transfer logs of the 20 universe tokens that name a listed wallet. Insert or ignore only.
-- day is the UTC day of the block. kind is 'swap' when the same transaction moved a universe
-- token of the wallet in the other direction too. The key is the only index: every read is
-- one listing's events in block order, forward after a block or backward for the page.
CREATE TABLE listing_events (
  listing_id TEXT NOT NULL,
  block INTEGER NOT NULL CHECK (block >= 0),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  tx_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount_wei TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transfer', 'swap')),
  day TEXT NOT NULL,
  PRIMARY KEY (listing_id, block, log_index)
) STRICT, WITHOUT ROWID;

-- One priced day of a listing's estimated record. Written once per day. The key serves the
-- listing's page (one listing, a day range) and the chain scoring chunk (listings after an id).
CREATE TABLE listing_days (
  listing_id TEXT NOT NULL,
  day TEXT NOT NULL,
  return_bps INTEGER NOT NULL,
  exposed INTEGER NOT NULL CHECK (exposed IN (0, 1)),
  index_micro INTEGER NOT NULL CHECK (index_micro >= 0),
  value_micro INTEGER NOT NULL CHECK (value_micro >= 0),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  unpriced_event_count INTEGER NOT NULL CHECK (unpriced_event_count >= 0),
  PRIMARY KEY (listing_id, day)
) STRICT, WITHOUT ROWID;
