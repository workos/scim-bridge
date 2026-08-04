import { describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { setDirectoryMode, setDirectoryWorkosDirectoryId } from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import { createCtx, createEnv, proxyRequest, seedDirectory, type SeededDirectory } from "./helpers";

/** GET /status/directories/{id} as the native app's listener would. */
function statusRequest(
  directory: SeededDirectory,
  id: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Request {
  return proxyRequest(directory, opts.method ?? "GET", `/status/directories/${id}`, undefined, {
    ...opts.headers,
  });
}

async function fetchStatus(env: PocEnv, request: Request): Promise<Response> {
  return proxyWorker.fetch(request, env, createCtx());
}

describe("status endpoint", () => {
  describe("auth", () => {
    it("rejects a request without a bearer token with 401", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`),
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    });

    it("rejects an unknown bearer token with 401", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`, {
          headers: { Authorization: "Bearer not-a-real-token" },
        }),
      );

      expect(res.status).toBe(401);
    });

    it("returns 404 (not 403) when a token asks for another directory's id", async () => {
      const env = await createEnv();
      const dirA = await seedDirectory(env.DB, { name: "A" });
      const dirB = await seedDirectory(env.DB, { name: "B" });

      // 404 so a valid token can't probe which directory ids exist.
      const res = await fetchStatus(env, statusRequest(dirA, dirB.id));

      expect(res.status).toBe(404);
    });

    it("returns 404 when a token asks for another directory's workos_directory_id", async () => {
      const env = await createEnv();
      const dirA = await seedDirectory(env.DB, { name: "A" });
      const dirB = await seedDirectory(env.DB, {
        name: "B",
        workos_directory_id: "directory_01OTHER",
      });

      const res = await fetchStatus(env, statusRequest(dirA, dirB.workos_directory_id!));

      expect(res.status).toBe(404);
    });
  });

  describe("lookup", () => {
    it("resolves the directory by its bridge id", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(res.status).toBe(200);
      expect(((await res.json()) as { directory_id: string }).directory_id).toBe(directory.id);
    });

    it("resolves the directory by its workos_directory_id when set", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, {
        workos_directory_id: "directory_01HXYZ",
      });

      const res = await fetchStatus(env, statusRequest(directory, "directory_01HXYZ"));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        directory_id: directory.id,
        workos_directory_id: "directory_01HXYZ",
      });
    });
  });

  describe("response shape", () => {
    it("returns every status field for a dual-write directory", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, {
        mode: "dual-write",
        workos_directory_id: "directory_01ABC",
      });

      const res = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        directory_id: directory.id,
        workos_directory_id: "directory_01ABC",
        mode: "dual-write",
        native_authoritative: true,
        updated_at: directory.updated_at,
      });
    });

    it("reports native_authoritative true for passthrough", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { mode: "passthrough" });

      const res = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(await res.json()).toMatchObject({
        mode: "passthrough",
        native_authoritative: true,
        workos_directory_id: null,
      });
    });

    it("reports native_authoritative false for workos-only", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { mode: "workos-only" });

      const res = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(await res.json()).toMatchObject({
        mode: "workos-only",
        native_authoritative: false,
      });
    });
  });

  describe("caching", () => {
    it("sends a short private Cache-Control max-age", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(res.headers.get("Cache-Control")).toBe("private, max-age=5");
    });

    it("returns the same ETag while the directory state is unchanged", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const first = await fetchStatus(env, statusRequest(directory, directory.id));
      const second = await fetchStatus(env, statusRequest(directory, directory.id));

      const etag = first.headers.get("ETag");
      expect(etag).toBeTruthy();
      // RFC 7232 forbids spaces in an entity tag; updated_at is folded.
      expect(etag).not.toContain(" ");
      expect(second.headers.get("ETag")).toBe(etag);
    });

    it("changes the ETag when the mode changes", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });

      const before = await fetchStatus(env, statusRequest(directory, directory.id));
      await setDirectoryMode(env.DB, directory.id, "workos-only");
      const after = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(after.headers.get("ETag")).not.toBe(before.headers.get("ETag"));
    });

    it("answers a matching If-None-Match with an empty 304 that keeps the headers", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const first = await fetchStatus(env, statusRequest(directory, directory.id));
      const etag = first.headers.get("ETag")!;

      const res = await fetchStatus(
        env,
        statusRequest(directory, directory.id, { headers: { "If-None-Match": etag } }),
      );

      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("ETag")).toBe(etag);
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=5");
    });

    it("serves a full 200 when If-None-Match carries a stale ETag", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });

      const first = await fetchStatus(env, statusRequest(directory, directory.id));
      const staleEtag = first.headers.get("ETag")!;
      await setDirectoryMode(env.DB, directory.id, "workos-only");

      const res = await fetchStatus(
        env,
        statusRequest(directory, directory.id, { headers: { "If-None-Match": staleEtag } }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ mode: "workos-only" });
    });

    it("supports HEAD with the same status and validators as GET", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const get = await fetchStatus(env, statusRequest(directory, directory.id));
      const head = await fetchStatus(
        env,
        statusRequest(directory, directory.id, { method: "HEAD" }),
      );

      // The runtime strips the body from a HEAD response; only status and
      // headers are the endpoint's contract here.
      expect(head.status).toBe(200);
      expect(head.headers.get("ETag")).toBe(get.headers.get("ETag"));
      expect(head.headers.get("Cache-Control")).toBe("private, max-age=5");
    });

    it("answers a conditional HEAD with 304", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const get = await fetchStatus(env, statusRequest(directory, directory.id));
      const res = await fetchStatus(
        env,
        statusRequest(directory, directory.id, {
          method: "HEAD",
          headers: { "If-None-Match": get.headers.get("ETag")! },
        }),
      );

      expect(res.status).toBe(304);
    });
  });

  describe("routing", () => {
    it.each(["POST", "PUT", "PATCH", "DELETE"])("returns 405 for %s", async (method) => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(env, statusRequest(directory, directory.id, { method }));

      expect(res.status).toBe(405);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    });

    it("returns 404 when the id segment is missing", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      for (const path of ["/status/directories", "/status/directories/"]) {
        const res = await fetchStatus(env, proxyRequest(directory, "GET", path));
        expect(res.status).toBe(404);
      }
    });

    it("returns 404 for extra path segments", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        proxyRequest(directory, "GET", `/status/directories/${directory.id}/extra`),
      );

      expect(res.status).toBe(404);
    });

    it("decodes a percent-encoded id before matching", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, {
        workos_directory_id: "directory 01 with spaces",
      });

      const res = await fetchStatus(
        env,
        statusRequest(directory, encodeURIComponent("directory 01 with spaces")),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        workos_directory_id: "directory 01 with spaces",
      });
    });

    it("returns 404 for a malformed percent-encoding instead of throwing", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(env, statusRequest(directory, "%E0%A4%A"));

      expect(res.status).toBe(404);
    });
  });

  describe("auth parsing", () => {
    it("accepts a lowercase 'bearer' scheme", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`, {
          headers: { Authorization: `bearer ${directory.proxy_token}` },
        }),
      );

      expect(res.status).toBe(200);
    });

    // The listener polling this endpoint runs on the customer's side, so it may
    // present the token in whichever shape its HTTP client is configured with.
    it("accepts a bare token with no scheme", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`, {
          headers: { Authorization: directory.proxy_token },
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ directory_id: directory.id });
    });

    it("rejects another scheme carrying the token with 401", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`, {
          headers: { Authorization: `Basic ${directory.proxy_token}` },
        }),
      );

      expect(res.status).toBe(401);
    });

    it("trims whitespace around the token after the Bearer scheme", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`, {
          headers: { Authorization: `Bearer   ${directory.proxy_token}  ` },
        }),
      );

      expect(res.status).toBe(200);
    });

    it("returns a 500 JSON error when the directory lookup itself fails", async () => {
      const broken = {
        DB: {
          prepare() {
            throw new Error("boom");
          },
        },
      } as unknown as PocEnv;

      const res = await fetchStatus(
        broken,
        new Request("https://bridge.test/status/directories/some-id", {
          headers: { Authorization: "Bearer some-token" },
        }),
      );

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("check precedence", () => {
    it("answers an unauthenticated POST with 405, not 401", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`, {
          method: "POST",
        }),
      );

      expect(res.status).toBe(405);
    });

    it("answers a bad path shape with 404 even when the token is unknown", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        new Request("https://bridge.test/status/directories", {
          headers: { Authorization: "Bearer not-a-real-token" },
        }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: expect.any(String) });
    });
  });

  describe("routing edges", () => {
    it("does not serve ids concatenated onto the prefix without a slash", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      // /status/directories<id> must not reach the status handler.
      const res = await fetchStatus(
        env,
        proxyRequest(directory, "GET", `/status/directories${directory.id}`),
      );

      expect(res.status).toBe(404);
    });

    it("tolerates a trailing slash after a valid id", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        proxyRequest(directory, "GET", `/status/directories/${directory.id}/`),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ directory_id: directory.id });
    });

    it("serves the status body as application/json", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const ok = await fetchStatus(env, statusRequest(directory, directory.id));
      const unauthorized = await fetchStatus(
        env,
        new Request(`https://bridge.test/status/directories/${directory.id}`),
      );

      // Plain JSON, not the SCIM data plane's application/scim+json.
      expect(ok.headers.get("Content-Type")).toContain("application/json");
      expect(unauthorized.headers.get("Content-Type")).toContain("application/json");
    });
  });

  describe("ETag composition", () => {
    it("sends the entity tag as a quoted opaque string", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(res.headers.get("ETag")).toMatch(/^"[^"]+"$/);
    });

    it("changes the ETag when workos_directory_id is set, not only on mode flips", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const before = await fetchStatus(env, statusRequest(directory, directory.id));
      await setDirectoryWorkosDirectoryId(env.DB, directory.id, "directory_01LATE");
      const after = await fetchStatus(env, statusRequest(directory, directory.id));

      expect(after.status).toBe(200);
      expect(after.headers.get("ETag")).not.toBe(before.headers.get("ETag"));
      expect(await after.json()).toMatchObject({ workos_directory_id: "directory_01LATE" });
    });

    it("does not honor If-None-Match: * (exact-match validators only)", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await fetchStatus(
        env,
        statusRequest(directory, directory.id, { headers: { "If-None-Match": "*" } }),
      );

      // Pins current behavior: RFC 7232 says `*` matches any current
      // representation (so a 304 would be conforming), but the endpoint
      // compares the header verbatim against its own ETag and serves a full
      // 200. Listeners always echo the exact ETag, so this stays harmless.
      expect(res.status).toBe(200);
    });
  });

  describe("mode flips", () => {
    it("reflects a setDirectoryMode cutover immediately", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { mode: "dual-write" });

      const before = await fetchStatus(env, statusRequest(directory, directory.id));
      expect(await before.json()).toMatchObject({
        mode: "dual-write",
        native_authoritative: true,
      });

      await setDirectoryMode(env.DB, directory.id, "workos-only");
      const cutover = await fetchStatus(env, statusRequest(directory, directory.id));
      expect(await cutover.json()).toMatchObject({
        mode: "workos-only",
        native_authoritative: false,
      });

      await setDirectoryMode(env.DB, directory.id, "passthrough");
      const rollback = await fetchStatus(env, statusRequest(directory, directory.id));
      expect(await rollback.json()).toMatchObject({
        mode: "passthrough",
        native_authoritative: true,
      });
    });
  });
});
