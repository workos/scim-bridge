import Database from "better-sqlite3";
import type { Pool } from "pg";
import { openPostgres, PostgresDatastore, PostgresMigrator } from "../server/db/postgres";
import { SqliteDatastore, SqliteMigrator } from "../server/db/sqlite";
import { DEMO_DIRECTORY_ID_KEY, rememberClientToken } from "../workers/shared/client-tokens";
import { setConfigIfAbsent } from "../workers/shared/db";
import { hashProxyToken, proxyTokenHint } from "../workers/shared/crypto";
import { newDirectoryId } from "../workers/shared/ids";
import { runMigrations, runMigrationsSync } from "../server/db/migrate";
import type { Directory, Mode, PocEnv } from "../workers/shared/types";

/**
 * Shared harness for the worker test suites.
 *
 * Every suite gets a real, freshly migrated database — the engine production
 * runs on, through the driver production uses — and a route-based fake for global
 * `fetch` so the proxy's native and WorkOS legs can be scripted per test.
 * Nothing here mocks the code under test; only the two upstreams and where the
 * data lives differ from production.
 *
 * `TEST_ENGINE` picks the driver, so the whole suite runs on both: `sqlite`
 * (default, in-memory) and `postgres` (a schema per database, dropped after the
 * test). The conformance suite covers the behaviours someone thought to write
 * down; running everything on both engines covers the ones the code actually
 * relies on.
 */

const MIGRATIONS = new URL("../migrations", import.meta.url).pathname;
const PG_MIGRATIONS = new URL("../migrations/postgres", import.meta.url).pathname;

export type TestEngine = "sqlite" | "postgres";

export const TEST_ENGINE: TestEngine =
  process.env.TEST_ENGINE === "postgres" ? "postgres" : "sqlite";

let schemaCounter = 0;

/** A freshly migrated datastore on the configured engine. */
export async function createTestDb(): Promise<PocEnv["DB"]> {
  if (TEST_ENGINE === "postgres") return createPostgresDb();
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  runMigrationsSync(new SqliteMigrator(sqlite), MIGRATIONS);
  return new SqliteDatastore(sqlite);
}

interface PostgresSchema {
  name: string;
  pool: Pool;
  store: PostgresDatastore;
  /** Tables to clear between tests (everything but the migration ledger). */
  tables: string[];
  /** The rows the baseline seeds into poc_config, restored after each truncate. */
  seeds: { key: string; value: string }[];
  inUse: boolean;
}

/** Migrated schemas this worker owns, reused across tests. */
const schemas: PostgresSchema[] = [];

/**
 * A migrated schema, reused.
 *
 * Migrating per database was the obvious design and measurably the wrong one: the
 * baseline costs 130–460ms, ~300 databases a run pay it, and with one worker per
 * core all that DDL contends on one server until tests start crossing the 5s
 * timeout — a flake that looks like slowness rather than a bug. So each worker
 * migrates once and resets between tests instead, which turns a ~150ms setup into
 * a ~10ms `TRUNCATE`.
 *
 * A test asking for a second database while it still holds the first gets a
 * second schema: two suites do that deliberately, and reusing one schema would
 * have let the second reset wipe the first.
 */
async function createPostgresDb(): Promise<PocEnv["DB"]> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_ENGINE=postgres needs TEST_DATABASE_URL (see README).");
  }

  const free = schemas.find((schema) => !schema.inUse);
  if (free) {
    await resetSchema(free);
    free.inUse = true;
    return free.store;
  }

  const name = `t${process.pid}_${(schemaCounter += 1)}`;
  const setup = openPostgres(url);
  await setup.query(`CREATE SCHEMA ${name}`);
  await setup.end();
  const pool = openPostgres(`${url}?options=-csearch_path%3D${name}`);
  const store = new PostgresDatastore(pool);
  await runMigrations(new PostgresMigrator(pool), PG_MIGRATIONS);

  const { rows: tables } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_migrations'",
  );
  const { rows: seeds } = await pool.query<{ key: string; value: string }>(
    "SELECT key, value FROM poc_config",
  );
  const schema: PostgresSchema = {
    name,
    pool,
    store,
    tables: tables.map((row) => row.table_name),
    seeds,
    inUse: true,
  };
  schemas.push(schema);
  return store;
}

