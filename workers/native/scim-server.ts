import { MIGRATED_ID_HEADER } from "../shared/types";
import type { GroupRow, ListFilter, ScimResource, ScimStore, UserRow } from "./store";

const SCIM_CONTENT_TYPE = "application/scim+json";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const USER_SCHEMA = "urn:ietf:params:scim:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:core:2.0:Group";

type Kind = "Users" | "Groups";

export interface ScimServerConfig {
  store: ScimStore;
  /**
   * When enabled, PUT /{kind}/{id} with X-WorkOS-Migrated-Id equal to the path
   * id is create-if-absent keyed on that id (the migrated-id contract).
   */
  migratedIdContract: boolean;
}

export function scimJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

export function scimError(status: number, detail: string, scimType?: string): Response {
  return scimJson(
    {
      schemas: [ERROR_SCHEMA],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    },
    status,
  );
}

export async function handleScim(
  request: Request,
  subpath: string,
  config: ScimServerConfig,
): Promise<Response> {
  const segments = subpath.split("/").filter(Boolean);
  const method = request.method.toUpperCase();

  if (segments.length === 1 && segments[0] === "ServiceProviderConfig") {
    if (method !== "GET") return scimError(405, "ServiceProviderConfig only supports GET.");
    return scimJson(serviceProviderConfig());
  }

  const kind: Kind | null =
    segments[0] === "Users" ? "Users" : segments[0] === "Groups" ? "Groups" : null;
  if (!kind || segments.length > 2) {
    return scimError(404, `No SCIM resource at ${subpath || "/"}.`);
  }

  const id = segments[1];
  if (!id) {
    if (method === "GET") return handleList(request, kind, config.store);
    if (method === "POST") return handleCreate(request, kind, config.store);
    return scimError(405, `${method} is not supported on /${kind}.`);
  }

  switch (method) {
    case "GET":
      return handleGet(kind, id, config.store);
    case "PUT":
      return handlePut(request, kind, id, config);
    case "PATCH":
      return handlePatch(request, kind, id, config.store);
    case "DELETE":
      return handleDelete(kind, id, config.store);
    default:
      return scimError(405, `${method} is not supported on /${kind}/{id}.`);
  }
}

type FilterResult = { ok: true; filter: ListFilter | null } | { ok: false; response: Response };

function parseFilter(raw: string | null, kind: Kind): FilterResult {
  if (!raw || !raw.trim()) return { ok: true, filter: null };
  const match = raw.trim().match(/^(\w+)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i);
  if (!match) {
    return {
      ok: false,
      response: scimError(
        501,
        `The filter "${raw}" is not supported; only 'attribute eq "value"' filters are.`,
      ),
    };
  }
  const value = match[2].replace(/\\(.)/g, "$1");
  const supported: Record<string, ListFilter> =
    kind === "Users"
      ? {
          username: { column: "user_name", value, caseInsensitive: true },
          externalid: { column: "external_id", value, caseInsensitive: false },
        }
      : {
          displayname: { column: "display_name", value, caseInsensitive: true },
          externalid: { column: "external_id", value, caseInsensitive: false },
        };
  const filter = supported[match[1].toLowerCase()];
  if (!filter) {
    return {
      ok: false,
      response: scimError(501, `Filtering ${kind} on attribute "${match[1]}" is not supported.`),
    };
  }
  return { ok: true, filter };
}

