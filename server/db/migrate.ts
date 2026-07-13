import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Apply `migrations/*.sql` in filename order, once each, tracked in a
 * `_migrations` table. Runs on every boot; already-applied files are skipped,
 * so the container is safe to restart and safe to ship new migrations with.
 *
 * These are the same D1 migration files used by the Cloudflare deploy — D1 is
 * SQLite, so they run verbatim here.
 */
export function runMigrations(db: Database.Database, dir: string): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (" +
      "name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const record = db.prepare("INSERT INTO _migrations (name) VALUES (?)");
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      record.run(file);
    });
    apply();
    ran.push(file);
  }
  return ran;
}
