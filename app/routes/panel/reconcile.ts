/**
 * What the Live state panel means by "the three directories agree".
 *
 * Pure comparison, no React: the route (`live.tsx`) fetches the three listings
 * and renders what comes back from here. It sits outside the route so a test can
 * import it — `scripts/check-type-gate.mjs` stops `tests/` from importing panel
 * *routes*, and this file is in the gate's project (`tsconfig.check.json`) and
 * imports nothing.
 */

/** One user row from any of the three directories, as the panel reads it. */
export interface DirRow {
  name: string;
  active: number;
}

/**
 * One group row, with the member identities the comparison needs.
 *
 * `members` are userNames, the same key the users comparison is on: the WorkOS
 * side resolves each SCIM member's `value` against the `/Users` listing fetched
 * in the same call before it reaches here (see `fetchWorkosDirectory`).
 */
export interface GroupRow {
  name: string;
  members: string[];
}

/** The bits of a `GET /Users` resource the panel reads. */
export interface ScimUserResource {
  id?: string;
  userName?: string;
}

/** The bits of a `GET /Groups` resource the panel reads. */
export interface ScimGroupResource {
  displayName?: string;
  members?: { value?: string; display?: string }[];
}

/**
 * Turn WorkOS's `GET /Groups` into rows the comparison can use, by resolving each
 * member against the `GET /Users` listing fetched in the same call.
 *
 * This resolution is the whole reason group membership can be reconciled at all:
 * a member arrives as a SCIM id, and only a userName can be matched against the
 * users comparison to ask whether that member is one of WorkOS's retained
 * inactive records. `display` covers a member outside this page of `/Users`; the
 * raw id is the last resort, and surfaces as a difference rather than quietly
 * dropping out of the count.
 */
export function workosGroupRows(
  groups: ScimGroupResource[],
  users: ScimUserResource[],
): GroupRow[] {
  const userNameById = new Map<string, string>();
  for (const user of users) {
    if (user.id && user.userName) userNameById.set(user.id, user.userName);
  }
  return groups.map((g) => ({
    name: g.displayName ?? "",
    members: (g.members ?? [])
      .map((m) => (m.value ? (userNameById.get(m.value) ?? m.display ?? m.value) : m.display))
      .filter((name): name is string => Boolean(name)),
  }));
}

export type Presence = "active" | "inactive" | "absent";

export interface UserReconRow {
  name: string;
  native: Presence;
  workos: Presence;
  idp: Presence;
  diverged: boolean;
  /** An inactive record one side retains that the others no longer have, in
   *  either orientation: WorkOS keeps an inactive SCIM record after a native
   *  data-plane hard delete (`isTombstone`), or the native app keeps an Inactive
   *  row via the listener's deactivate-in-place after the user is gone from
   *  WorkOS and the IdP (`isNativeTombstone`). The panel dims both the same way. */
  tombstone: boolean;
}

/** One membership edge — one user in one group — across the three directories. */
export interface GroupMemberReconRow {
  name: string;
  native: boolean;
  workos: boolean;
  idp: boolean;
  diverged: boolean;
  /** A membership edge one side retains for a user that is a tombstone, in either
   *  orientation: WorkOS keeps the edge for an inactive SCIM record a native hard
   *  delete dropped (`isTombstone`), or native keeps the edge for a
   *  deactivate-in-place tombstone WorkOS and the IdP no longer carry
   *  (`isNativeTombstone`). */
  tombstone: boolean;
}

export interface GroupReconRow {
  name: string;
  /** Member counts exactly as each directory reports them, tombstones included —
   *  the numbers stay true and `diverged` carries the judgement, the same way the
   *  users table still shows a tombstone as `Inactive`. */
  native: number | null;
  workos: number | null;
  idp: number | null;
  diverged: boolean;
  /** Every member of the group in any of the three directories, so the panel can
   *  say *which* member differs rather than only that a number does. */
  members: GroupMemberReconRow[];
  tombstones: number;
}

function presence(row: DirRow | undefined): Presence {
  if (!row) return "absent";
  return row.active === 1 ? "active" : "inactive";
}

