import type { BackfillSummary, Connection, ResourceType } from "./types";
import { insertProxyLog } from "./db";
import {
  errorMessage,
  isRecord,
  isSuccess,
  joinScimUrl,
  loadIdMaps,
  makeTranslator,
  mirrorUpsert,
  parseJson,
  scimFetch,
} from "./scim";

const PAGE_SIZE = 100;
const ERROR_CAP = 20;

interface ResourceCounts {
  total: number;
  mirrored: number;
  failed: number;
}

/**
 * Snapshot-then-replay: intentionally no guard against deletes that land
 * mid-backfill (the resurrection race the explainer documents).
 */
export async function runBackfill(
  db: D1Database,
  connection: Connection,
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    users: { total: 0, mirrored: 0, failed: 0 },
    groups: { total: 0, mirrored: 0, failed: 0 },
    errors: [],
  };

  const users = await snapshot(connection, "Users", summary.errors);
  for (const resource of users) {
    await mirrorResource(
      db,
      connection,
      "Users",
      resource,
      resource,
      summary.users,
      summary.errors,
    );
  }

  const groups = await snapshot(connection, "Groups", summary.errors);
  const maps = await loadIdMaps(db, connection.id);
  const translate = makeTranslator(maps.nativeToWorkos);
  for (const resource of groups) {
    const body = { ...resource };
    if (Array.isArray(body.members)) {
      body.members = body.members.map((member) =>
        isRecord(member) && typeof member.value === "string"
          ? { ...member, value: translate("Users", member.value) }
          : member,
      );
    }
    await mirrorResource(db, connection, "Groups", resource, body, summary.groups, summary.errors);
  }

  return summary;
}

async function snapshot(
  connection: Connection,
  kind: ResourceType,
  errors: string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let startIndex = 1;
  for (;;) {
    let page;
    try {
      page = await scimFetch(
        `${joinScimUrl(connection.native_url, `/${kind}`)}?startIndex=${startIndex}&count=${PAGE_SIZE}`,
        { method: "GET", token: connection.native_token },
      );
    } catch (error) {
      pushError(errors, `${kind} snapshot: ${errorMessage(error)}`);
      return out;
    }
    if (!isSuccess(page.status)) {
      pushError(errors, `${kind} snapshot: native returned ${page.status}`);
      return out;
    }
    const body = parseJson(page.bodyText);
    const resources = body && Array.isArray(body.Resources) ? body.Resources.filter(isRecord) : [];
    out.push(...resources);
    const total = body && typeof body.totalResults === "number" ? body.totalResults : out.length;
    if (resources.length === 0 || out.length >= total) return out;
    startIndex += resources.length;
  }
}

async function mirrorResource(
  db: D1Database,
  connection: Connection,
  kind: ResourceType,
  original: Record<string, unknown>,
  body: Record<string, unknown>,
  counts: ResourceCounts,
  errors: string[],
): Promise<void> {
  counts.total += 1;
  const nativeId = typeof original.id === "string" ? original.id : null;
  if (!nativeId) {
    counts.failed += 1;
    pushError(errors, `${kind}: snapshot resource is missing an id`);
    return;
  }
  const result = await mirrorUpsert(db, connection, kind, nativeId, body);
  try {
    await insertProxyLog(db, {
      connection_id: connection.id,
      source: "backfill",
      mode: connection.mode,
      method: "PUT",
      path: `/${kind}/${nativeId}`,
      request_body: JSON.stringify(body),
      workos_request: result.workosRequest,
      workos_status: result.status,
      workos_ms: result.ms,
      workos_body: result.body,
      response_status: result.status,
      error: result.error,
    });
  } catch {
    // logging must never abort the backfill
  }
  if (result.ok) {
    counts.mirrored += 1;
  } else {
    counts.failed += 1;
    pushError(errors, `${kind}/${nativeId}: ${result.error ?? `WorkOS returned ${result.status}`}`);
  }
}

function pushError(errors: string[], message: string): void {
  if (errors.length < ERROR_CAP) errors.push(message);
}
