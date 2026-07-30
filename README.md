# scim-bridge

A reversible **SCIM migration proxy** for moving an existing self-hosted SCIM
integration onto [WorkOS Directory Sync](https://workos.com/docs/directory-sync)
with **zero downtime and safe rollback**.

You run scim-bridge in front of your current SCIM endpoint. It dual-writes every
change to both your existing app and WorkOS, lets you backfill and verify at
your own pace, then cut over — and roll back losslessly at any point before the
final commit. A built-in **control panel** imports directories, holds their SCIM
credentials, flips migration modes, runs backfill, and shows the request log and
id mappings.

> How the migration works (dual-write → backfill → invert → commit), the
> migrated-id contract, and the platform changes it depends on are documented in
> [`docs/`](./docs) and the WorkOS internal migration guide.

## Quickstart (Docker)

```bash
cp .env.example .env       # then edit PUBLIC_URL etc.
docker compose up --build
```

The control panel is at `http://localhost:8080/panel` and the SCIM base URL your
IdP points at is `http://localhost:8080/scim/v2`. The SQLite database persists in
the `scim-bridge-data` volume.

Or run the image directly:

```bash
docker run -p 8080:8080 -v scim-bridge-data:/data \
  -e PUBLIC_URL=https://scim-bridge.acme.com \
  ghcr.io/workos/scim-bridge:latest
```

## Configuration (environment variables)

Only process-wide settings are configured here. Per-directory settings are
imported through the control panel.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PUBLIC_URL` | recommended | `http://127.0.0.1:$PORT` | Externally reachable base URL your IdP uses; drives the SCIM base URL shown in the panel. |
| `PORT` | no | `8080` | HTTP port the server listens on. |
| `DATABASE_PATH` | no | `/data/scim-bridge.db` | SQLite file path. Mount a volume here to persist. |
| `PANEL_AUTH_USER` / `PANEL_AUTH_PASSWORD` | no | — | HTTP Basic credentials guarding the control panel. Both blank = unauthenticated (front it with your own proxy/SSO). |
| `APP_ENCRYPTION_KEY` | no | — | When set, encrypts each directory's native + WorkOS bearer tokens at rest (AES-256-GCM). Keep it stable; leave unset to store them in plaintext. |
| `DEMO_MODE` | no | `false` | Mount the bundled IdP + native-app simulators under `/__demo` for a self-contained end-to-end demo. |

The `/scim/v2` data-plane is always authenticated by the per-directory proxy
token the panel mints — panel auth does not gate it.

## Importing a directory

1. Open `/panel` and create a directory to migrate.
2. Paste your **existing app's SCIM** base URL + bearer token, and the **WorkOS
   directory** endpoint + bearer token (from the WorkOS dashboard).
3. Copy the minted **SCIM base URL + proxy token** into your IdP's SCIM
   configuration. The directory starts in `passthrough`, so repointing the IdP
   changes no behavior — every request still reaches your native app.
4. Advance the mode: `passthrough → dual-write → backfill → cut over`, verifying
   convergence in the Live/Mappings tabs. Roll back any time before commit.

## How WorkOS handles each SCIM request

The proxy translates every request from your IdP into a WorkOS SCIM call under
the **migrated-id contract**: WorkOS addresses each resource by the id your own
system minted, carried in an `X-WorkOS-Migrated-Id: {id}` header, and echoes that
id back — so your IdP never sees a WorkOS-internal id. Post-decoupling only
`POST` creates a resource; `PUT`/`PATCH`/`DELETE` resolve by id and `404` on a
miss. So a first-touch write runs the dance `PUT /{kind}/{id}` → `404` →
`POST /{kind}` (both with the header), and a `POST 409` (create race) retries the
`PUT` to resolve the winner.

| Your IdP sends (→ proxy) | Proxy sends to WorkOS | How WorkOS handles it |
| --- | --- | --- |
| `POST /Users` (create) | `PUT /Users/{id}` + header → `404` → `POST /Users` + header | Creates the user and adopts `{id}` as its id. In dual-write, `{id}` is the id your native app minted (learned from its `201`); after cutover it is derived from the IdP `externalId`. |
| `PUT /Users/{id}` (replace) | `PUT /Users/{id}` + header (→ `404` → `POST /Users` + header) | Full replace; a missing first-touch resource `404`s the `PUT` and **self-heals via `POST`**. |
| `PATCH /Users/{id}` (update) | `PATCH /Users/{id}` | Applied verbatim (no header). Any ids inside the body are translated to the WorkOS side first. |
| `DELETE /Users/{id}` | `DELETE /Users/{id}` | Removes the resource; the proxy drops its id mapping. |
| `POST/PUT/PATCH/DELETE /Groups...` | Same shape as Users | Group `members[].value` ids are translated between your ids and WorkOS's in both directions. |
| `GET` (any) | Not sent to WorkOS | Reads are served from whichever side is authoritative for the current mode (your native app before cutover, WorkOS after). |

**Id strategy.** Every id the proxy sends WorkOS (path ids and group
`members[].value`) is mapped through its `id_mappings` table, so the two systems
stay linked. If a directory's WorkOS endpoint does not honor the migrated-id
contract, the proxy falls back to a plain `POST`, records the WorkOS-minted id
(`strategy = fallback-post`), and keeps translating through that mapping — the
migration still works, the ids just aren't shared.

## Demo mode

`DEMO_MODE=true` mounts a simulated IdP and native SCIM app in-process (under
`/__demo`) and points a new directory at them, so you can drive the whole
migration loop with no real IdP or WorkOS account. Leave it off in production.

> The **proxy handles many directories** — each imported directory is routed by
> its own proxy token. The **bundled simulator**, though, models a **single**
> directory (its mock WorkOS and native app share one store), so the demo runs
> one directory end-to-end. The reference DSync listener resolves each event's
> directory and migration mode per-directory (`directoryModeForEvent` in
> `workers/native/listener.ts`); a real customer maps the WorkOS `directory_id`
> to their own directory record there.

## Development

```bash
npm install
npm run dev          # React Router dev server (control panel)
npm run build        # production client + server build
npm start            # run the full server (proxy + panel) against the build
npm run typecheck    # react-router typegen + tsc --noEmit
```

`npm run dev` serves the panel with HMR; the `/scim` proxy data-plane runs under
`npm run build && npm start` (or in Docker).

## How it runs

scim-bridge is a single Node process:

- **`server/`** — a [Hono](https://hono.dev) server that routes `/scim/v2/*` to
  the proxy, serves the React Router control panel for everything else, applies
  SQLite migrations on boot, and adapts SQLite to the D1 API the app code uses.
- **`workers/proxy`** — the SCIM migration proxy (data-plane).
- **`workers/shared`** — SCIM translation, id-mapping, backfill, and DB helpers.
- **`app/`** — the React Router control panel (vendored WorkOS design system).
- **`workers/native`, `workers/idp`** — the demo simulators (DEMO_MODE only).

It also deploys to Cloudflare Workers + D1; the D1 migration files under
`migrations/` are shared by both runtimes.

## License

See [`LICENSE`](./LICENSE).
