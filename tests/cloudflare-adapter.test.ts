import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it } from "vitest";

/** Execute the real adapter without starting a Cloudflare container. The
 * deployment-only SDK is replaced at its import boundary; its container echoes
 * back the request the Worker forwards. */
const sdkUrl = `data:text/javascript,${encodeURIComponent(
  "export class Container {}\nexport function getContainer() { return { fetch: (request) => request }; }",
)}`;
const source = readFileSync(new URL("../deploy/cloudflare/src/bridge.ts", import.meta.url), "utf8");
const adapterUrl = `data:text/javascript,${encodeURIComponent(
  stripTypeScriptTypes(source).replace('"@cloudflare/containers"', JSON.stringify(sdkUrl)),
)}`;
const adapter = (await import(/* @vite-ignore */ adapterUrl)) as {
  BridgeContainer: new (
    ctx: object,
    env: Record<string, string | object | undefined>,
  ) => { envVars: Record<string, string> };
  default: { fetch(request: Request, env: object): Request };
};

function container(vars: Record<string, string | undefined> = {}) {
  return new adapter.BridgeContainer(
    {},
    { BRIDGE: {}, PUBLIC_URL: "https://bridge.example.test", ...vars },
  );
}

describe("Cloudflare Worker container environment", () => {
  it("forwards a configured WorkOS API credential for Directory Sync verification", () => {
    const credential = randomUUID();
    const instance = container({ WORKOS_API_KEY: credential });

    // Compare as a boolean so a failed assertion never prints the credential.
    expect(instance.envVars.WORKOS_API_KEY === credential).toBe(true);
  });

  it("leaves WorkOS API authentication unset when no secret is configured", () => {
    expect(Object.hasOwn(container().envVars, "WORKOS_API_KEY")).toBe(false);
  });

  it("preserves other configured secrets and omits unset secrets", () => {
    const password = randomUUID();
    const instance = container({ PANEL_AUTH_PASSWORD: password });

    expect(instance.envVars.PANEL_AUTH_PASSWORD === password).toBe(true);
    expect(Object.hasOwn(instance.envVars, "APP_ENCRYPTION_KEY")).toBe(false);
    expect(instance.envVars.PUBLIC_URL).toBe("https://bridge.example.test");
  });
});

describe("Cloudflare Worker request forwarding", () => {
  it("names the caller to the panel's sign-in throttle, replacing any forged address", () => {
    expect(container().envVars.PANEL_TRUST_PROXY).toBe("true");
    const request = new Request("https://bridge.example.test/panel", {
      headers: { "CF-Connecting-IP": "198.51.100.7", "X-Forwarded-For": "10.0.0.1" },
    });
    const forwarded = adapter.default.fetch(request, { BRIDGE: {} });
    expect(forwarded.headers.get("X-Forwarded-For")).toBe("198.51.100.7");
  });
});
