import { afterEach, describe, expect, it, vi } from "vitest";
import { eventsPollerEnabled, loadConfig } from "../server/config";
import {
  EVENTS_CURSOR_KEY,
  pollDsyncEventsOnce,
  startEventsPoller,
} from "../workers/native/events-poller";
import nativeWorker from "../workers/native/index";
import { handleDsyncWebhook } from "../workers/native/listener";
import { getConfig, setConfig } from "../workers/shared/db";
import type { ListenerEvent, PocEnv } from "../workers/shared/types";
import { createCtx, createEnv, seedDirectory } from "./helpers";

/**
 * The Events API polling transport. The mock WorkOS bundled into the native
 * worker keeps an ordered log of every DSync event it emits and serves it from
 * `GET /events` with `after` cursor pagination — the same contract as the real
 * `https://api.workos.com/events` — so the poller is exercised end to end here
 * with no real WorkOS.
 */

const MOCK_TOKEN = "mock-secret";
/** The bundled mock, as the fetch shim below serves it. The poller's base URL
 *  points here the same way a demo deployment points WORKOS_EVENTS_URL at it. */
const EVENTS_BASE = "https://app.test/mock-workos";

const USER_SCHEMA = "urn:ietf:params:scim:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:core:2.0:Group";

const T1 = "2026-08-10T10:00:00.000Z";

const originalFetch = globalThis.fetch;

/** Serve https://app.test from the native worker in-process, so the poller's
 *  plain `fetch` reaches the bundled mock exactly as it would over a socket. */
function installAppFetch(env: PocEnv): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (new URL(req.url).origin !== "https://app.test") {
      throw new Error(`unexpected fetch to ${req.url}`);
    }
    return nativeWorker.fetch(req, env, createCtx());
  }) as typeof fetch;
}

/** One directory in workos-only mode with the status endpoint unconfigured, so
 *  the handle-vs-ignore instruction deterministically falls back to the row.
 *  The mock's own webhook emission is off: anything the listener applies in
 *  these tests can only have travelled via GET /events. */
async function seedPollerEnv(): Promise<PocEnv> {
  const env = await createEnv();
  await env.DB.prepare(
    "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
  ).run();
  await seedDirectory(env.DB, { mode: "workos-only" });
  await setConfig(env.DB, "mock_workos.scim_token", MOCK_TOKEN);
  await setConfig(env.DB, "mock_workos.emit_dsync", "false");
  return env;
}

