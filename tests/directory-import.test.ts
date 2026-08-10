import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { action, loader as homeLoader } from "../app/routes/panel/home";
import { action as overviewAction } from "../app/routes/panel/directory-overview";
import { datastoreContext, demoModeContext } from "../app/context";
import proxyWorker from "../workers/proxy/index";
import {
  getDirectoryById,
  getDirectoryByToken,
  insertDirectory,
  listDirectories,
} from "../workers/shared/db";
import { hashProxyToken } from "../workers/shared/crypto";
import { clientTokenFor } from "../workers/shared/client-tokens";
import type { Directory, PocEnv } from "../workers/shared/types";
import {
  NATIVE_URL,
  createCtx,
  createEnv,
  installFakeUpstreams,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

/**
 * Directory intake: the panel's two import paths. A directory's `proxy_token` is
 * the credential its IdP presents and the key the proxy routes on, so an import
 * may bring the token the IdP already has (a DNS swap in front of an existing
 * SCIM hostname) instead of minting one.
 */
interface ImportResult {
  error?: string;
  imported?: number;
  importErrors?: string[];
}

/** Submit the panel form as the browser would, returning the action's result. */
async function submit(
  env: PocEnv,
  fields: Record<string, string>,
  demoMode = false,
): Promise<ImportResult | Response> {
  // The real React Router 8 provider, populated exactly as server/index.ts does
  // — so a route reading a context the server never sets fails here too.
  const context = new RouterContextProvider();
  context.set(datastoreContext, env.DB);
  context.set(demoModeContext, demoMode);
  return (await action({
    request: new Request("https://bridge.test/panel", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    context,
    params: {},
  } as unknown as ActionFunctionArgs)) as ImportResult | Response;
}

async function bulkImport(env: PocEnv, csv: string): Promise<ImportResult> {
  return (await submit(env, { intent: "bulk-import", csv })) as ImportResult;
}

async function only(env: PocEnv): Promise<Directory> {
  const rows = await listDirectories(env.DB);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Long enough to pass the fat-finger guard, as any real IdP token is. */
const IDP_TOKEN = "okta_scim_tok_9f3ac81be24d";

/**
 * The token an operator supplied is honoured — which, now that tokens are hashed,
 * means it authenticates and the row does *not* contain it, rather than the row
 * echoing it back. Both halves matter: a bug that stored the plaintext would still
 * let the token authenticate, and a bug that stored nothing would still keep it out.
 */
async function expectStoredToken(row: Directory, token: string): Promise<void> {
  expect(row.proxy_token_hash).toBe(await hashProxyToken(token));
  expect(row.proxy_token_hint).toBe(token.slice(-4));
  expect(JSON.stringify(row)).not.toContain(token);
}

describe("directory import", () => {
  describe("bulk CSV", () => {
    it("imports a row written against the original six columns", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        "Acme — Okta,https://acme.test/scim/v2,tok_native,https://api.workos.com/scim/v2.0/x,tok_workos,directory_01A",
      );

      expect(result).toEqual({ imported: 1, importErrors: [] });
      const row = await only(env);
      expect(row.name).toBe("Acme — Okta");
      expect(row.workos_directory_id).toBe("directory_01A");
      // No seventh column: insertDirectory mints the token (shared/ids.ts). The row
      // holds only its digest now, so the minted shape is pinned where
      // the plaintext still exists — "mints a 48-hex token" below.
      expect(row.proxy_token_hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
      expect(row.proxy_token_hint).toHaveLength(4);
      expect(row.id).toMatch(/^dir_[0-9a-f]{16}$/);
    });

    it("imports the trailing proxy token when a row carries one", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        `Acme — Okta,https://acme.test/scim/v2,tok_native,,,,${IDP_TOKEN}`,
      );

      expect(result).toEqual({ imported: 1, importErrors: [] });
      await expectStoredToken(await only(env), IDP_TOKEN);
    });

    it("accepts a header row and mixes rows with and without the token", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        [
          "name,native_url,native_token,workos_url,workos_token,workos_directory_id,proxy_token",
          `Acme,,,,,,${IDP_TOKEN}`,
          "Beta,,,,,",
        ].join("\n"),
      );

      expect(result).toEqual({ imported: 2, importErrors: [] });
      const rows = await listDirectories(env.DB);
      expect(rows.map((d) => d.name)).toEqual(["Acme", "Beta"]);
      await expectStoredToken(rows[0], IDP_TOKEN);
      expect(rows[1].proxy_token_hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
      expect(rows[1].proxy_token_hash).not.toBe(rows[0].proxy_token_hash);
    });

    it("trims surrounding whitespace off an imported token", async () => {
      const env = await createEnv();

      await bulkImport(env, `Acme,,,,,,  ${IDP_TOKEN}  `);

      await expectStoredToken(await only(env), IDP_TOKEN);
    });

    it("reports the row that duplicates a token and imports the rest", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        [`Acme,,,,,,${IDP_TOKEN}`, `Beta,,,,,,${IDP_TOKEN}`, "Gamma,,,,,"].join("\n"),
      );

      expect(result.imported).toBe(2);
      expect(result.importErrors).toHaveLength(1);
      expect(result.importErrors?.[0]).toContain("Row 2 (Beta)");
      expect(result.importErrors?.[0]).toContain("already belongs to another directory");
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Acme", "Gamma"]);
    });

    it("reports a token that collides with a directory imported earlier", async () => {
      const env = await createEnv();
      await insertDirectory(env.DB, { name: "Already here", proxy_token: IDP_TOKEN });

      const result = await bulkImport(env, `Acme,,,,,,${IDP_TOKEN}`);

      expect(result.imported).toBe(0);
      expect(result.importErrors?.[0]).toContain("Row 1 (Acme)");
      expect(result.importErrors?.[0]).toContain("already belongs to another directory");
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Already here"]);
    });

    it("rejects a token short enough to be a truncated paste", async () => {
      const env = await createEnv();

      const result = await bulkImport(env, ["Acme,,,,,,tok_short", "Beta,,,,,"].join("\n"));

      expect(result.imported).toBe(1);
      expect(result.importErrors?.[0]).toContain("Row 1 (Acme)");
      expect(result.importErrors?.[0]).toContain("at least 16 characters");
      // Rejected before the insert, so no half-imported row.
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Beta"]);
    });

    it("lists a same-second bulk import by name, not by minted id", async () => {
      const env = await createEnv();

      // A bulk import lands every row in one second, so created_at cannot order
      // them and the minted dir_… id is random. Without a meaningful tiebreaker
      // the panel would list an import differently on each engine. The timestamps
      // are pinned rather than assumed: the tie is the precondition under test.
      await bulkImport(env, ["Zeta,,,,,", "Acme,,,,,", "Mid,,,,,"].join("\n"));
      await env.DB.prepare("UPDATE scim_directories SET created_at = ?")
        .bind("2026-08-04 12:00:00")
        .run();

      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Acme", "Mid", "Zeta"]);
    });

    it("still reports a duplicate WorkOS directory id distinctly", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        ["Acme,,,,,directory_01A", "Beta,,,,,directory_01A"].join("\n"),
      );

      expect(result.imported).toBe(1);
      expect(result.importErrors?.[0]).toContain("WorkOS directory id is already assigned");
    });
  });

  describe("single-directory form", () => {
    it("keeps the supplied token and redirects to the new directory", async () => {
      const env = await createEnv();

      const res = (await submit(env, {
        intent: "create-directory",
        name: "Acme — Okta",
        proxy_token: IDP_TOKEN,
      })) as Response;

      const row = await only(env);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(`/panel/directories/${row.id}`);
      await expectStoredToken(row, IDP_TOKEN);
    });

    it("mints a token when the field is left blank", async () => {
      const env = await createEnv();

      await submit(env, { intent: "create-directory", name: "Acme — Okta", proxy_token: "" });

      const row = await only(env);
      expect(row.proxy_token_hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
      // The minted token authenticates, which is the property the old assertion on
      // the plaintext column was really standing in for.
      expect(row.proxy_token_hint).toHaveLength(4);
    });

    it("mints a 48-hex token and stores only its digest", async () => {
      const env = await createEnv();

      // Straight through insertDirectory: the one caller that still sees the
      // plaintext, and so the only place the minted shape is observable.
      const created = await insertDirectory(env.DB, { name: "Acme" });

      expect(created.proxy_token).toMatch(/^[0-9a-f]{48}$/);
      const row = await only(env);
      expect(row.proxy_token_hash).toBe(await hashProxyToken(created.proxy_token));
      expect(row.proxy_token_hint).toBe(created.proxy_token.slice(-4));
      expect(await getDirectoryByToken(env.DB, created.proxy_token)).toMatchObject({ id: row.id });
    });

    it("rejects a duplicate token with a message naming the conflict", async () => {
      const env = await createEnv();
      await insertDirectory(env.DB, { name: "Already here", proxy_token: IDP_TOKEN });

      const result = (await submit(env, {
        intent: "create-directory",
        name: "Acme — Okta",
        proxy_token: IDP_TOKEN,
      })) as ImportResult;

      expect(result.error).toContain("already belongs to another directory");
      expect((await listDirectories(env.DB)).map((d) => d.name)).toEqual(["Already here"]);
    });

    it("rejects a token short enough to be a truncated paste", async () => {
      const env = await createEnv();

      const result = (await submit(env, {
        intent: "create-directory",
        name: "Acme — Okta",
        proxy_token: "tok_short",
      })) as ImportResult;

      expect(result.error).toContain("at least 16 characters");
      expect(await listDirectories(env.DB)).toEqual([]);
    });
  });

  describe("routing on an imported token", () => {
    let fake: FakeUpstreams | undefined;
    afterEach(() => fake?.restore());

    it("routes an IdP request presenting its pre-existing token to that directory", async () => {
      const env = await createEnv();
      await bulkImport(
        env,
        [`Acme,${NATIVE_URL},native-secret,,,,${IDP_TOKEN}`, "Beta,,,,,"].join("\n"),
      );
      fake = installFakeUpstreams();
      fake.route("native", "POST", "/Users", scimJson(201, { id: "nat_1", userName: "a@b.c" }));

      const ctx = createCtx();
      const res = await proxyWorker.fetch(
        new Request("https://bridge.test/scim/v2/Users", {
          method: "POST",
          headers: {
            // The token the IdP was already configured with, unchanged.
            Authorization: `Bearer ${IDP_TOKEN}`,
            "Content-Type": "application/scim+json",
          },
          body: JSON.stringify({ userName: "a@b.c" }),
        }),
        env,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(201);
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("native")[0].headers.get("Authorization")).toBe("Bearer native-secret");
    });
  });

  /**
   * Where the import route leaves a readable copy of the token. The
   * policy itself is `publishMintedToken`, unit-tested in proxy-token-hashing; what
   * this pins is that the *route* asks it, and that an operator's own import is
   * never the directory it answers yes for — the mistake that would put every
   * production token back in the database in readable form.
   */
  describe("the plaintext copy an import leaves behind", () => {
    async function configValues(env: PocEnv): Promise<string[]> {
      const { results } = await env.DB.prepare("SELECT value FROM poc_config").all<{
        value: string;
      }>();
      return results.map((row) => row.value);
    }

    it("keeps none outside demo mode", async () => {
      const env = await createEnv();

      await submit(env, { intent: "create-directory", name: "Acme", proxy_token: IDP_TOKEN });

      expect(await configValues(env)).not.toContain(IDP_TOKEN);
    });

    it("keeps none for an operator's own import, demo mode or not", async () => {
      // The simulator drives the bundled demo directory and nothing else, so an
      // imported directory has no presenter in this process and a readable copy of
      // its token would only be a credential waiting to be used — which is what an
      // unauthenticated /__demo turned it into.
      const env = await createEnv();

      await submit(env, { intent: "create-directory", name: "Acme", proxy_token: IDP_TOKEN }, true);

      const row = await only(env);
      expect(await clientTokenFor(env.DB, row.id)).toBeNull();
      expect(await configValues(env)).not.toContain(IDP_TOKEN);
    });
  });
});

