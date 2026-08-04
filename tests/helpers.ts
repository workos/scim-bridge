import Database from "better-sqlite3";
import { SqliteDatastore, SqliteMigrator } from "../server/db/sqlite";
import { newDirectoryId } from "../workers/shared/ids";
import { runMigrationsSync } from "../server/db/migrate";
import type { Directory, Mode, PocEnv } from "../workers/shared/types";

/**
 * Shared harness for the worker test suites.
 *
 * Every suite gets a real SQLite database (the same engine production runs on,
 * via the same `SqliteD1` adapter) with all `migrations/*.sql` applied, and a
 * route-based fake for global `fetch` so the proxy's native and WorkOS legs
 * can be scripted per test. Nothing here mocks the code under test — only the
 * two upstreams and the datastore file location differ from production.
 */

/** In-memory datastore with all migrations applied. */
export function createTestDb(): PocEnv["DB"] {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  runMigrationsSync(new SqliteMigrator(sqlite), new URL("../migrations", import.meta.url).pathname);
  return new SqliteDatastore(sqlite);
}

export function createEnv(): PocEnv {
  return { DB: createTestDb() };
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
      NATIVE_URL,
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
