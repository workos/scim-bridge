import {
  decryptSecret,
  encryptSecret,
  hashProxyToken,
  isHashedToken,
  proxyTokenHint,
  timingSafeEqual,
} from "./crypto";
import { newDirectoryId, newProxyToken } from "./ids";
import { TransientDatastoreError, type Datastore } from "./datastore";
import type {
  Directory,
  IdMapping,
  Mode,
  NativeWriteFailure,
  ProxyLogEntry,
  ResourceType,
} from "./types";

/**
 * Retry a datastore operation when the failure was transient.
 *
 * `TransientDatastoreError` is the only signal: each driver classifies its own
 * engine's errors by code - SQLite's `SQLITE_BUSY`/`SQLITE_LOCKED`, Postgres's
 * serialization and deadlock codes plus a connection the pool lost - and anything
 * unclassified is rethrown on the first attempt.
 *
 * There used to be a message-substring fallback as well. It matched `internal
 * error`, which is broad enough to hit errors that are not transient at all, and
 * six attempts of latency in front of the real error is worse for whoever is
 * reading the logs than not retrying. Its other patterns were D1 wording, which
 * nothing produces now.
 *
 * As deployed this is a narrow safety net rather than a hot path: `busy_timeout`
 * absorbs SQLite contention inside the driver, and READ COMMITTED with a single
 * writer means Postgres cannot raise a serialization failure. What it is really
 * for is a connection lost mid-statement — an RDS failover or a restart.
 */
export async function withDatastoreRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof TransientDatastoreError)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function getConfig(db: Datastore, key: string): Promise<string | null> {
  const row = await withDatastoreRetry(() =>
    db.prepare("SELECT value FROM poc_config WHERE key = ?").bind(key).first<{ value: string }>(),
  );
  return row?.value ?? null;
}

export async function setConfig(db: Datastore, key: string, value: string): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO poc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .bind(key, value)
      .run(),
  );
}

/**
 * Set a config value only if the key is absent, and return the value that is
 * actually stored — which may be another instance's, not the one passed in.
 *
 * `setConfig` overwrites, so two instances booting at once would both see a key
 * absent and both write it. For a generated secret that is worse than a lost
 * write: `seedDemoDirectory` copies `native.scim_token` into a directory row, so
 * the loser's token would be stored on the row while the winner's sits in
 * config, and the demo would 401 for a reason two boots old. `DO NOTHING` plus a
 * read-back makes every racer agree on whichever value landed first.
 */
export async function setConfigIfAbsent(
  db: Datastore,
  key: string,
  value: string,
): Promise<string> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO poc_config (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT (key) DO NOTHING",
      )
      .bind(key, value)
      .run(),
  );
  return (await getConfig(db, key)) ?? value;
}

/** Decrypt the at-rest secrets on a directory row (native/WorkOS tokens). No-op
 *  when encryption is off or the value is plaintext. */
async function decryptDirectory(
  db: Datastore,
  directory: Directory | null,
): Promise<Directory | null> {
  if (!directory) return null;
  directory.native_token = await decryptSecret(db, directory.native_token);
  directory.workos_token = await decryptSecret(db, directory.workos_token);
  return directory;
}

/**
 * Resolve the directory a presented bearer token belongs to.
 *
 * The token is hashed and the digest is looked up, so this authenticates without the
 * database holding anything usable (ENT-6742).
 *
 * The match found by SQL is then re-checked in JS with a constant-time compare.
 * Being straight about what that buys, because "constant-time" oversells it: the
 * timing gain is marginal, since what SQL compared is a digest and leaking
 * information about a SHA-256 output does not help an attacker reach the token that
 * produced it. What the recheck actually buys is a *byte-exact* decision. `=` in SQL
 * is collation-dependent — a Postgres deployment with a nondeterministic collation,
 * or a column that ever becomes `CHAR`, can call two different strings equal — and
 * an authentication decision should not rest on the column's collation. It also
 * keeps every credential compare in this codebase going through one helper, which is
 * the property that survives someone later changing this query.
 */
