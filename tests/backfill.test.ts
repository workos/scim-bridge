import { afterEach, describe, expect, it } from "vitest";
import { runBackfill, runReconcileFromWorkos } from "../workers/shared/backfill";
import { upsertMapping } from "../workers/shared/db";
import { MIGRATED_ID_HEADER, type PocEnv } from "../workers/shared/types";
import {
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

function listPage(resources: Record<string, unknown>[], totalResults = resources.length) {
  return scimJson(200, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

/**
 * Minimal stateful WorkOS SCIM side honoring the post-decoupling contract:
 * PUT resolves-or-404s, POST creates and echoes an id — the migrated id from
 * the header by default, or a minted one via `mintId` (contract not honored).
 */
function installWorkosScim(
  fake: FakeUpstreams,
  opts: { mintId?: (nativeId: string) => string } = {},
) {
  const store = new Set<string>();
  fake.route("workos", "PUT", /^\/(Users|Groups)\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("/")[2]);
    return store.has(id) ? scimJson(200, call.json()) : scimJson(404, { detail: "not found" });
  });
  fake.route("workos", "POST", /^\/(Users|Groups)$/, (call) => {
    const migratedId = call.headers.get(MIGRATED_ID_HEADER) ?? "";
    const id = opts.mintId ? opts.mintId(migratedId) : migratedId;
    store.add(id);
    return scimJson(201, { ...(call.json() as Record<string, unknown>), id });
  });
  return store;
}

async function mappingRows(env: PocEnv, directoryId: string) {
  const { results } = await env.DB.prepare(
    "SELECT resource_type, native_id, workos_id, strategy FROM id_mappings " +
      "WHERE directory_id = ? ORDER BY resource_type, native_id",
  )
    .bind(directoryId)
    .all();
  return results;
}

async function proxyLogRows(env: PocEnv) {
  const { results } = await env.DB.prepare("SELECT * FROM proxy_log ORDER BY id").all();
  return results as Record<string, unknown>[];
}

/** Compact trail of upstream calls, query strings stripped. */
function trail(fake: FakeUpstreams) {
  return fake.calls.map((c) => `${c.target} ${c.method} ${c.path.split("?")[0]}`);
}

describe("runBackfill", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("replays native users then groups into WorkOS through the migrated-id dance", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      "/Users",
      listPage([
        { id: "u1", userName: "one@x.test" },
        { id: "u2", userName: "two@x.test" },
      ]),
    );
    fake.route(
      "native",
      "GET",
      "/Groups",
      listPage([{ id: "g1", displayName: "Eng", members: [{ value: "u1" }, { value: "u2" }] }]),
    );
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary).toEqual({
      users: { total: 2, mirrored: 2, failed: 0 },
      groups: { total: 1, mirrored: 1, failed: 0 },
      errors: [],
    });

    // Users are fully mirrored before the Groups snapshot is even taken, and
    // each first touch is PUT → 404 → POST-with-header.
    expect(trail(fake)).toEqual([
      "native GET /Users",
      "workos PUT /Users/u1",
      "workos POST /Users",
      "workos PUT /Users/u2",
      "workos POST /Users",
      "native GET /Groups",
      "workos PUT /Groups/g1",
      "workos POST /Groups",
    ]);

    const [snapshot, firstPut, firstPost] = fake.calls;
    expect(snapshot.headers.get("Authorization")).toBe("Bearer native-secret");
    expect(firstPut.headers.get("Authorization")).toBe("Bearer workos-secret");
    expect(firstPut.headers.get(MIGRATED_ID_HEADER)).toBe("u1");
    expect(firstPut.json()).toEqual({ id: "u1", userName: "one@x.test" });
    expect(firstPost.headers.get(MIGRATED_ID_HEADER)).toBe("u1");
    // POST creates: the native id travels only in the header, never the body.
    expect(firstPost.json()).toEqual({ userName: "one@x.test" });

    expect(await mappingRows(env, directory.id)).toEqual([
      { resource_type: "Groups", native_id: "g1", workos_id: "g1", strategy: "migrated-id" },
      { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
      { resource_type: "Users", native_id: "u2", workos_id: "u2", strategy: "migrated-id" },
    ]);

    // log_persistence defaults off: nothing lands in proxy_log.
    expect(await proxyLogRows(env)).toEqual([]);
  });

  it("is idempotent on a second pass: every PUT resolves, no POSTs, no duplicate mappings", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      "/Users",
      listPage([
        { id: "u1", userName: "one@x.test" },
        { id: "u2", userName: "two@x.test" },
      ]),
    );
    fake.route(
      "native",
      "GET",
      "/Groups",
      listPage([{ id: "g1", displayName: "Eng", members: [{ value: "u1" }] }]),
    );
    installWorkosScim(fake);

    await runBackfill(env.DB, directory);
    const callsAfterFirst = fake.calls.length;
    const postsAfterFirst = fake.calls.filter((c) => c.method === "POST").length;
    expect(postsAfterFirst).toBe(3);

    const second = await runBackfill(env.DB, directory);

    expect(second).toEqual({
      users: { total: 2, mirrored: 2, failed: 0 },
      groups: { total: 1, mirrored: 1, failed: 0 },
      errors: [],
    });
    const secondPass = fake.calls.slice(callsAfterFirst);
    expect(secondPass.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(trail(fake).slice(callsAfterFirst)).toEqual([
      "native GET /Users",
      "workos PUT /Users/u1",
      "workos PUT /Users/u2",
      "native GET /Groups",
      "workos PUT /Groups/g1",
    ]);
    // A migrated-id mapping keeps anchoring the PUT with the header.
    const reput = secondPass.find((c) => c.path === "/Users/u1");
    expect(reput?.headers.get(MIGRATED_ID_HEADER)).toBe("u1");

    expect(await mappingRows(env, directory.id)).toHaveLength(3);
  });

  it("counts a failed WorkOS leg and keeps mirroring the rest", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      "/Users",
      listPage([
        { id: "u1", userName: "one@x.test" },
        { id: "u2", userName: "two@x.test" },
        { id: "u3", userName: "three@x.test" },
      ]),
    );
    fake.route("native", "GET", "/Groups", listPage([]));
    fake.route("workos", "PUT", "/Users/", (call) => {
      // u3's leg dies on the wire; u1/u2 are ordinary first touches.
      if (call.path === "/Users/u3") throw new Error("socket hang up");
      return scimJson(404, { detail: "not found" });
    });
    fake.route("workos", "POST", "/Users", (call) =>
      call.headers.get(MIGRATED_ID_HEADER) === "u2"
        ? scimJson(500, { detail: "boom" })
        : scimJson(201, {
            ...(call.json() as Record<string, unknown>),
            id: call.headers.get(MIGRATED_ID_HEADER),
          }),
    );

    const summary = await runBackfill(env.DB, directory);

    expect(summary.users).toEqual({ total: 3, mirrored: 1, failed: 2 });
    expect(summary.groups).toEqual({ total: 0, mirrored: 0, failed: 0 });
    expect(summary.errors).toEqual([
      "Users/u2: WorkOS POST returned 500",
      "Users/u3: socket hang up",
    ]);
    // Only the survivor got a mapping.
    expect(await mappingRows(env, directory.id)).toEqual([
      { resource_type: "Users", native_id: "u1", workos_id: "u1", strategy: "migrated-id" },
    ]);
  });

  it("pages through the native enumeration until totalResults is reached", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    const users = [
      { id: "u1", userName: "one@x.test" },
      { id: "u2", userName: "two@x.test" },
      { id: "u3", userName: "three@x.test" },
    ];
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", (call) => {
      const params = new URL(call.path, "https://x").searchParams;
      const start = Number(params.get("startIndex"));
      const page = start === 1 ? users.slice(0, 2) : users.slice(start - 1);
      return scimJson(200, {
        totalResults: users.length,
        startIndex: start,
        itemsPerPage: page.length,
        Resources: page,
      });
    });
    fake.route("native", "GET", "/Groups", listPage([]));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.users).toEqual({ total: 3, mirrored: 3, failed: 0 });
    const snapshots = fake.callsTo("native").filter((c) => c.path.startsWith("/Users"));
    expect(snapshots.map((c) => c.path)).toEqual([
      "/Users?startIndex=1&count=100",
      "/Users?startIndex=3&count=100",
    ]);
  });

  it("translates group members[].value through fallback-post minted ids", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", listPage([{ id: "u1", userName: "one@x.test" }]));
    fake.route(
      "native",
      "GET",
      "/Groups",
      listPage([
        { id: "g1", displayName: "Eng", members: [{ value: "u1" }, { value: "missing" }] },
      ]),
    );
    // WorkOS ignores the migrated id and mints its own (contract off).
    const mint = new Map([
      ["u1", "wos_9"],
      ["g1", "wos_g7"],
    ]);
    installWorkosScim(fake, { mintId: (nativeId) => mint.get(nativeId) ?? `wos_${nativeId}` });

    const first = await runBackfill(env.DB, directory);
    expect(first).toEqual({
      users: { total: 1, mirrored: 1, failed: 0 },
      groups: { total: 1, mirrored: 1, failed: 0 },
      errors: [],
    });

    const groupPost = fake.calls.find((c) => c.method === "POST" && c.path === "/Groups");
    // The member's native id is rewritten to the minted WorkOS id recorded in
    // the user phase; an unmapped member passes through untranslated.
    expect(groupPost?.json()).toEqual({
      displayName: "Eng",
      members: [{ value: "wos_9" }, { value: "missing" }],
    });
    expect(await mappingRows(env, directory.id)).toEqual([
      { resource_type: "Groups", native_id: "g1", workos_id: "wos_g7", strategy: "fallback-post" },
      { resource_type: "Users", native_id: "u1", workos_id: "wos_9", strategy: "fallback-post" },
    ]);

    // Second pass: fallback mappings PUT the minted id with no migrated-id header.
    const callsAfterFirst = fake.calls.length;
    const second = await runBackfill(env.DB, directory);
    expect(second.users).toEqual({ total: 1, mirrored: 1, failed: 0 });
    expect(second.groups).toEqual({ total: 1, mirrored: 1, failed: 0 });
    const secondPass = fake.calls.slice(callsAfterFirst).filter((c) => c.target === "workos");
    expect(secondPass.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /Users/wos_9",
      "PUT /Groups/wos_g7",
    ]);
    expect(secondPass[0].headers.get(MIGRATED_ID_HEADER)).toBeNull();
    expect(secondPass[1].headers.get(MIGRATED_ID_HEADER)).toBeNull();
  });

  it("records snapshot failures per kind and mirrors nothing for them", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", scimJson(500, { detail: "nope" }));
    fake.route("native", "GET", "/Groups", () => {
      throw new Error("connection reset");
    });

    const summary = await runBackfill(env.DB, directory);

    expect(summary).toEqual({
      users: { total: 0, mirrored: 0, failed: 0 },
      groups: { total: 0, mirrored: 0, failed: 0 },
      errors: ["Users snapshot: native returned 500", "Groups snapshot: connection reset"],
    });
    expect(fake.callsTo("workos")).toHaveLength(0);
  });

  it("fails a snapshot resource that has no id without touching WorkOS for it", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      "/Users",
      listPage([{ userName: "ghost@x.test" }, { id: "u1", userName: "one@x.test" }]),
    );
    fake.route("native", "GET", "/Groups", listPage([]));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.users).toEqual({ total: 2, mirrored: 1, failed: 1 });
    expect(summary.errors).toEqual(["Users: snapshot resource is missing an id"]);
    expect(fake.callsTo("workos").map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /Users/u1",
      "POST /Users",
    ]);
  });

  it("persists one proxy_log row per resource when log_persistence is on", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write", log_persistence: 1 });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", listPage([{ id: "u1", userName: "one@x.test" }]));
    fake.route(
      "native",
      "GET",
      "/Groups",
      listPage([{ id: "g1", displayName: "Eng", members: [{ value: "u1" }] }]),
    );
    installWorkosScim(fake);

    await runBackfill(env.DB, directory);

    const rows = await proxyLogRows(env);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.source, r.mode, r.method, r.path])).toEqual([
      ["backfill", "dual-write", "PUT", "/Users/u1"],
      ["backfill", "dual-write", "PUT", "/Groups/g1"],
    ]);
    // First touch resolved via the POST leg: the log records the translated shape.
    expect(rows[0].workos_request).toBe(`POST /Users +${MIGRATED_ID_HEADER}`);
    expect(rows[0].workos_status).toBe(201);
    expect(rows[0].response_status).toBe(201);
    expect(rows[0].error).toBeNull();
    expect(rows[0].directory_id).toBe(directory.id);
  });

  it("caps the error list at 20 while still counting every failure", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    const users = Array.from({ length: 25 }, (_, i) => ({
      id: `user-${i}`,
      userName: `user-${i}@x.test`,
    }));
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", listPage(users));
    fake.route("native", "GET", "/Groups", listPage([]));
    fake.route("workos", "PUT", "/Users/", scimJson(404, { detail: "not found" }));
    fake.route("workos", "POST", "/Users", scimJson(500, { detail: "boom" }));

    const summary = await runBackfill(env.DB, directory);

    expect(summary.users).toEqual({ total: 25, mirrored: 0, failed: 25 });
    expect(summary.errors).toHaveLength(20);
    expect(summary.errors[0]).toBe("Users/user-0: WorkOS POST returned 500");
  });

  // A group Okta pushed carries no externalId, and a native app may serialize
  // that as null — which WorkOS rejects with 400 invalidSyntax on every replayed
  // resource, failing the whole backfill.
  it("replays a group whose externalId is null without the null", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", listPage([]));
    fake.route(
      "native",
      "GET",
      "/Groups",
      listPage([
        {
          id: "g1",
          displayName: "e2e-eng-a",
          externalId: null,
          members: [{ value: "u1", display: null }],
        },
      ]),
    );
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.groups).toEqual({ total: 1, mirrored: 1, failed: 0 });
    expect(summary.errors).toEqual([]);
    const [put, post] = fake.callsTo("workos");
    expect(put.json()).toEqual({
      id: "g1",
      displayName: "e2e-eng-a",
      members: [{ value: "u1" }],
    });
    // The POST leg of the dance sends the same stripped body, minus the id.
    expect(post.json()).toEqual({ displayName: "e2e-eng-a", members: [{ value: "u1" }] });
  });
});

