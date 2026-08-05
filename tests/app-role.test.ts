import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decidePanelAuth,
  loadConfig,
  loopbackBase,
  panelAuthExempt,
  seedDemoDirectory,
  seedGeneratedTokens,
  seedNativeAppConfig,
  seedNativeAppDirectories,
  type AppConfig,
} from "../server/config";
import { getConfig, insertDirectory, listDirectories, setConfig } from "../workers/shared/db";
import { hashProxyToken } from "../workers/shared/crypto";
import nativeWorker from "../workers/native/index";
import type { PocEnv } from "../workers/shared/types";
import {
  NATIVE_URL,
  createCtx,
  createEnv,
  installFakeUpstreams,
  type FakeUpstreams,
} from "./helpers";

/**
 * A bridge config that is allowed to have no panel credentials. Every bare
 * `loadConfig({})` in a bridge role now refuses to boot (VULN-1612), so the
 * cases below that are about something else say so explicitly rather than
 * quietly depending on the unsafe default they were written against.
 */
const OPEN_PANEL = { PANEL_AUTH_DISABLED: "true" } as const;

/** The image runs as the bridge by default and as the customer-app stand-in
 *  under APP_ROLE=native-app (see docs/runbook.md). */
describe("APP_ROLE", () => {
  describe("config parsing", () => {
    it("defaults to the bridge role", () => {
      expect(loadConfig({ ...OPEN_PANEL }).role).toBe("bridge");
      expect(loadConfig({ ...OPEN_PANEL, APP_ROLE: "" }).role).toBe("bridge");
      expect(loadConfig({ ...OPEN_PANEL, APP_ROLE: "bridge" }).role).toBe("bridge");
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
      expect(loadConfig({ ...OPEN_PANEL }).webhookSecret).toBeNull();
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
      const env = await createEnv();
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
      const env = await createEnv();
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
      const env = await createEnv();
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
      const env = await createEnv();
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
      expect(rows.map((d) => [d.id, d.workos_directory_id, d.proxy_token_hash, d.name])).toEqual([
        ["directory_01A", "directory_01A", await hashProxyToken("tok_a"), "Acme"],
        ["directory_01B", "directory_01B", await hashProxyToken("tok_b"), "directory_01B"],
      ]);
      // The declared token is hashed like any other, so DIRECTORIES_JSON stays the
      // only plaintext copy in this role (ENT-6742). Asserted against the digest of
      // the declared value rather than "not tok_a", which a typo would also satisfy.
      expect(rows.map((d) => d.proxy_token_hint)).toEqual(["ok_a", "ok_b"]);
      // Left at the table default: if the bridge is unreachable the listener
      // reads this mode and stays inert rather than applying events.
      expect(rows.every((d) => d.mode === "passthrough")).toBe(true);
    });

    it("updates a rotated proxy token in place", async () => {
      const env = await createEnv();
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
      expect(rows[0].proxy_token_hash).toBe(await hashProxyToken("tok_rotated"));
      expect(rows[0].proxy_token_hash).not.toBe(await hashProxyToken("tok_a"));
    });

    it("boots cleanly when a proxy token moves to a different directory id", async () => {
      const env = await createEnv();
      await seedNativeAppDirectories(
        env,
        nativeAppConfig({
          directories: [
            { workos_directory_id: "directory_01OLD", proxy_token: "tok_a", name: "A" },
          ],
        }),
      );
      // proxy_token_hash is UNIQUE table-wide, so re-creating the directory under a
      // new id with the same token must not collide with the row holding it — the
      // digest of a given token is the same value every time, which is what makes
      // the lookup possible and the collision reachable.
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
      expect(rows[0].proxy_token_hash).toBe(await hashProxyToken("tok_a"));
    });

    it("drops a directory removed from DIRECTORIES_JSON", async () => {
      const env = await createEnv();
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
      const env = await createEnv();
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
      const env = await createEnv();
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

/**
 * The panel serves every directory's decrypted `native_token`, `workos_token`
 * and `proxy_token`, on the same origin as the SCIM data plane an IdP has to
 * reach from the public internet — so who its gate admits is the whole security
 * boundary (VULN-1612). These pin the decision itself, which is why it lives in
 * config.ts rather than inside the middleware.
 */
describe("panel auth is required to boot", () => {
  /**
   * The panel renders each directory's native and WorkOS bearer tokens into the
   * page as form values, and APP_ENCRYPTION_KEY does not help (the panel
   * decrypts to render). Blank-means-open therefore served those credentials to
   * anyone who could reach the port — and blank was the default, was what
   * `.env.example` shipped, and was what docker-compose ran. The refusal is the
   * fix; these cases are what stops it being quietly relaxed again.
   */
  it("refuses to start a bridge with no panel credentials", () => {
    expect(() => loadConfig({})).toThrow(/PANEL_AUTH_USER and PANEL_AUTH_PASSWORD are required/);
    // The message has to say what is at stake, or the next operator "fixes" it
    // with the opt-out without knowing what they are opting out of.
    expect(() => loadConfig({})).toThrow(/bearer tokens in plaintext/);
    // Blank strings are what `PANEL_AUTH_USER=` in a .env produces.
    expect(() => loadConfig({ PANEL_AUTH_USER: "", PANEL_AUTH_PASSWORD: "" })).toThrow(
      /are required/,
    );
    // Neither set is the security case, and must not be reported as the
    // half-configured one — they have different fixes.
    expect(() => loadConfig({})).not.toThrow(/half-configured/);
  });

  it("keeps trimming the username and not the password", () => {
    // Asymmetric on purpose, and worth pinning: the username is trimmed, the
    // password is not, because trimming a password silently changes it. So
    // PANEL_AUTH_PASSWORD="  " is a real (bad) password while
    // PANEL_AUTH_USER="   " is no username at all — which makes this the
    // half-configured case, and now a refusal rather than a silent lockout.
    expect(() => loadConfig({ PANEL_AUTH_USER: "   ", PANEL_AUTH_PASSWORD: "  " })).toThrow(
      /PANEL_AUTH_USER is blank/,
    );
    expect(
      loadConfig({ PANEL_AUTH_USER: "ada", PANEL_AUTH_PASSWORD: "  " }).panelAuthPassword,
    ).toBe("  ");
  });

  it("starts when both credentials are set", () => {
    const config = loadConfig({ PANEL_AUTH_USER: "ada", PANEL_AUTH_PASSWORD: "hunter2" });
    expect(config.panelAuthUser).toBe("ada");
    expect(config.panelAuthPassword).toBe("hunter2");
    expect(config.panelAuthDisabled).toBe(false);
  });

  it("refuses half a pair, and says which half", async () => {
    // Not a leak — decidePanelAuth denies everything when one half is missing
    // (#27) — but a container that starts, logs "control panel: …" and then
    // rejects the operator's own password with nothing in the logs is a worse
    // outcome than one that will not start. Found by copying the .env.example
    // this change first shipped, which set a username and left the password
    // blank: /panel answered 401 to `-u admin:` and explained nothing.
    expect(() => loadConfig({ PANEL_AUTH_USER: "ada" })).toThrow(/PANEL_AUTH_PASSWORD is blank/);
    expect(() => loadConfig({ PANEL_AUTH_PASSWORD: "hunter2" })).toThrow(
      /PANEL_AUTH_USER is blank/,
    );
    // The runtime half of the same rule stays, because config is not the only
    // way to reach this state and denying is the safe answer either way.
    expect(await decidePanelAuth({ panelAuthUser: "ada", panelAuthPassword: null }, null)).toBe(
      "denied",
    );
  });

  it("starts with the explicit opt-out, and records it", () => {
    const config = loadConfig({ PANEL_AUTH_DISABLED: "true" });
    expect(config.panelAuthDisabled).toBe(true);
    // Still "open" at request time — the opt-out is about consent, not behaviour.
    expect(config.panelAuthUser).toBeNull();
  });

  it("does not treat a falsy or garbled opt-out as consent", () => {
    for (const value of ["false", "no", "0", "", "  ", "maybe", "TRUE-ish"]) {
      expect(() => loadConfig({ PANEL_AUTH_DISABLED: value })).toThrow(/are required/);
    }
    // …while the spellings `bool()` accepts do work.
    for (const value of ["true", "TRUE", " yes ", "1", "on"]) {
      expect(loadConfig({ PANEL_AUTH_DISABLED: value }).panelAuthDisabled).toBe(true);
    }
  });

  it("does not exempt DEMO_MODE from the requirement", () => {
    // A demo is the deployment most likely to be put on the internet and left
    // there, and nothing stops someone importing a real directory into one.
    expect(() => loadConfig({ DEMO_MODE: "true" })).toThrow(/are required/);
  });

  it("does not apply to the native-app role, which serves no panel", () => {
    const config = loadConfig({ APP_ROLE: "native-app", WEBHOOK_SECRET: "whsec_123" });
    expect(config.role).toBe("native-app");
    expect(config.panelAuthUser).toBeNull();
  });

  it("reports a malformed DIRECTORIES_JSON before the panel-auth policy", () => {
    // Two things wrong at once: the one the operator can only learn from us
    // (a parse error at a character offset) has to win over the one the error
    // message can explain in full.
    expect(() => loadConfig({ DIRECTORIES_JSON: "{" })).toThrow(/not valid JSON/);
  });
});

describe("what panel auth never challenges", () => {
  const closed = { demoMode: false };
  const demo = { demoMode: true };

  it("lets through the paths that authenticate themselves", () => {
    // The IdP cannot send Basic credentials, and a load balancer will not.
    expect(panelAuthExempt("/healthz", closed)).toBe(true);
    expect(panelAuthExempt("/scim/v2", closed)).toBe(true);
    expect(panelAuthExempt("/scim/v2/Users", closed)).toBe(true);
    expect(panelAuthExempt("/scim/v2/Groups/abc", closed)).toBe(true);
    expect(panelAuthExempt("/status/directories", closed)).toBe(true);
    expect(panelAuthExempt("/status/directories/dir_1", closed)).toBe(true);
  });

  it("challenges the panel and everything else", () => {
    expect(panelAuthExempt("/", closed)).toBe(false);
    expect(panelAuthExempt("/panel", closed)).toBe(false);
    expect(panelAuthExempt("/panel/directories/dir_1", closed)).toBe(false);
    expect(panelAuthExempt("/panel/live", closed)).toBe(false);
  });

  it("does not let a prefix near-miss through", () => {
    // The exemptions are equality-or-slash for exactly this reason: a
    // startsWith("/healthz") would hand /healthzsecrets to the world.
    expect(panelAuthExempt("/healthzz", closed)).toBe(false);
    expect(panelAuthExempt("/scim/v2extra", closed)).toBe(false);
    expect(panelAuthExempt("/status/directoriesX", closed)).toBe(false);
    expect(panelAuthExempt("/__demoevil", demo)).toBe(false);
    expect(panelAuthExempt("/panel/scim/v2", closed)).toBe(false);
  });

  it("exempts the simulators only in demo mode", () => {
    // The panel drives them over its own loopback URL with no credentials, so
    // gating them made DEMO_MODE and PANEL_AUTH_* mutually exclusive.
    expect(panelAuthExempt("/__demo", demo)).toBe(true);
    expect(panelAuthExempt("/__demo/idp/seed", demo)).toBe(true);
    expect(panelAuthExempt("/__demo/native/scim/v2/Users", demo)).toBe(true);
    // With the simulators unmounted the path is a 404 either way; keeping the
    // exemption conditional means the gate never has a hole it is not using.
    expect(panelAuthExempt("/__demo/idp/seed", closed)).toBe(false);
  });
});

/**
 * `/__demo` is exempt from panel auth, and the simulator behind it drives only the
 * directory named by `idp.demo_directory_id`. That config value is therefore an
 * authorization decision, and `seedDemoDirectory` is where boot makes it — including
 * for a demo database seeded before the key existed, where it has to recognise the
 * bundled directory rather than record one it just created (VULN-3076).
 */
describe("naming the directory the unauthenticated simulator may drive", () => {
  const demoConfig = (): AppConfig => loadConfig({ ...OPEN_PANEL, DEMO_MODE: "true" });

  /** The seeded demo directory's shape: both upstream legs are this process's fakes. */
  function bundled(config: AppConfig) {
    const base = loopbackBase(config);
    return {
      native_url: `${base}/__demo/native/scim/v2`,
      workos_url: `${base}/__demo/native/mock-workos/scim/v2`,
    };
  }

  it("records the directory it seeds into an empty database", async () => {
    const env = await createEnv();
    const config = demoConfig();

    await seedDemoDirectory(env, config);

    const [directory] = await listDirectories(env.DB);
    expect(await getConfig(env.DB, "idp.demo_directory_id")).toBe(directory.id);
  });

  it("adopts the bundled directory in a database seeded before the key existed", async () => {
    const env = await createEnv();
    const config = demoConfig();
    const { id } = await insertDirectory(env.DB, { name: "Demo directory", ...bundled(config) });

    await seedDemoDirectory(env, config);

    // No second directory was seeded, and the existing one is now drivable.
    expect(await listDirectories(env.DB)).toHaveLength(1);
    expect(await getConfig(env.DB, "idp.demo_directory_id")).toBe(id);
  });

  it("does not adopt a directory whose WorkOS leg is real", async () => {
    // The endpoints are operator-settable, so matching a prefix of the native leg
    // would adopt this row: its native leg points at the bundled fake, but its
    // WorkOS leg is a real directory the simulator would then provision into.
    const env = await createEnv();
    const config = demoConfig();
    await insertDirectory(env.DB, {
      name: "Half-bundled",
      native_url: `${loopbackBase(config)}/__demo/native/scim/v2`,
      workos_url: "https://api.workos.com/scim/v2.0/directory_01ABC",
      workos_token: "workos-secret",
    });

    await seedDemoDirectory(env, config);

    expect(await getConfig(env.DB, "idp.demo_directory_id")).toBeNull();
  });

  it("adopts nothing when an operator's own import is the only directory", async () => {
    const env = await createEnv();
    const config = demoConfig();
    await insertDirectory(env.DB, {
      name: "Acme Corp — Okta",
      native_url: "https://acme.example.com/scim/v2",
      workos_url: "https://api.workos.com/scim/v2.0/directory_01ABC",
    });

    await seedDemoDirectory(env, config);

    expect(await getConfig(env.DB, "idp.demo_directory_id")).toBeNull();
  });

  it("adopts nothing when two directories share the bundled shape", async () => {
    const env = await createEnv();
    const config = demoConfig();
    await insertDirectory(env.DB, { name: "Demo directory", ...bundled(config) });
    await insertDirectory(env.DB, { name: "Demo directory copy", ...bundled(config) });

    await seedDemoDirectory(env, config);

    expect(await getConfig(env.DB, "idp.demo_directory_id")).toBeNull();
  });

  it("leaves an already-recorded id alone", async () => {
    const env = await createEnv();
    const config = demoConfig();
    await setConfig(env.DB, "idp.demo_directory_id", "dir_already_chosen");
    await insertDirectory(env.DB, { name: "Demo directory", ...bundled(config) });

    await seedDemoDirectory(env, config);

    expect(await getConfig(env.DB, "idp.demo_directory_id")).toBe("dir_already_chosen");
  });

  it("records nothing outside demo mode", async () => {
    const env = await createEnv();
    const config = loadConfig({ ...OPEN_PANEL });

    await seedDemoDirectory(env, config);

    expect(await listDirectories(env.DB)).toHaveLength(0);
    expect(await getConfig(env.DB, "idp.demo_directory_id")).toBeNull();
  });
});

describe("panel auth", () => {
  const basic = (user: string, pass: string) =>
    `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

  it("is open only when neither credential is configured", async () => {
    const open = { panelAuthUser: null, panelAuthPassword: null };
    expect(await decidePanelAuth(open, null)).toBe("open");
    // Blank strings are what an operator gets from `PANEL_AUTH_USER=` in a .env
    // or an unset value in docker-compose, so they must read as "not set".
    expect(await decidePanelAuth({ panelAuthUser: "", panelAuthPassword: "" }, null)).toBe("open");
  });

  it("denies a half-configured pair instead of skipping auth", async () => {
    // The regression: `||` here meant one missing var opened the whole panel.
    // Anonymous, and with no signal to the operator that auth was off.
    expect(await decidePanelAuth({ panelAuthUser: "ada", panelAuthPassword: null }, null)).toBe(
      "denied",
    );
    expect(await decidePanelAuth({ panelAuthUser: null, panelAuthPassword: "hunter2" }, null)).toBe(
      "denied",
    );
    // Not even by presenting the half that *is* configured, which is the shape a
    // naive equality check would let through.
    expect(
      await decidePanelAuth({ panelAuthUser: "ada", panelAuthPassword: null }, basic("ada", "")),
    ).toBe("denied");
    expect(
      await decidePanelAuth(
        { panelAuthUser: null, panelAuthPassword: "hunter2" },
        basic("", "hunter2"),
      ),
    ).toBe("denied");
  });

  it("grants only an exact match once both are configured", async () => {
    const config = { panelAuthUser: "ada", panelAuthPassword: "hunter2" };
    expect(await decidePanelAuth(config, basic("ada", "hunter2"))).toBe("granted");
    expect(await decidePanelAuth(config, basic("ada", "wrong"))).toBe("denied");
    expect(await decidePanelAuth(config, basic("eve", "hunter2"))).toBe("denied");
    expect(await decidePanelAuth(config, null)).toBe("denied");
    expect(await decidePanelAuth(config, "Bearer ada:hunter2")).toBe("denied");
    expect(await decidePanelAuth(config, "Basic not-base64!")).toBe("denied");
    // A credential-less Basic header decodes to "", which has no separator.
    expect(await decidePanelAuth(config, "Basic ")).toBe("denied");
  });

  it("keeps a colon in the password intact", async () => {
    // Splitting on every colon truncates the password at the first one, so a
    // valid credential is rejected and the operator sees an unexplained 401.
    const config = { panelAuthUser: "ada", panelAuthPassword: "hunter2:extra:more" };
    expect(await decidePanelAuth(config, basic("ada", "hunter2:extra:more"))).toBe("granted");
    expect(await decidePanelAuth(config, basic("ada", "hunter2"))).toBe("denied");
  });

  it("denies a wrong password of any length, without throwing", async () => {
    // The reason the comparison hashes before comparing. A native
    // `timingSafeEqual` throws on length-mismatched inputs, and the string version
    // returns early on them — and a wrong password is very often the wrong length,
    // so that is the common case, not the edge case.
    const config = { panelAuthUser: "ada", panelAuthPassword: "hunter2" };

    for (const guess of ["", "h", "hunter", "hunter2 ", "hunter2".repeat(500), "🔑"]) {
      expect(await decidePanelAuth(config, basic("ada", guess)), guess).toBe("denied");
    }
  });

  it("checks the password even when the username is already wrong", async () => {
    // `user === u && pass === p` short-circuited: a wrong username meant the
    // password comparison never ran, so the two denials cost different work. Both
    // sides are now always compared. The observable part is only that each
    // combination is still denied — the invariant this pins is that no arrangement
    // of one-wrong-one-right is ever granted.
    const config = { panelAuthUser: "ada", panelAuthPassword: "hunter2" };

    expect(await decidePanelAuth(config, basic("eve", "hunter2"))).toBe("denied");
    expect(await decidePanelAuth(config, basic("ada", "wrong"))).toBe("denied");
    expect(await decidePanelAuth(config, basic("eve", "wrong"))).toBe("denied");
    // And the swap: right values in the wrong fields.
    expect(await decidePanelAuth(config, basic("hunter2", "ada"))).toBe("denied");
  });

  it("still grants a credential that differs only in case or whitespace nowhere", async () => {
    // Hashing makes the comparison exact, which is what it must stay: a panel
    // password is not case-insensitive and must not become so.
    const config = { panelAuthUser: "Ada", panelAuthPassword: "Hunter2" };

    expect(await decidePanelAuth(config, basic("Ada", "Hunter2"))).toBe("granted");
    expect(await decidePanelAuth(config, basic("ada", "Hunter2"))).toBe("denied");
    expect(await decidePanelAuth(config, basic("Ada", "hunter2"))).toBe("denied");
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
