import type { Directory, PocEnv, ResourceType } from "../shared/types";
import {
  deleteMapping,
  getDirectoryByToken,
  insertProxyLog,
  type ProxyLogInsert,
  shouldPersistLogs,
} from "../shared/db";
import {
  SCIM_CONTENT_TYPE,
  SCIM_PREFIX,
  errorMessage,
  isSuccess,
  joinScimUrl,
  loadIdMaps,
  makeTranslator,
  mirrorUpsert,
  parseJson,
  parseScimPath,
  scimError,
  scimFetch,
  translateListResponse,
  translatePatchIds,
  translateResourceIds,
  type MirrorResult,
  type ScimPath,
  type UpstreamResult,
} from "../shared/scim";
import { handleStatus, STATUS_PREFIX } from "./status";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODYLESS_STATUSES = new Set([204, 205, 304]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({ service: "scim-migration-proxy" });
    }
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    if (url.pathname === SCIM_PREFIX || url.pathname.startsWith(`${SCIM_PREFIX}/`)) {
      return handleScim(request, env, ctx, url);
    }
    if (url.pathname === STATUS_PREFIX || url.pathname.startsWith(`${STATUS_PREFIX}/`)) {
      return handleStatus(request, env, url);
    }
    return scimError(404, `Nothing is served at ${url.pathname}.`);
  },
} satisfies ExportedHandler<PocEnv>;

async function handleScim(
  request: Request,
  env: PocEnv,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const rawBody = await request.text();
  const requestBody = rawBody === "" ? null : rawBody;
  const scimPath = parseScimPath(url.pathname);

  const log: ProxyLogInsert = {
    mode: "unknown",
    method,
    path: `${url.pathname.slice(SCIM_PREFIX.length) || "/"}${url.search}`,
    request_body: requestBody,
  };
  const finish = (response: Response): Response => {
    log.response_status = response.status;
    if (shouldPersistLogs(directory)) ctx.waitUntil(insertProxyLog(env.DB, log).catch(() => {}));
    return response;
  };

  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  let directory: Directory | null = null;
  try {
    directory = await getDirectoryByToken(env.DB, token);
  } catch (error) {
    log.error = errorMessage(error);
    return finish(scimError(500, "The proxy could not resolve the directory for this token."));
  }
  if (!directory) {
    log.error = "missing or unknown proxy bearer token";
    return finish(
      scimError(
        401,
        "The bearer token in the Authorization header does not match any proxy directory.",
      ),
    );
  }
  log.directory_id = directory.id;
  log.mode = directory.mode;

  if (!scimPath) {
    return finish(
      scimError(
        404,
        `The proxy does not serve ${url.pathname}. Expected /Users, /Groups, /ServiceProviderConfig, /Schemas, or /ResourceTypes under ${SCIM_PREFIX}.`,
      ),
    );
  }

  const contentType = request.headers.get("Content-Type");
  const isWrite = WRITE_METHODS.has(method) && scimPath.kind !== null;

  if (directory.mode === "passthrough" || (directory.mode === "dual-write" && !isWrite)) {
    let native: UpstreamResult;
    try {
      native = await scimFetch(joinScimUrl(directory.native_url, scimPath.rest) + url.search, {
        method,
        token: directory.native_token,
        body: requestBody,
        contentType,
      });
    } catch (error) {
      log.error = errorMessage(error);
      return finish(scimError(502, "The native SCIM endpoint could not be reached."));
    }
    log.native_status = native.status;
    log.native_ms = native.ms;
    log.native_body = native.bodyText;
    return finish(
      upstreamResponse(native, {
        upstreamBase: directory.native_url,
        proxyBase: proxyBaseUrl(url),
      }),
    );
  }

  if (directory.mode === "dual-write") {
    return dualWrite(env, ctx, directory, scimPath, method, requestBody, contentType, url, log);
  }

  return workosOnly(
    env,
    ctx,
    directory,
    scimPath,
    method,
    requestBody,
    contentType,
    url,
    log,
    finish,
  );
}

