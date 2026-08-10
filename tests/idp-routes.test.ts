import { afterEach, describe, expect, it } from "vitest";
import idpWorker from "../workers/idp/index";
import { setConfig } from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  NATIVE_URL,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

/**
 * The IdP simulator's HTTP surface.
 *
 * `POST /__demo/idp/seed` returned 400 "Unknown or missing directoryId." for a
 * directoryId that was perfectly valid. The cause was the body parser, not the
 * validation: it read JSON only, and `curl -d …` sends
 * `application/x-www-form-urlencoded`, so the parse threw, the catch returned `{}`,
 * and the route reported the id as unknown.
 *
 * It stayed hidden because the panel is the only caller in the codebase and it always
 * sends JSON (`callIdpSimulator`). The callers this breaks are the ones DEMO_MODE
 * invites: a person or a script driving the simulator by hand.
 *
 * These are the first tests over `workers/idp/` at all, so the encodings are covered
 * one by one rather than assumed to share a path.
 */

/** Drive the worker the way the mount in server/index.ts does: prefix stripped. */
function call(env: PocEnv, path: string, init?: RequestInit): Promise<Response> {
  return idpWorker.fetch(
    new Request(`https://bridge.test${path}`, init),
    env as never,
    createCtx(),
  );
}

let fake: FakeUpstreams | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
});

describe("IdP simulator routes", () => {
  describe("finding the directory a request is about", () => {
    it("accepts a JSON body", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await call(env, "/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryId: directory.id }),
      });

      expect(res.status).toBe(200);
    });

    it("accepts a form-encoded body — the reported bug", async () => {
      // What `curl -d directoryId=…` sends, and what every form in the panel sends.
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await call(env, "/state", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ directoryId: directory.id }).toString(),
      });

      expect(res.status).toBe(200);
    });

    it("accepts a multipart body", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      const form = new FormData();
      form.set("directoryId", directory.id);

      // No explicit Content-Type: FormData sets it, boundary included.
      const res = await call(env, "/state", { method: "POST", body: form });

      expect(res.status).toBe(200);
    });

    it("accepts either encoding when the request carries no content type at all", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      for (const body of [
        JSON.stringify({ directoryId: directory.id }),
        new URLSearchParams({ directoryId: directory.id }).toString(),
      ]) {
        const res = await call(env, "/state", { method: "POST", body });

        expect(res.status, body).toBe(200);
      }
    });

    it("accepts a query parameter", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await call(env, `/state?directoryId=${directory.id}`, { method: "POST" });

      expect(res.status).toBe(200);
    });

    it("trims an id pasted with whitespace", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);

      const res = await call(env, "/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryId: `  ${directory.id}\n` }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("saying which mistake was made", () => {
    it("names the three ways to send an id when none arrived", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB);

      const res = await call(env, "/state", { method: "POST" });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      // The old message said "Unknown or missing" for this case too, which sent the
      // reader looking for a wrong id instead of a missing field.
      expect(body.error).toContain("No directoryId");
      expect(body.error).toContain("JSON");
      expect(body.error).toContain("form field");
      expect(body.error).toContain("?directoryId=");
    });

    it("names the id and lists the ones that exist when the id is unknown", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { name: "Demo directory" });

      const res = await call(env, "/state?directoryId=dir_0000000000000000", { method: "POST" });
      const body = (await res.json()) as {
        error: string;
        known: { id: string; name: string }[];
      };

      expect(res.status).toBe(400);
      expect(body.error).toContain("dir_0000000000000000");
      expect(body.known).toEqual([{ id: directory.id, name: "Demo directory" }]);
    });

    it("lists nothing but the id and name of a known directory", async () => {
      // The rest of a directory row is credentials (hashes, encrypted upstream
      // tokens). A diagnostic that helpfully dumps the row would be a leak.
      const env = await createEnv();
      await seedDirectory(env.DB, { proxy_token: "tok_secret_value" });

      const res = await call(env, "/state?directoryId=dir_0000000000000000", { method: "POST" });
      const raw = await res.text();

      expect(raw).not.toContain("tok_secret_value");
      expect(raw).not.toContain("native-secret");
      expect(raw).not.toContain("proxy_token_hash");
    });
  });

  /**
   * The simulator is mounted without panel credentials (`panelAuthExempt`), so the
   * only thing standing between an anonymous caller and a real directory's stored
   * credentials is which ids it will resolve. It resolves one: the bundled demo
   * directory. A second directory here stands in for an operator's own import.
   */
  describe("the directories it refuses to drive", () => {
    it("refuses an operator's imported directory and does not name it", async () => {
      const env = await createEnv();
      const demo = await seedDirectory(env.DB, { name: "Demo directory" });
      const imported = await seedDirectory(env.DB, { name: "Acme Corp — Okta" });

      const res = await call(env, "/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryId: imported.id }),
      });
      const raw = await res.text();

      expect(res.status).toBe(400);
      // Enumeration is the first half of the attack: the anonymous caller learns
      // which directories this bridge migrates before it picks one to write to.
      // Echoing back the id it supplied tells it nothing; naming the row does.
      expect(raw).not.toContain("Acme Corp");
      expect(JSON.parse(raw).known).toEqual([{ id: demo.id, name: "Demo directory" }]);
    });

    it("refuses to provision into an imported directory", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { name: "Demo directory" });
      const imported = await seedDirectory(env.DB, { name: "Acme Corp — Okta" });
      await setConfig(env.DB, "proxy.public_url", "https://native.test");
      fake = installFakeUpstreams();
      fake.route("native", "POST", "/Users", () => scimJson(201, { id: "usr_1" }));

      const res = await call(env, "/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryId: imported.id,
          action: "create-user",
          userName: "backdoor@victim-corp.com",
          externalId: "attacker-chosen",
        }),
      });

      expect(res.status).toBe(400);
      // Rejected before anything reached the proxy — no SCIM write was attempted
      // with the imported directory's credentials.
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe("the route the bug was reported against", () => {
    it("seeds the directory from a form-encoded POST /seed", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB);
      // The simulator posts SCIM to the proxy's public URL; point it at the fake.
      await setConfig(env.DB, "proxy.public_url", "https://native.test");
      fake = installFakeUpstreams();
      fake.route("native", "POST", "/Users", () => scimJson(201, { id: "usr_1" }));
      fake.route("native", "POST", "/Groups", () => scimJson(201, { id: "grp_1" }));
      fake.route("native", "PATCH", "/", () => scimJson(200, {}));

      const res = await call(env, "/seed", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ directoryId: directory.id }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, users: 5, groups: 2 });
      // And it really went out over SCIM rather than only writing rows locally.
      // `path` is relative to NATIVE_URL, which is already the `/scim/v2` base.
      expect(fake.callsTo("native").length).toBeGreaterThan(0);
      expect(fake.calls[0]).toMatchObject({ method: "POST", path: "/Users" });
    });
  });
});

/** The fake upstream base the simulator is pointed at above. Asserted so the test
 *  fails loudly if NATIVE_URL ever stops being the origin the route table matches. */
it("points the simulator at the fake upstream's origin", () => {
  expect(NATIVE_URL.startsWith("https://native.test")).toBe(true);
});