/**
 * The two sides disagree about what a DELETE leaves behind, and neither is wrong.
 *
 * Post-decoupling, WorkOS keeps SCIM resources and directory users in separate
 * tables (see "The migrated-id contract" in docs/architecture.md). Deleting a
 * user removes the directory user and *retains* the SCIM resource, flipped to
 * `active: false`. The native app has one table, and its row is gone when the
 * delete arrived through the SCIM data plane — the proxy's direct write path
 * hard-deletes. (The post-cutover DSync listener instead deactivates in place,
 * leaving Inactive on both sides; that shape agrees without this exclusion.)
 * `fetchWorkosDirectory` reads `GET /Users` — the SCIM table, and the only thing
 * a directory's SCIM token can reach — so every user ever deleted stays in the
 * WorkOS column forever.
 *
 * Counted as divergence, that number only ever grows and stops meaning anything:
 * a real directory read 8 users "missing from native" of which 7 were nothing
 * but this. It is worst right after a backfill, which converges the living users
 * and leaves the tombstones standing as the whole of the remaining count.
 *
 * So an inactive-in-WorkOS record the native app does not have is a tombstone,
 * not drift. An *active* one still is drift — a live resource the native app
 * should be holding and isn't — and keeps counting: that is the shape of a real
 * strand, and excluding it would hide the bug this exclusion exists to expose.
 *
 * Do not "fix" this by reading the true directory-user count instead:
 * `/directory_users` needs an environment API key, WorkOS API keys are not
 * scopeable, and the panel will not ask an operator for full environment access
 * to render a headline number. Everything here comes from the SCIM listing.
 *
 * The same delete leaves the same user standing in their WorkOS groups, so
 * `reconcileGroups` applies this predicate per membership edge as well — same
 * user, same signal, same rule.
 *
 * This is one of two orientations. The mirror — the native app holding an
 * Inactive tombstone WorkOS and the IdP no longer have — is `isNativeTombstone`.
 */
function isTombstone(native: Presence, workos: Presence): boolean {
  return workos === "inactive" && native === "absent";
}

/**
 * The mirror orientation: the native app is the side left holding a tombstone.
 *
 * With the environment's suspension soft-delete off, a plain deactivation
 * arrives as `dsync.user.deleted`, and the reference listener's
 * deactivate-in-place path keeps an Inactive native row after the user is gone
 * from WorkOS and the IdP. That row — native inactive, workos absent, idp absent
 * — is a tombstone, not drift; purging it is a retention decision, the same as
 * on the WorkOS side.
 *
 * Every clause is load-bearing, and dropping any one would swallow a real anomaly:
 *  - native must be *inactive*. An **active** native row with no workos/idp
 *    record is a genuine strand — a write that never propagated — and the
 *    `active`-still-diverges guarantee the WorkOS orientation also keeps must hold
 *    here unchanged.
 *  - idp must be *absent*. Inactive-in-native and absent-from-workos but still
 *    present in the IdP is a real anomaly (the IdP still knows this user), not a
 *    clean tombstone, so it keeps diverging.
 */
function isNativeTombstone(native: Presence, workos: Presence, idp: Presence): boolean {
  return native === "inactive" && workos === "absent" && idp === "absent";
}

export function reconcileUsers(users: {
  native: DirRow[];
  workos: DirRow[];
  idp: DirRow[];
}): UserReconRow[] {
  const byName = (rows: DirRow[]) => new Map(rows.map((r) => [r.name, r]));
  const n = byName(users.native);
  const w = byName(users.workos);
  const i = byName(users.idp);
  const names = [...new Set([...n.keys(), ...w.keys(), ...i.keys()])].sort();
  return names.map((name) => {
    const native = presence(n.get(name));
    const workos = presence(w.get(name));
    const idp = presence(i.get(name));
    const tombstone = isTombstone(native, workos) || isNativeTombstone(native, workos, idp);
    return {
      name,
      native,
      workos,
      idp,
      diverged: native !== workos && !tombstone,
      tombstone,
    };
  });
}

/**
 * A deleted user stays in their WorkOS groups too, so membership needs the same
 * exclusion — and gets it from the same signal, not from a guess.
 *
 * A native data-plane delete drops the user's row *and* their group-membership
 * edges, while WorkOS retains the SCIM resource as `active: false` and keeps it
 * in its groups, so `GET /Groups` reports an inflated member count forever:
 * measured on a real directory, four groups over-counted by exactly one member
 * each, and every one of the four extras was an inactive WorkOS record with no
 * native row.
 *
 * The listener's deactivate-in-place path produces the mirror of this at the
 * edge level: after a delete WorkOS and the IdP both drop the edge, native keeps
 * carrying the deactivated user in its group. That native-side tombstone edge is
 * excluded too, by the same rule read in the opposite orientation
 * (`isNativeTombstone` — see `reconcileMembers`).
 *
 * An earlier version of this comment argued groups could not be fixed, because a
 * SCIM Group has no `active` attribute (RFC 7643 §4.2 is `displayName` +
 * `members`). The premise is true and the conclusion was wrong: the *edge* does
 * not need an `active` of its own. It needs the member's identity, which
 * `GET /Groups` supplies as `members[].value` and which `fetchWorkosDirectory`
 * resolves against the `/Users` listing it already fetches in the same call. With
 * a userName on each edge the rule is `isTombstone` verbatim — the user is
 * inactive in WorkOS and absent from native — not a heuristic.
 *
 * The invariant the users fix protects holds here unchanged: an edge to a user
 * WorkOS holds as **active** that native does not have is still divergence, and
 * still counts. That is the real-bug channel — a live membership the native app
 * should be holding and isn't — and an exclusion that swallowed it would hide the
 * class of bug this exclusion exists to keep visible.
 *
 * What has no signal is a *group* WorkOS retains that native does not have: a
 * Group really does carry nothing to distinguish a retained group from an
 * undelivered one. So group presence keeps diverging on every difference; only
 * the edges inside a group are excluded.
 */