async function dualWrite(
  env: PocEnv,
  ctx: ExecutionContext,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  url: URL,
  log: ProxyLogInsert,
): Promise<Response> {
  let native: UpstreamResult;
  try {
    native = await scimFetch(joinScimUrl(directory.native_url, scimPath.rest) + url.search, {
      method,
      token: directory.native_token,
      body: requestBody,
      contentType,
    });
  } catch (error) {
    log.error = errorMessage(error);
    log.response_status = 502;
    if (shouldPersistLogs(directory)) ctx.waitUntil(insertProxyLog(env.DB, log).catch(() => {}));
    return scimError(502, "The native SCIM endpoint could not be reached.");
  }
  log.native_status = native.status;
  log.native_ms = native.ms;
  log.native_body = native.bodyText;
  log.response_status = native.status;

  const response = upstreamResponse(native, {
    upstreamBase: directory.native_url,
    proxyBase: proxyBaseUrl(url),
  });
  ctx.waitUntil(
    (async () => {
      if (isSuccess(native.status)) {
        try {
          await mirrorDualWrite(env.DB, directory, scimPath, method, requestBody, native, log);
        } catch (error) {
          log.error = `mirror failed: ${errorMessage(error)}`;
        }
      }
      if (shouldPersistLogs(directory)) await insertProxyLog(env.DB, log).catch(() => {});
    })(),
  );
  return response;
}

async function mirrorDualWrite(
  db: D1Database,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  native: UpstreamResult,
  log: ProxyLogInsert,
): Promise<void> {
  const kind = scimPath.kind as ResourceType;
  const maps = await loadIdMaps(db, directory.id);
  const translate = makeTranslator(maps.nativeToWorkos);

  if (method === "POST") {
    const created = parseJson(native.bodyText);
    const nativeId = created && typeof created.id === "string" ? created.id : null;
    if (!nativeId) {
      log.error = "native create response had no id; mirror skipped";
      return;
    }
    const resource = parseJson(requestBody) ?? {};
    const body = kind === "Groups" ? translateResourceIds(resource, kind, translate) : resource;
    applyMirrorResult(log, await mirrorUpsert(db, directory, kind, nativeId, body));
    return;
  }

  const nativeId = scimPath.id;
  if (!nativeId) return;

  if (method === "PUT") {
    const resource = parseJson(requestBody) ?? {};
    const body = kind === "Groups" ? translateResourceIds(resource, kind, translate) : resource;
    applyMirrorResult(log, await mirrorUpsert(db, directory, kind, nativeId, body));
    return;
  }

  const workosId = translate(kind, nativeId);
  const target = joinScimUrl(directory.workos_url, `/${kind}/${encodeURIComponent(workosId)}`);

  if (method === "PATCH") {
    const translated = translatePatchIds(parseJson(requestBody), kind, translate);
    log.workos_request = `PATCH /${kind}/${workosId}`;
    const mirror = await scimFetch(target, {
      method: "PATCH",
      token: directory.workos_token,
      body: translated ? JSON.stringify(translated) : requestBody,
    });
    applyWorkosLeg(log, mirror);
    return;
  }

  if (method === "DELETE") {
    log.workos_request = `DELETE /${kind}/${workosId}`;
    const mirror = await scimFetch(target, { method: "DELETE", token: directory.workos_token });
    applyWorkosLeg(log, mirror);
    if (isSuccess(mirror.status) || mirror.status === 404) {
      await deleteMapping(db, directory.id, kind, nativeId);
    } else {
      log.error = `mirror DELETE returned ${mirror.status}; id mapping kept for repair`;
    }
  }
}

