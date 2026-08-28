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
 * A `workos-primary` create keys the mirror leg on the tenant's `externalId`, so
 * an `externalId` equal to an already-mapped resource's NATIVE id must never mint
 * a second mapping onto that resource's WorkOS row.
 *
 * The sibling guard refuses an `externalId` equal to another resource's
 * `workos_id` (a `claimedMint`, caught on the `workos_id` column). This is the
 * other column: `mirrorUpsert(nativeId = externalId)` finds the victim's mapping,
 * takes its existing-mapping branch — which runs no `claimedByAnother` check —
 * PUTs the victim's WorkOS row, and records `{externalId → victim_workos}` into
 * the sink; the create then rebinds that WorkOS id onto native's freshly echoed
 * decoy id. Two native ids resolve to one WorkOS row, the alias-mint primitive
 * the DELETE id-space guard reads as a live native id, and the silent one-sided
 * deprovisioning bypass is restored with the divergence ledger left clean.
 */
describe("workos-primary create: externalId equal to another resource's native id", () => {
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

  it("refuses the create before either leg, and mints no alias onto the victim's row", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
      strategy: "fallback-post",
    });
    const before = fake.callsTo("native").length;

    // Honest upstreams that would let the attack land if the create did not refuse:
    // the victim's WorkOS row answers a PUT, and native mints a decoy for the create.
    let victimRowWritten = false;
    fake.route("workos", "PUT", "/Users/idp-1", () => {
      victimRowWritten = true;
      return scimJson(200, { id: "idp-1", userName: "attacker" });
    });
    fake.route(
      "native",
      "POST",
      "/Users",
      scimJson(201, { id: "nat_decoy", userName: "mallory" }),
      {
        once: true,
      },
    );

    // The attack: externalId names the victim's NATIVE id, not its WorkOS id.
    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "mallory@example.com",
        externalId: "nat_9f3c",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(created.status).toBe(409);
    const body = (await created.json()) as { detail?: string };
    expect(body.detail).toContain("nat_9f3c");
    // Permanent collision — never advise the retry that would loop the IdP forever.
    expect(body.detail).not.toContain("will converge");

    // The refusal is resolved before the mirror leg, so the victim's row is never
    // written and native is never asked to mint the decoy.
    expect(victimRowWritten).toBe(false);
    expect(
      fake
        .callsTo("native")
        .slice(before)
        .filter((c) => c.method !== "GET"),
    ).toEqual([]);

    // No second mapping points at the victim's WorkOS row, and the victim's own
    // mapping is untouched — the id space the DELETE guard reads stays intact.
    expect(await getMapping(env.DB, directory.id, "Users", "nat_decoy")).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
      strategy: "fallback-post",
    });
    // Nothing is owed to native, so the cutover-safety card stays empty.
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("still creates a resource whose externalId names no existing mapping", async () => {
    // The narrowness guard: the refusal keys on an EXISTING mapping, so a genuine
    // first-touch create with a fresh externalId must still converge to a 201.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);

    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_fresh", userName: "grace" }), {
      once: true,
    });
    fake.route("workos", "PUT", "/Users/fresh-1", scimJson(404, { detail: "not found" }), {
      once: true,
    });
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "fresh-1", userName: "grace" }), {
      once: true,
    });

    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "grace@example.com",
        externalId: "fresh-1",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(created.status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_fresh")).toMatchObject({
      workos_id: "fresh-1",
      strategy: "fallback-post",
    });
  });

  it("converges an IdP retry when native adopted the externalId under a fallback-post mapping", async () => {
    // The retry the refusal must NOT catch: a native app that adopts the externalId
    // as its own id (native_id === externalId) while WorkOS mints a different id, so
    // the mapping is {native_id: E, workos_id: W} and a faithful retry resolves E on
    // the native_id column. It is the same resource, not a cross-resource alias, so
    // it must converge onto W rather than be refused.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });

    // First create: native adopts externalId "E"; WorkOS mints a different id "W".
    fake.route("native", "POST", "/Users", scimJson(201, { id: "E", userName: "ada" }), {
      once: true,
    });
    fake.route("workos", "PUT", "/Users/E", scimJson(404, { detail: "not found" }), { once: true });
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "W", userName: "ada" }), {
      once: true,
    });
    const first = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "ada@example.com",
        externalId: "E",
        active: true,
      }),
      env,
      createCtx(),
    );
    expect(first.status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "E")).toMatchObject({
      workos_id: "W",
      strategy: "fallback-post",
    });

    // The retry: native resolves the resource by its userName and adopts the id
    // again, and the mirror converges onto the existing WorkOS row W.
    fake.route("native", "GET", /^\/Users\?/, (call) => {
      const filter = new URL(`http://native${call.path}`).searchParams.get("filter");
      const rows =
        filter === 'userName eq "ada@example.com"'
          ? [{ id: "E", userName: "ada@example.com" }]
          : [];
      return scimJson(200, {
        totalResults: rows.length,
        startIndex: 1,
        itemsPerPage: rows.length,
        Resources: rows,
      });
    });
    fake.route("native", "POST", "/Users", scimJson(201, { id: "E", userName: "ada" }), {
      once: true,
    });
    fake.route("workos", "PUT", "/Users/W", scimJson(200, { id: "W", userName: "ada" }));

    const retry = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "ada@example.com",
        externalId: "E",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ id: "E" });
    // The one mapping is unchanged — the retry converged, no alias was minted.
    expect(await getMapping(env.DB, directory.id, "Users", "E")).toMatchObject({
      workos_id: "W",
      strategy: "fallback-post",
    });
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });
});
