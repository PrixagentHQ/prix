-- Prix, browser push for the follow notes. A subscription is the address of a push service
-- that a browser gave the page; the table keeps it for the signed-in wallet.
-- The key is the SHA-256 of the endpoint, in hex, so one browser is one row.
CREATE TABLE push_subscriptions (
  id TEXT NOT NULL PRIMARY KEY,
  address TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_pushed_at TEXT
) STRICT, WITHOUT ROWID;

-- listSubscriptions and the limit of five per wallet read a wallet's rows.
CREATE INDEX push_subscriptions_address ON push_subscriptions (address, created_at);
