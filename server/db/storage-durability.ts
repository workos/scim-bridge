import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Is the SQLite file on a filesystem that survives a restart?
 *
 * The ENT-6600 e2e run lost its database three times: Cloudflare Containers give
 * the process a writable disk that disappears with the container, and nothing
 * about writing to it looks wrong until the container is replaced. The database
 * holds `id_mappings`, so losing it mid-migration means the proxy can no longer
 * translate ids between the IdP-facing and WorkOS-facing sides.
 *
 * `/proc/mounts` makes this detectable rather than advisory: find the mount point
 * the path actually lands on and look at its filesystem type. `overlay` is a
 * container's own layered root; `tmpfs` is memory. Both vanish. A real volume
 * reports what it is — `nfs4` for EFS, `ext4`/`xfs` for EBS or a Docker volume.
 *
 * Everything here degrades quietly: no `/proc/mounts` (macOS, BSD) means no
 * opinion, because a false warning about durable storage teaches operators to
 * ignore warnings about durable storage.
 */

/** Filesystems that do not outlive the container they belong to. */
const EPHEMERAL_FILESYSTEMS = new Set(["overlay", "overlay2", "aufs", "tmpfs", "ramfs"]);

export interface StorageDurability {
  /** The absolute path the driver will actually open. */
  path: string;
  /** The mount point `path` resolves onto, when it could be determined. */
  mountPoint: string | null;
  /** That mount's filesystem type, when it could be determined. */
  filesystem: string | null;
  /** True when the filesystem is one that disappears with the container. */
  ephemeral: boolean;
  /** Null when there is nothing to say (no /proc/mounts, or the mount is fine). */
  warning: string | null;
}

interface Mount {
  point: string;
  filesystem: string;
}

/** Parse the mount table. Format: `device mountpoint fstype options …`, with
 *  octal escapes for spaces in the mount point. */
function parseMounts(table: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of table.split("\n")) {
    const [, point, filesystem] = line.split(" ");
    if (!point || !filesystem) continue;
    mounts.push({ point: point.replaceAll("\\040", " "), filesystem });
  }
  return mounts;
}

/** The mount whose point is the longest prefix of `path` — the one a write to
 *  `path` actually lands on. */
export function mountFor(path: string, mounts: Mount[]): Mount | null {
  let best: Mount | null = null;
  for (const mount of mounts) {
    const isPrefix =
      path === mount.point || path.startsWith(mount.point === "/" ? "/" : `${mount.point}/`);
    if (!isPrefix) continue;
    if (!best || mount.point.length > best.point.length) best = mount;
  }
  return best;
}

export function inspectStorage(databasePath: string, mountTable?: string): StorageDurability {
  const path = resolve(databasePath);
  let table = mountTable;
  if (table === undefined) {
    try {
      table = readFileSync("/proc/mounts", "utf8");
    } catch {
      // Not Linux, or a sandbox without /proc. No opinion is better than a wrong one.
      return { path, mountPoint: null, filesystem: null, ephemeral: false, warning: null };
    }
  }

  const mount = mountFor(path, parseMounts(table));
  if (!mount) {
    return { path, mountPoint: null, filesystem: null, ephemeral: false, warning: null };
  }

  const ephemeral = EPHEMERAL_FILESYSTEMS.has(mount.filesystem);
  return {
    path,
    mountPoint: mount.point,
    filesystem: mount.filesystem,
    ephemeral,
    warning: ephemeral
      ? `DATABASE_PATH (${path}) is on a ${mount.filesystem} filesystem mounted at ${mount.point}, ` +
        "which does not survive this container being replaced. Every directory, its migration mode, " +
        "and its id mappings would be lost — mid-migration, with the IdP still sending traffic. " +
        "Mount a volume there, or use DATABASE_DRIVER=postgres. See docs/runbook.md#durable-storage."
      : null,
  };
}
