import type { Datastore } from "../shared/datastore";
import type { IdpActivity, IdpAutoState, IdpGroup, IdpUser, Origin } from "./types";
import { withD1Retry } from "../shared/db";
import { newIdpGroupId, newIdpUserId } from "../shared/ids";

export async function listUsers(db: Datastore, directoryId: string): Promise<IdpUser[]> {
  const { results } = await withD1Retry(() =>
    db
      .prepare("SELECT * FROM idp_users WHERE directory_id = ? ORDER BY created_at, user_name")
      .bind(directoryId)
      .all<IdpUser>(),
  );
  return results;
}

export async function listGroups(db: Datastore, directoryId: string): Promise<IdpGroup[]> {
  const { results } = await withD1Retry(() =>
    db
      .prepare("SELECT * FROM idp_groups WHERE directory_id = ? ORDER BY created_at, display_name")
      .bind(directoryId)
      .all<IdpGroup>(),
  );
  return results;
}

export async function listMembers(
  db: Datastore,
  directoryId: string,
): Promise<{ group_id: string; user_id: string }[]> {
  const { results } = await withD1Retry(() =>
    db
      .prepare(
        "SELECT m.group_id, m.user_id FROM idp_group_members m " +
          "JOIN idp_groups g ON g.id = m.group_id WHERE g.directory_id = ?",
      )
      .bind(directoryId)
      .all<{ group_id: string; user_id: string }>(),
  );
  return results;
}

export async function getUser(db: Datastore, id: string): Promise<IdpUser | null> {
  return withD1Retry(() =>
    db.prepare("SELECT * FROM idp_users WHERE id = ?").bind(id).first<IdpUser>(),
  );
}

export async function getGroup(db: Datastore, id: string): Promise<IdpGroup | null> {
  return withD1Retry(() =>
    db.prepare("SELECT * FROM idp_groups WHERE id = ?").bind(id).first<IdpGroup>(),
  );
}

export async function userByUserName(
  db: Datastore,
  directoryId: string,
  userName: string,
): Promise<IdpUser | null> {
  return withD1Retry(() =>
    db
      .prepare("SELECT * FROM idp_users WHERE directory_id = ? AND user_name = ?")
      .bind(directoryId, userName)
      .first<IdpUser>(),
  );
}

export async function groupByDisplayName(
  db: Datastore,
  directoryId: string,
  displayName: string,
): Promise<IdpGroup | null> {
  return withD1Retry(() =>
    db
      .prepare("SELECT * FROM idp_groups WHERE directory_id = ? AND display_name = ?")
      .bind(directoryId, displayName)
      .first<IdpGroup>(),
  );
}

export async function insertUser(
  db: Datastore,
  user: Pick<
    IdpUser,
    "directory_id" | "user_name" | "external_id" | "given_name" | "family_name" | "active"
  >,
): Promise<IdpUser> {
  return withD1Retry(
    () =>
      db
        .prepare(
          "INSERT INTO idp_users (id, directory_id, user_name, external_id, given_name, family_name, active) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
        )
        .bind(
          newIdpUserId(),
          user.directory_id,
          user.user_name,
          user.external_id,
          user.given_name,
          user.family_name,
          user.active,
        )
        .first<IdpUser>() as Promise<IdpUser>,
  );
}

export async function insertGroup(
  db: Datastore,
  group: Pick<IdpGroup, "directory_id" | "display_name" | "external_id">,
): Promise<IdpGroup> {
  return withD1Retry(
    () =>
      db
        .prepare(
          "INSERT INTO idp_groups (id, directory_id, display_name, external_id) VALUES (?, ?, ?, ?) RETURNING *",
        )
        .bind(newIdpGroupId(), group.directory_id, group.display_name, group.external_id)
        .first<IdpGroup>() as Promise<IdpGroup>,
  );
}

export async function setUserScimId(
  db: Datastore,
  id: string,
  scimId: string | null,
  status: number,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE idp_users SET scim_id = COALESCE(?, scim_id), last_status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(scimId, status, id)
      .run(),
  );
}

export async function setGroupScimId(
  db: Datastore,
  id: string,
  scimId: string | null,
  status: number,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE idp_groups SET scim_id = COALESCE(?, scim_id), last_status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(scimId, status, id)
      .run(),
  );
}

