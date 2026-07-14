import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { getConfig, listDirectories, withD1Retry } from "../../../workers/shared/db";
import type { IdpActivity } from "../../../workers/idp/types";
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
import { Separator } from "../../vendor/design-system/components/separator";
import { Status } from "../../vendor/design-system/components/status";
import * as Table from "../../vendor/design-system/components/table";
import { Text } from "../../vendor/design-system/components/text";
import * as TextField from "../../vendor/design-system/components/text-field";
import type { Mode } from "../../../workers/shared/types";
import { CardHeader, FieldLabel, ModeBadge, trimTrailingSlash } from "./ui";

const DEFAULT_IDP_URL = "http://localhost:8789";
const DEFAULT_INTERVAL_MS = 4000;

const ORIGIN_BADGE_COLORS = {
  seed: "blue",
  manual: "purple",
  auto: "green",
} as const;

const INTERVAL_OPTIONS = [
  { value: "1000", label: "Every 1 second" },
  { value: "2000", label: "Every 2 seconds" },
  { value: "4000", label: "Every 4 seconds" },
  { value: "8000", label: "Every 8 seconds" },
];

interface IdpUserRow {
  id: string;
  user_name: string;
  external_id: string | null;
  given_name: string | null;
  family_name: string | null;
  active: number;
  scim_id: string | null;
  last_status: number | null;
}

interface IdpGroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  scim_id: string | null;
}

interface IdpMemberRow {
  group_id: string;
  user_id: string;
  user_name: string;
}

interface IdpAutoStateRow {
  running: number;
  interval_ms: number;
  tick_count: number;
}

interface IdpActionData {
  error?: string;
}

export async function loader({ context }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const directories = await listDirectories(env.DB);
  const directory = directories[0] ?? null;

  const [idpPublicUrl, proxyPublicUrl] = await Promise.all([
    getConfig(env.DB, "idp.public_url"),
    getConfig(env.DB, "proxy.public_url"),
  ]);

  if (!directory) {
    return {
      directory: null,
      idpPublicUrl: idpPublicUrl ?? DEFAULT_IDP_URL,
      proxyPublicUrl: proxyPublicUrl ?? "",
      users: [] as IdpUserRow[],
      groups: [] as IdpGroupRow[],
      members: [] as IdpMemberRow[],
      activity: [] as IdpActivity[],
      auto: null as IdpAutoStateRow | null,
    };
  }

  const [users, groups, members, activity, auto] = await Promise.all([
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT id, user_name, external_id, given_name, family_name, active, scim_id, last_status " +
          "FROM idp_users WHERE directory_id = ? ORDER BY created_at",
      )
        .bind(directory.id)
        .all<IdpUserRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT id, display_name, external_id, scim_id FROM idp_groups WHERE directory_id = ? ORDER BY created_at",
      )
        .bind(directory.id)
        .all<IdpGroupRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT m.group_id AS group_id, m.user_id AS user_id, u.user_name AS user_name " +
          "FROM idp_group_members m " +
          "JOIN idp_groups g ON g.id = m.group_id " +
          "JOIN idp_users u ON u.id = m.user_id " +
          "WHERE g.directory_id = ? ORDER BY u.user_name",
      )
        .bind(directory.id)
        .all<IdpMemberRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare("SELECT * FROM idp_activity WHERE directory_id = ? ORDER BY id DESC LIMIT 50")
        .bind(directory.id)
        .all<IdpActivity>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT running, interval_ms, tick_count FROM idp_auto_state WHERE directory_id = ?",
      )
        .bind(directory.id)
        .first<IdpAutoStateRow>(),
    ),
  ]);

  return {
    directory: { id: directory.id, name: directory.name, mode: directory.mode as Mode },
    idpPublicUrl: idpPublicUrl ?? DEFAULT_IDP_URL,
    proxyPublicUrl: proxyPublicUrl ?? "",
    users: users.results,
    groups: groups.results,
    members: members.results,
    activity: activity.results,
    auto: auto ?? null,
  };
}

