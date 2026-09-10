import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const guardPath = fileURLToPath(new URL("./check-public-registry.mjs", import.meta.url));

function runGuard(packages) {
  const directory = mkdtempSync(join(tmpdir(), "check-public-registry-"));
  const lockPath = join(directory, "package-lock.json");
  writeFileSync(lockPath, JSON.stringify({ packages }));

  try {
    return spawnSync(process.execPath, [guardPath, lockPath], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts a lockfile with omitted registry resolutions", () => {
  const result = runGuard({ "": {}, "node_modules/example": { version: "1.0.0" } });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /omits registry-backed resolved URLs/);
});

test("rejects a private registry resolution", () => {
  const result = runGuard({
    "": {},
    "node_modules/example": {
      version: "1.0.0",
      resolved: "https://private-registry.example/example/-/example-1.0.0.tgz",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /private-registry\.example/);
});
