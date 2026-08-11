# Migration guide, end to end

The complete path for moving your self-hosted SCIM directories — one or two
hundred — onto WorkOS Directory Sync through this bridge: from the list you hand
WorkOS, to cutover. The [runbook](./runbook.md) covers each step's operational
depth; this is the map of the whole journey and the exact shapes exchanged at
each handoff.

**The short version, when you are migrating many directories:**

1. Send WorkOS one CSV naming your organizations → get back one credentials
   sheet (Step A)
2. Deploy the bridge, paste that sheet into **Bulk import** (Step B)
3. Repoint IdPs — no credential change needed if you import each existing
   token (Step C)
4. Stand up **one** listener for all directories, keyed by directory id
   (Step D)
5. **Pilot one directory end to end**, then advance the rest in waves with the
   bulk mode controls (Step E)

Every per-directory operation has a bulk counterpart: import, mode
changes, and the divergence counters all work across the whole list.

Two parties act in this guide:

- **WorkOS** provisions the WorkOS side of each directory (Step A). You cannot
  do this from the dashboard — imported directories carry properties only
  WorkOS can set.
- **You** (the operator) run the bridge, import the directories into it, repoint
  the IdP, and walk the migration (Steps B onward).

## Step A — WorkOS provisions your directories

Send your WorkOS contact one row per directory to migrate, as CSV:

```csv
organization_id,name
org_01HXAMPLE1,Acme — Okta
org_01HXAMPLE2,Globex — Entra
```

- `organization_id` — the WorkOS organization the directory belongs to.
- `name` — optional label, echoed back so you can match rows up.

WorkOS returns one row per directory:

```csv
organization_id,name,directory_id,scim_endpoint_url,bearer_token
org_01HXAMPLE1,Acme — Okta,directory_01HX…,https://api.workos.com/scim/v2.0/AbC…,se_…
```

- `directory_id` — the WorkOS directory id. Your DSync listener will key on it,
  and the bridge's status endpoint accepts it.
- `scim_endpoint_url` + `bearer_token` — the WorkOS SCIM endpoint the bridge
  writes to, and the credential it presents. **The bearer token is shown only in
  this sheet**; treat it accordingly.

