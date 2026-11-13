import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { IssueCategory, IssueStatus, Prisma } from "@prisma/client";
import { Viewer } from "../auth";
import { Infrastructure } from "../infrastructure";
import { partKey } from "../requests/parts";
import { canChangeStatus, requiresComment, resolvedAtFor } from "./rules";

export type IssueInput = {
  category: IssueCategory;
  description: string;
  eventId?: string;
  part?: string;
};
export type IssueQuery = {
  page: number;
  status?: IssueStatus;
  category?: IssueCategory;
  mine?: boolean;
  requestId?: string;
};
const notFound = () =>
  new NotFoundException({ code: "ISSUE_NOT_FOUND", message: "Issue not found" });
const issueInclude = {
  request: { include: { entity: true } },
  requestEvent: { select: { id: true, metadata: true } },
  reporter: { select: { id: true, email: true } },
  _count: { select: { comments: true } },
} satisfies Prisma.IssueInclude;
type IssueRecord = Prisma.IssueGetPayload<{ include: typeof issueInclude }>;

@Injectable()
export class IssuesService {
  constructor(private readonly infrastructure: Infrastructure) {}

  /**
   * Only the reporter and administrators may see an issue. Everyone else gets the same answer
   * as for an issue that does not exist.
   */
  private visible(viewer: Viewer): Prisma.IssueWhereInput {
    return viewer.role === "ADMIN" ? {} : { reporterId: viewer.id };
  }

  private view(issue: IssueRecord, viewer: Viewer) {
    const scope = issue.request.scope as { kind?: string; season?: { name?: string } };
    const event = issue.requestEvent?.metadata as { name?: string } | undefined;
    return {
      id: issue.id,
      status: issue.status,
      category: issue.category,
      part: issue.part,
      description: issue.description,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      resolvedAt: issue.resolvedAt,
      mine: issue.reporterId === viewer.id,
      // Administrators need to know who reported it; the reporter already knows.
      reporter: viewer.role === "ADMIN" ? issue.reporter : null,
      request: {
        id: issue.request.id,
        title: issue.request.entity.title,
        kind: scope.kind === "season" ? "season" : "event",
        season: scope.season?.name ?? null,
      },
      event: issue.requestEvent ? { id: issue.requestEvent.id, name: event?.name ?? null } : null,
      comments: issue._count.comments,
    };
  }