export async function setUserActive(
  db: Datastore,
  id: string,
  active: number,
  status: number,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE idp_users SET active = ?, last_status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(active, status, id)
      .run(),
  );
}

export async function setUserName(
  db: Datastore,
  id: string,
  givenName: string,
  familyName: string,
  status: number,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE idp_users SET given_name = ?, family_name = ?, last_status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(givenName, familyName, status, id)
      .run(),
  );
}

export async function renameGroup(
  db: Datastore,
  id: string,
  displayName: string,
  status: number,
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "UPDATE idp_groups SET display_name = ?, last_status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(displayName, status, id)
      .run(),
  );
}

export async function deleteUser(db: Datastore, id: string): Promise<void> {
  await withD1Retry(() =>
    db.batch([
      db.prepare("DELETE FROM idp_group_members WHERE user_id = ?").bind(id),
      db.prepare("DELETE FROM idp_users WHERE id = ?").bind(id),
    ]),
  );
}

export async function deleteGroup(db: Datastore, id: string): Promise<void> {
  await withD1Retry(() =>
    db.batch([
      db.prepare("DELETE FROM idp_group_members WHERE group_id = ?").bind(id),
      db.prepare("DELETE FROM idp_groups WHERE id = ?").bind(id),
    ]),
  );
}

export async function addMember(db: Datastore, groupId: string, userId: string): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare("INSERT OR IGNORE INTO idp_group_members (group_id, user_id) VALUES (?, ?)")
      .bind(groupId, userId)
      .run(),
  );
}

export async function removeMember(db: Datastore, groupId: string, userId: string): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare("DELETE FROM idp_group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupId, userId)
      .run(),
  );
}

export async function memberIds(db: Datastore, groupId: string): Promise<string[]> {
  const { results } = await withD1Retry(() =>
    db
      .prepare("SELECT user_id FROM idp_group_members WHERE group_id = ?")
      .bind(groupId)
      .all<{ user_id: string }>(),
  );
  return results.map((r) => r.user_id);
}

export async function logActivity(
  db: Datastore,
  entry: {
    directory_id: string;
    origin: Origin;
    action: string;
    subject?: string | null;
    method?: string | null;
    path?: string | null;
    status?: number | null;
    ok: boolean;
    detail?: string | null;
  },
): Promise<void> {
  await withD1Retry(() =>
    db
      .prepare(
        "INSERT INTO idp_activity (directory_id, origin, action, subject, method, path, status, ok, detail) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        entry.directory_id,
        entry.origin,
        entry.action,
        entry.subject ?? null,
        entry.method ?? null,
        entry.path ?? null,
        entry.status ?? null,
        entry.ok ? 1 : 0,
        entry.detail ?? null,
      )
      .run(),
  );
}

export async function getAutoState(
  db: Datastore,
  directoryId: string,
): Promise<IdpAutoState | null> {
  return withD1Retry(() =>
    db
      .prepare("SELECT * FROM idp_auto_state WHERE directory_id = ?")
      .bind(directoryId)
      .first<IdpAutoState>(),
  );
}

export async function setAutoState(
  db: Datastore,
  directoryId: string,
  patch: { running?: boolean; interval_ms?: number; tickDelta?: number },
): Promise<void> {
  const current = await getAutoState(db, directoryId);
  const running = patch.running ?? (current ? current.running === 1 : false);
  const interval = patch.interval_ms ?? current?.interval_ms ?? 4000;
  const ticks = (current?.tick_count ?? 0) + (patch.tickDelta ?? 0);
  await withD1Retry(() =>
    db
      .prepare(
        "INSERT INTO idp_auto_state (directory_id, running, interval_ms, tick_count, updated_at) " +
          "VALUES (?, ?, ?, ?, datetime('now')) " +
          "ON CONFLICT (directory_id) DO UPDATE SET running = excluded.running, " +
          "interval_ms = excluded.interval_ms, tick_count = excluded.tick_count, updated_at = excluded.updated_at",
      )
      .bind(directoryId, running ? 1 : 0, interval, ticks)
      .run(),
  );
}

export async function activity(
  db: Datastore,
  directoryId: string,
  limit = 50,
): Promise<IdpActivity[]> {
  const { results } = await withD1Retry(() =>
    db
      .prepare("SELECT * FROM idp_activity WHERE directory_id = ? ORDER BY id DESC LIMIT ?")
      .bind(directoryId, limit)
      .all<IdpActivity>(),
  );
  return results;
}