export async function getDirectoryByToken(db: Datastore, token: string): Promise<Directory | null> {
  if (!token) return null;
  const hash = await hashProxyToken(token);
  const row = await withDatastoreRetry(() =>
    db
      .prepare("SELECT * FROM scim_directories WHERE proxy_token_hash = ?")
      .bind(hash)
      .first<Directory>(),
  );
  if (!row || !timingSafeEqual(row.proxy_token_hash, hash)) return null;
  return decryptDirectory(db, row);
}

export async function getDirectoryById(db: Datastore, id: string): Promise<Directory | null> {
  return decryptDirectory(
    db,
    await withDatastoreRetry(() =>
      db.prepare("SELECT * FROM scim_directories WHERE id = ?").bind(id).first<Directory>(),
    ),
  );
}

export async function listDirectories(db: Datastore): Promise<Directory[]> {
  const { results } = await withDatastoreRetry(() =>
    db.prepare("SELECT * FROM scim_directories ORDER BY created_at, name, id").all<Directory>(),
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
   *  DNS swap in front of an existing SCIM hostname). Omitted → a fresh one is
   *  minted. Hashed before it is stored; only the digest reaches the row. */
  proxy_token?: string;
}

/** A created directory: its id, plus the proxy token in the clear. This is the
 *  only moment the token exists in a readable form — nothing can recover it from
 *  the row afterwards, so a caller that needs to show or configure it must take it
 *  from here (ENT-6742). */
export interface CreatedDirectory {
  id: string;
  proxy_token: string;
}

/** Create a directory, encrypting the native/WorkOS tokens at rest and hashing the
 *  proxy token. The id and proxy token are minted here rather than by column
 *  defaults, so every driver produces the same shapes (see shared/ids.ts). */
export async function insertDirectory(
  db: Datastore,
  directory: NewDirectory,
): Promise<CreatedDirectory> {
  const id = newDirectoryId();
  const nativeToken = await encryptSecret(db, directory.native_token ?? "");
  const workosToken = await encryptSecret(db, directory.workos_token ?? "");
  const proxyToken = directory.proxy_token?.trim() || newProxyToken();
  const proxyTokenHash = await hashProxyToken(proxyToken);
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO scim_directories " +
          "(id, name, native_url, native_token, workos_url, workos_token, workos_directory_id, " +
          "proxy_token_hash, proxy_token_hint) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        directory.name,
        directory.native_url ?? "",
        nativeToken,
        directory.workos_url ?? "",
        workosToken,
        directory.workos_directory_id || null,
        proxyTokenHash,
        proxyTokenHint(proxyToken),
      )
      .run(),
  );
  return { id, proxy_token: proxyToken };
}

/**
 * Mint a new proxy token for a directory and return it in the clear.
 *
 * The only way back from a lost token, now that the row holds a digest. The
 * previous token stops working the moment this returns, so whoever rotates has to
 * paste the new one into the IdP before the next sync — which is why the caller
 * gets the plaintext and the panel shows it once.
 */
export async function rotateProxyToken(db: Datastore, id: string): Promise<string> {
  const token = newProxyToken();
  // Hashed outside the retry closure: `withDatastoreRetry` takes a sync arrow, so
  // an `await` in there is a type error (TS1308) rather than a subtle bug.
  const hash = await hashProxyToken(token);
  const { meta } = await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET proxy_token_hash = ?, proxy_token_hint = ?, " +
          "updated_at = datetime('now') WHERE id = ?",
      )
      .bind(hash, proxyTokenHint(token), id)
      .run(),
  );
  if (!meta.changes) throw new Error(`No directory ${id} to rotate.`);
  return token;
}

