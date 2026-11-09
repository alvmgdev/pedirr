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
      writes = 0;
    const manager = {
      assertWriteCompatibility: async () => {},
      ensureLeague: async (input) => {
        assert.equal(input.externalId, "lg-100");
        return { id: 8 };
      },
      events: async () => [],
      queue: async () => (activity ? [{ eventId: 9, status: "Importing", progress: 100 }] : []),
      ensureEvent: async (input) => {
        writes++;
        assert.equal(input.externalId, "ev-100");
        assert.equal(input.leagueId, 8);
        return { id: 9, hasFile, files: hasFile ? [{ exists: true }] : [] };
      },
      search: async () => {
        searches++;
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
    );
    await worker.run(request.id);
    assert.equal(
      (await db.request.findUnique({ where: { id: request.id } })).status,
      "DOWNLOADING",
    );
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
    const previousWrites = writes;
    event.leagueId = "another-league";
    await assert.rejects(worker.run(request.id));
    assert.equal(writes, previousWrites);
    const failed = await db.request.findUnique({ where: { id: request.id } });
    assert.equal(failed.status, "APPROVED");
    assert.equal(failed.lastError, "REQUEST_METADATA_CHANGED");
    assert.equal(failed.integrationState, "error");
    console.log(
      "Fulfillment integration passed: scoped writes, import states, lost-file recovery, throttled search, metadata conflict and durable status outbox.",
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
