-- Phase 4 hardening (security review finding 12): a tier rises only when two reads at least
-- 60 minutes apart both show it. `rise_tier` is the highest tier every read since `rise_since`
-- has shown; both are NULL when no rise is pending. A tier falls at the first read that shows less.
ALTER TABLE token_holders ADD COLUMN rise_tier INTEGER CHECK (rise_tier IS NULL OR rise_tier BETWEEN 1 AND 3);
ALTER TABLE token_holders ADD COLUMN rise_since TEXT;
