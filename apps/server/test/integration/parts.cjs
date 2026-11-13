const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { RequestsService } = require("../../dist/requests/service");
const { Fulfillment } = require("../../dist/jobs/fulfillment");
const { heldParts, queuedParts, selectableParts } = require("../../dist/requests/parts");

// Requests with event parts against real PostgreSQL and a stateful fake Sportarr.
async function main() {
  const schema = "test_parts_" + randomUUID().replaceAll("-", "");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url.href },
      stdio: "ignore",
    });
    const user = (email, extra = {}) =>
      db.user.create({ data: { email, passwordHash: "unused", ...extra } });
    const admin = await user("admin@example.invalid", { role: "ADMIN" });
    const alice = await user("alice@example.invalid", { autoApprove: true });
    const bob = await user("bob@example.invalid", { autoApprove: false });
    const carol = await user("carol@example.invalid", { autoApprove: false });

    const league = { id: "league", shortId: "lg-200", name: "UFC", sportName: "Combat" };
    const hubEvent = (id, shortId) => ({
      id,
      shortId,
      name: "UFC " + shortId,
      leagueId: league.id,
      scheduledStart: "2020-01-01T12:00:00Z",
      status: "completed",
    });
    const hubEvents = {
      card: hubEvent("card", "ev-200"),
      managed: hubEvent("managed", "ev-300"),
      whole: hubEvent("whole", "ev-400"),
    };
    const definitions = [
      { name: "Full Event", number: 0 },
      { name: "Early Prelims", number: 1 },
      { name: "Prelims", number: 2 },
      { name: "Main Card", number: 3 },
      { name: "Post Show", number: 4 },
    ];
    // Sportarr library: ev-300 and ev-400 are managed by hand before Pedirr sees them.
    const stored = new Map([
      [
        "ev-300",
        {
          id: 30,
          externalId: "ev-300",
          leagueId: 8,
          title: "managed",
          monitored: true,
          hasFile: false,
          monitoredParts: null,
          files: [],
        },
      ],
      [
        "ev-400",
        {
          id: 40,
          externalId: "ev-400",
          leagueId: 8,
          title: "whole",
          monitored: true,
          hasFile: false,
          monitoredParts: "Full Event",
          files: [],
        },
      ],
    ]);
    const queue = [];
    const partWrites = [];
    const searches = [];
    const byId = (id) => [...stored.values()].find((item) => item.id === id);
    const manager = {
      assertWriteCompatibility: async () => {},
      ensureLeague: async () => ({ id: 8, monitoredParts: null }),
      events: async () => [...stored.values()].map((item) => ({ ...item })),
      queue: async () => queue.map((item) => ({ ...item })),
      multiPartEnabled: async () => true,
      ensureEvent: async (input) => {
        if (!stored.has(input.externalId)) {
          stored.set(input.externalId, {
            id: 20,
            externalId: input.externalId,
            leagueId: 8,
            title: input.title,
            monitored: true,
            hasFile: false,
            monitoredParts: null,
            files: [],
          });
        }
        return { ...stored.get(input.externalId) };
      },
      parts: async () => definitions,
      setMonitoredParts: async (id, parts) => {
        partWrites.push({ id, parts });
        byId(id).monitoredParts = parts;
        return { ...byId(id) };
      },
      search: async (id, part) => searches.push(part ? `${id}:${part}` : `${id}`),
    };
    const metadata = {
      league: async () => league,
      event: async (id) => hubEvents[id],
    };
    // Part choices as the real availability service derives them from the fake library.
    const availability = {
      check: async () => ({ state: "missing" }),
      parts: async (target) => {
        const event = stored.get(target.event.shortId);
        const parts = selectableParts(definitions);
        if (event?.monitoredParts === "Full Event") {
          return { supported: false };
        }
        const defaults = ["Early Prelims", "Prelims", "Main Card"];
        return event
          ? {
              supported: true,
              parts,
              defaults,
              held: heldParts(event, parts),
              queued: queuedParts(queue.filter((item) => item.eventId === event.id)),
            }
          : { supported: true, parts, defaults };
      },
    };
    const requests = new RequestsService({ db }, metadata, availability);
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
    const worker = new Fulfillment(
      { db, redis },
      metadata,
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
    const statusOf = async (requestId, person) =>
      (
        await db.requestSubscriber.findUnique({
          where: { requestId_userId: { requestId, userId: person.id } },
        })
      ).status;
    const reload = (id) => db.request.findUnique({ where: { id }, include: { parts: true } });

    // Alice (auto-approved) asks for the Main Card only.
    const first = await requests.create(
      { kind: "event", identifier: "card", parts: ["main card"] },
      alice,
    );
    assert.equal(first.created, true);
    const id = first.request.id;
    assert.deepEqual(
      first.request.parts.map((part) => [part.name, part.status]),
      [["Main Card", "APPROVED"]],
    );
    await assert.rejects(
      requests.create({ kind: "event", identifier: "card", parts: ["Countdown"] }, alice),
      (error) => error.getResponse().code === "INVALID_PARTS",
    );
    await assert.rejects(
      requests.create({ kind: "event", identifier: "card" }, carol),
      (error) => error.getResponse().code === "PARTS_REQUIRED",
    );

    // Pedirr created the event, so it monitors exactly the requested part and searches it alone.
    await worker.run(id);
    assert.deepEqual(partWrites, [{ id: 20, parts: "Main Card" }]);
    assert.deepEqual(searches, ["20:Main Card"]);
    const synced = await db.requestEvent.findFirst({ where: { requestId: id } });
    assert.deepEqual(synced.parts, ["Early Prelims", "Prelims", "Main Card", "Post Show"]);
    assert.equal(await statusOf(id, alice), "APPROVED");

    // Bob (manual review) joins the Main Card and adds the Prelims, which wait for review.
    await requests.create(
      { kind: "event", identifier: "card", parts: ["Main Card", "Prelims"] },
      bob,
    );
    let request = await reload(id);
    assert.equal(request.status, "APPROVED");
    assert.deepEqual(request.parts.map((part) => [part.name, part.status]).sort(), [
      ["Main Card", "APPROVED"],
      ["Prelims", "PENDING"],
    ]);
    assert.equal(await statusOf(id, bob), "PENDING");
    assert.equal(await statusOf(id, alice), "APPROVED");
    const review = await db.outboxEvent.findFirst({
      where: { type: "request.created", payload: { path: ["userIds"], array_contains: [bob.id] } },
    });
    assert.ok(review, "administrators are asked to review only the new parts");
    const ids = (page) => page.items.map((item) => item.id);
    assert.deepEqual(ids(await requests.list(admin, 1, "PENDING")), [id]);
    assert.deepEqual(ids(await requests.list(bob, 1, "PENDING", true)), [id]);
    assert.deepEqual(ids(await requests.list(alice, 1, "PENDING", true)), []);

    // The Main Card arrives: Alice is done while Bob's Prelims still wait.
    byId(20).files = [{ exists: true, partNumber: 3, partName: "Main Card" }];
    await worker.run(id);
    assert.equal((await reload(id)).status, "AVAILABLE");
    assert.equal(await statusOf(id, alice), "AVAILABLE");
    assert.equal(await statusOf(id, bob), "PENDING");
    const aliceNotice = await db.outboxEvent.findFirst({
      where: { type: "request.status", payload: { path: ["status"], equals: "AVAILABLE" } },
    });
    assert.deepEqual(aliceNotice.payload.userIds, [alice.id]);

    // The dialog shows each part's state and Sportarr's defaults, never who asked for it.
    const options = await requests.partOptions({ kind: "event", identifier: "card" }, carol);
    assert.equal(options.supported, true);
    assert.deepEqual(
      options.parts.map(({ name, optional, selected, state }) => [name, optional, selected, state]),
      [
        ["Early Prelims", false, true, "none"],
        ["Prelims", false, true, "requested"],
        ["Main Card", false, true, "available"],
        ["Post Show", true, false, "none"],
      ],
    );
    for (const person of [alice, bob]) {
      assert.ok(!JSON.stringify(options).includes(person.id));
      assert.ok(!JSON.stringify(options).includes(person.email));
    }
    assert.deepEqual(await requests.partOptions({ kind: "event", identifier: "whole" }, carol), {
      supported: false,
      parts: [],
    });

    // Approving the Prelims reopens the request without moving Alice backwards.
    request = await reload(id);
    await requests.moderate(id, { decision: "approve", version: request.version }, admin);
    assert.equal((await reload(id)).status, "APPROVED");
    assert.equal(await statusOf(id, alice), "AVAILABLE");
    assert.equal(await statusOf(id, bob), "APPROVED");
    await worker.run(id);
    assert.deepEqual(partWrites.at(-1), { id: 20, parts: "Prelims,Main Card" });
    assert.deepEqual(searches.slice(1), ["20:Prelims"]);
    assert.equal(await statusOf(id, alice), "AVAILABLE");
    queue.push({ eventId: 20, status: "Downloading", progress: 40, part: "Prelims" });
    await worker.run(id);
    assert.equal(await statusOf(id, bob), "DOWNLOADING");
    assert.equal(await statusOf(id, alice), "AVAILABLE");
    queue.length = 0;
    byId(20).files.push({ exists: true, partNumber: 2, partName: "Prelims" });
    await worker.run(id);
    assert.equal(await statusOf(id, bob), "AVAILABLE");
    assert.equal((await reload(id)).status, "AVAILABLE");

    // A rejected part asked for again returns to review; others keep their state.
    await requests.create({ kind: "event", identifier: "card", parts: ["Early Prelims"] }, carol);
    request = await reload(id);
    await requests.moderate(
      id,
      { decision: "reject", version: request.version, reason: "Not released" },
      admin,
    );
    request = await reload(id);
    assert.equal(request.parts.find((part) => part.name === "Early Prelims").status, "REJECTED");
    assert.equal(request.status, "AVAILABLE");
    assert.equal(await statusOf(id, carol), "REJECTED");
    await requests.create({ kind: "event", identifier: "card", parts: ["Early Prelims"] }, carol);
    request = await reload(id);
    assert.equal(request.parts.find((part) => part.name === "Early Prelims").status, "PENDING");
    assert.equal(await statusOf(id, carol), "PENDING");
    assert.equal(await statusOf(id, alice), "AVAILABLE");

    // Every part already on disk: nothing to request.
    const done = await requests.create(
      { kind: "event", identifier: "card", parts: ["Main Card"] },
      admin,
    );
    assert.deepEqual(done, { created: false, available: true, request: null });

    // An event managed by hand monitors every part (null): Pedirr adds nothing to it.
    const managed = await requests.create(
      { kind: "event", identifier: "managed", parts: ["Prelims"] },
      alice,
    );
    const writesBefore = partWrites.length;
    await worker.run(managed.request.id);
    assert.equal(partWrites.length, writesBefore);
    assert.ok(searches.includes("30:Prelims"));

    // A "Full Event" event offers no parts and is never split.
    await assert.rejects(
      requests.create({ kind: "event", identifier: "whole", parts: ["Main Card"] }, alice),
      (error) => error.getResponse().code === "PARTS_NOT_SUPPORTED",
    );
    const whole = await requests.create({ kind: "event", identifier: "whole" }, alice);
    assert.equal(whole.request.parts.length, 0);
    await worker.run(whole.request.id);
    assert.equal(partWrites.length, writesBefore);
    assert.ok(searches.includes("40"));
    // Requests without parts keep one request-level status for every subscriber.
    await requests.create({ kind: "event", identifier: "whole" }, bob);
    assert.equal(await statusOf(whole.request.id, bob), "APPROVED");

    console.log(
      "Parts integration passed: per-user part status, add-only monitoring, per-part search, part review and re-review, pending-part moderation queue, Full Event and whole-event compatibility.",
    );
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error("Parts integration test failed:", error);
  process.exitCode = 1;
});
