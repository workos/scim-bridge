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

## Try it in one command (no WorkOS account needed)

```bash
docker run -p 8080:8080 -e DEMO_MODE=true ghcr.io/workos/scim-bridge:latest
```

Open `http://localhost:8080/panel`. `DEMO_MODE` mounts a simulated IdP and a
simulated native app inside the container and points a directory at them, so you
can drive the whole migration — passthrough → dual-write → backfill → cut over,
and roll it back — against nothing but itself. Start on **Live state**: seed the
directory, then change modes and watch the three columns converge.

No volume is mounted above, so the demo starts clean every run. Leave
`DEMO_MODE` off in production.

## Quickstart (your own directories)

```bash
docker compose up --build
```

The control panel is at `http://localhost:8080/panel` and the SCIM base URL your
IdP points at is `http://localhost:8080/scim/v2`. The SQLite database persists in
the `scim-bridge-data` volume. To set `PUBLIC_URL` and the rest, `cp .env.example
.env` first — compose reads `.env` if it is there, and ignores it if it is not.

Or run the image directly:

```bash
docker run -p 8080:8080 -v scim-bridge-data:/data \
  -e PUBLIC_URL=https://scim-bridge.acme.com \
  ghcr.io/workos/scim-bridge:latest
```

The image is published for `linux/amd64` and `linux/arm64` under one manifest,
so the same command works on an EC2 host, on Cloudflare Containers, and on an
Apple Silicon laptop. **`:latest` is for trying it out** — for anything you
depend on, pin a version or a digest: see
[Releases and image tags](#releases-and-image-tags).

### Running it outside a container

`npm start` runs the same server, with two differences worth knowing before you
lose an evening to them:

- **It does not read `.env`.** Only `docker compose` does. Outside a container,
  pass the variables in the environment (`PUBLIC_URL=… npm start`) or export
  them.
- **`DATABASE_PATH` defaults to `/data/scim-bridge.db`**, which is the path
  inside the image. On a host machine there is usually no `/data`, and the
  server exits at boot with `Cannot open database because the directory does
  not exist`. Set it:

```bash
DATABASE_PATH=./scim-bridge.db PUBLIC_URL=http://localhost:8080 npm start
```

## Configuration (environment variables)

Only process-wide settings are configured here. Per-directory settings are
imported through the control panel.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PUBLIC_URL` | recommended | `http://127.0.0.1:$PORT` | Externally reachable base URL your IdP uses; drives the SCIM base URL shown in the panel. |
| `PORT` | no | `8080` | HTTP port the server listens on. |
| `DATABASE_PATH` | no | `/data/scim-bridge.db` | SQLite file path. Mount a volume here to persist. The default is a path *inside the image*; running outside a container, set it to somewhere that exists. |
| `PANEL_AUTH_USER` / `PANEL_AUTH_PASSWORD` | no | — | HTTP Basic credentials guarding the control panel. Both blank = unauthenticated (front it with your own proxy/SSO). |
| `APP_ENCRYPTION_KEY` | no | — | When set, encrypts each directory's native + WorkOS bearer tokens at rest (AES-256-GCM). Keep it stable; leave unset to store them in plaintext. |
| `DEMO_MODE` | no | `false` | Mount the bundled IdP + native-app simulators under `/__demo` for a self-contained end-to-end demo. |

The `/scim/v2` data-plane is always authenticated by the per-directory proxy
token the panel mints — panel auth does not gate it.

## Importing a directory

1. Open `/panel` and create a directory to migrate.
2. Paste your **existing app's SCIM** base URL + bearer token, and the **WorkOS
   directory** endpoint + bearer token (from the WorkOS dashboard).
3. **Press Rotate to get the proxy token.** The directory page shows only the
   last four characters of it — the token itself is stored as a hash and cannot
   be read back. **Rotate** mints a new one and displays it once, with a Copy
   button; take it then, because reloading the page loses it. If you already
   have a bearer token your IdP presents today, you can supply it as the proxy
   token at import instead and skip this.
4. Paste that token, and the **SCIM base URL** the page shows, into your IdP's
   SCIM configuration. The directory starts in `passthrough`, so repointing the
   IdP changes no behavior — every request still reaches your native app.
5. Advance the mode: `passthrough → dual-write → backfill → cut over`, verifying
   convergence in the Live/Mappings tabs. Roll back any time before commit.

> Rotating invalidates the previous token **immediately**, so a directory whose
> IdP is already syncing will `401` until you paste the new one. On a live
> directory, rotate at a moment you can follow straight through.
> [`docs/runbook.md`](./docs/runbook.md#proxy-tokens-are-hashed-so-they-cant-be-read-back)
> has the recovery paths.

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
> `workers/native/listener.ts`) by polling the proxy's status endpoint; a real
> customer's listener does the same with the WorkOS `directory_id` the event
> carries — see below.

## Directory status for your DSync listener

Your app's DSync event listener must **ignore** events while the proxy is still
writing your app directly and **handle** them once it isn't. The proxy exposes a
per-directory status endpoint that makes that call for you:

```
GET {PUBLIC_URL}/status/directories/{directory_id}
Authorization: Bearer {proxy_token}
→ { directory_id, workos_directory_id, mode, native_authoritative,
    apply_dsync_events, updated_at }
```

It accepts the WorkOS directory id (`directory_...`) DSync events carry — set
it on the directory in the panel — or the bridge's own id, authenticated by the
same per-directory proxy token as the `/scim/v2` data-plane. Responses are
cache-friendly (`ETag`, `Cache-Control: max-age=5`).

Key your listener on **`apply_dsync_events`** — the instruction. Don't derive it
from `mode` or from `native_authoritative`, which reports who owns the data and
only *looks* equivalent today. See
[`docs/listener-status.md`](./docs/listener-status.md) for the contract and a
client snippet.

## Development

```bash
npm install
npm run dev          # React Router dev server (control panel)
npm run build        # production client + server build
npm start            # run the full server (proxy + panel) against the build
npm run typecheck    # react-router typegen + tsc -b (workers/, server/, tests/)
npm run typecheck:gate  # asserts the gate rejects a deliberate type error
npm run typecheck:app   # the control panel, which is not gated yet
```

The test suite runs against the SQLite driver by default. Point
`TEST_DATABASE_URL` at a Postgres server and it also runs the datastore
conformance and schema-parity cases; add `TEST_ENGINE=postgres` and the **whole**
suite runs on Postgres instead:

```bash
docker run -d --rm --name sb-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=scimtest \
  -p 55432:5432 postgres:16
export TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/scimtest

npm test                 # every test on SQLite (+ the Postgres-only cases)
npm run test:postgres    # every test on Postgres
npm run test:engines     # asserts both runs covered the same tests
```

Each worker migrates one Postgres schema and resets it between tests, so a run
creates a handful rather than one per test. A worker killed mid-run (a timeout, a
Ctrl-C) leaves its schema behind; to clear leftovers:

```bash
psql "$TEST_DATABASE_URL" -tAc \
  "SELECT format('DROP SCHEMA %I CASCADE;', schema_name) FROM information_schema.schemata \
   WHERE schema_name ~ '^t[0-9]+_[0-9]+$'" | psql "$TEST_DATABASE_URL"
```

CI runs all three test commands. `test:engines` compares the JSON reports the
first two leave in `.vitest/`, so it costs no extra runs — and it fails if a test is skipped on one
engine but not the other, which is how "make it pass on Postgres" becomes "don't
run it on Postgres".

`npm run dev` serves the panel with HMR; the `/scim` proxy data-plane runs under
`npm run build && npm start` (or in Docker).

## How it runs

scim-bridge is a single Node process:

> **Storage:** the database holds every directory, its migration mode and its id
> mappings, so `DATABASE_PATH` must be on a volume that survives a restart (or use
> `DATABASE_DRIVER=postgres`). Boot warns when it is not. See
> [docs/runbook.md#durable-storage](docs/runbook.md#durable-storage).

- **`server/`** — a [Hono](https://hono.dev) server that routes `/scim/v2/*` to
  the proxy, serves the React Router control panel for everything else, applies
  migrations on boot, and provides the datastore driver the app code talks to
  (`Datastore` in `workers/shared/datastore.ts`; SQLite by default).
- **`workers/proxy`** — the SCIM migration proxy (data-plane).
- **`workers/shared`** — SCIM translation, id-mapping, backfill, and DB helpers.
- **`app/`** — the React Router control panel (vendored WorkOS design system).
- **`workers/native`, `workers/idp`** — the demo simulators (DEMO_MODE only).

The datastore is a configured choice: a SQLite file (default) or Postgres, behind
one narrow interface — see [docs/runbook.md#durable-storage](docs/runbook.md#durable-storage)
for which to pick and why.

## Releases and image tags

Every release is a git tag `vX.Y.Z`, a [GitHub
Release](https://github.com/workos/scim-bridge/releases) whose notes say what
changes for an operator, and a matching set of image tags. What changed in each
version is in [`CHANGELOG.md`](./CHANGELOG.md).

| Reference | Moves? | Use it for |
| --- | --- | --- |
| `ghcr.io/workos/scim-bridge@sha256:…` | never | **Production.** The only reference that cannot change under you; each release's notes print it. |
| `ghcr.io/workos/scim-bridge:0.3.0` | never in practice | Production, if you would rather read a version than a hash. A published version tag is never overwritten. |
| `ghcr.io/workos/scim-bridge:0.3` | with each patch | Picking up fixes without a redeploy decision. |
| `ghcr.io/workos/scim-bridge:latest` | with each release | Trying it out. An unattended `latest` will upgrade you across breaking changes. |

Images carry build provenance and an SBOM, so your scanner can answer "are we
exposed to CVE-x" without asking us:

```bash
docker buildx imagetools inspect ghcr.io/workos/scim-bridge:latest
```

Cutting a release, and the checks the pipeline runs before publishing anything,
are documented in [`docs/releasing.md`](./docs/releasing.md).

## License

MIT — see [`LICENSE`](./LICENSE).
