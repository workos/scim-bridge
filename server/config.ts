import {
  getConfig,
  insertDirectory,
  listDirectories,
  setConfig,
  setDirectoryLogPersistence,
  upsertDirectoryByWorkosId,
  type EnvDirectory,
} from "../workers/shared/db";
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
 * Global configuration for the container, read from environment variables.
 * Per-directory settings (native/WorkOS endpoints + tokens, mode) are imported
 * through the control panel and stored per directory; only process-wide
 * parameters live here.
 */
export interface AppConfig {
  /** Which half of the deployment this container runs. */
  role: AppRole;
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
  const port = Number(env.PORT ?? "8080");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive number; received "${env.PORT}".`);
  }
  const databasePath = env.DATABASE_PATH?.trim() || "/data/scim-bridge.db";
  const publicUrl = trimTrailingSlash(env.PUBLIC_URL?.trim() || `http://127.0.0.1:${port}`);
  const bridgeStatusUrl = env.BRIDGE_STATUS_URL?.trim();

  return {
    role: appRole(env.APP_ROLE),
    port,
    databasePath,
    publicUrl,
    demoMode: bool(env.DEMO_MODE),
    encryptionKey: env.APP_ENCRYPTION_KEY?.trim() || null,
    panelAuthUser: env.PANEL_AUTH_USER?.trim() || null,
    panelAuthPassword: env.PANEL_AUTH_PASSWORD || null,
    nativeScimToken: env.NATIVE_SCIM_TOKEN?.trim() || null,
    webhookSecret: env.WEBHOOK_SECRET?.trim() || null,
    bridgeStatusUrl: bridgeStatusUrl ? trimTrailingSlash(bridgeStatusUrl) : null,
    directories: directories(env.DIRECTORIES_JSON),
  };
}

/** Loopback base the in-process demo mounts are reachable at. */
export function loopbackBase(config: AppConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

/**
 * Push global params into `poc_config` so the existing `getConfig`-based code
 * (which reads `proxy.public_url`, and in demo mode the simulator URLs) sees
 * them without any per-request env plumbing. Env is authoritative and overrides
 * whatever the migrations seeded.
 */
export async function seedConfig(env: PocEnv, config: AppConfig): Promise<void> {
  const db = env.DB;
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
 * `native-app` role: push the env-supplied secrets and the bridge's base URL
 * into `poc_config`, where the native worker and its listener already read them
 * from. Only values actually provided are written, so an unset var leaves the
 * migration's own seed (e.g. the random `native.scim_token`) in place.
 */
export async function seedNativeAppConfig(env: PocEnv, config: AppConfig): Promise<void> {
  const db = env.DB;
  if (config.nativeScimToken) await setConfig(db, "native.scim_token", config.nativeScimToken);
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
 * `native-app` role: mirror the directories from `DIRECTORIES_JSON` into
 * `scim_directories`, the table the listener resolves an event's directory and
 * proxy token from. Each row's id IS the WorkOS directory id, so the
 * `directory_id` an event carries both finds the row here and is an id the
 * bridge's status endpoint accepts for that token. Re-seeded on every boot: env
 * is authoritative, as with the config keys.
 */
export async function seedNativeAppDirectories(env: PocEnv, config: AppConfig): Promise<void> {
  for (const directory of config.directories) {
    await upsertDirectoryByWorkosId(env.DB, directory);
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
  const demo = await insertDirectory(env.DB, {
    name: "Demo directory",
    native_url: `${base}/__demo/native/scim/v2`,
    native_token: (await getConfig(env.DB, "native.scim_token")) ?? "",
    workos_url: `${base}/__demo/native/mock-workos/scim/v2`,
    workos_token: (await getConfig(env.DB, "mock_workos.scim_token")) ?? "",
  });
  // The demo runs one directory you actively watch, so persist its logs.
  if (demo) await setDirectoryLogPersistence(env.DB, demo.id, true);
}
