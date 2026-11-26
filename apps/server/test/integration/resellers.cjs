const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const argon2 = require("argon2");
const { PrismaClient } = require("@prisma/client");
const { AuthService } = require("../../dist/auth");
const { PackagesService } = require("../../dist/packages");
const { PlansService } = require("../../dist/plans");
const { ResellerCreate, ResellersService } = require("../../dist/resellers");
const { PackageInput } = require("../../dist/packages");
const { plainToInstance } = require("class-transformer");
const { validate } = require("class-validator");
const { UsersService } = require("../../dist/users");

const code = (expected) => (error) => error.getResponse().code === expected;

async function main() {
  const schema = "test_resellers_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const infrastructure = { db };
    const packages = new PackagesService(infrastructure);
    const resellers = new ResellersService(infrastructure);
    const users = new UsersService(infrastructure);
    const plans = new PlansService(infrastructure, {});
    const [fights, hoops] = await Promise.all(
      ["Fights", "Hoops"].map((name) => db.plan.create({ data: { name, allContent: true } })),
    );

    // Packages group plans; names are unique and every plan must exist.
    // Input goes through the same transformation and validation as over HTTP.
    const valid = async (type, value) => {
      const input = plainToInstance(type, value);
      assert.deepEqual(await validate(input), []);
      return input;
    };
    const starter = await packages.create(
      await valid(PackageInput, { name: " Starter ", planIds: [fights.id, fights.id] }),
    );
    assert.deepEqual(
      [starter.name, starter.plans.map((plan) => plan.name), starter.resellers],
      ["Starter", ["Fights"], 0],
    );
    await assert.rejects(
      packages.create({ name: "Starter", planIds: [] }),
      code("PACKAGE_NAME_TAKEN"),
    );
    await assert.rejects(
      packages.create({ name: "Ghost", planIds: [randomUUID()] }),
      code("INVALID_PACKAGE_PLAN"),
    );
    const updated = await packages.update(starter.id, {
      name: "Starter",
      planIds: [fights.id, hoops.id],
    });
    assert.deepEqual(
      updated.plans.map((plan) => plan.name),
      ["Fights", "Hoops"],
    );
    await assert.rejects(
      packages.update(randomUUID(), { name: "Nope", planIds: [] }),
      code("PACKAGE_NOT_FOUND"),
    );

    // A reseller and its administrator are created together; the code is generated if absent.
    const password = "reseller-admin-password";
    const generated = await resellers.create({
      name: "Fight Club TV",
      packageId: starter.id,
      admin: { email: "Owner@Example.invalid", password },
    });
    assert.match(generated.code, /^[abcdefghjkmnpqrstuvwxyz23456789]{5}$/);
    assert.deepEqual(
      [generated.active, generated.maxUsers, generated.package.name, generated.clients],
      [true, null, "Starter", 0],
    );
    assert.equal(generated.admin.email, "owner@example.invalid");
    const owner = await db.user.findUniqueOrThrow({ where: { id: generated.admin.id } });
    assert.deepEqual([owner.role, owner.tenantId], ["RESELLER", generated.id]);
    // The same email may run another reseller and have a platform account.
    const custom = await resellers.create(
      await valid(ResellerCreate, {
        name: "Hoops Plus",
        code: " Hoops-Plus ",
        maxUsers: 25,
        admin: { email: "owner@example.invalid", password },
      }),
    );
    assert.deepEqual([custom.code, custom.maxUsers, custom.package], ["hoops-plus", 25, null]);
    await users.create({ email: "owner@example.invalid", password });
    for (const bad of ["admin", "ab", "a_b", "-ab", "x".repeat(21)]) {
      await assert.rejects(
        resellers.create({ name: "Bad", code: bad, admin: { email: "a@b.invalid", password } }),
        code("INVALID_RESELLER_CODE"),
        bad,
      );
    }
    await assert.rejects(
      resellers.create({
        name: "Copy",
        code: "hoops-plus",
        admin: { email: "c@d.invalid", password },
      }),
      code("RESELLER_CODE_TAKEN"),
    );
    await assert.rejects(
      resellers.create({
        name: "Lost",
        code: "lost1",
        packageId: randomUUID(),
        admin: { email: "e@f.invalid", password },
      }),
      code("PACKAGE_NOT_FOUND"),
    );
    // Nothing of a refused reseller is left behind.
    assert.equal(await db.tenant.count({ where: { code: "lost1" } }), 0);
    assert.equal(await db.user.count({ where: { email: "e@f.invalid" } }), 0);

    // The list shows resellers only, never the platform.
    assert.deepEqual(
      (await resellers.list()).map((item) => item.name),
      ["Fight Club TV", "Hoops Plus"],
    );
    await assert.rejects(resellers.detail("platform"), code("RESELLER_NOT_FOUND"));

    // The reseller administrator signs in at the reseller's address.
    process.env.SESSION_SECRET ??= "x".repeat(32);
    process.env.APP_ORIGIN ??= "http://localhost:3000";
    const auth = new AuthService(infrastructure);
    const response = { cookie: () => {} };
    const environment = {
      id: generated.id,
      code: generated.code,
      name: generated.name,
      active: true,
    };
    assert.equal(
      (await auth.login("owner@example.invalid", password, response, environment)).role,
      "RESELLER",
    );
    assert.equal(await db.session.count({ where: { userId: owner.id } }), 1);

    // Editing; disabling ends the reseller's sessions.
    const edited = await resellers.update(generated.id, {
      name: "Fight Club",
      maxUsers: 10,
      packageId: null,
    });
    assert.deepEqual([edited.name, edited.maxUsers, edited.package], ["Fight Club", 10, null]);
    await resellers.update(generated.id, { active: false, packageId: starter.id });
    assert.equal(await db.session.count({ where: { userId: owner.id } }), 0);
    assert.equal((await resellers.detail(generated.id)).active, false);
    await assert.rejects(
      resellers.update(randomUUID(), { name: "Nope" }),
      code("RESELLER_NOT_FOUND"),
    );

    // A new administrator password replaces the old one and signs them out.
    await auth.login("owner@example.invalid", password, response, { ...environment, active: true });
    await resellers.resetAdminPassword(generated.id, { password: "a-brand-new-password" });
    const reset = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    assert.equal(await argon2.verify(reset.passwordHash, "a-brand-new-password"), true);
    assert.equal(await db.session.count({ where: { userId: owner.id } }), 0);

    // Packages and plans resellers rely on cannot be deleted.
    await assert.rejects(packages.remove(starter.id), code("PACKAGE_IN_USE"));
    await assert.rejects(plans.remove(hoops.id), code("PLAN_IN_PACKAGE"));
    assert.equal((await plans.detail(hoops.id)).packages, 1);

    // The platform administrator's user list holds platform accounts only.
    const platformUsers = await users.list(1);
    assert.deepEqual(
      platformUsers.items.map((item) => item.email),
      ["owner@example.invalid"],
    );
    assert.equal(platformUsers.items[0].tenant.code, null);
    await assert.rejects(users.detail(owner.id), code("USER_NOT_FOUND"));
    await assert.rejects(users.update(owner.id, { active: false }), code("USER_NOT_FOUND"));
    console.log(
      "Resellers integration passed: packages with unique names and existing plans, resellers created with their administrator, generated and custom codes, validation and atomic refusal, platform excluded, reseller sign-in, edits, disabling ends sessions, administrator password reset, deletion guards, platform-only user administration.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Resellers integration test failed:", error);
  process.exitCode = 1;
});
