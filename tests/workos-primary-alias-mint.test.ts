import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { getMapping, listNativeWriteFailures } from "../workers/shared/db";
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
 * An id this directory already maps as one resource's `workos_id` must never
 * become a second resource's id.
 *
 * The `workos-primary` DELETE id-space guard classifies the path id against
 * `id_mappings` — an id no resource holds as a `native_id` is refused. That is
 * only sound while the caller cannot mint such a row: a mapping `{native_id: W,
 * workos_id: W}` for another resource's `workos_id` W satisfies the guard while
 * the two legs still split across the victim's pair, which restores the
 * deprovisioning bypass in full (WorkOS row deleted, native account live, the
 * divergence ledger clean).
 *
 * Both routes to the mint are driven from the position an attacker actually
 * holds: one directory's proxy bearer token, and the WorkOS-side id the same
 * token supplied as an `externalId` at create time.
 */
describe("workos-primary id mints across resources", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;

  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  /** The victim: an externalId-bearing create, as Okta and Entra send it. */
  async function createVictim(directory: SeededDirectory): Promise<Response> {
    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_9f3c", userName: "ada" }), {
      once: true,
    });
    fake.route("workos", "PUT", "/Users/idp-1", scimJson(404, { detail: "not found" }), {
      once: true,
    });
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "idp-1", userName: "ada" }), {
      once: true,
    });
    return proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "ada@example.com",
        externalId: "idp-1",
        active: true,
      }),
      env,
      createCtx(),
    );
  }

  /** Both upstreams, each answering honestly for the id it actually holds. */
  function routeUpstreams(): {
    nativeHas: () => boolean;
    workosHas: () => boolean;
    workosTitle: () => string | undefined;
  } {
    let nativeHasVictim = true;
    let workosHasVictim = true;
    let title: string | undefined;
    fake.route("workos", "PUT", /^\/Users\//, (call) => {
      if (call.path !== "/Users/idp-1" || !workosHasVictim) {
        return scimJson(404, { detail: "not found" });
      }
      title = (call.json() as Record<string, string>).title;
      return scimJson(200, { id: "idp-1", userName: "ada" });
    });
    fake.route("workos", "DELETE", /^\/Users\//, (call) => {
      if (call.path !== "/Users/idp-1" || !workosHasVictim) {
        return scimJson(404, { detail: "not found" });
      }
      workosHasVictim = false;
      return new Response(null, { status: 204 });
    });
    // The native app holds only its own id and resolves the raw path bytes.
    fake.route("native", "PUT", /^\/Users\//, (call) =>
      call.path === "/Users/nat_9f3c"
        ? scimJson(200, { id: "nat_9f3c", userName: "ada" })
        : scimJson(404, { detail: "not found" }),
    );
    fake.route("native", "DELETE", /^\/Users\//, (call) => {
      if (call.path !== "/Users/nat_9f3c") return scimJson(404, { detail: "not found" });
      nativeHasVictim = false;
      return new Response(null, { status: 204 });
    });
    return {
      nativeHas: () => nativeHasVictim,
      workosHas: () => workosHasVictim,
      workosTitle: () => title,
    };
  }

  it("refuses a replace that would adopt another resource's WorkOS-side id", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
      strategy: "fallback-post",
    });
    const { nativeHas, workosHas, workosTitle } = routeUpstreams();

    const put = await proxyWorker.fetch(
      proxyRequest(directory, "PUT", "/scim/v2/Users/idp-1", {
        userName: "attacker@example.com",
        title: "attacker-owned",
        active: true,
      }),
      env,
      createCtx(),
    );

    // The WorkOS leg refused the mint, so the victim's row was never written and
    // the IdP hears the native app's own answer for bytes it does not hold.
    expect(put.status).toBe(404);
    expect(workosTitle()).toBeUndefined();
    // Nothing is owed to native either: WorkOS holds no write native is missing.
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    // No alias row, so the id space the DELETE guard reads is still intact.
    expect(await getMapping(env.DB, directory.id, "Users", "idp-1")).toBeNull();

    // The DELETE the guard exists for therefore still cannot be unlocked.
    const del = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/idp-1"),
      env,
      createCtx(),
    );
    expect(del.status).toBe(404);
    expect(workosHas()).toBe(true);
    expect(nativeHas()).toBe(true);
    // The victim's pair is untouched and still mapped.
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
    });
  });

  it("refuses a create whose externalId is another resource's WorkOS-side id", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    const { nativeHas, workosHas, workosTitle } = routeUpstreams();

    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_att", userName: "fresh" }), {
      once: true,
    });
    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "fresh@example.com",
        externalId: "idp-1",
        title: "attacker-owned",
        active: true,
      }),
      env,
      createCtx(),
    );

    // Refused, and the victim's WorkOS row was never written to: the mint is
    // resolved before the mirror leg runs, not after it has already landed.
    expect(created.status).toBe(409);
    expect(workosTitle()).toBeUndefined();
    // No second mapping may point at the victim's WorkOS row.
    expect(await getMapping(env.DB, directory.id, "Users", "nat_att")).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
    });

    // So a DELETE addressed by the attacker's own native id cannot reach the
    // victim's WorkOS row through a mapping it minted.
    fake.route("native", "DELETE", "/Users/nat_att", new Response(null, { status: 204 }), {
      once: true,
    });
    const del = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/nat_att"),
      env,
      createCtx(),
    );
    expect(del.status).toBe(404);
    expect(workosHas()).toBe(true);
    expect(nativeHas()).toBe(true);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("still converges an IdP retry of a create it already completed", async () => {
    // The mint the refusal above must not catch: the same resource, addressed by
    // the same externalId, whose native leg resolves to the id it already has.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    routeUpstreams();

    // Native answers the duplicate create with the row it already holds.
    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_9f3c", userName: "ada" }), {
      once: true,
    });
    const retry = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "ada@example.com",
        externalId: "idp-1",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ id: "nat_9f3c" });
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
      strategy: "fallback-post",
    });
  });
});
