const { test } = require("node:test");
const assert = require("node:assert/strict");
const { aggregateStatus, imported, errorCode } = require("../dist/jobs/fulfillment");
const { dispatch } = require("../dist/jobs/dispatch");
test("open seasons cannot become available even when all current events have files", () => {
  assert.equal(aggregateStatus([{ available: true, downloading: false }], false), "APPROVED");
  assert.equal(aggregateStatus([{ available: true, downloading: false }], true), "AVAILABLE");
  assert.equal(aggregateStatus([], true), "APPROVED");
});
test("availability requires complete multipart state and a file actually present", () => {
  assert.equal(imported({ hasFile: true, files: [{ exists: true }] }), true);
  assert.equal(imported({ hasFile: false, files: [{ exists: true }] }), false);
  assert.equal(imported({ hasFile: true, files: [] }), false);
  assert.equal(imported({ hasFile: true, files: [{ exists: false }] }), false);
});
test("download state and failed imports do not imply availability", () => {
  assert.equal(aggregateStatus([{ available: false, downloading: true }], true), "DOWNLOADING");
  assert.equal(aggregateStatus([{ available: false, downloading: false }], true), "APPROVED");
  assert.equal(errorCode(new Error("secret network URL")), "INTEGRATION_FAILED");
});
test("outbox publication is idempotent across a crash before acknowledgement", async () => {
  const jobs = new Set();
  let fail = true,
    acknowledged = false;
  const infrastructure = {
    db: {
      outboxEvent: {
        findMany: async () =>
          acknowledged ? [] : [{ id: "event-1", payload: { requestId: "request-1" } }],
        update: async () => {
          if (fail) {
            throw new Error("Database connection lost");
          }
          acknowledged = true;
        },
      },
      request: { findMany: async () => [] },
    },
  };
  const queue = { add: async (_, __, options) => jobs.add(options.jobId) };
  await assert.rejects(dispatch(infrastructure, queue));
  fail = false;
  await dispatch(infrastructure, queue);
  assert.equal(jobs.size, 1);
  assert.equal(acknowledged, true);
});