async function resetSchema(schema: PostgresSchema): Promise<void> {
  // RESTART IDENTITY, not just TRUNCATE: the sequences behind proxy_log,
  // listener_events and idp_activity would otherwise carry over, and tests that
  // assert on an id or on "the first row" would pass in file order and fail when
  // run alone — which `tests/helpers.test.ts` checks on both engines.
  await schema.pool.query(
    `TRUNCATE ${schema.tables.map((table) => `"${table}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
  for (const seed of schema.seeds) {
    await schema.pool.query("INSERT INTO poc_config (key, value) VALUES ($1, $2)", [
      seed.key,
      seed.value,
    ]);
  }
}

/** Release the databases the finished test held. Registered in tests/setup.ts. */
export async function closeTestDatabases(): Promise<void> {
  for (const schema of schemas) schema.inUse = false;
}

/** Drop this worker's schemas. Registered in tests/setup.ts (afterAll). */
export async function teardownTestDatabases(): Promise<void> {
  for (const schema of schemas.splice(0)) {
    try {
      await schema.pool.query(`DROP SCHEMA ${schema.name} CASCADE`);
    } catch (error) {
      // Report rather than swallow: a silently failed drop is how a leak hides.
      // A killed worker (a timeout, a Ctrl-C) skips this entirely, so leftovers
      // are still possible — see the cleanup one-liner in the README.
      console.warn(`could not drop test schema ${schema.name}: ${(error as Error).message}`);
    }
    await schema.store.close();
  }
}

export async function createEnv(): Promise<PocEnv> {
  return { DB: await createTestDb() };
}

/** Minimal ExecutionContext: remembers waitUntil promises so tests can await them. */
export interface TestExecutionContext extends ExecutionContext {
  drain(): Promise<void>;
}

export function createCtx(): TestExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    passThroughOnException() {},
    props: {},
    async drain() {
      // waitUntil work may itself enqueue more work; drain until stable.
      while (pending.length) {
        const batch = pending.splice(0);
        await Promise.allSettled(batch);
      }
    },
  } as TestExecutionContext;
}

export const NATIVE_URL = "https://native.test/scim/v2";
export const WORKOS_URL = "https://workos.test/scim/v2";

export interface SeedDirectoryOptions {
  mode?: Mode;
  name?: string;
  proxy_token?: string;
  native_url?: string;
  native_token?: string;
  workos_token?: string;
  workos_directory_id?: string | null;
  log_persistence?: number;
}

/** A seeded row, plus the proxy token in the clear. The row itself holds only a
 *  digest, so a test that needs to present the token — most of them —
 *  takes it from here, exactly as production takes it from the mint. */
export type SeededDirectory = Directory & { proxy_token: string };

