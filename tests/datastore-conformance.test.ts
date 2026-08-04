import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations, runMigrationsSync } from "../server/db/migrate";
import { openPostgres, PostgresDatastore, PostgresMigrator } from "../server/db/postgres";
import { SqliteDatastore, SqliteMigrator } from "../server/db/sqlite";
import { getConfig, listDirectories, setConfigIfAbsent } from "../workers/shared/db";
import type { Datastore } from "../workers/shared/datastore";
import { seedGeneratedTokens } from "../server/config";
import { insertDirectory } from "../workers/shared/db";

/**
 * One suite, every driver. This is what makes "one narrow interface, two
 * drivers" more than an assertion: each case exercises a behaviour the shared
 * code depends on, so a driver that diverges fails here rather than in
 * production.
 *
 * Postgres runs only when TEST_DATABASE_URL is set (CI, or `docker run
 * postgres` locally). It is skipped rather than mocked: a fake Postgres would
 * prove nothing about the dialect, which is the entire risk.
 */
const POSTGRES_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS = new URL("../migrations", import.meta.url).pathname;
const PG_MIGRATIONS = new URL("../migrations/postgres", import.meta.url).pathname;

interface Driver {
  name: string;
  /** A migrated, empty datastore. */
  open(): Promise<Datastore>;
}

const drivers: Driver[] = [
  {
    name: "sqlite",
    async open() {
      const sqlite = new Database(":memory:");
      sqlite.pragma("foreign_keys = ON");
      runMigrationsSync(new SqliteMigrator(sqlite), MIGRATIONS);
      return new SqliteDatastore(sqlite);
    },
  },
];

const pools: { close(): Promise<void> }[] = [];

if (POSTGRES_URL) {
  drivers.push({
    name: "postgres",
    async open() {
      // A schema per test keeps cases independent without dropping the database.
      const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
      const pool = openPostgres(POSTGRES_URL);
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema}`);
      await pool.end();
      const scoped = openPostgres(`${POSTGRES_URL}?options=-csearch_path%3D${schema}`);
      const store = new PostgresDatastore(scoped);
      await runMigrations(new PostgresMigrator(scoped), PG_MIGRATIONS);
      pools.push(store);
      return store;
    },
  });
}

afterAll(async () => {
  for (const pool of pools) await pool.close();
});

describe.each(drivers)("$name driver", ({ open }) => {
  it("returns null from first() on a miss, and the row on a hit", async () => {
    const db = await open();

    expect(
      await db.prepare("SELECT value FROM poc_config WHERE key = ?").bind("nope").first(),
    ).toBeNull();
    await db.prepare("INSERT INTO poc_config (key, value) VALUES (?, ?)").bind("k", "v").run();

    expect(
      await db.prepare("SELECT value FROM poc_config WHERE key = ?").bind("k").first(),
    ).toEqual({
      value: "v",
    });
  });

  it("reports changes for a write, and zero when ON CONFLICT DO NOTHING skips", async () => {
    const db = await open();
    const insert = () =>
      db
        .prepare("INSERT INTO poc_config (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING")
        .bind("k", "v")
        .run();

    expect((await insert()).meta.changes).toBe(1);
    // The distinction `setConfigIfAbsent` and native/store.ts's membership edges
    // depend on: a skipped upsert is not a write.
    expect((await insert()).meta.changes).toBe(0);
    expect(
      (await db.prepare("DELETE FROM poc_config WHERE key = ?").bind("k").run()).meta.changes,
    ).toBe(1);
  });

  it("counts as a number, not a string", async () => {
    const db = await open();
    await db
      .prepare("INSERT INTO native_users (id, user_name, resource) VALUES (?, ?, ?)")
      .bind("u1", "a@b.c", "{}")
      .run();

    const row = await db.prepare("SELECT COUNT(*) AS n FROM native_users").first<{ n: number }>();

    // node-postgres hands back int8 as a string by default, which would put
    // `totalResults: "1"` in a SCIM ListResponse and break pagination maths.
    expect(row?.n).toBe(1);
    expect(typeof row?.n).toBe("number");
  });

  it("runs a batch atomically", async () => {
    const db = await open();
    await db.prepare("INSERT INTO poc_config (key, value) VALUES (?, ?)").bind("before", "1").run();

    await expect(
      db.batch([
        db.prepare("INSERT INTO poc_config (key, value) VALUES (?, ?)").bind("a", "1"),
        // Same key twice: the second statement violates the primary key.
        db.prepare("INSERT INTO poc_config (key, value) VALUES (?, ?)").bind("a", "2"),
      ]),
    ).rejects.toThrow();

    // The first statement must have rolled back with the second.
    expect(await getConfig(db, "a")).toBeNull();
    expect(await getConfig(db, "before")).toBe("1");
  });

  it("keeps the SQLite timestamp shape, which the status ETag and ordering read", async () => {
    const db = await open();
    await insertDirectory(db, { name: "Acme" });

    const [directory] = await listDirectories(db);

    // `YYYY-MM-DD HH:MM:SS`, UTC, second resolution — the format status.ts folds
    // to a T for its ETag and every ORDER BY compares lexicographically.
    expect(directory.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(directory.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const seconds =
      Math.abs(Date.now() - Date.parse(`${directory.created_at.replace(" ", "T")}Z`)) / 1000;
    expect(seconds).toBeLessThan(120);
  });

  it("orders a same-second insert deterministically", async () => {
    const db = await open();
    for (const name of ["Zeta", "Acme", "Mid"]) await insertDirectory(db, { name });

    expect((await listDirectories(db)).map((d) => d.name)).toEqual(["Acme", "Mid", "Zeta"]);
  });

  it("converges on one token when two boots race", async () => {
    const db = await open();

    // Both racers write; the loser must read back the winner's value rather than
    // keep the one it minted, or seedDemoDirectory copies a token nothing holds.
    const [first, second] = await Promise.all([
      seedGeneratedTokens({ DB: db }),
      seedGeneratedTokens({ DB: db }),
    ]);

    const stored = await getConfig(db, "native.scim_token");
    expect(stored).toMatch(/^[0-9a-f]{32}$/);
    expect(first["native.scim_token"]).toBe(stored);
    expect(second["native.scim_token"]).toBe(stored);
  });

  it("keeps the first value on setConfigIfAbsent and reports what landed", async () => {
    const db = await open();

    expect(await setConfigIfAbsent(db, "k", "first")).toBe("first");
    expect(await setConfigIfAbsent(db, "k", "second")).toBe("first");
    expect(await getConfig(db, "k")).toBe("first");
  });

  it("rejects a statement whose placeholders and parameters disagree", async () => {
    const db = await open();

    await expect(
      db.prepare("SELECT value FROM poc_config WHERE key = ? AND value = ?").bind("k").first(),
    ).rejects.toThrow();
  });

  it("binds a parameter containing a question mark verbatim", async () => {
    const db = await open();

    await db
      .prepare("INSERT INTO poc_config (key, value) VALUES (?, ?)")
      .bind("k", "why? ?? $1")
      .run();

    expect(await getConfig(db, "k")).toBe("why? ?? $1");
  });
});
