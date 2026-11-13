const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { ServiceUnavailableException } = require("@nestjs/common");
const { Availability } = require("../dist/requests/availability");
const { RequestsService } = require("../dist/requests/service");
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
const league = { id: "league", name: "League", shortId: "lg-100", sportName: "Soccer" };
const event = {
  id: "event",
  name: "Game",
  shortId: "ev-100",
  leagueId: "league",
  seasonId: "season",
  status: "completed",
};
const config = { url: "http://sportarr", apiKey: "fixture", rootFolderId: 1, qualityProfileId: 2 };
const settings = { configuration: async () => config };
const remote = {
  id: 10,
  externalId: "ev-100",
  leagueId: 8,
  title: "Game",
  hasFile: true,
  monitored: false,
  files: [{ exists: true }],
};
function upstream(records = [remote]) {
  global.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    if (url.endsWith("/leagues")) {
      return Response.json([
        { id: 8, externalId: "lg-100", name: "League", sport: "Soccer", monitored: false },
      ]);
    }
    assert.ok(url.includes("/leagues/8/events?showAll=true"));
    return Response.json({ page: 1, totalPages: 1, totalRecords: records.length, records });
  };
}
test("pre-existing imported events are recognized without remote writes", async () => {
  upstream();
  assert.deepEqual(await new Availability({}, settings).check({ kind: "event", league, event }), {
    state: "available",
  });
});
test("partial multipart imports do not count as available", async () => {
  upstream([{ ...remote, hasFile: false }]);
  assert.deepEqual(await new Availability({}, settings).check({ kind: "event", league, event }), {
    state: "missing",
  });
});
test("identity mismatch and unreachable managers are never reported as available", async () => {
  upstream([{ ...remote, externalId: "ev-999" }]);
  assert.deepEqual(await new Availability({}, settings).check({ kind: "event", league, event }), {
    state: "missing",
  });
  global.fetch = async () => {
    throw new Error("Network secret");
  };
  assert.deepEqual(await new Availability({}, settings).check({ kind: "event", league, event }), {
    state: "unknown",
    reason: "unreachable",
  });
});
test("unconfigured installations explicitly report unknown availability", async () => {
  const availability = new Availability(
    {},
    {
      configuration: async () => {
        throw new ServiceUnavailableException({ code: "SPORTARR_NOT_CONFIGURED" });
      },
    },
  );
  assert.deepEqual(await availability.check({ kind: "event", league, event }), {
    state: "unknown",
    reason: "not_configured",
  });
});
test("closed-season availability requires every scoped event and complete metadata pagination", async () => {
  const season = {
    id: "season",
    name: "2020",
    leagueId: "league",
    isCurrent: false,
    endDate: "2020-12-31",
  };
  const metadata = {
    events: async ({ page }) => ({
      items: [{ ...event, id: "event-" + page, shortId: "ev-" + page }],
      total: 2,
      page,
      totalPages: 2,
    }),
  };
  upstream([
    { ...remote, externalId: "ev-1", id: 1 },
    { ...remote, externalId: "ev-2", id: 2 },
  ]);
  assert.deepEqual(
    await new Availability(metadata, settings).check({ kind: "season", league, season }),
    { state: "available" },
  );
  upstream([{ ...remote, externalId: "ev-1", id: 1 }]);
  assert.deepEqual(
    await new Availability(metadata, settings).check({ kind: "season", league, season }),
    { state: "missing" },
  );
  metadata.events = async ({ page }) => ({ items: [event], total: 2, page, totalPages: 1 });
  assert.deepEqual(
    await new Availability(metadata, settings).check({ kind: "season", league, season }),
    { state: "unknown", reason: "incomplete" },
  );
});
test("an open season remains requestable even if its aired games are available", async () => {
  upstream();
  const metadata = {
    events: async () => assert.fail("Open season must not be treated as complete"),
  };
  assert.deepEqual(
    await new Availability(metadata, settings).check({
      kind: "season",
      league,
      season: {
        id: "season",
        name: "2026",
        leagueId: "league",
        isCurrent: true,
        endDate: "2020-12-31",
      },
    }),
    { state: "missing" },
  );
});
test("request submission returns existing availability without creating records or work", async () => {
  const db = {
    request: { findFirst: async () => null },
    $transaction: async () => assert.fail("Available content must not create a request"),
  };
  const metadata = { event: async () => event, league: async () => league };
  const service = new RequestsService({ db }, metadata, {
    check: async () => ({ state: "available" }),
  });
  assert.deepEqual(await service.create({ kind: "event", identifier: "event" }, { id: "user" }), {
    created: false,
    available: true,
    request: null,
  });
});
test("request submission fails closed when configured availability cannot be checked", async () => {
  const db = {
    request: { findFirst: async () => null },
    $transaction: async () => assert.fail("Unknown content must not create a request"),
  };
  const metadata = { event: async () => event, league: async () => league };
  const service = new RequestsService({ db }, metadata, {
    check: async () => ({ state: "unknown", reason: "unreachable" }),
  });
  await assert.rejects(
    service.create({ kind: "event", identifier: "event" }, { id: "user" }),
    (error) => error.getResponse().code === "AVAILABILITY_UNKNOWN",
  );
});

