const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const argon2 = require("argon2");
const { PrismaClient } = require("@prisma/client");
const { AuthService } = require("../../dist/auth");
const { UsersService } = require("../../dist/users");
const { PLATFORM_TENANT } = require("../../dist/tenants");

const code = (expected) => (error) => error.getResponse().code === expected;
const prismaCode = (expected) => (error) => error.code === expected;

async function main() {
  const schema = "test_tenants_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    // The platform environment exists from the start, without a code.
    const platform = await db.tenant.findUniqueOrThrow({ where: { id: PLATFORM_TENANT } });
    assert.deepEqual([platform.code, platform.active], [null, true]);

    // Accounts created as before belong to the platform.
    const users = new UsersService({ db });
    const password = "a-long-enough-password";
    const admin = await users.create({ email: "Shared@Example.invalid", password });
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: admin.id } })).tenantId,
      PLATFORM_TENANT,
    );
    await assert.rejects(
      users.create({ email: "shared@example.invalid", password }),
      code("EMAIL_UNAVAILABLE"),
    );

    // The same email may exist in a reseller, never twice in the same one.
    const reseller = await db.tenant.create({ data: { code: "k7x2p", name: "Fight Club TV" } });
    const otherPassword = "another-long-password";
    const client = await db.user.create({
      data: {
        email: "shared@example.invalid",
        passwordHash: await argon2.hash(otherPassword),
        tenantId: reseller.id,
      },
    });
    await assert.rejects(
      db.user.create({
        data: { email: "shared@example.invalid", passwordHash: "x", tenantId: reseller.id },
      }),
      prismaCode("P2002"),
    );
    await assert.rejects(
      db.tenant.create({ data: { code: "k7x2p", name: "Copycat" } }),
      prismaCode("P2002"),
    );

    // Signing in at the platform finds the platform account only.
    process.env.SESSION_SECRET ??= "x".repeat(32);
    process.env.APP_ORIGIN ??= "http://localhost:3000";
    const auth = new AuthService({ db });
    const response = { cookie: () => {} };
    assert.equal((await auth.login("shared@example.invalid", password, response)).id, admin.id);
    await assert.rejects(
      auth.login("shared@example.invalid", otherPassword, response),
      code("INVALID_CREDENTIALS"),
    );
    assert.notEqual(client.id, admin.id);

    // Packages group plans for resellers; one in use cannot be deleted.
    const plans = await Promise.all(
      ["Fights", "Basketball"].map((name) => db.plan.create({ data: { name, allContent: true } })),
    );
    const pack = await db.planPackage.create({
      data: { name: "Starter", plans: { connect: plans.map((plan) => ({ id: plan.id })) } },
      include: { plans: true },
    });
    assert.equal(pack.plans.length, 2);
    await db.tenant.update({ where: { id: reseller.id }, data: { packageId: pack.id } });
    await assert.rejects(db.planPackage.delete({ where: { id: pack.id } }), prismaCode("P2003"));
    // A reseller with users cannot be deleted either.
    await assert.rejects(db.tenant.delete({ where: { id: reseller.id } }), prismaCode("P2003"));
    console.log(
      "Tenants integration passed: platform environment, accounts default to it, emails unique per environment, platform sign-in, unique reseller codes, plan packages and deletion guards.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Tenants integration test failed:", error);
  process.exitCode = 1;
});
