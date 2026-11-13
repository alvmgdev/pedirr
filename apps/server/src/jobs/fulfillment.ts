import { BadGatewayException, HttpException } from "@nestjs/common";
import { Prisma, RequestStatus } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { Infrastructure } from "../infrastructure";
import { MetadataItem, MetadataProvider } from "../metadata/provider";
import { parseItem } from "../metadata/hub";
import { ContentManager, ManagerEvent, ManagerPart, QueueItem } from "../managers/client";
import { SportarrClient } from "../managers/sportarr";
import { SportarrSettings } from "../settings/sportarr";
import { searchRetrySeconds } from "../config";
import {
  ACTIVE_QUEUE,
  addMonitoredParts,
  effectiveMonitoredParts,
  heldParts,
  isFullEventOnly,
  partKey,
  partsRequestStatus,
  queuedParts,
  selectableParts,
  splitParts,
} from "../requests/parts";
import { refreshSubscribers } from "../requests/subscribers";

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const conflict = () =>
  new BadGatewayException({
    code: "REQUEST_METADATA_CHANGED",
    message: "Requested metadata identity or scope changed; administrator review is required",
  });
export function errorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (
      typeof body === "object" &&
      "code" in body &&
      typeof body.code === "string" &&
      /^[A-Z_]+$/.test(body.code)
    ) {
      return body.code;
    }
  }
  return "INTEGRATION_FAILED";
}
export function imported(event: ManagerEvent): boolean {
  return event.hasFile && event.files.some((file) => file.exists === true);
}
const OPTIONAL_PARTS = new Set(["post show"]);
const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/**
 * Monitored event parts still missing a file, for one search per part.
 *
 * Sportarr's event-level automatic search grabs only the best release, which
 * keeps choosing the part already held, so an event split into parts (for
 * example Early Prelims, Prelims and Main Card) would never be completed. A
 * part search rejects releases of other parts and unlabelled releases, and
 * stops when a whole-event file exists. Parts already downloading, the
 * optional Post Show and parts excluded by event or league monitoring are
 * skipped. While a queue item of unknown part is active, nothing is searched.
 */
