-- Prix, Phase 6.8: the holders' lounge. docs/contracts/phase-6-holders-2.md section 4.2.
-- One row per Telegram account the bot let into the Prix Community group (D-163). A member the bot did not let in has no row
-- and is never removed by Prix. 0018 is the first holders wave's; the two files touch no common table, and
-- wrangler applies every file that d1_migrations does not name, in the order of their names.
CREATE TABLE holders_lounge_members (
  telegram_user_id INTEGER NOT NULL PRIMARY KEY CHECK (telegram_user_id > 0),
  wallet TEXT NOT NULL CHECK (length(wallet) = 42 AND wallet = lower(wallet)),
  joined_at TEXT NOT NULL,
  checked_day TEXT NOT NULL
) STRICT, WITHOUT ROWID;
-- One wallet lets in one Telegram account.
CREATE UNIQUE INDEX holders_lounge_members_wallet ON holders_lounge_members (wallet);
-- The sweep: the members not judged today, oldest day first.
CREATE INDEX holders_lounge_members_due ON holders_lounge_members (checked_day, telegram_user_id);
