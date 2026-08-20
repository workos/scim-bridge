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

  it("reports the collection size against a server whose totalResults is the page size", async () => {
    fake = installFakeUpstreams();
    const all = users(16);
    fake.route("native", "GET", /^\/Users/, (call) => {
      const requested = Number(
        new URL(`https://x${call.path}`, "https://x").searchParams.get("count") ?? all.length,
      );
      const page = all.slice(0, requested);
      // The naive shape: totalResults echoes the page, not the collection.
      return listPage(page, page.length);
    });

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: 16 });
  });

  it("still trusts a compliant totalResults beyond the returned page", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, () => listPage(users(200), 500));

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: 500 });
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

    expect(result).toEqual({ reachable: true, count: 3 });
  });

  it("reports a reachable endpoint with no readable count as null, not zero", async () => {
    fake = installFakeUpstreams();
    fake.route("native", "GET", /^\/Users/, scimJson(200, { message: "not a list response" }));

    const result = await countUsers(NATIVE_URL, "native-secret");

    expect(result).toEqual({ reachable: true, count: null });
  });
});
