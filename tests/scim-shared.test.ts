import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../workers/shared/crypto";
import { upsertMapping } from "../workers/shared/db";
import {
  errorMessage,
  isRecord,
  isSuccess,
  joinScimUrl,
  loadIdMaps,
  makeTranslator,
  parseJson,
  parseScimPath,
  scimError,
  scimFetch,
  translateListResponse,
  translatePatchIds,
  translateResourceIds,
  type IdMaps,
} from "../workers/shared/scim";
import {
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  WORKOS_URL,
  type FakeUpstreams,
} from "./helpers";

describe("parseScimPath", () => {
  it("parses a Users collection path", () => {
    expect(parseScimPath("/scim/v2/Users")).toEqual({
      kind: "Users",
      id: null,
      discovery: false,
      rest: "/Users",
    });
  });

  it("parses a Users resource path with an id", () => {
    expect(parseScimPath("/scim/v2/Users/abc-123")).toEqual({
      kind: "Users",
      id: "abc-123",
      discovery: false,
      rest: "/Users/abc-123",
    });
  });

  it("parses Groups collection and resource paths", () => {
    expect(parseScimPath("/scim/v2/Groups")).toMatchObject({ kind: "Groups", id: null });
    expect(parseScimPath("/scim/v2/Groups/g1")).toMatchObject({ kind: "Groups", id: "g1" });
  });

  it("decodes the id but keeps rest URL-encoded for verbatim forwarding", () => {
    const parsed = parseScimPath("/scim/v2/Users/a%40b.c");
    expect(parsed).toEqual({
      kind: "Users",
      id: "a@b.c",
      discovery: false,
      rest: "/Users/a%40b.c",
    });
  });

  it("tolerates trailing and duplicate slashes", () => {
    expect(parseScimPath("/scim/v2/Users/")).toMatchObject({ kind: "Users", id: null });
    expect(parseScimPath("/scim/v2//Users")).toMatchObject({ kind: "Users", id: null });
  });

  it("rejects Users/Groups paths with trailing segments beyond the id", () => {
    expect(parseScimPath("/scim/v2/Users/abc/extra")).toBeNull();
    expect(parseScimPath("/scim/v2/Groups/g1/members")).toBeNull();
  });

  it("marks discovery roots as discovery with no kind or id", () => {
    for (const root of ["ServiceProviderConfig", "Schemas", "ResourceTypes"]) {
      expect(parseScimPath(`/scim/v2/${root}`)).toEqual({
        kind: null,
        id: null,
        discovery: true,
        rest: `/${root}`,
      });
    }
  });

  it("accepts discovery paths with trailing segments (forwarded verbatim)", () => {
    const parsed = parseScimPath("/scim/v2/Schemas/urn:ietf:params:scim:schemas:core:2.0:User");
    expect(parsed).toEqual({
      kind: null,
      id: null,
      discovery: true,
      rest: "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
    });
  });

  it("rejects paths outside the SCIM prefix", () => {
    expect(parseScimPath("/Users")).toBeNull();
    expect(parseScimPath("/scim/v1/Users")).toBeNull();
    expect(parseScimPath("/healthz")).toBeNull();
  });

  it("rejects the bare prefix with no resource", () => {
    expect(parseScimPath("/scim/v2")).toBeNull();
    expect(parseScimPath("/scim/v2/")).toBeNull();
  });

  it("rejects unknown resource roots and is case-sensitive", () => {
    expect(parseScimPath("/scim/v2/Bulk")).toBeNull();
    expect(parseScimPath("/scim/v2/users")).toBeNull();
    expect(parseScimPath("/scim/v2/serviceProviderConfig")).toBeNull();
  });

  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(parseScimPath("/scim/v2/Users/%zz")).toBeNull();
  });

  it("accepts a prefix without a segment boundary, yielding a slash-less rest", () => {
    // Suspected bug: "/scim/v2Users" passes the startsWith check, so it parses
    // as a Users collection whose rest ("Users") has no leading slash — a
    // downstream joinScimUrl would produce ".../scim/v2Users". Pinning current
    // behavior.
    expect(parseScimPath("/scim/v2Users")).toEqual({
      kind: "Users",
      id: null,
      discovery: false,
      rest: "Users",
    });
  });
});

describe("scimError", () => {
  it("returns the status, SCIM error body, and SCIM content type", async () => {
    const res = scimError(404, "Resource not found");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/scim+json");
    expect(await res.json()).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
      detail: "Resource not found",
    });
  });

  it("stringifies the status in the body per the SCIM error schema", async () => {
    const body = (await scimError(409, "conflict").json()) as { status: unknown };
    expect(body.status).toBe("409");
  });
});

