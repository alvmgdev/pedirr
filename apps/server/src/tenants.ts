import { NextFunction, Request, Response } from "express";

/**
 * The platform environment, reached at the root of the domain. Its administrators are the
 * platform (super) administrators; every account created before resellers existed belongs to it.
 */
export const PLATFORM_TENANT = "platform";

/** A reseller's code: 3 to 20 lowercase letters, digits or inner hyphens, used as /<code>/. */
export const TENANT_CODE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
/**
 * First path segments the application already uses. The web client treats any other code-shaped
 * segment as an environment, so codes must never take one of these (keep in sync with the web
 * routes in apps/web/src/environment.ts).
 */
export const RESERVED_TENANT_CODES = new Set([
  "account",
  "admin",
  "api",
  "assets",
  "catalog",
  "docs",
  "health",
  "images",
  "issues",
  "login",
  "platform",
  "requests",
]);
export const isTenantCode = (value: string) =>
  TENANT_CODE.test(value) && !RESERVED_TENANT_CODES.has(value);

export type EnvironmentRequest = Request & { environment?: string };

/**
 * Serves a reseller's API under /<code>/api/...: the code is kept on the request and the path
 * continues as /api/..., so every route works the same for the platform and for resellers.
 */
export function environmentPrefix(req: Request, _res: Response, next: NextFunction) {
  const match = /^\/([^/]+)(\/api(?:\/.*)?)$/.exec(req.url);
  if (match && isTenantCode(match[1])) {
    (req as EnvironmentRequest).environment = match[1];
    req.url = match[2];
  }
  next();
}
