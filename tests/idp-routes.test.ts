import { afterEach, describe, expect, it } from "vitest";
import idpWorker from "../workers/idp/index";
import proxyWorker from "../workers/proxy/index";
import { bundledDemoEndpoints, SIMULATOR_REQUEST_HEADER } from "../workers/shared/client-tokens";
import { setConfig } from "../workers/shared/db";
import type { PocEnv } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  NATIVE_URL,
  proxyRequest,
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

const LOOPBACK = "http://127.0.0.1:8787";

/** The demo directory as boot seeds it: both legs on this process's own fakes. */
async function seedDemo(env: PocEnv, opts: Parameters<typeof seedDirectory>[1] = {}) {
  await setConfig(env.DB, "proxy.loopback_url", LOOPBACK);
  return seedDirectory(env.DB, { ...bundledDemoEndpoints(LOOPBACK), ...opts });
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
      const directory = await seedDemo(env);

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
      const directory = await seedDemo(env);

      const res = await call(env, "/state", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ directoryId: directory.id }).toString(),
      });

      expect(res.status).toBe(200);
    });

    it("accepts a multipart body", async () => {
      const env = await createEnv();
      const directory = await seedDemo(env);
      const form = new FormData();
      form.set("directoryId", directory.id);

      // No explicit Content-Type: FormData sets it, boundary included.
      const res = await call(env, "/state", { method: "POST", body: form });

      expect(res.status).toBe(200);
    });

    it("accepts either encoding when the request carries no content type at all", async () => {
      const env = await createEnv();
      const directory = await seedDemo(env);

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
      const directory = await seedDemo(env);

      const res = await call(env, `/state?directoryId=${directory.id}`, { method: "POST" });

      expect(res.status).toBe(200);
    });

    it("trims an id pasted with whitespace", async () => {
      const env = await createEnv();
      const directory = await seedDemo(env);

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
      await seedDemo(env);

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
      const directory = await seedDemo(env, { name: "Demo directory" });

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
      await seedDemo(env, { proxy_token: "tok_secret_value" });

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
      const demo = await seedDemo(env, { name: "Demo directory" });
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
      await seedDemo(env, { name: "Demo directory" });
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

  /**
   * An operator can repoint the demo row at a real SCIM app from the panel. The
   * simulator still holds that row's proxy token, so it must stop driving the row
   * the moment either upstream leg is no longer one of the bundled fakes.
   */
  describe("a demo directory repointed at a real upstream", () => {
    for (const leg of ["native_url", "workos_url"] as const) {
      it(`refuses to provision once ${leg} is repointed, and stops naming it`, async () => {
        const env = await createEnv();
        const demo = await seedDemo(env, { name: "Demo directory" });
        await env.DB.prepare(`UPDATE scim_directories SET ${leg} = ? WHERE id = ?`)
          .bind("https://scim.victim.example/scim/v2", demo.id)
          .run();
        await setConfig(env.DB, "proxy.public_url", "https://native.test");
        fake = installFakeUpstreams();
        fake.route("native", "POST", "/Users", () => scimJson(201, { id: "usr_1" }));

        const res = await call(env, "/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryId: demo.id,
            action: "create-user",
            userName: "backdoor@victim.example",
            externalId: "attacker-1",
          }),
        });

        expect(res.status).toBe(400);
        expect(fake.calls).toHaveLength(0);
        expect(((await res.json()) as { known: unknown[] }).known).toEqual([]);
      });
    }
  });

  describe("the route the bug was reported against", () => {
    it("seeds the directory from a form-encoded POST /seed", async () => {
      const env = await createEnv();
      const directory = await seedDemo(env);
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

/**
 * The route check above runs once, but a seed or tick sends many SCIM requests
 * after it. The proxy re-checks the row it is about to forward with, so an
 * endpoint edit landing mid-seed still cannot redirect the rest of the writes.
 */
describe("proxy, for simulator traffic", () => {
  it("refuses to forward once the demo row is repointed", async () => {
    const env = await createEnv();
    const demo = await seedDemo(env);
    await env.DB.prepare("UPDATE scim_directories SET native_url = ? WHERE id = ?")
      .bind("https://scim.victim.example/scim/v2", demo.id)
      .run();
    fake = installFakeUpstreams();

    const res = await proxyWorker.fetch(
      proxyRequest(
        demo,
        "POST",
        "/scim/v2/Users",
        { userName: "backdoor@victim.example" },
        {
          [SIMULATOR_REQUEST_HEADER]: "1",
        },
      ),
      env,
      createCtx(),
    );

    expect(res.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("forwards while the demo row still points at the bundled fakes", async () => {
    const env = await createEnv();
    const demo = await seedDemo(env);
    fake = installFakeUpstreams();

    const res = await proxyWorker.fetch(
      proxyRequest(demo, "GET", "/scim/v2/Users", undefined, { [SIMULATOR_REQUEST_HEADER]: "1" }),
      env,
      createCtx(),
    );

    // The loopback fakes are not in this test's fetch table, so the forward itself
    // fails upstream; what matters is that the proxy tried rather than refused.
    expect(res.status).not.toBe(403);
    expect(await res.text()).not.toContain("only drives a directory wired to the bundled fakes");
  });
});
