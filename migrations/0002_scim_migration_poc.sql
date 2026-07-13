-- SCIM migration PoC: proxy connections, id mappings, request log,
-- native app directory tables, listener event log, and shared config.

CREATE TABLE IF NOT EXISTS poc_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The native app's own SCIM bearer token (what the proxy must present).
INSERT INTO poc_config (key, value) VALUES ('native.scim_token', lower(hex(randomblob(16))));
-- Optional WorkOS webhook secret for the native app's DSync listener.
INSERT INTO poc_config (key, value) VALUES ('native.webhook_secret', '');
-- Bearer token for the mock WorkOS SCIM endpoint hosted by the native worker.
INSERT INTO poc_config (key, value) VALUES ('mock_workos.scim_token', lower(hex(randomblob(16))));
-- Public base URLs, shown in the control panel so you can copy/paste into Okta.
INSERT INTO poc_config (key, value) VALUES ('proxy.public_url', 'http://localhost:8787');
INSERT INTO poc_config (key, value) VALUES ('native.public_url', 'http://localhost:8788');

-- One row per IdP connection: the pairing between a native SCIM endpoint and
-- a WorkOS directory SCIM endpoint, plus the proxy mode and credentials.
CREATE TABLE IF NOT EXISTS scim_connections (
  id TEXT PRIMARY KEY DEFAULT ('conn_' || lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'passthrough'
    CHECK (mode IN ('passthrough', 'dualwrite-native-first', 'workos-only')),
  -- Bearer token the IdP (Okta) presents to the proxy. Routes the request to
  -- this connection.
  proxy_token TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(24)))),
  -- Native SCIM base URL (ends with /scim/v2) + credential the proxy uses.
  native_url TEXT NOT NULL DEFAULT '',
  native_token TEXT NOT NULL DEFAULT '',
  -- WorkOS directory SCIM endpoint + bearer token from the WorkOS dashboard.
  workos_url TEXT NOT NULL DEFAULT '',
  workos_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO scim_connections (name, native_url, native_token) VALUES (
  'Default connection',
  'http://localhost:8788/scim/v2',
  (SELECT value FROM poc_config WHERE key = 'native.scim_token')
);

-- native_id -> workos_id per resource. With the migrated-id contract
-- (PUT + X-WorkOS-Migrated-Id) both sides share the native id and strategy is
-- 'migrated-id'. When the WorkOS endpoint rejects the contract the proxy
-- falls back to POST and records the WorkOS-minted id ('fallback-post').
CREATE TABLE IF NOT EXISTS id_mappings (
  connection_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('Users', 'Groups')),
  native_id TEXT NOT NULL,
  workos_id TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('migrated-id', 'fallback-post')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id, resource_type, native_id)
);

CREATE INDEX IF NOT EXISTS idx_id_mappings_workos
  ON id_mappings (connection_id, resource_type, workos_id);

-- Every request the proxy handles, with both legs' outcomes.
CREATE TABLE IF NOT EXISTS proxy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'idp' CHECK (source IN ('idp', 'backfill')),
  mode TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_body TEXT,
  -- Native leg
  native_status INTEGER,
  native_ms INTEGER,
  native_body TEXT,
  -- WorkOS (mirror or sole) leg; workos_request records the translated shape,
  -- e.g. 'PUT /Users/{id} +X-WorkOS-Migrated-Id'.
  workos_request TEXT,
  workos_status INTEGER,
  workos_ms INTEGER,
  workos_body TEXT,
  -- What the proxy returned to the IdP.
  response_status INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_proxy_log_connection ON proxy_log (connection_id, id DESC);

-- The customer app's own directory tables, written by its native SCIM handler
-- and (after cutover) by its DSync event listener.
CREATE TABLE IF NOT EXISTS native_users (
  id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL UNIQUE,
  external_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS native_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  external_id TEXT,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS native_group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- Mock WorkOS directory: a stand-in SCIM target hosted by the native worker at
-- /mock-workos/scim/v2 that honors the migrated-id contract, so the whole
-- migration can be exercised locally before pointing at a real WorkOS
-- directory endpoint.
CREATE TABLE IF NOT EXISTS mock_workos_users (
  id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL UNIQUE,
  external_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mock_workos_groups (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  external_id TEXT,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mock_workos_group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- Every DSync event the native app's listener received and what it did:
-- applied (state transition observed), skipped (no transition), or ignored.
CREATE TABLE IF NOT EXISTS listener_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  event_id TEXT,
  event_type TEXT NOT NULL,
  idp_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('applied', 'skipped', 'ignored')),
  detail TEXT,
  payload TEXT
);
