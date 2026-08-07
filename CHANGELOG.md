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

The next release is **0.3.0**: it adds a datastore choice and changes how
credentials are stored, both of which are worth a minor bump.

### Added

- **Postgres datastore.** `DATABASE_DRIVER=postgres` with `DATABASE_URL` runs
  the bridge against RDS/Aurora or any Postgres instead of a SQLite file — for
  operators who would rather point at a managed database than mount a volume.
  SQLite remains the default and the recommendation for a single instance.
- **Per-directory status endpoint** (`GET /status/directories/{id}`) so your
  DSync listener can ask, per directory, whether WorkOS is authoritative yet
  instead of hardcoding the cutover moment.
- **Boot warning when the database is on a disk that will not survive**, which
  is the failure that loses every id mapping in the migration.
- **Cloudflare Containers deployment template** under `deploy/`.

### Changed

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

- **Panel auth fails closed** when only one of `PANEL_AUTH_USER` /
  `PANEL_AUTH_PASSWORD` is set. Previously a half-configured panel served
  unauthenticated; it now refuses to start. Check both are set before upgrading.
- Panel credentials are compared in constant time.

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
