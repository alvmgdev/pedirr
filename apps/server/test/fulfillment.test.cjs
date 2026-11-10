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
test("only monitored missing event parts are searched, never parts already held or downloading", () => {
  const { partsToSearch } = require("../dist/jobs/fulfillment");
  const parts = [
    { name: "Full Event", number: 0 },
    { name: "Early Prelims", number: 1 },
    { name: "Prelims", number: 2 },
    { name: "Main Card", number: 3 },
    { name: "Post Show", number: 4 },
  ];
  const mainCard = { exists: true, partName: "Main Card", partNumber: 3 };
  const event = (files, monitoredParts = null) => ({
    id: 9,
    hasFile: false,
    files,
    monitoredParts,
  });
  // Without any file the event-level search remains responsible.
  assert.deepEqual(partsToSearch(event([]), parts, null, []), []);
  assert.deepEqual(partsToSearch(event([{ ...mainCard, exists: false }]), parts, null, []), []);
  // All parts monitored (null): the optional Post Show is not required.
  assert.deepEqual(partsToSearch(event([mainCard]), parts, null, []), ["Early Prelims", "Prelims"]);
  // A whole-event file covers every part.
  assert.deepEqual(
    partsToSearch(
      event([mainCard, { exists: true, partName: null, partNumber: 0 }]),
      parts,
      null,
      [],
    ),
    [],
  );
  // Event monitoring overrides the league; the league applies when the event has none.
  assert.deepEqual(
    partsToSearch(event([mainCard], "Prelims, Main Card"), parts, "Early Prelims", []),
    ["Prelims"],
  );
  assert.deepEqual(partsToSearch(event([mainCard]), parts, "Main Card", []), []);
  // A part already downloading is skipped; an active item of unknown part blocks all searches.
  assert.deepEqual(
    partsToSearch(event([mainCard]), parts, null, [
      { eventId: 9, status: "Downloading", progress: 5, part: "Prelims" },
    ]),
    ["Early Prelims"],
  );
  assert.deepEqual(
    partsToSearch(event([mainCard]), parts, null, [
      { eventId: 9, status: "Downloading", progress: 5, part: null },
    ]),
    [],
  );
  // Finished or failed queue rows do not block a missing part.
  assert.deepEqual(
    partsToSearch(event([mainCard]), parts, null, [
      { eventId: 9, status: "Imported", progress: 100, part: "Prelims" },
    ]),
    ["Early Prelims", "Prelims"],
  );
});
