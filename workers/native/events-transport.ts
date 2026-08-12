import { decryptSecret, encryptSecret, isEncryptedSecret } from "../shared/crypto";
import { deleteConfig, getConfig, setConfig } from "../shared/db";
import type { Datastore } from "../shared/datastore";
import { DEFAULT_POLL_INTERVAL_MS, startEventsPoller } from "./events-poller";
import type { EventsPoller } from "./events-poller";

/**
 * Runtime control over which transport the demo listener relies on: webhook
 * push, or Events API polling — and where the poller points.
 *
 * A controller owned by server boot holds the poll loop; the panel's listener
 * tab writes the persisted choices below and asks the controller to reconcile.
 * Boot reads the same keys, so the choice survives a restart. All of it is
 * demo-scoped: outside demo mode there is no panel, no tab, and no stored-key
 * lookup — the WORKOS_API_KEY / WORKOS_EVENTS_URL contract from the poller's
 * introduction decides alone, unchanged.
 */

/** Which transport the demo relies on: `"webhook"` or `"poll"`. Absent, the
 *  boot-time env rule decides — polling wherever it would have started before
 *  this key existed. Webhook deliveries are ACCEPTED in both positions (the
 *  event-id dedup makes overlap safe); this only starts or stops the poller. */
export const EVENTS_TRANSPORT_KEY = "native.events_transport";

/** Poll target: `"mock"` (the bundled loopback mock, keyless) or `"workos"`. */
export const EVENTS_TARGET_KEY = "native.events_target";

/** Events API base URL for the `"workos"` target. */
export const EVENTS_URL_KEY = "native.events_url";

/** The panel-stored API key, encrypted at rest when APP_ENCRYPTION_KEY is set
 *  (same envelope as the directory token columns). WORKOS_API_KEY from the
 *  environment always wins over this. The panel never reads it back — only
 *  whether it exists. */
export const EVENTS_API_KEY_CONFIG_KEY = "native.events_api_key";

const DEFAULT_EVENTS_URL = "https://api.workos.com";

export type EventsTransport = "webhook" | "poll";
export type EventsPollTarget = "mock" | "workos";
export type EventsKeySource = "env" | "stored" | "mock";

/** The slice of boot config the controller needs. Passed in rather than read
 *  from server/config.ts so this stays importable from the workers layer. */
export interface EventsPollerBoot {
  demoMode: boolean;
  /** WORKOS_API_KEY. Always wins over the panel-stored key. */
  envApiKey: string | null;
  /** WORKOS_EVENTS_URL as boot resolved it (env value or its default). */
  envEventsUrl: string;
  /** The exact loopback mock URL keyless polling is allowed against. */
  mockEventsUrl: string;
  /** Whether env alone turns the poller on (`eventsPollerEnabled`) — the
   *  default transport where no choice has been persisted. */
  enabledByEnv: boolean;
  intervalMs?: number;
  limit?: number;
}

export interface EventsPollerStatus {
  running: boolean;
  transport: EventsTransport;
  target: EventsPollTarget | null;
  /** What an absent `native.events_target` resolves to for this boot — the
   *  actions and the tab must default the same way the controller does, or a
   *  keyless guard checks one target while the poller runs another. */
  defaultTarget: EventsPollTarget;
  baseUrl: string | null;
  keySource: EventsKeySource | null;
  envKeyConfigured: boolean;
  intervalMs: number;
  /** ISO time of the last poll that completed, across starts and stops. */
  lastPollAt: string | null;
  /** The last poll failure, or the reason the poller cannot run at all. */
  lastError: string | null;
}

export interface EventsPollerController {
  /** Re-read the persisted transport choices and start/stop/retarget the poll
   *  loop to match. Resolves with the start DECISION — the first poll of a
   *  (re)started loop settles in the background, because both callers hold
   *  something open while they wait: boot the health check, a panel action an
   *  HTTP response, and a first poll drains a whole backlog over a network
   *  nobody controls. */
  reconcile(): Promise<EventsPollerStatus>;
  /** Resolves once the current loop's first poll has settled (immediately when
   *  none runs). Nothing on a request path awaits this; tests do. */
  settled(): Promise<void>;
  status(): EventsPollerStatus;
  stop(): void;
}

