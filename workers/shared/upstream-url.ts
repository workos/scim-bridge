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

  return null;
}

/** URL keeps an IPv6 literal in brackets; strip them for comparison. */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
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
