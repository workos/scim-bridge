import { getConfig } from "../shared/db";
import type { Directory } from "../shared/types";
import type { DirectoryStatus } from "../proxy/status";

/** How long a fetched status stays fresh before revalidating. Matches the
 *  endpoint's Cache-Control so a mode flip propagates within seconds. */
const TTL_MS = 5_000;
const FETCH_TIMEOUT_MS = 2_000;

interface CacheEntry {
  status: DirectoryStatus;
  etag: string | null;
  freshUntil: number;
}

const cache = new Map<string, CacheEntry>();

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
  db: D1Database,
  directory: Directory,
): Promise<DirectoryStatus | null> {
  const now = Date.now();
  const cached = cache.get(directory.id);
  if (cached && cached.freshUntil > now) return cached.status;

  const base = (await getConfig(db, "proxy.public_url"))?.replace(/\/+$/, "");
  if (!base) return null;
  try {
    const response = await fetch(`${base}/status/directories/${encodeURIComponent(directory.id)}`, {
      headers: {
        Authorization: `Bearer ${directory.proxy_token}`,
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 304 && cached) {
      cached.freshUntil = now + TTL_MS;
      return cached.status;
    }
    if (!response.ok) return null;
    const status = (await response.json()) as DirectoryStatus;
    cache.set(directory.id, {
      status,
      etag: response.headers.get("ETag"),
      freshUntil: now + TTL_MS,
    });
    return status;
  } catch {
    return null;
  }
}
