const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const Redis = require("ioredis");
const { CatalogController } = require("../../dist/metadata/controller");
const { CatalogAccess } = require("../../dist/metadata/access");
const { Schedule, SCHEDULE_PAGE_SIZE, SCHEDULE_SETTING } = require("../../dist/metadata/schedule");
const { indexSchedule, scheduleIndexStale } = require("../../dist/jobs/schedule-index");

const HOUR = 3600000;
const DAY = 24 * HOUR;

async function main() {
  const schema = "test_schedule_" + randomUUID().replaceAll("-", "");
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
    for (const key of ["schedule-full", "schedule-near", "pace"]) {
      await redis.del(`pedirr:index:${key}`);
    }
    const now = Date.now();
    const at = (offset) => new Date(now + offset).toISOString();
    // Hub's schedule: plenty of NBA games to page through, a few fights, and edge cases.
    let hub = [
      ...Array.from({ length: 70 }, (_, index) => ({
        id: `nba-${String(index).padStart(2, "0")}`,
        name: `Lakers vs Team ${index}`,
        leagueId: "league-nba",
        homeTeamId: "team-lakers",
        homeTeamName: "Los Angeles Lakers",
        homeTeamBadgeUrl: "https://example.invalid/lakers.png",
        awayTeamId: `team-${index}`,
        awayTeamName: `Team ${index}`,
        scheduledStart: at((index + 1) * HOUR),
        status: "scheduled",
      })),
      { id: "ufc-1", name: "UFC 320", leagueId: "league-ufc", scheduledStart: at(2 * DAY) },
      { id: "ufc-past", name: "UFC 319", leagueId: "league-ufc", scheduledStart: at(-3 * DAY) },
      { id: "ufc-late", name: "UFC 321", leagueId: "league-ufc", scheduledStart: at(10 * DAY) },
      {
        id: "ufc-off",
        name: "UFC Cancelled",
        leagueId: "league-ufc",
        scheduledStart: at(DAY),
        status: "cancelled",
      },
      {
        id: "wnba-1",
        name: "Sparks vs Liberty",
        leagueId: "league-wnba",
        scheduledStart: at(HOUR),
      },
    ];
    const calls = [];
    const metadata = {
      events: async (filters) => {
        calls.push(filters);
        const from = Date.parse(`${filters.from}T00:00:00Z`);
        const to = Date.parse(`${filters.to}T00:00:00Z`) + DAY;
        const inWindow = hub.filter((event) => {
          const start = Date.parse(event.scheduledStart);
          return start >= from && start < to;
        });
        const size = 25;
        return {
          items: inWindow.slice((filters.page - 1) * size, filters.page * size),
          total: inWindow.length,
          page: filters.page,
          pageSize: size,
          totalPages: Math.max(1, Math.ceil(inWindow.length / size)),
        };
      },
    };
    const queued = [];
    const queue = { add: async (name, data, options) => queued.push({ name, data, options }) };
    async function run(window, when = Date.now()) {
      queued.length = 0;
      let job = { window };
      for (let step = 0; step < 20; step++) {
        // Pages run back to back here; the shared pace is checked on its own below.
        await redis.del("pedirr:index:pace");
        const result = await indexSchedule(infrastructure, metadata, queue, job, when);
        if (result.done) {
          return result;
        }
        assert.equal(queued.at(-1).name, "schedule-index");
        job = queued.at(-1).data;
      }
      throw new Error("Run did not finish");
    }

    // The whole window: 7 days back to 14 ahead, paged, with every page using the same window.
    assert.equal(await scheduleIndexStale(infrastructure), true);
    const schedule = new Schedule(infrastructure, metadata);
    assert.equal(await schedule.ready(), false);
    await run("full");
    const windows = new Set(calls.map((call) => `${call.from}..${call.to}`));
    assert.equal(windows.size, 1);
    const [from, to] = [...windows][0].split("..");
    assert.equal(from, new Date(now - 7 * DAY).toISOString().slice(0, 10));
    assert.equal(to, new Date(now + 14 * DAY).toISOString().slice(0, 10));
    assert.ok(calls.every((call) => call.pageSize === 100));
    assert.equal(await db.hubEvent.count(), hub.length);
    assert.equal(await schedule.ready(), true);
    assert.equal(await scheduleIndexStale(infrastructure), false);
    // The hourly check does not copy the whole window again while its last copy is fresh.
    calls.length = 0;
    assert.deepEqual(await indexSchedule(infrastructure, metadata, queue, { window: "full" }), {
      skipped: "fresh",
    });
    assert.equal(calls.length, 0);
    const stored = await db.hubEvent.findUniqueOrThrow({ where: { id: "nba-00" } });
    assert.equal(stored.homeTeamName, "Los Angeles Lakers");
    assert.equal(stored.item.homeTeamBadgeUrl, "https://example.invalid/lakers.png");

    // Background copies share one pace: a copy finding it taken waits its turn, page unchanged.
    await redis.set("pedirr:index:pace", "1", "PX", 5000);
    queued.length = 0;
    const waiting = await indexSchedule(infrastructure, metadata, queue, { window: "near" });
    assert.ok(waiting.waiting > 0 && waiting.waiting <= 5000);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].data.page, 1);
    assert.ok(queued[0].options.delay > 0);
    await redis.del("pedirr:index:schedule-near");
    // The hourly run covers today and tomorrow, updates what changed and removes nothing.
    calls.length = 0;
    hub = hub.map((event) =>
      event.id === "wnba-1" ? { ...event, name: "Sparks vs Liberty (moved)" } : event,
    );
    const removedFromHub = hub.find((event) => event.id === "nba-69");
    hub = hub.filter((event) => event !== removedFromHub);
    await run("near");
    assert.equal(calls[0].from, new Date(now).toISOString().slice(0, 10));
    assert.equal(calls[0].to, new Date(now + DAY).toISOString().slice(0, 10));
    assert.equal(
      (await db.hubEvent.findUniqueOrThrow({ where: { id: "wnba-1" } })).name,
      "Sparks vs Liberty (moved)",
    );
    assert.ok(await db.hubEvent.findUnique({ where: { id: "nba-69" } }));
    // A day later the whole window is due again, and removes what Hub no longer lists.
    await db.setting.update({
      where: { key: "index.schedule" },
      data: { value: { completedAt: new Date(Date.now() - 2 * DAY).toISOString() } },
    });
    const full = await run("full", Date.now() + 1000);
    assert.equal(full.removed, 1);
    assert.equal(await db.hubEvent.findUnique({ where: { id: "nba-69" } }), null);

    // Users on a plan, the whole catalog for others.
    await db.hubLeague.createMany({
      data: [
        { id: "league-ufc", name: "UFC", sportId: "sport-combat", syncedAt: new Date() },
        { id: "league-nba", name: "NBA", sportId: "sport-basketball", syncedAt: new Date() },
        { id: "league-wnba", name: "WNBA", sportId: "sport-basketball", syncedAt: new Date() },
      ],
    });
    const plan = await db.plan.create({
      data: {
        name: "Fights and NBA",
        grants: {
          create: [
            { kind: "SPORT", hubId: "sport-combat", name: "Combat" },
            { kind: "LEAGUE", hubId: "league-nba", name: "NBA" },
          ],
        },
      },
    });
    const fighter = await db.user.create({
      data: { email: "fighter@example.invalid", passwordHash: "unused", planId: plan.id },
    });
    const free = await db.user.create({
      data: { email: "free@example.invalid", passwordHash: "unused" },
    });
    const controller = new CatalogController(
      { search: async () => assert.fail("Hub search is not used for users on a plan") },
      { rate: async () => {} },
      infrastructure,
      new CatalogAccess(infrastructure, {}),
      schedule,
    );
    const as = (viewer) => ({ viewer });

    // The schedule pages in Pedirr: soonest first, next seven days, no cancelled or past events.
    const first = await controller.upcoming({ page: 1 }, as(free));
    assert.equal(first.items.length, SCHEDULE_PAGE_SIZE);
    assert.deepEqual([first.hasMore, first.nextPage], [true, 2]);
    assert.equal(first.items[0].id, "nba-00");
    const second = await controller.upcoming({ page: 2 }, as(free));
    const everything = [...first.items, ...second.items].map((item) => item.id);
    assert.equal(second.hasMore, false);
    assert.equal(new Set(everything).size, everything.length);
    for (const hidden of ["ufc-past", "ufc-late", "ufc-off"]) {
      assert.equal(everything.includes(hidden), false, hidden);
    }
    assert.ok(everything.includes("wnba-1") && everything.includes("ufc-1"));
    const starts = [...first.items, ...second.items].map((item) => Date.parse(item.scheduledStart));
    assert.deepEqual(
      starts,
      [...starts].sort((a, b) => a - b),
    );
    // For a plan, every page is full of the plan's events: no short pages.
    const planned = await controller.upcoming({ page: 1 }, as(fighter));
    assert.equal(planned.items.length, SCHEDULE_PAGE_SIZE);
    assert.ok(planned.items.every((item) => ["league-nba", "league-ufc"].includes(item.leagueId)));
    const rest = await controller.upcoming({ page: 2 }, as(fighter));
    assert.equal(rest.hasMore, false);
    assert.equal(
      [...planned.items, ...rest.items].some((item) => item.leagueId === "league-wnba"),
      false,
    );

    // Users on a plan find leagues, the teams playing in the copy and its events.
    const lakers = await controller.search({ q: "lakers" }, as(fighter));
    const kinds = (result) => result.results.map((item) => item.entityType);
    assert.deepEqual([...new Set(kinds(lakers))], ["team", "event"]);
    const team = lakers.results.find((item) => item.entityType === "team");
    assert.deepEqual(team, {
      id: "team-lakers",
      name: "Los Angeles Lakers",
      entityType: "team",
      imageUrl: "https://example.invalid/lakers.png",
      logoUrl: "https://example.invalid/lakers.png",
    });
    assert.equal(lakers.results.filter((item) => item.entityType === "event").length, 20);
    const ufc = await controller.search({ q: "ufc" }, as(fighter));
    assert.deepEqual(
      ufc.results.map((item) => [item.entityType, item.name]),
      [
        ["league", "UFC"],
        ["event", "UFC 319"],
        ["event", "UFC 320"],
        ["event", "UFC 321"],
      ],
    );
    // Events of leagues outside the plan are not found.
    const sparks = await controller.search({ q: "sparks" }, as(fighter));
    assert.deepEqual(sparks.results, []);

    // A stale copy is not used: the schedule comes from Hub again.
    await db.setting.update({
      where: { key: SCHEDULE_SETTING },
      data: { value: { completedAt: new Date(now - 3 * DAY).toISOString() } },
    });
    assert.equal(await schedule.ready(), false);
    let hubAsked = false;
    const hubOnly = {
      events: async ({ page }) => {
        hubAsked = true;
        return { items: [], page, totalPages: 1 };
      },
    };
    const fallback = new CatalogController(
      hubOnly,
      { rate: async () => {} },
      infrastructure,
      new CatalogAccess(infrastructure, {}),
      new Schedule(infrastructure, hubOnly),
    );
    await fallback.upcoming({ page: 1 }, as(free));
    assert.equal(hubAsked, true);
    console.log(
      "Schedule integration passed: paged whole and hourly copies with one window per run, a shared background pace, cleanup only on whole runs, readiness and staleness, schedule paging for everyone and for plans, plan search of teams and events, fallback to Hub.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await redis.quit();
  }
}
main().catch((error) => {
  console.error("Schedule integration test failed:", error);
  process.exitCode = 1;
});
