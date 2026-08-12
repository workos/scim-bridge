-- Ordered log of the DSync events the bundled mock WorkOS emits, served from
-- its GET /events endpoint with `after` cursor pagination — the same contract
-- as the real Events API — so the polling transport can be exercised in demo
-- mode and in tests without a real WorkOS environment. `seq` is the emission
-- order the cursor pages over; `id` is the envelope id a poller persists as
-- its cursor.
CREATE TABLE IF NOT EXISTS mock_workos_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
