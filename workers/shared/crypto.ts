/**
 * Envelope encryption for per-directory secrets at rest (the native and WorkOS
 * bearer tokens). AES-256-GCM via Web Crypto, which is available identically on
 * Node and Cloudflare Workers.
 *
 * Encrypted values are stored as `enc:v1:<base64(iv‖ciphertext)>`. Any value
 * without that prefix is returned verbatim, so two states read correctly with no
 * migration: plaintext when no key is configured, and rows written before a key
 * was set.
 *
 * The AES key is derived (SHA-256) from a raw key stashed on the DB handle
 * (`db.encryptionKey`), not a module global — the proxy/workers and the bundled
 * control panel are separate module graphs but share one DB instance, so keying
 * off it is the only state both sides see. The derived key is cached per handle.
 * `encryptionKey` is part of the `Datastore` contract precisely so this cannot
 * degrade silently: a driver that didn't carry one would store every upstream
 * token in plaintext with nothing to say so.
 *
 * The proxy token is not encrypted, it is HASHED — see `hashProxyToken` below.
 * Encryption is the wrong tool for a value that is only ever compared: AES-GCM is
 * randomized, so an encrypted token could not be matched against the one the IdP
 * presents, which is why this column was plaintext until ENT-6742.
 *
 * The digest is UNSALTED, and that is deliberate rather than an oversight — the
 * paragraph below exists because `sha256(secret)` with no salt is a bug in the case
 * everyone has seen, and this is not that case.
 *
 * A salted or otherwise randomized digest can only be *verified* against a row you
 * have already found. The proxy has no row yet: a SCIM request arrives carrying a
 * bearer token and nothing else, and the token IS how the directory is located
 * (`WHERE proxy_token_hash = ?`, one indexed lookup on every request). Per-row salt
 * would mean reading every directory and hashing the presented token once per row.
 *
 * Unsalted is safe here only because of a property worth stating instead of
 * assuming: a proxy token is `randomHex(24)` from `crypto.getRandomValues` — 192
 * bits of CSPRNG output, 48 hex characters (see `shared/ids.ts`). There is no
 * dictionary, no reuse across sites, and no human in the loop, so the attacks that
 * salting and stretching (bcrypt/scrypt/argon2) defend against do not apply: those
 * exist because passwords are low-entropy and guessable, and a rainbow table is
 * only worth building against a value someone might plausibly have chosen.
 *
 * The one dent in that reasoning: ENT-6741 lets an operator import their IdP's
 * existing token, which could be weak. It is still their secret, chosen for a system
 * that also stored it, and the alternative is refusing the import.
 */

const PREFIX = "enc:v1:";

/**
 * Hash a proxy token for storage and for lookup.
 *
 * The proxy token is the only credential guarding the SCIM data plane, and it is
 * only ever *compared* — nothing needs to read it back. So it is stored as a
 * digest: whoever reads the database (a backup, a support query, a leaked volume)
 * gets no usable credential, and a token still authenticates by hashing what was
 * presented and looking that up.
 *
 * SHA-256, unsalted and unstretched — see the module docblock for why that is the
 * right call for this particular secret and not a copy of the password mistake.
 *
 * Stored `sha256:v1:<hex>` rather than bare hex, mirroring `enc:v1:`. The prefix
 * is what makes "has this row been hashed yet?" answerable — the boot backfill for
 * rows written before ENT-6742 needs to tell a digest from a plaintext token, and
 * "is it 64 hex characters?" is not that test: an imported token could itself be
 * 64 hex characters, and the backfill would skip it and lock that directory out.
 */
const HASH_PREFIX = "sha256:v1:";

export function isHashedToken(value: string): boolean {
  return value.startsWith(HASH_PREFIX);
}

export async function hashProxyToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return HASH_PREFIX + hex;
}

/**
 * The last 4 characters of a token, stored alongside the digest so the panel has
 * something to show for a credential it can no longer display.
 *
 * Last 4 of the plaintext, not of the digest: the operator matches it against what
 * they pasted into Okta, and a digest prefix is meaningless to them. 4 characters
 * of a 48-hex secret is negligible to an attacker — and this is the one moment
 * they are available, since hashing is one-way and the plaintext is not kept.
 */
export function proxyTokenHint(token: string): string {
  return token.slice(-4);
}

/**
 * Compare two credential-shaped strings without leaking where they differ.
 *
 * Moved here from `workers/native/listener.ts` (ENT-6742): it arrived with the
 * webhook signature check, and the proxy-token compare is a second caller in a
 * different subsystem, so it belongs beside the other credential primitives. Kept
 * as a hand-rolled loop rather than `node:crypto`'s `timingSafeEqual`, because this
 * module is imported by the workers too, and only `crypto.getRandomValues` /
 * `crypto.subtle` are available identically on Node and Cloudflare Workers.
 *
 * Length is compared first and non-constant-time, which leaks length only.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The slice of a handle this module needs: somewhere to find the raw key.
 *  `Datastore` requires the property, so every driver satisfies it — but a bare
 *  object does too, which keeps the unit tests free of a whole fake datastore. */
interface SecretStore {
  encryptionKey?: string | null;
}

/** Callers reach this from several module graphs, and a handle that turns out to
 *  carry no key at all degrades to plaintext rather than throwing. */
type Handle = SecretStore | null | undefined;

const derived = new WeakMap<object, { raw: string; key: CryptoKey }>();

async function keyFor(db: Handle): Promise<CryptoKey | null> {
  const raw = db?.encryptionKey ?? null;
  if (!db || !raw || typeof db !== "object") return null;
  const cached = derived.get(db);
  if (cached && cached.raw === raw) return cached.key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  derived.set(db, { raw, key });
  return key;
}

export async function encryptSecret(db: Handle, plaintext: string): Promise<string> {
  const key = await keyFor(db);
  if (!key || plaintext === "") return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return PREFIX + toBase64(packed);
}

export async function decryptSecret(db: Handle, value: string): Promise<string> {
  if (!value.startsWith(PREFIX)) return value;
  const key = await keyFor(db);
  if (!key) return value; // no key configured — cannot decrypt; surface as-is
  const packed = fromBase64(value.slice(PREFIX.length));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: packed.slice(0, 12) },
    key,
    packed.slice(12),
  );
  return new TextDecoder().decode(plain);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
