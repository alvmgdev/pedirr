const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("class-validator");
const { UsersService, UserCreate, UserUpdate, AccessPolicy } = require("../dist/users");

function fixture(adminCount = 1) {
  const revoked = [];
  let user = { id: "admin-id", role: "ADMIN", active: true };
  const tx = {
    $executeRaw: async () => 1,
    user: {
      findUnique: async () => user,
      count: async () => adminCount,
      update: async ({ data }) => {
        user = { ...user, ...data };
        return user;
      },
    },
    session: { deleteMany: async ({ where }) => revoked.push(where.userId) },
  };
  const service = new UsersService({
    db: {
      $transaction: async (callback) => callback(tx),
      setting: { findMany: async () => [{ key: "autoApprove.ADMIN", value: true }] },
    },
  });
  return { service, revoked };
}
test("the last active administrator cannot be demoted or disabled", async () => {
  const { service, revoked } = fixture();
  for (const change of [{ role: "USER" }, { active: false }]) {
    await assert.rejects(
      service.update("admin-id", change),
      (error) => error.getResponse().code === "LAST_ADMIN",
    );
  }
  assert.deepEqual(revoked, []);
});
test("a demotion with another active administrator revokes all sessions", async () => {
  const { service, revoked } = fixture(2);
  assert.equal((await service.update("admin-id", { role: "USER" })).role, "USER");
  assert.deepEqual(revoked, ["admin-id"]);
});
test("changing auto-approval does not revoke sessions", async () => {
  const { service, revoked } = fixture();
  assert.equal((await service.update("admin-id", { autoApprove: false })).autoApprove, false);
  assert.deepEqual(revoked, []);
});
test("explicit per-user allow and deny override role policies", async () => {
  const { service } = fixture();
  assert.equal(await service.autoApproves({ role: "ADMIN", autoApprove: false }), false);
  assert.equal(await service.autoApproves({ role: "USER", autoApprove: true }), true);
  assert.equal(await service.autoApproves({ role: "ADMIN", autoApprove: null }), true);
  assert.equal(await service.autoApproves({ role: "USER", autoApprove: null }), false);
});
test("null is accepted only as an explicit auto-approval inheritance setting", async () => {
  assert.equal((await validate(Object.assign(new UserUpdate(), { autoApprove: null }))).length, 0);
  for (const change of [{ active: null }, { role: null }, { autoApprove: "true" }]) {
    assert.ok((await validate(Object.assign(new UserUpdate(), change))).length > 0);
  }
  assert.ok(
    (await validate(Object.assign(new AccessPolicy(), { registrationEnabled: true }))).length > 0,
  );
});
test("the season grant is an optional boolean on user creation and updates", async () => {
  const credentials = { email: "viewer@example.invalid", password: "a-long-enough-password" };
  for (const value of [undefined, true, false]) {
    const create = Object.assign(new UserCreate(), credentials, { canRequestSeasons: value });
    assert.equal((await validate(create)).length, 0);
    assert.equal(
      (await validate(Object.assign(new UserUpdate(), { canRequestSeasons: value }))).length,
      0,
    );
  }
  for (const value of [null, "true", 1]) {
    const create = Object.assign(new UserCreate(), credentials, { canRequestSeasons: value });
    assert.ok((await validate(create)).length > 0);
    assert.ok(
      (await validate(Object.assign(new UserUpdate(), { canRequestSeasons: value }))).length > 0,
    );
  }
});
test("changing the season grant does not revoke sessions", async () => {
  const { service, revoked } = fixture();
  await service.update("admin-id", { canRequestSeasons: true });
  assert.deepEqual(revoked, []);
});
test("created users can only request single events unless granted", async () => {
  const created = [];
  const service = new UsersService({
    db: { user: { create: async ({ data }) => (created.push(data), data) } },
  });
  await service.create({ email: "One@Example.invalid", password: "a-long-enough-password" });
  await service.create({
    email: "two@example.invalid",
    password: "a-long-enough-password",
    canRequestSeasons: true,
  });
  assert.deepEqual(
    created.map(({ email, canRequestSeasons }) => ({ email, canRequestSeasons })),
    [
      { email: "one@example.invalid", canRequestSeasons: false },
      { email: "two@example.invalid", canRequestSeasons: true },
    ],
  );
});