/**
 * Convert rows written before ENT-6742, where `proxy_token_hash` still holds the
 * plaintext token the column used to be called `proxy_token`.
 *
 * Runs at boot, once, and is a no-op afterwards. It has to happen here rather than
 * in the migration because neither engine computes SHA-256 portably, and it has to
 * happen at boot rather than lazily on first authentication because a lazy version
 * leaves plaintext in the table for as long as a directory stays idle — and puts a
 * "try it both ways" branch in the auth path, which is the branch you least want to
 * get wrong.
 *
 * The `sha256:v1:` prefix is what makes a converted row distinguishable from an
 * unconverted one; see `hashProxyToken` for why the alternative test does not work.
 * This pass is the last moment `proxy_token_hint` can be filled in for these rows.
 */
export async function backfillProxyTokenHashes(db: Datastore): Promise<number> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare("SELECT id, proxy_token_hash FROM scim_directories")
      .all<{ id: string; proxy_token_hash: string }>(),
  );
  const plaintext = results.filter((row) => !isHashedToken(row.proxy_token_hash));
  if (!plaintext.length) return 0;

  const statements = await Promise.all(
    plaintext.map(async (row) =>
      db
        .prepare(
          "UPDATE scim_directories SET proxy_token_hash = ?, proxy_token_hint = ? WHERE id = ?",
        )
        .bind(
          await hashProxyToken(row.proxy_token_hash),
          proxyTokenHint(row.proxy_token_hash),
          row.id,
        ),
    ),
  );
  // One transaction: a partial pass would leave some directories authenticating
  // against a digest and others against a plaintext that nothing hashes to.
  await withDatastoreRetry(() => db.batch(statements));
  return plaintext.length;
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
 * One transaction, and the deletes run first: `proxy_token_hash` is UNIQUE across
 * the table, so a token that moved to a different directory id would otherwise
 * collide with the row still holding it.
 *
 * The declared token is hashed like any other. `DIRECTORIES_JSON` remains the
 * plaintext copy for this role — it is where the customer's app already keeps it —
 * so nothing here needs to read the row back to authenticate outbound.
 */
export async function reconcileDirectories(
  db: Datastore,
  directories: EnvDirectory[],
): Promise<void> {
  const ids = directories.map((d) => d.workos_directory_id);
  const hashes = await Promise.all(directories.map((d) => hashProxyToken(d.proxy_token)));
  const undeclared = ids.length
    ? db
        .prepare(`DELETE FROM scim_directories WHERE id NOT IN (${ids.map(() => "?").join(", ")})`)
        .bind(...ids)
    : db.prepare("DELETE FROM scim_directories");
  await withDatastoreRetry(() =>
    db.batch([
      undeclared,
      ...directories.map((directory, index) =>
        db
          .prepare(
            "INSERT INTO scim_directories " +
              "(id, name, proxy_token_hash, proxy_token_hint, workos_directory_id) " +
              "VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET " +
              "name = excluded.name, proxy_token_hash = excluded.proxy_token_hash, " +
              "proxy_token_hint = excluded.proxy_token_hint, updated_at = datetime('now')",
          )
          .bind(
            directory.workos_directory_id,
            directory.name,
            hashes[index],
            proxyTokenHint(directory.proxy_token),
            directory.workos_directory_id,
          ),
      ),
    ]),
  );
}

export async function setDirectoryNative(
  db: Datastore,
  id: string,
  url: string,
  token: string,
): Promise<void> {
  const encrypted = await encryptSecret(db, token);
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET native_url = ?, native_token = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(url, encrypted, id)
      .run(),
  );
}

export async function setDirectoryWorkos(
  db: Datastore,
  id: string,
  url: string,
  token: string,
): Promise<void> {
  const encrypted = await encryptSecret(db, token);
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET workos_url = ?, workos_token = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(url, encrypted, id)
      .run(),
  );
}

export async function setDirectoryWorkosDirectoryId(
  db: Datastore,
  id: string,
  workosDirectoryId: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "UPDATE scim_directories SET workos_directory_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(workosDirectoryId || null, id)
      .run(),
  );
}

