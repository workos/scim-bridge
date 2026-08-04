import { describe, expect, it } from "vitest";
import { createTestDb, TEST_ENGINE } from "./helpers";

/**
 * The harness's own guarantees. Both suites below assert what ~400 tests assume
 * about the database they are handed, on whichever engine `TEST_ENGINE` selects.
 */
describe("test harness database", () => {
  it("hands out an empty, migrated database", async () => {
    const db = await createTestDb();

    const { results } = await db.prepare("SELECT COUNT(*) AS n FROM scim_directories").all<{
      n: number;
    }>();
    expect(results[0].n).toBe(0);
    // Migrated, not just created: the seeded config rows are present.
    expect(
      await db
        .prepare("SELECT value FROM poc_config WHERE key = ?")
        .bind("proxy.public_url")
        .first(),
    ).not.toBeNull();
  });

  it("starts autoincrement ids at 1 in every database it hands out", async () => {
    // Tests assert on `id DESC` ordering and on "the first row", so an id counter
    // carried over from a previous database would fail only when a file ran alone
    // or in a different order — the failure shape that looks like flake. On
    // Postgres a truncating harness would need RESTART IDENTITY; a fresh schema
    // gets fresh sequences, and this is what says so.
    for (const round of [1, 2]) {
      const db = await createTestDb();
      await db
        .prepare("INSERT INTO listener_events (event_type, action) VALUES (?, ?)")
        .bind(`round-${round}`, "applied")
        .run();

      const row = await db.prepare("SELECT id FROM listener_events").first<{ id: number }>();

      expect(row?.id, `round ${round} on ${TEST_ENGINE}`).toBe(1);
    }
  });

  it("isolates two databases built inside one test", async () => {
    // app-role and cross-cutting both do this; a shared-schema harness would let
    // the second reset wipe the first.
    const first = await createTestDb();
    const second = await createTestDb();

    await first.prepare("INSERT INTO poc_config (key, value) VALUES (?, ?)").bind("k", "1").run();

    expect(
      await second.prepare("SELECT value FROM poc_config WHERE key = ?").bind("k").first(),
    ).toBeNull();
  });
});
