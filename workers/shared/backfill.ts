import type { Datastore } from "./datastore";
import type { BackfillSummary, Directory, ResourceType } from "./types";
import {
  getMapping,
  insertProxyLog,
  listMappingsByNativeId,
  shouldPersistLogs,
  upsertMapping,
} from "./db";
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
  type IdTranslationMaps,
  type UpstreamResult,
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
export async function runBackfill(db: Datastore, directory: Directory): Promise<BackfillSummary> {
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
  db: Datastore,
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
  db: Datastore,
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
    await pushToNative(
      db,
      directory,
      "Users",
      resource,
      toNative,
      maps,
      summary.users,
      summary.errors,
    );
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
    await pushToNative(
      db,
      directory,
      "Groups",
      body,
      toNative,
      maps,
      summary.groups,
      summary.errors,
    );
  }

  return summary;
}

async function pushToNative(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  resource: Record<string, unknown>,
  toNative: (kind: ResourceType, id: string) => string,
  maps: IdTranslationMaps,
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
  let result: UpstreamResult;
  try {
    result = await putNative(directory, kind, nativeId, resource);
  } catch (error) {
    counts.failed += 1;
    pushError(errors, `${kind}/${nativeId}: ${errorMessage(error)}`);
    return;
  }

  // A 409 means the native row exists under a DIFFERENT id — its userName (or
  // group displayName) collides with a resource the listener re-created under
  // the IdP id instead of the shared id. Repair it in place: find that row by
  // its unique attribute, PUT the update onto its own id, and record the
  // shared-id -> drifted-id mapping so the two sides stay translatable in both
  // directions. This is deliberately non-destructive — native is the customer's
  // own app, where DELETE deprovisions a real person (session revocation, data
  // archival, downstream cascades). Ids need not converge for rollback: the
  // mapping table already translates, so a drifted id WITH a mapping is
  // functionally equivalent to a shared id. Missing mapping was the real bug.
  let drift: DriftRepair | null = null;
  if (result.status === 409) {
    drift = await repairDrift(db, directory, kind, workosId, nativeId, resource, maps, errors);
    if (drift?.result) result = drift.result;
  }

  try {
    if (shouldPersistLogs(directory))
      await insertProxyLog(db, {
        directory_id: directory.id,
        source: "backfill",
        mode: directory.mode,
        method: "PUT",
        path: `/${kind}/${drift?.nativeId ?? nativeId}`,
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
    if (drift) {
      pushError(
        errors,
        `${kind}/${nativeId}: id drift — ${drift.attr} "${drift.value}" is native id ` +
          `${drift.nativeId}, WorkOS holds ${workosId}; reconciled via mapping`,
      );
    }
  } else {
    counts.failed += 1;
    pushError(errors, `${kind}/${nativeId}: ${describeFailure(result.status)}`);
  }
}

async function putNative(
  directory: Directory,
  kind: ResourceType,
  id: string,
  resource: Record<string, unknown>,
): Promise<UpstreamResult> {
  return scimFetch(joinScimUrl(directory.native_url, `/${kind}/${encodeURIComponent(id)}`), {
    method: "PUT",
    token: directory.native_token,
    body: JSON.stringify({ ...resource, id }),
    migratedId: id,
  });
}

interface DriftRepair {
  /** The id the colliding native row actually holds. */
  nativeId: string;
  /** The unique attribute it collided on, and its value, for the report. */
  attr: "userName" | "displayName";
  value: string;
  /** The repair PUT's result, or null if the row couldn't be resolved. */
  result: UpstreamResult | null;
}

/**
 * Resolve the native row a 409 collided with by its unique attribute, update it
 * in place under its own id, and map shared-id -> that drifted id. Returns null
 * when the collision can't be attributed to a resolvable row (no value on the
 * WorkOS resource, native can't find one, or the row isn't this directory's),
 * leaving the original 409 to be reported as an unresolved failure.
 *
 * `userName`/`displayName` are unique per native namespace, not per directory, so
 * in a deployment that fronts several directories into one native SCIM namespace
 * a match on the attribute is not evidence that the row is this directory's. It
 * must also be attributable to this directory — already mapped by it, or carrying
 * the same `externalId` as the WorkOS resource — and not mapped by another one.
 */
async function repairDrift(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  workosId: string,
  nativeId: string,
  resource: Record<string, unknown>,
  maps: IdTranslationMaps,
  errors: string[],
): Promise<DriftRepair | null> {
  const attr = kind === "Users" ? "userName" : "displayName";
  const value = typeof resource[attr] === "string" ? (resource[attr] as string) : null;
  if (!value) return null;

  let driftedId: string;
  let matched: Record<string, unknown>;
  try {
    const resolved = await findNativeRowByAttr(directory, kind, attr, value);
    const resolvedId = resolved && typeof resolved.id === "string" ? resolved.id : null;
    if (!resolved || !resolvedId || resolvedId === nativeId) return null;
    driftedId = resolvedId;
    matched = resolved;
  } catch (error) {
    pushError(errors, `${kind}/${nativeId}: resolving drift by ${attr}: ${errorMessage(error)}`);
    return null;
  }

  const unowned = await unattributedReason(
    db,
    directory,
    kind,
    workosId,
    driftedId,
    matched,
    resource,
  );
  if (unowned) {
    pushError(
      errors,
      `${kind}/${nativeId}: ${attr} "${value}" is native id ${driftedId}, which ${unowned}; ` +
        "drift left unrepaired",
    );
    return null;
  }

  let result: UpstreamResult;
  try {
    result = await putNative(directory, kind, driftedId, resource);
  } catch (error) {
    pushError(errors, `${kind}/${driftedId}: ${errorMessage(error)}`);
    return { nativeId: driftedId, attr, value, result: null };
  }
  if (isSuccess(result.status)) {
    await upsertMapping(db, {
      directory_id: directory.id,
      resource_type: kind,
      native_id: driftedId,
      workos_id: workosId,
      strategy: "fallback-post",
    });
    // Reflect the repair in the live translation maps so a group pushed later in
    // this same reconcile addresses a repaired user by its drifted native id
    // (the translator reads these maps by reference); the DB row alone wouldn't
    // be observed until the next reconcile.
    maps.workosToNative[kind].set(workosId, driftedId);
    maps.nativeToWorkos[kind].set(driftedId, workosId);
  }
  return { nativeId: driftedId, attr, value, result };
}

/**
 * Why the matched native row can't be treated as this directory's resource, or
 * null when it can. Attribution is positive: the mapping table already binds the
 * row to this directory, or the row's `externalId` is the one WorkOS holds. A row
 * another directory maps is never written — that would be one tenant's reconcile
 * overwriting another tenant's resource.
 */
async function unattributedReason(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  workosId: string,
  driftedId: string,
  matched: Record<string, unknown>,
  resource: Record<string, unknown>,
): Promise<string | null> {
  const mappings = await listMappingsByNativeId(db, kind, driftedId);
  const foreign = mappings.find((mapping) => mapping.directory_id !== directory.id);
  if (foreign) return `is already mapped by directory ${foreign.directory_id}`;

  const mine = await getMapping(db, directory.id, kind, driftedId);
  if (mine) {
    return mine.workos_id === workosId
      ? null
      : `this directory already maps it to WorkOS ${mine.workos_id}`;
  }

  const theirs = externalId(matched);
  const ours = externalId(resource);
  if (!theirs || !ours) return "has no externalId to attribute it to this directory";
  if (theirs !== ours) return `carries externalId ${theirs}, not ${ours}`;
  return null;
}

function externalId(resource: Record<string, unknown>): string | null {
  const value = resource.externalId;
  return typeof value === "string" && value ? value : null;
}

/** GET native filtered on a unique attribute, returning the first matching row. */
async function findNativeRowByAttr(
  directory: Directory,
  kind: ResourceType,
  attr: "userName" | "displayName",
  value: string,
): Promise<Record<string, unknown> | null> {
  const escaped = value.replace(/([\\"])/g, "\\$1");
  const filter = encodeURIComponent(`${attr} eq "${escaped}"`);
  const page = await scimFetch(
    `${joinScimUrl(directory.native_url, `/${kind}`)}?filter=${filter}`,
    {
      method: "GET",
      token: directory.native_token,
    },
  );
  if (!isSuccess(page.status)) {
    throw new Error(`native returned ${page.status}`);
  }
  // Confirm the returned row actually carries the attribute we filtered on: a
  // native app that ignores an unsupported ?filter would return its whole first
  // page, and blindly taking Resources[0] could overwrite an unrelated person.
  const body = parseJson(page.bodyText);
  const match = Array.isArray(body?.Resources)
    ? body.Resources.find(
        (entry) =>
          isRecord(entry) &&
          typeof entry[attr] === "string" &&
          (entry[attr] as string).toLowerCase() === value.toLowerCase(),
      )
    : null;
  return isRecord(match) ? match : null;
}

function describeFailure(status: number): string {
  return status === 409
    ? "native returned 409 (userName/displayName exists under a different id; drift unresolved)"
    : `native returned ${status}`;
}

function pushError(errors: string[], message: string): void {
  if (errors.length < ERROR_CAP) errors.push(message);
}
