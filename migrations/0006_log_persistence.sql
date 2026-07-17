-- Per-directory log persistence toggle.
--
-- Off by default: a fleet of directories writing every SCIM request into
-- proxy_log adds up fast, so the proxy only persists logs for directories a
-- customer explicitly enables for monitoring (per-directory or in bulk from the
-- control panel). When off, requests still proxy and mirror exactly the same —
-- only the proxy_log write is skipped.
ALTER TABLE scim_directories ADD COLUMN log_persistence INTEGER NOT NULL DEFAULT 0;
