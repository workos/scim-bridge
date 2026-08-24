-- Per-directory attestation: "my native SCIM app isolates rows by bearer token".
--
-- Off by default. When every directory on one canonical native URL carries this
-- flag AND a non-empty native token distinct from its neighbours', the namespace
-- checks treat them as disjoint — the namespace identity becomes (URL, token)
-- instead of URL alone. Anything short of that keeps the fail-closed answer:
-- the bridge cannot verify the customer's app actually partitions by credential,
-- so this column records the operator's explicit promise, not a fact the bridge
-- established. See workers/shared/native-namespace.ts for the rule.
ALTER TABLE scim_directories ADD COLUMN native_token_partitioned INTEGER NOT NULL DEFAULT 0;