export async function setDirectoryMode(db: Datastore, id: string, mode: Mode): Promise<void> {
  await withDatastoreRetry(() =>
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
  db: Datastore,
  id: string,
  on: boolean,
): Promise<void> {
  await withDatastoreRetry(() =>
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
  db: Datastore,
  ids: string[],
  on: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await withDatastoreRetry(() =>
    db
      .prepare(
        `UPDATE scim_directories SET log_persistence = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`,
      )
      .bind(on ? 1 : 0, ...ids)
      .run(),
  );
}

export async function getMapping(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  nativeId: string,
): Promise<IdMapping | null> {
  return withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND native_id = ?",
      )
      .bind(directoryId, resourceType, nativeId)
      .first<IdMapping>(),
  );
}

export async function getMappingByWorkosId(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  workosId: string,
): Promise<IdMapping | null> {
  return withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND workos_id = ?",
      )
      .bind(directoryId, resourceType, workosId)
      .first<IdMapping>(),
  );
}

/**
 * Mappings of this native id held by *other* directories, each carrying that
 * directory's native base URL and native token so the caller can tell which of
 * them address the same native namespace: ids only collide meaningfully within
 * one native app scoped by one token, so two directories pointed at different
 * endpoints — or at one endpoint under distinct tokens — can mint the same id
 * for unrelated resources. Namespace comparison is the caller's job: the URL
 * needs canonicalisation and the token a constant-time compare, neither of which
 * SQL string equality can do. The token is decrypted here (the JOIN doesn't run
 * through `decryptDirectory`) so the caller compares plaintext.
 */
export async function listOtherMappingsByNativeId(
  db: Datastore,
  directory: Directory,
  resourceType: ResourceType,
  nativeId: string,
): Promise<(IdMapping & { native_url: string; native_token: string })[]> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT m.*, d.native_url, d.native_token FROM id_mappings m " +
          "JOIN scim_directories d ON d.id = m.directory_id " +
          "WHERE m.resource_type = ? AND m.native_id = ? AND m.directory_id != ?",
      )
      .bind(resourceType, nativeId, directory.id)
      .all<IdMapping & { native_url: string; native_token: string }>(),
  );
  return Promise.all(
    results.map(async (row) => ({
      ...row,
      native_token: await decryptSecret(db, row.native_token),
    })),
  );
}

/** The mapping fields a caller supplies; the rest of the row has defaults. */
export type NewMapping = Pick<
  IdMapping,
  "directory_id" | "resource_type" | "native_id" | "workos_id" | "strategy"
>;

/** One string, used by both the single and the batched write, so the two cannot
 *  drift into disagreeing about conflict handling. */
const UPSERT_MAPPING_SQL =
  "INSERT INTO id_mappings (directory_id, resource_type, native_id, workos_id, strategy) " +
  "VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT (directory_id, resource_type, native_id) DO UPDATE SET " +
  "workos_id = excluded.workos_id, strategy = excluded.strategy, updated_at = datetime('now')";

function upsertMappingStatement(db: Datastore, mapping: NewMapping) {
  return db
    .prepare(UPSERT_MAPPING_SQL)
    .bind(
      mapping.directory_id,
      mapping.resource_type,
      mapping.native_id,
      mapping.workos_id,
      mapping.strategy,
    );
}

export async function upsertMapping(db: Datastore, mapping: NewMapping): Promise<void> {
  await withDatastoreRetry(() => upsertMappingStatement(db, mapping).run());
}

/**
 * Write many mappings in one round trip.
 *
 * The backfill's reason for existing (ENT-6761): it mirrors a resource at a time and
 * used to write a mapping at a time, which is one implicit transaction per statement
 * on SQLite, one network round trip per statement on Postgres, and — measured on the
 * ENT-6758 spike — 7 ms per statement against a Durable Object, versus 0.21 ms when
 * the same statements arrive together.
 *
 * Order is significant and preserved: later rows for the same key overwrite earlier
 * ones, exactly as sequential `upsertMapping` calls would, so a caller that queues
 * a correction after a first write still ends up with the correction.
 *
 * One transaction, so a failure leaves none of them — see the conformance suite for
 * what each engine guarantees. The caller is responsible for reporting *which*
 * resources were affected; `id_mappings` rows carry that identity themselves.
 */
