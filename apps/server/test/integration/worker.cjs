const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const { Queue, QueueEvents, Worker } = require('bullmq');
const { RequestsService } = require('../../dist/requests/service');
const { Fulfillment } = require('../../dist/jobs/fulfillment');
const { Notifications } = require('../../dist/notifications/service');
const { createProcessor } = require('../../dist/jobs/processor');

async function main() {
  const prefix = 'test_worker_' + randomUUID().replaceAll('-', '');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', prefix);
  const db = new PrismaClient({ datasourceUrl: url.href });
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const redis = new Redis(process.env.REDIS_URL, { keyPrefix: prefix + ':', maxRetriesPerRequest: 1 });
  const queue = new Queue('work', { connection, prefix });
  const events = new QueueEvents('work', { connection, prefix });
  let worker;
  let imported = false, downloading = false, searches = 0;
  const writes = [], deliveries = [];
  const league = { id: 'league', shortId: 'lg-100', name: 'Fixture League', sportName: 'Soccer' };
  const event = { id: 'event', shortId: 'ev-100', leagueId: 'league', name: 'Fixture Final', scheduledStart: '2020-01-01T12:00:00Z' };
  const managerLeague = { id: 8, externalId: 'lg-100', name: league.name, sport: 'Soccer', monitored: true, monitorType: 'All', monitoredTeamIds: [42] };
  let managerEvent;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-api-key'], 'fixture-key');
      const path = new URL(req.url, 'http://localhost').pathname;
      let result;
      if (req.method === 'GET' && path === '/api/system/status') result = { appName: 'Sportarr', version: '4.1.11' };
      else if (req.method === 'GET' && path === '/api/leagues') result = [managerLeague];
      else if (req.method === 'GET' && path === '/api/leagues/8/events') {
        const records = managerEvent ? [{ ...managerEvent, hasFile: imported, files: imported ? [{ exists: true }] : [] }] : [];
        result = { records, page: 1, totalPages: 1, totalRecords: records.length };
      } else if (req.method === 'GET' && path === '/api/queue') result = downloading ? [{ eventId: 9, status: 1, progress: 50 }] : [];
      else if (req.method === 'POST' && path === '/api/events') {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); writes.push(input);
        assert.equal(input.externalId, 'ev-100'); assert.equal(input.leagueId, 8);
        assert.equal(input.monitored, true); assert.equal(input.searchOnAdd, false);
        managerEvent = { ...input, id: 9, hasFile: false, files: [] };
        result = { id: 9 };
      } else if (req.method === 'GET' && path === '/api/events/9') result = managerEvent;
      else if (req.method === 'POST' && path === '/api/event/9/automatic-search') { searches++; result = {}; }
      else throw new Error(`Unexpected fixture operation: ${req.method} ${path}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500); res.end('{}'); fixtureErrors.push(error); }
  });
  const fixtureErrors = [];
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.href }, stdio: 'ignore' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await events.waitUntilReady();
    process.env.APP_ORIGIN = 'http://localhost:3187';
    const infrastructure = { db, redis };
    const metadata = { league: async () => league, event: async () => event };
    const fulfillment = new Fulfillment(infrastructure, metadata, { configuration: async () => ({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture-key', rootFolderId: 1, qualityProfileId: 2 }) });
    const notifications = new Notifications(infrastructure, { configuration: async () => ({ emailEnabled: true, emailSince: '2020-01-01', discordEnabled: false }) }, {
      send: async (_config, recipient, notice, id) => { deliveries.push({ recipient, notice, id }); },
    });
    worker = new Worker('work', createProcessor(infrastructure, queue, fulfillment, notifications), { connection, prefix, concurrency: 1 });
    const failed = []; worker.on('failed', (_job, error) => failed.push(error));
    async function run(name, data = {}) {
      const job = await queue.add(name, data);
      await job.waitUntilFinished(events, 15000);
    }
    async function drain() {
      const deadline = Date.now() + 15000;
      while (await queue.getWaitingCount() || await queue.getActiveCount()) {
        if (Date.now() > deadline) throw new Error('Queue did not drain');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.deepEqual(failed, []); assert.deepEqual(fixtureErrors, []);
    }
    const admin = await db.user.create({ data: { email: 'admin@example.invalid', passwordHash: 'unused', role: 'ADMIN' } });
    const user = await db.user.create({ data: { email: 'user@example.invalid', passwordHash: 'unused', locale: 'es' } });
    const requests = new RequestsService(infrastructure, metadata, { check: async () => ({ state: 'missing' }) });
    const created = await requests.create({ kind: 'event', identifier: event.id }, user);
    assert.equal(created.request.status, 'PENDING');
    await run('dispatch'); await drain();
    assert.equal(writes.length, 0); assert.equal(deliveries.length, 2);
    const approved = await requests.moderate(created.request.id, { decision: 'approve', version: created.request.version }, admin);
    assert.equal(approved.status, 'APPROVED');
    await run('dispatch'); await drain();
    assert.equal(writes.length, 1); assert.equal(searches, 1);
    downloading = true;
    await run('sync', { requestId: approved.id });
    assert.equal((await db.request.findUnique({ where: { id: approved.id } })).status, 'DOWNLOADING');
    downloading = false; imported = true;
    await run('sync', { requestId: approved.id });
    await run('dispatch'); await drain();
    assert.equal((await db.request.findUnique({ where: { id: approved.id } })).status, 'AVAILABLE');
    assert.equal(deliveries.length, 5);
    assert.match(deliveries.at(-1).notice.text, /Disponible/);
    const outbox = await db.outboxEvent.findMany({ where: { type: { in: ['request.created', 'request.status'] } } });
    for (const record of outbox) await run('notify', { eventId: record.id });
    await run('dispatch'); await drain();
    assert.equal(deliveries.length, 5); assert.equal(searches, 1); assert.equal(writes.length, 1);
    assert.equal(await db.notificationDelivery.count({ where: { status: 'sent' } }), 5);
    assert.equal(managerLeague.monitorType, 'All'); assert.deepEqual(managerLeague.monitoredTeamIds, [42]);
    const duplicate = await requests.create({ kind: 'event', identifier: event.id }, user);
    assert.equal(duplicate.created, false); assert.equal(duplicate.request.id, approved.id);
    console.log('Worker integration passed: pending/approval, real queue dispatch, native HTTP writes, downloading/imported states, localized delivery and replay deduplication.');
  } finally {
    if (worker) await worker.close();
    await queue.obliterate({ force: true });
    await events.close(); await queue.close();
    const keys = await connection.keys(prefix + ':*');
    if (keys.length) await connection.del(...keys);
    await redis.quit(); await connection.quit();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${prefix}" CASCADE`); await db.$disconnect();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
