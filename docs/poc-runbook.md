# SCIM migration PoC — runbook

This runbook walks the working proof of concept for the reversible SCIM
migration described by the static explainer at `/` (served by the panel app,
`public/index.html`) and specified in [poc-architecture.md](./poc-architecture.md):
a migration proxy sits between the IdP and two SCIM targets (the customer's
native endpoint and a WorkOS directory), mirrors writes under the migrated-id
contract, cuts over to WorkOS-only, hands the app's feed to a DSync event
listener, and can roll back to passthrough without losing anything.

| Component                   | Where                | Runs as                                    | Local port |
| --------------------------- | -------------------- | ------------------------------------------ | ---------- |
| Migration proxy             | `workers/proxy/`     | standalone Worker (`wrangler.proxy.toml`)  | 8787       |
| Native app ("the customer") | `workers/native/`    | standalone Worker (`wrangler.native.toml`) | 8788       |
| IdP simulator               | `workers/idp/`       | standalone Worker (`wrangler.idp.toml`)    | 8789       |
| Control panel               | `app/routes/panel.*` | this React Router app                      | 5173       |

The native worker also hosts a mock WorkOS directory endpoint at
`/mock-workos/scim/v2` so the whole migration runs locally with no WorkOS
account.

The **IdP simulator** is a stateful SCIM test client that stands in for Okta:
it holds its own directory, sends real SCIM requests through the proxy (keyed
by the connection's proxy token, exactly as a real Okta connection would), and
can churn the directory on its own via an auto-run loop. Drive it from the
**IdP simulator** tab in the panel — no external IdP needed.

## Run it locally

```bash
npm install
npm run db:migrate:local
```

Then four terminals:

```bash
npx react-router dev # control panel + explainer, http://localhost:5173
npm run dev:proxy    # migration proxy, http://localhost:8787
npm run dev:native   # native app + mock WorkOS, http://localhost:8788
npm run dev:idp      # IdP simulator, http://localhost:8789
```

If a worker fails to start with `Address already in use (127.0.0.1:9230)`,
the wrangler dev instances are colliding on the default inspector port; give
each a distinct one, e.g. `npm run dev:idp -- --inspector-port 9232`.

Use `npx react-router dev` to run the panel locally — it needs no secrets.
`npm run dev` is the Doppler-wrapped variant (`doppler run --project claude-day
...`) used when you need the AI-gateway env vars; it fails without Doppler
access.

`npm run dev` auto-applies pending migrations via its `predev` hook, so the
explicit `db:migrate:local` only matters if you start the workers first. All
three processes share the same local D1 database under `.wrangler/state`, so
the panel sees exactly what the workers write.

## Self-contained local demo (no WorkOS account)

The migration `0002_scim_migration_poc.sql` seeds one connection ("Default
connection") already pointed at the native endpoint. Wire its WorkOS side to
the mock:

1. Open http://localhost:5173/panel. In Global settings, note the seeded
   tokens: `native.scim_token`, `mock_workos.scim_token`, and the public URLs
   (`proxy.public_url`, `native.public_url`).
2. Open the default connection (`/panel/connections/:id`). On the WorkOS card
   set endpoint `http://localhost:8788/mock-workos/scim/v2` and bearer token =
   `mock_workos.scim_token`. Copy the connection's **proxy token** — that is
   what the IdP (or your curl) presents to the proxy.

### Drive it from the IdP simulator (recommended)

The fastest way to exercise everything is the **IdP simulator** tab
(`/panel/idp`) — no curl, no Okta:

1. Click **Seed directory** to provision a starter directory (5 users, 2
   groups) through the proxy. Watch the users appear on the **Native app** tab
   with the same ids the simulator holds.
2. On the connection page, flip the mode to **dual-write**, then **Run
   backfill** — the seeded users converge into the mock WorkOS directory under
   the migrated-id contract (check the **Mappings** tab).
3. Back on the IdP simulator, add a user or toggle a user's status and watch
   the write mirror to both sides (**Activity** tab on the connection).
4. Click **Start auto-run** to let the simulated IdP churn on its own (a
   worker-side loop that keeps running even if you close the tab). Watch the
   directory, the proxy activity log, and — after cutover — the DSync listener
   events all stay in sync. **Stop auto-run** when done.
5. Cut over to **workos-only** and confirm reads through the proxy still return
   the original ids. Roll back to **passthrough**; the native app is current.

Every simulator action is a real SCIM request through the proxy, so the
walkthrough below (what each verb looks like on the wire) still applies — the
simulator just issues them for you.

### Or drive it by hand with curl

Copy the connection's **proxy token** from the panel and export it:

```bash
PROXY_TOKEN=<proxy token from the panel>
BASE=http://localhost:8787/scim/v2
```

### 1. Passthrough — seed a user

With the connection in `passthrough` (the default):

```bash
curl -si -X POST "$BASE/Users" \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "alice@example.com",
    "name": { "givenName": "Alice", "familyName": "Nakamura" },
    "emails": [{ "primary": true, "value": "alice@example.com" }],
    "active": true
  }'
```

Expect a 201 with a native-minted `id`. WorkOS is untouched — the activity log
row has no WorkOS leg.

### 2. Flip to dual-write

On the connection page, set mode to `dualwrite-native-first`. Then create a
second user:

```bash
curl -si -X POST "$BASE/Users" \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "bob@example.com",
    "name": { "givenName": "Bob", "familyName": "Iyer" },
    "emails": [{ "primary": true, "value": "bob@example.com" }],
    "active": true
  }'
```

Copy the `id` from the response body:

```bash
BOB_ID=<id from the 201 response>
```

Create a group with Bob as a member (member `value` is the native user id):

```bash
curl -si -X POST "$BASE/Groups" \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d "{
    \"schemas\": [\"urn:ietf:params:scim:schemas:core:2.0:Group\"],
    \"displayName\": \"Engineering\",
    \"members\": [{ \"value\": \"$BOB_ID\" }]
  }"
```

In `/panel/connections/:id/activity` each of these rows now has two legs: a
native 201 first, then the mirror recorded as `PUT /Users/{id}
+X-WorkOS-Migrated-Id` (the id learned from native's 201).

### 3. Backfill

Alice predates dual-write, so she exists only in native. On the connection
page, run **Backfill**. It snapshots native (`GET /Users`, `GET /Groups`) and
replays every resource into WorkOS as a migrated-id PUT.

Inspect the result:

- `/panel/connections/:id/activity` — backfill rows carry `source = backfill`.
- `/panel/connections/:id/mappings` — one row per resource; with the mock the
  strategy is `migrated-id` and both ids are equal.
- http://localhost:8788/ — the native status page; `/panel/native` shows the
  same directory plus the listener log.

Both sides now hold alice, bob, and Engineering under the same ids.

### 4. Cut over

Set mode to `workos-only` (the panel asks you to confirm). The proxy stops
calling native entirely. Read Bob back through the proxy:

```bash
curl -s "$BASE/Users/$BOB_ID" -H "Authorization: Bearer $PROXY_TOKEN"
```

The response comes from the mock WorkOS directory — yet `"id"` is still
`$BOB_ID`. That is the migrated-id contract: WorkOS keyed its row on the
native id and echoes it back, so the IdP never sees ids change.

### 5. Feed the app through the DSync listener

After cutover the customer's app stays current through DSync events, not SCIM.

**With the mock WorkOS endpoint this happens automatically:** the mock stands
in for a migrated WorkOS directory, so every write it receives (from the proxy
in dual-write or workos-only) emits the corresponding `dsync.*` event to the
native app's listener at `/webhooks/dsync`. So in workos-only mode a write
through the proxy converges the native app with no manual step — watch the
Live state tab, or the listener log on the Native app tab. In dual-write the
listener sees the row the SCIM path already wrote and records a `skipped`
(`no transition`) — the overlap-safety property that lets you enable it before
cutover.

**With a real WorkOS directory** the listener needs WorkOS to reach your native
app: expose `http://localhost:8788` (a `cloudflared` tunnel or a deploy) and
configure a webhook in the WorkOS dashboard pointing at
`<native public url>/webhooks/dsync`. WorkOS cannot deliver to `localhost`, so
without that the listener stays empty even though the directory is syncing.

You can also simulate a delivery straight to the listener (signature
verification is off while `native.webhook_secret` is empty):

```bash
curl -si -X POST http://localhost:8788/webhooks/dsync \
  -H "Content-Type: application/json" \
  -d '{
    "id": "event_01HZDEMO0001",
    "event": "dsync.user.created",
    "created_at": "2026-07-06T12:00:00.000Z",
    "data": {
      "id": "directory_user_01HZDEMO0001",
      "directory_id": "directory_01HZDEMO",
      "idp_id": "carol@example.com",
      "username": "carol@example.com",
      "first_name": "Carol",
      "last_name": "Diaz",
      "emails": [{ "primary": true, "value": "carol@example.com" }],
      "state": "active"
    }
  }'
```

The first delivery is `applied` — the listener upserts a row keyed on
`data.idp_id` and observes the absent → active transition. Run the exact same
curl again: it is `skipped` as a `duplicate delivery` — the `event_id` dedupe
short-circuits it before any upsert. To see the other skip reason, deliver the
same data under a fresh `event_id`:

```bash
curl -si -X POST http://localhost:8788/webhooks/dsync \
  -H "Content-Type: application/json" \
  -d '{
    "id": "event_01HZDEMO0002",
    "event": "dsync.user.created",
    "created_at": "2026-07-06T12:01:00.000Z",
    "data": {
      "id": "directory_user_01HZDEMO0001",
      "directory_id": "directory_01HZDEMO",
      "idp_id": "carol@example.com",
      "username": "carol@example.com",
      "first_name": "Carol",
      "last_name": "Diaz",
      "emails": [{ "primary": true, "value": "carol@example.com" }],
      "state": "active"
    }
  }'
```

This one is `skipped` too, but as `no transition` — a new event, so it upserts,
but the row is already active so there is nothing to fire. Three distinct
outcomes: `applied` → `duplicate delivery` → `no transition`. All are on the
native status page at :8788 and in `/panel/native`.

### 6. Roll back

Set mode back to `passthrough`. The untouched native SCIM handler resumes as
the sole target, and because the listener wrote into the same native tables,
nothing went stale during cutover. Lossless, reversible.

## Exposing the endpoints for a real IdP

Okta only talks to HTTPS endpoints on the public internet, so pick one:

**Deploy the workers** (they are plain Workers with `workers_dev = true`):

```bash
npm run db:migrate:remote
npm run deploy:proxy    # -> https://cd26-scim-migration-demo-proxy.<subdomain>.workers.dev
npm run deploy:native   # -> https://cd26-scim-migration-demo-native.<subdomain>.workers.dev
```

**Or tunnel local dev** (one tunnel per worker you need reachable):

```bash
cloudflared tunnel --url http://localhost:8787   # proxy
cloudflared tunnel --url http://localhost:8788   # native (only needed for real webhooks)
```

Then repoint the connection at the deployed workers. The remote D1 seed leaves
the connection's Native endpoint as `http://localhost:8788/scim/v2`, which the
deployed proxy cannot reach. On the connection page (`/panel/connections/:id`),
edit the **Native endpoint** card to the deployed native URL —
`https://cd26-scim-migration-demo-native.<subdomain>.workers.dev/scim/v2` — and,
if you are still using the mock, edit the **WorkOS** card to
`https://cd26-scim-migration-demo-native.<subdomain>.workers.dev/mock-workos/scim/v2`.
Those per-connection endpoints are the actual routing config the proxy calls.

Separately, update `proxy.public_url` and `native.public_url` in the panel's
Global settings so the connection page shows copy-pasteable URLs. Note those
two config keys are display-only helpers — they are not routing config and
changing them does not repoint the connection.

Remember that deployed workers use the remote D1 database — tokens and
connections there are separate from your local state.

## Wiring Okta

1. Okta Admin console → **Applications → Applications → Browse App Catalog**.
2. Search for and add **"SCIM 2.0 Test App (Header Auth)"**. This catalog app
   is the one that accepts an arbitrary SCIM base URL plus a static
   `Authorization` header — exactly what the proxy expects.
3. On the app's **Provisioning** tab, click **Configure API Integration** and
   check **Enable API integration**:
   - **Base URL**: `<proxy public url>/scim/v2`
   - **API Token**: the connection's proxy token from the panel (Okta sends it
     as `Authorization: Bearer <token>`)
4. Click **Test API Credentials** — the proxy should answer the probe.
5. Under **Provisioning → To App**, enable **Create Users**, **Update User
   Attributes**, and **Deactivate Users**.
6. Assign people or groups on the **Assignments** tab; Okta provisions them
   through the proxy immediately.
7. To sync groups, use the separate **Push Groups** tab — group push is not
   part of Assignments.

Caveats:

- Okta **deactivates** rather than deletes: unassigning a user arrives as
  `PATCH { active: false }` (or a PUT with `active: false`), not a `DELETE`.
- The endpoint must be reachable over HTTPS — hence the deploy-or-tunnel step
  above. A bare `http://localhost` URL will fail the credentials test.

## Pointing at a real WorkOS directory

1. In the WorkOS dashboard, create a directory of type **Generic SCIM v2.0**
   for an organization (or have the customer create it via the Admin Portal).
2. Copy the directory's **Endpoint** and **Bearer Token** into the connection's
   WorkOS card in the panel, replacing the mock values.

On the migrated-id contract: `PUT /{kind}/{nativeId}` +
`X-WorkOS-Migrated-Id` is what the explainer specifies and what the mock
implements. If the real directory endpoint does not honor it (404/501 on the
header PUT), the proxy automatically falls back to `POST`, records the
WorkOS-minted id in `id_mappings` with `strategy = 'fallback-post'`, and
translates every id it sends (path ids, group `members[].value`) native →
WorkOS and every id it serves back WorkOS → native. The connection's Mappings
tab shows which contract is in effect per resource.

### The DSync listener leg with a real WorkOS webhook (ngrok)

After cutover the native app stays current through DSync events. With a real
directory, WorkOS delivers those events over HTTPS, so it needs to reach your
native app — `localhost` won't do. Expose it with ngrok and register the
webhook:

1. Tunnel the native worker:

   ```bash
   ngrok http 8788
   ```

   Copy the `https://…ngrok…` forwarding URL.

2. In the **Live state** tab's **DSync listener** card, turn **off** "Mock
   WorkOS emits DSync events" — otherwise the mock and the real webhook would
   both drive the listener and you'd apply every change twice.

3. Set the native app's public base URL to the ngrok URL (Global settings on
   the Connections tab), so the card's **Webhook endpoint for WorkOS** shows
   `https://…ngrok…/webhooks/dsync`. Copy it.

4. In the WorkOS dashboard, create a webhook pointing at that URL, subscribed
   to the `dsync.*` events. WorkOS shows the **signing secret once** — paste it
   into the card's **WorkOS webhook signing secret** field and save. The
   listener verifies the `WorkOS-Signature` header against it (HMAC-SHA256 of
   `timestamp.body`); leave it empty only for unsigned local deliveries.

5. Drive a change from your IdP (or the WorkOS dashboard) and watch the
   listener log on the Native app tab. WorkOS retries and may re-deliver, so
   the listener dedupes on `event.id` and fires side effects only on an
   observed transition — re-deliveries show as `skipped`.

The signing secret lives in `poc_config` under `native.webhook_secret`. If you
prefer not to use the panel field, set it directly:

```bash
npx wrangler d1 execute cd26-scim-migration-demo-db --remote \
  --command "UPDATE poc_config SET value = '<signing secret>', updated_at = datetime('now') WHERE key = 'native.webhook_secret'"
```

(Use `--local` instead of `--remote` for local dev. Note ngrok points at your
_local_ worker, so for a local run keep `--local` and the local dev servers
running.)

## Demo script (~8 steps)

The reversible-cutover story, mirroring the explainer's phases:

1. **Seed** — connection in `passthrough`; provision a user from the IdP (or
   curl). Show the activity log: native only, WorkOS silent.
2. **Dual-write** — flip to `dualwrite-native-first`; provision another user
   and a group. Show the mirror leg: `PUT +X-WorkOS-Migrated-Id` after
   native's 2xx.
3. **Backfill** — run it from the panel; the pre-dual-write user appears in
   WorkOS under its native id. Show the mappings tab.
4. **Converged** — both directories hold the same resources under the same
   ids (native status page vs. a GET through the proxy).
5. **Cutover** — flip to `workos-only`; GET a user through the proxy and point
   at the unchanged id. The proxy has gone silent toward native.
6. **Listener-only** — deliver (or simulate) a DSync event; show `applied` on
   the first delivery and `skipped` on the redelivery — side effects fire on
   transitions, not receipt.
7. **Prove freshness** — the listener wrote the native tables, so native never
   went stale during cutover.
8. **Rollback** — flip back to `passthrough`; the untouched native handler
   resumes and nothing was lost.

## Known sharp edges

- **The backfill delete race.** A `DELETE` landing mid-backfill can be undone
  by the snapshot replay ("carol resurrected") — see the explainer's backfill
  race section at `/` for the interleaving and the four fixes. The reference
  proxy is intentionally unguarded here: `runBackfill` trusts its snapshot and
  its PUT is an unconditional upsert.
- **Truncated bodies.** The activity log stores request/response bodies
  truncated at 8 KB; large list responses end in `… [truncated]`.
- **Single-tenant trust model.** The panel has no auth of its own — it is
  meant to sit behind Cloudflare Access. The only secret the IdP holds is the
  per-connection proxy token; anyone with panel access can read every token
  and flip modes.
