import type { Route } from "./+types/listener";

import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { datastoreContext } from "../../context";
import { getConfig, setConfig } from "../../../workers/shared/db";
import { EVENTS_CURSOR_KEY } from "../../../workers/native/events-poller";
import {
  EVENTS_API_KEY_CONFIG_KEY,
  EVENTS_TARGET_KEY,
  EVENTS_TRANSPORT_KEY,
  EVENTS_URL_KEY,
  clearEventsApiKey,
  eventsPollerController,
  setEventsPollTarget,
  setEventsTransport,
  storeEventsApiKey,
  type TransportActionOptions,
} from "../../../workers/native/events-transport";
import { CopyButton, FieldLabel, trimTrailingSlash } from "./ui";
import {
  Box,
  Card,
  Code,
  Flex,
  Heading,
  SegmentedControl,
  Separator,
  Switch,
  Text,
  TextField,
} from "@radix-ui/themes";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";

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

/** The live poller controller plus what a transport action must know. Env is
 *  read here (server-side) so the check works even under `npm run dev`, where
 *  no controller is registered. */
function transportOptions(): TransportActionOptions {
  const controller = eventsPollerController();
  return {
    controller,
    envKeyConfigured:
      controller?.status().envKeyConfigured ?? Boolean(process.env.WORKOS_API_KEY?.trim()),
  };
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = context.get(datastoreContext);
  const [mockEmit, webhookSecret, nativePublicUrl, tunnelUrl] = await Promise.all([
    getConfig(db, "mock_workos.emit_dsync"),
    getConfig(db, "native.webhook_secret"),
    getConfig(db, "native.public_url"),
    detectNgrokTunnel(),
  ]);
  const [transportChoice, targetChoice, eventsUrl, storedKey, cursor] = await Promise.all([
    getConfig(db, EVENTS_TRANSPORT_KEY),
    getConfig(db, EVENTS_TARGET_KEY),
    getConfig(db, EVENTS_URL_KEY),
    getConfig(db, EVENTS_API_KEY_CONFIG_KEY),
    getConfig(db, EVENTS_CURSOR_KEY),
  ]);
  const opts = transportOptions();
  const poller = opts.controller?.status() ?? null;
  return {
    mockEmit: mockEmit !== "false",
    webhookSecret: webhookSecret ?? "",
    nativePublicUrl: nativePublicUrl ?? "",
    tunnelUrl,
    transport:
      transportChoice === "webhook" || transportChoice === "poll"
        ? transportChoice
        : (poller?.transport ?? "poll"),
    // The controller's resolved target when it is actually polling, then the
    // persisted choice, then the boot default — never a bare "mock", which
    // could show the wrong selection on a demo whose env URL isn't the mock.
    pollTarget:
      poller?.target ??
      (targetChoice === "workos" || targetChoice === "mock"
        ? targetChoice
        : (poller?.defaultTarget ?? "mock")),
    eventsUrl: eventsUrl ?? "https://api.workos.com",
    // Presence only — the stored key itself is never sent to the page.
    storedKeyConfigured: Boolean(storedKey),
    envKeyConfigured: opts.envKeyConfigured,
    cursor,
    poller: poller && {
      running: poller.running,
      baseUrl: poller.baseUrl,
      keySource: poller.keySource,
      lastPollAt: poller.lastPollAt,
      lastError: poller.lastError,
      intervalMs: poller.intervalMs,
    },
  } as const;
}

export async function action({ context, request }: Route.ActionArgs) {
  const db = context.get(datastoreContext);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "set-mock-emit") {
    await setConfig(db, "mock_workos.emit_dsync", form.get("value") === "true" ? "true" : "false");
    return {};
  }
  if (intent === "save-webhook-secret") {
    await setConfig(db, "native.webhook_secret", String(form.get("value") ?? "").trim());
    return {};
  }
  if (intent === "use-tunnel-url") {
    const url = String(form.get("url") ?? "").trim();
    if (url) await setConfig(db, "native.public_url", url);
    return {};
  }
  if (intent === "set-transport") {
    return setEventsTransport(db, transportOptions(), String(form.get("value") ?? ""));
  }
  if (intent === "set-poll-target") {
    return setEventsPollTarget(db, transportOptions(), {
      target: String(form.get("target") ?? ""),
      url: String(form.get("url") ?? ""),
    });
  }
  if (intent === "store-events-api-key") {
    return storeEventsApiKey(db, transportOptions(), String(form.get("value") ?? ""));
  }
  if (intent === "clear-events-api-key") {
    return clearEventsApiKey(db, transportOptions());
  }
  return { error: "That action is not recognized." };
}

