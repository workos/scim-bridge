#!/usr/bin/env node
/**
 * Prove the type gate can fail.
 *
 * `npm run typecheck` used to run `tsc --noEmit` against a solution file with no
 * files of its own, so it checked nothing and passed on any error for months.
 * A gate nobody has watched fail is indistinguishable from no gate,
 * so this asserts the failure directly: drop a file with a deliberate type error
 * into each gated root, run the gate, and require it to reject.
 *
 * Also guards the one exclusion the gate carries — see tsconfig.check.json.
 *
 * Run by CI after `npm run typecheck`; `npm run typecheck:gate` locally.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One per gated root: a probe here must break the gate. */
const PROBE_ROOTS = ["workers/shared", "server/db", "tests"];
const PROBE_NAME = "__type_gate_probe.ts";
const PROBE_SOURCE = "export const probe: number = \"definitely not a number\";\n";

/** tests/ may not import the panel: that would pull the vendored design system
 *  into the gated project. The gate excludes today's single exception by name. */
const PANEL_IMPORT_EXCEPTION = "directory-import.test.ts";

/**
 * app/ modules that are *in* the gate and cannot reach the vendored tree, so a
 * test importing one is not the thing this check exists to stop. app/context.ts
 * is listed in tsconfig.check.json (server/index.ts imports it) and pulls in
 * react-router plus workers/shared/datastore, nothing else. Anything added here
 * must be in tsconfig.check.json's include and stay clear of app/vendor.
 */
const GATED_APP_MODULES = new Set([
  "../app/context",
  "../app/routes/panel/reconcile",
  "../app/routes/panel/user-count",
]);
const APP_IMPORT = /from "(\.\.\/app\/[^"]*)"|import\("(\.\.\/app\/[^"]*)"\)/g;

function runGate() {
  try {
    execFileSync("npx", ["tsc", "-b", "--force"], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function removeProbes() {
  for (const root of PROBE_ROOTS) rmSync(join(root, PROBE_NAME), { force: true });
}

const failures = [];

// A stale probe from an interrupted run would make everything below meaningless.
removeProbes();

const clean = runGate();
if (!clean.ok) {
  failures.push(`the gate does not pass on a clean tree:\n${clean.output}`);
}

for (const root of PROBE_ROOTS) {
  const probe = join(root, PROBE_NAME);
  writeFileSync(probe, PROBE_SOURCE);
  const result = runGate();
  removeProbes();
  if (result.ok) {
    failures.push(`a deliberate type error in ${root}/ did NOT fail the gate — ${root}/ is not covered`);
  } else if (!result.output.includes(PROBE_NAME)) {
    failures.push(`the gate failed with a probe in ${root}/, but not because of it:\n${result.output}`);
  } else {
    console.log(`✓ ${root}/ is gated`);
  }
}

const crossing = readdirSync("tests")
  .filter((file) => file.endsWith(".ts") && file !== PANEL_IMPORT_EXCEPTION)
  .filter((file) =>
    [...readFileSync(join("tests", file), "utf8").matchAll(APP_IMPORT)]
      .map((match) => match[1] ?? match[2])
      .some((specifier) => !GATED_APP_MODULES.has(specifier)),
  );
if (crossing.length > 0) {
  failures.push(
    `${crossing.join(", ")} import(s) from app/, which pulls the vendored design system into the ` +
      `gated project. Either extract the logic under test out of the panel route, or bring app/ ` +
      `into the gate — don't add another name to tsconfig.check.json's exclude list.`,
  );
} else {
  console.log("✓ tests/ does not reach the vendored design system");
}

if (failures.length > 0) {
  console.error(`\ntype gate check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nThe type gate rejects a deliberate error in every gated root.");
