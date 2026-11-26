import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { Infrastructure } from "../infrastructure";
import { MetadataProvider } from "../metadata/provider";
import { text } from "./league-index";
import { PagedJob, pagedSync } from "./paged-sync";

export const SCHEDULE_INDEX_JOB = "schedule-index";
/** The setting recording the last complete copy, which makes the copy usable. */
export const SCHEDULE_SETTING = "index.schedule";
const DAY = 86400000;
/**
 * The whole window once a day, and today and tomorrow every hour, since that is where start
 * times and cancellations change most.
 */
export const SCHEDULE_WINDOWS = {
  full: { pastDays: 7, futureDays: 14, everyMs: DAY },
  near: { pastDays: 0, futureDays: 1, everyMs: 3600000 },
} as const;
export type ScheduleWindow = keyof typeof SCHEDULE_WINDOWS;
export type ScheduleJob = PagedJob & { window: ScheduleWindow; from?: string; to?: string };

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const date = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;

/** When the last complete copy finished, if any. */
export async function scheduleCompletedAt(infrastructure: Infrastructure) {
  const setting = await infrastructure.db.setting.findUnique({ where: { key: SCHEDULE_SETTING } });
  const value = setting?.value as { completedAt?: unknown } | undefined;
  return typeof value?.completedAt === "string" ? Date.parse(value.completedAt) : undefined;
}

/** Whether the whole window should be copied now: never done, or not in the last day. */
export async function scheduleIndexStale(infrastructure: Infrastructure, now = Date.now()) {
  const at = await scheduleCompletedAt(infrastructure);
  return at === undefined || now - at > SCHEDULE_WINDOWS.full.everyMs;
}

/**
 * Copies Hub's events of a window, a page of 100 per job. Only the whole window removes events:
 * those Hub no longer lists there and those that have left it.
 */
export function indexSchedule(
  infrastructure: Infrastructure,
  metadata: MetadataProvider,
  queue: Queue,
  job: ScheduleJob,
  now = Date.now(),
) {
  const db = infrastructure.db;
  const window = SCHEDULE_WINDOWS[job.window] ?? SCHEDULE_WINDOWS.full;
  const whole = window === SCHEDULE_WINDOWS.full;
  return pagedSync<ScheduleJob>(
    infrastructure,
    queue,
    {
      name: SCHEDULE_INDEX_JOB,
      key: whole ? "schedule-full" : "schedule-near",
      start: (at) => ({
        from: day(at - window.pastDays * DAY),
        to: day(at + window.futureDays * DAY),
      }),
      fetch: (page, run) =>
        metadata.events({ from: run.from, to: run.to, page, pageSize: 100, order: "asc" }),
      store: (items, syncedAt) =>
        db.$transaction(
          items.map((event) => {
            const data = {
              shortId: text(event.shortId),
              name: event.name,
              leagueId: text(event.leagueId),
              seasonId: text(event.seasonId),
              homeTeamId: text(event.homeTeamId),
              homeTeamName: text(event.homeTeamName),
              awayTeamId: text(event.awayTeamId),
              awayTeamName: text(event.awayTeamName),
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
          }),
        ),
      finish: async (startedAt, run, at) => {
        if (!whole) {
          return {};
        }
        const removed = await db.hubEvent.deleteMany({ where: { syncedAt: { lt: startedAt } } });
        const value = { completedAt: new Date(at).toISOString(), from: run.from, to: run.to };
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
