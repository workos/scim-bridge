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
import {
  decidePanelAuth,
  loadConfig,
  seedConfig,
  seedDemoDirectory,
  seedNativeAppConfig,
  seedNativeAppDirectories,
} from "./config";
import { openDatabase, SqliteDatastore, SqliteMigrator } from "./db/sqlite";
import { runMigrations } from "./db/migrate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const CLIENT_DIR = join(ROOT, "build/client");
const SERVER_BUILD = join(ROOT, "build/server/index.js");

const config = loadConfig();

// Datastore: open the SQLite file, apply migrations, and hand every `env.DB`
// consumer the driver.
const sqlite = openDatabase(config.databasePath);
const applied = await runMigrations(new SqliteMigrator(sqlite), MIGRATIONS_DIR);
if (applied.length) console.log(`Applied ${applied.length} migration(s): ${applied.join(", ")}`);
const store = new SqliteDatastore(sqlite);
// Encrypt per-directory tokens at rest when a key is provided (else plaintext).
// The key rides on the shared DB handle so both the workers and the bundled
// panel (separate module graphs) encrypt/decrypt consistently.
store.encryptionKey = config.encryptionKey;
if (config.encryptionKey) console.log("Per-directory token encryption: enabled");
const env: PocEnv = { DB: store };
if (config.role === "native-app") {
  await seedNativeAppConfig(env, config);
  await seedNativeAppDirectories(env, config);
  console.log(`Reconciled directories to the ${config.directories.length} in DIRECTORIES_JSON`);
  if (!config.bridgeStatusUrl) {
    console.log(
      "BRIDGE_STATUS_URL is unset: the listener can't read the bridge's status endpoint " +
        "and will stay inert (falling back to each directory row's own mode).",
    );
  }
} else {
  await seedConfig(env, config);
  await seedDemoDirectory(env, config);
}

// `ctx.waitUntil` on Workers keeps async work alive after the response; on Node
// we just run it fire-and-forget and swallow rejections (the callers already
// treat these legs as best-effort).
const ctx = {
  waitUntil(promise: Promise<unknown>): void {
    void Promise.resolve(promise).catch(() => {});
  },
  passThroughOnException(): void {},
} as unknown as ExecutionContext;

const app = new Hono();

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

/** The `bridge` role: the migration proxy's data-plane and status endpoint, the
 *  control panel behind them, and the demo simulators when enabled. */
async function mountBridge(): Promise<void> {
  const requestHandler = createRequestHandler(
    (await import(pathToFileURL(SERVER_BUILD).href)) as unknown as ServerBuild,
    "production",
  );

  // Guard the control panel with optional HTTP Basic auth. The SCIM data-plane
  // (/scim) and the directory status endpoint (/status) authenticate each
  // request by its own proxy token, and /healthz stays open for load-balancer
  // probes, so none of them are gated here.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path === "/healthz" ||
      path === "/scim/v2" ||
      path.startsWith("/scim/v2/") ||
      path === "/status/directories" ||
      path.startsWith("/status/directories/")
    ) {
      return next();
    }

    if (decidePanelAuth(config, c.req.header("Authorization") ?? null) !== "denied") return next();
    return c.body("Authentication required.", 401, {
      "WWW-Authenticate": 'Basic realm="scim-bridge", charset="UTF-8"',
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // SCIM data-plane → the migration proxy.
  app.all("/scim/v2", (c) => proxyWorker.fetch(c.req.raw, env, ctx));
  app.all("/scim/v2/*", (c) => proxyWorker.fetch(c.req.raw, env, ctx));

  // Directory migration-mode status, polled by the customer's DSync listener.
  // Token-authenticated by the proxy like the data-plane.
  app.all("/status/directories", (c) => proxyWorker.fetch(c.req.raw, env, ctx));
  app.all("/status/directories/*", (c) => proxyWorker.fetch(c.req.raw, env, ctx));

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
}

if (config.role === "native-app") {
  // Standing in for the customer's own application: the native worker owns
  // every route (its SCIM server at /scim/v2, the DSync listener at
  // /webhooks/dsync, /healthz, and its status page at /). No proxy, no panel,
  // no simulators — so PANEL_AUTH_* has nothing to guard here either.
  console.log("APP_ROLE=native-app: serving the native app at the root, no proxy or panel");
  app.all("*", (c) => nativeWorker.fetch(c.req.raw, env, ctx));
} else {
  await mountBridge();
}

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`scim-bridge listening on http://0.0.0.0:${info.port}`);
  if (config.role === "native-app") {
    console.log(`  native SCIM base URL: ${config.publicUrl}/scim/v2`);
    console.log(`  DSync webhook URL: ${config.publicUrl}/webhooks/dsync`);
  } else {
    console.log(`  control panel: ${config.publicUrl}/panel`);
    console.log(`  SCIM base URL: ${config.publicUrl}/scim/v2`);
  }
});
