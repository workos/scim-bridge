import type { Route } from "./+types/listener";

import { Form, useFetcher, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { getConfig, setConfig } from "../../../workers/shared/db";
import { CopyButton, FieldLabel, trimTrailingSlash } from "./ui";
import { Badge } from "../../vendor/design-system/components/badge";
import { Box } from "../../vendor/design-system/components/box";
import { Button } from "../../vendor/design-system/components/button";
import { Card } from "../../vendor/design-system/components/card";
import { Code } from "../../vendor/design-system/components/code";
import { Flex } from "../../vendor/design-system/components/flex";
import { Heading } from "../../vendor/design-system/components/heading";
import { Separator } from "../../vendor/design-system/components/separator";
import { Switch } from "../../vendor/design-system/components/switch";
import { Text } from "../../vendor/design-system/components/text";
import * as TextField from "../../vendor/design-system/components/text-field";

/** Detect a running local ngrok tunnel via its inspection API. Returns the
 *  public https URL, or null when ngrok isn't running (or can't be reached —
 *  only works for a locally-running panel, which is the ngrok use case). */
async function detectNgrokTunnel(): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tunnels?: { public_url?: string; proto?: string }[] };
    const tunnels = body.tunnels ?? [];
    const url =
      tunnels.find((t) => t.proto === "https" && typeof t.public_url === "string")?.public_url ??
      tunnels.find((t) => typeof t.public_url === "string")?.public_url;
    return url ?? null;
  } catch {
    return null;
  }
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.cloudflare;
  const [mockEmit, webhookSecret, nativePublicUrl, tunnelUrl] = await Promise.all([
    getConfig(env.DB, "mock_workos.emit_dsync"),
    getConfig(env.DB, "native.webhook_secret"),
    getConfig(env.DB, "native.public_url"),
    detectNgrokTunnel(),
  ]);
  return {
    mockEmit: mockEmit !== "false",
    webhookSecret: webhookSecret ?? "",
    nativePublicUrl: nativePublicUrl ?? "",
    tunnelUrl,
  } as const;
}

export async function action({ context, request }: Route.ActionArgs) {
  const { env } = context.cloudflare;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "set-mock-emit") {
    await setConfig(
      env.DB,
      "mock_workos.emit_dsync",
      form.get("value") === "true" ? "true" : "false",
    );
    return {};
  }
  if (intent === "save-webhook-secret") {
    await setConfig(env.DB, "native.webhook_secret", String(form.get("value") ?? "").trim());
    return {};
  }
  if (intent === "use-tunnel-url") {
    const url = String(form.get("url") ?? "").trim();
    if (url) await setConfig(env.DB, "native.public_url", url);
    return {};
  }
  return { error: "That action is not recognized." };
}

export default function PanelListener() {
  const { mockEmit, webhookSecret, nativePublicUrl, tunnelUrl } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const savingSecret = useNavigation().formData?.get("intent") === "save-webhook-secret";
  const emitting =
    fetcher.formData?.get("intent") === "set-mock-emit"
      ? fetcher.formData.get("value") === "true"
      : mockEmit;
  const webhookUrl = `${trimTrailingSlash(nativePublicUrl || "http://localhost:8788")}/webhooks/dsync`;

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" gap="4" justify="between">
        <Flex direction="column" gap="1">
          <Heading as="h2" size="5">
            DSync listener
          </Heading>
          <Text color="gray" size="2">
            How the native app learns about changes after cutover — the webhook endpoint it exposes,
            the ngrok tunnel that reaches it, and its signing secret.
          </Text>
        </Flex>
        <Button loading={revalidator.state === "loading"} onClick={() => revalidator.revalidate()}>
          Refresh
        </Button>
      </Flex>

      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3" justify="between">
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium">
                Mock WorkOS emits DSync events
              </Text>
              <Text color="gray" size="2">
                On, the mock drives the listener so the cutover loop runs self-contained. Turn off
                when a real WorkOS directory delivers webhooks, so events aren't applied twice.
              </Text>
            </Flex>
            <Switch
              checked={emitting}
              onCheckedChange={(checked) =>
                fetcher.submit(
                  { intent: "set-mock-emit", value: checked ? "true" : "false" },
                  { method: "post" },
                )
              }
            />
          </Flex>

          <Separator size="4" />

          <Flex direction="column" gap="2">
            <FieldLabel>Webhook endpoint for WorkOS</FieldLabel>
            <Flex align="center" gap="2">
              <Code size="2">{webhookUrl}</Code>
              <CopyButton value={webhookUrl} />
            </Flex>
            <Text color="gray" size="2">
              Register this as the webhook URL in the WorkOS dashboard. For a real directory, point
              the base URL at your ngrok tunnel below.
            </Text>
          </Flex>

          <Separator size="4" />

          <Flex direction="column" gap="2">
            <Flex align="center" gap="2">
              <FieldLabel>ngrok tunnel</FieldLabel>
              <Badge color={tunnelUrl ? "green" : "gray"} variant="soft">
                {tunnelUrl ? "Detected" : "Not detected"}
              </Badge>
            </Flex>
            {tunnelUrl ? (
              <>
                <Flex align="center" gap="2">
                  <Code size="2">{tunnelUrl}</Code>
                  <CopyButton value={tunnelUrl} />
                </Flex>
                <Form method="post">
                  <input name="intent" type="hidden" value="use-tunnel-url" />
                  <input name="url" type="hidden" value={tunnelUrl} />
                  <Button type="submit" variant="soft">
                    Use for webhooks
                  </Button>
                </Form>
                <Text color="gray" size="2">
                  Points the native app's public URL at the tunnel, so the webhook endpoint above
                  targets it.
                </Text>
              </>
            ) : (
              <>
                <Text color="gray" size="2">
                  The panel runs in the Workers runtime and can't launch processes, so start the
                  tunnel to the native app in a terminal — this detects it on the next refresh:
                </Text>
                <Flex align="center" gap="2">
                  <Code size="2">npm run tunnel</Code>
                  <CopyButton value="npm run tunnel" />
                </Flex>
              </>
            )}
          </Flex>

          <Separator size="4" />

          <Form method="post">
            <input name="intent" type="hidden" value="save-webhook-secret" />
            <Flex direction="column" gap="2">
              <FieldLabel htmlFor="webhook-secret">WorkOS webhook signing secret</FieldLabel>
              <Flex align="center" gap="2">
                <Box className="grow">
                  <TextField.Root
                    defaultValue={webhookSecret}
                    id="webhook-secret"
                    name="value"
                    placeholder="wh_secret_…"
                  />
                </Box>
                <Button loading={savingSecret} type="submit" variant="soft">
                  Save secret
                </Button>
              </Flex>
              <Text color="gray" size="2">
                From the WorkOS dashboard when you create the webhook. While set, incoming webhooks
                are signature-verified; leave empty to accept unsigned local deliveries.
              </Text>
            </Flex>
          </Form>
        </Flex>
      </Card>
    </Flex>
  );
}
