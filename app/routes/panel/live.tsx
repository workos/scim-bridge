import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation, useRevalidator } from "react-router";
import type { Directory, ListenerEvent, Mode } from "../../../workers/shared/types";
import { MODES } from "../../../workers/shared/types";
import {
  clearNativeDirectory,
  getDirectoryById,
  listDirectories,
  setDirectoryMode,
  withD1Retry,
} from "../../../workers/shared/db";
import { runBackfill } from "../../../workers/shared/backfill";
import { callIdpSimulator } from "./idp-simulator";
import { FieldLabel, trimTrailingSlash } from "./ui";
import * as AlertDialog from "../../vendor/design-system/components/alert-dialog";
import { Badge } from "../../vendor/design-system/components/badge";
import { Box } from "../../vendor/design-system/components/box";
import { Button } from "../../vendor/design-system/components/button";
import { Callout } from "../../vendor/design-system/components/callout";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import * as Dialog from "../../vendor/design-system/components/dialog";
import * as EmptyState from "../../vendor/design-system/components/empty-state";
import { Flex } from "../../vendor/design-system/components/flex";
import { Grid } from "../../vendor/design-system/components/grid";
import { Heading } from "../../vendor/design-system/components/heading";
import * as Select from "../../vendor/design-system/components/select";
import * as Table from "../../vendor/design-system/components/table";
import { Text } from "../../vendor/design-system/components/text";
import * as TextField from "../../vendor/design-system/components/text-field";

const DEFAULT_INTERVAL_MS = 4000;

const INTERVAL_OPTIONS = [
  { value: "1000", label: "Every 1 second" },
  { value: "2000", label: "Every 2 seconds" },
  { value: "4000", label: "Every 4 seconds" },
  { value: "8000", label: "Every 8 seconds" },
];

const ACTION_BADGE_COLORS = {
  applied: "green",
  skipped: "gray",
  ignored: "yellow",
} as const;

interface DirRow {
  name: string;
  active: number;
}
interface GroupRow {
  name: string;
  member_count: number;
}

const REFRESH_MS = 3000;

interface ScimResource {
  id?: string;
  userName?: string;
  displayName?: string;
  active?: boolean;
  members?: unknown[];
}

/** Read the WorkOS side live over SCIM, so this works whether the directory
 *  points at the local mock or a real WorkOS directory. */
async function fetchWorkosDirectory(
  url: string,
  token: string,
): Promise<{ reachable: boolean; users: DirRow[]; groups: GroupRow[] }> {
  if (!url || !token) return { reachable: false, users: [], groups: [] };
  const base = trimTrailingSlash(url);
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const [uRes, gRes] = await Promise.all([
      fetch(`${base}/Users?count=200`, { headers }),
      fetch(`${base}/Groups?count=200`, { headers }),
    ]);
    if (!uRes.ok || !gRes.ok) return { reachable: false, users: [], groups: [] };
    const uBody = (await uRes.json()) as { Resources?: ScimResource[] };
    const gBody = (await gRes.json()) as { Resources?: ScimResource[] };
    const users = (uBody.Resources ?? []).map((r) => ({
      name: r.userName ?? "",
      active: r.active === false ? 0 : 1,
    }));
    const groups = (gBody.Resources ?? []).map((r) => ({
      name: r.displayName ?? "",
      member_count: r.members?.length ?? 0,
    }));
    return { reachable: true, users, groups };
  } catch {
    return { reachable: false, users: [], groups: [] };
  }
}

/** Empty the WorkOS directory the directory points at, over SCIM — so it
 *  works for the local mock or a real directory. Groups first, then users. */
