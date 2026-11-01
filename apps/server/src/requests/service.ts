import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RequestStatus } from '@prisma/client';
import { Infrastructure } from '../infrastructure';
import { MetadataItem, MetadataProvider } from '../metadata/provider';
import { Viewer } from '../auth';

export type RequestTarget = { kind: 'season' | 'event'; identifier: string };
export type Moderation = { decision: 'approve' | 'reject'; version: number; reason?: string };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const include = { entity: { include: { identifiers: true } }, _count: { select: { subscribers: true } } } as const;

@Injectable()
export class RequestsService {
  constructor(private readonly infrastructure: Infrastructure, private readonly metadata: MetadataProvider) {}
  private async target(input: RequestTarget) {
    if (input.kind === 'event') {
      const event = await this.metadata.event(input.identifier);
      if (!event.leagueId || event.isActive === false) throw new BadRequestException({ code: 'INVALID_TARGET', message: 'Event has no active league association' });
      const league = await this.metadata.league(event.leagueId);
      return { entity: event, kind: 'EVENT' as const, scopeKey: 'event', scope: { kind: 'event', provider: 'hub', event, league } };
    }
    const season = await this.metadata.season(input.identifier);
    if (!season.leagueId || season.isActive === false) throw new BadRequestException({ code: 'INVALID_TARGET', message: 'Season has no active league association' });
    const league = await this.metadata.league(season.leagueId);
    return { entity: league, kind: 'LEAGUE' as const, scopeKey: `season:hub:${season.id}`, scope: { kind: 'season', provider: 'hub', season, league } };
  }
  private async entity(tx: Prisma.TransactionClient, item: MetadataItem, kind: 'LEAGUE' | 'EVENT') {
    const namespace = `${kind.toLowerCase()}:uuid`;
    const where = { provider_namespace_value: { provider: 'hub', namespace, value: item.id } };
    const identity = await tx.externalIdentifier.findUnique({ where });
    const entity = identity
      ? await tx.catalogEntity.update({ where: { id: identity.entityId }, data: { title: item.name, metadata: json(item) } })
      : await tx.catalogEntity.create({ data: { kind, title: item.name, metadata: json(item), identifiers: { create: { provider: 'hub', namespace, value: item.id } } } });
    // A mirrored TSDB ID remains a separate identity, never an inferred Hub ID.
    for (const [provider, suffix, value] of [['hub', 'shortId', item.shortId], ['thesportsdb', 'id', item.tsdbId]] as const) {
      if (!value) continue;
      const key = { provider, namespace: `${kind.toLowerCase()}:${suffix}`, value };
      const existing = await tx.externalIdentifier.findUnique({ where: { provider_namespace_value: key } });
      if (existing && existing.entityId !== entity.id) throw new ConflictException({ code: 'METADATA_IDENTITY_CONFLICT', message: 'Metadata identifiers require administrator review' });
      await tx.externalIdentifier.upsert({ where: { provider_namespace_value: key }, create: { ...key, entityId: entity.id }, update: {} });
    }
    return entity;
  }
  async create(input: RequestTarget, viewer: Viewer) {
    const target = await this.target(input);
    return this.infrastructure.db.$transaction(async tx => {
      // Canonical upstream identity serializes aliases and overlapping season requests.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hub:${target.kind}:${target.entity.id}`}))`;
      const user = await tx.user.findUnique({ where: { id: viewer.id } });
      if (!user?.active) throw new ForbiddenException();
      const entity = await this.entity(tx, target.entity, target.kind);
      const existing = await tx.request.findUnique({ where: { entityId_scopeKey: { entityId: entity.id, scopeKey: target.scopeKey } } });
      if (existing) {
        await tx.requestSubscriber.upsert({ where: { requestId_userId: { requestId: existing.id, userId: user.id } }, create: { requestId: existing.id, userId: user.id }, update: {} });
        return { created: false, request: await tx.request.findUniqueOrThrow({ where: { id: existing.id }, include }) };
      }
      const policy = await tx.setting.findUnique({ where: { key: `autoApprove.${user.role}` } });
      const approved = user.autoApprove ?? policy?.value === true;
      const status = approved ? 'APPROVED' : 'PENDING';
      const request = await tx.request.create({ data: {
        entityId: entity.id, scopeKey: target.scopeKey, scope: json(target.scope), status,
        integrationState: approved ? 'queued' : 'idle',
        subscribers: { create: { userId: user.id } },
        history: { create: { actorId: user.id, action: 'created', details: { status, autoApproved: approved } } },
      }, include });
      await tx.outboxEvent.create({ data: { type: 'request.created', payload: { requestId: request.id, status } } });
      if (approved) await tx.outboxEvent.create({ data: { type: 'request.fulfill', payload: { requestId: request.id, version: request.version } } });
      return { created: true, request };
    });
  }
  async list(viewer: Viewer, page: number, status?: RequestStatus, mine = false) {
    const where: Prisma.RequestWhereInput = { status, ...(mine ? { subscribers: { some: { userId: viewer.id } } } : {}) };
    const [items, total] = await this.infrastructure.db.$transaction([
      this.infrastructure.db.request.findMany({ where, include: { ...include, subscribers: { where: { userId: viewer.id }, select: { userId: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * 30, take: 30 }),
      this.infrastructure.db.request.count({ where }),
    ]);
    return { items: items.map(({ subscribers, ...request }) => ({ ...request, subscribed: subscribers.length > 0 })), total, page, pageSize: 30 };
  }
  async detail(id: string, viewer: Viewer) {
    const request = await this.infrastructure.db.request.findUnique({ where: { id }, include: { ...include, subscribers: { where: { userId: viewer.id }, select: { userId: true } }, history: { select: { id: true, action: true, details: true, createdAt: true }, orderBy: { createdAt: 'asc' } } } });
    if (!request) throw new NotFoundException({ code: 'REQUEST_NOT_FOUND', message: 'Request not found' });
    const { subscribers, ...result } = request;
    return { ...result, subscribed: subscribers.length > 0 };
  }
  async moderate(id: string, input: Moderation, viewer: Viewer) {
    if (viewer.role !== 'ADMIN') throw new ForbiddenException();
    if (input.decision === 'reject' && !input.reason?.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'Provide a rejection reason' });
    return this.infrastructure.db.$transaction(async tx => {
      const actor = await tx.user.findUnique({ where: { id: viewer.id } });
      if (!actor?.active || actor.role !== 'ADMIN') throw new ForbiddenException();
      const status = input.decision === 'approve' ? 'APPROVED' : 'REJECTED';
      const updated = await tx.request.updateMany({ where: { id, version: input.version, status: 'PENDING' }, data: {
        status, version: { increment: 1 }, reviewedBy: viewer.id,
        rejectionReason: status === 'REJECTED' ? input.reason!.trim() : null,
        integrationState: status === 'APPROVED' ? 'queued' : 'idle',
      } });
      if (updated.count !== 1) throw new ConflictException({ code: 'REQUEST_CHANGED', message: 'Request changed. Refresh before reviewing it.' });
      await tx.requestHistory.create({ data: { requestId: id, actorId: viewer.id, action: input.decision, details: { status, reason: status === 'REJECTED' ? input.reason!.trim() : null } } });
      await tx.outboxEvent.create({ data: { type: 'request.status', payload: { requestId: id, status } } });
      if (status === 'APPROVED') await tx.outboxEvent.create({ data: { type: 'request.fulfill', payload: { requestId: id, version: input.version + 1 } } });
      return tx.request.findUniqueOrThrow({ where: { id }, include });
    });
  }
}
