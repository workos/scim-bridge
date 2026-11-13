import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { antiFramingHeaders, PanelAuthThrottle, panelAuthGuard } from "../server/panel-boundary";

const config = { panelAuthUser: "ada", panelAuthPassword: "hunter2", demoMode: false };

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** A panel behind the real guard, with the peer address taken from a test header. */
function panel(throttle: PanelAuthThrottle) {
  const app = new Hono();
  app.use("*", antiFramingHeaders());
  app.use(
    "*",
    panelAuthGuard(config, throttle, (c) => c.req.header("X-Test-Peer") ?? "peer"),
  );
  app.get("/panel", (c) => c.text("tokens live here"));
  return (authorization: string | null, peer = "198.51.100.7") =>
    app.request("/panel", {
      headers: {
        "X-Test-Peer": peer,
        ...(authorization === null ? {} : { Authorization: authorization }),
      },
    });
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("the panel refuses to be framed", () => {
  it("on the panel, on the auth challenge, and on 429s", async () => {
    const get = panel(new PanelAuthThrottle({ perSource: 1 }));
    for (const res of [
      await get(basic("ada", "hunter2")),
      await get(null),
      await get(basic("ada", "wrong")),
      await get(basic("ada", "wrong")),
    ]) {
      expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    }
  });
});

describe("failed panel sign-ins are throttled", () => {
  it("answers 429 to a source after its failures run out, even with the right password", async () => {
    const t = clock();
    const get = panel(new PanelAuthThrottle({ perSource: 3, total: 100, windowMs: 60_000, ...t }));
    for (let i = 0; i < 3; i++) expect((await get(basic("ada", `guess${i}`))).status).toBe(401);

    const locked = await get(basic("ada", "hunter2"));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBe("60");
    expect(await locked.text()).not.toContain("tokens");

    // Another source is unaffected, and the locked one recovers when its window ends.
    expect((await get(basic("ada", "hunter2"), "203.0.113.9")).status).toBe(200);
    t.advance(60_000);
    expect((await get(basic("ada", "hunter2"))).status).toBe(200);
  });

  it("caps guesses across all sources, so rotating addresses does not help", async () => {
    const get = panel(new PanelAuthThrottle({ perSource: 10, total: 5, windowMs: 60_000 }));
    for (let i = 0; i < 5; i++)
      expect((await get(basic("ada", "x"), `10.0.0.${i}`)).status).toBe(401);
    expect((await get(basic("ada", "hunter2"), "10.0.0.99")).status).toBe(429);
  });

  it("does not count the browser's credential-less first request as a guess", async () => {
    const get = panel(new PanelAuthThrottle({ perSource: 1 }));
    for (let i = 0; i < 5; i++) expect((await get(null)).status).toBe(401);
    expect((await get(basic("ada", "hunter2"))).status).toBe(200);
  });

  it("holds a concurrent burst of guesses to the limit", async () => {
    const get = panel(new PanelAuthThrottle({ perSource: 10, total: 100 }));
    const burst = await Promise.all(
      Array.from({ length: 25 }, (_, i) => get(basic("ada", `wrong${i}`))),
    );
    const statuses = burst.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
  });

  it("does not spend the budget on correct sign-ins", async () => {
    const get = panel(new PanelAuthThrottle({ perSource: 2 }));
    for (let i = 0; i < 5; i++) expect((await get(basic("ada", "hunter2"))).status).toBe(200);
    expect((await get(basic("ada", "wrong"))).status).toBe(401);
  });

  it("admits overlapping correct sign-ins while guesses are still under the limit", async () => {
    const get = panel(new PanelAuthThrottle({ perSource: 10, total: 100 }));
    for (let i = 0; i < 9; i++) expect((await get(basic("ada", `wrong${i}`))).status).toBe(401);
    const overlapping = await Promise.all(
      Array.from({ length: 11 }, () => get(basic("ada", "hunter2"))),
    );
    expect(overlapping.map((r) => r.status)).toEqual(Array(11).fill(200));
  });
});
