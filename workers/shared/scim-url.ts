/** SCIM URL helpers with no server dependencies, so panel components can use them in the browser. */

export function joinScimUrl(base: string, path: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // An unparseable base was already broken; keep the old total behaviour
    // rather than start throwing here.
    return base.replace(/\/+$/, "") + path;
  }
  // Append to the pathname, not the raw string. A base that carries a query or
  // fragment (`https://host/scim?x` or a stored `http://169.254.169.254/…?`)
  // would otherwise fold the forced `/Users` suffix into the query string
  // (`…?x/Users`), letting an operator-supplied URL divert the request path past
  // host validation. The base names an endpoint, not a query, so drop both.
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") + path;
  return url.toString();
}

/**
 * Canonical key for the native SCIM namespace a base URL addresses, so two
 * directories configured with equivalent-but-differently-written URLs (default
 * port written out, upper-case host, trailing slash) are recognised as the same
 * native app. Returns null for a URL that can't be parsed — callers that use
 * this to decide whether resources can collide must treat that as "might be the
 * same namespace" rather than assuming isolation.
 */
export function nativeNamespaceKey(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const port = url.port && url.port !== defaultPort(url.protocol) ? `:${url.port}` : "";
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname.replace(/\/+$/, "")}`;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}
