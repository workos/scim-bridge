/**
 * Conservative validation of an operator-supplied upstream URL (a directory's
 * `native_url` / `workos_url`).
 *
 * The bridge dials these from inside the deployment's network, so a bad one is
 * an SSRF primitive. But this product is self-hosted and the native app is
 * frequently on a private/internal address — demo mode uses 127.0.0.1 — so this
 * deliberately does NOT block RFC1918/private ranges or loopback: doing so would
 * refuse legitimate deployments. Only the unambiguous wins are enforced here:
 *
 *  - a scheme allowlist (http/https), so `file:`, `gopher:` and friends cannot
 *    be smuggled in;
 *  - https for anything off this machine: every call carries the directory's
 *    bearer token, so plain http hands it to anyone on the network path;
 *  - the cloud metadata / link-local addresses, where no real SCIM app lives.
 *
 * Returns a human error for the panel to surface, or null when acceptable. An
 * empty value is acceptable: the endpoint fields are optional and filled later.
 */
export function validateUpstreamUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" is not a valid URL.`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `The endpoint URL must use http or https, not "${url.protocol.replace(/:$/, "")}".`;
  }

  if (isMetadataHost(url.hostname)) {
    return `${url.hostname} is a cloud metadata address and cannot be an endpoint.`;
  }

  if (sendsTokenInPlaintext(url)) {
    return (
      `The endpoint URL must use https: plain http would send this directory's bearer ` +
      `token unencrypted to ${url.hostname}. Only loopback addresses may use http, unless ` +
      `UPSTREAM_ALLOW_PRIVATE_HTTP=true accepts it for a private host.`
    );
  }

  return null;
}

/**
 * Whether a request to `url` would carry a bearer token over a network in the
 * clear: plain http to anything but this machine. With
 * `UPSTREAM_ALLOW_PRIVATE_HTTP=true` the operator accepts plain http on a
 * network they trust, for every host except a public IP address. A hostname
 * counts as private because internal apps are often named under a public
 * domain, and resolving it here would not prove where the request goes.
 * Read from the environment, not set at boot, so the panel's separately
 * bundled routes and the proxy agree.
 */
export function sendsTokenInPlaintext(
  url: URL,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return false;
  return !(privateHttpAllowed(env) && !isPublicIpLiteral(url.hostname));
}

/** `UPSTREAM_ALLOW_PRIVATE_HTTP=true`: plain http to private upstreams is accepted. */
export function privateHttpAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.UPSTREAM_ALLOW_PRIVATE_HTTP?.trim() === "true";
}

/** An IP literal outside the loopback, private (RFC 1918, CGNAT) and
 *  unique-local IPv6 ranges. Hostnames are not IP literals. */
function isPublicIpLiteral(hostname: string): boolean {
  const host = normalizeHost(hostname);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    return !isPrivate;
  }
  if (host.includes(":")) return !/^f[cd][0-9a-f]{0,2}:/.test(host);
  return false;
}

/** Loopback only: a request to it never leaves the machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    // 127.0.0.0/8 mapped into IPv6, which URL writes as ::ffff:7fxx:xxxx.
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
  );
}

/** URL keeps an IPv6 literal in brackets and a fully qualified name's
 *  trailing dot; strip both for comparison. */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

/**
 * Whether a host is a cloud instance-metadata / link-local address. The IMDS
 * lives at 169.254.169.254 and its IPv6 twin at fd00:ec2::254; the whole IPv4
 * link-local /16 is treated the same, since no legitimate SCIM endpoint is in it.
 */
function isMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "fd00:ec2::254") return true;
  return false;
}
