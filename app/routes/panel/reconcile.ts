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

/** One group row, reduced to the only thing the panel compares. */
export interface GroupRow {
  name: string;
  member_count: number;
}

export type Presence = "active" | "inactive" | "absent";

export interface UserReconRow {
  name: string;
  native: Presence;
  workos: Presence;
  idp: Presence;
  diverged: boolean;
  /** A user WorkOS retains as an inactive SCIM record after a delete the native
   *  app applied in full. See `isTombstone`. */
  tombstone: boolean;
}

export interface GroupReconRow {
  name: string;
  native: number | null;
  workos: number | null;
  idp: number | null;
  diverged: boolean;
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
 * `active: false`. The native app has one table, so its row is simply gone.
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
 * Groups get no tombstone exclusion, deliberately.
 *
 * The users exclusion above is only safe because a SCIM User carries `active`,
 * which separates "WorkOS retained a deleted record" from "WorkOS holds a live
 * record native is missing". A SCIM Group has no such attribute (RFC 7643 §4.2
 * is `displayName` + `members`), so `GET /Groups` gives the panel nothing that
 * distinguishes a retained group from a genuinely undelivered one, and nothing
 * that distinguishes a retained member inside a live group either — this
 * function sees member *counts*, because the listing's member identities are
 * dropped in `fetchWorkosDirectory`.
 *
 * Any group-side exclusion would therefore be a guess ("no native row and zero
 * members, probably deleted"), and a wrong guess here hides real divergence,
 * which is the exact failure the users exclusion is written to avoid. So groups
 * keep counting every difference, and an operator reading a group diff has the
 * users table beside it to read it against.
 */
export function reconcileGroups(groups: {
  native: GroupRow[];
  workos: GroupRow[];
  idp: GroupRow[];
}): GroupReconRow[] {
  const byName = (rows: GroupRow[]) => new Map(rows.map((r) => [r.name, r.member_count]));
  const n = byName(groups.native);
  const w = byName(groups.workos);
  const i = byName(groups.idp);
  const names = [...new Set([...n.keys(), ...w.keys(), ...i.keys()])].sort();
  return names.map((name) => {
    const native = n.has(name) ? n.get(name)! : null;
    const workos = w.has(name) ? w.get(name)! : null;
    return {
      name,
      native,
      workos,
      idp: i.has(name) ? i.get(name)! : null,
      diverged: native !== workos,
    };
  });
}
