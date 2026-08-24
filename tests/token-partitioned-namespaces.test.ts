import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { runBackfill, runReconcileFromWorkos } from "../workers/shared/backfill";
import { MIGRATED_ID_HEADER, type PocEnv } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
  type RecordedCall,
  type SeededDirectory,
} from "./helpers";

/**
 * The ENT-6878 opt-out, end to end: two directories front ONE native URL whose
 * SCIM service genuinely isolates rows by bearer token, each directory is
 * attested `native_token_partitioned` with its own token, and the shared-
 * namespace guards stand down — for exactly this configuration. The same native
 * id exists under both tenants and is two different people, which is the shape
 * the guards exist to protect and the attestation takes responsibility for.
 *
 * `distinct-native-tokens.test.ts` is this file's mandatory counterpart: the
 * SAME topology WITHOUT the attestations, where every guard must still fire.
 */

/** A native SCIM app that actually partitions: one row store per bearer token. */
function installPartitionedNative(fake: FakeUpstreams, stores: Map<string, Map<string, unknown>>) {
  const storeFor = (call: RecordedCall) => {
    const token = (call.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    return stores.get(token) ?? null;
  };
  fake.route("native", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const users = storeFor(call);
    if (!users) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const row = users.get(id);
    return row
      ? scimJson(200, row as Record<string, unknown>)
      : scimJson(404, { detail: "not found" });
  });
  fake.route("native", "GET", /^\/Users(\?|$)/, (call) => {
    const users = storeFor(call);
    if (!users) return scimJson(401, { detail: "bad token" });
    return scimJson(200, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: users.size,
      startIndex: 1,
      itemsPerPage: users.size,
      Resources: [...users.values()],
    });
  });
  fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("native", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const users = storeFor(call);
    if (!users) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
}

/** Two separate WorkOS directories behind one fake, told apart by bearer token —
 *  as in production, where each directory has its own WorkOS endpoint and
 *  credential. PUT resolves-or-404s, POST creates under the migrated id. */