// Parts are offered only when Sportarr knows the event's real parts.
const card = [
  { name: "Full Event", partNumber: 0 },
  { name: "Early Prelims", partNumber: 1 },
  { name: "Prelims", partNumber: 2 },
  { name: "Main Card", partNumber: 3 },
  { name: "Post Show", partNumber: 4 },
];
const fightNight = card.filter((part) => ![1, 4].includes(part.partNumber));
function sportarrWithParts({ events, parts, leagues, multiPart = true, calls = [] }) {
  global.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push(path);
    if (path.endsWith("/config")) {
      return Response.json({ enableMultiPartEpisodes: multiPart });
    }
    if (path.endsWith("/leagues")) {
      return Response.json(
        leagues ?? [
          { id: 8, externalId: "lg-200", name: "UFC", sport: "Combat", monitored: false },
        ],
      );
    }
    if (path.includes("/leagues/8/events?showAll=true")) {
      return Response.json({
        page: 1,
        totalPages: 1,
        totalRecords: events.length,
        records: events,
      });
    }
    const match = path.match(/\/event\/(\d+)\/parts$/);
    if (match) {
      return Response.json({ parts: parts[match[1]] ?? [{ name: "Full Event", partNumber: 0 }] });
    }
    if (path.endsWith("/queue")) {
      return Response.json([]);
    }
    assert.fail("Unexpected Sportarr call " + path);
  };
  return calls;
}
const ufc = { id: "ufc", name: "UFC", shortId: "lg-200", sportName: "Combat" };
const stored = (id, shortId, extra = {}) => ({
  id,
  externalId: shortId,
  leagueId: 8,
  title: shortId,
  hasFile: false,
  monitored: false,
  files: [],
  ...extra,
});
const eventTarget = (shortId) => ({
  kind: "event",
  league: ufc,
  event: { id: shortId, shortId, leagueId: "ufc", name: shortId },
});

test("an event Sportarr does not hold yet is requested whole, never with guessed parts", async () => {
  const calls = sportarrWithParts({ events: [stored(1, "ev-other")], parts: {} });
  const availability = new Availability({}, settings);
  assert.deepEqual(await availability.parts(eventTarget("ev-new")), { supported: false });
  assert.ok(!calls.some((call) => call.includes("library/parts")));
  sportarrWithParts({ events: [], parts: {}, leagues: [] });
  assert.deepEqual(await availability.parts(eventTarget("ev-new")), { supported: false });
});

test("only the parts Sportarr defines for the event are offered", async () => {
  sportarrWithParts({
    events: [stored(1, "ev-ppv"), stored(2, "ev-fight-night"), stored(3, "ev-weekly")],
    parts: { 1: card, 2: fightNight },
  });
  const availability = new Availability({}, settings);
  const ppv = await availability.parts(eventTarget("ev-ppv"));
  assert.deepEqual(
    ppv.parts.map((part) => part.name),
    ["Early Prelims", "Prelims", "Main Card", "Post Show"],
  );
  assert.deepEqual(ppv.defaults, ["Early Prelims", "Prelims", "Main Card"]);
  const night = await availability.parts(eventTarget("ev-fight-night"));
  assert.deepEqual(
    night.parts.map((part) => part.name),
    ["Prelims", "Main Card"],
  );
  // Weekly wrestling and similar events have no parts: no dialog.
  assert.deepEqual(await availability.parts(eventTarget("ev-weekly")), { supported: false });
  sportarrWithParts({ events: [stored(1, "ev-ppv")], parts: { 1: card }, multiPart: false });
  assert.deepEqual(await availability.parts(eventTarget("ev-ppv")), { supported: false });
});

test("a season offers the parts its events have in Sportarr", async () => {
  sportarrWithParts({
    events: [
      stored(1, "ev-ppv"),
      stored(2, "ev-fight-night"),
      stored(3, "ev-other-season"),
      stored(4, "ev-whole", { monitoredParts: "Full Event" }),
    ],
    parts: { 1: fightNight, 2: fightNight, 3: card, 4: card },
    leagues: [
      {
        id: 8,
        externalId: "lg-200",
        name: "UFC",
        sport: "Combat",
        monitored: false,
        monitoredParts: "Prelims,Main Card",
      },
    ],
  });
  const metadata = {
    events: async ({ season, page }) => ({
      items: ["ev-ppv", "ev-fight-night", "ev-whole"].map((shortId) => ({
        id: shortId,
        shortId,
        leagueId: "ufc",
        seasonId: season,
      })),
      page,
      total: 3,
      totalPages: 1,
    }),
  };
  const availability = new Availability(metadata, settings);
  const season = await availability.parts({
    kind: "season",
    league: ufc,
    season: { id: "2026", name: "2026", leagueId: "ufc" },
  });
  // ev-other-season is outside the season and ev-whole keeps one file, so no Early Prelims.
  assert.deepEqual(
    season.parts.map((part) => part.name),
    ["Prelims", "Main Card"],
  );
  assert.deepEqual(season.defaults, ["Prelims", "Main Card"]);
});
