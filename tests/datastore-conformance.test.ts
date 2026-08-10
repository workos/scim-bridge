import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations, runMigrationsSync } from "../server/db/migrate";
import { openPostgres, PostgresDatastore, PostgresMigrator } from "../server/db/postgres";
import { SqliteDatastore, SqliteMigrator } from "../server/db/sqlite";
import {
  getConfig,
  listDirectories,
  setConfigIfAbsent,
  upsertMappings,
  withDatastoreRetry,
  type NewMapping,
} from "../workers/shared/db";
import { TransientDatastoreError, type Datastore } from "../workers/shared/datastore";
import { seedGeneratedTokens } from "../server/config";
import { insertDirectory } from "../workers/shared/db";
import type { ResourceType } from "../workers/shared/types";

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

// Skipping is right locally — most changes don't need a database running — but in
// CI it is indistinguishable from passing, and a driver nobody exercises is a
// driver that rots. CI supplies the service, so a missing URL there means the
// workflow broke, not that Postgres is optional.
if (process.env.CI && !POSTGRES_URL) {
  throw new Error(
    "TEST_DATABASE_URL is unset in CI: the Postgres driver would be silently skipped. " +
      "Check the postgres service container in .github/workflows/ci.yml.",
  );
}

// Verifying by hand that Postgres ran? Read this file's own line in the runner
// output — `datastore-conformance.test.ts (20 tests)`, one per driver per case —
// not the suite total. The total is the number the runner prints loudest and the
// tempting thing to assert, and it moves whenever anything else in tests/ does,
// so it fails for reasons that have nothing to do with the driver. The invariant
// is per-file and depends on nothing outside it.

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

/** A mapping row for the cases below; only the ids vary. */
function mapping(directoryId: string, nativeId: string, workosId: string): NewMapping {
  return {
    directory_id: directoryId,
    resource_type: "Users",
    native_id: nativeId,
    workos_id: workosId,
    strategy: "migrated-id",
  };
}

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

  it("leaves no mapping behind when one write in the batch fails", async () => {
    // What the backfill's batched flush relies on, asserted per engine rather than
    // assumed to be the same. `INSERT OR IGNORE` reached production once because
    // nobody asked whether app SQL meant the same thing on both engines; a batch
    // that half-applied would be worse — some resources would have mappings and
    // others would not, with the summary reporting all of them mirrored.
    const db = await open();
    const { id } = await insertDirectory(db, { name: "Acme" });
    await upsertMappings(db, [mapping(id, "u_first", "wos_first")]);

    await expect(
      upsertMappings(db, [
        mapping(id, "u_good", "wos_good"),
        // resource_type is CHECK-constrained, so this statement cannot apply.
        { ...mapping(id, "u_bad", "wos_bad"), resource_type: "Nonsense" as ResourceType },
      ]),
    ).rejects.toThrow();

    const { results } = await db
      .prepare("SELECT native_id FROM id_mappings WHERE directory_id = ? ORDER BY native_id")
      .bind(id)
      .all<{ native_id: string }>();
    // The good statement rolled back with the bad one, and the row written by an
    // earlier successful batch is untouched.
    expect(results.map((row) => row.native_id)).toEqual(["u_first"]);
  });

  it("applies a later mapping over an earlier one inside the same batch", async () => {
    // The backfill queues rows in the order the mirror path produced them, and a
    // correction can follow a first write for the same resource. Batching must not
    // reorder them: the last write for a key has to win, exactly as it would if the
    // statements had been issued one at a time.
    const db = await open();
    const { id } = await insertDirectory(db, { name: "Acme" });

    await upsertMappings(db, [
      { ...mapping(id, "u1", "wos_stale"), strategy: "migrated-id" },
      { ...mapping(id, "u1", "wos_fresh"), strategy: "fallback-post" },
    ]);

    const row = await db
      .prepare(
        "SELECT workos_id, strategy FROM id_mappings WHERE directory_id = ? AND native_id = ?",
      )
      .bind(id, "u1")
      .first<{ workos_id: string; strategy: string }>();
    expect(row).toEqual({ workos_id: "wos_fresh", strategy: "fallback-post" });
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
    // The tie is the precondition, so make it rather than hope for it: three
    // inserts usually share a second, and "usually" is a flake on any engine.
    await db
      .prepare("UPDATE scim_directories SET created_at = ?")
      .bind("2026-08-04 12:00:00")
      .run();

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

  it("rethrows an error the driver did not classify, on the first attempt", async () => {
    const db = await open();
    let attempts = 0;

    // Broken SQL is not transient, and the retry must not sit on it: six attempts
    // of latency in front of the real error is worse for whoever reads the log
    // than no retry at all. Asserting the COUNT is the point — "rejects" alone
    // would still pass with a substring fallback quietly retrying six times.
    await expect(
      withDatastoreRetry(async () => {
        attempts += 1;
        return db.prepare("SLECT nonsense FROM poc_config").first();
      }),
    ).rejects.toThrow();

    expect(attempts).toBe(1);
  });

  it("does not retry an unclassified error whose message merely looks transient", async () => {
    let attempts = 0;

    // This is the case the removed substring fallback got wrong: it matched
    // `internal error`, so a fatal error phrased this way was retried six times
    // and surfaced ~420ms late. The driver never classified it, so it must not be
    // retried — and asserting the attempt count is what distinguishes this from
    // the fallback still being there.
    await expect(
      withDatastoreRetry(async () => {
        attempts += 1;
        throw new Error("internal error: constraint violated, database is locked out");
      }),
    ).rejects.toThrow("internal error");

    expect(attempts).toBe(1);
  });

  it("retries what the driver did classify, and can succeed", async () => {
    let attempts = 0;

    const result = await withDatastoreRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new TransientDatastoreError(
          Object.assign(new Error("connection terminated unexpectedly"), { code: "ECONNRESET" }),
        );
      }
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
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
