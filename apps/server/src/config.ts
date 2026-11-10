import { isIP } from "node:net";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function port(): number {
  const value = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("Invalid PORT");
  }
  return value;
}

export type TrustProxy = false | number | string[];

const NAMED_SUBNETS = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * Parse TRUST_PROXY for Express. Unset or "false" keeps the direct peer as the
 * client address. A hop count (1-10) or a comma-separated list of IP
 * addresses, CIDR ranges or Express subnet names trusts X-Forwarded-For only
 * from those reverse proxies. "true" (trust every peer) is refused because any
 * client could then choose the address used for rate limiting.
 */
export function trustProxy(raw: string | undefined = process.env.TRUST_PROXY): TrustProxy {
  const value = (raw ?? "").trim();
  if (value === "" || value === "false") {
    return false;
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) {
      throw new Error("TRUST_PROXY hop count must be between 1 and 10");
    }
    return hops;
  }
  if (value === "true") {
    throw new Error("TRUST_PROXY=true is not allowed; set a hop count or the proxy addresses");
  }
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (!NAMED_SUBNETS.has(entry) && !isAddressOrRange(entry)) {
      throw new Error("Invalid TRUST_PROXY entry");
    }
  }
  return entries;
}

function isAddressOrRange(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split("/");
  const family = isIP(address ?? "");
  if (!family || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d+$/.test(prefix)) {
    return false;
  }
  return Number(prefix) <= (family === 4 ? 32 : 128);
}
