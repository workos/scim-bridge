import { withDatastoreRetry } from "../shared/db";
import { handleDsyncWebhook } from "./listener";
import type { ScimStore } from "./store";
import type { Datastore } from "../shared/datastore";

// When the mock WorkOS directory is written to, it emits the DSync events a
// real migrated WorkOS directory would: appended to an ordered log served from
// GET /events (always — a real environment always has one), and delivered as a
// webhook to this app's own listener when `mock_workos.emit_dsync` allows.
// That closes the workos-only cutover loop locally over either transport:
// proxy → mock WorkOS → DSync event → listener → native app converges. A real
// WorkOS directory emits its own events, so this only runs for the mock.

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

async function deliver(
  db: Datastore,
  webhook: boolean,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const envelope = {
    id: `evt_${crypto.randomUUID()}`,
    event,
    data,
    created_at: new Date().toISOString(),
  };
  // The log is unconditional: it is the mock's copy of the environment event
  // stream GET /events pages over, and a real environment records an event
  // whether or not any webhook endpoint is configured to receive it.
  await withDatastoreRetry(() =>
    db
      .prepare("INSERT INTO mock_workos_events (id, event, data, created_at) VALUES (?, ?, ?, ?)")
      .bind(envelope.id, envelope.event, JSON.stringify(envelope.data), envelope.created_at)
      .run(),
  );
  if (!webhook) return;
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

/** Emit the DSync event(s) for a successful mock write, after it committed.
 *  `webhook: false` still appends to the event log but posts no delivery — the
 *  poller-only configuration, where /events is the sole transport. */
export async function emitMockEvents(
  db: Datastore,
  store: ScimStore,
  method: string,
  path: MockPath,
  before: MockBefore,
  responseText: string,
  status: number,
  webhook: boolean,
): Promise<void> {
  if (!path.kind) return;
  const kind = path.kind;

  if (method === "DELETE") {
    if (before.externalId == null && before.name == null) return;
    await deliver(
      db,
      webhook,
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
      webhook,
      created ? "dsync.user.created" : "dsync.user.updated",
      userEventData(resource),
    );
    return;
  }

  const groupData = {
    idp_id: typeof resource.externalId === "string" ? resource.externalId : null,
    name: typeof resource.displayName === "string" ? resource.displayName : null,
  };
  await deliver(db, webhook, created ? "dsync.group.created" : "dsync.group.updated", groupData);

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
      await deliver(db, webhook, "dsync.group.user_added", {
        user: memberEventData(user),
        group: groupData,
      });
  }
  for (const userId of beforeIds.filter((v) => !afterIds.includes(v))) {
    const user = await store.userById(userId);
    if (user) {
      await deliver(db, webhook, "dsync.group.user_removed", {
        user: memberEventData(user),
        group: groupData,
      });
    }
  }
}

/**
 * The mock's `GET /events`: the public Events API contract in miniature —
 * `events[]` type filter, `after` cursor, `limit`, Bearer auth (checked by the
 * caller), and a `{ data, list_metadata }` body whose `after` is null once the
 * log is exhausted. Ordered by emission (`seq`), never by timestamp: serving
 * the log in the order it was written is what makes the poller immune to the
 * out-of-order hazard webhooks have.
 */
export async function listMockEvents(db: Datastore, params: URLSearchParams): Promise<Response> {
  const limit = Math.min(Math.max(Number(params.get("limit") ?? "10") || 10, 1), 100);
  const after = params.get("after");
  let afterSeq = 0;
  if (after) {
    const row = await withDatastoreRetry(() =>
      db
        .prepare("SELECT seq FROM mock_workos_events WHERE id = ?")
        .bind(after)
        .first<{ seq: number }>(),
    );
    if (!row) {
      return Response.json({ message: `Event ${after} not found.` }, { status: 400 });
    }
    afterSeq = row.seq;
  }

  const types = params.getAll("events[]");
  const typeFilter = types.length ? ` AND event IN (${types.map(() => "?").join(", ")})` : "";
  // limit + 1: one row of lookahead decides whether a next-page cursor exists.
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare(
        "SELECT id, event, data, created_at FROM mock_workos_events " +
          `WHERE seq > ?${typeFilter} ORDER BY seq LIMIT ?`,
      )
      .bind(afterSeq, ...types, limit + 1)
      .all<{ id: string; event: string; data: string; created_at: string }>(),
  );
  const more = results.length > limit;
  const page = results.slice(0, limit);
  const data = page.map((row) => ({
    id: row.id,
    event: row.event,
    data: JSON.parse(row.data) as unknown,
    created_at: row.created_at,
  }));
  return Response.json({
    data,
    list_metadata: {
      before: data.length ? data[0].id : null,
      after: more ? data[data.length - 1].id : null,
    },
  });
}
