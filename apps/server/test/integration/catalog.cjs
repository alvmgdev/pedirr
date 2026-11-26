const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { NotFoundException } = require("@nestjs/common");
const { PrismaClient } = require("@prisma/client");
const Redis = require("ioredis");
const { CatalogController } = require("../../dist/metadata/controller");
const { CatalogAccess } = require("../../dist/metadata/access");
const { Schedule } = require("../../dist/metadata/schedule");
const { indexLeagues, leagueIndexStale } = require("../../dist/jobs/league-index");

const code = (expected) => (error) => error.getResponse().code === expected;

async function main() {
  const schema = "test_catalog_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  const redis = new Redis(process.env.REDIS_URL);
  const infrastructure = { db, redis };
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const combat = "sport-combat";
    const basketball = "sport-basketball";
    const leagues = [
      { id: "league-ufc", shortId: "lg-1", name: "UFC", sportId: combat, sportName: "Combat" },
      { id: "league-pfl", shortId: "lg-2", name: "PFL", sportId: combat, sportName: "Combat" },
      { id: "league-nba", shortId: "lg-3", name: "NBA", sportId: basketball },
      { id: "league-wnba", shortId: "lg-4", name: "WNBA", sportId: basketball },
      { id: "league-acb", shortId: "lg-5", name: "Liga ACB", sportId: basketball },
    ];
    // A league Hub knows but the index has not seen yet.
    const fresh = { id: "league-bkfc", shortId: "lg-6", name: "BKFC", sportId: combat };
    const leagueOf = (id) => id.split("-").slice(0, 2).join("-");
    const hubCalls = [];
    let hubLeagues = leagues;
    const metadata = {
      leagues: async (page, pageSize = 30) => {
        hubCalls.push(["leagues", page, pageSize]);
        const items = hubLeagues.slice((page - 1) * 2, page * 2);
        return {
          items,
          total: hubLeagues.length,
          page,
          pageSize: 2,
          totalPages: Math.ceil(hubLeagues.length / 2),
        };
      },
      league: async (id) => {
        hubCalls.push(["league", id]);
        const league = [...leagues, fresh].find((item) => [item.id, item.shortId].includes(id));
        if (!league) {
          throw new NotFoundException({ code: "METADATA_NOT_FOUND" });
        }
        return league;
      },
      search: async (q) => ({
        query: q,
        total: 1,
        results: [{ id: "x", name: q, entityType: "team" }],
      }),
      seasons: async () => ({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0 }),
      // Season and event IDs start with their league: "league-nba-2026".
      season: async (id) => ({ id, name: id, leagueId: leagueOf(id) }),
      event: async (id) => ({ id, name: id, leagueId: leagueOf(id) }),
      events: async (filters) => {
        const soon = new Date(Date.now() + 3600000).toISOString();
        return {
          items: ["league-ufc-e1", "league-nba-e1", "league-wnba-e1", "league-bkfc-e1"].map(
            (id) => ({ id, name: id, leagueId: leagueOf(id), scheduledStart: soon }),
          ),
          total: 4,
          page: filters.page,
          pageSize: 50,
          totalPages: 1,
        };
      },
      team: async (id) => ({ id, name: id }),
    };

    // The index fills page by page under a lock; each page queues the next one.
    const queued = [];
    const queue = { add: async (name, data, options) => queued.push({ name, data, options }) };
    assert.equal(await leagueIndexStale(infrastructure), true);
    await redis.del("pedirr:index:leagues");
    let job = {};
    for (let step = 0; step < 10; step++) {
      await redis.del("pedirr:index:pace");
      const result = await indexLeagues(infrastructure, metadata, queue, job, 1000);
      if (result.done) {
        break;
      }
      job = queued.at(-1).data;
    }
    assert.equal(await db.hubLeague.count(), 5);
    assert.deepEqual(
      hubCalls.filter((call) => call[0] === "leagues").map((call) => call[1]),
      [1, 2, 3],
    );
    assert.ok(queued.every((item) => item.options.delay > 0));
    assert.equal(await redis.get("pedirr:index:leagues"), null);
    // A run that finds another one going does nothing; a stale page of an old run stops.
    await redis.set("pedirr:index:leagues", "5000");
    await redis.del("pedirr:index:pace");
    assert.deepEqual(await indexLeagues(infrastructure, metadata, queue, {}, 6000), {
      skipped: "running",
    });
    assert.deepEqual(
      await indexLeagues(infrastructure, metadata, queue, { page: 2, startedAt: 1000 }, 6000),
      { skipped: "superseded" },
    );
    await redis.del("pedirr:index:leagues");
    // A complete run drops leagues Hub no longer lists.
    hubLeagues = leagues.slice(0, 4);
    queued.length = 0;
    job = {};
    for (let step = 0; step < 10; step++) {
      await redis.del("pedirr:index:pace");
      const result = await indexLeagues(infrastructure, metadata, queue, job, Date.now());
      if (result.done) {
        assert.equal(result.removed, 1);
        break;
      }
      job = queued.at(-1).data;
    }
    assert.equal(await db.hubLeague.findUnique({ where: { id: "league-acb" } }), null);
    assert.equal(await leagueIndexStale(infrastructure), false);

    const plan = await db.plan.create({
      data: {
        name: "Fights and NBA",
        grants: {
          create: [
            { kind: "SPORT", hubId: combat, name: "Combat" },
            { kind: "LEAGUE", hubId: "league-nba", name: "NBA" },
          ],
        },
      },
    });
    const user = (role, planId) =>
      db.user.create({
        data: { email: `${randomUUID()}@example.invalid`, passwordHash: "unused", role, planId },
      });
    const fighter = await user("USER", plan.id);
    const free = await user("USER", null);
    const admin = await user("ADMIN", plan.id);
    const controller = new CatalogController(
      metadata,
      { rate: async () => {} },
      infrastructure,
      new CatalogAccess(infrastructure, metadata),
      // Not ready: no complete copy of the schedule yet, so Hub answers as before.
      new Schedule(infrastructure, metadata),
    );
    const as = (viewer) => ({ viewer });

    // Search and the league list come from the index, limited to the plan and paginated there.
    const found = await controller.search({ q: "ba" }, as(fighter));
    assert.deepEqual(
      found.results.map((item) => [item.entityType, item.name]),
      [["league", "NBA"]],
    );
    assert.deepEqual(
      (await controller.search({ q: "lg-1" }, as(fighter))).results.map((item) => item.name),
      ["UFC"],
    );
    const list = await controller.leagues({ page: 1 }, as(fighter));
    assert.deepEqual(
      list.items.map((item) => item.name),
      ["NBA", "PFL", "UFC"],
    );
    assert.deepEqual([list.total, list.totalPages], [3, 1]);
    // Without a restrictive plan, and for administrators, Hub answers as before.
    for (const viewer of [free, admin]) {
      assert.equal(
        (await controller.search({ q: "ba" }, as(viewer))).results[0].entityType,
        "team",
      );
    }

    // Single leagues, seasons and events outside the plan say so.
    assert.equal((await controller.league({ id: "lg-1" }, as(fighter))).name, "UFC");
    await assert.rejects(
      controller.league({ id: "league-wnba" }, as(fighter)),
      code("PLAN_NOT_ALLOWED"),
    );
    await assert.rejects(
      controller.seasons({ id: "lg-4" }, { page: 1 }, as(fighter)),
      code("PLAN_NOT_ALLOWED"),
    );
    await controller.seasons({ id: "league-pfl" }, { page: 1 }, as(fighter));
    await assert.rejects(
      controller.season({ id: "league-wnba-2026" }, as(fighter)),
      code("PLAN_NOT_ALLOWED"),
    );
    assert.equal(
      (await controller.season({ id: "league-nba-2026" }, as(fighter))).leagueId,
      "league-nba",
    );
    await assert.rejects(
      controller.event({ id: "league-wnba-e9" }, as(fighter)),
      code("PLAN_NOT_ALLOWED"),
    );
    await assert.rejects(
      controller.events({ season: "league-wnba-2026", page: 1 }, as(fighter)),
      code("PLAN_NOT_ALLOWED"),
    );
    await assert.rejects(
      controller.events({ league: "league-wnba", page: 1 }, as(fighter)),
      code("PLAN_NOT_ALLOWED"),
    );
    // A league of a granted sport that is not indexed yet is checked with Hub.
    hubCalls.length = 0;
    assert.equal(
      (await controller.event({ id: "league-bkfc-e1" }, as(fighter))).id,
      "league-bkfc-e1",
    );
    assert.deepEqual(hubCalls, [["league", "league-bkfc"]]);
    for (const viewer of [free, admin]) {
      assert.equal(
        (await controller.event({ id: "league-wnba-e9" }, as(viewer))).id,
        "league-wnba-e9",
      );
    }

    // Lists mixing leagues (a team, the schedule) keep only the plan's leagues.
    const team = await controller.events({ team: "team-1", page: 1 }, as(fighter));
    assert.deepEqual(
      team.items.map((item) => item.id),
      ["league-ufc-e1", "league-nba-e1"],
    );
    assert.equal((await controller.events({ team: "team-1", page: 1 }, as(free))).items.length, 4);
    const upcoming = await controller.upcoming({ page: 1 }, as(fighter));
    assert.deepEqual(
      upcoming.items.map((item) => item.id),
      ["league-ufc-e1", "league-nba-e1"],
    );
    assert.equal((await controller.upcoming({ page: 1 }, as(admin))).items.length, 4);

    // Popular leagues outside the plan are hidden.
    for (const league of [leagues[0], leagues[3]]) {
      const entity = await db.catalogEntity.create({
        data: { kind: "LEAGUE", title: league.name, metadata: league },
      });
      // Followed at the platform, so platform users see them.
      await db.request.create({
        data: {
          entityId: entity.id,
          scopeKey: "season:x",
          scope: {},
          subscribers: { create: { userId: free.id } },
        },
      });
    }
    assert.deepEqual(
      (await controller.popular(as(fighter))).items.map((item) => item.title),
      ["UFC"],
    );
    assert.equal((await controller.popular(as(free))).items.length, 2);

    // "Every sport" plans restrict nothing.
    await db.plan.update({ where: { id: plan.id }, data: { allContent: true } });
    assert.equal((await controller.search({ q: "ba" }, as(fighter))).results[0].entityType, "team");
    console.log(
      "Catalog integration passed: paged league index with lock and cleanup, plan-limited search and league list, refusals for leagues, seasons and events outside the plan, Hub fallback for unindexed leagues, filtered team events, schedule and popular leagues, unrestricted viewers.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await redis.quit();
  }
}
main().catch((error) => {
  console.error("Catalog integration test failed:", error);
  process.exitCode = 1;
});
