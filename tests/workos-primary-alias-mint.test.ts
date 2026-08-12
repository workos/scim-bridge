import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { runBackfill } from "../workers/shared/backfill";
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
    // A uniqueness lookup: the native app answers for the victim it holds and for
    // nothing else, as it would for a resource it has never seen.
    fake.route("native", "GET", /^\/Users\?/, (call) => {
      const filter = new URL(`http://native${call.path}`).searchParams.get("filter");
      const hit = filter === 'userName eq "ada@example.com"' && nativeHasVictim;
      const rows = hit ? [{ id: "nat_9f3c", userName: "ada@example.com" }] : [];
      return scimJson(200, {
        totalResults: rows.length,
        startIndex: 1,
        itemsPerPage: rows.length,
        Resources: rows,
      });
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
    const before = fake.callsTo("native").length;

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

    // The refusal is final, so it is reached before either app is written to:
    // there is no row to take back and nothing for a reconcile to find.
    expect(
      fake
        .callsTo("native")
        .slice(before)
        .filter((c) => c.method !== "GET"),
    ).toEqual([]);
    expect(workosHas()).toBe(true);
    expect(nativeHas()).toBe(true);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("refuses a claimed mint whose resource native cannot be resolved", async () => {
    // Native holds the claimed resource but cannot be asked which row it is (no
    // filter support): with no proof the create is the claimed resource's retry,
    // the refusal stands, and it still costs neither app a write.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    fake.route("native", "GET", /^\/Users\?/, scimJson(501, { detail: "filters unsupported" }));
    routeUpstreams();
    const before = fake.callsTo("native").length;

    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "fresh@example.com",
        externalId: "idp-1",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(created.status).toBe(409);
    expect(
      fake
        .callsTo("native")
        .slice(before)
        .filter((c) => c.method !== "GET"),
    ).toEqual([]);
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("refuses a backfill replay of a native row another resource's mapping claims", async () => {
    // The same collision reached through the operator's runbook rather than the
    // proxy: the attacker names a native row's id as its own externalId, so the
    // victim row's later replay would write the attacker's WorkOS row.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_att", userName: "fresh" }), {
      once: true,
    });
    fake.route("workos", "PUT", "/Users/nat_victim", scimJson(404, { detail: "not found" }), {
      once: true,
    });
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "nat_victim" }), { once: true });
    const claim = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "fresh@example.com",
        externalId: "nat_victim",
        active: true,
      }),
      env,
      createCtx(),
    );
    expect(claim.status).toBe(201);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_att")).toMatchObject({
      workos_id: "nat_victim",
    });

    // The operator backfills. The victim's own native row is unmapped, and its
    // id is the attacker's WorkOS-side id.
    fake.route("native", "GET", /^\/Users(\?|$)/, () =>
      scimJson(200, {
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "nat_victim", userName: "ada@example.com", active: true }],
      }),
    );
    fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
      scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
    );
    let victimReplayed = false;
    fake.route("workos", "PUT", "/Users/nat_victim", () => {
      victimReplayed = true;
      return scimJson(200, { id: "nat_victim" });
    });

    const summary = await runBackfill(env.DB, directory);

    // The replay would have landed on the attacker's WorkOS row, so it is not made.
    expect(victimReplayed).toBe(false);
    expect(summary.users.failed).toBe(1);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_victim")).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "nat_att")).toMatchObject({
      workos_id: "nat_victim",
    });
  });

  it("refuses a same-page backfill claim that has not been flushed yet", async () => {
    // The claim and the row that collides with it are mirrored in one page, so
    // the claim only exists in the run's queue when the second row is reached.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake.route("native", "GET", /^\/Users(\?|$)/, () =>
      scimJson(200, {
        totalResults: 2,
        startIndex: 1,
        itemsPerPage: 2,
        Resources: [
          { id: "nat_att", userName: "fresh@example.com", externalId: "nat_victim" },
          { id: "nat_victim", userName: "ada@example.com" },
        ],
      }),
    );
    fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
      scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
    );
    // nat_att's own migrated-id PUT 404s, so WorkOS mints it the victim's id.
    fake.route("workos", "PUT", "/Users/nat_att", scimJson(404, { detail: "not found" }), {
      once: true,
    });
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "nat_victim" }), { once: true });
    let victimReplayed = false;
    fake.route("workos", "PUT", "/Users/nat_victim", () => {
      victimReplayed = true;
      return scimJson(200, { id: "nat_victim" });
    });

    const summary = await runBackfill(env.DB, directory);

    // The queued claim is enough: the victim's row is not written under it.
    expect(victimReplayed).toBe(false);
    expect(summary.users).toMatchObject({ total: 2, mirrored: 1, failed: 1 });
    expect(await getMapping(env.DB, directory.id, "Users", "nat_victim")).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "nat_att")).toMatchObject({
      workos_id: "nat_victim",
    });
  });

  it("refuses a claimed mint without writing to native at all", async () => {
    // The refusal the create leg cannot undo: native already holds the resource,
    // so its answer to the POST would not be evidence this request made the row.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    const before = fake.callsTo("native").length;
    // Native resolves the attacker's userName to a row it already has.
    fake.route("native", "GET", /^\/Users\?/, () =>
      scimJson(200, {
        totalResults: 1,
        startIndex: 1,
        itemsPerPage: 1,
        Resources: [{ id: "nat_pre", userName: "fresh@example.com" }],
      }),
    );
    routeUpstreams();

    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "fresh@example.com",
        externalId: "idp-1",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(created.status).toBe(409);
    // The pre-existing row is neither created, written to, nor deleted.
    expect(
      fake
        .callsTo("native")
        .slice(before)
        .filter((c) => c.method !== "GET"),
    ).toEqual([]);
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

  it("tells the IdP a colliding create will not converge, and pollutes no ledger", async () => {
    // A create with no externalId whose native-minted id happens to be another
    // resource's WorkOS-side id: mirrorUpsert refuses before writing. The IdP must
    // not be told to retry — the collision is permanent — and the refusal is not a
    // native-lagging-WorkOS gap, so nothing belongs in the divergence card.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    let title: string | undefined;
    fake.route("workos", "PUT", /^\/Users\//, (call) => {
      if (call.path !== "/Users/idp-1") return scimJson(404, { detail: "not found" });
      title = (call.json() as Record<string, string>).title;
      return scimJson(200, { id: "idp-1", userName: "ada" });
    });
    // Native mints its own id for this create, and it is the victim's WorkOS id.
    fake.route("native", "POST", "/Users", scimJson(201, { id: "idp-1", userName: "fresh" }), {
      once: true,
    });

    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "fresh@example.com",
        title: "attacker-owned",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(created.status).toBe(409);
    const body = (await created.json()) as { detail?: string };
    // Accurate: names the collision, and never advises the retry that would loop.
    expect(body.detail).toContain("already the WorkOS-side id");
    expect(body.detail).not.toContain("will converge");
    // The victim's WorkOS row was never written, and no ledger row was minted.
    expect(title).toBeUndefined();
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    // No alias mapping was recorded under the victim's WorkOS id either.
    expect(await getMapping(env.DB, directory.id, "Users", "idp-1")).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
    });
  });

  it("refuses a native-raced retry without inverting the divergence card", async () => {
    // The pre-check resolves native to the claimed resource, but native then
    // answers the create POST with a third id — a race between the resolve and the
    // create. Nothing was written to WorkOS, so the two ids never collapsed. The
    // orphan native row must NOT be logged as a native write failure: that card is
    // "what WorkOS holds that native is missing", and here native holds the row and
    // WorkOS holds nothing — the inverse — and a reconcile would sweep it anyway.
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    expect((await createVictim(directory)).status).toBe(201);
    routeUpstreams();
    // The uniqueness lookup resolves the retry to the claimed native id (pre-check
    // passes), but the create POST mints a different id.
    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_race", userName: "ada" }), {
      once: true,
    });

    const created = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", {
        userName: "ada@example.com",
        externalId: "idp-1",
        active: true,
      }),
      env,
      createCtx(),
    );

    expect(created.status).toBe(409);
    const body = (await created.json()) as { detail?: string };
    expect(body.detail).not.toContain("will converge");
    // The divergence ledger stays empty, and the raced id earns no mapping.
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
    expect(await getMapping(env.DB, directory.id, "Users", "nat_race")).toBeNull();
    expect(await getMapping(env.DB, directory.id, "Users", "nat_9f3c")).toMatchObject({
      workos_id: "idp-1",
    });
  });
});
