import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import type { ServerBuild } from "react-router";
import proxyWorker from "../workers/proxy/index";
import nativeWorker from "../workers/native/index";
import idpWorker from "../workers/idp/index";
import type { PocEnv } from "../workers/shared/types";
import { loadConfig, seedConfig, seedDemoDirectory } from "./config";
import { openDatabase, SqliteD1 } from "./db/d1-sqlite";
import { runMigrations } from "./db/migrate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const CLIENT_DIR = join(ROOT, "build/client");
const SERVER_BUILD = join(ROOT, "build/server/index.js");

const config = loadConfig();

// Datastore: open the SQLite file, apply migrations, wrap it in the D1 shim so
// every `env.DB` consumer runs unchanged.
const sqlite = openDatabase(config.databasePath);
const applied = runMigrations(sqlite, MIGRATIONS_DIR);
if (applied.length) console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
const sqliteD1 = new SqliteD1(sqlite);
// Encrypt per-directory tokens at rest when a key is provided (else plaintext).
// The key rides on the shared DB handle so both the workers and the bundled
// panel (separate module graphs) encrypt/decrypt consistently.
sqliteD1.encryptionKey = config.encryptionKey;
if (config.encryptionKey) console.log("Per-directory token encryption: enabled");
const DB = sqliteD1 as unknown as PocEnv["DB"];
const env: PocEnv = { DB };
await seedConfig(env, config);
await seedDemoDirectory(env, config);

// `ctx.waitUntil` on Workers keeps async work alive after the response; on Node
// we just run it fire-and-forget and swallow rejections (the callers already
// treat these legs as best-effort).
const ctx = {
  waitUntil(promise: Promise<unknown>): void {
    void Promise.resolve(promise).catch(() => {});
  },
  passThroughOnException(): void {},
} as unknown as ExecutionContext;

const requestHandler = createRequestHandler(
  (await import(pathToFileURL(SERVER_BUILD).href)) as unknown as ServerBuild,
  "production",
);

/** Re-issue a request to a mounted worker with the mount prefix stripped. */
function mounted(
  worker: { fetch: (req: Request, env: PocEnv, ctx: ExecutionContext) => Promise<Response> },
  prefix: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  url.pathname = url.pathname.slice(prefix.length) || "/";
  return worker.fetch(new Request(url, req), env, ctx);
}

const app = new Hono();

// Guard the control panel with optional HTTP Basic auth. The SCIM data-plane
// (/scim) authenticates each request by its own proxy token, and /healthz stays
// open for load-balancer probes, so neither is gated here.
app.use("*", async (c, next) => {
  const { panelAuthUser, panelAuthPassword } = config;
  // Both credentials blank: the panel runs unauthenticated by design (operators
  // front it with their own reverse proxy / SSO, as documented). If either is
  // set the panel is guarded — a partial configuration must fail closed, never
  // open, so a lone PANEL_AUTH_USER can't leave the panel wide open.
  if (!panelAuthUser && !panelAuthPassword) return next();
  const path = new URL(c.req.url).pathname;
  if (path === "/healthz" || path === "/scim/v2" || path.startsWith("/scim/v2/")) return next();

  const header = c.req.header("Authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  const [user, pass] = Buffer.from(encoded ?? "", "base64")
    .toString()
    .split(":");
  if (
    scheme === "Basic" &&
    Boolean(panelAuthUser) &&
    Boolean(panelAuthPassword) &&
    user === panelAuthUser &&
    pass === panelAuthPassword
  ) {
    return next();
  }
  return c.body("Authentication required.", 401, {
    "WWW-Authenticate": 'Basic realm="scim-bridge", charset="UTF-8"',
  });
});

app.get("/healthz", (c) => c.json({ ok: true }));

// SCIM data-plane → the migration proxy.
app.all("/scim/v2", (c) => proxyWorker.fetch(c.req.raw, env, ctx));
app.all("/scim/v2/*", (c) => proxyWorker.fetch(c.req.raw, env, ctx));

// Bundled simulators for a self-contained demo (a real customer has their own
// IdP and native app, so these are off unless DEMO_MODE is set).
if (config.demoMode) {
  console.log("DEMO_MODE on: mounting IdP + native-app simulators under /__demo");
  app.all("/__demo/native", (c) => mounted(nativeWorker, "/__demo/native", c.req.raw));
  app.all("/__demo/native/*", (c) => mounted(nativeWorker, "/__demo/native", c.req.raw));
  app.all("/__demo/idp", (c) => mounted(idpWorker, "/__demo/idp", c.req.raw));
  app.all("/__demo/idp/*", (c) => mounted(idpWorker, "/__demo/idp", c.req.raw));
}

// Static client assets (hashed bundles, fonts, favicon). Only GET/HEAD are
// candidates for a file; other methods fall straight through to the panel so
// form POSTs aren't swallowed by the static handler. Misses fall through too.
const staticFiles = serveStatic({ root: CLIENT_DIR });
app.use("*", (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  return staticFiles(c, next);
});

// Everything else → the React Router control panel (SSR).
app.all("*", (c) =>
  requestHandler(c.req.raw, { cloudflare: { env, ctx, demoMode: config.demoMode } }),
);

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`scim-bridge listening on http://0.0.0.0:${info.port}`);
  console.log(`  control panel: ${config.publicUrl}/panel`);
  console.log(`  SCIM base URL: ${config.publicUrl}/scim/v2`);
});
