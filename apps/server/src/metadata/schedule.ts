import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Infrastructure } from "../infrastructure";
import { scheduleCompletedAt } from "../jobs/schedule-index";
import { MetadataItem } from "./provider";

const WEEK = 7 * 86400000;
/** A copy older than this is not trusted; the schedule then comes from Hub as before. */
const MAX_AGE = 2 * 86400000;
export const SCHEDULE_PAGE_SIZE = 60;
const SEARCH_LIMIT = 20;
type Item = MetadataItem & { entityType?: "league" | "team" | "event" };

/**
 * Answers from the local copy of Hub's schedule (7 days back to 14 ahead), where events can be
 * paged and filtered by league in one query. `leagues` null means every league.
 */
@Injectable()
export class LocalSchedule {
  constructor(private readonly infrastructure: Infrastructure) {}
  /** Whether a complete copy finished recently enough to be used. */
  async ready(now = Date.now()) {
    const at = await scheduleCompletedAt(this.infrastructure);
    return at !== undefined && now - at <= MAX_AGE;
  }
  private where(leagues: Set<string> | null): Prisma.HubEventWhereInput {
    return {
      isActive: true,
      // A null status is not "cancelled"; a plain `not` would also drop it.
      OR: [{ status: null }, { status: { not: "cancelled" } }],
      ...(leagues ? { leagueId: { in: [...leagues] } } : {}),
    };
  }
  /** Events starting in the next seven days, soonest first. */
  async upcoming(leagues: Set<string> | null, page: number, now = Date.now()) {
    const rows = await this.infrastructure.db.hubEvent.findMany({
      where: {
        ...this.where(leagues),
        scheduledStart: { gte: new Date(now), lte: new Date(now + WEEK) },
      },
      select: { item: true },
      orderBy: [{ scheduledStart: "asc" }, { id: "asc" }],
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
  /** Events in the copy whose name matches, oldest first. */
  async searchEvents(leagues: Set<string> | null, query: string): Promise<Item[]> {
    const rows = await this.infrastructure.db.hubEvent.findMany({
      where: { ...this.where(leagues), name: { contains: query, mode: "insensitive" } },
      select: { item: true },
      orderBy: [{ scheduledStart: "asc" }, { id: "asc" }],
      take: SEARCH_LIMIT,
    });
    return rows.map((row) => ({ ...(row.item as MetadataItem), entityType: "event" as const }));
  }
  /** Teams playing an event in the copy whose name matches. */
  async searchTeams(leagues: Set<string> | null, query: string): Promise<Item[]> {
    const name = { contains: query, mode: "insensitive" as const };
    const rows = await this.infrastructure.db.hubEvent.findMany({
      where: {
        AND: [this.where(leagues), { OR: [{ homeTeamName: name }, { awayTeamName: name }] }],
      },
      select: {
        homeTeamId: true,
        homeTeamName: true,
        awayTeamId: true,
        awayTeamName: true,
        item: true,
      },
      orderBy: [{ scheduledStart: "asc" }, { id: "asc" }],
      take: 200,
    });
    const teams = new Map<string, Item>();
    const needle = query.toLocaleLowerCase();
    for (const row of rows) {
      const item = row.item as Record<string, unknown>;
      for (const [id, team, badge] of [
        [row.homeTeamId, row.homeTeamName, item.homeTeamBadgeUrl],
        [row.awayTeamId, row.awayTeamName, item.awayTeamBadgeUrl],
      ] as const) {
        if (id && team && !teams.has(id) && team.toLocaleLowerCase().includes(needle)) {
          teams.set(id, {
            id,
            name: team,
            entityType: "team",
            ...(typeof badge === "string" ? { imageUrl: badge, logoUrl: badge } : {}),
          });
        }
      }
    }
    return [...teams.values()].slice(0, SEARCH_LIMIT);
  }
}
