/**
 * The environment this page belongs to: a reseller when the first path segment is its code
 * (/<code>/requests), otherwise the platform at the root. Keep the reserved words in sync with
 * RESERVED_TENANT_CODES in apps/server/src/tenants.ts: they are this app's own first segments.
 */
const CODE = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
const RESERVED = new Set([
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

export function environmentCode(pathname: string): string | null {
  const segment = pathname.split("/")[1] ?? "";
  return CODE.test(segment) && !RESERVED.has(segment) ? segment : null;
}

/** The reseller code, or null at the platform. */
export const environment = environmentCode(window.location.pathname);
/** Router base path: /<code> for a reseller. */
export const basename = environment ? `/${environment}` : undefined;
/** API base path: each environment has its own API and session. */
export const apiBase = environment ? `/${environment}/api/v1` : "/api/v1";
