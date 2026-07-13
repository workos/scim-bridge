import type { Connection, IdMapping, ResourceType } from "./types";
import { MIGRATED_ID_HEADER } from "./types";
import { getMapping, upsertMapping, withD1Retry } from "./db";

export const SCIM_PREFIX = "/scim/v2";
export const SCIM_CONTENT_TYPE = "application/scim+json";

export function scimError(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: String(status),
      detail,
    }),
    { status, headers: { "Content-Type": SCIM_CONTENT_TYPE } },
  );
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function joinScimUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export interface ScimPath {
  kind: ResourceType | null;
  id: string | null;
  discovery: boolean;
  /** Path after /scim/v2, still URL-encoded, for verbatim forwarding. */
  rest: string;
}

const DISCOVERY_ROOTS = new Set(["ServiceProviderConfig", "Schemas", "ResourceTypes"]);

export function parseScimPath(pathname: string): ScimPath | null {
  if (!pathname.startsWith(SCIM_PREFIX)) return null;
  const rest = pathname.slice(SCIM_PREFIX.length);
  let segments: string[];
  try {
    segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length === 0) return null;
  const head = segments[0];
  if (head === "Users" || head === "Groups") {
    if (segments.length > 2) return null;
    return { kind: head, id: segments[1] ?? null, discovery: false, rest };
  }
  if (DISCOVERY_ROOTS.has(head)) {
    return { kind: null, id: null, discovery: true, rest };
  }
  return null;
}

export interface UpstreamResult {
  status: number;
  ms: number;
  bodyText: string | null;
  contentType: string | null;
}

export interface ScimFetchOptions {
  method: string;
  token: string;
  body?: string | null;
  contentType?: string | null;
  migratedId?: string;
}

export async function scimFetch(url: string, options: ScimFetchOptions): Promise<UpstreamResult> {
  const headers = new Headers({ Authorization: `Bearer ${options.token}` });
  if (options.body != null) {
    headers.set("Content-Type", options.contentType ?? SCIM_CONTENT_TYPE);
  }
  if (options.migratedId != null) {
    headers.set(MIGRATED_ID_HEADER, options.migratedId);
  }
  const started = Date.now();
  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body ?? undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    ms: Date.now() - started,
    bodyText: text === "" ? null : text,
    contentType: response.headers.get("Content-Type"),
  };
}

export type IdMaps = Record<ResourceType, Map<string, string>>;

export interface IdTranslationMaps {
  nativeToWorkos: IdMaps;
  workosToNative: IdMaps;
}

export type IdTranslator = (kind: ResourceType, id: string) => string;

export async function loadIdMaps(db: D1Database, connectionId: string): Promise<IdTranslationMaps> {
  const { results } = await withD1Retry(() =>
    db
      .prepare(
        "SELECT resource_type, native_id, workos_id FROM id_mappings WHERE connection_id = ?",
      )
      .bind(connectionId)
      .all<Pick<IdMapping, "resource_type" | "native_id" | "workos_id">>(),
  );
  const maps: IdTranslationMaps = {
    nativeToWorkos: { Users: new Map(), Groups: new Map() },
    workosToNative: { Users: new Map(), Groups: new Map() },
  };
  for (const row of results) {
    maps.nativeToWorkos[row.resource_type].set(row.native_id, row.workos_id);
    maps.workosToNative[row.resource_type].set(row.workos_id, row.native_id);
  }
  return maps;
}

export function makeTranslator(maps: IdMaps): IdTranslator {
  return (kind, id) => maps[kind].get(id) ?? id;
}

function translateMemberEntries(entries: unknown[], translate: IdTranslator): unknown[] {
  return entries.map((entry) =>
    isRecord(entry) && typeof entry.value === "string"
      ? { ...entry, value: translate("Users", entry.value) }
      : entry,
  );
}

export function translateResourceIds(
  resource: Record<string, unknown>,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...resource };
  if (typeof out.id === "string") out.id = translate(kind, out.id);
  if (Array.isArray(out.members)) out.members = translateMemberEntries(out.members, translate);
  return out;
}

export function translateListResponse(
  body: Record<string, unknown>,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> {
  if (!Array.isArray(body.Resources)) return body;
  return {
    ...body,
    Resources: body.Resources.map((resource) =>
      isRecord(resource) ? translateResourceIds(resource, kind, translate) : resource,
    ),
  };
}

const MEMBER_FILTER = /members\[value eq "([^"]+)"\]/g;

export function translatePatchIds(
  body: Record<string, unknown> | null,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> | null {
  if (!body || !Array.isArray(body.Operations)) return body;
  return {
    ...body,
    Operations: body.Operations.map((op) =>
      isRecord(op) ? translatePatchOp(op, kind, translate) : op,
    ),
  };
}

function translatePatchOp(
  op: Record<string, unknown>,
  kind: ResourceType,
  translate: IdTranslator,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...op };
  if (typeof next.path === "string") {
    next.path = next.path.replace(
      MEMBER_FILTER,
      (_match, id: string) => `members[value eq "${translate("Users", id)}"]`,
    );
  }
  if (kind !== "Groups") return next;
  const path = typeof next.path === "string" ? next.path : "";
  const value = next.value;
  if (Array.isArray(value) && (path === "" || path.startsWith("members"))) {
    next.value = translateMemberEntries(value, translate);
  } else if (isRecord(value)) {
    const members = value.members;
    if (Array.isArray(members)) {
      next.value = { ...value, members: translateMemberEntries(members, translate) };
    }
  }
  return next;
}

export interface MirrorResult {
  ok: boolean;
  workosRequest: string;
  status: number | null;
  ms: number | null;
  body: string | null;
  error: string | null;
}

