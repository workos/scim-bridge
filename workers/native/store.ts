import { withD1Retry } from "../shared/db";
import type { Datastore } from "../shared/datastore";

export interface ScimTables {
  users: string;
  groups: string;
  members: string;
}

export const NATIVE_TABLES: ScimTables = {
  users: "native_users",
  groups: "native_groups",
  members: "native_group_members",
};

export const MOCK_WORKOS_TABLES: ScimTables = {
  users: "mock_workos_users",
  groups: "mock_workos_groups",
  members: "mock_workos_group_members",
};

export type ScimResource = Record<string, unknown>;

export interface UserRow {
  id: string;
  user_name: string;
  external_id: string | null;
  active: number;
  resource: string;
  created_at: string;
  updated_at: string;
}

export interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  resource: string;
  created_at: string;
  updated_at: string;
}

export interface MemberRef {
  value: string;
  display?: string;
}

export interface ListFilter {
  column: "user_name" | "external_id" | "display_name";
  value: string;
  caseInsensitive: boolean;
}

export class ScimStore {
  constructor(
    readonly db: Datastore,
    readonly tables: ScimTables,
  ) {}

  async userById(id: string): Promise<UserRow | null> {
    return withD1Retry(() =>
      this.db.prepare(`SELECT * FROM ${this.tables.users} WHERE id = ?`).bind(id).first<UserRow>(),
    );
  }

  async userByUserName(userName: string): Promise<UserRow | null> {
    return withD1Retry(() =>
      this.db
        .prepare(`SELECT * FROM ${this.tables.users} WHERE lower(user_name) = lower(?)`)
        .bind(userName)
        .first<UserRow>(),
    );
  }

  async userByExternalId(externalId: string): Promise<UserRow | null> {
    return withD1Retry(() =>
      this.db
        .prepare(`SELECT * FROM ${this.tables.users} WHERE external_id = ?`)
        .bind(externalId)
        .first<UserRow>(),
    );
  }

  async listUsers(
    filter: ListFilter | null,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: UserRow[] }> {
    return this.list<UserRow>(this.tables.users, filter, offset, limit);
  }

  async upsertUser(user: {
    id: string;
    userName: string;
    externalId: string | null;
    active: boolean;
    resource: ScimResource;
  }): Promise<void> {
    await withD1Retry(() =>
      this.db
        .prepare(
          `INSERT INTO ${this.tables.users} (id, user_name, external_id, active, resource) ` +
            "VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT (id) DO UPDATE SET user_name = excluded.user_name, " +
            "external_id = excluded.external_id, active = excluded.active, " +
            "resource = excluded.resource, updated_at = datetime('now')",
        )
        .bind(
          user.id,
          user.userName,
          user.externalId,
          user.active ? 1 : 0,
          JSON.stringify(user.resource),
        )
        .run(),
    );
  }

  async deleteUser(id: string): Promise<boolean> {
    await withD1Retry(() =>
      this.db.prepare(`DELETE FROM ${this.tables.members} WHERE user_id = ?`).bind(id).run(),
    );
    const result = await withD1Retry(() =>
      this.db.prepare(`DELETE FROM ${this.tables.users} WHERE id = ?`).bind(id).run(),
    );
    return result.meta.changes > 0;
  }

  async groupById(id: string): Promise<GroupRow | null> {
    return withD1Retry(() =>
      this.db
        .prepare(`SELECT * FROM ${this.tables.groups} WHERE id = ?`)
        .bind(id)
        .first<GroupRow>(),
    );
  }

  async groupByDisplayName(displayName: string): Promise<GroupRow | null> {
    return withD1Retry(() =>
      this.db
        .prepare(`SELECT * FROM ${this.tables.groups} WHERE lower(display_name) = lower(?)`)
        .bind(displayName)
        .first<GroupRow>(),
    );
  }

  async groupByExternalId(externalId: string): Promise<GroupRow | null> {
    return withD1Retry(() =>
      this.db
        .prepare(`SELECT * FROM ${this.tables.groups} WHERE external_id = ?`)
        .bind(externalId)
        .first<GroupRow>(),
    );
  }

  async listGroups(
    filter: ListFilter | null,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: GroupRow[] }> {
    return this.list<GroupRow>(this.tables.groups, filter, offset, limit);
  }

  async upsertGroup(group: {
    id: string;
    displayName: string;
    externalId: string | null;
    resource: ScimResource;
  }): Promise<void> {
    await withD1Retry(() =>
      this.db
        .prepare(
          `INSERT INTO ${this.tables.groups} (id, display_name, external_id, resource) ` +
            "VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, " +
            "external_id = excluded.external_id, resource = excluded.resource, " +
            "updated_at = datetime('now')",
        )
        .bind(group.id, group.displayName, group.externalId, JSON.stringify(group.resource))
        .run(),
    );
  }

  async deleteGroup(id: string): Promise<boolean> {
    await withD1Retry(() =>
      this.db.prepare(`DELETE FROM ${this.tables.members} WHERE group_id = ?`).bind(id).run(),
    );
    const result = await withD1Retry(() =>
      this.db.prepare(`DELETE FROM ${this.tables.groups} WHERE id = ?`).bind(id).run(),
    );
    return result.meta.changes > 0;
  }

  async membersOf(groupId: string): Promise<MemberRef[]> {
    const { results } = await withD1Retry(() =>
      this.db
        .prepare(
          `SELECT m.user_id AS value, u.user_name AS display FROM ${this.tables.members} m ` +
            `LEFT JOIN ${this.tables.users} u ON u.id = m.user_id ` +
            "WHERE m.group_id = ? ORDER BY m.user_id",
        )
        .bind(groupId)
        .all<{ value: string; display: string | null }>(),
    );
    return results.map((row) =>
      row.display == null ? { value: row.value } : { value: row.value, display: row.display },
    );
  }

  async addMember(groupId: string, userId: string): Promise<boolean> {
    const result = await withD1Retry(() =>
      this.db
        .prepare(`INSERT OR IGNORE INTO ${this.tables.members} (group_id, user_id) VALUES (?, ?)`)
        .bind(groupId, userId)
        .run(),
    );
    return result.meta.changes > 0;
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const result = await withD1Retry(() =>
      this.db
        .prepare(`DELETE FROM ${this.tables.members} WHERE group_id = ? AND user_id = ?`)
        .bind(groupId, userId)
        .run(),
    );
    return result.meta.changes > 0;
  }

  async setMembers(groupId: string, userIds: string[]): Promise<void> {
    await withD1Retry(() =>
      this.db.prepare(`DELETE FROM ${this.tables.members} WHERE group_id = ?`).bind(groupId).run(),
    );
    for (const userId of new Set(userIds)) {
      await this.addMember(groupId, userId);
    }
  }

  private async list<T>(
    table: string,
    filter: ListFilter | null,
    offset: number,
    limit: number,
  ): Promise<{ total: number; rows: T[] }> {
    const where = filter
      ? filter.caseInsensitive
        ? `WHERE lower(${filter.column}) = lower(?)`
        : `WHERE ${filter.column} = ?`
      : "";
    const binds = filter ? [filter.value] : [];
    const totalRow = await withD1Retry(() =>
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
        .bind(...binds)
        .first<{ n: number }>(),
    );
    const { results } = await withD1Retry(() =>
      this.db
        .prepare(`SELECT * FROM ${table} ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`)
        .bind(...binds, limit, offset)
        .all<T>(),
    );
    return { total: totalRow?.n ?? 0, rows: results };
  }
}
