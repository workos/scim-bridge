# WorkOS SCIM data requirements

What the WorkOS SCIM endpoint requires of every user and group it is handed,
extracted from the validations WorkOS enforces server-side (baseline verified
against the WorkOS SCIM v2.0 implementation in August 2026; provider and
migration setup checks reviewed in September 2026) and phrased as a checklist
to run against your users database **before** the first dual-write or backfill.
Check the directory's provider and migration setup with WorkOS as well as the
data: some requirements depend on the directory type and setup state. Rejected
users can also be absent from group syncs.

The bridge surfaces each rejection with WorkOS's own reason: the backfill
summary, the **Activity** tab, and the native-writes card all show lines like
`Users/u1: WorkOS POST returned 400 (invalidValue: Required attributes missing:
emails)`. So this page doubles as the decoder for those messages — the
[rejection table](#what-a-rejection-looks-like-in-the-bridge) maps each one
back to a checklist item.

## The checklist

### Directory setup and provider identities

- [ ] **The imported directory type matches the actual upstream IdP.** The
      `type` in the list you give WorkOS is selected by you, not auto-detected from
      SCIM traffic or the bridge credentials CSV. Confirm it with WorkOS during
      [Step A](./migration-guide.md#step-a--workos-provisions-your-directories),
      including for a previously imported directory. Do not select Generic SCIM
      just to bypass a provider-specific validation.

- [ ] **Known user `externalId`s contain the actual IdP identifier.** For
      `Okta SCIM v2.0`, this is the Okta user ID (20 characters beginning `00u`);
      for `Azure SCIM v2.0`, it is the Microsoft Entra object ID (a GUID). During
      setup, when the directory is `Validating` and WorkOS has enabled provider
      ID format enforcement for the team, a `POST /Users` with a missing or
      malformed `externalId` can be rejected with `400 invalidValue`. This check
      does not reject PUT/PATCH, but a bridge PUT that returns `404` falls back to
      POST and therefore encounters the create check.

- [ ] **Legacy users without `externalId` have an agreed migration path.**
      Before enabling dual-write or running backfill, have WorkOS confirm that
      server support for these imports is available in your target environment.
      The required support must accept an omitted `externalId` on a trusted
      migrated create and preserve an IdP `externalId` learned later when a
      migrated full replacement omits it. Importing a directory or deploying the
      bridge alone does not establish that this support is deployed. A malformed
      identifier that is present is not the same as an absent one.

Keep these identities separate:

| Value                          | Meaning                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory import `external_id` | Your existing directory/tenant identifier; marks the WorkOS directory as migrated.                                                                              |
| User resource `id`             | Your native SCIM resource ID, carried separately in `X-WorkOS-Migrated-Id` under the [migrated-id contract](../README.md#how-workos-handles-each-scim-request). |
| User resource `externalId`     | The IdP's identifier for that user, such as the real Okta user ID. It need not equal the native resource ID.                                                    |

The bridge mirrors the native resource and strips null-valued keys; it has no
built-in lookup against Okta or Entra to enrich missing identifiers. If the
native record omitted `externalId`, backfill cannot recover it. Preserve the
native `id` and coordinate migration support with WorkOS; if you can recover
the real IdP identifier from an authoritative source, supply that value. Do
not copy an email or native ID into `externalId`, generate a lookalike
`00u...` value, or rename native IDs to satisfy the format check.

### Users

The first two checks cover required user attributes; the provider setup checks
above, uniqueness constraints, and payload validation can also reject writes.
A user failing the `userName` or usable-email checks can be held on the WorkOS
side (see
[what happens to a rejected user](#what-happens-on-the-workos-side-when-a-user-is-rejected)).

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
      legacy rows seeded without emails — and the audit is one query: _no user may
      have an empty/blank email list unless their `userName` is an email address._

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

- [ ] **No two _active_ users share an email, case-insensitively.** Rejected
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
      identity is sticky across renames, so a _renamed_ group still holds its old
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

| You see                                                                                                        | It means                                                                                                                                                | Fix                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ``400 (invalidValue: externalId must be an Okta user ID (e.g. `00u...`) for Okta SCIM v2.0 directories.)``     | A create failed the Okta-specific setup check. `externalId` may be missing or malformed; this error alone does not prove which. No user row is created. | Check the imported type and actual payload. Supply the real Okta user ID if available; for legacy records without it, confirm server migration support with WorkOS before retrying. |
| `400 (invalidValue: externalId must be a Microsoft Entra object ID (a GUID) for Azure SCIM v2.0 directories.)` | A create failed the Entra-specific setup check. No user row is created.                                                                                 | Check the imported type and actual payload; supply the real object ID or coordinate legacy migration support with WorkOS.                                                           |
| `400 (invalidValue: Required attributes missing: emails)` — `invalidSyntax` on a replace                       | No `emails[]` entry with a non-blank value, and `userName` is not an email address. The user is now **held** on the WorkOS side — see below.            | Add an email (or email-shaped `userName`) in your database, re-run backfill.                                                                                                        |
| `400 (invalidValue: 'userName' is required)`                                                                   | Missing/empty `userName`.                                                                                                                               | Populate it, re-run backfill.                                                                                                                                                       |
| `400 (invalidSyntax: 'active' is expected boolean, received string)`                                           | Boolean serialized as a string.                                                                                                                         | Fix the serialization.                                                                                                                                                              |
| `400` with no parenthetical, on a deactivated user                                                             | `active: false` on create while the environment's suspension soft-delete is off.                                                                        | Have WorkOS enable soft-delete ([Step A](./migration-guide.md#choose-your-deletion-semantics-suspension-soft-delete)).                                                              |
| `409 (Another user already exists with this username '…')`                                                     | Duplicate `userName` (case-insensitive) in the directory.                                                                                               | Deduplicate, re-run backfill.                                                                                                                                                       |
| `409 (Another user already exists with this email '…')`                                                        | Two active users share an address (case-insensitive).                                                                                                   | Deduplicate or deactivate one.                                                                                                                                                      |
| `400 (invalidValue: 'displayName' is required)`                                                                | Group without a name.                                                                                                                                   | Populate it.                                                                                                                                                                        |
| `409 (Another group already exists with this ID '…')`                                                          | Group identity (`externalId`, else `displayName`) collides with a live — or renamed — group.                                                            | Give groups unique `externalId`s.                                                                                                                                                   |
| Group mirrored fine, but members are missing in WorkOS                                                         | Unresolvable members were silently dropped — usually users rejected by the checks above.                                                                | Fix the users, re-run backfill; the group's next write restores them.                                                                                                               |
| `413`                                                                                                          | Resource body over 2,000 KB.                                                                                                                            | Almost certainly a giant group — split it.                                                                                                                                          |

Exact wording of some `4xx` bodies can vary with WorkOS-side configuration.
Provider ID format enforcement also changes whether a setup create is
accepted, so confirm the target environment's behavior during the pilot.

## What happens on the WorkOS side when a user is rejected

The provider `externalId` format rejection is recorded on the directory,
which remains in `Validating`; it does **not** create a held user row. Resolve
the provider mapping or migration support prerequisite, then retry the write.

A user failing the hard checks (`userName`, usable email) is not simply
bounced: WorkOS **persists them in a `Validating` state** with a processing
error, returns the `400`, and emits no Directory Sync events for them. While
they are held, every group sync that references them drops them from the
member list. The hold is self-healing in exactly the way a backfill wants:
re-sending the corrected payload merges into the held row (no duplicate, no
`409`), so the loop is _fix the data → re-run backfill_ — the user goes live
and the next pass over their groups restores the memberships. Backfill is
idempotent, so re-running it after each round of fixes costs nothing.

## Scope

This page lists **data-level** checks and **provider/migration setup** checks
to complete before migration. Protocol-level validation (PATCH
operation shapes, filter grammar, content types, auth) applies to what the IdP
sends at runtime, is forwarded by the bridge verbatim, and is not something a
data audit can prevent; the [runbook's troubleshooting
table](./runbook.md#troubleshooting) covers those as they surface.
