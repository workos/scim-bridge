# Architecture

scim-bridge is a single Node process that puts a reversible SCIM migration proxy
in front of a customer's existing SCIM endpoint and mirrors changes into WorkOS
Directory Sync. It also runs on Cloudflare Workers + D1; the same code and
migrations serve both.

## Process layout

A [Hono](https://hono.dev) server (`server/index.ts`) routes by path:

- `POST/GET/... /scim/v2/*` → **the migration proxy** (`workers/proxy`), the
  SCIM data-plane. Authenticated per request by the directory's `proxy_token`.
- `GET /status/directories/{id}` → the directory's migration-mode status
  (`native_authoritative`), polled by the customer's DSync listener.
  Authenticated by the directory's `proxy_token`; `{id}` accepts the bridge's
  directory id or the directory's WorkOS id (`workos_directory_id`).
- `/healthz` → liveness probe.
- `/__demo/*` → the bundled IdP + native-app simulators (`DEMO_MODE` only).
- everything else → the **control panel** (`app/`, React Router SSR).

Shared logic lives in `workers/shared`: `scim.ts` (translation + id rewriting),
`db.ts` (data access), `backfill.ts`, `crypto.ts` (at-rest secret encryption),
`types.ts`. The panel and the proxy share one database.

## Data model

Every `env.DB` caller talks to one narrow interface — `Datastore` in
`workers/shared/datastore.ts`: `prepare().bind().first()/.all()/.run()`,
`batch()` (atomic in every driver), and the at-rest encryption key. Drivers
implement it; `server/db/sqlite.ts` is the file-backed one and the default.
Migrations in `migrations/*.sql` are applied on boot — `server/db/migrate.ts`
orders the files, the driver's `DatastoreMigrator` applies them and owns the
`_migrations` ledger, since migration SQL is dialect-specific.

| Table | Holds |
| --- | --- |
| `scim_directories` | One row per directory being migrated: `mode`, `proxy_token` (IdP→proxy; minted at import, or the token the IdP already presents when one is imported), native URL + token, WorkOS URL + token, `workos_directory_id` (the `directory_...` id DSync events carry). |
| `id_mappings` | native id ↔ WorkOS id per resource, with the strategy used (`migrated-id` or `fallback-post`). |
| `proxy_log` | Every proxied request, both legs — the panel's Activity view. |
| `listener_events` / `listener_versions` | The demo DSync listener's log and last-writer-wins ledger. |
| `poc_config` | Global key/value settings (public URLs, demo tokens). |

The native/WorkOS **bearer tokens are encrypted at rest** (AES-256-GCM) when
`APP_ENCRYPTION_KEY` is set; the `proxy_token` is not, because it is the lookup
key. See `workers/shared/crypto.ts`.

## Migration modes (per directory)

`scim_directories.mode` advances the migration; both systems stay written
throughout until the deliberate cutover.

1. **`passthrough`** — forward to the native endpoint only. Native authoritative.
2. **`dual-write`** — handle natively, respond to the IdP, then
   mirror the full resource to WorkOS. Native authoritative. **Backfill** runs in
   this mode: idempotently copy live native state into WorkOS via the same upsert.
3. **`workos-only`** — write WorkOS first; the customer's app now provisions from
   WorkOS Directory Sync events. The point of no return.

Rollback before cutover is lossless: drop back toward `passthrough` and keep
serving from the native system, which stayed current.

## The migrated-id contract

The IdP keys later operations by the id the customer's system minted
(`PATCH /Users/{id}`). So for a migrated WorkOS directory the canonical id flips
to that id, and the `X-WorkOS-Migrated-Id` header carries it. Post-decoupling
only **POST** creates a WorkOS scim row — `PUT`/`PATCH`/`DELETE` resolve strictly
by id and `404` on a miss. So the proxy runs the standard SCIM dance:

1. `PUT /{kind}/{id}` + the header — updates in place when the resource exists.
2. On `404` (an expected first touch, not an error): `POST /{kind}` + the same
   header, which WorkOS adopts and echoes back as the resource id.
3. On `POST 409` (a concurrent create won the race): retry the `PUT`, which now
   resolves the winner's row — the bridge owns that race.

The dance is invisible at the IdP boundary: a create answers `201` and a replace
answers `200`, whichever leg resolved — a create whose `PUT` found the resource
already under the minted id is an idempotent create of the same resource (the id
comes from the IdP's `externalId`), not a conflict.

The IdP never sees a WorkOS-internal id. When WorkOS doesn't honor the header
(e.g. the `external_id` gate is off) the POST mints its own id; the proxy detects
the diverging echoed id and records a `fallback-post` mapping instead so ids
still translate in both directions. Resources born after cutover mint their id
from the IdP `externalId`, so one shared id spans all three systems
(rollback-safe).

## Multi-directory

The proxy is **multi-directory**: one instance serves many directories, each
routed by its own `proxy_token`, each with independent credentials and mode. The
bundled simulator models a single directory; the reference DSync listener
(`workers/native/listener.ts`) resolves each event's directory and mode
per-directory (`directoryModeForEvent`) by polling
`GET /status/directories/{id}` through `workers/native/status-client.ts` — the
same contract a customer's own listener uses (see
[listener-status.md](./listener-status.md)).
