import { afterEach, describe, expect, it, vi } from "vitest";
import { listDirectories } from "../workers/shared/db";
import {
  checkNativeNamespace,
  duplicateNativeNamespaces,
  duplicateNativeNamespaceWarnings,
  findNativeNamespaceConflict,
  type NamespaceDirectory,
  partitionedNamespaceNotices,
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

/** A stored-directory fixture: unattested, with its own token by default, so
 *  every pre-existing refusal below is proven to hold DESPITE distinct tokens —
 *  distinctness alone must never lift a conflict. */
function dir(
  id: string,
  name: string,
  native_url: string,
  extra: Partial<NamespaceDirectory> = {},
): NamespaceDirectory {
  return {
    id,
    name,
    native_url,
    native_token: `token-${id}`,
    native_token_partitioned: 0,
    ...extra,
  };
}

/** The one directory in the database, asserted to be alone. */
async function only(env: PocEnv): Promise<Directory> {
  const rows = await listDirectories(env.DB);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("one directory per native SCIM namespace", () => {
  describe("the refusal an operator reads", () => {
    it("names the conflicting directory, the endpoint, and a per-directory path", () => {
      const message = checkNativeNamespace(ENDPOINT, [dir("dir_01ACME", "Acme — Okta", ENDPOINT)]);
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
      const at = (url: string) => checkNativeNamespace(url, [dir("d", "Other", url)]) ?? "";
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
    const stored = [dir("dir_01", "Acme", "https://app.example.com/scim/v2")];

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
      const blanks = [dir("a", "A", ""), dir("b", "B", "   ")];
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
        dir("a", "A", ENDPOINT),
        dir("b", "B", `${ENDPOINT}/`),
        dir("c", "C", "https://APP.EXAMPLE.COM:443/scim/v2"),
        dir("d", "D", `${HOST}/scim/d/v2`),
        dir("e", "E", ""),
        dir("f", "F", ""),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0].key).toBe(ENDPOINT);
      expect(groups[0].directories.map((d) => d.id)).toEqual(["a", "b", "c"]);
    });

    it("treats unparseable base URLs as possibly the same app", () => {
      const groups = duplicateNativeNamespaces([
        dir("a", "A", "app.example.com"),
        dir("b", "B", "not a url either"),
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
            Array.from({ length: n }, (_, i) => dir(`dir_0${i}`, `D${i}`, ENDPOINT)),
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

  describe("token-partitioned namespaces (the ENT-6878 opt-out)", () => {
    const attested = (id: string, name: string, token: string) =>
      dir(id, name, ENDPOINT, { native_token: token, native_token_partitioned: 1 });
    const partitionedCandidate = (token: string) => ({
      native_token: token,
      native_token_partitioned: 1,
    });

    it("lifts the conflict only when both sides attest and the tokens differ", () => {
      const holder = attested("dir_01A", "Org A", "token-a");
      expect(checkNativeNamespace(ENDPOINT, [holder], partitionedCandidate("token-b"))).toBeNull();
      // Canonically equivalent spellings of the shared URL are equally lifted.
      expect(
        checkNativeNamespace(`${ENDPOINT}/`, [holder], partitionedCandidate("token-b")),
      ).toBeNull();
      // A third attested tenant joins the same group past two incumbents.
      expect(
        checkNativeNamespace(
          ENDPOINT,
          [holder, attested("dir_01B", "Org B", "token-b")],
          partitionedCandidate("token-c"),
        ),
      ).toBeNull();
    });

    it("keeps the refusal while either side has not opted in", () => {
      const unattested = dir("dir_01A", "Org A", ENDPOINT, { native_token: "token-a" });
      // Candidate attested, holder not: both must opt in.
      expect(checkNativeNamespace(ENDPOINT, [unattested], partitionedCandidate("token-b"))).toMatch(
        /already in use by/,
      );
      // Holder attested, candidate not — the CSV import and the create dialog
      // never attest, so this is also what keeps bulk import strict.
      expect(checkNativeNamespace(ENDPOINT, [attested("dir_01A", "Org A", "token-a")])).toMatch(
        /already in use by/,
      );
    });

    it("names the attestation remedy in the ordinary refusal", () => {
      const message = checkNativeNamespace(ENDPOINT, [dir("dir_01A", "Org A", ENDPOINT)]) ?? "";
      // The path remedy stays first; the attestation is the documented alternative.
      expect(message).toContain(`${HOST}/scim/<tenant-a>/v2`);
      expect(message).toMatch(/token-partitioned/);
    });

    it("refuses equal or empty tokens with the distinct-token message, naming no token", () => {
      const holder = attested("dir_01A", "Org A", "token-shared");
      const equal = checkNativeNamespace(ENDPOINT, [holder], partitionedCandidate("token-shared"));
      // The distinct token IS the boundary being asserted, so the message says
      // that instead of suggesting a path — and never contains the token itself.
      expect(equal).toMatch(/do not tell them apart/);
      expect(equal).not.toContain("token-shared");
      expect(equal).not.toContain("<tenant-a>");
      expect(checkNativeNamespace(ENDPOINT, [holder], partitionedCandidate(""))).toMatch(
        /do not tell them apart/,
      );
    });

    it("treats tokens the bridge cannot decrypt as indistinguishable", () => {
      // Distinct ciphertexts prove nothing about the plaintexts (randomized IV),
      // so attestation over opaque tokens must not lift the refusal.
      const holder = attested("dir_01A", "Org A", "enc:v1:AAAA");
      expect(checkNativeNamespace(ENDPOINT, [holder], partitionedCandidate("enc:v1:BBBB"))).toMatch(
        /do not tell them apart/,
      );
    });

    it("refuses a token edit that would equal a neighbour's in the attested group", () => {
      // The URL is unchanged and already sanctioned; the TOKEN save is what
      // collapses the boundary, so it is what gets refused.
      const neighbours = [
        attested("dir_01A", "Org A", "token-a"),
        attested("dir_01B", "Org B", "token-b"),
      ];
      expect(
        findNativeNamespaceConflict(ENDPOINT, neighbours, partitionedCandidate("token-b"))?.id,
      ).toBe("dir_01B");
      expect(checkNativeNamespace(ENDPOINT, neighbours, partitionedCandidate("token-b"))).toMatch(
        /do not tell them apart/,
      );
    });

    it("groups a fully attested set as partitioned, and reports it as INFO not WARNING", () => {
      const duplicates = duplicateNativeNamespaces([
        attested("dir_01A", "Org A", "token-a"),
        attested("dir_01B", "Org B", "token-b"),
      ]);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].partitioned).toBe(true);
      expect(duplicateNativeNamespaceWarnings(duplicates)).toHaveLength(0);
      const [notice] = partitionedNamespaceNotices(duplicates);
      expect(notice).toContain("Org A");
      expect(notice).toContain("Org B");
      expect(notice).toContain(ENDPOINT);
      expect(notice).toMatch(/attest/);
      // Audit line, not credential material.
      expect(notice).not.toContain("token-a");
      expect(notice).not.toContain("token-b");
    });

    it("keeps warning when the group is only partly attested or a pair's tokens match", () => {
      const partly = duplicateNativeNamespaces([
        attested("dir_01A", "Org A", "token-a"),
        dir("dir_01B", "Org B", ENDPOINT, { native_token: "token-b" }),
      ]);
      expect(partly[0].partitioned).toBe(false);
      expect(duplicateNativeNamespaceWarnings(partly)).toHaveLength(1);
      expect(partitionedNamespaceNotices(partly)).toHaveLength(0);

      const collided = duplicateNativeNamespaces([
        attested("dir_01A", "Org A", "token-shared"),
        attested("dir_01B", "Org B", "token-shared"),
        attested("dir_01C", "Org C", "token-c"),
      ]);
      // One equal pair poisons the whole group: it is only as partitioned as its
      // weakest pair.
      expect(collided[0].partitioned).toBe(false);
      expect(duplicateNativeNamespaceWarnings(collided)).toHaveLength(1);
    });

    it("boot reports an attested group at INFO and counts zero conflicts", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, {
        name: "Org A",
        native_url: ENDPOINT,
        native_token: "token-a",
        native_token_partitioned: 1,
      });
      await seedDirectory(env.DB, {
        name: "Org B",
        native_url: ENDPOINT,
        native_token: "token-b",
        native_token_partitioned: 1,
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(reportNativeNamespaceDuplicates(env)).resolves.toBe(0);

      expect(warn).not.toHaveBeenCalled();
      const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("INFO:");
      expect(logged).toContain("Org A");
      expect(logged).toContain("Org B");
      expect(logged).not.toContain("token-a");
    });
  });
});