describe("joinScimUrl", () => {
  it("joins a clean base and a leading-slash path", () => {
    expect(joinScimUrl("https://host/scim/v2", "/Users")).toBe("https://host/scim/v2/Users");
  });

  it("strips one or more trailing slashes from the base", () => {
    expect(joinScimUrl("https://host/scim/v2/", "/Users")).toBe("https://host/scim/v2/Users");
    expect(joinScimUrl("https://host/scim/v2///", "/Users/x")).toBe("https://host/scim/v2/Users/x");
  });

  it("does not insert a slash when the path lacks one", () => {
    expect(joinScimUrl("https://host/scim/v2", "Users")).toBe("https://host/scim/v2Users");
  });

  it("returns the bare base for an empty path", () => {
    expect(joinScimUrl("https://host/scim/v2/", "")).toBe("https://host/scim/v2");
  });
});

function idMaps(entries: { users?: [string, string][]; groups?: [string, string][] }): IdMaps {
  return {
    Users: new Map(entries.users ?? []),
    Groups: new Map(entries.groups ?? []),
  };
}

describe("makeTranslator", () => {
  it("maps known ids per resource type and leaves unknown ids as-is", () => {
    const translate = makeTranslator(
      idMaps({ users: [["nat_u1", "wos_u1"]], groups: [["nat_g1", "wos_g1"]] }),
    );
    expect(translate("Users", "nat_u1")).toBe("wos_u1");
    expect(translate("Groups", "nat_g1")).toBe("wos_g1");
    expect(translate("Users", "nat_g1")).toBe("nat_g1"); // wrong-kind lookup misses
    expect(translate("Users", "unknown")).toBe("unknown");
  });
});

describe("translateResourceIds", () => {
  const translate = makeTranslator(
    idMaps({
      users: [
        ["nat_u1", "wos_u1"],
        ["nat_u2", "wos_u2"],
      ],
      groups: [["nat_g1", "wos_g1"]],
    }),
  );

  it("translates the top-level id by kind and leaves other fields untouched", () => {
    const out = translateResourceIds(
      { id: "nat_u1", userName: "a@b.c", externalId: "nat_u1" },
      "Users",
      translate,
    );
    expect(out).toEqual({ id: "wos_u1", userName: "a@b.c", externalId: "nat_u1" });
  });

  it("translates group members[].value as Users ids", () => {
    const out = translateResourceIds(
      {
        id: "nat_g1",
        displayName: "Eng",
        members: [
          { value: "nat_u1", display: "A" },
          { value: "unknown", display: "B" },
        ],
      },
      "Groups",
      translate,
    );
    expect(out.id).toBe("wos_g1");
    expect(out.members).toEqual([
      { value: "wos_u1", display: "A" },
      { value: "unknown", display: "B" },
    ]);
  });

  it("leaves non-string ids and malformed member entries alone", () => {
    const out = translateResourceIds(
      { id: 42, members: [{ display: "no value" }, "bare", { value: 7 }] },
      "Groups",
      translate,
    );
    expect(out.id).toBe(42);
    expect(out.members).toEqual([{ display: "no value" }, "bare", { value: 7 }]);
  });

  it("translates a members array even on a Users resource (always Users-keyed)", () => {
    const out = translateResourceIds(
      { id: "nat_u1", members: [{ value: "nat_u2" }] },
      "Users",
      translate,
    );
    expect(out.members).toEqual([{ value: "wos_u2" }]);
  });

  it("does not mutate the input resource", () => {
    const input = { id: "nat_u1", members: [{ value: "nat_u2" }] };
    translateResourceIds(input, "Users", translate);
    expect(input.id).toBe("nat_u1");
    expect(input.members[0].value).toBe("nat_u2");
  });
});

describe("translateListResponse", () => {
  const translate = makeTranslator(idMaps({ users: [["nat_u1", "wos_u1"]] }));

  it("translates each record in Resources and preserves envelope fields", () => {
    const out = translateListResponse(
      {
        totalResults: 2,
        itemsPerPage: 2,
        Resources: [{ id: "nat_u1" }, { id: "unknown" }, "not-a-record"],
      },
      "Users",
      translate,
    );
    expect(out.totalResults).toBe(2);
    expect(out.itemsPerPage).toBe(2);
    expect(out.Resources).toEqual([{ id: "wos_u1" }, { id: "unknown" }, "not-a-record"]);
  });

  it("returns the body unchanged when Resources is not an array", () => {
    const body = { totalResults: 0 };
    expect(translateListResponse(body, "Users", translate)).toBe(body);
  });
});

