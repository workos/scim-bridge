# WorkOS SCIM data requirements

What the WorkOS SCIM endpoint requires of every user and group it is handed,
extracted from the validations WorkOS enforces server-side (verified against
the WorkOS SCIM v2.0 implementation, August 2026) and phrased as a checklist to
run against your users database **before** the first dual-write or backfill.
Every check is a query you can run on day one, before anything migrates. Every
violation found later costs a rejected write — and the worst one also leaves a
user held in limbo on the WorkOS side and silently dropped from group syncs.

The bridge surfaces each rejection with WorkOS's own reason: the backfill
summary, the **Activity** tab, and the native-writes card all show lines like
`Users/u1: WorkOS POST returned 400 (invalidValue: Required attributes missing:
emails)`. So this page doubles as the decoder for those messages — the
[rejection table](#what-a-rejection-looks-like-in-the-bridge) maps each one
back to a checklist item.

## The checklist

### Users

Only the first two are **hard requirements** — a user violating either is
rejected outright *and* held on the WorkOS side (see
[what happens to a rejected user](#what-happens-on-the-workos-side-when-a-user-is-rejected)).
The rest each cost something quieter.

- [ ] **Every user has a non-empty `userName`.** Hard requirement, on create
  and on full replace alike. WorkOS also lowercases it into the user's unique
  identifier, so treat it as case-insensitive (next item).

- [ ] **Every user has a usable email.** The exact rule: `emails` must contain
  at least one entry whose `value` is non-blank (not absent, not `""`, not
  whitespace). A user failing that gets one escape hatch — a `userName` that is
  itself a well-formed email address, from which WorkOS backfills
  `emails: [{ primary: true, type: "work", value: <userName> }]`. A user with
  neither is **rejected with `Required attributes missing: emails`**. This is
  the requirement most home-grown SCIM stores fail — service accounts and
  legacy rows seeded without emails — and the audit is one query: *no user may
  have an empty/blank email list unless their `userName` is an email address.*

- [ ] **Email values are well-formed addresses, and each user has a primary
  one.** WorkOS never rejects a malformed email — it accepts the user and
  silently records them with **no primary email**. Same silent outcome when no
  entry is usable as primary: WorkOS picks the entry flagged `primary: true`,
  else the first `type: "work"` entry, else the first `type: "home"` entry —
  an email list with none of those stores the raw list but no primary address.
  Audit: values parse as email addresses, and every user has an entry that is
  `primary`, `work`, or `home`.

- [ ] **`userName` is unique within each directory, case-insensitively.**
  `ACME\jdoe` and `acme\JDOE` are the same user to WorkOS. A duplicate is
  rejected with `409` `Another user already exists with this username '…'`.

- [ ] **No two *active* users share an email, case-insensitively.** Rejected
  with `409` `Another user already exists with this email '…'`. Only active
  users block — a deactivated user's address can be reused.

- [ ] **`active` is a real JSON boolean.** `"true"`/`"false"` strings are
  rejected on create and replace (`'active' is expected boolean, received
  string`). If your store serializes booleans as strings, fix the
  serialization, not the data. (The same strictness applies to types
  generally: `emails` must be an array of objects with string `value`s, and
  `name.givenName`/`name.familyName` must be strings — the bridge already
  drops `null`-valued keys from WorkOS-bound bodies, so `null`s only bite
  inside `PATCH` operations.)

- [ ] **Decide what happens to your deactivated users.** Creating a user with
  `active: false` is rejected when your WorkOS environment has **user
  suspension soft-delete off** — so backfilling a database that retains
  deactivated users needs that setting **on** (the choice you make with WorkOS
  in [Step A](./migration-guide.md#choose-your-deletion-semantics-suspension-soft-delete),
  and one more reason most migrating customers want it on). This is also the
  one rejection whose error body carries no readable reason: the bridge shows
  a bare `WorkOS POST returned 400` with no parenthetical.

- [ ] **Users have first and last names** (`name.givenName`,
  `name.familyName`). Soft: a user missing either is accepted and goes live —
  events fire — but each miss is recorded as a processing error on the user in
  the WorkOS dashboard. Clean it up now or accept the noise.

### Groups

- [ ] **Every group has a non-empty `displayName`.** Hard requirement —
  rejected with `'displayName' is required`.

- [ ] **Every group has a stable, unique identity.** WorkOS identifies a group
  by `externalId` when present, else by `displayName`, and rejects a
  collision with `409` `Another group already exists with this ID '…'`. Two
  groups sharing a `displayName` and lacking `externalId`s collide; and the
  identity is sticky across renames, so a *renamed* group still holds its old
  name as its identity. Audit: every group carries a unique `externalId` — or,
  failing that, a `displayName` unique across the directory's history, not
  just its present.

- [ ] **Every group member resolves to a live user.** WorkOS **silently
  drops** member values it cannot resolve — the group is accepted, minus those
  members, with the drop logged only on the WorkOS side. Two ways to hit it: a
  `members[].value` pointing at a user id that doesn't exist, and a member
  whose user was rejected by the userName/email checks above. The bridge
  backfills users before groups, so ordering is never the cause — data quality
  is. (Member `value`s must also be non-empty strings; an empty one is
  rejected at the schema.)

### Payload

- [ ] **No single resource body over 2,000 KB.** Requests above the limit are
  rejected with `413` (shown bare in the bridge — the response isn't a SCIM
  error body). Only realistic for enormous groups, whose full member list
  travels in one body on create and replace.

## What a rejection looks like in the bridge

The backfill summary, Activity rows, and native-writes card carry WorkOS's
`scimType` and `detail` in parentheses after the status. The ones this
checklist predicts:

| You see | It means | Fix |
| --- | --- | --- |
| `400 (invalidValue: Required attributes missing: emails)` — `invalidSyntax` on a replace | No `emails[]` entry with a non-blank value, and `userName` is not an email address. The user is now **held** on the WorkOS side — see below. | Add an email (or email-shaped `userName`) in your database, re-run backfill. |
| `400 (invalidValue: 'userName' is required)` | Missing/empty `userName`. | Populate it, re-run backfill. |
| `400 (invalidSyntax: 'active' is expected boolean, received string)` | Boolean serialized as a string. | Fix the serialization. |
| `400` with no parenthetical, on a deactivated user | `active: false` on create while the environment's suspension soft-delete is off. | Have WorkOS enable soft-delete ([Step A](./migration-guide.md#choose-your-deletion-semantics-suspension-soft-delete)). |
| `409 (Another user already exists with this username '…')` | Duplicate `userName` (case-insensitive) in the directory. | Deduplicate, re-run backfill. |
| `409 (Another user already exists with this email '…')` | Two active users share an address (case-insensitive). | Deduplicate or deactivate one. |
| `400 (invalidValue: 'displayName' is required)` | Group without a name. | Populate it. |
| `409 (Another group already exists with this ID '…')` | Group identity (`externalId`, else `displayName`) collides with a live — or renamed — group. | Give groups unique `externalId`s. |
| Group mirrored fine, but members are missing in WorkOS | Unresolvable members were silently dropped — usually users rejected by the checks above. | Fix the users, re-run backfill; the group's next write restores them. |
| `413` | Resource body over 2,000 KB. | Almost certainly a giant group — split it. |

Exact wording of the `4xx` bodies can vary slightly with WorkOS-side flags;
the *accept/reject decisions above do not* — flags there change the error
envelope, never the rule.

## What happens on the WorkOS side when a user is rejected

A user failing the hard checks (`userName`, usable email) is not simply
bounced: WorkOS **persists them in a `Validating` state** with a processing
error, returns the `400`, and emits no Directory Sync events for them. While
they are held, every group sync that references them drops them from the
member list. The hold is self-healing in exactly the way a backfill wants:
re-sending the corrected payload merges into the held row (no duplicate, no
`409`), so the loop is *fix the data → re-run backfill* — the user goes live
and the next pass over their groups restores the memberships. Backfill is
idempotent, so re-running it after each round of fixes costs nothing.

## Scope

This page lists **data-level** checks — things a query against your users
database can catch before migration. Protocol-level validation (PATCH
operation shapes, filter grammar, content types, auth) applies to what the IdP
sends at runtime, is forwarded by the bridge verbatim, and is not something a
data audit can prevent; the [runbook's troubleshooting
table](./runbook.md#troubleshooting) covers those as they surface.
