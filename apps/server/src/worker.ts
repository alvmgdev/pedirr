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
  const notifications = new Notifications(infrastructure, new NotificationSettings(infrastructure));
  const worker = new Worker(
    "pedirr-work",
    createProcessor(infrastructure, queue, fulfillment, notifications, metadata),
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
  // The league index lets the catalog be filtered by plan; refresh it daily and when missing.
  await queue.upsertJobScheduler(
    "league-index",
    { every: LEAGUE_INDEX_EVERY_MS },
    { name: LEAGUE_INDEX_JOB, data: {} },
  );
  if (await leagueIndexStale(infrastructure)) {
    await queue.add(LEAGUE_INDEX_JOB, {}, { jobId: `${LEAGUE_INDEX_JOB}-startup-${Date.now()}` });
  }
  // The local schedule pages and filters "upcoming" and lets users on a plan search events.
  for (const window of ["full", "near"] as const) {
    await queue.upsertJobScheduler(
      `${SCHEDULE_INDEX_JOB}-${window}`,
      { every: SCHEDULE_WINDOWS[window].everyMs },
      { name: SCHEDULE_INDEX_JOB, data: { window } },
    );
  }
  if (await scheduleIndexStale(infrastructure)) {
    await queue.add(
      SCHEDULE_INDEX_JOB,
      { window: "full" },
      { jobId: `${SCHEDULE_INDEX_JOB}-startup-${Date.now()}` },
    );
  }
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
