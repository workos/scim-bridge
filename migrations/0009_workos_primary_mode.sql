-- The fourth migration mode, `workos-primary`, plus the table that
-- records what it can leave behind.
--
-- 1. Widen the mode CHECK to admit 'workos-primary': WorkOS answers the IdP, and
--    the proxy still writes the native app directly rather than relying on DSync
--    webhooks. The rung between 'dual-write' and 'workos-only', and the only one
--    where WorkOS is authoritative while rollback stays free. SQLite cannot alter
--    a CHECK in place, so the table is rebuilt — the same reason 0007 rebuilt it.
--
-- 2. `native_write_failures`: the durable record of a native write that failed
--    while WorkOS already committed one. This deliberately does NOT live in
--    `proxy_log`, which is gated by `log_persistence` and off by default
--    (migration 0006) — a divergence that vanishes on a default directory is
--    exactly the silent drift this mode exists to disprove. Rows here are
--    written unconditionally.
CREATE TABLE scim_directories_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'passthrough'
    CHECK (mode IN ('passthrough', 'dual-write', 'workos-primary', 'workos-only')),
  proxy_token_hash TEXT NOT NULL UNIQUE,
  native_url TEXT NOT NULL DEFAULT '',
  native_token TEXT NOT NULL DEFAULT '',
  workos_url TEXT NOT NULL DEFAULT '',
  workos_token TEXT NOT NULL DEFAULT '',
  workos_directory_id TEXT,
  log_persistence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Last, because 0008 added it with ALTER TABLE ADD COLUMN on both engines and
  -- tests/schema-parity.test.ts compares column order. A rebuild is free to put
  -- the columns anywhere; Postgres, which alters its CHECK in place, is not.
  proxy_token_hint TEXT NOT NULL DEFAULT ''
);

INSERT INTO scim_directories_new (
  id, name, mode, proxy_token_hash, native_url, native_token, workos_url,
  workos_token, workos_directory_id, log_persistence, created_at, updated_at,
  proxy_token_hint
)
SELECT
  id, name, mode, proxy_token_hash, native_url, native_token, workos_url,
  workos_token, workos_directory_id, log_persistence, created_at, updated_at,
  proxy_token_hint
FROM scim_directories;

DROP TABLE scim_directories;
ALTER TABLE scim_directories_new RENAME TO scim_directories;

-- 0007 created this index; the rebuild dropped it with the old table.
CREATE UNIQUE INDEX idx_scim_directories_workos_directory_id
  ON scim_directories (workos_directory_id)
  WHERE workos_directory_id IS NOT NULL;

-- One row per diverged resource, not per failed attempt: the operator's question
-- is "which resources is native missing", and a retry loop must not be able to
-- bury that answer under thousands of rows. A repeat failure on the same
-- resource updates the row in place (`attempts`, `last_seen_at`), and a later
-- native success on it clears the row.
--
-- `resource_key` is the native-id-space key of the resource, or the request path
-- when there is no id to name (a create that never reached native).
CREATE TABLE IF NOT EXISTS native_write_failures (
  directory_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('Users', 'Groups')),
  resource_key TEXT NOT NULL,
  method TEXT NOT NULL,
  native_status INTEGER,
  detail TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (directory_id, resource_type, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_native_write_failures_directory
  ON native_write_failures (directory_id, last_seen_at DESC);
