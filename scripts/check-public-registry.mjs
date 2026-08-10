/**
 * Every dependency must resolve from the public npm registry.
 *
 * This repository is published, so a lockfile entry pointing at an
 * internal host is two problems at once: nobody outside WorkOS can install it,
 * and the URL itself advertises internal infrastructure.
 *
 * It happens by accident rather than intent. A machine authenticated to WorkOS's
 * Socket proxy writes `https://socket-firewall.workos.dev/...` into `resolved`
 * for anything it installs, and the result looks completely normal locally — the
 * tarballs are identical, so `npm ci` and every test pass. CI then fails at
 * `npm ci` with E401 before a single check runs, which is what happened on #45.
 *
 * The failure mode this guards is therefore not "a broken build" — it is "a
 * lockfile that works for whoever wrote it and nobody else".
 */
import { readFileSync } from "node:fs";

const ALLOWED_HOST = "registry.npmjs.org";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

/** Every `resolved` URL in the tree, with the package path that carries it. */
function resolvedUrls(packages) {
  return Object.entries(packages ?? {})
    .filter(([, entry]) => typeof entry?.resolved === "string")
    .map(([path, entry]) => ({ path: path || "(root)", url: entry.resolved }));
}

const entries = resolvedUrls(lock.packages);
if (entries.length === 0) {
  console.error("check-public-registry: no resolved URLs found — is package-lock.json intact?");
  process.exit(1);
}

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
      `registry proxy. The tarballs are the same, so only the URL is wrong — fix it with:\n\n` +
      `  sed -i '' 's|https://<internal-host>/|https://${ALLOWED_HOST}/|g' package-lock.json\n\n` +
      `then confirm \`npm ci\` still works from a clean directory.`,
  );
  process.exit(1);
}

console.log(`✓ all ${entries.length} dependencies resolve from ${ALLOWED_HOST}`);
