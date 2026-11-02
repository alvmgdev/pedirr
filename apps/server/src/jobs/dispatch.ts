import { Queue } from 'bullmq';
import { Infrastructure } from '../infrastructure';

export async function dispatch(infrastructure: Infrastructure, queue: Queue) {
  const { db } = infrastructure;
  const recoveryCutoff = new Date(Date.now() - 15 * 60000);
  const recoveryBucket = Math.floor(Date.now() / (15 * 60000));
  const pending = await db.outboxEvent.findMany({ where: { OR: [
    { publishedAt: null, type: 'request.fulfill' },
    { processedAt: null, type: { in: ['request.created', 'request.status'] }, OR: [{ publishedAt: null }, { publishedAt: { lt: recoveryCutoff } }] },
  ] }, orderBy: [{ publishedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }], take: 100 });
  for (const event of pending) {
    const payload = event.payload as { requestId: string };
    if (event.publishedAt) {
      const previousJob = await queue.getJob(event.jobId ?? `outbox-${event.id}`);
      const state = await previousJob?.getState();
      if (state && !['completed', 'failed', 'unknown'].includes(state)) {
        // Preserve active work and delayed retries, including upstream Retry-After.
        // Move the next recovery check forward so waiting records cannot starve the batch.
        await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date() } });
        continue;
      }
    }
    const jobId = event.publishedAt ? `recovery-${event.id}-${recoveryBucket}` : `outbox-${event.id}`;
    await queue.add(event.type === 'request.fulfill' ? 'sync' : 'notify', event.type === 'request.fulfill' ? { requestId: payload.requestId } : { eventId: event.id }, { jobId });
    // Queue insertion is idempotent. A crash between these writes republishes the same job ID.
    await db.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: new Date(), jobId } });
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
