const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("class-validator");
const { canChangeStatus, requiresComment, resolvedAtFor } = require("../dist/issues/rules");
const { CreateIssue, IssueStatusChange } = require("../dist/issues/controller");

test("administrators manage the whole issue lifecycle", () => {
  for (const [from, to] of [
    ["OPEN", "IN_PROGRESS"],
    ["IN_PROGRESS", "RESOLVED"],
    ["OPEN", "CLOSED"],
    ["RESOLVED", "OPEN"],
    ["CLOSED", "IN_PROGRESS"],
  ]) {
    assert.equal(canChangeStatus("ADMIN", from, to), true, `${from} -> ${to}`);
  }
  assert.equal(canChangeStatus("ADMIN", "OPEN", "OPEN"), false);
});

test("reporters close their active issues and reopen finished ones, nothing else", () => {
  assert.equal(canChangeStatus("REPORTER", "OPEN", "CLOSED"), true);
  assert.equal(canChangeStatus("REPORTER", "IN_PROGRESS", "CLOSED"), true);
  assert.equal(canChangeStatus("REPORTER", "RESOLVED", "OPEN"), true);
  assert.equal(canChangeStatus("REPORTER", "CLOSED", "OPEN"), true);
  for (const [from, to] of [
    ["OPEN", "IN_PROGRESS"],
    ["OPEN", "RESOLVED"],
    ["IN_PROGRESS", "OPEN"],
    ["RESOLVED", "CLOSED"],
    ["CLOSED", "RESOLVED"],
  ]) {
    assert.equal(canChangeStatus("REPORTER", from, to), false, `${from} -> ${to}`);
  }
});

test("resolving needs an explanation and finished issues record when they finished", () => {
  assert.equal(requiresComment("RESOLVED"), true);
  assert.equal(requiresComment("CLOSED"), false);
  const now = new Date("2026-11-14T10:00:00Z");
  assert.equal(resolvedAtFor("RESOLVED", now), now);
  assert.equal(resolvedAtFor("CLOSED", now), now);
  assert.equal(resolvedAtFor("OPEN", now), null);
  assert.equal(resolvedAtFor("IN_PROGRESS", now), null);
});

test("issue input is validated before reaching the service", async () => {
  const valid = { category: "QUALITY", description: "Audio is out of sync" };
  assert.equal((await validate(Object.assign(new CreateIssue(), valid))).length, 0);
  for (const change of [
    { category: "BROKEN" },
    { description: "" },
    { description: "x".repeat(2001) },
    { eventId: "not-a-uuid" },
    { part: "x".repeat(61) },
  ]) {
    assert.ok((await validate(Object.assign(new CreateIssue(), valid, change))).length > 0);
  }
  assert.ok(
    (await validate(Object.assign(new IssueStatusChange(), { status: "DONE" }))).length > 0,
  );
  assert.equal(
    (await validate(Object.assign(new IssueStatusChange(), { status: "CLOSED" }))).length,
    0,
  );
});
