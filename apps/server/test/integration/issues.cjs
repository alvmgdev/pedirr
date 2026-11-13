const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { IssuesService } = require("../../dist/issues/service");

// Issues against real PostgreSQL: visibility, lifecycle, timeline and outbox.
async function main() {
  const schema = "test_issues_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const user = (email, role = "USER") =>
      db.user.create({ data: { email, passwordHash: "unused", role } });
    const admin = await user("admin@example.invalid", "ADMIN");
    const alice = await user("alice@example.invalid");
    const bob = await user("bob@example.invalid");
    const eve = await user("eve@example.invalid");
    const entity = await db.catalogEntity.create({
      data: { kind: "LEAGUE", title: "UFC", metadata: {} },
    });
    const request = await db.request.create({
      data: {
        entityId: entity.id,
        scopeKey: "season:hub:2026",
        status: "AVAILABLE",
        scope: { kind: "season", provider: "hub", season: { name: "2026" } },
        parts: { create: [{ name: "Main Card", status: "APPROVED" }] },
        subscribers: {
          create: [
            { userId: alice.id, parts: ["Main Card"], status: "AVAILABLE" },
            { userId: bob.id, parts: ["Main Card"], status: "AVAILABLE" },
          ],
        },
        events: {
          create: {
            externalId: "ufc-334",
            metadata: { name: "UFC 334" },
            parts: ["Early Prelims", "Prelims", "Main Card"],
          },
        },
      },
      include: { events: true },
    });
    const event = request.events[0];
    const issues = new IssuesService({ db });
    const code = (expected) => (error) => error.getResponse().code === expected;

    // Only followers of a request report on it; anyone else cannot even confirm it exists.
    await assert.rejects(
      issues.create(request.id, { category: "QUALITY", description: "Bad" }, eve),
      code("REQUEST_NOT_FOUND"),
    );
    await assert.rejects(
      issues.create(
        request.id,
        { category: "QUALITY", description: "Bad", eventId: randomUUID() },
        alice,
      ),
      code("INVALID_ISSUE_TARGET"),
    );
    await assert.rejects(
      issues.create(
        request.id,
        { category: "QUALITY", description: "Bad", part: "Countdown" },
        alice,
      ),
      code("INVALID_ISSUE_TARGET"),
    );
    await assert.rejects(
      issues.create(request.id, { category: "QUALITY", description: "   " }, alice),
      code("DESCRIPTION_REQUIRED"),
    );
    const report = await issues.create(
      request.id,
      {
        category: "LANGUAGE",
        description: "  The commentary is in Portuguese  ",
        eventId: event.id,
        part: "main card",
      },
      alice,
    );
    assert.equal(report.status, "OPEN");
    assert.equal(report.part, "Main Card");
    assert.equal(report.description, "The commentary is in Portuguese");
    assert.deepEqual(report.event, { id: event.id, name: "UFC 334" });
    assert.equal(report.request.season, "2026");
    assert.equal(report.reporter, null, "reporters do not get their own identity back");
    const duplicate = await issues
      .create(
        request.id,
        { category: "LANGUAGE", description: "Again", eventId: event.id, part: "Main Card" },
        alice,
      )
      .catch((error) => error.getResponse());
    assert.equal(duplicate.code, "ISSUE_EXISTS");
    assert.equal(duplicate.issueId, report.id);
    const bobs = await issues.create(
      request.id,
      { category: "PLAYBACK", description: "Stutters" },
      bob,
    );
    const created = await db.outboxEvent.findMany({ where: { type: "issue.created" } });
    assert.equal(created.length, 2);

    // Each user sees only their own issues; administrators see everything and who reported it.
    assert.deepEqual(
      (await issues.list(alice, { page: 1 })).items.map((item) => item.id),
      [report.id],
    );
    await assert.rejects(issues.detail(report.id, bob), code("ISSUE_NOT_FOUND"));
    await assert.rejects(issues.comment(report.id, "Me too", bob), code("ISSUE_NOT_FOUND"));
    const all = await issues.list(admin, { page: 1 });
    assert.equal(all.total, 2);
    assert.equal(all.items.find((item) => item.id === report.id).reporter.email, alice.email);
    assert.deepEqual(
      (await issues.list(admin, { page: 1, category: "PLAYBACK" })).items.map((item) => item.id),
      [bobs.id],
    );
    assert.equal((await issues.list(admin, { page: 1, requestId: request.id })).total, 2);
    assert.deepEqual(await issues.open(admin), { open: 2 });
    assert.deepEqual(await issues.open(alice), { open: 1 });

    // Administrators move the issue along; resolving requires an explanation.
    let detail = await issues.changeStatus(report.id, { status: "IN_PROGRESS" }, admin);
    assert.equal(detail.status, "IN_PROGRESS");
    await assert.rejects(
      issues.changeStatus(report.id, { status: "RESOLVED" }, admin),
      code("COMMENT_REQUIRED"),
    );
    await assert.rejects(
      issues.changeStatus(report.id, { status: "IN_PROGRESS" }, alice),
      code("ISSUE_STATUS_NOT_ALLOWED"),
    );
    await issues.comment(report.id, "Which language do you expect?", admin);
    await issues.comment(report.id, "English, please", alice);
    detail = await issues.changeStatus(
      report.id,
      { status: "RESOLVED", comment: "Replaced the file in Sportarr" },
      admin,
    );
    assert.equal(detail.status, "RESOLVED");
    assert.ok(detail.resolvedAt);

    // The reporter sees the conversation without administrator identities.
    detail = await issues.detail(report.id, alice);
    assert.deepEqual(
      detail.timeline.map((entry) => [
        entry.status,
        entry.body,
        entry.author.role,
        entry.author.mine,
      ]),
      [
        ["IN_PROGRESS", null, "ADMIN", false],
        [null, "Which language do you expect?", "ADMIN", false],
        [null, "English, please", "USER", true],
        ["RESOLVED", "Replaced the file in Sportarr", "ADMIN", false],
      ],
    );
    assert.ok(detail.timeline.every((entry) => entry.author.email === null));
    assert.equal((await issues.detail(report.id, admin)).timeline[2].author.email, alice.email);

    // The reporter reopens it, then closes it once it is fixed.
    detail = await issues.changeStatus(
      report.id,
      { status: "OPEN", comment: "Still Portuguese" },
      alice,
    );
    assert.equal(detail.status, "OPEN");
    assert.equal(detail.resolvedAt, null);
    detail = await issues.changeStatus(report.id, { status: "CLOSED" }, alice);
    assert.equal(detail.status, "CLOSED");
    await assert.rejects(
      issues.changeStatus(report.id, { status: "CLOSED" }, alice),
      code("ISSUE_STATUS_NOT_ALLOWED"),
    );

    // Updates notify the other side of the conversation.
    const updates = await db.outboxEvent.findMany({ where: { type: "issue.updated" } });
    assert.deepEqual(
      updates.map((item) => `${item.payload.status}:${item.payload.audience}`).sort(),
      [
        "CLOSED:admins",
        "COMMENT:admins",
        "COMMENT:reporter",
        "IN_PROGRESS:reporter",
        "OPEN:admins",
        "RESOLVED:reporter",
      ],
    );

    // A finished duplicate no longer blocks a new report; deleting the request removes issues.
    await issues.create(
      request.id,
      { category: "LANGUAGE", description: "Back again", eventId: event.id, part: "Main Card" },
      alice,
    );
    await db.request.delete({ where: { id: request.id } });
    assert.equal(await db.issue.count(), 0);
    assert.equal(await db.issueComment.count(), 0);
    console.log(
      "Issues integration passed: follower-only reporting, private visibility, duplicate detection, lifecycle rules, anonymous administrator replies, notifications outbox and cascade.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Issues integration test failed:", error);
  process.exitCode = 1;
});
