-- Postgres side of migrations/0017_divergence_write_fingerprint.sql: a live
-- write retires a divergence row only when it is the retry of the exact write
-- the row recorded, or a converged delete of the resource.
ALTER TABLE native_write_failures ADD COLUMN IF NOT EXISTS write_fingerprint TEXT;
