import { describe, expect, it } from "vitest";
import { reconcileUsers } from "../app/routes/panel/reconcile";

/**
 * The Live state panel's convergence check against WorkOS's retained SCIM records.
 *
 * WorkOS keeps SCIM resources and directory users in separate tables, so a delete
 * removes the directory user and leaves the SCIM resource behind with
 * `active: false`; the native app has one table and its row is gone. The panel
 * reads `GET /Users` — the SCIM table — so every user ever deleted sits in the
 * WorkOS column forever, and counting those as drift made the headline number
 * grow monotonically (a real directory: 8 "missing from native", 7 of them this).
 *
 * The exclusion is narrow on purpose. Inactive-in-WorkOS + absent-from-native is
 * a tombstone; *active*-in-WorkOS + absent-from-native is a live resource the
 * native app should hold and doesn't, which is a real strand and must survive
 * this change — the whole risk here is an exclusion that swallows it.
 */

const user = (name: string, active: number) => ({ name, active });

describe("WorkOS tombstones in the users reconciliation", () => {
  it("does not count a user WorkOS retains as inactive after native deleted the row", () => {
    const rows = reconcileUsers({
      native: [],
      workos: [user("ada.lovelace@acme.test", 0)],
      idp: [],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "ada.lovelace@acme.test",
      native: "absent",
      workos: "inactive",
      diverged: false,
      tombstone: true,
    });
  });

  it("still counts a user WorkOS holds as active that native does not have", () => {
    const rows = reconcileUsers({
      native: [],
      workos: [user("bob.baker@acme.test", 1)],
      idp: [user("bob.baker@acme.test", 1)],
    });

    expect(rows[0]).toMatchObject({
      name: "bob.baker@acme.test",
      native: "absent",
      workos: "active",
      diverged: true,
      tombstone: false,
    });
  });

  it("keeps the tombstone row in the table so the record stays inspectable", () => {
    const rows = reconcileUsers({
      native: [],
      workos: [user("ada.lovelace@acme.test", 0)],
      idp: [],
    });

    expect(rows.map((r) => r.name)).toEqual(["ada.lovelace@acme.test"]);
  });

  it("leaves the measured directory with one real divergence instead of eight", () => {
    // The shape observed on a real directory right after a backfill: the living
    // users have converged, seven deleted users linger as inactive SCIM records,
    // and one genuine strand is active in WorkOS with no native row.
    const deleted = Array.from({ length: 7 }, (_, i) => user(`gone-${i}@acme.test`, 0));
    const rows = reconcileUsers({
      native: [user("carol@acme.test", 1)],
      workos: [...deleted, user("bob.baker@acme.test", 1), user("carol@acme.test", 1)],
      idp: [user("bob.baker@acme.test", 1), user("carol@acme.test", 1)],
    });

    expect(rows.filter((r) => r.diverged).map((r) => r.name)).toEqual(["bob.baker@acme.test"]);
    expect(rows.filter((r) => r.tombstone)).toHaveLength(7);
  });

  it("does not extend the exclusion to a user native still holds", () => {
    // Inactive in WorkOS but present in native is an ordinary state difference,
    // not a delete WorkOS survived: native has a row, so there is something to
    // reconcile and it keeps counting.
    const rows = reconcileUsers({
      native: [user("dana@acme.test", 1)],
      workos: [user("dana@acme.test", 0)],
      idp: [user("dana@acme.test", 1)],
    });

    expect(rows[0]).toMatchObject({ diverged: true, tombstone: false });
  });

  it("does not excuse the mirror image, a row only the native app has", () => {
    // The asymmetry runs one way: WorkOS retains, native does not. An inactive
    // native row WorkOS never received is a write that did not land.
    const rows = reconcileUsers({
      native: [user("erin@acme.test", 0)],
      workos: [],
      idp: [],
    });

    expect(rows[0]).toMatchObject({
      native: "inactive",
      workos: "absent",
      diverged: true,
      tombstone: false,
    });
  });

  it("treats a user both sides deactivated as converged, with no tombstone label", () => {
    const rows = reconcileUsers({
      native: [user("frank@acme.test", 0)],
      workos: [user("frank@acme.test", 0)],
      idp: [],
    });

    expect(rows[0]).toMatchObject({ diverged: false, tombstone: false });
  });
});
