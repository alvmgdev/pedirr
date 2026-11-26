import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Infrastructure, logger } from "../infrastructure";
import { appVersion, hubBudget } from "../config";
import {
  EventFilters,
  LeagueSearch,
  MetadataItem,
  MetadataPage,
  MetadataProvider,
  MetadataSearch,
} from "./provider";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseItem(value: unknown): MetadataItem {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.name !== "string"
  ) {
    throw new Error("Invalid metadata entity");
  }
  for (const key of ["shortId", "tsdbId", "leagueId", "seasonId", "scheduledStart"]) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") {
      throw new Error("Invalid metadata field");
    }
  }
  return value as MetadataItem;
}
export function parsePage(value: unknown): MetadataPage {
  if (!record(value) || !Array.isArray(value.items)) {
    throw new Error("Invalid metadata page");
  }
  for (const key of ["total", "page", "pageSize", "totalPages"]) {
    if (
      !Number.isSafeInteger(value[key]) ||
      Number(value[key]) < (key === "page" || key === "pageSize" ? 1 : 0)
    ) {
      throw new Error("Invalid metadata pagination");
    }
  }
  return { ...value, items: value.items.map(parseItem) } as MetadataPage;
}
export function parseSearch(value: unknown): MetadataSearch {
  if (
    !record(value) ||
    !Array.isArray(value.results) ||
    typeof value.query !== "string" ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0
  ) {
    throw new Error("Invalid metadata search");
  }
  const results = value.results.map((item) => {
    const parsed = parseItem(item);
    if (!["league", "team", "event"].includes(String(parsed.entityType))) {
      throw new Error("Invalid metadata result type");
    }
    return parsed as MetadataSearch["results"][number];
  });
  return { query: value.query, total: Number(value.total), results };
}
const optional = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
/** Rows of Hub's TheSportsDB-compatible search; every row needs Hub's ID and a name. */
function mirrorRows(value: unknown, name: "strEvent" | "strTeam") {
  if (!record(value) || !record(value.data)) {
    throw new Error("Invalid mirror search");
  }
  const rows = value.data.search ?? [];
  if (!Array.isArray(rows)) {
    throw new Error("Invalid mirror search");
  }
  return rows.filter(
    (row): row is Record<string, unknown> =>
      record(row) && typeof row.hubId === "string" && typeof row[name] === "string",
  );
}
export function parseMirrorEvents(value: unknown): LeagueSearch["events"] {
  return mirrorRows(value, "strEvent").map((row) => ({
    id: row.hubId as string,
    shortId: optional(row.hubShortId),
    name: row.strEvent as string,
    entityType: "event",
    leagueShortId: optional(row.idLeague),
    leagueName: optional(row.strLeague),
    sportName: optional(row.strSport),
    scheduledStart: optional(row.strTimestamp),
    status: optional(row.strStatus),
    posterUrl: optional(row.strPoster),
    thumbUrl: optional(row.strThumb),
    squareUrl: optional(row.strSquare),
    fanartUrl: optional(row.strFanart),
    bannerUrl: optional(row.strBanner),
    venueName: optional(row.strVenue),
  }));
}
export function parseMirrorTeams(value: unknown): LeagueSearch["teams"] {
  return mirrorRows(value, "strTeam").map((row) => ({
    id: row.hubId as string,
    shortId: optional(row.hubShortId),
    name: row.strTeam as string,
    entityType: "team",
    leagueName: optional(row.strLeague),
    sportName: optional(row.strSport),
    logoUrl: optional(row.strBadge),
    imageUrl: optional(row.strBadge),
  }));
}
export function retrySeconds(value: string | null): number {
  if (value === null) {
    return 60;
  }
  const delay = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(delay) ? Math.max(1, delay) : 60;
}

