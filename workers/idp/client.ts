import type { Datastore } from "../shared/datastore";
import type { Directory } from "../shared/types";
import { getConfig } from "../shared/db";
import { clientTokenFor } from "../shared/client-tokens";
import * as store from "./store";
import type { IdpEnv, IdpGroup, IdpUser, Origin } from "./types";

const SCIM_CONTENT_TYPE = "application/scim+json";

interface ScimResult {
  status: number;
  ok: boolean;
  body: Record<string, unknown> | null;
  bodyText: string;
}

/** Where the simulated IdP points — the proxy's inbound SCIM endpoint, keyed
 *  by the directory's proxy token, exactly as a real Okta directory would. */
async function scimBase(db: Datastore): Promise<string> {
  const url = (await getConfig(db, "proxy.public_url")) ?? "http://localhost:8787";
  return `${url.replace(/\/+$/, "")}/scim/v2`;
}

async function send(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ScimResult> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("Content-Type", SCIM_CONTENT_TYPE);
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const bodyText = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const json: unknown = JSON.parse(bodyText);
    parsed = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, body: parsed, bodyText };
}

function userResource(user: IdpUser): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: user.user_name,
    externalId: user.external_id,
    name: { givenName: user.given_name ?? "", familyName: user.family_name ?? "" },
    emails: [{ primary: true, value: user.user_name, type: "work" }],
    active: user.active === 1,
  };
}

function groupResource(group: IdpGroup, members: { value: string }[]): Record<string, unknown> {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName: group.display_name,
    externalId: group.external_id,
    members,
  };
}

/**
 * The bearer token this simulated IdP presents to the proxy.
 *
 * Read from the simulator's own credential store, not from the directory row: the
 * row holds only a digest. A missing token means nobody ever told the
 * simulator about this directory (a row created before this store existed, or by
 * hand), and failing loudly beats sending an empty Authorization header and
 * reporting a 401 as if the proxy had rejected a real credential.
 */
async function bearer(ctx: ActionContext): Promise<string> {
  const token = await clientTokenFor(ctx.env.DB, ctx.directory.id);
  if (!token) {
    throw new Error(
      `The IdP simulator has no proxy token for directory ${ctx.directory.id}. ` +
        "Rotate the token on the directory page to give it one.",
    );
  }
  return token;
}

export interface ActionContext {
  env: IdpEnv;
  directory: Directory;
  origin: Origin;
}

async function record(
  ctx: ActionContext,
  action: string,
  subject: string,
  method: string,
  path: string,
  result: ScimResult,
): Promise<void> {
  await store.logActivity(ctx.env.DB, {
    directory_id: ctx.directory.id,
    origin: ctx.origin,
    action,
    subject,
    method,
    path,
    status: result.status,
    ok: result.ok,
    detail: result.ok ? null : ((result.body?.detail as string) ?? result.bodyText.slice(0, 300)),
  });
}

/** Provision a brand-new user: create locally, POST /Users through the proxy,
 *  and store the id the target minted so later verbs address the same row. */
export async function createUser(
  ctx: ActionContext,
  input: { userName: string; externalId: string; givenName: string; familyName: string },
): Promise<IdpUser> {
  const { db } = { db: ctx.env.DB };
  const user = await store.insertUser(db, {
    directory_id: ctx.directory.id,
    user_name: input.userName,
    external_id: input.externalId,
    given_name: input.givenName,
    family_name: input.familyName,
    active: 1,
  });
  const base = await scimBase(db);
  const result = await send(base, await bearer(ctx), "POST", "/Users", userResource(user));
  const scimId = typeof result.body?.id === "string" ? result.body.id : null;
  await store.setUserScimId(db, user.id, scimId, result.status);
  await record(ctx, "create user", user.user_name, "POST", "/Users", result);
  return { ...user, scim_id: scimId, last_status: result.status };
}

export async function setActive(
  ctx: ActionContext,
  userId: string,
  active: boolean,
): Promise<void> {
  const db = ctx.env.DB;
  const user = await store.getUser(db, userId);
  if (!user || !user.scim_id) return;
  const patch = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", value: { active } }],
  };
  const path = `/Users/${encodeURIComponent(user.scim_id)}`;
  const result = await send(await scimBase(db), await bearer(ctx), "PATCH", path, patch);
  await store.setUserActive(db, userId, active ? 1 : 0, result.status);
  await record(
    ctx,
    active ? "reactivate user" : "deactivate user",
    user.user_name,
    "PATCH",
    path,
    result,
  );
}

