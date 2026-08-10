import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The panel reaches nothing but the host that served it, and vendors nothing.
 *
 * This replaces tests/vendored-design-system.test.ts, which asserted that every
 * vendored file carried a `@ts-nocheck` header. Deleting the vendored tree removed
 * what that guard protected, and a guard for a thing that no longer exists is worse
 * than none — but the invariant underneath it is real and worth keeping, one level
 * up:
 *
 *  1. No `app/vendor/**`. The 470-file copy of the WorkOS design system is what
 *     made this repository unpublishable, and 299 of those files were a
 *     modified fork of `@radix-ui/themes`, which is an npm dependency.
 *  2. No WorkOS-controlled hosts in anything the browser loads. The vendored CSS
 *     declared `@font-face` rules against `https://cdn.workos.com/fonts/*` and
 *     referenced 237 `images.workoscdn.com` URLs, so opening the panel of a bridge
 *     a *customer* self-hosts made live requests to WorkOS infrastructure. Fonts
 *     are now served out of the bridge's own /assets.
 *
 * The registry half of the same concern — that every *dependency* resolves from
 * the public npm registry — is guarded separately, in the lockfile check (#50).
 */
const ROOT = new URL("..", import.meta.url).pathname;
const APP = join(ROOT, "app");
const SOURCE = new Set([".ts", ".tsx", ".css", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Hosts that must not appear in anything the panel ships. Deliberately the
 * WorkOS-operated asset hosts rather than "any external URL": a docs link in a
 * comment is fine, a font the browser fetches is not.
 */
const FORBIDDEN_HOSTS = ["cdn.workos.com", "images.workoscdn.com", "workoscdn.com"];

/**
 * Block comments are stripped before scanning, because the files that removed
 * these hosts explain in prose which hosts they removed — app/theme.css names
 * `cdn.workos.com` in the comment justifying why the fonts are now local. A guard
 * that fires on its own rationale gets deleted rather than obeyed.
 *
 * Only `/* … *␘/` is stripped, never `//` to end-of-line: `//` appears inside
 * every `https://` URL, and a strip that ate those would turn this guard silently
 * inert — the one failure direction that matters here.
 */
function withoutBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
      continue;
    }
    if (SOURCE.has(extname(entry))) found.push(path);
  }
  return found;
}

describe("the panel is self-contained", () => {
  const files = sourceFiles(APP);

  it("has source files to check in the first place", () => {
    // Guards the guard: a walk that found nothing would make the assertions
    // below pass by vacuity, which is how the last one nearly shipped hollow.
    expect(files.length).toBeGreaterThan(10);
  });

  it("vendors no third-party source tree", () => {
    expect(
      existsSync(join(APP, "vendor")),
      "app/vendor was deleted; depend on the published package instead of copying it in",
    ).toBe(false);
  });

  it("references no WorkOS-operated asset host", () => {
    const offenders = files.flatMap((path) => {
      const source = withoutBlockComments(readFileSync(path, "utf8"));
      return FORBIDDEN_HOSTS.filter((host) => source.includes(host)).map(
        (host) => `${relative(ROOT, path)} → ${host}`,
      );
    });

    expect(
      offenders,
      "the panel runs inside a customer's infrastructure; it must not fetch assets from WorkOS. " +
        "Vendor the asset into app/ or install it from npm.",
    ).toEqual([]);
  });
});
