import { Prisma } from "@prisma/client";
import { Viewer } from "../auth";

type Who = Pick<Viewer, "role" | "tenantId">;

/**
 * Platform administrators see every request. Everyone else sees the requests someone of their
 * own environment follows, so resellers, and the platform's own users, never see each other's.
 */
export const requestsVisibleTo = (viewer: Who): Prisma.RequestWhereInput =>
  viewer.role === "ADMIN" ? {} : { subscribers: { some: { user: { tenantId: viewer.tenantId } } } };

/** The followers a viewer may know about: everyone's for platform administrators. */
export const followersVisibleTo = (viewer: Who): Prisma.RequestSubscriberWhereInput =>
  viewer.role === "ADMIN" ? {} : { user: { tenantId: viewer.tenantId } };

/**
 * The followers a list looks at: those the viewer may know about, narrowed to one environment
 * when a platform administrator chooses it. Everyone else is always limited to their own.
 */
export const followersInScope = (viewer: Who, environment?: string) =>
  viewer.role === "ADMIN" && environment
    ? { user: { tenantId: environment } }
    : followersVisibleTo(viewer);

/**
 * The followers a request's count includes. Users never learn how many others follow, so
 * theirs only counts themselves.
 */
export const followersCounted = (
  viewer: Who & { id: string },
  environment?: string,
): Prisma.RequestSubscriberWhereInput =>
  viewer.role === "USER" ? { userId: viewer.id } : followersInScope(viewer, environment);
