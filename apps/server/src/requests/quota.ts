import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/** Weekly limits use a rolling window, so a user cannot spend two weeks back to back. */
export const QUOTA_WINDOW_MS = 7 * 86400000;

type Role = "ADMIN" | "RESELLER" | "USER";
type Limited = { role: Role; weeklyRequestLimit: number | null };
export type Quota = {
  /** Null when the user has no limit. */
  limit: number | null;
  used: number;
  remaining: number | null;
  /** When the next request frees up; null while requests remain or without a limit. */
  resetsAt: string | null;
};

/** Administrators (of the platform or a reseller) are never limited; users only when given one. */
export const weeklyLimit = (user: Limited) =>
  user.role === "USER" ? user.weeklyRequestLimit : null;

/** Limits and expiration apply to users only, so administrators cannot lock themselves out. */
export const isExpired = (
  user: { role: Role; expiresAt: Date | string | null },
  now = Date.now(),
) => user.role === "USER" && user.expiresAt !== null && new Date(user.expiresAt).getTime() <= now;

/** Requests the user started in the window that were not rejected for them, oldest first. */
export async function quota(
  db: Prisma.TransactionClient,
  userId: string,
  now = Date.now(),
): Promise<Quota> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true, weeklyRequestLimit: true },
  });
  const limit = weeklyLimit(user);
  if (limit === null) {
    return { limit: null, used: 0, remaining: null, resetsAt: null };
  }
  const charged = await db.requestSubscriber.findMany({
    where: {
      userId,
      countsTowardQuota: true,
      status: { not: "REJECTED" },
      createdAt: { gt: new Date(now - QUOTA_WINDOW_MS) },
    },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const used = charged.length;
  const remaining = Math.max(0, limit - used);
  // With the limit reached, a request frees up once enough of the oldest ones leave the window.
  const freeing = remaining === 0 ? charged[used - limit] : undefined;
  return {
    limit,
    used,
    remaining,
    resetsAt: freeing
      ? new Date(freeing.createdAt.getTime() + QUOTA_WINDOW_MS).toISOString()
      : null,
  };
}

export const weeklyLimitReached = (current: Quota) =>
  new ForbiddenException({
    code: "WEEKLY_LIMIT_REACHED",
    message: "You have used every request available this week",
    resetsAt: current.resetsAt,
  });