export async function upsertMappings(db: Datastore, mappings: NewMapping[]): Promise<void> {
  if (mappings.length === 0) return;
  await withDatastoreRetry(() =>
    db.batch(mappings.map((mapping) => upsertMappingStatement(db, mapping))),
  );
}

export async function deleteMapping(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  nativeId: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "DELETE FROM id_mappings WHERE directory_id = ? AND resource_type = ? AND native_id = ?",
      )
      .bind(directoryId, resourceType, nativeId)
      .run(),
  );
}

export type NewNativeWriteFailure = Pick<
  NativeWriteFailure,
  "directory_id" | "resource_type" | "resource_key" | "method" | "native_status" | "detail"
>;

/**
 * Record that WorkOS holds a write native does not (ENT-6767).
 *
 * Written unconditionally — `shouldPersistLogs` deliberately does not gate this.
 * `proxy_log` is off by default, so a divergence recorded only there would
 * disappear on an ordinary directory, and the whole value of `workos-primary` is
 * the claim that native is current.
 *
 * Keyed on the resource rather than the attempt, so an IdP retrying every minute
 * keeps one row (with a rising `attempts`) instead of burying the set of diverged
 * resources under its own noise.
 */
export async function recordNativeWriteFailure(
  db: Datastore,
  failure: NewNativeWriteFailure,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "INSERT INTO native_write_failures (directory_id, resource_type, resource_key, method, " +
          "native_status, detail) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (directory_id, resource_type, resource_key) DO UPDATE SET " +
          "method = excluded.method, native_status = excluded.native_status, " +
          "detail = excluded.detail, attempts = native_write_failures.attempts + 1, " +
          "last_seen_at = datetime('now')",
      )
      .bind(
        failure.directory_id,
        failure.resource_type,
        failure.resource_key,
        failure.method,
        failure.native_status,
        failure.detail,
      )
      .run(),
  );
}

/** Drop the divergence record for a resource, because a write to it has now
 *  reached native. Self-healing is the common case — the IdP retries, or the next
 *  change to the same resource lands — and a record that outlives the divergence
 *  it describes trains the operator to ignore the surface. */
export async function clearNativeWriteFailure(
  db: Datastore,
  directoryId: string,
  resourceType: ResourceType,
  resourceKey: string,
): Promise<void> {
  await withDatastoreRetry(() =>
    db
      .prepare(
        "DELETE FROM native_write_failures WHERE directory_id = ? AND resource_type = ? " +
          "AND resource_key = ?",
      )
      .bind(directoryId, resourceType, resourceKey)
      .run(),
  );
}

export async function listNativeWriteFailures(
  db: Datastore,
  directoryId: string,
): Promise<NativeWriteFailure[]> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT * FROM native_write_failures WHERE directory_id = ? ORDER BY last_seen_at DESC, " +
          "resource_type, resource_key",
      )
      .bind(directoryId)
      .all<NativeWriteFailure>(),
  );
  return results;
}

/** How many resources each directory has diverged, for the fleet table. Only
 *  directories with at least one appear. */
export async function countNativeWriteFailures(db: Datastore): Promise<Record<string, number>> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT directory_id, COUNT(*) AS failures FROM native_write_failures " +
          "GROUP BY directory_id",
      )
      .all<{ directory_id: string; failures: number }>(),
  );
  const counts: Record<string, number> = {};
  for (const row of results) counts[row.directory_id] = Number(row.failures);
  return counts;
}

/** Wipe the native app's directory and its DSync listener log — the customer
 *  app's own state. Leaves directories, mappings, and the WorkOS side alone. */
export async function clearNativeDirectory(db: Datastore): Promise<void> {
  await withDatastoreRetry(() =>
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

export async function insertProxyLog(db: Datastore, entry: ProxyLogInsert): Promise<void> {
  await withDatastoreRetry(() =>
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