describe("runReconcileFromWorkos", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("replays the WorkOS snapshot into native as migrated-id PUTs with ids translated back", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "u1",
      workos_id: "wos_1",
      strategy: "fallback-post",
    });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Groups",
      native_id: "g1",
      workos_id: "wos_g1",
      strategy: "fallback-post",
    });
    fake = installFakeUpstreams();
    fake.route(
      "workos",
      "GET",
      "/Users",
      listPage([
        { id: "wos_1", userName: "one@x.test" },
        { id: "wos_2", userName: "two@x.test" },
      ]),
    );
    fake.route(
      "workos",
      "GET",
      "/Groups",
      listPage([
        { id: "wos_g1", displayName: "Eng", members: [{ value: "wos_1" }, { value: "wos_2" }] },
      ]),
    );
    fake.route("native", "PUT", /^\/(Users|Groups)\//, (call) => scimJson(200, call.json()));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary).toEqual({
      users: { total: 2, mirrored: 2, failed: 0 },
      groups: { total: 1, mirrored: 1, failed: 0 },
      errors: [],
    });
    expect(trail(fake)).toEqual([
      "workos GET /Users",
      "native PUT /Users/u1",
      "native PUT /Users/wos_2",
      "workos GET /Groups",
      "native PUT /Groups/g1",
    ]);

    const putU1 = fake.calls[1];
    expect(putU1.headers.get("Authorization")).toBe("Bearer native-secret");
    expect(putU1.headers.get(MIGRATED_ID_HEADER)).toBe("u1");
    expect(putU1.json()).toEqual({ id: "u1", userName: "one@x.test" });
    // A WorkOS resource with no mapping keeps its WorkOS id as the shared id.
    const putU2 = fake.calls[2];
    expect(putU2.headers.get(MIGRATED_ID_HEADER)).toBe("wos_2");
    expect(putU2.json()).toEqual({ id: "wos_2", userName: "two@x.test" });
    const putGroup = fake.calls[4];
    expect(putGroup.json()).toEqual({
      id: "g1",
      displayName: "Eng",
      members: [{ value: "u1" }, { value: "wos_2" }],
    });

    const rows = await proxyLogRows(env);
    expect(rows.map((r) => [r.source, r.path, r.native_status, r.error])).toEqual([
      ["backfill", "/Users/u1", 200, null],
      ["backfill", "/Users/wos_2", 200, null],
      ["backfill", "/Groups/g1", 200, null],
    ]);
  });

  it("counts a native leg that rejects the upsert as failed", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    fake = installFakeUpstreams();
    fake.route(
      "workos",
      "GET",
      "/Users",
      listPage([
        { id: "wos_1", userName: "one@x.test" },
        { id: "wos_2", userName: "two@x.test" },
      ]),
    );
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", "/Users/wos_1", scimJson(500, { detail: "nope" }));
    fake.route("native", "PUT", "/Users/", (call) => scimJson(200, call.json()));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users).toEqual({ total: 2, mirrored: 1, failed: 1 });
    expect(summary.errors).toEqual(["Users/wos_1: native returned 500"]);
  });

  it("counts a thrown native leg and an id-less WorkOS resource as failed", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    fake = installFakeUpstreams();
    fake.route(
      "workos",
      "GET",
      "/Users",
      listPage([{ userName: "ghost@x.test" }, { id: "wos_1", userName: "one@x.test" }]),
    );
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", "/Users/", () => {
      throw new Error("link down");
    });

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users).toEqual({ total: 2, mirrored: 0, failed: 2 });
    expect(summary.errors).toEqual([
      "Users: WorkOS resource is missing an id",
      "Users/wos_1: link down",
    ]);
    // The id-less resource never reaches native; only wos_1 was attempted.
    expect(fake.callsTo("native")).toHaveLength(1);
    // log_persistence defaults off: the reconcile writes nothing.
    expect(await proxyLogRows(env)).toEqual([]);
  });

  it("logs reconcile failures and URL-encodes translated native ids in the PUT path", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "user one",
      workos_id: "wos_1",
      strategy: "fallback-post",
    });
    fake = installFakeUpstreams();
    fake.route(
      "workos",
      "GET",
      "/Users",
      listPage([
        { id: "wos_1", userName: "one@x.test" },
        { id: "wos_2", userName: "two@x.test" },
      ]),
    );
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", "/Users/user%20one", scimJson(500, { detail: "nope" }));
    fake.route("native", "PUT", "/Users/", (call) => scimJson(200, call.json()));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    // The WorkOS snapshot leg carries the WorkOS bearer token.
    const snapshot = fake.callsTo("workos")[0];
    expect(snapshot.headers.get("Authorization")).toBe("Bearer workos-secret");

    expect(fake.callsTo("native").map((c) => c.path)).toEqual([
      "/Users/user%20one",
      "/Users/wos_2",
    ]);
    expect(summary.users).toEqual({ total: 2, mirrored: 1, failed: 1 });
    expect(summary.errors).toEqual(["Users/user one: native returned 500"]);

    // Failure rows land in proxy_log too, with the raw (undecoded) native id.
    const rows = await proxyLogRows(env);
    expect(rows.map((r) => [r.source, r.mode, r.method, r.path, r.native_status, r.error])).toEqual(
      [
        ["backfill", "workos-only", "PUT", "/Users/user one", 500, "native returned 500"],
        ["backfill", "workos-only", "PUT", "/Users/wos_2", 200, null],
      ],
    );
  });

  it("repairs a drifted native row on 409 by resolving on userName and mapping the shared id", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only", log_persistence: 1 });
    fake = installFakeUpstreams();
    // No mapping seeded: the shared id translates to itself, so reconcile first
    // PUTs /Users/shared-1. Native holds that user under the drifted IdP id, so
    // its userName collides → 409.
    fake.route("workos", "GET", "/Users", listPage([{ id: "shared-1", userName: "one@x.test" }]));
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", "/Users/shared-1", scimJson(409, { detail: "userName exists" }));
    fake.route("native", "GET", "/Users", () =>
      listPage([{ id: "idp-1", userName: "one@x.test" }]),
    );
    fake.route("native", "PUT", "/Users/idp-1", (call) => scimJson(200, call.json()));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    // The drifted row is repaired in place — never DELETEd.
    expect(fake.callsTo("native").map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "PUT /Users/shared-1",
      "GET /Users",
      "PUT /Users/idp-1",
    ]);
    expect(fake.callsTo("native").every((c) => c.method !== "DELETE")).toBe(true);
    // Counted as mirrored, with a distinct id-drift report.
    expect(summary.users).toEqual({ total: 1, mirrored: 1, failed: 0 });
    expect(summary.errors).toEqual([
      'Users/shared-1: id drift — userName "one@x.test" is native id idp-1, ' +
        "WorkOS holds shared-1; reconciled via mapping",
    ]);
    // The mapping row is what keeps the two sides translatable — the crux of the fix.
    expect(await mappingRows(env, directory.id)).toEqual([
      {
        resource_type: "Users",
        native_id: "idp-1",
        workos_id: "shared-1",
        strategy: "fallback-post",
      },
    ]);
    // The repair PUT carried the drifted id in both the path and the migrated-id header.
    const repair = fake.callsTo("native")[2];
    expect(repair.headers.get(MIGRATED_ID_HEADER)).toBe("idp-1");
    expect(repair.json()).toEqual({ id: "idp-1", userName: "one@x.test" });
  });

  it("repairs a drifted group on 409 by resolving on displayName", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    fake = installFakeUpstreams();
    fake.route("workos", "GET", "/Users", listPage([]));
    fake.route("workos", "GET", "/Groups", listPage([{ id: "shared-g1", displayName: "Eng" }]));
    fake.route(
      "native",
      "PUT",
      "/Groups/shared-g1",
      scimJson(409, { detail: "displayName exists" }),
    );
    fake.route("native", "GET", "/Groups", () => listPage([{ id: "idp-g1", displayName: "Eng" }]));
    fake.route("native", "PUT", "/Groups/idp-g1", (call) => scimJson(200, call.json()));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.groups).toEqual({ total: 1, mirrored: 1, failed: 0 });
    expect(summary.errors).toEqual([
      'Groups/shared-g1: id drift — displayName "Eng" is native id idp-g1, ' +
        "WorkOS holds shared-g1; reconciled via mapping",
    ]);
    expect(await mappingRows(env, directory.id)).toEqual([
      {
        resource_type: "Groups",
        native_id: "idp-g1",
        workos_id: "shared-g1",
        strategy: "fallback-post",
      },
    ]);
  });

  it("reports an unresolvable 409 distinctly and leaves it failed", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    fake = installFakeUpstreams();
    fake.route("workos", "GET", "/Users", listPage([{ id: "shared-1", userName: "one@x.test" }]));
    fake.route("workos", "GET", "/Groups", listPage([]));
    fake.route("native", "PUT", "/Users/shared-1", scimJson(409, { detail: "userName exists" }));
    // The lookup finds no matching row — the collision can't be attributed.
    fake.route("native", "GET", "/Users", listPage([]));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(summary.errors).toEqual([
      "Users/shared-1: native returned 409 (userName/displayName exists under a different id; drift unresolved)",
    ]);
    expect(await mappingRows(env, directory.id)).toEqual([]);
  });
});

