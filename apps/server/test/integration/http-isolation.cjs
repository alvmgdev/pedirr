const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const argon2 = require("argon2");
const cookieParser = require("cookie-parser");
const Redis = require("ioredis");
const { PrismaClient } = require("@prisma/client");
const { ValidationPipe } = require("@nestjs/common");
const { Test } = require("@nestjs/testing");
const { SwaggerModule, DocumentBuilder } = require("@nestjs/swagger");
const { AppModule } = require("../../dist/app.module");
const { Infrastructure } = require("../../dist/infrastructure");
const { MetadataProvider } = require("../../dist/metadata/provider");
const { RequestsService } = require("../../dist/requests/service");
const { IssuesService } = require("../../dist/issues/service");
const { environmentPrefix } = require("../../dist/tenants");

/**
 * Every route the API serves, and how it is kept within an environment. A route missing here
 * fails the suite: decide how it is isolated, then add it to the matching list and its checks.
 */
const ROUTES = {
  // Anyone, signed in or not.
  public: [
    "GET health/live",
    "GET health/ready",
    "GET auth/csrf",
    "GET auth/config",
    "POST auth/register",
    "POST auth/login",
  ],
  // The caller's own account and session.
  own: ["POST auth/logout", "GET auth/me", "PATCH me", "POST me/password"],
  // Shared content, narrowed by plan (covered by the catalog and plans programs) or computed
  // for the caller; lists among them are checked below for other environments' data.
  content: [
    "GET catalog/search",
    "GET catalog/leagues",
    "GET catalog/leagues/{id}",
    "GET catalog/leagues/{id}/seasons",
    "GET catalog/seasons/{id}",
    "GET catalog/teams/{id}",
    "GET catalog/events",
    "GET catalog/events/{id}",
    "GET catalog/upcoming",
    "GET catalog/popular",
    "POST requests",
    "GET requests",
    "GET requests/lookup",
    "GET requests/parts",
    "GET requests/quota",
    "GET issues",
    "GET issues/open",
  ],
  // An environment's data addressed by ID: other environments get "not found".
  scoped: [
    "GET requests/{id}",
    "POST requests/{id}/issues",
    "GET issues/{id}",
    "POST issues/{id}/comments",
    "PATCH issues/{id}",
  ],
  // The platform administrator only.
  platform: [
    "POST requests/{id}/review",
    "GET admin/users",
    "POST admin/users",
    "GET admin/users/{id}",
    "PATCH admin/users/{id}",
    "GET admin/policies",
    "PATCH admin/policies",
    "GET admin/plans",
    "POST admin/plans",
    "GET admin/plans/sports",
    "GET admin/plans/{id}",
    "PUT admin/plans/{id}",
    "DELETE admin/plans/{id}",
    "GET admin/packages",
    "POST admin/packages",
    "GET admin/packages/{id}",
    "PUT admin/packages/{id}",
    "DELETE admin/packages/{id}",
    "GET admin/resellers",
    "POST admin/resellers",
    "GET admin/resellers/{id}",
    "PATCH admin/resellers/{id}",
    "POST admin/resellers/{id}/admin-password",
    "GET admin/settings/sportarr",
    "PUT admin/settings/sportarr",
    "POST admin/settings/sportarr/test",
    "GET admin/settings/notifications",
    "PUT admin/settings/notifications",
    "GET admin/settings/notifications/deliveries",
  ],
  // A reseller's administrator only, always for its own reseller.
  reseller: [
    "GET reseller/overview",
    "GET reseller/clients",
    "POST reseller/clients",
    "GET reseller/clients/{id}",
    "PATCH reseller/clients/{id}",
    "POST reseller/clients/{id}/password",
    "GET reseller/notifications",
    "PUT reseller/notifications",
    "GET reseller/notifications/deliveries",
  ],
};

