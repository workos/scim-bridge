import { afterEach, describe, expect, it } from "vitest";
import {
  EVENTS_API_KEY_CONFIG_KEY,
  EVENTS_TARGET_KEY,
  EVENTS_TRANSPORT_KEY,
  EVENTS_URL_KEY,
  clearEventsApiKey,
  createEventsPollerController,
  eventsPollerController,
  registerEventsPollerController,
  setEventsPollTarget,
  setEventsTransport,
  storeEventsApiKey,
  type EventsPollerBoot,
  type EventsPollerController,
} from "../workers/native/events-transport";
import nativeWorker from "../workers/native/index";
import { getConfig, setConfig } from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import { createCtx, createEnv, seedDirectory } from "./helpers";

/**
 * The panel's listener transport switcher: a controller owned by server boot
 * that starts/stops/retargets the Events API poller from persisted config, and
 * the validated actions the demo panel drives it with. The bundled mock plays
 * WorkOS as in the poller suite; a second fake origin plays REAL WorkOS so the
 * key-precedence and target tests can see the Authorization header presented.
 */

const MOCK_TOKEN = "mock-secret";
const MOCK_URL = "https://app.test/mock-workos";
const REAL_URL = "https://api.workos.test";

const USER_SCHEMA = "urn:ietf:params:scim:core:2.0:User";

const originalFetch = globalThis.fetch;

interface RealWorkosCapture {
  auths: (string | null)[];
}

/** Serve https://app.test from the native worker (the bundled mock), and play
 *  real WorkOS at https://api.workos.test — always an empty page, recording the
 *  Authorization header each request presented. */
function installTransportFetch(env: PocEnv): RealWorkosCapture {
  const capture: RealWorkosCapture = { auths: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const origin = new URL(req.url).origin;
    if (origin === "https://app.test") return nativeWorker.fetch(req, env, createCtx());
    if (origin === REAL_URL) {
      capture.auths.push(req.headers.get("Authorization"));
      return Response.json({ data: [], list_metadata: { before: null, after: null } });
    }
    throw new Error(`unexpected fetch to ${req.url}`);
  }) as typeof fetch;
  return capture;
}

async function seedTransportEnv(): Promise<PocEnv> {
  const env = await createEnv();
  await env.DB.prepare(
    "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
  ).run();
  await seedDirectory(env.DB, { mode: "workos-only" });
  await setConfig(env.DB, "mock_workos.scim_token", MOCK_TOKEN);
  await setConfig(env.DB, "mock_workos.emit_dsync", "false");
  return env;
}

/** The demo bridge's boot slice: keyless polling of its own mock, long interval
 *  so only the awaited first poll of each (re)start ever runs. */
function demoBoot(overrides: Partial<EventsPollerBoot> = {}): EventsPollerBoot {
  return {
    demoMode: true,
    envApiKey: null,
    envEventsUrl: MOCK_URL,
    mockEventsUrl: MOCK_URL,
    enabledByEnv: true,
    intervalMs: 60_000,
    ...overrides,
  };
}

