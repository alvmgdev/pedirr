import { Injectable } from "@nestjs/common";
import { MetadataItem, MetadataProvider } from "../metadata/provider";
import { SportarrSettings } from "../settings/sportarr";
import { SportarrClient } from "../managers/sportarr";
import { imported } from "../jobs/fulfillment";
import { ManagerPart } from "../managers/client";
import {
  defaultParts,
  effectiveMonitoredParts,
  heldParts,
  isFullEventOnly,
  partKey,
  queuedParts,
  selectableParts,
} from "./parts";

export type AvailabilityTarget = {
  kind: "event" | "season";
  league: MetadataItem;
  event?: MetadataItem;
  season?: MetadataItem;
};
export type AvailabilityResult = {
  state: "available" | "missing" | "unknown";
  reason?: "not_configured" | "unreachable" | "identity" | "incomplete";
};
/** What Sportarr knows about the parts of a request target. */
export type PartsInfo =
  | { supported: false }
  | {
      supported: true;
      parts: ManagerPart[];
      defaults: string[];
      /** Event targets already in Sportarr: parts on disk and parts with queue work. */
      held?: { whole: boolean; names: string[] };
      queued?: { unknown: boolean; names: string[] };
    };
@Injectable()
export class Availability {
  constructor(
    private readonly metadata: MetadataProvider,
    private readonly settings: SportarrSettings,
  ) {}
  async check(target: AvailabilityTarget): Promise<AvailabilityResult> {
    let config;
    try {
      config = await this.settings.configuration();
    } catch (error) {
      const body = (error as { getResponse?: () => { code?: string } }).getResponse?.();
      return {
        state: "unknown",
        reason: body?.code === "SPORTARR_NOT_CONFIGURED" ? "not_configured" : "unreachable",
      };
    }
    try {
      if (!target.league.shortId) {
        return { state: "unknown", reason: "identity" };
      }
      const manager = new SportarrClient(config);
      const leagues = (await manager.leagues()).filter(
        (league) => league.externalId === target.league.shortId,
      );
      if (!leagues.length) {
        return { state: "missing" };
      }
      if (leagues.length !== 1) {
        return { state: "unknown", reason: "identity" };
      }
      const league = leagues[0];
      let expected: MetadataItem[];
      if (target.kind === "event") {
        if (!target.event?.shortId || target.event.leagueId !== target.league.id) {
          return { state: "unknown", reason: "identity" };
        }
        expected = [target.event];
      } else {
        const season = target.season;
        if (!season || season.leagueId !== target.league.id) {
          return { state: "unknown", reason: "identity" };
        }
        if (
          season.isCurrent !== false ||
          typeof season.endDate !== "string" ||
          !(Date.parse(season.endDate + "T23:59:59Z") < Date.now())
        ) {
          return { state: "missing" };
        }
        expected = [];
        let total: number | undefined;
        let complete = false;
        const seen = new Set<string>();
        for (let page = 1; page <= 10000; page++) {
          const result = await this.metadata.events({
            league: target.league.id,
            season: season.id,
            page,
          });
          total ??= result.total;
          if (result.total !== total || result.page !== page) {
            return { state: "unknown", reason: "incomplete" };
          }
          for (const event of result.items) {
            if (
              seen.has(event.id) ||
              event.leagueId !== target.league.id ||
              event.seasonId !== season.id
            ) {
              return { state: "unknown", reason: "identity" };
            }
            seen.add(event.id);
            expected.push(event);
          }
          if (page >= result.totalPages) {
            complete = true;
            break;
          }
          if (!result.items.length) {
            return { state: "unknown", reason: "incomplete" };
          }
        }
        if (!complete || expected.length !== total) {
          return { state: "unknown", reason: "incomplete" };
        }
        if (
          expected.some((event) => event.status !== "completed" && event.status !== "cancelled")
        ) {
          return { state: "missing" };
        }
        expected = expected.filter(
          (event) => event.isActive !== false && event.status !== "cancelled",
        );
      }
      if (!expected.length) {
        return { state: "missing" };
      }
      const stored = await manager.events(league.id);
      for (const event of expected) {
        if (!event.shortId) {
          return { state: "unknown", reason: "identity" };
        }
        const matches = stored.filter(
          (item) => item.externalId === event.shortId && item.leagueId === league.id,
        );
        if (matches.length > 1) {
          return { state: "unknown", reason: "identity" };
        }
        if (!matches.length || !imported(matches[0])) {
          return { state: "missing" };
        }
      }
      return { state: "available" };
    } catch {
      return { state: "unknown", reason: "unreachable" };
    }
  }
  /**
   * Part choices for a target, only when Sportarr knows the real parts: an event Sportarr holds
   * (its definitions follow the event type, so a Fight Night has no Early Prelims and weekly
   * wrestling has none), or a season of a league Sportarr holds (the parts of its events).
   * Sportarr cannot describe the parts of an event it does not hold yet, so those are requested
   * whole. Unsupported as well when Sportarr is unavailable, splits nothing into parts, or keeps
   * the event or league as one "Full Event" file.
   */
  async parts(target: AvailabilityTarget): Promise<PartsInfo> {
    let config;
    try {
      config = await this.settings.configuration();
    } catch {
      return { supported: false };
    }
    if (!target.league.shortId) {
      return { supported: false };
    }
    try {
      const manager = new SportarrClient(config);
      if (!(await manager.multiPartEnabled())) {
        return { supported: false };
      }
      const leagues = (await manager.leagues()).filter(
        (league) => league.externalId === target.league.shortId,
      );
      if (leagues.length !== 1) {
        return { supported: false };
      }
      const league = leagues[0];
      const stored = (await manager.events(league.id)).filter(
        (item) => item.leagueId === league.id,
      );
      if (target.kind === "event") {
        const matches = stored.filter((item) => item.externalId === target.event?.shortId);
        if (matches.length !== 1) {
          return { supported: false };
        }
        const event = matches[0];
        const configured = effectiveMonitoredParts(event.monitoredParts, league.monitoredParts);
        if (isFullEventOnly(configured)) {
          return { supported: false };
        }
        const parts = selectableParts(await manager.parts(event.id));
        if (!parts.length) {
          return { supported: false };
        }
        const activity = (await manager.queue()).filter((item) => item.eventId === event.id);
        return {
          supported: true,
          parts,
          defaults: defaultParts(parts, configured),
          held: heldParts(event, parts),
          queued: queuedParts(activity),
        };
      }
      const leagueParts = effectiveMonitoredParts(null, league.monitoredParts);
      const scope = await this.seasonEvents(target);
      if (isFullEventOnly(leagueParts) || !scope) {
        return { supported: false };
      }
      // The season offers every part any of its events has, in card order.
      const byName = new Map<string, ManagerPart>();
      for (const event of stored.filter((item) => scope.has(item.externalId ?? ""))) {
        if (isFullEventOnly(effectiveMonitoredParts(event.monitoredParts, league.monitoredParts))) {
          continue;
        }
        for (const part of selectableParts(await manager.parts(event.id))) {
          const known = byName.get(partKey(part.name));
          if (!known || part.number < known.number) {
            byName.set(partKey(part.name), part);
          }
        }
      }
      const parts = [...byName.values()].sort((left, right) => left.number - right.number);
      if (!parts.length) {
        return { supported: false };
      }
      return { supported: true, parts, defaults: defaultParts(parts, leagueParts) };
    } catch {
      return { supported: false };
    }
  }
  /** Hub short IDs of a season's events, or undefined when the listing is inconsistent. */
  private async seasonEvents(target: AvailabilityTarget): Promise<Set<string> | undefined> {
    const season = target.season;
    if (target.kind !== "season" || !season || season.leagueId !== target.league.id) {
      return undefined;
    }
    const ids = new Set<string>();
    for (let page = 1; page <= 10000; page++) {
      const result = await this.metadata.events({
        league: target.league.id,
        season: season.id,
        page,
      });
      for (const event of result.items) {
        if (event.shortId) {
          ids.add(event.shortId);
        }
      }
      if (page >= result.totalPages || !result.items.length) {
        return ids;
      }
    }
    return undefined;
  }
}
