const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { SportarrClient, managerUrl } = require("../dist/managers/sportarr");
const { SecretBox } = require("../dist/settings/secrets");
const { SportarrSettings } = require("../dist/settings/sportarr");
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
const config = {
  url: "http://sportarr:8989/sports",
  apiKey: "private-test-key",
  rootFolderId: 1,
  qualityProfileId: 2,
};
const entry = (id) => ({
  id,
  externalId: `ev-${id}`,
  title: "Game",
  monitored: true,
  hasFile: false,
  files: [],
});
test("Sportarr connection preserves URL base and sends credentials only as a header", async () => {
  const paths = [];
  global.fetch = async (url, init) => {
    assert.equal(init.headers["X-Api-Key"], config.apiKey);
    assert.equal(init.redirect, "error");
    assert.ok(!url.includes(config.apiKey));
    const path = new URL(url).pathname;
    paths.push(path);
    assert.ok(path.startsWith("/sports/api/"));
    if (path.endsWith("system/status")) {
      return Response.json({ appName: "Sportarr", version: "4.1.0.1110" });
    }
    if (path.endsWith("leagues")) {
      return Response.json([]);
    }
    if (path.endsWith("rootfolder")) {
      return Response.json([{ id: 1, path: "/sports" }]);
    }
    if (path.endsWith("qualityprofile")) {
      return Response.json([{ id: 2, name: "HD" }]);
    }
    assert.fail("Unexpected endpoint");
  };
  const result = await new SportarrClient(config).testConnection();
  assert.equal(result.version, "4.1.0.1110");
  assert.equal(paths.length, 4);
  assert.equal(result.apiKey, undefined);
});
test("the client rejects another application and redacts upstream failures", async () => {
  const client = new SportarrClient(config);
  global.fetch = async () => Response.json({ appName: "Sonarr", version: "4" });
  await assert.rejects(
    client.testConnection(),
    (error) => error.getResponse().code === "SPORTARR_INVALID_RESPONSE",
  );
  global.fetch = async () =>
    new Response("Do not expose upstream body: " + config.apiKey, { status: 401 });
  await assert.rejects(
    client.leagues(),
    (error) =>
      error.getResponse().code === "SPORTARR_AUTH_FAILED" &&
      !JSON.stringify(error.getResponse()).includes(config.apiKey),
  );
  global.fetch = async () => {
    throw new Error(config.apiKey);
  };
  await assert.rejects(
    client.leagues(),
    (error) =>
      error.getResponse().code === "SPORTARR_UNREACHABLE" && !error.message.includes(config.apiKey),
  );
});
test("event reconciliation consumes every unfiltered page", async () => {
  const seen = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("showAll"), "true");
    const page = Number(parsed.searchParams.get("page"));
    seen.push(page);
    return Response.json({ page, totalPages: 2, totalRecords: 2, records: [entry(page)] });
  };
  const result = await new SportarrClient(config).events(10);
  assert.deepEqual(
    result.map((row) => row.id),
    [1, 2],
  );
  assert.deepEqual(seen, [1, 2]);
});
test("a failed or inconsistent page never returns a partial event list", async () => {
  global.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json({ page, totalPages: 2, totalRecords: 2, records: [entry(1)] });
  };
  await assert.rejects(
    new SportarrClient(config).events(10),
    (error) => error.getResponse().code === "SPORTARR_INVALID_RESPONSE",
  );
  global.fetch = async (url) =>
    new URL(url).searchParams.get("page") === "1"
      ? Response.json({ page: 1, totalPages: 2, totalRecords: 2, records: [entry(1)] })
      : new Response("", { status: 500 });
  await assert.rejects(
    new SportarrClient(config).events(10),
    (error) => error.getResponse().code === "SPORTARR_HTTP_ERROR",
  );
});
test("URLs reject credential/query tricks while allowing private network installations", () => {
  assert.equal(
    managerUrl("http://192.168.1.10:8989/sportarr/"),
    "http://192.168.1.10:8989/sportarr",
  );
  for (const url of [
    "file:///etc/passwd",
    "http://key:secret@localhost",
    "http://localhost?apikey=secret",
    "http://localhost/#token",
  ]) {
    assert.throws(() => managerUrl(url));
  }
});
test("encrypted settings authenticate the key, context and ciphertext", () => {
  const box = new SecretBox("ab".repeat(32));
  const first = box.encrypt("secret-value", "sportarr.apiKey");
  const second = box.encrypt("secret-value", "sportarr.apiKey");
  assert.notEqual(first, second);
  assert.ok(!first.includes("secret-value"));
  assert.equal(box.decrypt(first, "sportarr.apiKey"), "secret-value");
  assert.throws(() => box.decrypt(first, "smtp.password"));
  assert.throws(() => new SecretBox("cd".repeat(32)).decrypt(first, "sportarr.apiKey"));
  const parts = first.split(".");
  const data = Buffer.from(parts[3], "base64");
  data[0] ^= 1;
  parts[3] = data.toString("base64");
  assert.throws(() => box.decrypt(parts.join("."), "sportarr.apiKey"));
});
test("settings persist ciphertext, return no key and cannot reuse it for a different host", async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = "ab".repeat(32);
  let stored;
  const settings = new SportarrSettings({
    db: {
      setting: {
        findUnique: async () => (stored ? { value: stored } : null),
        upsert: async ({ create }) => {
          stored = create.value;
        },
      },
    },
  });
  global.fetch = async (url) => {
    if (url.endsWith("system/status")) {
      return Response.json({ appName: "Sportarr", version: "4.1" });
    }
    if (url.endsWith("leagues")) {
      return Response.json([]);
    }
    if (url.endsWith("rootfolder")) {
      return Response.json([{ id: 1, path: "/sports" }]);
    }
    return Response.json([{ id: 2, name: "HD" }]);
  };
  const result = await settings.save(config);
  assert.equal(result.hasApiKey, true);
  assert.ok(!JSON.stringify(result).includes(config.apiKey));
  assert.ok(!JSON.stringify(stored).includes(config.apiKey));
  assert.equal((await settings.configuration()).apiKey, config.apiKey);
  assert.equal((await settings.credentials({ url: config.url })).apiKey, config.apiKey);
  await assert.rejects(
    settings.credentials({ url: "http://another-host" }),
    (error) => error.getResponse().code === "API_KEY_REQUIRED",
  );
});
test("existing league monitoring and quality settings are never rewritten", async () => {
  const existing = {
    id: 8,
    externalId: "lg-100",
    name: "League",
    sport: "Soccer",
    monitored: true,
    monitorType: "Future",
    qualityProfileId: 9,
    monitoredTeams: [4],
  };
  global.fetch = async (url, init) => {
    assert.equal(init.method, "GET");
    assert.ok(url.endsWith("/leagues"));
    return Response.json([existing]);
  };
  const result = await new SportarrClient(config).ensureLeague({
    externalId: "lg-100",
    name: "League",
    sport: "Soccer",
    rootFolderId: 1,
    qualityProfileId: 2,
  });
  assert.deepEqual(result, existing);
});
test("new league is inert and a partial upstream commit is reconciled before retry", async () => {
  let created = false,
    writes = 0;
  global.fetch = async (url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.monitored, false);
      assert.equal(body.monitorType, "None");
      assert.deepEqual(body.monitoredTeamIds, []);
      writes++;
      created = true;
      return new Response("", { status: 500 });
    }
    return Response.json(
      created
        ? [{ id: 8, externalId: "lg-100", name: "League", sport: "Soccer", monitored: false }]
        : [],
    );
  };
  const client = new SportarrClient(config);
  const input = {
    externalId: "lg-100",
    name: "League",
    sport: "Soccer",
    rootFolderId: 1,
    qualityProfileId: 2,
  };
  assert.equal((await client.ensureLeague(input)).id, 8);
  assert.equal((await client.ensureLeague(input)).id, 8);
  assert.equal(writes, 1);
});
const eventInput = {
  externalId: "ev-1",
  title: "Game",
  sport: "Soccer",
  leagueId: 8,
  eventDate: "2026-11-10T12:00:00Z",
  season: "2026",
  seasonNumber: 2026,
  qualityProfileId: 2,
};
test("existing event monitoring uses only the explicitly requested field", async () => {
  let monitored = false;
  global.fetch = async (url, init) => {
    assert.ok(url.endsWith("/events/1"));
    if (init.method === "PUT") {
      assert.deepEqual(JSON.parse(init.body), { monitored: true });
      monitored = true;
    }
    return Response.json({ ...entry(1), leagueId: 8, monitored, qualityProfileId: 9 });
  };
  const result = await new SportarrClient(config).ensureEvent(eventInput, [
    { ...entry(1), leagueId: 8, monitored: false, qualityProfileId: 9 },
  ]);
  assert.equal(result.monitored, true);
  assert.equal(result.qualityProfileId, 9);
});
test("a title/date duplicate with another external ID is not adopted or monitored", async () => {
  let writes = 0;
  global.fetch = async (url, init) => {
    if (init.method === "POST") {
      writes++;
      return Response.json({ event: { id: 44 }, alreadyAdded: true });
    }
    assert.equal(init.method, "GET");
    return Response.json({ ...entry(44), leagueId: 8, monitored: false });
  };
  await assert.rejects(
    new SportarrClient(config).ensureEvent(eventInput, []),
    (error) => error.getResponse().code === "SPORTARR_IDENTITY_CONFLICT",
  );
  assert.equal(writes, 1);
});
test("an ambiguous event creation is reconciled through the complete league list", async () => {
  let posts = 0;
  global.fetch = async (url, init) => {
    if (init.method === "POST") {
      posts++;
      throw new Error("Connection lost after commit");
    }
    assert.ok(url.includes("/leagues/8/events?showAll=true"));
    return Response.json({
      page: 1,
      totalPages: 1,
      totalRecords: 1,
      records: [{ ...entry(1), leagueId: 8 }],
    });
  };
  assert.equal((await new SportarrClient(config).ensureEvent(eventInput, [])).id, 1);
  assert.equal(posts, 1);
});
test("available events are not rewritten and automatic search uses the native singular route", async () => {
  const client = new SportarrClient(config);
  global.fetch = async () => assert.fail("Available content must not trigger writes");
  await client.ensureEvent(eventInput, [
    { ...entry(1), leagueId: 8, monitored: false, hasFile: true },
  ]);
  global.fetch = async (url, init) => {
    assert.ok(url.endsWith("/api/event/1/automatic-search"));
    assert.equal(init.method, "POST");
    return Response.json({ taskIds: [1] });
  };
  await client.search(1);
});
test("numeric queue enums are normalized using the source-defined order", async () => {
  global.fetch = async () => Response.json([{ eventId: 1, status: 6, progress: 100 }]);
  assert.deepEqual(await new SportarrClient(config).queue(), [
    { eventId: 1, status: "Importing", progress: 100, part: null },
  ]);
});
test("native write compatibility rejects unreviewed minor releases", async () => {
  const client = new SportarrClient(config);
  global.fetch = async () => Response.json({ appName: "Sportarr", version: "4.1.11.0-local" });
  await client.assertWriteCompatibility();
  for (const version of ["4.1.10.0", "4.2.0.0", "5.0.0.0"]) {
    global.fetch = async () => Response.json({ appName: "Sportarr", version });
    await assert.rejects(
      client.assertWriteCompatibility(),
      (error) => error.getResponse().code === "SPORTARR_UNSUPPORTED_VERSION",
    );
  }
});

