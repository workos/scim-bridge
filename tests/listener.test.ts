import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDsyncWebhook } from "../workers/native/listener";
import { fetchDirectoryStatus } from "../workers/native/status-client";
import { setConfig } from "../workers/shared/db";
import type { Directory, ListenerEvent, PocEnv } from "../workers/shared/types";
import {
  NATIVE_URL,
  createEnv,
  installFakeUpstreams,
  seedDirectory,
  type FakeUpstreams,
  type SeedDirectoryOptions,
} from "./helpers";

const T1 = "2026-07-31T10:00:00.000Z";
const T2 = "2026-07-31T11:00:00.000Z";
const T3 = "2026-07-31T12:00:00.000Z";

let eventSeq = 0;

interface EnvelopeOptions {
  id?: string | null;
  at?: string;
}

function envelope(event: string, data: unknown, opts: EnvelopeOptions = {}) {
  return {
    id: opts.id === undefined ? `event_${(eventSeq += 1)}` : opts.id,
    event,
    created_at: opts.at ?? T1,
    data,
  };
}

function webhookRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://native.test/webhooks/dsync", { method: "POST", headers, body });
}

async function deliver(
  env: PocEnv,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return handleDsyncWebhook(webhookRequest(raw, headers), env.DB);
}

/** Environment with one directory and the status endpoint UNconfigured, so the
 *  mode lookup deterministically falls back to the directory row (migration
 *  0002 seeds proxy.public_url=localhost, which tests must not dial). */
async function seedListenerEnv(
  opts: SeedDirectoryOptions = {},
): Promise<{ env: PocEnv; directory: Directory }> {
  const env = createEnv();
  await env.DB.prepare(
    "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
  ).run();
  const directory = await seedDirectory(env.DB, { mode: "workos-only", ...opts });
  return { env, directory };
}

async function listenerEvents(db: PocEnv["DB"]): Promise<ListenerEvent[]> {
  const { results } = await db
    .prepare("SELECT * FROM listener_events ORDER BY id")
    .all<ListenerEvent>();
  return results;
}

