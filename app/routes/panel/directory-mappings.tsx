import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import type { IdMapping } from "../../../workers/shared/types";
import { getDirectoryById, withD1Retry } from "../../../workers/shared/db";
import { Badge } from "../../vendor/design-system/components/badge";
import { Button } from "../../vendor/design-system/components/button";
import { Callout } from "../../vendor/design-system/components/callout";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import * as EmptyState from "../../vendor/design-system/components/empty-state";
import { Flex } from "../../vendor/design-system/components/flex";
import * as Table from "../../vendor/design-system/components/table";
import { Text } from "../../vendor/design-system/components/text";
import { CardHeader, trimTrailingSlash } from "./ui";

interface ScimResource {
  id?: string;
  externalId?: string;
}

/** Fetch how WorkOS reports each resource over SCIM, keyed by the id it returns
 *  (the migrated id, for a migrated directory). The value carries the external
 *  id WorkOS holds — present means the IdP key was imported alongside it. */
async function fetchWorkosIndex(
  url: string,
  token: string,
): Promise<{ reachable: boolean; byId: Record<string, { externalId: string | null }> }> {
  if (!url || !token) return { reachable: false, byId: {} };
  const base = trimTrailingSlash(url);
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const [uRes, gRes] = await Promise.all([
      fetch(`${base}/Users?count=200`, { headers }),
      fetch(`${base}/Groups?count=200`, { headers }),
    ]);
    if (!uRes.ok || !gRes.ok) return { reachable: false, byId: {} };
    const uBody = (await uRes.json()) as { Resources?: ScimResource[] };
    const gBody = (await gRes.json()) as { Resources?: ScimResource[] };
    const byId: Record<string, { externalId: string | null }> = {};
    for (const r of [...(uBody.Resources ?? []), ...(gBody.Resources ?? [])]) {
      if (typeof r.id === "string") {
        byId[r.id] = { externalId: typeof r.externalId === "string" ? r.externalId : null };
      }
    }
    return { reachable: true, byId };
  } catch {
    return { reachable: false, byId: {} };
  }
}

export async function loader({ context, params }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const directoryId = params.id ?? "";
  const [{ results }, directory] = await Promise.all([
    withD1Retry(() =>
      env.DB.prepare(
        "SELECT * FROM id_mappings WHERE directory_id = ? ORDER BY updated_at DESC, native_id, resource_type",
      )
        .bind(directoryId)
        .all<IdMapping>(),
    ),
    getDirectoryById(env.DB, directoryId),
  ]);
  const workos = directory
    ? await fetchWorkosIndex(directory.workos_url, directory.workos_token)
    : { reachable: false, byId: {} };
  return { mappings: results, workos } as const;
}

export default function DirectoryMappings() {
  const { mappings, workos } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  // fallback-post rows are the ones whose native↔WorkOS pairing only this table
  // records, so they are the ones that decide how much a lost database costs —
  // see docs/runbook.md#durable-storage. The rows are already loaded; this is a
  // filter, not another query.
  const fallbackPost = mappings.filter((mapping) => mapping.strategy === "fallback-post").length;

  return (
    <Card size="3">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="4" justify="between">
          <CardHeader
            title="Id mappings"
            description="How the proxy links each native resource to its WorkOS counterpart. WorkOS reports a migrated resource by the native id (the migrated-id contract) and imports the IdP external id alongside it."
          />
          <Button
            loading={revalidator.state === "loading"}
            onClick={() => revalidator.revalidate()}
          >
            Refresh
          </Button>
        </Flex>

        {fallbackPost > 0 && (
          <Callout.Root color="yellow">
            <Callout.Text>
              {fallbackPost} of {mappings.length} mappings are <Code>fallback-post</Code>: WorkOS
              minted those ids, so this table is the only record of the pairing. Losing the database
              costs a filter-and-repair round trip per resource on the next write — make sure
              DATABASE_PATH is on a volume that survives a restart.
            </Callout.Text>
          </Callout.Root>
        )}

        {!workos.reachable && mappings.length > 0 && (
          <Callout.Root color="yellow">
            <Callout.Text>
              The WorkOS endpoint didn't respond, so the WorkOS columns can't be confirmed live.
            </Callout.Text>
          </Callout.Root>
        )}

        {mappings.length === 0 ? (
          <EmptyState.Root
            title="No id mappings yet"
            subtitle="Mappings appear when dual-write or backfill mirrors resources."
          />
        ) : (
          <Table.Root>
            <Table.Content>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Resource</Table.ColumnHeader>
                  <Table.ColumnHeader>Native id</Table.ColumnHeader>
                  <Table.ColumnHeader>WorkOS id</Table.ColumnHeader>
                  <Table.ColumnHeader>External id in WorkOS</Table.ColumnHeader>
                  <Table.ColumnHeader>Strategy</Table.ColumnHeader>
                  <Table.ColumnHeader>Updated</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {mappings.map((mapping: IdMapping) => {
                  const inWorkos = workos.byId[mapping.workos_id];
                  return (
                    <Table.Row key={`${mapping.resource_type}:${mapping.native_id}`}>
                      <Table.Cell>
                        <Text size="2">{mapping.resource_type}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Code size="1">{mapping.native_id}</Code>
                      </Table.Cell>
                      <Table.Cell>
                        <Code size="1">{mapping.workos_id}</Code>
                      </Table.Cell>
                      <Table.Cell>
                        {!workos.reachable ? (
                          <Text color="gray" size="1">
                            —
                          </Text>
                        ) : !inWorkos ? (
                          <Badge color="red" variant="soft">
                            Not in WorkOS
                          </Badge>
                        ) : inWorkos.externalId ? (
                          <Flex align="center" gap="2">
                            <Badge color="green" variant="soft">
                              Imported
                            </Badge>
                            <Code size="1">{inWorkos.externalId}</Code>
                          </Flex>
                        ) : (
                          <Badge color="yellow" variant="soft">
                            Not imported
                          </Badge>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge color={mapping.strategy === "migrated-id" ? "green" : "yellow"}>
                          {mapping.strategy}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Text color="gray" size="1" style={{ whiteSpace: "nowrap" }}>
                          {mapping.updated_at}
                        </Text>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.Root>
        )}

        <Callout.Root color="gray">
          <Callout.Text>
            The WorkOS id shown is what the SCIM API returns — for a migrated directory that is the
            migrated id (the adopted native id), not WorkOS's internal <Code>directory_user</Code>{" "}
            id, which SCIM does not expose. A resource created directly in WorkOS after cutover
            would surface with a WorkOS-native id here.
          </Callout.Text>
        </Callout.Root>
      </Flex>
    </Card>
  );
}