test("part searches send the part name and parts/queue keep Sportarr's part identity", async () => {
  const bodies = [];
  global.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/event/9/automatic-search")) {
      bodies.push(JSON.parse(init.body));
      return Response.json({ success: true });
    }
    if (path.endsWith("/event/9/parts")) {
      return Response.json({
        parts: [
          { name: "Full Event", partNumber: 0 },
          { name: "Prelims", partNumber: 2 },
        ],
        isFightNightStyle: false,
      });
    }
    if (path.endsWith("/queue")) {
      return Response.json([
        { eventId: 9, status: 1, progress: 10, part: "Prelims" },
        { eventId: 9, status: "Downloading", progress: 20, part: "  " },
        { eventId: 9, status: "Downloading", progress: 30 },
      ]);
    }
    assert.fail("Unexpected endpoint " + path);
  };
  const client = new SportarrClient(config);
  await client.search(9);
  await client.search(9, "Prelims");
  assert.deepEqual(bodies, [{}, { part: "Prelims" }]);
  assert.deepEqual(await client.parts(9), [
    { name: "Full Event", number: 0 },
    { name: "Prelims", number: 2 },
  ]);
  assert.deepEqual(
    (await client.queue()).map((item) => item.part),
    ["Prelims", null, null],
  );
  global.fetch = async () => Response.json({ parts: [{ name: "Prelims", partNumber: -1 }] });
  await assert.rejects(client.parts(9));
});
test("part definitions, the multi-part setting and monitored parts use Sportarr's native API", async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ method: init.method, path: pathname, body: init.body && JSON.parse(init.body) });
    if (pathname.endsWith("/library/parts/Mixed%20Martial%20Arts")) {
      return Response.json({ parts: [{ name: "Main Card", partNumber: 3 }] });
    }
    if (pathname.endsWith("/config")) {
      return Response.json({ enableMultiPartEpisodes: true });
    }
    if (pathname.endsWith("/events/7/parts")) {
      return Response.json({ id: 7 });
    }
    if (pathname.endsWith("/events/7")) {
      return Response.json({ ...entry(7), monitoredParts: "Prelims,Main Card" });
    }
    assert.fail("Unexpected endpoint " + pathname);
  };
  const client = new SportarrClient(config);
  assert.deepEqual(await client.sportParts("Mixed Martial Arts"), [
    { name: "Main Card", number: 3 },
  ]);
  assert.equal(await client.multiPartEnabled(), true);
  assert.equal(
    (await client.setMonitoredParts(7, "Prelims,Main Card")).monitoredParts,
    "Prelims,Main Card",
  );
  assert.deepEqual(
    calls.find((call) => call.method === "PUT"),
    {
      method: "PUT",
      path: "/sports/api/events/7/parts",
      body: { monitoredParts: "Prelims,Main Card" },
    },
  );
  global.fetch = async () => Response.json({ enableMultiPartEpisodes: "yes" });
  await assert.rejects(client.multiPartEnabled());
});
