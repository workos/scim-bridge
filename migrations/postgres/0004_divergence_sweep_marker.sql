-- Postgres side of migrations/0010_divergence_sweep_marker.sql: the reconcile
-- sweep stamps the divergence rows it captured and deletes only rows still
-- carrying that stamp, so a row deleted and re-created mid-reconcile can no
-- longer pass for the row it replaced (VULN-3086).
ALTER TABLE native_write_failures ADD COLUMN IF NOT EXISTS sweep_token TEXT;
