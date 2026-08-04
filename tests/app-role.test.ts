import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  seedGeneratedTokens,
  seedNativeAppConfig,
  seedNativeAppDirectories,
  type AppConfig,
} from "../server/config";
import { getConfig, listDirectories } from "../workers/shared/db";
import nativeWorker from "../workers/native/index";
import type { PocEnv } from "../workers/shared/types";
import {
  NATIVE_URL,
  createCtx,
  createEnv,
  installFakeUpstreams,
  type FakeUpstreams,
} from "./helpers";

/** The image runs as the bridge by default and as the customer-app stand-in
 *  under APP_ROLE=native-app (see docs/runbook.md). */
describe("APP_ROLE", () => {
  describe("config parsing", () => {
    it("defaults to the bridge role", () => {
      expect(loadConfig({}).role).toBe("bridge");
      expect(loadConfig({ APP_ROLE: "" }).role).toBe("bridge");
      expect(loadConfig({ APP_ROLE: "bridge" }).role).toBe("bridge");
    });

    it("accepts the native-app role, whitespace included", () => {
      const env = { WEBHOOK_SECRET: "whsec_123" };
      expect(loadConfig({ ...env, APP_ROLE: "native-app" }).role).toBe("native-app");
      expect(loadConfig({ ...env, APP_ROLE: " native-app " }).role).toBe("native-app");
    });

    it("rejects an unknown role at boot", () => {
      expect(() => loadConfig({ APP_ROLE: "proxy" })).toThrow(
        'APP_ROLE must be one of bridge, native-app; received "proxy".',
      );
      // A near-miss must not silently fall back to the bridge's behavior.
      expect(() => loadConfig({ APP_ROLE: "NATIVE-APP" })).toThrow(/APP_ROLE must be one of/);
    });

    it("reads the native-app env vars", () => {
      const config = loadConfig({
        APP_ROLE: "native-app",
        NATIVE_SCIM_TOKEN: "native-secret",
        WEBHOOK_SECRET: "whsec_123",
        BRIDGE_STATUS_URL: "https://bridge.acme.com/",
      });
      expect(config.nativeScimToken).toBe("native-secret");
      expect(config.webhookSecret).toBe("whsec_123");
      expect(config.bridgeStatusUrl).toBe("https://bridge.acme.com");
    });

    it("refuses the native-app role without a WEBHOOK_SECRET", () => {
      expect(() => loadConfig({ APP_ROLE: "native-app" })).toThrow(
        /WEBHOOK_SECRET is required when APP_ROLE=native-app/,
      );
      expect(() => loadConfig({ APP_ROLE: "native-app", WEBHOOK_SECRET: "  " })).toThrow(
        /unsigned/,
      );
      // The bridge never serves /webhooks/dsync, so it boots without one.
      expect(loadConfig({}).webhookSecret).toBeNull();
    });

    it("leaves the optional native-app vars null when unset, panel auth included", () => {
      const config = loadConfig({ APP_ROLE: "native-app", WEBHOOK_SECRET: "whsec_123" });
      expect(config.nativeScimToken).toBeNull();
      expect(config.bridgeStatusUrl).toBeNull();
      expect(config.panelAuthUser).toBeNull();
      expect(config.panelAuthPassword).toBeNull();
      expect(config.directories).toEqual([]);
    });

    it("parses DIRECTORIES_JSON, defaulting a missing name to the directory id", () => {
      const config = loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "whsec_123",
        DIRECTORIES_JSON: JSON.stringify([
          { workos_directory_id: "directory_01A", proxy_token: "tok_a", name: "Acme" },
          { workos_directory_id: "directory_01B", proxy_token: "tok_b" },
        ]),
      });
      expect(config.directories).toEqual([
        { workos_directory_id: "directory_01A", proxy_token: "tok_a", name: "Acme" },
        { workos_directory_id: "directory_01B", proxy_token: "tok_b", name: "directory_01B" },
      ]);
    });

    it("rejects a DIRECTORIES_JSON that isn't an array of complete entries", () => {
      expect(() => loadConfig({ DIRECTORIES_JSON: "{" })).toThrow(/not valid JSON/);
      expect(() => loadConfig({ DIRECTORIES_JSON: '{"workos_directory_id":"d"}' })).toThrow(
        /received object/,
      );
      expect(() => loadConfig({ DIRECTORIES_JSON: '[{"workos_directory_id":"d"}]' })).toThrow(
        "entry 0 is missing workos_directory_id or proxy_token",
      );
      expect(() => loadConfig({ DIRECTORIES_JSON: '[{"proxy_token":"t"}]' })).toThrow(
        "entry 0 is missing workos_directory_id or proxy_token",
      );
    });
  });

  describe("boot-seeded tokens", () => {
    it("mints the bundled endpoints' tokens on first boot, once", async () => {
      const env = createEnv();
      // Migration 0002 used to generate these in SQL, which would give each
      // driver a different secret; a fresh database now starts without them.
      expect(await getConfig(env.DB, "native.scim_token")).toBeNull();
      expect(await getConfig(env.DB, "mock_workos.scim_token")).toBeNull();

      await seedGeneratedTokens(env);
      const native = await getConfig(env.DB, "native.scim_token");
      const mock = await getConfig(env.DB, "mock_workos.scim_token");
      await seedGeneratedTokens(env);

      expect(native).toMatch(/^[0-9a-f]{32}$/);
      expect(mock).toMatch(/^[0-9a-f]{32}$/);
      expect(native).not.toBe(mock);
      // A restart reuses them: rotating would break the bridge's writes to the
      // native app and every copy-pasted value in the panel.
      expect(await getConfig(env.DB, "native.scim_token")).toBe(native);
      expect(await getConfig(env.DB, "mock_workos.scim_token")).toBe(mock);
    });
  });

  describe("env-seeded config", () => {
    it("lands the native-app secrets and the bridge URL in poc_config", async () => {
      const env = createEnv();
      await seedNativeAppConfig(env, nativeAppConfig({ bridgeStatusUrl: "https://bridge.test" }));

      expect(await getConfig(env.DB, "native.scim_token")).toBe("native-secret");
      expect(await getConfig(env.DB, "native.webhook_secret")).toBe("whsec_123");
      // Both keys: the status client prefers the loopback one, which would
      // otherwise dial this container instead of the bridge.
      expect(await getConfig(env.DB, "proxy.loopback_url")).toBe("https://bridge.test");
      expect(await getConfig(env.DB, "proxy.public_url")).toBe("https://bridge.test");
      // Real WorkOS delivers the events; the bundled mock must not also emit.
      expect(await getConfig(env.DB, "mock_workos.emit_dsync")).toBe("false");
    });

    it("does not rotate the boot-seeded token when the var is unset", async () => {
      const env = createEnv();
      const unset = nativeAppConfig({ nativeScimToken: null, bridgeStatusUrl: null });
      // First boot mints the token; a restart with NATIVE_SCIM_TOKEN still unset
      // must leave it alone, or every restart would break the bridge's writes.
      await seedNativeAppConfig(env, unset);
      const seeded = await getConfig(env.DB, "native.scim_token");
      await seedNativeAppConfig(env, unset);

      expect(seeded).toMatch(/^[0-9a-f]{32}$/);
      expect(await getConfig(env.DB, "native.scim_token")).toBe(seeded);
      expect(await getConfig(env.DB, "proxy.public_url")).toBe("http://localhost:8787");
    });
  });

  describe("env-seeded directories", () => {
    it("keys each row on the WorkOS directory id and is re-runnable", async () => {
      const env = createEnv();
      const config = nativeAppConfig({
        directories: [
          { workos_directory_id: "directory_01A", proxy_token: "tok_a", name: "Acme" },
          { workos_directory_id: "directory_01B", proxy_token: "tok_b", name: "directory_01B" },
        ],
      });
      await seedNativeAppDirectories(env, config);
      await seedNativeAppDirectories(env, config);

      const rows = await listDirectories(env.DB);
      expect(rows).toHaveLength(2);
      // The row id IS the WorkOS id, so it resolves an event's directory_id
      // locally and is an id the bridge's status endpoint accepts.
      expect(rows.map((d) => [d.id, d.workos_directory_id, d.proxy_token, d.name])).toEqual([
        ["directory_01A", "directory_01A", "tok_a", "Acme"],
        ["directory_01B", "directory_01B", "tok_b", "directory_01B"],
      ]);
      // Left at the table default: if the bridge is unreachable the listener
      // reads this mode and stays inert rather than applying events.
      expect(rows.every((d) => d.mode === "passthrough")).toBe(true);
    });

    it("updates a rotated proxy token in place", async () => {
      const env = createEnv();
      const directory = {
        workos_directory_id: "directory_01A",
        proxy_token: "tok_a",
        name: "Acme",
      };
      await seedNativeAppDirectories(env, nativeAppConfig({ directories: [directory] }));
      await seedNativeAppDirectories(
        env,
        nativeAppConfig({ directories: [{ ...directory, proxy_token: "tok_rotated" }] }),
      );

      const rows = await listDirectories(env.DB);
      expect(rows).toHaveLength(1);
      expect(rows[0].proxy_token).toBe("tok_rotated");
    });

    it("boots cleanly when a proxy token moves to a different directory id", async () => {
      const env = createEnv();
      await seedNativeAppDirectories(
        env,
        nativeAppConfig({
          directories: [
            { workos_directory_id: "directory_01OLD", proxy_token: "tok_a", name: "A" },
          ],
        }),
      );
      // proxy_token is UNIQUE table-wide, so re-creating the directory under a
      // new id with the same token must not collide with the row holding it.
      await seedNativeAppDirectories(
        env,
        nativeAppConfig({
          directories: [
            { workos_directory_id: "directory_01NEW", proxy_token: "tok_a", name: "A" },
          ],
        }),
      );

      const rows = await listDirectories(env.DB);
      expect(rows.map((d) => d.id)).toEqual(["directory_01NEW"]);
      expect(rows[0].proxy_token).toBe("tok_a");
    });

    it("drops a directory removed from DIRECTORIES_JSON", async () => {
      const env = createEnv();
      await seedNativeAppDirectories(
        env,
        nativeAppConfig({
          directories: [
            { workos_directory_id: "directory_01A", proxy_token: "tok_a", name: "Acme" },
            { workos_directory_id: "directory_01B", proxy_token: "tok_b", name: "Beta" },
          ],
        }),
      );
      await seedNativeAppDirectories(
        env,
        nativeAppConfig({
          directories: [
            { workos_directory_id: "directory_01A", proxy_token: "tok_a", name: "Acme" },
          ],
        }),
      );

      expect((await listDirectories(env.DB)).map((d) => d.id)).toEqual(["directory_01A"]);
    });

    it("drops every row when the var is emptied", async () => {
      const env = createEnv();
      await seedNativeAppDirectories(env, nativeAppConfig());
      await seedNativeAppDirectories(env, nativeAppConfig({ directories: [] }));

      expect(await listDirectories(env.DB)).toEqual([]);
    });
  });

  describe("the seeded container as the native app", () => {
    let fake: FakeUpstreams | undefined;
    afterEach(() => {
      fake?.restore();
      vi.useRealTimers();
    });

    async function seedNativeApp(overrides: Partial<AppConfig> = {}): Promise<PocEnv> {
      const env = createEnv();
      // The fake upstreams only answer the two known hosts, so the bridge is
      // reachable at the native host's base.
      const config = nativeAppConfig({ bridgeStatusUrl: NATIVE_URL, ...overrides });
      await seedNativeAppConfig(env, config);
      await seedNativeAppDirectories(env, config);
      return env;
    }

    /** Deliver the fixture event (for directory_01A) as WorkOS would: signed with
     *  WEBHOOK_SECRET, at a frozen clock inside the freshness window. */
    function deliverSigned(env: PocEnv): Promise<Response> {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(SIGNED_AT);
      const mac = createHmac("sha256", "whsec_123").update(`${SIGNED_AT}.${EVENT}`).digest("hex");
      return nativeWorker.fetch(
        new Request("https://app.test/webhooks/dsync", {
          method: "POST",
          headers: { "WorkOS-Signature": `t=${SIGNED_AT},v1=${mac}` },
          body: EVENT,
        }),
        env,
        createCtx(),
      );
    }

    async function listenerActions(env: PocEnv): Promise<string[]> {
      const { results } = await env.DB.prepare(
        "SELECT action FROM listener_events ORDER BY id",
      ).all<{
        action: string;
      }>();
      return results.map((r) => r.action);
    }

    it("accepts NATIVE_SCIM_TOKEN as the bearer on its SCIM endpoint", async () => {
      const env = await seedNativeApp();

      const denied = await nativeWorker.fetch(
        new Request("https://app.test/scim/v2/Users", {
          headers: { Authorization: "Bearer wrong" },
        }),
        env,
        createCtx(),
      );
      const allowed = await nativeWorker.fetch(
        new Request("https://app.test/scim/v2/Users", {
          headers: { Authorization: "Bearer native-secret" },
        }),
        env,
        createCtx(),
      );

      expect(denied.status).toBe(401);
      expect(allowed.status).toBe(200);
    });

    it("verifies deliveries against WEBHOOK_SECRET", async () => {
      const env = await seedNativeApp();

      const res = await nativeWorker.fetch(
        new Request("https://app.test/webhooks/dsync", { method: "POST", body: EVENT }),
        env,
        createCtx(),
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ received: false });
    });

    it("asks the bridge for the status of the directory an event carries", async () => {
      const env = await seedNativeApp();
      fake = installFakeUpstreams();
      fake.route("native", "GET", "/status/directories/", (call) => {
        expect(call.headers.get("Authorization")).toBe("Bearer tok_a");
        return Response.json({
          directory_id: "dir_1a2b3c4d5e6f7a8b",
          workos_directory_id: "directory_01A",
          mode: "workos-only",
          native_authoritative: false,
          updated_at: "2026-08-03 12:00:00",
        });
      });

      const res = await deliverSigned(env);

      expect(res.status).toBe(200);
      // The row id doubles as the path segment, so the bridge resolves the
      // directory by its WorkOS id without this container knowing the dir_… one.
      expect(fake.callsTo("native")[0]?.path).toBe("/status/directories/directory_01A");
      expect(await listenerActions(env)).toEqual(["applied"]);
    });

    it("ignores an event whose directory_id matches no seeded directory", async () => {
      // One directory, but a different one than the event names: the lone-row
      // shortcut must not adopt another directory's users.
      const env = await seedNativeApp({
        directories: [{ workos_directory_id: "directory_01B", proxy_token: "tok_b", name: "Beta" }],
      });
      fake = installFakeUpstreams();

      const res = await deliverSigned(env);

      expect(res.status).toBe(200);
      expect(await listenerActions(env)).toEqual(["ignored"]);
      // Resolution fails before any status lookup, so no credential is spent.
      expect(fake.calls).toHaveLength(0);
      const { results } = await env.DB.prepare("SELECT id FROM native_users").all();
      expect(results).toHaveLength(0);
    });

    it("stops applying events for a directory dropped from DIRECTORIES_JSON", async () => {
      const env = await seedNativeApp();
      fake = installFakeUpstreams();
      fake.route("native", "GET", "/status/directories/", () =>
        Response.json({
          directory_id: "directory_01A",
          workos_directory_id: "directory_01A",
          mode: "workos-only",
          native_authoritative: false,
          updated_at: "2026-08-03 12:00:00",
        }),
      );
      // The next boot no longer declares it.
      await seedNativeAppDirectories(env, nativeAppConfig({ directories: [] }));

      const res = await deliverSigned(env);

      expect(res.status).toBe(200);
      expect(await listenerActions(env)).toEqual(["ignored"]);
      expect(fake.calls).toHaveLength(0);
    });
  });
});

/** Epoch ms the fixture below is signed at; the clock is frozen here so the
 *  delivery lands inside the listener's freshness window. */
const SIGNED_AT = Date.parse("2026-08-03T12:00:00.000Z");

const EVENT = JSON.stringify({
  id: "event_01",
  event: "dsync.user.created",
  created_at: "2026-08-03T12:00:00.000Z",
  data: {
    directory_id: "directory_01A",
    idp_id: "idp_ada",
    email: "ada@example.com",
    state: "active",
  },
});

/** A native-app AppConfig with the vars this suite exercises filled in. */
function nativeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      APP_ROLE: "native-app",
      NATIVE_SCIM_TOKEN: "native-secret",
      WEBHOOK_SECRET: "whsec_123",
      DIRECTORIES_JSON: JSON.stringify([
        { workos_directory_id: "directory_01A", proxy_token: "tok_a", name: "Acme" },
      ]),
    }),
    ...overrides,
  };
}
