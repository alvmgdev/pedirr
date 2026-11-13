import { RequestStatus } from "@prisma/client";
import { ManagerEvent, ManagerPart, QueueItem } from "../managers/client";

// Sportarr's pseudo part for one whole-event file, and its optional bonus part.
const FULL_EVENT = "full event";
const OPTIONAL_PARTS = new Set(["post show"]);
export const ACTIVE_QUEUE = [
  "Queued",
  "Downloading",
  "Paused",
  "Completed",
  "Importing",
  "ImportPending",
  "ImportWarning",
  "Warning",
];

/** Case-insensitive identity of a part name, as Sportarr compares them. */
export const partKey = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
export const isOptionalPart = (name: string) => OPTIONAL_PARTS.has(partKey(name));
/** Days after an event start during which optional parts such as the Post Show are searched. */
export const OPTIONAL_SEARCH_DAYS = 7;
/**
 * Parts that decide availability. Like Sportarr, optional parts never block an event that has
 * other parts requested; requested on their own they are what the user is waiting for.
 */
export function requiredParts(names: string[]): string[] {
  const required = names.filter((name) => !isOptionalPart(name));
  return required.length ? required : names;
}
const has = (names: Iterable<string>, name: string) =>
  [...names].some((item) => partKey(item) === partKey(name));

/** Parts a user can choose: real segments, never the "Full Event" pseudo part. */
export function selectableParts(definitions: ManagerPart[]): ManagerPart[] {
  return definitions.filter((part) => part.number > 0 && partKey(part.name) !== FULL_EVENT);
}

/** Monitored parts that apply to an event: its own value, else the league's; null is all. */
export function effectiveMonitoredParts(event: unknown, league: unknown): string | null {
  if (typeof event === "string") {
    return event;
  }
  return typeof league === "string" ? league : null;
}

/** An event or league set to "Full Event" keeps one whole file and never splits into parts. */
export function isFullEventOnly(value: string | null): boolean {
  return value !== null && partKey(value) === FULL_EVENT;
}

export function splitParts(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Parts pre-selected for a new request: the monitored parts Sportarr applies (all parts when
 * none are configured), never the optional ones such as the Post Show.
 */
export function defaultParts(selectable: ManagerPart[], configured: string | null): string[] {
  const monitored = configured === null ? null : splitParts(configured);
  return selectable
    .filter((part) => monitored === null || has(monitored, part.name))
    .filter((part) => !isOptionalPart(part.name))
    .map((part) => part.name);
}

/** Canonical names for requested parts, or undefined when any is unknown or repeated. */
export function canonicalParts(selectable: ManagerPart[], names: string[]): string[] | undefined {
  const result: string[] = [];
  for (const name of names) {
    const match = selectable.find((part) => partKey(part.name) === partKey(name));
    if (!match || has(result, match.name)) {
      return undefined;
    }
    result.push(match.name);
  }
  return result;
}

/** Parts held on disk; a whole-event file covers every part. Parked files do not count. */
export function heldParts(
  event: ManagerEvent,
  definitions: ManagerPart[],
): { whole: boolean; names: string[] } {
  const files = event.files.filter((file) => file.exists === true && file.isParked !== true);
  const whole = files.some(
    (file) =>
      (file.partNumber === null || file.partNumber === undefined || file.partNumber === 0) &&
      (!partKey(file.partName) || partKey(file.partName) === FULL_EVENT),
  );
  const numbers = new Set(files.map((file) => file.partNumber));
  const names = files.map((file) => partKey(file.partName));
  return {
    whole,
    names: definitions
      .filter((part) => numbers.has(part.number) || names.includes(partKey(part.name)))
      .map((part) => part.name),
  };
}

/** Parts with active queue work; an active item without a part may hold any of them. */
export function queuedParts(activity: QueueItem[]): { unknown: boolean; names: string[] } {
  const active = activity.filter((item) => ACTIVE_QUEUE.includes(item.status));
  return {
    unknown: active.some((item) => !item.part),
    names: active.filter((item) => item.part).map((item) => item.part!),
  };
}

/** Comma-separated monitored parts after adding names, in Sportarr's part order. */
export function addMonitoredParts(
  definitions: ManagerPart[],
  current: string[],
  add: string[],
): string {
  const wanted = [...current, ...add];
  const ordered = definitions
    .filter((part) => part.number > 0 && has(wanted, part.name))
    .map((part) => part.name);
  // Keep configured names Sportarr no longer defines rather than dropping them silently.
  const unknown = current.filter((name) => !has(ordered, name));
  return [...ordered, ...unknown].join(",");
}

export type PartReview = { name: string; status: RequestStatus };
export type EventState = {
  parts: string[];
  available: boolean;
  availableParts: string[];
  downloadingParts: string[];
  downloading: boolean;
};

/**
 * Status of one subscriber. Requests without parts share the request status. With parts, it
 * depends only on the parts that subscriber asked for, so another user's extra parts never
 * move it backwards.
 */
export function subscriberStatus(input: {
  requestStatus: RequestStatus;
  requestParts: PartReview[];
  userParts: string[];
  events: EventState[];
  closed: boolean;
}): RequestStatus {
  if (!input.requestParts.length) {
    return input.requestStatus;
  }
  const mine = input.userParts.length
    ? input.requestParts.filter((part) => has(input.userParts, part.name))
    : input.requestParts;
  if (!mine.length) {
    return input.requestStatus;
  }
  if (mine.every((part) => part.status === "REJECTED")) {
    return "REJECTED";
  }
  const approved = mine.filter((part) => part.status === "APPROVED").map((part) => part.name);
  if (!approved.length || mine.some((part) => part.status === "PENDING")) {
    return "PENDING";
  }
  return progressStatus(approved, input.events, input.closed);
}

/** Fulfillment status for a set of approved parts across the synchronized events. */
export function progressStatus(
  approved: string[],
  events: EventState[],
  closed: boolean,
): RequestStatus {
  if (!events.length) {
    return "APPROVED";
  }
  let complete = true;
  let downloading = false;
  for (const event of events) {
    if (!event.parts.length) {
      complete &&= event.available;
      downloading ||= event.downloading;
      continue;
    }
    const wanted = approved.filter((name) => has(event.parts, name));
    // The event-level flag reflects the parts approved at the last sync, not this set.
    complete &&= requiredParts(wanted).every((name) => has(event.availableParts, name));
    downloading ||= wanted.some((name) => has(event.downloadingParts, name));
  }
  if (complete && closed) {
    return "AVAILABLE";
  }
  return downloading ? "DOWNLOADING" : "APPROVED";
}

/** Request status from its parts: review first, then fulfillment of the approved ones. */
export function partsRequestStatus(
  parts: PartReview[],
  fulfillment: RequestStatus | undefined,
): RequestStatus {
  if (parts.some((part) => part.status === "APPROVED")) {
    return fulfillment && !["PENDING", "REJECTED"].includes(fulfillment) ? fulfillment : "APPROVED";
  }
  return parts.some((part) => part.status === "PENDING") ? "PENDING" : "REJECTED";
}
