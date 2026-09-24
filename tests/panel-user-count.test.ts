import { afterEach, describe, expect, it } from "vitest";
import { countUsers, getUserCountStatus } from "../app/routes/panel/user-count";
import {
  installFakeUpstreams,
  NATIVE_URL,
  WORKOS_URL,
  scimJson,
  type FakeUpstreams,
} from "./helpers";

/**
 * The Live state card's user count, read over SCIM from each endpoint.
 *
 * RFC 7644 §3.4.2.4 says `totalResults` is the size of the whole collection,
 * independent of pagination — but a hand-rolled SCIM server (a POC dummy, a
 * customer's first native endpoint) often reports the size of the page it
 * returned instead. A probe that asks for a one-item page and trusts
 * `totalResults` then reads "1 users" no matter how many exist, in every mode
 * (Writer's POC hit exactly this). The count must survive both kinds of server.
 */

function listPage(resources: Record<string, unknown>[], totalResults: number) {
  return scimJson(200, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

const users = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, userName: `user-${i}@x.test` }));

describe("countUsers", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  /** A server with the naive shape: it honors count/startIndex, but reports
   *  totalResults as the size of the page it returned, not the collection. */
  function naiveServer(fakeUpstreams: FakeUpstreams, total: number) {
    const all = users(total);
    fakeUpstreams.route("native", "GET", /^\/Users/, (call) => {
      const params = new URL(`https://x${call.path}`, "https://x").searchParams;
      const requested = Number(params.get("count") ?? all.length);
      const startIndex = Number(params.get("startIndex") ?? 1);
      const page = all.slice(startIndex - 1, startIndex - 1 + requested);
      return listPage(page, page.length);
    });
  }

  it("reports the collection size against a server whose totalResults is the page size", async () => {
    fake = installFakeUpstreams();
    naiveServer(fake, 16);

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: 16, truncated: false });
    // A page that isn't full already proves the collection ended: no second probe.
    expect(fake.calls).toHaveLength(1);
  });

  it("resolves a full first page with one more probe when the total is page-sized", async () => {
    fake = installFakeUpstreams();
    naiveServer(fake, 250);

    const result = await countUsers(NATIVE_URL, "native-secret");

    // Page 2 (startIndex=201) returns 50 rows and is not full, so the count is
    // exact — the ambiguity is resolved, not merely flagged.
    expect(result).toEqual({ reachable: true, count: 250, truncated: false });
    expect(fake.calls).toHaveLength(2);
  });

  it("reports a floor and truncation when the second page is full too", async () => {
    fake = installFakeUpstreams();
    naiveServer(fake, 450);

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: 400, truncated: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("keeps an exactly-page-sized collection exact via the empty second page", async () => {
    fake = installFakeUpstreams();
    naiveServer(fake, 200);

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: 200, truncated: false });
    expect(fake.calls).toHaveLength(2);
  });

  it("does not treat an unfiltered totalResults as the active-user count", async () => {
    fake = installFakeUpstreams();
    const all = users(500).map((user, i) => ({ ...user, active: i !== 0 && i !== 200 }));
    fake.route("native", "GET", /^\/Users/, (call) => {
      const start = Number(new URL(`https://x${call.path}`).searchParams.get("startIndex")) - 1;
      return listPage(all.slice(start, start + 200), 500);
    });

    const result = await countUsers(NATIVE_URL, "native-secret");

    // The unread third page may contain inactive users. Only the 398 active
    // users actually read are known; 500 is the raw collection size.
    expect(result).toEqual({ reachable: true, count: 398, truncated: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("falls back to counting the returned resources when totalResults is missing", async () => {
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      /^\/Users/,
      scimJson(200, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        Resources: users(3),
      }),
    );

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: 3, truncated: false });
  });

  it("reports a reachable endpoint with no readable count as null, not zero", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, scimJson(200, { message: "not a list response" }));

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: null, truncated: false });
  });

  it("matches 78 native users with 78 active WorkOS users and one retained inactive record", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, listPage(users(78), 78));
    fake.route(
      "workos",
      "GET",
      /^\/Users/,
      listPage(
        [...users(78).map((user) => ({ ...user, active: true })), { id: "deleted", active: false }],
        79,
      ),
    );

    const native = await countUsers(NATIVE_URL, "native-secret");
    const workos = await countUsers(WORKOS_URL, "workos-secret");

    expect(native).toEqual({ reachable: true, count: 78, truncated: false });
    expect(workos).toEqual({ reachable: true, count: 78, truncated: false });
    expect(getUserCountStatus(native, workos)).toEqual({
      color: "green",
      label: "active counts match",
    });
  });

  it("reveals different active counts even when raw record totals match", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, listPage(users(79), 79));
    fake.route(
      "workos",
      "GET",
      /^\/Users/,
      listPage([...users(78), { id: "deleted", active: false }], 79),
    );

    const native = await countUsers(NATIVE_URL, "native-secret");
    const workos = await countUsers(WORKOS_URL, "workos-secret");

    expect(getUserCountStatus(native, workos)).toEqual({
      color: "yellow",
      label: "active counts differ",
    });
  });

  it("counts an entirely inactive collection as exactly zero active users", async () => {
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      /^\/Users/,
      listPage(
        users(3).map((user) => ({ ...user, active: false })),
        3,
      ),
    );

    expect(await countUsers(NATIVE_URL, "native-secret")).toEqual({
      reachable: true,
      count: 0,
      truncated: false,
    });
  });

  it("excludes inactive users on both pages of a complete collection", async () => {
    fake = installFakeUpstreams();
    const all = users(250).map((user, i) => ({ ...user, active: i !== 0 && i !== 200 }));
    fake.route("native", "GET", /^\/Users/, (call) => {
      const start = Number(new URL(`https://x${call.path}`).searchParams.get("startIndex")) - 1;
      return listPage(all.slice(start, start + 200), 250);
    });

    expect(await countUsers(NATIVE_URL, "native-secret")).toEqual({
      reachable: true,
      count: 248,
      truncated: false,
    });
  });

  it.each([
    { total: 75, want: 74, truncated: false },
    { total: 150, want: 99, truncated: true },
  ])(
    "honors smaller upstream pages for a $total-record collection",
    async ({ total, want, truncated }) => {
      fake = installFakeUpstreams();
      const all = users(total).map((user, i) => ({ ...user, active: i !== 50 }));
      fake.route("native", "GET", /^\/Users/, (call) => {
        const start = Number(new URL(`https://x${call.path}`).searchParams.get("startIndex")) - 1;
        return listPage(all.slice(start, start + 50), total);
      });

      expect(await countUsers(NATIVE_URL, "native-secret")).toEqual({
        reachable: true,
        count: want,
        truncated,
      });
      expect(fake.calls[1].path).toContain("startIndex=51");
    },
  );

  it("keeps the first page as a lower bound when the next page fails", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users\?startIndex=1&/, listPage(users(200), 250));
    fake.route("native", "GET", /^\/Users\?startIndex=201&/, scimJson(503, {}));

    expect(await countUsers(NATIVE_URL, "native-secret")).toEqual({
      reachable: true,
      count: 200,
      truncated: true,
    });
  });

  it("does not inflate a count when an endpoint repeats a page", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, () => listPage(users(200), 250));

    expect(await countUsers(NATIVE_URL, "native-secret")).toEqual({
      reachable: true,
      count: 200,
      truncated: true,
    });
  });

  it.each([
    { totalResults: 79 },
    { totalResults: 1, Resources: [null] },
    { totalResults: 1, Resources: [{ id: "u1", active: "false" }] },
  ])("keeps malformed resources unknown instead of trusting their raw total", async (body) => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, scimJson(200, body));

    expect(await countUsers(NATIVE_URL, "native-secret")).toEqual({
      reachable: true,
      count: null,
      truncated: false,
    });
  });

  it("accepts an empty SCIM collection that omits Resources", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, scimJson(200, { totalResults: 0 }));

    expect(await countUsers(NATIVE_URL, "native-secret")).toEqual({
      reachable: true,
      count: 0,
      truncated: false,
    });
  });
});

describe("getUserCountStatus", () => {
  it("does not equate two unavailable counts", () => {
    const unknown = { reachable: true, count: null, truncated: false };
    expect(getUserCountStatus(unknown, unknown)).toEqual({
      color: "gray",
      label: "counts unavailable",
    });
  });

  it("does not compare incomplete active counts", () => {
    const partial = { reachable: true, count: 78, truncated: true };
    expect(getUserCountStatus(partial, { ...partial, truncated: false })).toEqual({
      color: "gray",
      label: "counts incomplete",
    });
  });

  it("reports an unreachable endpoint before comparing counts", () => {
    const unreachable = { reachable: false, count: null, truncated: false };
    expect(getUserCountStatus(unreachable, unreachable)).toEqual({
      color: "gray",
      label: "endpoint unreachable",
    });
  });
});
