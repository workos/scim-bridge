import { BlockList, isIP } from "node:net";

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
      `token unencrypted to ${url.hostname}. Only loopback addresses may use http.`
    );
  }

  return null;
}

/** Throw before a bearer token would go to `url` in the clear. Checked at send
 *  time, not only on save: a row stored before https was required must not leak
 *  its token. */
export function refusePlaintextToken(url: string): void {
  if (sendsTokenInPlaintext(new URL(url))) {
    throw new Error(
      `Refusing to send a bearer token over plain http to ${new URL(url).hostname}; ` +
        "set the endpoint to https.",
    );
  }
}

/** Whether a request to `url` would carry a bearer token over a network in the
 *  clear: plain http to anything but this machine. */
export function sendsTokenInPlaintext(url: URL): boolean {
  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** The IMDS lives at 169.254.169.254 and its IPv6 twin at fd00:ec2::254; the
 *  whole IPv4 link-local /16 is treated the same, since no SCIM app lives in it. */
const METADATA = new BlockList();
METADATA.addSubnet("169.254.0.0", 16, "ipv4");
METADATA.addAddress("fd00:ec2::254", "ipv6");

/** Loopback only: a request to it never leaves the machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || inList(LOOPBACK, host);
}

function isMetadataHost(hostname: string): boolean {
  return inList(METADATA, hostname);
}

/** `BlockList` also matches IPv4-mapped IPv6 (`::ffff:7f00:1`) against IPv4 rules. */
function inList(list: BlockList, hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  return family !== 0 && list.check(host, family === 6 ? "ipv6" : "ipv4");
}
