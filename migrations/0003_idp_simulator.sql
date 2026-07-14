-- The IdP simulator: a stateful SCIM test client that stands in for Okta.
-- It holds its own directory (the IdP's source of truth), sends real SCIM
-- requests through the proxy, and tracks the SCIM resource id each resource
-- was provisioned under — exactly as a real IdP keys on its remote id.

INSERT INTO poc_config (key, value) VALUES ('idp.public_url', 'http://localhost:8789');

CREATE TABLE IF NOT EXISTS idp_users (
  id TEXT PRIMARY KEY DEFAULT ('idpu_' || lower(hex(randomblob(8)))),
  directory_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  -- The stable external key the IdP emits as externalId (the DSync idp_id).
  external_id TEXT NOT NULL,
  given_name TEXT,
  family_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  -- The id the SCIM target (proxy) minted; null until provisioned. Used as the
  -- path id for later PUT/PATCH/DELETE, just like Okta tracks the remote id.
  scim_id TEXT,
  last_status INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idp_users_conn_username
  ON idp_users (directory_id, user_name);

CREATE TABLE IF NOT EXISTS idp_groups (
  id TEXT PRIMARY KEY DEFAULT ('idpg_' || lower(hex(randomblob(8)))),
  directory_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_id TEXT NOT NULL,
  scim_id TEXT,
  last_status INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idp_groups_conn_name
  ON idp_groups (directory_id, display_name);

CREATE TABLE IF NOT EXISTS idp_group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- Everything the simulator did, newest first in the panel: which action, on
-- which subject, the SCIM call it made through the proxy, and the response.
CREATE TABLE IF NOT EXISTS idp_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directory_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'auto', 'seed')),
  action TEXT NOT NULL,
  subject TEXT,
  method TEXT,
  path TEXT,
  status INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_idp_activity_conn ON idp_activity (directory_id, id DESC);

-- Auto-run loop state, one row per directory, written by the scheduler DO so
-- the panel can render whether the simulated IdP is currently churning.
CREATE TABLE IF NOT EXISTS idp_auto_state (
  directory_id TEXT PRIMARY KEY,
  running INTEGER NOT NULL DEFAULT 0,
  interval_ms INTEGER NOT NULL DEFAULT 4000,
  tick_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
