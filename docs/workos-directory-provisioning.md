# WorkOS directory provisioning (Step A) — spec

Bulk-importing many directories is **two** operations. This document specs the
first; the second lives in this repo.

- **Step A — create the directories _in WorkOS_.** Bulk-create one migrated
  Generic-SCIM directory per organization and emit their endpoints + tokens.
  **WorkOS-internal tool** (see "Why internal" below). Lives in the `workos/workos`
  monorepo, **not** in this repo.
- **Step B — import them into the proxy.** Feed Step A's output (plus the
  customer's native SCIM columns) into scim-bridge's **panel → Bulk import**.
  Already implemented here (`app/routes/panel/home.tsx`, `bulk-import`).

## Why Step A is internal (not a customer API key)

A migrated directory needs state a normal customer API key cannot set:

- `directories.migrated = true` — set via the internal-admin `setDirectoryMigrated`
  mutation (branch `jonatas/scim-mig-workos-only`, commit `0c36ea037ab`).
- `created_at` within `[2025-08-07, 2026-06-29T16:00Z)` — the window where a
  group's `idp_id` equals its `externalId` **and** the resource-decoupling
  behavior stays LD-flag-governed.
- The `dsync-scim-resource-decoupling-behavior` LD flag = `on` for the directory.

So Step A runs through internal-admin GraphQL and depends on the (currently
unmerged) migrated-id branch. It must not ship in the public `scim-bridge` repo.

## CSV contract (the handoff)

**Step A input** — one organization per line:

```
organization_id[,name]
org_01ABC...,Acme Corp
org_01DEF...,Beta Inc
```

**Step A output** — what WorkOS returns to the customer:

```
organization_id,name,scim_endpoint_url,bearer_token
org_01ABC...,Acme Corp,https://api.workos.com/scim/v2.0/<external_key>,<token>
```

**Step B input** (scim-bridge Bulk import) — the customer merges their native
side onto Step A's output:

```
name,native_url,native_token,workos_url,workos_token
Acme Corp,https://acme.com/scim/v2,<native token>,https://api.workos.com/scim/v2.0/<external_key>,<token>
```

`workos_url` = Step A's `scim_endpoint_url`; `workos_token` = its `bearer_token`.

## Tool shape (monorepo)

A script/CLI in `workos/workos` that, per input organization id:

1. Creates a directory: `type = generic scim v2.0`, `state = active`.
2. Sets `migrated = true` (`setDirectoryMigrated`).
3. Ensures `created_at` lands in the window above.
4. Generates the `external_key` + bearer token via the existing directory-token flow.
5. Appends `organization_id, name, scim_endpoint_url, bearer_token` to the output CSV.

```
# pseudocode — internal-admin GraphQL client
for org_id in read_csv(input):
    dir = admin.createDirectory(organizationId=org_id, type="generic_scim_v2_0", state="active")
    admin.setDirectoryMigrated(directoryId=dir.id, migrated=True)   # commit 0c36ea037ab
    # created_at window + LD flag are environment prerequisites (see the migration guide)
    write_row(org_id, dir.name, dir.scim_endpoint_url, dir.bearer_token)
```

**Blocked on:** a bulk `createDirectory` internal-admin mutation. Only
`setDirectoryMigrated` exists on the branch today; the create-and-return-token
path still needs adding. Until then, directories are created via the dashboard /
Admin Portal and their endpoint + token pasted into Step B by hand.
