import { describe, expect, it } from "vitest";
import {
  backfillProxyTokenHashes,
  getDirectoryByToken,
  insertDirectory,
  rotateProxyToken,
  setConfig,
} from "../workers/shared/db";
import { hashProxyToken } from "../workers/shared/crypto";
import { forgetClientTokens } from "../workers/shared/client-tokens";
import { createUser } from "../workers/idp/client";
import { fetchDirectoryStatus } from "../workers/native/status-client";
import { newDirectoryId } from "../workers/shared/ids";
import type { PocEnv } from "../workers/shared/types";
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

    it("converts only the legacy rows in a mixed table", async () => {
      const env = await createEnv();
      const legacy = await seedLegacyRow(env, "okta_tok_live_9f3a");
      const current = await seedDirectory(env.DB, { proxy_token: "tok_current" });

      expect(await backfillProxyTokenHashes(env.DB)).toBe(1);

      // Both authenticate afterwards, which is the only property an operator cares
      // about — one row was rewritten and the other must not have been touched.
      expect(await getDirectoryByToken(env.DB, "okta_tok_live_9f3a")).toMatchObject({
        id: legacy,
      });
      expect(await getDirectoryByToken(env.DB, "tok_current")).toMatchObject({
        id: current.id,
      });
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
});
