import { joinScimUrl } from "../../../workers/shared/scim";

export interface EndpointCount {
  reachable: boolean;
  count: number | null;
  /** True when `count` is a floor, not a total: every page the probe read was
   *  full, so the collection continues beyond what it counted. A consumer must
   *  not compare two counts for equality while either is truncated. */
  truncated: boolean;
}

/** One page of the probe, and the budget it stops at. 200 matches the demo
 *  live view's cap. */
const PAGE = 200;

/**
 * Live user count from an endpoint over SCIM.
 *
 * RFC 7644 makes `totalResults` the size of the whole collection, but a
 * hand-rolled SCIM server often reports the size of the page it returned — a
 * probe that trusts the field then undercounts, and a one-item probe reads
 * "1 users" forever (a real POC hit exactly this). So: read a full page and
 * take the larger of `totalResults` and the rows actually returned. That is
 * still ambiguous in one case — a full page whose total doesn't exceed it,
 * which is either a collection of exactly one page or a page-sized total with
 * more behind it — and one more probe at the next page tells those apart. A
 * second full page stops there and reports a floor (`truncated`) rather than
 * paginating an arbitrarily large directory from a status card.
 */
export async function countUsers(url: string, token: string): Promise<EndpointCount> {
  if (!url) return { reachable: false, count: null, truncated: false };

  const first = await listUsersPage(url, token, 1);
  if (first === null) return { reachable: false, count: null, truncated: false };
  const { reported, returned } = first;
  if (reported === null && returned === null) {
    return { reachable: true, count: null, truncated: false };
  }

  // Unambiguous when the page wasn't full (the collection ended inside it) or
  // the reported total exceeds the page (a compliant server's real total).
  const pageFull = returned === PAGE;
  if (!pageFull || (reported !== null && reported > (returned ?? 0))) {
    return { reachable: true, count: Math.max(reported ?? 0, returned ?? 0), truncated: false };
  }

  const second = await listUsersPage(url, token, PAGE + 1);
  if (second === null || second.returned === null) {
    // The endpoint answered the first page, so it is reachable; what's unknown
    // is only whether the collection continues. Report the floor as such.
    return { reachable: true, count: PAGE, truncated: true };
  }
  return {
    reachable: true,
    count: PAGE + second.returned,
    truncated: second.returned === PAGE,
  };
}

/** One page of GET /Users, with a short timeout so an unreachable or
 *  not-yet-configured endpoint fails fast instead of hanging. Null on any
 *  failure; otherwise the reported totalResults and the returned row count,
 *  each null when the body doesn't carry it. */
async function listUsersPage(
  url: string,
  token: string,
  startIndex: number,
): Promise<{ reported: number | null; returned: number | null } | null> {
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
    const body = (await response.json()) as { totalResults?: unknown; Resources?: unknown };
    return {
      reported: typeof body.totalResults === "number" ? body.totalResults : null,
      returned: Array.isArray(body.Resources) ? body.Resources.length : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