Directories provisioned this way are **imported directories**: WorkOS marks
them as migrated, which is what enables the
[migrated-id contract](../README.md#how-workos-handles-each-scim-request) and —
critically — **suspension soft-delete semantics**:

> **Why soft-delete matters.** On an imported directory, deactivating a user
> (`active: false`, which is how Okta and Entra offboard) emits
> `dsync.user.updated` with the user retained as Inactive — so
> `dsync.user.deleted` means the user is actually gone. Without this, a
> deactivation emits `dsync.user.deleted` while WorkOS quietly keeps the user
> and their group memberships; a listener that honors the event by deleting its
> row then loses the user's id and memberships on every **rehire**
> (deactivate → reactivate), and no later event ever re-announces them. If you
> are migrating a directory that was *not* provisioned through this flow, ask
> WorkOS to confirm suspension soft-delete is enabled for your environment
> before cutover.

## Step B — deploy the bridge and import the directories

### Where the bridge sits

The bridge is a single container in **your** infrastructure, placed so that:

- **Your IdP can reach it over public HTTPS.** The IdP sends SCIM to
  `<PUBLIC_URL>/scim/v2`; terminate TLS in front (the container serves plain
  HTTP) and set `PUBLIC_URL` to that external address.
- **It can reach both upstreams outbound**: your app's SCIM endpoint
  (`native_url` — often internal; the bridge can live inside the same network)
  and `api.workos.com`.
- **`/panel` is not public.** It renders every directory's upstream tokens.
  Basic auth is required to boot; better, keep the panel path internal-only at
  your proxy and set `APP_ENCRYPTION_KEY`.
- **Your listener can reach it** for `GET /status/directories/{id}` (Step D) —
  same host as the SCIM base URL, so public reachability already covers it.
- **One instance, on a persistent volume.** The database holds the id mappings
  the whole migration depends on —
  [runbook: durable storage](./runbook.md#durable-storage) — and both the proxy
  and the listener protocol assume a single writer.

WorkOS webhooks do **not** target the bridge — they go to your app's listener
(Step D). The bridge has no inbound dependency on WorkOS at all.

Deploy ([runbook: deploy](./runbook.md#deploy)), then import each directory —
one at a time in the panel, or all of them at once with **Bulk import**
(one row per directory, header optional):

```csv
name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token
Acme — Okta,https://acme.example.com/scim/v2,tok_native,https://api.workos.com/scim/v2.0/AbC…,se_…,directory_01HX…,okta_tok_existing
```

- `native_url` + `native_token` — your app's existing SCIM endpoint and the
  token the bridge presents to it. **One directory per native endpoint** — see
  [the namespace rule](./runbook.md#deployment-requirement-one-directory-per-native-scim-endpoint).
- `workos_url` + `workos_token` + `workos_directory_id` — pasted straight from
  Step A's sheet (`scim_endpoint_url`, `bearer_token`, `directory_id`).
- `proxy_token` — optional. Supply the bearer token your IdP already presents
  today and the IdP needs no credential change at all
  ([zero IdP-touch](./runbook.md#zero-idp-touch-deployment)); omit it and the
  bridge mints one, which is **not displayed after import** — press **Rotate**
  on the directory page to mint a token you can copy, shown once
  ([tokens are hashed](./runbook.md#proxy-tokens-are-hashed-so-they-cant-be-read-back)).

## Step C — repoint the IdP

Paste the directory's **SCIM base URL** (shown on its page) and proxy token into
the IdP's SCIM configuration. Every directory starts in `passthrough`, so this
changes no behavior: requests flow through the bridge to your app unchanged.
Verify traffic in the **Activity** tab before going further.

## Step D — prepare your DSync listener

One listener serves every directory: each event carries `data.directory_id`,
so a single webhook endpoint resolves the directory per event and asks the
bridge whether to apply it. You register **one** webhook in WorkOS, not two
hundred.

Before cutover your app must consume Directory Sync events:

1. Point a WorkOS webhook endpoint (dashboard → Webhooks, `dsync.*` events) at
   your listener, and verify every delivery against its signing secret.
2. Gate event application on the bridge's status endpoint —
   `GET /status/directories/{id}` → `apply_dsync_events` — so the listener
   stays inert until cutover flips it. [listener-status.md](./listener-status.md)
   specifies the contract; `workers/native/listener.ts` is a reference
   implementation, and `APP_ROLE=native-app`
   ([runbook](./runbook.md#run-the-image-as-the-customer-app-stand-in)) runs it
   as a rehearsal stand-in.
3. Apply events with the semantics an imported directory guarantees —
   [listener-status.md: applying events](./listener-status.md#applying-events)
   spells them out, including the rehire case that silently loses data when a
   listener gets this wrong.

## Step E — pilot one directory, then advance the rest in waves

**Pilot first.** Take one low-stakes directory through every rung below — all
the way to `workos-only` and one post-cutover change observed arriving through
your listener — before touching the rest. Every integration surprise you'll
meet lives in that first pass; the other 199 are repetition.

Then advance the rest in waves: the directory list has **bulk mode changes**
(select directories → set mode), and its per-directory divergence counter shows
which ones aren't ready to advance. Keep waves small enough that a surprise in
one is visible before the next wave moves.

Per directory, advance the mode from its page, verifying convergence in the
**Activity** and **Mappings** tabs at every rung —
[runbook: run the migration](./runbook.md#run-the-migration) has the full
operational detail, including what "safe to cut over" looks like:

| Rung | What changes | Verify before the next rung |
| --- | --- | --- |
| `passthrough` | Nothing — traffic flows to your app | IdP traffic visible in Activity |
| `dual-write` | New writes mirror to WorkOS | Writes land on both sides |
| **Backfill** (button) | Existing state copies to WorkOS | Mappings shows a WorkOS id per resource |
| `workos-primary` | WorkOS answers the IdP; the proxy still writes your app | The native-writes card is **empty** — dwell here |
| `workos-only` | Cutover: your app is fed by DSync events only | Run **Reconcile from WorkOS** immediately after the flip |

**Rollback** is a mode change at any rung — before cutover nothing needs
reconciling first; after cutover, run **Reconcile from WorkOS** if you're unsure
the listener kept up. Bulk mode changes are on the directory list.

## When something looks off

The [troubleshooting table](./runbook.md#troubleshooting) covers the common
symptoms. Two worth naming here because they look like bridge bugs and aren't:

- **WorkOS shows more users than your app after cutover.** Deactivated users:
  WorkOS retains them as inactive records (with their memberships); your app
  deprovisioned them. Compare *active* users and their memberships, not raw
  row counts.
- **A rehired user is missing group memberships in your app.** Your listener
  hard-deleted on an event that was a deactivation — see Step A's soft-delete
  note, and run **Reconcile from WorkOS** to repair.
