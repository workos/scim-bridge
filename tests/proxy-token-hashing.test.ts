import { describe, expect, it } from "vitest";
import {
  backfillProxyTokenHashes,
  getDirectoryByToken,
  insertDirectory,
  rotateProxyToken,
  setConfig,
} from "../workers/shared/db";
import { hashProxyToken } from "../workers/shared/crypto";
import {
  clientTokenFor,
  DEMO_DIRECTORY_ID_KEY,
  forgetClientTokens,
  publishMintedToken,
} from "../workers/shared/client-tokens";
import { createUser } from "../workers/idp/client";
import { fetchDirectoryStatus } from "../workers/native/status-client";
import { newDirectoryId } from "../workers/shared/ids";
import type { Directory, PocEnv } from "../workers/shared/types";
import type { Datastore } from "../workers/shared/datastore";
import { createEnv, installFakeUpstreams, seedDirectory } from "./helpers";

/**
 * ENT-6742: the proxy token is stored as a digest, so the database holds nothing
 * that can be presented as a credential.
 *
 * The whole suite runs on both engines, so everything here is checked against
 * SQLite and Postgres — which matters most for the backfill, whose write goes
 * through `batch()`.
 *
 * The risk in this change is not the hashing, it is the *upgrade*: live deployments
 * (including the e2e environment) have rows holding a plaintext token, and their
 * IdPs are configured with it. If the conversion loses or corrupts one of those,
 * that directory stops authenticating and the token cannot be recovered from
 * anywhere — the migration is one-way by construction. So the cases below lean on
 * that path rather than on the happy one.
 */

/** A row as it exists before this change: the token in the clear, in the column
 *  that 0008 renames. Written with raw SQL because no code path produces one any
 *  more, which is exactly why the backfill needs testing against it. */
async function seedLegacyRow(env: PocEnv, token: string): Promise<string> {
  const id = newDirectoryId();
  await env.DB.prepare("INSERT INTO scim_directories (id, name, proxy_token_hash) VALUES (?, ?, ?)")
    .bind(id, "Legacy", token)
    .run();
  return id;
}

/** A directory row with every column filled in, for tests that build one by hand
 *  rather than through a driver. */
const blankDirectory: Directory = {
  id: "dir_stub",
  name: "Stub",
  mode: "passthrough",
  proxy_token_hash: "",
  proxy_token_hint: "",
  native_url: "",
  native_token: "",
  workos_url: "",
  workos_token: "",
  workos_directory_id: null,
  log_persistence: 0,
  created_at: "2026-01-01 00:00:00",
  updated_at: "2026-01-01 00:00:00",
};

/** The narrowest datastore that `getDirectoryByToken` can run against: one that
 *  answers every query with the given row. Lets a test hand the lookup a row the
 *  real engines would never return (see the byte-identity case). */
function stubDatastore(row: Directory): Datastore {
  const statement = {
    bind: () => statement,
    first: async () => row,
    all: async () => ({ results: [row], success: true as const, meta: {} }),
    run: async () => ({ results: [], success: true as const, meta: { changes: 1, duration: 0 } }),
  };
  return { prepare: () => statement, batch: async () => [] } as unknown as Datastore;
}

async function storedRow(env: PocEnv, id: string) {
  return env.DB.prepare(
    "SELECT proxy_token_hash, proxy_token_hint FROM scim_directories WHERE id = ?",
  )
    .bind(id)
    .first<{ proxy_token_hash: string; proxy_token_hint: string }>();
}