async function mockScim(
  env: PocEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const res = await nativeWorker.fetch(
    new Request(`https://app.test/mock-workos/scim/v2${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${MOCK_TOKEN}`,
        ...(body !== undefined ? { "Content-Type": "application/scim+json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env,
    createCtx(),
  );
  expect(res.status).toBeLessThan(300);
  return res;
}

async function eventsRequest(env: PocEnv, query: string, token = MOCK_TOKEN): Promise<Response> {
  return nativeWorker.fetch(
    new Request(`https://app.test/mock-workos/events${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    createCtx(),
  );
}

/** Append an envelope to the mock's event log directly, for the tests that need
 *  exact ids and timestamps rather than whatever a SCIM write would emit. */
async function appendEnvelope(
  db: PocEnv["DB"],
  id: string,
  event: string,
  data: unknown,
  createdAt: string = T1,
): Promise<void> {
  await db
    .prepare("INSERT INTO mock_workos_events (id, event, data, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, event, JSON.stringify(data), createdAt)
    .run();
}

function scimUser(userName: string, externalId: string, active = true) {
  return { schemas: [USER_SCHEMA], userName, externalId, active };
}

async function listenerEvents(db: PocEnv["DB"]): Promise<ListenerEvent[]> {
  const { results } = await db
    .prepare("SELECT * FROM listener_events ORDER BY id")
    .all<ListenerEvent>();
  return results;
}

async function nativeUsers(
  db: PocEnv["DB"],
): Promise<{ id: string; external_id: string | null; active: number }[]> {
  const { results } = await db
    .prepare("SELECT * FROM native_users ORDER BY id")
    .all<{ id: string; external_id: string | null; active: number }>();
  return results;
}

async function memberEdges(db: PocEnv["DB"]): Promise<{ group_id: string; user_id: string }[]> {
  const { results } = await db
    .prepare("SELECT group_id, user_id FROM native_group_members ORDER BY group_id, user_id")
    .all<{ group_id: string; user_id: string }>();
  return results;
}

async function mockEventIds(db: PocEnv["DB"]): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM mock_workos_events ORDER BY seq")
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

describe("events api poller", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("applies a page of events in order through the listener and persists the cursor", async () => {
    const env = await seedPollerEnv();
    installAppFetch(env);
    await mockScim(env, "POST", "/Users", scimUser("ada@example.com", "idp-user-1"));
    await mockScim(env, "POST", "/Users", scimUser("grace@example.com", "idp-user-9"));
    await mockScim(env, "POST", "/Groups", {
      schemas: [GROUP_SCHEMA],
      displayName: "Engineering",
      externalId: "grp-eng",
    });
    // Webhook emission is off, so the log is the only copy of these events.
    expect(await nativeUsers(env.DB)).toHaveLength(0);

    // limit: 2 forces a second page, so this also proves a tick drains the log.
    const result = await pollDsyncEventsOnce(env.DB, {
      apiKey: MOCK_TOKEN,
      baseUrl: EVENTS_BASE,
      limit: 2,
    });

    expect(result.processed).toBe(3);
    expect((await nativeUsers(env.DB)).map((u) => u.external_id)).toEqual([
      "idp-user-1",
      "idp-user-9",
    ]);
    expect((await listenerEvents(env.DB)).map((e) => [e.event_type, e.action])).toEqual([
      ["dsync.user.created", "applied"],
      ["dsync.user.created", "applied"],
      ["dsync.group.created", "applied"],
    ]);
    const log = await mockEventIds(env.DB);
    expect(await getConfig(env.DB, EVENTS_CURSOR_KEY)).toBe(log[log.length - 1]);
  });

  it("resumes from the persisted cursor without re-applying old events", async () => {
    const env = await seedPollerEnv();
    installAppFetch(env);
    await mockScim(env, "POST", "/Users", scimUser("ada@example.com", "idp-user-1"));
    await pollDsyncEventsOnce(env.DB, { apiKey: MOCK_TOKEN, baseUrl: EVENTS_BASE });
    expect(await listenerEvents(env.DB)).toHaveLength(1);

    // A later run — a restart in miniature: nothing carried over but the
    // persisted cursor — must see only what happened since.
    await mockScim(env, "POST", "/Users", scimUser("grace@example.com", "idp-user-9"));
    const result = await pollDsyncEventsOnce(env.DB, { apiKey: MOCK_TOKEN, baseUrl: EVENTS_BASE });

    expect(result.processed).toBe(1);
    const rows = await listenerEvents(env.DB);
    // No replayed or "skipped duplicate" rows for the first event: the cursor
    // means the old page is never re-read at all.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      event_type: "dsync.user.created",
      action: "applied",
      idp_id: "idp-user-9",
    });
    const log = await mockEventIds(env.DB);
    expect(await getConfig(env.DB, EVENTS_CURSOR_KEY)).toBe(log[log.length - 1]);

    // And a poll with nothing new applies nothing and moves nothing.
    const idle = await pollDsyncEventsOnce(env.DB, { apiKey: MOCK_TOKEN, baseUrl: EVENTS_BASE });
    expect(idle.processed).toBe(0);
    expect(await listenerEvents(env.DB)).toHaveLength(2);
    expect(await getConfig(env.DB, EVENTS_CURSOR_KEY)).toBe(log[log.length - 1]);
  });

  it("converges on the deactivate/reactivate/membership sequence that breaks out-of-order webhooks", async () => {
    // The transport's selling point. All four events share one created_at —
    // WorkOS timestamps are not unique — so the listener's version ledger
    // cannot order them: delivered as webhooks with the deactivate arriving
    // last (observed live, 31s late), the stale event wins and destroys the
    // state the reactivate established. The Events API returns them in
    // emission order, so applying in returned order needs no timestamps.
    const env = await seedPollerEnv();
    installAppFetch(env);
    const ada = { idp_id: "idp-user-1", email: "ada@example.com" };
    const engineering = { name: "Engineering", raw_attributes: { externalId: "grp-eng" } };
    await appendEnvelope(env.DB, "evt_1", "dsync.user.created", { ...ada, state: "active" });
    await appendEnvelope(env.DB, "evt_2", "dsync.user.updated", { ...ada, state: "inactive" });
    await appendEnvelope(env.DB, "evt_3", "dsync.user.updated", { ...ada, state: "active" });
    await appendEnvelope(env.DB, "evt_4", "dsync.group.user_added", {
      user: { ...ada, state: "active" },
      group: engineering,
    });

    const result = await pollDsyncEventsOnce(env.DB, { apiKey: MOCK_TOKEN, baseUrl: EVENTS_BASE });

    expect(result.processed).toBe(4);
    const users = await nativeUsers(env.DB);
    expect(users).toHaveLength(1);
    expect(users[0].active).toBe(1);
    expect(await memberEdges(env.DB)).toHaveLength(1);
    expect((await listenerEvents(env.DB)).map((e) => e.action)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
    ]);
  });

  it("does not advance the cursor past an event whose handler failed", async () => {
    const env = await seedPollerEnv();
    installAppFetch(env);
    await appendEnvelope(env.DB, "evt_1", "dsync.user.created", {
      idp_id: "idp-user-1",
      email: "ada@example.com",
      state: "active",
    });
    await appendEnvelope(env.DB, "evt_2", "dsync.user.created", {
      idp_id: "idp-user-9",
      email: "grace@example.com",
      state: "active",
    });
    // Hide the users table so the second apply throws mid-page.
    await appendEnvelope(env.DB, "evt_3", "dsync.group.created", {
      name: "Engineering",
      raw_attributes: { externalId: "grp-eng" },
    });
    await env.DB.prepare("ALTER TABLE native_groups RENAME TO native_groups_hidden").run();

    await pollDsyncEventsOnce(env.DB, { apiKey: MOCK_TOKEN, baseUrl: EVENTS_BASE });

    // The two user events landed and are behind the cursor; the failed group
    // event is not, so the next poll re-reads and repairs it.
    expect(await getConfig(env.DB, EVENTS_CURSOR_KEY)).toBe("evt_2");
    await env.DB.prepare("ALTER TABLE native_groups_hidden RENAME TO native_groups").run();
    const repaired = await pollDsyncEventsOnce(env.DB, {
      apiKey: MOCK_TOKEN,
      baseUrl: EVENTS_BASE,
    });

    expect(repaired.processed).toBe(1);
    expect(await getConfig(env.DB, EVENTS_CURSOR_KEY)).toBe("evt_3");
    const { results } = await env.DB.prepare("SELECT id FROM native_groups").all<{ id: string }>();
    expect(results).toHaveLength(1);
  });

  describe("the polling loop", () => {
    /** An always-empty datastore. The loop tests assert timer arithmetic, and a
     *  real driver's socket round-trips cannot complete while the clock is
     *  fake — on Postgres the first tick would simply hang. */
    function stubDb(): PocEnv["DB"] {
      const statement = {
        bind: () => statement,
        first: async () => null,
        all: async () => ({ results: [], success: true as const, meta: {} }),
        run: async () => ({
          results: [],
          success: true as const,
          meta: { changes: 0, duration: 0 },
        }),
      };
      return { prepare: () => statement } as unknown as PocEnv["DB"];
    }

    it("keeps polling after a failed fetch", async () => {
      vi.useFakeTimers();
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection refused");
        return Response.json({ data: [], list_metadata: { before: null, after: null } });
      }) as typeof fetch;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const poller = startEventsPoller(stubDb(), {
        apiKey: MOCK_TOKEN,
        baseUrl: EVENTS_BASE,
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      // The failure was logged and swallowed; the next tick still runs.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);

      poller.stop();
      warn.mockRestore();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(2);
    });

    it("keeps at most one poll in flight", async () => {
      vi.useFakeTimers();
      let calls = 0;
      let release: ((res: Response) => void) | undefined;
      globalThis.fetch = ((): Promise<Response> => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      }) as typeof fetch;

      const poller = startEventsPoller(stubDb(), {
        apiKey: MOCK_TOKEN,
        baseUrl: EVENTS_BASE,
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);
      // Three intervals pass while the first request hangs: no second request.
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toBe(1);

      release?.(Response.json({ data: [], list_metadata: { before: null, after: null } }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      poller.stop();
    });
  });

  describe("the mock /events endpoint", () => {
    it("requires the bearer token", async () => {
      const env = await seedPollerEnv();

      expect((await eventsRequest(env, "", "wrong")).status).toBe(401);
      expect((await eventsRequest(env, "")).status).toBe(200);
    });

    it("pages in emission order with after + limit", async () => {
      const env = await seedPollerEnv();
      for (const n of [1, 2, 3]) {
        await appendEnvelope(env.DB, `evt_${n}`, "dsync.user.created", { idp_id: `idp-${n}` });
      }

      const first = (await (await eventsRequest(env, "?limit=2")).json()) as {
        data: { id: string }[];
        list_metadata: { after: string | null };
      };
      expect(first.data.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
      expect(first.list_metadata.after).toBe("evt_2");

      const second = (await (await eventsRequest(env, "?limit=2&after=evt_2")).json()) as {
        data: { id: string }[];
        list_metadata: { after: string | null };
      };
      expect(second.data.map((e) => e.id)).toEqual(["evt_3"]);
      // The log is exhausted, which the real API reports as a null cursor.
      expect(second.list_metadata.after).toBeNull();
    });

    it("honours the events[] filter", async () => {
      const env = await seedPollerEnv();
      await appendEnvelope(env.DB, "evt_1", "dsync.user.created", { idp_id: "idp-1" });
      await appendEnvelope(env.DB, "evt_2", "connection.activated", {});
      await appendEnvelope(env.DB, "evt_3", "dsync.user.deleted", { idp_id: "idp-1" });

      const res = (await (
        await eventsRequest(env, "?events[]=dsync.user.created&events[]=dsync.user.deleted")
      ).json()) as { data: { id: string }[] };

      expect(res.data.map((e) => e.id)).toEqual(["evt_1", "evt_3"]);
    });
  });

  describe("WORKOS_API_KEY gates the poller", () => {
    it("stays off when the key is unset, leaving webhooks the transport", async () => {
      const config = loadConfig({ APP_ROLE: "native-app", WEBHOOK_SECRET: "whsec_123" });
      expect(config.workosApiKey).toBeNull();
      expect(eventsPollerEnabled(config)).toBe(false);

      // The webhook path is byte-for-byte the pre-poller behavior: an event
      // delivered to /webhooks/dsync applies, and no cursor state appears.
      const env = await seedPollerEnv();
      const res = await handleDsyncWebhook(
        new Request("https://app.test/webhooks/dsync", {
          method: "POST",
          body: JSON.stringify({
            id: "evt_wh1",
            event: "dsync.user.created",
            created_at: T1,
            data: { idp_id: "idp-user-1", email: "ada@example.com", state: "active" },
          }),
        }),
        env.DB,
      );

      expect(res.status).toBe(200);
      expect(await nativeUsers(env.DB)).toHaveLength(1);
      expect(await getConfig(env.DB, EVENTS_CURSOR_KEY)).toBeNull();
    });

    it("turns on for the native-app role, and for the bridge only alongside the demo mock", () => {
      const key = { WORKOS_API_KEY: "sk_test_123" };
      expect(
        eventsPollerEnabled(loadConfig({ APP_ROLE: "native-app", WEBHOOK_SECRET: "w", ...key })),
      ).toBe(true);
      // A plain bridge mounts no native app for the poller to feed.
      expect(eventsPollerEnabled(loadConfig({ PANEL_AUTH_DISABLED: "true", ...key }))).toBe(false);
      expect(
        eventsPollerEnabled(loadConfig({ PANEL_AUTH_DISABLED: "true", DEMO_MODE: "true", ...key })),
      ).toBe(true);
    });

    it("reads the key from the environment only, defaulting the endpoint and interval", () => {
      const config = loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "w",
        WORKOS_API_KEY: " sk_test_123 ",
      });
      expect(config.workosApiKey).toBe("sk_test_123");
      expect(config.workosEventsUrl).toBe("https://api.workos.com");
      expect(config.eventsPollIntervalMs).toBe(5000);

      const demo = loadConfig({
        APP_ROLE: "native-app",
        WEBHOOK_SECRET: "w",
        WORKOS_EVENTS_URL: "http://127.0.0.1:8080/mock-workos/",
        WORKOS_EVENTS_POLL_INTERVAL_MS: "250",
      });
      expect(demo.workosEventsUrl).toBe("http://127.0.0.1:8080/mock-workos");
      expect(demo.eventsPollIntervalMs).toBe(250);

      for (const bad of ["0", "-5", "nope"]) {
        expect(() =>
          loadConfig({
            APP_ROLE: "native-app",
            WEBHOOK_SECRET: "w",
            WORKOS_EVENTS_POLL_INTERVAL_MS: bad,
          }),
        ).toThrow(/WORKOS_EVENTS_POLL_INTERVAL_MS/);
      }
    });
  });
});
