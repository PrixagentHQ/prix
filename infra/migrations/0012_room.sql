-- Prix, Phase 6.3: the room, a public chat between users. docs/contracts/phase-6-room.md section 2.
-- The statements are that section's, as they stand. Adds two tables; nothing in 0001 to 0009 is changed.
--
-- The number. 0010 is Prix Live's and 0011 is Phase 6.2's, and neither is on main yet, so this file can be
-- applied to a database that holds 0001 to 0009 only. The gap is expected: wrangler applies every file
-- that d1_migrations does not name, in the order of their names, and never asks that the numbers run on
-- (infra/README.md section 16). 0012 reads and writes no table of 0010 or 0011, and they none of its own.
--
-- Addresses are stored in lower case. Times are ISO text as Date.prototype.toISOString() writes them, so
-- text order is time order: the store compares at with cut_at, and last_at with a time, as text.

-- One row per message. id rises by one with every message and is the order of the room: AUTOINCREMENT, so
-- an id is never given twice, also after the prune has deleted the oldest rows. The store reads the
-- newest ids by this key and finds the prune's edge by arithmetic on it. A hidden message keeps its row.
CREATE TABLE room_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  hidden_at TEXT,
  hidden_by TEXT
);
-- The messages of one writer: the lift of a mute reads it to find the writer's newest message, and so
-- does an admin who looks one up by hand.
CREATE INDEX room_messages_author ON room_messages (author);

-- One row per wallet that took a turn or was muted: its last message, the count of its UTC day, a mute,
-- and cut_at: set by a mute, never cleared, and moved forward by a lift to the writer's newest message.
-- At or before it nothing the writer wrote is shown.
-- The room's counts of an hour and of a day are not here: they are rows of counters (0002).
CREATE TABLE room_writers (
  address TEXT PRIMARY KEY,
  last_at TEXT,
  day TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  muted_at TEXT,
  muted_by TEXT,
  cut_at TEXT
) WITHOUT ROWID;