async function handleList(request: Request, kind: Kind, store: ScimStore): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = parseFilter(params.get("filter"), kind);
  if (!parsed.ok) return parsed.response;

  const startIndex = Math.max(1, parseIntParam(params.get("startIndex"), 1));
  const count = Math.max(0, parseIntParam(params.get("count"), 100));

  let total: number;
  let resources: ScimResource[];
  if (kind === "Users") {
    const page = await store.listUsers(parsed.filter, startIndex - 1, count);
    total = page.total;
    resources = page.rows.map(renderUser);
  } else {
    const page = await store.listGroups(parsed.filter, startIndex - 1, count);
    total = page.total;
    resources = [];
    for (const row of page.rows) {
      resources.push(await renderGroup(row, store));
    }
  }

  return scimJson({
    schemas: [LIST_RESPONSE_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

async function handleCreate(request: Request, kind: Kind, store: ScimStore): Promise<Response> {
  const body = await readJson(request);
  if (!body) return scimError(400, "Request body must be a JSON object.", "invalidValue");

  if (kind === "Users") {
    const userName = stringAttr(body, "userName");
    if (!userName) return scimError(400, "userName is required.", "invalidValue");
    if (await store.userByUserName(userName)) {
      return scimError(409, `A user with userName "${userName}" already exists.`, "uniqueness");
    }
    const id = crypto.randomUUID();
    const resource = normalizeUser(body, id);
    await store.upsertUser(userRecord(id, resource));
    return scimJson(resource, 201);
  }

  const displayName = stringAttr(body, "displayName");
  if (!displayName) return scimError(400, "displayName is required.", "invalidValue");
  if (await store.groupByDisplayName(displayName)) {
    return scimError(409, `A group named "${displayName}" already exists.`, "uniqueness");
  }
  const id = crypto.randomUUID();
  const resource = normalizeGroup(body, id);
  await store.upsertGroup(groupRecord(id, resource));
  await store.setMembers(id, memberValues(body.members));
  return scimJson({ ...resource, members: await store.membersOf(id) }, 201);
}

async function handleGet(kind: Kind, id: string, store: ScimStore): Promise<Response> {
  if (kind === "Users") {
    const row = await store.userById(id);
    if (!row) return scimError(404, `No user with id ${id}.`);
    return scimJson(renderUser(row));
  }
  const row = await store.groupById(id);
  if (!row) return scimError(404, `No group with id ${id}.`);
  return scimJson(await renderGroup(row, store));
}

async function handlePut(
  request: Request,
  kind: Kind,
  id: string,
  config: ScimServerConfig,
): Promise<Response> {
  const { store } = config;
  const body = await readJson(request);
  if (!body) return scimError(400, "Request body must be a JSON object.", "invalidValue");

  const migratedId = request.headers.get(MIGRATED_ID_HEADER);
  if (config.migratedIdContract && migratedId !== null && migratedId !== id) {
    return scimError(
      400,
      `${MIGRATED_ID_HEADER} must equal the resource id in the path.`,
      "invalidValue",
    );
  }
  const createIfAbsent = config.migratedIdContract && migratedId === id;

  if (kind === "Users") {
    const existing = await store.userById(id);
    if (!existing && !createIfAbsent) return scimError(404, `No user with id ${id}.`);
    const userName = stringAttr(body, "userName");
    if (!userName) return scimError(400, "userName is required.", "invalidValue");
    const conflict = await store.userByUserName(userName);
    if (conflict && conflict.id !== id) {
      return scimError(409, `A user with userName "${userName}" already exists.`, "uniqueness");
    }
    const resource = normalizeUser(body, id);
    await store.upsertUser(userRecord(id, resource));
    return scimJson(resource);
  }

  const existing = await store.groupById(id);
  if (!existing && !createIfAbsent) return scimError(404, `No group with id ${id}.`);
  const displayName = stringAttr(body, "displayName");
  if (!displayName) return scimError(400, "displayName is required.", "invalidValue");
  const conflict = await store.groupByDisplayName(displayName);
  if (conflict && conflict.id !== id) {
    return scimError(409, `A group named "${displayName}" already exists.`, "uniqueness");
  }
  const resource = normalizeGroup(body, id);
  await store.upsertGroup(groupRecord(id, resource));
  await store.setMembers(id, memberValues(body.members));
  return scimJson({ ...resource, members: await store.membersOf(id) });
}

async function handlePatch(
  request: Request,
  kind: Kind,
  id: string,
  store: ScimStore,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return scimError(400, "Request body must be a JSON object.", "invalidValue");
  const operations = patchOperations(body);
  if (!operations) {
    return scimError(400, "PATCH body must include an Operations array.", "invalidValue");
  }

  if (kind === "Users") return patchUser(id, operations, store);
  return patchGroup(id, operations, store);
}

async function patchUser(
  id: string,
  operations: ScimResource[],
  store: ScimStore,
): Promise<Response> {
  const row = await store.userById(id);
  if (!row) return scimError(404, `No user with id ${id}.`);
  const resource = JSON.parse(row.resource) as ScimResource;

  for (const op of operations) {
    const opName = String(op.op ?? "").toLowerCase();
    const path = typeof op.path === "string" && op.path.trim() ? op.path.trim() : null;

    if (path && path.includes("[")) {
      return scimError(
        400,
        `The path "${path}" targets a filtered attribute, which is not supported on User resources.`,
        "invalidPath",
      );
    }

    if (opName === "remove") {
      if (!path) return scimError(400, "A remove operation requires a path.", "noTarget");
      const error = removeUserAttr(resource, path);
      if (error) return error;
      continue;
    }
    if (opName !== "add" && opName !== "replace") {
      return scimError(400, `The PATCH op "${String(op.op)}" is not supported.`, "invalidValue");
    }
    if (!path) {
      const value = op.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return scimError(
          400,
          "A path-less add/replace operation requires an object value.",
          "invalidValue",
        );
      }
      for (const [attr, attrValue] of Object.entries(value)) {
        setUserAttr(resource, attr, attrValue);
      }
      continue;
    }
    setUserAttr(resource, path, op.value);
  }

  resource.id = id;
  resource.active = coerceBoolean(resource.active ?? true);
  const userName = stringAttr(resource, "userName");
  if (!userName) return scimError(400, "userName is required.", "invalidValue");
  const conflict = await store.userByUserName(userName);
  if (conflict && conflict.id !== id) {
    return scimError(409, `A user with userName "${userName}" already exists.`, "uniqueness");
  }
  await store.upsertUser(userRecord(id, resource));
  return scimJson(resource);
}

async function patchGroup(
  id: string,
  operations: ScimResource[],
  store: ScimStore,
): Promise<Response> {
  const row = await store.groupById(id);
  if (!row) return scimError(404, `No group with id ${id}.`);
  const resource = JSON.parse(row.resource) as ScimResource;

  for (const op of operations) {
    const opName = String(op.op ?? "").toLowerCase();
    if (opName !== "add" && opName !== "replace" && opName !== "remove") {
      return scimError(400, `The PATCH op "${String(op.op)}" is not supported.`, "invalidValue");
    }
    const path = typeof op.path === "string" && op.path.trim() ? op.path.trim() : null;

    const memberFilter = path?.match(/^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i);
    if (memberFilter) {
      if (opName !== "remove") {
        return scimError(
          400,
          'Only remove is supported on members[value eq "…"] paths.',
          "invalidValue",
        );
      }
      await store.removeMember(id, memberFilter[1]);
      continue;
    }

    if (path && path.toLowerCase() === "members") {
      const ids = memberValues(op.value);
      if (opName === "add") {
        for (const userId of ids) await store.addMember(id, userId);
      } else if (opName === "replace") {
        await store.setMembers(id, ids);
      } else if (op.value === undefined || op.value === null) {
        await store.setMembers(id, []);
      } else {
        for (const userId of ids) await store.removeMember(id, userId);
      }
      continue;
    }

    if (opName === "remove") {
      if (!path) return scimError(400, "A remove operation requires a path.", "noTarget");
      const canonical = canonicalGroupAttr(path);
      if (canonical === "displayName" || canonical === "id") {
        return scimError(400, `${canonical} cannot be removed.`, "mutability");
      }
      delete resource[canonical];
      continue;
    }

    if (!path) {
      const value = op.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return scimError(
          400,
          "A path-less add/replace operation requires an object value.",
          "invalidValue",
        );
      }
      for (const [attr, attrValue] of Object.entries(value)) {
        if (attr.toLowerCase() === "members") {
          if (opName === "add") {
            for (const userId of memberValues(attrValue)) await store.addMember(id, userId);
          } else {
            await store.setMembers(id, memberValues(attrValue));
          }
        } else {
          resource[canonicalGroupAttr(attr)] = attrValue;
        }
      }
      continue;
    }
    resource[canonicalGroupAttr(path)] = op.value;
  }

  resource.id = id;
  const displayName = stringAttr(resource, "displayName");
  if (!displayName) return scimError(400, "displayName is required.", "invalidValue");
  const conflict = await store.groupByDisplayName(displayName);
  if (conflict && conflict.id !== id) {
    return scimError(409, `A group named "${displayName}" already exists.`, "uniqueness");
  }
  await store.upsertGroup(groupRecord(id, resource));
  return scimJson({ ...resource, members: await store.membersOf(id) });
}

async function handleDelete(kind: Kind, id: string, store: ScimStore): Promise<Response> {
  const removed = kind === "Users" ? await store.deleteUser(id) : await store.deleteGroup(id);
  if (!removed) {
    return scimError(404, `No ${kind === "Users" ? "user" : "group"} with id ${id}.`);
  }
  return new Response(null, { status: 204 });
}

function renderUser(row: UserRow): ScimResource {
  return JSON.parse(row.resource) as ScimResource;
}

async function renderGroup(row: GroupRow, store: ScimStore): Promise<ScimResource> {
  const resource = JSON.parse(row.resource) as ScimResource;
  return { ...resource, members: await store.membersOf(row.id) };
}

export function normalizeUser(body: ScimResource, id: string): ScimResource {
  const meta = objectAttr(body.meta);
  return {
    ...body,
    schemas: Array.isArray(body.schemas) && body.schemas.length > 0 ? body.schemas : [USER_SCHEMA],
    id,
    userName: stringAttr(body, "userName"),
    externalId: body.externalId == null ? null : String(body.externalId),
    active: coerceBoolean(body.active ?? true),
    meta: { ...meta, resourceType: "User" },
  };
}

export function normalizeGroup(body: ScimResource, id: string): ScimResource {
  const resource: ScimResource = { ...body };
  delete resource.members;
  const meta = objectAttr(resource.meta);
  resource.schemas =
    Array.isArray(resource.schemas) && resource.schemas.length > 0
      ? resource.schemas
      : [GROUP_SCHEMA];
  resource.id = id;
  resource.externalId = resource.externalId == null ? null : String(resource.externalId);
  resource.meta = { ...meta, resourceType: "Group" };
  return resource;
}

function userRecord(
  id: string,
  resource: ScimResource,
): {
  id: string;
  userName: string;
  externalId: string | null;
  active: boolean;
  resource: ScimResource;
} {
  return {
    id,
    userName: String(resource.userName),
    externalId: resource.externalId == null ? null : String(resource.externalId),
    active: resource.active === true,
    resource,
  };
}

function groupRecord(
  id: string,
  resource: ScimResource,
): { id: string; displayName: string; externalId: string | null; resource: ScimResource } {
  return {
    id,
    displayName: String(resource.displayName),
    externalId: resource.externalId == null ? null : String(resource.externalId),
    resource,
  };
}

function setUserAttr(resource: ScimResource, path: string, value: unknown): void {
  const canonical = canonicalUserAttr(path);
  if (canonical === "active") {
    resource.active = coerceBoolean(value);
    return;
  }
  const dot = canonical.indexOf(".");
  if (dot > 0) {
    const parent = canonical.slice(0, dot);
    const child = canonical.slice(dot + 1);
    const container = objectAttr(resource[parent]);
    resource[parent] = { ...container, [child]: value };
    return;
  }
  const existing = objectAttr(resource[canonical]);
  const incoming = objectAttr(value);
  if (existing && incoming) {
    resource[canonical] = { ...existing, ...incoming };
    return;
  }
  resource[canonical] = value;
}

function removeUserAttr(resource: ScimResource, path: string): Response | null {
  const canonical = canonicalUserAttr(path);
  if (canonical === "userName" || canonical === "id" || canonical === "active") {
    return scimError(400, `${canonical} cannot be removed.`, "mutability");
  }
  const dot = canonical.indexOf(".");
  if (dot > 0) {
    const container = objectAttr(resource[canonical.slice(0, dot)]);
    if (container) delete container[canonical.slice(dot + 1)];
    return null;
  }
  delete resource[canonical];
  return null;
}

function canonicalUserAttr(path: string): string {
  const lower = path.toLowerCase();
  if (lower === "active") return "active";
  if (lower === "username") return "userName";
  if (lower === "externalid") return "externalId";
  if (lower.startsWith("name.")) return `name.${path.slice(5)}`;
  return path;
}

function canonicalGroupAttr(path: string): string {
  const lower = path.toLowerCase();
  if (lower === "displayname") return "displayName";
  if (lower === "externalid") return "externalId";
  if (lower === "id") return "id";
  return path;
}

function patchOperations(body: ScimResource): ScimResource[] | null {
  const raw = Array.isArray(body.Operations)
    ? body.Operations
    : Array.isArray(body.operations)
      ? body.operations
      : null;
  if (!raw) return null;
  const operations: ScimResource[] = [];
  for (const entry of raw) {
    const op = objectAttr(entry);
    if (!op) return null;
    operations.push(op);
  }
  return operations;
}

function memberValues(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      ids.push(entry);
    } else {
      const member = objectAttr(entry);
      if (member && typeof member.value === "string") ids.push(member.value);
    }
  }
  return ids;
}

export function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value === 1;
}

function stringAttr(resource: ScimResource, key: string): string | null {
  const value = resource[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function objectAttr(value: unknown): ScimResource | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ScimResource)
    : null;
}

async function readJson(request: Request): Promise<ScimResource | null> {
  try {
    return objectAttr(await request.json());
  } catch {
    return null;
  }
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

function serviceProviderConfig(): ScimResource {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    filter: { supported: true, maxResults: 200 },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    sort: { supported: false },
    etag: { supported: false },
    changePassword: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Authentication scheme using the OAuth Bearer Token standard.",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig" },
  };
}
