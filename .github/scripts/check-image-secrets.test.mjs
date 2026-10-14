import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const scriptPath = fileURLToPath(new URL("./check-image-secrets.sh", import.meta.url));

// The real script only ever talks to `docker save` and `docker image inspect`.
// This stand-in answers both from a prepared tarball, so the layer scan runs
// end to end against the system tar with no daemon.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  save)
    out=""
    while [ $# -gt 0 ]; do
      [ "$1" = "-o" ] && out="$2"
      shift
    done
    cp "$FAKE_IMAGE_TAR" "$out"
    ;;
  image)
    # No Config.Env: the config-env branch of the scan is not under test here.
    ;;
  *)
    echo "fake docker: unexpected call: $*" >&2
    exit 64
    ;;
esac
`;

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${cmd} ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

/**
 * Build what `docker save` would write for a one-layer image whose layer holds
 * the given files, keyed by in-image path. Every member goes in verbatim —
 * including a top-level name beginning with a dash, which is the whole point.
 */
function buildImageTar(root, files) {
  const content = join(root, "content");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(content, dirname(path)), { recursive: true });
    writeFileSync(join(content, path), body);
  }
  const outer = join(root, "outer", "blobs", "sha256");
  mkdirSync(outer, { recursive: true });
  run("tar", ["-cf", join(outer, "layer"), "-C", content, "--", ...readdirSync(content)]);
  const imageTar = join(root, "image.tar");
  run("tar", ["-cf", imageTar, "-C", join(root, "outer"), "."]);
  return imageTar;
}

function scanImageWith(files) {
  const root = mkdtempSync(join(tmpdir(), "check-image-secrets-"));
  try {
    const imageTar = buildImageTar(root, files);
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), FAKE_DOCKER);
    chmodSync(join(bin, "docker"), 0o755);
    return spawnSync("bash", [scriptPath, "fake:image"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_IMAGE_TAR: imageTar },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILLED_NPMRC = "//registry.example/:_authToken=hunter2\n";

test("passes an image whose .npmrc carries no credential", () => {
  const result = scanImageWith({ "app/.npmrc": "registry=https://registry.npmjs.org/\n" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no secrets/);
});

test("fails an image whose .npmrc carries an auth token", () => {
  const result = scanImageWith({ "app/.npmrc": FILLED_NPMRC });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /app\/\.npmrc/);
});

// A member name beginning with a dash reaches `tar -xf` as a positional
// argument. Without an option terminator tar reads it as an option, extracts
// nothing, and the scan passes an image it never looked inside.
test("still reads a credential file whose path begins with a dash", () => {
  const result = scanImageWith({ "--help/.npmrc": FILLED_NPMRC });

  assert.equal(result.status, 1, `scan passed without extracting the file:\n${result.stdout}`);
  assert.match(result.stderr, /--help\/\.npmrc/);
});
