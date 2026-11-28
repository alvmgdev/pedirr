import { Availability, AvailabilityTarget } from "./availability";
import { canonicalParts, isOptionalPart, partKey, partsRequestStatus } from "./parts";
import { refreshSubscribers } from "./subscribers";
import { isExpired, quota, weeklyLimitReached } from "./quota";
import { planAllows, planNotAllowed, userAccess } from "../plans";
import {
  followersCounted,
  followersInScope,
  followersVisibleTo,
  requestsVisibleTo,
} from "./visibility";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, RequestStatus } from "@prisma/client";
import { Infrastructure } from "../infrastructure";
import { MetadataItem, MetadataProvider } from "../metadata/provider";
import { mayRequestSeasons, Viewer } from "../auth";

export type RequestTarget = { kind: "season" | "event"; identifier: string; parts?: string[] };
export type Moderation = { decision: "approve" | "reject"; version: number; reason?: string };
const seasonRequestsNotAllowed = () =>
  new ForbiddenException({
    code: "SEASON_REQUESTS_NOT_ALLOWED",
    message: "Only administrators can request whole seasons",
  });
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const include = {
  entity: { include: { identifiers: true } },
  parts: {
    select: { name: true, status: true, rejectionReason: true },
    orderBy: { createdAt: "asc" },
  },
} as const;
/** A request as shown, counting only the followers the viewer may know about. */
const shown = (viewer: Pick<Viewer, "id" | "role" | "tenantId">) => ({
  ...include,
  _count: { select: { subscribers: { where: followersCounted(viewer) } } },
});
/**
 * Who asked first and when, among the followers the viewer may see. Users only get the date:
 * never another person's email, nor how many follow.
 */
function requestedBy(
  viewer: Pick<Viewer, "role">,
  first:
    | { createdAt: Date; user: { email: string; tenant: { code: string | null; name: string } } }
    | undefined,
  followers: number,
) {
  if (!first) {
    return null;
  }
  return viewer.role === "USER"
    ? { at: first.createdAt, email: null, environment: null, others: 0 }
    : {
        at: first.createdAt,
        email: first.user.email,
        // Resellers' administrators only ever see their own environment, so it goes unsaid.
        environment: viewer.role === "ADMIN" ? first.user.tenant : null,
        others: Math.max(0, followers - 1),
      };
}
const sameName = (left: string) => (right: { name: string } | string) =>
  partKey(typeof right === "string" ? right : right.name) === partKey(left);
type PartState = "none" | "requested" | "downloading" | "available";