@Injectable()
export class HubProvider extends MetadataProvider {
  private readonly budget: number;
  constructor(private readonly infrastructure: Infrastructure) {
    super();
    this.budget = hubBudget();
  }
  private unavailable(seconds: number, reason = "upstream") {
    return new ServiceUnavailableException({
      code: "METADATA_BUSY",
      message: "Metadata is temporarily unavailable. Try again shortly.",
      retryAfterSeconds: Math.max(1, seconds),
      reason,
    });
  }
  private async read<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    parse: (value: unknown) => T,
    ttl = 300,
  ): Promise<T> {
    // Paths starting with "/" are outside the public API (Hub's TheSportsDB-compatible search).
    const url = new URL(
      path.startsWith("/")
        ? `https://sportarr.net${path}`
        : `https://sportarr.net/api/public/v1/${path}`,
    );
    for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const key = `pedirr:hub:v1:${createHash("sha256").update(url.href).digest("hex")}`;
    const redis = this.infrastructure.redis;
    const cached = await redis.get(key);
    if (cached) {
      try {
        return parse(JSON.parse(cached));
      } catch {
        await redis.del(key);
      }
    }
    const cooldown = await redis.ttl("pedirr:hub:cooldown");
    if (cooldown > 0) {
      throw this.unavailable(cooldown, "upstream_limit");
    }
    const lock = key + ":lock";
    const owner = randomUUID();
    if (!(await redis.set(lock, owner, "EX", 15, "NX"))) {
      // Share the completed result across API replicas instead of rejecting overlapping reads.
      const deadline = Date.now() + 11000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const shared = await redis.get(key);
        if (shared) {
          try {
            return parse(JSON.parse(shared));
          } catch {
            await redis.del(key);
          }
        }
        const waitingCooldown = await redis.ttl("pedirr:hub:cooldown");
        if (waitingCooldown > 0) {
          throw this.unavailable(waitingCooldown, "upstream_limit");
        }
        if (!(await redis.get(lock))) {
          return this.read(path, query, parse, ttl);
        }
      }
      throw this.unavailable(1, "in_flight");
    }
    try {
      const settled = await redis.get(key);
      if (settled) {
        try {
          return parse(JSON.parse(settled));
        } catch {
          await redis.del(key);
        }
      }
      const allowed = Number(
        await redis.eval(
          `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n`,
          1,
          "pedirr:hub:budget",
        ),
      );
      if (allowed > this.budget) {
        throw this.unavailable(await redis.ttl("pedirr:hub:budget"), "local_limit");
      }
      let response: Response;
      try {
        response = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          redirect: "error",
          headers: { Accept: "application/json", "User-Agent": `Pedirr/${appVersion}` },
        });
      } catch {
        throw this.unavailable(10);
      }
      if (response.status === 429) {
        const seconds = retrySeconds(response.headers.get("retry-after"));
        // A shorter concurrent response must not reduce an existing cooldown.
        await redis.eval(
          `local ttl=redis.call('TTL',KEYS[1]); if ttl<tonumber(ARGV[1]) then redis.call('SET',KEYS[1],'1','EX',ARGV[1]) end; return 1`,
          1,
          "pedirr:hub:cooldown",
          seconds,
        );
        throw this.unavailable(seconds, "upstream_limit");
      }
      if (response.status === 404) {
        throw new NotFoundException({ code: "METADATA_NOT_FOUND", message: "Content not found" });
      }
      if (!response.ok) {
        logger.warn({ upstream: "hub", status: response.status }, "Metadata request failed");
        throw this.unavailable(10);
      }
      let parsed: T;
      try {
        parsed = parse(await response.json());
      } catch {
        throw new BadGatewayException({
          code: "METADATA_INVALID",
          message: "Metadata provider returned an unexpected response",
        });
      }
      await redis.set(key, JSON.stringify(parsed), "EX", ttl);
      return parsed;
    } finally {
      await redis.eval(
        `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`,
        1,
        lock,
        owner,
      );
    }
  }
  search(query: string) {
    return this.read(
      "search",
      { q: query.trim(), types: "league,team,event", limit: 20 },
      parseSearch,
    );
  }
  /**
   * Hub's TheSportsDB-compatible search: public like the rest, and unlike the main search it says
   * which league each result belongs to. It returns up to 25 events, nearest dates first.
   */
  async searchWithLeagues(query: string): Promise<LeagueSearch> {
    const q = encodeURIComponent(query.trim());
    const [events, teams] = await Promise.all([
      this.read(`/api/v2/json/search/event/${q}`, {}, parseMirrorEvents),
      this.read(`/api/v2/json/search/team/${q}`, {}, parseMirrorTeams),
    ]);
    return { events, teams };
  }
  sports() {
    // Hub lists a few dozen sports, so one page covers them; they rarely change.
    return this.read("sports", { page: 1, page_size: 100 }, parsePage, 86400);
  }
  leagues(page: number, pageSize = 30) {
    return this.read("leagues", { page, page_size: pageSize }, parsePage, 3600);
  }
  league(id: string) {
    return this.read(`leagues/${encodeURIComponent(id)}`, {}, parseItem);
  }
  seasons(league: string, page: number) {
    return this.read(
      `leagues/${encodeURIComponent(league)}/seasons`,
      { page, page_size: 50 },
      parsePage,
    );
  }
  season(id: string) {
    return this.read(`seasons/${encodeURIComponent(id)}`, {}, parseItem);
  }
  team(id: string) {
    return this.read(`teams/${encodeURIComponent(id)}`, {}, parseItem);
  }
  events({ pageSize = 50, order = "asc", ...filters }: EventFilters) {
    return this.read(
      "events",
      { ...filters, page_size: pageSize, order },
      parsePage,
      filters.season ? 3600 : 120,
    );
  }
  event(id: string) {
    return this.read(`events/${encodeURIComponent(id)}`, {}, parseItem, 120);
  }
}