describe("runBackfill snapshot edges", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("records a truncation error when an empty page arrives short of totalResults", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", (call) => {
      const start = new URL(call.path, "https://x").searchParams.get("startIndex");
      return start === "1"
        ? scimJson(200, {
            totalResults: 10,
            Resources: [
              { id: "u1", userName: "one@x.test" },
              { id: "u2", userName: "two@x.test" },
            ],
          })
        : scimJson(200, { totalResults: 10, Resources: [] });
    });
    fake.route("native", "GET", "/Groups", listPage([]));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    // What was enumerated is still replayed, but the shortfall is reported.
    expect(summary.users).toEqual({ total: 2, mirrored: 2, failed: 0 });
    expect(summary.errors).toEqual([
      "Users snapshot: native returned an empty page at 2 of 10 resources",
    ]);
    const snapshots = fake.callsTo("native").filter((c) => c.path.startsWith("/Users"));
    expect(snapshots.map((c) => c.path)).toEqual([
      "/Users?startIndex=1&count=100",
      "/Users?startIndex=3&count=100",
    ]);
  });

  it("carries totalResults forward when a later page omits it", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", (call) => {
      const start = new URL(call.path, "https://x").searchParams.get("startIndex");
      if (start === "1") {
        return scimJson(200, {
          totalResults: 3,
          Resources: [{ id: "u1", userName: "one@x.test" }],
        });
      }
      // Page 2 omits the total; the carried 3 keeps paging alive.
      return start === "2"
        ? scimJson(200, { Resources: [{ id: "u2", userName: "two@x.test" }] })
        : scimJson(200, { Resources: [] });
    });
    fake.route("native", "GET", "/Groups", listPage([]));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.users).toEqual({ total: 2, mirrored: 2, failed: 0 });
    expect(summary.errors).toEqual([
      "Users snapshot: native returned an empty page at 2 of 3 resources",
    ]);
    const snapshots = fake.callsTo("native").filter((c) => c.path.startsWith("/Users"));
    expect(snapshots.map((c) => c.path)).toEqual([
      "/Users?startIndex=1&count=100",
      "/Users?startIndex=2&count=100",
      "/Users?startIndex=3&count=100",
    ]);
  });

  it("keeps resources from earlier pages when a later page fails", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", (call) => {
      const start = new URL(call.path, "https://x").searchParams.get("startIndex");
      return start === "1"
        ? scimJson(200, {
            totalResults: 3,
            Resources: [
              { id: "u1", userName: "one@x.test" },
              { id: "u2", userName: "two@x.test" },
            ],
          })
        : scimJson(500, { detail: "boom" });
    });
    fake.route("native", "GET", "/Groups", listPage([]));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.errors).toEqual(["Users snapshot: native returned 500"]);
    // The partial snapshot is still replayed, not discarded.
    expect(summary.users).toEqual({ total: 2, mirrored: 2, failed: 0 });
  });

  it("treats a missing totalResults as a single page and skips non-record entries", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      "/Users",
      scimJson(200, { Resources: ["junk", { id: "u1", userName: "one@x.test" }] }),
    );
    fake.route("native", "GET", "/Groups", listPage([]));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary).toEqual({
      users: { total: 1, mirrored: 1, failed: 0 },
      groups: { total: 0, mirrored: 0, failed: 0 },
      errors: [],
    });
    const userSnapshots = fake.callsTo("native").filter((c) => c.path.startsWith("/Users"));
    expect(userSnapshots).toHaveLength(1);
  });

  it("fails the resource type when a 200 list body is not JSON", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", listPage([{ id: "u1", userName: "one@x.test" }]));
    fake.route("native", "GET", "/Groups", new Response("<html>oops</html>", { status: 200 }));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    // Users still mirror; the unusable Groups body is reported rather than read
    // as an empty directory.
    expect(summary).toEqual({
      users: { total: 1, mirrored: 1, failed: 0 },
      groups: { total: 0, mirrored: 0, failed: 0 },
      errors: ["Groups snapshot: native returned a list response that is not JSON"],
    });
    const groupSnapshots = fake.callsTo("native").filter((c) => c.path.startsWith("/Groups"));
    expect(groupSnapshots).toHaveLength(1);
  });

  it("fails the resource type when the list response has an empty body", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", new Response(null, { status: 204 }));
    fake.route("native", "GET", "/Groups", listPage([]));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.users).toEqual({ total: 0, mirrored: 0, failed: 0 });
    expect(summary.errors).toEqual([
      "Users snapshot: native returned a list response that is not JSON",
    ]);
  });

  it("fails the resource type when the list body has no Resources array", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", scimJson(200, { totalResults: 3, Resources: "nope" }));
    fake.route("native", "GET", "/Groups", scimJson(200, { detail: "who knows" }));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.errors).toEqual([
      "Users snapshot: native returned a list response without a Resources array",
      "Groups snapshot: native returned a list response without a Resources array",
    ]);
    expect(summary.users).toEqual({ total: 0, mirrored: 0, failed: 0 });
    expect(summary.groups).toEqual({ total: 0, mirrored: 0, failed: 0 });
  });

  it("reports no error for a genuinely empty directory", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", listPage([]));
    fake.route("native", "GET", "/Groups", scimJson(200, { totalResults: 0, Resources: [] }));
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary).toEqual({
      users: { total: 0, mirrored: 0, failed: 0 },
      groups: { total: 0, mirrored: 0, failed: 0 },
      errors: [],
    });
  });

  it("names the WorkOS side in reconcile snapshot errors", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "workos-only" });
    fake = installFakeUpstreams();
    fake.route("workos", "GET", "/Users", new Response("<html>oops</html>", { status: 200 }));
    fake.route("workos", "GET", "/Groups", scimJson(502, { detail: "bad gateway" }));

    const summary = await runReconcileFromWorkos(env.DB, directory);

    expect(summary.errors).toEqual([
      "Users snapshot: workos returned a list response that is not JSON",
      "Groups snapshot: workos returned 502",
    ]);
  });
});

