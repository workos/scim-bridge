import { describe, expect, it } from "vitest";
import { reconcileGroups, reconcileUsers, tombstoneSummary } from "../app/routes/panel/reconcile";

/**
 * The mirror of the WorkOS-tombstone exclusion (see panel-workos-tombstones.test.ts).
 *
 * With the environment's suspension soft-delete off, a plain deactivation
 * arrives as `dsync.user.deleted`, so the reference listener's deactivate-in-place
 * path leaves the native app holding an Inactive row after the user is gone from
 * WorkOS and the IdP. That native-side Inactive record — native inactive, workos
 * absent, idp absent — is a tombstone, not drift; purging it is a retention
 * decision, exactly as on the WorkOS side.
 *
 * The gate is deliberately narrow, and each clause guards a real anomaly:
 *  - native must be *inactive*. An **active** native row with no workos/idp record
 *    is a genuine strand — a write that never propagated — and must keep counting.
 *  - idp must be *absent*. A user inactive-in-native and absent-from-workos but
 *    still present in the IdP is a real anomaly, not a clean tombstone.
 */

const user = (name: string, active: number) => ({ name, active });

describe("native tombstones in the users reconciliation", () => {
  it("does not count a user native retains as inactive after WorkOS and the IdP dropped it", () => {
    const rows = reconcileUsers({
      native: [user("ada.lovelace@acme.test", 0)],
      workos: [],
      idp: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "ada.lovelace@acme.test",
      native: "inactive",
      workos: "absent",
      idp: "absent",
      diverged: false,
      tombstone: true,
    });
  });

  it("keeps the tombstone row in the table so the record stays inspectable", () => {
    const rows = reconcileUsers({
      native: [user("ada.lovelace@acme.test", 0)],
      workos: [],
      idp: [],
    });

    expect(rows.map((r) => r.name)).toEqual(["ada.lovelace@acme.test"]);
  });

  it("still counts an ACTIVE native row that workos and the IdP do not have", () => {
    // The invariant the whole exclusion exists to protect: an active row with no
    // workos/idp record is a write that never landed there, not a tombstone.
    const rows = reconcileUsers({
      native: [user("erin@acme.test", 1)],
      workos: [],
      idp: [],
    });

    expect(rows[0]).toMatchObject({
      native: "active",
      workos: "absent",
      idp: "absent",
      diverged: true,
      tombstone: false,
    });
  });

  it("still counts a native-inactive user the IdP still has", () => {
    // Inactive in native and absent from workos but present in the IdP is a
    // genuine anomaly, not a clean tombstone — all three clauses are required.
    const rows = reconcileUsers({
      native: [user("ada.lovelace@acme.test", 0)],
      workos: [],
      idp: [user("ada.lovelace@acme.test", 1)],
    });

    expect(rows[0]).toMatchObject({
      native: "inactive",
      workos: "absent",
      idp: "active",
      diverged: true,
      tombstone: false,
    });
  });
});

/**
 * The same deactivate-in-place leaves the user standing in native's groups while
 * workos and the IdP no longer carry the edge, so membership needs the mirror
 * exclusion too — the opposite orientation of the WorkOS-tombstone edge rule.
 */

const group = (name: string, members: string[]) => ({ name, members });

describe("native tombstones in the groups reconciliation", () => {
  it("does not count a member native's group keeps after WorkOS and the IdP dropped the user", () => {
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["carol@acme.test", "ada.lovelace@acme.test"])],
        workos: [group("Engineering", ["carol@acme.test"])],
        idp: [group("Engineering", ["carol@acme.test"])],
      },
      {
        native: [user("carol@acme.test", 1), user("ada.lovelace@acme.test", 0)],
        workos: [user("carol@acme.test", 1)],
        idp: [user("carol@acme.test", 1)],
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Engineering", diverged: false, tombstones: 1 });
    // Counts stay true to what each directory reports; only the judgement changes.
    expect(rows[0]).toMatchObject({ native: 2, workos: 1 });
    expect(rows[0]?.members).toContainEqual({
      name: "ada.lovelace@acme.test",
      native: true,
      workos: false,
      idp: false,
      diverged: false,
      tombstone: true,
    });
  });

  it("still counts an ACTIVE member only native's group holds", () => {
    // Active in native, absent from workos+idp: a membership native never
    // propagated, not a tombstone.
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["erin@acme.test"])],
        workos: [group("Engineering", [])],
        idp: [group("Engineering", [])],
      },
      {
        native: [user("erin@acme.test", 1)],
        workos: [],
        idp: [],
      },
    );

    expect(rows[0]).toMatchObject({ diverged: true, tombstones: 0 });
    expect(rows[0]?.members).toContainEqual({
      name: "erin@acme.test",
      native: true,
      workos: false,
      idp: false,
      diverged: true,
      tombstone: false,
    });
  });

  it("still counts a native-inactive member the IdP still has", () => {
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["ada.lovelace@acme.test"])],
        workos: [group("Engineering", [])],
        idp: [group("Engineering", ["ada.lovelace@acme.test"])],
      },
      {
        native: [user("ada.lovelace@acme.test", 0)],
        workos: [],
        idp: [user("ada.lovelace@acme.test", 1)],
      },
    );

    expect(rows[0]).toMatchObject({ diverged: true, tombstones: 0 });
  });
});

