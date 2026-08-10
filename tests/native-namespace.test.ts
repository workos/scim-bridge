import { afterEach, describe, expect, it, vi } from "vitest";
import { listDirectories } from "../workers/shared/db";
import {
  checkNativeNamespace,
  duplicateNativeNamespaces,
  duplicateNativeNamespaceWarnings,
} from "../workers/shared/native-namespace";
import { reportNativeNamespaceDuplicates, seedDemoDirectory } from "../server/config";
import type { AppConfig } from "../server/config";
import type { Directory, PocEnv } from "../workers/shared/types";
import { createEnv, seedDirectory } from "./helpers";

/**
 * One directory per native SCIM namespace: the rule itself, the
 * refusal an operator reads, boot-time seeding, and what happens to a database
 * that already breaks the rule.
 *
 * The three panel paths that can put a directory on a native URL — the
 * single-directory form, the bulk CSV, and `intent=save-native`, which can
 * *move* one — are exercised in `directory-import.test.ts`, the one test the
 * type gate lets import a panel route (see scripts/check-type-gate.mjs).
 */

const HOST = "https://app.example.com";
const ENDPOINT = `${HOST}/scim/v2`;

/** The one directory in the database, asserted to be alone. */
async function only(env: PocEnv): Promise<Directory> {
  const rows = await listDirectories(env.DB);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("one directory per native SCIM namespace", () => {
  describe("the refusal an operator reads", () => {
    it("names the conflicting directory, the endpoint, and a per-directory path", () => {
      const message = checkNativeNamespace(ENDPOINT, [
        { id: "dir_01ACME", name: "Acme — Okta", native_url: ENDPOINT },
      ]);
      expect(message).toContain(ENDPOINT);
      // Which directory collided — by name AND id, because a fleet may hold two
      // directories called "Acme" and the operator has to find the right row.
      expect(message).toContain("Acme — Okta");
      expect(message).toContain("dir_01ACME");
      // The remedy, on their own host rather than a placeholder one. Without it
      // this refusal is a support ticket.
      expect(message).toContain(`${HOST}/scim/<tenant-a>/v2`);
      expect(message).toContain(`${HOST}/scim/<tenant-b>/v2`);
      // Why it matters, so nobody "fixes" it by pointing both at one URL again.
      expect(message).toMatch(/can land on the other's users/);
      // And which differences do NOT count, so the first attempt isn't a slash.
      expect(message).toMatch(/trailing slash/);
    });

    it("puts the tenant segment where the customer's path already is", () => {
      const at = (url: string) =>
        checkNativeNamespace(url, [{ id: "d", name: "Other", native_url: url }]) ?? "";
      // Before a trailing version segment, which is where SCIM services take it.
      expect(at("https://a.test/api/scim/v2.0")).toContain(
        "https://a.test/api/scim/<tenant-a>/v2.0",
      );
      // No version segment to sit in front of: append.
      expect(at("https://a.test/scim")).toContain("https://a.test/scim/<tenant-a>");
      expect(at("https://a.test/")).toContain("https://a.test/<tenant-a>");
      // A bracketed placeholder, not a plausible tenant name: a path that already
      // carries one must not be echoed back as ".../scim/acme/acme/v2", which
      // reads as a bug in the bridge. Caught by reading a real boot warning.
      expect(at(`${HOST}/scim/acme/v2`)).not.toContain("/scim/acme/acme/v2");
    });

    it("explains an unparseable base URL instead of blaming another directory", () => {
      const message = checkNativeNamespace("app.example.com/scim/v2", []);
      // No scheme: `new URL` cannot parse it, so the bridge cannot say what native
      // app it addresses and must not promise this directory has one to itself.
      expect(message).toMatch(/not a URL the bridge can parse/);
      expect(message).toContain("https://app.example.com/scim/v2");
      // It is nobody else's fault, so no other directory is named.
      expect(message).not.toMatch(/already in use by/);
    });
  });

  describe("comparison is canonical, not textual", () => {
    const stored = [{ id: "dir_01", name: "Acme", native_url: "https://app.example.com/scim/v2" }];

    it.each([
      ["a trailing slash", "https://app.example.com/scim/v2/"],
      ["an upper-case host", "https://APP.EXAMPLE.COM/scim/v2"],
      ["the default port written out", "https://app.example.com:443/scim/v2"],
      ["all three at once", "HTTPS://App.Example.COM:443/scim/v2//"],
      ["surrounding whitespace", "  https://app.example.com/scim/v2  "],
    ])("refuses %s", (_label, url) => {
      expect(checkNativeNamespace(url, stored)).toMatch(/already in use by/);
    });

    it.each([
      ["a different path on the same host", "https://app.example.com/scim/tenant-b/v2"],
      ["a different host", "https://other.example.com/scim/v2"],
      ["a non-default port", "https://app.example.com:8443/scim/v2"],
      ["a different scheme", "http://app.example.com/scim/v2"],
    ])("allows %s", (_label, url) => {
      expect(checkNativeNamespace(url, stored)).toBeNull();
    });

    it("allows any number of directories with no native endpoint yet", () => {
      const blanks = [
        { id: "a", name: "A", native_url: "" },
        { id: "b", name: "B", native_url: "   " },
      ];
      expect(checkNativeNamespace("", blanks)).toBeNull();
      expect(checkNativeNamespace("   ", blanks)).toBeNull();
      // And a blank never blocks a real one.
      expect(checkNativeNamespace(ENDPOINT, blanks)).toBeNull();
    });
  });

  describe("path 4 — boot-time seeding", () => {
    const demoConfig = { demoMode: true, port: 8080 } as AppConfig;

    it("seeds the demo directory into an empty database", async () => {
      const env = await createEnv();
      await seedDemoDirectory(env, demoConfig);
      expect((await only(env)).name).toBe("Demo directory");
    });

    it("does not seed a second directory onto the bundled endpoint", async () => {
      const env = await createEnv();
      // The bundled native leg, already taken by an operator's own import.
      await seedDirectory(env.DB, {
        name: "Operator's own",
        native_url: "http://127.0.0.1:8080/__demo/native/scim/v2",
      });

      await seedDemoDirectory(env, demoConfig);

      // Two things hold this line: the existing "no-op once any directory
      // exists" rule, and the namespace check behind it. Removing either alone
      // leaves this green — the other catches it — and removing both turns it
      // red. That is the point of the second one, and it is measured: the
      // namespace check is what keeps the invariant if the precondition is ever
      // relaxed, the same bet as the six downstream guards.
      const rows = await listDirectories(env.DB);
      expect(rows.filter((d) => d.native_url.includes("/__demo/native/scim/v2"))).toHaveLength(1);
    });
  });

  describe("deployments that already violate the rule", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("groups directories that share an endpoint, canonically", () => {
      const groups = duplicateNativeNamespaces([
        { id: "a", name: "A", native_url: ENDPOINT },
        { id: "b", name: "B", native_url: `${ENDPOINT}/` },
        { id: "c", name: "C", native_url: "https://APP.EXAMPLE.COM:443/scim/v2" },
        { id: "d", name: "D", native_url: `${HOST}/scim/d/v2` },
        { id: "e", name: "E", native_url: "" },
        { id: "f", name: "F", native_url: "" },
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBe(ENDPOINT);
      expect(groups[0].directories.map((d) => d.id)).toEqual(["a", "b", "c"]);
    });

    it("treats unparseable base URLs as possibly the same app", () => {
      const groups = duplicateNativeNamespaces([
        { id: "a", name: "A", native_url: "app.example.com" },
        { id: "b", name: "B", native_url: "not a url either" },
      ]);
      // Fail-closed: the bridge cannot prove these address different apps, and
      // being wrong here costs a warning rather than a refusal.
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBeNull();
      expect(duplicateNativeNamespaceWarnings(groups)[0]).toMatch(/cannot parse/);
    });

    it("reads as a sentence, however many directories are in the group", () => {
      const at = (n: number) =>
        duplicateNativeNamespaceWarnings(
          duplicateNativeNamespaces(
            Array.from({ length: n }, (_, i) => ({
              id: `dir_0${i}`,
              name: `D${i}`,
              native_url: ENDPOINT,
            })),
          ),
        )[0];
      // "the directory A, the directory B are all configured" is what the first
      // cut emitted, and it read like a bug. An operator has to be able to scan
      // this in a wall of container logs.
      expect(at(2)).toContain('Directories "D0" (dir_00) and "D1" (dir_01) are configured');
      expect(at(3)).toContain('Directories "D0" (dir_00), "D1" (dir_01) and "D2" (dir_02) are');
    });

    it("warns at boot naming every directory in the group, and does not throw", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: ENDPOINT });
      await seedDirectory(env.DB, { name: "Globex", native_url: `${ENDPOINT}/` });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Returning rather than throwing IS the requirement: an operator locked out
      // of the panel cannot repair the data the panel is the only editor for.
      await expect(reportNativeNamespaceDuplicates(env)).resolves.toBe(1);

      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("Acme — Okta");
      expect(logged).toContain("Globex");
      expect(logged).toContain(ENDPOINT);
    });

    it("says nothing at boot when every directory has its own endpoint", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme", native_url: `${HOST}/scim/acme/v2` });
      await seedDirectory(env.DB, { name: "Globex", native_url: `${HOST}/scim/globex/v2` });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(reportNativeNamespaceDuplicates(env)).resolves.toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
