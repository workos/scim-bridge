import type { Connection, PocEnv, ResourceType } from "../shared/types";
import { MIGRATED_ID_HEADER } from "../shared/types";
import {
  deleteMapping,
  getConnectionByToken,
  insertProxyLog,
  type ProxyLogInsert,
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
    ctx.waitUntil(insertProxyLog(env.DB, log).catch(() => {}));
    return response;
  };

  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  let connection: Connection | null = null;
  try {
    connection = await getConnectionByToken(env.DB, token);
  } catch (error) {
    log.error = errorMessage(error);
    return finish(scimError(500, "The proxy could not resolve the connection for this token."));
  }
  if (!connection) {
    log.error = "missing or unknown proxy bearer token";
    return finish(
      scimError(
        401,
        "The bearer token in the Authorization header does not match any proxy connection.",
      ),
    );
  }
  log.connection_id = connection.id;
  log.mode = connection.mode;

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

  if (
    connection.mode === "passthrough" ||
    (connection.mode === "dualwrite-native-first" && !isWrite)
  ) {
    let native: UpstreamResult;
    try {
      native = await scimFetch(joinScimUrl(connection.native_url, scimPath.rest) + url.search, {
        method,
        token: connection.native_token,
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
    return finish(upstreamResponse(native));
  }

  if (connection.mode === "dualwrite-native-first") {
    return dualWrite(env, ctx, connection, scimPath, method, requestBody, contentType, url, log);
  }

  return workosOnly(
    env,
    ctx,
    connection,
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
  connection: Connection,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  contentType: string | null,
  url: URL,
  log: ProxyLogInsert,
): Promise<Response> {
  let native: UpstreamResult;
  try {
    native = await scimFetch(joinScimUrl(connection.native_url, scimPath.rest) + url.search, {
      method,
      token: connection.native_token,
      body: requestBody,
      contentType,
    });
  } catch (error) {
    log.error = errorMessage(error);
    log.response_status = 502;
    ctx.waitUntil(insertProxyLog(env.DB, log).catch(() => {}));
    return scimError(502, "The native SCIM endpoint could not be reached.");
  }
  log.native_status = native.status;
  log.native_ms = native.ms;
  log.native_body = native.bodyText;
  log.response_status = native.status;

  const response = upstreamResponse(native);
  ctx.waitUntil(
    (async () => {
      if (isSuccess(native.status)) {
        try {
          await mirrorDualWrite(env.DB, connection, scimPath, method, requestBody, native, log);
        } catch (error) {
          log.error = `mirror failed: ${errorMessage(error)}`;
        }
      }
      await insertProxyLog(env.DB, log).catch(() => {});
    })(),
  );
  return response;
}

async function mirrorDualWrite(
  db: D1Database,
  connection: Connection,
  scimPath: ScimPath,
  method: string,
  requestBody: string | null,
  native: UpstreamResult,
  log: ProxyLogInsert,
): Promise<void> {
  const kind = scimPath.kind as ResourceType;
  const maps = await loadIdMaps(db, connection.id);
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
    applyMirrorResult(log, await mirrorUpsert(db, connection, kind, nativeId, body));
    return;
  }

  const nativeId = scimPath.id;
  if (!nativeId) return;

  if (method === "PUT") {
    const resource = parseJson(requestBody) ?? {};
    const body = kind === "Groups" ? translateResourceIds(resource, kind, translate) : resource;
    applyMirrorResult(log, await mirrorUpsert(db, connection, kind, nativeId, body));
    return;
  }

  const workosId = translate(kind, nativeId);
  const target = joinScimUrl(connection.workos_url, `/${kind}/${encodeURIComponent(workosId)}`);

  if (method === "PATCH") {
    const translated = translatePatchIds(parseJson(requestBody), kind, translate);
    log.workos_request = `PATCH /${kind}/${workosId}`;
    const mirror = await scimFetch(target, {
      method: "PATCH",
      token: connection.workos_token,
      body: translated ? JSON.stringify(translated) : requestBody,
    });
    applyWorkosLeg(log, mirror);
    return;
  }

  if (method === "DELETE") {
    log.workos_request = `DELETE /${kind}/${workosId}`;
    const mirror = await scimFetch(target, { method: "DELETE", token: connection.workos_token });
    applyWorkosLeg(log, mirror);
    if (isSuccess(mirror.status) || mirror.status === 404) {
      await deleteMapping(db, connection.id, kind, nativeId);
    } else {
      log.error = `mirror DELETE returned ${mirror.status}; id mapping kept for repair`;
    }
  }
}

async function workosOnly(
  env: PocEnv,
  _ctx: ExecutionContext,
  connection: Connection,
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
  let migratedId: string | undefined;

  if (kind) {
    const maps = await loadIdMaps(env.DB, connection.id);
    const toWorkos = makeTranslator(maps.nativeToWorkos);
    toNative = makeTranslator(maps.workosToNative);
    // A create after cutover must still mint a migrated id (not let WorkOS
    // assign a native one), or the new resource can't be referenced by the
    // migrated ids the rest of the directory uses — e.g. group membership.
    if (method === "POST") {
      return finish(
        await createWithMigratedId(env.DB, connection, kind, requestBody, toWorkos, log),
      );
    }
    if (scimPath.id) {
      const targetId = toWorkos(kind, scimPath.id);
      outPath = `/${kind}/${encodeURIComponent(targetId)}`;
      // The migrated-id contract holds after cutover too: a replace must stay
      // create-if-absent so resources that missed their mirror leg self-heal.
      if (method === "PUT") migratedId = targetId;
    }
    if (outBody != null && (method === "PUT" || method === "POST")) {
      const parsed = parseJson(outBody);
      if (parsed) {
        const translated = translateResourceIds(parsed, kind, toWorkos);
        if (method === "POST") delete translated.id;
        outBody = JSON.stringify(translated);
      }
    } else if (outBody != null && method === "PATCH") {
      const translated = translatePatchIds(parseJson(outBody), kind, toWorkos);
      if (translated) outBody = JSON.stringify(translated);
    }
  }

  log.workos_request =
    `${method} ${outPath}${url.search}` + (migratedId != null ? ` +${MIGRATED_ID_HEADER}` : "");
  let workos: UpstreamResult;
  try {
    workos = await scimFetch(joinScimUrl(connection.workos_url, outPath) + url.search, {
      method,
      token: connection.workos_token,
      body: outBody,
      contentType,
      migratedId,
    });
  } catch (error) {
    log.error = errorMessage(error);
    return finish(scimError(502, "The WorkOS SCIM endpoint could not be reached."));
  }
  applyWorkosLeg(log, workos);

  if (!kind || !toNative || method === "POST") {
    return finish(upstreamResponse(workos));
  }
  const parsed = parseJson(workos.bodyText);
  if (!parsed) {
    return finish(upstreamResponse(workos));
  }
  const rewritten = Array.isArray(parsed.Resources)
    ? translateListResponse(parsed, kind, toNative)
    : translateResourceIds(parsed, kind, toNative);
  return finish(
    new Response(JSON.stringify(rewritten), {
      status: workos.status,
      headers: { "Content-Type": workos.contentType ?? SCIM_CONTENT_TYPE },
    }),
  );
}

/**
 * Create a resource after cutover using the migrated-id contract: mint a stable
 * id, translate any group members to WorkOS ids, and PUT create-if-absent so the
 * new resource joins the same id scheme as everything backfill mirrored. The
 * minted id is echoed back so the caller (IdP) records it for later references.
 */
async function createWithMigratedId(
  db: D1Database,
  connection: Connection,
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
  const result = await mirrorUpsert(db, connection, kind, mintedId, body);
  applyMirrorResult(log, result);
  if (!result.ok) {
    return scimError(
      result.status && result.status >= 400 ? result.status : 502,
      `The WorkOS endpoint rejected the migrated-id create: ${result.error ?? "unknown error"}.`,
    );
  }
  const created = parseJson(result.body) ?? { ...body, id: mintedId };
  created.id = mintedId;
  return new Response(JSON.stringify(created), {
    status: result.status ?? 201,
    headers: { "Content-Type": SCIM_CONTENT_TYPE },
  });
}

function upstreamResponse(result: UpstreamResult): Response {
  const body = BODYLESS_STATUSES.has(result.status) ? null : result.bodyText;
  return new Response(body, {
    status: result.status,
    headers: { "Content-Type": result.contentType ?? SCIM_CONTENT_TYPE },
  });
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
