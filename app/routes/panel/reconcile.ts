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
  /** A user WorkOS retains as an inactive SCIM record after a delete the native
   *  app applied as a data-plane hard delete. The DSync listener's
   *  deactivate-in-place path never produces this shape — it leaves Inactive on
   *  both sides, which agree on their own. See `isTombstone`. */
  tombstone: boolean;
}

/** One membership edge — one user in one group — across the three directories. */
export interface GroupMemberReconRow {
  name: string;
  native: boolean;
  workos: boolean;
  idp: boolean;
  diverged: boolean;
  /** A membership edge WorkOS retains for a user it retains as an inactive SCIM
   *  record after a native hard delete dropped the row *and* the edge — the
   *  data-plane path; the DSync listener keeps both. See `isTombstone`. */
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
 */
function isTombstone(native: Presence, workos: Presence): boolean {
  return workos === "inactive" && native === "absent";
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
    const tombstone = isTombstone(native, workos);
    return {
      name,
      native,
      workos,
      idp: presence(i.get(name)),
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
 * edges (the DSync listener's deactivate-in-place keeps both, so that path
 * agrees edge-for-edge and needs no exclusion). WorkOS
 * retains the SCIM resource as `active: false` and keeps it in its groups, so
 * `GET /Groups` reports an inflated member count forever: measured on a real
 * directory, four groups over-counted by exactly one member each, and every one
 * of the four extras was an inactive WorkOS record with no native row.
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
  const names = [...new Set([...n.keys(), ...w.keys(), ...i.keys()])].sort();
  return names.map((name) => {
    const native = n.get(name);
    const workos = w.get(name);
    const idp = i.get(name);
    const members = reconcileMembers({ native, workos, idp }, nativeUsers, workosUsers);
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
): GroupMemberReconRow[] {
  const n = new Set(edges.native ?? []);
  const w = new Set(edges.workos ?? []);
  const i = new Set(edges.idp ?? []);
  const names = [...new Set([...n, ...w, ...i])].sort();
  return names.map((name) => {
    const native = n.has(name);
    const workos = w.has(name);
    const tombstone =
      workos &&
      !native &&
      isTombstone(presence(nativeUsers.get(name)), presence(workosUsers.get(name)));
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
