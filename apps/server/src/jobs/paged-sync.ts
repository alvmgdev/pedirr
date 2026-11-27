import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { hubBudget } from "../config";
import { Infrastructure } from "../infrastructure";
import { MetadataItem, MetadataPage } from "../metadata/provider";

/** Background copies use at most this share of the Hub budget, leaving the rest to people. */
const BACKGROUND_SHARE = 0.3;
const LOCK_SECONDS = 7200;
/**
 * How often the worker checks whether a daily copy is due. A copy that failed, for example while
 * Hub was down, is retried within this time instead of the next day.
 */
export const INDEX_CHECK_EVERY_MS = 3600000;
/** One pace for every background copy, so copies running at once never add up past the share. */
const PACE = "pedirr:index:pace";

export const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/**
 * Pause between background pages: with the default budget of 20 calls a minute, one call every
 * 10 seconds.
 */
export function backgroundDelayMs(budget = hubBudget()) {
  const share = Math.max(1, Math.floor(budget * BACKGROUND_SHARE));
  return Math.max(3000, Math.ceil(60000 / share));
}

export type PagedJob = { page?: number; startedAt?: number };
type PagedRun = {
  /** Queue job name. */
  name: string;
  /** Distinguishes runs sharing a job name; used for the lock and job IDs. */
  key: string;
  fetch: (page: number, startedAt: number) => Promise<MetadataPage>;
  /** The write for one item; a page's writes run in one transaction. */
  row: (item: MetadataItem, syncedAt: Date) => Prisma.PrismaPromise<unknown>;
  /** Runs after the last page, with the run's start, e.g. to remove what was not seen again. */
  finish: (startedAt: Date, now: number) => Promise<Record<string, unknown>>;
  /** Whether a new run is due; asked only when a run would start, never for its later pages. */
  due?: () => Promise<boolean>;
};

/**
 * Copies one page from Hub and queues the next, so a copy never holds the worker for long. A run
 * starts without a page and takes a lock: overlapping runs of the same key never interleave, and
 * a page of a superseded run stops. Every copy waits for the shared pace before calling Hub. Rows
 * are stamped with the time they were written, so cleanup at the end only removes rows nobody
 * wrote since the run began.
 */
export async function pagedSync<T extends PagedJob>(
  infrastructure: Infrastructure,
  queue: Queue,
  run: PagedRun,
  job: T,
  now = Date.now(),
) {
  const redis = infrastructure.redis;
  const lock = `pedirr:index:${run.key}`;
  let { page, startedAt } = job;
  if (page === undefined || startedAt === undefined) {
    if (run.due && !(await run.due())) {
      return { skipped: "fresh" as const };
    }
    page = 1;
    startedAt = now;
    if (!(await redis.set(lock, String(startedAt), "EX", LOCK_SECONDS, "NX"))) {
      return { skipped: "running" as const };
    }
  } else if ((await redis.get(lock)) !== String(startedAt)) {
    return { skipped: "superseded" as const };
  }
  await redis.expire(lock, LOCK_SECONDS);
  const current = { ...job, page, startedAt };
  const delay = backgroundDelayMs();
  if (!(await redis.set(PACE, "1", "PX", delay, "NX"))) {
    const wait = Math.max(1, await redis.pttl(PACE));
    await queue.add(run.name, current, {
      jobId: `${run.name}-${run.key}-${startedAt}-${page}-${now}`,
      delay: wait,
    });
    return { page, waiting: wait };
  }
  let result: MetadataPage;
  try {
    result = await run.fetch(page, startedAt);
    const syncedAt = new Date(now);
    await infrastructure.db.$transaction(result.items.map((item) => run.row(item, syncedAt)));
  } catch (error) {
    // A run that fails on its first page has copied nothing: let a retry start at once instead
    // of leaving the lock to block every attempt for hours.
    if (page === 1) {
      await redis.eval(
        `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`,
        1,
        lock,
        String(startedAt),
      );
    }
    throw error;
  }
  if (result.page < result.totalPages) {
    await queue.add(
      run.name,
      { ...current, page: page + 1 },
      { jobId: `${run.name}-${run.key}-${startedAt}-${page + 1}`, delay },
    );
    return { page, next: page + 1 };
  }
  // Only a complete run cleans up; an interrupted one leaves the copy as it was.
  const finished = await run.finish(new Date(startedAt), now);
  await redis.del(lock);
  return { page, done: true as const, ...finished };
}
