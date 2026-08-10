# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue.**

Report it to <security@workos.com>. If you'd like to encrypt the report, our key
is at <https://workos.com/.well-known/pgp-key.txt>.

Please include:

- what an attacker can do, and what they need to start with
- the steps to reproduce it
- the version or image digest you tested against (`docker buildx imagetools inspect ghcr.io/workos/scim-bridge:latest` prints the digest)

We'll acknowledge your report and keep you updated as we work on a fix. If you'd
like credit in the release notes, say so and tell us how you'd like to be named.

## Supported versions

Fixes land on `main` and go out in the next release. Only the latest release is
supported — this is an operational tool used for the length of a migration, not a
long-lived library, so please upgrade rather than expect backports.

## What this tool is trusted with

Worth knowing when judging whether something is a vulnerability. During a
migration this process holds, for every directory it is configured with:

- the **bearer token the IdP presents**, which is how a SCIM request is routed to
  a directory (stored as a SHA-256 digest, never in the clear)
- the **native application's SCIM token** and the **WorkOS directory token**,
  which are upstream credentials it uses on every request (encrypted at rest when
  `APP_ENCRYPTION_KEY` is set, and in the clear when it is not)
- the **id mappings** that let it translate a resource id between the two sides —
  irreplaceable, and the reason losing the database mid-migration is disruptive
- the **divergence ledger** (`native_write_failures`), which records writes WorkOS
  accepted and the native application did not. It is the operator's repair queue
  **and their cutover gate**, so anything that can silently empty it is a
  security issue even though it changes no user's state.

Reports that turn a visible failure into a silent one are in scope, and are taken
as seriously as ones that change data.

## Deployment expectations

These are assumptions the threat model makes. A finding that depends on breaking
one of them is still worth reporting, but say which:

- **`/panel` is authenticated.** It renders every directory's upstream tokens. The
  container refuses to start without `PANEL_AUTH_USER` and `PANEL_AUTH_PASSWORD`
  unless `PANEL_AUTH_DISABLED=true` says something in front of it authenticates
  instead. It logs a warning on every boot when you do that, deliberately.
- **`/scim/v2/*` and `/status/directories/*` are publicly reachable and are
  authenticated per directory** by the bearer token the IdP presents.
- **TLS is terminated in front of this process.** It serves plain HTTP.
- **One instance per database.** The proxy and the DSync listener assume a single
  writer, on either datastore driver.
- **A directory's proxy token is a trusted position**, held by the customer's IdP.
  Findings that escalate *beyond* that position — reaching another directory,
  another tenant, or the operator's own signals — are the interesting ones.