describe("translatePatchIds", () => {
  const translate = makeTranslator(
    idMaps({
      users: [
        ["nat_u1", "wos_u1"],
        ["nat_u2", "wos_u2"],
      ],
    }),
  );

  it("passes through null and bodies without an Operations array", () => {
    expect(translatePatchIds(null, "Groups", translate)).toBeNull();
    const body = { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"] };
    expect(translatePatchIds(body, "Groups", translate)).toBe(body);
  });

  it("rewrites members[value eq ...] filters in op paths, including repeats", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "remove", path: 'members[value eq "nat_u1"]' },
          { op: "remove", path: 'members[value eq "nat_u1"] or members[value eq "nat_u2"]' },
          { op: "remove", path: 'members[value eq "unknown"]' },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "remove", path: 'members[value eq "wos_u1"]' },
      { op: "remove", path: 'members[value eq "wos_u1"] or members[value eq "wos_u2"]' },
      { op: "remove", path: 'members[value eq "unknown"]' },
    ]);
  });

  it("translates array values for Groups ops with no path or a members path", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "add", value: [{ value: "nat_u1" }] },
          { op: "add", path: "members", value: [{ value: "nat_u2" }] },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "add", value: [{ value: "wos_u1" }] },
      { op: "add", path: "members", value: [{ value: "wos_u2" }] },
    ]);
  });

  it("leaves array values on non-members paths untouched", () => {
    const ops = [{ op: "add", path: "emails", value: [{ value: "nat_u1" }] }];
    const out = translatePatchIds({ Operations: ops }, "Groups", translate);
    expect(out?.Operations).toEqual(ops);
  });

  it("translates a nested members array inside a record value", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "replace", value: { displayName: "Eng", members: [{ value: "nat_u1" }] } },
          { op: "replace", value: { displayName: "No members" } },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "replace", value: { displayName: "Eng", members: [{ value: "wos_u1" }] } },
      { op: "replace", value: { displayName: "No members" } },
    ]);
  });

  it("rewrites paths but never values for Users PATCHes", () => {
    const out = translatePatchIds(
      {
        Operations: [
          { op: "remove", path: 'members[value eq "nat_u1"]' },
          { op: "add", value: [{ value: "nat_u1" }] },
        ],
      },
      "Users",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "remove", path: 'members[value eq "wos_u1"]' },
      { op: "add", value: [{ value: "nat_u1" }] },
    ]);
  });

  it("leaves non-record operations as-is", () => {
    const out = translatePatchIds({ Operations: ["bogus", 42] }, "Groups", translate);
    expect(out?.Operations).toEqual(["bogus", 42]);
  });

  it("does not mutate the input body", () => {
    const body = { Operations: [{ op: "add", value: [{ value: "nat_u1" }] }] };
    translatePatchIds(body, "Groups", translate);
    expect(body.Operations[0].value[0].value).toBe("nat_u1");
  });
});

