import { joinScimUrl } from "../../../workers/shared/scim";

export interface EndpointCount {
  reachable: boolean;
  /** Users whose SCIM resource does not explicitly set active: false. */
  count: number | null;
  /** True when unread or invalid pages prevent an exact active-user count. */
  truncated: boolean;
}

/** Counts alone cannot prove that the users or their attributes are in sync. */
export function getUserCountStatus(
  native: EndpointCount,
  workos: EndpointCount,
): { color: "green" | "yellow" | "gray"; label: string } {
  if (!native.reachable || !workos.reachable) {
    return { color: "gray", label: "endpoint unreachable" };
  }
  if (native.count === null || workos.count === null) {
    return { color: "gray", label: "counts unavailable" };
  }
  if (native.truncated || workos.truncated) {
    return { color: "gray", label: "counts incomplete" };
  }
  return native.count === workos.count
    ? { color: "green", label: "active counts match" }
    : { color: "yellow", label: "active counts differ" };
}

const PAGE = 200;
const MAX_PAGES = 2;

export interface ScimCountUser {
  id: string;
  active?: boolean;
  userName?: string;
}

/** Only return the count to the overview, not the fetched user records. */
export async function countUsers(url: string, token: string): Promise<EndpointCount> {
  const { reachable, count, truncated } = await readUserSnapshot(url, token);
  return { reachable, count, truncated };
}

/**
 * Count active users from SCIM resources, not totalResults: retained inactive
 * records inflate that unfiltered total. Omitted active means active, matching
 * the detailed live view and native endpoints that only retain live users.
 *
 * Read at most two pages to keep the panel bounded. Only an empty page confirms
 * completion: native endpoints may cap pages below our requested size and report
 * a page-sized totalResults or omit it. Even a consistent total is not proof the
 * next page is empty. A larger reported total also prevents an early empty page
 * from appearing complete. Keep inactive rows for the detailed comparison.
 */
export async function readUserSnapshot(
  url: string,
  token: string,
): Promise<EndpointCount & { users: ScimCountUser[] }> {
  if (!url) return { reachable: false, count: null, truncated: false, users: [] };

  let count = 0;
  let returned = 0;
  let reported = 0;
  const seen = new Set<string>();
  const users: ScimCountUser[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listUsersPage(url, token, returned + 1);
    if (result === null || result.resources === null) {
      return page === 0
        ? { reachable: result !== null, count: null, truncated: false, users }
        : { reachable: true, count, truncated: true, users };
    }
    reported = Math.max(reported, result.reported ?? 0);
    let repeated = false;
    for (const user of result.resources) {
      if (seen.has(user.id)) {
        repeated = true;
        continue;
      }
      seen.add(user.id);
      users.push(user);
      if (user.active !== false) count++;
    }
    returned += result.resources.length;
    // A server ignoring startIndex must not inflate the count or appear exact.
    if (repeated) return { reachable: true, count, truncated: true, users };
    if (result.resources.length === 0) {
      return { reachable: true, count, truncated: reported > returned, users };
    }
  }
  return { reachable: true, count, truncated: true, users };
}

function isCountedUser(value: unknown): value is ScimCountUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "string" &&
    user.id.length > 0 &&
    (user.active === undefined || typeof user.active === "boolean") &&
    (user.userName === undefined || typeof user.userName === "string")
  );
}

/** Null distinguishes an unreachable endpoint from a readable but invalid list. */
async function listUsersPage(
  url: string,
  token: string,
  startIndex: number,
): Promise<{ reported: number | null; resources: ScimCountUser[] | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(
      `${joinScimUrl(url, "/Users")}?startIndex=${startIndex}&count=${PAGE}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        redirect: "manual",
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { totalResults?: unknown; Resources?: unknown } | null;
    const total = body?.totalResults;
    const reported =
      typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null;
    // SCIM permits Resources to be omitted for an empty collection only.
    const rows = body?.Resources ?? (reported === 0 ? [] : null);
    return {
      reported,
      resources: Array.isArray(rows) && rows.every(isCountedUser) ? rows : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
