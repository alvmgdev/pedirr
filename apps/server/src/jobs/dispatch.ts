import { Queue } from 'bullmq';
import { Infrastructure } from '../infrastructure';

export async function dispatch(infrastructure: Infrastructure, queue: Queue) {
  const { db } = infrastructure;
  const pending = await db.outboxEvent.findMany({ where: { publishedAt: null, type: { in: ['request.fulfill', 'request.created', 'request.status'] } }, orderBy: { createdAt: 'asc' }, take: 100 });
  for (const event of pending) {
    const payload = event.payload as { requestId: string };
    await queue.add(event.type === 'request.fulfill' ? 'sync' : 'notify', event.type === 'request.fulfill' ? { requestId: payload.requestId } : { eventId: event.id }, { jobId: `outbox-${event.id}` });
    // Queue insertion is idempotent. A crash between these writes republishes the same job ID.
    await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
  }
  const bucket = Math.floor(Date.now() / 300000);
  let cursor: string | undefined;
  while (true) {
    const requests = await db.request.findMany({ where: { status: { in: ['APPROVED', 'DOWNLOADING', 'AVAILABLE'] } }, select: { id: true }, orderBy: { id: 'asc' }, take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const request of requests) await queue.add('sync', { requestId: request.id }, { jobId: `sync-${request.id}-${bucket}` });
    if (requests.length < 100) break;
    cursor = requests[requests.length - 1].id;
  }
}
