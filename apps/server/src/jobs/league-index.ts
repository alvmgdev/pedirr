import { Queue } from "bullmq";
import { Infrastructure } from "../infrastructure";
import { MetadataProvider } from "../metadata/provider";

export const LEAGUE_INDEX_JOB = "league-index";
export const LEAGUE_INDEX_EVERY_MS = 86400000;
const PAGE_SIZE = 100;
// Pages are fetched one job at a time with a pause between them, so the sync never holds the
// worker for long and users keep most of the shared Hub budget.
const PAGE_DELAY_MS = 4000;
const LOCK = "pedirr:league-index:run";
const LOCK_SECONDS = 7200;

export type LeagueIndexJob = { page?: number; startedAt?: number };
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** Whether the index is missing or older than a day, so the worker should refresh it now. */
export async function leagueIndexStale(infrastructure: Infrastructure, now = Date.now()) {
  const newest = await infrastructure.db.hubLeague.aggregate({ _max: { syncedAt: true } });
  const at = newest._max.syncedAt?.getTime();
  return at === undefined || now - at > LEAGUE_INDEX_EVERY_MS;
}

/**
 * Copies one page of Hub's leagues into the index and queues the next one. A run starts without
 * a page and takes a lock, so overlapping runs (a scheduled one and one at startup) never mix
 * their timestamps; the last page removes leagues Hub no longer lists.
 */
export async function indexLeagues(
  infrastructure: Infrastructure,
  metadata: MetadataProvider,
  queue: Queue,
  job: LeagueIndexJob,
  now = Date.now(),
) {
  const redis = infrastructure.redis;
  let { page, startedAt } = job;
  if (page === undefined || startedAt === undefined) {
    startedAt = now;
    page = 1;
    if (!(await redis.set(LOCK, String(startedAt), "EX", LOCK_SECONDS, "NX"))) {
      return { skipped: "running" as const };
    }
  } else if ((await redis.get(LOCK)) !== String(startedAt)) {
    return { skipped: "superseded" as const };
  }
  await redis.expire(LOCK, LOCK_SECONDS);
  const result = await metadata.leagues(page, PAGE_SIZE);
  const syncedAt = new Date(startedAt);
  await infrastructure.db.$transaction(
    result.items.map((league) => {
      const data = {
        shortId: text(league.shortId),
        name: league.name,
        sportId: text(league.sportId),
        sportName: text(league.sportName),
        country: text(league.country),
        logoUrl: text(league.logoUrl),
        syncedAt,
      };
      return infrastructure.db.hubLeague.upsert({
        where: { id: league.id },
        create: { id: league.id, ...data },
        update: data,
      });
    }),
  );
  if (result.page < result.totalPages) {
    await queue.add(
      LEAGUE_INDEX_JOB,
      { page: page + 1, startedAt },
      { jobId: `${LEAGUE_INDEX_JOB}-${startedAt}-${page + 1}`, delay: PAGE_DELAY_MS },
    );
    return { page, next: page + 1 };
  }
  // Only a complete run may remove leagues; an interrupted one leaves the index as it was.
  const removed = await infrastructure.db.hubLeague.deleteMany({
    where: { syncedAt: { lt: syncedAt } },
  });
  await redis.del(LOCK);
  return { page, done: true as const, removed: removed.count };
}
