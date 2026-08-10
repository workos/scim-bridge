/**
 * Where a bundled component finds the proxy token it has to *present*.
 *
 * The token in `scim_directories` is stored as a digest, which is correct for the
 * proxy — it only ever verifies — but this repo also ships two components that act as
 * *clients* of the proxy and therefore need the token itself:
 *
 *   - the IdP simulator (`workers/idp`), standing in for Okta
 *   - the native app's status client (`workers/native/status-client.ts`), which
 *     authenticates to `GET /status/directories/{id}`
 *
 * A real deployment has neither problem: the presenter is Okta, holding its own
 * copy in its own configuration, and the customer's app reads
 * `DIRECTORIES_JSON`. Nothing needs to read a token back out of the database. So
 * the plaintext lives here, deliberately narrowly, in the two places where this
 * process is also playing the client:
 *
 * `rememberClientToken` is in-process only. `native-app` mode reconstructs its
 * directories from `DIRECTORIES_JSON` on every boot, so the token is always
 * available from the environment and never has to be written down.
 *
 * `storeClientToken` persists, because the simulated IdP cannot be rebuilt from the
 * environment: its directories are minted in the panel at runtime and it must keep
 * working across a restart, exactly as Okta would keep the token an admin pasted
 * into it. That row is the simulated IdP's own configuration, not the proxy's
 * verifier — which is why it is keyed under `idp.` and why a deployment with no
 * simulator has no such row.
 *
 * Anything that mints or rotates a token is responsible for telling these stores
 * about it; there is no way to recompute it later.
 */
import { getConfig, setConfig } from "./db";
import type { Datastore } from "./datastore";

/** Config key naming the one directory the bundled simulators are allowed to drive. */
export const DEMO_DIRECTORY_ID_KEY = "idp.demo_directory_id";

/** The bundled demo directory's id, or null when this deployment has none. */
export async function demoDirectoryId(db: Datastore): Promise<string | null> {
  return getConfig(db, DEMO_DIRECTORY_ID_KEY);
}

/** Tokens this process was started with (native-app mode's DIRECTORIES_JSON). */
const remembered = new Map<string, string>();

export function rememberClientToken(directoryId: string, token: string): void {
  remembered.set(directoryId, token);
}

/** Test seam: `native-app` boot repopulates this, so clearing it between cases
 *  keeps one test's environment out of the next one's. */
export function forgetClientTokens(): void {
  remembered.clear();
}

function configKey(directoryId: string): string {
  return `idp.proxy_token.${directoryId}`;
}

export async function storeClientToken(
  db: Datastore,
  directoryId: string,
  token: string,
): Promise<void> {
  await setConfig(db, configKey(directoryId), token);
}

/** The token to present for this directory, or null if this process has no copy —
 *  which is the normal state in production and an error only for a caller that was
 *  about to act as a client. */
export async function clientTokenFor(db: Datastore, directoryId: string): Promise<string | null> {
  return remembered.get(directoryId) ?? (await getConfig(db, configKey(directoryId)));
}

/**
 * Hand a freshly minted token to whoever will present it — which is nobody, unless
 * a simulator is bundled into this deployment.
 *
 * The single decision point for the panel's three mint paths (create, bulk import,
 * rotate), so "when do we keep a plaintext copy?" is answered in one place rather
 * than in three route files that can drift apart. It is also why this lives here
 * and not inline in a route: the two failure modes are opposite and both bad, so
 * they are worth testing directly.
 *
 * - demo mode without this: the simulator keeps presenting a retired token and
 *   every provisioning action 401s
 * - production *with* it: the plaintext is back in the database under a different
 *   name, and hashing the column bought nothing
 *
 * Which is why the decision is keyed on the *directory*, not on the process-wide
 * demo flag. Only the bundled demo directory has a presenter inside this process;
 * a directory an operator imported is driven by their real IdP, which holds its
 * own copy. Keying on `demoMode` alone kept a usable plaintext credential for
 * every real directory minted or rotated while the flag was on, and the simulator
 * is reachable without panel credentials.
 */
export async function publishMintedToken(
  db: Datastore,
  directoryId: string,
  token: string,
  options: { demoMode: boolean },
): Promise<void> {
  if (!options.demoMode) return;
  if (directoryId !== (await demoDirectoryId(db))) return;
  await storeClientToken(db, directoryId, token);
}
