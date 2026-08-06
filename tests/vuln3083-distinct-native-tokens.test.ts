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
 * VULN-3083: two bridge directories (attacker A, victim B) front ONE native SCIM
 * app on the same `native_url` with DISTINCT native tokens. The native app accepts
 * either token over one flat user set — it does not partition rows per credential,
 * which the bridge cannot verify — so the ids collide even though the tokens
 * differ, and every shared-namespace guard must still fire.
 *
 * The attacker only ever drives the proxy over HTTP with A's own proxy token;
 * backfill, cutover and reconcile are the operator's documented runbook steps.
 */

/** A flat native SCIM app: one store, ANY accepted token reads/replaces any row. */
function installFlatNative(
  fake: FakeUpstreams,
  seed: Record<string, Record<string, unknown>>,
  accepted: string[],
) {
  const users = new Map<string, Record<string, unknown>>(Object.entries(seed));
  const tokensSeen = new Set<string>();
  const auth = (call: { headers: Headers }) => {
    const token = (call.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    tokensSeen.add(token);
    return accepted.includes(token);
  };
  fake.route("native", "GET", /^\/Users\/[^/?]+$/, (call) => {
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const row = users.get(id);
    return row ? scimJson(200, row) : scimJson(404, { detail: "not found" });
  });
  fake.route("native", "GET", /^\/Users(\?|$)/, (call) => {
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
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
    if (!auth(call)) return scimJson(401, { detail: "bad token" });
    const id = decodeURIComponent(call.path.split("?")[0].split("/")[2]);
    const body = { ...(call.json() as Record<string, unknown>), id };
    users.set(id, body);
    return scimJson(200, body);
  });
  return { users, tokensSeen };
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

describe("VULN-3083: distinct native tokens on one flat native app", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("refuses to claim a co-tenant row, so no post-cutover write or reconcile reaches the victim's row", async () => {
    const env = await createEnv();
    const attacker = await seedDirectory(env.DB, {
      name: "Org A (attacker)",
      mode: "dual-write",
      native_token: "native-token-A",
    });
    const victim = await seedDirectory(env.DB, {
      name: "Org B (victim)",
      mode: "dual-write",
      native_token: "native-token-B",
    });

    fake = installFakeUpstreams();
    const native = installFlatNative(
      fake,
      { "vic-1": { id: "vic-1", userName: "victim.user@orgb.example", active: true } },
      ["native-token-A", "native-token-B"],
    );
    const workos = installStatefulWorkos(fake);

    // The operator's mandatory backfill must not attribute the co-tenant row to A,
    // so no victim PII reaches A's WorkOS directory and no mapping is minted.
    const backfill = await runBackfill(env.DB, attacker);
    expect(backfill.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    expect(backfill.errors[0]).toContain("another directory fronts this native app");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM id_mappings WHERE directory_id = ?")
        .bind(attacker.id)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 0 });
    expect([...workos.values()]).toEqual([]);

    // Post-cutover, the attacker's replace of the victim's native id is refused.
    await setMode(env.DB, attacker.id, "workos-only");
    const attackerNow = await reload(env.DB, attacker);
    const put = await send(env, attackerNow, "PUT", "/scim/v2/Users/vic-1", {
      userName: "attacker@evil.example",
      active: false,
    });
    expect(put.status).toBe(404);

    // And the operator's reconcile has nothing of the victim's to push back.
    await runReconcileFromWorkos(env.DB, attackerNow);
    const victimView = await send(env, victim, "GET", "/scim/v2/Users/vic-1");
    expect(victimView.status).toBe(200);
    expect(await victimView.json()).toMatchObject({
      userName: "victim.user@orgb.example",
      active: true,
    });
    expect(native.users.get("vic-1")).toMatchObject({
      userName: "victim.user@orgb.example",
      active: true,
    });
    // Both tokens really do reach one flat row set — the precondition held.
    expect([...native.tokensSeen].sort()).toEqual(["native-token-A", "native-token-B"]);
  });

  it("same native token on both directories: the guards fire identically", async () => {
    const env = await createEnv();
    const attacker = await seedDirectory(env.DB, {
      name: "Org A",
      mode: "dual-write",
      native_token: "native-token-shared",
    });
    await seedDirectory(env.DB, {
      name: "Org B",
      mode: "dual-write",
      native_token: "native-token-shared",
    });
    fake = installFakeUpstreams();
    const native = installFlatNative(
      fake,
      { "vic-1": { id: "vic-1", userName: "victim.user@orgb.example", active: true } },
      ["native-token-shared"],
    );
    installStatefulWorkos(fake);

    const backfill = await runBackfill(env.DB, attacker);
    expect(backfill.users).toEqual({ total: 1, mirrored: 0, failed: 1 });
    await setMode(env.DB, attacker.id, "workos-only");
    const put = await send(env, await reload(env.DB, attacker), "PUT", "/scim/v2/Users/vic-1", {
      userName: "attacker@evil.example",
      active: false,
    });
    expect(put.status).toBe(404);
    expect(native.users.get("vic-1")).toMatchObject({
      userName: "victim.user@orgb.example",
      active: true,
    });
  });
});
