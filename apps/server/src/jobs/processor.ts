import { Job, Queue } from "bullmq";
import { Infrastructure } from "../infrastructure";
import { Notifications } from "../notifications/service";
import { dispatch } from "./dispatch";
import { Fulfillment } from "./fulfillment";
import { indexLeagues, LEAGUE_INDEX_JOB } from "./league-index";
import { indexSchedule, SCHEDULE_INDEX_JOB } from "./schedule-index";
import { MetadataProvider } from "../metadata/provider";

export function createProcessor(
  infrastructure: Infrastructure,
  queue: Queue,
  fulfillment: Fulfillment,
  notifications: Notifications,
  metadata: MetadataProvider,
) {
  return async (job: Job) => {
    if (job.name === "dispatch") {
      return dispatch(infrastructure, queue);
    }
    if (job.name === "notify" && typeof job.data.eventId === "string") {
      await notifications.run(job.data.eventId);
      await infrastructure.db.outboxEvent.updateMany({
        where: { id: job.data.eventId, processedAt: null },
        data: { processedAt: new Date() },
      });
      return;
    }
    if (job.name === LEAGUE_INDEX_JOB) {
      return indexLeagues(infrastructure, metadata, queue, job.data);
    }
    if (job.name === SCHEDULE_INDEX_JOB) {
      return indexSchedule(infrastructure, metadata, queue, job.data);
    }
    if (job.name === "sync" && typeof job.data.requestId === "string") {
      return fulfillment.run(job.data.requestId);
    }
    throw new Error("Unsupported work item");
  };
}
