import type { Directory, WorkerHandler } from "../shared/types";
import { getDirectoryById, withDatastoreRetry } from "../shared/db";
import { demoDirectoryId } from "../shared/client-tokens";
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

/**
 * Read a POST body as JSON *or* as a form encoding (ENT-6756).
 *
 * The panel always sends JSON (`callIdpSimulator`), which is why this went
 * unnoticed: the only caller that could hit it is a human or a script driving the
 * simulator directly, and that is exactly what DEMO_MODE invites. `curl -d …`
 * defaults to `application/x-www-form-urlencoded`, so the JSON parse threw, the
 * catch returned `{}`, and a perfectly valid `directoryId` was reported as
 * "Unknown or missing" — the reported bug.
 *
 * Content type decides, with a fallback rather than a rejection, because a hand
 * written request is as likely to carry the wrong content type as none at all.
 */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") ?? "";

  // multipart needs the boundary from the header, so it has to go through
  // `formData()`; everything else is parsed from the raw text, which keeps the body
  // to a single read and avoids cloning the request.
  if (/^multipart\/form-data/i.test(contentType)) {
    try {
      const form = await request.formData();
      return Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
    } catch {
      return {};
    }
  }

  const raw = await request.text();
  if (!raw) return {};
  if (/^application\/(json|.*\+json)/i.test(contentType)) return parseJson(raw) ?? {};
  if (/^application\/x-www-form-urlencoded/i.test(contentType)) return parseForm(raw) ?? {};
  // No usable content type: try both rather than guess which one was meant.
  return parseJson(raw) ?? parseForm(raw) ?? {};
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `a=1&b=2` → `{a: "1", b: "2"}`. Null when nothing parsed out, so a caller can
 *  fall through to another encoding: `URLSearchParams` accepts any string and would
 *  otherwise turn a JSON body into one nonsense key. */
function parseForm(raw: string): Record<string, unknown> | null {
  const params = new URLSearchParams(raw);
  const fields = Object.fromEntries(params.entries());
  return Object.keys(fields).length > 0 ? fields : null;
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
    // Trimmed: an id pasted from a terminal or a panel URL arrives with whitespace
    // often enough that rejecting it teaches nothing.
    const directoryId = (
      str(body, "directoryId") ||
      url.searchParams.get("directoryId") ||
      ""
    ).trim();
    // The simulator drives exactly one directory: the bundled demo one, seeded
    // against the in-process fakes. It is mounted without panel credentials, so a
    // caller-supplied id may never be resolved against the rest of the table — an
    // operator's imported directory holds real upstream credentials and real
    // users, and provisioning one from here would be an unauthenticated write to
    // their production identity systems (VULN-3076).
    const demoId = await demoDirectoryId(env.DB);
    const directory =
      directoryId && directoryId === demoId ? await getDirectoryById(env.DB, directoryId) : null;
    if (!directory) {
      // Two different mistakes, two different messages. The old single string said
      // "Unknown or missing" for both, so a valid id that failed to parse out of the
      // body looked like an id the database had never heard of (ENT-6756).
      if (!directoryId) {
        return json(
          {
            error:
              'No directoryId in this request. Send it as JSON (`{"directoryId":"dir_…"}`), ' +
              "as a form field, or as a ?directoryId= query parameter.",
          },
          400,
        );
      }
      // Only ever the demo directory. Listing what the caller may drive still turns
      // a dead end into the next step, without telling an anonymous caller which
      // directories this bridge migrates for real.
      const demo = demoId ? await getDirectoryById(env.DB, demoId) : null;
      return json(
        {
          error: `The IdP simulator only drives the bundled demo directory, not ${directoryId}.`,
          known: demo ? [{ id: demo.id, name: demo.name }] : [],
        },
        400,
      );
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