function installPartitionedWorkos(fake: FakeUpstreams, stores: Map<string, Map<string, unknown>>) {
  const storeFor = (call: RecordedCall) => {
    const token = (call.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    return stores.get(token) ?? null;
  };
  fake.route("workos", "GET", /^\/Users(\?|$)/, (call) => {
    const users = storeFor(call);
    if (!users) return scimJson(401, { detail: "bad token" });
    return scimJson(200, {
      totalResults: users.size,
      startIndex: 1,
      itemsPerPage: users.size,
      Resources: [...users.values()],
    });
  });
  fake.route("workos", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("workos", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const users = storeFor(call);
    if (!users) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("workos", "POST", /^\/Users(\?|$)/, (call) => {
    const users = storeFor(call);
    if (!users) return scimJson(401, { detail: "bad token" });
    const id = call.headers.get(MIGRATED_ID_HEADER) ?? crypto.randomUUID();
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(201, body);
  });
}

async function setMode(db: PocEnv["DB"], id: string, mode: string) {
  await db.prepare("UPDATE scim_directories SET mode = ? WHERE id = ?").bind(mode, id).run();
}

async function reload(db: PocEnv["DB"], seeded: SeededDirectory): Promise<SeededDirectory> {
  const row = await db
    .prepare("SELECT * FROM scim_directories WHERE id = ?")
    .bind(seeded.id)
    .first();
  return { ...(row as object), proxy_token: seeded.proxy_token } as SeededDirectory;
}

async function send(
  env: PocEnv,
  directory: SeededDirectory,
  method: string,
  path: string,
  body?: unknown,
) {
  const ctx = createCtx();
  const res = await proxyWorker.fetch(proxyRequest(directory, method, path, body), env, ctx);
  await ctx.drain();
  return res;
}

describe("token-partitioned native namespaces (attested)", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  async function seedTenants(env: PocEnv) {
    const orgA = await seedDirectory(env.DB, {
      name: "Org A",
      mode: "dual-write",
      native_token: "native-token-A",
      native_token_partitioned: 1,
      workos_token: "workos-token-A",
    });
    const orgB = await seedDirectory(env.DB, {
      name: "Org B",
      mode: "dual-write",
      native_token: "native-token-B",
      native_token_partitioned: 1,
      workos_token: "workos-token-B",
    });
    return { orgA, orgB };
  }

  it("migrates both tenants through one URL: same native id, two people, zero crosstalk", async () => {
    const env = await createEnv();
    const { orgA, orgB } = await seedTenants(env);

    fake = installFakeUpstreams();
    // The precondition being attested: the app really does isolate by token, and
    // native id u-1 is a DIFFERENT person under each tenant's token.
    const nativeStores = new Map<string, Map<string, unknown>>([
      [
        "native-token-A",
        new Map([["u-1", { id: "u-1", userName: "alice@orga.example", active: true }]]),
      ],
      [
        "native-token-B",
        new Map([["u-1", { id: "u-1", userName: "bob@orgb.example", active: true }]]),
      ],
    ]);
    const workosStores = new Map<string, Map<string, unknown>>([
      ["workos-token-A", new Map()],
      ["workos-token-B", new Map()],
    ]);
    installPartitionedNative(fake, nativeStores);
    installPartitionedWorkos(fake, workosStores);

    // Backfill mirrors each tenant's own row — the config the old rule forced
    // onto per-tenant paths now migrates as-is.
    const backfillA = await runBackfill(env.DB, orgA);
    expect(backfillA.errors).toEqual([]);
    expect(backfillA.users).toEqual({ total: 1, mirrored: 1, failed: 0 });
    const backfillB = await runBackfill(env.DB, orgB);
    expect(backfillB.users).toEqual({ total: 1, mirrored: 1, failed: 0 });
    expect(workosStores.get("workos-token-A")?.get("u-1")).toMatchObject({
      userName: "alice@orga.example",
    });
    expect(workosStores.get("workos-token-B")?.get("u-1")).toMatchObject({
      userName: "bob@orgb.example",
    });
    // The id the ticket names: native id u-1 legitimately mapped by BOTH
    // directories, one row each.
    for (const d of [orgA, orgB]) {
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM id_mappings WHERE directory_id = ? AND native_id = 'u-1'",
        )
          .bind(d.id)
          .first<{ n: number }>(),
      ).toMatchObject({ n: 1 });
    }

    // Post-cutover, A's write to its own native id flows instead of 404ing.
    await setMode(env.DB, orgA.id, "workos-only");
    const put = await send(env, await reload(env.DB, orgA), "PUT", "/scim/v2/Users/u-1", {
      userName: "alice@orga.example",
      active: false,
    });
    expect(put.status).toBe(200);
    expect(workosStores.get("workos-token-A")?.get("u-1")).toMatchObject({ active: false });
    // …and B's copies — same native id, other tenant — are untouched.
    expect(workosStores.get("workos-token-B")?.get("u-1")).toMatchObject({ active: true });
    expect(nativeStores.get("native-token-B")?.get("u-1")).toMatchObject({ active: true });

    // A's reconcile replays into A's partition only: bob keeps his row even
    // though it sits at the same native id.
    const reconcile = await runReconcileFromWorkos(env.DB, await reload(env.DB, orgA));
    expect(reconcile.errors).toEqual([]);
    expect(reconcile.users.failed).toBe(0);
    expect(nativeStores.get("native-token-A")?.get("u-1")).toMatchObject({ active: false });
    expect(nativeStores.get("native-token-B")?.get("u-1")).toMatchObject({
      userName: "bob@orgb.example",
      active: true,
    });
  });

  it("stands the guards back up the moment an unattested directory joins the URL", async () => {
    const env = await createEnv();
    const { orgA } = await seedTenants(env);
    // A third directory on the same URL WITHOUT the attestation: the group no
    // longer has every tenant opted in, so A's own attestation stops counting.
    await seedDirectory(env.DB, {
      name: "Org C (unattested)",
      mode: "dual-write",
      native_token: "native-token-C",
    });

    fake = installFakeUpstreams();
    installPartitionedNative(
      fake,
      new Map([
        [
          "native-token-A",
          new Map([["u-1", { id: "u-1", userName: "alice@orga.example", active: true }]]),
        ],
      ]),
    );
    installPartitionedWorkos(fake, new Map([["workos-token-A", new Map()]]));

    const backfill = await runBackfill(env.DB, orgA);
    expect(backfill.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(backfill.errors[0]).toContain("another directory fronts this native app");
  });
});
