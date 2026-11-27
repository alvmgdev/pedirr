const { test } = require("node:test");
const assert = require("node:assert/strict");
const { daySlices, HUB_RANGE_DAYS } = require("../dist/metadata/schedule");
const { indexRetryDelayMs } = require("../dist/jobs/paged-sync");
const { failureDetails } = require("../dist/jobs/fulfillment");
const { ServiceUnavailableException } = require("@nestjs/common");

test("date ranges are split into weeks that touch without overlapping", () => {
  assert.equal(HUB_RANGE_DAYS, 7);
  // 21 days, both ends included: three full weeks.
  assert.deepEqual(daySlices("2026-11-20", "2026-12-10"), [
    { from: "2026-11-20", to: "2026-11-26" },
    { from: "2026-11-27", to: "2026-12-03" },
    { from: "2026-12-04", to: "2026-12-10" },
  ]);
  // Not a multiple of seven: the last range is shorter.
  assert.deepEqual(daySlices("2026-11-20", "2026-12-11").at(-1), {
    from: "2026-12-11",
    to: "2026-12-11",
  });
  assert.deepEqual(daySlices("2026-11-27", "2026-11-28"), [
    { from: "2026-11-27", to: "2026-11-28" },
  ]);
  // Every day of a long range is asked exactly once, across a month and a year end.
  const slices = daySlices("2026-12-20", "2027-01-31");
  const days = slices.flatMap(({ from, to }) => {
    const out = [];
    for (let at = Date.parse(from); at <= Date.parse(to); at += 86400000) {
      out.push(new Date(at).toISOString().slice(0, 10));
    }
    return out;
  });
  assert.equal(days.length, 43);
  assert.equal(new Set(days).size, 43);
  assert.ok(slices.every(({ from, to }) => Date.parse(to) - Date.parse(from) <= 6 * 86400000));
});

test("failed background copies retry after 2, 4, 8 and 16 minutes, at most an hour", () => {
  assert.deepEqual([1, 2, 3, 4].map(indexRetryDelayMs), [120000, 240000, 480000, 960000]);
  assert.equal(indexRetryDelayMs(10), 3600000);
});

test("failed jobs log why Hub failed, not only that it was busy", () => {
  const busy = (body) => new ServiceUnavailableException({ code: "METADATA_BUSY", ...body });
  assert.deepEqual(failureDetails(busy({ reason: "timeout", retryAfterSeconds: 10 })), {
    code: "METADATA_BUSY",
    reason: "timeout",
    retryAfterSeconds: 10,
  });
  assert.deepEqual(failureDetails(busy({ reason: "upstream", status: 502 })), {
    code: "METADATA_BUSY",
    reason: "upstream",
    status: 502,
  });
  assert.deepEqual(failureDetails(new Error("boom")), { code: "INTEGRATION_FAILED" });
});