async function main() {
  const schema = "test_http_isolation_" + randomUUID().replaceAll("-", "");
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
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    const metadata = {
      league: async (id) => ({ id, name: id }),
      event: async (id) => ({ id, name: id, leagueId: `league-${id}` }),
      season: async (id) => ({ id, name: id, leagueId: id.replace("season", "league") }),
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Infrastructure)
      .useValue({ db, redis })
      .overrideProvider(MetadataProvider)
      .useValue(metadata)
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

    // Every route the API serves is classified.
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const served = Object.entries(document.paths).flatMap(([path, item]) =>
      ["get", "post", "put", "patch", "delete"]
        .filter((method) => item[method])
        .map((method) => `${method.toUpperCase()} ${path.replace(/^\/api\/v1\//, "")}`),
    );
    const classified = Object.values(ROUTES).flat();
    for (const route of served) {
      assert.ok(
        classified.includes(route),
        `Unclassified route ${route}: decide how it is isolated and add it to ROUTES`,
      );
    }
    for (const route of classified) {
      assert.ok(served.includes(route), `ROUTES lists ${route}, which the API no longer serves`);
    }
    assert.equal(new Set(classified).size, classified.length, "A route is listed twice");

    // Two resellers and the platform, each with an administrator and a client.
    const everything = await db.plan.create({ data: { name: "Everything", allContent: true } });
    const pack = await db.planPackage.create({
      data: { name: "All", plans: { connect: [{ id: everything.id }] } },
    });
    const a = await db.tenant.create({ data: { code: "k7x2p", name: "A", packageId: pack.id } });
    const b = await db.tenant.create({ data: { code: "other", name: "B", packageId: pack.id } });
    const password = "a-long-enough-password";
    const passwordHash = await argon2.hash(password);
    const user = (email, role, tenantId, planId) =>
      db.user.create({ data: { email, passwordHash, role, tenantId, planId } });
    const people = {
      admin: await user("admin@example.invalid", "ADMIN", "platform"),
      platformUser: await user("fan@example.invalid", "USER", "platform"),
      ownerA: await user("owner@example.invalid", "RESELLER", a.id),
      clientA: await user("client@example.invalid", "USER", a.id, everything.id),
      ownerB: await user("owner@example.invalid", "RESELLER", b.id),
      clientB: await user("client@example.invalid", "USER", b.id, everything.id),
    };
    const prefix = (person) =>
      person.tenantId === a.id ? "/k7x2p" : person.tenantId === b.id ? "/other" : "";

    // Reseller A's data: a request, an issue about it, and a client.
    const requests = app.get(RequestsService);
    const issues = app.get(IssuesService);
    const requestA = (await requests.create({ kind: "event", identifier: "a1" }, people.clientA))
      .request;
    const issueA = await issues.create(
      requestA.id,
      { category: "QUALITY", description: "Blurry" },
      people.clientA,
    );
    await requests.create({ kind: "season", identifier: "season-a" }, people.ownerA);

    // Sessions for everyone, at their own address.
    const sessions = {};
    for (const [name, person] of Object.entries(people)) {
      const headers = { Origin: process.env.APP_ORIGIN };
      const csrf = await (
        await fetch(`${base}${prefix(person)}/api/v1/auth/csrf`, { headers })
      ).json();
      const response = await fetch(`${base}${prefix(person)}/api/v1/auth/login`, {
        method: "POST",
        headers: { ...headers, "x-csrf-token": csrf.token, "Content-Type": "application/json" },
        body: JSON.stringify({ email: person.email, password }),
      });
      assert.equal(response.status, 201, `sign-in ${name}`);
      const cookie = response.headers.get("set-cookie").split(";")[0];
      const token = (
        await (
          await fetch(`${base}${prefix(person)}/api/v1/auth/csrf`, {
            headers: { ...headers, Cookie: cookie },
          })
        ).json()
      ).token;
      sessions[name] = { person, cookie, token };
    }
    const call = async (name, route, params = {}, body = {}) => {
      const [method, template] = route.split(" ");
      const path = template.replace(/\{(\w+)\}/g, (_, key) => params[key] ?? randomUUID());
      const session = name ? sessions[name] : null;
      const headers = { Origin: process.env.APP_ORIGIN };
      if (session) {
        headers.Cookie = session.cookie;
      }
      if (method !== "GET") {
        headers["x-csrf-token"] = session
          ? session.token
          : (await (await fetch(`${base}/api/v1/auth/csrf`, { headers })).json()).token;
        headers["Content-Type"] = "application/json";
      }
      const where = session ? prefix(session.person) : "";
      const response = await fetch(`${base}${where}/api/v1/${path}`, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    // Platform administration refuses everyone else, whatever the route.
    for (const route of ROUTES.platform) {
      for (const name of ["ownerA", "clientA", "platformUser"]) {
        assert.equal((await call(name, route)).status, 403, `${name} ${route}`);
      }
      assert.equal((await call(null, route)).status, 401, `anonymous ${route}`);
    }
    // The reseller panel refuses everyone but reseller administrators.
    for (const route of ROUTES.reseller) {
      for (const name of ["admin", "clientA", "platformUser"]) {
        assert.equal((await call(name, route)).status, 403, `${name} ${route}`);
      }
      assert.equal((await call(null, route)).status, 401, `anonymous ${route}`);
    }

    // Reseller A's data by ID does not exist for anyone outside A, the platform included.
    const scopedChecks = {
      "GET requests/{id}": { id: requestA.id },
      "POST requests/{id}/issues": {
        id: requestA.id,
        body: { category: "QUALITY", description: "Mine too" },
      },
      "GET issues/{id}": { id: issueA.id },
      "POST issues/{id}/comments": { id: issueA.id, body: { body: "Hello" } },
      "PATCH issues/{id}": { id: issueA.id, body: { status: "CLOSED" } },
    };
    assert.deepEqual(Object.keys(scopedChecks).sort(), [...ROUTES.scoped].sort());
    for (const [route, { body, ...params }] of Object.entries(scopedChecks)) {
      for (const name of ["ownerB", "clientB", "platformUser"]) {
        assert.equal((await call(name, route, params, body)).status, 404, `${name} ${route}`);
      }
    }
    // Inside A, its client and administrator reach them; the administrator only reads issues.
    assert.equal((await call("clientA", "GET requests/{id}", { id: requestA.id })).status, 200);
    assert.equal((await call("ownerA", "GET issues/{id}", { id: issueA.id })).status, 200);
    assert.equal(
      (await call("ownerA", "POST issues/{id}/comments", { id: issueA.id }, { body: "Hi" })).status,
      404,
    );
    // A reseller's clients by ID: another reseller's administrator gets "not found".
    const clientRoutes = [
      ["GET reseller/clients/{id}", undefined],
      ["PATCH reseller/clients/{id}", { active: false }],
      ["POST reseller/clients/{id}/password", { password: "another-long-password" }],
    ];
    for (const [route, body] of clientRoutes) {
      assert.equal(
        (await call("ownerB", route, { id: people.clientA.id }, body)).status,
        404,
        `ownerB ${route}`,
      );
    }
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: people.clientA.id } })).active,
      true,
    );

    // Lists in other environments hold nothing of A's.
    const ids = (result, key = "items") => (result.body?.[key] ?? []).map((item) => item.id);
    for (const name of ["ownerB", "clientB", "platformUser"]) {
      assert.ok(!ids(await call(name, "GET requests")).includes(requestA.id), `${name} requests`);
      assert.ok(!ids(await call(name, "GET issues")).includes(issueA.id), `${name} issues`);
      const popular = await call(name, "GET catalog/popular");
      assert.ok(
        !popular.body.items.some((item) => item.metadata.id === "league-a"),
        `${name} popular`,
      );
    }
    assert.ok(!ids(await call("ownerB", "GET reseller/clients")).includes(people.clientA.id));
    assert.equal((await call("ownerB", "GET issues/open")).body.open, 0);
    // A itself sees them.
    assert.ok(ids(await call("ownerA", "GET requests")).includes(requestA.id));
    assert.ok(ids(await call("ownerA", "GET issues")).includes(issueA.id));
    assert.ok(ids(await call("ownerA", "GET reseller/clients")).includes(people.clientA.id));
    console.log(
      `HTTP isolation passed: all ${served.length} routes classified; platform and reseller administration refused to everyone else; another environment's requests, issues and clients not found by ID; lists without other environments' data.`,
    );
  } finally {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await redis.quit();
  }
}
main().catch((error) => {
  console.error("HTTP isolation test failed:", error);
  process.exitCode = 1;
});