/** What the persisted config + boot env ask the controller to run. */
interface DesiredPoller {
  transport: EventsTransport;
  target: EventsPollTarget | null;
  run: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  keySource: EventsKeySource | null;
  /** Why a `transport: "poll"` choice still cannot run (e.g. no key). */
  blocked: string | null;
}

const NEEDS_KEY =
  "Polling real WorkOS needs an API key: set WORKOS_API_KEY or store one in the panel.";

function asTransport(value: string | null): EventsTransport | null {
  return value === "webhook" || value === "poll" ? value : null;
}

function asTarget(value: string | null): EventsPollTarget | null {
  return value === "mock" || value === "workos" ? value : null;
}

/** The stored key, decrypted for use. A value that stays ciphertext (the
 *  encryption key changed or was removed) counts as absent rather than being
 *  presented verbatim to the API. */
async function storedApiKey(db: Datastore): Promise<string | null> {
  const raw = await getConfig(db, EVENTS_API_KEY_CONFIG_KEY);
  if (!raw) return null;
  const plain = await decryptSecret(db, raw);
  return plain && !isEncryptedSecret(plain) ? plain : null;
}

/** What an absent `native.events_target` means for this boot: the mock when
 *  the env URL is (or defaulted to) the bundled mock, real WorkOS otherwise. */
export function defaultPollTarget(
  boot: Pick<EventsPollerBoot, "envEventsUrl" | "mockEventsUrl">,
): EventsPollTarget {
  return boot.envEventsUrl === boot.mockEventsUrl ? "mock" : "workos";
}

async function resolveDesired(db: Datastore, boot: EventsPollerBoot): Promise<DesiredPoller> {
  const envTransport: EventsTransport = boot.enabledByEnv ? "poll" : "webhook";
  const off = (transport: EventsTransport): DesiredPoller => ({
    transport,
    target: null,
    run: false,
    baseUrl: null,
    apiKey: null,
    keySource: null,
    blocked: null,
  });

  if (!boot.demoMode) {
    // No panel exists outside demo mode, so NO panel-written key — the
    // transport choice included — may steer a production listener: a datastore
    // previously driven by a demo panel must not switch off a poller the
    // environment said to run, when the tab that could undo it isn't there.
    // Env is the entire configuration, exactly as when the poller shipped.
    if (!boot.enabledByEnv || !boot.envApiKey) return off(envTransport);
    return {
      transport: "poll",
      target: null,
      run: true,
      baseUrl: boot.envEventsUrl,
      apiKey: boot.envApiKey,
      keySource: "env",
      blocked: null,
    };
  }

  const transport = asTransport(await getConfig(db, EVENTS_TRANSPORT_KEY)) ?? envTransport;
  if (transport !== "poll") return off(transport);

  const target = asTarget(await getConfig(db, EVENTS_TARGET_KEY)) ?? defaultPollTarget(boot);
  if (target === "mock") {
    // The bundled mock authenticates with its own seeded token — the one
    // target that never needs (and would reject) a WorkOS credential.
    const token = (await getConfig(db, "mock_workos.scim_token")) ?? "";
    if (!token) {
      return { ...off("poll"), target, blocked: "The bundled mock has no seeded token yet." };
    }
    return {
      transport,
      target,
      run: true,
      baseUrl: boot.mockEventsUrl,
      apiKey: token,
      keySource: "mock",
      blocked: null,
    };
  }

  const baseUrl =
    (await getConfig(db, EVENTS_URL_KEY)) ??
    (boot.envEventsUrl !== boot.mockEventsUrl ? boot.envEventsUrl : DEFAULT_EVENTS_URL);
  const stored = boot.envApiKey ? null : await storedApiKey(db);
  const apiKey = boot.envApiKey ?? stored;
  if (!apiKey) {
    // The panel actions refuse to persist this state; reaching it anyway
    // (hand-edited config, a cleared key) must park the poller with a visible
    // reason, never start it keyless against something that isn't the mock.
    return { ...off("poll"), target, baseUrl, blocked: NEEDS_KEY };
  }
  return {
    transport,
    target,
    run: true,
    baseUrl,
    apiKey,
    keySource: boot.envApiKey ? "env" : "stored",
    blocked: null,
  };
}

