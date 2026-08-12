import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { MIGRATED_ID_HEADER, type PocEnv } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
  type SeededDirectory,
} from "./helpers";

/**
 * VULN-3084 residual: the 409-resolution lookup must confirm the row it finds
 * actually carries the attribute it filtered on before adopting its id.
 *
 * A native app is free to ignore an unsupported `?filter` and answer the whole
 * first page. `findNativeByUniqueAttribute` used to take `Resources[0]` on faith,
 * so a directory that owns its native namespace (no shared-namespace guard to
 * catch it) would map itself onto an unrelated local row. Its reconcile-side twin
 * `findNativeIdByAttr` already verifies the attribute case-insensitively; these
 * bring the proxy leg to parity.
 */

async function send(
  env: PocEnv,
  directory: SeededDirectory,
  method: string,
  path: string,
  body?: unknown,
) {
  const ctx = createCtx();
  const res = await proxyWorker.fetch(proxyRequest(directory, method, path, body), env, ctx);
  await ctx.drain();
  return res;
}

/** A stateful WorkOS SCIM directory (PUT resolves-or-404s, POST creates). */
function installStatefulWorkos(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  fake.route("workos", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const row = users.get(id);
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("workos", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("workos", "POST", /^\/Users(\?|$)/, (call) => {
    const id = call.headers.get(MIGRATED_ID_HEADER) ?? crypto.randomUUID();
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(201, body);
  });
  return users;
}

describe("native 409 resolution verifies the filtered attribute", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("does not adopt a row a filter-ignoring native returns for a different userName", async () => {
    const env = await createEnv();
    // A single directory that owns its native namespace: the shared-namespace
    // guard never fires, so verification here is the only thing standing between
    // a filter-ignoring native and a mis-mapping.
    const only = await seedDirectory(env.DB, { name: "Org A", mode: "workos-primary" });

    fake = installFakeUpstreams();
    // Native 409s the create, then ignores the ?filter and hands back its whole
    // first page — a single, unrelated row that does NOT match the userName.
    fake.route("native", "POST", /^\/Users(\?|$)/, () =>
      scimJson(409, { detail: "userName already exists" }),
    );
    fake.route("native", "GET", /^\/Users(\?|$)/, () =>
      scimJson(200, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "nat-other", userName: "someone.else@orga.example", active: true }],
      }),
    );
    installStatefulWorkos(fake);

    const create = await send(env, only, "POST", "/scim/v2/Users", {
      userName: "ada@orga.example",
      externalId: "idp-1",
      active: true,
    });

    // The unrelated row must not be handed back as this create's id.
    const createBody = (await create.json()) as Record<string, unknown>;
    expect(createBody.id).not.toBe("nat-other");
    // The 409 could not be resolved, so it surfaces rather than being adopted.
    expect(create.status).not.toBe(201);

    // And nothing may claim the unrelated native row for this directory.
    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND native_id = ?",
    )
      .bind(only.id, "nat-other")
      .first();
    expect(mapping).toBeNull();
  });

  it("adopts the matching row even when it is not first, case-insensitively", async () => {
    const env = await createEnv();
    const only = await seedDirectory(env.DB, { name: "Org A", mode: "workos-primary" });

    fake = installFakeUpstreams();
    fake.route("native", "POST", /^\/Users(\?|$)/, () =>
      scimJson(409, { detail: "userName already exists" }),
    );
    // The matching row is second and differs in case: blindly taking Resources[0]
    // would grab the wrong id, so a green here proves the verification, not luck.
    fake.route("native", "GET", /^\/Users(\?|$)/, () =>
      scimJson(200, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
        Resources: [
          { id: "nat-other", userName: "someone.else@orga.example", active: true },
          { id: "nat-ada", userName: "ADA@orga.example", active: true },
        ],
      }),
    );
    installStatefulWorkos(fake);

    const create = await send(env, only, "POST", "/scim/v2/Users", {
      userName: "ada@orga.example",
      externalId: "idp-1",
      active: true,
    });

    expect(create.status).toBe(201);
    const createBody = (await create.json()) as Record<string, unknown>;
    expect(createBody.id).toBe("nat-ada");

    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND native_id = ?",
    )
      .bind(only.id, "nat-ada")
      .first();
    expect(mapping).not.toBeNull();
  });
});
