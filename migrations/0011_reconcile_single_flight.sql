-- The reconcile's sweep stamp (migrations/0010) protects a divergence recorded by
-- live workos-primary traffic mid-run by leaving that row's `sweep_token` NULL.
-- The stamp is a single mutable column and `markDivergencesForSweep` re-stamps
-- every row of the directory, so a second reconcile starting while the first is
-- still replaying launders the first run's protective NULLs into its own stamp and
-- clears them — while the first run's older snapshot replays the pre-change state
-- back into the native app (VULN-3092).
--
-- The stamp protocol only holds for one reconcile per directory at a time, and
-- nothing enforced that. These columns are the claim a run takes before it stamps:
-- the claim is a conditional UPDATE, so a second run cannot start while one holds
-- it, and `reconcile_started_at` lets a claim orphaned by a crash time out instead
-- of blocking the directory forever.
ALTER TABLE scim_directories ADD COLUMN reconcile_token TEXT;
ALTER TABLE scim_directories ADD COLUMN reconcile_started_at TEXT;
