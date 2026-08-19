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

Panel mutations (save endpoints, change mode, run backfill, delete a directory)
are accepted only from same-origin requests — the browser's `Origin` /
`Sec-Fetch-Site` prove the request came from the panel itself, not a cross-site
page forging it with the operator's cached Basic credentials. This is on by
default and needs no configuration. If you drive the panel from a script or
another origin, set `PANEL_CSRF_DISABLED=true` to turn it off; the bridge warns
at every boot while it is off, the same as `PANEL_AUTH_DISABLED`. The
token-authenticated `/scim` and `/status` endpoints are unaffected — the IdP
posts to them cross-origin legitimately.

## Durable storage

The database holds every directory's configuration, its migration mode, **and its
`id_mappings`** — the table that lets the proxy translate ids between the side the
IdP talks to and the side WorkOS talks to. Lose it mid-migration and the proxy
cannot do that translation; the IdP also starts 401ing, because no directory
matches the token it presents.

This is not hypothetical. An end-to-end run lost its database **three
times**: the deployment ran on Cloudflare Containers, whose disk is recreated with
the container, and nothing about writing to it looks wrong until a redeploy. Each
loss meant re-importing every directory while the IdP kept sending traffic.

### Recommended: SQLite on a persistent volume

The bridge exists for the length of one migration. Mounting a filesystem is a
smaller ask than standing up a database for a temporary tool, so this is the
default and the recommendation:

```bash
DATABASE_DRIVER=sqlite            # the default
DATABASE_PATH=/data/scim-bridge.db  # ...pointed at the mount
```

Run **one instance**. SQLite is single-writer, and the proxy and DSync listener
assume a single writer regardless of engine — this does not scale horizontally,
by design.

| Platform | Durable storage |
| --- | --- |
| docker compose | the named volume in `docker-compose.yml` (already wired) |
| AWS | ECS/Fargate with an **EFS** volume, or EC2 with an **EBS** volume |
| Fly.io | `fly volumes create` and mount it |
| **Cloudflare Containers** | **the container's local disk is ephemeral** — it is recreated with the container. See [Cloudflare](#cloudflare) below for what is durable there. |

That last row is the one to read twice: it is where our own e2e ran, so anyone
copying that setup inherits the problem the hard way.

#### Cloudflare

The precise statement is that **the container's local disk does not persist** —
not that Cloudflare can't be durable. There is no volume to mount, so durability
has to come from somewhere the container can reach over the network:

- **External Postgres, via [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)** —
  works today: `DATABASE_DRIVER=postgres` with `DATABASE_URL` pointed through it.
  Hyperdrive is what makes the connection pooling sane from Cloudflare's edge.
