import { describe, expect, it } from "vitest";
import { handleDsyncWebhook } from "../workers/native/listener";
import type { PocEnv } from "../workers/shared/types";
import { NATIVE_TABLES, ScimStore } from "../workers/native/store";
import { createEnv, seedDirectory } from "./helpers";

/**
 * One native-app stand-in serving several directories keeps their rows in one
 * set of tables. These cases hold two organizations to their own rows and their
 * own ordering timelines, even when their IdPs pick colliding identities.
 */

const T1 = "2026-07-31T10:00:00.000Z";
const T2 = "2026-07-31T11:00:00.000Z";
const T3 = "2026-07-31T12:00:00.000Z";

let seq = 0;
function envelope(event: string, data: unknown, at: string) {
  return { id: `event_scope_${(seq += 1)}`, event, created_at: at, data };
}

async function deliver(env: PocEnv, body: unknown): Promise<Response> {
  const request = new Request("https://native.test/webhooks/dsync", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return handleDsyncWebhook(request, env.DB);
}

/** Directories linked to WorkOS ids, with the status endpoint unconfigured so
 *  each falls back to its own row's mode. */
async function seedEnv(workosIds: string[]): Promise<PocEnv> {
  const env = await createEnv();
  await env.DB.prepare(
    "DELETE FROM poc_config WHERE key IN ('proxy.public_url', 'proxy.loopback_url')",
  ).run();
  for (const id of workosIds) {
    await seedDirectory(env.DB, { mode: "workos-only", name: id, workos_directory_id: id });
  }
  return env;
}

async function lastDetail(env: PocEnv): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT detail FROM listener_events ORDER BY id DESC LIMIT 1",
  ).first<{ detail: string }>();
  return row?.detail ?? "";
}

const victim = (directoryId: string, state: string) => ({
  directory_id: directoryId,
  idp_id: "shared-K",
  email: "victim@b.example",
  state,
});

describe("listener ordering keys are bound to the event's directory", () => {
  it("does not let an event for an unconfigured directory supersede another directory's offboarding", async () => {
    const env = await seedEnv(["directory_b"]);
    await deliver(env, envelope("dsync.user.created", victim("directory_b", "active"), T1));

    const foreign = { directory_id: "directory_a", idp_id: "shared-K", email: "m@a.example" };
    await deliver(env, envelope("dsync.user.updated", { ...foreign, state: "active" }, T3));
    await deliver(env, envelope("dsync.user.deleted", victim("directory_b", "inactive"), T2));

    const user = await env.DB.prepare("SELECT active FROM native_users WHERE external_id = ?")
      .bind("shared-K")
      .first<{ active: number }>();
    expect(user?.active).toBe(0);
    const unscoped = await env.DB.prepare("SELECT 1 FROM listener_versions WHERE scope = ?")
      .bind("user:shared-K")
      .first();
    expect(unscoped).toBeNull();
  });

  it("does not let another configured directory's newer event supersede an offboarding", async () => {
    const env = await seedEnv(["directory_a", "directory_b"]);
    await deliver(env, envelope("dsync.user.created", victim("directory_b", "active"), T1));

    const foreign = { directory_id: "directory_a", idp_id: "shared-K", email: "m@a.example" };
    await deliver(env, envelope("dsync.user.updated", { ...foreign, state: "active" }, T3));
    await deliver(env, envelope("dsync.user.deleted", victim("directory_b", "inactive"), T2));

    expect(await lastDetail(env)).not.toMatch(/superseded/);
    const victimRow = await env.DB.prepare("SELECT active FROM native_users WHERE user_name = ?")
      .bind("victim@b.example")
      .first<{ active: number }>();
    expect(victimRow?.active).toBe(0);
  });

  it("still drops a stale event against a version an older listener recorded unscoped", async () => {
    const env = await seedEnv(["directory_b"]);
    await env.DB.prepare("INSERT INTO listener_versions (scope, event_at) VALUES (?, ?)")
      .bind("user:shared-K", T3)
      .run();

    await deliver(env, envelope("dsync.user.created", victim("directory_b", "active"), T2));

    expect(await lastDetail(env)).toBe("superseded by a newer event (out-of-order delivery)");
  });
});

