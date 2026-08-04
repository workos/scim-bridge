import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The vendored design system is excluded from typechecking by a `@ts-nocheck`
 * header that `npm run sync-design-system` writes (ENT-6755).
 *
 * This exists because the exclusion lives in generated files: a sync run with an
 * older copy of the script would silently drop the headers, and the only symptom
 * would be ~59 type errors reappearing in a directory nobody reads — after which
 * the tempting fix is to loosen the gate rather than re-run the sync. So the
 * property is asserted here instead of trusted.
 *
 * `npm run sync-design-system -- --mark-only` re-applies the headers without
 * needing the monorepo checked out.
 */
const VENDOR = new URL("../app/vendor/design-system", import.meta.url).pathname;
const CHECKED = new Set([".ts", ".tsx", ".cjs", ".mjs", ".js", ".jsx"]);

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
      continue;
    }
    if (CHECKED.has(extname(entry))) found.push(path);
  }
  return found;
}

describe("vendored design system", () => {
  const files = sourceFiles(VENDOR);

  it("has source files to check in the first place", () => {
    // Guards the guard: a walk that found nothing would make every assertion
    // below pass by vacuity.
    expect(files.length).toBeGreaterThan(50);
  });

  it("marks every source file @ts-nocheck", () => {
    const unmarked = files
      .filter((path) => !readFileSync(path, "utf8").startsWith("// @ts-nocheck"))
      .map((path) => path.slice(VENDOR.length + 1));

    expect(
      unmarked,
      "run `npm run sync-design-system -- --mark-only`; the sync script writes these headers",
    ).toEqual([]);
  });

  it("keeps the header pointing at where the file is actually edited", () => {
    // A header that says only "@ts-nocheck" invites someone to fix the errors
    // here, where the next sync overwrites the fix.
    const header = readFileSync(files[0], "utf8").split("\n").slice(0, 2).join("\n");

    expect(header).toContain("workos/packages/design-system");
    expect(header).toContain("sync-design-system");
  });
});