async function cleanWorkosDirectory(
  url: string,
  token: string,
): Promise<{ ok: boolean; deleted: number; failed: number }> {
  if (!url || !token) return { ok: false, deleted: 0, failed: 0 };
  const base = trimTrailingSlash(url);
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const [uRes, gRes] = await Promise.all([
      fetch(`${base}/Users?count=200`, { headers }),
      fetch(`${base}/Groups?count=200`, { headers }),
    ]);
    if (!uRes.ok || !gRes.ok) return { ok: false, deleted: 0, failed: 0 };
    const uBody = (await uRes.json()) as { Resources?: ScimResource[] };
    const gBody = (await gRes.json()) as { Resources?: ScimResource[] };
    const targets: [string, string][] = [
      ...(gBody.Resources ?? []).map((r) => ["Groups", r.id] as [string, string | undefined]),
      ...(uBody.Resources ?? []).map((r) => ["Users", r.id] as [string, string | undefined]),
    ].filter((t): t is [string, string] => typeof t[1] === "string");
    let deleted = 0;
    let failed = 0;
    for (const [kind, id] of targets) {
      const res = await fetch(`${base}/${kind}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      if (res.ok || res.status === 404) deleted += 1;
      else failed += 1;
    }
    return { ok: true, deleted, failed };
  } catch {
    return { ok: false, deleted: 0, failed: 0 };
  }
}

export async function loader({ context }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const directories = await listDirectories(env.DB);
  const directory = directories[0] ?? null;
  if (!directory) {
    return { directory: null } as const;
  }

  const [nativeU, idpU, nativeG, idpG, workos, auto, events] = await Promise.all([
    withD1Retry(() =>
      env.DB.prepare("SELECT user_name AS name, active FROM native_users").all<DirRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare("SELECT user_name AS name, active FROM idp_users WHERE directory_id = ?")
        .bind(directory.id)
        .all<DirRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT g.display_name AS name, COUNT(m.user_id) AS member_count " +
          "FROM native_groups g LEFT JOIN native_group_members m ON m.group_id = g.id GROUP BY g.id",
      ).all<GroupRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT g.display_name AS name, COUNT(m.user_id) AS member_count " +
          "FROM idp_groups g LEFT JOIN idp_group_members m ON m.group_id = g.id " +
          "WHERE g.directory_id = ? GROUP BY g.id",
      )
        .bind(directory.id)
        .all<GroupRow>(),
    ),
    fetchWorkosDirectory(directory.workos_url, directory.workos_token),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT running, interval_ms, tick_count FROM idp_auto_state WHERE directory_id = ?",
      )
        .bind(directory.id)
        .first<AutoStateRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT * FROM listener_events ORDER BY id DESC LIMIT 25",
      ).all<ListenerEvent>(),
    ),
  ]);

  return {
    directory: { id: directory.id, name: directory.name, mode: directory.mode },
    workosReachable: workos.reachable,
    workosConfigured: directory.workos_url !== "",
    workosIsMock: directory.workos_url.includes("/mock-workos/"),
    auto: auto ?? null,
    events: events.results,
    users: { native: nativeU.results, workos: workos.users, idp: idpU.results },
    groups: { native: nativeG.results, workos: workos.groups, idp: idpG.results },
  } as const;
}

interface AutoStateRow {
  running: number;
  interval_ms: number;
  tick_count: number;
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { env } = context.cloudflare;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "reset-native") {
    await clearNativeDirectory(env.DB);
    return {};
  }

  const directoryId = String(form.get("directoryId") ?? "");
  const directory = directoryId ? await getDirectoryById(env.DB, directoryId) : null;
  if (!directory) {
    return { error: "No directory exists yet — create one on the Directories tab first." };
  }

  // --- IdP simulator controls (forwarded to the simulator worker) ---
  if (intent === "idp-seed") {
    const r = await callIdpSimulator(env.DB, "seed", { directoryId: directory.id });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-reset") {
    const r = await callIdpSimulator(env.DB, "reset", { directoryId: directory.id });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-auto-start") {
    const intervalMs = Number(form.get("intervalMs")) || DEFAULT_INTERVAL_MS;
    const r = await callIdpSimulator(env.DB, "auto/start", {
      directoryId: directory.id,
      intervalMs,
    });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-auto-stop") {
    const r = await callIdpSimulator(env.DB, "auto/stop", { directoryId: directory.id });
    return r.ok ? {} : { error: r.error };
  }
  if (intent === "idp-action") {
    const body: Record<string, unknown> = {
      directoryId: directory.id,
      action: String(form.get("action") ?? ""),
    };
    for (const key of ["userName", "givenName", "familyName", "displayName"]) {
      const value = form.get(key);
      if (value != null) body[key] = String(value);
    }
    const r = await callIdpSimulator(env.DB, "action", body);
    return r.ok ? {} : { error: r.error };
  }

  if (intent === "set-mode") {
    const mode = String(form.get("mode") ?? "");
    if (!MODES.includes(mode as Mode)) {
      return { error: "That mode is not one of passthrough, dual-write, or workos-only." };
    }
    await setDirectoryMode(env.DB, directory.id, mode as Mode);
    return {};
  }

  if (intent === "run-backfill") {
    if (directory.mode !== "dualwrite-native-first") {
      return {
        error: "Backfill only runs in dual-write, so live writes keep flowing while it replays.",
      };
    }
    const backfill = await runBackfill(env.DB, directory as Directory);
    return { backfill };
  }

  if (intent === "clean-workos") {
    // Only SCIM DELETEs against the directory — never touches the directory's
    // WorkOS URL/token or the id mappings. The proxy self-heals a mapping whose
    // resource was deleted on the next mirror (see mirrorUpsert).
    const result = await cleanWorkosDirectory(directory.workos_url, directory.workos_token);
    if (!result.ok) {
      return { error: "The WorkOS endpoint didn't respond, so nothing was deleted." };
    }
    return {};
  }

  return { error: "That action is not recognized." };
}

// --- reconciliation -------------------------------------------------------

type Presence = "active" | "inactive" | "absent";

interface UserReconRow {
  name: string;
  native: Presence;
  workos: Presence;
  idp: Presence;
  diverged: boolean;
}

function presence(row: DirRow | undefined): Presence {
  if (!row) return "absent";
  return row.active === 1 ? "active" : "inactive";
}

function reconcileUsers(users: {
  native: DirRow[];
  workos: DirRow[];
  idp: DirRow[];
}): UserReconRow[] {
  const byName = (rows: DirRow[]) => new Map(rows.map((r) => [r.name, r]));
  const n = byName(users.native);
  const w = byName(users.workos);
  const i = byName(users.idp);
  const names = [...new Set([...n.keys(), ...w.keys(), ...i.keys()])].sort();
  return names.map((name) => {
    const native = presence(n.get(name));
    const workos = presence(w.get(name));
    return { name, native, workos, idp: presence(i.get(name)), diverged: native !== workos };
  });
}

interface GroupReconRow {
  name: string;
  native: number | null;
  workos: number | null;
  idp: number | null;
  diverged: boolean;
}

function reconcileGroups(groups: {
  native: GroupRow[];
  workos: GroupRow[];
  idp: GroupRow[];
}): GroupReconRow[] {
  const byName = (rows: GroupRow[]) => new Map(rows.map((r) => [r.name, r.member_count]));
  const n = byName(groups.native);
  const w = byName(groups.workos);
  const i = byName(groups.idp);
  const names = [...new Set([...n.keys(), ...w.keys(), ...i.keys()])].sort();
  return names.map((name) => {
    const native = n.has(name) ? n.get(name)! : null;
    const workos = w.has(name) ? w.get(name)! : null;
    return {
      name,
      native,
      workos,
      idp: i.has(name) ? i.get(name)! : null,
      diverged: native !== workos,
    };
  });
}

// --- flow rail ------------------------------------------------------------

/** Which write-path legs are live in each mode — the rail lights these up. */
const FLOW: Record<
  Mode,
  { toNative: "live" | "mirror" | "off"; toWorkos: "live" | "mirror" | "off"; listener: boolean }
> = {
  passthrough: { toNative: "live", toWorkos: "off", listener: false },
  "dualwrite-native-first": { toNative: "live", toWorkos: "mirror", listener: false },
  "workos-only": { toNative: "off", toWorkos: "live", listener: true },
};

const FLOW_CAPTION: Record<Mode, string> = {
  passthrough:
    "Writes go to the native app only. WorkOS is untouched — the safe place to land a rollback.",
  "dualwrite-native-first":
    "Writes hit the native app first, then mirror into WorkOS under the migrated-id contract. Native stays the source of truth.",
  "workos-only":
    "Cutover: writes go to WorkOS only. The native app stays current through its DSync event listener, not the proxy.",
};

function Node({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "idp" | "proxy" | "target";
}) {
  const ring =
    tone === "idp"
      ? "border-[var(--purple-7)] bg-[var(--purple-2)]"
      : tone === "proxy"
        ? "border-[var(--gray-7)] bg-[var(--gray-2)]"
        : "border-[var(--gray-6)] bg-[var(--color-panel-solid)]";
  return (
    <Box className={`rounded-[var(--radius-3)] border px-3 py-2 ${ring}`}>
      <Flex direction="column" gap="1" align="center">
        <Text size="1" color="gray" weight="medium">
          {label}
        </Text>
        <Text size={tone === "proxy" ? "2" : "4"} weight="bold">
          {value}
        </Text>
      </Flex>
    </Box>
  );
}

function Leg({ state, label }: { state: "live" | "mirror" | "off"; label: string }) {
  const color =
    state === "live" ? "var(--green-9)" : state === "mirror" ? "var(--blue-9)" : "var(--gray-6)";
  return (
    <Flex direction="column" align="center" gap="1" className="min-w-[76px]">
      <Text size="1" style={{ color }} weight="medium">
        {label}
      </Text>
      <Box
        className="h-0 w-full border-t-2"
        style={{ borderColor: color, borderStyle: state === "mirror" ? "dashed" : "solid" }}
      />
    </Flex>
  );
}

function FlowRail({
  mode,
  counts,
}: {
  mode: Mode;
  counts: { idp: number; native: number; workos: number };
}) {
  const flow = FLOW[mode];
  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="3" wrap="wrap">
        <Node label="IdP (source)" value={`${counts.idp} users`} tone="idp" />
        <Leg state="live" label="SCIM" />
        <Node label="Proxy" value={MODE_LABEL[mode]} tone="proxy" />
        <Flex direction="column" gap="3">
          <Flex align="center" gap="2">
            <Leg state={flow.toNative} label="native" />
            <Node label="Native app" value={`${counts.native} users`} tone="target" />
          </Flex>
          <Flex align="center" gap="2">
            <Leg state={flow.toWorkos} label={flow.toWorkos === "mirror" ? "mirror" : "workos"} />
            <Node label="WorkOS" value={`${counts.workos} users`} tone="target" />
          </Flex>
        </Flex>
      </Flex>
      {flow.listener && (
        <Text size="1" style={{ color: "var(--purple-11)" }}>
          ⤺ WorkOS → native app via the DSync event listener
        </Text>
      )}
      <Text color="gray" size="2">
        {FLOW_CAPTION[mode]}
      </Text>
    </Flex>
  );
}

// --- cells ----------------------------------------------------------------

function PresenceCell({ state }: { state: Presence }) {
  if (state === "absent") {
    return (
      <Text color="gray" size="2" style={{ opacity: 0.5 }}>
        —
      </Text>
    );
  }
  return (
    <Badge color={state === "active" ? "green" : "gray"} variant="soft">
      {state === "active" ? "Active" : "Inactive"}
    </Badge>
  );
}

function CountCell({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <Text color="gray" size="2" style={{ opacity: 0.5 }}>
        —
      </Text>
    );
  }
  return (
    <Text size="2">
      {value} {value === 1 ? "member" : "members"}
    </Text>
  );
}

const MODE_LABEL: Record<Mode, string> = {
  passthrough: "Passthrough",
  "dualwrite-native-first": "Dual-write",
  "workos-only": "WorkOS-only",
};
const MODE_COLOR: Record<Mode, "gray" | "blue" | "green"> = {
  passthrough: "gray",
  "dualwrite-native-first": "blue",
  "workos-only": "green",
};

export default function PanelLive() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as { error?: string } | undefined;
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (!live) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [live, revalidator]);

  if (!data.directory) {
    return (
      <EmptyState.Root
        title="No directory yet"
        subtitle="Create a directory on the Directories tab, then this console tracks all three directories live."
      />
    );
  }

  const { directory, users, groups, workosReachable, workosConfigured, auto, events } = data;
  const mode = directory.mode as Mode;
  const userRows = reconcileUsers(users);
  const groupRows = reconcileGroups(groups);
  const userDiffs = userRows.filter((r) => r.diverged).length;
  const groupDiffs = groupRows.filter((r) => r.diverged).length;
  const converged = userDiffs === 0 && groupDiffs === 0;
  const showDiff = workosConfigured && workosReachable;
  const settingMode = navigation.formData?.get("intent") === "set-mode";
  const backfilling = navigation.formData?.get("intent") === "run-backfill";

  const activeCount = (rows: DirRow[]) => rows.length;

  return (
    <Flex direction="column" gap="4">
      <Flex align="start" gap="4" justify="between">
        <Flex direction="column" gap="1">
          <Heading as="h2" size="5">
            Live state
          </Heading>
          <Text color="gray" size="2">
            The native app, WorkOS, and the IdP directory side by side — watch them converge as the
            proxy routes SCIM writes.
          </Text>
        </Flex>
        <Flex align="center" gap="3">
          <Badge color={live ? "green" : "gray"} variant="soft">
            {live ? "Live" : "Paused"}
          </Badge>
          <Button variant="soft" onClick={() => setLive((v) => !v)}>
            {live ? "Pause" : "Resume"}
          </Button>
          <Button
            loading={revalidator.state === "loading"}
            onClick={() => revalidator.revalidate()}
          >
            Refresh
          </Button>
        </Flex>
      </Flex>

      {actionData?.error && (
        <Callout.Root color="red">
          <Callout.Text>{actionData.error}</Callout.Text>
        </Callout.Root>
      )}

      <Card size="3">
        <Flex direction="column" gap="4">
          <FlowRail
            mode={mode}
            counts={{
              idp: activeCount(users.idp),
              native: activeCount(users.native),
              workos: activeCount(users.workos),
            }}
          />
          <Flex align="center" gap="3" wrap="wrap">
            <Text size="2" weight="medium">
              Proxy mode
            </Text>
            {MODES.map((m) => (
              <Form key={m} method="post">
                <input name="directoryId" type="hidden" value={directory.id} />
                <input name="intent" type="hidden" value="set-mode" />
                <input name="mode" type="hidden" value={m} />
                <Button
                  color={MODE_COLOR[m]}
                  disabled={m === mode || settingMode}
                  type="submit"
                  variant={m === mode ? "solid" : "soft"}
                >
                  {MODE_LABEL[m]}
                </Button>
              </Form>
            ))}
            <Box className="grow" />
            <Form method="post">
              <input name="directoryId" type="hidden" value={directory.id} />
              <input name="intent" type="hidden" value="run-backfill" />
              <Button
                disabled={mode !== "dualwrite-native-first" || backfilling}
                loading={backfilling}
                type="submit"
                variant="soft"
              >
                Run backfill
              </Button>
            </Form>
            <CleanWorkosButton
              directoryId={directory.id}
              disabled={!workosConfigured}
              isMock={data.workosIsMock}
            />
            <ResetNativeButton />
          </Flex>
        </Flex>
      </Card>

      <SimulatorControls auto={auto} directoryId={directory.id} />

      {!workosConfigured ? (
        <Callout.Root color="gray">
          <Callout.Text>
            No WorkOS endpoint is set on this directory, so only the native app and IdP are shown.
            Set one on the directory page — the mock at{" "}
            <Code>http://localhost:8788/mock-workos/scim/v2</Code> for a self-contained run, or a
            real WorkOS directory.
          </Callout.Text>
        </Callout.Root>
      ) : !workosReachable ? (
        <Callout.Root color="red">
          <Callout.Text>
            The WorkOS endpoint didn't respond, so its column is unavailable and convergence can't
            be computed. Check the endpoint URL and bearer token on the directory page.
          </Callout.Text>
        </Callout.Root>
      ) : converged ? (
        <Callout.Root color="green">
          <Callout.Text>
            Native app and WorkOS hold the same directory — {userRows.length}{" "}
            {userRows.length === 1 ? "user" : "users"}, {groupRows.length}{" "}
            {groupRows.length === 1 ? "group" : "groups"}, fully converged.
          </Callout.Text>
        </Callout.Root>
      ) : (
        <Callout.Root color="yellow">
          <Callout.Text>
            Native app and WorkOS differ on {userDiffs} {userDiffs === 1 ? "user" : "users"} and{" "}
            {groupDiffs} {groupDiffs === 1 ? "group" : "groups"}. That is expected mid-migration —
            dual-write plus a backfill converges them; workos-only diverges them until the listener
            catches native up.
          </Callout.Text>
        </Callout.Root>
      )}

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Heading as="h3" size="3">
              Users
            </Heading>
            <Text color="gray" size="2">
              One row per email across all three directories. Highlighted rows differ between the
              native app and WorkOS.
            </Text>
          </Flex>
          {userRows.length === 0 ? (
            <EmptyState.Root
              title="No users anywhere yet"
              subtitle="Seed or add a user on the IdP simulator tab to see it land here."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>User</Table.ColumnHeader>
                    <Table.ColumnHeader>Native app</Table.ColumnHeader>
                    <Table.ColumnHeader>WorkOS</Table.ColumnHeader>
                    <Table.ColumnHeader>IdP</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {userRows.map((row) => (
                    <Table.Row
                      key={row.name}
                      style={
                        showDiff && row.diverged ? { background: "var(--yellow-2)" } : undefined
                      }
                    >
                      <Table.Cell>{row.name}</Table.Cell>
                      <Table.Cell>
                        <PresenceCell state={row.native} />
                      </Table.Cell>
                      <Table.Cell>
                        <PresenceCell state={row.workos} />
                      </Table.Cell>
                      <Table.Cell>
                        <PresenceCell state={row.idp} />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.Root>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Heading as="h3" size="3">
              Groups
            </Heading>
            <Text color="gray" size="2">
              Member count per directory. Highlighted rows differ between the native app and WorkOS.
            </Text>
          </Flex>
          {groupRows.length === 0 ? (
            <EmptyState.Root
              title="No groups anywhere yet"
              subtitle="Create a group on the IdP simulator tab to see it land here."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Group</Table.ColumnHeader>
                    <Table.ColumnHeader>Native app</Table.ColumnHeader>
                    <Table.ColumnHeader>WorkOS</Table.ColumnHeader>
                    <Table.ColumnHeader>IdP</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {groupRows.map((row) => (
                    <Table.Row
                      key={row.name}
                      style={
                        showDiff && row.diverged ? { background: "var(--yellow-2)" } : undefined
                      }
                    >
                      <Table.Cell>{row.name}</Table.Cell>
                      <Table.Cell>
                        <CountCell value={row.native} />
                      </Table.Cell>
                      <Table.Cell>
                        <CountCell value={row.workos} />
                      </Table.Cell>
                      <Table.Cell>
                        <CountCell value={row.idp} />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.Root>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Heading as="h3" size="3">
              DSync events
            </Heading>
            <Text color="gray" size="2">
              The last 25 DSync events the native app's listener received after cutover — applied (a
              state transition), skipped (a no-op or superseded by a newer event), or ignored.
            </Text>
          </Flex>
          {events.length === 0 ? (
            <EmptyState.Root
              title="No events yet"
              subtitle="Events appear in workos-only mode, once WorkOS delivers DSync webhooks to the native listener."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Time</Table.ColumnHeader>
                    <Table.ColumnHeader>Event</Table.ColumnHeader>
                    <Table.ColumnHeader>IdP id</Table.ColumnHeader>
                    <Table.ColumnHeader>Action</Table.ColumnHeader>
                    <Table.ColumnHeader>Detail</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {events.map((event: ListenerEvent) => (
                    <Table.Row key={event.id}>
                      <Table.Cell>
                        <Text color="gray" size="1" style={{ whiteSpace: "nowrap" }}>
                          {event.ts}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Code size="1">{event.event_type}</Code>
                      </Table.Cell>
                      <Table.Cell>
                        {event.idp_id ? (
                          <Code size="1">{event.idp_id}</Code>
                        ) : (
                          <Text color="gray" size="1">
                            —
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge color={ACTION_BADGE_COLORS[event.action]}>{event.action}</Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Box maxWidth="320px">
                          <Text color="gray" size="1">
                            {event.detail ?? ""}
                          </Text>
                        </Box>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.Root>
          )}
        </Flex>
      </Card>
    </Flex>
  );
}

function SimulatorControls({
  auto,
  directoryId,
}: {
  auto: AutoStateRow | null;
  directoryId: string;
}) {
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const pendingAction = navigation.formData?.get("action");
  const running = auto?.running === 1;

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex direction="column" gap="1">
          <Heading as="h3" size="3">
            IdP simulator
          </Heading>
          <Text color="gray" size="2">
            Drive the source directory from here. Every action sends a real SCIM request through the
            proxy, exactly like Okta would.
          </Text>
        </Flex>

        <Flex align="center" gap="3" wrap="wrap">
          <Form method="post">
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-seed" />
            <Button loading={pendingIntent === "idp-seed"} type="submit">
              Seed directory
            </Button>
          </Form>
          <SimulatorUserDialog
            directoryId={directoryId}
            pending={pendingAction === "create-user"}
          />
          <SimulatorGroupDialog
            directoryId={directoryId}
            pending={pendingAction === "create-group"}
          />
          <Box className="grow" />
          <ResetSimulatorButton directoryId={directoryId} />
        </Flex>

        <Flex
          align="center"
          gap="3"
          justify="between"
          wrap="wrap"
          className="rounded-[var(--radius-3)] border border-[var(--gray-a5)] bg-[var(--gray-a2)] px-4 py-3"
        >
          <Flex align="center" gap="3">
            <Text size="2" weight="medium">
              Auto-run
            </Text>
            <Badge color={running ? "green" : "gray"} variant="soft">
              {running ? "Running" : "Idle"}
            </Badge>
            {running && (
              <Text color="gray" size="2">
                {auto?.tick_count ?? 0} ticks, one every{" "}
                {((auto?.interval_ms ?? DEFAULT_INTERVAL_MS) / 1000).toString()}s
              </Text>
            )}
          </Flex>
          {running ? (
            <Form method="post">
              <input name="directoryId" type="hidden" value={directoryId} />
              <input name="intent" type="hidden" value="idp-auto-stop" />
              <Button loading={pendingIntent === "idp-auto-stop"} type="submit" variant="soft">
                Stop auto-run
              </Button>
            </Form>
          ) : (
            <Form method="post">
              <input name="directoryId" type="hidden" value={directoryId} />
              <input name="intent" type="hidden" value="idp-auto-start" />
              <Flex align="center" gap="3">
                <Select.Root defaultValue={String(DEFAULT_INTERVAL_MS)} name="intervalMs">
                  <Select.Trigger aria-label="Auto-run interval" />
                  <Select.Content>
                    {INTERVAL_OPTIONS.map((option) => (
                      <Select.Item key={option.value} value={option.value}>
                        {option.label}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <Button color="purple" loading={pendingIntent === "idp-auto-start"} type="submit">
                  Start auto-run
                </Button>
              </Flex>
            </Form>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

function SimulatorUserDialog({ directoryId, pending }: { directoryId: string; pending: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button color="purple" variant="soft">
          Add user
        </Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Add user"
              description="Provisions a new user in the simulated directory. The IdP immediately sends a SCIM create through the proxy."
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-action" />
            <input name="action" type="hidden" value="create-user" />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor="live-user-name">Email</FieldLabel>
              <TextField.Root
                autoFocus
                id="live-user-name"
                name="userName"
                placeholder="ada@acme.test"
                required
                type="email"
              />
            </Flex>
            <Grid columns={{ initial: "1", sm: "2" }} gap="4">
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="live-given-name">First name</FieldLabel>
                <TextField.Root id="live-given-name" name="givenName" placeholder="Ada" />
              </Flex>
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="live-family-name">Last name</FieldLabel>
                <TextField.Root id="live-family-name" name="familyName" placeholder="Lovelace" />
              </Flex>
            </Grid>
            <Dialog.Footer>
              <Dialog.Close>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button color="purple" loading={pending} type="submit">
                Add user
              </Button>
            </Dialog.Footer>
          </Flex>
        </Form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SimulatorGroupDialog({ directoryId, pending }: { directoryId: string; pending: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button variant="soft">Create group</Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Create group"
              description="Creates a new group in the simulated directory and pushes it through the proxy."
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-action" />
            <input name="action" type="hidden" value="create-group" />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor="live-group-name">Group name</FieldLabel>
              <TextField.Root
                autoFocus
                id="live-group-name"
                name="displayName"
                placeholder="Engineering"
                required
              />
            </Flex>
            <Dialog.Footer>
              <Dialog.Close>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button color="purple" loading={pending} type="submit">
                Create group
              </Button>
            </Dialog.Footer>
          </Flex>
        </Form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ResetSimulatorButton({ directoryId }: { directoryId: string }) {
  const navigation = useNavigation();
  const resetting = navigation.formData?.get("intent") === "idp-reset";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" variant="soft">
          Reset simulator
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Reset the simulator?"
              description="Wipes the simulated IdP directory and its activity feed and stops auto-run. It does not touch what the proxy already provisioned into WorkOS or the native app."
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="idp-reset" />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" loading={resetting} type="submit">
                  Reset simulator
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function CleanWorkosButton({
  directoryId,
  disabled,
  isMock,
}: {
  directoryId: string;
  disabled: boolean;
  isMock: boolean;
}) {
  const navigation = useNavigation();
  const cleaning = navigation.formData?.get("intent") === "clean-workos";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" disabled={disabled} variant="soft">
          Clean WorkOS
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Clean the WorkOS directory?"
              description={
                isMock
                  ? "Sends a SCIM delete for every user and group in the mock WorkOS directory. The directory's endpoint stays configured; the native app and IdP are untouched."
                  : "Sends a SCIM delete for every user and group in the real WorkOS directory this directory points at — this removes real data from that directory. The directory's endpoint stays configured; the native app and IdP are untouched."
              }
            />
            <input name="directoryId" type="hidden" value={directoryId} />
            <input name="intent" type="hidden" value="clean-workos" />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" loading={cleaning} type="submit">
                  Clean WorkOS
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function ResetNativeButton() {
  const navigation = useNavigation();
  const resetting = navigation.formData?.get("intent") === "reset-native";
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" variant="soft">
          Reset native app
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Reset the native app?"
              description="Deletes every user and group from the customer app's directory and its DSync listener log. The proxy directory, id mappings, and WorkOS are left untouched."
            />
            <input name="intent" type="hidden" value="reset-native" />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" loading={resetting} type="submit">
                  Reset native app
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
