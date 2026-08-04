import type { ActionFunctionArgs } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { action } from "../app/routes/panel/home";
import proxyWorker from "../workers/proxy/index";
import { insertDirectory, listDirectories } from "../workers/shared/db";
import type { Directory, PocEnv } from "../workers/shared/types";
import {
  NATIVE_URL,
  createCtx,
  createEnv,
  installFakeUpstreams,
  scimJson,
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
): Promise<ImportResult | Response> {
  return (await action({
    request: new Request("https://bridge.test/panel", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    context: { cloudflare: { env, ctx: createCtx(), demoMode: false } },
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
      // No seventh column: insertDirectory mints the token (shared/ids.ts).
      expect(row.proxy_token).toMatch(/^[0-9a-f]{48}$/);
      expect(row.id).toMatch(/^dir_[0-9a-f]{16}$/);
    });

    it("imports the trailing proxy token when a row carries one", async () => {
      const env = await createEnv();

      const result = await bulkImport(
        env,
        `Acme — Okta,https://acme.test/scim/v2,tok_native,,,,${IDP_TOKEN}`,
      );

      expect(result).toEqual({ imported: 1, importErrors: [] });
      expect((await only(env)).proxy_token).toBe(IDP_TOKEN);
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
      expect(rows[0].proxy_token).toBe(IDP_TOKEN);
      expect(rows[1].proxy_token).toMatch(/^[0-9a-f]{48}$/);
    });

    it("trims surrounding whitespace off an imported token", async () => {
      const env = await createEnv();

      await bulkImport(env, `Acme,,,,,,  ${IDP_TOKEN}  `);

      expect((await only(env)).proxy_token).toBe(IDP_TOKEN);
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

      // Every row lands in the same second, so created_at cannot order them and
      // the minted dir_… id is random. Without a meaningful tiebreaker the panel
      // would list a bulk import in a different order on each engine.
      await bulkImport(env, ["Zeta,,,,,", "Acme,,,,,", "Mid,,,,,"].join("\n"));

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
      expect(row.proxy_token).toBe(IDP_TOKEN);
    });

    it("mints a token when the field is left blank", async () => {
      const env = await createEnv();

      await submit(env, { intent: "create-directory", name: "Acme — Okta", proxy_token: "" });

      expect((await only(env)).proxy_token).toMatch(/^[0-9a-f]{48}$/);
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
});
