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
  type SeededDirectory,
} from "./helpers";

/**
 * VULN-3073 attacker-perspective reproduction.
 *
 * Two bridge directories (attacker A, victim B) front ONE flat native SCIM app
 * (shared namespace). The native app answers 2xx for any existing id and its
 * listing returns every co-tenant's rows. A stateful WorkOS side stands in for
 * A's WorkOS directory. The attacker only ever drives the proxy over HTTP with
 * A's proxy token; backfill/reconcile are the operator's runbook steps.
 */

/** A flat native SCIM app: one store, any token reads/replaces any row. */
function installFlatNative(fake: FakeUpstreams, seed: Record<string, Record<string, unknown>>) {
  const users = new Map<string, Record<string, unknown>>(Object.entries(seed));
  fake.route("native", "GET", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const row = users.get(id);
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("native", "GET", /^\/Users(\?|$)/, () =>
    scimJson(200, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: users.size,
      startIndex: 1,
      itemsPerPage: users.size,
      Resources: [...users.values()],
    }),
  );
  fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("native", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  return users;
}

/** A stateful WorkOS SCIM directory for A (PUT resolves-or-404s, POST creates). */
function installStatefulWorkos(fake: FakeUpstreams) {
  const users = new Map<string, Record<string, unknown>>();
  fake.route("workos", "GET", /^\/Users(\?|$)/, () =>
    scimJson(200, {
      totalResults: users.size,
      startIndex: 1,
      itemsPerPage: users.size,
      Resources: [...users.values()],
    }),
  );
  fake.route("workos", "GET", /^\/Groups(\?|$)/, () =>
    scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
  );
  fake.route("workos", "PUT", /^\/Users\/[^/?]+$/, (call) => {
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    if (!users.has(id)) return scimJson(404, { detail: "not found" });
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  fake.route("workos", "POST", /^\/Users(\?|$)/, (call) => {
    const id = call.headers.get(MIGRATED_ID_HEADER) ?? crypto.randomUUID();
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(201, body);
  });
  return users;
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

describe("VULN-3073: backfill claims co-tenant rows in a shared native namespace", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("refuses to claim a co-tenant native row, so the post-cutover write and reconcile never reach the victim's row", async () => {
    const env = await createEnv();
    // Attacker A and victim B front the SAME native app (default NATIVE_URL) => shared namespace.
    const attacker = await seedDirectory(env.DB, { name: "Org A (attacker)", mode: "dual-write" });
    const victim = await seedDirectory(env.DB, { name: "Org B (victim)", mode: "dual-write" });

    fake = installFakeUpstreams();
    const nativeStore = installFlatNative(fake, {
      "vic-1": { id: "vic-1", userName: "victim.user@orgb.example", active: true },
    });
    installStatefulWorkos(fake);

    // Operator runs the runbook's mandatory backfill for A. In a shared namespace
    // the unscoped native listing returns the neighbour's row, and backfill now
    // refuses to claim it instead of minting a trusted mapping.
    const backfill = await runBackfill(env.DB, attacker);
    expect(backfill.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(backfill.errors[0]).toContain("another directory fronts this native app");
    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND native_id = ?",
    )
      .bind(attacker.id, "vic-1")
      .first();
    expect(mapping).toBeNull();

    // Cutover: without a claim, the attacker's post-cutover replace is refused.
    await setMode(env.DB, attacker.id, "workos-only");
    const attackerNow = await reload(env.DB, attacker);
    const put = await send(env, attackerNow, "PUT", "/scim/v2/Users/vic-1", {
      userName: "attacker@evil.example",
      active: false,
    });
    expect(put.status).toBe(404);

    // And the operator's routine reconcile never targets the victim's row.
    await runReconcileFromWorkos(env.DB, attackerNow);
    const victimView = await send(env, victim, "GET", "/scim/v2/Users/vic-1");
    const seen = (await victimView.json()) as Record<string, unknown>;
    expect(seen.active).toBe(true);
    expect(seen.userName).toBe("victim.user@orgb.example");
    expect(nativeStore.get("vic-1")).toMatchObject({
      active: true,
      userName: "victim.user@orgb.example",
    });
  });

  it("still backfills every row when the directory has the native namespace to itself", async () => {
    const env = await createEnv();
    const only = await seedDirectory(env.DB, { name: "Org A", mode: "dual-write" });
    fake = installFakeUpstreams();
    installFlatNative(fake, {
      u1: { id: "u1", userName: "one@a.example", active: true },
      u2: { id: "u2", userName: "two@a.example", active: true },
    });
    installStatefulWorkos(fake);

    const backfill = await runBackfill(env.DB, only);
    expect(backfill.users).toEqual({ total: 2, mirrored: 2, failed: 0 });
    const { results } = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? ORDER BY native_id",
    )
      .bind(only.id)
      .all();
    expect(results.map((r) => r.native_id)).toEqual(["u1", "u2"]);
  });

  it("re-checks sharing per row: a namespace that becomes shared mid-backfill still refuses the co-tenant row", async () => {
    const env = await createEnv();
    const attacker = await seedDirectory(env.DB, { name: "Org A", mode: "dual-write" });

    fake = installFakeUpstreams();
    // The directory is alone when the run starts (not shared). The operator points a
    // second directory at the same native app while the snapshot is in flight.
    fake.route(
      "native",
      "GET",
      /^\/Users(\?|$)/,
      async () => {
        await seedDirectory(env.DB, { name: "Org B (configured mid-run)", mode: "dual-write" });
        return scimJson(200, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
          Resources: [{ id: "vic-1", userName: "victim.user@orgb.example", active: true }],
        });
      },
      { once: true },
    );
    fake.route("native", "GET", /^\/Groups(\?|$)/, () =>
      scimJson(200, { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }),
    );
    installStatefulWorkos(fake);

    // By the time the row is minted the namespace is shared, so it is refused even
    // though the run began un-shared.
    const backfill = await runBackfill(env.DB, attacker);
    expect(backfill.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    const mapping = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ? AND native_id = ?",
    )
      .bind(attacker.id, "vic-1")
      .first();
    expect(mapping).toBeNull();
  });

  it("negative control: with NO backfill, a post-cutover attacker PUT is refused (404)", async () => {
    const env = await createEnv();
    const attacker = await seedDirectory(env.DB, { name: "Org A", mode: "workos-only" });
    await seedDirectory(env.DB, { name: "Org B", mode: "dual-write" });
    fake = installFakeUpstreams();
    installFlatNative(fake, {
      "vic-1": { id: "vic-1", userName: "victim.user@orgb.example", active: true },
    });
    installStatefulWorkos(fake);

    const put = await send(env, attacker, "PUT", "/scim/v2/Users/vic-1", {
      userName: "attacker@evil.example",
      active: false,
    });
    // No mapping exists, shared namespace => replaceWithMigratedId refuses.
    expect(put.status).toBe(404);
  });
});
