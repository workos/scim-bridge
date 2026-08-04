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

  /**
   * Sequence carryover between tests, which is the only place it can happen.
   *
   * These are deliberately TWO tests, and merging them back into one would make
   * the check vacuous — that was the original mistake. Within a single test, the
   * second `createTestDb()` finds no free schema and creates a fresh one, and a
   * fresh schema has fresh sequences whether or not `resetSchema` asks for
   * `RESTART IDENTITY`. Reuse only happens *between* tests, once `afterEach` has
   * released the schema, so only a second `it()` exercises the reset path.
   *
   * Verified by removing ` RESTART IDENTITY` from the TRUNCATE in helpers.ts: the
   * second test below fails on Postgres, and the whole suite passed before this
   * pair existed.
   *
   * On SQLite each database is a new `:memory:` file, so the property holds
   * trivially there; both engines run it because `test:engines` requires the same
   * test set on each.
   */
  it("leaves a row behind for the next test to find gone", async () => {
    const db = await createTestDb();

    await db
      .prepare("INSERT INTO listener_events (event_type, action) VALUES (?, ?)")
      .bind("first-test", "applied")
      .run();

    const row = await db.prepare("SELECT id FROM listener_events").first<{ id: number }>();
    expect(row?.id).toBe(1);
  });

  it("hands the next test an empty database whose ids start at 1 again", async () => {
    // This is the test that matters: on Postgres this database is the schema the
    // previous test used, reset rather than recreated.
    const db = await createTestDb();

    const { results: before } = await db
      .prepare("SELECT id FROM listener_events")
      .all<{ id: number }>();
    await db
      .prepare("INSERT INTO listener_events (event_type, action) VALUES (?, ?)")
      .bind("second-test", "applied")
      .run();
    const row = await db.prepare("SELECT id FROM listener_events").first<{ id: number }>();

    // Empty proves the TRUNCATE ran; id 1 proves it restarted the identity. Tests
    // assert on `id DESC` ordering and on "the first row", so a counter carried
    // over from the previous test fails only when a file runs alone or in a
    // different order — the failure shape that looks like flake.
    expect(before, `${TEST_ENGINE}: previous test's rows should be gone`).toEqual([]);
    expect(row?.id, `${TEST_ENGINE}: identity should restart at 1`).toBe(1);
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
