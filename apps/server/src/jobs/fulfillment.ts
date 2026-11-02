import { BadGatewayException, HttpException } from '@nestjs/common';
import { Prisma, RequestStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { Infrastructure } from '../infrastructure';
import { MetadataItem, MetadataProvider } from '../metadata/provider';
import { parseItem } from '../metadata/hub';
import { ContentManager, ManagerEvent, QueueItem } from '../managers/client';
import { SportarrClient } from '../managers/sportarr';
import { SportarrSettings } from '../settings/sportarr';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const conflict = () => new BadGatewayException({ code: 'REQUEST_METADATA_CHANGED', message: 'Requested metadata identity or scope changed; administrator review is required' });
export function errorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && 'code' in body && typeof body.code === 'string' && /^[A-Z_]+$/.test(body.code)) return body.code;
  }
  return 'INTEGRATION_FAILED';
}
export function imported(event: ManagerEvent): boolean {
  return event.hasFile && event.files.some(file => file.exists === true);
}
export function aggregateStatus(events: { available: boolean; downloading: boolean }[], closed: boolean): RequestStatus {
  if (closed && events.length > 0 && events.every(event => event.available)) return 'AVAILABLE';
  return events.some(event => event.downloading) ? 'DOWNLOADING' : 'APPROVED';
}
export class Fulfillment {
  constructor(private readonly infrastructure: Infrastructure, private readonly metadata: MetadataProvider, private readonly settings: SportarrSettings,
    private readonly managerFactory: (config: Awaited<ReturnType<SportarrSettings['configuration']>>) => ContentManager = config => new SportarrClient(config)) {}
  private async plan(scopeValue: Prisma.JsonValue) {
    const scope = scopeValue as Record<string, unknown>;
    if (!scope || scope.provider !== 'hub' || !['event', 'season'].includes(String(scope.kind))) throw conflict();
    const savedLeague = parseItem(scope.league);
    const league = await this.metadata.league(savedLeague.id);
    if (league.id !== savedLeague.id || !league.shortId || typeof league.sportName !== 'string') throw conflict();
    if (scope.kind === 'event') {
      const saved = parseItem(scope.event);
      const event = await this.metadata.event(saved.id);
      if (event.id !== saved.id || event.leagueId !== league.id) throw conflict();
      return { league, events: [event], closed: true };
    }
    const savedSeason = parseItem(scope.season);
    const season = await this.metadata.season(savedSeason.id);
    if (season.id !== savedSeason.id || season.leagueId !== league.id) throw conflict();
    const events: MetadataItem[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= 10000; page++) {
      const result = await this.metadata.events({ league: league.id, season: season.id, page });
      expectedTotal ??= result.total;
      if (result.total !== expectedTotal || result.page !== page) throw conflict();
      for (const item of result.items) {
        if (item.leagueId !== league.id || item.seasonId !== season.id || seen.has(item.id)) throw conflict();
        seen.add(item.id); events.push(item);
      }
      if (page >= result.totalPages) {
        if (events.length !== expectedTotal) throw conflict();
        const ended = typeof season.endDate === 'string' && Date.parse(season.endDate + 'T23:59:59Z') < Date.now();
        const closed = season.isCurrent === false && ended && events.every(event => event.status === 'completed' || event.status === 'cancelled');
        return { league, events, closed };
      }
      if (!result.items.length) throw conflict();
    }
    throw conflict();
  }
  async run(requestId: string) {
    const { db, redis } = this.infrastructure;
    const request = await db.request.findUnique({ where: { id: requestId } });
    if (!request || !['APPROVED', 'DOWNLOADING', 'AVAILABLE'].includes(request.status)) return;
    let lock: string | undefined;
    const owner = randomUUID();
    let renewal: NodeJS.Timeout | undefined;
    let lost = false;
    try {
      const config = await this.settings.configuration();
      const managerKey = createHash('sha256').update(config.url).digest('hex');
      lock = `pedirr:manager:${managerKey}:lock`;
      if (!await redis.set(lock, owner, 'EX', 45, 'NX')) throw new HttpException({ code: 'MANAGER_BUSY', retryAfterSeconds: 45 }, 503);
      const check = async () => { if (lost || await redis.get(lock!) !== owner) throw new Error('Manager lease lost'); };
      renewal = setInterval(() => {
        void redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],45) end; return 0`, 1, lock!, owner)
          .then(result => { if (!result) lost = true; }).catch(() => { lost = true; });
      }, 10000);
      const plan = await this.plan(request.scope);
      const events = plan.events.filter(event => event.isActive !== false && event.status !== 'cancelled');
      // Validate every identity before allowing any remote write.
      for (const event of events) if (!event.shortId || !/^ev-\d+$/.test(event.shortId) || !event.scheduledStart || !Number.isFinite(Date.parse(event.scheduledStart))) throw conflict();
      const manager = this.managerFactory(config);
      await manager.assertWriteCompatibility();
      await check();
      const league = await manager.ensureLeague({ externalId: plan.league.shortId!, name: plan.league.name, sport: String(plan.league.sportName), rootFolderId: config.rootFolderId, qualityProfileId: config.qualityProfileId });
      const existing = await manager.events(league.id);
      const queue = await manager.queue();
      const results: { available: boolean; downloading: boolean }[] = [];
      for (const event of events) {
        await check();
        const current = await manager.ensureEvent({ externalId: event.shortId!, title: event.name, sport: String(plan.league.sportName), leagueId: league.id, eventDate: event.scheduledStart!, season: typeof event.seasonName === 'string' ? event.seasonName : null, seasonNumber: typeof event.seasonNumber === 'number' ? event.seasonNumber : null, qualityProfileId: config.qualityProfileId }, existing);
        const available = imported(current);
        const activity: QueueItem[] = queue.filter(item => item.eventId === current.id);
        const downloading = activity.some(item => ['Queued', 'Downloading', 'Paused', 'Completed', 'Importing', 'ImportPending', 'ImportWarning', 'Warning'].includes(item.status));
        const progress = available ? 100 : Math.max(0, ...activity.map(item => Math.min(100, Math.max(0, item.progress))));
        await db.requestEvent.upsert({ where: { requestId_externalId: { requestId, externalId: event.id } },
          create: { requestId, externalId: event.id, metadata: json(event), remoteId: current.id, available, progress, checkedAt: new Date() },
          update: { metadata: json(event), remoteId: current.id, available, progress, active: true, checkedAt: new Date() } });
        results.push({ available, downloading });
        if (!available && !downloading && Date.parse(event.scheduledStart!) <= Date.now()) {
          const searchKey = `pedirr:search:${managerKey}:${current.id}`;
          if (await redis.set(searchKey, owner, 'EX', 21600, 'NX')) {
            await check();
            try { await manager.search(current.id); }
            catch (error) { await redis.expire(searchKey, 300); throw error; }
          }
        }
      }
      await check();
      const status = aggregateStatus(results, plan.closed);
      await db.$transaction(async tx => {
        await tx.requestEvent.updateMany({ where: { requestId, externalId: { notIn: events.map(event => event.id) } }, data: { active: false } });
        const updated = await tx.request.updateMany({ where: { id: requestId, version: request.version }, data: { status, integrationState: 'synced', lastError: null, version: { increment: 1 } } });
        if (!updated.count) throw new Error('Request changed during synchronization');
        if (status !== request.status) {
          await tx.requestHistory.create({ data: { requestId, action: 'synchronized', details: { status } } });
          await tx.outboxEvent.create({ data: { type: 'request.status', payload: { requestId, status } } });
        }
      });
    } catch (error) {
      await db.request.updateMany({ where: { id: requestId }, data: { integrationState: 'error', lastError: errorCode(error) } });
      throw error;
    } finally {
      if (renewal) clearInterval(renewal);
      if (lock) await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`, 1, lock, owner);
    }
  }
}
