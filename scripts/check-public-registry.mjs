/**
 * Every registry URL present in the lockfile must use the public npm registry.
 *
 * This repository is published, so a lockfile entry pointing at an internal
 * host can prevent outside installs and advertise internal infrastructure.
 * npm is configured to omit registry-backed `resolved` fields entirely, but
 * this check still protects legitimate non-registry resolutions and catches a
 * private registry URL if one is reintroduced.
 */
import { readFileSync } from "node:fs";

const ALLOWED_HOST = "registry.npmjs.org";

const lockPath = process.argv[2] ?? new URL("../package-lock.json", import.meta.url);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));

/** Every `resolved` URL in the tree, with the package path that carries it. */
function resolvedUrls(packages) {
  return Object.entries(packages ?? {})
    .filter(([, entry]) => typeof entry?.resolved === "string")
    .map(([path, entry]) => ({ path: path || "(root)", url: entry.resolved }));
}

const entries = resolvedUrls(lock.packages);

// `file:` and `link:` are local workspace references, not registry downloads.
const offenders = entries.filter(({ url }) => {
  if (url.startsWith("file:") || url.startsWith("link:")) return false;
  try {
    return new URL(url).host !== ALLOWED_HOST;
  } catch {
    return true;
  }
});

if (offenders.length > 0) {
  console.error(
    `check-public-registry: ${offenders.length} dependency(ies) do not resolve from ${ALLOWED_HOST}:\n`,
  );
  for (const { path, url } of offenders.slice(0, 20)) console.error(`  ${path}\n    ${url}`);
  if (offenders.length > 20) console.error(`  … and ${offenders.length - 20} more`);
  console.error(
    `\nThis usually means npm install ran on a machine authenticated to an internal\n` +
      `registry proxy. Regenerate the lockfile with the repository's npm policy,\n` +
      `then confirm \`npm ci\` still works from a clean directory.`,
  );
  process.exit(1);
}

console.log(
  entries.length === 0
    ? "✓ lockfile omits registry-backed resolved URLs"
    : `✓ all ${entries.length} explicit resolutions use ${ALLOWED_HOST}`,
);
