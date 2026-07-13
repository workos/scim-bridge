# SCIM migration PoC — architecture

Implements the design described by the static explainer at `public/index.html`
("Cutover — a reversible SCIM migration") as a working proof of concept.

## Components

| Component                   | Where                | Runs as                                    | Local port |
| --------------------------- | -------------------- | ------------------------------------------ | ---------- |
| Migration proxy             | `workers/proxy/`     | standalone Worker (`wrangler.proxy.toml`)  | 8787       |
| Native app ("the customer") | `workers/native/`    | standalone Worker (`wrangler.native.toml`) | 8788       |
| IdP simulator               | `workers/idp/`       | standalone Worker (`wrangler.idp.toml`)    | 8789       |
| Control panel               | `app/routes/panel.*` | this React Router app                      | 5173       |

They share one D1 database (`cd26-scim-migration-demo-db`). Schema:
`migrations/0002_scim_migration_poc.sql` (proxy/native) and
`migrations/0003_idp_simulator.sql` (IdP simulator). Shared types and helpers:
`workers/shared/`.

```
IdP simulator ──SCIM──▶ proxy ──▶ native /scim/v2 (customer app, own DB tables)
                          └────▶ WorkOS directory SCIM endpoint (mirror / sole target)
WorkOS ──DSync webhooks──▶ native /webhooks/dsync (the "one new component")
panel ──D1──▶ connections, mode, credentials, mappings, request log, IdP directory
```

The **IdP simulator** (`workers/idp/`) stands in for Okta: it owns a directory
in its own `idp_*` tables (`0003`), sends real SCIM requests through the proxy
keyed by the connection's `proxy_token`, and tracks the SCIM resource id each
resource was provisioned under (like a real IdP keying on its remote id). Its
manual actions run synchronously; an auto-run loop (a Durable Object,
`IdpScheduler`, with a self-rescheduling alarm) performs randomized realistic
mutations on an interval until stopped. HTTP surface: `/state`, `/action`,
`/seed`, `/reset`, `/auto/start`, `/auto/stop`. Config key `idp.public_url`.

## Modes (per connection, `scim_connections.mode`)

- `passthrough` — every read and write goes to native; WorkOS untouched.
  Rollback landing spot.
- `dualwrite-native-first` — write native first; only on a native 2xx, mirror
  the write into WorkOS via the migrated-id contract. Reads served from
  native. The IdP response always comes from native (authoritative).
- `workos-only` — cutover. WorkOS is the only SCIM target; the proxy goes
  silent toward native. The customer's DSync listener becomes the app's feed.

## The migrated-id contract

Creates/replaces mirror as `PUT /{kind}/{nativeId}` with header
`X-WorkOS-Migrated-Id: {nativeId}` (create-if-absent keyed on the native id).
WorkOS echoes that id on reads, so the IdP never sees ids change.

Per-request translation (dual-write mode):

| Inbound (IdP → proxy) | Mirror to WorkOS           | Notes                                     |
| --------------------- | -------------------------- | ----------------------------------------- |
| `POST /Users`         | `PUT /Users/{id}` + header | id learned from native's 201              |
| `PUT /Users/{id}`     | `PUT /Users/{id}` + header | full replace                              |
| `PATCH /Users/{id}`   | `PATCH /Users/{id}`        | verbatim, no header                       |
| `DELETE /Users/{id}`  | `DELETE /Users/{id}`       | exposed to the backfill race              |
| Groups                | same shape as Users        | PATCH members[].value are native user ids |
| `GET` (any)           | never mirrored             | reads resolve from the mode's read side   |

Fallback: if the WorkOS endpoint does not honor the migrated-id contract
(404/501 on the header PUT), the proxy falls back to `POST` and records the
WorkOS-minted id in `id_mappings` (`strategy = 'fallback-post'`). All ids sent
to WorkOS (path ids, group `members[].value`) are translated native → workos
through `id_mappings` with identity as the default; responses served from
WorkOS in `workos-only` mode are translated back workos → native.

## Backfill

Snapshot native (`GET /Users`, `GET /Groups`, paginated), replay each resource
into WorkOS as a migrated-id PUT. Lives in `workers/shared/backfill.ts` as
`runBackfill(db, connection): Promise<BackfillSummary>`; invoked from the
control panel. Log entries carry `source = 'backfill'`. The delete race
described on the explainer page is intentionally left open (reference
behavior), and documented in the runbook.

## Native app surface

- `GET /` — HTML status page: users, groups, listener event log.
- `/scim/v2/*` — SCIM 2.0 server, bearer auth via `poc_config
'native.scim_token'`: Users + Groups CRUD, `filter=userName eq` /
  `displayName eq`, `startIndex`/`count` pagination, PATCH (active flag,
  attribute replace, group membership add/remove incl.
  `members[value eq "…"]` paths), `ServiceProviderConfig`.
- `POST /webhooks/dsync` — the DSync event listener: every handler is an
  upsert keyed on `idp_id` (the IdP external key — externalId/userName), side
  effects only on observed state transitions; outcomes recorded in
  `listener_events` (`applied` / `skipped` / `ignored`). Signature
  verification via `poc_config 'native.webhook_secret'` when set.
- `/mock-workos/scim/v2/*` — a mock WorkOS directory endpoint (separate
  `mock_workos_*` tables, bearer auth via `poc_config
'mock_workos.scim_token'`) that honors the migrated-id contract
  (`PUT /{kind}/{id}` + `X-WorkOS-Migrated-Id` = create-if-absent keyed on
  that id; plain PUT to an absent id = 404). Lets the full migration run
  locally with no WorkOS credentials; swap the connection's WorkOS endpoint
  for a real directory later.

## Control panel routes

- `/panel` — connections list + create.
- `/panel/connections/:id` — mode control (cutover/rollback confirms), native
  and WorkOS endpoint/credential config, proxy token + IdP base URL to paste
  into Okta, backfill trigger, endpoint health checks.
- `/panel/connections/:id/activity` — proxy request log.
- `/panel/connections/:id/mappings` — id mappings.
- `/panel/live` — the live-state console: a flow rail that doubles as the
  proxy-mode control, a convergence banner, and a reconciliation matrix of
  users and groups across all three stores (native, WorkOS, IdP) with
  divergence highlighted. WorkOS state is read live over SCIM, so it reflects
  the mock or a real directory. Auto-refreshes; also hosts backfill and
  reset-native controls.
- `/panel/native` — the native app's directory + listener log (both sides of
  the migration visible), with a reset-native-app control.
- `/panel/idp` — the IdP simulator: the simulated directory, manual action
  controls, the auto-run toggle, and the SCIM-call activity feed.

The static explainer stays at `/`.