- **Checkpoint the SQLite file to [R2](https://developers.cloudflare.com/r2/) and
  restore it on boot** — the Cloudflare analogue of the Litestream→S3 option above.
  Lossy by the checkpoint interval (anything written since the last upload is
  gone), and it is configuration plus a boot script rather than a code change.
- **A Durable Object / D1 driver** — possible future work, *not* a current option.

That last one needs one sentence of explanation, because it is the same fact that
kept a `d1` driver out of the datastore work and it will be asked again:
**bindings belong to the Worker, not to the container's Node process.** A
container fronted by a Worker cannot reach D1 or Durable Object storage directly;
it can only reach them over the wire, through something the Worker exposes. That
is a driver with an HTTP transport — a new component to write and operate, with a
network hop per statement — not a configuration flag.

At boot the server prints the absolute path it opened and, on Linux, the
filesystem underneath it:

```
SQLite database: /data/scim-bridge.db (ext4 on /data)
```

and if that filesystem is one that disappears with the container (`overlay`,
`tmpfs`), it says so loudly:

```
WARNING: DATABASE_PATH (/data/scim-bridge.db) is on a overlay filesystem mounted at /,
which does not survive this container being replaced. …
```

Back it up with volume snapshots, or with [Litestream](https://litestream.io)
replicating the file to S3 continuously.

### Postgres when

- you want **more than one instance** (note the single-writer caveat above still
  applies to the application, so this is for failover, not scale-out), or
- you want **managed backups / point-in-time recovery**, or
- you would rather point at RDS/Aurora than mount a filesystem.

```bash
DATABASE_DRIVER=postgres
DATABASE_URL=postgres://bridge:secret@scim-bridge-db.abc.eu-west-1.rds.amazonaws.com:5432/bridge
```

Both drivers apply their own migrations on boot (`migrations/*.sql` for SQLite,
`migrations/postgres/*.sql` for Postgres) and are safe to restart. Switching
driver does **not** move data.

### If you lose the database anyway

Two things are gone, and they recover differently. **Re-importing the CSV restores
directory configuration, not mappings** — that part matters.

1. **Directories.** Re-import them, including each `proxy_token` (see
   [zero IdP-touch](#zero-idp-touch-deployment)); the IdP then authenticates
   again without being reconfigured. Keep an export somewhere you will still have
   it — the CSV *is* the recovery procedure, and since the tokens are hashed at
   rest it is now the *only* copy: you cannot read them back out of a surviving
   database, only rotate them and reconfigure the IdP.
2. **`id_mappings`.** These re-derive themselves, but by two different routes,
   and the second one is worth understanding before you decide how urgently to
   act:

   | strategy | what it is | how it comes back |
   | --- | --- | --- |
   | `migrated-id` | `native_id == workos_id` — the shared id the migrated-id contract preserves | the next mirrored write PUTs the shared id, WorkOS already has it, and the mapping is recorded again. Effectively self-healing. |
   | `fallback-post` | `native_id != workos_id` — WorkOS minted its own id, and this table was the only record of the pairing | the next write PUTs the native id (404), POSTs (409, because the resource already exists there), then the proxy looks it up by `userName`/`displayName`, repairs the content, and re-records the mapping. It works, but it costs a filter round-trip per resource. |

   So the exposure is **how many `fallback-post` rows a directory had**. A
   directory whose mappings are all `migrated-id` barely notices a wipe; one with
   `fallback-post` rows needs a write per resource to repair, and until that write
   happens, requests for those resources translate to an id WorkOS does not have,
   so the IdP sees 404s. If the WorkOS side ever stopped rejecting duplicate
   `userName`s, the repair would instead create a second resource — the case the
   "only POST creates" invariant exists to prevent.

   The directory's **Mappings** tab shows the strategy per row and warns when any
   are `fallback-post`, so that count is the number to check before trusting
   ephemeral storage.

### One more reason not to leave the file lying around

Proxy tokens are hashed at rest, so a copy of the database is no longer
a set of live credentials. It is still a set of *upstream* ones: the native and
WorkOS bearer tokens are only encrypted if `APP_ENCRYPTION_KEY` is set, and the id
mappings are irreplaceable. Both are arguments for a volume you control.

## Deployment requirement: one directory per native SCIM endpoint

**Your SCIM service must give every directory its own base URL.** This is a
requirement of the deployment, not a preference — check it before you import
anything, because it may need a change on your side.

Two bridge directories pointed at one native endpoint share a single set of SCIM
user and group ids. The bridge cannot see how your service decides which tenant a
request is for, so it cannot tell whose record a native id names — and a write
meant for one directory can land on another's users. The bridge refuses the
configuration rather than trying to survive it.

The endpoints are compared canonically: scheme, host, port and path, with
capitalisation, a default port written out (`:443`, `:80`) and a trailing slash
normalised away. `https://app.example.com:443/scim/v2/` and
`https://APP.example.com/scim/v2` are the same endpoint.

**The path counts**, which is what makes one host workable. Route a path segment
per tenant and the directories are distinct:

```
https://app.example.com/scim/acme/v2      → directory 1
https://app.example.com/scim/globex/v2    → directory 2
```

If your SCIM service today serves every tenant from one flat URL and decides the
tenant from the bearer token alone, add a path segment per directory before you
migrate the second one. A token is not enough: the bridge has no way to verify
that your service partitions rows by the presenting credential.

A directory with an empty native base URL is fine — it addresses nothing yet.

**Upgrading a deployment that already violates this.** The bridge still starts. It
logs a `WARNING` at boot naming each set of directories that share an endpoint,
and repeats it on the panel's directories page. Nothing is refused retroactively;
only new saves are checked. Repair it by giving each directory its own path (edit
**Native SCIM endpoint** on the directory page) and the warning clears.

## Import directories

Open `/panel`.

- **One directory** → *Import directory*: name, your native SCIM base URL + token,
  and the WorkOS directory endpoint + token (from the credentials sheet WorkOS
  returns when it provisions your directories — see the
  [migration guide, Step A](./migration-guide.md#step-a--workos-provisions-your-directories)).
  The optional **Existing IdP bearer token** field is the proxy token to use — see
  [zero IdP-touch](#zero-idp-touch-deployment) below.
- **Many** → *Bulk import*: paste CSV
  `name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token`
  (header optional; only the name is required). `proxy_token` is the last column
  and optional, so six-column CSVs written before it existed import unchanged.
  Two rows sharing a `native_url` — or a row taking an endpoint an existing
  directory already has — refuses the **whole** file: nothing is imported, so
  you never have to work out which half landed.

  The WorkOS half of each row — `workos_url`, `workos_token`,
  `workos_directory_id` — is pasted straight from the credentials sheet WorkOS
  returns at provisioning time
  ([migration guide, Step A](./migration-guide.md#step-a--workos-provisions-your-directories)).
  Provisioning is a WorkOS-side operation — imported directories can't be
  created from the dashboard — so if you don't have that sheet yet, that's the
  step to do first.

Then copy the directory's **SCIM base URL + proxy token** into your IdP's SCIM
config. It starts in `passthrough`, so repointing the IdP changes no behavior —
every request still reaches your native app.

### Proxy tokens are hashed, so they can't be read back

The database stores `sha256(proxy_token)`, never the token. Consequences
worth knowing before you need them:

- **The directory page shows the last 4 characters**, not the token. Match it
  against what you pasted into the IdP.
- **Rotate is the only recovery.** If the token was never copied, or was lost, use
  **Rotate** on the directory page: it mints a new one, shows it once, and the
  previous token stops working immediately — so paste it into the IdP before the
  next sync. A directory whose IdP still presents the old token 401s until you do.
- **Right after an import, the minted token is not displayed yet** (the display
  policy for mint and bulk import is still being decided). Until it is, rotate once
  on the new directory's page to get a token you can copy.
- **Upgrading an existing deployment needs nothing.** The first boot on this version
  hashes whatever plaintext tokens the database holds and logs how many it
  converted. Every IdP keeps working with the token it already has; the conversion
  is one-way, so from then on the CSV export is the only readable copy.

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
- **Imported tokens are hashed at rest**, like minted ones — the proxy stores
  only a digest and routes by it, so the token cannot be read back later
  ([recovery paths](#proxy-tokens-are-hashed-so-they-cant-be-read-back)).
  `APP_ENCRYPTION_KEY` covers the native/WorkOS upstream tokens, which the
  proxy must present, not this routing key, which it only verifies.
- A too-short value is rejected at import (a truncated paste would 401 every
  SCIM request instead of failing here).
- **Rotation is in place, and immediate.** **Rotate** on the directory page
  mints a new token and shows it once; the previous token stops authenticating
  the moment it returns, so on a live directory rotate only when you can paste
  the new token into the IdP straight away.

## Run the migration

Advance the directory's mode from its page, verifying convergence in the
**Activity** and **Mappings** tabs at each step:

1. **passthrough** → confirm requests flow through to native unchanged.
2. **dual-write (native-first)** → new writes now also mirror to WorkOS.
3. **Run backfill** → copies existing native state into WorkOS (idempotent;
   safe to re-run). Requires dual-write on. Failures in the summary are
   usually the data, not the bridge —
   [workos-scim-requirements.md](./workos-scim-requirements.md) maps each
   WorkOS error to the audit that would have caught it.
4. Verify parity (Mappings shows a WorkOS id per resource).
5. **workos-primary** → WorkOS starts answering the IdP, while the proxy keeps
   writing the native app directly. **Stay here.** Dwelling on this rung is the
   point of it: WorkOS's authority is exercised by real IdP traffic, the native
   app is still current on every request rather than via webhook delivery, and
   going back to dual-write is a mode change with no reconcile and no backfill
   behind it. Both legs run at once and the IdP is answered only once both
   finish, so a request that returned `200` reached both sides.

   Watch the directory page's native-writes card while you dwell. It lists the
   resources WorkOS accepted and native refused; every row is a resource native
   is behind on. **Reconcile from WorkOS** is the repair — nothing retries in
   the background, deliberately, so a repair happens when an operator has looked
   at why native refused. An empty card is what "safe to cut over" looks like,
   and a row retires itself: a reconcile that replays cleanly clears the rows it
   repaired, and so does any later write to the same resource that reaches native
   — including after a rollback, where reconcile is no longer offered because
   WorkOS is no longer authoritative.

   Backfill still runs here, so a directory that reaches this rung with WorkOS
   short a few resources does not have to drop back to fix it.
6. **Cut over to workos-only** → confirm the AlertDialog. WorkOS is now
   authoritative; provision your app from WorkOS Directory Sync events (the
   listener in `workers/native/listener.ts` is a reference implementation).
   Wire your listener's handle-vs-ignore decision to the directory's status
   endpoint — `GET /status/directories/{id}`, shown on the directory page —
   see [listener-status.md](./listener-status.md).

   This is the step that makes the listener — and therefore webhook delivery —
   load-bearing for the first time. Take it only once the listener has been
   verified end to end: reachable, verifying signatures, and applying events.

   **Run Reconcile from WorkOS immediately after the flip.** The cutover is
   instantaneous on the proxy side — it stops writing the native app the same
   instant — while a listener that caches the status answer needs a moment to
   notice. An IdP write landing in that gap is written by nobody: the listener
   ignores it, acknowledges it with a `200`, and WorkOS never redelivers. The
   bundled listener closes the window by confirming every ignore against the
   status endpoint before acting on it, but a customer listener on an
   older bridge — or one that caches without revalidating — still has it, and
   the reconcile is the only remedy either way. It snapshots the live WorkOS
   directory back into native and is idempotent, so it costs nothing when the
   window was empty. Cutting over during a quiet period narrows the exposure but
   does not remove it.

   The listener keys on that response's **`apply_dsync_events`** and on nothing
   else. The endpoint also reports `native_authoritative`, which describes who
   owns the data and is there for display; it is not the instruction. The two
   are exact opposites on every mode except `workos-primary`, where WorkOS is
   authoritative *and* the listener must stay inert because the proxy is still
   writing native — a listener keyed on `native_authoritative` applies every
   change a second time there. When the field is absent the listener falls back
   to `mode === "workos-only"`, so an older bridge still behaves correctly.

**Rollback:** on any mode before cutover — `workos-primary` included — move the
mode back toward passthrough. The proxy wrote native on every request, so native
is current and there is nothing to reconcile or backfill first. After cutover
(`workos-only`), native is kept current by the DSync listener; if you're unsure
it stayed caught up, run **Reconcile from WorkOS** on the directory page first —
it snapshots the live WorkOS directory and replays every resource back into
native, guaranteeing parity before you flip the mode back.

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
- A line ending `drift left unrepaired` means the collision _did_ resolve to a
  row, but that row isn't attributable to this directory: another directory in the
  same native namespace maps it, or it is unmapped and its id isn't the
  `externalId` WorkOS holds (the shape listener-adopted drift always takes).
  `userName`/`displayName` are unique per native namespace, not per directory, so
  in a deployment that bridges several directories into one namespace a match can
  be another tenant's resource; reconcile refuses to write it. Line the ids up by
  hand only once you've confirmed which directory the row belongs to.
- A line ending `drift left unrepaired` means the collision *did* resolve to a
  row, but that row isn't attributable to this directory — another directory maps
  it, or its `externalId` isn't the one WorkOS holds. `userName`/`displayName` are
  unique per native namespace, not per directory, so in a deployment that bridges
  several directories into one namespace a match can be another tenant's
  resource; reconcile refuses to write it. Line the ids up by hand only once
  you've confirmed which directory the row belongs to.

**Multi-directory topology: one native app fronted by several directories is a
shared namespace.** Several directories can front one native app (the same
`native_url`). The guards above (drift repair, and the proxy's create/replace
attribution) treat that as a *shared* namespace whatever the `native_token`s are,
and refuse to attribute a native row from a tenant-supplied id — so no directory
can name another's rows. Distinct per-directory native tokens deliberately do
**not** relax this: whether a customer's app partitions its rows by the
credential that authenticated the call is a property of that app, not something
the bridge can observe or enforce, and an app that accepts every issued token
over one flat row set would turn the relaxation into a cross-tenant write. The
practical consequence is that directories sharing a `native_url` do not get the
`externalId`-derived, id-preserving mapping; to keep it, **migrate each directory
against a native namespace it has to itself** (a distinct `native_url`, e.g. a
per-tenant host or path prefix).

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
directory *and* the bridge answers `apply_dsync_events: true` for it (see
[listener-status.md](./listener-status.md)). If `BRIDGE_STATUS_URL` is
unreachable it falls back to the seeded row, which stays at `passthrough` —
events are logged as ignored rather than applied, so a cutover that looks inert
is the first thing to check there.

Instead of (or alongside) the webhook, the stand-in can **poll the WorkOS
Events API**, which returns events in order — eliminating the out-of-order
delivery hazard webhooks have. Set `WORKOS_API_KEY` to turn it on (and
optionally `WORKOS_EVENTS_URL` / `WORKOS_EVENTS_POLL_INTERVAL_MS`); polled
events run through exactly the same handling as webhook deliveries, and
duplicates across the two transports are dropped by event id. The key is the
environment-wide WorkOS credential, so keep it in your secret manager — it is
read from the environment only, never stored. See
[listener-status.md](./listener-status.md#events-api-instead-of-webhooks) for
the trade.

## Self-contained demo

`DEMO_MODE=true` mounts a simulated IdP + native app and seeds a pre-wired "Demo
directory", so you can drive the whole loop with no real IdP or WorkOS account.
Use the panel's **Live state** and **IdP simulator** tabs to seed and churn the
directory and watch it converge.

The Events API poller self-wires here too: in demo mode it starts with no
`WORKOS_API_KEY`, polling the mock WorkOS the demo itself mounts
(`/__demo/native/mock-workos/events`, authenticated with the mock's seeded
token). Keyless polling works only against that bundled mock — set
`WORKOS_EVENTS_URL` to anything else and the real key is required again.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Proxy returns 401 | The IdP's bearer token must equal the directory's `proxy_token`. If every directory 401s at once, the database was probably lost — see [durable storage](#durable-storage). |
| Proxy returns 401 and the token looks right | Check the header shape. `Authorization: Bearer <token>` (any casing of the scheme) and a bare `Authorization: <token>` both authenticate, so it doesn't matter whether the IdP adds the prefix or sends the field verbatim; any other scheme (`Basic …`) does not. The one shape that still fails is a doubled prefix — typing `Bearer <token>` into an IdP that then adds its own. |
| Proxy returns 502 | The native (passthrough/dual-write) or WorkOS (workos-only) endpoint is unreachable — verify the URL/token with the directory page's test buttons. |
| WorkOS answers 400 `invalidSyntax` on a mirror or backfill | An attribute the native app sent as `null` where WorkOS expects a string. The bridge drops null-valued keys from every WorkOS-bound resource body, so this should only appear on a `PATCH` (whose `Operations` are deliberately left alone — a null there can be a meaningful remove) or for a genuinely malformed value. |
| WorkOS answers 400 `Required attributes missing: emails` | The user has no `emails[]` entry with a non-blank value and their `userName` is not an email address WorkOS could backfill from. WorkOS holds the user in a `Validating` state and drops them from group syncs until corrected — fix the source data and re-run backfill. The full set of WorkOS-side data requirements: [workos-scim-requirements.md](./workos-scim-requirements.md). |
| WorkOS answers 409 on a mirror or backfill | A uniqueness collision inside the directory: a duplicate `userName` or active-user email (both case-insensitive), or a group identity (`externalId`, else `displayName`) already taken. The [data checklist](./workos-scim-requirements.md) has the audits that catch these up front. |
| Listener ignores events after cutover | `GET /status/directories/{id}` must answer `apply_dsync_events: true`. If it answers `false` with `mode: workos-only`, the row didn't flip; if the listener ignores a `true`, it is deriving the decision from `mode` or `native_authoritative` instead of reading the field. |
| Listener applies each change twice | It is inferring "apply" from `native_authoritative` (or from "not passthrough/dual-write") rather than reading `apply_dsync_events`. Those agree in every mode except `workos-primary`, so this shows up the moment a directory reaches that mode. |
| Proxy returns 502 in workos-primary | Native rejected the write with a 5xx or could not be reached while WorkOS took it. Visible by design: the directory page's native-writes card names the resource. The IdP's retry is safe (ids are shared, so it converges); if native keeps refusing, **Reconcile from WorkOS** repairs it. |
| Proxy returns a native 4xx in workos-primary | Native rejected the write on its merits, so its own status and body are returned rather than a 502 — a bare retry would only reproduce it. Fix the resource (or native's validation), then retry or reconcile. |
| Mappings show `fallback-post` | The migrated-id contract wasn't active for that WorkOS directory (flag/`migrated`/`created_at` prerequisites) — ids aren't shared. |
| Tokens look like `enc:v1:…` in the DB | Expected — they're encrypted at rest. Never change `APP_ENCRYPTION_KEY` after writing, or they become unreadable. |
| Panel 500s after setting a key | The key changed since tokens were written; restore the original `APP_ENCRYPTION_KEY`. |
| Stand-in ignores every DSync event | Its `DIRECTORIES_JSON` entry must carry the directory's WorkOS id and proxy token, the bridge's row must have that WorkOS id set, and `BRIDGE_STATUS_URL` must reach the bridge — otherwise the mode reads as pre-cutover. |
