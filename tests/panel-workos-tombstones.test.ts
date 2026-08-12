import { describe, expect, it } from "vitest";
import { reconcileGroups, reconcileUsers, workosGroupRows } from "../app/routes/panel/reconcile";

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

  it("reads the mirror image as a native-side tombstone once the IdP has dropped it too", () => {
    // This shape once counted as a one-directional asymmetry — a native inactive
    // row WorkOS never received. Deactivate-in-place gives it a second, correct
    // reading: WorkOS *and* the IdP are both gone, so native is simply the side
    // left holding the tombstone. The exclusion is symmetric now — see
    // isNativeTombstone and panel-native-tombstones.test.ts for the full set,
    // including the guard that an *active* native-only row still diverges.
    const rows = reconcileUsers({
      native: [user("erin@acme.test", 0)],
      workos: [],
      idp: [],
    });

    expect(rows[0]).toMatchObject({
      native: "inactive",
      workos: "absent",
      idp: "absent",
      diverged: false,
      tombstone: true,
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

/**
 * The same delete, one level down: it also takes the user's group-membership
 * edges out of the native app and leaves them standing in WorkOS, so `GET /Groups`
 * over-reports members for as long as the directory lives.
 *
 * The signal is the same one the users comparison uses — the member resolves to a
 * userName, and that user is inactive in WorkOS and absent from native — so the
 * rule is `isTombstone` applied per edge, not a guess about group shape. The same
 * invariant has to survive: an edge to an *active* WorkOS user native does not
 * have is a real strand and keeps counting.
 */

const group = (name: string, members: string[]) => ({ name, members });
const noUsers = { native: [], workos: [], idp: [] };

describe("WorkOS tombstones in the groups reconciliation", () => {
  it("does not count a member WorkOS keeps in a group after native deleted the user", () => {
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["carol@acme.test"])],
        workos: [group("Engineering", ["carol@acme.test", "ada.lovelace@acme.test"])],
        idp: [group("Engineering", ["carol@acme.test"])],
      },
      {
        native: [user("carol@acme.test", 1)],
        workos: [user("carol@acme.test", 1), user("ada.lovelace@acme.test", 0)],
        idp: [user("carol@acme.test", 1)],
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Engineering", diverged: false, tombstones: 1 });
    // The counts stay true to what each directory reports — WorkOS really does
    // hold two members. Only the judgement changes.
    expect(rows[0]).toMatchObject({ native: 1, workos: 2 });
  });

  it("still counts a member WorkOS holds as active that native's group does not have", () => {
    const rows = reconcileGroups(
      {
        native: [group("Engineering", [])],
        workos: [group("Engineering", ["bob.baker@acme.test"])],
        idp: [group("Engineering", ["bob.baker@acme.test"])],
      },
      {
        native: [],
        workos: [user("bob.baker@acme.test", 1)],
        idp: [user("bob.baker@acme.test", 1)],
      },
    );

    expect(rows[0]).toMatchObject({ diverged: true, tombstones: 0 });
    expect(rows[0]?.members).toContainEqual({
      name: "bob.baker@acme.test",
      native: false,
      workos: true,
      idp: true,
      diverged: true,
      tombstone: false,
    });
  });

  it("counts a member WorkOS holds as active even when native still holds the user", () => {
    // The membership edge is the thing that failed to land, not the user. Nothing
    // about the user's own state should excuse it.
    const rows = reconcileGroups(
      {
        native: [group("Engineering", [])],
        workos: [group("Engineering", ["carol@acme.test"])],
        idp: [group("Engineering", ["carol@acme.test"])],
      },
      {
        native: [user("carol@acme.test", 1)],
        workos: [user("carol@acme.test", 1)],
        idp: [user("carol@acme.test", 1)],
      },
    );

    expect(rows[0]).toMatchObject({ diverged: true, tombstones: 0 });
  });

  it("names the member that differs and which side holds it", () => {
    // The point of comparing by identity rather than by count: the row can say
    // who, not just that a number is off by one.
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["carol@acme.test", "erin@acme.test"])],
        workos: [group("Engineering", ["carol@acme.test", "bob.baker@acme.test"])],
        idp: [group("Engineering", ["carol@acme.test"])],
      },
      {
        native: [user("carol@acme.test", 1), user("erin@acme.test", 1)],
        workos: [user("carol@acme.test", 1), user("bob.baker@acme.test", 1)],
        idp: [user("carol@acme.test", 1)],
      },
    );

    // Equal counts on both sides — a count comparison would have called this
    // converged and said nothing at all.
    expect(rows[0]).toMatchObject({ native: 2, workos: 2, diverged: true });
    expect(rows[0]?.members.filter((m) => m.diverged).map((m) => [m.name, m.workos])).toEqual([
      ["bob.baker@acme.test", true],
      ["erin@acme.test", false],
    ]);
  });

  it("does not extend the exclusion to a member native still has in the group", () => {
    // Native holds the edge too, so there is no delete to survive and no
    // difference to excuse — and nothing to exclude.
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["ada.lovelace@acme.test"])],
        workos: [group("Engineering", ["ada.lovelace@acme.test"])],
        idp: [],
      },
      {
        native: [user("ada.lovelace@acme.test", 1)],
        workos: [user("ada.lovelace@acme.test", 0)],
        idp: [],
      },
    );

    expect(rows[0]).toMatchObject({ diverged: false, tombstones: 0 });
  });

  it("does not label an edge both sides hold as deleted, whatever the user's state", () => {
    // The edge, not just the user, has to be gone from native. Native's group
    // here still holds a member whose user row native has lost — an orphaned
    // edge, not a delete that landed — so nothing about it is a tombstone and
    // labelling it `deleted` would be a story about the wrong thing.
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["ada.lovelace@acme.test"])],
        workos: [group("Engineering", ["ada.lovelace@acme.test"])],
        idp: [],
      },
      { ...noUsers, workos: [user("ada.lovelace@acme.test", 0)] },
    );

    expect(rows[0]).toMatchObject({ diverged: false, tombstones: 0 });
    expect(rows[0]?.members).toEqual([
      {
        name: "ada.lovelace@acme.test",
        native: true,
        workos: true,
        idp: false,
        diverged: false,
        tombstone: false,
      },
    ]);
  });

  it("does not excuse the mirror image, a membership only the native app has", () => {
    const rows = reconcileGroups(
      {
        native: [group("Engineering", ["erin@acme.test"])],
        workos: [group("Engineering", [])],
        idp: [],
      },
      {
        native: [user("erin@acme.test", 1)],
        workos: [],
        idp: [],
      },
    );

    expect(rows[0]).toMatchObject({ diverged: true, tombstones: 0 });
  });

  it("keeps diverging on a group WorkOS has that native does not", () => {
    // A SCIM Group carries no `active`, so there is genuinely no signal that
    // separates a retained group from an undelivered one. Group *presence* keeps
    // counting every difference; only the edges inside a group are excluded.
    const rows = reconcileGroups(
      {
        native: [],
        workos: [group("Engineering", ["ada.lovelace@acme.test"])],
        idp: [],
      },
      {
        native: [],
        workos: [user("ada.lovelace@acme.test", 0)],
        idp: [],
      },
    );

    expect(rows[0]).toMatchObject({ native: null, workos: 1, diverged: true, tombstones: 1 });
  });

  it("keeps the tombstone member listed so the row stays inspectable", () => {
    const rows = reconcileGroups(
      {
        native: [group("Engineering", [])],
        workos: [group("Engineering", ["ada.lovelace@acme.test"])],
        idp: [],
      },
      { ...noUsers, workos: [user("ada.lovelace@acme.test", 0)] },
    );

    expect(rows[0]?.members).toEqual([
      {
        name: "ada.lovelace@acme.test",
        native: false,
        workos: true,
        idp: false,
        diverged: false,
        tombstone: true,
      },
    ]);
  });

  it("leaves the measured directory's four over-counted groups fully converged", () => {
    // Measured on a real WorkOS directory: four groups where WorkOS reported one
    // member more than native, and every one of the four extras was a deactivated
    // SCIM record with no native row. WorkOS matched the IdP in each case; native
    // was the only side that had forgotten anyone.
    const extras = [
      { group: "Engineering", member: "sybil.silva164@acme.test", nativeMembers: ["kept-eng"] },
      { group: "Finance", member: "mallory.meyer412@acme.test", nativeMembers: [] },
      { group: "Sales", member: "dave.patel519@acme.test", nativeMembers: [] },
      { group: "Support", member: "dave.diaz@acme.test", nativeMembers: ["kept-sup"] },
    ];
    const living = [...new Set(extras.flatMap((e) => e.nativeMembers))];

    const rows = reconcileGroups(
      {
        native: extras.map((e) => group(e.group, e.nativeMembers)),
        workos: extras.map((e) => group(e.group, [...e.nativeMembers, e.member])),
        idp: extras.map((e) => group(e.group, [...e.nativeMembers, e.member])),
      },
      {
        native: living.map((name) => user(name, 1)),
        workos: [...living.map((name) => user(name, 1)), ...extras.map((e) => user(e.member, 0))],
        idp: [...living.map((name) => user(name, 1)), ...extras.map((e) => user(e.member, 1))],
      },
    );

    expect(rows.map((r) => [r.name, r.native, r.workos, r.idp])).toEqual([
      ["Engineering", 1, 2, 2],
      ["Finance", 0, 1, 1],
      ["Sales", 0, 1, 1],
      ["Support", 1, 2, 2],
    ]);
    expect(rows.filter((r) => r.diverged)).toEqual([]);
    expect(rows.reduce((total, r) => total + r.tombstones, 0)).toBe(4);
  });

  it("does not let the four tombstones mask a real strand in the same table", () => {
    // The same directory with one genuine miss added: a live WorkOS member native
    // never received. The exclusion must not swallow it.
    const rows = reconcileGroups(
      {
        native: [group("Engineering", []), group("Finance", [])],
        workos: [
          group("Engineering", ["sybil.silva164@acme.test"]),
          group("Finance", ["mallory.meyer412@acme.test", "bob.baker@acme.test"]),
        ],
        idp: [],
      },
      {
        native: [],
        workos: [
          user("sybil.silva164@acme.test", 0),
          user("mallory.meyer412@acme.test", 0),
          user("bob.baker@acme.test", 1),
        ],
        idp: [user("bob.baker@acme.test", 1)],
      },
    );

    expect(rows.filter((r) => r.diverged).map((r) => r.name)).toEqual(["Finance"]);
    expect(
      rows
        .flatMap((r) => r.members)
        .filter((m) => m.diverged)
        .map((m) => m.name),
    ).toEqual(["bob.baker@acme.test"]);
  });
});

