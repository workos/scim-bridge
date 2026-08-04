/**
 * The datastore contract every driver implements.
 *
 * This is the slice of the D1 API the application actually uses — the shape
 * `server/db/d1-sqlite.ts` was written against when the datastore was a SQLite
 * file pretending to be D1. Naming it here makes it the interface rather than an
 * imitation, so a second driver (Postgres, ENT-6753) is a new implementation
 * instead of a new pretence, and `tsc` decides whether the slice is sufficient.
 *
 * Deliberately narrower than D1's own interface: no `raw()`, no `first(colName)`, no
 * `exec()`, no `meta.last_row_id` (nothing reads it, and not every engine can
 * produce one). Add to it only when a call site genuinely needs more — every
 * addition is something each driver must reproduce identically.
 */

/**
 * A failure the caller may retry: a lock, a serialization conflict, a connection
 * the pool lost. Each driver decides what qualifies for its engine and wraps the
 * cause, so `withD1Retry` doesn't have to pattern-match error strings it can't
 * know.
 */
export class TransientDatastoreError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TransientDatastoreError";
  }
}

export interface DatastoreRunResult {
  results: unknown[];
  success: true;
  /** `changes` is the row count the statement affected; callers use it to tell a
   *  real write from a no-op (e.g. `INSERT … ON CONFLICT DO NOTHING`). */
  meta: { changes: number; duration: number };
}

export interface DatastoreAllResult<T> {
  results: T[];
  success: true;
  meta: Record<string, unknown>;
}

export interface DatastoreStatement {
  /** Returns a bound copy; the unbound statement is reusable. */
  bind(...params: unknown[]): DatastoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DatastoreAllResult<T>>;
  run(): Promise<DatastoreRunResult>;
}

export interface Datastore {
  prepare(sql: string): DatastoreStatement;
  /**
   * Run several statements as one atomic unit, in order. Every driver must make
   * this a real transaction: the read-then-write paths that cannot use an
   * interactive transaction (D1 has none, and the code was written for D1) rely
   * on it for atomicity.
   */
  batch(statements: DatastoreStatement[]): Promise<DatastoreRunResult[]>;
  /**
   * Raw key for at-rest secret encryption, read off the handle by
   * `workers/shared/crypto.ts`. Part of the contract rather than a property one
   * driver happens to carry: a driver that omitted it would silently store the
   * per-directory upstream tokens in plaintext.
   */
  encryptionKey: string | null;
}

/**
 * Schema migration, kept off `Datastore` so application code cannot reach DDL.
 * Each driver brings its own: migration files are dialect-specific, and the
 * runner in `server/db/migrate.ts` only orders them.
 */
export interface DatastoreMigrator {
  /** Names already applied, creating the ledger table if it doesn't exist. */
  appliedMigrations(): Promise<Set<string>>;
  /** Apply one script and record its name, atomically. */
  applyMigration(name: string, sql: string): Promise<void>;
}
