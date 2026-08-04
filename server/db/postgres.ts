import pg from "pg";
import {
  TransientDatastoreError,
  type Datastore,
  type DatastoreAllResult,
  type DatastoreMigrator,
  type DatastoreRunResult,
  type DatastoreStatement,
} from "../../workers/shared/datastore";
import { rewritePlaceholders } from "./placeholders";

/**
 * The Postgres driver: `Datastore` over node-postgres, for the deployments that
 * already run RDS/Aurora and want their database backed up by the same machinery
 * as everything else they own.
 *
 * Only two things differ from the SQL the rest of the app writes, and both are
 * handled here rather than at any call site:
 *
 * 1. `?` placeholders become `$1…$n` (see ./placeholders.ts).
 * 2. `datetime('now')` — the timestamp columns are TEXT holding SQLite's
 *    `YYYY-MM-DD HH:MM:SS`, a format the status ETag, the lexicographic ordering
 *    and the panel all read — so the baseline schema defines a `datetime(text)`
 *    function returning exactly that. Nothing needs rewriting for time.
 */

/** `int8` (COUNT(*), SUM) arrives as a string by default, so `totalResults` in a
 *  SCIM ListResponse would serialise as "5" and pagination arithmetic would
 *  concatenate. Every count this app runs fits in a JS number. */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

type Row = Record<string, unknown>;

interface Queryable {
  query(config: {
    text: string;
    values: unknown[];
  }): Promise<{ rows: Row[]; rowCount: number | null }>;
}

class PostgresStatement implements DatastoreStatement {
  constructor(
    private readonly client: () => Queryable,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): PostgresStatement {
    return new PostgresStatement(this.client, this.sql, params);
  }

  async first<T = Row>(): Promise<T | null> {
    const { rows } = await this.execute(this.client());
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = Row>(): Promise<DatastoreAllResult<T>> {
    const { rows } = await this.execute(this.client());
    return { results: rows as T[], success: true, meta: {} };
  }

  async run(): Promise<DatastoreRunResult> {
    return this.runOn(this.client());
  }

  /** Used by `batch` to run inside its transaction's connection. */
  async runOn(client: Queryable): Promise<DatastoreRunResult> {
    const { rows, rowCount } = await this.execute(client);
    return { results: rows, success: true, meta: { changes: rowCount ?? 0, duration: 0 } };
  }

  private async execute(client: Queryable): Promise<{ rows: Row[]; rowCount: number | null }> {
    const { sql, count } = rewrite(this.sql);
    // A mis-rewrite (a `?` inside a string literal that got renumbered) would
    // otherwise bind silently wrong values. Fail loudly on the first execution.
    if (count !== this.params.length) {
      throw new Error(
        `placeholder/parameter mismatch: ${count} placeholder(s), ${this.params.length} parameter(s) — ${this.sql}`,
      );
    }
    try {
      return await client.query({ text: sql, values: this.params });
    } catch (error) {
      throw isTransientPostgresError(error) ? new TransientDatastoreError(error) : error;
    }
  }
}

const rewritten = new Map<string, ReturnType<typeof rewritePlaceholders>>();

function rewrite(sql: string): ReturnType<typeof rewritePlaceholders> {
  let entry = rewritten.get(sql);
  if (!entry) {
    entry = rewritePlaceholders(sql);
    rewritten.set(sql, entry);
  }
  return entry;
}

export class PostgresDatastore implements Datastore {
  /** Null = store secrets in plaintext (see workers/shared/crypto.ts). */
  encryptionKey: string | null = null;

  constructor(private readonly pool: pg.Pool) {}

  prepare(sql: string): PostgresStatement {
    return new PostgresStatement(() => this.pool, sql);
  }

  /** One pooled connection, BEGIN…COMMIT, so `batch` is atomic as the contract
   *  promises: the read-then-write paths depend on it. */
  async batch(statements: DatastoreStatement[]): Promise<DatastoreRunResult[]> {
    const own = statements as PostgresStatement[];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results: DatastoreRunResult[] = [];
      for (const statement of own) {
        results.push(await statement.runOn(client));
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const LEDGER = "_migrations";

/** Postgres has transactional DDL, so a migration and its ledger row commit or
 *  roll back together. */
export class PostgresMigrator implements DatastoreMigrator {
  constructor(private readonly pool: pg.Pool) {}

  async appliedMigrations(): Promise<Set<string>> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (` +
        "name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const { rows } = await this.pool.query<{ name: string }>(`SELECT name FROM ${LEDGER}`);
    return new Set(rows.map((row) => row.name));
  }

  async applyMigration(name: string, sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO ${LEDGER} (name) VALUES ($1)`, [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Transient Postgres failures worth retrying: serialization/deadlock, an admin
 *  shutdown or failover, and a connection the pool lost mid-flight. The SQLite
 *  set (`database is locked`) never applies here. */
export function isTransientPostgresError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "40001" || // serialization_failure
    code === "40P01" || // deadlock_detected
    code === "57P01" || // admin_shutdown
    code === "57P03" || // cannot_connect_now (still starting up)
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE"
  );
}

export function openPostgres(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}
