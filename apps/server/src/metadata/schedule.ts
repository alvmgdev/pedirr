import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Infrastructure } from "../infrastructure";
import { MetadataItem, MetadataProvider, MetadataSearch } from "./provider";

export const DAY = 86400000;
const WEEK = 7 * DAY;
/** A copy older than this is not trusted; the schedule then comes from Hub as before. */
const MAX_AGE = 2 * DAY;
/** The setting recording the last complete copy of the schedule, which makes it usable. */
export const SCHEDULE_SETTING = "index.schedule";
export const SCHEDULE_PAGE_SIZE = 60;
const SEARCH_LIMIT = 20;
const ORDER = [
  { scheduledStart: "asc" },
  { id: "asc" },
] satisfies Prisma.HubEventOrderByWithRelationInput[];
type Result = MetadataSearch["results"][number];

/** A UTC calendar day as Hub's date filters take it. */
export const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** When the last complete copy finished, if any. */
export async function scheduleCompletedAt(infrastructure: Infrastructure) {
  const setting = await infrastructure.db.setting.findUnique({ where: { key: SCHEDULE_SETTING } });
  const value = setting?.value as { completedAt?: unknown } | undefined;
  return typeof value?.completedAt === "string" ? Date.parse(value.completedAt) : undefined;
}

/**
 * The schedule of the next seven days and plan search of events and teams. Both come from the
 * local copy of Hub's events (7 days back to 14 ahead), where they are paged and filtered by
 * league in one query; until a complete, recent copy exists, the schedule comes from Hub.
 * `leagues` null means every league.
 */
@Injectable()
export class Schedule {
  constructor(
    private readonly infrastructure: Infrastructure,
    private readonly metadata: MetadataProvider,
  ) {}
  /** Whether a complete copy finished recently enough to be used. */
  async ready(now = Date.now()) {
    const at = await scheduleCompletedAt(this.infrastructure);
    return at !== undefined && now - at <= MAX_AGE;
  }
  /** Events starting in the next seven days, soonest first. */
  async upcoming(leagues: Set<string> | null, page: number, now = Date.now()) {
    return (await this.ready(now))
      ? this.localUpcoming(leagues, page, now)
      : this.hubUpcoming(leagues, page, now);
  }
  /** Teams and events of the given leagues found in the copy; none until it is ready. */
  async search(leagues: Set<string>, query: string): Promise<Result[]> {
    if (!(await this.ready())) {
      return [];
    }
    const [teams, events] = await Promise.all([
      this.searchTeams(leagues, query),
      this.searchEvents(leagues, query),
    ]);
    return [...teams, ...events];
  }
  private where(leagues: Set<string> | null): Prisma.HubEventWhereInput {
    return {
      isActive: true,
      // A null status is not "cancelled"; a plain `not` would also drop it.
      OR: [{ status: null }, { status: { not: "cancelled" } }],
      ...(leagues ? { leagueId: { in: [...leagues] } } : {}),
    };
  }
  private async localUpcoming(leagues: Set<string> | null, page: number, now: number) {
    const rows = await this.infrastructure.db.hubEvent.findMany({
      where: {
        ...this.where(leagues),
        scheduledStart: { gte: new Date(now), lte: new Date(now + WEEK) },
      },
      select: { item: true },
      orderBy: ORDER,
      skip: (page - 1) * SCHEDULE_PAGE_SIZE,
      take: SCHEDULE_PAGE_SIZE + 1,
    });
    const hasMore = rows.length > SCHEDULE_PAGE_SIZE;
    return {
      items: rows.slice(0, SCHEDULE_PAGE_SIZE).map((row) => row.item as MetadataItem),
      page,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
    };
  }
  /**
   * Hub cannot filter by several leagues, so its pages are filtered here. Empty pages are skipped
   * (at most five per call) without claiming that a partially scanned schedule is exhausted.
   */
  private async hubUpcoming(leagues: Set<string> | null, first: number, now: number) {
    // Keep the broadcast-date margin: Hub filters by date, the schedule by start time.
    const from = isoDay(now - DAY);
    const to = isoDay(now + WEEK);
    for (let page = first; page < first + 5; page++) {
      const result = await this.metadata.events({ from, to, page, pageSize: 100 });
      const items = result.items.filter(
        (item) =>
          item.scheduledStart &&
          Date.parse(item.scheduledStart) >= now &&
          Date.parse(item.scheduledStart) <= now + WEEK &&
          item.status !== "cancelled" &&
          item.isActive !== false &&
          (!leagues || leagues.has(item.leagueId ?? "")),
      );
      const hasMore = result.page < result.totalPages;
      if (items.length || !hasMore || page === first + 4) {
        return { items, page: result.page, hasMore, nextPage: hasMore ? result.page + 1 : null };
      }
    }
    throw new Error("Unreachable upcoming pagination");
  }
  private async searchEvents(leagues: Set<string>, query: string): Promise<Result[]> {
    const rows = await this.infrastructure.db.hubEvent.findMany({
      where: { ...this.where(leagues), name: { contains: query, mode: "insensitive" } },
      select: { item: true },
      orderBy: ORDER,
      take: SEARCH_LIMIT,
    });
    return rows.map((row) => ({ ...(row.item as MetadataItem), entityType: "event" as const }));
  }
  private async searchTeams(leagues: Set<string>, query: string): Promise<Result[]> {
    const name = { contains: query, mode: "insensitive" as const };
    const rows = await this.infrastructure.db.hubEvent.findMany({
      where: {
        AND: [this.where(leagues), { OR: [{ homeTeamName: name }, { awayTeamName: name }] }],
      },
      select: {
        homeTeamId: true,
        homeTeamName: true,
        homeTeamBadgeUrl: true,
        awayTeamId: true,
        awayTeamName: true,
        awayTeamBadgeUrl: true,
      },
      orderBy: ORDER,
      take: 200,
    });
    const teams = new Map<string, Result>();
    const needle = query.toLocaleLowerCase();
    for (const row of rows) {
      for (const [id, team, badge] of [
        [row.homeTeamId, row.homeTeamName, row.homeTeamBadgeUrl],
        [row.awayTeamId, row.awayTeamName, row.awayTeamBadgeUrl],
      ]) {
        if (id && team && !teams.has(id) && team.toLocaleLowerCase().includes(needle)) {
          teams.set(id, {
            id,
            name: team,
            entityType: "team",
            ...(badge ? { imageUrl: badge, logoUrl: badge } : {}),
          });
        }
      }
    }
    return [...teams.values()].slice(0, SEARCH_LIMIT);
  }
}
