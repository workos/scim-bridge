import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations, runMigrationsSync } from "../server/db/migrate";
import { openPostgres, PostgresDatastore, PostgresMigrator } from "../server/db/postgres";
import { SqliteDatastore, SqliteMigrator } from "../server/db/sqlite";
import type { Datastore } from "../workers/shared/datastore";
import { MODES } from "../workers/shared/types";

/**
 * The two migration sets describe one logical schema, and nothing stops a change
 * landing on only one side — a column added to `migrations/*.sql` and forgotten in
 * `migrations/postgres/0001_baseline.sql` would pass every test until the
 * Postgres deployment hit the missing column at runtime.
 *
 * So: apply both, introspect both, normalise to a comparable model, and diff.
 * This deliberately compares the *shape* rather than the DDL text — Postgres
 * rewrites `IN (…)` as `= ANY (ARRAY[…])`, renders defaults with `::text` casts,
 * and names constraint-backed indexes its own way, none of which is drift. What
 * it does catch is a missing table, a missing or renamed column, a changed type
 * class, nullability, default, primary key, unique constraint or index.
 *
 * A checked-in expectation would have been the alternative, and it would need
 * updating by hand on every schema change — i.e. exactly when it is load-bearing.
 *
 * Postgres-only, so this skips without TEST_DATABASE_URL. In CI the conformance
 * suite already fails the build when that variable is missing, so a skip here
 * cannot go unnoticed either.
 */
const POSTGRES_URL = process.env.TEST_DATABASE_URL;

/** The ledger each migrator creates for itself, not part of the schema under
 *  comparison (SQLite tracks `applied_at` as TEXT, Postgres as TIMESTAMPTZ). */
const NOT_COMPARED = new Set(["_migrations"]);

interface Column {
  name: string;
  /** `text` or `integer` — the classes this schema uses. */
  type: string;
  nullable: boolean;
  /** Normalised: casts stripped, whitespace collapsed. Null when absent. */
  default: string | null;
  /** SQLite AUTOINCREMENT / Postgres identity. */
  generated: boolean;
}

interface Index {
  columns: string[];
  unique: boolean;
  /** Normalised partial-index predicate, or null. */
  predicate: string | null;
}

interface Table {
  columns: Column[];
  primaryKey: string[];
  /** Column lists of UNIQUE constraints, sorted for comparison. */
  unique: string[][];
  /** Explicitly named indexes, keyed by name. */
  indexes: Record<string, Index>;
  /** Columns mentioned by a CHECK constraint — the expression text differs by
   *  engine, the set of guarded columns does not. */
  checked: string[];
}

type Schema = Record<string, Table>;

function normalizeDefault(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/::[a-z ]+/g, "") // 'x'::text → 'x'
    .replace(/\s+/g, " ")
    .replace(/^\((.*)\)$/, "$1")
    .trim();
}

