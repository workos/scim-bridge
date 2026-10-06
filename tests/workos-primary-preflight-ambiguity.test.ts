import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { AmbiguousScimMappingError, getMapping, upsertMapping } from "../workers/shared/db";
import type { PocEnv, ResourceType } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
  type SeededDirectory,
} from "./helpers";

describe("workos-primary unused claims on ambiguous legacy mappings", () => {
  let env: PocEnv;
  let directory: SeededDirectory;
  let fake: FakeUpstreams;

  beforeEach(async () => {
    env = await createEnv();
    directory = await seedDirectory(env.DB, { mode: "workos-primary" });
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  async function seedAmbiguousMappings(kind: ResourceType) {
    for (const nativeId of ["18", "19"]) {
      await upsertMapping(env.DB, {
        directory_id: directory.id,
        resource_type: kind,
        native_id: nativeId,
        workos_id: "workos-legacy-duplicate",
        strategy: "fallback-post",
      });
    }
  }

  function readClaim(kind: ResourceType) {
    return env.DB.prepare(
      "SELECT token FROM workos_primary_create_claims WHERE directory_id = ? AND resource_type = ?",
    )
      .bind(directory.id, kind)
      .first<{ token: string }>();
  }

  function create(kind: ResourceType) {
    return proxyWorker.fetch(
      proxyRequest(directory, "POST", `/scim/v2/${kind}`, {
        [kind === "Users" ? "userName" : "displayName"]: "new-resource",
        externalId: "new-external-id",
      }),
      env,
      createCtx(),
    );
  }

  for (const kind of ["Users", "Groups"] as const) {
    for (const method of ["POST", "DELETE"] as const) {
      it(`refuses ${kind} ${method} before I/O and releases its unused claim`, async () => {
        await seedAmbiguousMappings(kind);
        fake.route("native", "DELETE", `/${kind}/18`, new Response(null, { status: 204 }));
        fake.route(
          "workos",
          "DELETE",
          `/${kind}/workos-legacy-duplicate`,
          new Response(null, { status: 204 }),
        );

        const response =
          method === "POST"
            ? await create(kind)
            : await proxyWorker.fetch(
                proxyRequest(directory, "DELETE", `/scim/v2/${kind}/18`),
                env,
                createCtx(),
              );

        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("1");
        expect(fake.calls).toEqual([]);
        expect(await readClaim(kind)).toBeNull();
        for (const nativeId of ["18", "19"])
          expect(await getMapping(env.DB, directory.id, kind, nativeId)).toMatchObject({
            workos_id: "workos-legacy-duplicate",
          });
      });
    }

    it(`retains ${kind} create ownership if ambiguity is discovered after upstream writes`, async () => {
      fake.route("native", "POST", `/${kind}`, scimJson(201, { id: "native-new" }));
      fake.route("workos", "PUT", `/${kind}/new-external-id`, async () => {
        // A legacy writer changes the map after the create's preflight snapshot.
        await seedAmbiguousMappings(kind);
        return scimJson(200, { id: "new-external-id" });
      });

      await expect(create(kind)).rejects.toBeInstanceOf(AmbiguousScimMappingError);

      const retained = await readClaim(kind);
      expect(retained?.token).toEqual(expect.any(String));
      expect(fake.callsTo("native")).toHaveLength(1);
      expect(fake.callsTo("workos")).toHaveLength(1);
      expect(await getMapping(env.DB, directory.id, kind, "native-new")).toMatchObject({
        workos_id: "new-external-id",
      });
      expect((await create(kind)).status).toBe(503);
      expect(await readClaim(kind)).toEqual(retained);
      expect(fake.calls).toHaveLength(2);
    });
  }
});
