-- Postgres side of migrations/0013_native_token_partitioned.sql: the reasoning
-- lives there; tests/schema-parity.test.ts holds the two engines together.
ALTER TABLE scim_directories ADD COLUMN IF NOT EXISTS native_token_partitioned INTEGER NOT NULL DEFAULT 0;
