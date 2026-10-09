-- Prix, one continuous league (docs/DECISIONS.md D-109, docs/CONTRACTS.md section 19).
--
-- Season 1 becomes the only season and never ends: its ends_at moves to ONE_LEAGUE_ENDS_AT
-- (packages/contracts/src/phase2-reputation.ts), so season_lifecycle never opens a next season,
-- never freezes this one, and nothing resets. Nothing else changes.
--
-- Safe on production with 0001 to 0007 applied and 0008 not applied: it reads and writes only
-- the seasons table of 0001. Without a season 1 it changes nothing; run twice, it is the same.
UPDATE seasons SET ends_at = '2099-12-31T00:00:00.000Z' WHERE number = 1;
