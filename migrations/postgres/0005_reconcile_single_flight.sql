-- Postgres side of migrations/0011_reconcile_single_flight.sql: a reconcile takes
-- a per-directory claim before it stamps the divergence ledger, so a second run
-- cannot re-stamp the NULL sweep tokens the first run left to protect live
-- divergences.
ALTER TABLE scim_directories ADD COLUMN IF NOT EXISTS reconcile_token TEXT;
ALTER TABLE scim_directories ADD COLUMN IF NOT EXISTS reconcile_started_at TEXT;
