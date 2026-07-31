import { getDirectoryByToken } from "../shared/db";
import type { Directory, PocEnv } from "../shared/types";

export const STATUS_PREFIX = "/status/directories";

/** How long a listener may cache a status response before revalidating. Kept
 *  short so a mode flip (cutover or rollback) propagates within seconds. */
const CACHE_MAX_AGE_SECONDS = 5;

export interface DirectoryStatus {
  directory_id: string;
  workos_directory_id: string | null;
  mode: Directory["mode"];
  native_authoritative: boolean;
  updated_at: string;
}

/**
 * GET /status/directories/{id} — the migration-mode status of one directory,
 * for the customer's native app's DSync event listener: while the native app is
 * authoritative (before cutover) it must keep ignoring DSync events, and once
 * WorkOS is authoritative (workos-only) it must apply them.
 *
 * Authenticated by the directory's own proxy token — the same credential the
 * IdP presents to the /scim/v2 data-plane — so a token can only ever read the
 * status of its own directory. `{id}` accepts the bridge's directory id or the
 * directory's WorkOS id (`workos_directory_id`, when set), the id DSync
 * webhook events carry in `event.data.directory_id`.
 */
export async function handleStatus(request: Request, env: PocEnv, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return statusError(405, "The status endpoint only accepts GET.");
  }

  const rest = url.pathname.slice(STATUS_PREFIX.length);
  const segments = rest.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return statusError(404, `Nothing is served at ${url.pathname}. Try ${STATUS_PREFIX}/{id}.`);
  }
  const requestedId = decodeURIComponent(segments[0]);

  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  let directory: Directory | null;
  try {
    directory = await getDirectoryByToken(env.DB, token);
  } catch {
    return statusError(500, "The proxy could not resolve the directory for this token.");
  }
  if (!directory) {
    return statusError(
      401,
      "The bearer token in the Authorization header does not match any proxy directory.",
    );
  }
  // A token only reads its own directory; any other id 404s so tokens can't
  // probe which directory ids exist.
  if (requestedId !== directory.id && requestedId !== directory.workos_directory_id) {
    return statusError(404, `This token's directory is not ${requestedId}.`);
  }

  const body: DirectoryStatus = {
    directory_id: directory.id,
    workos_directory_id: directory.workos_directory_id,
    mode: directory.mode,
    native_authoritative: directory.mode !== "workos-only",
    updated_at: directory.updated_at,
  };
  // SQLite's datetime('now') contains a space, which is not a valid ETag
  // character (RFC 7232), so it is folded to a T.
  const etag = `"${directory.mode}:${directory.updated_at.replaceAll(" ", "T")}"`;
  const headers = {
    ETag: etag,
    "Cache-Control": `private, max-age=${CACHE_MAX_AGE_SECONDS}`,
  };
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(body, { headers });
}

function statusError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
