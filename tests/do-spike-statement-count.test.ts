import { describe, expect, it } from "vitest";
import { runBackfill } from "../workers/shared/backfill";
import type { Datastore, DatastoreStatement } from "../workers/shared/datastore";
import type { Directory } from "../workers/shared/types";
import {
  createEnv,
  installFakeUpstreams,
  NATIVE_URL,
  scimJson,
  seedDirectory,
  WORKOS_URL,
} from "./helpers";

/**
 * ENT-6758 spike, part 1 of 2: how many datastore statements does a realistic
 * backfill issue?
 *
 * A Durable Object driver turns every statement into a round trip, so the cost of
 * the design is `statements × round-trip`. This file measures the first factor,
 * which is a *count* and therefore unaffected by machine load — the second factor
 * needs a quiet machine and is measured separately.
 *
 * Kept as a test rather than a script so it runs on both engines through the
 * existing harness and cannot drift away from the code it is measuring. It asserts
 * bounds rather than exact numbers: the point is the growth rate, and pinning an
 * exact count would turn every legitimate query change into a failure here.
 */

/** Wraps a datastore and counts what passes through it, by SQL verb. */
function counting(inner: Datastore): { db: Datastore; counts: Record<string, number> } {
  const counts: Record<string, number> = { total: 0, batched: 0 };
  const bump = (sql: string) => {
    const verb = (sql.trim().split(/\s+/)[0] ?? "?").toUpperCase();
    counts[verb] = (counts[verb] ?? 0) + 1;
    counts.total += 1;
  };
  const db: Datastore = {
    get encryptionKey() {
      return inner.encryptionKey;
    },
    set encryptionKey(value) {
      inner.encryptionKey = value;
    },
    prepare(sql: string): DatastoreStatement {
      bump(sql);
      return inner.prepare(sql);
    },
    batch(statements) {
      // A batch is one round trip in the DO design, however many statements it
      // carries — which is exactly why the split matters.
      counts.batched += 1;
      return inner.batch(statements);
    },
  } as Datastore;
  return { db, counts };
}

/** A directory pointed at the fake upstreams, in dual-write so the mirror runs. */
async function backfillDirectory(db: Datastore): Promise<Directory> {
  return seedDirectory(db, { mode: "dual-write" });
}

/** `count` users and groups on the native side, each group holding every user. */
function serveNative(count: number) {
  const fake = installFakeUpstreams();
  const users = Array.from({ length: count }, (_, i) => ({
    id: `nat_u${i}`,
    userName: `user${i}@acme.test`,
    active: true,
  }));
  const groups = Array.from({ length: Math.max(1, Math.round(count / 10)) }, (_, i) => ({
    id: `nat_g${i}`,
    displayName: `Group ${i}`,
    members: users.map((u) => ({ value: u.id })),
  }));

  for (const [kind, resources] of [
    ["Users", users],
    ["Groups", groups],
  ] as const) {
    fake.route("native", "GET", `/${kind}`, () =>
      scimJson(200, { totalResults: resources.length, Resources: resources }),
    );
    // Every mirrored resource is a PUT that 404s (never migrated), then a POST.
    fake.route("workos", "PUT", `/${kind}`, () => scimJson(404, { detail: "not found" }));
    fake.route("workos", "POST", `/${kind}`, (call) =>
      scimJson(201, { id: `wos_${(call.json() as { id?: string })?.id ?? "x"}` }),
    );
  }
  return fake;
}

describe("ENT-6758 spike: statements per backfill", () => {
  it("issues a bounded number of statements per mirrored resource", async () => {
    const env = await createEnv();
    const { db, counts } = counting(env.DB);
    const directory = await backfillDirectory(env.DB);
    const fake = serveNative(50);
    try {
      const before = { ...counts };
      const summary = await runBackfill(db, { ...directory, native_url: NATIVE_URL });

      const mirrored = summary.users.mirrored + summary.groups.mirrored;
      expect(mirrored).toBeGreaterThan(0);
      const perResource = (counts.total - before.total) / mirrored;

      // The number that decides the design. Recorded in the PR body; asserted only
      // loosely, because a query added to a mirror path is a legitimate change and
      // this test should not be the thing that blocks it.
      console.log(
        `[ENT-6758] mirrored=${mirrored} statements=${counts.total} ` +
          `perResource=${perResource.toFixed(2)} batches=${counts.batched} ` +
          `byVerb=${JSON.stringify(
            Object.fromEntries(Object.entries(counts).filter(([k]) => k !== "total")),
          )}`,
      );
      expect(perResource).toBeLessThan(10);
      expect(WORKOS_URL.startsWith("https://")).toBe(true);
    } finally {
      fake.restore();
    }
  });

  it("grows linearly with the directory, not worse", async () => {
    // Linear is the assumption the ticket's "statement per resource" rests on. If
    // any path were quadratic (a per-resource query that scans mappings, say), the
    // DO round-trip cost would be catastrophic rather than merely slow, and that is
    // worth knowing before measuring latency at all.
    const measured: { size: number; statements: number }[] = [];

    for (const size of [10, 50, 100]) {
      const env = await createEnv();
      const { db, counts } = counting(env.DB);
      const directory = await backfillDirectory(env.DB);
      const fake = serveNative(size);
      try {
        await runBackfill(db, { ...directory, native_url: NATIVE_URL });
        measured.push({ size, statements: counts.total });
      } finally {
        fake.restore();
      }
    }

    console.log(`[ENT-6758] growth=${JSON.stringify(measured)}`);
    const [small, , large] = measured;
    // 10× the directory must cost well under 20× the statements.
    expect(large.statements / small.statements).toBeLessThan(20);
  });
});
