-- Store a digest of the proxy token instead of the token.
--
-- The column is RENAMED, not dropped and re-added, because existing rows must keep
-- their value: it is still plaintext at this point, and the boot backfill
-- (`backfillProxyTokenHashes`) rewrites each one in place. Hashing cannot be done
-- here — neither engine computes SHA-256 portably (SQLite has no builtin, Postgres
-- needs pgcrypto), so the conversion belongs in app code that runs once at boot.
--
-- That backfill pass is also the only moment `proxy_token_hint` can be populated
-- for a pre-existing row. The hint is the last 4 characters of the plaintext; once
-- the row holds only a digest there is nowhere left to read them from.
--
-- RENAME COLUMN carries the UNIQUE constraint over, which is still the constraint
-- we want: two directories cannot share a token, and they cannot share its digest
-- either. A rename is also cheap where a rebuild is not — 0007 had to rebuild this
-- table only because a CHECK constraint cannot be altered in place.
ALTER TABLE scim_directories RENAME COLUMN proxy_token TO proxy_token_hash;

ALTER TABLE scim_directories ADD COLUMN proxy_token_hint TEXT NOT NULL DEFAULT '';
