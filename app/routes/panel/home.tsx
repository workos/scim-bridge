import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { getConfig, listConnections, setConfig, withD1Retry } from "../../../workers/shared/db";
import { Button } from "../../vendor/design-system/components/button";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import * as Dialog from "../../vendor/design-system/components/dialog";
import * as EmptyState from "../../vendor/design-system/components/empty-state";
import { Flex } from "../../vendor/design-system/components/flex";
import { Grid } from "../../vendor/design-system/components/grid";
import { Heading } from "../../vendor/design-system/components/heading";
import { Separator } from "../../vendor/design-system/components/separator";
import { Text } from "../../vendor/design-system/components/text";
import * as TextField from "../../vendor/design-system/components/text-field";
import { CardHeader, CopyButton, FieldLabel, ModeBadge, trimTrailingSlash } from "./ui";

interface HomeActionData {
  error?: string;
  settingsSaved?: boolean;
}

export async function loader({ context }: LoaderFunctionArgs) {
  const { env } = context.cloudflare;
  const [connections, proxyPublicUrl, nativePublicUrl, nativeScimToken, mockWorkosToken] =
    await Promise.all([
      listConnections(env.DB),
      getConfig(env.DB, "proxy.public_url"),
      getConfig(env.DB, "native.public_url"),
      getConfig(env.DB, "native.scim_token"),
      getConfig(env.DB, "mock_workos.scim_token"),
    ]);

  return {
    connections,
    proxyPublicUrl: proxyPublicUrl ?? "",
    nativePublicUrl: nativePublicUrl ?? "",
    nativeScimToken: nativeScimToken ?? "",
    mockWorkosToken: mockWorkosToken ?? "",
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { env } = context.cloudflare;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create-connection") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) {
      return { error: "The connection needs a name before it can be created." };
    }
    const row = await withD1Retry(() =>
      env.DB.prepare("INSERT INTO scim_connections (name) VALUES (?) RETURNING id")
        .bind(name)
        .first<{ id: string }>(),
    );
    if (!row) {
      return {
        error: "The connection could not be created. Check the D1 database and retry.",
      };
    }
    return redirect(`/panel/connections/${row.id}`);
  }

  if (intent === "save-settings") {
    const proxyPublicUrl = String(form.get("proxy_public_url") ?? "").trim();
    const nativePublicUrl = String(form.get("native_public_url") ?? "").trim();
    if (!proxyPublicUrl || !nativePublicUrl) {
      return {
        error:
          "The proxy public URL and native app public URL are both required — clearing them would break every copy-paste value on this page.",
      };
    }
    await setConfig(env.DB, "proxy.public_url", proxyPublicUrl);
    await setConfig(env.DB, "native.public_url", nativePublicUrl);
    return { settingsSaved: true };
  }

  return { error: "That form action is not recognized." };
}

function TokenRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Flex direction="column" gap="2">
      <Text color="gray" size="2" weight="medium">
        {label}
      </Text>
      <Flex align="center" gap="2">
        <Code size="2" className="break-all">
          {value || "(not set)"}
        </Code>
        {value && <CopyButton value={value} />}
      </Flex>
      {hint && (
        <Text color="gray" size="1">
          {hint}
        </Text>
      )}
    </Flex>
  );
}

