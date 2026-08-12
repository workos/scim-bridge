import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { getMapping, listNativeWriteFailures } from "../workers/shared/db";
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
 * The 409-recovery mint site resolves a WorkOS id from a `userName`/`displayName`
 * lookup, and WorkOS answers that filter with whichever resource carries the
 * name. Recording it would give a caller-chosen native id a second mapping onto
 * a resource this directory already mirrors — the id-space collapse the DELETE
 * guard (`workers/proxy/index.ts`) then reads as a legitimate native id, so a
 * DELETE addressed to the caller's id deletes the other resource's WorkOS row
 * while the native leg 404s and the pair is read as convergence.
 */

function installNative(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  let minted = 0;
  fake.route("native", "POST", /^\/Users(\?|$)/, (call) => {
    const body = call.json() as Record<string, unknown>;
    for (const row of users.values()) {
      if (row.userName === body.userName) return scimJson(409, { detail: "userName exists" });
    }
    const id = `nat_9f3c${minted === 0 ? "" : `_${minted}`}`;
    minted += 1;
    const created = { ...body, id };
    users.set(id, created);
    return scimJson(201, created);
  });
  fake.route("native", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const row = users.get(decodeURIComponent(call.path.split("?")[0].split("/")[2]));
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("native", "GET", /^\/Users(\?|$)/, (call) => {
    const wanted = /userName eq "(.*)"/.exec(decodeURIComponent(call.path))?.[1];
    const rows = [...users.values()].filter((r) => wanted === undefined || r.userName === wanted);
    return scimJson(200, {
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows,
    });
  });
  fake.route("native", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("native", "DELETE", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    users.delete(id);
    return new Response(null, { status: 204 });
  });
  return users;
}

/** WorkOS: enforces userName uniqueness on POST, mints its own ids. */
function installWorkos(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  let minted = 0;
  fake.route("workos", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const row = users.get(decodeURIComponent(call.path.split("?")[0].split("/")[2]));
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("workos", "GET", /^\/Users(\?|$)/, (call) => {
    const wanted = /userName eq "(.*)"/.exec(decodeURIComponent(call.path))?.[1];
    const rows = [...users.values()].filter((r) => wanted === undefined || r.userName === wanted);
    return scimJson(200, {
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows,
    });
  });
  fake.route("workos", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("workos", "POST", /^\/Users(\?|$)/, (call) => {
    const body = call.json() as Record<string, unknown>;
    for (const row of users.values()) {
      if (row.userName === body.userName) return scimJson(409, { detail: "userName exists" });
    }
    // WorkOS does not honor the migrated-id contract here: it mints its own id.
    void call.headers.get(MIGRATED_ID_HEADER);
    const id = `wos_${(minted += 1)}`;
    const created = { ...body, id };
    users.set(id, created);
    return scimJson(201, created);
  });
  fake.route("workos", "DELETE", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    users.delete(id);
    return new Response(null, { status: 204 });
  });
  return users;
}

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

describe("workos-primary: 409-recovery mint", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("refuses to recover onto a row another resource already maps to", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
    const nativeUsers = installNative(fake);
    const workosUsers = installWorkos(fake);

    // Legitimate provisioning of the victim, driven over the proxy's SCIM
    // interface exactly as the IdP does: native mints nat_9f3c, WorkOS mints wos_1.
    const created = await send(env, directory, "POST", "/scim/v2/Users", {
      userName: "ada@example.com",
      active: true,
      title: "CFO",
    });
    expect(created.status).toBe(201);
    const victimMapping = await getMapping(env.DB, directory.id, "Users", "nat_9f3c");
    expect(victimMapping).toMatchObject({ workos_id: "wos_1", strategy: "fallback-post" });

    // A PUT to an id of the caller's choosing, carrying the mirrored resource's
    // userName: WorkOS 404s the migrated-id PUT, 409s the POST on the name, and
    // the recovery lookup resolves the mirrored resource's row.
    const mint = await send(env, directory, "PUT", "/scim/v2/Users/atk-x", {
      userName: "ada@example.com",
      active: true,
      title: "intern",
    });
    // The IdP hears native's 404 for an id native never held — the WorkOS leg's
    // refusal is a 409 that commits nothing, so neither leg wrote anything.
    expect(mint.status).toBe(404);

    // No mapping was minted, and the other resource's row was never written.
    expect(await getMapping(env.DB, directory.id, "Users", "atk-x")).toBeNull();
    expect(workosUsers.get("wos_1")).toMatchObject({ title: "CFO" });
    // A refusal is permanent, not a write to repair: it stays out of the ledger.
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);

    // With no mapping to stand on, the DELETE that the alias would have carried
    // reaches neither leg's row.
    expect((await send(env, directory, "DELETE", "/scim/v2/Users/atk-x")).status).toBe(404);
    expect(workosUsers.has("wos_1")).toBe(true);
    expect(nativeUsers.get("nat_9f3c")).toMatchObject({ userName: "ada@example.com" });
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "wos_1",
    });
  });

  it("still recovers onto a row no mapping claims", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
    installNative(fake);
    const workosUsers = installWorkos(fake);
    // The case the recovery exists for: a WorkOS row under an id this bridge
    // never recorded (a create that raced, or a pre-existing directory member).
    workosUsers.set("wos_9", { id: "wos_9", userName: "ada@example.com" });

    const created = await send(env, directory, "POST", "/scim/v2/Users", {
      userName: "ada@example.com",
      active: true,
    });
    expect(created.status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "wos_9",
      strategy: "fallback-post",
    });
  });

  it("refuses a DELETE addressed by a resource's WorkOS-side id", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
    const nativeUsers = installNative(fake);
    const workosUsers = installWorkos(fake);

    expect(
      (
        await send(env, directory, "POST", "/scim/v2/Users", {
          userName: "ada@example.com",
          active: true,
        })
      ).status,
    ).toBe(201);

    // Addressing the victim's WorkOS id directly is what PR #84's guard refuses.
    const del = await send(env, directory, "DELETE", "/scim/v2/Users/wos_1");
    expect(del.status).toBe(404);
    expect(workosUsers.has("wos_1")).toBe(true);
    expect(nativeUsers.has("nat_9f3c")).toBe(true);
  });
});
