import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatastoreMigrator } from "../../workers/shared/datastore";
import type { SqliteMigrator } from "./sqlite";

/**
 * Apply a directory of `*.sql` migrations in filename order, once each, tracked
 * in a `_migrations` ledger. Runs on every boot; already-applied files are
 * skipped, so the container is safe to restart and safe to ship new migrations
 * with.
 *
 * This module only decides *which* files run and in what order — reading the
 * ledger and applying a file belong to the driver's `DatastoreMigrator`, since
 * the ledger SQL and the migration files are both dialect-specific.
 */

/** The migration files not yet in the ledger, in filename order. */
function pending(dir: string, applied: Set<string>): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => !applied.has(file))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

export async function runMigrations(migrator: DatastoreMigrator, dir: string): Promise<string[]> {
  const files = pending(dir, await migrator.appliedMigrations());
  for (const { name, sql } of files) {
    await migrator.applyMigration(name, sql);
  }
  return files.map((file) => file.name);
}

/** The same walk without awaiting, for the synchronous SQLite driver: the test
 *  harness builds a migrated in-memory database inside synchronous helpers. */
export function runMigrationsSync(migrator: SqliteMigrator, dir: string): string[] {
  const files = pending(dir, migrator.appliedSync());
  for (const { name, sql } of files) {
    migrator.applySync(name, sql);
  }
  return files.map((file) => file.name);
}
