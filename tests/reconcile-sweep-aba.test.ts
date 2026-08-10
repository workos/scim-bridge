import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { listNativeWriteFailures, upsertMapping } from "../workers/shared/db";
import { runReconcileFromWorkos } from "../workers/shared/backfill";
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
 * The defect this pins: the post-reconcile sweep gates its DELETE on the
 * `attempts` value captured at reconcile start, on the premise that `attempts` is a monotonic row
 * version. It is monotonic only within one row's lifetime: `native_write_failures`
 * rows are deleted (per-resource repair during the reconcile, or a live write that
 * lands) and re-created by an INSERT that omits `attempts`, so the new row restarts
 * at the schema default of 1 — the same value that was captured for the row it
 * replaced. The sweep cannot tell the two apart and erases the fresh, unresolved
 * divergence, turning the operator's cutover gate green over a real gap (ABA).
 *
 * Both divergences here are recorded by driving the real proxy HTTP handler with
 * the IdP's proxy token — the same interface the IdP uses — rather than by calling
 * the recorder directly.
 */
function listPage(resources: Record<string, unknown>[], totalResults = resources.length) {
  return scimJson(200, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

describe("reconcile sweep and a divergence re-created mid-reconcile", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  /** A workos-primary directory with u2 mapped — the post-backfill steady state. */
  async function seedDwelling(): Promise<SeededDirectory> {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "u2",
      workos_id: "wos_2",
      strategy: "migrated-id",
    });
    return directory;
  }

  it("keeps a fresh failure recorded after the reconcile cleared the row for that key", async () => {
    const directory = await seedDwelling();
    let nativeAcceptsWrites = false;
    let clearedByReplay: number | null = null;
    let midReconcile: Awaited<ReturnType<typeof listNativeWriteFailures>> = [];

    fake.route("workos", "PUT", "/Users/wos_2", (call) => scimJson(200, call.json()));
    fake.route("native", "PUT", /^\/Users\//, (call) =>
      nativeAcceptsWrites ? scimJson(200, call.json()) : scimJson(500, { detail: "outage" }),
    );

    // 1. A native-leg blip on a live IdP write: WorkOS commits, native does not, so
    //    the ledger holds one row for u2 with attempts = 1.
    const blip = await proxyWorker.fetch(
      proxyRequest(directory, "PUT", "/scim/v2/Users/u2", {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        id: "u2",
        userName: "two@x.test",
        active: true,
      }),
      env,
      createCtx(),
    );
    expect(blip.status).toBe(502);
    const captured = await listNativeWriteFailures(env.DB, directory.id);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ resource_key: "u2", method: "PUT", attempts: 1 });

    // 2. Native recovers and the operator runs "Reconcile from WorkOS". The replay
    //    PUT for u2 succeeds, so clearRepairedDivergences deletes the captured row.
    nativeAcceptsWrites = true;
    fake.route("workos", "GET", "/Users", listPage([{ id: "wos_2", userName: "two@x.test" }]));

    // 3. While the reconcile is still walking the directory (the Groups page here
    //    stands in for the rest of a minutes-long snapshot), the IdP deprovisions u2:
    //    WorkOS commits `active: false`, the native leg fails again. The row for u2
    //    no longer exists, so this INSERTs a NEW row — attempts restarts at 1.
    fake.route("workos", "GET", "/Groups", async () => {
      // The replay already repaired u2, so the captured row is gone by now: what
      // follows is a brand-new row, not an increment of the captured one.
      clearedByReplay = (await listNativeWriteFailures(env.DB, directory.id)).length;
      nativeAcceptsWrites = false;
      const deprovision = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/u2", {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          id: "u2",
          userName: "two@x.test",
          active: false,
        }),
        env,
        createCtx(),
      );
      expect(deprovision.status).toBe(502);
      midReconcile = await listNativeWriteFailures(env.DB, directory.id);
      return listPage([]);
    });

    await runReconcileFromWorkos(env.DB, directory);

    // The fresh row is a different row that happens to carry the same attempts.
    expect(clearedByReplay).toBe(0);
    expect(midReconcile).toMatchObject([{ resource_key: "u2", attempts: 1 }]);

    // 4. The deprovisioning gap post-dates the reconcile's watermark and the replay
    //    pushed the pre-deprovision state, so the row must survive and keep the
    //    cutover gate red. Vulnerable code erases it: the re-created row's attempts
    //    (1) equals the captured attempts (1) and its method is not DELETE.
    const rows = await listNativeWriteFailures(env.DB, directory.id);
    const gap = rows.find((row) => row.resource_key === "u2");
    expect(gap).toBeDefined();
    expect(gap).toMatchObject({ method: "PUT", native_status: 500 });
  });
});
