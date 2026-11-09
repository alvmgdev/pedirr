const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { RequestsService } = require("../../dist/requests/service");

async function main() {
  const schema = "test_requests_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const users = await Promise.all(
      ["ADMIN", "USER", "USER"].map((role, index) =>
        db.user.create({
          data: { email: `${index}@example.invalid`, passwordHash: "unused", role },
        }),
      ),
    );
    const [admin, user, other] = users;
    const league = {
      id: "league-uuid",
      name: "Example League",
      shortId: "lg-100",
      tsdbId: "900",
      isActive: true,
    };
    const metadata = {
      league: async () => league,
      season: async (id) => ({
        id: id === "alias" ? "season-uuid" : id,
        name: "2026-2027",
        leagueId: league.id,
      }),
      event: async (id) => ({
        id,
        name: "A vs B",
        leagueId: league.id,
        seasonId: "season-uuid",
        scheduledStart: "2026-11-10T10:00:00Z",
      }),
    };
    const service = new RequestsService({ db }, metadata, {
      check: async () => ({ state: "missing" }),
    });
    const results = await Promise.all([
      service.create({ kind: "season", identifier: "season-uuid" }, user),
      service.create({ kind: "season", identifier: "alias" }, other),
    ]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results[0].request.id, results[1].request.id);
    assert.equal(await db.request.count(), 1);
    assert.equal(await db.requestSubscriber.count(), 2);
    assert.equal(await db.outboxEvent.count({ where: { type: "request.created" } }), 1);
    const request = results[0].request;
    assert.equal(request.status, "PENDING");
    assert.equal(request.scope.season.id, "season-uuid");
    assert.equal(await db.externalIdentifier.count(), 3);
    const reviewResults = await Promise.allSettled([
      service.moderate(request.id, { decision: "approve", version: 0 }, admin),
      service.moderate(
        request.id,
        { decision: "reject", version: 0, reason: "Not requested by policy" },
        admin,
      ),
    ]);
    assert.equal(reviewResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      reviewResults.find((result) => result.status === "rejected").reason.getResponse().code,
      "REQUEST_CHANGED",
    );
    const reviewed = await db.request.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(await db.requestHistory.count({ where: { requestId: request.id } }), 2);
    assert.equal(await db.outboxEvent.count({ where: { type: "request.status" } }), 1);
    assert.equal(
      await db.outboxEvent.count({ where: { type: "request.fulfill" } }),
      reviewed.status === "APPROVED" ? 1 : 0,
    );
    await db.setting.create({ data: { key: "autoApprove.USER", value: true } });
    const event = await service.create({ kind: "event", identifier: "event-auto" }, user);
    assert.equal(event.request.status, "APPROVED");
    assert.equal(event.request.scope.kind, "event");
    assert.equal(event.request.integrationState, "queued");
    await db.user.update({ where: { id: user.id }, data: { autoApprove: false } });
    const denied = await service.create({ kind: "event", identifier: "event-manual" }, user);
    assert.equal(denied.request.status, "PENDING");
    await assert.rejects(
      service.moderate(denied.request.id, { decision: "approve", version: 0 }, user),
      (error) => error.getStatus() === 403,
    );
    await assert.rejects(
      service.moderate(denied.request.id, { decision: "reject", version: 0 }, admin),
      (error) => error.getResponse().code === "REASON_REQUIRED",
    );
    await service.moderate(
      denied.request.id,
      { decision: "reject", version: 0, reason: "Outside scope" },
      admin,
    );
    const duplicate = await service.create({ kind: "event", identifier: "event-manual" }, other);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.request.status, "REJECTED");
    const mine = await service.list(other, 1, undefined, true);
    assert.equal(mine.total, 2);
    assert.ok(mine.items.every((item) => item.subscribed && !("subscribers" in item)));
    // Force an outbox failure and verify the request and subscription roll back.
    await db.$executeRawUnsafe(
      `ALTER TABLE "OutboxEvent" ADD CONSTRAINT reject_fulfillment CHECK (type <> 'request.fulfill') NOT VALID`,
    );
    const count = await db.request.count();
    await assert.rejects(service.create({ kind: "event", identifier: "must-rollback" }, other));
    assert.equal(await db.request.count(), count);
    assert.equal(
      await db.catalogEntity.count({
        where: { identifiers: { some: { value: "must-rollback" } } },
      }),
      0,
    );
    console.log(
      "Request integration passed: concurrent deduplication, scoped identities, moderation races, policy precedence, authorization, privacy and transactional outbox rollback.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Request integration test failed:", error.message);
  process.exitCode = 1;
});
