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

export async function getDirectoryByToken(
  db: D1Database,
  token: string,
): Promise<Directory | null> {
  if (!token) return null;
  return withD1Retry(() =>
    db
      .prepare("SELECT * FROM scim_directories WHERE proxy_token = ?")
      .bind(token)
      .first<Directory>(),
  );
}

export async function getDirectoryById(db: D1Database, id: string): Promise<Directory | null> {
  return withD1Retry(() =>
    db.prepare("SELECT * FROM scim_directories WHERE id = ?").bind(id).first<Directory>(),
  );
}

export async function listDirectories(db: D1Database): Promise<Directory[]> {
  const { results } = await withD1Retry(() =>
    db.prepare("SELECT * FROM scim_directories ORDER BY created_at").all<Directory>(),
  );
  return results;
}

export async function setDirectoryMode(db: D1Database, id: string, mode: Mode): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare("UPDATE scim_directories SET mode = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(mode, id)
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
