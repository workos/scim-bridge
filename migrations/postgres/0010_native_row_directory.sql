-- Postgres side of migrations/0016_native_row_directory.sql: the reasoning
-- lives there; tests/schema-parity.test.ts holds the two engines together.
ALTER TABLE native_users ADD COLUMN IF NOT EXISTS directory_id TEXT;
ALTER TABLE native_groups ADD COLUMN IF NOT EXISTS directory_id TEXT;
