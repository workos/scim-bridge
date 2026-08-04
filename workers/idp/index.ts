import type { Directory, WorkerHandler } from "../shared/types";
import { getDirectoryById, withDatastoreRetry } from "../shared/db";
import * as client from "./client";
import type { ActionContext } from "./client";
import { seedDirectory } from "./auto";
import { idpScheduler } from "./scheduler";
import * as store from "./store";
import type { IdpEnv } from "./types";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? (body[key] as string) : "";
}

const handler: WorkerHandler<IdpEnv> = {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};

export default handler;

async function route(request: Request, env: IdpEnv): Promise<Response> {
  {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/" && request.method === "GET") {
      return json({ service: "scim-idp-simulator" });
    }

    const body = request.method === "POST" ? await readBody(request) : {};
    const directoryId = str(body, "directoryId") || (url.searchParams.get("directoryId") ?? "");
    const directory = directoryId ? await getDirectoryById(env.DB, directoryId) : null;
    if (!directory) {
      return json({ error: "Unknown or missing directoryId." }, 400);
    }

    if (url.pathname === "/state") {
      const [users, groups, members, activity, auto] = await Promise.all([
        store.listUsers(env.DB, directory.id),
        store.listGroups(env.DB, directory.id),
        store.listMembers(env.DB, directory.id),
        store.activity(env.DB, directory.id),
        store.getAutoState(env.DB, directory.id),
      ]);
      return json({ users, groups, members, activity, auto });
    }

    if (request.method !== "POST") {
      return json({ error: `${request.method} not supported on ${url.pathname}.` }, 405);
    }

    if (url.pathname === "/seed") {
      const summary = await seedDirectory(env, directory as Directory);
      return json({ ok: true, ...summary });
    }

    if (url.pathname === "/reset") {
      await idpScheduler.stop(env, directory.id);
      await withDatastoreRetry(() =>
        env.DB.batch([
          env.DB.prepare(
            "DELETE FROM idp_group_members WHERE group_id IN (SELECT id FROM idp_groups WHERE directory_id = ?)",
          ).bind(directory.id),
          env.DB.prepare("DELETE FROM idp_groups WHERE directory_id = ?").bind(directory.id),
          env.DB.prepare("DELETE FROM idp_users WHERE directory_id = ?").bind(directory.id),
          env.DB.prepare("DELETE FROM idp_activity WHERE directory_id = ?").bind(directory.id),
        ]),
      );
      return json({ ok: true });
    }

    if (url.pathname === "/auto/start") {
      const interval = Number(body.intervalMs) || 4000;
      await idpScheduler.start(env, directory.id, interval);
      return json({ ok: true, running: true, intervalMs: interval });
    }

    if (url.pathname === "/auto/stop") {
      await idpScheduler.stop(env, directory.id);
      return json({ ok: true, running: false });
    }

    if (url.pathname === "/action") {
      return handleAction(env, directory as Directory, body);
    }

    return json({ error: `No route for ${url.pathname}.` }, 404);
  }
}

async function handleAction(
  env: IdpEnv,
  directory: Directory,
  body: Record<string, unknown>,
): Promise<Response> {
  const ctx: ActionContext = { env, directory, origin: "manual" };
  const action = str(body, "action");

  switch (action) {
    case "create-user": {
      const userName = str(body, "userName");
      if (!userName) return json({ error: "A user name (email) is required." }, 400);
      if (await store.userByUserName(env.DB, directory.id, userName)) {
        return json(
          { error: `A user named "${userName}" already exists in the simulated directory.` },
          409,
        );
      }
      const givenName = str(body, "givenName") || userName.split("@")[0];
      const familyName = str(body, "familyName") || "User";
      const externalId = str(body, "externalId") || `okta-${slug(userName.split("@")[0])}`;
      const user = await client.createUser(ctx, { userName, externalId, givenName, familyName });
      return json({ ok: true, user });
    }
    case "deactivate-user":
      await client.setActive(ctx, str(body, "userId"), false);
      return json({ ok: true });
    case "reactivate-user":
      await client.setActive(ctx, str(body, "userId"), true);
      return json({ ok: true });
    case "delete-user":
      await client.removeUser(ctx, str(body, "userId"));
      return json({ ok: true });
    case "rename-user":
      await client.renameUser(
        ctx,
        str(body, "userId"),
        str(body, "givenName"),
        str(body, "familyName"),
      );
      return json({ ok: true });
    case "create-group": {
      const displayName = str(body, "displayName");
      if (!displayName) return json({ error: "A group name is required." }, 400);
      if (await store.groupByDisplayName(env.DB, directory.id, displayName)) {
        return json(
          { error: `A group named "${displayName}" already exists in the simulated directory.` },
          409,
        );
      }
      const externalId = str(body, "externalId") || `okta-grp-${slug(displayName)}`;
      const group = await client.createGroup(ctx, { displayName, externalId });
      return json({ ok: true, group });
    }
    case "rename-group":
      await client.renameGroup(ctx, str(body, "groupId"), str(body, "displayName"));
      return json({ ok: true });
    case "delete-group":
      await client.removeGroup(ctx, str(body, "groupId"));
      return json({ ok: true });
    case "add-member":
      await client.addMember(ctx, str(body, "groupId"), str(body, "userId"));
      return json({ ok: true });
    case "remove-member":
      await client.removeMember(ctx, str(body, "groupId"), str(body, "userId"));
      return json({ ok: true });
    default:
      return json({ error: `Unknown action "${action}".` }, 400);
  }
}
