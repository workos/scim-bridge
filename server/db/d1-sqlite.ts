import Database from "better-sqlite3";

/**
 * A minimal `D1Database`-compatible wrapper over better-sqlite3.
 *
 * The proxy, the panel, and the demo simulators all talk to the datastore
 * through the small slice of the D1 API this project actually uses:
 * `prepare(sql).bind(...).first()/.all()/.run()` and `batch([...])`. Implementing
 * that slice here lets every file under `workers/` and `app/` keep its
 * `env.DB` typed as `D1Database` and run unchanged on a plain SQLite file.
 *
 * SQLite is the same engine D1 wraps, so `datetime('now')`, `ON CONFLICT … DO
 * UPDATE`, `randomblob(...)`, and autoincrement all behave identically — no SQL
 * dialect translation is needed.
 */

type Row = Record<string, unknown>;

interface D1RunResult {
  results: unknown[];
  success: true;
  meta: { changes: number; last_row_id: number; duration: number };
}

class SqliteStatement {
  constructor(
    private readonly db: Database.Database,
    private readonly getStmt: (sql: string) => Database.Statement,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.getStmt, this.sql, params);
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.getStmt(this.sql).get(...this.params) as Row | undefined;
    if (row === undefined) return null;
    if (colName !== undefined) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const results = this.getStmt(this.sql).all(...this.params) as T[];
    return { results, success: true, meta: {} };
  }

  async run(): Promise<D1RunResult> {
    return runOne(this.getStmt(this.sql), this.params);
  }

  /** Present for API parity; unused by this project. */
  async raw<T = unknown>(): Promise<T[]> {
    const stmt = this.getStmt(this.sql);
    stmt.raw(true);
    const rows = stmt.all(...this.params) as T[];
    stmt.raw(false);
    return rows;
  }
}

function runOne(stmt: Database.Statement, params: unknown[]): D1RunResult {
  if (stmt.reader) {
    const results = stmt.all(...params);
    return { results, success: true, meta: { changes: 0, last_row_id: 0, duration: 0 } };
  }
  const info = stmt.run(...params);
  return {
    results: [],
    success: true,
    meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0 },
  };
}

export class SqliteD1 {
  /** Raw key for at-rest secret encryption, read by workers/shared/crypto off
   *  the shared DB handle. Null (or unset, as on Cloudflare D1) = plaintext. */
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
    return new SqliteStatement(this.db, this.getStmt, sql);
  }

  /** Run several prepared statements atomically, mirroring `D1Database.batch`. */
  async batch(statements: SqliteStatement[]): Promise<D1RunResult[]> {
    const tx = this.db.transaction((list: SqliteStatement[]) =>
      list.map((s) => runOne(this.getStmt(s.sql), s.params)),
    );
    return tx(statements);
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