export default function PanelHome() {
  const { connections, proxyPublicUrl, nativePublicUrl, nativeScimToken, mockWorkosToken } =
    useLoaderData<typeof loader>();
  const actionData = useActionData() as HomeActionData | undefined;
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const mockWorkosUrl = `${trimTrailingSlash(nativePublicUrl)}/mock-workos/scim/v2`;

  return (
    <Flex direction="column" gap="5">
      <Flex align="center" justify="between">
        <Heading as="h2" size="5">
          Connections
        </Heading>
        <Dialog.Root>
          <Dialog.Trigger>
            <Button color="purple">Create connection</Button>
          </Dialog.Trigger>
          <Dialog.Content size="2">
            <Form method="post">
              <Flex direction="column" gap="5">
                <Dialog.Header
                  title="Create connection"
                  description="A new connection starts in passthrough mode with a freshly minted proxy token."
                  error={actionData?.error}
                />
                <input type="hidden" name="intent" value="create-connection" />
                <Flex direction="column" gap="2">
                  <FieldLabel htmlFor="connection-name">Name</FieldLabel>
                  <TextField.Root
                    autoFocus
                    id="connection-name"
                    name="name"
                    placeholder="Acme Corp — Okta"
                    required
                  />
                </Flex>
                <Dialog.Footer>
                  <Dialog.Close>
                    <Button>Cancel</Button>
                  </Dialog.Close>
                  <Button
                    color="purple"
                    loading={pendingIntent === "create-connection"}
                    type="submit"
                  >
                    Create connection
                  </Button>
                </Dialog.Footer>
              </Flex>
            </Form>
          </Dialog.Content>
        </Dialog.Root>
      </Flex>

      {connections.length === 0 ? (
        <Card size="3">
          <EmptyState.Root
            title="No connections yet"
            subtitle="Create a connection to mint the proxy token the IdP will authenticate with."
          />
        </Card>
      ) : (
        <Flex direction="column" gap="3">
          {connections.map((connection) => (
            <Card key={connection.id} size="3">
              <Flex align="center" gap="4" justify="between">
                <Flex direction="column" gap="1">
                  <Flex align="center" gap="2">
                    <Heading as="h3" size="4">
                      {connection.name}
                    </Heading>
                    <ModeBadge mode={connection.mode} />
                  </Flex>
                  <Text color="gray" size="2">
                    <Code size="1">{connection.id}</Code> · created {connection.created_at}
                  </Text>
                </Flex>
                <Button asChild type={null}>
                  <Link to={`/panel/connections/${connection.id}`}>Open</Link>
                </Button>
              </Flex>
            </Card>
          ))}
        </Flex>
      )}

      <Card size="3">
        <Flex direction="column" gap="5">
          <CardHeader
            title="Global settings"
            description="Public base URLs feed the copy-paste values below and on each connection page. Tokens are minted by the migration and read-only here."
          />
          <Form method="post">
            <input type="hidden" name="intent" value="save-settings" />
            <Flex direction="column" gap="4">
              <Grid columns={{ initial: "1", sm: "2" }} gap="4">
                <Flex direction="column" gap="2">
                  <FieldLabel htmlFor="proxy-public-url">Proxy public URL</FieldLabel>
                  <TextField.Root
                    defaultValue={proxyPublicUrl}
                    id="proxy-public-url"
                    name="proxy_public_url"
                    placeholder="http://localhost:8787"
                    required
                  />
                </Flex>
                <Flex direction="column" gap="2">
                  <FieldLabel htmlFor="native-public-url">Native app public URL</FieldLabel>
                  <TextField.Root
                    defaultValue={nativePublicUrl}
                    id="native-public-url"
                    name="native_public_url"
                    placeholder="http://localhost:8788"
                    required
                  />
                </Flex>
              </Grid>
              <Flex align="center" gap="3" justify="end">
                {actionData?.error && (
                  <Text color="red" size="2">
                    {actionData.error}
                  </Text>
                )}
                {actionData?.settingsSaved && (
                  <Text color="green" size="2">
                    Settings saved.
                  </Text>
                )}
                <Button loading={pendingIntent === "save-settings"} type="submit">
                  Save settings
                </Button>
              </Flex>
            </Flex>
          </Form>
          <Separator size="4" />
          <Grid columns={{ initial: "1", sm: "2" }} gap="4">
            <TokenRow label="Native SCIM bearer token" value={nativeScimToken} />
            <TokenRow
              label="Mock WorkOS bearer token"
              value={mockWorkosToken}
              hint={`Mock endpoint: ${mockWorkosUrl}`}
            />
          </Grid>
        </Flex>
      </Card>
    </Flex>
  );
}
