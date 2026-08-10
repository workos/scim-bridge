import type { Directory, IdMapping, ResourceType } from "./types";
import { MIGRATED_ID_HEADER } from "./types";
import { getMapping, listDirectories, upsertMapping, withDatastoreRetry } from "./db";
import type { NewMapping } from "./db";
import type { Datastore } from "./datastore";

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

/**
 * The proxy token an inbound request presents, or "" when the header carries
 * none. Two shapes count:
 *
 * - `Bearer <token>`, scheme matched case-insensitively (RFC 7235 §2.1).
 * - the bare token, no scheme. An IdP that sends the `Authorization` header
 *   verbatim — Okta's header-auth SCIM app puts the API Token field straight in
 *   it — never adds a prefix, and after a DNS swap the bridge inherits whatever
 *   shape that IdP always sent to the native app.
 *
 * Any other scheme (`Basic …`) is not a token to route on, so a value
 * containing whitespace only counts behind `Bearer`.
 */
export function authorizationToken(header: string | null): string {
  const value = (header ?? "").trim();
  const bearer = /^Bearer\s+(.*)$/i.exec(value);
  if (bearer) return bearer[1].trim();
  return /\s/.test(value) ? "" : value;
}

/**
 * The value with every null-valued key removed, recursively.
 *
 * Omitting an optional attribute and sending it as `null` express the same thing
 * in SCIM, but WorkOS rejects the null — `400 invalidSyntax: 'externalId' is
 * expected string, received null` — and the bridge cannot dictate how a
 * customer's SCIM app serializes an attribute it has no value for.
 *
 * Only keys go. An empty object or array is a value, not an absence, so both
 * survive; a null ELEMENT of an array survives too, since dropping it would
 * renumber the ones after it.
 */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry: unknown) => stripNulls(entry)) as T;
  if (!isRecord(value)) return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null) stripped[key] = stripNulls(entry);
  }
  return stripped as T;
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

/**
 * Canonical key for the native SCIM namespace a base URL addresses, so two
 * directories configured with equivalent-but-differently-written URLs (default
 * port written out, upper-case host, trailing slash) are recognised as the same
 * native app. Returns null for a URL that can't be parsed — callers that use
 * this to decide whether resources can collide must treat that as "might be the
 * same namespace" rather than assuming isolation.
 */
export function nativeNamespaceKey(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const port = url.port && url.port !== defaultPort(url.protocol) ? `:${url.port}` : "";
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/+$/, "")}`;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

/**
 * Whether two directories' native base URLs can address the same native app, and
 * so whether their ids can collide. Compared canonically, because equivalent URLs
 * are stored verbatim (`https://x:443/scim/v2` and `https://X/scim/v2/` are one
 * endpoint). Fails closed: a URL that won't parse is treated as possibly shared,
 * which only ever refuses a write.
 */
export function sharesNamespace(ours: string, theirs: string): boolean {
  const a = nativeNamespaceKey(ours);
  const b = nativeNamespaceKey(theirs);
  return a === null || b === null ? true : a === b;
}

/** The native-app coordinate two rows are compared on for collision: the base
 *  URL of the native app. A whole `Directory` satisfies it, but so does a
 *  mapping row that carries only this (see `listOtherMappingsByNativeId`). */
export type NativeEndpoint = Pick<Directory, "native_url">;

/**
 * Whether two directories share a native namespace — i.e. front the same native
 * app. Two directories on one `native_url` share an id space: the bridge cannot
 * verify that the customer's app partitions its rows by which bearer token
 * authenticated a call, so a matching URL must be treated as shared regardless
 * of the tokens. Fails closed on an unparseable URL too (see `sharesNamespace`),
 * which only ever refuses a write.
 */
export async function sharesNativeNamespace(
  a: NativeEndpoint,
  b: NativeEndpoint,
): Promise<boolean> {
  return sharesNamespace(a.native_url, b.native_url);
}

/**
 * Whether another directory addresses the same native app as this one. In a
 * shared namespace a native id names a row that may belong to a different
 * tenant, so no identifier this directory's own tenant supplies (`externalId`,
 * and the id derived from it) can be trusted to address a row: the tenant would
 * be choosing which of its neighbours' rows to write. Callers fail closed on
 * true.
 *
 * A matching `native_url` is sufficient to be shared: distinct native tokens do
 * NOT prove the callers address disjoint rows, because the bridge cannot verify
 * that the customer's app scopes its rows by the presenting credential.
 */