/**
 * The migrated-id contract: PUT /{kind}/{nativeId} + X-WorkOS-Migrated-Id.
 * On 404/501 the endpoint does not honor the contract; fall back to a plain
 * PUT on a previously mapped workos id, or POST and record the minted id.
 */
export async function mirrorUpsert(
  db: D1Database,
  connection: Connection,
  kind: ResourceType,
  nativeId: string,
  resource: Record<string, unknown>,
): Promise<MirrorResult> {
  let workosRequest = `PUT /${kind}/${nativeId} +${MIGRATED_ID_HEADER}`;
  let ms = 0;
  try {
    const contract = await scimFetch(
      joinScimUrl(connection.workos_url, `/${kind}/${encodeURIComponent(nativeId)}`),
      {
        method: "PUT",
        token: connection.workos_token,
        body: JSON.stringify({ ...resource, id: nativeId }),
        migratedId: nativeId,
      },
    );
    ms += contract.ms;
    if (isSuccess(contract.status)) {
      await upsertMapping(db, {
        connection_id: connection.id,
        resource_type: kind,
        native_id: nativeId,
        workos_id: nativeId,
        strategy: "migrated-id",
      });
      return {
        ok: true,
        workosRequest,
        status: contract.status,
        ms,
        body: contract.bodyText,
        error: null,
      };
    }
    if (contract.status !== 404 && contract.status !== 501) {
      return {
        ok: false,
        workosRequest,
        status: contract.status,
        ms,
        body: contract.bodyText,
        error: `WorkOS migrated-id PUT returned ${contract.status}`,
      };
    }

    const existing = await getMapping(db, connection.id, kind, nativeId);
    if (existing) {
      workosRequest = `PUT /${kind}/${existing.workos_id} (fallback)`;
      const replace = await scimFetch(
        joinScimUrl(connection.workos_url, `/${kind}/${encodeURIComponent(existing.workos_id)}`),
        {
          method: "PUT",
          token: connection.workos_token,
          body: JSON.stringify({ ...resource, id: existing.workos_id }),
        },
      );
      ms += replace.ms;
      if (isSuccess(replace.status)) {
        await upsertMapping(db, {
          connection_id: connection.id,
          resource_type: kind,
          native_id: nativeId,
          workos_id: existing.workos_id,
          strategy: "fallback-post",
        });
        return {
          ok: true,
          workosRequest,
          status: replace.status,
          ms,
          body: replace.bodyText,
          error: null,
        };
      }
      if (replace.status !== 404) {
        return {
          ok: false,
          workosRequest,
          status: replace.status,
          ms,
          body: replace.bodyText,
          error: `WorkOS fallback PUT returned ${replace.status}`,
        };
      }
      // The mapped resource no longer exists on WorkOS (e.g. the directory was
      // cleaned) — fall through to POST to recreate it. The POST's upsertMapping
      // overwrites the stale mapping keyed on the same native id.
    }

    workosRequest = `POST /${kind} (fallback)`;
    const { id: _omitted, ...stripped } = resource;
    const create = await scimFetch(joinScimUrl(connection.workos_url, `/${kind}`), {
      method: "POST",
      token: connection.workos_token,
      body: JSON.stringify(stripped),
    });
    ms += create.ms;
    if (isSuccess(create.status)) {
      const created = parseJson(create.bodyText);
      const workosId = created && typeof created.id === "string" ? created.id : null;
      if (!workosId) {
        return {
          ok: false,
          workosRequest,
          status: create.status,
          ms,
          body: create.bodyText,
          error: "WorkOS fallback POST succeeded but the response had no id",
        };
      }
      await upsertMapping(db, {
        connection_id: connection.id,
        resource_type: kind,
        native_id: nativeId,
        workos_id: workosId,
        strategy: "fallback-post",
      });
      return {
        ok: true,
        workosRequest,
        status: create.status,
        ms,
        body: create.bodyText,
        error: null,
      };
    }
    if (create.status === 409) {
      const attribute = kind === "Users" ? "userName" : "displayName";
      const value = resource[attribute];
      if (typeof value === "string" && value !== "") {
        const filter = `${attribute} eq "${value.replaceAll('"', '\\"')}"`;
        const lookup = await scimFetch(
          `${joinScimUrl(connection.workos_url, `/${kind}`)}?filter=${encodeURIComponent(filter)}`,
          { method: "GET", token: connection.workos_token },
        );
        ms += lookup.ms;
        const listing = parseJson(lookup.bodyText);
        const resources = listing && Array.isArray(listing.Resources) ? listing.Resources : [];
        const first = resources.find(isRecord);
        const workosId = first && typeof first.id === "string" ? first.id : null;
        if (isSuccess(lookup.status) && workosId) {
          await upsertMapping(db, {
            connection_id: connection.id,
            resource_type: kind,
            native_id: nativeId,
            workos_id: workosId,
            strategy: "fallback-post",
          });
          return {
            ok: true,
            workosRequest,
            status: create.status,
            ms,
            body: create.bodyText,
            error: null,
          };
        }
      }
      return {
        ok: false,
        workosRequest,
        status: create.status,
        ms,
        body: create.bodyText,
        error: `WorkOS fallback POST hit 409 and the ${attribute} lookup did not recover an id`,
      };
    }
    return {
      ok: false,
      workosRequest,
      status: create.status,
      ms,
      body: create.bodyText,
      error: `WorkOS fallback POST returned ${create.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      workosRequest,
      status: null,
      ms: ms || null,
      body: null,
      error: errorMessage(error),
    };
  }
}
