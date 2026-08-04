import type { Route } from "./+types/home";

import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  type CreatedDirectory,
  getConfig,
  insertDirectory,
  listDirectories,
  setConfig,
  setDirectoriesLogPersistence,
  setDirectoryMode,
} from "../../../workers/shared/db";
import { publishMintedToken } from "../../../workers/shared/client-tokens";
import { MODES, type Mode } from "../../../workers/shared/types";
import { Button } from "../../vendor/design-system/components/button";
import { Callout } from "../../vendor/design-system/components/callout";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import * as Dialog from "../../vendor/design-system/components/dialog";
import { Flex } from "../../vendor/design-system/components/flex";
import { Grid } from "../../vendor/design-system/components/grid";
import { Heading } from "../../vendor/design-system/components/heading";
import { Separator } from "../../vendor/design-system/components/separator";
import { Text } from "../../vendor/design-system/components/text";
import { TextArea } from "../../vendor/design-system/components/text-area";
import * as TextField from "../../vendor/design-system/components/text-field";
import { DirectoryTable } from "./directory-table";
import { CardHeader, CopyButton, FieldLabel, trimTrailingSlash } from "./ui";

interface HomeActionData {
  error?: string;
  settingsSaved?: boolean;
  imported?: number;
  importErrors?: string[];
}

interface CsvRow {
  name: string;
  native_url: string;
  native_token: string;
  workos_url: string;
  workos_token: string;
  workos_directory_id: string;
  proxy_token: string;
}

/** Parse the bulk-import CSV: one directory per line, columns in header order.
 *  A leading `name,...` header row is optional. Values must not contain commas
 *  (URLs and bearer tokens don't), so a simple split is sufficient. `proxy_token`
 *  trails the original six columns, so CSVs written against those import
 *  unchanged. */
function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const rows: CsvRow[] = [];
  lines.forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    if (i === 0 && cells[0]?.toLowerCase() === "name") return; // header
    const [
      name = "",
      native_url = "",
      native_token = "",
      workos_url = "",
      workos_token = "",
      workos_directory_id = "",
      proxy_token = "",
    ] = cells;
    rows.push({
      name,
      native_url,
      native_token,
      workos_url,
      workos_token,
      workos_directory_id,
      proxy_token,
    });
  });
  return rows;
}

/** An imported proxy token is a credential an IdP is already presenting, so a
 *  truncated paste would 401 every SCIM request instead of failing here. Real IdP
 *  tokens are far longer; this bound only catches a fat-fingered value. */
const MIN_PROXY_TOKEN_LENGTH = 16;

function proxyTokenError(token: string): string | null {
  if (!token || token.length >= MIN_PROXY_TOKEN_LENGTH) return null;
  return (
    `A proxy token must be at least ${MIN_PROXY_TOKEN_LENGTH} characters ` +
    `(received ${token.length}) — check the value wasn't truncated.`
  );
}

/** Both `proxy_token` and `workos_directory_id` are UNIQUE and an import is the
 *  one place a caller supplies either, so name which one collided. */
function directoryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unique/i.test(message)) {
    if (/proxy_token/i.test(message)) {
      return "That proxy token already belongs to another directory — it is the key the proxy routes on, so no two directories can share one.";
    }
    if (/workos_directory_id/i.test(message)) {
      return "That WorkOS directory id is already assigned to another directory.";
    }
  }
  return message;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.cloudflare;
  const [directories, proxyPublicUrl, nativePublicUrl, nativeScimToken, mockWorkosToken] =
    await Promise.all([
      listDirectories(env.DB),
      getConfig(env.DB, "proxy.public_url"),
      getConfig(env.DB, "native.public_url"),
      getConfig(env.DB, "native.scim_token"),
      getConfig(env.DB, "mock_workos.scim_token"),
    ]);

  return {
    directories,
    proxyPublicUrl: proxyPublicUrl ?? "",
    nativePublicUrl: nativePublicUrl ?? "",
    nativeScimToken: nativeScimToken ?? "",
    mockWorkosToken: mockWorkosToken ?? "",
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env, demoMode } = context.cloudflare;
  const form = await request.formData();
  const intent = form.get("intent");
  const field = (key: string) => String(form.get(key) ?? "").trim();

  if (intent === "create-directory") {
    const name = field("name");
    if (!name) {
      return { error: "The directory needs a name before it can be created." };
    }
    const proxyToken = field("proxy_token");
    const tokenError = proxyTokenError(proxyToken);
    if (tokenError) {
      return { error: tokenError };
    }
    let created: CreatedDirectory;
    try {
      created = await insertDirectory(env.DB, {
        name,
        native_url: field("native_url"),
        native_token: field("native_token"),
        workos_url: field("workos_url"),
        workos_token: field("workos_token"),
        workos_directory_id: field("workos_directory_id"),
        proxy_token: proxyToken,
      });
    } catch (error) {
      return { error: directoryError(error) };
    }
    // The minted token is readable here and nowhere afterwards (ENT-6742). Showing
    // it at mint is the held half of the ticket, so this keeps today's redirect and
    // the operator recovers the token by rotating on the directory page.
    //
    // Only a bundled simulator gets a plaintext copy; see publishMintedToken.
    await publishMintedToken(env.DB, created.id, created.proxy_token, { demoMode });
    return redirect(`/panel/directories/${created.id}`);
  }

  if (intent === "bulk-import") {
    const rows = parseCsv(field("csv"));
    if (rows.length === 0) {
      return { error: "No directories found in the CSV. Add one directory per line." };
    }
    let imported = 0;
    const importErrors: string[] = [];
    for (const [i, r] of rows.entries()) {
      if (!r.name) {
        importErrors.push(`Row ${i + 1}: missing a name in the first column.`);
        continue;
      }
      const tokenError = proxyTokenError(r.proxy_token);
      if (tokenError) {
        importErrors.push(`Row ${i + 1} (${r.name}): ${tokenError}`);
        continue;
      }
      try {
        const created = await insertDirectory(env.DB, r);
        await publishMintedToken(env.DB, created.id, created.proxy_token, { demoMode });
        imported++;
      } catch (error) {
        importErrors.push(`Row ${i + 1} (${r.name}): ${directoryError(error)}`);
      }
    }
    return { imported, importErrors };
  }

  if (intent === "bulk-set-mode") {
    const mode = field("mode");
    if (!MODES.includes(mode as Mode)) {
      return { error: "Choose a valid target mode." };
    }
    const ids = field("ids")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      await setDirectoryMode(env.DB, id, mode as Mode);
    }
    return { bulkUpdated: ids.length, bulkMode: mode };
  }

  if (intent === "bulk-set-log-persistence") {
    const ids = field("ids")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await setDirectoriesLogPersistence(env.DB, ids, field("on") === "true");
    return { bulkUpdated: ids.length };
  }

  if (intent === "save-settings") {
    const proxyPublicUrl = field("proxy_public_url");
    const nativePublicUrl = field("native_public_url");
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

function CredentialFields() {
  return (
    <Flex direction="column" gap="4">
      <Text color="gray" size="1">
        SCIM credentials — optional now, and editable later on the directory page. The directory
        starts in passthrough, so it stays inert until you advance the mode.
      </Text>
      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        <Flex direction="column" gap="2">
          <FieldLabel htmlFor="native-url">Native SCIM base URL</FieldLabel>
          <TextField.Root id="native-url" name="native_url" placeholder="https://.../scim/v2" />
        </Flex>
        <Flex direction="column" gap="2">
          <FieldLabel htmlFor="native-token">Native SCIM token</FieldLabel>
          <TextField.Root id="native-token" name="native_token" placeholder="Bearer token" />
        </Flex>
        <Flex direction="column" gap="2">
          <FieldLabel htmlFor="workos-url">WorkOS directory endpoint</FieldLabel>
          <TextField.Root
            id="workos-url"
            name="workos_url"
            placeholder="https://api.workos.com/scim/v2.0/..."
          />
        </Flex>
        <Flex direction="column" gap="2">
          <FieldLabel htmlFor="workos-token">WorkOS bearer token</FieldLabel>
          <TextField.Root id="workos-token" name="workos_token" placeholder="Bearer token" />
        </Flex>
        <Flex direction="column" gap="2">
          <FieldLabel htmlFor="workos-directory-id">WorkOS directory id</FieldLabel>
          <TextField.Root
            id="workos-directory-id"
            name="workos_directory_id"
            placeholder="directory_01…"
          />
        </Flex>
      </Grid>
    </Flex>
  );
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
  const { directories, proxyPublicUrl, nativePublicUrl, nativeScimToken, mockWorkosToken } =
    useLoaderData<typeof loader>();
  const actionData = useActionData() as HomeActionData | undefined;
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const mockWorkosUrl = `${trimTrailingSlash(nativePublicUrl)}/mock-workos/scim/v2`;

  return (
    <Flex direction="column" gap="5">
      <Flex align="center" justify="between">
        <Heading as="h2" size="5">
          Directories
        </Heading>
        <Flex gap="3">
          <Dialog.Root>
            <Dialog.Trigger>
              <Button variant="outline">Bulk import</Button>
            </Dialog.Trigger>
            <Dialog.Content size="2">
              <Form method="post">
                <Flex direction="column" gap="5">
                  <Dialog.Header
                    title="Bulk import directories"
                    description="One directory per line. Columns: name, native SCIM URL, native token, WorkOS endpoint, WorkOS token, WorkOS directory id, proxy token. Only the name is required; the rest can be filled per directory later."
                    error={actionData?.error}
                  />
                  <input type="hidden" name="intent" value="bulk-import" />
                  <Flex direction="column" gap="2">
                    <FieldLabel htmlFor="csv">CSV</FieldLabel>
                    <TextArea
                      id="csv"
                      name="csv"
                      resize="vertical"
                      rows={8}
                      placeholder={
                        "name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token\n" +
                        "Acme — Okta,https://acme.com/scim/v2,tok_native,https://api.workos.com/scim/v2.0/xxx,tok_workos,directory_01XXX,tok_idp_existing"
                      }
                    />
                    <Text color="gray" size="1">
                      A leading header row is optional. Values must not contain commas. Leave the
                      last column off to mint a proxy token per directory; fill it in with the
                      bearer token that directory's IdP already presents.
                    </Text>
                  </Flex>
                  <Dialog.Footer>
                    <Dialog.Close>
                      <Button>Cancel</Button>
                    </Dialog.Close>
                    <Button color="purple" loading={pendingIntent === "bulk-import"} type="submit">
                      Import directories
                    </Button>
                  </Dialog.Footer>
                </Flex>
              </Form>
            </Dialog.Content>
          </Dialog.Root>

          <Dialog.Root>
            <Dialog.Trigger>
              <Button color="purple">Import directory</Button>
            </Dialog.Trigger>
            <Dialog.Content size="3">
              <Form method="post">
                <Flex direction="column" gap="5">
                  <Dialog.Header
                    title="Import directory"
                    description="A new directory starts in passthrough mode, with a freshly minted proxy token unless you bring the one its IdP already uses."
                    error={actionData?.error}
                  />
                  <input type="hidden" name="intent" value="create-directory" />
                  <Flex direction="column" gap="2">
                    <FieldLabel htmlFor="directory-name">Name</FieldLabel>
                    <TextField.Root
                      autoFocus
                      id="directory-name"
                      name="name"
                      placeholder="Acme Corp — Okta"
                      required
                    />
                  </Flex>
                  <Flex direction="column" gap="2">
                    <FieldLabel htmlFor="proxy-token">Existing IdP bearer token</FieldLabel>
                    <TextField.Root
                      id="proxy-token"
                      name="proxy_token"
                      placeholder="The token the IdP already sends"
                    />
                    <Text color="gray" size="1">
                      Only when you point an existing SCIM hostname at the bridge by DNS and the IdP
                      keeps its current token. Leave blank to mint a new one for the IdP to use.
                    </Text>
                  </Flex>
                  <Separator size="4" />
                  <CredentialFields />
                  <Dialog.Footer>
                    <Dialog.Close>
                      <Button>Cancel</Button>
                    </Dialog.Close>
                    <Button
                      color="purple"
                      loading={pendingIntent === "create-directory"}
                      type="submit"
                    >
                      Import directory
                    </Button>
                  </Dialog.Footer>
                </Flex>
              </Form>
            </Dialog.Content>
          </Dialog.Root>
        </Flex>
      </Flex>

      {actionData?.imported !== undefined && (
        <Callout.Root color={actionData.importErrors?.length ? "yellow" : "green"}>
          <Callout.Text>
            Imported {actionData.imported} {actionData.imported === 1 ? "directory" : "directories"}
            .
            {actionData.importErrors?.length
              ? ` ${actionData.importErrors.length} row(s) failed: ${actionData.importErrors.join("; ")}`
              : ""}
          </Callout.Text>
        </Callout.Root>
      )}

      <DirectoryTable directories={directories} />

      <Card size="3">
        <Flex direction="column" gap="5">
          <CardHeader
            title="Global settings"
            description="Public base URLs feed the copy-paste values below and on each directory page. Tokens are minted by the migration and read-only here."
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
