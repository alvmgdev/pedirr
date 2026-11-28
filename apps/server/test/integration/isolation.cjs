const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { RequestsService } = require("../../dist/requests/service");
const { IssuesService } = require("../../dist/issues/service");
const { CatalogController } = require("../../dist/metadata/controller");
const { CatalogAccess } = require("../../dist/metadata/access");

const code = (expected) => (error) => error.getResponse().code === expected;

async function main() {
  const schema = "test_isolation_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const everything = await db.plan.create({ data: { name: "Everything", allContent: true } });
    const pack = await db.planPackage.create({
      data: { name: "All", plans: { connect: [{ id: everything.id }] } },
    });
    const tenant = (code, name) => db.tenant.create({ data: { code, name, packageId: pack.id } });
    const a = await tenant("k7x2p", "Fight Club TV");
    const b = await tenant("other", "Other Sports");
    const user = (email, role, tenantId, planId) =>
      db.user.create({ data: { email, passwordHash: "unused", role, tenantId, planId } });
    const admin = await user("admin@example.invalid", "ADMIN", "platform");
    const platformFan = await user("fan@example.invalid", "USER", "platform");
    const ownerA = await user("owner@example.invalid", "RESELLER", a.id);
    const clientA = await user("ana@example.invalid", "USER", a.id, everything.id);
    const otherA = await user("alex@example.invalid", "USER", a.id, everything.id);
    const ownerB = await user("owner@example.invalid", "RESELLER", b.id);
    const clientB = await user("bea@example.invalid", "USER", b.id, everything.id);

    const metadata = {
      league: async (id) => ({ id, name: id }),
      event: async (id) => ({ id, name: id, leagueId: "league-1" }),
      season: async (id) => ({ id, name: id, leagueId: id.replace("season", "league") }),
    };
    const requests = new RequestsService({ db }, metadata, {
      check: async () => ({ state: "missing" }),
    });
    const event = (id, viewer) => requests.create({ kind: "event", identifier: id }, viewer);
    const onlyA = (await event("ev-a", clientA)).request;
    const onlyB = (await event("ev-b", clientB)).request;
    // One download shared by both resellers' clients.
    const shared = (await event("ev-shared", clientA)).request;
    await event("ev-shared", clientB);
    const platformOnly = (await event("ev-p", platformFan)).request;

    // Each environment lists the requests its own people follow; the platform administrator all.
    const titles = async (viewer) =>
      (await requests.list(viewer, 1)).items.map((item) => item.entity.title).sort();
    assert.deepEqual(await titles(clientA), ["ev-a", "ev-shared"]);
    assert.deepEqual(await titles(otherA), ["ev-a", "ev-shared"]);
    assert.deepEqual(await titles(ownerA), ["ev-a", "ev-shared"]);
    assert.deepEqual(await titles(clientB), ["ev-b", "ev-shared"]);
    assert.deepEqual(await titles(platformFan), ["ev-p"]);
    assert.deepEqual(await titles(admin), ["ev-a", "ev-b", "ev-p", "ev-shared"]);
    assert.equal((await requests.list(clientA, 1)).total, 2);
    // Follower counts never include other environments' people.
    const count = async (viewer) =>
      (await requests.list(viewer, 1)).items.find((item) => item.id === shared.id)._count
        .subscribers;
    assert.equal(await count(clientA), 1);
    assert.equal(await count(admin), 2);

    // Cards say who asked first and when, among the followers each viewer may see.
    await db.requestSubscriber.update({
      where: { requestId_userId: { requestId: shared.id, userId: clientA.id } },
      data: { createdAt: new Date(Date.now() - 3600000) },
    });
    const beaJoined = (
      await db.requestSubscriber.findUniqueOrThrow({
        where: { requestId_userId: { requestId: shared.id, userId: clientB.id } },
      })
    ).createdAt;
    const card = async (viewer, environment) =>
      (await requests.list(viewer, 1, undefined, false, environment)).items.find(
        (item) => item.id === shared.id,
      );
    const asPlatform = (await card(admin)).requestedBy;
    assert.equal(asPlatform.email, "ana@example.invalid");
    assert.deepEqual(asPlatform.environment, { code: "k7x2p", name: "Fight Club TV" });
    assert.equal(asPlatform.others, 1);
    // Reseller B sees its own client and the date she asked: nothing hints that A was first.
    assert.deepEqual((await card(ownerB)).requestedBy, {
      at: beaJoined,
      email: "bea@example.invalid",
      environment: null,
      others: 0,
    });
    // Users get only the date, never who or how many.
    assert.deepEqual((await card(clientB)).requestedBy, {
      at: beaJoined,
      email: null,
      environment: null,
      others: 0,
    });
    // The platform administrator may choose an environment; the cards follow it.
    const chosen = async (environment) =>
      (await requests.list(admin, 1, undefined, false, environment)).items
        .map((item) => item.entity.title)
        .sort();
    assert.deepEqual(await chosen(b.id), ["ev-b", "ev-shared"]);
    assert.deepEqual(await chosen("platform"), ["ev-p"]);
    const inB = (await card(admin, b.id)).requestedBy;
    assert.deepEqual(
      [inB.email, inB.environment.name, inB.others],
      ["bea@example.invalid", "Other Sports", 0],
    );
    // Anyone else asking for another environment is ignored and keeps seeing their own.
    assert.deepEqual(
      (await requests.list(ownerA, 1, undefined, false, b.id)).items
        .map((item) => item.entity.title)
        .sort(),
      ["ev-a", "ev-shared"],
    );
    assert.equal((await card(ownerA, b.id)).requestedBy.email, "ana@example.invalid");
    assert.equal((await card(ownerA, b.id))._count.subscribers, 1);

    // Another environment's request does not exist for them; a shared one shows only their own.
    for (const [id, viewer] of [
      [onlyB.id, clientA],
      [onlyB.id, ownerA],
      [onlyA.id, clientB],
      [platformOnly.id, clientA],
      [onlyA.id, platformFan],
    ]) {
      await assert.rejects(requests.detail(id, viewer), code("REQUEST_NOT_FOUND"));
    }
    const asOwner = await requests.detail(shared.id, ownerA);
    assert.deepEqual(
      asOwner.subscribers.map((item) => item.email),
      ["ana@example.invalid"],
    );
    assert.equal(asOwner._count.subscribers, 1);
    assert.equal((await requests.detail(shared.id, clientA)).subscribers, null);
    // The platform administrator sees each follower's environment; a reseller only its own.
    assert.deepEqual(
      (await requests.detail(shared.id, admin)).subscribers
        .map((item) => [item.email, item.environment.name])
        .sort(),
      [
        ["ana@example.invalid", "Fight Club TV"],
        ["bea@example.invalid", "Other Sports"],
      ],
    );
    assert.equal(asOwner.subscribers[0].environment, null);
    // Users see when they asked, but never how many others follow.
    const asAna = await requests.detail(shared.id, clientA);
    assert.equal(asAna._count.subscribers, 1);
    assert.ok(asAna.subscription.createdAt instanceof Date);
    const asAlex = await requests.detail(shared.id, otherA);
    assert.deepEqual([asAlex._count.subscribers, asAlex.subscription], [0, null]);
    assert.equal(
      (await requests.list(otherA, 1)).items.find((item) => item.id === shared.id)._count
        .subscribers,
      0,
    );
    // The history names nobody: no actor, email or environment reaches any viewer.
    for (const viewer of [clientB, ownerB]) {
      for (const entry of (await requests.detail(shared.id, viewer)).history) {
        assert.deepEqual(Object.keys(entry).sort(), ["action", "createdAt", "details", "id"]);
        assert.doesNotMatch(JSON.stringify(entry), /@|Fight Club|k7x2p/);
      }
    }
    assert.deepEqual(
      (await requests.detail(shared.id, admin)).subscribers.map((item) => item.email).sort(),
      ["ana@example.invalid", "bea@example.invalid"],
    );

    // Looking up content another environment requested shows its state but does not open it.
    const lookup = (id, viewer) => requests.lookup({ kind: "event", identifier: id }, viewer);
    assert.deepEqual(await lookup("ev-b", otherA), {
      state: "requested",
      request: { id: onlyB.id, status: onlyB.status },
      subscribed: false,
      visible: false,
    });
    assert.equal((await lookup("ev-a", otherA)).visible, true);
    // Following it makes it theirs too.
    await event("ev-b", otherA);
    assert.equal((await requests.detail(onlyB.id, otherA)).subscribers, null);
    assert.equal((await requests.detail(onlyB.id, ownerA))._count.subscribers, 1);

    // Popular leagues count only requests of the viewer's environment.
    await requests.create({ kind: "season", identifier: "season-a" }, ownerA);
    await requests.create({ kind: "season", identifier: "season-b" }, ownerB);
    const access = new CatalogAccess({ db }, metadata);
    const catalog = new CatalogController(metadata, { rate: async () => {} }, { db }, access, {});
    const popular = async (viewer) =>
      (await catalog.popular({ viewer })).items.map((item) => item.title).sort();
    assert.deepEqual(await popular(clientA), ["league-a"]);
    assert.deepEqual(await popular(clientB), ["league-b"]);
    assert.deepEqual(await popular(platformFan), []);
    assert.deepEqual(await popular(admin), ["league-a", "league-b"]);

    // Issues: a reseller's administrator reads its clients' issues, never another reseller's.
    const issues = new IssuesService({ db });
    const report = (requestId, viewer) =>
      issues.create(requestId, { category: "QUALITY", description: "Blurry" }, viewer);
    const issueA = await report(onlyA.id, clientA);
    const issueB = await report(onlyB.id, clientB);
    const listed = async (viewer) => (await issues.list(viewer, { page: 1 })).items;
    const ownerView = await listed(ownerA);
    assert.deepEqual(
      ownerView.map((item) => [item.id, item.reporter.email]),
      [[issueA.id, "ana@example.invalid"]],
    );
    assert.deepEqual(
      (await listed(clientB)).map((item) => item.id),
      [issueB.id],
    );
    assert.equal((await listed(admin)).length, 2);
    await assert.rejects(issues.detail(issueB.id, ownerA), code("ISSUE_NOT_FOUND"));
    await assert.rejects(issues.detail(issueA.id, otherA), code("ISSUE_NOT_FOUND"));
    assert.equal((await issues.open(ownerA)).open, 1);
    assert.equal((await issues.open(ownerB)).open, 1);
    // Read only: it cannot comment or change the status of its clients' issues.
    await assert.rejects(issues.comment(issueA.id, "Looking", ownerA));
    await assert.rejects(issues.changeStatus(issueA.id, { status: "CLOSED" }, ownerA));
    // It sees its client's name in the timeline, never the platform administrator's.
    await issues.comment(issueA.id, "Which part?", admin);
    await issues.comment(issueA.id, "The main card", clientA);
    const timeline = (await issues.detail(issueA.id, ownerA)).timeline;
    assert.deepEqual(
      timeline.map((item) => [item.author.role, item.author.email]),
      [
        ["ADMIN", null],
        ["USER", "ana@example.invalid"],
      ],
    );
    console.log(
      "Isolation integration passed: request lists, follower counts, details and subscriber lists per environment, lookups of other environments' requests, following them, popular leagues, and read-only reseller access to its clients' issues.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Isolation integration test failed:", error);
  process.exitCode = 1;
});
