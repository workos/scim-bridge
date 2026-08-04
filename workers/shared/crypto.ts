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
 * The proxy token is deliberately NOT encrypted — it is the lookup key
 * (`WHERE proxy_token = ?`), and AES-GCM is randomized, so an encrypted value
 * couldn't be matched against the token the IdP presents.
 */

const PREFIX = "enc:v1:";

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
