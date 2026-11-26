const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const Redis = require("ioredis");
const { PrismaClient } = require("@prisma/client");
const { ValidationPipe } = require("@nestjs/common");
const { Test } = require("@nestjs/testing");
const { AppModule } = require("../../dist/app.module");
const { Infrastructure } = require("../../dist/infrastructure");
const { ClientsService } = require("../../dist/clients");
const { RequestsService } = require("../../dist/requests/service");
const { environmentPrefix } = require("../../dist/tenants");

const code = (expected) => (error) => error.getResponse().code === expected;

async function main() {
  const schema = "test_clients_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  const redis = new Redis(process.env.REDIS_URL);
  let app;
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    await redis.flushdb();
    const plan = (name, league) =>
      db.plan.create({
        data: { name, grants: { create: { kind: "LEAGUE", hubId: league, name: league } } },
      });
    const fights = await plan("Fights", "league-ufc");
    const hoops = await plan("Hoops", "league-nba");
    const starter = await db.planPackage.create({
      data: { name: "Starter", plans: { connect: [{ id: fights.id }] } },
    });
    const fightClub = await db.tenant.create({
      data: { code: "k7x2p", name: "Fight Club TV", packageId: starter.id, maxUsers: 2 },
    });
    const other = await db.tenant.create({ data: { code: "other", name: "Other Sports" } });
    const password = "a-long-enough-password";
    const passwordHash = await argon2.hash(password);
    const owner = await db.user.create({
      data: {
        email: "owner@example.invalid",
        passwordHash,
        role: "RESELLER",
        tenantId: fightClub.id,
      },
    });
    const otherOwner = await db.user.create({
      data: { email: "owner@example.invalid", passwordHash, role: "RESELLER", tenantId: other.id },
    });
    const clients = new ClientsService({ db });

    // The reseller sees its own package and limit.
    assert.deepEqual(await clients.overview(fightClub.id), {
      code: "k7x2p",
      name: "Fight Club TV",
      maxUsers: 2,
      package: { id: starter.id, name: "Starter", plans: [{ id: fights.id, name: "Fights" }] },
      clients: 0,
    });

    // Clients get plans of the package only, within the reseller's limit.
    const fan = await clients.create(fightClub.id, {
      email: "Fan@Example.invalid",
      password,
      planId: fights.id,
      weeklyRequestLimit: 3,
    });
    assert.deepEqual(
      [fan.email, fan.role, fan.tenant.code, fan.plan.name, fan.weeklyRequestLimit],
      ["fan@example.invalid", "USER", "k7x2p", "Fights", 3],
    );
    await assert.rejects(
      clients.create(fightClub.id, { email: "x@example.invalid", password, planId: hoops.id }),
      code("PLAN_NOT_IN_PACKAGE"),
    );
    await assert.rejects(
      clients.create(fightClub.id, { email: "fan@example.invalid", password }),
      code("EMAIL_UNAVAILABLE"),
    );
    const planless = await clients.create(fightClub.id, {
      email: "planless@example.invalid",
      password,
    });
    assert.equal(planless.plan, null);
    await assert.rejects(
      clients.create(fightClub.id, { email: "third@example.invalid", password }),
      code("CLIENT_LIMIT_REACHED"),
    );
    // Concurrent creations cannot both take the last place.
    await db.tenant.update({ where: { id: fightClub.id }, data: { maxUsers: 3 } });
    const raced = await Promise.allSettled([
      clients.create(fightClub.id, { email: "race1@example.invalid", password }),
      clients.create(fightClub.id, { email: "race2@example.invalid", password }),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    await db.tenant.update({ where: { id: fightClub.id }, data: { maxUsers: null } });
    // The same email may be a client of another reseller.
    const theirFan = await clients.create(other.id, { email: "fan@example.invalid", password });

    // A reseller only ever sees and changes its own clients.
    const mine = await clients.list(fightClub.id, 1);
    assert.equal(mine.total, 3);
    assert.ok(mine.items.every((item) => item.tenant.code === "k7x2p" && item.role === "USER"));
    for (const attempt of [
      () => clients.detail(fightClub.id, theirFan.id),
      () => clients.update(fightClub.id, theirFan.id, { active: false }),
      () => clients.resetPassword(fightClub.id, theirFan.id, { password }),
      () => clients.detail(fightClub.id, owner.id),
    ]) {
      await assert.rejects(attempt(), code("CLIENT_NOT_FOUND"));
    }
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: theirFan.id } })).active, true);

    // Editing a client; deactivating or a new password signs them out.
    await db.session.create({
      data: { tokenHash: randomUUID(), userId: fan.id, expiresAt: new Date(Date.now() + 60000) },
    });
    await assert.rejects(
      clients.update(fightClub.id, fan.id, { planId: hoops.id }),
      code("PLAN_NOT_IN_PACKAGE"),
    );
    const edited = await clients.update(fightClub.id, fan.id, {
      expiresAt: "2030-01-01T00:00:00.000Z",
      weeklyRequestLimit: null,
    });
    assert.deepEqual(
      [edited.expiresAt.toISOString(), edited.weeklyRequestLimit, edited.plan.name],
      ["2030-01-01T00:00:00.000Z", null, "Fights"],
    );
    await clients.update(fightClub.id, fan.id, { active: false });
    assert.equal(await db.session.count({ where: { userId: fan.id } }), 0);
    await clients.update(fightClub.id, fan.id, { active: true });
    await clients.resetPassword(fightClub.id, fan.id, { password: "a-brand-new-password" });
    const reset = await db.user.findUniqueOrThrow({ where: { id: fan.id } });
    assert.equal(await argon2.verify(reset.passwordHash, "a-brand-new-password"), true);

    // What each kind of account may request.
    const metadata = {
      league: async (id) => ({ id, name: id }),
      event: async (id) => ({ id, name: id, leagueId: `league-${id.split("-")[0]}` }),
    };
    const requests = new RequestsService({ db }, metadata, {
      check: async () => ({ state: "missing" }),
    });
    const request = (id, user) => requests.create({ kind: "event", identifier: id }, user);
    const platformFan = await db.user.create({
      data: { email: "p@example.invalid", passwordHash },
    });
    // A client with a plan: the plan's leagues.
    assert.equal((await request("ufc-1", fan)).created, true);
    await assert.rejects(request("nba-1", fan), code("PLAN_NOT_ALLOWED"));
    // A reseller's client without a plan: nothing.
    await assert.rejects(request("ufc-2", planless), code("PLAN_NOT_ALLOWED"));
    assert.deepEqual(await requests.lookup({ kind: "event", identifier: "ufc-2" }, planless), {
      state: "not_allowed",
    });
    // A reseller administrator: what the package's plans include; without a package, nothing.
    assert.equal((await request("ufc-3", owner)).created, true);
    await assert.rejects(request("nba-2", owner), code("PLAN_NOT_ALLOWED"));
    await assert.rejects(request("ufc-4", otherOwner), code("PLAN_NOT_ALLOWED"));
    // A platform user without a plan: everything, as before.
    assert.equal((await request("nba-3", platformFan)).created, true);

    // Over HTTP: only a reseller's administrator reaches the reseller panel, for its reseller.
    process.env.APP_ORIGIN = "http://localhost:3187";
    process.env.SESSION_SECRET = randomUUID() + randomUUID();
    process.env.SETTINGS_ENCRYPTION_KEY = require("node:crypto").randomBytes(32).toString("hex");
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Infrastructure)
      .useValue({ db, redis })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.use(environmentPrefix);
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const signIn = async (prefix, email, secret) => {
      const headers = { Origin: process.env.APP_ORIGIN };
      const csrf = await (await fetch(`${base}${prefix}/api/v1/auth/csrf`, { headers })).json();
      const response = await fetch(`${base}${prefix}/api/v1/auth/login`, {
        method: "POST",
        headers: { ...headers, "x-csrf-token": csrf.token, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: secret }),
      });
      assert.equal(response.status, 201, `${prefix} ${email}`);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const get = async (path, cookie) =>
      (await fetch(base + path, { headers: { Cookie: cookie } })).status;
    const ownerCookie = await signIn("/k7x2p", "owner@example.invalid", password);
    const fanCookie = await signIn("/k7x2p", "fan@example.invalid", "a-brand-new-password");
    await db.user.create({
      data: { email: "admin@example.invalid", passwordHash, role: "ADMIN" },
    });
    const adminCookie = await signIn("", "admin@example.invalid", password);
    assert.equal(await get("/k7x2p/api/v1/reseller/overview", ownerCookie), 200);
    assert.equal(await get("/k7x2p/api/v1/reseller/clients", ownerCookie), 200);
    assert.equal(await get("/k7x2p/api/v1/reseller/overview", fanCookie), 403);
    assert.equal(await get("/api/v1/reseller/overview", adminCookie), 403);
    // A reseller's administrator never reaches platform administration.
    assert.equal(await get("/k7x2p/api/v1/admin/users", ownerCookie), 403);
    assert.equal(await get("/k7x2p/api/v1/admin/resellers", ownerCookie), 403);
    console.log(
      "Clients integration passed: reseller overview, package-only plans, client limit with concurrent creations, per-reseller emails, isolation between resellers, edits that sign clients out, password reset, request access by account kind, and the reseller panel guard over HTTP.",
    );
  } finally {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await redis.quit();
  }
}
main().catch((error) => {
  console.error("Clients integration test failed:", error);
  process.exitCode = 1;
});
