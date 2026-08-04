import {
  getConfig,
  insertDirectory,
  listDirectories,
  reconcileDirectories,
  setConfig,
  setConfigIfAbsent,
  setDirectoryLogPersistence,
  type EnvDirectory,
} from "../workers/shared/db";
import { rememberClientToken, storeClientToken } from "../workers/shared/client-tokens";
import { newScimToken } from "../workers/shared/ids";
import type { PocEnv } from "../workers/shared/types";

/**
 * Which half of a migration deployment this container runs. The image ships
 * both sides: `bridge` is the real product (migration proxy + control panel),
 * `native-app` runs only the bundled native app worker so the same image can
 * stand in for the customer's own application during an end-to-end run.
 */
export const APP_ROLES = ["bridge", "native-app"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Which datastore backs the container. `sqlite` (the default) is the documented
 * docker-compose deployment: one file on a mounted volume. `postgres` is for the
 * deployments that already run RDS/Aurora and want the database backed up by the
 * machinery they already own (ENT-6753).
 */
export const DATABASE_DRIVERS = ["sqlite", "postgres"] as const;
export type DatabaseDriver = (typeof DATABASE_DRIVERS)[number];

/**
 * Global configuration for the container, read from environment variables.
 * Per-directory settings (native/WorkOS endpoints + tokens, mode) are imported
 * through the control panel and stored per directory; only process-wide
 * parameters live here.
 */
export interface AppConfig {
  /** Which half of the deployment this container runs. */
  role: AppRole;
  /** Which datastore driver backs `env.DB`. */
  databaseDriver: DatabaseDriver;
  /** `postgres` driver: the connection string (DATABASE_URL). */
  databaseUrl: string | null;
  /** HTTP port the server listens on. */
  port: number;
  /** Path to the SQLite database file (mount a volume here to persist). */
  databasePath: string;
  /** Public base URL the IdP uses to reach the proxy, e.g. https://scim.acme.com. */
  publicUrl: string;
  /** Enable the bundled IdP + native-app simulators for a self-contained demo. */
  demoMode: boolean;
  /** Optional key reserved for encrypting per-directory tokens at rest. */
  encryptionKey: string | null;
  /** Optional HTTP Basic credentials guarding the control panel. */
  panelAuthUser: string | null;
  panelAuthPassword: string | null;
  /** `native-app` role: bearer token the bridge presents to this app's /scim/v2. */
  nativeScimToken: string | null;
  /** `native-app` role: HMAC secret of the WorkOS webhook endpoint feeding /webhooks/dsync. */
  webhookSecret: string | null;
  /** `native-app` role: base URL of the BRIDGE, which serves the status endpoint. */
  bridgeStatusUrl: string | null;
  /** Directories declared by env. Only the `native-app` role seeds them; the
   *  bridge imports its own through the control panel. */
  directories: EnvDirectory[];
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function databaseDriver(value: string | undefined): DatabaseDriver {
  const driver = value?.trim() || "sqlite";
  if (!(DATABASE_DRIVERS as readonly string[]).includes(driver)) {
    throw new Error(
      `DATABASE_DRIVER must be one of ${DATABASE_DRIVERS.join(", ")}; received "${value}".`,
    );
  }
  return driver as DatabaseDriver;
}

function appRole(value: string | undefined): AppRole {
  const role = value?.trim() || "bridge";
  if (!(APP_ROLES as readonly string[]).includes(role)) {
    throw new Error(`APP_ROLE must be one of ${APP_ROLES.join(", ")}; received "${value}".`);
  }
  return role as AppRole;
}

/**
 * Parse `DIRECTORIES_JSON`: the directories a `native-app` container serves,
 * `[{ "workos_directory_id": "directory_…", "proxy_token": "…", "name": "…" }]`.
 * A real customer's app already knows these two values per directory (the id
 * DSync events carry, and the proxy token they configured their IdP with), so
 * the stand-in is told them the same way instead of growing a panel of its own.
 */
function directories(value: string | undefined): EnvDirectory[] {
  const raw = value?.trim();
  if (!raw) return [];
  const shape = 'DIRECTORIES_JSON must be a JSON array of {"workos_directory_id","proxy_token"}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${shape}; it is not valid JSON (${(error as Error).message}).`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${shape}; received ${typeof parsed}.`);
  return parsed.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const id = typeof record.workos_directory_id === "string" ? record.workos_directory_id : "";
    const token = typeof record.proxy_token === "string" ? record.proxy_token : "";
    if (!id || !token) {
      throw new Error(`${shape}; entry ${index} is missing workos_directory_id or proxy_token.`);
    }
    return {
      workos_directory_id: id,
      proxy_token: token,
      name: typeof record.name === "string" && record.name ? record.name : id,
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const role = appRole(env.APP_ROLE);
  const port = Number(env.PORT ?? "8080");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive number; received "${env.PORT}".`);
  }
  const databasePath = env.DATABASE_PATH?.trim() || "/data/scim-bridge.db";
  const publicUrl = trimTrailingSlash(env.PUBLIC_URL?.trim() || `http://127.0.0.1:${port}`);
  const bridgeStatusUrl = env.BRIDGE_STATUS_URL?.trim();
  const driver = databaseDriver(env.DATABASE_DRIVER);
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  // Failing at boot beats a driver that cannot connect: the panel would serve
  // 500s with the real cause buried in a stack trace.
  if (driver === "postgres" && !databaseUrl) {
    throw new Error("DATABASE_URL is required when DATABASE_DRIVER=postgres.");
  }
  const webhookSecret = env.WEBHOOK_SECRET?.trim() || null;
  // Refuse to boot rather than serve /webhooks/dsync unauthenticated: the
  // listener skips signature verification when it has no secret, so an
  // internet-routable stand-in would apply any unsigned POST as a real WorkOS
  // event. (Unlike BRIDGE_STATUS_URL, which only degrades to reading no status.)
  if (role === "native-app" && !webhookSecret) {
    throw new Error(
      "WEBHOOK_SECRET is required when APP_ROLE=native-app: without it every unsigned " +
        "POST to the publicly routable /webhooks/dsync would be applied as a genuine " +
        "WorkOS event. Use the signing secret of the webhook endpoint in the WorkOS dashboard.",
    );
  }

  return {
    role,
    databaseDriver: driver,
    databaseUrl,
    port,
    databasePath,
    publicUrl,
    demoMode: bool(env.DEMO_MODE),
    encryptionKey: env.APP_ENCRYPTION_KEY?.trim() || null,
    panelAuthUser: env.PANEL_AUTH_USER?.trim() || null,
    panelAuthPassword: env.PANEL_AUTH_PASSWORD || null,
    nativeScimToken: env.NATIVE_SCIM_TOKEN?.trim() || null,
    webhookSecret,
    bridgeStatusUrl: bridgeStatusUrl ? trimTrailingSlash(bridgeStatusUrl) : null,
    directories: directories(env.DIRECTORIES_JSON),
  };
}

/** Loopback base the in-process demo mounts are reachable at. */
export function loopbackBase(config: AppConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

export type PanelAuthDecision = "open" | "granted" | "denied";

/**
 * Whether the panel's Basic-auth gate admits a request.
 *
 * `open` means no credentials are configured at all — the documented "front it
 * with your own reverse proxy / SSO" deployment. Anything else demands a
 * matching header, including a *half*-configured pair: a username with no
 * password is a misconfiguration, and treating it as `open` served every
 * directory's decrypted SCIM tokens to anonymous callers (VULN-1612).
 *
 * Lives here rather than in the middleware because the middleware only exists
 * once the react-router build is mounted, and a decision this consequential
 * should be testable without one.
 */
export function decidePanelAuth(
  config: Pick<AppConfig, "panelAuthUser" | "panelAuthPassword">,
  authorizationHeader: string | null,
): PanelAuthDecision {
  const { panelAuthUser, panelAuthPassword } = config;
  if (!panelAuthUser && !panelAuthPassword) return "open";
  // Half a pair can never be matched: the configured side would have to equal a
  // supplied value while the unset side compares against null, so demand both.
  if (!panelAuthUser || !panelAuthPassword) return "denied";

  const [scheme, encoded] = (authorizationHeader ?? "").split(" ");
  if (scheme !== "Basic") return "denied";
  // Split once: a colon is legal inside a password, so everything after the
  // first one belongs to it.
  const decoded = Buffer.from(encoded ?? "", "base64").toString();
  const separator = decoded.indexOf(":");
  if (separator === -1) return "denied";
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return user === panelAuthUser && pass === panelAuthPassword ? "granted" : "denied";
}

/**
 * Push global params into `poc_config` so the existing `getConfig`-based code
 * (which reads `proxy.public_url`, and in demo mode the simulator URLs) sees
 * them without any per-request env plumbing. Env is authoritative and overrides
 * whatever the migrations seeded.
 */
export async function seedConfig(env: PocEnv, config: AppConfig): Promise<void> {
  const db = env.DB;
  await seedGeneratedTokens(env);
  await setConfig(db, "proxy.public_url", config.publicUrl);
  // The in-process reference listener reaches the proxy over loopback, so it
  // works even when the public URL only resolves outside the container.
  await setConfig(db, "proxy.loopback_url", loopbackBase(config));
  if (config.demoMode) {
    const base = loopbackBase(config);
    await setConfig(db, "idp.public_url", `${base}/__demo/idp`);
    await setConfig(db, "native.public_url", `${base}/__demo/native`);
  }
}

/**
 * Mint the bundled endpoints' bearer tokens on first boot. Migration 0002 used to
 * generate these in SQL, which would hand each datastore driver a different
 * secret; the app owns them now. Only ever written when absent, so a restart
 * never rotates a token an IdP or the panel is already using.
 */
export async function seedGeneratedTokens(env: PocEnv): Promise<Record<string, string>> {
  const landed: Record<string, string> = {};
  for (const key of ["native.scim_token", "mock_workos.scim_token"]) {
    // Insert-if-absent and read back: with two instances booting at once (the
    // point of the Postgres driver) a check-then-write would let the loser's
    // token reach a directory row while the winner's sits in config.
    landed[key] = await setConfigIfAbsent(env.DB, key, newScimToken());
  }
  return landed;
}

/**
 * `native-app` role: push the env-supplied secrets and the bridge's base URL
 * into `poc_config`, where the native worker and its listener already read them
 * from. Only values actually provided are written, so an unset var leaves the
 * boot-seeded default (e.g. the random `native.scim_token`) in place.
 */
export async function seedNativeAppConfig(env: PocEnv, config: AppConfig): Promise<void> {
  const db = env.DB;
  await seedGeneratedTokens(env);
  if (config.nativeScimToken) await setConfig(db, "native.scim_token", config.nativeScimToken);
  // Always set in this role — loadConfig refuses to boot without it.
  if (config.webhookSecret) await setConfig(db, "native.webhook_secret", config.webhookSecret);
  // The listener's status client resolves the status endpoint from this
  // container's own `proxy.loopback_url ?? proxy.public_url`. Here the proxy is
  // a DIFFERENT container, so both keys point at the bridge — loopback included,
  // or it would win and dial this container instead.
  if (config.bridgeStatusUrl) {
    await setConfig(db, "proxy.public_url", config.bridgeStatusUrl);
    await setConfig(db, "proxy.loopback_url", config.bridgeStatusUrl);
  }
  // Real WorkOS delivers the DSync events here, so the bundled mock WorkOS —
  // which rides along inside the native worker at /mock-workos/scim/v2 — must
  // not also emit them if anything ever writes to it.
  await setConfig(db, "mock_workos.emit_dsync", "false");
}

/**
 * `native-app` role: make `scim_directories` — the table the listener resolves
 * an event's directory and proxy token from — match `DIRECTORIES_JSON` exactly.
 * Each row's id IS the WorkOS directory id, so the `directory_id` an event
 * carries both finds the row here and is an id the bridge's status endpoint
 * accepts for that token. Env is authoritative, as with the config keys: a
 * directory dropped from the var loses its row on the next boot, so it can no
 * longer resolve an event or hold on to a proxy token.
 */
export async function seedNativeAppDirectories(env: PocEnv, config: AppConfig): Promise<void> {
  await reconcileDirectories(env.DB, config.directories);
  // The rows keep only a digest (ENT-6742), so the status client gets its copy from
  // the environment we just read. In-process: this runs on every boot.
  for (const directory of config.directories) {
    rememberClientToken(directory.workos_directory_id, directory.proxy_token);
  }
}

/**
 * In demo mode, seed one directory already wired to the in-process simulators
 * (native app + mock WorkOS) so the migration loop is runnable immediately. No-op
 * once any directory exists, so it never fights a user's own imports.
 */
export async function seedDemoDirectory(env: PocEnv, config: AppConfig): Promise<void> {
  if (!config.demoMode) return;
  const existing = await listDirectories(env.DB);
  if (existing.length > 0) return;
  const base = loopbackBase(config);
  const { id, proxy_token } = await insertDirectory(env.DB, {
    name: "Demo directory",
    native_url: `${base}/__demo/native/scim/v2`,
    native_token: (await getConfig(env.DB, "native.scim_token")) ?? "",
    workos_url: `${base}/__demo/native/mock-workos/scim/v2`,
    workos_token: (await getConfig(env.DB, "mock_workos.scim_token")) ?? "",
  });
  // The bundled IdP simulator drives this directory, so it needs the token the way
  // Okta would have it: its own stored copy. Persisted rather than in-process,
  // because this seed is a no-op on the next boot (a directory already exists) and
  // the simulator still has to work.
  await storeClientToken(env.DB, id, proxy_token);
  // The demo runs one directory you actively watch, so persist its logs.
  await setDirectoryLogPersistence(env.DB, id, true);
}
