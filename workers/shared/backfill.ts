import type { BackfillSummary, Directory, ResourceType } from "./types";
import { insertProxyLog, shouldPersistLogs } from "./db";
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

type UpstreamSide = "native" | "workos";

interface ResourceCounts {
  total: number;
  mirrored: number;
  failed: number;
}

/**
 * Snapshot-then-replay: intentionally no guard against deletes that land
 * mid-backfill (the resurrection race the explainer documents).
 */
export async function runBackfill(db: D1Database, directory: Directory): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    users: { total: 0, mirrored: 0, failed: 0 },
    groups: { total: 0, mirrored: 0, failed: 0 },
    errors: [],
  };

  const users = await snapshot(
    directory.native_url,
    directory.native_token,
    "Users",
    "native",
    summary.errors,
  );
  for (const resource of users) {
    await mirrorResource(db, directory, "Users", resource, resource, summary.users, summary.errors);
  }

  const groups = await snapshot(
    directory.native_url,
    directory.native_token,
    "Groups",
    "native",
    summary.errors,
  );
  const maps = await loadIdMaps(db, directory.id);
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
    await mirrorResource(db, directory, "Groups", resource, body, summary.groups, summary.errors);
  }

  return summary;
}

/**
 * Pages an upstream list endpoint. Every way the enumeration can come up short —
 * a transport failure, an error status, a body that is not a SCIM ListResponse,
 * or pagination that stops before `totalResults` — records an error, so a
 * summary with an empty snapshot is never mistaken for an empty directory.
 */
async function snapshot(
  url: string,
  token: string,
  kind: ResourceType,
  side: UpstreamSide,
  errors: string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  // Carried across pages: an upstream that reports the total once and omits it
  // from later pages must not look like it ran out of resources.
  let reportedTotal: number | null = null;
  let startIndex = 1;
  for (;;) {
    let page;
    try {
      page = await scimFetch(
        `${joinScimUrl(url, `/${kind}`)}?startIndex=${startIndex}&count=${PAGE_SIZE}`,
        { method: "GET", token },
      );
    } catch (error) {
      pushError(errors, `${kind} snapshot: ${errorMessage(error)}`);
      return out;
    }
    if (!isSuccess(page.status)) {
      pushError(errors, `${kind} snapshot: ${side} returned ${page.status}`);
      return out;
    }
    const body = parseJson(page.bodyText);
    if (!body) {
      pushError(errors, `${kind} snapshot: ${side} returned a list response that is not JSON`);
      return out;
    }
    if (!Array.isArray(body.Resources)) {
      pushError(
        errors,
        `${kind} snapshot: ${side} returned a list response without a Resources array`,
      );
      return out;
    }
    const resources = body.Resources.filter(isRecord);
    out.push(...resources);
    if (typeof body.totalResults === "number") reportedTotal = body.totalResults;
    const total = reportedTotal ?? out.length;
    if (out.length >= total) return out;
    if (resources.length === 0) {
      pushError(
        errors,
        `${kind} snapshot: ${side} returned an empty page at ${out.length} of ${total} resources`,
      );
      return out;
    }
    startIndex += resources.length;
  }
}

async function mirrorResource(
  db: D1Database,
  directory: Directory,
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
  const result = await mirrorUpsert(db, directory, kind, nativeId, body);
  try {
    if (shouldPersistLogs(directory))
      await insertProxyLog(db, {
        directory_id: directory.id,
        source: "backfill",
        mode: directory.mode,
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

/**
 * Reverse of runBackfill: snapshot the live WorkOS directory over SCIM and
 * replay every user and group into the native app as migrated-id upserts,
 * preserving the shared id. A belt-and-suspenders reconcile before rollback — it
 * brings native current even if its DSync listener lagged or never ran. Requires
 * the native endpoint to honor the migrated-id create-if-absent PUT contract, so
 * a resource missing on the native side is restored under its shared id. (The
 * forward direction no longer relies on this: WorkOS creates only via POST.)
 */
export async function runReconcileFromWorkos(
  db: D1Database,
  directory: Directory,
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    users: { total: 0, mirrored: 0, failed: 0 },
    groups: { total: 0, mirrored: 0, failed: 0 },
    errors: [],
  };
  const maps = await loadIdMaps(db, directory.id);
  const toNative = makeTranslator(maps.workosToNative);

  const users = await snapshot(
    directory.workos_url,
    directory.workos_token,
    "Users",
    "workos",
    summary.errors,
  );
  for (const resource of users) {
    await pushToNative(db, directory, "Users", resource, toNative, summary.users, summary.errors);
  }

  const groups = await snapshot(
    directory.workos_url,
    directory.workos_token,
    "Groups",
    "workos",
    summary.errors,
  );
  for (const resource of groups) {
    const body = { ...resource };
    if (Array.isArray(body.members)) {
      body.members = body.members.map((member) =>
        isRecord(member) && typeof member.value === "string"
          ? { ...member, value: toNative("Users", member.value) }
          : member,
      );
    }
    await pushToNative(db, directory, "Groups", body, toNative, summary.groups, summary.errors);
  }

  return summary;
}

async function pushToNative(
  db: D1Database,
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
  toNative: (kind: ResourceType, id: string) => string,
  counts: ResourceCounts,
  errors: string[],
): Promise<void> {
  counts.total += 1;
  const workosId = typeof resource.id === "string" ? resource.id : null;
  if (!workosId) {
    counts.failed += 1;
    pushError(errors, `${kind}: WorkOS resource is missing an id`);
    return;
  }
  const nativeId = toNative(kind, workosId);
  let result;
  try {
    result = await scimFetch(
      joinScimUrl(directory.native_url, `/${kind}/${encodeURIComponent(nativeId)}`),
      {
        method: "PUT",
        token: directory.native_token,
        body: JSON.stringify({ ...resource, id: nativeId }),
        migratedId: nativeId,
      },
    );
  } catch (error) {
    counts.failed += 1;
    pushError(errors, `${kind}/${nativeId}: ${errorMessage(error)}`);
    return;
  }
  try {
    if (shouldPersistLogs(directory))
      await insertProxyLog(db, {
        directory_id: directory.id,
        source: "backfill",
        mode: directory.mode,
        method: "PUT",
        path: `/${kind}/${nativeId}`,
        request_body: JSON.stringify(resource),
        native_status: result.status,
        native_ms: result.ms,
        native_body: result.bodyText,
        response_status: result.status,
        error: isSuccess(result.status) ? null : `native returned ${result.status}`,
      });
  } catch {
    // logging must never abort the reconcile
  }
  if (isSuccess(result.status)) {
    counts.mirrored += 1;
  } else {
    counts.failed += 1;
    pushError(errors, `${kind}/${nativeId}: native returned ${result.status}`);
  }
}

function pushError(errors: string[], message: string): void {
  if (errors.length < ERROR_CAP) errors.push(message);
}
