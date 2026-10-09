-- Prix, Phase 5: the data network. docs/contracts/phase-5-data.md section 2.
-- A migration that has been applied is never edited. Money is integer micro-USDG (6 decimals).

-- API keys. Only the SHA-256 of the key is stored, never the key. `prefix` is the first
-- 12 characters, kept to recognise a key in a list. A revoked key stays, so a wallet cannot
-- clear its history, and so the count of keys created today is true.
CREATE TABLE api_keys (
  id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_day TEXT,
  revoked_at TEXT
) STRICT, WITHOUT ROWID;

-- authenticateKey: one seek per call.
CREATE UNIQUE INDEX api_keys_hash ON api_keys (key_hash);
-- listKeys, the count of a wallet's active keys, and the count of keys it created today.
CREATE INDEX api_keys_owner ON api_keys (owner, created_at);
-- The count of keys everyone created today (DATA_KEY_CREATES_DAILY_CEILING).
CREATE INDEX api_keys_created ON api_keys (created_at);

-- Wallets that may not use the API: authenticateKey leaves their keys out, createKey refuses them.
CREATE TABLE api_blocked (
  owner TEXT NOT NULL PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Calls per wallet per UTC day, never per key: rotating keys changes nothing here.
-- free_n counts calls inside the free quota, paid_n calls paid with credits.
CREATE TABLE api_usage (
  day TEXT NOT NULL,
  owner TEXT NOT NULL,
  free_n INTEGER NOT NULL DEFAULT 0 CHECK (free_n >= 0),
  paid_n INTEGER NOT NULL DEFAULT 0 CHECK (paid_n >= 0),
  PRIMARY KEY (day, owner)
) STRICT, WITHOUT ROWID;

-- listUsage: the last days of one wallet. An update of free_n or paid_n does not touch this
-- index, so it costs one more written row only on a wallet's first call of the day.
CREATE INDEX api_usage_owner ON api_usage (owner, day);

-- The global counts of one UTC day: bucket 'api' is keyed calls, bucket 'page' is uncached
-- lookups from the public trust page. The ceiling is checked in the same statement that counts.
CREATE TABLE api_global (
  day TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('api', 'page')),
  n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, bucket)
) STRICT, WITHOUT ROWID;

-- Prepaid credits, one row per wallet. balance_micro is what is left to spend on calls.
-- It is a number of calls the product owes, bought with a transfer. It is not a deposit and
-- nothing can be withdrawn from it.
CREATE TABLE api_credits (
  owner TEXT NOT NULL PRIMARY KEY,
  balance_micro INTEGER NOT NULL DEFAULT 0 CHECK (balance_micro >= 0),
  bought_micro INTEGER NOT NULL DEFAULT 0 CHECK (bought_micro >= 0),
  updated_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Payments that were credited. The primary key is the replay guard: a transaction hash can
-- be credited once, whoever sends it and however many requests carry it.
CREATE TABLE api_payments (
  tx_hash TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL,
  amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),
  block_number INTEGER NOT NULL,
  credited_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- listPayments: one wallet's payments, newest first.
CREATE INDEX api_payments_owner ON api_payments (owner, credited_at);

-- A payment is a record of money that arrived. It is insert only, in the database itself.
CREATE TRIGGER api_payments_no_update BEFORE UPDATE ON api_payments
BEGIN
  SELECT RAISE(ABORT, 'payments are insert only: a row is never updated');
END;

CREATE TRIGGER api_payments_no_delete BEFORE DELETE ON api_payments
BEGIN
  SELECT RAISE(ABORT, 'payments are insert only: a row is never deleted');
END;
