import { afterAll, afterEach } from "vitest";
import { closeTestDatabases, teardownTestDatabases } from "./helpers";

/**
 * Release the databases a test held, then drop them when the file is done.
 *
 * For Postgres each database is a schema this worker migrated once and reuses, so
 * releasing is what lets the next test have it (reset on the way out). Dropping at
 * the end returns the schemas and their connections. Both are no-ops for the
 * in-memory SQLite engine.
 */
afterEach(async () => {
  await closeTestDatabases();
});

afterAll(async () => {
  await teardownTestDatabases();
});
