import 'reflect-metadata';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { HttpException } from '@nestjs/common';
import { required } from './config';
import { Infrastructure, logger } from './infrastructure';
import { HubProvider } from './metadata/hub';
import { SportarrSettings } from './settings/sportarr';
import { Fulfillment, errorCode } from './jobs/fulfillment';
import { dispatch } from './jobs/dispatch';

async function main() {
  const infrastructure = new Infrastructure();
  const connection = new Redis(required('REDIS_URL'), { maxRetriesPerRequest: null });
  const queue = new Queue('pedirr-work', { connection, defaultJobOptions: {
    attempts: 5, backoff: { type: 'pedirr' }, removeOnComplete: { age: 172800 }, removeOnFail: { age: 604800 },
  } });
  const fulfillment = new Fulfillment(infrastructure, new HubProvider(infrastructure), new SportarrSettings(infrastructure));
  const worker = new Worker('pedirr-work', async job => {
    if (job.name === 'dispatch') return dispatch(infrastructure, queue);
    if (job.name === 'sync' && typeof job.data.requestId === 'string') return fulfillment.run(job.data.requestId);
    throw new Error('Unsupported work item');
  }, { connection, concurrency: 1, settings: { backoffStrategy: (attempts, _type, error) => {
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (typeof body === 'object' && 'retryAfterSeconds' in body && typeof body.retryAfterSeconds === 'number') return Math.max(1000, body.retryAfterSeconds * 1000);
    }
    return Math.min(3600000, 30000 * 2 ** (attempts - 1));
  } } });
  await queue.upsertJobScheduler('dispatcher', { every: 60000 }, { name: 'dispatch', data: {} });
  await queue.add('dispatch', {}, { jobId: `startup-${Date.now()}` });
  const beat = () => connection.set('pedirr:worker:heartbeat', String(Date.now()), 'EX', 60)
    .catch(() => logger.error('Worker heartbeat failed'));
  const heartbeat = setInterval(() => { void beat(); }, 15000);
  await beat();
  worker.on('failed', (job, error) => logger.error({ jobId: job?.id, code: errorCode(error) }, 'Job failed'));
  worker.on('error', () => logger.error('Worker connection error'));
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    await worker.close();
    await queue.close();
    await connection.quit();
    await infrastructure.onModuleDestroy();
  }
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  logger.info('Pedirr worker started');
}
void main().catch(() => { logger.fatal('Worker startup failed'); process.exitCode = 1; });
