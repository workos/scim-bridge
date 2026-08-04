import { afterEach } from "vitest";
import { closeTestDatabases } from "./helpers";

/**
 * Tear down whatever databases a test created. Needed for the Postgres engine —
 * each database is a schema plus a connection pool, and a run that leaked them
 * would exhaust `max_connections` long before the suite finished. A no-op for the
 * in-memory SQLite engine, which the garbage collector handles.
 */
afterEach(async () => {
  await closeTestDatabases();
});
