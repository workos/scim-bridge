import { getConfig } from "../shared/db";
import type { Datastore } from "../shared/datastore";
import type { PocEnv, WorkerHandler } from "../shared/types";
import { handleDsyncWebhook } from "./listener";
import { timingSafeEqual } from "../shared/crypto";
import {
  captureMockBefore,
  emitMockEvents,
  listMockEvents,
  parseMockScimPath,
} from "./mock-emitter";
import { handleScim, scimError } from "./scim-server";
import { renderStatusPage } from "./status-page";
import { MOCK_WORKOS_TABLES, NATIVE_TABLES, ScimStore } from "./store";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const SCIM_BASE = "/scim/v2";
const MOCK_SCIM_BASE = "/mock-workos/scim/v2";

const handler: WorkerHandler<PocEnv> = {
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
        // The native app keeps create-if-absent PUT so the reverse reconcile
        // (WorkOS → native) can restore resources with their shared id. Inert
        // for normal IdP traffic, which never sends the migrated-id header.
        migratedIdMode: "put-upsert",
      });
    }

    if (pathname === "/mock-workos/events") {
      if (request.method !== "GET") {
        return Response.json({ error: "The events endpoint only accepts GET." }, { status: 405 });
      }
      // The mock's SCIM token stands in for the environment API key the real
      // GET https://api.workos.com/events takes.
      const denied = await requireBearer(request, env.DB, "mock_workos.scim_token");
      if (denied) return denied;
      return listMockEvents(env.DB, new URL(request.url).searchParams);
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

      // The mock stands in for a migrated WorkOS directory, which post-decoupling
      // creates only via POST (adopting the migrated id) and 404s a PUT on a
      // missing id — the contract the bridge now runs its PUT → 404 → POST dance
      // against.
      const response = await handleScim(request, subpath, { store, migratedIdMode: "post-create" });

      if (mutating && response.ok) {
        // The mock stands in for a migrated WorkOS directory, so it emits the
        // DSync events one would: always into the log its GET /events serves,
        // and as a webhook delivery only while `mock_workos.emit_dsync` allows
        // (off when a real WorkOS webhook drives the listener instead). Never
        // let emission break the SCIM response.
        const webhook = (await getConfig(env.DB, "mock_workos.emit_dsync")) !== "false";
        const body = method === "DELETE" ? "" : await response.clone().text();
        try {
          await emitMockEvents(
            env.DB,
            store,
            method,
            mockPath,
            before,
            body,
            response.status,
            webhook,
          );
        } catch {
          // ignore — the write already succeeded; event emission is best-effort
        }
      }
      return response;
    }

    return Response.json({ error: `No route for ${pathname}.` }, { status: 404 });
  },
};

export default handler;

async function requireBearer(
  request: Request,
  db: Datastore,
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
