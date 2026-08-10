import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  claimReconcileRun,
  listNativeWriteFailures,
  releaseReconcileRun,
  upsertMapping,
} from "../workers/shared/db";
import { ReconcileInFlightError, runReconcileFromWorkos } from "../workers/shared/backfill";
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
 * The defect these pin: the sweep-token protocol assumes at most one reconcile
 * per directory is in flight, but nothing enforces it. `markDivergencesForSweep` is an
 * unconditional `UPDATE ... SET sweep_token = ? WHERE directory_id = ?`, so a
 * second reconcile that starts mid-flight re-stamps the stamp-less rows the first
 * run's watermark deliberately protects. The second run then legitimately clears
 * such a row after its own fresh replay, and the first run's stale snapshot replay
 * re-asserts the pre-change state onto native afterwards — a live gap with no
 * ledger row behind it.
 *
 * The claim `runReconcileFromWorkos` now takes is what enforces the assumption:
 * the overlapping run is refused, so the stamp-less row stands and the cutover
 * card still shows the gap.
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

describe("overlapping reconciles and a post-watermark divergence", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

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

  /** Drive the whole interleaving. `overlap` runs the second reconcile inside the
   *  first one's snapshot page — the only difference between the two cases. */
  async function race(overlap: boolean) {
    const directory = await seedDwelling();
    let nativeAcceptsWrites = true;
    let nativeActive = true;
    let workosActive = true;
    let pageServed = 0;
    let midRun: Awaited<ReturnType<typeof listNativeWriteFailures>> = [];
    let afterInner: Awaited<ReturnType<typeof listNativeWriteFailures>> = [];
    let innerError: unknown = null;

    fake.route("workos", "PUT", "/Users/wos_2", (call) => {
      const body = call.json() as Record<string, unknown>;
      workosActive = body.active !== false;
      return scimJson(200, body);
    });
    fake.route("native", "PUT", /^\/Users\//, (call) => {
      if (!nativeAcceptsWrites) return scimJson(500, { detail: "blip" });
      const body = call.json() as Record<string, unknown>;
      nativeActive = body.active !== false;
      return scimJson(200, body);
    });

    fake.route("workos", "GET", "/Users", async () => {
      pageServed += 1;
      // Run B (nested) pages after the deactivation: it sees the fresh state.
      if (pageServed > 1) return listPage([{ id: "wos_2", userName: "two@x.test", active: false }]);

      // Run A is mid-snapshot. The IdP deactivates u2 through the proxy: the
      // WorkOS leg commits `active:false`, the native leg blips, so the gap is
      // recorded stamp-less — un-clearable by run A, by design.
      nativeAcceptsWrites = false;
      const deactivate = await proxyWorker.fetch(
        proxyRequest(directory, "PUT", "/scim/v2/Users/u2", {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          id: "u2",
          userName: "two@x.test",
          active: false,
        }),
        env,
        createCtx(),
      );
      expect(deactivate.status).toBe(502);
      midRun = await listNativeWriteFailures(env.DB, directory.id);
      nativeAcceptsWrites = true; // native recovers

      if (overlap) {
        // A second reconcile starts while A is still paging: second tab, retry
        // after a proxy timeout, double submit, or a forged cross-site POST.
        innerError = await runReconcileFromWorkos(env.DB, directory).then(
          () => null,
          (error: unknown) => error,
        );
        afterInner = await listNativeWriteFailures(env.DB, directory.id);
      }

      // Run A's page was read before the deactivation.
      return listPage([{ id: "wos_2", userName: "two@x.test", active: true }]);
    });
    fake.route("workos", "GET", "/Groups", listPage([]));

    await runReconcileFromWorkos(env.DB, directory);

    return {
      directory,
      midRun,
      afterInner,
      rows: await listNativeWriteFailures(env.DB, directory.id),
      innerError,
      nativeActive,
      workosActive,
    };
  }

  it("refuses the overlapping reconcile, so the live gap keeps its record", async () => {
    const result = await race(true);

    expect(result.midRun).toMatchObject([
      { resource_key: "u2", method: "PUT", native_status: 500, sweep_token: null },
    ]);
    // The second run never got to re-stamp anything: it could not take the claim.
    expect(result.innerError).toBeInstanceOf(ReconcileInFlightError);
    expect(result.afterInner).toMatchObject([{ resource_key: "u2", sweep_token: null }]);

    // Run A's stale replay still re-asserts `active: true` on native, but the row
    // recording that divergence survives, so the cutover card stays red.
    expect(result.workosActive).toBe(false);
    expect(result.nativeActive).toBe(true);
    expect(result.rows).toMatchObject([
      { resource_key: "u2", method: "PUT", native_status: 500, sweep_token: null },
    ]);
  });

  it("negative control: without the overlap the gap survives (PR #71 bound holds)", async () => {
    const result = await race(false);

    expect(result.workosActive).toBe(false);
    expect(result.nativeActive).toBe(true);
    const gap = result.rows.find((row) => row.resource_key === "u2");
    expect(gap).toBeDefined();
    expect(gap).toMatchObject({ method: "PUT", native_status: 500, sweep_token: null });
  });

  it("hands the claim back on release, and takes over one left by a crash", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });

    expect(await claimReconcileRun(env.DB, directory.id, "run-a")).toBe(true);
    expect(await claimReconcileRun(env.DB, directory.id, "run-b")).toBe(false);

    // A run that ends releases its own claim; a later one is free to take it.
    await releaseReconcileRun(env.DB, directory.id, "run-a");
    expect(await claimReconcileRun(env.DB, directory.id, "run-b")).toBe(true);

    // A claim left behind by a crashed run must not block the directory forever,
    // so one older than the TTL is takeable.
    await env.DB.prepare("UPDATE scim_directories SET reconcile_started_at = ? WHERE id = ?")
      .bind("2000-01-01 00:00:00", directory.id)
      .run();
    expect(await claimReconcileRun(env.DB, directory.id, "run-c")).toBe(true);

    // The crashed run's late release must not hand away the live claim.
    await releaseReconcileRun(env.DB, directory.id, "run-b");
    expect(await claimReconcileRun(env.DB, directory.id, "run-d")).toBe(false);
  });
});
