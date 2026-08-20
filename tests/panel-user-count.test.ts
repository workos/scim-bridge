import { afterEach, describe, expect, it } from "vitest";
import { countUsers } from "../app/routes/panel/user-count";
import { installFakeUpstreams, NATIVE_URL, scimJson, type FakeUpstreams } from "./helpers";

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

  it("still trusts a compliant totalResults beyond the returned page", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, () => listPage(users(200), 500));

    const result = await countUsers(NATIVE_URL, "native-secret");

    // totalResults exceeding the page is unambiguous: one request, no probe.
    expect(result).toEqual({ reachable: true, count: 500, truncated: false });
    expect(fake.calls).toHaveLength(1);
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
});
