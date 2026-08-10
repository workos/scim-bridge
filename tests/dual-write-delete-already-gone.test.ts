import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  listNativeWriteFailures,
  recordNativeWriteFailure,
  upsertMapping,
} from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

/**
 * The dual-write DELETE strand found in the 2026-08-07 demo run.
 *
 * `dualWrite` gated the whole mirror leg on `isSuccess(native.status)`. For
 * POST/PUT/PATCH that is right — a native 404 means the write did not land, and
 * mirroring it would manufacture drift the other way. For DELETE it is backwards:
 * a native 404 says the resource is ALREADY absent, which is the state the request
 * asked for. Cancelling the WorkOS leg left the user live in WorkOS, the proxy
 * handed native's 404 back, and the IdP — reading an idempotent delete as done —
 * never retried. Nothing else in the system removes that row.
 *
 * The live run logged 14 of these (`method='DELETE' AND mode LIKE 'dual%' AND
 * native_status=404 AND workos_status IS NULL`), leaving bob.baker@acme.test
 * active in WorkOS while absent from both the native app and the IdP.
 *
 * These tests pin both halves of the rule: the DELETE-404 mirror now runs, and the
 * narrowing holds so a later refactor cannot widen it to other methods or other
 * 4xx. Everything is driven through the real proxy handler with the IdP's proxy
 * token, the interface the IdP actually uses.
 */
describe("dual-write mirrors a DELETE native reports already gone", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  it("runs the WorkOS DELETE leg when native answers 404, and still returns native's 404", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "u9",
      workos_id: "wos_9",
      strategy: "migrated-id",
    });
    fake.route("native", "DELETE", "/Users/u9", scimJson(404, { detail: "not found" }));
    fake.route("workos", "DELETE", "/Users/wos_9", new Response(null, { status: 204 }));

    const ctx = createCtx();
    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"),
      env,
      ctx,
    );
    await ctx.drain();

    // The mirror ran against the translated id — this is the assertion the bug
    // fails: before the fix `callsTo("workos")` is empty and the user stays live.
    const mirror = fake.callsTo("workos");
    expect(mirror).toHaveLength(1);
    expect(mirror[0].method).toBe("DELETE");
    expect(mirror[0].path).toBe("/Users/wos_9");

    // Native's 404 is still what the IdP hears. That is honest, and it is correct
    // precisely because the mirror has now actually run.
    expect(res.status).toBe(404);

    // Both sides are absent, so the mapping must not keep claiming the resource
    // is live.
    const { results } = await env.DB.prepare(
      "SELECT native_id FROM id_mappings WHERE directory_id = ?",
    )
      .bind(directory.id)
      .all();
    expect(results).toEqual([]);
  });

  it("mirrors an unmapped DELETE native reports gone, under the shared native id", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake.route("native", "DELETE", "/Users/u404", scimJson(404, { detail: "not found" }));
    fake.route("workos", "DELETE", "/Users/u404", new Response(null, { status: 204 }));

    const ctx = createCtx();
    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/u404"),
      env,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(404);
    expect(fake.callsTo("workos").map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /Users/u404",
    ]);
  });

  it("retires the divergence row for a resource native reports already gone", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    // A gap recorded while this directory was on workos-primary: WorkOS committed
    // a write native never took. The resource is now absent from native, so the
    // row no longer describes anything outstanding.
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "u9",
      method: "PUT",
      native_status: 500,
      detail: "WorkOS committed this write; native did not: native returned 500",
    });
    fake.route("native", "DELETE", "/Users/u9", scimJson(404, { detail: "not found" }));
    fake.route("workos", "DELETE", "/Users/u9", new Response(null, { status: 204 }));

    const ctx = createCtx();
    await proxyWorker.fetch(proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"), env, ctx);
    await ctx.drain();

    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });

  it("still suppresses the mirror when native 404s a PUT, PATCH or POST", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    for (const method of ["PUT", "PATCH", "POST"] as const) {
      fake.route("native", method, /^\/Users/, scimJson(404, { detail: "not found" }));
      // Deliberately wide, so a widened guard is caught wherever it aims.
      fake.route("workos", method, /^\/Users/, () => scimJson(200, { id: "should-not-be-called" }));
    }

    for (const [method, path, body] of [
      ["PUT", "/scim/v2/Users/u9", { userName: "gone@x.test" }],
      ["PATCH", "/scim/v2/Users/u9", { Operations: [{ op: "replace", value: { active: false } }] }],
      ["POST", "/scim/v2/Users", { userName: "gone@x.test" }],
    ] as const) {
      const ctx = createCtx();
      const res = await proxyWorker.fetch(proxyRequest(directory, method, path, body), env, ctx);
      await ctx.drain();
      expect(res.status).toBe(404);
    }

    // A 404 on these means the write genuinely did not happen. Mirroring it would
    // create the opposite drift, so the WorkOS side must stay untouched.
    expect(fake.callsTo("workos")).toEqual([]);
  });

  it("still suppresses the mirror on a DELETE native rejects with some other 4xx", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    fake.route("workos", "DELETE", /^\/Users/, () => new Response(null, { status: 204 }));

    // None of these say "already in the requested state": 403 is a refusal, 409 a
    // conflict, 410 arrives with the resource's own tombstone semantics rather
    // than native's "no such path". Only 404 earns the mirror.
    const statuses = [400, 403, 409, 410, 429] as const;
    for (const status of statuses) {
      fake.route("native", "DELETE", "/Users/u9", scimJson(status, { detail: "no" }), {
        once: true,
      });
    }

    for (const status of statuses) {
      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"),
        env,
        ctx,
      );
      await ctx.drain();
      expect(res.status).toBe(status);
    }

    expect(fake.callsTo("workos")).toEqual([]);
  });

  /**
   * `workos-primary` runs both legs concurrently and starts the WorkOS leg before
   * either is awaited, so a native 404 cannot cancel it — the mode has no gate to
   * get backwards. Pinned here rather than argued in a comment: the strand this
   * suite fixes for dual-write must not be reintroduced there by a later change
   * that makes the WorkOS leg conditional on native's answer.
   */
  it("workos-primary already deletes from WorkOS when native answers 404", async () => {
    const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    await upsertMapping(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      native_id: "u9",
      workos_id: "wos_9",
      strategy: "migrated-id",
    });
    fake.route("native", "DELETE", "/Users/u9", scimJson(404, { detail: "not found" }));
    fake.route("workos", "DELETE", "/Users/wos_9", new Response(null, { status: 204 }));

    const ctx = createCtx();
    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"),
      env,
      ctx,
    );
    await ctx.drain();

    expect(fake.callsTo("workos").map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /Users/wos_9",
    ]);
    // 204, not the 404 this asserted while `workosPrimary` read a native DELETE
    // 404 as a failed leg. It now reads it the way this suite reads it for
    // dual-write: native not holding the resource is the state the DELETE asked
    // for. WorkOS did the work and the resource is absent on both sides, so the
    // IdP hears WorkOS's success rather than a failure for a deprovision that
    // landed. What this test is here to pin — that the WorkOS leg runs at all —
    // is the assertion above and is unchanged.
    expect(res.status).toBe(204);
    // And the phantom row that motivated the change: recording one here claimed
    // native was missing a resource it had just reported it does not hold, and
    // nothing could ever retire it.
    expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);
  });
});
