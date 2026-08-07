import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { listNativeWriteFailures, recordNativeWriteFailure } from "../workers/shared/db";
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
 * What the already-gone path (#78) may retire, and when.
 *
 * A native 404 is not a write native accepted — it is native declining to speak
 * about the path. So it is evidence about the path id and nothing else, and the
 * clear it triggers has to be scoped to that: keying off the request body as the
 * 2xx path does let any holder of the directory's proxy token retire divergence
 * rows for resources the request never touched (VULN-3108). Nor is the row stale
 * until the mirror has actually dropped the resource from WorkOS, which is the
 * only leg that closes the gap here.
 *
 * `native_write_failures` is the operator's cutover gate and `proxy_log` is off
 * by default, so a `method='DELETE'` row erased this way is a terminated user the
 * panel silently stops reporting as still live in the customer's app.
 *
 * Everything runs through the real proxy handler with the directory's proxy
 * bearer token — the interface the IdP uses.
 */
describe("dual-write DELETE already-gone: scope of the divergence clear", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  afterEach(() => fake.restore());
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });

  // Recorded while the directory was on `workos-primary`: WorkOS committed the
  // deprovision, native refused it, and native still holds both users.
  async function seedDeprovisioningGaps(directoryId: string): Promise<void> {
    for (const key of ["u9", "victim@acme.test"]) {
      await recordNativeWriteFailure(env.DB, {
        directory_id: directoryId,
        resource_type: "Users",
        resource_key: key,
        method: "DELETE",
        native_status: 500,
        detail: "WorkOS committed this write; native did not: native returned 500",
      });
    }
  }

  function routeAlreadyGone(path: string): void {
    fake.route("native", "DELETE", path, scimJson(404, { detail: "no such user" }));
    fake.route("workos", "DELETE", path, scimJson(404, { detail: "no such user" }));
  }

  it("ignores request-body keys, which name resources native never spoke about", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    await seedDeprovisioningGaps(directory.id);
    // Native answers 404 for an id it does not hold, whatever the body says.
    routeAlreadyGone("/Users/zzz-nonexistent");

    const ctx = createCtx();
    const res = await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/zzz-nonexistent", {
        externalId: "u9",
        userName: "victim@acme.test",
      }),
      env,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(404);
    // Nothing was deprovisioned anywhere, so both gaps are still open.
    expect(
      (await listNativeWriteFailures(env.DB, directory.id)).map((row) => row.resource_key).sort(),
    ).toEqual(["u9", "victim@acme.test"]);
  });

  it("ignores an id in the 404 body, which is an error rather than a resource", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    await seedDeprovisioningGaps(directory.id);
    fake.route(
      "native",
      "DELETE",
      "/Users/zzz-nonexistent",
      scimJson(404, { id: "u9", detail: "no such user" }),
    );
    fake.route("workos", "DELETE", "/Users/zzz-nonexistent", scimJson(404, { detail: "gone" }));

    const ctx = createCtx();
    await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/zzz-nonexistent"),
      env,
      ctx,
    );
    await ctx.drain();

    expect(
      (await listNativeWriteFailures(env.DB, directory.id)).map((row) => row.resource_key).sort(),
    ).toEqual(["u9", "victim@acme.test"]);
  });

  it("leaves rows standing for a DELETE that names no resource at all", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    await seedDeprovisioningGaps(directory.id);
    routeAlreadyGone("/Users/zzz-nonexistent");

    const ctx = createCtx();
    await proxyWorker.fetch(
      proxyRequest(directory, "DELETE", "/scim/v2/Users/zzz-nonexistent"),
      env,
      ctx,
    );
    await ctx.drain();

    expect(
      (await listNativeWriteFailures(env.DB, directory.id)).map((row) => row.resource_key).sort(),
    ).toEqual(["u9", "victim@acme.test"]);
  });

  it("retires the path id's own row once both sides are confirmed absent", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    await seedDeprovisioningGaps(directory.id);
    // Native no longer holds `u9` and the mirror confirms WorkOS does not either:
    // the divergence the row records is genuinely closed. The neighbouring row is
    // about a different resource and is not.
    fake.route("native", "DELETE", "/Users/u9", scimJson(404, { detail: "no such user" }));
    fake.route("workos", "DELETE", "/Users/u9", new Response(null, { status: 204 }));

    const ctx = createCtx();
    await proxyWorker.fetch(proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"), env, ctx);
    await ctx.drain();

    expect(
      (await listNativeWriteFailures(env.DB, directory.id)).map((row) => row.resource_key),
    ).toEqual(["victim@acme.test"]);
  });

  it("keeps the row when the mirror leg fails to drop the resource from WorkOS", async () => {
    const directory = await seedDirectory(env.DB, { mode: "dual-write" });
    await recordNativeWriteFailure(env.DB, {
      directory_id: directory.id,
      resource_type: "Users",
      resource_key: "u9",
      method: "PUT",
      native_status: 500,
      detail: "WorkOS committed this write; native did not: native returned 500",
    });
    fake.route("native", "DELETE", "/Users/u9", scimJson(404, { detail: "no such user" }));
    // WorkOS still holds the resource, so nothing has converged and the row is
    // still the only record of the gap.
    fake.route("workos", "DELETE", "/Users/u9", scimJson(503, { detail: "unavailable" }));

    const ctx = createCtx();
    await proxyWorker.fetch(proxyRequest(directory, "DELETE", "/scim/v2/Users/u9"), env, ctx);
    await ctx.drain();

    expect(
      (await listNativeWriteFailures(env.DB, directory.id)).map((row) => row.resource_key),
    ).toEqual(["u9"]);
  });
});
