import Database from "better-sqlite3";
import { openPostgres, PostgresDatastore, PostgresMigrator } from "../server/db/postgres";
import { SqliteDatastore, SqliteMigrator } from "../server/db/sqlite";
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

/** Databases the current test created, torn down by tests/setup.ts afterEach. */
const open: { close(): Promise<void> }[] = [];
let schemaCounter = 0;

/** A freshly migrated datastore on the configured engine. */
export async function createTestDb(): Promise<PocEnv["DB"]> {
  if (TEST_ENGINE === "postgres") return createPostgresDb();
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  runMigrationsSync(new SqliteMigrator(sqlite), MIGRATIONS);
  return new SqliteDatastore(sqlite);
}

async function createPostgresDb(): Promise<PocEnv["DB"]> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_ENGINE=postgres needs TEST_DATABASE_URL (see README).");
  }
  // A schema per database rather than one per file with truncation between
  // tests: two of the suites build two independent databases inside a single
  // test, and an isolation model that quietly breaks those is worse than the
  // schema-creation cost (measured in the PR). It also sidesteps the trap in the
  // truncating design — TRUNCATE leaves sequences where they were unless asked
  // (`RESTART IDENTITY`), so tests that assert on an autoincrement id would pass
  // in file order and fail when run alone. A new schema has new sequences, which
  // `tests/helpers.test.ts` pins rather than assumes.
  const schema = `t${process.pid}_${(schemaCounter += 1)}`;
  const setup = openPostgres(url);
  await setup.query(`CREATE SCHEMA ${schema}`);
  await setup.end();
  const pool = openPostgres(`${url}?options=-csearch_path%3D${schema}`);
  const store = new PostgresDatastore(pool);
  await runMigrations(new PostgresMigrator(pool), PG_MIGRATIONS);
  open.push({
    async close() {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
      await store.close();
    },
  });
  return store;
}

/** Drop what the finished test created. Registered once, in tests/setup.ts. */
export async function closeTestDatabases(): Promise<void> {
  const closing = open.splice(0);
  for (const database of closing) await database.close();
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

/** Insert a directory wired to the fake upstream URLs and return the full row. */
export async function seedDirectory(
  db: PocEnv["DB"],
  opts: SeedDirectoryOptions = {},
): Promise<Directory> {
  const token = opts.proxy_token ?? `proxy-token-${Math.random().toString(36).slice(2)}`;
  await db
    .prepare(
      `INSERT INTO scim_directories
         (id, name, mode, proxy_token, native_url, native_token, workos_url, workos_token,
          workos_directory_id, log_persistence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      // The same generator production uses, now that the column has no default.
      newDirectoryId(),
      opts.name ?? "Test Directory",
      opts.mode ?? "dual-write",
      token,
      opts.native_url ?? NATIVE_URL,
      opts.native_token ?? "native-secret",
      WORKOS_URL,
      opts.workos_token ?? "workos-secret",
      opts.workos_directory_id ?? null,
      opts.log_persistence ?? 0,
    )
    .run();
  const row = await db
    .prepare("SELECT * FROM scim_directories WHERE proxy_token = ?")
    .bind(token)
    .first<Directory>();
  if (!row) throw new Error("seedDirectory: row not found after insert");
  return row;
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

/** Build a request to a worker as the IdP would send it. */
export function proxyRequest(
  directory: Directory,
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