describe("runBackfill logging and member passthrough", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("writes failure rows to proxy_log with the error and leg status", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write", log_persistence: 1 });
    fake = installFakeUpstreams();
    fake.route(
      "native",
      "GET",
      "/Users",
      listPage([
        { id: "u1", userName: "one@x.test" },
        { id: "u2", userName: "two@x.test" },
      ]),
    );
    fake.route("native", "GET", "/Groups", listPage([]));
    fake.route("workos", "PUT", "/Users/", (call) => {
      if (call.path === "/Users/u2") throw new Error("socket hang up");
      return scimJson(404, { detail: "not found" });
    });
    fake.route("workos", "POST", "/Users", scimJson(500, { detail: "boom" }));

    const summary = await runBackfill(env.DB, directory);

    expect(summary.users).toEqual({ total: 2, mirrored: 0, failed: 2 });
    const rows = await proxyLogRows(env);
    expect(
      rows.map((r) => [r.path, r.workos_request, r.workos_status, r.response_status, r.error]),
    ).toEqual([
      ["/Users/u1", `POST /Users +${MIGRATED_ID_HEADER}`, 500, 500, "WorkOS POST returned 500"],
      ["/Users/u2", `PUT /Users/u2 +${MIGRATED_ID_HEADER}`, null, null, "socket hang up"],
    ]);
    expect(await mappingRows(env, directory.id)).toEqual([]);
  });

  it("passes group member entries that are not translatable records through untouched", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake = installFakeUpstreams();
    fake.route("native", "GET", "/Users", listPage([{ id: "u1", userName: "one@x.test" }]));
    fake.route(
      "native",
      "GET",
      "/Groups",
      listPage([
        {
          id: "g1",
          displayName: "Eng",
          members: [{ value: "u1" }, "opaque", { value: 7 }, { display: "no value" }],
        },
      ]),
    );
    installWorkosScim(fake);

    const summary = await runBackfill(env.DB, directory);

    expect(summary.groups).toEqual({ total: 1, mirrored: 1, failed: 0 });
    const groupPost = fake.calls.find((c) => c.method === "POST" && c.path === "/Groups");
    expect(groupPost?.json()).toEqual({
      displayName: "Eng",
      members: [{ value: "u1" }, "opaque", { value: 7 }, { display: "no value" }],
    });
  });
});