export function reconcileGroups(
  groups: {
    native: GroupRow[];
    workos: GroupRow[];
    idp: GroupRow[];
  },
  users: {
    native: DirRow[];
    workos: DirRow[];
    idp: DirRow[];
  },
): GroupReconRow[] {
  const byName = (rows: GroupRow[]) => new Map(rows.map((r) => [r.name, r.members]));
  const n = byName(groups.native);
  const w = byName(groups.workos);
  const i = byName(groups.idp);
  const nativeUsers = new Map(users.native.map((r) => [r.name, r]));
  const workosUsers = new Map(users.workos.map((r) => [r.name, r]));
  const idpUsers = new Map(users.idp.map((r) => [r.name, r]));
  const names = [...new Set([...n.keys(), ...w.keys(), ...i.keys()])].sort();
  return names.map((name) => {
    const native = n.get(name);
    const workos = w.get(name);
    const idp = i.get(name);
    const members = reconcileMembers({ native, workos, idp }, nativeUsers, workosUsers, idpUsers);
    return {
      name,
      native: native ? native.length : null,
      workos: workos ? workos.length : null,
      idp: idp ? idp.length : null,
      // Two ways a group can differ: one side does not have the group at all, or
      // the two sides disagree about who is in it.
      diverged:
        (native === undefined) !== (workos === undefined) || members.some((m) => m.diverged),
      members,
      tombstones: members.filter((m) => m.tombstone).length,
    };
  });
}

function reconcileMembers(
  edges: { native: string[] | undefined; workos: string[] | undefined; idp: string[] | undefined },
  nativeUsers: Map<string, DirRow>,
  workosUsers: Map<string, DirRow>,
  idpUsers: Map<string, DirRow>,
): GroupMemberReconRow[] {
  const n = new Set(edges.native ?? []);
  const w = new Set(edges.workos ?? []);
  const i = new Set(edges.idp ?? []);
  const names = [...new Set([...n, ...w, ...i])].sort();
  return names.map((name) => {
    const native = n.has(name);
    const workos = w.has(name);
    // Classify the member once against the three users listings, then read the
    // tombstone from whichever side is the one still holding the edge. WorkOS
    // orientation: workos keeps the edge for an inactive record native dropped.
    // Native orientation (the mirror): native keeps the edge for a deactivate-in-
    // place tombstone workos and the IdP no longer have.
    const nUser = presence(nativeUsers.get(name));
    const wUser = presence(workosUsers.get(name));
    const iUser = presence(idpUsers.get(name));
    const tombstone =
      (workos && !native && isTombstone(nUser, wUser)) ||
      (native && !workos && isNativeTombstone(nUser, wUser, iUser));
    return {
      name,
      native,
      workos,
      idp: i.has(name),
      diverged: native !== workos && !tombstone,
      tombstone,
    };
  });
}

/** Tombstones split by which side is left holding the inactive record, so the
 *  panel headline can describe each accurately instead of attributing both to
 *  WorkOS. The two orientations are mutually exclusive per row/edge. */
export interface TombstoneCounts {
  /** WorkOS keeps an inactive SCIM record the native app dropped (workos
   *  inactive, native absent) — the WorkOS-side tombstone. */
  workos: number;
  /** The native app keeps an Inactive row after WorkOS and the IdP dropped the
   *  user (native inactive, workos + idp absent) — the deactivate-in-place
   *  tombstone. */
  native: number;
}

export interface TombstoneSummary {
  users: TombstoneCounts;
  members: TombstoneCounts;
}

/**
 * Count tombstones by orientation across the reconciled rows. A tombstone row is
 * WorkOS-side exactly when native is absent (the record only WorkOS still has)
 * and native-side otherwise (native is the inactive holder); a tombstone edge is
 * WorkOS-side when WorkOS is the one carrying it and native-side when native is —
 * the same split the two exclusion branches already made, read back off the row.
 */
export function tombstoneSummary(
  userRows: UserReconRow[],
  groupRows: GroupReconRow[],
): TombstoneSummary {
  const users: TombstoneCounts = { workos: 0, native: 0 };
  for (const row of userRows) {
    if (!row.tombstone) continue;
    if (row.native === "absent") users.workos += 1;
    else users.native += 1;
  }
  const members: TombstoneCounts = { workos: 0, native: 0 };
  for (const group of groupRows) {
    for (const member of group.members) {
      if (!member.tombstone) continue;
      if (member.workos) members.workos += 1;
      else members.native += 1;
    }
  }
  return { users, members };
}
