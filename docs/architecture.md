# Architecture

scim-bridge is a single Node process that puts a reversible SCIM migration proxy
in front of a customer's existing SCIM endpoint and mirrors changes into WorkOS
Directory Sync. It also runs on Cloudflare Workers + D1; the same code and
migrations serve both.

## Process layout

A [Hono](https://hono.dev) server (`server/index.ts`) routes by path:

- `POST/GET/... /scim/v2/*` → **the migration proxy** (`workers/proxy`), the
  SCIM data-plane. Authenticated per request by the directory's `proxy_token`.
- `/healthz` → liveness probe.
- `/__demo/*` → the bundled IdP + native-app simulators (`DEMO_MODE` only).
- everything else → the **control panel** (`app/`, React Router SSR).

Shared logic lives in `workers/shared`: `scim.ts` (translation + id rewriting),
`db.ts` (data access), `backfill.ts`, `crypto.ts` (at-rest secret encryption),
`types.ts`. The panel and the proxy share one database.

## Data model (SQLite / D1)

`server/db/d1-sqlite.ts` wraps a SQLite file in the small slice of the D1 API the
code uses (`prepare().bind().first()/.all()/.run()`, `batch()`), so every
`env.DB` caller runs unchanged on either runtime. Migrations in `migrations/*.sql`
are applied on boot (`server/db/migrate.ts`).

| Table | Holds |
| --- | --- |
| `scim_directories` | One row per directory being migrated: `mode`, `proxy_token` (IdP→proxy), native URL + token, WorkOS URL + token. |
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
2. **`dualwrite-native-first`** — handle natively, respond to the IdP, then
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
per-directory (`directoryModeForEvent`).
