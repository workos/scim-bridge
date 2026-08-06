import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  getMapping,
  listNativeWriteFailures,
  setDirectoryMode,
  upsertMapping,
} from "../workers/shared/db";
import type { Mode, PocEnv } from "../workers/shared/types";
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
 * ENT-6767, rung 3 of the ladder: WorkOS answers the IdP and the proxy still
 * writes the native app directly. Both legs run at once and the IdP is answered
 * only once both have finished.
 *
 * What these tests hold in place, in order of how expensive the mistake would be:
 *
 *   1. The IdP is never told a write succeeded when one side rejected it.
 *   2. A write WorkOS kept and native refused is recorded durably, whatever the
 *      directory's log settings say.
 *   3. A retry converges rather than duplicating — the property that makes
 *      "fail the request" a safe policy here at all.
 *   4. The legs overlap, so the mode costs max(native, workos) and not the sum.
 *   5. Native is still current at every rung, in both directions, with no
 *      reconcile and no backfill in between.
 */
describe("workos-primary", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  /** A directory on rung 3 with `native-1` already mapped to `workos-1`, the state
   *  a directory reaches by climbing from dual-write with a backfill behind it. */
  async function seedMapped(): Promise<SeededDirectory> {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "native-1",
      workos_id: "workos-1",
      strategy: "migrated-id",
    });
    return directory;
  }

  const ada = {
    userName: "ada@example.com",
    externalId: "idp-1",
    active: true,
  };

  function put(directory: SeededDirectory, body: unknown = ada): Promise<Response> {
    return proxyWorker.fetch(
      proxyRequest(directory, "PUT", "/scim/v2/Users/native-1", body),
      env,
      createCtx(),
    );
  }

  async function failures(directoryId: string) {
    return listNativeWriteFailures(env.DB, directoryId);
  }

  describe("both legs succeed", () => {
    it("writes both sides, answers the IdP in its own id space, and records nothing", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      expect(res.status).toBe(200);
      // The IdP addressed native-1 and must keep seeing native-1: WorkOS's id
      // never leaks into the IdP's id space, so a rollback to a native-writing
      // mode needs no re-keying on the IdP side.
      expect(await res.json()).toMatchObject({ id: "native-1" });
      expect(fake.callsTo("native").map((c) => `${c.method} ${c.path}`)).toEqual([
        "PUT /Users/native-1",
      ]);
      expect(fake.callsTo("workos").map((c) => `${c.method} ${c.path}`)).toEqual([
        "PUT /Users/workos-1",
      ]);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("serves reads from WorkOS, because WorkOS is the authoritative side", async () => {
      const directory = await seedMapped();
      fake.route("workos", "GET", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "GET", "/scim/v2/Users/native-1"),
        env,
        createCtx(),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "native-1" });
      expect(fake.callsTo("native")).toHaveLength(0);
    });
  });

  describe("native fails and WorkOS committed", () => {
    it("fails the IdP request with a 502 on a native 5xx and records the divergence", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      // 502 rather than native's 500: the write did land somewhere, and the IdP's
      // correct next move is to retry — which converges on WorkOS's copy.
      expect(res.status).toBe(502);
      const [failure] = await failures(directory.id);
      expect(failure).toMatchObject({
        resource_type: "Users",
        resource_key: "native-1",
        method: "PUT",
        native_status: 500,
        attempts: 1,
      });
      expect(failure.detail).toContain("WorkOS committed this write");
    });

    it("forwards a native 4xx unchanged, because a retry will only reproduce it", async () => {
      const directory = await seedMapped();
      fake.route(
        "native",
        "PUT",
        "/Users/native-1",
        scimJson(400, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "400",
        }),
      );
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      // Native's own answer, not a 502: the request is wrong on its merits, and
      // an operator reading the IdP's log needs to see why provisioning stopped
      // rather than a generic gateway error that invites an endless retry.
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ status: "400" });
      expect((await failures(directory.id))[0]).toMatchObject({
        native_status: 400,
      });
    });

    it("records the divergence even with log persistence off, which is the default", async () => {
      // The whole reason this is its own table rather than a proxy_log row: a
      // default directory persists no logs, and a divergence nobody can see
      // defeats the one promise this mode makes about the native app.
      const directory = await seedMapped();
      expect(directory.log_persistence).toBe(0);
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      await put(directory);

      const { results } = await env.DB.prepare("SELECT * FROM proxy_log").all();
      expect(results).toHaveLength(0);
      expect(await failures(directory.id)).toHaveLength(1);
    });

    it("keeps one row per resource as the IdP retries, counting the attempts", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      await put(directory);
      await put(directory);
      await put(directory);

      const rows = await failures(directory.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(3);
    });

    it("clears the row once a later write to the same resource reaches native", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(500, { detail: "boom" }), {
        once: true,
      });
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));
      await put(directory);
      expect(await failures(directory.id)).toHaveLength(1);

      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      const res = await put(directory);

      expect(res.status).toBe(200);
      expect(await failures(directory.id)).toEqual([]);
    });

    it("records an unreachable native endpoint, which reports no status at all", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", () => {
        throw new TypeError("fetch failed");
      });
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));

      const res = await put(directory);

      expect(res.status).toBe(502);
      expect((await failures(directory.id))[0]).toMatchObject({
        native_status: null,
        resource_key: "native-1",
      });
    });
  });

  describe("WorkOS fails and native committed", () => {
    it("fails the IdP request and records nothing, because native is not the side behind", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(503, { detail: "unavailable" }));

      const res = await put(directory);

      expect(res.status).toBeGreaterThanOrEqual(400);
      // native_write_failures answers "what is native missing". Here native has
      // the write and WorkOS does not, so a row would send an operator to
      // reconcile FROM the stale side — exactly the wrong repair.
      expect(await failures(directory.id)).toEqual([]);
    });
  });

  describe("creates", () => {
    it("runs both legs at once when the IdP supplies an externalId", async () => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      let nativeStarted = false;
      let workosStartedBeforeNativeFinished = false;
      let releaseNative: () => void = () => {};
      const nativeGate = new Promise<void>((resolve) => {
        releaseNative = resolve;
      });
      fake.route("native", "POST", "/Users", async () => {
        nativeStarted = true;
        await nativeGate;
        return scimJson(201, { id: "native-uuid", ...ada });
      });
      fake.route("workos", "PUT", "/Users/idp-1", () => {
        // Reached while the native leg is still in flight, which is the property
        // under test: the legs overlap instead of queueing behind each other.
        workosStartedBeforeNativeFinished = nativeStarted;
        releaseNative();
        return scimJson(404, { detail: "no such user" });
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "idp-1", ...ada }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );

      expect(res.status).toBe(201);
      expect(workosStartedBeforeNativeFinished).toBe(true);
      // The IdP is answered with native's id, and the mapping is keyed on it —
      // not on the id WorkOS minted from the externalId. A mapping keyed on the
      // minted id would claim a native row that does not exist.
      expect(await res.json()).toMatchObject({ id: "native-uuid" });
      const mapping = await getMapping(env.DB, directory.id, "Users", "native-uuid");
      expect(mapping).toMatchObject({
        workos_id: "idp-1",
        strategy: "fallback-post",
      });
    });

    it("stays native-first without an externalId, so both sides share native's id", async () => {
      // Nothing here is derivable from the request: two concurrent legs would each
      // mint an id the other never sees, and the resource would exist twice under
      // two unrelated ids. Serializing costs one round trip, once per resource.
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const { userName } = ada;
      fake.route("native", "POST", "/Users", scimJson(201, { id: "native-uuid", userName }));
      fake.route("workos", "PUT", "/Users/native-uuid", scimJson(404, { detail: "no such user" }));
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "native-uuid", userName }));

      const res = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", { userName }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ id: "native-uuid" });
      expect(fake.calls[0]).toMatchObject({ target: "native", method: "POST" });
      expect(await getMapping(env.DB, directory.id, "Users", "native-uuid")).toMatchObject({
        workos_id: "native-uuid",
        strategy: "migrated-id",
      });
    });

    it("converges on a retry instead of creating the resource twice", async () => {
      // The property that makes failing the IdP request safe. First attempt:
      // WorkOS creates, native rejects. Retry: WorkOS resolves its existing row
      // by id, and native answers 409 for the resource it already holds, which is
      // resolved to that row rather than reported.
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      fake.route("native", "POST", "/Users", scimJson(500, { detail: "boom" }), { once: true });
      fake.route("workos", "PUT", "/Users/idp-1", scimJson(404, { detail: "absent" }), {
        once: true,
      });
      fake.route("workos", "POST", "/Users", scimJson(201, { id: "idp-1", ...ada }), {
        once: true,
      });

      const first = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );
      expect(first.status).toBe(502);
      expect((await failures(directory.id))[0]).toMatchObject({
        resource_key: "idp-1",
        method: "POST",
      });

      // The retry, against upstreams that now hold what the first attempt left.
      fake.route("native", "POST", "/Users", scimJson(409, { detail: "userName exists" }));
      fake.route("native", "GET", "/Users?filter=", scimJson(200, { Resources: [{ id: "n-1" }] }));
      fake.route("workos", "PUT", "/Users/idp-1", scimJson(200, { id: "idp-1", ...ada }));

      const second = await proxyWorker.fetch(
        proxyRequest(directory, "POST", "/scim/v2/Users", ada),
        env,
        createCtx(),
      );

      expect(second.status).toBe(201);
      expect(await second.json()).toMatchObject({ id: "n-1" });
      // One WorkOS resource, one mapping, and the divergence is gone.
      expect(fake.callsTo("workos").filter((c) => c.method === "POST")).toHaveLength(1);
      expect(await getMapping(env.DB, directory.id, "Users", "n-1")).toMatchObject({
        workos_id: "idp-1",
      });
      expect(await failures(directory.id)).toEqual([]);
    });
  });

  it("costs max(native, workos) rather than the sum", async () => {
    const directory = await seedMapped();
    const delay = 120;
    const slow = (body: unknown) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return scimJson(200, body);
    };
    fake.route("native", "PUT", "/Users/native-1", slow({ id: "native-1", ...ada }));
    fake.route("workos", "PUT", "/Users/workos-1", slow({ id: "workos-1", ...ada }));

    const started = Date.now();
    const res = await put(directory);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    // Sequential legs would take at least 2 × delay. The midpoint is a wide
    // enough margin to survive a loaded CI box without admitting a serial
    // implementation.
    expect(elapsed).toBeLessThan(delay * 1.5);
  });

  describe("the ladder", () => {
    /** Set the mode the way the panel does, and nothing else — no reconcile, no
     *  backfill. Every rung change on this ladder is supposed to be this cheap. */
    async function setMode(directory: SeededDirectory, mode: Mode): Promise<void> {
      await setDirectoryMode(env.DB, directory.id, mode);
    }

    it("keeps native current climbing 1 → 2 → 3 → 4 and coming back down", async () => {
      const directory = await seedMapped();
      fake.route("native", "PUT", /^\/Users\/native-1/, scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", /^\/Users\/workos-1/, scimJson(200, { id: "workos-1", ...ada }));

      const nativeWrites = () => fake.callsTo("native").filter((c) => c.method === "PUT").length;
      const seen: Record<string, { status: number; nativeWrites: number }> = {};
      const ladder: Mode[] = [
        "passthrough",
        "dual-write",
        "workos-primary",
        "workos-only",
        "workos-primary",
        "dual-write",
        "passthrough",
      ];
      for (const mode of ladder) {
        await setMode(directory, mode);
        const before = nativeWrites();
        const res = await put(directory);
        seen[`${mode}@${Object.keys(seen).length}`] = {
          status: res.status,
          nativeWrites: nativeWrites() - before,
        };
      }

      // Every rung answers the IdP successfully, and native receives the write
      // directly on every rung except the cutover — including on the way back
      // down, with no reconcile and no backfill in between.
      expect(Object.values(seen).map((s) => s.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
      expect(Object.values(seen).map((s) => s.nativeWrites)).toEqual([1, 1, 1, 0, 1, 1, 1]);
    });

    it("does not require a reconcile to leave workos-primary", async () => {
      // The customer's actual worry: "I wouldn't have to worry about backfilling
      // the old system." Native was written on every request while on rung 3, so
      // dropping back to dual-write is a mode change and the next write proves it.
      const directory = await seedMapped();
      fake.route("native", "PUT", "/Users/native-1", scimJson(200, { id: "native-1", ...ada }));
      fake.route("workos", "PUT", "/Users/workos-1", scimJson(200, { id: "workos-1", ...ada }));
      await put(directory);

      await setMode(directory, "dual-write");
      const res = await put(directory);

      expect(res.status).toBe(200);
      expect(await failures(directory.id)).toEqual([]);
    });
  });
});