  async create(requestId: string, input: IssueInput, viewer: Viewer) {
    const description = input.description.trim();
    if (!description) {
      throw new BadRequestException({
        code: "DESCRIPTION_REQUIRED",
        message: "Describe the problem",
      });
    }
    return this.infrastructure.db.$transaction(async (tx) => {
      // Serialize a user's reports so the duplicate check cannot race.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issue:${viewer.id}`}))`;
      const user = await tx.user.findUnique({ where: { id: viewer.id } });
      if (!user?.active) {
        throw new ForbiddenException();
      }
      const request = await tx.request.findUnique({
        where: { id: requestId },
        include: {
          parts: true,
          events: true,
          subscribers: { where: { userId: user.id } },
        },
      });
      // Content the user does not follow is reported only by administrators.
      if (!request || (user.role !== "ADMIN" && !request.subscribers.length)) {
        throw new NotFoundException({ code: "REQUEST_NOT_FOUND", message: "Request not found" });
      }
      const event = input.eventId
        ? request.events.find((item) => item.id === input.eventId)
        : undefined;
      if (input.eventId && !event) {
        throw new BadRequestException({
          code: "INVALID_ISSUE_TARGET",
          message: "Choose an event of this request",
        });
      }
      let part: string | null = null;
      if (input.part !== undefined) {
        const known = [
          ...request.parts.map((item) => item.name),
          ...(event ? event.parts : request.events.flatMap((item) => item.parts)),
        ];
        part = known.find((name) => partKey(name) === partKey(input.part)) ?? null;
        if (!part) {
          throw new BadRequestException({
            code: "INVALID_ISSUE_TARGET",
            message: "Choose a part of this request",
          });
        }
      }
      const duplicate = await tx.issue.findFirst({
        where: {
          requestId,
          reporterId: user.id,
          category: input.category,
          requestEventId: event?.id ?? null,
          part,
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
      });
      if (duplicate) {
        throw new ConflictException({
          code: "ISSUE_EXISTS",
          message: "You already reported this problem",
          issueId: duplicate.id,
        });
      }
      const issue = await tx.issue.create({
        data: {
          requestId,
          reporterId: user.id,
          requestEventId: event?.id ?? null,
          part,
          category: input.category,
          description,
        },
        include: issueInclude,
      });
      await tx.outboxEvent.create({
        data: { type: "issue.created", payload: { issueId: issue.id, actorId: user.id } },
      });
      return this.view(issue, viewer);
    });
  }

  async list(viewer: Viewer, query: IssueQuery) {
    const where: Prisma.IssueWhereInput = {
      ...this.visible(viewer),
      ...(query.mine ? { reporterId: viewer.id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.requestId ? { requestId: query.requestId } : {}),
    };
    const { db } = this.infrastructure;
    const [items, total] = await db.$transaction([
      db.issue.findMany({
        where,
        include: issueInclude,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip: (query.page - 1) * 30,
        take: 30,
      }),
      db.issue.count({ where }),
    ]);
    return {
      items: items.map((issue) => this.view(issue, viewer)),
      total,
      page: query.page,
      pageSize: 30,
    };
  }

  /** Issues waiting for attention: all open ones for administrators, the user's active ones. */
  async open(viewer: Viewer) {
    const count = await this.infrastructure.db.issue.count({
      where:
        viewer.role === "ADMIN"
          ? { status: "OPEN" }
          : { reporterId: viewer.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
    });
    return { open: count };
  }

  async detail(id: string, viewer: Viewer) {
    const issue = await this.infrastructure.db.issue.findFirst({
      where: { id, ...this.visible(viewer) },
      include: {
        ...issueInclude,
        comments: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          include: { author: { select: { id: true, email: true, role: true } } },
        },
      },
    });
    if (!issue) {
      throw notFound();
    }
    return {
      ...this.view(issue, viewer),
      timeline: issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        status: comment.status,
        createdAt: comment.createdAt,
        author: comment.author
          ? {
              role: comment.author.role,
              mine: comment.author.id === viewer.id,
              // Users see "Administrator"; administrators see who wrote it.
              email: viewer.role === "ADMIN" ? comment.author.email : null,
            }
          : null,
      })),
    };
  }

  async comment(id: string, body: string, viewer: Viewer) {
    const text = body.trim();
    if (!text) {
      throw new BadRequestException({ code: "COMMENT_REQUIRED", message: "Write a comment" });
    }
    return this.change(id, viewer, async (tx, issue, actor) => {
      await tx.issueComment.create({ data: { issueId: id, authorId: viewer.id, body: text } });
      await tx.issue.update({ where: { id }, data: { updatedAt: new Date() } });
      await tx.outboxEvent.create({
        data: {
          type: "issue.updated",
          payload: {
            issueId: id,
            status: "COMMENT",
            audience: actor === "ADMIN" ? "reporter" : "admins",
            actorId: viewer.id,
          },
        },
      });
      return issue;
    });
  }

  async changeStatus(id: string, input: { status: IssueStatus; comment?: string }, viewer: Viewer) {
    const text = input.comment?.trim() || null;
    return this.change(id, viewer, async (tx, issue, actor) => {
      if (!canChangeStatus(actor, issue.status, input.status)) {
        throw new ConflictException({
          code: "ISSUE_STATUS_NOT_ALLOWED",
          message: "This status change is not allowed",
        });
      }
      if (requiresComment(input.status) && !text) {
        throw new BadRequestException({
          code: "COMMENT_REQUIRED",
          message: "Explain how the problem was resolved",
        });
      }
      await tx.issueComment.create({
        data: { issueId: id, authorId: viewer.id, body: text, status: input.status },
      });
      await tx.issue.update({
        where: { id },
        data: { status: input.status, resolvedAt: resolvedAtFor(input.status) },
      });
      await tx.outboxEvent.create({
        data: {
          type: "issue.updated",
          payload: {
            issueId: id,
            status: input.status,
            audience: actor === "ADMIN" ? "reporter" : "admins",
            actorId: viewer.id,
          },
        },
      });
      return issue;
    });
  }

  /** Runs a change on an issue the viewer can act on, serialized per issue. */
  private async change(
    id: string,
    viewer: Viewer,
    apply: (
      tx: Prisma.TransactionClient,
      issue: { status: IssueStatus },
      actor: "ADMIN" | "REPORTER",
    ) => Promise<unknown>,
  ) {
    await this.infrastructure.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issue:${id}`}))`;
      const user = await tx.user.findUnique({ where: { id: viewer.id } });
      if (!user?.active) {
        throw new ForbiddenException();
      }
      const issue = await tx.issue.findUnique({ where: { id } });
      const admin = user.role === "ADMIN";
      if (!issue || (!admin && issue.reporterId !== user.id)) {
        throw notFound();
      }
      await apply(tx, issue, admin ? "ADMIN" : "REPORTER");
    });
    return this.detail(id, viewer);
  }
}