export async function renameUser(
  ctx: ActionContext,
  userId: string,
  givenName: string,
  familyName: string,
): Promise<void> {
  const db = ctx.env.DB;
  const user = await store.getUser(db, userId);
  if (!user || !user.scim_id) return;
  const patch = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [
      { op: "replace", path: "name.givenName", value: givenName },
      { op: "replace", path: "name.familyName", value: familyName },
    ],
  };
  const path = `/Users/${encodeURIComponent(user.scim_id)}`;
  const result = await send(await scimBase(db), await bearer(ctx), "PATCH", path, patch);
  await store.setUserName(db, userId, givenName, familyName, result.status);
  await record(ctx, "rename user", user.user_name, "PATCH", path, result);
}

export async function removeUser(ctx: ActionContext, userId: string): Promise<void> {
  const db = ctx.env.DB;
  const user = await store.getUser(db, userId);
  if (!user) return;
  if (user.scim_id) {
    const path = `/Users/${encodeURIComponent(user.scim_id)}`;
    const result = await send(await scimBase(db), await bearer(ctx), "DELETE", path);
    await record(ctx, "delete user", user.user_name, "DELETE", path, result);
  }
  await store.deleteUser(db, userId);
}

export async function createGroup(
  ctx: ActionContext,
  input: { displayName: string; externalId: string },
): Promise<IdpGroup> {
  const db = ctx.env.DB;
  const group = await store.insertGroup(db, {
    directory_id: ctx.directory.id,
    display_name: input.displayName,
    external_id: input.externalId,
  });
  const base = await scimBase(db);
  const result = await send(base, await bearer(ctx), "POST", "/Groups", groupResource(group, []));
  const scimId = typeof result.body?.id === "string" ? result.body.id : null;
  await store.setGroupScimId(db, group.id, scimId, result.status);
  await record(ctx, "create group", group.display_name, "POST", "/Groups", result);
  return { ...group, scim_id: scimId, last_status: result.status };
}

export async function renameGroup(
  ctx: ActionContext,
  groupId: string,
  displayName: string,
): Promise<void> {
  const db = ctx.env.DB;
  const group = await store.getGroup(db, groupId);
  if (!group || !group.scim_id) return;
  const patch = {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [{ op: "replace", path: "displayName", value: displayName }],
  };
  const path = `/Groups/${encodeURIComponent(group.scim_id)}`;
  const result = await send(await scimBase(db), await bearer(ctx), "PATCH", path, patch);
  await store.renameGroup(db, groupId, displayName, result.status);
  await record(ctx, "rename group", displayName, "PATCH", path, result);
}

export async function removeGroup(ctx: ActionContext, groupId: string): Promise<void> {
  const db = ctx.env.DB;
  const group = await store.getGroup(db, groupId);
  if (!group) return;
  if (group.scim_id) {
    const path = `/Groups/${encodeURIComponent(group.scim_id)}`;
    const result = await send(await scimBase(db), await bearer(ctx), "DELETE", path);
    await record(ctx, "delete group", group.display_name, "DELETE", path, result);
  }
  await store.deleteGroup(db, groupId);
}

async function changeMembership(
  ctx: ActionContext,
  groupId: string,
  userId: string,
  op: "add" | "remove",
): Promise<void> {
  const db = ctx.env.DB;
  const group = await store.getGroup(db, groupId);
  const user = await store.getUser(db, userId);
  if (!group || !group.scim_id || !user || !user.scim_id) return;
  const path = `/Groups/${encodeURIComponent(group.scim_id)}`;
  const patch =
    op === "add"
      ? {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: user.scim_id }] }],
        }
      : {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "remove", path: `members[value eq "${user.scim_id}"]` }],
        };
  const result = await send(await scimBase(db), await bearer(ctx), "PATCH", path, patch);
  if (op === "add") await store.addMember(db, groupId, userId);
  else await store.removeMember(db, groupId, userId);
  await record(
    ctx,
    op === "add" ? "add member" : "remove member",
    `${user.user_name} → ${group.display_name}`,
    "PATCH",
    path,
    result,
  );
}

export function addMember(ctx: ActionContext, groupId: string, userId: string): Promise<void> {
  return changeMembership(ctx, groupId, userId, "add");
}

export function removeMember(ctx: ActionContext, groupId: string, userId: string): Promise<void> {
  return changeMembership(ctx, groupId, userId, "remove");
}