/**
 * One directory per native SCIM namespace — the three panel paths.
 *
 * Two directories on one native endpoint share a single set of SCIM ids, so the
 * bridge cannot tell whose record a native id names. Six downstream guards
 * already defend the consequences (#32, #40, #49, #51, #57, #67); these three
 * checks are what make the situation impossible to configure in the first place.
 *
 * They live in this file, rather than beside the rest of the namespace suite in
 * native-namespace.test.ts, because it is the one test the type gate permits to
 * import a panel route (scripts/check-type-gate.mjs).
 */
const NS_HOST = "https://app.example.com";
const NS_ENDPOINT = `${NS_HOST}/scim/v2`;

/** Post a directory page's form for a given directory id. */
async function postOverview(
  env: PocEnv,
  id: string,
  fields: Record<string, string>,
): Promise<{ error?: string } | Response> {
  const context = new RouterContextProvider();
  context.set(datastoreContext, env.DB);
  context.set(demoModeContext, false);
  return (await overviewAction({
    request: new Request(`https://bridge.test/panel/directories/${id}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    context,
    params: { id },
  } as unknown as ActionFunctionArgs)) as { error?: string } | Response;
}

async function loadHome(env: PocEnv): Promise<{ namespaceWarnings: string[] }> {
  const context = new RouterContextProvider();
  context.set(datastoreContext, env.DB);
  context.set(demoModeContext, false);
  return (await homeLoader({
    request: new Request("https://bridge.test/panel"),
    context,
    params: {},
  } as unknown as LoaderFunctionArgs)) as { namespaceWarnings: string[] };
}

/** This file's `submit`, narrowed to what the namespace assertions read. */
async function nsSubmit(
  env: PocEnv,
  fields: Record<string, string>,
): Promise<ImportResult | Response> {
  return submit(env, fields);
}

function createFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    intent: "create-directory",
    name: "Globex — Entra",
    native_url: NS_ENDPOINT,
    ...overrides,
  };
}

/** The full CSV column order the import expects. */
function csvRow(name: string, nativeUrl: string): string {
  return `${name},${nativeUrl},tok_native,https://api.workos.com/scim/v2.0/x,tok_workos,,`;
}

describe("one directory per native SCIM namespace", () => {
  describe("path 1 — the single-directory form", () => {
    it("refuses a create on an endpoint another directory already uses", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });

      const result = (await nsSubmit(env, createFields())) as { error?: string };

      expect(result.error).toContain("Acme — Okta");
      expect(result.error).toContain(acme.id);
      // Refused, not merely reported: the row must not exist.
      await only(env);
    });

    it("refuses the trailing-slash spelling a string comparison would let through", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });

      const result = (await nsSubmit(env, createFields({ native_url: `${NS_ENDPOINT}/` }))) as {
        error?: string;
      };

      expect(result.error).toMatch(/already in use by/);
      await only(env);
    });

    it("creates a directory on its own path under the same host", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: `${NS_HOST}/scim/acme/v2` });

      const result = await nsSubmit(env, createFields({ native_url: `${NS_HOST}/scim/globex/v2` }));

      // A redirect to the new directory's page is the success path.
      expect(result).toBeInstanceOf(Response);
      expect(await listDirectories(env.DB)).toHaveLength(2);
    });

    it("still creates a directory with no native endpoint alongside one that has it", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });

      const result = await nsSubmit(env, createFields({ native_url: "" }));

      expect(result).toBeInstanceOf(Response);
      expect(await listDirectories(env.DB)).toHaveLength(2);
    });
  });

  describe("path 2 — the bulk CSV import", () => {
    it("refuses the whole file when two of its own rows share an endpoint", async () => {
      const env = await createEnv();
      const csv = [
        csvRow("Acme", `${NS_HOST}/scim/acme/v2`),
        csvRow("Globex", NS_ENDPOINT),
        csvRow("Initech", `${NS_ENDPOINT}/`),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as { error?: string };

      // Atomic: row 1 was perfectly valid and must NOT have landed. A partly
      // applied import leaves an operator with no record of which rows took.
      expect(await listDirectories(env.DB)).toHaveLength(0);
      expect(result.error).toContain("Nothing was imported");
      // Names both sides of the collision by row, since CSV rows have no ids yet.
      expect(result.error).toContain("Row 3 (Initech)");
      expect(result.error).toContain('row 2 ("Globex") of this same import');
    });

    it("refuses the whole file when one row takes a stored directory's endpoint", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const csv = [
        csvRow("Globex", `${NS_HOST}/scim/globex/v2`),
        csvRow("Initech", `${NS_HOST}/scim/v2/`),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as { error?: string };

      await only(env);
      expect(result.error).toContain("Row 2 (Initech)");
      expect(result.error).toContain(acme.id);
    });

    it("imports a file whose rows each have their own path", async () => {
      const env = await createEnv();
      const csv = [
        csvRow("Acme", `${NS_HOST}/scim/acme/v2`),
        csvRow("Globex", `${NS_HOST}/scim/globex/v2`),
        // A row with no endpoint yet is not a duplicate of the other blank one.
        csvRow("Initech", ""),
        csvRow("Umbrella", ""),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as {
        imported?: number;
        importErrors?: string[];
      };

      expect(result.importErrors).toEqual([]);
      expect(result.imported).toBe(4);
      expect(await listDirectories(env.DB)).toHaveLength(4);
    });

    it("ignores the endpoint of a row that would not be imported anyway", async () => {
      const env = await createEnv();
      // Row 1 has no name, so it is skipped before any insert. Its endpoint must
      // not refuse row 2, which is the row that actually lands there.
      const csv = [csvRow("", NS_ENDPOINT), csvRow("Globex", NS_ENDPOINT)].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as {
        imported?: number;
        importErrors?: string[];
      };

      expect(result.imported).toBe(1);
      expect(result.importErrors).toEqual(["Row 1: missing a name in the first column."]);
      expect((await only(env)).native_url).toBe(NS_ENDPOINT);
    });

    it("reports an unparseable endpoint per row and imports nothing", async () => {
      const env = await createEnv();
      const csv = [
        csvRow("Acme", `${NS_HOST}/scim/acme/v2`),
        csvRow("Globex", "app.example.com/scim/v2"),
      ].join("\n");

      const result = (await nsSubmit(env, { intent: "bulk-import", csv })) as { error?: string };

      expect(result.error).toContain("Row 2 (Globex)");
      expect(result.error).toMatch(/not a URL the bridge can parse/);
      expect(await listDirectories(env.DB)).toHaveLength(0);
    });
  });

  describe("path 3 — save-native, which can move a directory", () => {
    it("refuses moving a directory onto another's endpoint", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const globex = await seedDirectory(env.DB, {
        name: "Globex",
        native_url: `${NS_HOST}/scim/globex/v2`,
      });

      const result = (await postOverview(env, globex.id, {
        intent: "save-native",
        native_url: `${NS_ENDPOINT}/`,
        native_token: "tok",
      })) as { error?: string };

      expect(result.error).toContain(acme.id);
      // The move must not have happened — a refusal that still wrote the row
      // would be the worst of both.
      const after = await getDirectoryById(env.DB, globex.id);
      expect(after?.native_url).toBe(`${NS_HOST}/scim/globex/v2`);
    });

    it("lets a directory re-save its own endpoint, including a respelling", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: `${NS_HOST}/scim/acme/v2` });
      const globex = await seedDirectory(env.DB, { name: "Globex", native_url: NS_ENDPOINT });

      const result = (await postOverview(env, globex.id, {
        intent: "save-native",
        native_url: `${NS_ENDPOINT}/`,
        native_token: "rotated",
      })) as { error?: string };

      // Excluding self is what makes rotating the token on an unchanged URL work.
      expect(result.error).toBeUndefined();
      const after = await getDirectoryById(env.DB, globex.id);
      expect(after?.native_url).toBe(`${NS_ENDPOINT}/`);
      expect(after?.native_token).toBe("rotated");
    });

    it("lets a directory move to a free path, and clear its endpoint", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const globex = await seedDirectory(env.DB, {
        name: "Globex",
        native_url: `${NS_HOST}/scim/globex/v2`,
      });

      expect(
        await postOverview(env, globex.id, {
          intent: "save-native",
          native_url: `${NS_HOST}/scim/globex-2/v2`,
          native_token: "tok",
        }),
      ).toEqual({});
      expect(
        await postOverview(env, globex.id, {
          intent: "save-native",
          native_url: "",
          native_token: "",
        }),
      ).toEqual({});
      expect((await getDirectoryById(env.DB, globex.id))?.native_url).toBe("");
    });
  });
  describe("a deployment that already violates the rule", () => {
    it("surfaces the conflict on the panel's directory list", async () => {
      const env = await createEnv();
      const acme = await seedDirectory(env.DB, { name: "Acme — Okta", native_url: NS_ENDPOINT });
      const globex = await seedDirectory(env.DB, { name: "Globex", native_url: `${NS_ENDPOINT}/` });

      const { namespaceWarnings } = await loadHome(env);

      // Container logs from a month ago are not where this gets found.
      expect(namespaceWarnings).toHaveLength(1);
      expect(namespaceWarnings[0]).toContain(acme.id);
      expect(namespaceWarnings[0]).toContain(globex.id);
      expect(namespaceWarnings[0]).toContain(`${NS_HOST}/scim/<tenant>/v2`);
    });

    it("shows nothing on a healthy fleet", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Acme", native_url: `${NS_HOST}/scim/acme/v2` });
      await seedDirectory(env.DB, { name: "Globex", native_url: "" });
      expect((await loadHome(env)).namespaceWarnings).toEqual([]);
    });
  });
});
