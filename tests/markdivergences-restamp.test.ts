import { beforeEach, describe, expect, it } from "vitest";
import {
  listNativeWriteFailures,
  markDivergencesForSweep,
  recordNativeWriteFailure,
} from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import { createEnv, seedDirectory } from "./helpers";

/**
 * The defect this pins: `markDivergencesForSweep` used to be an unconditional
 * `UPDATE ... SET sweep_token = ? WHERE directory_id = ?`. The reconcile claim
 * (`claimReconcileRun`) is the primary guard that keeps one reconcile per
 * directory in flight, but a run that overran the 30-min lease TTL can be
 * superseded — so two stampings can still race behind the lock. When they do, an
 * unconditional stamp lets the second run re-stamp rows the first run already
 * claimed, making them clearable under the second run's token while the first
 * run's stale snapshot is still replaying: the sweep-laundering primitive the
 * claim exists to close.
 *
 * The predicate `sweep_token IS NULL` is the second line: a row a live run has
 * already claimed keeps its stamp, so a superseding run cannot steal and clear
 * it. `recordNativeWriteFailure` re-NULLs a row (a live failure), which correctly
 * re-opens it to the next run's window; `clearReplayedDivergenceForResource`
 * deletes a repaired row rather than leaving it to be re-stamped.
 */
describe("markDivergencesForSweep stamps only unclaimed rows", () => {
  let env: PocEnv;
  beforeEach(async () => {
    env = await createEnv();
  });

  async function seedDivergence(directoryId: string, resourceKey: string): Promise<void> {
    await recordNativeWriteFailure(env.DB, {
      directory_id: directoryId,
      resource_type: "Users",
      resource_key: resourceKey,
      method: "PUT",
      native_status: 500,
      detail: "WorkOS committed this write; native did not",
    });
  }

  it("does not re-stamp a row an overlapping run already claimed", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await seedDivergence(directory.id, "u2");

    // Run A claims the row's stamp.
    await markDivergencesForSweep(env.DB, directory.id, "run-a");
    // Run B (an overrun-then-superseded overlap that slipped past the claim lock)
    // must NOT steal it: re-stamping under run-b would let run B clear a row run
    // A's stale replay is about to re-diverge.
    await markDivergencesForSweep(env.DB, directory.id, "run-b");

    const rows = await listNativeWriteFailures(env.DB, directory.id);
    expect(rows).toMatchObject([{ resource_key: "u2", sweep_token: "run-a" }]);
  });

  it("still stamps a stamp-less row (a normal reconcile's own start)", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await seedDivergence(directory.id, "u2");

    await markDivergencesForSweep(env.DB, directory.id, "run-a");

    const rows = await listNativeWriteFailures(env.DB, directory.id);
    expect(rows).toMatchObject([{ resource_key: "u2", sweep_token: "run-a" }]);
  });

  it("re-stamps a row a live failure re-NULLed after an earlier stamp", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await seedDivergence(directory.id, "u2");

    // Earlier run stamped it; a fresh live failure then re-NULLs the token, which
    // is how a divergence that keeps failing correctly re-enters the next run's
    // sweep window.
    await markDivergencesForSweep(env.DB, directory.id, "run-a");
    await seedDivergence(directory.id, "u2");
    await markDivergencesForSweep(env.DB, directory.id, "run-b");

    const rows = await listNativeWriteFailures(env.DB, directory.id);
    expect(rows).toMatchObject([{ resource_key: "u2", sweep_token: "run-b" }]);
  });
});
