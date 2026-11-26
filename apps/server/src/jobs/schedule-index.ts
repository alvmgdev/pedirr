import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { Infrastructure } from "../infrastructure";
import { MetadataProvider } from "../metadata/provider";
import { DAY, isoDay, SCHEDULE_SETTING, scheduleCompletedAt } from "../metadata/schedule";
import { PagedJob, pagedSync, text } from "./paged-sync";

export const SCHEDULE_INDEX_JOB = "schedule-index";
/**
 * The whole window once a day, and today and tomorrow every hour, since that is where start
 * times and cancellations change most. Only a whole run removes events and makes the copy usable.
 */
export const SCHEDULE_WINDOWS = {
  full: { pastDays: 7, futureDays: 14, everyMs: DAY, whole: true },
  near: { pastDays: 0, futureDays: 1, everyMs: 3600000, whole: false },
} as const;
type ScheduleJob = PagedJob & { window: keyof typeof SCHEDULE_WINDOWS };

const date = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;

/** Whether the whole window should be copied now: never done, or not in the last day. */
export async function scheduleIndexStale(infrastructure: Infrastructure, now = Date.now()) {
  const at = await scheduleCompletedAt(infrastructure);
  return at === undefined || now - at > SCHEDULE_WINDOWS.full.everyMs;
}

/**
 * Copies Hub's events of a window, a page of 100 per job. The whole window also removes the
 * events Hub no longer lists there and those that have left it.
 */
export function indexSchedule(
  infrastructure: Infrastructure,
  metadata: MetadataProvider,
  queue: Queue,
  job: ScheduleJob,
  now = Date.now(),
) {
  const db = infrastructure.db;
  const name = job.window === "near" ? "near" : "full";
  const window = SCHEDULE_WINDOWS[name];
  return pagedSync(
    infrastructure,
    queue,
    {
      name: SCHEDULE_INDEX_JOB,
      key: `schedule-${name}`,
      fetch: (page, startedAt) =>
        metadata.events({
          from: isoDay(startedAt - window.pastDays * DAY),
          to: isoDay(startedAt + window.futureDays * DAY),
          page,
          pageSize: 100,
          order: "asc",
        }),
      row: (event, syncedAt) => {
        const data = {
          name: event.name,
          leagueId: text(event.leagueId),
          homeTeamId: text(event.homeTeamId),
          homeTeamName: text(event.homeTeamName),
          homeTeamBadgeUrl: text(event.homeTeamBadgeUrl),
          awayTeamId: text(event.awayTeamId),
          awayTeamName: text(event.awayTeamName),
          awayTeamBadgeUrl: text(event.awayTeamBadgeUrl),
          scheduledStart: date(event.scheduledStart),
          status: text(event.status),
          isActive: event.isActive !== false,
          item: event as Prisma.InputJsonValue,
          syncedAt,
        };
        return db.hubEvent.upsert({
          where: { id: event.id },
          create: { id: event.id, ...data },
          update: data,
        });
      },
      finish: async (startedAt, at) => {
        if (!window.whole) {
          return {};
        }
        const removed = await db.hubEvent.deleteMany({ where: { syncedAt: { lt: startedAt } } });
        const value = { completedAt: new Date(at).toISOString() };
        await db.setting.upsert({
          where: { key: SCHEDULE_SETTING },
          create: { key: SCHEDULE_SETTING, value },
          update: { value },
        });
        return { removed: removed.count };
      },
    },
    job,
    now,
  );
}
