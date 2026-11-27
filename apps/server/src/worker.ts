import { Notifications } from "./notifications/service";
import { NotificationSettings } from "./settings/notifications";
import "reflect-metadata";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { HttpException } from "@nestjs/common";
import { required, searchRetrySeconds } from "./config";
import { Infrastructure, logger } from "./infrastructure";
import { HubProvider } from "./metadata/hub";
import { SportarrSettings } from "./settings/sportarr";
import { Fulfillment, errorCode } from "./jobs/fulfillment";
import { createProcessor } from "./jobs/processor";
import { LEAGUE_INDEX_EVERY_MS, LEAGUE_INDEX_JOB, leagueIndexStale } from "./jobs/league-index";
import { SCHEDULE_INDEX_JOB, SCHEDULE_WINDOWS, scheduleIndexStale } from "./jobs/schedule-index";
import { TELEGRAM_POLL_EVERY_MS, TELEGRAM_POLL_JOB } from "./jobs/telegram-poll";

async function main() {
  // Fail at startup rather than on the first search.
  searchRetrySeconds();
  const infrastructure = new Infrastructure();
  const connection = new Redis(required("REDIS_URL"), { maxRetriesPerRequest: null });
  const queue = new Queue("pedirr-work", {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "pedirr" },
      removeOnComplete: { age: 172800 },
      removeOnFail: { age: 604800 },
    },
  });
  const metadata = new HubProvider(infrastructure);
  const fulfillment = new Fulfillment(
    infrastructure,
    metadata,
    new SportarrSettings(infrastructure),
  );
  const settings = new NotificationSettings(infrastructure);
  const notifications = new Notifications(infrastructure, settings);
  const worker = new Worker(
    "pedirr-work",
    createProcessor(infrastructure, queue, fulfillment, notifications, metadata, settings),
    {
      connection,
      concurrency: 1,
      settings: {
        backoffStrategy: (attempts, _type, error) => {
          if (error instanceof HttpException) {
            const body = error.getResponse();
            if (
              typeof body === "object" &&
              "retryAfterSeconds" in body &&
              typeof body.retryAfterSeconds === "number"
            ) {
              return Math.max(1000, body.retryAfterSeconds * 1000);
            }
          }
          return Math.min(3600000, 30000 * 2 ** (attempts - 1));
        },
      },
    },
  );
  await queue.upsertJobScheduler("dispatcher", { every: 60000 }, { name: "dispatch", data: {} });
  await queue.add("dispatch", {}, { jobId: `startup-${Date.now()}` });
  /** Runs a job on a schedule, and once now when what it maintains is missing or stale. */
  async function recurring(id: string, every: number, name: string, data: object, stale: boolean) {
    await queue.upsertJobScheduler(id, { every }, { name, data });
    if (stale) {
      await queue.add(name, data, { jobId: `${id}-startup-${Date.now()}` });
    }
  }
  // The league index and the local schedule narrow the catalog to plans and page "upcoming".
  await recurring(
    LEAGUE_INDEX_JOB,
    LEAGUE_INDEX_EVERY_MS,
    LEAGUE_INDEX_JOB,
    {},
    await leagueIndexStale(infrastructure),
  );
  for (const window of ["full", "near"] as const) {
    await recurring(
      `${SCHEDULE_INDEX_JOB}-${window}`,
      SCHEDULE_WINDOWS[window].everyMs,
      SCHEDULE_INDEX_JOB,
      { window },
      window === "full" && (await scheduleIndexStale(infrastructure)),
    );
  }
  // Reads what reaches the platform's Telegram bot to link groups and channels, only while a link
  // code is pending; otherwise a run is one Redis lookup. It keeps no history of its runs.
  await queue.upsertJobScheduler(
    TELEGRAM_POLL_JOB,
    { every: TELEGRAM_POLL_EVERY_MS },
    {
      name: TELEGRAM_POLL_JOB,
      data: {},
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    },
  );
  const beat = () =>
    connection
      .set("pedirr:worker:heartbeat", String(Date.now()), "EX", 60)
      .catch(() => logger.error("Worker heartbeat failed"));
  const heartbeat = setInterval(() => {
    void beat();
  }, 15000);
  await beat();
  worker.on("failed", (job, error) =>
    logger.error({ jobId: job?.id, code: errorCode(error) }, "Job failed"),
  );
  worker.on("error", () => logger.error("Worker connection error"));
  let stopping = false;
  async function shutdown() {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(heartbeat);
    await worker.close();
    await queue.close();
    await connection.quit();
    await infrastructure.onModuleDestroy();
  }
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
  logger.info("Pedirr worker started");
}
void main().catch(() => {
  logger.fatal("Worker startup failed");
  process.exit(1);
});