/**
 * The exclusion reads WorkOS-absence as a deletion, so it must trust that
 * absence. When the WorkOS listing failed to load, `fetchWorkosDirectory` returns
 * an empty list with `reachable: false` — indistinguishable, by content, from a
 * directory that genuinely holds no such user. Reading that empty list as
 * absence would silently reclassify every native-inactive/idp-absent user as a
 * deleted tombstone during a WorkOS outage, masking real drift. So the
 * native-side exclusion only fires when WorkOS was actually reached.
 */
describe("the native tombstone requires WorkOS to have been reached", () => {
  it("does not tombstone a native-inactive row when WorkOS was unreachable", () => {
    const rows = reconcileUsers(
      { native: [user("ada.lovelace@acme.test", 0)], workos: [], idp: [] },
      { workosReachable: false },
    );

    expect(rows[0]).toMatchObject({
      native: "inactive",
      workos: "absent",
      idp: "absent",
      diverged: true,
      tombstone: false,
    });
  });

  it("tombstones the same row once WorkOS was reached and the user is genuinely absent", () => {
    const rows = reconcileUsers(
      { native: [user("ada.lovelace@acme.test", 0)], workos: [], idp: [] },
      { workosReachable: true },
    );

    expect(rows[0]).toMatchObject({ diverged: false, tombstone: true });
  });

  it("does not tombstone a native-only membership edge when WorkOS was unreachable", () => {
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["ada.lovelace@acme.test"])],
        workos: [group("Engineering", [])],
        idp: [group("Engineering", [])],
      },
      {
        native: [user("ada.lovelace@acme.test", 0)],
        workos: [],
        idp: [],
      },
      { workosReachable: false },
    );

    expect(rows[0]).toMatchObject({ diverged: true, tombstones: 0 });
    expect(rows[0]?.members).toContainEqual({
      name: "ada.lovelace@acme.test",
      native: true,
      workos: false,
      idp: false,
      diverged: true,
      tombstone: false,
    });
  });
});

/**
 * The headline splits the tombstone count by orientation so it can describe each
 * accurately instead of attributing both to WorkOS. `tombstoneSummary` reads the
 * split back off the reconciled rows.
 */
describe("splitting tombstones by orientation for the headline", () => {
  it("counts WorkOS-side and native-side user and member tombstones separately", () => {
    const userRows = reconcileUsers({
      // ada: WorkOS retains inactive, native dropped it — WorkOS-side.
      // bob: native retains inactive, WorkOS + IdP dropped it — native-side.
      // carol: a living user on both sides, not a tombstone.
      native: [user("bob@acme.test", 0), user("carol@acme.test", 1)],
      workos: [user("ada@acme.test", 0), user("carol@acme.test", 1)],
      idp: [user("carol@acme.test", 1)],
    });
    const groupRows = reconcileGroups(
      {
        // WorkOS's group still carries ada (WorkOS-side edge tombstone); native's
        // group still carries bob (native-side edge tombstone).
        native: [group("Engineering", ["bob@acme.test", "carol@acme.test"])],
        workos: [group("Engineering", ["ada@acme.test", "carol@acme.test"])],
        idp: [group("Engineering", ["carol@acme.test"])],
      },
      {
        native: [user("bob@acme.test", 0), user("carol@acme.test", 1)],
        workos: [user("ada@acme.test", 0), user("carol@acme.test", 1)],
        idp: [user("carol@acme.test", 1)],
      },
    );

    expect(tombstoneSummary(userRows, groupRows)).toEqual({
      users: { workos: 1, native: 1 },
      members: { workos: 1, native: 1 },
    });
  });

  it("counts nothing when a native-only row is active or the IdP still has it", () => {
    // Neither shape is a tombstone, so neither orientation is counted.
    const userRows = reconcileUsers({
      native: [user("erin@acme.test", 1), user("ada@acme.test", 0)],
      workos: [],
      idp: [user("ada@acme.test", 1)],
    });

    expect(tombstoneSummary(userRows, [])).toEqual({
      users: { workos: 0, native: 0 },
      members: { workos: 0, native: 0 },
    });
  });
});