describe("proxy token hashing", () => {
  describe("lookup", () => {
    it("resolves a directory by hashing the presented token", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { proxy_token: "tok_presented" });

      expect(await getDirectoryByToken(env.DB, "tok_presented")).toMatchObject({
        id: directory.id,
      });
    });

    it("does not resolve a directory from the digest itself", async () => {
      // Presenting the stored value must not work: otherwise a leaked database row
      // is still a usable credential and hashing has bought nothing.
      const env = await createEnv();
      await seedDirectory(env.DB, { proxy_token: "tok_presented" });

      expect(await getDirectoryByToken(env.DB, await hashProxyToken("tok_presented"))).toBeNull();
    });

    it("does not resolve a directory from its hint", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { proxy_token: "tok_presented" });

      expect(directory.proxy_token_hint).toBe("nted");
      expect(await getDirectoryByToken(env.DB, "nted")).toBeNull();
    });

    it("rejects a row the query matched but whose digest is not byte-identical", async () => {
      /*
       * The constant-time recheck after the lookup.
       *
       * This one needs a stub datastore, and the reason is the interesting part: no
       * real query can reach the recheck today. Both engines compare TEXT byte-wise,
       * so a row whose digest differs — in case or anything else — is simply not
       * returned, and my first attempt at this test passed with the recheck deleted.
       * The recheck defends against a *future* schema where that stops holding: a
       * nondeterministic Postgres collation, or this column becoming CHAR with its
       * blank-padded equality. So the state is constructed directly instead of being
       * coaxed out of SQL that cannot produce it.
       */
      const hash = await hashProxyToken("tok_presented");
      const rowWithADifferentDigest = { ...blankDirectory, proxy_token_hash: hash.toUpperCase() };
      const db = stubDatastore(rowWithADifferentDigest);

      expect(await getDirectoryByToken(db, "tok_presented")).toBeNull();
      // Same stub, digest byte-identical: proves the null above is the compare
      // talking and not the stub failing to return anything.
      expect(
        await getDirectoryByToken(
          stubDatastore({ ...blankDirectory, proxy_token_hash: hash }),
          "tok_presented",
        ),
      ).toMatchObject({ id: "dir_stub" });
    });
  });

  describe("upgrading a deployment that stored plaintext", () => {
    it("converts a legacy row so its existing token still authenticates", async () => {
      const env = await createEnv();
      const id = await seedLegacyRow(env, "okta_tok_live_9f3a");

      // Before: the plaintext is in the column, so hashing the presented token
      // finds nothing — this is the state a deployment upgrades from.
      expect(await getDirectoryByToken(env.DB, "okta_tok_live_9f3a")).toBeNull();

      expect(await backfillProxyTokenHashes(env.DB)).toBe(1);

      expect(await getDirectoryByToken(env.DB, "okta_tok_live_9f3a")).toMatchObject({ id });
      expect(await storedRow(env, id)).toEqual({
        proxy_token_hash: await hashProxyToken("okta_tok_live_9f3a"),
        // The one moment this is available: last 4 of a plaintext that is about to
        // stop existing anywhere.
        proxy_token_hint: "9f3a",
      });
    });

    it("is idempotent, and does not hash a hash", async () => {
      // The failure that would break every directory at once: a second boot
      // re-hashing what the first boot hashed. Nothing would look wrong until an
      // IdP's next request 401s, and the plaintext is gone by then.
      const env = await createEnv();
      const id = await seedLegacyRow(env, "okta_tok_live_9f3a");
      await backfillProxyTokenHashes(env.DB);
      const afterFirst = await storedRow(env, id);

      expect(await backfillProxyTokenHashes(env.DB)).toBe(0);

      expect(await storedRow(env, id)).toEqual(afterFirst);
      expect(await getDirectoryByToken(env.DB, "okta_tok_live_9f3a")).toMatchObject({ id });
    });

    it("converges from a half-converted table, leaving the done rows byte-identical", async () => {
      // The realistic bad state: a container killed partway through the pass, so
      // some rows are hashed and some are not. Prefix-driven detection handles it by
      // construction — but "by construction" is the kind of claim that stops being
      // true quietly, so it is asserted rather than trusted.
      const env = await createEnv();
      const legacy = await seedLegacyRow(env, "okta_tok_live_9f3a");
      const alreadyDone = await seedDirectory(env.DB, { proxy_token: "tok_current" });
      const untouched = await storedRow(env, alreadyDone.id);

      expect(await backfillProxyTokenHashes(env.DB)).toBe(1);

      // One boot finishes the job: both authenticate afterwards.
      expect(await getDirectoryByToken(env.DB, "okta_tok_live_9f3a")).toMatchObject({
        id: legacy,
      });
      expect(await getDirectoryByToken(env.DB, "tok_current")).toMatchObject({
        id: alreadyDone.id,
      });
      // And the row that was already done was not rewritten — a re-hash here would
      // be silent, and would retire a credential an IdP is still presenting.
      expect(await storedRow(env, alreadyDone.id)).toEqual(untouched);
    });

    it("captures the hint in the same pass as the hash, because there is no later", async () => {
      // Hash now, hint "in a follow-up" is hint never: the last 4 characters live in
      // the plaintext this pass overwrites. Separate from the conversion test above
      // so a regression names which half went missing.
      const env = await createEnv();
      const id = await seedLegacyRow(env, "okta_tok_live_9f3a");

      await backfillProxyTokenHashes(env.DB);

      const row = await storedRow(env, id);
      expect(row?.proxy_token_hash).toBe(await hashProxyToken("okta_tok_live_9f3a"));
      expect(row?.proxy_token_hint).toBe("9f3a");
    });

    it("converts a token that is itself 64 hex characters", async () => {
      // Why the stored digest carries a `sha256:v1:` prefix. An imported IdP token
      // (ENT-6741 accepts any) can look exactly like a bare digest, and a backfill
      // that guessed by shape would skip this row and lock the directory out.
      const env = await createEnv();
      const looksLikeADigest = "a".repeat(64);
      const id = await seedLegacyRow(env, looksLikeADigest);

      expect(await backfillProxyTokenHashes(env.DB)).toBe(1);

      expect(await getDirectoryByToken(env.DB, looksLikeADigest)).toMatchObject({ id });
    });

    it("does nothing on a database that never held plaintext", async () => {
      const env = await createEnv();
      await seedDirectory(env.DB, { proxy_token: "tok_current" });

      expect(await backfillProxyTokenHashes(env.DB)).toBe(0);
    });
  });

  describe("rotation", () => {
    it("mints a token that authenticates and retires the one that did", async () => {
      const env = await createEnv();
      const { id } = await insertDirectory(env.DB, { name: "Acme", proxy_token: "tok_old" });

      const rotated = await rotateProxyToken(env.DB, id);

      expect(rotated).toMatch(/^[0-9a-f]{48}$/);
      expect(await getDirectoryByToken(env.DB, rotated)).toMatchObject({ id });
      // The point of rotating: the old credential stops working immediately.
      expect(await getDirectoryByToken(env.DB, "tok_old")).toBeNull();
    });

    it("moves the hint along with the token", async () => {
      // A stale hint is worse than none: the operator compares it with what they
      // pasted into the IdP to decide whether the rotation landed.
      const env = await createEnv();
      const { id } = await insertDirectory(env.DB, { name: "Acme", proxy_token: "tok_old_1234" });

      const rotated = await rotateProxyToken(env.DB, id);

      expect((await storedRow(env, id))?.proxy_token_hint).toBe(rotated.slice(-4));
    });

    it("refuses to report success for a directory that does not exist", async () => {
      const env = await createEnv();

      await expect(rotateProxyToken(env.DB, "dir_0000000000000000")).rejects.toThrow(
        "No directory dir_0000000000000000 to rotate",
      );
    });
  });

  /**
   * The two bundled components that *present* a token rather than verifying one.
   * They read the row before this change, so hashing breaks them — and the IdP
   * simulator is what drives the e2e, so nothing else would have noticed. There was
   * no coverage of `workers/idp/client.ts` at all before these.
   */
  describe("components that present the token", () => {
    it("sends the plaintext from the IdP simulator, not the digest", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { proxy_token: "tok_simulated" });
      // Points the simulator at the fake upstream host, whose base is NATIVE_URL.
      await setConfig(env.DB, "proxy.public_url", "https://native.test");
      const fake = installFakeUpstreams();
      try {
        fake.route("native", "POST", "/Users", Response.json({ id: "u_1" }, { status: 201 }));

        await createUser(
          { env: { DB: env.DB }, directory, origin: "manual" },
          {
            userName: "ada@acme.test",
            externalId: "ext_1",
            givenName: "Ada",
            familyName: "Lovelace",
          },
        );

        expect(fake.calls[0].headers.get("Authorization")).toBe("Bearer tok_simulated");
      } finally {
        fake.restore();
      }
    });

    it("says what is wrong when nothing told the simulator the token", async () => {
      // The state a pre-existing directory lands in: hashed row, no stored copy. A
      // silent empty bearer would surface as a 401 from the proxy and read as if the
      // proxy had rejected a real credential.
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { proxy_token: "tok_simulated" });
      forgetClientTokens();

      await expect(
        createUser(
          { env: { DB: env.DB }, directory, origin: "manual" },
          { userName: "ada@acme.test", externalId: "ext_1", givenName: "A", familyName: "L" },
        ),
      ).rejects.toThrow(`no proxy token for directory ${directory.id}`);
    });

    it("keeps the native app's status client on the token it booted with", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { proxy_token: "tok_declared" });
      await setConfig(env.DB, "proxy.loopback_url", "https://native.test");
      const fake = installFakeUpstreams();
      try {
        fake.route("native", "GET", "/status/directories/", () =>
          Response.json({ directory_id: directory.id, mode: "workos-only" }),
        );

        await fetchDirectoryStatus(env.DB, directory);

        expect(fake.calls[0].headers.get("Authorization")).toBe("Bearer tok_declared");
      } finally {
        fake.restore();
      }
    });

    it("stays inert instead of guessing when it has no token", async () => {
      const env = await createEnv();
      const directory = await seedDirectory(env.DB, { proxy_token: "tok_declared" });
      await setConfig(env.DB, "proxy.loopback_url", "https://native.test");
      forgetClientTokens();
      const fake = installFakeUpstreams();
      try {
        // No route registered: an unauthenticated request would 501 loudly here.
        expect(await fetchDirectoryStatus(env.DB, directory)).toBeNull();
        expect(fake.calls).toHaveLength(0);
      } finally {
        fake.restore();
      }
    });
  });

  /**
   * `publishMintedToken` is the one decision point for the panel's three mint paths.
   * Both directions are checked because both are real: the demo/e2e simulator dies
   * without the copy, and production leaks the plaintext with it. The route wiring
   * itself is covered in tests/directory-import.test.ts, the one suite allowed to
   * import a panel route.
   */
  describe("where the plaintext copy is written", () => {
    async function plaintextRows(env: PocEnv): Promise<{ key: string; value: string }[]> {
      const { results } = await env.DB.prepare("SELECT key, value FROM poc_config").all<{
        key: string;
        value: string;
      }>();
      return results;
    }

    it("hands the bundled demo directory its token in demo mode", async () => {
      const env = await createEnv();
      const { id, proxy_token } = await insertDirectory(env.DB, { name: "Demo directory" });
      await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, id);

      await publishMintedToken(env.DB, id, proxy_token, { demoMode: true });

      expect(await clientTokenFor(env.DB, id)).toBe(proxy_token);
    });

    it("writes nothing for another directory, even in demo mode", async () => {
      // The keying that made the simulator a confused deputy: gating on the
      // process-wide flag kept a usable plaintext credential for every real
      // directory minted or rotated while a demo was running, and /__demo answers
      // without panel credentials (VULN-3076).
      const env = await createEnv();
      const demo = await insertDirectory(env.DB, { name: "Demo directory" });
      await setConfig(env.DB, DEMO_DIRECTORY_ID_KEY, demo.id);
      const { id, proxy_token } = await insertDirectory(env.DB, { name: "Acme" });
      forgetClientTokens();

      await publishMintedToken(env.DB, id, proxy_token, { demoMode: true });

      expect(await clientTokenFor(env.DB, id)).toBeNull();
      const values = (await plaintextRows(env)).map((row) => row.value);
      expect(values).not.toContain(proxy_token);
    });

    it("writes nothing at all outside demo mode", async () => {
      const env = await createEnv();
      const { id, proxy_token } = await insertDirectory(env.DB, { name: "Acme" });
      forgetClientTokens();

      await publishMintedToken(env.DB, id, proxy_token, { demoMode: false });

      expect(await clientTokenFor(env.DB, id)).toBeNull();
      // Not just "the idp. key is absent" — no row anywhere holds the token.
      const values = (await plaintextRows(env)).map((row) => row.value);
      expect(values).not.toContain(proxy_token);
    });
  });
});