export async function action({
  context,
  request,
}: ActionFunctionArgs): Promise<Response | IdpActionData> {
  const { env } = context.cloudflare;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const directoryId = String(form.get("directoryId") ?? "");

  if (!directoryId) {
    return {
      error: "No directory exists yet — create a directory before driving the simulated IdP.",
    };
  }

  const idpPublicUrl = (await getConfig(env.DB, "idp.public_url")) ?? DEFAULT_IDP_URL;

  const endpoints: Record<string, string> = {
    seed: "seed",
    reset: "reset",
    "auto-start": "auto/start",
    "auto-stop": "auto/stop",
    action: "action",
  };

  const endpoint = endpoints[intent];
  if (!endpoint) {
    return { error: "That form action is not recognized." };
  }

  const body: Record<string, unknown> = { directoryId };

  if (intent === "auto-start") {
    body.intervalMs = Number(form.get("intervalMs")) || DEFAULT_INTERVAL_MS;
  }

  if (intent === "action") {
    body.action = String(form.get("action") ?? "");
    for (const key of ["userId", "groupId", "userName", "givenName", "familyName", "displayName"]) {
      const value = form.get(key);
      if (value != null) body[key] = String(value);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${trimTrailingSlash(idpPublicUrl)}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      error: `The IdP simulator at ${idpPublicUrl} was unreachable — ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    return { error: data.error ?? "The IdP simulator rejected that request." };
  }

  return redirect("/panel/idp");
}

function DirectoryField({ directoryId }: { directoryId: string }) {
  return <input name="directoryId" type="hidden" value={directoryId} />;
}

function fullName(user: IdpUserRow): string {
  const name = [user.given_name, user.family_name].filter(Boolean).join(" ");
  return name || "—";
}

function AddUserDialog({ directoryId, pending }: { directoryId: string; pending: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button color="purple">Add user</Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Add user"
              description="Provisions a new user in the simulated directory. The IdP immediately sends a SCIM create through the proxy."
            />
            <DirectoryField directoryId={directoryId} />
            <input name="intent" type="hidden" value="action" />
            <input name="action" type="hidden" value="create-user" />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor="idp-user-name">Email</FieldLabel>
              <TextField.Root
                autoFocus
                id="idp-user-name"
                name="userName"
                placeholder="ada@acme.test"
                required
                type="email"
              />
            </Flex>
            <Grid columns={{ initial: "1", sm: "2" }} gap="4">
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="idp-given-name">First name</FieldLabel>
                <TextField.Root id="idp-given-name" name="givenName" placeholder="Ada" />
              </Flex>
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor="idp-family-name">Last name</FieldLabel>
                <TextField.Root id="idp-family-name" name="familyName" placeholder="Lovelace" />
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

function CreateGroupDialog({ directoryId, pending }: { directoryId: string; pending: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button>Create group</Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Create group"
              description="Creates a new group in the simulated directory and pushes it to WorkOS through the proxy."
            />
            <DirectoryField directoryId={directoryId} />
            <input name="intent" type="hidden" value="action" />
            <input name="action" type="hidden" value="create-group" />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor="idp-group-name">Group name</FieldLabel>
              <TextField.Root
                autoFocus
                id="idp-group-name"
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

function RenameUserDialog({ directoryId, user }: { directoryId: string; user: IdpUserRow }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button ghost size="1">
          Rename
        </Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Rename user"
              description={`Sends a SCIM update for ${user.user_name} through the proxy.`}
            />
            <DirectoryField directoryId={directoryId} />
            <input name="intent" type="hidden" value="action" />
            <input name="action" type="hidden" value="rename-user" />
            <input name="userId" type="hidden" value={user.id} />
            <Grid columns={{ initial: "1", sm: "2" }} gap="4">
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor={`rename-given-${user.id}`}>First name</FieldLabel>
                <TextField.Root
                  autoFocus
                  defaultValue={user.given_name ?? ""}
                  id={`rename-given-${user.id}`}
                  name="givenName"
                  required
                />
              </Flex>
              <Flex direction="column" gap="2">
                <FieldLabel htmlFor={`rename-family-${user.id}`}>Last name</FieldLabel>
                <TextField.Root
                  defaultValue={user.family_name ?? ""}
                  id={`rename-family-${user.id}`}
                  name="familyName"
                  required
                />
              </Flex>
            </Grid>
            <Dialog.Footer>
              <Dialog.Close>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button color="purple" type="submit">
                Save changes
              </Button>
            </Dialog.Footer>
          </Flex>
        </Form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function DeleteUserDialog({ directoryId, user }: { directoryId: string; user: IdpUserRow }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" ghost size="1">
          Delete
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Delete this user?"
              description={`The IdP will send a SCIM delete for ${user.user_name} through the proxy. This mirrors an Okta deprovisioning.`}
            />
            <DirectoryField directoryId={directoryId} />
            <input name="intent" type="hidden" value="action" />
            <input name="action" type="hidden" value="delete-user" />
            <input name="userId" type="hidden" value={user.id} />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" type="submit">
                  Delete user
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function RenameGroupDialog({ directoryId, group }: { directoryId: string; group: IdpGroupRow }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button ghost size="1">
          Rename
        </Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <Dialog.Header
              title="Rename group"
              description={`Sends a SCIM update for ${group.display_name} through the proxy.`}
            />
            <DirectoryField directoryId={directoryId} />
            <input name="intent" type="hidden" value="action" />
            <input name="action" type="hidden" value="rename-group" />
            <input name="groupId" type="hidden" value={group.id} />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor={`rename-group-${group.id}`}>Group name</FieldLabel>
              <TextField.Root
                autoFocus
                defaultValue={group.display_name}
                id={`rename-group-${group.id}`}
                name="displayName"
                required
              />
            </Flex>
            <Dialog.Footer>
              <Dialog.Close>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button color="purple" type="submit">
                Save changes
              </Button>
            </Dialog.Footer>
          </Flex>
        </Form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function DeleteGroupDialog({ directoryId, group }: { directoryId: string; group: IdpGroupRow }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger>
        <Button color="red" ghost size="1">
          Delete
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Content size="2">
        <Form method="post">
          <Flex direction="column" gap="5">
            <AlertDialog.Header
              title="Delete this group?"
              description={`The IdP will send a SCIM delete for ${group.display_name} through the proxy.`}
            />
            <DirectoryField directoryId={directoryId} />
            <input name="intent" type="hidden" value="action" />
            <input name="action" type="hidden" value="delete-group" />
            <input name="groupId" type="hidden" value={group.id} />
            <AlertDialog.Footer>
              <AlertDialog.Cancel>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action>
                <Button color="red" type="submit">
                  Delete group
                </Button>
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </Flex>
        </Form>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function ManageMembersDialog({
  directoryId,
  group,
  members,
  candidates,
}: {
  directoryId: string;
  group: IdpGroupRow;
  members: IdpMemberRow[];
  candidates: IdpUserRow[];
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button ghost size="1">
          Manage members
        </Button>
      </Dialog.Trigger>
      <Dialog.Content size="2">
        <Flex direction="column" gap="5">
          <Dialog.Header
            title={`Members of ${group.display_name}`}
            description="Adding or removing a member sends a SCIM PATCH for the group through the proxy."
          />

          <Flex direction="column" gap="2">
            <Text size="2" weight="medium">
              Current members
            </Text>
            {members.length === 0 ? (
              <Text color="gray" size="2">
                This group has no members yet.
              </Text>
            ) : (
              <Flex gap="2" wrap="wrap">
                {members.map((member) => (
                  <Form key={member.user_id} method="post">
                    <DirectoryField directoryId={directoryId} />
                    <input name="intent" type="hidden" value="action" />
                    <input name="action" type="hidden" value="remove-member" />
                    <input name="groupId" type="hidden" value={group.id} />
                    <input name="userId" type="hidden" value={member.user_id} />
                    <Button ghost size="1" type="submit">
                      {member.user_name} ✕
                    </Button>
                  </Form>
                ))}
              </Flex>
            )}
          </Flex>

          <Separator size="4" />

          <Form method="post">
            <Flex direction="column" gap="3">
              <DirectoryField directoryId={directoryId} />
              <input name="intent" type="hidden" value="action" />
              <input name="action" type="hidden" value="add-member" />
              <input name="groupId" type="hidden" value={group.id} />
              <FieldLabel htmlFor={`add-member-${group.id}`}>Add a member</FieldLabel>
              {candidates.length === 0 ? (
                <Text color="gray" size="2">
                  Every user is already a member of this group.
                </Text>
              ) : (
                <Flex gap="3">
                  <Select.Root name="userId" required>
                    <Select.Trigger id={`add-member-${group.id}`} placeholder="Choose a user" />
                    <Select.Content>
                      {candidates.map((user) => (
                        <Select.Item key={user.id} value={user.id}>
                          {user.user_name}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  <Button color="purple" type="submit">
                    Add member
                  </Button>
                </Flex>
              )}
            </Flex>
          </Form>

          <Dialog.Footer>
            <Dialog.Close>
              <Button>Done</Button>
            </Dialog.Close>
          </Dialog.Footer>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export default function PanelIdp() {
  const { directory, idpPublicUrl, proxyPublicUrl, users, groups, members, activity, auto } =
    useLoaderData<typeof loader>();
  const actionData = useActionData() as IdpActionData | undefined;
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const pendingIntent = navigation.formData?.get("intent");
  const pendingAction = navigation.formData?.get("action");
  const running = auto?.running === 1;
  const scimTarget = `${trimTrailingSlash(proxyPublicUrl)}/scim/v2`;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(id);
  }, [running, revalidator]);

  const membersByGroup = new Map<string, IdpMemberRow[]>();
  for (const member of members as IdpMemberRow[]) {
    const list = membersByGroup.get(member.group_id) ?? [];
    list.push(member);
    membersByGroup.set(member.group_id, list);
  }

  if (!directory) {
    return (
      <Flex direction="column" gap="4">
        <Heading as="h2" size="5">
          IdP simulator
        </Heading>
        <Card size="3">
          <EmptyState.Root
            title="No directory yet"
            subtitle="Create a directory on the Directories tab first. The simulated IdP authenticates to the proxy with that directory's token."
          />
        </Card>
      </Flex>
    );
  }

  const directoryId = directory.id;

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" gap="4" justify="between">
        <Flex direction="column" gap="1">
          <Heading as="h2" size="5">
            IdP simulator
          </Heading>
          <Text color="gray" size="2">
            A stateful stand-in for Okta. Every change here sends a real SCIM request through the
            proxy, exactly like a production identity provider would.
          </Text>
        </Flex>
        <Button loading={revalidator.state === "loading"} onClick={() => revalidator.revalidate()}>
          Refresh
        </Button>
      </Flex>

      {actionData?.error && (
        <Callout.Root color="red">
          <Callout.Text>{actionData.error}</Callout.Text>
        </Callout.Root>
      )}

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex align="center" gap="2">
            <CardHeader title={directory.name} />
            <ModeBadge mode={directory.mode} />
          </Flex>
          <Grid columns={{ initial: "1", sm: "2" }} gap="4">
            <Flex direction="column" gap="2">
              <Text color="gray" size="2" weight="medium">
                SCIM target
              </Text>
              <Code size="2" className="break-all">
                {scimTarget}
              </Code>
            </Flex>
            <Flex direction="column" gap="2">
              <Text color="gray" size="2" weight="medium">
                Simulator worker
              </Text>
              <Code size="2" className="break-all">
                {idpPublicUrl}
              </Code>
            </Flex>
          </Grid>
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Controls"
            description="Seed a starter directory, add resources by hand, or wipe everything to start over."
          />
          <Flex gap="3" wrap="wrap">
            <Form method="post">
              <DirectoryField directoryId={directoryId} />
              <input name="intent" type="hidden" value="seed" />
              <Button loading={pendingIntent === "seed"} type="submit">
                Seed directory
              </Button>
            </Form>
            <AddUserDialog directoryId={directoryId} pending={pendingAction === "create-user"} />
            <CreateGroupDialog
              directoryId={directoryId}
              pending={pendingAction === "create-group"}
            />
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button color="red">Reset simulator</Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content size="2">
                <Form method="post">
                  <Flex direction="column" gap="5">
                    <AlertDialog.Header
                      title="Reset the simulator?"
                      description="This wipes the simulated directory and activity feed and stops auto-run. It does not touch what the proxy already provisioned into WorkOS or the native app."
                    />
                    <DirectoryField directoryId={directoryId} />
                    <input name="intent" type="hidden" value="reset" />
                    <AlertDialog.Footer>
                      <AlertDialog.Cancel>
                        <Button>Cancel</Button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action>
                        <Button color="red" type="submit">
                          Reset simulator
                        </Button>
                      </AlertDialog.Action>
                    </AlertDialog.Footer>
                  </Flex>
                </Form>
              </AlertDialog.Content>
            </AlertDialog.Root>
          </Flex>
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex align="center" gap="2">
            <CardHeader title="Auto-run" />
            <Badge color={running ? "green" : "gray"}>{running ? "Running" : "Idle"}</Badge>
          </Flex>
          <Text color="gray" size="2">
            Auto-run churns the directory on a worker-side timer — creating, renaming, moving, and
            deactivating resources. It keeps running even if you close this tab. Watch the Native
            app and a directory's Activity tab converge as the SCIM traffic flows.
          </Text>
          {running ? (
            <Flex align="center" gap="3" justify="between" wrap="wrap">
              <Text size="2">
                {auto?.tick_count ?? 0} ticks so far, one every{" "}
                {((auto?.interval_ms ?? DEFAULT_INTERVAL_MS) / 1000).toString()} seconds.
              </Text>
              <Form method="post">
                <DirectoryField directoryId={directoryId} />
                <input name="intent" type="hidden" value="auto-stop" />
                <Button loading={pendingIntent === "auto-stop"} type="submit">
                  Stop auto-run
                </Button>
              </Form>
            </Flex>
          ) : (
            <Form method="post">
              <DirectoryField directoryId={directoryId} />
              <input name="intent" type="hidden" value="auto-start" />
              <Flex align="end" gap="3" wrap="wrap">
                <Flex direction="column" gap="2">
                  <FieldLabel htmlFor="idp-interval">Interval</FieldLabel>
                  <Select.Root defaultValue={String(DEFAULT_INTERVAL_MS)} name="intervalMs">
                    <Select.Trigger id="idp-interval" />
                    <Select.Content>
                      {INTERVAL_OPTIONS.map((option) => (
                        <Select.Item key={option.value} value={option.value}>
                          {option.label}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Flex>
                <Button color="purple" loading={pendingIntent === "auto-start"} type="submit">
                  Start auto-run
                </Button>
              </Flex>
            </Form>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Users"
            description="The simulated directory's users and their SCIM state."
          />
          {users.length === 0 ? (
            <EmptyState.Root
              title="No users yet"
              subtitle="Seed the directory or add a user to provision one through the proxy."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>User name</Table.ColumnHeader>
                    <Table.ColumnHeader>External id</Table.ColumnHeader>
                    <Table.ColumnHeader>Name</Table.ColumnHeader>
                    <Table.ColumnHeader>Status</Table.ColumnHeader>
                    <Table.ColumnHeader>SCIM id</Table.ColumnHeader>
                    <Table.ColumnHeader />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {users.map((user: IdpUserRow) => (
                    <Table.Row key={user.id}>
                      <Table.Cell>
                        <Text size="2" weight="medium">
                          {user.user_name}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        {user.external_id ? (
                          <Code size="1">{user.external_id}</Code>
                        ) : (
                          <Text color="gray" size="1">
                            —
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Text size="2">{fullName(user)}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Status color={user.active ? "green" : "gray"}>
                          {user.active ? "Active" : "Deactivated"}
                        </Status>
                      </Table.Cell>
                      <Table.Cell>
                        {user.scim_id ? (
                          <Code size="1">{user.scim_id}</Code>
                        ) : (
                          <Text color="gray" size="1">
                            —
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Flex align="center" gap="2" justify="end">
                          <Form method="post">
                            <DirectoryField directoryId={directoryId} />
                            <input name="intent" type="hidden" value="action" />
                            <input
                              name="action"
                              type="hidden"
                              value={user.active ? "deactivate-user" : "reactivate-user"}
                            />
                            <input name="userId" type="hidden" value={user.id} />
                            <Button ghost size="1" type="submit">
                              {user.active ? "Deactivate" : "Reactivate"}
                            </Button>
                          </Form>
                          <RenameUserDialog directoryId={directoryId} user={user} />
                          <DeleteUserDialog directoryId={directoryId} user={user} />
                        </Flex>
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
          <CardHeader
            title="Groups"
            description="The simulated directory's groups and their members."
          />
          {groups.length === 0 ? (
            <EmptyState.Root
              title="No groups yet"
              subtitle="Seed the directory or create a group to push one through the proxy."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Name</Table.ColumnHeader>
                    <Table.ColumnHeader>External id</Table.ColumnHeader>
                    <Table.ColumnHeader>Members</Table.ColumnHeader>
                    <Table.ColumnHeader>SCIM id</Table.ColumnHeader>
                    <Table.ColumnHeader />
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {groups.map((group: IdpGroupRow) => {
                    const groupMembers = membersByGroup.get(group.id) ?? [];
                    const memberIds = new Set(groupMembers.map((m) => m.user_id));
                    const candidates = (users as IdpUserRow[]).filter((u) => !memberIds.has(u.id));
                    return (
                      <Table.Row key={group.id}>
                        <Table.Cell>
                          <Text size="2" weight="medium">
                            {group.display_name}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          {group.external_id ? (
                            <Code size="1">{group.external_id}</Code>
                          ) : (
                            <Text color="gray" size="1">
                              —
                            </Text>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {groupMembers.length > 0 ? (
                            <Text size="2">{groupMembers.map((m) => m.user_name).join(", ")}</Text>
                          ) : (
                            <Text color="gray" size="1">
                              No members
                            </Text>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {group.scim_id ? (
                            <Code size="1">{group.scim_id}</Code>
                          ) : (
                            <Text color="gray" size="1">
                              —
                            </Text>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <Flex align="center" gap="2" justify="end">
                            <ManageMembersDialog
                              candidates={candidates}
                              directoryId={directoryId}
                              group={group}
                              members={groupMembers}
                            />
                            <RenameGroupDialog directoryId={directoryId} group={group} />
                            <DeleteGroupDialog directoryId={directoryId} group={group} />
                          </Flex>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.Root>
          )}
        </Flex>
      </Card>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader
            title="Activity"
            description="The last 50 SCIM calls the simulated IdP made through the proxy."
          />
          {activity.length === 0 ? (
            <EmptyState.Root
              title="No activity yet"
              subtitle="Seed the directory or add a user to see the simulated IdP's SCIM calls."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Time</Table.ColumnHeader>
                    <Table.ColumnHeader>Origin</Table.ColumnHeader>
                    <Table.ColumnHeader>Action</Table.ColumnHeader>
                    <Table.ColumnHeader>Subject</Table.ColumnHeader>
                    <Table.ColumnHeader>Request</Table.ColumnHeader>
                    <Table.ColumnHeader>Status</Table.ColumnHeader>
                    <Table.ColumnHeader>Detail</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {activity.map((entry: IdpActivity) => (
                    <Table.Row
                      key={entry.id}
                      style={entry.ok ? undefined : { backgroundColor: "var(--red-a2)" }}
                    >
                      <Table.Cell>
                        <Text color="gray" size="1" style={{ whiteSpace: "nowrap" }}>
                          {entry.ts}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge color={ORIGIN_BADGE_COLORS[entry.origin]}>{entry.origin}</Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Text size="2">{entry.action}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        {entry.subject ? (
                          <Text size="2">{entry.subject}</Text>
                        ) : (
                          <Text color="gray" size="1">
                            —
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {entry.method && entry.path ? (
                          <Code size="1" className="whitespace-nowrap">
                            {entry.method} {entry.path}
                          </Code>
                        ) : (
                          <Text color="gray" size="1">
                            —
                          </Text>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge color={entry.ok ? "green" : "red"}>
                          {entry.status != null ? entry.status : entry.ok ? "ok" : "error"}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Box maxWidth="280px">
                          <Text color="gray" size="1">
                            {entry.detail ?? ""}
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
