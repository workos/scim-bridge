import Database from "better-sqlite3";
import {
  TransientDatastoreError,
  type Datastore,
  type DatastoreAllResult,
  type DatastoreMigrator,
  type DatastoreRunResult,
  type DatastoreStatement,
} from "../../workers/shared/datastore";

/**
 * The file-backed driver: `Datastore` over better-sqlite3, and the default
 * everywhere. Mounted on a real disk it is also the whole storage story for the
 * documented docker-compose deployment.
 *
 * better-sqlite3 is synchronous, so every method here resolves immediately; the
 * async interface exists for drivers that talk over a socket.
 */

type Row = Record<string, unknown>;

class SqliteStatement implements DatastoreStatement {
  constructor(
    private readonly getStmt: (sql: string) => Database.Statement,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SqliteStatement {
    return new SqliteStatement(this.getStmt, this.sql, params);
  }

  async first<T = Row>(): Promise<T | null> {
    try {
      const row = this.getStmt(this.sql).get(...this.params) as Row | undefined;
      return row === undefined ? null : (row as T);
    } catch (error) {
      rethrow(error);
    }
  }

  async all<T = Row>(): Promise<DatastoreAllResult<T>> {
    try {
      const results = this.getStmt(this.sql).all(...this.params) as T[];
      return { results, success: true, meta: {} };
    } catch (error) {
      rethrow(error);
    }
  }

  async run(): Promise<DatastoreRunResult> {
    try {
      return runOne(this.getStmt(this.sql), this.params);
    } catch (error) {
      rethrow(error);
    }
  }
}

/** SQLite's own retryable failures: another writer holds the lock. */
function isTransientSqliteError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || code === "SQLITE_LOCKED";
}

function rethrow(error: unknown): never {
  throw isTransientSqliteError(error) ? new TransientDatastoreError(error) : error;
}

function runOne(stmt: Database.Statement, params: unknown[]): DatastoreRunResult {
  // A statement with RETURNING (or a SELECT sent through run()) is a reader, and
  // better-sqlite3 refuses .run() on those — read the rows instead.
  if (stmt.reader) {
    const results = stmt.all(...params);
    return { results, success: true, meta: { changes: 0, duration: 0 } };
  }
  const info = stmt.run(...params);
  return { results: [], success: true, meta: { changes: info.changes, duration: 0 } };
}

export class SqliteDatastore implements Datastore {
  /** Null = store secrets in plaintext (see workers/shared/crypto.ts). */
  encryptionKey: string | null = null;

  private readonly cache = new Map<string, Database.Statement>();
  private readonly getStmt = (sql: string): Database.Statement => {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  };

  constructor(private readonly db: Database.Database) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.getStmt, sql);
  }

  async batch(statements: DatastoreStatement[]): Promise<DatastoreRunResult[]> {
    // Every statement came from this instance's prepare(), so each carries the
    // sql and params to replay inside the transaction.
    const own = statements as SqliteStatement[];
    const tx = this.db.transaction((list: SqliteStatement[]) =>
      list.map((s) => runOne(this.getStmt(s.sql), s.params)),
    );
    try {
      return tx(own);
    } catch (error) {
      rethrow(error);
    }
  }
}

const LEDGER = "_migrations";

/**
 * SQLite's `DatastoreMigrator`. A migration file's DDL and its ledger row are one
 * transaction, so a half-applied file can never be recorded as done.
 */
export class SqliteMigrator implements DatastoreMigrator {
  constructor(private readonly db: Database.Database) {}

  async appliedMigrations(): Promise<Set<string>> {
    return this.appliedSync();
  }

  async applyMigration(name: string, sql: string): Promise<void> {
    this.applySync(name, sql);
  }

  /** better-sqlite3 is synchronous, so the test harness can migrate a fresh
   *  in-memory database without awaiting (see tests/helpers.ts). */
  appliedSync(): Set<string> {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (` +
        "name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    const rows = this.db.prepare(`SELECT name FROM ${LEDGER}`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  }

  applySync(name: string, sql: string): void {
    const record = this.db.prepare(`INSERT INTO ${LEDGER} (name) VALUES (?)`);
    this.db.transaction(() => {
      this.db.exec(sql);
      record.run(name);
    })();
  }
}

/** Open the SQLite file with the pragmas the app expects (WAL + foreign keys). */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
