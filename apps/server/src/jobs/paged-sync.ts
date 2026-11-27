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
/** Retries of a failed background page back off instead of following Hub's short retry hints. */
export const INDEX_BACKOFF = { type: "index" } as const;
/** 2, 4, 8 and 16 minutes, never more than an hour: an outage costs a few calls, not a flood. */
export const indexRetryDelayMs = (attempts: number) =>
  Math.min(3600000, 120000 * 2 ** Math.max(0, attempts - 1));
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

export type PagedJob = { page?: number; startedAt?: number; slice?: number };
type PagedRun = {
  /** Queue job name. */
  name: string;
  /** Distinguishes runs sharing a job name; used for the lock and job IDs. */
  key: string;
  /** One page of one part of the run; parts are read one after another. */
  fetch: (page: number, startedAt: number, slice: number) => Promise<MetadataPage>;
  /** How many parts (date ranges) the run started at `startedAt` reads; one by default. */
  slices?: (startedAt: number) => number;
  /** The write for one item; a page's writes run in one transaction. */
  row: (item: MetadataItem, syncedAt: Date) => Prisma.PrismaPromise<unknown>;
  /** Runs after the last page, with the run's start, e.g. to remove what was not seen again. */
  finish: (startedAt: Date, now: number) => Promise<Record<string, unknown>>;
  /** Whether a new run is due; asked only when a run would start, never for its later pages. */
  due?: () => Promise<boolean>;
};

/**
 * Copies one page from Hub and queues the next, so a copy never holds the worker for long. A run
 * may read several parts in turn (date ranges small enough for Hub), all under its start time.
 * A run starts without a page and takes a lock: overlapping runs of the same key never
 * interleave, and a page of a superseded run stops. A failed page releases the lock, so nothing
 * waits hours for it; its retry takes the lock back and carries on unless another run has started
 * since. Every copy waits for the shared pace before calling Hub. Rows are stamped with the time
 * they were written, and cleanup runs once, after the last page of the last part, removing only
 * rows nobody wrote since the run began; an interrupted run leaves the copy as it was.
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
  let { page, startedAt, slice = 0 } = job;
  if (page === undefined || startedAt === undefined) {
    if (run.due && !(await run.due())) {
      return { skipped: "fresh" as const };
    }
    page = 1;
    slice = 0;
    startedAt = now;
    if (!(await redis.set(lock, String(startedAt), "EX", LOCK_SECONDS, "NX"))) {
      return { skipped: "running" as const };
    }
  } else {
    const holder = await redis.get(lock);
    const resumed =
      holder === null && (await redis.set(lock, String(startedAt), "EX", LOCK_SECONDS, "NX"));
    if (holder !== String(startedAt) && !resumed) {
      return { skipped: "superseded" as const };
    }
  }
  await redis.expire(lock, LOCK_SECONDS);
  const current = { ...job, page, startedAt, slice };
  const slices = run.slices?.(startedAt) ?? 1;
  const id = `${run.name}-${run.key}-${startedAt}-${slice}-${page}`;
  const delay = backgroundDelayMs();
  if (!(await redis.set(PACE, "1", "PX", delay, "NX"))) {
    const wait = Math.max(1, await redis.pttl(PACE));
    await queue.add(run.name, current, {
      jobId: `${id}-${now}`,
      delay: wait,
      backoff: INDEX_BACKOFF,
    });
    return { slice, page, waiting: wait };
  }
  let result: MetadataPage;
  try {
    result = await run.fetch(page, startedAt, slice);
    const syncedAt = new Date(now);
    await infrastructure.db.$transaction(result.items.map((item) => run.row(item, syncedAt)));
  } catch (error) {
    // Let the retry, or the next run, start at once instead of waiting hours for the lock.
    await redis.eval(
      `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`,
      1,
      lock,
      String(startedAt),
    );
    throw error;
  }
  if (result.page < result.totalPages) {
    await queue.add(
      run.name,
      { ...current, page: page + 1 },
      {
        jobId: `${run.name}-${run.key}-${startedAt}-${slice}-${page + 1}`,
        delay,
        backoff: INDEX_BACKOFF,
      },
    );
    return { slice, page, next: page + 1 };
  }
  if (slice + 1 < slices) {
    await queue.add(
      run.name,
      { ...current, slice: slice + 1, page: 1 },
      {
        jobId: `${run.name}-${run.key}-${startedAt}-${slice + 1}-1`,
        delay,
        backoff: INDEX_BACKOFF,
      },
    );
    return { slice, page, nextSlice: slice + 1 };
  }
  // Only a complete run cleans up; an interrupted one leaves the copy as it was.
  const finished = await run.finish(new Date(startedAt), now);
  await redis.del(lock);
  return { slice, page, done: true as const, ...finished };
}