async function mockScim(env: PocEnv, path: string, body: unknown): Promise<void> {
  const res = await nativeWorker.fetch(
    new Request(`https://app.test/mock-workos/scim/v2${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "Content-Type": "application/scim+json" },
      body: JSON.stringify(body),
    }),
    env,
    createCtx(),
  );
  expect(res.status).toBeLessThan(300);
}

function scimUser(userName: string, externalId: string) {
  return { schemas: [USER_SCHEMA], userName, externalId, active: true };
}

async function nativeUsers(db: PocEnv["DB"]): Promise<{ id: string }[]> {
  const { results } = await db.prepare("SELECT id FROM native_users ORDER BY id").all<{
    id: string;
  }>();
  return results;
}

describe("events transport switcher", () => {
  let controller: EventsPollerController | undefined;
  afterEach(() => {
    controller?.stop();
    controller = undefined;
    globalThis.fetch = originalFetch;
  });

  describe("controller lifecycle", () => {
    it("starts polling on the demo default, stops on webhook, restarts on poll", async () => {
      const env = await seedTransportEnv();
      installTransportFetch(env);
      await mockScim(env, "/Users", scimUser("ada@example.com", "idp-user-1"));

      controller = createEventsPollerController(env.DB, demoBoot());
      const started = await controller.reconcile();

      // Default in a demo with no persisted choice: the poller runs against
      // the bundled mock keylessly, and the awaited first poll already drained
      // the log through the listener.
      expect(started.running).toBe(true);
      expect(started.transport).toBe("poll");
      expect(started.baseUrl).toBe(MOCK_URL);
      expect(started.keySource).toBe("mock");
      expect(started.lastPollAt).not.toBeNull();
      expect(await nativeUsers(env.DB)).toHaveLength(1);

      // Flip to webhooks: the loop stops, and a later event stays unapplied
      // because nothing polls for it.
      const flipped = await setEventsTransport(
        env.DB,
        { controller, envKeyConfigured: false },
        "webhook",
      );
      expect(flipped.error).toBeUndefined();
      expect(controller.status().running).toBe(false);
      expect(await getConfig(env.DB, EVENTS_TRANSPORT_KEY)).toBe("webhook");
      await mockScim(env, "/Users", scimUser("grace@example.com", "idp-user-9"));
      expect(await nativeUsers(env.DB)).toHaveLength(1);

      // And back: the restart's first poll catches up on what it missed.
      await setEventsTransport(env.DB, { controller, envKeyConfigured: false }, "poll");
      expect(controller.status().running).toBe(true);
      expect(await nativeUsers(env.DB)).toHaveLength(2);
    });

    it("stays off outside demo mode without the env rule, whatever config says", async () => {
      // APP_ROLE=native-app with no WORKOS_API_KEY: the #117 contract, and the
      // transport key defaulting must not change it — nor may panel-stored
      // keys/targets leak into a role that has no panel.
      const env = await seedTransportEnv();
      installTransportFetch(env);
      await setConfig(env.DB, EVENTS_TARGET_KEY, "workos");
      await setConfig(env.DB, EVENTS_URL_KEY, REAL_URL);
      await storeEventsApiKey(env.DB, { controller: null, envKeyConfigured: false }, "sk_stored");

      controller = createEventsPollerController(env.DB, {
        demoMode: false,
        envApiKey: null,
        envEventsUrl: "https://api.workos.com",
        mockEventsUrl: "http://127.0.0.1:8080/__demo/native/mock-workos",
        enabledByEnv: false,
        intervalMs: 60_000,
      });
      const status = await controller.reconcile();

      expect(status.running).toBe(false);
    });

    it("polls the env target with the env key outside demo mode, ignoring panel keys", async () => {
      const env = await seedTransportEnv();
      const real = installTransportFetch(env);
      // Panel leftovers that must not win in a panel-less role.
      await setConfig(env.DB, EVENTS_URL_KEY, "https://evil.example");
      await storeEventsApiKey(env.DB, { controller: null, envKeyConfigured: true }, "sk_stored");

      controller = createEventsPollerController(env.DB, {
        demoMode: false,
        envApiKey: "sk_env_123",
        envEventsUrl: REAL_URL,
        mockEventsUrl: "http://127.0.0.1:8080/__demo/native/mock-workos",
        enabledByEnv: true,
        intervalMs: 60_000,
      });
      const status = await controller.reconcile();

      expect(status.running).toBe(true);
      expect(status.baseUrl).toBe(REAL_URL);
      expect(status.keySource).toBe("env");
      expect(real.auths).toEqual(["Bearer sk_env_123"]);
    });
  });

  describe("real-WorkOS target validation", () => {
    it("refuses the target when no key exists anywhere, leaving the mock polling", async () => {
      const env = await seedTransportEnv();
      installTransportFetch(env);
      controller = createEventsPollerController(env.DB, demoBoot());
      await controller.reconcile();

      const result = await setEventsPollTarget(
        env.DB,
        { controller, envKeyConfigured: false },
        { target: "workos", url: REAL_URL },
      );

      // A validation error at the control, not a silently dead poller: nothing
      // was written and the mock target keeps running.
      expect(result.error).toMatch(/API key/);
      expect(await getConfig(env.DB, EVENTS_TARGET_KEY)).toBeNull();
      expect(controller.status().running).toBe(true);
      expect(controller.status().baseUrl).toBe(MOCK_URL);
    });

    it("refuses flipping to poll while the persisted target is keyless real WorkOS", async () => {
      const env = await seedTransportEnv();
      installTransportFetch(env);
      await setConfig(env.DB, EVENTS_TRANSPORT_KEY, "webhook");
      await setConfig(env.DB, EVENTS_TARGET_KEY, "workos");
      controller = createEventsPollerController(env.DB, demoBoot());
      await controller.reconcile();

      const result = await setEventsTransport(
        env.DB,
        { controller, envKeyConfigured: false },
        "poll",
      );

      expect(result.error).toMatch(/API key/);
      expect(await getConfig(env.DB, EVENTS_TRANSPORT_KEY)).toBe("webhook");
      expect(controller.status().running).toBe(false);
    });

    it("rejects an unparseable target URL", async () => {
      const env = await seedTransportEnv();
      controller = createEventsPollerController(env.DB, demoBoot());

      const result = await setEventsPollTarget(
        env.DB,
        { controller, envKeyConfigured: true },
        { target: "workos", url: "not a url" },
      );

      expect(result.error).toMatch(/URL/);
      expect(await getConfig(env.DB, EVENTS_URL_KEY)).toBeNull();
    });

    it("keeps the poller stopped with a visible reason if config reaches the keyless state anyway", async () => {
      // Defense in depth behind the action validation: config written by hand
      // (or a key cleared out from under a target) must not crash or silently
      // start a keyless real-WorkOS poller.
      const env = await seedTransportEnv();
      installTransportFetch(env);
      await setConfig(env.DB, EVENTS_TARGET_KEY, "workos");
      await setConfig(env.DB, EVENTS_URL_KEY, REAL_URL);

      controller = createEventsPollerController(env.DB, demoBoot());
      const status = await controller.reconcile();

      expect(status.running).toBe(false);
      expect(status.lastError).toMatch(/API key/);
    });
  });

  describe("stored API key handling", () => {
    it("encrypts the stored key at rest and decrypts it for use", async () => {
      const env = await seedTransportEnv();
      const real = installTransportFetch(env);
      // What server boot does when APP_ENCRYPTION_KEY is set.
      (env.DB as { encryptionKey?: string | null }).encryptionKey = "unit-test-key";

      const stored = await storeEventsApiKey(
        env.DB,
        { controller: null, envKeyConfigured: false },
        "sk_live_super_secret",
      );
      expect(stored.error).toBeUndefined();

      const raw = await getConfig(env.DB, EVENTS_API_KEY_CONFIG_KEY);
      expect(raw).toMatch(/^enc:v1:/);
      expect(raw).not.toContain("sk_live_super_secret");

      controller = createEventsPollerController(env.DB, demoBoot());
      const target = await setEventsPollTarget(
        env.DB,
        { controller, envKeyConfigured: false },
        { target: "workos", url: REAL_URL },
      );
      expect(target.error).toBeUndefined();

      const status = controller.status();
      expect(status.running).toBe(true);
      expect(status.keySource).toBe("stored");
      expect(real.auths).toEqual(["Bearer sk_live_super_secret"]);
    });

    it("lets WORKOS_API_KEY always win over the stored key", async () => {
      const env = await seedTransportEnv();
      const real = installTransportFetch(env);
      await storeEventsApiKey(env.DB, { controller: null, envKeyConfigured: true }, "sk_stored");
      await setConfig(env.DB, EVENTS_TARGET_KEY, "workos");
      await setConfig(env.DB, EVENTS_URL_KEY, REAL_URL);

      controller = createEventsPollerController(env.DB, demoBoot({ envApiKey: "sk_env_123" }));
      const status = await controller.reconcile();

      expect(status.running).toBe(true);
      expect(status.keySource).toBe("env");
      expect(real.auths).toEqual(["Bearer sk_env_123"]);
    });

    it("refuses to clear the key out from under a keyless real-WorkOS poller", async () => {
      const env = await seedTransportEnv();
      const real = installTransportFetch(env);
      await storeEventsApiKey(env.DB, { controller: null, envKeyConfigured: false }, "sk_stored");
      await setConfig(env.DB, EVENTS_TARGET_KEY, "workos");
      await setConfig(env.DB, EVENTS_URL_KEY, REAL_URL);
      controller = createEventsPollerController(env.DB, demoBoot());
      await controller.reconcile();
      expect(real.auths).toEqual(["Bearer sk_stored"]);

      const refused = await clearEventsApiKey(env.DB, { controller, envKeyConfigured: false });
      expect(refused.error).toMatch(/before clearing/);
      expect(await getConfig(env.DB, EVENTS_API_KEY_CONFIG_KEY)).not.toBeNull();

      // Retarget to the mock first, then the clear goes through and the
      // poller keeps running keylessly where that is allowed.
      await setEventsPollTarget(
        env.DB,
        { controller, envKeyConfigured: false },
        {
          target: "mock",
        },
      );
      const cleared = await clearEventsApiKey(env.DB, { controller, envKeyConfigured: false });
      expect(cleared.error).toBeUndefined();
      expect(await getConfig(env.DB, EVENTS_API_KEY_CONFIG_KEY)).toBeNull();
      expect(controller.status().running).toBe(true);
      expect(controller.status().keySource).toBe("mock");
    });

    it("refuses to store a blank key", async () => {
      const env = await seedTransportEnv();
      const result = await storeEventsApiKey(
        env.DB,
        { controller: null, envKeyConfigured: false },
        "   ",
      );
      expect(result.error).toBeTruthy();
      expect(await getConfig(env.DB, EVENTS_API_KEY_CONFIG_KEY)).toBeNull();
    });
  });

  describe("cross-module-graph registry", () => {
    it("hands the panel the controller boot registered", async () => {
      const env = await seedTransportEnv();
      controller = createEventsPollerController(env.DB, demoBoot());
      registerEventsPollerController(controller);
      expect(eventsPollerController()).toBe(controller);
    });
  });
});
