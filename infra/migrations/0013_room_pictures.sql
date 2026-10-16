-- Prix, Phase 6.4: pictures in the room. docs/contracts/phase-6-pictures.md section 2.
-- The statements are that section's, as they stand. It adds only: twelve columns and three partial indexes
-- to room_messages, six columns to room_writers, and three tables. Nothing in 0001 to 0012 is changed, and
-- the Phase 6.3 code runs on the migrated tables as before.
--
-- The number. 0010 is Prix Live's and 0011 is Phase 6.2's, and neither is on main yet. The gap is expected:
-- wrangler applies every file that d1_migrations does not name, in the order of their names
-- (infra/README.md section 16). 0013 needs 0012 (it alters its two tables) and nothing of 0010 or 0011.
--
-- It goes in BEFORE the API of this phase, as 0012 did: that API names the new columns in every read of the
-- room, whatever ROOM_PICTURES_ENABLED says (infra/README.md section 18).
--
-- Addresses are stored in lower case. Times are ISO text as Date.prototype.toISOString() writes them, so
-- text order is time order and the store compares them as text.

-- A picture is columns of its message's own row: there is never a picture without its message or a picture
-- message without its picture, and one INSERT makes both. A message of text leaves all of them null.
ALTER TABLE room_messages ADD COLUMN pic_type TEXT;       -- 'jpeg' | 'png' | 'gif'; NULL: a message of text
ALTER TABLE room_messages ADD COLUMN pic_key TEXT;        -- the KV key; NULL once Prix deleted the bytes
ALTER TABLE room_messages ADD COLUMN pic_bytes INTEGER;
ALTER TABLE room_messages ADD COLUMN pic_width INTEGER;
ALTER TABLE room_messages ADD COLUMN pic_height INTEGER;
ALTER TABLE room_messages ADD COLUMN pic_frames INTEGER;
ALTER TABLE room_messages ADD COLUMN pic_sha256 TEXT;
ALTER TABLE room_messages ADD COLUMN pic_state TEXT;      -- 'ok' | 'reported' | 'kept' | 'removed'
ALTER TABLE room_messages ADD COLUMN pic_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_messages ADD COLUMN pic_decided_at TEXT;
ALTER TABLE room_messages ADD COLUMN pic_decided_by TEXT;
ALTER TABLE room_messages ADD COLUMN pic_gone_at TEXT;

-- Partial, so a message of text writes none of them. pic_live: a writer's pictures that may still have
-- bytes, for the mute. pic_reported: the pictures that wait for an admin, for the admins' list and for a
-- writer's count of them. pic_owed: removed pictures whose bytes Prix still owes a delete, for the sweep
-- job; a run with nothing owed reads at most one row (the seek that found nothing) and never the table.
CREATE INDEX room_messages_pic_live ON room_messages (author) WHERE pic_key IS NOT NULL;
CREATE INDEX room_messages_pic_reported ON room_messages (author) WHERE pic_state = 'reported';
CREATE INDEX room_messages_pic_owed ON room_messages (id) WHERE pic_state = 'removed' AND pic_key IS NOT NULL;

-- One row for each wallet that reported a picture: the primary key is what makes two reports of one
-- picture by one wallet, sent at once, count once. The prune deletes a report with its message.
CREATE TABLE room_picture_reports (
  message_id INTEGER NOT NULL,
  reporter TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (message_id, reporter)
) WITHOUT ROWID;

-- The bytes an admin removed, by their SHA-256, and the record of each removal. It holds no reporter's
-- address. The bytes of a removed picture are kept nowhere.
CREATE TABLE room_picture_blocks (
  sha256 TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  frames INTEGER NOT NULL,
  reports INTEGER NOT NULL
) WITHOUT ROWID;

-- One row at most in this phase, 'pictures_off': the switch that needs no deploy. `by` is an admin's
-- address, or the word 'auto' when it set itself; `why` is 'admin', 'reports_hour' or 'reports_day'.
CREATE TABLE room_flags (
  name TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  why TEXT NOT NULL
) WITHOUT ROWID;

ALTER TABLE room_writers ADD COLUMN first_at TEXT;
ALTER TABLE room_writers ADD COLUMN pictures_day TEXT;
ALTER TABLE room_writers ADD COLUMN pictures_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_writers ADD COLUMN reports_day TEXT;
ALTER TABLE room_writers ADD COLUMN reports_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_writers ADD COLUMN report_strikes INTEGER NOT NULL DEFAULT 0;
-- The fill: each writer's oldest message that is not hidden. A first line that an admin hid as spam under
-- Phase 6.3 opens neither pictures nor reports; a writer with no such message is left at null and waits
-- from its next stored message.
UPDATE room_writers SET first_at = (SELECT MIN(at) FROM room_messages WHERE author = room_writers.address AND hidden_at IS NULL);
