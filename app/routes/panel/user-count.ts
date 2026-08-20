import { joinScimUrl } from "../../../workers/shared/scim";

export interface EndpointCount {
  reachable: boolean;
  count: number | null;
}

/** Live user count from an endpoint over SCIM, with a short timeout so an
 *  unreachable or not-yet-configured endpoint fails fast instead of hanging. */
export async function countUsers(url: string, token: string): Promise<EndpointCount> {
  if (!url) return { reachable: false, count: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    // A real page, not `count=1`: RFC 7644 makes totalResults the size of the
    // whole collection, but a hand-rolled SCIM server often reports the size of
    // the page it returned — a one-item probe then reads "1 users" forever,
    // whatever the directory holds. Ask for a page (200, the same cap the demo
    // live view uses) and take the larger of the two answers: a compliant
    // server's totalResults still wins past the page, and a page-sized
    // totalResults is corrected by the rows actually returned.
    const response = await fetch(`${joinScimUrl(url, "/Users")}?count=200`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) return { reachable: false, count: null };
    const body = (await response.json()) as { totalResults?: unknown; Resources?: unknown };
    const reported = typeof body.totalResults === "number" ? body.totalResults : null;
    const returned = Array.isArray(body.Resources) ? body.Resources.length : null;
    const count =
      reported === null && returned === null ? null : Math.max(reported ?? 0, returned ?? 0);
    return { reachable: true, count };
  } catch {
    return { reachable: false, count: null };
  } finally {
    clearTimeout(timer);
  }
}