describe("isSuccess", () => {
  it("is true exactly for 2xx statuses", () => {
    expect(isSuccess(199)).toBe(false);
    expect(isSuccess(200)).toBe(true);
    expect(isSuccess(201)).toBe(true);
    expect(isSuccess(204)).toBe(true);
    expect(isSuccess(299)).toBe(true);
    expect(isSuccess(300)).toBe(false);
    expect(isSuccess(404)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("extracts the message from Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ detail: "x" })).toBe("[object Object]");
  });
});

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("parseJson", () => {
  it("parses a JSON object", () => {
    expect(parseJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("returns null for null and empty input", () => {
    expect(parseJson(null)).toBeNull();
    expect(parseJson("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseJson("{not json")).toBeNull();
  });

  it("returns null for valid JSON that is not an object", () => {
    expect(parseJson("[1,2]")).toBeNull();
    expect(parseJson('"str"')).toBeNull();
    expect(parseJson("123")).toBeNull();
    expect(parseJson("null")).toBeNull();
    expect(parseJson("true")).toBeNull();
  });
});

describe("crypto secrets", () => {
  const KEY = "test-master-key";

  it("round-trips a secret when the DB handle carries a key", async () => {
    const db = { encryptionKey: KEY };
    const stored = await encryptSecret(db, "workos-secret-token");
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain("workos-secret-token");
    expect(await decryptSecret(db, stored)).toBe("workos-secret-token");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const db = { encryptionKey: KEY };
    const a = await encryptSecret(db, "same");
    const b = await encryptSecret(db, "same");
    expect(a).not.toBe(b);
    expect(await decryptSecret(db, a)).toBe("same");
    expect(await decryptSecret(db, b)).toBe("same");
  });

  it("returns plaintext verbatim when no key is configured", async () => {
    expect(await encryptSecret({}, "secret")).toBe("secret");
    expect(await encryptSecret({ encryptionKey: null }, "secret")).toBe("secret");
    expect(await encryptSecret(null, "secret")).toBe("secret");
    expect(await encryptSecret(undefined, "secret")).toBe("secret");
  });

  it("never encrypts the empty string", async () => {
    expect(await encryptSecret({ encryptionKey: KEY }, "")).toBe("");
  });

  it("returns non-prefixed values verbatim from decryptSecret (pre-key rows)", async () => {
    expect(await decryptSecret({ encryptionKey: KEY }, "plain-token")).toBe("plain-token");
    expect(await decryptSecret({}, "plain-token")).toBe("plain-token");
  });

  it("surfaces an encrypted value as-is when decrypting without a key", async () => {
    const stored = await encryptSecret({ encryptionKey: KEY }, "secret");
    expect(await decryptSecret({}, stored)).toBe(stored);
  });

  it("rejects when decrypting with the wrong key", async () => {
    const stored = await encryptSecret({ encryptionKey: KEY }, "secret");
    let threw = false;
    try {
      await decryptSecret({ encryptionKey: "different-key" }, stored);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects on tampered ciphertext (GCM auth failure)", async () => {
    const db = { encryptionKey: KEY };
    const stored = await encryptSecret(db, "secret");
    // Flip the last base64 character of the payload.
    const payload = stored.slice("enc:v1:".length);
    const flipped = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A");
    let threw = false;
    try {
      await decryptSecret(db, "enc:v1:" + flipped);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("re-derives the key when encryptionKey changes on the same handle", async () => {
    const db: { encryptionKey: string } = { encryptionKey: KEY };
    const stored = await encryptSecret(db, "secret");

    db.encryptionKey = "rotated-key";
    let threw = false;
    try {
      await decryptSecret(db, stored);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // old ciphertext no longer decrypts

    const restored = await encryptSecret(db, "after-rotation");
    db.encryptionKey = KEY;
    expect(await decryptSecret(db, stored)).toBe("secret"); // cache switches back with raw
    db.encryptionKey = "rotated-key";
    expect(await decryptSecret(db, restored)).toBe("after-rotation");
  });

  it("derives the same key on different handles with the same raw key", async () => {
    const stored = await encryptSecret({ encryptionKey: KEY }, "portable");
    expect(await decryptSecret({ encryptionKey: KEY }, stored)).toBe("portable");
  });

  it("handles unicode plaintext", async () => {
    const db = { encryptionKey: KEY };
    const secret = "tökén-ção-🔐";
    expect(await decryptSecret(db, await encryptSecret(db, secret))).toBe(secret);
  });
});

// --- Verifier additions ---

describe("parseScimPath (edge cases)", () => {
  it("preserves duplicate slashes verbatim in rest", () => {
    // rest is forwarded as-is; only the parsed segments collapse empty parts.
    expect(parseScimPath("/scim/v2//Users")).toEqual({
      kind: "Users",
      id: null,
      discovery: false,
      rest: "//Users",
    });
  });

  it("rejects malformed percent-encoding on discovery paths too", () => {
    // decodeURIComponent runs on every segment before the root is classified.
    expect(parseScimPath("/scim/v2/Schemas/%zz")).toBeNull();
  });
});

describe("translateListResponse (kind plumbing)", () => {
  it("translates Groups listings with the Groups map, not the Users map", () => {
    const translate = makeTranslator(
      idMaps({ users: [["shared", "wos_u"]], groups: [["nat_g1", "wos_g1"]] }),
    );
    const out = translateListResponse(
      { totalResults: 2, Resources: [{ id: "nat_g1" }, { id: "shared" }] },
      "Groups",
      translate,
    );
    // "shared" only exists in the Users map, so a Groups listing must not map it.
    expect(out.Resources).toEqual([{ id: "wos_g1" }, { id: "shared" }]);
  });
});

describe("translatePatchIds (filter path with value)", () => {
  it("translates array values when the path is a members filter, not just bare 'members'", () => {
    const translate = makeTranslator(
      idMaps({
        users: [
          ["nat_u1", "wos_u1"],
          ["nat_u2", "wos_u2"],
        ],
      }),
    );
    const out = translatePatchIds(
      {
        Operations: [
          { op: "replace", path: 'members[value eq "nat_u1"]', value: [{ value: "nat_u2" }] },
        ],
      },
      "Groups",
      translate,
    );
    expect(out?.Operations).toEqual([
      { op: "replace", path: 'members[value eq "wos_u1"]', value: [{ value: "wos_u2" }] },
    ]);
  });
});

describe("scimFetch", () => {
  let fake: FakeUpstreams;

  afterEach(() => {
    fake.restore();
  });

  it("sends a bearer token and no content-type or migrated-id header on a body-less request", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "GET", "/Users/abc", scimJson(200, { id: "abc" }));

    const result = await scimFetch(joinScimUrl(WORKOS_URL, "/Users/abc"), {
      method: "GET",
      token: "workos-secret",
    });

    const call = fake.calls[0];
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/Users/abc");
    expect(call.headers.get("Authorization")).toBe("Bearer workos-secret");
    expect(call.headers.get("Content-Type")).toBeNull();
    expect(call.headers.get("X-WorkOS-Migrated-Id")).toBeNull();
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe(JSON.stringify({ id: "abc" }));
    expect(result.contentType).toBe("application/scim+json");
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it("defaults the content type to application/scim+json when a body is present", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "POST", "/Users", scimJson(201, { id: "u1" }));

    await scimFetch(joinScimUrl(WORKOS_URL, "/Users"), {
      method: "POST",
      token: "t",
      body: '{"userName":"a@b.c"}',
    });

    const call = fake.calls[0];
    expect(call.headers.get("Content-Type")).toBe("application/scim+json");
    expect(call.body).toBe('{"userName":"a@b.c"}');
  });

  it("honors an explicit content type", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "PUT", "/Users/u1", scimJson(200, { id: "u1" }));

    await scimFetch(joinScimUrl(WORKOS_URL, "/Users/u1"), {
      method: "PUT",
      token: "t",
      body: "{}",
      contentType: "application/json",
    });

    expect(fake.calls[0].headers.get("Content-Type")).toBe("application/json");
  });

  it("sets the migrated-id header when given", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "PUT", "/Users/nat_u1", scimJson(200, { id: "nat_u1" }));

    await scimFetch(joinScimUrl(WORKOS_URL, "/Users/nat_u1"), {
      method: "PUT",
      token: "t",
      body: "{}",
      migratedId: "nat_u1",
    });

    expect(fake.calls[0].headers.get("X-WorkOS-Migrated-Id")).toBe("nat_u1");
  });

  it("normalizes an empty response body to null", async () => {
    fake = installFakeUpstreams();
    fake.route("workos", "DELETE", "/Users/u1", new Response(null, { status: 204 }));

    const result = await scimFetch(joinScimUrl(WORKOS_URL, "/Users/u1"), {
      method: "DELETE",
      token: "t",
    });

    expect(result.status).toBe(204);
    expect(result.bodyText).toBeNull();
  });
});

describe("loadIdMaps", () => {
  it("builds both directions, keyed per resource type", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "nat_u1",
      workos_id: "wos_u1",
      strategy: "migrated-id",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "nat_g1",
      workos_id: "wos_g1",
      strategy: "fallback-post",
    });

    const maps = await loadIdMaps(env.DB, directory.id);
    expect(maps.nativeToWorkos.Users.get("nat_u1")).toBe("wos_u1");
    expect(maps.workosToNative.Users.get("wos_u1")).toBe("nat_u1");
    expect(maps.nativeToWorkos.Groups.get("nat_g1")).toBe("wos_g1");
    expect(maps.workosToNative.Groups.get("wos_g1")).toBe("nat_g1");
    // A Users mapping must not leak into the Groups map or vice versa.
    expect(maps.nativeToWorkos.Groups.has("nat_u1")).toBe(false);
    expect(maps.nativeToWorkos.Users.has("nat_g1")).toBe(false);
  });

  it("only loads mappings for the requested directory", async () => {
    const env = createEnv();
    const mine = await seedDirectory(env.DB);
    const other = await seedDirectory(env.DB);
    await upsertMapping(env.DB, {
      directory_id: other.id,
      resource_type: "Users",
      native_id: "nat_u1",
      workos_id: "wos_other",
      strategy: "migrated-id",
    });

    const maps = await loadIdMaps(env.DB, mine.id);
    expect(maps.nativeToWorkos.Users.size).toBe(0);
    expect(maps.workosToNative.Users.size).toBe(0);
  });
});
