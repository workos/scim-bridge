-- Directory migration-mode status endpoint support.
--
-- 1. Rename the mode 'dual-write' to 'dual-write'. The CHECK
--    constraint can't be altered in place, so the table is rebuilt.
-- 2. Add `workos_directory_id`: the WorkOS directory id (directory_...) this
--    row migrates. DSync webhook events carry it (`event.data.directory_id`),
--    so a customer's native app can key its per-event handle-vs-ignore
--    decision on it via GET /status/directories/{id}. Optional — the bridge's
--    own id works in the path too.
CREATE TABLE scim_directories_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'passthrough'
    CHECK (mode IN ('passthrough', 'dual-write', 'workos-only')),
  proxy_token TEXT NOT NULL UNIQUE,
  native_url TEXT NOT NULL DEFAULT '',
  native_token TEXT NOT NULL DEFAULT '',
  workos_url TEXT NOT NULL DEFAULT '',
  workos_token TEXT NOT NULL DEFAULT '',
  workos_directory_id TEXT,
  log_persistence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO scim_directories_new (
  id, name, mode, proxy_token, native_url, native_token, workos_url,
  workos_token, log_persistence, created_at, updated_at
)
SELECT
  id, name,
  CASE mode WHEN 'dualwrite-native-first' THEN 'dual-write' ELSE mode END,
  proxy_token, native_url, native_token, workos_url,
  workos_token, log_persistence, created_at, updated_at
FROM scim_directories;

DROP TABLE scim_directories;
ALTER TABLE scim_directories_new RENAME TO scim_directories;

CREATE UNIQUE INDEX idx_scim_directories_workos_directory_id
  ON scim_directories (workos_directory_id)
  WHERE workos_directory_id IS NOT NULL;