export default function PanelListener() {
  const {
    mockEmit,
    webhookSecret,
    nativePublicUrl,
    tunnelUrl,
    transport,
    pollTarget,
    eventsUrl,
    storedKeyConfigured,
    envKeyConfigured,
    cursor,
    poller,
  } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const fetcher = useFetcher<typeof action>();
  const transportFetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const savingSecret = navigation.formData?.get("intent") === "save-webhook-secret";
  const savingKey = navigation.formData?.get("intent") === "store-events-api-key";
  const emitting =
    fetcher.formData?.get("intent") === "set-mock-emit"
      ? fetcher.formData.get("value") === "true"
      : mockEmit;
  // Optimistic while the flip is in flight, and honest again once it lands —
  // a refused flip (e.g. keyless real-WorkOS target) snaps the control back.
  const shownTransport =
    transportFetcher.state !== "idle" &&
    transportFetcher.formData?.get("intent") === "set-transport"
      ? String(transportFetcher.formData.get("value"))
      : transport;
  const shownTarget =
    transportFetcher.state !== "idle" &&
    transportFetcher.formData?.get("intent") === "set-poll-target"
      ? String(transportFetcher.formData.get("target"))
      : pollTarget;
  // Toggle errors arrive on the fetcher; the URL/key form posts navigate, so
  // theirs arrive as action data. The fetcher's LATEST result wins whenever it
  // has one — a successful toggle returns {} and must clear a stale navigation
  // error, which `??` would resurrect.
  const actionData = useActionData<typeof action>();
  const transportError = transportFetcher.data ? transportFetcher.data.error : actionData?.error;
  const webhookUrl = `${trimTrailingSlash(nativePublicUrl || "http://localhost:8788")}/webhooks/dsync`;
  const keyBadge = envKeyConfigured
    ? { color: "green" as const, label: "Configured (env)" }
    : storedKeyConfigured
      ? { color: "green" as const, label: "Configured (panel)" }
      : { color: "gray" as const, label: "Not set" };

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" gap="4" justify="between">
        <Flex direction="column" gap="1">
          <Heading as="h2" size="5">
            DSync listener
          </Heading>
          <Text color="gray" size="2">
            How the native app learns about changes after cutover — the transport it relies on
            (webhook push or Events API polling), the webhook endpoint it exposes, the ngrok tunnel
            that reaches it, and its signing secret.
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
                Transport
              </Text>
              <Text color="gray" size="2">
                Webhooks are pushed and can arrive out of order; the Events API is polled in order
                behind a cursor. Webhook deliveries are accepted in both positions — duplicates are
                dropped by event id — so this switches which transport the demo relies on, not a
                mute of the other.
              </Text>
            </Flex>
            <SegmentedControl.Root
              onValueChange={(value) =>
                transportFetcher.submit({ intent: "set-transport", value }, { method: "post" })
              }
              value={shownTransport}
            >
              <SegmentedControl.Item value="webhook">Webhooks (push)</SegmentedControl.Item>
              <SegmentedControl.Item value="poll">Events API (poll)</SegmentedControl.Item>
            </SegmentedControl.Root>
          </Flex>

          <Separator size="4" />

          <Flex direction="column" gap="2">
            <Flex align="center" gap="2">
              <FieldLabel>Poller</FieldLabel>
              <Badge color={poller?.running ? "green" : "gray"} variant="soft">
                {poller ? (poller.running ? "Running" : "Stopped") : "Not in this process"}
              </Badge>
              {poller?.keySource ? (
                <Badge color="blue" variant="soft">
                  {poller.keySource === "mock"
                    ? "mock token (keyless)"
                    : poller.keySource === "env"
                      ? "key from env"
                      : "key from panel"}
                </Badge>
              ) : null}
            </Flex>
            {poller?.baseUrl ? (
              <Flex align="center" gap="2">
                <Code size="2">{poller.baseUrl}/events</Code>
                <CopyButton value={`${poller.baseUrl}/events`} />
              </Flex>
            ) : null}
            <Text color="gray" size="2">
              Cursor: {cursor ? <Code size="2">{cursor}</Code> : "none yet"} · Last poll:{" "}
              {poller?.lastPollAt ?? "never"}
              {poller ? ` · every ${poller.intervalMs} ms` : ""}
            </Text>
            {poller?.lastError ? (
              <Text color="red" size="2">
                {poller.lastError}
              </Text>
            ) : null}
            <Text color="gray" size="2">
              A poison event the poller abandons after bounded retries shows up in the native app's
              event log as an ignored entry naming the event id.
            </Text>
          </Flex>

          {shownTransport === "poll" ? (
            <>
              <Separator size="4" />

              <Flex align="center" gap="3" justify="between">
                <Flex direction="column" gap="1">
                  <Text size="2" weight="medium">
                    Poll target
                  </Text>
                  <Text color="gray" size="2">
                    The bundled mock needs no credential. Real WorkOS needs the environment API key
                    — WORKOS_API_KEY always wins over a key stored here.
                  </Text>
                </Flex>
                <SegmentedControl.Root
                  onValueChange={(target) =>
                    transportFetcher.submit(
                      { intent: "set-poll-target", target, url: eventsUrl },
                      { method: "post" },
                    )
                  }
                  value={shownTarget}
                >
                  <SegmentedControl.Item value="mock">Bundled mock</SegmentedControl.Item>
                  <SegmentedControl.Item value="workos">Real WorkOS</SegmentedControl.Item>
                </SegmentedControl.Root>
              </Flex>

              {shownTarget === "workos" ? (
                <Form method="post">
                  <input name="intent" type="hidden" value="set-poll-target" />
                  <input name="target" type="hidden" value="workos" />
                  <Flex direction="column" gap="2">
                    <FieldLabel htmlFor="events-url">Events API base URL</FieldLabel>
                    <Flex align="center" gap="2">
                      <Box className="grow">
                        <TextField.Root
                          defaultValue={eventsUrl}
                          id="events-url"
                          name="url"
                          placeholder="https://api.workos.com"
                        />
                      </Box>
                      <Button type="submit" variant="soft">
                        Save target
                      </Button>
                    </Flex>
                  </Flex>
                </Form>
              ) : null}

              <Flex direction="column" gap="2">
                <Flex align="center" gap="2">
                  <FieldLabel htmlFor="events-api-key">WorkOS API key</FieldLabel>
                  <Badge color={keyBadge.color} variant="soft">
                    {keyBadge.label}
                  </Badge>
                </Flex>
                <Form method="post">
                  <input name="intent" type="hidden" value="store-events-api-key" />
                  <Flex align="center" gap="2">
                    <Box className="grow">
                      <TextField.Root
                        autoComplete="off"
                        id="events-api-key"
                        name="value"
                        placeholder={storedKeyConfigured ? "Replace stored key…" : "sk_…"}
                        type="password"
                      />
                    </Box>
                    <Button loading={savingKey} type="submit" variant="soft">
                      {storedKeyConfigured ? "Replace key" : "Save key"}
                    </Button>
                  </Flex>
                </Form>
                {storedKeyConfigured ? (
                  <Form method="post">
                    <input name="intent" type="hidden" value="clear-events-api-key" />
                    <Button color="red" type="submit" variant="soft">
                      Clear stored key
                    </Button>
                  </Form>
                ) : null}
                <Text color="gray" size="2">
                  Write-only: the key is encrypted at rest when APP_ENCRYPTION_KEY is set and is
                  never shown again. WORKOS_API_KEY from the environment takes precedence over it.
                </Text>
              </Flex>
            </>
          ) : null}

          {transportError ? (
            <Text color="red" size="2">
              {transportError}
            </Text>
          ) : null}
        </Flex>
      </Card>

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