@Injectable()
export class RequestsService {
  constructor(
    private readonly infrastructure: Infrastructure,
    private readonly metadata: MetadataProvider,
    private readonly availability: Availability,
  ) {}
  private async target(input: RequestTarget) {
    if (input.kind === "event") {
      const event = await this.metadata.event(input.identifier);
      if (!event.leagueId || event.isActive === false) {
        throw new BadRequestException({
          code: "INVALID_TARGET",
          message: "Event has no active league association",
        });
      }
      const league = await this.metadata.league(event.leagueId);
      return {
        entity: event,
        kind: "EVENT" as const,
        scopeKey: "event",
        scope: { kind: "event", provider: "hub", event, league },
      };
    }
    const season = await this.metadata.season(input.identifier);
    if (!season.leagueId || season.isActive === false) {
      throw new BadRequestException({
        code: "INVALID_TARGET",
        message: "Season has no active league association",
      });
    }
    const league = await this.metadata.league(season.leagueId);
    return {
      entity: league,
      kind: "LEAGUE" as const,
      scopeKey: `season:hub:${season.id}`,
      scope: { kind: "season", provider: "hub", season, league },
    };
  }
  private async entity(tx: Prisma.TransactionClient, item: MetadataItem, kind: "LEAGUE" | "EVENT") {
    const namespace = `${kind.toLowerCase()}:uuid`;
    const where = { provider_namespace_value: { provider: "hub", namespace, value: item.id } };
    const identity = await tx.externalIdentifier.findUnique({ where });
    const entity = identity
      ? await tx.catalogEntity.update({
          where: { id: identity.entityId },
          data: { title: item.name, metadata: json(item) },
        })
      : await tx.catalogEntity.create({
          data: {
            kind,
            title: item.name,
            metadata: json(item),
            identifiers: { create: { provider: "hub", namespace, value: item.id } },
          },
        });
    // A mirrored TSDB ID remains a separate identity, never an inferred Hub ID.
    for (const [provider, suffix, value] of [
      ["hub", "shortId", item.shortId],
      ["thesportsdb", "id", item.tsdbId],
    ] as const) {
      if (!value) {
        continue;
      }
      const key = { provider, namespace: `${kind.toLowerCase()}:${suffix}`, value };
      const existing = await tx.externalIdentifier.findUnique({
        where: { provider_namespace_value: key },
      });
      if (existing && existing.entityId !== entity.id) {
        throw new ConflictException({
          code: "METADATA_IDENTITY_CONFLICT",
          message: "Metadata identifiers require administrator review",
        });
      }
      await tx.externalIdentifier.upsert({
        where: { provider_namespace_value: key },
        create: { ...key, entityId: entity.id },
        update: {},
      });
    }
    return entity;
  }
  private async existing(target: Awaited<ReturnType<RequestsService["target"]>>) {
    return this.infrastructure.db.request.findFirst({
      where: {
        scopeKey: target.scopeKey,
        entity: {
          identifiers: {
            some: {
              provider: "hub",
              namespace: `${target.kind.toLowerCase()}:uuid`,
              value: target.entity.id,
            },
          },
        },
      },
      include,
    });
  }
  /** Whether what the user may request includes the target's league. */
  private async allowed(userId: string, target: Awaited<ReturnType<RequestsService["target"]>>) {
    return planAllows(await userAccess(this.infrastructure.db, userId), target.scope.league);
  }
  async lookup(input: RequestTarget, viewer: Viewer) {
    const target = await this.target(input);
    // Content outside the plan cannot be requested or followed, whoever asked for it.
    if (!(await this.allowed(viewer.id, target))) {
      return { state: "not_allowed" as const };
    }
    const existing = await this.existing(target);
    if (existing) {
      const [following, known] = await Promise.all([
        this.infrastructure.db.requestSubscriber.findUnique({
          where: { requestId_userId: { requestId: existing.id, userId: viewer.id } },
        }),
        this.infrastructure.db.requestSubscriber.count({
          where: { requestId: existing.id, ...followersVisibleTo(viewer) },
        }),
      ]);
      return {
        state: "requested" as const,
        request: { id: existing.id, status: existing.status },
        // The viewer already follows it: there is nothing to follow, only more parts to ask for.
        subscribed: following !== null,
        // Only requests someone of the viewer's environment follows open for them.
        visible: known > 0,
      };
    }
    return this.availability.check(target.scope as AvailabilityTarget);
  }
  /**
   * Parts offered for a target with Sportarr's defaults and each part's current state. Never
   * reveals who requested a part.
   */
  async partOptions(input: RequestTarget, viewer: Viewer) {
    if (input.kind === "season" && !mayRequestSeasons(viewer)) {
      throw seasonRequestsNotAllowed();
    }
    const target = await this.target(input);
    if (!(await this.allowed(viewer.id, target))) {
      return { supported: false, parts: [] };
    }
    const found = await this.existing(target);
    // A whole-event request already covers every part: there is nothing to choose, only to follow.
    if (found && !found.parts.length) {
      return { supported: false, parts: [] };
    }
    const info = await this.availability.parts(target.scope as AvailabilityTarget);
    if (!info.supported) {
      return { supported: false, parts: [] };
    }
    const existing = found
      ? await this.infrastructure.db.request.findUnique({
          where: { id: found.id },
          include: { parts: true, events: { where: { active: true } } },
        })
      : null;
    const parts = info.parts.map(({ name }) => {
      const events = existing?.events ?? [];
      let state: PartState = "none";
      const reviewed = existing?.parts.find(sameName(name));
      if (reviewed && reviewed.status !== "REJECTED") {
        state = "requested";
      }
      if (
        (info.queued && (info.queued.names.some(sameName(name)) || info.queued.unknown)) ||
        events.some((event) => event.downloadingParts.some(sameName(name)))
      ) {
        state = "downloading";
      }
      if (
        (info.held && (info.held.whole || info.held.names.some(sameName(name)))) ||
        (events.length > 0 &&
          events.every((event) =>
            event.parts.length ? event.availableParts.some(sameName(name)) : event.available,
          ))
      ) {
        state = "available";
      }
      return {
        name,
        optional: isOptionalPart(name),
        selected: info.defaults.some(sameName(name)),
        state,
      };
    });
    return { supported: true, parts };
  }
  async create(input: RequestTarget, viewer: Viewer) {
    if (input.kind === "season" && !mayRequestSeasons(viewer)) {
      throw seasonRequestsNotAllowed();
    }
    const target = await this.target(input);
    let parts: string[] | undefined;
    if (input.parts !== undefined) {
      const info = await this.availability.parts(target.scope as AvailabilityTarget);
      if (!info.supported) {
        throw new BadRequestException({
          code: "PARTS_NOT_SUPPORTED",
          message: "This content cannot be requested by parts",
        });
      }
      parts = canonicalParts(info.parts, input.parts);
      if (!parts?.length) {
        throw new BadRequestException({
          code: "INVALID_PARTS",
          message: "Choose parts offered for this content",
        });
      }
      const held = info.held;
      if (held && (held.whole || parts.every((name) => held.names.some(sameName(name))))) {
        return { created: false, available: true, request: null };
      }
    }
    const existing = await this.existing(target);
    if (!existing) {
      const availability = await this.availability.check(target.scope as AvailabilityTarget);
      if (availability.state === "available") {
        return { created: false, available: true, request: null };
      }
      if (availability.state === "unknown" && availability.reason !== "not_configured") {
        throw new ServiceUnavailableException({
          code: "AVAILABILITY_UNKNOWN",
          message: "Availability could not be verified. Try again before requesting this content.",
        });
      }
    }
    return this.infrastructure.db.$transaction(async (tx) => {
      // Canonical upstream identity serializes aliases and overlapping season requests.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hub:${target.kind}:${target.entity.id}`}))`;
      const user = await tx.user.findUnique({ where: { id: viewer.id } });
      if (!user?.active || isExpired(user)) {
        throw new ForbiddenException();
      }
      // Checked against the stored plan, so a plan change applies at once; following counts too.
      if (!planAllows(await userAccess(tx, user.id), target.scope.league)) {
        throw planNotAllowed();
      }
      if (input.kind === "season" && !mayRequestSeasons(user)) {
        throw seasonRequestsNotAllowed();
      }
      const entity = await this.entity(tx, target.entity, target.kind);
      const existing = await tx.request.findUnique({
        where: { entityId_scopeKey: { entityId: entity.id, scopeKey: target.scopeKey } },
        include: { parts: true },
      });
      const policy = await tx.setting.findUnique({ where: { key: `autoApprove.${user.role}` } });
      const approved = user.autoApprove ?? policy?.value === true;
      if (existing?.parts.length && parts) {
        return this.addParts(tx, existing, user.id, parts, approved, viewer);
      }
      if (existing) {
        if (existing.parts.length) {
          throw new BadRequestException({
            code: "PARTS_REQUIRED",
            message: "Choose the parts to request",
          });
        }
        // A whole-event request already covers every part.
        await tx.requestSubscriber.upsert({
          where: { requestId_userId: { requestId: existing.id, userId: user.id } },
          create: { requestId: existing.id, userId: user.id, status: existing.status },
          update: {},
        });
        return {
          created: false,
          request: await tx.request.findUniqueOrThrow({
            where: { id: existing.id },
            include: shown(viewer),
          }),
        };
      }
      // Only starting a request uses the weekly limit; serialize this user's concurrent ones.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${user.id}`}))`;
      const current = await quota(tx, user.id);
      if (current.remaining === 0) {
        throw weeklyLimitReached(current);
      }
      const status = approved ? "APPROVED" : "PENDING";
      const request = await tx.request.create({
        data: {
          entityId: entity.id,
          scopeKey: target.scopeKey,
          scope: json(target.scope),
          status,
          integrationState: approved ? "queued" : "idle",
          subscribers: {
            create: { userId: user.id, parts: parts ?? [], status, countsTowardQuota: true },
          },
          ...(parts ? { parts: { create: parts.map((name) => ({ name, status })) } } : {}),
          history: {
            create: {
              actorId: user.id,
              action: "created",
              details: { status, autoApproved: approved, ...(parts ? { parts } : {}) },
            },
          },
        },
        include: shown(viewer),
      });
      await tx.outboxEvent.create({
        data: { type: "request.created", payload: { requestId: request.id, status } },
      });
      if (approved) {
        await tx.outboxEvent.create({
          data: {
            type: "request.fulfill",
            payload: { requestId: request.id, version: request.version },
          },
        });
      }
      return { created: true, request };
    });
  }
  /**
   * Adds a user's parts to a request with parts. New parts follow that user's approval policy;
   * a rejected part asked for again returns to review. Parts already pending or approved are
   * shared, so the user simply joins them.
   */
  private async addParts(
    tx: Prisma.TransactionClient,
    existing: Prisma.RequestGetPayload<{ include: { parts: true } }>,
    userId: string,
    parts: string[],
    approved: boolean,
    viewer: Viewer,
  ) {
    const status = approved ? "APPROVED" : "PENDING";
    const added: string[] = [];
    for (const name of parts) {
      const current = existing.parts.find(sameName(name));
      if (!current) {
        await tx.requestPart.create({ data: { requestId: existing.id, name, status } });
        added.push(name);
      } else if (current.status === "REJECTED") {
        await tx.requestPart.update({
          where: { id: current.id },
          data: { status, reviewedBy: null, rejectionReason: null },
        });
        added.push(current.name);
      }
    }
    const subscription = await tx.requestSubscriber.findUnique({
      where: { requestId_userId: { requestId: existing.id, userId } },
    });
    const mine = [...(subscription?.parts ?? [])];
    for (const name of parts) {
      if (!mine.some(sameName(name))) {
        mine.push(name);
      }
    }
    await tx.requestSubscriber.upsert({
      where: { requestId_userId: { requestId: existing.id, userId } },
      create: { requestId: existing.id, userId, parts: mine },
      update: { parts: mine },
    });
    // A newly approved part is not on disk yet, so the request is no longer complete.
    const next = partsRequestStatus(
      await tx.requestPart.findMany({ where: { requestId: existing.id } }),
      approved && added.length && existing.status === "AVAILABLE" ? "APPROVED" : existing.status,
    );
    if (added.length || next !== existing.status) {
      const restart =
        approved && added.length > 0 && ["PENDING", "REJECTED"].includes(existing.status);
      await tx.request.update({
        where: { id: existing.id },
        data: {
          status: next,
          version: { increment: 1 },
          ...(restart ? { integrationState: "queued", rejectionReason: null } : {}),
        },
      });
      await tx.requestHistory.create({
        data: {
          requestId: existing.id,
          actorId: userId,
          action: "parts",
          details: { status: next, parts: added, autoApproved: approved },
        },
      });
      if (added.length && !approved) {
        // Administrators review the new parts; only this user is told about them.
        await tx.outboxEvent.create({
          data: {
            type: "request.created",
            payload: { requestId: existing.id, status: "PENDING", userIds: [userId] },
          },
        });
      }
      if (approved && added.length) {
        await tx.outboxEvent.create({
          data: {
            type: "request.fulfill",
            payload: { requestId: existing.id, version: existing.version + 1 },
          },
        });
      }
    }
    await refreshSubscribers(tx, existing.id);
    return {
      created: false,
      request: await tx.request.findUniqueOrThrow({
        where: { id: existing.id },
        include: shown(viewer),
      }),
    };
  }
  /** The viewer's weekly limit and what is left of it. */
  quota(viewer: Viewer) {
    return quota(this.infrastructure.db, viewer.id);
  }
  async list(
    viewer: Viewer,
    page: number,
    status?: RequestStatus,
    mine = false,
    {
      environment,
      q,
      order = "desc",
    }: { environment?: string; q?: string; order?: "asc" | "desc" } = {},
  ) {
    // Only platform administrators choose an environment; everyone else is limited to theirs.
    const scope = followersInScope(viewer, environment);
    // Personal lists filter on the user's own status; the shared list on the request status,
    // where new parts awaiting review also count as pending.
    const titled: Prisma.RequestWhereInput = q
      ? { entity: { title: { contains: q, mode: "insensitive" } } }
      : {};
    const where: Prisma.RequestWhereInput = mine
      ? {
          AND: [
            { subscribers: { some: { userId: viewer.id, ...(status ? { status } : {}) } } },
            titled,
          ],
        }
      : {
          AND: [
            requestsVisibleTo(viewer),
            viewer.role === "ADMIN" && environment ? { subscribers: { some: scope } } : {},
            titled,
            status === "PENDING"
              ? { OR: [{ status }, { parts: { some: { status: "PENDING" } } }] }
              : { status },
          ],
        };
    const { db } = this.infrastructure;
    const [items, total] = await db.$transaction([
      db.request.findMany({
        where,
        include: {
          ...include,
          _count: { select: { subscribers: { where: followersCounted(viewer, environment) } } },
          subscribers: {
            where: { userId: viewer.id },
            select: { userId: true, parts: true, status: true },
          },
        },
        orderBy: [{ createdAt: order }, { id: "asc" }],
        skip: (page - 1) * 30,
        take: 30,
      }),
      db.request.count({ where }),
    ]);
    // The first follower in scope, per request: the date and the person shown on its card.
    const firsts = new Map(
      (
        await db.requestSubscriber.findMany({
          where: { requestId: { in: items.map((item) => item.id) }, ...scope },
          distinct: ["requestId"],
          orderBy: [{ requestId: "asc" }, { createdAt: "asc" }, { userId: "asc" }],
          select: {
            requestId: true,
            createdAt: true,
            user: { select: { email: true, tenant: { select: { code: true, name: true } } } },
          },
        })
      ).map((first) => [first.requestId, first]),
    );
    return {
      items: items.map(({ subscribers, ...request }) => ({
        ...request,
        requestedBy: requestedBy(viewer, firsts.get(request.id), request._count.subscribers),
        subscribed: subscribers.length > 0,
        subscription: subscribers[0]
          ? { parts: subscribers[0].parts, status: subscribers[0].status }
          : null,
      })),
      total,
      page,
      pageSize: 30,
    };
  }
  async detail(id: string, viewer: Viewer) {
    // A request nobody of the viewer's environment follows does not exist for them.
    const request = await this.infrastructure.db.request.findFirst({
      where: { AND: [{ id }, requestsVisibleTo(viewer)] },
      include: {
        ...shown(viewer),
        // Administrators see the subscribers they may know about; users only themselves.
        subscribers: {
          where: viewer.role === "USER" ? { userId: viewer.id } : followersVisibleTo(viewer),
          select: {
            userId: true,
            parts: true,
            status: true,
            createdAt: true,
            user: { select: { email: true, tenant: { select: { code: true, name: true } } } },
          },
          orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
        },
        events: {
          where: { active: true },
          select: {
            id: true,
            metadata: true,
            available: true,
            progress: true,
            checkedAt: true,
            parts: true,
            availableParts: true,
            downloadingParts: true,
          },
        },
        history: {
          select: { id: true, action: true, details: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!request) {
      throw new NotFoundException({ code: "REQUEST_NOT_FOUND", message: "Request not found" });
    }
    const { subscribers, ...result } = request;
    const own = subscribers.find((subscriber) => subscriber.userId === viewer.id);
    return {
      ...result,
      subscribed: own !== undefined,
      subscription: own ? { parts: own.parts, status: own.status, createdAt: own.createdAt } : null,
      // Who asked for what, so administrators can review and answer (a reseller's administrator
      // for its own clients); never shown to users.
      subscribers:
        viewer.role !== "USER"
          ? subscribers.map((subscriber) => ({
              email: subscriber.user.email,
              // Only platform administrators see several environments, so only they are told.
              environment: viewer.role === "ADMIN" ? subscriber.user.tenant : null,
              parts: subscriber.parts,
              status: subscriber.status,
              createdAt: subscriber.createdAt,
            }))
          : null,
    };
  }
  async moderate(id: string, input: Moderation, viewer: Viewer) {
    if (viewer.role !== "ADMIN") {
      throw new ForbiddenException();
    }
    if (input.decision === "reject" && !input.reason?.trim()) {
      throw new BadRequestException({
        code: "REASON_REQUIRED",
        message: "Provide a rejection reason",
      });
    }
    const changed = () =>
      new ConflictException({
        code: "REQUEST_CHANGED",
        message: "Request changed. Refresh before reviewing it.",
      });
    return this.infrastructure.db.$transaction(async (tx) => {
      const actor = await tx.user.findUnique({ where: { id: viewer.id } });
      if (!actor?.active || actor.role !== "ADMIN") {
        throw new ForbiddenException();
      }
      const decision = input.decision === "approve" ? "APPROVED" : "REJECTED";
      const reason = decision === "REJECTED" ? input.reason!.trim() : null;
      const request = await tx.request.findUnique({ where: { id }, include: { parts: true } });
      if (!request || request.version !== input.version) {
        throw changed();
      }
      if (!request.parts.length) {
        const updated = await tx.request.updateMany({
          where: { id, version: input.version, status: "PENDING" },
          data: {
            status: decision,
            version: { increment: 1 },
            reviewedBy: viewer.id,
            rejectionReason: reason,
            integrationState: decision === "APPROVED" ? "queued" : "idle",
          },
        });
        if (updated.count !== 1) {
          throw changed();
        }
        await tx.requestHistory.create({
          data: {
            requestId: id,
            actorId: viewer.id,
            action: input.decision,
            details: { status: decision, reason },
          },
        });
        await tx.outboxEvent.create({
          data: { type: "request.status", payload: { requestId: id, status: decision } },
        });
      } else {
        // The review covers the parts awaiting it; approved parts keep downloading.
        const pending = request.parts.filter((part) => part.status === "PENDING");
        if (!pending.length) {
          throw changed();
        }
        await tx.requestPart.updateMany({
          where: { requestId: id, status: "PENDING" },
          data: { status: decision, reviewedBy: viewer.id, rejectionReason: reason },
        });
        // Newly approved parts are not on disk yet, so the request is no longer complete.
        const next = partsRequestStatus(
          await tx.requestPart.findMany({ where: { requestId: id } }),
          decision === "APPROVED" && request.status === "AVAILABLE" ? "APPROVED" : request.status,
        );
        const updated = await tx.request.updateMany({
          where: { id, version: input.version },
          data: {
            status: next,
            version: { increment: 1 },
            reviewedBy: viewer.id,
            rejectionReason: next === "REJECTED" ? reason : null,
            ...(decision === "APPROVED" && ["PENDING", "REJECTED"].includes(request.status)
              ? { integrationState: "queued" }
              : {}),
          },
        });
        if (updated.count !== 1) {
          throw changed();
        }
        await tx.requestHistory.create({
          data: {
            requestId: id,
            actorId: viewer.id,
            action: input.decision,
            details: { status: decision, reason, parts: pending.map((part) => part.name) },
          },
        });
      }
      if (decision === "APPROVED") {
        await tx.outboxEvent.create({
          data: { type: "request.fulfill", payload: { requestId: id, version: input.version + 1 } },
        });
      }
      await refreshSubscribers(tx, id);
      return tx.request.findUniqueOrThrow({ where: { id }, include: shown(viewer) });
    });
  }
}
