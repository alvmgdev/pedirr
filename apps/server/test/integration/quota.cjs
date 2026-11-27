const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const argon2 = require("argon2");
const { PrismaClient } = require("@prisma/client");
const { RequestsService } = require("../../dist/requests/service");
const { AuthService, digest } = require("../../dist/auth");
const { UsersService } = require("../../dist/users");
const { withWeeklyUsage } = require("../../dist/requests/quota");

const code = (expected) => (error) => error.getResponse().code === expected;

async function main() {
  const schema = "test_quota_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const create = (role, data = {}) =>
      db.user.create({
        data: { email: `${randomUUID()}@example.invalid`, passwordHash: "unused", role, ...data },
      });
    const admin = await create("ADMIN", { weeklyRequestLimit: 0 });
    const limited = await create("USER", { weeklyRequestLimit: 2 });
    const other = await create("USER");
    const league = { id: "league-uuid", name: "Example League", isActive: true };
    const metadata = {
      league: async () => league,
      event: async (id) => ({ id, name: id, leagueId: league.id }),
    };
    const service = new RequestsService({ db }, metadata, {
      check: async () => ({ state: "missing" }),
    });
    const request = (id, user) => service.create({ kind: "event", identifier: id }, user);

    // Without a limit there is nothing to count.
    assert.deepEqual(await service.quota(other), {
      limit: null,
      used: 0,
      remaining: null,
      resetsAt: null,
    });
    // Administrators are never limited, whatever their stored limit says.
    assert.equal((await request("admin-event", admin)).created, true);
    assert.equal((await service.quota(admin)).limit, null);

    const first = await request("event-1", limited);
    await request("event-2", limited);
    const spent = await service.quota(limited);
    assert.deepEqual([spent.limit, spent.used, spent.remaining], [2, 2, 0]);
    const firstAt = (
      await db.requestSubscriber.findUniqueOrThrow({
        where: { requestId_userId: { requestId: first.request.id, userId: limited.id } },
      })
    ).createdAt;
    assert.equal(spent.resetsAt, new Date(firstAt.getTime() + 7 * 86400000).toISOString());
    await assert.rejects(request("event-3", limited), (error) => {
      assert.equal(error.getResponse().code, "WEEKLY_LIMIT_REACHED");
      assert.equal(error.getResponse().resetsAt, spent.resetsAt);
      return true;
    });
    assert.equal(await db.request.count({ where: { entity: { title: "event-3" } } }), 0);

    // Following a request someone else started is free, even with no requests left.
    await request("shared", other);
    assert.equal((await request("shared", limited)).created, false);
    assert.equal((await service.quota(limited)).used, 2);

    // A rejected request is given back.
    await service.moderate(
      first.request.id,
      { decision: "reject", version: 0, reason: "No" },
      admin,
    );
    assert.equal((await service.quota(limited)).remaining, 1);
    assert.equal((await request("event-3", limited)).created, true);

    // Administrators' lists show what each account has used of its limit.
    const listed = new Map(
      (await new UsersService({ db }).list(1)).items.map((user) => [user.id, user]),
    );
    assert.equal(listed.get(limited.id).weeklyRequestsUsed, 2);
    assert.equal(listed.get(other.id).weeklyRequestsUsed, null);
    assert.equal(listed.get(admin.id).weeklyRequestsUsed, null);
    const [unused] = await withWeeklyUsage(db, [
      { id: randomUUID(), role: "USER", weeklyRequestLimit: 3 },
    ]);
    assert.equal(unused.weeklyRequestsUsed, 0);

    // Requests older than seven days leave the window.
    await db.requestSubscriber.updateMany({
      where: { userId: limited.id },
      data: { createdAt: new Date(Date.now() - 8 * 86400000) },
    });
    assert.equal((await service.quota(limited)).used, 0);

    // Concurrent requests cannot both take the last one.
    await db.user.update({ where: { id: limited.id }, data: { weeklyRequestLimit: 1 } });
    const fresh = await db.user.findUniqueOrThrow({ where: { id: limited.id } });
    const raced = await Promise.allSettled([request("race-1", fresh), request("race-2", fresh)]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      raced.find((result) => result.status === "rejected").reason.getResponse().code,
      "WEEKLY_LIMIT_REACHED",
    );

    // An expired account can neither request, keep its session nor sign in.
    const password = "correct horse battery";
    const expired = await create("USER", {
      passwordHash: await argon2.hash(password),
      expiresAt: new Date(Date.now() - 1000),
    });
    await assert.rejects(request("expired-event", expired), (error) => error.getStatus() === 403);
    process.env.SESSION_SECRET ??= "x".repeat(32);
    process.env.APP_ORIGIN ??= "http://localhost:3000";
    const auth = new AuthService({ db });
    await assert.rejects(auth.login(expired.email, password, {}), code("ACCOUNT_EXPIRED"));
    await assert.rejects(
      auth.login(expired.email, "wrong password!", {}),
      code("INVALID_CREDENTIALS"),
    );
    const token = "a".repeat(64);
    await db.session.create({
      data: {
        tokenHash: digest(token),
        userId: expired.id,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const req = { cookies: { [auth.cookieName]: token } };
    await auth.resolve(req);
    assert.equal(req.viewer, undefined);
    // Extending the date brings the account back.
    await db.user.update({ where: { id: expired.id }, data: { expiresAt: null } });
    await auth.resolve(req);
    assert.equal(req.viewer.id, expired.id);
    // Expiration never applies to administrators, so they cannot lock everyone out.
    await db.user.update({
      where: { id: expired.id },
      data: { role: "ADMIN", expiresAt: new Date(0) },
    });
    const adminReq = { cookies: { [auth.cookieName]: token } };
    await auth.resolve(adminReq);
    assert.equal(adminReq.viewer.id, expired.id);
    console.log("quota integration passed");
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
