import { describe, expect, it } from "vitest";
import * as store from "../workers/idp/store";
import { createEnv, seedDirectory } from "./helpers";

/**
 * The IdP simulator's own store. Covered here because its inserts now mint their
 * ids in TypeScript rather than through a column default — and because the only
 * other way to reach this code is the bundled simulator's HTTP surface, which no
 * test drives.
 */
describe("idp store", () => {
  it("mints an id for a user and reads the row back", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);

    const user = await store.insertUser(env.DB, {
      directory_id: directory.id,
      user_name: "ada@example.com",
      external_id: "idp_ada",
      given_name: "Ada",
      family_name: "Lovelace",
      active: 1,
    });

    expect(user.id).toMatch(/^idpu_[0-9a-f]{16}$/);
    expect(user).toMatchObject({
      directory_id: directory.id,
      user_name: "ada@example.com",
      external_id: "idp_ada",
      active: 1,
    });
    expect(await store.listUsers(env.DB, directory.id)).toEqual([user]);
  });

  it("mints an id for a group and reads the row back", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);

    const group = await store.insertGroup(env.DB, {
      directory_id: directory.id,
      display_name: "Engineering",
      external_id: "idp_eng",
    });

    expect(group.id).toMatch(/^idpg_[0-9a-f]{16}$/);
    expect(group).toMatchObject({ display_name: "Engineering", external_id: "idp_eng" });
    expect(await store.listGroups(env.DB, directory.id)).toEqual([group]);
  });

  it("lists a same-second seed by name, not by minted id", async () => {
    const env = await createEnv();
    const directory = await seedDirectory(env.DB);
    for (const name of ["zoe@example.com", "ada@example.com", "mia@example.com"]) {
      await store.insertUser(env.DB, {
        directory_id: directory.id,
        user_name: name,
        external_id: name,
        given_name: "",
        family_name: "",
        active: 1,
      });
    }
    for (const name of ["Zeta", "Alpha", "Mid"]) {
      await store.insertGroup(env.DB, {
        directory_id: directory.id,
        display_name: name,
        external_id: name,
      });
    }

    // A seed writes every row within one second, so created_at alone leaves the
    // order to the engine.
    expect((await store.listUsers(env.DB, directory.id)).map((u) => u.user_name)).toEqual([
      "ada@example.com",
      "mia@example.com",
      "zoe@example.com",
    ]);
    expect((await store.listGroups(env.DB, directory.id)).map((g) => g.display_name)).toEqual([
      "Alpha",
      "Mid",
      "Zeta",
    ]);
  });

  it("keeps each directory's users and groups separate", async () => {
    const env = await createEnv();
    const a = await seedDirectory(env.DB, { name: "A" });
    const b = await seedDirectory(env.DB, { name: "B" });
    await store.insertUser(env.DB, {
      directory_id: a.id,
      user_name: "ada@example.com",
      external_id: "idp_ada",
      given_name: "",
      family_name: "",
      active: 1,
    });

    expect(await store.listUsers(env.DB, a.id)).toHaveLength(1);
    expect(await store.listUsers(env.DB, b.id)).toEqual([]);
  });
});
