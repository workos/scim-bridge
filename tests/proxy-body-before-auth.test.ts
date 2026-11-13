import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker, { MAX_SCIM_BODY_BYTES } from "../workers/proxy/index";
import type { PocEnv } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

/** A body that counts how many bytes the bridge pulled from it. */
function countingBody(chunks: number, chunkBytes: number) {
  const pulled = { bytes: 0 };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      pulled.bytes += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
  });
  return { body, pulled };
}

function post(token: string, body: ReadableStream<Uint8Array> | string, headers = {}) {
  return new Request("https://bridge.test/scim/v2/Users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/scim+json",
      ...headers,
    },
    body,
    // @ts-expect-error -- Node's fetch needs duplex for a stream body; lib.dom's RequestInit lacks it.
    duplex: "half",
  });
}

describe("proxy reads a SCIM body only for an authenticated caller, and only up to the cap", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  it("rejects an unknown token without reading the body", async () => {
    await seedDirectory(env.DB, { mode: "passthrough" });
    const { body, pulled } = countingBody(64, 1024 * 1024);

    const response = await proxyWorker.fetch(post("not-a-token", body), env, createCtx());

    expect(response.status).toBe(401);
    expect(pulled.bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it("stops reading an authenticated body at the cap and answers 413", async () => {
    const directory = await seedDirectory(env.DB, { mode: "passthrough" });
    const { body, pulled } = countingBody(64, 1024 * 1024);

    const response = await proxyWorker.fetch(post(directory.proxy_token, body), env, createCtx());

    expect(response.status).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(MAX_SCIM_BODY_BYTES + 2 * 1024 * 1024);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a declared Content-Length over the cap", async () => {
    const directory = await seedDirectory(env.DB, { mode: "passthrough" });
    const response = await proxyWorker.fetch(
      post(directory.proxy_token, "{}", { "Content-Length": String(MAX_SCIM_BODY_BYTES + 1) }),
      env,
      createCtx(),
    );
    expect(response.status).toBe(413);
  });

  it("still forwards an ordinary authenticated body", async () => {
    const directory = await seedDirectory(env.DB, { mode: "passthrough" });
    fake.route("native", "POST", "/Users", scimJson(201, { id: "native-1" }));

    const response = await proxyWorker.fetch(
      post(directory.proxy_token, JSON.stringify({ userName: "a@example.com" })),
      env,
      createCtx(),
    );

    expect(response.status).toBe(201);
  });
});
