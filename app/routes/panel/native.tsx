import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation, useRevalidator } from "react-router";
import type { ListenerEvent } from "../../../workers/shared/types";
import { clearNativeDirectory, withD1Retry } from "../../../workers/shared/db";
import * as AlertDialog from "../../vendor/design-system/components/alert-dialog";
import { Badge } from "../../vendor/design-system/components/badge";
import { Button } from "../../vendor/design-system/components/button";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import * as EmptyState from "../../vendor/design-system/components/empty-state";
import { Flex } from "../../vendor/design-system/components/flex";
import { Heading } from "../../vendor/design-system/components/heading";
import { Status } from "../../vendor/design-system/components/status";
import * as Table from "../../vendor/design-system/components/table";
import { Text } from "../../vendor/design-system/components/text";
import { CardHeader } from "./ui";

export async function action({ context, request }: ActionFunctionArgs) {
  const { env } = context.cloudflare;
  const form = await request.formData();
  if (form.get("intent") === "reset-native") {
    await clearNativeDirectory(env.DB);
  }
  return {};
}

interface NativeUserRow {
  id: string;
  user_name: string;
  external_id: string | null;
  active: number;
}

interface NativeGroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
}

interface MemberRow {
  group_id: string;
  user_name: string;
}

const ACTION_BADGE_COLORS = {
  applied: "green",
  skipped: "gray",
  ignored: "yellow",
} as const;

export async function loader({ context }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const [users, groups, members, events] = await Promise.all([
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT id, user_name, external_id, active FROM native_users ORDER BY user_name",
      ).all<NativeUserRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT id, display_name, external_id FROM native_groups ORDER BY display_name",
      ).all<NativeGroupRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT gm.group_id AS group_id, u.user_name AS user_name " +
          "FROM native_group_members gm JOIN native_users u ON u.id = gm.user_id " +
          "ORDER BY u.user_name",
      ).all<MemberRow>(),
    ),
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT * FROM listener_events ORDER BY id DESC LIMIT 50",
      ).all<ListenerEvent>(),
    ),
  ]);

  return {
    users: users.results,
    groups: groups.results,
    members: members.results,
    events: events.results,
  };
}

function ResetNativeDialog() {
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
              description="Deletes every user and group from the customer app's directory, plus its DSync listener log. The proxy connection, id mappings, and the WorkOS side are left untouched — this only clears what the customer app itself holds."
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

export default function PanelNative() {
  const { users, groups, members, events } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  const membersByGroup = new Map<string, string[]>();
  for (const member of members as MemberRow[]) {
    const names = membersByGroup.get(member.group_id) ?? [];
    names.push(member.user_name);
    membersByGroup.set(member.group_id, names);
  }

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" gap="4" justify="between">
        <Flex direction="column" gap="1">
          <Heading as="h2" size="5">
            Native app
          </Heading>
          <Text color="gray" size="2">
            The customer's own directory tables — written by its SCIM handler before cutover and by
            its DSync event listener after.
          </Text>
        </Flex>
        <Flex gap="3">
          <ResetNativeDialog />
          <Button
            loading={revalidator.state === "loading"}
            onClick={() => revalidator.revalidate()}
          >
            Refresh
          </Button>
        </Flex>
      </Flex>

      <Card size="3">
        <Flex direction="column" gap="4">
          <CardHeader title="Users" />
          {users.length === 0 ? (
            <EmptyState.Root
              title="No users yet"
              subtitle="Users appear once the IdP provisions them through the proxy."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>User name</Table.ColumnHeader>
                    <Table.ColumnHeader>External id</Table.ColumnHeader>
                    <Table.ColumnHeader>Status</Table.ColumnHeader>
                    <Table.ColumnHeader>Id</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {users.map((user: NativeUserRow) => (
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
                        <Status color={user.active ? "green" : "red"}>
                          {user.active ? "Active" : "Deactivated"}
                        </Status>
                      </Table.Cell>
                      <Table.Cell>
                        <Code size="1">{user.id}</Code>
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
          <CardHeader title="Groups" />
          {groups.length === 0 ? (
            <EmptyState.Root
              title="No groups yet"
              subtitle="Groups appear once the IdP pushes them through the proxy."
            />
          ) : (
            <Table.Root>
              <Table.Content>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>Name</Table.ColumnHeader>
                    <Table.ColumnHeader>External id</Table.ColumnHeader>
                    <Table.ColumnHeader>Members</Table.ColumnHeader>
                    <Table.ColumnHeader>Id</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {groups.map((group: NativeGroupRow) => {
                    const memberNames = membersByGroup.get(group.id) ?? [];
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
                          {memberNames.length > 0 ? (
                            <Text size="2">{memberNames.join(", ")}</Text>
                          ) : (
                            <Text color="gray" size="1">
                              No members
                            </Text>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <Code size="1">{group.id}</Code>
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
            title="Listener events"
            description="The last 50 DSync events the native listener received: applied (state transition), skipped (no transition), or ignored."
          />
          {events.length === 0 ? (
            <EmptyState.Root
              title="No events yet"
              subtitle="Events appear once WorkOS starts delivering DSync webhooks to the native listener."
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
                        <Text color="gray" size="1">
                          {event.detail ?? ""}
                        </Text>
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
