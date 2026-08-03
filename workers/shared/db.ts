import { decryptSecret, encryptSecret } from "./crypto";
import type { Directory, IdMapping, Mode, ProxyLogEntry, ResourceType } from "./types";

/** Retry transient local-dev D1 errors (miniflare surfaces these when several
 *  wrangler dev processes hit one SQLite file concurrently). Not needed against
 *  real D1, but harmless there. */
export async function withD1Retry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        /database is locked|SQLITE_BUSY|internal error|Failed to parse body as JSON|Network connection lost|storage caused object to be reset|reset because its code was updated/i.test(
          message,
        );
      if (!transient) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await withD1Retry(() =>
    db.prepare("SELECT value FROM poc_config WHERE key = ?").bind(key).first<{ value: string }>(),
  );
  return row?.value ?? null;
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "INSERT INTO poc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(key, value)
      .run(),
  );
}

/** Decrypt the at-rest secrets on a directory row (native/WorkOS tokens). No-op
 *  when encryption is off or the value is plaintext. */
async function decryptDirectory(
  db: D1Database,
  directory: Directory | null,
): Promise<Directory | null> {
  if (!directory) return null;
  directory.native_token = await decryptSecret(db, directory.native_token);
  directory.workos_token = await decryptSecret(db, directory.workos_token);
  return directory;
}

export async function getDirectoryByToken(
  db: D1Database,
  token: string,
): Promise<Directory | null> {
  if (!token) return null;
  return decryptDirectory(
    db,
    await withD1Retry(() =>
      db
        .prepare("SELECT * FROM scim_directories WHERE proxy_token = ?")
        .bind(token)
        .first<Directory>(),
    ),
  );
}

export async function getDirectoryById(db: D1Database, id: string): Promise<Directory | null> {
  return decryptDirectory(
    db,
    await withD1Retry(() =>
      db.prepare("SELECT * FROM scim_directories WHERE id = ?").bind(id).first<Directory>(),
    ),
  );
}

export async function listDirectories(db: D1Database): Promise<Directory[]> {
  const { results } = await withD1Retry(() =>
    db.prepare("SELECT * FROM scim_directories ORDER BY created_at").all<Directory>(),
  );
  return Promise.all(results.map((d) => decryptDirectory(db, d) as Promise<Directory>));
}

export interface NewDirectory {
  name: string;
  native_url?: string;
  native_token?: string;
  workos_url?: string;
  workos_token?: string;
  workos_directory_id?: string;
  /** The bearer token the IdP will present, when it already has one to keep (a
   *  DNS swap in front of an existing SCIM hostname). Omitted → the schema mints
   *  one. Stays plaintext: it is the routing key `getDirectoryByToken` looks up. */
  proxy_token?: string;
}

