# Runbook

Operating a scim-bridge deployment: deploy, import directories, run the
migration, and roll back. For install/config basics see the [README](../README.md);
for the migration's design see [architecture.md](./architecture.md).

## Deploy

```bash
cp .env.example .env    # set PUBLIC_URL (externally reachable), a persistent DATABASE_PATH volume
docker compose up -d --build
```

Health: `GET /healthz` → `{"ok":true}`. Migrations apply on boot. Put the panel
behind auth (`PANEL_AUTH_USER`/`PANEL_AUTH_PASSWORD`, or your own reverse proxy)
and set `APP_ENCRYPTION_KEY` so per-directory tokens are encrypted at rest.

## Choose a datastore

`DATABASE_DRIVER` decides what the container writes to. Run **one instance** against
either: the proxy serialises writes per directory and the DSync listener's dedup is
check-then-act, so a second instance is not safe yet regardless of the engine.

| | `sqlite` (default) | `postgres` |
| --- | --- | --- |
| Set | `DATABASE_PATH` (mount a volume) | `DATABASE_URL` |
| Good for | docker compose, EC2, ECS+EFS | anyone already running RDS/Aurora |
| Backups | your volume snapshots, or [Litestream](https://litestream.io) to S3 | whatever backs up the rest of your Postgres |
| Migrations | `migrations/*.sql` | `migrations/postgres/*.sql` |

```bash
DATABASE_DRIVER=postgres
DATABASE_URL=postgres://bridge:secret@scim-bridge-db.abc.eu-west-1.rds.amazonaws.com:5432/bridge
```

Both drivers apply their migrations on boot and are safe to restart. Switching
driver does **not** move data: export the directories you care about (name, WorkOS
directory id, proxy token) and re-import them on the other side.

On **Cloudflare-hosted** deployments use Postgres or a durable volume — not D1.
The container is a Node process and D1 bindings live in the Worker, so reaching D1
would mean a query proxy per statement or losing atomic batches.

## Import directories

Open `/panel`.

- **One directory** → *Import directory*: name, your native SCIM base URL + token,
  and the WorkOS directory endpoint + token (from the WorkOS dashboard). The
  optional **Existing IdP bearer token** field is the proxy token to use — see
  [zero IdP-touch](#zero-idp-touch-deployment) below.
- **Many** → *Bulk import*: paste CSV
  `name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token`
  (header optional; only the name is required). `proxy_token` is the last column
  and optional, so six-column CSVs written before it existed import unchanged.
  See [workos-directory-provisioning.md](./workos-directory-provisioning.md)
  for producing the WorkOS side in bulk.

Then copy the directory's **SCIM base URL + proxy token** into your IdP's SCIM
config. It starts in `passthrough`, so repointing the IdP changes no behavior —
every request still reaches your native app.

### Zero IdP-touch deployment

The proxy resolves a directory by the bearer token the IdP presents, so there are
two ways to put the bridge in front of a directory:

| | The IdP admin must… | Proxy token |
| --- | --- | --- |
| **Repoint** | change the SCIM base URL (and the token) in the IdP | minted at import; copy it into the IdP |
| **DNS swap** | nothing | import the token the IdP already presents |

The DNS swap is the one the product promises for end customers: you own the
hostname the IdP already calls, so you point it at the bridge and import that
directory's existing bearer token as its `proxy_token`. The IdP keeps sending the
same URL and the same token, and the bridge routes on it. Nothing about the
migration itself differs — the directory still starts in `passthrough`.

Constraints worth knowing before you plan a swap:

- **A token can only belong to one directory.** `proxy_token` is unique and is
  the routing key; a duplicate is refused per row at import naming the conflict.
  A native app that issued **one shared token to every enterprise customer**
  therefore cannot be token-routed at all — that needs a different routing key
  (hostname or path per tenant) and is not supported today.
- **Imported tokens are stored as-is**, like minted ones: `APP_ENCRYPTION_KEY`
  covers the native/WorkOS upstream tokens, not the routing key the proxy must
  look up on every request.
- A too-short value is rejected at import (a truncated paste would 401 every
  SCIM request instead of failing here).
- **The token is set at import only.** The directory page shows it read-only;
  there is no in-place rotation, and re-importing means deleting the directory
  (which drops its id mappings). Get it right while the directory is being
  created.

## Run the migration

Advance the directory's mode from its page, verifying convergence in the
**Activity** and **Mappings** tabs at each step:

1. **passthrough** → confirm requests flow through to native unchanged.
2. **dual-write (native-first)** → new writes now also mirror to WorkOS.
3. **Run backfill** → copies existing native state into WorkOS (idempotent;
   safe to re-run). Requires dual-write on.
4. Verify parity (Mappings shows a WorkOS id per resource).
5. **Cut over to workos-only** → confirm the AlertDialog. WorkOS is now
   authoritative; provision your app from WorkOS Directory Sync events (the
   listener in `workers/native/listener.ts` is a reference implementation).
   Wire your listener's handle-vs-ignore decision to the directory's status
   endpoint — `GET /status/directories/{id}`, shown on the directory page —
   see [listener-status.md](./listener-status.md).

**Rollback:** before cutover, move the mode back toward passthrough — the native
system stayed current, so no data is lost. After cutover (`workos-only`), native
is kept current by the DSync listener; if you're unsure it stayed caught up, run
**Reconcile from WorkOS** on the directory page first — it snapshots the live
WorkOS directory and replays every resource back into native, guaranteeing parity
before you flip the mode back.

Two properties make this safe:

- **Id-preserving.** When the listener creates a resource from an event it adopts
  the event's WorkOS resource id (`data.id`), which for a migrated directory is
  the pre-migration shared id and for a resource born after cutover is the id
  WorkOS minted from the IdP `externalId`. Either way native, WorkOS, and the
  proxy address the resource by one id, so reconcile's `PUT /Users/{id}` lands on
  the same row.
- **Functional even when ids drift.** Ids don't actually have to match for
  rollback to work: the proxy translates through the `id_mappings` table, so a
  native row under a *different* id but with a mapping row is addressable end to
  end. What breaks rollback is a resource with **no** mapping — the case the
  reconcile below repairs.

**Repairing a directory whose ids already drifted.** A directory cut over before
this listener fix may hold native rows under the IdP id while WorkOS holds the
shared id (e.g. an offboard-then-rehire re-created the row under `idp_id`). Run
**Reconcile from WorkOS** and read its summary:

- Lines like `Users/{sharedId}: id drift — userName "…" is native id {driftedId},
  WorkOS holds {sharedId}; reconciled via mapping` mean reconcile found the
  drifted native row by its `userName`/`displayName`, updated it in place, and
  wrote the mapping — the directory is now rollback-safe with no further action.
- A line ending `native returned 409 (… drift unresolved)` means the collision
  couldn't be attributed to a row (the userName/displayName didn't resolve);
  investigate that resource by hand.

Reconcile never deletes a native row to fix an id: native is the customer's own
app, where a `DELETE` deprovisions a real person (session revocation, data
archival, downstream cascades). Hand-deleting a native row to force ids to line
up is a last resort — do it only with those side effects understood.

## Run the image as the customer-app stand-in

For an end-to-end rehearsal against real WorkOS you need something on the other
side of the proxy. `APP_ROLE=native-app` deploys this same image a second time as
that app: the bundled native worker serves every route at the root — SCIM at
`/scim/v2`, the DSync listener at `/webhooks/dsync`, `/healthz`, and its live
state at `/` — with no proxy, no panel, and no simulators (so `PANEL_AUTH_*` and
`DEMO_MODE` do nothing here). Give it its own `DATABASE_PATH` volume.

```bash
APP_ROLE=native-app
PUBLIC_URL=https://app.acme-demo.com          # where WorkOS and the bridge reach it
NATIVE_SCIM_TOKEN=…                           # what the bridge presents to /scim/v2
WEBHOOK_SECRET=whsec_…                         # from the WorkOS webhook endpoint
BRIDGE_STATUS_URL=https://scim-bridge.acme.com # the BRIDGE container, not this one
DIRECTORIES_JSON=[{"workos_directory_id":"directory_01HXYZ","proxy_token":"…","name":"Acme"}]
```

Wiring it up, per directory:

1. On the **bridge**, import the directory with this app's `<PUBLIC_URL>/scim/v2`
   + `NATIVE_SCIM_TOKEN` as its native endpoint, and set its **WorkOS directory
   id** — the stand-in's status lookups are keyed on it.
2. Copy that directory's `workos_directory_id` and `proxy_token` into
   `DIRECTORIES_JSON`. Each entry becomes a row in the stand-in's own
   `scim_directories` keyed *by the WorkOS directory id*, which is both what an
   event's `data.directory_id` resolves against and an id the bridge's
   `GET /status/directories/{id}` accepts for that token.
3. In the WorkOS dashboard, point a webhook endpoint at
   `<PUBLIC_URL>/webhooks/dsync` and set its signing secret as `WEBHOOK_SECRET`.
   The container refuses to start without one: the endpoint is publicly routable,
   and an unverified listener would apply anything posted to it.

`DIRECTORIES_JSON` is the authoritative set, reconciled on every boot — rows it
no longer declares are deleted, so removing a directory (or moving its token to a
new directory id) takes effect on the next restart with no manual cleanup.

The listener applies an event only when its `directory_id` matches a declared
directory *and* the bridge reports `workos-only` for it (see
[listener-status.md](./listener-status.md)). If `BRIDGE_STATUS_URL` is
unreachable it falls back to the seeded row, which stays at `passthrough` —
events are logged as ignored rather than applied, so a cutover that looks inert
is the first thing to check there.

## Self-contained demo

`DEMO_MODE=true` mounts a simulated IdP + native app and seeds a pre-wired "Demo
directory", so you can drive the whole loop with no real IdP or WorkOS account.
Use the panel's **Live state** and **IdP simulator** tabs to seed and churn the
directory and watch it converge.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Proxy returns 401 | The IdP's bearer token must equal the directory's `proxy_token`. |
| Proxy returns 401 and the token looks right | Check the header shape. `Authorization: Bearer <token>` (any casing of the scheme) and a bare `Authorization: <token>` both authenticate, so it doesn't matter whether the IdP adds the prefix or sends the field verbatim; any other scheme (`Basic …`) does not. The one shape that still fails is a doubled prefix — typing `Bearer <token>` into an IdP that then adds its own. |
| Proxy returns 502 | The native (passthrough/dual-write) or WorkOS (workos-only) endpoint is unreachable — verify the URL/token with the directory page's test buttons. |
| WorkOS answers 400 `invalidSyntax` on a mirror or backfill | An attribute the native app sent as `null` where WorkOS expects a string. The bridge drops null-valued keys from every WorkOS-bound resource body, so this should only appear on a `PATCH` (whose `Operations` are deliberately left alone — a null there can be a meaningful remove) or for a genuinely malformed value. |
| Mappings show `fallback-post` | The migrated-id contract wasn't active for that WorkOS directory (flag/`migrated`/`created_at` prerequisites) — ids aren't shared. |
| Tokens look like `enc:v1:…` in the DB | Expected — they're encrypted at rest. Never change `APP_ENCRYPTION_KEY` after writing, or they become unreadable. |
| Panel 500s after setting a key | The key changed since tokens were written; restore the original `APP_ENCRYPTION_KEY`. |
| Stand-in ignores every DSync event | Its `DIRECTORIES_JSON` entry must carry the directory's WorkOS id and proxy token, the bridge's row must have that WorkOS id set, and `BRIDGE_STATUS_URL` must reach the bridge — otherwise the mode reads as pre-cutover. |
