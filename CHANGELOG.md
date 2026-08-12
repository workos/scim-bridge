# Changelog

Notable changes to scim-bridge, written for the person deciding whether to
upgrade a proxy that sits in front of their identity provider. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The release workflow reads the section matching a tag and refuses to cut a
release without one — see [docs/releasing.md](docs/releasing.md).

Container images for each version:
`docker pull ghcr.io/workos/scim-bridge:<version>` (`linux/amd64`, `linux/arm64`).

## [Unreleased]

## [0.3.1]

A single security fix on top of 0.3.0.

### Security

- **A 409-recovery no longer records a mapping onto another resource's WorkOS
  row.** When a create raced and the proxy recovered by resolving the resource
  through a `userName`/`displayName` filter, it adopted whatever row WorkOS
  returned — including one this directory already mirrors under a different id.
  A holder of a directory's proxy token could use that to make one resource's id
  alias another's, and a later `DELETE` would then remove the other resource's
  WorkOS row while the native side reported nothing wrong. The recovery now
  refuses to record a mapping onto a WorkOS id already claimed by a different
  resource, closing the last of the id-aliasing write paths.

## [0.3.0]

The first 0.3 release: it adds an ordered event transport and a Postgres
datastore option, changes how a deleted user is handled after cutover, and
hardens the control panel — a minor bump on several fronts.

### Added

- **Events API transport for the DSync listener.** The reference listener can
  poll `GET /events` with a persisted cursor instead of receiving webhooks. The
  Events API delivers events **in order**, which webhooks do not — the
  recommended transport for a migration, because out-of-order delivery is a
  source of drift between your app and WorkOS. Set `WORKOS_API_KEY` to turn it
  on; webhooks remain supported. See `docs/listener-status.md`.
- **End-to-end migration guide** (`docs/migration-guide.md`): the whole path
  from the directories WorkOS provisions for you, through import, IdP
  repointing, and the mode ladder with lossless rollback.
- **Postgres datastore.** `DATABASE_DRIVER=postgres` with `DATABASE_URL` runs
  the bridge against RDS/Aurora or any Postgres instead of a SQLite file — for
  operators who would rather point at a managed database than mount a volume.
  SQLite remains the default and the recommendation for a single instance.
- **Per-directory status endpoint** (`GET /status/directories/{id}`) so your
  DSync listener can ask, per directory, whether WorkOS is authoritative yet
  instead of hardcoding the cutover moment.
- **Control-panel affordances** for the demo: switch the listener between
  webhooks and the Events API, set a per-directory Events API key, and choose
  whether the native app hard-deletes or deactivates in place on a delete.
- **Boot warning when the database is on a disk that will not survive**, which
  is the failure that loses every id mapping in the migration.
- **Cloudflare Containers deployment template** under `deploy/`.

### Changed

- **The reference listener deactivates a user in place on `dsync.user.deleted`
  instead of hard-deleting.** With suspension soft-delete off, a deactivation
  arrives as `user.deleted`; keeping the row (and its group memberships) as
  inactive makes a rehire round-trip cleanly and makes an out-of-order or stale
  delivery non-destructive. Deactivate-in-place is the recommended app behavior;
  actual purging is a retention-policy decision, not an event handler's.
- **The Live-state diff distinguishes a retained-inactive tombstone from real
  drift** on both sides — a user one system keeps inactive after the other
  removed it no longer counts as divergence — and the native Database node now
  shows its active-user count alongside WorkOS, so the living sets read straight
  across.
- **Proxy tokens are hashed at rest.** Existing plaintext tokens are converted
  on first boot; the tokens themselves keep working, they are just no longer
  readable from the database. No action required.
- Backfill writes its id mappings in batches, which makes large directories
  materially faster.
- Retries are attempted only for errors a driver classified as transient,
  rather than for anything that threw.

### Fixed

- **A `DELETE` the native app reports as already gone now still deletes from
  WorkOS** in `dual-write`. Previously a native `404` cancelled the mirror, so
  the user stayed live in WorkOS — and because the proxy returns native's `404`
  and the IdP treats an idempotent delete as done, it was never retried and
  nothing else removed the row. Only `DELETE` and only `404` behave this way;
  a `404` on `POST`/`PUT`/`PATCH` still suppresses the mirror.
- A `PUT` that replaces a resource no longer adopts the path id as a mapping
  when the body disagrees — the case that could cross-link two resources.
- Native rows are never attributed by a tenant-supplied `externalId` alone.

### Security

- **The already-gone `DELETE` no longer retires divergence records named by the
  request body.** A native `404` says nothing about resources the request did
  not address, so a holder of a directory's proxy token could clear that
  directory's deprovisioning gaps — the panel's cutover signal — by naming them
  in the body of a `DELETE` for an id that does not exist. It now retires only
  the path's own row, and only once the mirror has removed the resource from
  WorkOS.
- **Panel auth fails closed** when only one of `PANEL_AUTH_USER` /
  `PANEL_AUTH_PASSWORD` is set. Previously a half-configured panel served
  unauthenticated; it now refuses to start. Check both are set before upgrading.
- Panel credentials are compared in constant time.
- **The control panel rejects cross-site state-changing requests.** Panel
  mutations are validated against `Sec-Fetch-Site`/`Origin`, so a forged
  cross-site request can no longer ride a cached Basic-auth session to
  reconfigure or exfiltrate a directory. Scripted/non-browser use can opt out
  with `PANEL_CSRF_DISABLED=true`. The `/scim/v2` data plane is unaffected.
- **Operator-supplied upstream URLs are validated.** Saving a native or WorkOS
  endpoint is restricted to `http`/`https`, blocks cloud-metadata addresses, and
  upstream SCIM calls no longer follow redirects — so a mistyped or hostile URL
  cannot turn the bridge into a request relay into its own network.
- **Closed id-aliasing write paths.** A holder of a directory's proxy token
  could record a second mapping onto a resource the directory already mirrors,
  which a later `DELETE` could use to remove that resource's WorkOS row
  undetected. The create and replace mint sites now refuse to adopt an id
  already claimed by another resource. (One further recovery path is closed in
  0.3.1.)

## [0.2.2] - 2026-07-15

### Added

- Directory table and a shared flow-rail in the control panel, so the migration
  stage of every directory is visible at a glance.

### Changed

- Backfill reporting and progress detail.
- Demo-only screens moved into their own navigation group, so a production
  panel no longer advertises the simulators.

## [0.2.1] - 2026-07-14

### Added

- **`APP_ENCRYPTION_KEY`** — when set, each directory's native and WorkOS bearer
  tokens are encrypted at rest with AES-256-GCM. Keep the key stable: rotating
  or removing it leaves existing encrypted tokens unreadable.

### Changed

- Container and configuration documentation refreshed.

## [0.2.0] - 2026-07-14

### Changed

- **Breaking: "connection" is now "directory"** throughout the panel, the API
  and the database, matching WorkOS's own vocabulary. Imports made against
  0.1.0 need to be re-imported.
- The DSync listener resolves migration mode **per directory** rather than
  globally, so directories can be at different stages of the same migration.

### Added

- Directory import flow in the control panel.

## [0.1.0] - 2026-07-13

### Added

- First release: the SCIM migration proxy (passthrough → dual-write → backfill →
  cut over, reversible until commit), the control panel, and a Docker image.

[unreleased]: https://github.com/workos/scim-bridge/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/workos/scim-bridge/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/workos/scim-bridge/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/workos/scim-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/workos/scim-bridge/releases/tag/v0.1.0
