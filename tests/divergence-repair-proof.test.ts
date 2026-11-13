import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  listNativeWriteFailures,
  recordNativeWriteFailure,
  setDirectoryMode,
  upsertMapping,
} from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
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
 * A live write retires a `native_write_failures` row only when it proves the
 * write the row records reached native: the retry of that exact write, a create
 * native applied for a missing create, or a converged delete. A different write
 * to the same resource, or a create native rejected, proves nothing.
 */
describe("divergence rows retire only on proof of repair", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  async function seedMappedGroup(): Promise<SeededDirectory> {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    for (const [kind, native, workos] of [
      ["Users", "u1", "wu1"],
      ["Groups", "g1", "wg1"],
    ] as const) {
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        native_id: native,
        workos_id: workos,
        strategy: "fallback-post",
      });
    }
    return directory;
  }

  const removeMember = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "remove", path: 'members[value eq "u1"]' }],
  };
  const rename = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "displayName", value: "Engineering revised" }],
  };

  async function patchGroup(directory: SeededDirectory, body: unknown): Promise<Response> {
    const ctx = createCtx();
    const res = await proxyWorker.fetch(
      proxyRequest(directory, "PATCH", "/scim/v2/Groups/g1", body),
      env,
      ctx,
    );
    await ctx.drain();
    return res;
  }

  const keys = async (directoryId: string) =>
    (await listNativeWriteFailures(env.DB, directoryId)).map((f) => [f.resource_key, f.method]);

  it("keeps a failed member removal after an unrelated PATCH to the group succeeds", async () => {
    const directory = await seedMappedGroup();
    fake.route("workos", "PATCH", "/Groups/wg1", scimJson(200, { id: "wg1" }));
    fake.route("native", "PATCH", "/Groups/g1", scimJson(500, { detail: "boom" }), { once: true });
    expect((await patchGroup(directory, removeMember)).status).toBe(502);
    expect(await keys(directory.id)).toEqual([["g1", "PATCH"]]);

    fake.route("native", "PATCH", "/Groups/g1", scimJson(200, { id: "g1" }));
    expect((await patchGroup(directory, rename)).status).toBe(200);
    expect(await keys(directory.id)).toEqual([["g1", "PATCH"]]);

    for (const mode of ["dual-write", "passthrough"] as const) {
      await setDirectoryMode(env.DB, directory.id, mode);
      expect((await patchGroup(directory, rename)).status, mode).toBe(200);
      expect(await keys(directory.id), mode).toEqual([["g1", "PATCH"]]);
    }

    await setDirectoryMode(env.DB, directory.id, "workos-primary");
    expect((await patchGroup(directory, removeMember)).status).toBe(200);
    expect(await keys(directory.id)).toEqual([]);
  });

  it("stops a retry from retiring a row that absorbed a different failed write", async () => {
    const directory = await seedMappedGroup();
    fake.route("workos", "PATCH", "/Groups/wg1", scimJson(200, { id: "wg1" }));
    for (let i = 0; i < 2; i++) {
      fake.route("native", "PATCH", "/Groups/g1", scimJson(500, { detail: "boom" }), {
        once: true,
      });
    }
    await patchGroup(directory, removeMember);
    await patchGroup(directory, rename);

    fake.route("native", "PATCH", "/Groups/g1", scimJson(200, { id: "g1" }));
    expect((await patchGroup(directory, rename)).status).toBe(200);
    expect(await keys(directory.id)).toEqual([["g1", "PATCH"]]);
  });

  it("keeps a deprovisioning gap a DELETE row when a later write to the key fails", async () => {
    const directory = await seedMappedGroup();
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      resource_key: "g1",
      method: "DELETE",
      native_status: 500,
      detail: "WorkOS committed this write; native did not",
      write_fingerprint: null,
    });
    fake.route("workos", "PATCH", "/Groups/wg1", scimJson(200, { id: "wg1" }));
    fake.route("native", "PATCH", "/Groups/g1", scimJson(500, { detail: "boom" }), { once: true });
    await patchGroup(directory, rename);
    fake.route("native", "PATCH", "/Groups/g1", scimJson(200, { id: "g1" }));
    await patchGroup(directory, rename);

    expect(await keys(directory.id)).toEqual([["g1", "DELETE"]]);
  });

  it("keeps a deprovisioning gap when a create native rejects is compensated", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "nat_9f3c",
      method: "DELETE",
      native_status: 500,
      detail: "WorkOS committed this write; native did not",
      write_fingerprint: null,
    });
    fake.route(
      "native",
      "POST",
      "/Users",
      scimJson(404, { detail: "fail.seat.liteSeatNotEnabled" }),
    );
    fake.route("workos", "PUT", "/Users/nat_9f3c", scimJson(404, { detail: "absent" }));
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-minted" }));
    fake.route("workos", "DELETE", "/Users/workos-minted", new Response(null, { status: 204 }));

    const res = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        externalId: "nat_9f3c",
        userName: "rejected@example.com",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(res.status).toBe(404);
    expect(fake.callsTo("workos").some((call) => call.method === "DELETE")).toBe(true);
    expect(await keys(directory.id)).toEqual([["nat_9f3c", "DELETE"]]);
  });

  it("keeps another create's record when a different rejected create is compensated", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "idp-1",
      method: "POST",
      native_status: 503,
      detail: "WorkOS created the resource; native did not",
      write_fingerprint: "an earlier create",
    });
    fake.route("native", "POST", "/Users", scimJson(404, { detail: "rejected" }));
    fake.route("workos", "PUT", "/Users/idp-1", scimJson(404, { detail: "absent" }));
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "workos-minted" }));
    fake.route("workos", "DELETE", "/Users/workos-minted", new Response(null, { status: 204 }));

    await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        externalId: "idp-1",
        userName: "someone-else@example.com",
      }),
      env,
      createCtx(),
    );

    expect(await keys(directory.id)).toEqual([["idp-1", "POST"]]);
  });
  it("keeps a create's record when a different create with the same externalId succeeds", async () => {
    const directory = await seedDirectory(env.DB, { mode: "passthrough" });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "idp-1",
      method: "POST",
      native_status: 503,
      detail: "WorkOS created the resource; native did not",
      write_fingerprint: "the original create",
    });
    fake.route("native", "POST", "/Users", scimJson(201, { id: "native-2" }));

    const ctx = createCtx();
    await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        externalId: "idp-1",
        userName: "someone-else@example.com",
      }),
      env,
      ctx,
    );
    await ctx.drain();

    expect(await keys(directory.id)).toEqual([["idp-1", "POST"]]);
  });

  it("keeps a DELETE row's own status and detail when a later write to the key fails", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    const base = {
      directory_id: directory.id,
      resource_type: "Users" as const,
      resource_key: "u1",
    };
    await recordNativeWriteFailure(env.DB, {
      ...base,
      method: "DELETE",
      native_status: 403,
      detail: "native refused the delete",
      write_fingerprint: "the delete",
    });
    await recordNativeWriteFailure(env.DB, {
      ...base,
      method: "PATCH",
      native_status: 404,
      detail: "native has no such user",
      write_fingerprint: "a patch",
    });

    const [row] = await listNativeWriteFailures(env.DB, directory.id);
    expect([row?.method, row?.native_status, row?.detail]).toEqual([
      "DELETE",
      403,
      "native refused the delete",
    ]);
  });

  it("reports the latest error when the DELETE itself fails again", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    const base = {
      directory_id: directory.id,
      resource_type: "Users" as const,
      resource_key: "u1",
    };
    for (const [status, detail] of [
      [403, "native refused the delete"],
      [500, "native crashed"],
    ] as const) {
      await recordNativeWriteFailure(env.DB, {
        ...base,
        method: "DELETE",
        native_status: status,
        detail,
        write_fingerprint: "the delete",
      });
    }

    const [row] = await listNativeWriteFailures(env.DB, directory.id);
    expect([row?.method, row?.native_status, row?.detail]).toEqual([
      "DELETE",
      500,
      "native crashed",
    ]);
  });
});
