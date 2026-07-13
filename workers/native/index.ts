import { getConfig } from "../shared/db";
import type { PocEnv } from "../shared/types";
import { handleDsyncWebhook, timingSafeEqual } from "./listener";
import { captureMockBefore, emitMockEvents, parseMockScimPath } from "./mock-emitter";
import { handleScim, scimError } from "./scim-server";
import { renderStatusPage } from "./status-page";
import { MOCK_WORKOS_TABLES, NATIVE_TABLES, ScimStore } from "./store";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const SCIM_BASE = "/scim/v2";
const MOCK_SCIM_BASE = "/mock-workos/scim/v2";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/healthz") {
      return Response.json({ ok: true });
    }

    if (pathname === "/" && request.method === "GET") {
      return renderStatusPage(env.DB);
    }

    if (pathname === "/webhooks/dsync") {
      if (request.method !== "POST") {
        return Response.json({ error: "The DSync webhook only accepts POST." }, { status: 405 });
      }
      return handleDsyncWebhook(request, env.DB);
    }

    if (pathname === SCIM_BASE || pathname.startsWith(`${SCIM_BASE}/`)) {
      const denied = await requireBearer(request, env.DB, "native.scim_token");
      if (denied) return denied;
      return handleScim(request, pathname.slice(SCIM_BASE.length), {
        store: new ScimStore(env.DB, NATIVE_TABLES),
        migratedIdContract: false,
      });
    }

    if (pathname === MOCK_SCIM_BASE || pathname.startsWith(`${MOCK_SCIM_BASE}/`)) {
      const denied = await requireBearer(request, env.DB, "mock_workos.scim_token");
      if (denied) return denied;
      const subpath = pathname.slice(MOCK_SCIM_BASE.length);
      const store = new ScimStore(env.DB, MOCK_WORKOS_TABLES);
      const method = request.method.toUpperCase();
      const mockPath = parseMockScimPath(subpath);
      const mutating = mockPath.kind !== null && MUTATING_METHODS.has(method);
      const before = mutating ? await captureMockBefore(store, method, mockPath) : {};

      const response = await handleScim(request, subpath, { store, migratedIdContract: true });

      if (
        mutating &&
        response.ok &&
        (await getConfig(env.DB, "mock_workos.emit_dsync")) !== "false"
      ) {
        // The mock stands in for a migrated WorkOS directory, so it emits the
        // DSync events one would. Off when a real WorkOS webhook drives the
        // listener instead. Never let emission break the SCIM response.
        const body = method === "DELETE" ? "" : await response.clone().text();
        try {
          await emitMockEvents(env.DB, store, method, mockPath, before, body, response.status);
        } catch {
          // ignore — the write already succeeded; event emission is best-effort
        }
      }
      return response;
    }

    return Response.json({ error: `No route for ${pathname}.` }, { status: 404 });
  },
} satisfies ExportedHandler<PocEnv>;

async function requireBearer(
  request: Request,
  db: D1Database,
  configKey: string,
): Promise<Response | null> {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const expected = await getConfig(db, configKey);
  if (!expected || !token || !timingSafeEqual(token, expected)) {
    return scimError(401, "Invalid or missing bearer token.");
  }
  return null;
}
