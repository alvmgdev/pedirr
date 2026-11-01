import 'reflect-metadata';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { required } from './config';
import { logger } from './infrastructure';

const connection = new Redis(required('REDIS_URL'), { maxRetriesPerRequest: null });
const worker = new Worker('pedirr-maintenance', async (job) => {
  if (job.name !== 'heartbeat') throw new Error(`Unsupported maintenance job: ${job.name}`);
  logger.debug({ jobId: job.id }, 'Maintenance job completed');
}, { connection });

const heartbeat = setInterval(() => {
  connection.set('pedirr:worker:heartbeat', String(Date.now()), 'EX', 60)
    .catch((err: unknown) => logger.error({ err }, 'Worker heartbeat failed'));
}, 15000);
connection.set('pedirr:worker:heartbeat', String(Date.now()), 'EX', 60)
  .catch((err: unknown) => logger.error({ err }, 'Worker heartbeat failed'));
worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Job failed'));
worker.on('error', (err) => logger.error({ err }, 'Worker error'));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  await worker.close();
  await connection.quit();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
logger.info('Pedirr worker started');
