-- Serialize creates before their upstream writes, while native's id is unknown.
-- Do not expire claims: an old request can still be writing to either upstream.
CREATE TABLE workos_primary_create_claims (
  directory_id TEXT NOT NULL REFERENCES scim_directories(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('Users', 'Groups')),
  token TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (directory_id, resource_type)
);
