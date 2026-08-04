#!/usr/bin/env node
/**
 * Assert both engines ran the same tests.
 *
 * The tempting check is the total — it is the number the runner prints — but a
 * total is satisfied by any two runs that happen to add up, and it moves whenever
 * anything else in tests/ lands. What matters is that no test is present for one
 * engine and missing (or skipped) for the other: that is how "make it pass on
 * Postgres" quietly becomes "don't run it on Postgres".
 *
 * Reads the JSON reports `npm test` and `npm run test:postgres` leave behind, so
 * it costs no extra runs.
 */
import { readFileSync } from "node:fs";

const REPORTS = [
  { engine: "sqlite", path: ".vitest/sqlite.json" },
  { engine: "postgres", path: ".vitest/postgres.json" },
];

function read({ engine, path }) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(
      `Could not read the ${engine} report at ${path}: ${error.message}\n` +
        "Run `npm test` and `npm run test:postgres` first — each writes one.",
    );
    process.exit(1);
  }
  const ran = new Set();
  const skipped = new Set();
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      const name = `${test.ancestorTitles.join(" > ")} > ${test.title}`;
      (test.status === "pending" || test.status === "skipped" ? skipped : ran).add(name);
    }
  }
  return { engine, ran, skipped };
}

const [sqlite, postgres] = REPORTS.map(read);

function difference(a, b) {
  return [...a].filter((name) => !b.has(name)).sort();
}

const failures = [];

const onlySqlite = difference(sqlite.ran, postgres.ran);
const onlyPostgres = difference(postgres.ran, sqlite.ran);
if (onlySqlite.length > 0) {
  failures.push(
    `${onlySqlite.length} test(s) ran on sqlite but not on postgres:\n    ${onlySqlite.slice(0, 10).join("\n    ")}`,
  );
}
if (onlyPostgres.length > 0) {
  failures.push(
    `${onlyPostgres.length} test(s) ran on postgres but not on sqlite:\n    ${onlyPostgres.slice(0, 10).join("\n    ")}`,
  );
}
for (const { engine, skipped, ran } of [sqlite, postgres]) {
  const other = engine === "sqlite" ? postgres : sqlite;
  const skippedHere = [...skipped].filter((name) => other.ran.has(name)).sort();
  if (skippedHere.length > 0) {
    failures.push(
      `${skippedHere.length} test(s) skipped on ${engine} but run on the other engine:\n    ${skippedHere.slice(0, 10).join("\n    ")}`,
    );
  }
  if (ran.size === 0) failures.push(`the ${engine} report contains no passing tests`);
}

if (failures.length > 0) {
  console.error(`Engine parity check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Both engines ran the same ${sqlite.ran.size} tests.`);
