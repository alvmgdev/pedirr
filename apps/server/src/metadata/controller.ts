import { BadRequestException, Controller, Get, Param, Query, Req } from "@nestjs/common";
import { ApiProperty, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { AuthRequest, AuthService } from "../auth";
import { Infrastructure } from "../infrastructure";
import { MetadataProvider } from "./provider";
import { CatalogAccess } from "./access";
import { Schedule } from "./schedule";
import { planNotAllowed } from "../plans";

export class CatalogPage {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;
}
export class SearchQuery {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q!: string;
}
export class CatalogIdentifier {
  @ApiProperty() @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/) id!: string;
}
export class EventsQuery extends CatalogPage {
  @ApiProperty({ required: false, enum: ["asc", "desc"], default: "asc" })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(["asc", "desc"])
  order?: "asc" | "desc";
  @ApiProperty({ required: false })
  @ValidateIf((_, v) => v !== undefined)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/)
  league?: string;
  @ApiProperty({ required: false })
  @ValidateIf((_, v) => v !== undefined)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/)
  season?: string;
  @ApiProperty({ required: false })
  @ValidateIf((_, v) => v !== undefined)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/)
  team?: string;
  @ApiProperty({ required: false, format: "date" })
  @ValidateIf((_, v) => v !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  from?: string;
  @ApiProperty({ required: false, format: "date" })
  @ValidateIf((_, v) => v !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  to?: string;
}

@ApiTags("Discovery")
@Controller("catalog")
export class CatalogController {
  constructor(
    private readonly metadata: MetadataProvider,
    private readonly auth: AuthService,
    private readonly infrastructure: Infrastructure,
    private readonly access: CatalogAccess,
    private readonly schedule: Schedule,
  ) {}
  /** Fails like a request outside the plan would, so pages say why instead of "not found". */
  private async requireLeague(req: AuthRequest, league: string | null | undefined) {
    if (!(await this.access.allowsLeague(await this.access.scope(req.viewer!), league))) {
      throw planNotAllowed();
    }
  }
  private limit(req: AuthRequest) {
    return this.auth.rate(`catalog:${req.viewer!.id}`, 90, 60);
  }
  @Get("search") async search(@Query() query: SearchQuery, @Req() req: AuthRequest) {
    await this.limit(req);
    const scope = await this.access.scope(req.viewer!);
    if (!scope) {
      return this.metadata.search(query.q);
    }
    // Hub search results carry no league or sport, so users on a plan search the league index
    // and the local schedule for the events of those leagues and the teams playing them.
    const [leagues, allowed] = await Promise.all([
      this.access.searchLeagues(scope, query.q),
      this.access.leagueIds(scope),
    ]);
    const results = [...leagues.results, ...(await this.schedule.search(allowed, query.q))];
    return { query: query.q, total: results.length, results };
  }
  @Get("leagues") async leagues(@Query() query: CatalogPage, @Req() req: AuthRequest) {
    await this.limit(req);
    const scope = await this.access.scope(req.viewer!);
    return scope ? this.access.leaguePage(scope, query.page) : this.metadata.leagues(query.page);
  }
  @Get("leagues/:id") async league(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req);
    const league = await this.metadata.league(params.id);
    if (!this.access.includes(await this.access.scope(req.viewer!), league)) {
      throw planNotAllowed();
    }
    return league;
  }
  @Get("leagues/:id/seasons") async seasons(
    @Param() params: CatalogIdentifier,
    @Query() query: CatalogPage,
    @Req() req: AuthRequest,
  ) {
    await this.limit(req);
    await this.requireLeague(req, params.id);
    return this.metadata.seasons(params.id, query.page);
  }
  @Get("seasons/:id") async season(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req);
    const season = await this.metadata.season(params.id);
    await this.requireLeague(req, season.leagueId);
    return season;
  }
  @Get("teams/:id") async team(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req);
    return this.metadata.team(params.id);
  }
  @Get("events") async events(@Query() query: EventsQuery, @Req() req: AuthRequest) {
    await this.limit(req);
    if (query.from && query.to && query.from > query.to) {
      throw new BadRequestException({
        code: "INVALID_DATE_RANGE",
        message: "Start date must precede end date",
      });
    }
    const scope = await this.access.scope(req.viewer!);
    if (scope && query.league) {
      await this.requireLeague(req, query.league);
    }
    if (scope && query.season) {
      await this.requireLeague(req, (await this.metadata.season(query.season)).leagueId);
    }
    const result = await this.metadata.events(query);
    if (!scope || query.league || query.season) {
      return result;
    }
    // A team plays in several leagues; keep the events of leagues in the plan.
    const leagues = await this.access.leagueIds(scope);
    return { ...result, items: result.items.filter((item) => leagues.has(item.leagueId ?? "")) };
  }
  @Get("events/:id") async event(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req);
    const event = await this.metadata.event(params.id);
    await this.requireLeague(req, event.leagueId);
    return event;
  }
  @Get("upcoming") async upcoming(@Query() query: CatalogPage, @Req() req: AuthRequest) {
    await this.limit(req);
    const scope = await this.access.scope(req.viewer!);
    return this.schedule.upcoming(scope ? await this.access.leagueIds(scope) : null, query.page);
  }
  @Get("popular") async popular(@Req() req: AuthRequest) {
    await this.limit(req);
    const groups = await this.infrastructure.db.request.groupBy({
      by: ["entityId"],
      where: { entity: { kind: "LEAGUE" }, status: { not: "REJECTED" } },
      _count: { _all: true },
      orderBy: { _count: { entityId: "desc" } },
      take: 12,
    });
    const entities = await this.infrastructure.db.catalogEntity.findMany({
      where: { id: { in: groups.map((group) => group.entityId) } },
      include: { identifiers: true },
    });
    const scope = await this.access.scope(req.viewer!);
    return {
      basis: "local-requests",
      items: groups
        .filter((group) => {
          const entity = entities.find((item) => item.id === group.entityId);
          return entity && this.access.includes(scope, entity.metadata as { id: string });
        })
        .map((group) => ({
          ...entities.find((entity) => entity.id === group.entityId)!,
          requestCount: group._count._all,
        })),
    };
  }
}
