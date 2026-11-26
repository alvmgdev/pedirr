import { Queue } from "bullmq";
import { Infrastructure } from "../infrastructure";
import { MetadataItem, MetadataPage } from "../metadata/provider";

/** Background copies use at most this share of the Hub budget, leaving the rest to people. */
const BACKGROUND_SHARE = 0.3;
const LOCK_SECONDS = 7200;

/**
 * Pause between pages of a background copy: with the default budget of 20 calls a minute, one
 * call every 10 seconds.
 */
export function backgroundDelayMs(budget = Number(process.env.HUB_REQUESTS_PER_MINUTE ?? 20)) {
  const share = Math.max(1, Math.floor(budget * BACKGROUND_SHARE));
  return Math.max(3000, Math.ceil(60000 / share));
}

export type PagedJob = { page?: number; startedAt?: number };
export type PagedRun<T extends PagedJob> = {
  /** Queue job name. */
  name: string;
  /** Distinguishes runs sharing a job name; used for the lock and job IDs. */
  key: string;
  /** What every page of a run needs (such as a date window), fixed when the run starts. */
  start?: (now: number) => Partial<T>;
  fetch: (page: number, job: T) => Promise<MetadataPage>;
  store: (items: MetadataItem[], syncedAt: Date) => Promise<unknown>;
  /** Runs after the last page, with the run's start, e.g. to remove what was not seen again. */
  finish: (startedAt: Date, job: T, now: number) => Promise<Record<string, unknown>>;
};

/**
 * Copies one page from Hub and queues the next after a pause, so a copy never holds the worker
 * for long. A run starts without a page and takes a lock: overlapping runs of the same key never
 * interleave, and a page of a superseded run stops. Rows are stamped with the time they were
 * written, so cleanup at the end only removes rows nobody wrote since the run began.
 */
export async function pagedSync<T extends PagedJob>(
  infrastructure: Infrastructure,
  queue: Queue,
  run: PagedRun<T>,
  input: T,
  now = Date.now(),
) {
  const redis = infrastructure.redis;
  const lock = `pedirr:index:${run.key}`;
  let job = input;
  if (job.page === undefined || job.startedAt === undefined) {
    job = { ...job, ...run.start?.(now), page: 1, startedAt: now };
    if (!(await redis.set(lock, String(now), "EX", LOCK_SECONDS, "NX"))) {
      return { skipped: "running" as const };
    }
  } else if ((await redis.get(lock)) !== String(job.startedAt)) {
    return { skipped: "superseded" as const };
  }
  await redis.expire(lock, LOCK_SECONDS);
  const page = job.page!;
  const result = await run.fetch(page, job);
  await run.store(result.items, new Date(now));
  if (result.page < result.totalPages) {
    await queue.add(
      run.name,
      { ...job, page: page + 1 },
      { jobId: `${run.name}-${run.key}-${job.startedAt}-${page + 1}`, delay: backgroundDelayMs() },
    );
    return { page, next: page + 1 };
  }
  // Only a complete run cleans up; an interrupted one leaves the copy as it was.
  const finished = await run.finish(new Date(job.startedAt!), job, now);
  await redis.del(lock);
  return { page, done: true as const, ...finished };
}
