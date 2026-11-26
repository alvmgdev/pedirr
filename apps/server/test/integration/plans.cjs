const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { NotFoundException } = require("@nestjs/common");
const { PrismaClient } = require("@prisma/client");
const { RequestsService } = require("../../dist/requests/service");
const { PlansService } = require("../../dist/plans");
const { UsersService } = require("../../dist/users");

const code = (expected) => (error) => error.getResponse().code === expected;

async function main() {
  const schema = "test_plans_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const combat = { id: "sport-combat", shortId: "sp-1", name: "Combat" };
    const basketball = { id: "sport-basketball", shortId: "sp-2", name: "Basketball" };
    const leagues = {
      ufc: { id: "league-ufc", shortId: "lg-1", name: "UFC", sportId: combat.id },
      pfl: { id: "league-pfl", shortId: "lg-2", name: "PFL", sportId: combat.id },
      nba: { id: "league-nba", shortId: "lg-3", name: "NBA", sportId: basketball.id },
      wnba: { id: "league-wnba", shortId: "lg-4", name: "WNBA", sportId: basketball.id },
    };
    const leagueLookups = [];
    const metadata = {
      sports: async () => ({ items: [combat, basketball], total: 2, page: 1, pageSize: 100 }),
      league: async (id) => {
        leagueLookups.push(id);
        const league = Object.values(leagues).find((item) => [item.id, item.shortId].includes(id));
        if (!league) {
          throw new NotFoundException({ code: "METADATA_NOT_FOUND" });
        }
        return league;
      },
      // Event IDs name their league: "ufc-1" belongs to UFC.
      event: async (id) => ({ id, name: id, leagueId: leagues[id.split("-")[0]].id }),
    };
    const plans = new PlansService({ db }, metadata);
    const users = new UsersService({ db });
    const requests = new RequestsService({ db }, metadata, {
      check: async () => ({ state: "missing" }),
      parts: async () => ({ supported: false, parts: [] }),
    });

    // Grants are stored under Hub's canonical ID and name, whatever the client sent.
    const fights = await plans.create({
      name: "Fights",
      allContent: false,
      grants: [
        { kind: "SPORT", hubId: "sp-1" },
        { kind: "LEAGUE", hubId: "lg-3" },
        { kind: "LEAGUE", hubId: "league-nba" },
      ],
    });
    assert.deepEqual(
      fights.grants.map(({ kind, hubId, name }) => [kind, hubId, name]),
      [
        ["SPORT", combat.id, "Combat"],
        ["LEAGUE", leagues.nba.id, "NBA"],
      ],
    );
    assert.equal(fights.users, 0);
    await assert.rejects(
      plans.create({ name: "Nothing", allContent: false, grants: [] }),
      code("PLAN_EMPTY"),
    );
    await assert.rejects(
      plans.create({ name: "Bad", allContent: false, grants: [{ kind: "LEAGUE", hubId: "nope" }] }),
      code("INVALID_PLAN_GRANT"),
    );
    await assert.rejects(
      plans.create({ name: "Bad", allContent: false, grants: [{ kind: "SPORT", hubId: "nope" }] }),
      code("INVALID_PLAN_GRANT"),
    );
    await assert.rejects(
      plans.create({ name: "Fights", allContent: true, grants: [] }),
      code("PLAN_NAME_TAKEN"),
    );
    // Saving again does not look up leagues the plan already has.
    leagueLookups.length = 0;
    await plans.update(fights.id, {
      name: "Fights",
      allContent: false,
      grants: fights.grants.map(({ kind, hubId }) => ({ kind, hubId })),
    });
    assert.deepEqual(leagueLookups, []);
    const everything = await plans.create({ name: "Everything", allContent: true, grants: [] });
    // A plan is a content package; weekly limits belong to each user.
    assert.equal("weeklyRequestLimit" in everything, false);
    assert.deepEqual(
      (await plans.list()).map((plan) => plan.name),
      ["Everything", "Fights"],
    );
    assert.deepEqual(await plans.sports(), [
      { id: combat.id, name: "Combat" },
      { id: basketball.id, name: "Basketball" },
    ]);

    const create = (email, data = {}) =>
      users.create({ email, password: "a-long-enough-password", ...data });
    const fighter = await create("fighter@example.invalid", { planId: fights.id });
    assert.deepEqual(fighter.plan, { id: fights.id, name: "Fights" });
    const free = await create("free@example.invalid");
    assert.equal(free.plan, null);
    await assert.rejects(
      create("ghost@example.invalid", { planId: randomUUID() }),
      code("PLAN_NOT_FOUND"),
    );
    await assert.rejects(users.update(free.id, { planId: randomUUID() }), code("PLAN_NOT_FOUND"));
    const admin = await db.user.create({
      data: {
        email: "admin@example.invalid",
        passwordHash: "unused",
        role: "ADMIN",
        planId: fights.id,
      },
    });

    const request = (id, user) => requests.create({ kind: "event", identifier: id }, user);
    // A sport grant covers every league of the sport; a league grant only that league.
    assert.equal((await request("ufc-1", fighter)).created, true);
    assert.equal((await request("pfl-1", fighter)).created, true);
    assert.equal((await request("nba-1", fighter)).created, true);
    await assert.rejects(request("wnba-1", fighter), code("PLAN_NOT_ALLOWED"));
    assert.equal(await db.request.count({ where: { entity: { title: "wnba-1" } } }), 0);
    assert.deepEqual(await requests.lookup({ kind: "event", identifier: "wnba-1" }, fighter), {
      state: "not_allowed",
    });
    assert.deepEqual(await requests.partOptions({ kind: "event", identifier: "wnba-1" }, fighter), {
      supported: false,
      parts: [],
    });
    // Following someone else's request outside the plan is refused too.
    assert.equal((await request("wnba-2", free)).created, true);
    await assert.rejects(request("wnba-2", fighter), code("PLAN_NOT_ALLOWED"));
    // No plan means everything; administrators are never restricted by a plan.
    assert.equal((await request("wnba-3", admin)).created, true);

    // The user's own weekly limit applies alongside the plan.
    assert.equal((await requests.quota(fighter)).limit, null);
    await users.update(fighter.id, { weeklyRequestLimit: 3 });
    await assert.rejects(request("ufc-2", fighter), code("WEEKLY_LIMIT_REACHED"));
    await users.update(fighter.id, { weeklyRequestLimit: 5 });
    assert.equal((await request("ufc-2", fighter)).created, true);

    // A plan change applies at once, even to a session holding the old user.
    await users.update(fighter.id, { planId: everything.id });
    assert.equal((await request("wnba-4", fighter)).created, true);
    assert.equal((await requests.quota(fighter)).limit, 5);
    await users.update(fighter.id, { weeklyRequestLimit: null });
    assert.equal((await requests.quota(fighter)).limit, null);

    // Plans with users cannot be deleted.
    await assert.rejects(plans.remove(everything.id), code("PLAN_IN_USE"));
    assert.equal((await plans.detail(everything.id)).users, 1);
    await users.update(fighter.id, { planId: null });
    assert.deepEqual(await plans.remove(everything.id), { ok: true });
    await assert.rejects(plans.detail(everything.id), code("PLAN_NOT_FOUND"));
    await db.user.update({ where: { id: admin.id }, data: { planId: null } });
    await plans.remove(fights.id);
    assert.equal(await db.planGrant.count(), 0);
    console.log(
      "Plans integration passed: canonical grants, validation, sport and league access, following, administrators, user weekly limits alongside plans, live plan changes and deletion rules.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Plans integration test failed:", error);
  process.exitCode = 1;
});
