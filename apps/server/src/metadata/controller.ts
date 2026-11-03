import { BadRequestException, Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { AuthRequest, AuthService } from '../auth';
import { Infrastructure } from '../infrastructure';
import { MetadataProvider } from './provider';

export class CatalogPage {
  @ApiProperty({ required: false, default: 1 }) @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
}
export class SearchQuery {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(2) @MaxLength(100) q!: string;
}
export class CatalogIdentifier {
  @ApiProperty() @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/) id!: string;
}
export class EventsQuery extends CatalogPage {
  @ApiProperty({ required: false, enum: ['asc', 'desc'], default: 'asc' }) @ValidateIf((_, v) => v !== undefined) @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @ApiProperty({ required: false }) @ValidateIf((_, v) => v !== undefined) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/) league?: string;
  @ApiProperty({ required: false }) @ValidateIf((_, v) => v !== undefined) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/) season?: string;
  @ApiProperty({ required: false }) @ValidateIf((_, v) => v !== undefined) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/) team?: string;
  @ApiProperty({ required: false, format: 'date' }) @ValidateIf((_, v) => v !== undefined) @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) from?: string;
  @ApiProperty({ required: false, format: 'date' }) @ValidateIf((_, v) => v !== undefined) @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) to?: string;
}

@ApiTags('Discovery') @Controller('catalog')
export class CatalogController {
  constructor(private readonly metadata: MetadataProvider, private readonly auth: AuthService, private readonly infrastructure: Infrastructure) {}
  private limit(req: AuthRequest) { return this.auth.rate(`catalog:${req.viewer!.id}`, 90, 60); }
  @Get('search') async search(@Query() query: SearchQuery, @Req() req: AuthRequest) {
    await this.limit(req); return this.metadata.search(query.q);
  }
  @Get('leagues') async leagues(@Query() query: CatalogPage, @Req() req: AuthRequest) {
    await this.limit(req); return this.metadata.leagues(query.page);
  }
  @Get('leagues/:id') async league(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req); return this.metadata.league(params.id);
  }
  @Get('leagues/:id/seasons') async seasons(@Param() params: CatalogIdentifier, @Query() query: CatalogPage, @Req() req: AuthRequest) {
    await this.limit(req); return this.metadata.seasons(params.id, query.page);
  }
  @Get('seasons/:id') async season(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req); return this.metadata.season(params.id);
  }
  @Get('teams/:id') async team(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req); return this.metadata.team(params.id);
  }
  @Get('events') async events(@Query() query: EventsQuery, @Req() req: AuthRequest) {
    await this.limit(req);
    if (query.from && query.to && query.from > query.to) throw new BadRequestException({ code: 'INVALID_DATE_RANGE', message: 'Start date must precede end date' });
    return this.metadata.events(query);
  }
  @Get('events/:id') async event(@Param() params: CatalogIdentifier, @Req() req: AuthRequest) {
    await this.limit(req); return this.metadata.event(params.id);
  }
  @Get('upcoming') async upcoming(@Query() query: CatalogPage, @Req() req: AuthRequest) {
    await this.limit(req);
    const now = Date.now();
    // Retain the broadcast-date margin while skipping past-only pages server-side.
    const from = new Date(now - 86400000).toISOString().slice(0, 10);
    const to = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
    // Skip exhausted pages without claiming that a partially scanned schedule is empty.
    for (let page = query.page; page < query.page + 5; page++) {
      const result = await this.metadata.events({ from, to, page, pageSize: 100 });
      const items = result.items.filter(item => item.scheduledStart && Date.parse(item.scheduledStart) >= now && Date.parse(item.scheduledStart) <= now + 7 * 86400000 && item.status !== 'cancelled' && item.isActive !== false);
      const hasMore = result.page < result.totalPages;
      if (items.length || !hasMore || page === query.page + 4) {
        return { items, page: result.page, hasMore, nextPage: hasMore ? result.page + 1 : null };
      }
    }
    throw new Error('Unreachable upcoming pagination');
  }
  @Get('popular') async popular(@Req() req: AuthRequest) {
    await this.limit(req);
    const groups = await this.infrastructure.db.request.groupBy({ by: ['entityId'], where: { entity: { kind: 'LEAGUE' }, status: { not: 'REJECTED' } }, _count: { _all: true }, orderBy: { _count: { entityId: 'desc' } }, take: 12 });
    const entities = await this.infrastructure.db.catalogEntity.findMany({ where: { id: { in: groups.map(group => group.entityId) } }, include: { identifiers: true } });
    return { basis: 'local-requests', items: groups.map(group => ({ ...entities.find(entity => entity.id === group.entityId)!, requestCount: group._count._all })) };
  }
}
