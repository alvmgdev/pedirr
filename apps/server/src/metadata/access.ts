import { Injectable } from "@nestjs/common";
import { Viewer } from "../auth";
import { Infrastructure } from "../infrastructure";
import { userAccess } from "../plans";
import { MetadataItem, MetadataPage, MetadataSearch } from "./provider";
import { MetadataProvider } from "./provider";

/** What a user on a plan may see: league grants by Hub ID and sport grants by Hub sport ID. */
export type PlanScope = { leagues: Set<string>; sports: Set<string> };
const LEAGUE_PAGE_SIZE = 30;
const leagueFields = {
  id: true,
  shortId: true,
  name: true,
  sportId: true,
  sportName: true,
  country: true,
  logoUrl: true,
} as const;

/**
 * Narrows the catalog to a user's plan. Hub cannot filter by several leagues or sports, and its
 * search results do not say which sport a league belongs to, so listings for users on a plan come
 * from the daily league index, and single leagues are checked exactly (asking Hub when a league
 * is not indexed yet). Administrators and users without a restrictive plan see everything.
 */
@Injectable()
export class CatalogAccess {
  constructor(
    private readonly infrastructure: Infrastructure,
    private readonly metadata: MetadataProvider,
  ) {}
  /** The viewer's plan as sets, or null when nothing is restricted. */
  async scope(viewer: Viewer): Promise<PlanScope | null> {
    if (viewer.role === "ADMIN") {
      return null;
    }
    const plan = await userAccess(this.infrastructure.db, viewer.id);
    if (!plan || plan.allContent) {
      return null;
    }
    const ids = (kind: string) =>
      new Set(plan.grants.filter((grant) => grant.kind === kind).map((grant) => grant.hubId));
    return { leagues: ids("LEAGUE"), sports: ids("SPORT") };
  }
  /** Every league ID the plan reaches according to the index, plus its league grants. */
  async leagueIds(scope: PlanScope) {
    const rows = scope.sports.size
      ? await this.infrastructure.db.hubLeague.findMany({
          where: { sportId: { in: [...scope.sports] } },
          select: { id: true },
        })
      : [];
    return new Set([...scope.leagues, ...rows.map((row) => row.id)]);
  }
  /** Whether a known league (with its sport) is in the plan. */
  includes(scope: PlanScope | null, league: { id: string; sportId?: unknown }) {
    return (
      !scope ||
      scope.leagues.has(league.id) ||
      (typeof league.sportId === "string" && scope.sports.has(league.sportId))
    );
  }
  /** Exact check for a league given by Hub UUID or short ID. */
  async allowsLeague(scope: PlanScope | null, identifier: string | null | undefined) {
    if (!scope) {
      return true;
    }
    if (!identifier) {
      return false;
    }
    if (scope.leagues.has(identifier)) {
      return true;
    }
    const row = await this.infrastructure.db.hubLeague.findFirst({
      where: { OR: [{ id: identifier }, { shortId: identifier }] },
      select: { id: true, sportId: true },
    });
    return this.includes(scope, row ?? (await this.metadata.league(identifier)));
  }
  /** Leagues of the plan whose name matches, shaped like Hub search results. */
  async searchLeagues(scope: PlanScope, query: string): Promise<MetadataSearch> {
    const rows = await this.infrastructure.db.hubLeague.findMany({
      where: {
        AND: [
          this.where(scope),
          {
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { shortId: { equals: query, mode: "insensitive" } },
            ],
          },
        ],
      },
      select: leagueFields,
      orderBy: { name: "asc" },
      take: 20,
    });
    return {
      query,
      total: rows.length,
      results: rows.map((row) => ({ ...this.item(row), entityType: "league" as const })),
    };
  }
  /** A page of the plan's leagues, shaped like Hub's league list. */
  async leaguePage(scope: PlanScope, page: number): Promise<MetadataPage> {
    const where = this.where(scope);
    const [rows, total] = await this.infrastructure.db.$transaction([
      this.infrastructure.db.hubLeague.findMany({
        where,
        select: leagueFields,
        orderBy: { name: "asc" },
        skip: (page - 1) * LEAGUE_PAGE_SIZE,
        take: LEAGUE_PAGE_SIZE,
      }),
      this.infrastructure.db.hubLeague.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.item(row)),
      total,
      page,
      pageSize: LEAGUE_PAGE_SIZE,
      totalPages: Math.ceil(total / LEAGUE_PAGE_SIZE),
    };
  }
  private where(scope: PlanScope) {
    return {
      OR: [{ id: { in: [...scope.leagues] } }, { sportId: { in: [...scope.sports] } }],
    };
  }
  private item(row: {
    id: string;
    shortId: string | null;
    name: string;
    sportId: string | null;
    sportName: string | null;
    country: string | null;
    logoUrl: string | null;
  }): MetadataItem {
    return {
      id: row.id,
      name: row.name,
      shortId: row.shortId,
      sportId: row.sportId,
      sportName: row.sportName,
      country: row.country,
      logoUrl: row.logoUrl,
      imageUrl: row.logoUrl,
    };
  }
}
