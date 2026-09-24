import { afterEach, beforeEach, describe, expect, it } from "vitest";
import proxyWorker from "../workers/proxy/index";
import { getMapping, listNativeWriteFailures } from "../workers/shared/db";
import type { PocEnv, ResourceType } from "../workers/shared/types";
import {
  createCtx,
  createEnv,
  installFakeUpstreams,
  proxyRequest,
  scimJson,
  seedDirectory,
  type FakeUpstreams,
} from "./helpers";

describe("workos-primary concurrent creates", () => {
  let env: PocEnv;
  let fake: FakeUpstreams;
  beforeEach(async () => {
    env = await createEnv();
    fake = installFakeUpstreams();
  });
  afterEach(() => fake.restore());

  it.each<ResourceType>(["Users", "Groups"])(
    "refuses overlapping %s creates before either upstream, then rejects the alias on retry",
    async (kind) => {
      const directory = await seedDirectory(env.DB, { mode: "workos-primary" });
      const attribute = kind === "Users" ? "userName" : "displayName";
      const firstBody = { [attribute]: "first", externalId: "shared-id" };
      const secondBody = { [attribute]: "second", externalId: "shared-id" };
      const create = (body: Record<string, string>) =>
        proxyWorker.fetch(
          proxyRequest(directory, "POST", `/scim/v2/${kind}`, body),
          env,
          createCtx(),
        );
      let overlapping: Response | undefined;
      let nativeCreates = 0;
      // Hold the first native leg open until the second request has answered.
      // On the vulnerable implementation this mints two native rows while both
      // mirror legs adopt the same WorkOS row, before the first mapping exists.
      fake.route("native", "POST", `/${kind}`, async (call) => {
        nativeCreates += 1;
        const body = call.json() as Record<string, string>;
        const isFirst = body[attribute] === "first";
        if (isFirst) overlapping = await create(secondBody);
        return scimJson(201, { ...body, id: isFirst ? "native-first" : "native-second" });
      });
      fake.route("workos", "PUT", `/${kind}/shared-id`, (call) =>
        scimJson(200, { ...(call.json() as Record<string, string>), id: "shared-id" }),
      );
      fake.route(
        "native",
        "GET",
        new RegExp(`^/${kind}\\?`),
        scimJson(200, { totalResults: 0, Resources: [] }),
      );

      expect((await create(firstBody)).status).toBe(201);
      expect(overlapping?.status).toBe(503);
      expect(overlapping?.headers.get("Retry-After")).toBe("1");
      expect(nativeCreates).toBe(1);
      expect(fake.callsTo("workos")).toHaveLength(1);
      expect(await getMapping(env.DB, directory.id, kind, "native-first")).toMatchObject({
        workos_id: "shared-id",
      });
      expect(await getMapping(env.DB, directory.id, kind, "native-second")).toBeNull();
      expect(await listNativeWriteFailures(env.DB, directory.id)).toEqual([]);

      // Once the claim is released the completed mapping is visible to the
      // existing guard: this is now a permanent collision, not retryable busy.
      expect((await create(secondBody)).status).toBe(409);
      expect(nativeCreates).toBe(1);
      expect(fake.callsTo("workos")).toHaveLength(1);
    },
  );
});