/** Create a directory, encrypting the native/WorkOS tokens at rest. */
export async function insertDirectory(
  db: D1Database,
  directory: NewDirectory,
): Promise<{ id: string } | null> {
  const columns = [
    "name",
    "native_url",
    "native_token",
    "workos_url",
    "workos_token",
    "workos_directory_id",
  ];
  const values: unknown[] = [
    directory.name,
    directory.native_url ?? "",
    await encryptSecret(db, directory.native_token ?? ""),
    directory.workos_url ?? "",
    await encryptSecret(db, directory.workos_token ?? ""),
    directory.workos_directory_id || null,
  ];
  // Left out of the statement entirely when no token is supplied, so the
  // column's DEFAULT generates one exactly as it did before imports could carry
  // a token.
  const proxyToken = directory.proxy_token?.trim();
  if (proxyToken) {
    columns.push("proxy_token");
    values.push(proxyToken);
  }
  return withD1Retry(() =>
    db
      .prepare(
        `INSERT INTO scim_directories (${columns.join(", ")}) ` +
          `VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
      )
      .bind(...values)
      .first<{ id: string }>(),
  );
}

/** A directory declared by environment rather than imported through the panel:
 *  what a customer's own app knows about a directory — the WorkOS id its DSync
 *  events carry, and the proxy token they configured their IdP with. */
export interface EnvDirectory {
  workos_directory_id: string;
  proxy_token: string;
  name: string;
}

/**
 * Make `scim_directories` match a declared set exactly: drop every row that is
 * no longer declared, then create or update the declared ones. Each row's
 * primary key IS its WorkOS directory id, so one value both resolves the row
 * from an event's `directory_id` and works as `{id}` in the bridge's
 * `GET /status/directories/{id}` (which accepts either side's id). Rows carry no
 * upstream URLs or tokens — nothing here proxies SCIM; a row exists so a
 * listener can find its directory and status credential. The mode is left at the
 * table default (`passthrough`), the safe answer if the status endpoint is ever
 * unreachable: the listener stays inert.
 *
 * One transaction, and the deletes run first: `proxy_token` is UNIQUE across the
 * table, so a token that moved to a different directory id would otherwise
 * collide with the row still holding it.
 */
export async function reconcileDirectories(
  db: D1Database,
  directories: EnvDirectory[],
): Promise<void> {
  const ids = directories.map((d) => d.workos_directory_id);
  const undeclared = ids.length
    ? db
        .prepare(`DELETE FROM scim_directories WHERE id NOT IN (${ids.map(() => "?").join(", ")})`)
        .bind(...ids)
    : db.prepare("DELETE FROM scim_directories");
  await withD1Retry(() =>
    db.batch([
      undeclared,
      ...directories.map((directory) =>
        db
          .prepare(
            "INSERT INTO scim_directories (id, name, proxy_token, workos_directory_id) " +
              "VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET " +
              "name = excluded.name, proxy_token = excluded.proxy_token, " +
              "updated_at = datetime('now')",
          )
          .bind(
            directory.workos_directory_id,
            directory.name,
            directory.proxy_token,
            directory.workos_directory_id,
          ),
      ),
    ]),
  );
}

export async function setDirectoryNative(
  db: D1Database,
  id: string,
  url: string,
  token: string,
): Promise<void> {
  const encrypted = await encryptSecret(db, token);
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET native_url = ?, native_token = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(url, encrypted, id)
      .run(),
  );
}

export async function setDirectoryWorkos(
  db: D1Database,
  id: string,
  url: string,
  token: string,
): Promise<void> {
  const encrypted = await encryptSecret(db, token);
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET workos_url = ?, workos_token = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(url, encrypted, id)
      .run(),
  );
}

export async function setDirectoryWorkosDirectoryId(
  db: D1Database,
  id: string,
  workosDirectoryId: string,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET workos_directory_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(workosDirectoryId || null, id)
      .run(),
  );
}

export async function setDirectoryMode(db: D1Database, id: string, mode: Mode): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare("UPDATE scim_directories SET mode = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(mode, id)
      .run(),
  );
}

/** Whether this directory's proxy requests should be written to proxy_log. Off
 *  by default (migration 0006) so a large fleet of directories doesn't fill the
 *  log; the request still proxies and mirrors identically when off. */
export function shouldPersistLogs(directory: Directory | null | undefined): boolean {
  return Boolean(directory && directory.log_persistence);
}

export async function setDirectoryLogPersistence(
  db: D1Database,
  id: string,
  on: boolean,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET log_persistence = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(on ? 1 : 0, id)
      .run(),
  );
}

/** Bulk toggle for the control panel's multi-select. */
export async function setDirectoriesLogPersistence(
  db: D1Database,
  ids: string[],
  on: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await withD1Retry(() =>
    db
      .prepare(
        `UPDATE scim_directories SET log_persistence = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`,
      )
      .bind(on ? 1 : 0, ...ids)
      .run(),
  );
}

export async function getMapping(
  db: D1Database,
  directoryId: string,
  resourceType: ResourceType,
  nativeId: string,
): Promise<IdMapping | null> {
  return withD1Retry(() =>
    db
      .prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND native_id = ?",
      )
      .bind(directoryId, resourceType, nativeId)
      .first<IdMapping>(),
  );
}

export async function getMappingByWorkosId(
  db: D1Database,
  directoryId: string,
  resourceType: ResourceType,
  workosId: string,
): Promise<IdMapping | null> {
  return withD1Retry(() =>
    db
      .prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND workos_id = ?",
      )
      .bind(directoryId, resourceType, workosId)
      .first<IdMapping>(),
  );
}

export async function upsertMapping(
  db: D1Database,
  mapping: Pick<
    IdMapping,
    "directory_id" | "resource_type" | "native_id" | "workos_id" | "strategy"
  >,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) " +
          "VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (directory_id, resource_type, native_id) DO UPDATE SET " +
          "workos_id = excluded.workos_id, strategy = excluded.strategy, updated_at = datetime('now')",
      )
      .bind(
        mapping.directory_id,
        mapping.resource_type,
        mapping.native_id,
        mapping.workos_id,
        mapping.strategy,
      )
      .run(),
  );
}

export async function deleteMapping(
  db: D1Database,
  directoryId: string,
  resourceType: ResourceType,
  nativeId: string,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "DELETE FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND native_id = ?",
      )
      .bind(directoryId, resourceType, nativeId)
      .run(),
  );
}

/** Wipe the native app's directory and its DSync listener log — the customer
 *  app's own state. Leaves directories, mappings, and the WorkOS side alone. */
export async function clearNativeDirectory(db: D1Database): Promise<void> {
  await withD1Retry(() =>
    db.batch([
      db.prepare("DELETE FROM native_group_members"),
      db.prepare("DELETE FROM native_groups"),
      db.prepare("DELETE FROM native_users"),
      db.prepare("DELETE FROM listener_events"),
      db.prepare("DELETE FROM listener_versions"),
    ]),
  );
}

const BODY_LIMIT = 8_192;

export function truncateBody(body: string | null | undefined): string | null {
  if (body == null || body === "") return null;
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}… [truncated]` : body;
}

export type ProxyLogInsert = Partial<Omit<ProxyLogEntry, "id" | "ts">> &
  Pick<ProxyLogEntry, "mode" | "method" | "path">;

export async function insertProxyLog(db: D1Database, entry: ProxyLogInsert): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "INSERT INTO proxy_log (directory_id, source, mode, method, path, request_body, " +
          "native_status, native_ms, native_body, workos_request, workos_status, workos_ms, " +
          "workos_body, response_status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        entry.directory_id ?? null,
        entry.source ?? "idp",
        entry.mode,
        entry.method,
        entry.path,
        truncateBody(entry.request_body),
        entry.native_status ?? null,
        entry.native_ms ?? null,
        truncateBody(entry.native_body),
        entry.workos_request ?? null,
        entry.workos_status ?? null,
        entry.workos_ms ?? null,
        truncateBody(entry.workos_body),
        entry.response_status ?? null,
        entry.error ?? null,
      )
      .run(),
  );
}