describe("listener attribute fallbacks stay inside the event's directory", () => {
  const admins = (directoryId: string, externalId: string) => ({
    directory_id: directoryId,
    name: "Admins",
    raw_attributes: { externalId },
  });

  it("does not rebind or join another directory's group that shares a display name", async () => {
    const env = await seedEnv(["directory_a", "directory_b"]);
    await deliver(env, envelope("dsync.group.created", admins("directory_b", "grp-b"), T1));
    const victimGroup = await env.DB.prepare(
      "SELECT id FROM native_groups WHERE external_id = 'grp-b'",
    ).first<{ id: string }>();

    await deliver(env, envelope("dsync.group.created", admins("directory_a", "grp-a"), T2));
    const mallory = {
      idp_id: "mallory",
      email: "mallory@a.example",
      state: "active",
    };
    await deliver(
      env,
      envelope(
        "dsync.group.user_added",
        { directory_id: "directory_a", user: mallory, group: admins("directory_a", "grp-a") },
        T3,
      ),
    );

    const victimNow = await env.DB.prepare(
      "SELECT external_id, directory_id FROM native_groups WHERE id = ?",
    )
      .bind(victimGroup!.id)
      .first<{ external_id: string; directory_id: string }>();
    expect(victimNow?.external_id).toBe("grp-b");
    const { results: victimMembers } = await env.DB.prepare(
      "SELECT user_id FROM native_group_members WHERE group_id = ?",
    )
      .bind(victimGroup!.id)
      .all();
    expect(victimMembers).toHaveLength(0);

    const { results: groups } = await env.DB.prepare(
      "SELECT external_id, directory_id FROM native_groups ORDER BY external_id",
    ).all<{ external_id: string; directory_id: string }>();
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ external_id: "grp-a" });
    expect(groups[1]).toMatchObject({ external_id: "grp-b" });
    expect(groups[0].directory_id).not.toBe(groups[1].directory_id);
  });

  it("does not adopt another directory's user by a shared externalId", async () => {
    const env = await seedEnv(["directory_a", "directory_b"]);
    await deliver(env, envelope("dsync.user.created", victim("directory_b", "active"), T1));

    const foreign = { directory_id: "directory_a", idp_id: "shared-K", email: "m@a.example" };
    await deliver(env, envelope("dsync.user.updated", { ...foreign, state: "inactive" }, T2));

    const victimRow = await env.DB.prepare(
      "SELECT active, user_name FROM native_users WHERE user_name = ?",
    )
      .bind("victim@b.example")
      .first<{ active: number; user_name: string }>();
    expect(victimRow?.active).toBe(1);
  });
});

describe("listener directory ownership is claimed and enforced in the write", () => {
  const unclaim = (env: PocEnv) =>
    env.DB.prepare("UPDATE native_users SET directory_id = NULL").run();
  const owner = async (env: PocEnv) =>
    (
      await env.DB.prepare("SELECT directory_id FROM native_users WHERE external_id = ?")
        .bind("shared-K")
        .first<{ directory_id: string | null }>()
    )?.directory_id;

  it("claims a pre-ownership row on an unchanged event, so a later second directory cannot hide it", async () => {
    const env = await seedEnv(["directory_b"]);
    await deliver(env, envelope("dsync.user.created", victim("directory_b", "active"), T1));
    await unclaim(env);

    await deliver(env, envelope("dsync.user.updated", victim("directory_b", "active"), T2));
    expect(await lastDetail(env)).toBe("no transition");
    expect(await owner(env)).not.toBeNull();

    await seedDirectory(env.DB, {
      mode: "workos-only",
      name: "directory_a",
      workos_directory_id: "directory_a",
    });
    await deliver(env, envelope("dsync.user.deleted", victim("directory_b", "inactive"), T3));
    const row = await env.DB.prepare("SELECT active FROM native_users WHERE external_id = ?")
      .bind("shared-K")
      .first<{ active: number }>();
    expect(row?.active).toBe(0);
  });

  it("claims a pre-ownership row it deactivates", async () => {
    const env = await seedEnv(["directory_b"]);
    await deliver(env, envelope("dsync.user.created", victim("directory_b", "active"), T1));
    await unclaim(env);

    await deliver(env, envelope("dsync.user.deleted", victim("directory_b", "inactive"), T2));
    expect(await owner(env)).not.toBeNull();
  });

  it("refuses an owned write to a row another directory owns", async () => {
    const env = await createEnv();
    const store = new ScimStore(env.DB, NATIVE_TABLES);
    const user = (directoryId: string, userName: string) => ({
      id: "shared-K",
      userName,
      externalId: "shared-K",
      active: true,
      resource: {},
      directoryId,
    });

    expect(await store.upsertUser(user("dir-b", "victim@b.example"))).toBe(true);
    expect(await store.upsertUser(user("dir-a", "mallory@a.example"))).toBe(false);
    expect(await store.upsertUser(user("dir-b", "victim2@b.example"))).toBe(true);

    const row = await env.DB.prepare(
      "SELECT user_name, directory_id FROM native_users WHERE id = 'shared-K'",
    ).first<{ user_name: string; directory_id: string }>();
    expect(row).toEqual({ user_name: "victim2@b.example", directory_id: "dir-b" });
  });

  it("keeps two directories' rows apart when their creates race for one IdP id", async () => {
    const env = await seedEnv(["directory_a", "directory_b"]);
    const foreign = { directory_id: "directory_a", idp_id: "shared-K", email: "m@a.example" };
    await Promise.all([
      deliver(env, envelope("dsync.user.created", victim("directory_b", "active"), T1)),
      deliver(env, envelope("dsync.user.created", { ...foreign, state: "active" }, T1)),
    ]);

    const { results } = await env.DB.prepare(
      "SELECT user_name, directory_id FROM native_users ORDER BY user_name",
    ).all<{ user_name: string; directory_id: string }>();
    expect(results.map((r) => r.user_name)).toEqual(["m@a.example", "victim@b.example"]);
    expect(results[0].directory_id).not.toBe(results[1].directory_id);
  });
});
