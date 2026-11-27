import { Queue } from "bullmq";
import { Infrastructure } from "../infrastructure";
import { MetadataProvider } from "../metadata/provider";
import { PagedJob, pagedSync, text } from "./paged-sync";

export const LEAGUE_INDEX_JOB = "league-index";
/** The index is copied again once its last complete copy is older than this. */
export const LEAGUE_INDEX_MAX_AGE_MS = 86400000;
/** When the last complete copy finished; a copy cut short does not count. */
export const LEAGUE_INDEX_SETTING = "index.leagues";

/** Whether the index has never been copied completely, or not in the last day. */
export async function leagueIndexStale(infrastructure: Infrastructure, now = Date.now()) {
  const setting = await infrastructure.db.setting.findUnique({
    where: { key: LEAGUE_INDEX_SETTING },
  });
  const value = setting?.value as { completedAt?: unknown } | undefined;
  const at = typeof value?.completedAt === "string" ? Date.parse(value.completedAt) : NaN;
  return !Number.isFinite(at) || now - at > LEAGUE_INDEX_MAX_AGE_MS;
}

/** Copies Hub's leagues and their sports into the index, a page of 100 per job. */
export function indexLeagues(
  infrastructure: Infrastructure,
  metadata: MetadataProvider,
  queue: Queue,
  job: PagedJob,
  now = Date.now(),
) {
  const db = infrastructure.db;
  return pagedSync(
    infrastructure,
    queue,
    {
      name: LEAGUE_INDEX_JOB,
      key: "leagues",
      fetch: (page) => metadata.leagues(page, 100),
      row: (league, syncedAt) => {
        const data = {
          shortId: text(league.shortId),
          name: league.name,
          sportId: text(league.sportId),
          sportName: text(league.sportName),
          country: text(league.country),
          logoUrl: text(league.logoUrl),
          syncedAt,
        };
        return db.hubLeague.upsert({
          where: { id: league.id },
          create: { id: league.id, ...data },
          update: data,
        });
      },
      // Leagues Hub no longer lists; then the copy counts as complete.
      finish: async (startedAt, at) => {
        const removed = await db.hubLeague.deleteMany({ where: { syncedAt: { lt: startedAt } } });
        const value = { completedAt: new Date(at).toISOString() };
        await db.setting.upsert({
          where: { key: LEAGUE_INDEX_SETTING },
          create: { key: LEAGUE_INDEX_SETTING, value },
          update: { value },
        });
        return { removed: removed.count };
      },
      due: () => leagueIndexStale(infrastructure, now),
    },
    job,
    now,
  );
}
