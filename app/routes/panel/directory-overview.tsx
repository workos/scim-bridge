import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { runBackfill, runReconcileFromWorkos } from "../../../workers/shared/backfill";
import {
  getConfig,
  getDirectoryById,
  setDirectoryLogPersistence,
  setDirectoryMode,
  setDirectoryNative,
  setDirectoryWorkos,
  setDirectoryWorkosDirectoryId,
  withD1Retry,
} from "../../../workers/shared/db";
import type { BackfillSummary, Mode } from "../../../workers/shared/types";
import { MODES } from "../../../workers/shared/types";
import * as AlertDialog from "../../vendor/design-system/components/alert-dialog";
import { Badge } from "../../vendor/design-system/components/badge";
import { Button } from "../../vendor/design-system/components/button";
import { Callout } from "../../vendor/design-system/components/callout";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import { Flex } from "../../vendor/design-system/components/flex";
import { Grid } from "../../vendor/design-system/components/grid";
import { RadioCards } from "../../vendor/design-system/components/radio-cards";
import { Text } from "../../vendor/design-system/components/text";
import * as TextField from "../../vendor/design-system/components/text-field";
import { FlowRail } from "./flow-rail";
import { CardHeader, CopyButton, FieldLabel, trimTrailingSlash } from "./ui";

interface HealthResult {
  target: "native" | "workos";
  status: number | null;
  ok: boolean;
  detail?: string;
}

interface EndpointCount {
  reachable: boolean;
  count: number | null;
}

interface TopologyResult {
  native: EndpointCount;
  workos: EndpointCount;
}

interface OverviewActionData {
  error?: string;
  backfill?: BackfillSummary;
  reconcile?: BackfillSummary;
  health?: HealthResult;
  topology?: TopologyResult;
}

const MODE_DETAILS: { value: Mode; description: string }[] = [
  {
    value: "passthrough",
    description:
      "Every read and write goes to native. WorkOS is untouched. The rollback landing spot.",
  },
  {
    value: "dual-write",
    description:
      "Write native first; only on a native 2xx, mirror the write into WorkOS via the migrated-id contract. Reads served from native.",
  },
  {
    value: "workos-only",
    description:
      "Cutover. WorkOS is the only SCIM target and the proxy goes silent toward native. The DSync listener becomes the app's feed.",
  },
];

export async function loader({ context, params }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const directory = await getDirectoryById(env.DB, params.id ?? "");
  if (!directory) {
    throw new Response("Directory not found", { status: 404 });
  }
  const [proxyPublicUrl, nativePublicUrl] = await Promise.all([
    getConfig(env.DB, "proxy.public_url"),
    getConfig(env.DB, "native.public_url"),
  ]);
  return {
    directory,
    proxyPublicUrl: proxyPublicUrl ?? "",
    nativePublicUrl: nativePublicUrl ?? "",
  };
}