function normalizePredicate(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[()]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function typeClass(raw: string): string {
  const type = raw.toLowerCase();
  if (type.startsWith("text") || type.startsWith("char") || type.startsWith("varchar"))
    return "text";
  if (type.startsWith("int") || type === "bigint" || type === "smallint") return "integer";
  return type;
}

async function readSqliteSchema(db: Datastore): Promise<Schema> {
  const { results: tables } = await db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all<{ name: string; sql: string }>();

  const schema: Schema = {};
  for (const table of tables) {
    if (NOT_COMPARED.has(table.name)) continue;
    const { results: columns } = await db
      .prepare(
        "SELECT name, type, [notnull], dflt_value, pk FROM pragma_table_info(?) ORDER BY cid",
      )
      .bind(table.name)
      .all<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>();
    // AUTOINCREMENT is only visible in the DDL text.
    const autoincrement = /autoincrement/i.test(table.sql);

    const { results: indexList } = await db
      .prepare("SELECT name, [unique], partial, origin FROM pragma_index_list(?)")
      .bind(table.name)
      .all<{ name: string; unique: number; partial: number; origin: string }>();

    const indexes: Record<string, Index> = {};
    const unique: string[][] = [];
    for (const index of indexList) {
      // xinfo, not info: it reports the sort direction, which `(directory_id,
      // id DESC)` indexes depend on and Postgres includes in its definition.
      // `key = 1` drops the trailing rowid column SQLite appends.
      const { results: parts } = await db
        .prepare("SELECT name, [desc] FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno")
        .bind(index.name)
        .all<{ name: string; desc: number }>();
      const columnNames = parts.map((part) => (part.desc === 1 ? `${part.name} DESC` : part.name));
      if (index.origin === "pk") continue; // compared as primaryKey
      if (index.origin === "u") {
        unique.push(columnNames);
        continue;
      }
      // A partial index's predicate lives in the CREATE INDEX text.
      const { results: definition } = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .bind(index.name)
        .all<{ sql: string | null }>();
      const where = definition[0]?.sql?.match(/\bWHERE\b(.*)$/is)?.[1] ?? null;
      indexes[index.name] = {
        columns: columnNames,
        unique: index.unique === 1,
        predicate: normalizePredicate(where),
      };
    }

    const columnNames = columns.map((column) => column.name);
    const checkText = table.sql.match(/CHECK\s*\(/i) ? table.sql : "";
    schema[table.name] = {
      columns: columns.map((column) => ({
        name: column.name,
        type: typeClass(column.type),
        // A non-INTEGER PRIMARY KEY may hold NULL in SQLite but not in Postgres.
        // That quirk is not drift, so a primary-key column counts as NOT NULL.
        nullable: column.notnull === 0 && column.pk === 0,
        default: normalizeDefault(column.dflt_value),
        generated: autoincrement && column.pk === 1 && typeClass(column.type) === "integer",
      })),
      primaryKey: columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
      unique: unique.map((columnList) => columnList.slice()).sort(compareColumnLists),
      indexes,
      checked: columnNames
        .filter((name) => new RegExp(`CHECK\\s*\\([^)]*\\b${name}\\b`, "i").test(checkText))
        .sort(),
    };
  }
  return schema;
}

async function readPostgresSchema(db: Datastore): Promise<Schema> {
  const { results: columns } = await db
    .prepare(
      "SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity " +
        "FROM information_schema.columns WHERE table_schema = current_schema() " +
        "ORDER BY table_name, ordinal_position",
    )
    .all<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      is_identity: string;
    }>();

  const { results: constraints } = await db
    .prepare(
      "SELECT c.relname AS table_name, con.contype, con.conname, pg_get_constraintdef(con.oid) AS def " +
        "FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()",
    )
    .all<{ table_name: string; contype: string; conname: string; def: string }>();

  const { results: indexes } = await db
    .prepare(
      "SELECT tablename AS table_name, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()",
    )
    .all<{ table_name: string; indexname: string; indexdef: string }>();

  const constraintBacked = new Set(constraints.map((constraint) => constraint.conname));
  const schema: Schema = {};
  for (const column of columns) {
    if (NOT_COMPARED.has(column.table_name)) continue;
    const table = (schema[column.table_name] ??= {
      columns: [],
      primaryKey: [],
      unique: [],
      indexes: {},
      checked: [],
    });
    table.columns.push({
      name: column.column_name,
      type: typeClass(column.data_type),
      nullable: column.is_nullable === "YES",
      default: normalizeDefault(column.column_default),
      generated: column.is_identity === "YES",
    });
  }

  for (const constraint of constraints) {
    const table = schema[constraint.table_name];
    if (!table) continue;
    const columnList = constraint.def.match(/\(([^)]*)\)/)?.[1] ?? "";
    const columnNames = columnList.split(",").map((name) => name.trim().replace(/"/g, ""));
    if (constraint.contype === "p") table.primaryKey = columnNames;
    if (constraint.contype === "u") table.unique.push(columnNames);
    if (constraint.contype === "c") {
      for (const column of table.columns) {
        if (new RegExp(`\\b${column.name}\\b`).test(constraint.def))
          table.checked.push(column.name);
      }
    }
  }

  for (const index of indexes) {
    const table = schema[index.table_name];
    if (!table || constraintBacked.has(index.indexname)) continue;
    const columnList = index.indexdef.match(/USING \w+ \(([^)]*)\)/)?.[1] ?? "";
    table.indexes[index.indexname] = {
      columns: columnList.split(",").map((name) => name.trim().replace(/"/g, "")),
      unique: /CREATE UNIQUE INDEX/i.test(index.indexdef),
      predicate: normalizePredicate(index.indexdef.match(/\bWHERE\b(.*)$/is)?.[1] ?? null),
    };
  }

  for (const table of Object.values(schema)) {
    table.unique.sort(compareColumnLists);
    table.checked = [...new Set(table.checked)].sort();
  }
  return schema;
}

function compareColumnLists(a: string[], b: string[]): number {
  return a.join(",").localeCompare(b.join(","));
}

const pools: { close(): Promise<void> }[] = [];
afterAll(async () => {
  for (const pool of pools) await pool.close();
});

describe.skipIf(!POSTGRES_URL)("schema parity", () => {
  async function schemas(): Promise<{ sqlite: Schema; postgres: Schema }> {
    const sqlite = new Database(":memory:");
    runMigrationsSync(
      new SqliteMigrator(sqlite),
      new URL("../migrations", import.meta.url).pathname,
    );

    const schema = `parity_${Math.random().toString(36).slice(2, 10)}`;
    const setup = openPostgres(POSTGRES_URL as string);
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
    const scoped = openPostgres(`${POSTGRES_URL}?options=-csearch_path%3D${schema}`);
    const store = new PostgresDatastore(scoped);
    pools.push(store);
    await runMigrations(
      new PostgresMigrator(scoped),
      new URL("../migrations/postgres", import.meta.url).pathname,
    );

    return {
      sqlite: await readSqliteSchema(new SqliteDatastore(sqlite)),
      postgres: await readPostgresSchema(store),
    };
  }

  it("describes the same tables on both engines", async () => {
    const { sqlite, postgres } = await schemas();

    expect(Object.keys(postgres).sort()).toEqual(Object.keys(sqlite).sort());
  });

  it("describes every table identically, column for column", async () => {
    const { sqlite, postgres } = await schemas();

    // One assertion per table so a failure names the drifted table rather than
    // dumping the whole schema.
    for (const name of Object.keys(sqlite)) {
      expect(postgres[name], `table ${name}`).toEqual(sqlite[name]);
    }
  });

  it("enforces the mode CHECK on both engines, not just declares it", async () => {
    // The one comparison the shape can't make: Postgres rewrites `IN (…)` as
    // `= ANY (ARRAY[…])`, so the allowed set is pinned behaviourally instead.
    const schema = `probe_${Math.random().toString(36).slice(2, 10)}`;
    const setup = openPostgres(POSTGRES_URL as string);
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
    const scoped = openPostgres(`${POSTGRES_URL}?options=-csearch_path%3D${schema}`);
    const postgres = new PostgresDatastore(scoped);
    pools.push(postgres);
    await runMigrations(
      new PostgresMigrator(scoped),
      new URL("../migrations/postgres", import.meta.url).pathname,
    );
    const sqlite = new Database(":memory:");
    runMigrationsSync(
      new SqliteMigrator(sqlite),
      new URL("../migrations", import.meta.url).pathname,
    );

    for (const db of [new SqliteDatastore(sqlite) as Datastore, postgres]) {
      const insert = (mode: string) =>
        db
          .prepare(
            "INSERT INTO scim_directories (id, name, mode, proxy_token_hash) VALUES (?, ?, ?, ?)",
          )
          .bind(`dir_${mode}`, "Acme", mode, `tok_${mode}`)
          .run();

      await expect(insert("nonsense")).rejects.toThrow();
      // Every mode the code can set, so a mode added to MODES without widening
      // both CHECKs fails here rather than at the first operator who selects it.
      for (const mode of MODES) {
        await expect(insert(mode), `mode ${mode}`).resolves.toBeDefined();
      }
    }
  });
});
