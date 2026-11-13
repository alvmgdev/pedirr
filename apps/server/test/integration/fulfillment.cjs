const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { Fulfillment } = require("../../dist/jobs/fulfillment");
async function main() {
  const schema = "test_fulfillment_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const league = { id: "league", shortId: "lg-100", name: "League", sportName: "Soccer" };
    const event = {
      id: "event",
      shortId: "ev-100",
      name: "Game",
      leagueId: "league",
      scheduledStart: "2020-01-01T12:00:00Z",
    };
    const entity = await db.catalogEntity.create({
      data: { kind: "EVENT", title: "Game", metadata: event },
    });
    const request = await db.request.create({
      data: {
        entityId: entity.id,
        scopeKey: "event",
        status: "APPROVED",
        scope: { provider: "hub", kind: "event", league, event },
      },
    });
    const values = new Map();
    const redis = {
      set: async (key, value, _, __, nx) => {
        if (nx && values.has(key)) {
          return null;
        }
        values.set(key, value);
        return "OK";
      },
      get: async (key) => values.get(key),
      expire: async () => 1,
      eval: async (script, _, key, owner) => {
        if (values.get(key) !== owner) {
          return 0;
        }
        if (script.includes("'DEL'")) {
          values.delete(key);
        }
        return 1;
      },
    };
    let hasFile = false,
      activity = true,
      searches = 0,
      writes = 0,
      partFiles = null;
    const searchedParts = [];
    const refreshes = [];
    let importedEvent = false,
      importsOnRefresh = false;
    const held = () => ({
      id: 9,
      externalId: "ev-100",
      leagueId: 8,
      monitored: true,
      hasFile,
      files: partFiles ?? (hasFile ? [{ exists: true }] : []),
    });
    const manager = {
      assertWriteCompatibility: async () => {},
      ensureLeague: async (input) => {
        assert.equal(input.externalId, "lg-100");
        return { id: 8 };
      },
      // Sportarr holds the event only after importing it from the Hub.
      events: async () => (importedEvent ? [held()] : []),
      refreshEvents: async (leagueId, seasons) => {
        refreshes.push({ leagueId, seasons });
        importedEvent = importsOnRefresh;
      },
      queue: async () => (activity ? [{ eventId: 9, status: "Importing", progress: 100 }] : []),
      monitorEvent: async (externalId, leagueId, existing) => {
        writes++;
        assert.equal(externalId, "ev-100");
        assert.equal(leagueId, 8);
        return existing.find((item) => item.externalId === externalId);
      },
      parts: async () => [
        { name: "Full Event", number: 0 },
        { name: "Early Prelims", number: 1 },
        { name: "Prelims", number: 2 },
        { name: "Main Card", number: 3 },
        { name: "Post Show", number: 4 },
      ],
      search: async (_, part) => {
        searches++;
        if (part) {
          searchedParts.push(part);
        }
      },
    };
    const worker = new Fulfillment(
      { db, redis },
      { league: async () => league, event: async () => event },
      {
        configuration: async () => ({
          url: "http://sportarr",
          apiKey: "unused",
          rootFolderId: 1,
          qualityProfileId: 2,
        }),
      },
      () => manager,
      { attempts: 1, delayMs: 0 },
    );
    // Sportarr has not imported the event: it is requested from Sportarr, never made by hand,
    // nothing is searched, and the run asks to be retried.
    await assert.rejects(
      worker.run(request.id),
      (error) => error.getResponse().code === "EVENT_NOT_IMPORTED",
    );
    assert.deepEqual(refreshes, [{ leagueId: 8, seasons: [] }]);
    assert.equal(searches, 0);
    let waiting = await db.request.findUnique({ where: { id: request.id } });
    assert.equal(waiting.status, "APPROVED");
    assert.equal(waiting.lastError, "EVENT_NOT_IMPORTED");
    assert.equal(await db.requestEvent.count(), 0);
    // The next refresh imports it, and the same run goes on with the complete event.
    importsOnRefresh = true;
    await worker.run(request.id);
    assert.equal(refreshes.length, 2);
    waiting = await db.request.findUnique({ where: { id: request.id } });
    assert.equal(waiting.status, "DOWNLOADING");
    assert.equal(waiting.lastError, null);
    assert.equal(searches, 0);
    hasFile = true;
    activity = false;
    await worker.run(request.id);
    assert.equal((await db.request.findUnique({ where: { id: request.id } })).status, "AVAILABLE");
    assert.equal((await db.requestEvent.findFirst()).available, true);
    hasFile = false;
    await worker.run(request.id);
    assert.equal((await db.request.findUnique({ where: { id: request.id } })).status, "APPROVED");
    await worker.run(request.id);
    assert.equal(searches, 1);
    assert.equal(await db.outboxEvent.count({ where: { type: "request.status" } }), 3);
    // A split event with only its Main Card searches each missing part once, together.
    partFiles = [{ exists: true, partName: "Main Card", partNumber: 3 }];
    await worker.run(request.id);
    assert.deepEqual(searchedParts.sort(), ["Early Prelims", "Prelims"]);
    await worker.run(request.id);
    assert.equal(searchedParts.length, 2, "part searches share the retry interval");
    partFiles = null;
    const previousWrites = writes;
    event.leagueId = "another-league";
    await assert.rejects(worker.run(request.id));
    assert.equal(writes, previousWrites);
    const failed = await db.request.findUnique({ where: { id: request.id } });
    assert.equal(failed.status, "APPROVED");
    assert.equal(failed.lastError, "REQUEST_METADATA_CHANGED");
    assert.equal(failed.integrationState, "error");
    console.log(
      "Fulfillment integration passed: events imported by Sportarr and never created by hand, scoped writes, import states, lost-file recovery, throttled search, metadata conflict and durable status outbox.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Fulfillment integration test failed:", error.message);
  process.exitCode = 1;
});