export function createEventsPollerController(
  db: Datastore,
  boot: EventsPollerBoot,
): EventsPollerController {
  const intervalMs = boot.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let loop: EventsPoller | null = null;
  let current: { baseUrl: string; apiKey: string } | null = null;
  let status: EventsPollerStatus = {
    running: false,
    transport: boot.enabledByEnv ? "poll" : "webhook",
    target: null,
    defaultTarget: defaultPollTarget(boot),
    baseUrl: null,
    keySource: null,
    envKeyConfigured: Boolean(boot.envApiKey),
    intervalMs,
    lastPollAt: null,
    lastError: null,
  };

  const stopLoop = (): void => {
    loop?.stop();
    loop = null;
    current = null;
  };

  return {
    status: () => ({ ...status }),
    settled: () => loop?.firstPoll ?? Promise.resolve(),
    stop() {
      stopLoop();
      status = { ...status, running: false };
    },
    async reconcile() {
      const desired = await resolveDesired(db, boot);
      status = {
        ...status,
        transport: desired.transport,
        target: desired.target,
        baseUrl: desired.baseUrl,
        keySource: desired.keySource,
        lastError: desired.blocked,
      };
      if (!desired.run || desired.baseUrl === null || desired.apiKey === null) {
        stopLoop();
        status = { ...status, running: false };
        return { ...status };
      }

      const retarget =
        current === null ||
        current.baseUrl !== desired.baseUrl ||
        current.apiKey !== desired.apiKey;
      if (retarget) {
        stopLoop();
        current = { baseUrl: desired.baseUrl, apiKey: desired.apiKey };
        loop = startEventsPoller(db, {
          apiKey: desired.apiKey,
          baseUrl: desired.baseUrl,
          intervalMs,
          limit: boot.limit,
          onSuccess: () => {
            status = { ...status, lastPollAt: new Date().toISOString(), lastError: null };
          },
          onError: (message) => {
            status = { ...status, lastError: message };
          },
        });
        // Deliberately NOT awaited: the first poll drains a whole backlog
        // with network round-trips, and reconcile's callers hold something
        // open while they wait — boot the health check, a panel action an
        // HTTP response. The decision is what they need; the poll's outcome
        // lands in the status via the callbacks above.
      }
      status = { ...status, running: true };
      return { ...status };
    },
  };
}

/**
 * The controller crosses two module graphs: server boot creates it from
 * source, while the panel action lives in the react-router build that Vite
 * bundled its own copy of this module into. A module-level variable would be
 * two variables, so the handoff rides the global symbol registry — the same
 * split, and the same fix, as app/context.ts.
 */
const CONTROLLER = Symbol.for("scim-bridge.events-poller-controller");
const host = globalThis as Record<symbol, unknown>;

export function registerEventsPollerController(controller: EventsPollerController): void {
  host[CONTROLLER] = controller;
}

/** Null under `npm run dev`, which mounts only the panel and runs no poller. */
export function eventsPollerController(): EventsPollerController | null {
  return (host[CONTROLLER] as EventsPollerController | undefined) ?? null;
}

/** What a panel action needs beyond the datastore: the live controller (null
 *  when this process runs none) and whether WORKOS_API_KEY is set. */
export interface TransportActionOptions {
  controller: EventsPollerController | null;
  envKeyConfigured: boolean;
}

export interface TransportActionResult {
  error?: string;
}