async function checkEndpoint(
  target: "native" | "workos",
  url: string,
  token: string,
): Promise<HealthResult> {
  if (!url) {
    return {
      target,
      status: null,
      ok: false,
      detail: "No endpoint URL is configured for this target yet.",
    };
  }
  try {
    const response = await fetch(`${trimTrailingSlash(url)}/Users?count=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { target, status: response.status, ok: response.ok };
  } catch (error) {
    return {
      target,
      status: null,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Live user count from an endpoint over SCIM, with a short timeout so an
 *  unreachable or not-yet-configured endpoint fails fast instead of hanging. */
async function countUsers(url: string, token: string): Promise<EndpointCount> {
  if (!url) return { reachable: false, count: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${trimTrailingSlash(url)}/Users?count=1`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return { reachable: false, count: null };
    const body = (await response.json()) as { totalResults?: unknown };
    const count = typeof body.totalResults === "number" ? body.totalResults : null;
    return { reachable: true, count };
  } catch {
    return { reachable: false, count: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function action({
  context,
  params,
  request,
}: ActionFunctionArgs): Promise<Response | OverviewActionData> {
  const { env } = context.cloudflare;
  const directory = await getDirectoryById(env.DB, params.id ?? "");
  if (!directory) {
    throw new Response("Directory not found", { status: 404 });
  }

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "set-mode") {
    const mode = String(form.get("mode") ?? "");
    if (!MODES.includes(mode as Mode)) {
      return {
        error: "That mode is not one of passthrough, dual-write, or workos-only.",
      };
    }
    await setDirectoryMode(env.DB, directory.id, mode as Mode);
    return {};
  }

  if (intent === "set-log-persistence") {
    await setDirectoryLogPersistence(env.DB, directory.id, form.get("on") === "true");
    return {};
  }

  if (intent === "save-native") {
    await setDirectoryNative(
      env.DB,
      directory.id,
      String(form.get("native_url") ?? "").trim(),
      String(form.get("native_token") ?? "").trim(),
    );
    return {};
  }

  if (intent === "save-workos") {
    await setDirectoryWorkos(
      env.DB,
      directory.id,
      String(form.get("workos_url") ?? "").trim(),
      String(form.get("workos_token") ?? "").trim(),
    );
    return {};
  }

  if (intent === "save-workos-directory-id") {
    try {
      await setDirectoryWorkosDirectoryId(
        env.DB,
        directory.id,
        String(form.get("workos_directory_id") ?? "").trim(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: /unique/i.test(message)
          ? "That WorkOS directory id is already assigned to another directory."
          : message,
      };
    }
    return {};
  }

  if (intent === "run-backfill") {
    if (directory.mode !== "dual-write") {
      return {
        error:
          "Backfill only runs in dual-write mode, so live writes keep flowing while the snapshot replays.",
      };
    }
    const backfill = await runBackfill(env.DB, directory);
    return { backfill };
  }

  if (intent === "reconcile-from-workos") {
    if (directory.mode !== "workos-only") {
      return {
        error:
          "Reconcile from WorkOS runs in workos-only mode, to bring the native app fully current before a rollback.",
      };
    }
    const reconcile = await runReconcileFromWorkos(env.DB, directory);
    return { reconcile };
  }

  if (intent === "test-native") {
    return {
      health: await checkEndpoint("native", directory.native_url, directory.native_token),
    };
  }

  if (intent === "test-workos") {
    return {
      health: await checkEndpoint("workos", directory.workos_url, directory.workos_token),
    };
  }

  if (intent === "topology") {
    const [native, workos] = await Promise.all([
      countUsers(directory.native_url, directory.native_token),
      countUsers(directory.workos_url, directory.workos_token),
    ]);
    return { topology: { native, workos } };
  }

  if (intent === "delete-directory") {
    await withD1Retry(() =>
      env.DB.batch([
        env.DB.prepare("DELETE FROM id_mappings WHERE directory_id = ?").bind(directory.id),
        env.DB.prepare("DELETE FROM proxy_log WHERE directory_id = ?").bind(directory.id),
        env.DB.prepare("DELETE FROM scim_directories WHERE id = ?").bind(directory.id),
      ]),
    );
    return redirect("/panel");
  }

  return { error: "That form action is not recognized." };
}

function LogPersistenceCard({ on, pending }: { on: boolean; pending: boolean }) {
  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <CardHeader
          title="Log persistence"
          description="Persist this directory's proxy requests to the activity log and id mappings. Enable it only for directories you're actively monitoring — a large fleet logging every request adds up. When off, requests still proxy and mirror exactly the same."
        />
        <Flex align="center" gap="3" wrap="wrap">
          <Badge color={on ? "green" : "gray"} variant={on ? undefined : "soft"}>
            {on ? "Monitored" : "Not persisted"}
          </Badge>
          <Form method="post">
            <input type="hidden" name="intent" value="set-log-persistence" />
            <input type="hidden" name="on" value={on ? "false" : "true"} />
            <Button loading={pending} type="submit" variant="soft">
              {on ? "Disable logging" : "Enable logging"}
            </Button>
          </Form>
        </Flex>
      </Flex>
    </Card>
  );
}

function ModeCard({ currentMode, pending }: { currentMode: Mode; pending: boolean }) {
  const submit = useSubmit();
  const [selected, setSelected] = useState<Mode>(currentMode);
  const dirty = selected !== currentMode;
  const isCutover = dirty && selected === "workos-only";
  const isRollback = dirty && currentMode === "workos-only";
  const applyMode = () => submit({ intent: "set-mode", mode: selected }, { method: "post" });

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <CardHeader
          title="Mode"
          description="The IdP never changes. The proxy's mode decides where each request goes and which side is the source of truth."
        />
        <RadioCards.Root
          columns={{ initial: "1", sm: "3" }}
          value={selected}
          onValueChange={(value) => setSelected(value as Mode)}
        >
          {MODE_DETAILS.map((mode) => (
            <RadioCards.Item key={mode.value} value={mode.value}>
              <Flex direction="column" gap="1" width="100%">
                <Text size="2" weight="medium">
                  {mode.value}
                </Text>
                <Text color="gray" size="1">
                  {mode.description}
                </Text>
              </Flex>
            </RadioCards.Item>
          ))}
        </RadioCards.Root>
        <Flex justify="end">
          {isCutover || isRollback ? (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button color="purple" disabled={pending}>
                  {isCutover ? "Cut over to WorkOS" : `Roll back to ${selected}`}
                </Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content size="2">
                <Flex direction="column" gap="5">
                  <AlertDialog.Header
                    title={isCutover ? "Cut over to WorkOS?" : "Roll back from workos-only?"}
                    description={
                      isCutover
                        ? "The proxy will stop sending SCIM traffic to the native endpoint entirely — WorkOS becomes the only target. Enable the customer's DSync event listener first, or the native directory will go stale."
                        : `The proxy will switch back to ${selected} and the untouched native SCIM handler resumes. Let in-flight DSync events drain first so the listener finishes applying everything WorkOS already accepted.`
                    }
                  />
                  <AlertDialog.Footer>
                    <AlertDialog.Cancel>
                      <Button>Cancel</Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action>
                      <Button color="red" onClick={applyMode}>
                        {isCutover ? "Cut over" : "Roll back"}
                      </Button>
                    </AlertDialog.Action>
                  </AlertDialog.Footer>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          ) : (
            <Button color="purple" disabled={!dirty} loading={pending} onClick={applyMode}>
              {dirty ? `Switch to ${selected}` : "Mode is up to date"}
            </Button>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

function EndpointCard({
  title,
  description,
  intent,
  urlField,
  tokenField,
  urlValue,
  tokenValue,
  buttonLabel,
  pending,
}: {
  title: string;
  description: string;
  intent: string;
  urlField: string;
  tokenField: string;
  urlValue: string;
  tokenValue: string;
  buttonLabel: string;
  pending: boolean;
}) {
  return (
    <Card size="3">
      <Form method="post">
        <input type="hidden" name="intent" value={intent} />
        <Flex direction="column" gap="4">
          <CardHeader title={title} description={description} />
          <Grid columns={{ initial: "1", sm: "2" }} gap="4">
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor={urlField}>Base URL</FieldLabel>
              <TextField.Root
                defaultValue={urlValue}
                id={urlField}
                name={urlField}
                placeholder="https://…/scim/v2"
              />
            </Flex>
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor={tokenField}>Bearer token</FieldLabel>
              <TextField.Root
                defaultValue={tokenValue}
                id={tokenField}
                name={tokenField}
                suppressPasswordManagers
              />
            </Flex>
          </Grid>
          <Flex justify="end">
            <Button loading={pending} type="submit">
              {buttonLabel}
            </Button>
          </Flex>
        </Flex>
      </Form>
    </Card>
  );
}

function BackfillResult({ summary }: { summary: BackfillSummary }) {
  return (
    <Flex direction="column" gap="3">
      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        {(["users", "groups"] as const).map((kind) => (
          <Flex key={kind} align="center" gap="2">
            <Text size="2" weight="medium">
              {kind === "users" ? "Users" : "Groups"}
            </Text>
            <Badge color="gray" lowContrast>
              {summary[kind].total} total
            </Badge>
            <Badge color="green">{summary[kind].mirrored} mirrored</Badge>
            <Badge color={summary[kind].failed > 0 ? "red" : "gray"}>
              {summary[kind].failed} failed
            </Badge>
          </Flex>
        ))}
      </Grid>
      {summary.errors.length > 0 && (
        <Callout.Root color="red">
          <Callout.Text>
            {summary.errors.slice(0, 5).map((error, index) => (
              <Text as="div" key={index} size="2">
                {error}
              </Text>
            ))}
          </Callout.Text>
        </Callout.Root>
      )}
    </Flex>
  );
}

function LiveStateCard({ mode }: { mode: Mode }) {
  const fetcher = useFetcher<OverviewActionData>();
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      fetcher.submit({ intent: "topology" }, { method: "post" });
    }
  }, [fetcher]);

  const topo = fetcher.data?.topology;
  const counts = { native: topo?.native.count ?? null, workos: topo?.workos.count ?? null };

  let sync: { color: "green" | "yellow" | "gray"; label: string } | null = null;
  if (topo) {
    if (!topo.native.reachable || !topo.workos.reachable) {
      sync = { color: "gray", label: "endpoint unreachable" };
    } else if (topo.native.count === topo.workos.count) {
      sync = { color: "green", label: "in sync" };
    } else {
      sync = { color: "yellow", label: "drift" };
    }
  }

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="3" justify="between">
          <CardHeader
            title="Live state"
            description="The native app and WorkOS for this directory, read live over SCIM. Counts are users."
          />
          <Flex align="center" gap="2">
            {sync && <Badge color={sync.color}>{sync.label}</Badge>}
            <Button
              loading={fetcher.state !== "idle"}
              onClick={() => fetcher.submit({ intent: "topology" }, { method: "post" })}
              variant="soft"
            >
              Refresh
            </Button>
          </Flex>
        </Flex>
        <FlowRail counts={counts} mode={mode} />
      </Flex>
    </Card>
  );
}

export default function DirectoryOverview() {
  const { directory, proxyPublicUrl, nativePublicUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData() as OverviewActionData | undefined;
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const scimBaseUrl = `${trimTrailingSlash(proxyPublicUrl)}/scim/v2`;
  const statusUrl = `${trimTrailingSlash(proxyPublicUrl)}/status/directories/${directory.workos_directory_id || directory.id}`;
  const mockWorkosUrl = `${trimTrailingSlash(nativePublicUrl)}/mock-workos/scim/v2`;
  const health = actionData?.health;

  return (
    <Flex direction="column" gap="4">
      {actionData?.error && (
        <Callout.Root color="red">
          <Callout.Text>{actionData.error}</Callout.Text>
        </Callout.Root>
      )}

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Identity provider"
            description="Paste these into the IdP's SCIM provisioning settings (Okta: header auth, HTTP Header — Bearer)."
          />
          <Grid columns={{ initial: "1", sm: "2" }} gap="4">
            <Flex direction="column" gap="2">
              <Text color="gray" size="2" weight="medium">
                SCIM base URL
              </Text>
              <Flex align="center" gap="2">
                <Code size="2" className="break-all">
                  {scimBaseUrl}
                </Code>
                <CopyButton value={scimBaseUrl} />
              </Flex>
            </Flex>
            <Flex direction="column" gap="2">
              <Text color="gray" size="2" weight="medium">
                Bearer token
              </Text>
              <Flex align="center" gap="2">
                <Code size="2" className="break-all">
                  {directory.proxy_token}
                </Code>
                <CopyButton value={directory.proxy_token} />
              </Flex>
            </Flex>
          </Grid>
        </Flex>
      </Card>

      <ModeCard
        key={directory.mode}
        currentMode={directory.mode}
        pending={pendingIntent === "set-mode"}
      />

      <LogPersistenceCard
        on={Boolean(directory.log_persistence)}
        pending={pendingIntent === "set-log-persistence"}
      />

      <LiveStateCard mode={directory.mode} />

      <EndpointCard
        title="Native SCIM endpoint"
        description="The customer's own SCIM server — authoritative until cutover. The proxy presents this bearer token."
        intent="save-native"
        urlField="native_url"
        tokenField="native_token"
        urlValue={directory.native_url}
        tokenValue={directory.native_token}
        buttonLabel="Save native endpoint"
        pending={pendingIntent === "save-native"}
      />

      <EndpointCard
        title="WorkOS directory endpoint"
        description={`For a local run, paste the mock endpoint (${mockWorkosUrl}) with the mock bearer token from Global settings. For the real thing, paste the endpoint and bearer token from a WorkOS dashboard generic SCIM directory.`}
        intent="save-workos"
        urlField="workos_url"
        tokenField="workos_token"
        urlValue={directory.workos_url}
        tokenValue={directory.workos_token}
        buttonLabel="Save WorkOS endpoint"
        pending={pendingIntent === "save-workos"}
      />

      <Card size="3">
        <Form method="post">
          <input type="hidden" name="intent" value="save-workos-directory-id" />
          <Flex direction="column" gap="4">
            <CardHeader
              title="Listener status endpoint"
              description="The customer's native app polls this from its DSync event listener to decide whether to handle or ignore an event for this directory (native_authoritative). Authenticate with the directory's proxy bearer token above. Set the WorkOS directory id (directory_...) so the listener can address it by the id DSync events carry."
            />
            <Grid columns={{ initial: "1", sm: "2" }} gap="4">
              <Flex direction="column" gap="2">
                <Text color="gray" size="2" weight="medium">
                  Status URL
                </Text>
                <Flex align="center" gap="2">
                  <Code size="2" className="break-all">
                    {statusUrl}
                  </Code>
                  <CopyButton value={statusUrl} />
                </Flex>
              </Flex>
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="workos-directory-id">WorkOS directory id</FieldLabel>
                <TextField.Root
                  defaultValue={directory.workos_directory_id ?? ""}
                  id="workos-directory-id"
                  name="workos_directory_id"
                  placeholder="directory_01…"
                />
              </Flex>
            </Grid>
            <Flex justify="end">
              <Button loading={pendingIntent === "save-workos-directory-id"} type="submit">
                Save WorkOS directory id
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Backfill"
            description="Snapshot the native directory and replay every user and group into WorkOS as migrated-id upserts."
          />
          {directory.mode !== "dual-write" ? (
            <Flex align="center" gap="3" justify="between">
              <Text color="gray" size="2">
                Backfill is only available in dual-write mode, so live dual-writes keep flowing
                while the snapshot replays. Switch modes above to enable it.
              </Text>
              <Button disabled>Run backfill</Button>
            </Flex>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="run-backfill" />
              <Flex justify="end">
                <Button color="purple" loading={pendingIntent === "run-backfill"} type="submit">
                  Run backfill
                </Button>
              </Flex>
            </Form>
          )}
          {actionData?.backfill && <BackfillResult summary={actionData.backfill} />}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Backfill from WorkOS → native (rollback)"
            description="The reverse of the forward backfill: snapshot the live WorkOS directory and replay every user and group back into the native app as migrated-id upserts. Run it before rolling back, to bring the native app fully current in case its DSync listener lagged."
          />
          {directory.mode !== "workos-only" ? (
            <Flex align="center" gap="3" justify="between">
              <Text color="gray" size="2">
                Available in workos-only mode — that's when WorkOS is authoritative and the native
                app may be behind. Run it here to make native current, then roll back safely. Switch
                modes above to enable it.
              </Text>
              <Button disabled>Backfill from WorkOS</Button>
            </Flex>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="reconcile-from-workos" />
              <Flex justify="end">
                <Button
                  color="purple"
                  loading={pendingIntent === "reconcile-from-workos"}
                  type="submit"
                >
                  Backfill from WorkOS
                </Button>
              </Flex>
            </Form>
          )}
          {actionData?.reconcile && <BackfillResult summary={actionData.reconcile} />}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Health"
            description="Sends GET /Users?count=1 to each endpoint with its stored bearer token."
          />
          <Flex gap="3">
            <Form method="post">
              <input type="hidden" name="intent" value="test-native" />
              <Button loading={pendingIntent === "test-native"} type="submit">
                Test native
              </Button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="test-workos" />
              <Button loading={pendingIntent === "test-workos"} type="submit">
                Test WorkOS
              </Button>
            </Form>
          </Flex>
          {health && (
            <Flex align="center" gap="2">
              <Badge color={health.ok ? "green" : "red"}>{health.ok ? "ok" : "failed"}</Badge>
              <Text size="2">
                The {health.target === "native" ? "native" : "WorkOS"} endpoint{" "}
                {health.status != null ? `returned ${health.status}` : "was unreachable"}
                {health.detail ? ` — ${health.detail}` : "."}
              </Text>
            </Flex>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex align="center" gap="4" justify="between">
          <Flex direction="column" gap="1">
            <Text size="3" weight="medium">
              Danger zone
            </Text>
            <Text color="gray" size="2">
              Deleting this directory removes its id mappings and invalidates its proxy token
              immediately.
            </Text>
          </Flex>
          <AlertDialog.Root>
            <AlertDialog.Trigger>
              <Button color="red">Delete directory</Button>
            </AlertDialog.Trigger>
            <AlertDialog.Content size="2">
              <Form method="post">
                <Flex direction="column" gap="5">
                  <AlertDialog.Header
                    title="Delete this directory?"
                    description={`This permanently deletes "${directory.name}" and its id mappings. The IdP will start receiving 401 responses from the proxy as soon as the token is gone.`}
                  />
                  <input type="hidden" name="intent" value="delete-directory" />
                  <AlertDialog.Footer>
                    <AlertDialog.Cancel>
                      <Button>Cancel</Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action>
                      <Button color="red" type="submit">
                        Delete directory
                      </Button>
                    </AlertDialog.Action>
                  </AlertDialog.Footer>
                </Flex>
              </Form>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </Flex>
      </Card>
    </Flex>
  );
}