export function partsToSearch(
  event: ManagerEvent,
  parts: ManagerPart[],
  leagueMonitoredParts: unknown,
  activity: QueueItem[],
): string[] {
  const files = event.files.filter((file) => file.exists === true);
  if (files.length === 0) {
    return [];
  }
  const wholeEvent = files.some(
    (file) =>
      file.partNumber === 0 ||
      ((file.partNumber === null || file.partNumber === undefined) && !lower(file.partName)),
  );
  if (wholeEvent) {
    return [];
  }
  const active = activity.filter((item) => ACTIVE_QUEUE.includes(item.status));
  if (active.some((item) => !item.part)) {
    return [];
  }
  const configured =
    typeof event.monitoredParts === "string"
      ? event.monitoredParts
      : typeof leagueMonitoredParts === "string"
        ? leagueMonitoredParts
        : null;
  const monitored =
    configured === null ? null : new Set(configured.split(",").map(lower).filter(Boolean));
  const heldNames = new Set(files.map((file) => lower(file.partName)));
  const heldNumbers = new Set(files.map((file) => file.partNumber));
  const busy = new Set(active.map((item) => lower(item.part)));
  return parts
    .filter(
      (part) =>
        part.number > 0 &&
        !OPTIONAL_PARTS.has(lower(part.name)) &&
        (monitored === null || monitored.has(lower(part.name))) &&
        !heldNames.has(lower(part.name)) &&
        !heldNumbers.has(part.number) &&
        !busy.has(lower(part.name)),
    )
    .map((part) => part.name);
}
export function aggregateStatus(
  events: { available: boolean; downloading: boolean }[],
  closed: boolean,
): RequestStatus {
  if (closed && events.length > 0 && events.every((event) => event.available)) {
    return "AVAILABLE";
  }
  return events.some((event) => event.downloading) ? "DOWNLOADING" : "APPROVED";
}
export class Fulfillment {
  constructor(
    private readonly infrastructure: Infrastructure,
    private readonly metadata: MetadataProvider,
    private readonly settings: SportarrSettings,
    private readonly managerFactory: (
      config: Awaited<ReturnType<SportarrSettings["configuration"]>>,
    ) => ContentManager = (config) => new SportarrClient(config),
  ) {}
  private async plan(scopeValue: Prisma.JsonValue) {
    const scope = scopeValue as Record<string, unknown>;
    if (!scope || scope.provider !== "hub" || !["event", "season"].includes(String(scope.kind))) {
      throw conflict();
    }
    const savedLeague = parseItem(scope.league);
    const league = await this.metadata.league(savedLeague.id);
    if (league.id !== savedLeague.id || !league.shortId || typeof league.sportName !== "string") {
      throw conflict();
    }
    if (scope.kind === "event") {
      const saved = parseItem(scope.event);
      const event = await this.metadata.event(saved.id);
      if (event.id !== saved.id || event.leagueId !== league.id) {
        throw conflict();
      }
      return { league, events: [event], closed: true };
    }
    const savedSeason = parseItem(scope.season);
    const season = await this.metadata.season(savedSeason.id);
    if (season.id !== savedSeason.id || season.leagueId !== league.id) {
      throw conflict();
    }
    const events: MetadataItem[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= 10000; page++) {
      const result = await this.metadata.events({ league: league.id, season: season.id, page });
      expectedTotal ??= result.total;
      if (result.total !== expectedTotal || result.page !== page) {
        throw conflict();
      }
      for (const item of result.items) {
        if (item.leagueId !== league.id || item.seasonId !== season.id || seen.has(item.id)) {
          throw conflict();
        }
        seen.add(item.id);
        events.push(item);
      }
      if (page >= result.totalPages) {
        if (events.length !== expectedTotal) {
          throw conflict();
        }
        const ended =
          typeof season.endDate === "string" &&
          Date.parse(season.endDate + "T23:59:59Z") < Date.now();
        const closed =
          season.isCurrent === false &&
          ended &&
          events.every((event) => event.status === "completed" || event.status === "cancelled");
        return { league, events, closed };
      }
      if (!result.items.length) {
        throw conflict();
      }
    }
    throw conflict();
  }
  async run(requestId: string) {
    const { db, redis } = this.infrastructure;
    const request = await db.request.findUnique({
      where: { id: requestId },
      include: { parts: true },
    });
    if (!request || !["APPROVED", "DOWNLOADING", "AVAILABLE"].includes(request.status)) {
      return;
    }
    let lock: string | undefined;
    const owner = randomUUID();
    let renewal: NodeJS.Timeout | undefined;
    let lost = false;
    try {
      const config = await this.settings.configuration();
      const managerKey = createHash("sha256").update(config.url).digest("hex");
      lock = `pedirr:manager:${managerKey}:lock`;
      if (!(await redis.set(lock, owner, "EX", 45, "NX"))) {
        throw new HttpException({ code: "MANAGER_BUSY", retryAfterSeconds: 45 }, 503);
      }
      const check = async () => {
        if (lost || (await redis.get(lock!)) !== owner) {
          throw new Error("Manager lease lost");
        }
      };
      renewal = setInterval(() => {
        void redis
          .eval(
            `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],45) end; return 0`,
            1,
            lock!,
            owner,
          )
          .then((result) => {
            if (!result) {
              lost = true;
            }
          })
          .catch(() => {
            lost = true;
          });
      }, 10000);
      const plan = await this.plan(request.scope);
      const events = plan.events.filter(
        (event) => event.isActive !== false && event.status !== "cancelled",
      );
      // Validate every identity before allowing any remote write.
      for (const event of events) {
        if (
          !event.shortId ||
          !/^ev-\d+$/.test(event.shortId) ||
          !event.scheduledStart ||
          !Number.isFinite(Date.parse(event.scheduledStart))
        ) {
          throw conflict();
        }
      }
      const manager = this.managerFactory(config);
      await manager.assertWriteCompatibility();
      await check();
      const league = await manager.ensureLeague({
        externalId: plan.league.shortId!,
        name: plan.league.name,
        sport: String(plan.league.sportName),
        rootFolderId: config.rootFolderId,
        qualityProfileId: config.qualityProfileId,
      });
      // Requests with parts monitor and search only their approved parts.
      const byParts = request.parts.length > 0;
      const approvedParts = request.parts
        .filter((part) => part.status === "APPROVED")
        .map((part) => part.name);
      const multiPart = byParts && (await manager.multiPartEnabled());
      const existing = await manager.events(league.id);
      const queue = await manager.queue();
      const retrySeconds = searchRetrySeconds();
      const results: { available: boolean; downloading: boolean }[] = [];
      for (const event of events) {
        await check();
        const created = !existing.some((item) => item.externalId === event.shortId);
        let current = await manager.ensureEvent(
          {
            externalId: event.shortId!,
            title: event.name,
            sport: String(plan.league.sportName),
            leagueId: league.id,
            eventDate: event.scheduledStart!,
            season: typeof event.seasonName === "string" ? event.seasonName : null,
            seasonNumber: typeof event.seasonNumber === "number" ? event.seasonNumber : null,
            qualityProfileId: config.qualityProfileId,
          },
          existing,
        );
        let definitions: ManagerPart[] = [];
        let wanted: string[] = [];
        if (multiPart) {
          const effective = effectiveMonitoredParts(current.monitoredParts, league.monitoredParts);
          // A "Full Event" event keeps one whole file; its parts are never changed.
          if (!isFullEventOnly(effective)) {
            definitions = selectableParts(await manager.parts(current.id));
            wanted = definitions
              .filter((part) => approvedParts.some((name) => partKey(name) === partKey(part.name)))
              .map((part) => part.name);
          }
          if (wanted.length) {
            // Only ever add parts. An event Pedirr just created starts with the requested ones;
            // an existing event keeps everything it already monitors (null already means all).
            const configured = created || effective === null ? null : splitParts(effective);
            const missing = configured
              ? wanted.filter((name) => !configured.some((item) => partKey(item) === partKey(name)))
              : wanted;
            if (created || (configured && missing.length)) {
              await check();
              current = await manager.setMonitoredParts(
                current.id,
                addMonitoredParts(definitions, configured ?? [], missing),
              );
            }
          }
        }
        const activity: QueueItem[] = queue.filter((item) => item.eventId === current.id);
        const queued = queuedParts(activity);
        let available: boolean;
        let downloading = activity.some((item) => ACTIVE_QUEUE.includes(item.status));
        let availableParts: string[] = [];
        let downloadingParts: string[] = [];
        if (definitions.length) {
          const held = heldParts(current, definitions);
          availableParts = held.whole ? definitions.map((part) => part.name) : held.names;
          const missing = wanted.filter(
            (name) => !availableParts.some((item) => partKey(item) === partKey(name)),
          );
          available = missing.length === 0;
          downloadingParts = queued.unknown
            ? missing
            : missing.filter((name) =>
                queued.names.some((item) => partKey(item) === partKey(name)),
              );
          downloading = downloadingParts.length > 0;
        } else {
          available = imported(current);
        }
        const progress = available
          ? 100
          : Math.max(0, ...activity.map((item) => Math.min(100, Math.max(0, item.progress))));
        const state = {
          metadata: json(event),
          remoteId: current.id,
          available,
          progress,
          parts: definitions.map((part) => part.name),
          availableParts,
          downloadingParts,
          downloading,
          checkedAt: new Date(),
        };
        await db.requestEvent.upsert({
          where: { requestId_externalId: { requestId, externalId: event.id } },
          create: { requestId, externalId: event.id, ...state },
          update: { ...state, active: true },
        });
        results.push({ available, downloading });
        if (!available && Date.parse(event.scheduledStart!) <= Date.now()) {
          const searches: { key: string; part?: string }[] = [];
          const partSearch = (part: string) => ({
            key: `pedirr:search:${managerKey}:${current.id}:part:${encodeURIComponent(part.toLowerCase())}`,
            part,
          });
          if (definitions.length) {
            // Search each requested part on its own, so another part is never grabbed instead.
            if (!queued.unknown) {
              for (const part of wanted) {
                const held = availableParts.some((item) => partKey(item) === partKey(part));
                const busy = queued.names.some((item) => partKey(item) === partKey(part));
                if (!held && !busy) {
                  searches.push(partSearch(part));
                }
              }
            }
          } else if (!current.files.some((file) => file.exists === true)) {
            if (!downloading) {
              searches.push({ key: `pedirr:search:${managerKey}:${current.id}` });
            }
          } else {
            const missing = partsToSearch(
              current,
              await manager.parts(current.id),
              league.monitoredParts,
              activity,
            );
            searches.push(...missing.map(partSearch));
          }
          for (const search of searches) {
            if (await redis.set(search.key, owner, "EX", retrySeconds, "NX")) {
              await check();
              try {
                await manager.search(current.id, search.part);
              } catch (error) {
                await redis.expire(search.key, 300);
                throw error;
              }
            }
          }
        }
      }
      await check();
      const progressStatus = aggregateStatus(results, plan.closed);
      const status = byParts ? partsRequestStatus(request.parts, progressStatus) : progressStatus;
      await db.$transaction(async (tx) => {
        await tx.requestEvent.updateMany({
          where: { requestId, externalId: { notIn: events.map((event) => event.id) } },
          data: { active: false },
        });
        const updated = await tx.request.updateMany({
          where: { id: requestId, version: request.version },
          data: {
            status,
            closed: plan.closed,
            integrationState: "synced",
            lastError: null,
            version: { increment: 1 },
          },
        });
        if (!updated.count) {
          throw new Error("Request changed during synchronization");
        }
        if (status !== request.status) {
          await tx.requestHistory.create({
            data: { requestId, action: "synchronized", details: { status } },
          });
          // Requests with parts notify each user from their own status instead.
          if (!byParts) {
            await tx.outboxEvent.create({
              data: { type: "request.status", payload: { requestId, status } },
            });
          }
        }
        await refreshSubscribers(tx, requestId);
      });
    } catch (error) {
      await db.request.updateMany({
        where: { id: requestId },
        data: { integrationState: "error", lastError: errorCode(error) },
      });
      throw error;
    } finally {
      if (renewal) {
        clearInterval(renewal);
      }
      if (lock) {
        await redis.eval(
          `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`,
          1,
          lock,
          owner,
        );
      }
    }
  }
}
