import { Queue } from "bullmq";
import { Infrastructure } from "../infrastructure";
import { MetadataProvider } from "../metadata/provider";
import { PagedJob, pagedSync, text } from "./paged-sync";

export const LEAGUE_INDEX_JOB = "league-index";
export const LEAGUE_INDEX_EVERY_MS = 86400000;

/** Whether the index is missing or older than a day, so the worker should refresh it now. */
export async function leagueIndexStale(infrastructure: Infrastructure, now = Date.now()) {
  const newest = await infrastructure.db.hubLeague.aggregate({ _max: { syncedAt: true } });
  const at = newest._max.syncedAt?.getTime();
  return at === undefined || now - at > LEAGUE_INDEX_EVERY_MS;
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
      // Leagues Hub no longer lists.
      finish: async (startedAt) => ({
        removed: (await db.hubLeague.deleteMany({ where: { syncedAt: { lt: startedAt } } })).count,
      }),
    },
    job,
    now,
  );
}
