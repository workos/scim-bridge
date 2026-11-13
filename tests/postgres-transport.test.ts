import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSecurePostgresTransport } from "../server/config";

const remote = "postgres://bridge:secret@db.example.com:5432/bridge";

describe("requireSecurePostgresTransport", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("judges the host and TLS mode PGHOST and PGSSLMODE fill in", () => {
    vi.stubEnv("PGHOST", "db.example.com");
    expect(() => requireSecurePostgresTransport("postgres:///bridge", false)).toThrow(
      /db\.example\.com without verified TLS/,
    );
    vi.stubEnv("PGSSLMODE", "verify-full");
    expect(() => requireSecurePostgresTransport("postgres:///bridge", false)).not.toThrow();
  });

  it("refuses a remote database reached without verified TLS", () => {
    for (const url of [remote, `${remote}?sslmode=disable`, `${remote}?sslmode=no-verify`]) {
      expect(() => requireSecurePostgresTransport(url, false)).toThrow(/without verified TLS/);
    }
  });

  it("refuses sslmode=require when the URL opts into libpq semantics, which skip verification", () => {
    expect(() =>
      requireSecurePostgresTransport(`${remote}?sslmode=require&uselibpqcompat=true`, false),
    ).toThrow(/without verified TLS/);
  });

  it("accepts verified TLS, loopback, and unix sockets", () => {
    for (const url of [
      `${remote}?sslmode=verify-full`,
      `${remote}?sslmode=require`,
      `${remote}?ssl=true`,
      "postgres://postgres:pw@127.0.0.1:5432/bridge",
      "postgres://postgres:pw@localhost/bridge",
      "postgres://postgres:pw@/bridge?host=/var/run/postgresql",
    ]) {
      expect(() => requireSecurePostgresTransport(url, false)).not.toThrow();
    }
  });

  it("lets DATABASE_ALLOW_PLAINTEXT accept a plaintext remote database, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => requireSecurePostgresTransport(remote, true)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DATABASE_ALLOW_PLAINTEXT/));
    warn.mockRestore();
  });
});