async function anyKeyAvailable(db: Datastore, opts: TransportActionOptions): Promise<boolean> {
  return opts.envKeyConfigured || (await storedApiKey(db)) !== null;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Flip which transport the demo relies on. Refuses a flip to polling that
 *  could only produce a dead poller (real-WorkOS target with no key anywhere). */
export async function setEventsTransport(
  db: Datastore,
  opts: TransportActionOptions,
  value: string,
): Promise<TransportActionResult> {
  const transport = asTransport(value);
  if (!transport) return { error: "That transport is not recognized." };
  if (transport === "poll") {
    // Default the target exactly as the controller will, or this guard checks
    // "mock" while the poller starts blocked on a keyless real-WorkOS target.
    const target =
      asTarget(await getConfig(db, EVENTS_TARGET_KEY)) ??
      opts.controller?.status().defaultTarget ??
      "mock";
    if (target === "workos" && !(await anyKeyAvailable(db, opts))) {
      return { error: NEEDS_KEY };
    }
  }
  await setConfig(db, EVENTS_TRANSPORT_KEY, transport);
  await opts.controller?.reconcile();
  return {};
}

/** Point the poller at the bundled mock or at real WorkOS. The real target is
 *  validated — URL shape, and a key from somewhere — before anything persists,
 *  so a refusal leaves the previous target running untouched. */
export async function setEventsPollTarget(
  db: Datastore,
  opts: TransportActionOptions,
  input: { target: string; url?: string },
): Promise<TransportActionResult> {
  const target = asTarget(input.target);
  if (!target) return { error: "That poll target is not recognized." };
  if (target === "mock") {
    await setConfig(db, EVENTS_TARGET_KEY, "mock");
    await opts.controller?.reconcile();
    return {};
  }

  const url = (input.url ?? "").trim() || DEFAULT_EVENTS_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "The Events API URL is not a valid URL." };
  }
  // The poller presents the API key as a bearer on every tick, so a cleartext
  // transport would hand the environment-wide credential to the network.
  // Loopback is the one exemption — it never leaves the host, and it is how
  // the bundled mock is reached.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed))) {
    return {
      error:
        "The Events API URL must use https — a plain-http target would send the API key " +
        "in cleartext. (Loopback addresses are exempt.)",
    };
  }
  if (!(await anyKeyAvailable(db, opts))) return { error: NEEDS_KEY };
  await setConfig(db, EVENTS_URL_KEY, url.replace(/\/+$/, ""));
  await setConfig(db, EVENTS_TARGET_KEY, "workos");
  await opts.controller?.reconcile();
  return {};
}

/** Store (or replace) the panel API key — write-only, encrypted at rest when
 *  APP_ENCRYPTION_KEY is set. The panel never renders it back. */
export async function storeEventsApiKey(
  db: Datastore,
  opts: TransportActionOptions,
  key: string,
): Promise<TransportActionResult> {
  const trimmed = key.trim();
  if (!trimmed) return { error: "Paste a key to store — or use Clear to remove the stored one." };
  await setConfig(db, EVENTS_API_KEY_CONFIG_KEY, await encryptSecret(db, trimmed));
  await opts.controller?.reconcile();
  return {};
}

/** Remove the stored key — unless a running keyless real-WorkOS poller would
 *  be stranded by it, which is a refusal for the same reason selecting that
 *  target keyless is. */
export async function clearEventsApiKey(
  db: Datastore,
  opts: TransportActionOptions,
): Promise<TransportActionResult> {
  if (!opts.envKeyConfigured) {
    const transport =
      asTransport(await getConfig(db, EVENTS_TRANSPORT_KEY)) ??
      opts.controller?.status().transport ??
      "poll";
    const target = asTarget(await getConfig(db, EVENTS_TARGET_KEY)) ?? "mock";
    if (transport === "poll" && target === "workos") {
      return {
        error:
          "This key is what the poller is using. Switch the target to the bundled mock " +
          "(or the transport to webhooks) before clearing it.",
      };
    }
  }
  await deleteConfig(db, EVENTS_API_KEY_CONFIG_KEY);
  await opts.controller?.reconcile();
  return {};
}