async function workosOnly(
  env: PocEnv,
  _ctx: ExecutionContext,
  directory: Directory,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  url: URL,
  log: ProxyLogInsert,
  finish: (response: Response) => Response,
): Promise<Response> {
  const kind = scimPath.kind;
  let outPath = scimPath.rest;
  let outBody = requestBody;
  let toNative: ((kind: ResourceType, id: string) => string) | null = null;

  if (kind) {
    const maps = await loadIdMaps(env.DB, directory.id);
    const toWorkos = makeTranslator(maps.nativeToWorkos);
    toNative = makeTranslator(maps.workosToNative);
    // A create after cutover must still mint a migrated id (not let WorkOS
    // assign a native one), or the new resource can't be referenced by the
    // migrated ids the rest of the directory uses — e.g. group membership.
    if (method === "POST") {
      return finish(
        await createWithMigratedId(env.DB, directory, kind, requestBody, toWorkos, log),
      );
    }
    // A replace runs the same PUT → 404 → POST dance as the mirror leg: WorkOS
    // no longer creates on PUT, so a first-touch replace self-heals into a POST
    // create instead of surfacing a 404 to the IdP.
    if (method === "PUT" && scimPath.id) {
      return finish(
        await replaceWithMigratedId(
          env.DB,
          directory,
          kind,
          scimPath.id,
          requestBody,
          toWorkos,
          log,
        ),
      );
    }
    if (scimPath.id) {
      const targetId = toWorkos(kind, scimPath.id);
      outPath = `/${kind}/${encodeURIComponent(targetId)}`;
    }
    if (outBody != null && method === "PATCH") {
      const translated = translatePatchIds(parseJson(outBody), kind, toWorkos);
      if (translated) outBody = JSON.stringify(translated);
    }
  }

  log.workos_request = `${method} ${outPath}${url.search}`;
  let workos: UpstreamResult;
  try {
    workos = await scimFetch(joinScimUrl(directory.workos_url, outPath) + url.search, {
      method,
      token: directory.workos_token,
      body: outBody,
      contentType,
    });
  } catch (error) {
    log.error = errorMessage(error);
    return finish(scimError(502, "The WorkOS SCIM endpoint could not be reached."));
  }
  applyWorkosLeg(log, workos);

  // Prune the mapping the same way the dual-write mirror does, so the table
  // never claims a deleted resource is live. A 404 counts: the resource is gone
  // on the WorkOS side either way.
  if (method === "DELETE" && kind && scimPath.id) {
    if (isSuccess(workos.status) || workos.status === 404) {
      // The WorkOS delete already committed, so a failed prune must not turn a
      // completed delete into an error for the IdP — log it and let the next
      // write self-heal the row.
      try {
        await deleteMapping(env.DB, directory.id, kind, scimPath.id);
      } catch (error) {
        log.error = `id mapping prune failed: ${errorMessage(error)}`;
      }
    } else {
      log.error = `WorkOS DELETE returned ${workos.status}; id mapping kept for repair`;
    }
  }

  const forward: ForwardOptions = {
    upstreamBase: directory.workos_url,
    proxyBase: proxyBaseUrl(url),
  };
  if (!kind || !toNative || method === "POST") {
    return finish(upstreamResponse(workos, forward));
  }
  const translateId = toNative;
  const idForward: ForwardOptions = {
    ...forward,
    bodyRewritten: true,
    toIdpId: (id) => translateId(kind, id),
  };
  const parsed = parseJson(workos.bodyText);
  if (!parsed) {
    return finish(upstreamResponse(workos, idForward));
  }
  const rewritten = Array.isArray(parsed.Resources)
    ? translateListResponse(parsed, kind, toNative)
    : translateResourceIds(parsed, kind, toNative);
  return finish(
    new Response(JSON.stringify(rewritten), {
      status: workos.status,
      headers: proxiedHeaders(workos, idForward),
    }),
  );
}

/**
 * Create a resource after cutover using the migrated-id contract: mint a stable
 * id, translate any group members to WorkOS ids, and run the mirror dance
 * (POST + X-WorkOS-Migrated-Id) so the new resource joins the same id scheme as
 * everything backfill mirrored. The minted id is echoed back so the caller (IdP)
 * records it for later references, with SCIM create semantics (201) regardless of
 * which leg of the dance resolved.
 */
