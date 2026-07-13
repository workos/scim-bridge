-- Last-writer-wins ledger for the native app's DSync listener.
--
-- WorkOS does not guarantee webhook delivery order: under load or on retries a
-- newer event can be delivered before an older one (observed: a group
-- membership `removed` overtaking the `added` it supersedes, leaving a stale
-- edge). The listener records, per resource/edge, the `created_at` of the most
-- recent event it has applied, and ignores any event that is older — so
-- out-of-order redeliveries can no longer resurrect superseded state.
CREATE TABLE IF NOT EXISTS listener_versions (
  scope TEXT PRIMARY KEY,
  event_at TEXT NOT NULL
);
