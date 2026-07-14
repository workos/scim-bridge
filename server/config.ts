import { getConfig, insertDirectory, listDirectories, setConfig } from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";

/**
 * Global configuration for the container, read from environment variables.
 * Per-directory settings (native/WorkOS endpoints + tokens, mode) are imported
 * through the control panel and stored per directory; only process-wide
 * parameters live here.
 */
export interface AppConfig {
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
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be a positive number; received "${env.PORT}".`);
  }
  const databasePath = env.DATABASE_PATH?.trim() || "/data/scim-bridge.db";
  const publicUrl = trimTrailingSlash(env.PUBLIC_URL?.trim() || `http://127.0.0.1:${port}`);

  return {
    port,
    databasePath,
    publicUrl,
    demoMode: bool(env.DEMO_MODE),
    encryptionKey: env.APP_ENCRYPTION_KEY?.trim() || null,
    panelAuthUser: env.PANEL_AUTH_USER?.trim() || null,
    panelAuthPassword: env.PANEL_AUTH_PASSWORD || null,
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
  if (config.demoMode) {
    const base = loopbackBase(config);
    await setConfig(db, "idp.public_url", `${base}/__demo/idp`);
    await setConfig(db, "native.public_url", `${base}/__demo/native`);
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
  await insertDirectory(env.DB, {
    name: "Demo directory",
    native_url: `${base}/__demo/native/scim/v2`,
    native_token: (await getConfig(env.DB, "native.scim_token")) ?? "",
    workos_url: `${base}/__demo/native/mock-workos/scim/v2`,
    workos_token: (await getConfig(env.DB, "mock_workos.scim_token")) ?? "",
  });
}