/**
 * The step that makes the group comparison possible at all: `GET /Groups` gives
 * member *ids*, and only a userName can be matched against the users listing to
 * ask whether that member is a record WorkOS retained. Discarding the ids — which
 * the panel used to do, keeping only `members.length` — is what made a group-side
 * exclusion look impossible.
 */
describe("resolving WorkOS group members to userNames", () => {
  it("resolves a member id against the /Users listing fetched in the same call", () => {
    const rows = workosGroupRows(
      [{ displayName: "Engineering", members: [{ value: "usr_1" }, { value: "usr_2" }] }],
      [
        { id: "usr_1", userName: "carol@acme.test" },
        { id: "usr_2", userName: "ada.lovelace@acme.test" },
      ],
    );

    expect(rows).toEqual([
      { name: "Engineering", members: ["carol@acme.test", "ada.lovelace@acme.test"] },
    ]);
  });

  it("falls back to display, then to the raw id, rather than dropping the member", () => {
    // A member outside this page of /Users still has to reach the comparison: a
    // silently dropped edge would under-count WorkOS and hide a real difference.
    const rows = workosGroupRows(
      [
        {
          displayName: "Engineering",
          members: [{ value: "usr_9", display: "erin@acme.test" }, { value: "usr_unknown" }],
        },
      ],
      [],
    );

    expect(rows[0]?.members).toEqual(["erin@acme.test", "usr_unknown"]);
  });

  it("reads a group with no members as an empty roster, not a missing group", () => {
    expect(workosGroupRows([{ displayName: "Finance" }], [])).toEqual([
      { name: "Finance", members: [] },
    ]);
  });
});
