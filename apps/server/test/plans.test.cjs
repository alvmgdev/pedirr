const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("class-validator");
const { plainToInstance } = require("class-transformer");
const { planAllows, PlanInput } = require("../dist/plans");

const ufc = { id: "league-ufc", sportId: "sport-combat" };

test("without a plan or with every sport, any league is allowed", () => {
  assert.equal(planAllows(null, ufc), true);
  assert.equal(planAllows(undefined, ufc), true);
  assert.equal(planAllows({ allContent: true, grants: [] }, ufc), true);
});

test("a sport grant covers its leagues and a league grant only that league", () => {
  const sport = { allContent: false, grants: [{ kind: "SPORT", hubId: "sport-combat" }] };
  assert.equal(planAllows(sport, ufc), true);
  assert.equal(planAllows(sport, { id: "league-nba", sportId: "sport-basketball" }), false);
  const league = { allContent: false, grants: [{ kind: "LEAGUE", hubId: "league-nba" }] };
  assert.equal(planAllows(league, ufc), false);
  assert.equal(planAllows(league, { id: "league-nba", sportId: "sport-basketball" }), true);
  // A league ID never matches a sport grant, nor the reverse.
  assert.equal(
    planAllows({ allContent: false, grants: [{ kind: "SPORT", hubId: "league-ufc" }] }, ufc),
    false,
  );
  assert.equal(planAllows({ allContent: false, grants: [] }, ufc), false);
  // A league whose sport is unknown is only reachable through a league grant.
  assert.equal(planAllows(sport, { id: "league-x" }), false);
});

test("plan input requires a name and valid grants", async () => {
  const errors = (value) => validate(plainToInstance(PlanInput, value));
  const valid = {
    name: "  Fights ",
    allContent: false,
    grants: [{ kind: "SPORT", hubId: "sp-000001" }],
  };
  assert.equal((await errors(valid)).length, 0);
  assert.equal(plainToInstance(PlanInput, valid).name, "Fights");
  for (const invalid of [
    { ...valid, name: "   " },
    { ...valid, name: "x".repeat(81) },
    { ...valid, grants: [{ kind: "TEAM", hubId: "x" }] },
    { ...valid, grants: [{ kind: "LEAGUE", hubId: "../x" }] },
    { ...valid, grants: "SPORT" },
    { ...valid, allContent: "yes" },
  ]) {
    assert.ok((await errors(invalid)).length > 0, JSON.stringify(invalid));
  }
});
