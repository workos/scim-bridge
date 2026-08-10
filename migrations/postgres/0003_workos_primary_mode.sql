-- The Postgres side of migrations/0009_workos_primary_mode.sql. The
-- reasoning for both the mode and the failures table lives there; this file
-- carries only what the two engines express differently, and
-- tests/schema-parity.test.ts holds the two ends together.
--
-- A new migration rather than an edit to 0001_baseline.sql: the migrator only
-- runs what it has not run, so editing an already-applied file leaves that
-- database silently on the old shape (the point 0002_hash_proxy_token.sql makes
-- at length).
--
-- Postgres can alter a CHECK in place, so this is a drop-and-add rather than the
-- table rebuild SQLite needs. The constraint name is the one Postgres generated
-- for the inline CHECK in the baseline.
ALTER TABLE scim_directories DROP CONSTRAINT scim_directories_mode_check;

ALTER TABLE scim_directories ADD CONSTRAINT scim_directories_mode_check
  CHECK (mode IN ('passthrough', 'dual-write', 'workos-primary', 'workos-only'));

CREATE TABLE IF NOT EXISTS native_write_failures (
  directory_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('Users', 'Groups')),
  resource_key TEXT NOT NULL,
  method TEXT NOT NULL,
  native_status INTEGER,
  detail TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT datetime('now'),
  last_seen_at TEXT NOT NULL DEFAULT datetime('now'),
  PRIMARY KEY (directory_id, resource_type, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_native_write_failures_directory
  ON native_write_failures (directory_id, last_seen_at DESC);