export async function nativeNamespaceIsShared(
  db: Datastore,
  directory: Directory,
): Promise<boolean> {
  const directories = await listDirectories(db);
  const candidates = directories.filter(
    (other) =>
      other.id !== directory.id &&
      // A directory with no native url configured yet addresses no native app,
      // so it holds no rows to protect. Everything else compares fail-closed.
      other.native_url !== "",
  );
  const shared = await Promise.all(
    candidates.map((other) => sharesNativeNamespace(directory, other)),
  );
  return shared.some(Boolean);
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
  // The prefix must end on a segment boundary, so "/scim/v2Users" is not a SCIM
  // path: it would yield a slash-less `rest` that joinScimUrl forwards verbatim.
  if (pathname !== SCIM_PREFIX && !pathname.startsWith(`${SCIM_PREFIX}/`)) return null;
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

/**
 * Response headers a proxied response may carry back to the IdP. An allowlist,
 * never a denylist: the proxy re-serializes bodies, so framing headers
 * (Content-Length, Transfer-Encoding, Content-Encoding) and hop-by-hop headers
 * would describe the upstream response rather than the one being sent.
 */
export const FORWARDED_RESPONSE_HEADERS = ["Location", "ETag", "Retry-After"] as const;

export interface UpstreamResult {
  status: number;
  ms: number;
  bodyText: string | null;
  contentType: string | null;
  /** Allowlisted upstream response headers, keyed as in FORWARDED_RESPONSE_HEADERS. */
  headers: Record<string, string>;
}

/**
 * Conditional request headers carried through to the upstream that issued the
 * validator the IdP is quoting. Forwarding an ETag without them would turn a
 * conditional update into an unconditional one, so the IdP would believe a
 * precondition ran that never reached the authoritative endpoint.
 */
export const CONDITIONAL_REQUEST_HEADERS = [
  "If-Match",
  "If-None-Match",
  "If-Modified-Since",
  "If-Unmodified-Since",
] as const;

/** Pick the conditional headers out of an incoming IdP request. */
export function conditionalRequestHeaders(headers: Headers): Record<string, string> {
  const conditional: Record<string, string> = {};
  for (const name of CONDITIONAL_REQUEST_HEADERS) {
    const value = headers.get(name);
    if (value != null) conditional[name] = value;
  }
  return conditional;
}

export interface ScimFetchOptions {
  method: string;
  token: string;
  body?: string | null;
  contentType?: string | null;
  migratedId?: string;
  /** Extra request headers, e.g. the caller's conditional headers. */
  requestHeaders?: Record<string, string>;
}

export async function scimFetch(url: string, options: ScimFetchOptions): Promise<UpstreamResult> {
  const headers = new Headers({ Authorization: `Bearer ${options.token}` });
  if (options.body != null) {
    headers.set("Content-Type", options.contentType ?? SCIM_CONTENT_TYPE);
  }
  if (options.migratedId != null) {
    headers.set(MIGRATED_ID_HEADER, options.migratedId);
  }
  for (const [name, value] of Object.entries(options.requestHeaders ?? {})) {
    headers.set(name, value);
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
    headers: forwardableHeaders(response.headers),
  };
}

function forwardableHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value != null) forwarded[name] = value;
  }
  return forwarded;
}

export type IdMaps = Record<ResourceType, Map<string, string>>;

export interface IdTranslationMaps {
  nativeToWorkos: IdMaps;
  workosToNative: IdMaps;
}

export type IdTranslator = (kind: ResourceType, id: string) => string;

