const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { NestFactory } = require("@nestjs/core");
const { Module, ValidationPipe } = require("@nestjs/common");
const { APP_GUARD } = require("@nestjs/core");
const cookieParser = require("cookie-parser");
const argon2 = require("argon2");
process.env.APP_ORIGIN = "http://localhost:3187";
process.env.SESSION_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
const { AuthController, AuthService, SecurityGuard, passwordOptions } = require("../dist/auth");
const { UsersController, UsersService } = require("../dist/users");
const { Infrastructure } = require("../dist/infrastructure");
const { trustProxy } = require("../dist/config");
let app, base, user;
let registrationSetting = null;
const sessions = new Map();
const counters = new Map();
const infrastructure = {
  redis: {
    eval: async (_, __, key) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    },
  },
  db: {
    user: {
      findUnique: async () => user,
      findUniqueOrThrow: async () => publicUser(),
      create: async ({ data }) => ({ ...publicUser(), id: "user-2", email: data.email }),
    },
    session: {
      create: async ({ data }) => sessions.set(data.tokenHash, { ...data, user: publicUser() }),
      findUnique: async ({ where }) => {
        const session = sessions.get(where.tokenHash);
        return session ? { ...session, user: publicUser() } : null;
      },
      deleteMany: async ({ where }) => sessions.delete(where.tokenHash),
    },
    setting: { findUnique: async () => registrationSetting },
  },
};
function publicUser() {
  const { passwordHash, ...result } = user;
  return result;
}
class TestModule {}
Module({
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    UsersService,
    { provide: Infrastructure, useValue: infrastructure },
    { provide: APP_GUARD, useClass: SecurityGuard },
  ],
})(TestModule);
before(async () => {
  user = {
    id: "user-1",
    email: "person@example.com",
    role: "USER",
    active: true,
    locale: "en",
    timezone: "UTC",
    autoApprove: null,
    passwordHash: await argon2.hash("a-strong-test-password", passwordOptions),
  };
  app = await NestFactory.create(TestModule, { logger: false });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
after(async () => {
  await app?.close();
});
async function csrf(cookie) {
  const response = await fetch(base + "/auth/csrf", { headers: cookie ? { cookie } : {} });
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()).token;
}
async function login(token, extra = {}) {
  return fetch(base + "/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: process.env.APP_ORIGIN,
      "x-csrf-token": token,
      ...extra,
    },
    body: JSON.stringify({ email: user.email, password: "a-strong-test-password" }),
  });
}
test("unauthenticated requests cannot read a profile", async () => {
  assert.equal((await fetch(base + "/auth/me")).status, 401);
});
test("login requires matching Origin and CSRF", async () => {
  assert.equal((await login("bad")).status, 403);
  assert.equal((await login(await csrf(), { origin: "https://attacker.example" })).status, 403);
});
test("login issues an opaque HttpOnly cookie, binds CSRF, and logout revokes it", async () => {
  const anonymousToken = await csrf();
  const response = await login(anonymousToken);
  assert.equal(response.status, 201);
  const header = response.headers.get("set-cookie");
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  const cookie = header.split(";")[0];
  const profile = await response.json();
  assert.equal(profile.passwordHash, undefined);
  assert.equal((await fetch(base + "/auth/me", { headers: { cookie } })).status, 200);
  const logout = (token) =>
    fetch(base + "/auth/logout", {
      method: "POST",
      headers: { cookie, origin: process.env.APP_ORIGIN, "x-csrf-token": token },
    });
  assert.equal((await logout(anonymousToken)).status, 403);
  assert.equal((await logout(await csrf(cookie))).status, 201);
  assert.equal((await fetch(base + "/auth/me", { headers: { cookie } })).status, 401);
});
test("disabling a user invalidates existing sessions", async () => {
  const response = await login(await csrf());
  const cookie = response.headers.get("set-cookie").split(";")[0];
  user.active = false;
  assert.equal((await fetch(base + "/auth/me", { headers: { cookie } })).status, 401);
  user.active = true;
});
test("registration stays closed until explicitly enabled", async () => {
  const response = await fetch(base + "/auth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: process.env.APP_ORIGIN,
      "x-csrf-token": await csrf(),
    },
    body: JSON.stringify({ email: "new@example.com", password: "a-strong-test-password" }),
  });
  assert.equal(response.status, 403);
});
test("public configuration reports closed registration by default", async () => {
  const response = await fetch(base + "/auth/config");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { registrationEnabled: false });
});
test("enabled registration is reported publicly and accepts new accounts", async () => {
  registrationSetting = { key: "registration", value: true };
  try {
    assert.deepEqual(await (await fetch(base + "/auth/config")).json(), {
      registrationEnabled: true,
    });
    const response = await fetch(base + "/auth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: process.env.APP_ORIGIN,
        "x-csrf-token": await csrf(),
      },
      body: JSON.stringify({ email: "New@Example.com", password: "a-strong-test-password" }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).email, "new@example.com");
  } finally {
    registrationSetting = null;
  }
});
test("shared login rate limiter rejects excessive attempts", async () => {
  let response;
  for (let i = 0; i < 16; i++) {
    response = await login(await csrf());
  }
  assert.equal(response.status, 429);
});

test("a trusted proxy gives each client its own login limit", async () => {
  counters.clear();
  const express = app.getHttpAdapter().getInstance();
  express.set("trust proxy", trustProxy("loopback"));
  try {
    for (let i = 0; i < 3; i++) {
      await login(await csrf(), { "x-forwarded-for": "203.0.113.7" });
    }
    await login(await csrf(), { "x-forwarded-for": "198.51.100.9" });
    assert.equal(counters.get("pedirr:rate:login:203.0.113.7"), 3);
    assert.equal(counters.get("pedirr:rate:login:198.51.100.9"), 1);
  } finally {
    express.set("trust proxy", false);
    counters.clear();
  }
});

test("without a trusted proxy, forwarded addresses cannot dodge the limit", async () => {
  counters.clear();
  for (let i = 0; i < 3; i++) {
    await login(await csrf(), { "x-forwarded-for": `198.51.100.${i}` });
  }
  const keys = [...counters.keys()].filter((key) => key.startsWith("pedirr:rate:login:"));
  assert.equal(keys.length, 1);
  assert.equal(counters.get(keys[0]), 3);
  assert.doesNotMatch(keys[0], /198\.51\.100/);
  counters.clear();
});

test("ordinary users cannot read or change administrator policies", async () => {
  counters.clear();
  const response = await login(await csrf());
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(base + "/admin/policies", { headers: { cookie } })).status, 403);
  assert.equal(
    (
      await fetch(base + "/admin/policies", {
        method: "PATCH",
        headers: {
          cookie,
          origin: process.env.APP_ORIGIN,
          "x-csrf-token": await csrf(cookie),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          registrationEnabled: true,
          userAutoApprove: true,
          adminAutoApprove: true,
        }),
      })
    ).status,
    403,
  );
});
