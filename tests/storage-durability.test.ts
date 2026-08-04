import { describe, expect, it } from "vitest";
import { inspectStorage, mountFor } from "../server/db/storage-durability";

/**
 * The boot guard for ENT-6751: the e2e deployment lost its database three times
 * because a container's own disk looks writable right up to the moment the
 * container is replaced.
 *
 * Mount tables here are real ones, trimmed: the first from Cloudflare Containers
 * (overlay root, nothing mounted), the second from ECS + EFS.
 */
const CONTAINER_ROOT = [
  "overlay / overlay rw,relatime,lowerdir=/var/lib/docker/overlay2/l/ABC 0 0",
  "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
  "tmpfs /dev tmpfs rw,nosuid,size=65536k,mode=755 0 0",
  "shm /dev/shm tmpfs rw,nosuid,nodev,noexec,relatime,size=65536k 0 0",
].join("\n");

const CONTAINER_WITH_EFS = [
  ...CONTAINER_ROOT.split("\n"),
  "127.0.0.1:/ /data nfs4 rw,relatime,vers=4.1,rsize=1048576 0 0",
].join("\n");

const CONTAINER_WITH_EBS = [
  ...CONTAINER_ROOT.split("\n"),
  "/dev/nvme1n1 /data ext4 rw,relatime 0 0",
].join("\n");

describe("storage durability", () => {
  it("warns when the database sits on a container's own overlay disk", () => {
    const storage = inspectStorage("/data/scim-bridge.db", CONTAINER_ROOT);

    expect(storage).toMatchObject({
      path: "/data/scim-bridge.db",
      mountPoint: "/",
      filesystem: "overlay",
      ephemeral: true,
    });
    // The warning has to say what is lost, not just that something is wrong: an
    // operator reading it mid-deploy needs to know it costs them the migration.
    expect(storage.warning).toContain("does not survive this container being replaced");
    expect(storage.warning).toContain("id mappings");
    expect(storage.warning).toContain("DATABASE_DRIVER=postgres");
  });

  it("warns when the path is on tmpfs, which is memory", () => {
    const storage = inspectStorage("/dev/shm/scim.db", CONTAINER_ROOT);

    expect(storage).toMatchObject({ filesystem: "tmpfs", ephemeral: true });
    expect(storage.warning).toContain("/dev/shm");
  });

  it("stays quiet on EFS and on EBS", () => {
    for (const table of [CONTAINER_WITH_EFS, CONTAINER_WITH_EBS]) {
      const storage = inspectStorage("/data/scim-bridge.db", table);

      expect(storage.ephemeral, storage.filesystem ?? "").toBe(false);
      expect(storage.warning).toBeNull();
      expect(storage.mountPoint).toBe("/data");
    }
  });

  it("picks the mount the path actually lands on, not the shortest match", () => {
    // The whole point: / is overlay in every container, so a guard that stopped
    // at the first matching mount would warn about a perfectly good volume.
    const mounts = [
      { point: "/", filesystem: "overlay" },
      { point: "/data", filesystem: "ext4" },
      { point: "/data/inner", filesystem: "tmpfs" },
    ];

    expect(mountFor("/data/scim-bridge.db", mounts)?.filesystem).toBe("ext4");
    expect(mountFor("/data/inner/scim.db", mounts)?.filesystem).toBe("tmpfs");
    expect(mountFor("/var/lib/x", mounts)?.filesystem).toBe("overlay");
  });

  it("does not treat a similarly-named sibling as a mount prefix", () => {
    const mounts = [
      { point: "/", filesystem: "overlay" },
      { point: "/data", filesystem: "ext4" },
    ];

    // /database is not under /data, however much it looks like it.
    expect(mountFor("/database/scim.db", mounts)?.filesystem).toBe("overlay");
  });

  it("resolves a relative path before deciding", () => {
    const storage = inspectStorage("scim-bridge.db", CONTAINER_ROOT);

    expect(storage.path.startsWith("/")).toBe(true);
    expect(storage.path.endsWith("/scim-bridge.db")).toBe(true);
  });

  it("reads a mount point containing an escaped space", () => {
    const table = "/dev/sdb /my\\040data ext4 rw,relatime 0 0";

    expect(inspectStorage("/my data/scim.db", table)).toMatchObject({
      mountPoint: "/my data",
      filesystem: "ext4",
      ephemeral: false,
    });
  });

  it("has no opinion when the mount table is unreadable", () => {
    // macOS and BSD have no /proc/mounts. A false warning about durable storage
    // teaches operators to ignore warnings about durable storage.
    expect(inspectStorage("/tmp/scim.db", "")).toMatchObject({
      mountPoint: null,
      filesystem: null,
      ephemeral: false,
      warning: null,
    });
  });
});