export async function loadIdMaps(db: Datastore, directoryId: string): Promise<IdTranslationMaps> {
  const { results } = await withDatastoreRetry(() =>
    db
      .prepare("SELECT resource_type, native_id, workos_id FROM id_mappings WHERE directory_id = ?")
      .bind(directoryId)
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

/** Accumulates the WorkOS-leg timings across the steps of a single mirror. */
interface Elapsed {
  ms: number;
}

function mirrorOk(workosRequest: string, result: UpstreamResult, acc: Elapsed): MirrorResult {
  return {
    ok: true,
    workosRequest,
    status: result.status,
    ms: acc.ms,
    body: result.bodyText,
    error: null,
  };
}

function mirrorFail(
  workosRequest: string,
  result: UpstreamResult,
  acc: Elapsed,
  error: string,
): MirrorResult {
  return {
    ok: false,
    workosRequest,
    status: result.status,
    ms: acc.ms,
    body: result.bodyText,
    error,
  };
}

async function putWorkos(
  directory: Directory,
  kind: ResourceType,
  id: string,
  resource: Record<string, unknown>,
  acc: Elapsed,
  migratedId?: string,
): Promise<UpstreamResult> {
  const result = await scimFetch(
    joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(id)}`),
    {
      method: "PUT",
      token: directory.workos_token,
      body: JSON.stringify({ ...resource, id }),
      migratedId,
    },
  );
  acc.ms += result.ms;
  return result;
}

/**
 * The migrated-id contract (post-decoupling): only POST creates a WorkOS scim
 * row — PUT/PATCH/DELETE resolve strictly by id and 404 on a miss. So the
 * bridge runs the standard SCIM dance instead of relying on a create-if-absent
 * PUT:
 *   1. PUT /{kind}/{id} + X-WorkOS-Migrated-Id — updates in place when present.
 *   2. On 404 (expected first touch, not an error): POST /{kind} + the same
 *      header, which WorkOS adopts and echoes back as the resource id.
 *   3. On POST 409 (a concurrent create won the race): retry the PUT, which now
 *      resolves the winner's row — the bridge owns that race now.
 * When WorkOS does not honor the header (e.g. the external_id gate is off) the
 * POST mints its own id; the diverging echoed id is detected and recorded as a
 * `fallback-post` mapping so ids still translate in both directions.
 */
/**
 * Somewhere to queue id mappings instead of writing them one at a time.
 *
 * The live mirror passes nothing and writes immediately, because it handles one
 * resource per request and has nothing to batch with. The backfill passes an array
 * and flushes it per page — same rows, same order, one round trip.
 *
 * Deliberately a plain array rather than a callback: the caller needs to see what is
 * pending in order to report which resources a failed flush affected, and an array of
 * mapping rows already carries that identity.
 */
export type MappingSink = NewMapping[];

export async function mirrorUpsert(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  rawResource: Record<string, unknown>,
  sink?: MappingSink,
): Promise<MirrorResult> {
  // Every WorkOS-bound resource body funnels through here — live mirror,
  // backfill replay, and the workos-only create/replace legs — and does so after
  // id translation, so translated members survive the pass. PATCH deliberately
  // does not route through this function: a null inside `Operations` can be a
  // meaningful remove, and the reverse (WorkOS → native) replay stays verbatim.
  const resource = stripNulls(rawResource);
  const acc: Elapsed = { ms: 0 };
  try {
    // A resource WorkOS already knows: update it in place by the id it stored
    // (the shared migrated id, or a minted one for a fallback-post mapping).
    const existing = await getMapping(db, directory.id, kind, nativeId);
    if (existing) {
      const useHeader = existing.strategy === "migrated-id";
      const label = `PUT /${kind}/${existing.workos_id}${useHeader ? ` +${MIGRATED_ID_HEADER}` : " (fallback)"}`;
      const put = await putWorkos(
        directory,
        kind,
        existing.workos_id,
        resource,
        acc,
        useHeader ? nativeId : undefined,
      );
      if (isSuccess(put.status)) {
        await recordMapping(
          db,
          mappingRow(directory, kind, nativeId, existing.workos_id, existing.strategy),
          sink,
        );
        return mirrorOk(label, put, acc);
      }
      if (put.status !== 404) {
        return mirrorFail(label, put, acc, `WorkOS PUT returned ${put.status}`);
      }
      // The mapped resource is gone on WorkOS (e.g. the directory was cleaned) —
      // recreate it below. createViaPost's upsertMapping overwrites the stale row.
    } else {
      // First touch: try the migrated-id PUT. It 404s when absent (only POST
      // creates now) but succeeds if the row already exists under the shared id.
      const label = `PUT /${kind}/${nativeId} +${MIGRATED_ID_HEADER}`;
      const put = await putWorkos(directory, kind, nativeId, resource, acc, nativeId);
      if (isSuccess(put.status)) {
        await recordMapping(
          db,
          mappingRow(directory, kind, nativeId, nativeId, "migrated-id"),
          sink,
        );
        return mirrorOk(label, put, acc);
      }
      if (put.status !== 404) {
        return mirrorFail(label, put, acc, `WorkOS migrated-id PUT returned ${put.status}`);
      }
    }

    return createViaPost(db, directory, kind, nativeId, resource, acc, sink);
  } catch (error) {
    return {
      ok: false,
      workosRequest: `PUT /${kind}/${nativeId} +${MIGRATED_ID_HEADER}`,
      status: null,
      ms: acc.ms || null,
      body: null,
      error: errorMessage(error),
    };
  }
}

/**
 * The 404 leg of the dance: create the resource with POST + the migrated-id
 * header. WorkOS echoes the id back — equal to nativeId when it honored the
 * contract (`migrated-id`), or a freshly minted one otherwise (`fallback-post`).
 * A 409 means a concurrent create won the race, so re-PUT to resolve the winner.
 */
async function createViaPost(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  resource: Record<string, unknown>,
  acc: Elapsed,
  sink?: MappingSink,
): Promise<MirrorResult> {
  const label = `POST /${kind} +${MIGRATED_ID_HEADER}`;
  const { id: _omitted, ...stripped } = resource;
  const create = await scimFetch(joinScimUrl(directory.workos_url, `/${kind}`), {
    method: "POST",
    token: directory.workos_token,
    body: JSON.stringify(stripped),
    migratedId: nativeId,
  });
  acc.ms += create.ms;

  if (isSuccess(create.status)) {
    const created = parseJson(create.bodyText);
    const workosId = created && typeof created.id === "string" ? created.id : null;
    if (!workosId) {
      return mirrorFail(label, create, acc, "WorkOS POST succeeded but the response had no id");
    }
    // The echoed id decides the contract outcome: identical id ⇒ WorkOS adopted
    // the migrated id; a different id ⇒ it minted its own (contract not honored).
    const strategy = workosId === nativeId ? "migrated-id" : "fallback-post";
    await recordMapping(db, mappingRow(directory, kind, nativeId, workosId, strategy), sink);
    return mirrorOk(label, create, acc);
  }

  if (create.status === 409) {
    return resolveCreateRace(db, directory, kind, nativeId, resource, create, acc, sink);
  }

  return mirrorFail(label, create, acc, `WorkOS POST returned ${create.status}`);
}

/**
 * POST 409: either a concurrent create won the race under the same migrated id
 * (re-PUT now resolves it → `migrated-id`), or the contract is off and a row
 * with the same userName/displayName already exists under a minted id we don't
 * know (the re-PUT 404s, so look it up by filter and map it → `fallback-post`).
 */
async function resolveCreateRace(
  db: Datastore,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  resource: Record<string, unknown>,
  create: UpstreamResult,
  acc: Elapsed,
  sink?: MappingSink,
): Promise<MirrorResult> {
  const reputLabel = `PUT /${kind}/${nativeId} +${MIGRATED_ID_HEADER} (409 retry)`;
  const reput = await putWorkos(directory, kind, nativeId, resource, acc, nativeId);
  if (isSuccess(reput.status)) {
    await recordMapping(db, mappingRow(directory, kind, nativeId, nativeId, "migrated-id"), sink);
    return mirrorOk(reputLabel, reput, acc);
  }
  if (reput.status !== 404) {
    return mirrorFail(reputLabel, reput, acc, `WorkOS 409-retry PUT returned ${reput.status}`);
  }

  const attribute = kind === "Users" ? "userName" : "displayName";
  const value = resource[attribute];
  const lookupLabel = `GET /${kind}?filter=${attribute} (409 recovery)`;
  if (typeof value === "string" && value !== "") {
    const filter = `${attribute} eq "${value.replaceAll('"', '\\"')}"`;
    const lookup = await scimFetch(
      `${joinScimUrl(directory.workos_url, `/${kind}`)}?filter=${encodeURIComponent(filter)}`,
      { method: "GET", token: directory.workos_token },
    );
    acc.ms += lookup.ms;
    const listing = parseJson(lookup.bodyText);
    const resources = listing && Array.isArray(listing.Resources) ? listing.Resources : [];
    const first = resources.find(isRecord);
    const workosId = first && typeof first.id === "string" ? first.id : null;
    if (isSuccess(lookup.status) && workosId) {
      // Write the resource content onto the existing row (a plain replace by its
      // minted id) so it actually syncs, and so the returned body is the resource
      // rather than the search page. Then record the diverging-id mapping.
      const syncLabel = `PUT /${kind}/${workosId} (409 recovery)`;
      const sync = await putWorkos(directory, kind, workosId, resource, acc);
      if (isSuccess(sync.status)) {
        await recordMapping(
          db,
          mappingRow(directory, kind, nativeId, workosId, "fallback-post"),
          sink,
        );
        return mirrorOk(syncLabel, sync, acc);
      }
      return mirrorFail(syncLabel, sync, acc, `WorkOS 409-recovery PUT returned ${sync.status}`);
    }
  }
  return mirrorFail(
    lookupLabel,
    create,
    acc,
    `WorkOS POST hit 409 and the ${attribute} lookup did not recover an id`,
  );
}

/** Queue the mapping when the caller is batching, write it when it is not. */
async function recordMapping(
  db: Datastore,
  mapping: NewMapping,
  sink: MappingSink | undefined,
): Promise<void> {
  if (sink) {
    sink.push(mapping);
    return;
  }
  await upsertMapping(db, mapping);
}

function mappingRow(
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  workosId: string,
  strategy: IdMapping["strategy"],
): Pick<IdMapping, "directory_id" | "resource_type" | "native_id" | "workos_id" | "strategy"> {
  return {
    directory_id: directory.id,
    resource_type: kind,
    native_id: nativeId,
    workos_id: workosId,
    strategy,
  };
}
