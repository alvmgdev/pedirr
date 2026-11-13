import { IssueStatus } from "@prisma/client";

export const ISSUE_CATEGORIES = [
  "WRONG_CONTENT",
  "MISSING_CONTENT",
  "QUALITY",
  "LANGUAGE",
  "PLAYBACK",
  "OTHER",
] as const;
export const ISSUE_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const;
const finished = (status: IssueStatus) => status === "RESOLVED" || status === "CLOSED";

/**
 * Whether an actor may move an issue between two statuses. Administrators manage the whole
 * lifecycle; reporters may close their own issue while it is active ("it is fixed now") and
 * reopen it once finished ("it still happens").
 */
export function canChangeStatus(
  actor: "ADMIN" | "REPORTER",
  from: IssueStatus,
  to: IssueStatus,
): boolean {
  if (from === to) {
    return false;
  }
  if (actor === "ADMIN") {
    return true;
  }
  return finished(from) ? to === "OPEN" : to === "CLOSED";
}

/** Resolving explains what was done; every other change may carry an optional comment. */
export const requiresComment = (to: IssueStatus) => to === "RESOLVED";

/** Finished issues record when they finished; reopening clears it. */
export const resolvedAtFor = (to: IssueStatus, now = new Date()) => (finished(to) ? now : null);
