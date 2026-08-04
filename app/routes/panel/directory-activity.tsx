import type { Route } from "./+types/directory-activity";

import { useLoaderData, useRevalidator } from "react-router";
import { datastoreContext } from "../../context";
import type { ProxyLogEntry } from "../../../workers/shared/types";
import { withDatastoreRetry } from "../../../workers/shared/db";
import { Badge } from "../../vendor/design-system/components/badge";
import { Button } from "../../vendor/design-system/components/button";
import { Callout } from "../../vendor/design-system/components/callout";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import * as Dialog from "../../vendor/design-system/components/dialog";
import * as EmptyState from "../../vendor/design-system/components/empty-state";
import { Flex } from "../../vendor/design-system/components/flex";
import * as Table from "../../vendor/design-system/components/table";
import { Text } from "../../vendor/design-system/components/text";
import { CardHeader, formatBody, StatusCodeBadge } from "./ui";

export async function loader({ context, params }: Route.LoaderArgs) {
  const { results } = await withDatastoreRetry(() =>
    context
      .get(datastoreContext)
      .prepare("SELECT * FROM proxy_log WHERE directory_id = ? ORDER BY id DESC LIMIT 100")
      .bind(params.id ?? "")
      .all<ProxyLogEntry>(),
  );
  return { entries: results };
}

function BodySection({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <Flex direction="column" gap="1">
      <Text color="gray" size="1" weight="medium">
        {label}
      </Text>
      <pre className="m-0 max-h-72 overflow-auto rounded-[var(--radius-3)] bg-[var(--gray-a2)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {formatBody(value)}
      </pre>
    </Flex>
  );
}

function EntryDialog({ entry }: { entry: ProxyLogEntry }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button ghost size="1">
          Details
        </Button>
      </Dialog.Trigger>
      <Dialog.Content size="5">
        <Flex direction="column" gap="5">
          <Dialog.Header
            title={`${entry.method} ${entry.path}`}
            description={`${entry.ts} · ${entry.source} · ${entry.mode}`}
          />
          <Dialog.Body>
            <Flex direction="column" gap="4">
              {entry.error && (
                <Callout.Root color="red">
                  <Callout.Text>{entry.error}</Callout.Text>
                </Callout.Root>
              )}
              {entry.workos_request && (
                <Text size="2">
                  WorkOS request: <Code size="2">{entry.workos_request}</Code>
                </Text>
              )}
              <BodySection label="Request body" value={entry.request_body} />
              <BodySection
                label={`Native response${entry.native_status != null ? ` · ${entry.native_status}` : ""}`}
                value={entry.native_body}
              />
              <BodySection
                label={`WorkOS response${entry.workos_status != null ? ` · ${entry.workos_status}` : ""}`}
                value={entry.workos_body}
              />
              {!entry.error && !entry.request_body && !entry.native_body && !entry.workos_body && (
                <Text color="gray" size="2">
                  No bodies were recorded for this request.
                </Text>
              )}
            </Flex>
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Close>
              <Button>Close</Button>
            </Dialog.Close>
          </Dialog.Footer>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export default function DirectoryActivity() {
  const { entries } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="4" justify="between">
          <CardHeader
            title="Activity"
            description="The latest 100 requests the proxy handled for this directory, with both legs' outcomes."
          />
          <Button
            loading={revalidator.state === "loading"}
            onClick={() => revalidator.revalidate()}
          >
            Refresh
          </Button>
        </Flex>

        {entries.length === 0 ? (
          <EmptyState.Root
            title="No requests yet"
            subtitle="Entries appear as soon as the IdP or a backfill sends SCIM traffic through the proxy."
          />
        ) : (
          <Table.Root>
            <Table.Content>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Time</Table.ColumnHeader>
                  <Table.ColumnHeader>Source</Table.ColumnHeader>
                  <Table.ColumnHeader>Request</Table.ColumnHeader>
                  <Table.ColumnHeader>Mode</Table.ColumnHeader>
                  <Table.ColumnHeader>Native</Table.ColumnHeader>
                  <Table.ColumnHeader>WorkOS</Table.ColumnHeader>
                  <Table.ColumnHeader>Response</Table.ColumnHeader>
                  <Table.ColumnHeader />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {entries.map((entry: ProxyLogEntry) => {
                  const failed = entry.error != null || (entry.response_status ?? 0) >= 400;
                  return (
                    <Table.Row
                      key={entry.id}
                      style={failed ? { backgroundColor: "var(--red-a2)" } : undefined}
                    >
                      <Table.Cell>
                        <Text color="gray" size="1" style={{ whiteSpace: "nowrap" }}>
                          {entry.ts}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge color={entry.source === "backfill" ? "yellow" : "gray"}>
                          {entry.source}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Code size="1" className="whitespace-nowrap">
                          {entry.method} {entry.path}
                        </Code>
                      </Table.Cell>
                      <Table.Cell>
                        <Text color="gray" size="1">
                          {entry.mode}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <StatusCodeBadge status={entry.native_status} />
                      </Table.Cell>
                      <Table.Cell>
                        <Flex align="center" gap="2">
                          {entry.workos_request && (
                            <Code size="1" className="whitespace-nowrap">
                              {entry.workos_request}
                            </Code>
                          )}
                          <StatusCodeBadge status={entry.workos_status} />
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex align="center" gap="2">
                          <StatusCodeBadge status={entry.response_status} />
                          {entry.error != null && <Badge color="red">error</Badge>}
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <EntryDialog entry={entry} />
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
  );
}
