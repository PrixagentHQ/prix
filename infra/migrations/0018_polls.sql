-- Phase 6.7: the holders' poll (docs/contracts/phase-6-holders.md section 4.2).
CREATE TABLE poll_votes (
  poll_id TEXT NOT NULL,
  wallet TEXT NOT NULL,          -- lower-case 0x address
  option_id TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- when the wallet's current choice was made, server clock
  PRIMARY KEY (poll_id, wallet)
) STRICT, WITHOUT ROWID;

-- Votes cast by option, kept beside the rows so that the public read reads one row an option.
CREATE TABLE poll_counts (
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  votes INTEGER NOT NULL CHECK (votes >= 0),
  PRIMARY KEY (poll_id, option_id)
) STRICT, WITHOUT ROWID;

-- The frozen result of a closed poll: one row an option, written once by the tally.
CREATE TABLE poll_results (
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  cast_votes INTEGER NOT NULL CHECK (cast_votes >= 0),
  counted INTEGER NOT NULL CHECK (counted >= 0 AND counted <= cast_votes),
  counted_at TEXT NOT NULL,
  first_block INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  PRIMARY KEY (poll_id, option_id)
) STRICT, WITHOUT ROWID;

-- Revision 2 (H-SEC-8): the owner's choice to show "Owner holds $PRIX" on its agents' pages, off by default.
ALTER TABLE users ADD COLUMN show_holds INTEGER NOT NULL DEFAULT 0 CHECK (show_holds IN (0, 1));
