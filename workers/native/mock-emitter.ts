import { handleDsyncWebhook } from "./listener";
import type { ScimStore } from "./store";
import type { Datastore } from "../shared/datastore";

// When the mock WorkOS directory is written to, it emits the DSync webhook
// events a real migrated WorkOS directory would — delivered to this app's own
// listener. That closes the workos-only cutover loop locally: proxy → mock
// WorkOS → DSync event → listener → native app converges. A real WorkOS
// directory emits its own events, so this only runs for the mock.

type Kind = "Users" | "Groups";

export interface MockPath {
  kind: Kind | null;
  id: string | null;
}

export function parseMockScimPath(subpath: string): MockPath {
  const segments = subpath.split("/").filter(Boolean);
  const head = segments[0];
  if (head === "Users" || head === "Groups") {
    return { kind: head, id: segments[1] ? decodeURIComponent(segments[1]) : null };
  }
  return { kind: null, id: null };
}

export interface MockBefore {
  externalId?: string | null;
  name?: string | null;
  memberIds?: string[];
}

/** Snapshot the bits a mutation would erase: the resource identity before a
 *  delete, and a group's members before a membership change (for the diff). */
export async function captureMockBefore(
  store: ScimStore,
  method: string,
  path: MockPath,
): Promise<MockBefore> {
  const before: MockBefore = {};
  if (!path.kind || !path.id) return before;
  if (method === "DELETE") {
    if (path.kind === "Users") {
      const user = await store.userById(path.id);
      if (user) {
        before.externalId = user.external_id;
        before.name = user.user_name;
      }
    } else {
      const group = await store.groupById(path.id);
      if (group) {
        before.externalId = group.external_id;
        before.name = group.display_name;
      }
    }
  } else if (path.kind === "Groups") {
    before.memberIds = (await store.membersOf(path.id)).map((m) => m.value);
  }
  return before;
}

async function deliver(db: Datastore, event: string, data: Record<string, unknown>): Promise<void> {
  const envelope = {
    id: `evt_${crypto.randomUUID()}`,
    event,
    data,
    created_at: new Date().toISOString(),
  };
  const request = new Request("http://native/webhooks/dsync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  await handleDsyncWebhook(request, db);
}

function userEventData(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    idp_id: typeof resource.externalId === "string" ? resource.externalId : null,
    username: typeof resource.userName === "string" ? resource.userName : null,
    state: resource.active === false ? "inactive" : "active",
    emails: resource.emails,
  };
}

function memberEventData(user: {
  external_id: string | null;
  user_name: string;
  active: number;
}): Record<string, unknown> {
  return {
    idp_id: user.external_id,
    username: user.user_name,
    state: user.active === 1 ? "active" : "inactive",
  };
}

/** Emit the DSync event(s) for a successful mock write, after it committed. */
export async function emitMockEvents(
  db: Datastore,
  store: ScimStore,
  method: string,
  path: MockPath,
  before: MockBefore,
  responseText: string,
  status: number,
): Promise<void> {
  if (!path.kind) return;
  const kind = path.kind;

  if (method === "DELETE") {
    if (before.externalId == null && before.name == null) return;
    await deliver(
      db,
      kind === "Users" ? "dsync.user.deleted" : "dsync.group.deleted",
      kind === "Users"
        ? { idp_id: before.externalId ?? null, username: before.name ?? null }
        : { idp_id: before.externalId ?? null, name: before.name ?? null },
    );
    return;
  }

  let resource: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (!parsed || typeof parsed !== "object") return;
    resource = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const created = method === "POST" || status === 201;

  if (kind === "Users") {
    await deliver(
      db,
      created ? "dsync.user.created" : "dsync.user.updated",
      userEventData(resource),
    );
    return;
  }

  const groupData = {
    idp_id: typeof resource.externalId === "string" ? resource.externalId : null,
    name: typeof resource.displayName === "string" ? resource.displayName : null,
  };
  await deliver(db, created ? "dsync.group.created" : "dsync.group.updated", groupData);

  // Membership deltas become user_added / user_removed events, diffing the
  // group's members before the write against those it holds after.
  const afterIds = Array.isArray(resource.members)
    ? resource.members
        .map((m) => (m && typeof m === "object" ? (m as { value?: unknown }).value : null))
        .filter((v): v is string => typeof v === "string")
    : [];
  const beforeIds = before.memberIds ?? [];
  for (const userId of afterIds.filter((v) => !beforeIds.includes(v))) {
    const user = await store.userById(userId);
    if (user)
      await deliver(db, "dsync.group.user_added", {
        user: memberEventData(user),
        group: groupData,
      });
  }
  for (const userId of beforeIds.filter((v) => !afterIds.includes(v))) {
    const user = await store.userById(userId);
    if (user) {
      await deliver(db, "dsync.group.user_removed", {
        user: memberEventData(user),
        group: groupData,
      });
    }
  }
}
