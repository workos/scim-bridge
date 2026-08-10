-- Store a digest of the proxy token instead of the token.
-- The SQLite side of this is migrations/0008_hash_proxy_token.sql; the reasoning
-- lives there, and tests/schema-parity.test.ts holds the two ends together.
--
-- Written as its own migration rather than folded into 0001_baseline.sql even
-- though no Postgres deployment predates it: editing a migration that has already
-- been applied anywhere (including a developer's own database) leaves that database
-- silently on the old shape, since the migrator only ever runs what it has not run.
ALTER TABLE scim_directories RENAME COLUMN proxy_token TO proxy_token_hash;

ALTER TABLE scim_directories ADD COLUMN proxy_token_hint TEXT NOT NULL DEFAULT '';
