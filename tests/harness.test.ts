import { afterEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("test harness", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => fake?.restore());

  it("boots the proxy against an in-memory migrated database", async () => {
    const env = createEnv();
    const res = await proxyWorker.fetch(
      new Request("https://bridge.test/healthz"),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("routes a passthrough write to native only", async () => {
    const env = createEnv();
    const directory = await seedDirectory(env.DB, { mode: "passthrough" });
    fake = installFakeUpstreams();
    fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_1", userName: "a@b.c" }));

    const ctx = createCtx();
    const res = await proxyWorker.fetch(
      proxyRequest(directory, "POST", "/scim/v2/Users", { userName: "a@b.c" }),
      env,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(201);
    expect(fake.callsTo("native")).toHaveLength(1);
    expect(fake.callsTo("workos")).toHaveLength(0);
  });
});
