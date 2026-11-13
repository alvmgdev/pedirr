const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  addMonitoredParts,
  canonicalParts,
  defaultParts,
  effectiveMonitoredParts,
  heldParts,
  isFullEventOnly,
  partsRequestStatus,
  progressStatus,
  queuedParts,
  selectableParts,
  subscriberStatus,
} = require("../dist/requests/parts");

const definitions = [
  { name: "Full Event", number: 0 },
  { name: "Early Prelims", number: 1 },
  { name: "Prelims", number: 2 },
  { name: "Main Card", number: 3 },
  { name: "Post Show", number: 4 },
];
const selectable = selectableParts(definitions);
const event = (files) => ({
  id: 1,
  externalId: "ev-1",
  title: "UFC",
  hasFile: false,
  monitored: true,
  files,
});

test("users choose real segments, never the Full Event pseudo part", () => {
  assert.deepEqual(
    selectable.map((part) => part.name),
    ["Early Prelims", "Prelims", "Main Card", "Post Show"],
  );
});

test("defaults follow Sportarr's monitored parts and leave optional parts unselected", () => {
  assert.deepEqual(defaultParts(selectable, null), ["Early Prelims", "Prelims", "Main Card"]);
  assert.deepEqual(defaultParts(selectable, "main card, Post Show"), ["Main Card"]);
  assert.equal(effectiveMonitoredParts("Prelims", "Main Card"), "Prelims");
  assert.equal(effectiveMonitoredParts(null, "Main Card"), "Main Card");
  assert.equal(effectiveMonitoredParts(undefined, undefined), null);
  assert.equal(isFullEventOnly("full event"), true);
  assert.equal(isFullEventOnly("Full Event,Main Card"), false);
  assert.equal(isFullEventOnly(null), false);
});

test("requested names map to Sportarr's names and reject unknown or repeated parts", () => {
  assert.deepEqual(canonicalParts(selectable, ["main card", "PRELIMS"]), ["Main Card", "Prelims"]);
  assert.equal(canonicalParts(selectable, ["Main Card", "main card"]), undefined);
  assert.equal(canonicalParts(selectable, ["Full Event"]), undefined);
  assert.equal(canonicalParts(selectable, ["Countdown"]), undefined);
});

test("held parts come from existing, unparked files; a whole-event file covers every part", () => {
  assert.deepEqual(
    heldParts(
      event([
        { exists: true, partNumber: 3, partName: "Main Card" },
        { exists: false, partNumber: 2, partName: "Prelims" },
        { exists: true, isParked: true, partNumber: 1, partName: "Early Prelims" },
      ]),
      selectable,
    ),
    { whole: false, names: ["Main Card"] },
  );
  assert.equal(heldParts(event([{ exists: true, partNumber: null }]), selectable).whole, true);
  assert.equal(
    heldParts(event([{ exists: true, partNumber: 0, partName: "Full Event" }]), selectable).whole,
    true,
  );
});

test("queue work names its parts; an active item without a part may hold any part", () => {
  assert.deepEqual(
    queuedParts([
      { eventId: 1, status: "Downloading", progress: 10, part: "Prelims" },
      { eventId: 1, status: "Failed", progress: 0, part: "Main Card" },
    ]),
    { unknown: false, names: ["Prelims"] },
  );
  assert.equal(
    queuedParts([{ eventId: 1, status: "Queued", progress: 0, part: null }]).unknown,
    true,
  );
});

test("monitored parts are only added, in Sportarr's order, keeping unknown configured names", () => {
  assert.equal(addMonitoredParts(definitions, [], ["Main Card", "Prelims"]), "Prelims,Main Card");
  assert.equal(
    addMonitoredParts(definitions, ["Main Card", "Countdown"], ["Early Prelims"]),
    "Early Prelims,Main Card,Countdown",
  );
});

const eventState = (overrides) => ({
  parts: ["Early Prelims", "Prelims", "Main Card"],
  available: false,
  availableParts: [],
  downloadingParts: [],
  downloading: false,
  ...overrides,
});

test("each subscriber's status depends only on their own parts", () => {
  const requestParts = [
    { name: "Main Card", status: "APPROVED" },
    { name: "Prelims", status: "PENDING" },
  ];
  const events = [eventState({ availableParts: ["Main Card"] })];
  const common = { requestStatus: "APPROVED", requestParts, events, closed: true };
  assert.equal(subscriberStatus({ ...common, userParts: ["Main Card"] }), "AVAILABLE");
  assert.equal(subscriberStatus({ ...common, userParts: ["Prelims"] }), "PENDING");
  assert.equal(subscriberStatus({ ...common, userParts: ["Main Card", "Prelims"] }), "PENDING");
  assert.equal(
    subscriberStatus({
      ...common,
      requestParts: [{ name: "Prelims", status: "REJECTED" }, ...requestParts.slice(0, 1)],
      userParts: ["Prelims"],
    }),
    "REJECTED",
  );
  // Requests without parts share the request status.
  assert.equal(
    subscriberStatus({ ...common, requestParts: [], userParts: [], requestStatus: "DOWNLOADING" }),
    "DOWNLOADING",
  );
});

test("availability needs every approved part on every event and a closed scope", () => {
  const events = [
    eventState({ availableParts: ["Main Card"] }),
    eventState({ parts: ["Prelims", "Main Card"], downloadingParts: ["Main Card"] }),
  ];
  assert.equal(progressStatus(["Main Card"], events, true), "DOWNLOADING");
  assert.equal(progressStatus(["Main Card"], events.slice(0, 1), false), "APPROVED");
  assert.equal(progressStatus(["Main Card"], events.slice(0, 1), true), "AVAILABLE");
  // A part an event does not define (no Early Prelims on a Fight Night) never blocks it.
  assert.equal(
    progressStatus(["Early Prelims"], [eventState({ parts: ["Prelims", "Main Card"] })], true),
    "AVAILABLE",
  );
  assert.equal(
    progressStatus(
      ["Main Card"],
      [eventState({ parts: [], available: false, downloading: true })],
      true,
    ),
    "DOWNLOADING",
  );
});

test("request status reviews parts first, then follows fulfillment of approved parts", () => {
  assert.equal(partsRequestStatus([{ name: "A", status: "PENDING" }], "APPROVED"), "PENDING");
  assert.equal(partsRequestStatus([{ name: "A", status: "REJECTED" }], "APPROVED"), "REJECTED");
  assert.equal(
    partsRequestStatus(
      [
        { name: "A", status: "APPROVED" },
        { name: "B", status: "PENDING" },
      ],
      "DOWNLOADING",
    ),
    "DOWNLOADING",
  );
  assert.equal(partsRequestStatus([{ name: "A", status: "APPROVED" }], "PENDING"), "APPROVED");
});
