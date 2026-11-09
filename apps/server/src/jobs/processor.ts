import { Job, Queue } from "bullmq";
import { Infrastructure } from "../infrastructure";
import { Notifications } from "../notifications/service";
import { dispatch } from "./dispatch";
import { Fulfillment } from "./fulfillment";

export function createProcessor(
  infrastructure: Infrastructure,
  queue: Queue,
  fulfillment: Fulfillment,
  notifications: Notifications,
) {
  return async (job: Job) => {
    if (job.name === "dispatch") return dispatch(infrastructure, queue);
    if (job.name === "notify" && typeof job.data.eventId === "string") {
      await notifications.run(job.data.eventId);
      await infrastructure.db.outboxEvent.updateMany({
        where: { id: job.data.eventId, processedAt: null },
        data: { processedAt: new Date() },
      });
      return;
    }
    if (job.name === "sync" && typeof job.data.requestId === "string")
      return fulfillment.run(job.data.requestId);
    throw new Error("Unsupported work item");
  };
}