async function createWithMigratedId(
  db: D1Database,
  directory: Directory,
  kind: ResourceType,
  requestBody: string | null,
  toWorkos: (kind: ResourceType, id: string) => string,
  log: ProxyLogInsert,
): Promise<Response> {
  const parsed = parseJson(requestBody) ?? {};
  const body = kind === "Groups" ? translateResourceIds(parsed, kind, toWorkos) : parsed;
  delete body.id;
  // Derive the id from the IdP's externalId, so the native app — which learns of
  // this create via a DSync webhook carrying that same externalId — and WorkOS
  // all address the resource by one shared id. Without this, a resource born in
  // workos-only gets a random id the native app never sees, and a later rollback
  // to a native-writing mode can't target it (404) and backfill 409s. Works for
  // groups too: WorkOS surfaces a group's idp_id as its displayName but stores
  // the externalId (raw_attributes.externalId), which the native listener reads.
  const externalId = typeof body.externalId === "string" ? body.externalId : null;
  const mintedId = externalId ?? crypto.randomUUID();
  const result = await mirrorUpsert(db, directory, kind, mintedId, body);
  applyMirrorResult(log, result);
  if (!result.ok) {
    return scimError(
      result.status && result.status >= 400 ? result.status : 502,
      `The WorkOS endpoint rejected the migrated-id create: ${result.error ?? "unknown error"}.`,
    );
  }
  const created = parseJson(result.body) ?? { ...body, id: mintedId };
  created.id = mintedId;
  // A create always answers the IdP with 201, even when the dance resolved on a
  // PUT leg (200) because the resource already sat under the minted id. That id
  // is derived from the IdP's externalId, so resolving is an idempotent create of
  // the same logical resource, not a conflict. Symmetric with the replace path,
  // which always answers 200 even when it self-heals via a POST create.
  return new Response(JSON.stringify(created), {
    status: 201,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

/**
 * Replace a resource the IdP addresses by its migrated id. Runs the same
 * PUT → 404 → POST dance as the mirror leg (via mirrorUpsert), then echoes the
 * result back in native-id space so the IdP only ever sees its own id.
 */
async function replaceWithMigratedId(
  db: D1Database,
  directory: Directory,
  kind: ResourceType,
  nativeId: string,
  requestBody: string | null,
  toWorkos: (kind: ResourceType, id: string) => string,
  log: ProxyLogInsert,
): Promise<Response> {
  const parsed = parseJson(requestBody) ?? {};
  // Group member values are written in WorkOS-id space; the top-level id is
  // keyed off the path (nativeId), so mirrorUpsert owns it.
  const body = kind === "Groups" ? translateResourceIds(parsed, kind, toWorkos) : parsed;
  const result = await mirrorUpsert(db, directory, kind, nativeId, body);
  applyMirrorResult(log, result);
  if (!result.ok) {
    return scimError(
      result.status && result.status >= 400 ? result.status : 502,
      `The WorkOS endpoint rejected the migrated-id replace: ${result.error ?? "unknown error"}.`,
    );
  }
  // Reload after the write so a freshly created resource's mapping is visible,
  // then translate the response back to native ids for the IdP.
  const maps = await loadIdMaps(db, directory.id);
  const toNative = makeTranslator(maps.workosToNative);
  const workosResponse = parseJson(result.body) ?? { ...body, id: nativeId };
  const rewritten = translateResourceIds(workosResponse, kind, toNative);
  rewritten.id = nativeId;
  // A replace always answers the IdP with 200, even when it self-healed via a
  // POST create (201) — the IdP issued a PUT and SCIM replies to it with 200.
  return new Response(JSON.stringify(rewritten), {
    status: 200,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

interface ForwardOptions {
  /** SCIM base URL of the upstream that produced the response. */
  upstreamBase: string;
  /** SCIM base URL the IdP addresses the proxy by. */
  proxyBase: string;
  /**
   * Set when the proxy re-serializes the body (id translation), which makes an
   * upstream ETag describe a payload the IdP never receives.
   */
  bodyRewritten?: boolean;
  /** Maps an upstream resource id back into the id space the IdP addresses. */
  toIdpId?: (id: string) => string;
}

function upstreamResponse(result: UpstreamResult, forward: ForwardOptions): Response {
  const body = BODYLESS_STATUSES.has(result.status) ? null : result.bodyText;
  return new Response(body, {
    status: result.status,
    headers: proxiedHeaders(result, forward),
  });
}

function proxiedHeaders(result: UpstreamResult, forward: ForwardOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": result.contentType ?? SCIM_CONTENT_TYPE,
  };
  for (const [name, value] of Object.entries(result.headers)) {
    if (name === "ETag") {
      if (!forward.bodyRewritten) headers.ETag = value;
      continue;
    }
    if (name === "Location") {
      const rewritten = rewriteLocation(value, forward);
      if (rewritten) headers.Location = rewritten;
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

/**
 * Re-point an upstream Location at the proxy. The IdP only knows the proxy's
 * SCIM base URL and its own id space, so a Location naming the native app or
 * WorkOS directly would send it around the proxy — and, after cutover, at a
 * WorkOS id it never issued. Anything that does not sit under the upstream's
 * own SCIM base cannot be rewritten safely and is dropped rather than leaked.
 */
function rewriteLocation(value: string, forward: ForwardOptions): string | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(forward.upstreamBase);
    target = new URL(value, base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return null;
  let rest = target.pathname.slice(basePath.length);
  if (forward.toIdpId) {
    let segments: string[];
    try {
      segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    if (segments.length !== 2) return null;
    rest = `/${segments[0]}/${encodeURIComponent(forward.toIdpId(segments[1]))}`;
  }
  return `${forward.proxyBase}${rest}${target.search}`;
}

function proxyBaseUrl(url: URL): string {
  return `${url.origin}${SCIM_PREFIX}`;
}

function applyMirrorResult(log: ProxyLogInsert, result: MirrorResult): void {
  log.workos_request = result.workosRequest;
  log.workos_status = result.status;
  log.workos_ms = result.ms;
  log.workos_body = result.body;
  if (result.error) log.error = result.error;
}

function applyWorkosLeg(log: ProxyLogInsert, result: UpstreamResult): void {
  log.workos_status = result.status;
  log.workos_ms = result.ms;
  log.workos_body = result.bodyText;
}
