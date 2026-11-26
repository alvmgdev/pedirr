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
const { environmentPrefix } = require("../../dist/tenants");

async function main() {
  const schema = "test_environments_" + randomUUID().replaceAll("-", "");
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

    // The same email at the platform and at a reseller, each with its own password.
    const fightClub = await db.tenant.create({ data: { code: "k7x2p", name: "Fight Club TV" } });
    const other = await db.tenant.create({ data: { code: "other", name: "Other Sports" } });
    const email = "shared@example.invalid";
    const platformPassword = "platform-password-1";
    const resellerPassword = "reseller-password-1";
    await db.user.create({ data: { email, passwordHash: await argon2.hash(platformPassword) } });
    await db.user.create({
      data: { email, passwordHash: await argon2.hash(resellerPassword), tenantId: fightClub.id },
    });

    const request = async (path, { method = "GET", body, cookie = "" } = {}) => {
      const headers = { Cookie: cookie, Origin: process.env.APP_ORIGIN };
      if (method !== "GET") {
        const prefix = path.slice(0, path.indexOf("/api/v1/") + "/api/v1".length);
        const csrf = await fetch(base + prefix + "/auth/csrf", { headers });
        headers["x-csrf-token"] = (await csrf.json()).token;
        headers["Content-Type"] = "application/json";
      }
      const response = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        body: await response.json(),
        set: response.headers.get("set-cookie"),
      };
    };
    const login = (prefix, password) =>
      request(`${prefix}/api/v1/auth/login`, { method: "POST", body: { email, password } });

    // Each environment describes itself; an unknown code is not a service.
    assert.deepEqual((await request("/api/v1/auth/config")).body, {
      registrationEnabled: false,
      environment: null,
    });
    assert.deepEqual((await request("/k7x2p/api/v1/auth/config")).body, {
      registrationEnabled: false,
      environment: { code: "k7x2p", name: "Fight Club TV", active: true },
    });
    const unknown = await request("/nope1/api/v1/auth/config");
    assert.deepEqual([unknown.status, unknown.body.code], [404, "TENANT_NOT_FOUND"]);

    // Signing in finds the account of the environment addressed, with its own cookie.
    const reseller = await login("/k7x2p", resellerPassword);
    assert.equal(reseller.status, 201);
    assert.equal(reseller.body.tenant.code, "k7x2p");
    assert.match(reseller.set, /^pedirr_reseller_session=[a-f0-9]{64};/);
    assert.match(reseller.set, /Path=\/k7x2p\//);
    assert.equal((await login("/k7x2p", platformPassword)).status, 401);
    const platform = await login("", platformPassword);
    assert.equal(platform.status, 201);
    assert.equal(platform.body.tenant.code, null);
    assert.match(platform.set, /^pedirr_session=[a-f0-9]{64};/);
    assert.match(platform.set, /Path=\//);
    assert.equal((await login("", resellerPassword)).status, 401);

    const resellerToken = reseller.set.split(";")[0].split("=")[1];
    const platformToken = platform.set.split(";")[0].split("=")[1];
    const me = (prefix, cookie) => request(`${prefix}/api/v1/auth/me`, { cookie });
    // A browser signed in to both sends both cookies to a reseller; each side reads its own.
    const both = `pedirr_session=${platformToken}; pedirr_reseller_session=${resellerToken}`;
    assert.equal((await me("/k7x2p", both)).body.tenant.code, "k7x2p");
    assert.equal((await me("", both)).body.tenant.code, null);
    // A session never works in another environment, whatever cookie name carries it.
    assert.equal((await me("", `pedirr_session=${resellerToken}`)).status, 401);
    assert.equal((await me("/k7x2p", `pedirr_reseller_session=${platformToken}`)).status, 401);
    assert.equal((await me("/other", `pedirr_reseller_session=${resellerToken}`)).status, 401);
    // Resellers create their clients; nobody registers at a reseller.
    const register = await request("/k7x2p/api/v1/auth/register", {
      method: "POST",
      body: { email: "new@example.invalid", password: "a-long-enough-password" },
    });
    assert.deepEqual([register.status, register.body.code], [403, "REGISTRATION_CLOSED"]);

    // A disabled reseller's sessions stop and nobody can sign in there.
    const resellerCookie = `pedirr_reseller_session=${resellerToken}`;
    await db.tenant.update({ where: { id: fightClub.id }, data: { active: false } });
    assert.equal((await me("/k7x2p", resellerCookie)).status, 401);
    const disabled = await login("/k7x2p", resellerPassword);
    assert.deepEqual([disabled.status, disabled.body.code], [403, "TENANT_DISABLED"]);
    assert.equal((await request("/k7x2p/api/v1/auth/config")).body.environment.active, false);
    await db.tenant.update({ where: { id: fightClub.id }, data: { active: true } });
    assert.equal((await me("/k7x2p", resellerCookie)).status, 200);

    // Signing out of a reseller clears its own cookie and leaves the platform session alone.
    const logout = await request("/k7x2p/api/v1/auth/logout", { method: "POST", cookie: both });
    assert.equal(logout.status, 201);
    assert.match(logout.set, /^pedirr_reseller_session=;/);
    assert.match(logout.set, /Path=\/k7x2p\//);
    assert.equal((await me("/k7x2p", resellerCookie)).status, 401);
    assert.equal((await me("", `pedirr_session=${platformToken}`)).status, 200);
    assert.ok(other);
    console.log(
      "Environments integration passed: per-environment configuration, unknown codes, sign-in by environment, separate cookies, sessions bound to their environment, closed reseller registration, disabled resellers and sign-out.",
    );
  } finally {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await redis.quit();
  }
}
main().catch((error) => {
  console.error("Environments integration test failed:", error);
  process.exitCode = 1;
});