/** Insert a directory wired to the fake upstream URLs and return the full row. */
export async function seedDirectory(
  db: PocEnv["DB"],
  opts: SeedDirectoryOptions = {},
): Promise<SeededDirectory> {
  const token = opts.proxy_token ?? `proxy-token-${Math.random().toString(36).slice(2)}`;
  const id = newDirectoryId();
  await db
    .prepare(
      `INSERT INTO scim_directories
         (id, name, mode, proxy_token_hash, proxy_token_hint, native_url, native_token,
          workos_url, workos_token, workos_directory_id, log_persistence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      // The same generator production uses, now that the column has no default.
      id,
      opts.name ?? "Test Directory",
      opts.mode ?? "dual-write",
      await hashProxyToken(token),
      proxyTokenHint(token),
      opts.native_url ?? NATIVE_URL,
      opts.native_token ?? "native-secret",
      WORKOS_URL,
      opts.workos_token ?? "workos-secret",
      opts.workos_directory_id ?? null,
      opts.log_persistence ?? 0,
    )
    .run();
  // Boot does this for the components that present the token (the IdP simulator,
  // the native app's status client). Nothing else stands in for boot here, so a
  // seeded directory that skipped it would make those components silently inert.
  rememberClientToken(id, token);
  // Boot also names the one directory the bundled simulators may drive, and only
  // when there isn't one already (`seedDemoDirectory` is a no-op once any directory
  // exists). Mirrored here so the first directory a test seeds is the simulator's,
  // and a second one is a stand-in for an operator's real import — which the
  // simulator must refuse.
  await setConfigIfAbsent(db, DEMO_DIRECTORY_ID_KEY, id);
  const row = await db
    .prepare("SELECT * FROM scim_directories WHERE id = ?")
    .bind(id)
    .first<Directory>();
  if (!row) throw new Error("seedDirectory: row not found after insert");
  return { ...row, proxy_token: token };
}

/** One recorded upstream call, in arrival order. */
export interface RecordedCall {
  target: "native" | "workos";
  method: string;
  /** Path relative to the upstream base, e.g. "/Users/abc?filter=x". */
  path: string;
  headers: Headers;
  body: string | null;
  json(): unknown;
}

export type RouteHandler = (call: RecordedCall) => Response | Promise<Response>;

export interface FakeUpstreams {
  /** Script the next responses. Handlers match in order: the first entry whose
   *  target+method+path (string prefix or RegExp) matches is used and, when
   *  `once` is true, consumed. Later entries act as fallbacks. */
  route(
    target: "native" | "workos",
    method: string,
    path: string | RegExp,
    handler: Response | RouteHandler,
    opts?: { once?: boolean },
  ): void;
  /** Every upstream call the proxy made, in order. */
  calls: RecordedCall[];
  callsTo(target: "native" | "workos"): RecordedCall[];
  /** Restore the previous global fetch. */
  restore(): void;
}

/**
 * Replace global fetch with a router for the two fake upstream hosts.
 * Unmatched calls return 501 with a diagnostic body so a missing route fails
 * the test loudly instead of hanging or silently succeeding.
 */
export function installFakeUpstreams(): FakeUpstreams {
  interface Route {
    target: "native" | "workos";
    method: string;
    path: string | RegExp;
    handler: Response | RouteHandler;
    once: boolean;
    used: boolean;
  }
  const routes: Route[] = [];
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const target =
      url.origin === new URL(NATIVE_URL).origin
        ? ("native" as const)
        : url.origin === new URL(WORKOS_URL).origin
          ? ("workos" as const)
          : null;
    if (!target) {
      throw new Error(`fake fetch: unexpected host ${url.origin} (${req.method} ${req.url})`);
    }
    const base = target === "native" ? NATIVE_URL : WORKOS_URL;
    const path = req.url.slice(base.length) || "/";
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const call: RecordedCall = {
      target,
      method: req.method,
      path,
      headers: req.headers,
      body: body === "" ? null : body,
      json() {
        return this.body === null ? null : JSON.parse(this.body);
      },
    };
    calls.push(call);

    for (const r of routes) {
      if (r.used || r.target !== target || r.method !== req.method.toUpperCase()) continue;
      const matches =
        typeof r.path === "string" ? path === r.path || path.startsWith(r.path) : r.path.test(path);
      if (!matches) continue;
      if (r.once) r.used = true;
      const res = r.handler instanceof Response ? r.handler.clone() : await r.handler(call);
      return res;
    }
    return Response.json(
      { detail: `fake upstream: no route for ${target} ${req.method} ${path}` },
      { status: 501 },
    );
  }) as typeof fetch;

  return {
    route(target, method, path, handler, opts) {
      routes.push({
        target,
        method: method.toUpperCase(),
        path,
        handler,
        once: opts?.once ?? false,
        used: false,
      });
    },
    calls,
    callsTo(target) {
      return calls.filter((c) => c.target === target);
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A SCIM JSON response with the content type upstreams actually send. */
export function scimJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/scim+json" },
  });
}

/** Build a request to a worker as the IdP would send it. Takes a `SeededDirectory`
 *  because the row alone no longer contains a presentable credential. */
export function proxyRequest(
  directory: SeededDirectory,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://bridge.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${directory.proxy_token}`,
      ...(body !== undefined ? { "Content-Type": "application/scim+json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
