import type { Directory } from "../shared/types";
import * as client from "./client";
import type { ActionContext } from "./client";
import * as store from "./store";
import type { IdpEnv } from "./types";

const FIRST = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Eve",
  "Frank",
  "Grace",
  "Heidi",
  "Ivan",
  "Judy",
  "Mallory",
  "Niaj",
  "Olivia",
  "Peggy",
  "Rupert",
  "Sybil",
  "Trent",
  "Victor",
  "Walter",
  "Yara",
];
const LAST = [
  "Anderson",
  "Baker",
  "Clarke",
  "Diaz",
  "Evans",
  "Foster",
  "Garcia",
  "Hughes",
  "Ibarra",
  "Jensen",
  "Klein",
  "Lopez",
  "Meyer",
  "Novak",
  "Owens",
  "Patel",
  "Quinn",
  "Reed",
  "Silva",
  "Tanaka",
];
const TEAMS = ["Engineering", "Sales", "Support", "Design", "Finance", "Marketing", "Legal", "Ops"];

const DOMAIN = "acme.test";
const MAX_USERS = 14;
const MIN_USERS = 3;

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** One realistic IdP mutation, chosen with weights that keep the directory in
 *  a sane size band. Every branch drives a real SCIM call through the proxy. */
export async function performTick(ctx: ActionContext): Promise<string> {
  const users = await store.listUsers(ctx.env.DB, ctx.directory.id);
  const groups = await store.listGroups(ctx.env.DB, ctx.directory.id);
  const active = users.filter((u) => u.active === 1);
  const inactive = users.filter((u) => u.active === 0);

  const roll = Math.random();

  if (users.length < MIN_USERS || (users.length < MAX_USERS && roll < 0.3)) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const suffix = Math.floor(Math.random() * 900 + 100);
    const userName = `${slug(first)}.${slug(last)}${suffix}@${DOMAIN}`;
    await client.createUser(ctx, {
      userName,
      externalId: `okta-${slug(first)}${slug(last)}${suffix}`,
      givenName: first,
      familyName: last,
    });
    return `created ${userName}`;
  }

  if (groups.length === 0 || (groups.length < TEAMS.length && roll < 0.4)) {
    const remaining = TEAMS.filter((t) => !groups.some((g) => g.display_name === t));
    if (remaining.length > 0) {
      const name = pick(remaining);
      await client.createGroup(ctx, { displayName: name, externalId: `okta-grp-${slug(name)}` });
      return `created group ${name}`;
    }
  }

  if (roll < 0.55 && active.length > MIN_USERS) {
    const u = pick(active);
    await client.setActive(ctx, u.id, false);
    return `deactivated ${u.user_name}`;
  }

  if (roll < 0.65 && inactive.length > 0) {
    const u = pick(inactive);
    await client.setActive(ctx, u.id, true);
    return `reactivated ${u.user_name}`;
  }

  if (roll < 0.85 && groups.length > 0 && active.length > 0) {
    const g = pick(groups);
    const u = pick(active);
    const members = await store.memberIds(ctx.env.DB, g.id);
    if (members.includes(u.id)) {
      await client.removeMember(ctx, g.id, u.id);
      return `removed ${u.user_name} from ${g.display_name}`;
    }
    await client.addMember(ctx, g.id, u.id);
    return `added ${u.user_name} to ${g.display_name}`;
  }

  if (roll < 0.95 && active.length > 0) {
    const u = pick(active);
    await client.renameUser(ctx, u.id, pick(FIRST), u.family_name ?? pick(LAST));
    return `renamed ${u.user_name}`;
  }

  if (users.length > MIN_USERS) {
    const u = pick(users);
    await client.removeUser(ctx, u.id);
    return `deleted ${u.user_name}`;
  }

  // Fallback when every weighted branch was skipped (small directory): add one.
  const first = pick(FIRST);
  const last = pick(LAST);
  const suffix = Math.floor(Math.random() * 900 + 100);
  const userName = `${slug(first)}.${slug(last)}${suffix}@${DOMAIN}`;
  await client.createUser(ctx, {
    userName,
    externalId: `okta-${slug(first)}${slug(last)}${suffix}`,
    givenName: first,
    familyName: last,
  });
  return `created ${userName}`;
}

/** Seed a small starting directory: a handful of users and two groups with
 *  members, each provisioned through the proxy. Idempotent — seeding again
 *  reuses resources that already exist rather than colliding on them. */
export async function seedDirectory(
  env: IdpEnv,
  directory: Directory,
): Promise<{ users: number; groups: number }> {
  const ctx: ActionContext = { env, directory, origin: "seed" };
  const people = [
    ["Alice", "Anderson"],
    ["Bob", "Baker"],
    ["Carol", "Clarke"],
    ["Dave", "Diaz"],
    ["Eve", "Evans"],
  ];
  const created = [];
  for (const [first, last] of people) {
    const userName = `${slug(first)}.${slug(last)}@${DOMAIN}`;
    const existing = await store.userByUserName(env.DB, directory.id, userName);
    created.push(
      existing ??
        (await client.createUser(ctx, {
          userName,
          externalId: `okta-${slug(first)}${slug(last)}`,
          givenName: first,
          familyName: last,
        })),
    );
  }
  const eng =
    (await store.groupByDisplayName(env.DB, directory.id, "Engineering")) ??
    (await client.createGroup(ctx, {
      displayName: "Engineering",
      externalId: "okta-grp-engineering",
    }));
  const sales =
    (await store.groupByDisplayName(env.DB, directory.id, "Sales")) ??
    (await client.createGroup(ctx, { displayName: "Sales", externalId: "okta-grp-sales" }));
  await client.addMember(ctx, eng.id, created[0].id);
  await client.addMember(ctx, eng.id, created[1].id);
  await client.addMember(ctx, sales.id, created[2].id);
  return { users: created.length, groups: 2 };
}
