import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isSuccess, joinScimUrl, scimFetch } from "../workers/shared/scim";
import { validateUpstreamUrl } from "../workers/shared/upstream-url";

/**
 * The bridge dials operator-supplied `native_url` / `workos_url` from inside the
 * deployment's network. These pin the conservative acceptance boundary: block
 * the unambiguous SSRF wins (bad schemes, cloud metadata) without refusing the
 * private/internal and loopback endpoints a self-hosted deployment legitimately
 * uses. The panel wiring that calls this lives in tests/directory-import.test.ts.
 */
describe("validateUpstreamUrl", () => {
  it("rejects a scheme that is not http or https", () => {
    expect(validateUpstreamUrl("file:///etc/passwd")).toMatch(/must use http or https/);
    expect(validateUpstreamUrl("gopher://x/")).toMatch(/must use http or https/);
    expect(validateUpstreamUrl("ftp://host/scim")).toMatch(/must use http or https/);
  });

  it("rejects the cloud metadata / link-local addresses", () => {
    expect(validateUpstreamUrl("http://169.254.169.254/latest/meta-data/")).toMatch(
      /metadata address/,
    );
    // The whole IPv4 link-local /16, not just the IMDS host.
    expect(validateUpstreamUrl("http://169.254.0.1/scim/v2")).toMatch(/metadata address/);
    // AWS IMDS IPv6 twin, brackets and all.
    expect(validateUpstreamUrl("http://[fd00:ec2::254]/latest/meta-data/")).toMatch(
      /metadata address/,
    );
  });

  it("accepts an ordinary https endpoint and a loopback http one", () => {
    // A normal upstream, a private/internal native app, the demo loopback, and a
    // named localhost all pass — blocking any of them would break real setups.
    expect(validateUpstreamUrl("https://acme.example.com/scim/v2")).toBeNull();
    expect(validateUpstreamUrl("http://127.0.0.1:8788/scim/v2")).toBeNull();
    expect(validateUpstreamUrl("http://localhost:8788/scim/v2")).toBeNull();
    expect(validateUpstreamUrl("http://10.0.0.7/scim/v2")).toBeNull();
    // Empty is "not configured yet", which the optional endpoint fields allow.
    expect(validateUpstreamUrl("")).toBeNull();
    expect(validateUpstreamUrl("   ")).toBeNull();
  });

  it("rejects a value that is not a URL", () => {
    expect(validateUpstreamUrl("not a url")).toMatch(/not a valid URL/);
  });
});

describe("joinScimUrl", () => {
  it("appends the SCIM path to the pathname, not the query string", () => {
    // A base carrying a query would otherwise fold the forced suffix into it,
    // making the effective path attacker-chosen past host validation.
    const joined = joinScimUrl("http://169.254.169.254/latest/meta-data?", "/Users");
    const url = new URL(joined);
    expect(url.pathname.endsWith("/Users")).toBe(true);
    expect(url.search).toBe("");
  });

  it("drops a fragment on the base too", () => {
    const url = new URL(joinScimUrl("https://host/scim/v2#frag", "/Groups/abc"));
    expect(url.pathname).toBe("/scim/v2/Groups/abc");
    expect(url.hash).toBe("");
  });

  it("still joins an ordinary base the way it always did", () => {
    expect(joinScimUrl("https://api.workos.com/scim/v2.0/dir_1", "/Users")).toBe(
      "https://api.workos.com/scim/v2.0/dir_1/Users",
    );
    expect(joinScimUrl("https://host/scim/v2/", "/Users")).toBe("https://host/scim/v2/Users");
    // Callers pass pre-encoded ids; the encoding must survive.
    expect(joinScimUrl("https://host/scim/v2", "/Users/a%20b")).toBe(
      "https://host/scim/v2/Users/a%20b",
    );
  });
});

/**
 * Save-time host validation cannot stop an upstream that 302s to a blocked target
 * after the check — so scimFetch must never follow a redirect on an upstream call.
 */
describe("scimFetch does not follow redirects", () => {
  async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("refuses to chase a 302 to a metadata endpoint, and fails closed", async () => {
    let metadataHits = 0;
    // Stands in for the metadata service; a followed redirect would land here.
    const metadata = http.createServer((_req, res) => {
      metadataHits += 1;
      res.writeHead(200, { "Content-Type": "application/scim+json" });
      res.end('{"totalResults":1}');
    });
    const metadataPort = await listen(metadata);
    const upstream = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${metadataPort}/latest/meta-data/` });
      res.end();
    });
    const upstreamPort = await listen(upstream);

    try {
      const result = await scimFetch(`http://127.0.0.1:${upstreamPort}/Users`, {
        method: "GET",
        token: "tok",
      });
      // The redirect was not followed: the metadata host was never contacted, and
      // the 3xx surfaces as the failure every caller already treats a bad status as.
      expect(metadataHits).toBe(0);
      expect(isSuccess(result.status)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => metadata.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