async function lastEvent(db: PocEnv["DB"]): Promise<ListenerEvent> {
  const rows = await listenerEvents(db);
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

interface NativeUser {
  id: string;
  user_name: string;
  external_id: string | null;
  active: number;
  resource: string;
}

async function nativeUsers(db: PocEnv["DB"]): Promise<NativeUser[]> {
  const { results } = await db.prepare("SELECT * FROM native_users ORDER BY id").all<NativeUser>();
  return results;
}

async function nativeGroups(
  db: PocEnv["DB"],
): Promise<{ id: string; display_name: string; external_id: string | null }[]> {
  const { results } = await db
    .prepare("SELECT * FROM native_groups ORDER BY id")
    .all<{ id: string; display_name: string; external_id: string | null }>();
  return results;
}

async function memberEdges(db: PocEnv["DB"]): Promise<{ group_id: string; user_id: string }[]> {
  const { results } = await db
    .prepare("SELECT * FROM native_group_members ORDER BY group_id, user_id")
    .all<{ group_id: string; user_id: string }>();
  return results;
}

const ada = {
  idp_id: "idp-user-1",
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
  state: "active",
};

const engineering = { name: "Engineering", raw_attributes: { externalId: "grp-eng" } };

describe("dsync listener", () => {
  let fake: FakeUpstreams | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
    vi.useRealTimers();
  });

  describe("webhook auth", () => {
    it("rejects a delivery without a signature when a secret is configured", async () => {
      const { env } = await seedListenerEnv();
      await setConfig(env.DB, "native.webhook_secret", "whsec_test");

      const res = await deliver(env, envelope("dsync.user.created", ada));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        received: false,
        error: "Webhook signature verification failed.",
      });
      // Nothing is applied or even logged for an unauthenticated delivery.
      expect(await listenerEvents(env.DB)).toHaveLength(0);
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });

    it("rejects a tampered signature", async () => {
      const { env } = await seedListenerEnv();
      await setConfig(env.DB, "native.webhook_secret", "whsec_test");
      const body = JSON.stringify(envelope("dsync.user.created", ada));
      const mac = createHmac("sha256", "wrong-secret").update(`1753900000.${body}`).digest("hex");

      const res = await deliver(env, body, { "WorkOS-Signature": `t=1753900000,v1=${mac}` });

      expect(res.status).toBe(401);
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });

    it("accepts a correctly signed delivery", async () => {
      const { env } = await seedListenerEnv();
      const secret = "whsec_test";
      await setConfig(env.DB, "native.webhook_secret", secret);
      const body = JSON.stringify(envelope("dsync.user.created", ada));
      const t = "1753900000";
      const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

      const res = await deliver(env, body, { "WorkOS-Signature": `t=${t},v1=${mac}` });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      expect((await lastEvent(env.DB)).action).toBe("applied");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });

    it("accepts unsigned deliveries while no secret is configured", async () => {
      const { env } = await seedListenerEnv();
      const res = await deliver(env, envelope("dsync.user.created", ada));
      expect(res.status).toBe(200);
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });
  });

  describe("mode gating", () => {
    for (const mode of ["passthrough", "dual-write"] as const) {
      it(`stays inert in ${mode} mode but still advances the version ledger`, async () => {
        const { env } = await seedListenerEnv({ mode });

        const res = await deliver(env, envelope("dsync.user.created", ada, { at: T2 }));

        expect(res.status).toBe(200);
        expect(await nativeUsers(env.DB)).toHaveLength(0);
        const event = await lastEvent(env.DB);
        expect(event.action).toBe("ignored");
        expect(event.detail).toBe(
          `listener inactive in ${mode} mode — the proxy writes the native app directly until cutover`,
        );
        expect(event.idp_id).toBe("idp-user-1");

        const version = await env.DB.prepare("SELECT * FROM listener_versions WHERE scope = ?")
          .bind("user:idp-user-1")
          .first<{ event_at: string }>();
        expect(version?.event_at).toBe(T2);
      });
    }

    it("applies events in workos-only mode", async () => {
      const { env } = await seedListenerEnv({ mode: "workos-only" });

      const res = await deliver(env, envelope("dsync.user.created", ada));

      expect(res.status).toBe(200);
      expect((await lastEvent(env.DB)).action).toBe("applied");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });

    it("uses a version recorded while inert to drop a stale pre-cutover event after cutover", async () => {
      const { env, directory } = await seedListenerEnv({ mode: "passthrough" });
      await deliver(env, envelope("dsync.user.updated", ada, { at: T3 }));

      await env.DB.prepare("UPDATE scim_directories SET mode = 'workos-only' WHERE id = ?")
        .bind(directory.id)
        .run();
      const res = await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));

      expect(res.status).toBe(200);
      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("superseded by a newer event (out-of-order delivery)");
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });

    it("leaves an event unapplied when several directories exist and it carries no directory_id", async () => {
      const { env } = await seedListenerEnv({ mode: "workos-only" });
      await seedDirectory(env.DB, { mode: "workos-only", name: "Second" });

      await deliver(env, envelope("dsync.user.created", ada));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("ignored");
      expect(event.detail).toBe(
        "listener inactive in pre-cutover mode — the proxy writes the native app directly until cutover",
      );
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });

    it("resolves the directory by the workos_directory_id an event carries", async () => {
      const { env } = await seedListenerEnv({ mode: "passthrough" });
      await seedDirectory(env.DB, {
        mode: "workos-only",
        name: "Migrated",
        workos_directory_id: "directory_123",
      });

      await deliver(env, envelope("dsync.user.created", { ...ada, directory_id: "directory_123" }));

      expect((await lastEvent(env.DB)).action).toBe("applied");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });

    it("prefers the mode from the proxy status endpoint over the directory row", async () => {
      const { env, directory } = await seedListenerEnv({ mode: "passthrough" });
      await setConfig(env.DB, "proxy.loopback_url", NATIVE_URL);
      fake = installFakeUpstreams();
      fake.route("native", "GET", "/status/directories/", (call) => {
        expect(call.headers.get("Authorization")).toBe(`Bearer ${directory.proxy_token}`);
        return Response.json({
          directory_id: directory.id,
          workos_directory_id: null,
          mode: "workos-only",
          native_authoritative: false,
          updated_at: directory.updated_at,
        });
      });

      await deliver(env, envelope("dsync.user.created", ada));

      expect(fake.callsTo("native")[0]?.path).toBe(`/status/directories/${directory.id}`);
      expect((await lastEvent(env.DB)).action).toBe("applied");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });

    it("falls back to the directory row when the status endpoint errors", async () => {
      const { env } = await seedListenerEnv({ mode: "workos-only" });
      await setConfig(env.DB, "proxy.loopback_url", NATIVE_URL);
      fake = installFakeUpstreams();
      // No status route: the fake answers 501, which the client treats as a
      // failed lookup.

      await deliver(env, envelope("dsync.user.created", ada));

      expect((await lastEvent(env.DB)).action).toBe("applied");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });
  });

  describe("status client", () => {
    const statusBody = (directory: Directory) => ({
      directory_id: directory.id,
      workos_directory_id: directory.workos_directory_id,
      mode: "workos-only" as const,
      native_authoritative: false,
      updated_at: directory.updated_at,
    });

    it("fetches once and serves the TTL window from cache", async () => {
      const { env, directory } = await seedListenerEnv();
      await setConfig(env.DB, "proxy.loopback_url", NATIVE_URL);
      fake = installFakeUpstreams();
      fake.route("native", "GET", "/status/directories/", () =>
        Response.json(statusBody(directory), { headers: { ETag: '"v1"' } }),
      );

      const first = await fetchDirectoryStatus(env.DB, directory);
      const second = await fetchDirectoryStatus(env.DB, directory);

      expect(first?.mode).toBe("workos-only");
      expect(second).toEqual(first);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.calls[0].headers.get("Authorization")).toBe(`Bearer ${directory.proxy_token}`);
      expect(fake.calls[0].headers.get("If-None-Match")).toBeNull();
    });

    it("revalidates with If-None-Match after the TTL and keeps the cached status on 304", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { env, directory } = await seedListenerEnv();
      await setConfig(env.DB, "proxy.loopback_url", NATIVE_URL);
      fake = installFakeUpstreams();
      fake.route(
        "native",
        "GET",
        "/status/directories/",
        Response.json(statusBody(directory), { headers: { ETag: '"v1"' } }),
        { once: true },
      );
      fake.route("native", "GET", "/status/directories/", (call) => {
        expect(call.headers.get("If-None-Match")).toBe('"v1"');
        return new Response(null, { status: 304 });
      });

      const first = await fetchDirectoryStatus(env.DB, directory);
      vi.setSystemTime(Date.now() + 6_000);
      const second = await fetchDirectoryStatus(env.DB, directory);
      const third = await fetchDirectoryStatus(env.DB, directory);

      expect(first?.mode).toBe("workos-only");
      expect(second).toEqual(first);
      // The 304 re-freshens the entry, so the immediate third read is a cache hit.
      expect(third).toEqual(first);
      expect(fake.callsTo("native")).toHaveLength(2);
    });

    it("backs off for the TTL after a failed lookup", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { env, directory } = await seedListenerEnv();
      await setConfig(env.DB, "proxy.loopback_url", NATIVE_URL);
      fake = installFakeUpstreams();
      fake.route("native", "GET", "/status/directories/", new Response(null, { status: 500 }), {
        once: true,
      });
      fake.route("native", "GET", "/status/directories/", () =>
        Response.json(statusBody(directory)),
      );

      expect(await fetchDirectoryStatus(env.DB, directory)).toBeNull();
      // Within the backoff window the client does not retry.
      expect(await fetchDirectoryStatus(env.DB, directory)).toBeNull();
      expect(fake.callsTo("native")).toHaveLength(1);

      vi.setSystemTime(Date.now() + 6_000);
      expect((await fetchDirectoryStatus(env.DB, directory))?.mode).toBe("workos-only");
      expect(fake.callsTo("native")).toHaveLength(2);
    });

    it("returns null without fetching when no status endpoint is configured", async () => {
      const { env, directory } = await seedListenerEnv();
      fake = installFakeUpstreams();

      expect(await fetchDirectoryStatus(env.DB, directory)).toBeNull();
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("user events", () => {
    it("creates a user keyed on the IdP id", async () => {
      const { env } = await seedListenerEnv();

      await deliver(env, envelope("dsync.user.created", ada));

      const users = await nativeUsers(env.DB);
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        id: "idp-user-1",
        user_name: "ada@example.com",
        external_id: "idp-user-1",
        active: 1,
      });
      expect(JSON.parse(users[0].resource)).toMatchObject({
        schemas: ["urn:ietf:params:scim:core:2.0:User"],
        id: "idp-user-1",
        userName: "ada@example.com",
        externalId: "idp-user-1",
        active: true,
        name: { givenName: "Ada", familyName: "Lovelace" },
        emails: [{ value: "ada@example.com", primary: true }],
        meta: { resourceType: "User" },
      });
      const event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe("onboard()");
      expect(event.idp_id).toBe("idp-user-1");
    });

    it("provisions an inactive user without onboarding it", async () => {
      const { env } = await seedListenerEnv();

      await deliver(env, envelope("dsync.user.created", { ...ada, state: "inactive" }));

      expect((await nativeUsers(env.DB))[0].active).toBe(0);
      expect((await lastEvent(env.DB)).detail).toBe("provisioned inactive");
    });

    it("offboards on a deactivating update and skips a no-transition redelivery", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));

      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, state: "suspended" }, { at: T2 }),
      );
      let event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe("offboard()");
      expect((await nativeUsers(env.DB))[0].active).toBe(0);

      // Same payload again (new event id, same timestamp): no state transition.
      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, state: "suspended" }, { at: T2 }),
      );
      event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("no transition");
    });

    it("deletes a user and its membership edges", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));
      await deliver(
        env,
        envelope("dsync.group.user_added", { user: ada, group: engineering }, { at: T1 }),
      );

      await deliver(env, envelope("dsync.user.deleted", ada, { at: T2 }));

      expect(await nativeUsers(env.DB)).toHaveLength(0);
      expect(await memberEdges(env.DB)).toHaveLength(0);
      const event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe("offboard()");
    });

    it("skips deleting a user that is already absent", async () => {
      const { env } = await seedListenerEnv();

      await deliver(env, envelope("dsync.user.deleted", ada));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("no-op: user already absent");
    });

    it("ignores a user event without an idp_id", async () => {
      const { env } = await seedListenerEnv();

      await deliver(env, envelope("dsync.user.created", { email: "no-id@example.com" }));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("ignored");
      expect(event.detail).toBe("user event carries no idp_id");
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });
  });

  describe("group events", () => {
    it("creates, renames, and deletes a group keyed on its externalId", async () => {
      const { env } = await seedListenerEnv();

      await deliver(
        env,
        envelope("dsync.group.created", { idp_id: "Engineering", ...engineering }, { at: T1 }),
      );
      expect(await nativeGroups(env.DB)).toEqual([
        expect.objectContaining({
          id: "grp-eng",
          display_name: "Engineering",
          external_id: "grp-eng",
        }),
      ]);
      expect((await lastEvent(env.DB)).detail).toBe('group "Engineering" created');

      await deliver(
        env,
        envelope(
          "dsync.group.updated",
          { idp_id: "Platform", name: "Platform", raw_attributes: { externalId: "grp-eng" } },
          { at: T2 },
        ),
      );
      expect((await nativeGroups(env.DB))[0].display_name).toBe("Platform");
      expect((await lastEvent(env.DB)).detail).toBe('renamed to "Platform"');

      await deliver(
        env,
        envelope(
          "dsync.group.deleted",
          { idp_id: "Platform", name: "Platform", raw_attributes: { externalId: "grp-eng" } },
          { at: T3 },
        ),
      );
      expect(await nativeGroups(env.DB)).toHaveLength(0);
      const event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe('group "Platform" removed; its users retained');
    });

    it("skips a group update with no transition", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.group.created", engineering, { at: T1 }));

      await deliver(env, envelope("dsync.group.updated", engineering, { at: T1 }));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("no transition");
    });
  });

  describe("membership events", () => {
    const grace = { idp_id: "idp-user-9", email: "grace@example.com", state: "active" };

    it("upserts stub rows for a membership event that arrives before user and group", async () => {
      const { env } = await seedListenerEnv();

      await deliver(
        env,
        envelope("dsync.group.user_added", { user: grace, group: engineering }, { at: T1 }),
      );

      expect(await nativeUsers(env.DB)).toEqual([
        expect.objectContaining({
          id: "idp-user-9",
          user_name: "grace@example.com",
          external_id: "idp-user-9",
          active: 1,
        }),
      ]);
      expect(await nativeGroups(env.DB)).toEqual([
        expect.objectContaining({ id: "grp-eng", display_name: "Engineering" }),
      ]);
      expect(await memberEdges(env.DB)).toEqual([{ group_id: "grp-eng", user_id: "idp-user-9" }]);
      const event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe(
        'added grace@example.com to "Engineering" (2 stub rows created); onboard()',
      );

      // The later user.created lands on the stub instead of duplicating it.
      await deliver(
        env,
        envelope("dsync.user.created", { ...grace, first_name: "Grace" }, { at: T2 }),
      );
      const users = await nativeUsers(env.DB);
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe("idp-user-9");
      expect(JSON.parse(users[0].resource).name).toMatchObject({ givenName: "Grace" });
    });

    it("skips an already-present membership edge", async () => {
      const { env } = await seedListenerEnv();
      const data = { user: grace, group: engineering };
      await deliver(env, envelope("dsync.group.user_added", data, { at: T1 }));

      await deliver(env, envelope("dsync.group.user_added", data, { at: T1 }));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("no-op: membership edge already present");
      expect(await memberEdges(env.DB)).toHaveLength(1);
    });

    it("removes a membership edge and skips removals for absent users", async () => {
      const { env } = await seedListenerEnv();
      await deliver(
        env,
        envelope("dsync.group.user_added", { user: grace, group: engineering }, { at: T1 }),
      );

      await deliver(
        env,
        envelope("dsync.group.user_removed", { user: grace, group: engineering }, { at: T2 }),
      );
      let event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe('removed grace@example.com from "Engineering"');
      expect(await memberEdges(env.DB)).toHaveLength(0);

      await deliver(
        env,
        envelope(
          "dsync.group.user_removed",
          { user: { idp_id: "idp-user-void", email: "void@example.com" }, group: engineering },
          { at: T2 },
        ),
      );
      event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("no-op: user not present");
    });

    it("does not resurrect a deleted user via a stale membership event", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", grace, { at: T1 }));
      await deliver(env, envelope("dsync.user.deleted", grace, { at: T3 }));

      await deliver(
        env,
        envelope("dsync.group.user_added", { user: grace, group: engineering }, { at: T2 }),
      );

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe(
        "no-op: grace@example.com was removed by a newer event; not resurrecting via stale membership",
      );
      expect(await nativeUsers(env.DB)).toHaveLength(0);
      expect(await memberEdges(env.DB)).toHaveLength(0);
    });
  });

  describe("ordering and dedup", () => {
    it("drops an out-of-order update that would resurrect superseded state", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));
      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, state: "suspended" }, { at: T3 }),
      );

      await deliver(env, envelope("dsync.user.updated", ada, { at: T2 }));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("superseded by a newer event (out-of-order delivery)");
      expect((await nativeUsers(env.DB))[0].active).toBe(0);
    });

    it("skips a redelivery of an already-processed event id", async () => {
      const { env } = await seedListenerEnv();
      const dup = envelope("dsync.user.created", ada, { id: "event_dup", at: T1 });
      await deliver(env, dup);

      await deliver(env, dup);

      const rows = await listenerEvents(env.DB);
      expect(rows).toHaveLength(2);
      expect(rows[0].action).toBe("applied");
      expect(rows[1]).toMatchObject({
        event_id: "event_dup",
        action: "skipped",
        detail: "duplicate delivery",
      });
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });
  });

  describe("webhook auth edge cases", () => {
    it("accepts a signature whose hex digest is uppercase", async () => {
      const { env } = await seedListenerEnv();
      const secret = "whsec_test";
      await setConfig(env.DB, "native.webhook_secret", secret);
      const body = JSON.stringify(envelope("dsync.user.created", ada));
      const t = "1753900000";
      const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex").toUpperCase();

      const res = await deliver(env, body, { "WorkOS-Signature": `t=${t},v1=${mac}` });

      expect(res.status).toBe(200);
      expect((await lastEvent(env.DB)).action).toBe("applied");
    });

    it("treats an empty configured secret like no secret", async () => {
      const { env } = await seedListenerEnv();
      await setConfig(env.DB, "native.webhook_secret", "");

      const res = await deliver(env, envelope("dsync.user.created", ada));

      expect(res.status).toBe(200);
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });
  });

  describe("handler errors", () => {
    it("acknowledges a handler error without an event id so a redelivery can repair it", async () => {
      const { env } = await seedListenerEnv();
      // Hide the users table so the apply throws a non-transient storage error.
      await env.DB.prepare("ALTER TABLE native_users RENAME TO native_users_hidden").run();
      const event = envelope("dsync.user.created", ada, { id: "event_err", at: T1 });

      const res = await deliver(env, event);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      const failed = await lastEvent(env.DB);
      expect(failed.action).toBe("ignored");
      expect(failed.detail).toMatch(/^handler error \(event event_err\): /);
      expect(failed.event_id).toBeNull();
      // The ledger only advances once an event is applied, never on a failure.
      const version = await env.DB.prepare("SELECT event_at FROM listener_versions WHERE scope = ?")
        .bind("user:idp-user-1")
        .first<{ event_at: string }>();
      expect(version).toBeFalsy();

      await env.DB.prepare("ALTER TABLE native_users_hidden RENAME TO native_users").run();
      await deliver(env, event);

      const repaired = await lastEvent(env.DB);
      expect(repaired.action).toBe("applied");
      expect(repaired.event_id).toBe("event_err");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });
  });

  describe("version ledger", () => {
    it("applies an event without a created_at in arrival order and records no version", async () => {
      const { env } = await seedListenerEnv();

      const res = await deliver(env, { id: "event_noat", event: "dsync.user.created", data: ada });

      expect(res.status).toBe(200);
      expect((await lastEvent(env.DB)).action).toBe("applied");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
      const versions = await env.DB.prepare("SELECT * FROM listener_versions").all();
      expect(versions.results).toHaveLength(0);
    });

    it("never regresses the ledger when inert events arrive out of order", async () => {
      const { env, directory } = await seedListenerEnv({ mode: "dual-write" });
      await deliver(env, envelope("dsync.user.updated", ada, { at: T3 }));
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));

      const version = await env.DB.prepare("SELECT event_at FROM listener_versions WHERE scope = ?")
        .bind("user:idp-user-1")
        .first<{ event_at: string }>();
      expect(version?.event_at).toBe(T3);

      await env.DB.prepare("UPDATE scim_directories SET mode = 'workos-only' WHERE id = ?")
        .bind(directory.id)
        .run();
      await deliver(env, envelope("dsync.user.updated", ada, { at: T2 }));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("superseded by a newer event (out-of-order delivery)");
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });

    it("applies a redelivery of an event first seen while inert after cutover", async () => {
      // A delivery logged only as 'ignored' while the listener was inert does
      // not count as a duplicate, so a post-cutover redelivery re-evaluates
      // under the current mode and applies — an event straddling the cutover is
      // no longer stranded waiting on the backfill.
      const { env, directory } = await seedListenerEnv({ mode: "passthrough" });
      const event = envelope("dsync.user.created", ada, { id: "event_precut", at: T1 });
      await deliver(env, event);
      expect((await lastEvent(env.DB)).action).toBe("ignored");

      await env.DB.prepare("UPDATE scim_directories SET mode = 'workos-only' WHERE id = ?")
        .bind(directory.id)
        .run();
      await deliver(env, event);

      const row = await lastEvent(env.DB);
      expect(row.action).toBe("applied");
      expect(row.event_id).toBe("event_precut");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });

    it("still drops a stale redelivery superseded by a newer inert event after cutover", async () => {
      // The version ledger advances even while inert, so a redelivery whose own
      // timeline was overtaken by a newer pre-cutover event is still gated as
      // out-of-order rather than resurrecting superseded state.
      const { env, directory } = await seedListenerEnv({ mode: "passthrough" });
      const stale = envelope("dsync.user.created", ada, { id: "event_stale", at: T1 });
      await deliver(env, stale);
      await deliver(env, envelope("dsync.user.updated", ada, { id: "event_newer", at: T3 }));

      await env.DB.prepare("UPDATE scim_directories SET mode = 'workos-only' WHERE id = ?")
        .bind(directory.id)
        .run();
      await deliver(env, stale);

      const row = await lastEvent(env.DB);
      expect(row.action).toBe("skipped");
      expect(row.detail).toBe("superseded by a newer event (out-of-order delivery)");
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });
  });

  describe("directory resolution", () => {
    it("resolves the directory by the proxy's own directory id", async () => {
      const { env } = await seedListenerEnv({ mode: "passthrough" });
      const migrated = await seedDirectory(env.DB, { mode: "workos-only", name: "Migrated" });

      await deliver(env, envelope("dsync.user.created", { ...ada, directory_id: migrated.id }));

      expect((await lastEvent(env.DB)).action).toBe("applied");
      expect(await nativeUsers(env.DB)).toHaveLength(1);
    });

    it("stays inert when no directory is configured", async () => {
      const env = createEnv();
      await env.DB.prepare(
        "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
      ).run();

      const res = await deliver(env, envelope("dsync.user.created", ada));

      expect(res.status).toBe(200);
      const event = await lastEvent(env.DB);
      expect(event.action).toBe("ignored");
      expect(event.detail).toBe(
        "listener inactive in pre-cutover mode — the proxy writes the native app directly until cutover",
      );
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });
  });

  describe("status client url selection", () => {
    const statusBody = (directory: Directory) => ({
      directory_id: directory.id,
      workos_directory_id: directory.workos_directory_id,
      mode: "workos-only" as const,
      native_authoritative: false,
      updated_at: directory.updated_at,
    });

    it("falls back to proxy.public_url when no loopback url is configured", async () => {
      const { env, directory } = await seedListenerEnv();
      await setConfig(env.DB, "proxy.public_url", NATIVE_URL);
      fake = installFakeUpstreams();
      fake.route("native", "GET", "/status/directories/", () =>
        Response.json(statusBody(directory)),
      );

      const status = await fetchDirectoryStatus(env.DB, directory);

      expect(status?.mode).toBe("workos-only");
      expect(fake.callsTo("native")).toHaveLength(1);
    });

    it("prefers the loopback url over the public url", async () => {
      const { env, directory } = await seedListenerEnv();
      await setConfig(env.DB, "proxy.loopback_url", NATIVE_URL);
      // The public URL points somewhere the fake would reject loudly.
      await setConfig(env.DB, "proxy.public_url", "https://unreachable.example");
      fake = installFakeUpstreams();
      fake.route("native", "GET", "/status/directories/", () =>
        Response.json(statusBody(directory)),
      );

      const status = await fetchDirectoryStatus(env.DB, directory);

      expect(status?.mode).toBe("workos-only");
      expect(fake.callsTo("native")).toHaveLength(1);
    });
  });

  describe("group key fallbacks", () => {
    it("falls back to idp_id as the group key when raw_attributes carries no externalId", async () => {
      const { env } = await seedListenerEnv();

      await deliver(env, envelope("dsync.group.created", { idp_id: "design-key", name: "Design" }));

      expect(await nativeGroups(env.DB)).toEqual([
        expect.objectContaining({
          id: "design-key",
          display_name: "Design",
          external_id: "design-key",
        }),
      ]);
      expect((await lastEvent(env.DB)).detail).toBe('group "Design" created');
    });

    it("falls back to the group name as key when idp_id is also missing", async () => {
      const { env } = await seedListenerEnv();

      await deliver(env, envelope("dsync.group.created", { name: "Solo" }));

      expect(await nativeGroups(env.DB)).toEqual([
        expect.objectContaining({ id: "Solo", display_name: "Solo", external_id: "Solo" }),
      ]);
    });

    it("ignores a keyed group create that carries no name", async () => {
      const { env } = await seedListenerEnv();

      await deliver(
        env,
        envelope("dsync.group.created", { raw_attributes: { externalId: "grp-x" } }),
      );

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("ignored");
      expect(event.detail).toBe("group event carries no name");
      expect(event.idp_id).toBe("grp-x");
      expect(await nativeGroups(env.DB)).toHaveLength(0);
    });
  });

  describe("membership edge cases", () => {
    const grace = { idp_id: "idp-user-9", email: "grace@example.com", state: "active" };

    it("ignores a membership event missing its user or group", async () => {
      const { env } = await seedListenerEnv();

      await deliver(env, envelope("dsync.group.user_added", { user: grace }));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("ignored");
      expect(event.detail).toBe("membership event carries no user or group");
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });

    it("skips a removal whose group is absent even when the user exists", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", grace, { at: T1 }));

      await deliver(
        env,
        envelope("dsync.group.user_removed", { user: grace, group: engineering }, { at: T2 }),
      );

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe("no-op: group not present");
    });

    it("does not resurrect a deleted group via a stale membership event", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", grace, { at: T1 }));
      await deliver(env, envelope("dsync.group.created", engineering, { at: T1 }));
      await deliver(env, envelope("dsync.group.deleted", engineering, { at: T3 }));

      await deliver(
        env,
        envelope("dsync.group.user_added", { user: grace, group: engineering }, { at: T2 }),
      );

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("skipped");
      expect(event.detail).toBe(
        'no-op: group "Engineering" was removed by a newer event; not resurrecting',
      );
      expect(await nativeGroups(env.DB)).toHaveLength(0);
      expect(await memberEdges(env.DB)).toHaveLength(0);
    });

    it("creates a single group stub when only the group is missing", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", grace, { at: T1 }));

      await deliver(
        env,
        envelope("dsync.group.user_added", { user: grace, group: engineering }, { at: T2 }),
      );

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      // Singular note, and no onboard() since the user already existed.
      expect(event.detail).toBe('added grace@example.com to "Engineering" (1 stub row created)');
      expect(await memberEdges(env.DB)).toEqual([{ group_id: "grp-eng", user_id: "idp-user-9" }]);
    });

    it("keys stubs on the primary email when the user has no idp_id and lets a later create adopt them", async () => {
      const { env } = await seedListenerEnv();
      const eve = { emails: [{ value: "eve@example.com", primary: true }] };

      await deliver(
        env,
        envelope("dsync.group.user_added", { user: eve, group: engineering }, { at: T1 }),
      );

      const users = await nativeUsers(env.DB);
      expect(users).toHaveLength(1);
      expect(users[0].user_name).toBe("eve@example.com");
      expect(users[0].external_id).toBeNull();
      expect(users[0].active).toBe(1);
      const stubId = users[0].id;
      expect((await lastEvent(env.DB)).detail).toBe(
        'added eve@example.com to "Engineering" (2 stub rows created); onboard()',
      );
      // The ordering scope falls back to the primary email as the user key.
      const version = await env.DB.prepare("SELECT event_at FROM listener_versions WHERE scope = ?")
        .bind("member:grp-eng:eve@example.com")
        .first<{ event_at: string }>();
      expect(version?.event_at).toBe(T1);

      await deliver(
        env,
        envelope(
          "dsync.user.created",
          { idp_id: "idp-user-5", email: "eve@example.com", state: "active" },
          { at: T2 },
        ),
      );

      const adopted = await nativeUsers(env.DB);
      expect(adopted).toHaveLength(1);
      expect(adopted[0].id).toBe(stubId);
      expect(adopted[0].external_id).toBe("idp-user-5");
    });
  });

  describe("user update details", () => {
    it("onboards on reactivation", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));
      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, state: "suspended" }, { at: T2 }),
      );

      await deliver(env, envelope("dsync.user.updated", ada, { at: T3 }));

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe("onboard()");
      expect((await nativeUsers(env.DB))[0].active).toBe(1);
    });

    it("applies an attribute-only change as 'attributes updated' and follows the new primary email", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));

      await deliver(
        env,
        envelope(
          "dsync.user.updated",
          { ...ada, last_name: "King", email: "ada.king@example.com" },
          { at: T2 },
        ),
      );

      const event = await lastEvent(env.DB);
      expect(event.action).toBe("applied");
      expect(event.detail).toBe("attributes updated");
      const users = await nativeUsers(env.DB);
      expect(users[0].user_name).toBe("ada.king@example.com");
      const resource = JSON.parse(users[0].resource);
      expect(resource.name).toMatchObject({ givenName: "Ada", familyName: "King" });
      expect(resource.emails).toEqual([{ value: "ada.king@example.com", primary: true }]);
      expect(resource.userName).toBe("ada.king@example.com");
    });

    it("keeps upserting by idp_id once the email change breaks the userName match", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));

      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, email: "ada.king@example.com" }, { at: T2 }),
      );
      // Second change: the stored user_name is now the T2 address, so the
      // userByUserName fallback cannot match either address — only the
      // external_id lookup keeps this a single row.
      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, email: "ada.byron@example.com" }, { at: T3 }),
      );

      const users = await nativeUsers(env.DB);
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe("idp-user-1");
      expect(users[0].user_name).toBe("ada.byron@example.com");
      expect(JSON.parse(users[0].resource).emails).toEqual([
        { value: "ada.byron@example.com", primary: true },
      ]);
    });

    it("replaces the primary email but keeps the secondaries and their labels", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));
      const seeded = (await nativeUsers(env.DB))[0];
      const resource = JSON.parse(seeded.resource);
      resource.emails = [
        { value: "ada@example.com", primary: true, type: "work" },
        { value: "ada@home.example.com", type: "home" },
      ];
      await env.DB.prepare("UPDATE native_users SET resource = ? WHERE id = ?")
        .bind(JSON.stringify(resource), seeded.id)
        .run();

      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, email: "ada.king@example.com" }, { at: T2 }),
      );

      expect(JSON.parse((await nativeUsers(env.DB))[0].resource).emails).toEqual([
        { value: "ada.king@example.com", primary: true, type: "work" },
        { value: "ada@home.example.com", type: "home" },
      ]);
    });

    it("keeps a promoted secondary's own labels", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));
      const seeded = (await nativeUsers(env.DB))[0];
      const resource = JSON.parse(seeded.resource);
      resource.emails = [
        { value: "ada@example.com", primary: true, type: "work" },
        { value: "ada@home.example.com", type: "home" },
      ];
      await env.DB.prepare("UPDATE native_users SET resource = ? WHERE id = ?")
        .bind(JSON.stringify(resource), seeded.id)
        .run();

      await deliver(
        env,
        envelope("dsync.user.updated", { ...ada, email: "ada@home.example.com" }, { at: T2 }),
      );

      expect(JSON.parse((await nativeUsers(env.DB))[0].resource).emails).toEqual([
        { value: "ada@home.example.com", primary: true, type: "home" },
      ]);
    });

    it("mirrors an emails array the event carries", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));

      await deliver(
        env,
        envelope(
          "dsync.user.updated",
          {
            ...ada,
            emails: [
              { value: "ada@home.example.com" },
              { value: "ada.king@example.com", primary: true },
            ],
          },
          { at: T2 },
        ),
      );

      const users = await nativeUsers(env.DB);
      expect(users[0].user_name).toBe("ada.king@example.com");
      expect(JSON.parse(users[0].resource).emails).toEqual([
        { value: "ada@home.example.com" },
        { value: "ada.king@example.com", primary: true },
      ]);
    });

    it("leaves the stored emails alone for an event carrying no address", async () => {
      const { env } = await seedListenerEnv();
      await deliver(env, envelope("dsync.user.created", ada, { at: T1 }));

      // A membership event's user object is partial: idp_id and username only.
      await deliver(
        env,
        envelope(
          "dsync.group.user_added",
          { user: { idp_id: "idp-user-1", username: "ada@example.com" }, group: engineering },
          { at: T2 },
        ),
      );

      const users = await nativeUsers(env.DB);
      expect(users).toHaveLength(1);
      expect(JSON.parse(users[0].resource).emails).toEqual([
        { value: "ada@example.com", primary: true },
      ]);
    });
  });

  describe("payload persistence", () => {
    it("truncates oversized payloads in the event log", async () => {
      const { env } = await seedListenerEnv();
      const raw = "x".repeat(9001);

      await deliver(env, raw);

      const event = await lastEvent(env.DB);
      expect(event.payload).toHaveLength(8192 + "… [truncated]".length);
      expect(event.payload!.startsWith("x".repeat(8192))).toBe(true);
      expect(event.payload!.endsWith("… [truncated]")).toBe(true);
    });
  });

  describe("ignored payloads", () => {
    it("logs a non-envelope payload as ignored and still acknowledges it", async () => {
      const { env } = await seedListenerEnv();

      const res = await deliver(env, "not json");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      const event = await lastEvent(env.DB);
      expect(event).toMatchObject({
        event_type: "unknown",
        action: "ignored",
        detail: "payload is not a WorkOS webhook envelope",
        payload: "not json",
      });
    });

    it("ignores lifecycle and unhandled event types with their documented details", async () => {
      const { env } = await seedListenerEnv();
      const cases: [string, string][] = [
        ["dsync.activated", "directory activated; informational, no per-user work"],
        ["dsync.deleted", "directory deleted; flagged for review, users retained"],
        ["dsync.token.generated", "sync credential lifecycle; not directory data"],
        ["dsync.something.new", "no handler for event type dsync.something.new"],
      ];

      for (const [type, detail] of cases) {
        await deliver(env, envelope(type, {}));
        const event = await lastEvent(env.DB);
        expect(event.action).toBe("ignored");
        expect(event.detail).toBe(detail);
      }
      expect(await nativeUsers(env.DB)).toHaveLength(0);
    });
  });
});
