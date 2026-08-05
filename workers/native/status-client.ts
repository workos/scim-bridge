import { getConfig } from "../shared/db";
import { clientTokenFor } from "../shared/client-tokens";
import type { Datastore } from "../shared/datastore";
import type { Directory } from "../shared/types";
import type { DirectoryStatus } from "../proxy/status";

/** How long a fetched status stays fresh before revalidating. Matches the
 *  endpoint's Cache-Control so a mode flip propagates within seconds. */
const TTL_MS = 5_000;
const FETCH_TIMEOUT_MS = 2_000;

/**
 * A status payload as *received*, which is not the same type as one we serve.
 * A listener may be talking to a bridge older than itself, so every field the
 * contract has gained since the endpoint shipped is optional here.
 * `apply_dsync_events` (ENT-6768) is the first; callers must handle its absence
 * rather than assume this bridge wrote the response.
 */
export type ReceivedDirectoryStatus = Omit<DirectoryStatus, "apply_dsync_events"> & {
  apply_dsync_events?: boolean;
};

interface CacheEntry {
  status: ReceivedDirectoryStatus;
  etag: string | null;
  freshUntil: number;
}

const cache = new Map<string, CacheEntry>();
// Failed lookups back off for a TTL too, so a burst of events doesn't pay the
// fetch timeout once per event while the endpoint is unreachable.
const failedUntil = new Map<string, number>();

/**
 * Read a directory's migration-mode status from the proxy's
 * `GET /status/directories/{id}` endpoint, authenticated by that directory's
 * proxy token — the contract a customer's own DSync listener uses to decide
 * whether to handle or ignore an event. Responses are cached briefly and
 * revalidated with `If-None-Match`, since the listener asks once per event.
 *
 * Returns null when the endpoint can't be reached or answers with an error
 * (e.g. under `npm run dev`, where only the panel is mounted) — the caller
 * falls back to the directory row it already holds.
 */
export async function fetchDirectoryStatus(
  db: Datastore,
  directory: Directory,
): Promise<ReceivedDirectoryStatus | null> {
  const now = Date.now();
  const cached = cache.get(directory.id);
  if (cached && cached.freshUntil > now) return cached.status;
  if ((failedUntil.get(directory.id) ?? 0) > now) return null;

  // The bundled listener runs in the proxy's own process, so loopback is the
  // reliable route; the public URL may only resolve outside the container.
  const base = (
    (await getConfig(db, "proxy.loopback_url")) ?? (await getConfig(db, "proxy.public_url"))
  )?.replace(/\/+$/, "");
  if (!base) return null;
  // The directory row holds a digest (ENT-6742), so the token comes from the copy
  // this process was started with — `DIRECTORIES_JSON` in native-app mode. Without
  // one there is no credential to present, and the caller's own fallback (the row's
  // mode) is the documented inert behaviour.
  const token = await clientTokenFor(db, directory.id);
  if (!token) return null;
  try {
    const response = await fetch(`${base}/status/directories/${encodeURIComponent(directory.id)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 304 && cached) {
      cached.freshUntil = now + TTL_MS;
      return cached.status;
    }
    if (!response.ok) {
      failedUntil.set(directory.id, now + TTL_MS);
      return null;
    }
    const status = (await response.json()) as ReceivedDirectoryStatus;
    cache.set(directory.id, {
      status,
      etag: response.headers.get("ETag"),
      freshUntil: now + TTL_MS,
    });
    return status;
  } catch {
    failedUntil.set(directory.id, now + TTL_MS);
    return null;
  }
}
