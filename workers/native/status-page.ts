import type { ListenerEvent } from "../shared/types";
import { MOCK_WORKOS_TABLES, NATIVE_TABLES, ScimStore } from "./store";
import type { GroupRow, MemberRef, ScimTables, UserRow } from "./store";

interface DirectorySnapshot {
  users: UserRow[];
  groups: { row: GroupRow; members: MemberRef[] }[];
}

export async function renderStatusPage(db: D1Database): Promise<Response> {
  const native = await loadDirectory(db, NATIVE_TABLES);
  const mock = await loadDirectory(db, MOCK_WORKOS_TABLES);
  const events = await loadEvents(db);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Native app — SCIM migration demo</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 24px 64px;
    background: #0b0d12;
    color: #d6dae3;
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #8a93a6; margin: 0 0 12px; }
  h3 { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #6b7386; margin: 16px 0 6px; }
  .sub { color: #8a93a6; margin: 0 0 28px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 28px; }
  @media (max-width: 800px) { .cols { grid-template-columns: 1fr; } }
  .card { background: #12151c; border: 1px solid #232836; border-radius: 8px; padding: 18px 20px; }
  .row { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; border-bottom: 1px solid #1a1e28; }
  .row:last-child { border-bottom: 0; }
  .who { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .idp { color: #6b7386; font-size: 12px; }
  .spacer { flex: 1; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap; }
  .badge.active { color: #7fd8a4; border-color: #23503a; background: #10281c; }
  .badge.inactive { color: #98a1b3; border-color: #2c3242; background: #171b24; }
  .badge.applied { color: #7fd8a4; border-color: #23503a; background: #10281c; }
  .badge.skipped { color: #e5c274; border-color: #5a4a1e; background: #2a2211; }
  .badge.ignored { color: #98a1b3; border-color: #2c3242; background: #171b24; }
  .members { color: #8a93a6; font-size: 12px; }
  .empty { color: #545c6e; font-style: italic; padding: 4px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #6b7386; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; padding: 6px 10px 6px 0; border-bottom: 1px solid #232836; }
  td { padding: 6px 10px 6px 0; border-bottom: 1px solid #1a1e28; vertical-align: top; }
  td.ts { color: #6b7386; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.type, td.idpid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.detail { color: #b6bdcc; }
</style>
</head>
<body>
<main>
  <h1>Native app</h1>
  <p class="sub">The customer's directory, the mock WorkOS directory, and the DSync listener log.</p>
  <div class="cols">
    <section class="card">
      <h2>Native directory</h2>
      ${renderDirectory(native)}
    </section>
    <section class="card">
      <h2>Mock WorkOS directory</h2>
      ${renderDirectory(mock)}
    </section>
  </div>
  <section class="card">
    <h2>Listener events (last 50)</h2>
    ${renderEvents(events)}
  </section>
</main>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function loadDirectory(db: D1Database, tables: ScimTables): Promise<DirectorySnapshot> {
  const store = new ScimStore(db, tables);
  const { rows: users } = await store.listUsers(null, 0, 500);
  const { rows: groupRows } = await store.listGroups(null, 0, 500);
  const groups: DirectorySnapshot["groups"] = [];
  for (const row of groupRows) {
    groups.push({ row, members: await store.membersOf(row.id) });
  }
  return { users, groups };
}

async function loadEvents(db: D1Database): Promise<ListenerEvent[]> {
  const { results } = await db
    .prepare("SELECT * FROM listener_events ORDER BY id DESC LIMIT 50")
    .all<ListenerEvent>();
  return results;
}

function renderDirectory(snapshot: DirectorySnapshot): string {
  const users =
    snapshot.users.length === 0
      ? '<div class="empty">no users</div>'
      : snapshot.users
          .map(
            (user) => `<div class="row">
  <span class="who">${escapeHtml(user.user_name)}</span>
  ${user.external_id ? `<span class="idp">${escapeHtml(user.external_id)}</span>` : ""}
  <span class="spacer"></span>
  <span class="badge ${user.active === 1 ? "active" : "inactive"}">${user.active === 1 ? "active" : "inactive"}</span>
</div>`,
          )
          .join("\n");

  const groups =
    snapshot.groups.length === 0
      ? '<div class="empty">no groups</div>'
      : snapshot.groups
          .map(({ row, members }) => {
            const names = members
              .map((m) => m.display ?? m.value)
              .map(escapeHtml)
              .join(" · ");
            return `<div class="row">
  <span class="who">${escapeHtml(row.display_name)}</span>
  <span class="spacer"></span>
  <span class="members">${names || "no members"}</span>
</div>`;
          })
          .join("\n");

  return `<h3>Users</h3>\n${users}\n<h3>Groups</h3>\n${groups}`;
}

function renderEvents(events: ListenerEvent[]): string {
  if (events.length === 0) {
    return '<div class="empty">no events received yet</div>';
  }
  const rows = events
    .map(
      (event) => `<tr>
  <td class="ts">${escapeHtml(event.ts)}</td>
  <td class="type">${escapeHtml(event.event_type)}</td>
  <td class="idpid">${escapeHtml(event.idp_id ?? "—")}</td>
  <td><span class="badge ${event.action}">${event.action}</span></td>
  <td class="detail">${escapeHtml(event.detail ?? "")}</td>
</tr>`,
    )
    .join("\n");
  return `<table>
<thead><tr><th>Time</th><th>Event</th><th>idp_id</th><th>Action</th><th>Detail</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
