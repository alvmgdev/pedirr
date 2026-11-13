import { Prisma, RequestStatus } from "@prisma/client";
import { subscriberStatus } from "./parts";

/**
 * Recomputes every subscriber's own status after a review, a new part or a synchronization.
 * Requests with parts notify each user whose status changed; requests without parts keep
 * their single request-level notification, emitted by the caller.
 */
export async function refreshSubscribers(tx: Prisma.TransactionClient, requestId: string) {
  const request = await tx.request.findUniqueOrThrow({
    where: { id: requestId },
    include: { parts: true, events: { where: { active: true } }, subscribers: true },
  });
  const changed = new Map<RequestStatus, string[]>();
  for (const subscriber of request.subscribers) {
    const status = subscriberStatus({
      requestStatus: request.status,
      requestParts: request.parts,
      userParts: subscriber.parts,
      events: request.events,
      closed: request.closed,
    });
    if (status === subscriber.status) {
      continue;
    }
    await tx.requestSubscriber.update({
      where: { requestId_userId: { requestId, userId: subscriber.userId } },
      data: { status },
    });
    changed.set(status, [...(changed.get(status) ?? []), subscriber.userId]);
  }
  if (request.parts.length) {
    for (const [status, userIds] of changed) {
      await tx.outboxEvent.create({
        data: { type: "request.status", payload: { requestId, status, userIds } },
      });
    }
  }
}
