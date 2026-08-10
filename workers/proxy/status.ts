import { getDirectoryByToken } from "../shared/db";
import { authorizationToken } from "../shared/scim";
import { nativeIsAuthoritative, type Directory, type PocEnv } from "../shared/types";

export const STATUS_PREFIX = "/status/directories";

/** How long a listener may cache a status response before revalidating. Kept
 *  short so a mode flip (cutover or rollback) propagates within seconds. */
const CACHE_MAX_AGE_SECONDS = 5;

export interface DirectoryStatus {
  directory_id: string;
  workos_directory_id: string | null;
  mode: Directory["mode"];
  /** Who owns the directory's data. Descriptive — for display and reporting.
   *  NOT an instruction: see `apply_dsync_events`. */
  native_authoritative: boolean;
  /** What the listener must do with a DSync event for this directory. This is
   *  the field a listener keys on. */
  apply_dsync_events: boolean;
  updated_at: string;
}

/**
 * Whether a listener should apply DSync events for a directory in this mode.
 *
 * This is NOT `!native_authoritative`, and `workos-primary` is the mode
 * that proves it: WorkOS answers the IdP, so native is not authoritative, and yet
 * the proxy still writes native directly on every request — a listener that also
 * applied the events would process every change twice. Both fields are `false`
 * there, which is the shape no earlier mode could produce.
 *
 * Keep this the single place the instruction is decided, and keep it exported —
 * the ETag has to be computed from the same value the body carries.
 */
export function appliesDsyncEvents(mode: Directory["mode"]): boolean {
  return mode === "workos-only";
}

/**
 * GET /status/directories/{id} — the migration-mode status of one directory,
 * for the customer's native app's DSync event listener: `apply_dsync_events`
 * tells the listener whether to apply an event or stay inert. In every mode but
 * `workos-only` the proxy writes the native app directly, so applying a WorkOS
 * echo would fight that write path; in `workos-only` the listener is how the
 * native app learns about changes. Note that this is not the same line as
 * "who is authoritative": on `workos-primary` WorkOS is, and the listener still
 * stays inert.
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
  let requestedId: string;
  try {
    requestedId = decodeURIComponent(segments[0]);
  } catch {
    return statusError(404, `Nothing is served at ${url.pathname}. Try ${STATUS_PREFIX}/{id}.`);
  }

  const token = authorizationToken(request.headers.get("Authorization"));
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

  const applyDsyncEvents = appliesDsyncEvents(directory.mode);
  const body: DirectoryStatus = {
    directory_id: directory.id,
    workos_directory_id: directory.workos_directory_id,
    mode: directory.mode,
    native_authoritative: nativeIsAuthoritative(directory.mode),
    apply_dsync_events: applyDsyncEvents,
    updated_at: directory.updated_at,
  };
  // Covers every field of the representation: mode and workos_directory_id
  // directly, updated_at for anything else. SQLite's datetime('now') contains
  // a space, which is not a valid ETag character (RFC 7232), so it is folded
  // to a T.
  //
  // `apply_dsync_events` is carried EXPLICITLY rather than left to the mode
  // segment that happens to determine it today. Two reasons, both about the
  // worst bug this endpoint can have — a 304 that withholds a changed
  // instruction:
  //  1. Across the deploy that added the field, the representation changes
  //     while mode and updated_at do not. Without a new segment a listener
  //     holding a pre-deploy validator would get a 304 and keep a cached body
  //     that has no `apply_dsync_events` in it at all.
  //  2. It makes the property structural instead of incidental. If the
  //     instruction ever stops being a pure function of mode (a per-directory
  //     pause switch, say), the validator still changes with it — nobody has to
  //     remember to come back here.
  // A redundant ETag segment can only cost an extra 200; it can never withhold
  // a change.
  const etag = `"${directory.mode}:${directory.workos_directory_id ?? ""}:${directory.updated_at.replaceAll(" ", "T")}:apply=${applyDsyncEvents ? "1" : "0"}"`;
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
