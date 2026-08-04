/**
 * Every generated id and secret the app mints, in one place.
 *
 * These used to be column DEFAULTs (`'dir_' || lower(hex(randomblob(8)))`) and
 * two `INSERT`s in migration 0002. That works only as long as SQLite is the only
 * engine: each driver would otherwise reproduce a different id shape, and a
 * credential whose value depends on which datastore you picked is a bad
 * property. Generating here also means the proxy token — the value ENT-6741 made
 * importable — has exactly one origin in the code.
 *
 * `crypto.getRandomValues` is available identically on Node and Workers, as
 * `workers/shared/crypto.ts` already assumes.
 */

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A directory's own id (`dir_…`), as the panel and the status endpoint show it. */
export function newDirectoryId(): string {
  return `dir_${randomHex(8)}`;
}

/**
 * The bearer token an IdP presents to reach one directory. 24 bytes: this is the
 * only credential guarding the SCIM data-plane, and it travels in a header the
 * customer's IdP config holds forever.
 */
export function newProxyToken(): string {
  return randomHex(24);
}

/** A bearer token for one of the bundled endpoints (the native app's SCIM server,
 *  the mock WorkOS directory). Seeded at boot, not by a migration. */
export function newScimToken(): string {
  return randomHex(16);
}

export function newIdpUserId(): string {
  return `idpu_${randomHex(8)}`;
}

export function newIdpGroupId(): string {
  return `idpg_${randomHex(8)}`;
}
