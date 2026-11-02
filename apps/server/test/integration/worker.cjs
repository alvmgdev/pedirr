require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const { Queue, QueueEvents, Worker } = require('bullmq');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { completeOpenApi } = require('../../dist/openapi');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const cookieParser = require('cookie-parser');
const argon2 = require('argon2');
const { AppModule } = require('../../dist/app.module');
const { Infrastructure } = require('../../dist/infrastructure');
const { MetadataProvider } = require('../../dist/metadata/provider');
const { SportarrSettings } = require('../../dist/settings/sportarr');
const { NotificationSettings } = require('../../dist/settings/notifications');
const { passwordOptions } = require('../../dist/auth');
const { smtpFixture } = require('../fixtures/smtp.cjs');
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
  let worker, app, smtp;
  let imported = false, downloading = false, searches = 0;
  const writes = [];
  const league = { id: 'league', shortId: 'lg-100', name: 'Fixture League', sportName: 'Soccer' };
  const event = { id: 'event', shortId: 'ev-100', leagueId: 'league', name: 'Fixture Final', scheduledStart: '2020-01-01T12:00:00Z' };
  const managerLeague = { id: 8, externalId: 'lg-100', name: league.name, sport: 'Soccer', monitored: true, monitorType: 'All', monitoredTeamIds: [42] };
  const managerEvents = new Map();
  const season = { id: 'season', name: '2020', leagueId: league.id, isCurrent: true, endDate: '2020-12-31' };
  const seasonEvents = [
    { ...event, id: 'season-event-1', shortId: 'ev-101', seasonId: season.id, status: 'completed' },
    { ...event, id: 'season-event-2', shortId: 'ev-102', seasonId: season.id, status: 'completed' },
    { ...event, id: 'season-event-3', shortId: 'ev-103', seasonId: season.id, status: 'cancelled' },
    { ...event, id: 'season-event-4', shortId: 'ev-104', seasonId: season.id, status: 'completed', isActive: false },
  ];
  let invalidSeasonPage = false;
  const seasonPages = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-api-key'], 'fixture-key');
      const path = new URL(req.url, 'http://localhost').pathname;
      let result;
      if (req.method === 'GET' && path === '/api/system/status') result = { appName: 'Sportarr', version: '4.1.11' };
      else if (req.method === 'GET' && path === '/api/rootfolder') result = [{ id: 1, path: '/sports' }];
      else if (req.method === 'GET' && path === '/api/qualityprofile') result = [{ id: 2, name: 'Fixture profile' }];
      else if (req.method === 'GET' && path === '/api/leagues') result = [managerLeague];
      else if (req.method === 'GET' && path === '/api/leagues/8/events') {
        const records = [...managerEvents.values()].map(item => ({ ...item, hasFile: imported, files: imported ? [{ exists: true }] : [] }));
        result = { records, page: 1, totalPages: 1, totalRecords: records.length };
      } else if (req.method === 'GET' && path === '/api/queue') result = downloading ? [{ eventId: 9, status: 1, progress: 50 }] : [];
      else if (req.method === 'POST' && path === '/api/events') {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); writes.push(input);
        assert.ok(['ev-100', 'ev-101', 'ev-102'].includes(input.externalId)); assert.equal(input.leagueId, 8);
        assert.equal(input.monitored, true); assert.equal(input.searchOnAdd, false);
        const id = 9 + managerEvents.size;
        managerEvents.set(id, { ...input, id, hasFile: false, files: [] });
        result = { id };
      } else if (req.method === 'GET' && /^\/api\/events\/\d+$/.test(path)) result = managerEvents.get(Number(path.split('/').at(-1)));
      else if (req.method === 'POST' && /^\/api\/event\/\d+\/automatic-search$/.test(path)) { searches++; result = {}; }
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
    process.env.SESSION_SECRET = randomUUID() + randomUUID();
    process.env.SETTINGS_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('hex');
    const infrastructure = { db, redis };
    const metadata = {
      league: async () => league, event: async () => event, season: async () => season,
      events: async filters => {
        assert.equal(filters.league, league.id); assert.equal(filters.season, season.id);
        seasonPages.push(filters.page);
        const items = seasonEvents.slice((filters.page - 1) * 2, filters.page * 2).map(item => ({ ...item }));
        if (invalidSeasonPage && filters.page === 2) items[0].seasonId = 'another-season';
        return { items, total: 4, page: filters.page, pageSize: 2, totalPages: 2 };
      },
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Infrastructure).useValue(infrastructure)
      .overrideProvider(MetadataProvider).useValue(metadata).compile();
    app = module.createNestApplication({ logger: false });
    app.use(cookieParser()); app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const specification = completeOpenApi(SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Pedirr API').setVersion('1.0').setDescription('Test contracts').build()), process.env.APP_ORIGIN);
    const ajv = new Ajv({ strict: false }); addFormats(ajv);
    const contracts = [];
    for (const [path, item] of Object.entries(specification.paths)) {
      for (const method of ['get', 'post', 'put', 'patch']) {
        const operation = item[method]; if (!operation) continue;
        const success = operation.responses[method === 'post' ? '201' : '200'];
        const validate = ajv.compile({ components: specification.components, ...success.content['application/json'].schema });
        contracts.push({ method: method.toUpperCase(), pattern: new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+') + '$'), validate });
        if (path.startsWith('/api/v1/admin/')) assert.deepEqual(operation.security, [{ Session: [] }]);
      }
    }
    assert.equal(specification.components.securitySchemes.Session.name, 'pedirr_session');
    assert.deepEqual(specification.paths['/api/v1/auth/login'].post.security, []);

    async function call(path, { method = 'GET', body, cookie = '', csrf = true, status = 200 } = {}) {
      const headers = { Cookie: cookie, Origin: process.env.APP_ORIGIN };
      if (method !== 'GET' && csrf) {
        const response = await fetch(base + '/api/v1/auth/csrf', { headers });
        assert.equal(response.status, 200);
        headers['x-csrf-token'] = (await response.json()).token;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + '/api/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(response.status, status, `${method} ${path}`);
      const result = await response.json();
      if (response.ok) {
        const contract = contracts.find(item => item.method === method && item.pattern.test('/api/v1/' + path));
        assert.ok(contract, `Missing response contract: ${method} ${path}`);
        assert.ok(contract.validate(result), `Response contract failed: ${method} ${path}: ${JSON.stringify(contract.validate.errors)}`);
      }
      return { body: result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    smtp = await smtpFixture();
    const fulfillment = new Fulfillment(infrastructure, metadata, app.get(SportarrSettings));
    const notifications = new Notifications(infrastructure, app.get(NotificationSettings));
    worker = new Worker('work', createProcessor(infrastructure, queue, fulfillment, notifications), { connection, prefix, concurrency: 1 });
    const failed = []; worker.on('failed', (_job, error) => failed.push(error));
    async function consumeFailure() {
      const deadline = Date.now() + 5000;
      while (!failed.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(failed.length, 1); failed.length = 0;
    }

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
    const password = randomUUID();
    const passwordHash = await argon2.hash(password, passwordOptions);
    await db.user.create({ data: { email: 'admin@example.invalid', passwordHash, role: 'ADMIN' } });
    await db.user.create({ data: { email: 'user@example.invalid', passwordHash, locale: 'es' } });
    const admin = (await call('auth/login', { method: 'POST', body: { email: 'admin@example.invalid', password }, status: 201 })).cookie;
    const user = (await call('auth/login', { method: 'POST', body: { email: 'user@example.invalid', password }, status: 201 })).cookie;
    assert.ok(admin); assert.ok(user);
    await call('auth/me', { cookie: user });
    await call('admin/users', { cookie: admin });
    await call('admin/policies', { cookie: admin });
    await call('admin/settings/sportarr', { cookie: admin });
    await call('admin/settings/notifications', { cookie: admin });
    for (const body of [{ locale: null }, { timezone: null }, { timezone: '' }, { timezone: 'Not/A_Zone' }]) {
      await call('me', { method: 'PATCH', cookie: user, body, status: 400 });
    }
    const profile = (await call('me', { method: 'PATCH', cookie: user, body: { timezone: 'Europe/Madrid' } })).body;
    assert.equal(profile.timezone, 'Europe/Madrid'); assert.equal(profile.locale, 'es');
    await call('requests', { status: 401 });
    await call('requests', { method: 'POST', cookie: user, csrf: false, body: { kind: 'event', identifier: event.id }, status: 403 });
    await call('requests', { method: 'POST', cookie: user, body: { kind: 'event', identifier: event.id, unexpected: true }, status: 400 });
    const settings = { url: `http://127.0.0.1:${server.address().port}`, apiKey: 'fixture-key', rootFolderId: 1, qualityProfileId: 2 };
    await call('admin/settings/sportarr', { method: 'PUT', cookie: user, body: settings, status: 403 });
    const saved = await call('admin/settings/sportarr', { method: 'PUT', cookie: admin, body: settings });
    assert.equal(saved.body.hasApiKey, true); assert.equal(saved.body.apiKey, undefined);
    assert.ok(!(JSON.stringify((await db.setting.findUnique({ where: { key: 'sportarr' } })).value).includes('fixture-key')));
    await call('admin/settings/notifications', { method: 'PUT', cookie: admin, body: {
      emailEnabled: true, smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'plain', smtpUser: '',
      emailFrom: 'pedirr@example.invalid', discordEnabled: false, discordLocale: 'en',
    } });
    const created = (await call('requests', { method: 'POST', cookie: user, body: { kind: 'event', identifier: event.id }, status: 201 })).body;
    assert.equal(created.request.status, 'PENDING');
    await run('dispatch'); await drain();
    assert.equal(writes.length, 0); assert.equal(smtp.messages.length, 2);
    const review = { decision: 'approve', version: created.request.version };
    await call(`requests/${created.request.id}/review`, { method: 'POST', cookie: user, body: review, status: 403 });
    const approved = (await call(`requests/${created.request.id}/review`, { method: 'POST', cookie: admin, body: review, status: 201 })).body;
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
    assert.equal(smtp.messages.length, 5);
    assert.match(smtp.messages.at(-1), /Disponible/);
    const detail = (await call(`requests/${approved.id}`, { cookie: user })).body;
    assert.equal(detail.status, 'AVAILABLE'); assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0].available, true); assert.equal(detail.subscribed, true);
    await call('requests', { cookie: user });
    await call('admin/settings/notifications/deliveries', { cookie: admin });
    assert.equal(await db.session.count(), 2);
    const outbox = await db.outboxEvent.findMany({ where: { type: { in: ['request.created', 'request.status'] } } });
    for (const record of outbox) await run('notify', { eventId: record.id });
    await run('dispatch'); await drain();
    assert.equal(smtp.messages.length, 5); assert.equal(searches, 1); assert.equal(writes.length, 1);
    assert.equal(await db.notificationDelivery.count({ where: { status: 'sent' } }), 5);
    assert.equal(managerLeague.monitorType, 'All'); assert.deepEqual(managerLeague.monitoredTeamIds, [42]);
    const duplicate = (await call('requests', { method: 'POST', cookie: user, body: { kind: 'event', identifier: event.id }, status: 201 })).body;
    assert.equal(duplicate.created, false); assert.equal(duplicate.request.id, approved.id);
    assert.equal(await db.outboxEvent.count({ where: { type: { in: ['request.created', 'request.status'] }, processedAt: null } }), 0);
    // A published notification with no surviving Redis job must be recovered from PostgreSQL.
    const stale = new Date(Date.now() - 16 * 60000);
    const lost = await db.outboxEvent.create({ data: { type: 'request.status', publishedAt: stale, payload: { requestId: approved.id, status: 'AVAILABLE' } } });
    await run('dispatch'); await drain();
    assert.equal(smtp.messages.length, 6);
    assert.ok((await db.outboxEvent.findUnique({ where: { id: lost.id } })).processedAt);
    // A delayed retry still in Redis must retain its delay instead of being recovered early.
    const delayed = await db.outboxEvent.create({ data: { type: 'request.status', publishedAt: stale, payload: { requestId: approved.id, status: 'AVAILABLE' } } });
    const delayedJob = await queue.add('notify', { eventId: delayed.id }, { jobId: `outbox-${delayed.id}`, delay: 3600000 });
    await run('dispatch'); await drain();
    assert.equal(smtp.messages.length, 6);
    assert.equal(await delayedJob.getState(), 'delayed');
    assert.equal((await db.outboxEvent.findUnique({ where: { id: delayed.id } })).processedAt, null);
    await delayedJob.remove();
    await db.outboxEvent.delete({ where: { id: delayed.id } });
    // Exhaust the queue attempt, restore SMTP, then recover the unfinished outbox event.
    const retry = await db.outboxEvent.create({ data: { type: 'request.status', publishedAt: new Date(), payload: { requestId: approved.id, status: 'AVAILABLE' } } });
    smtp.failNext();
    await assert.rejects(run('notify', { eventId: retry.id }));
    assert.equal((await db.outboxEvent.findUnique({ where: { id: retry.id } })).processedAt, null);
    assert.equal((await db.notificationDelivery.findFirst({ where: { eventId: retry.id } })).status, 'failed');
    await consumeFailure();
    await db.outboxEvent.update({ where: { id: retry.id }, data: { publishedAt: stale } });
    await run('dispatch'); await drain();
    assert.equal(smtp.messages.length, 7);
    assert.ok((await db.outboxEvent.findUnique({ where: { id: retry.id } })).processedAt);
    assert.equal((await db.notificationDelivery.findFirst({ where: { eventId: retry.id } })).attempts, 2);
    await run('dispatch'); await drain();
    assert.equal(smtp.messages.length, 7);
    // Exercise a complete season through the same authenticated API and native HTTP adapter.
    imported = false;
    const seasonRequest = (await call('requests', { method: 'POST', cookie: user, body: { kind: 'season', identifier: season.id }, status: 201 })).body.request;
    assert.equal(seasonRequest.scope.kind, 'season'); assert.equal(seasonRequest.scope.season.id, season.id);
    await call(`requests/${seasonRequest.id}/review`, { method: 'POST', cookie: admin, body: { decision: 'approve', version: seasonRequest.version }, status: 201 });
    await run('dispatch'); await drain();
    assert.ok(seasonPages.length >= 2 && seasonPages.length % 2 === 0);
    for (let index = 0; index < seasonPages.length; index += 2) assert.deepEqual(seasonPages.slice(index, index + 2), [1, 2]);
    assert.deepEqual(writes.map(item => item.externalId), ['ev-100', 'ev-101', 'ev-102']);
    const scoped = await db.requestEvent.findMany({ where: { requestId: seasonRequest.id, active: true }, orderBy: { externalId: 'asc' } });
    assert.deepEqual(scoped.map(item => item.externalId), ['season-event-1', 'season-event-2']);
    imported = true;
    await run('sync', { requestId: seasonRequest.id });
    assert.equal((await call(`requests/${seasonRequest.id}`, { cookie: user })).body.status, 'APPROVED');
    season.isCurrent = false;
    await run('sync', { requestId: seasonRequest.id });
    const completed = (await call(`requests/${seasonRequest.id}`, { cookie: user })).body;
    assert.equal(completed.status, 'AVAILABLE'); assert.ok(completed.events.every(item => item.available));
    invalidSeasonPage = true;
    const before = writes.length;
    await assert.rejects(run('sync', { requestId: seasonRequest.id }));
    await consumeFailure();
    assert.equal(writes.length, before);
    assert.equal((await db.request.findUnique({ where: { id: seasonRequest.id } })).lastError, 'REQUEST_METADATA_CHANGED');
    invalidSeasonPage = false;
    await run('sync', { requestId: seasonRequest.id });
    assert.equal((await db.request.findUnique({ where: { id: seasonRequest.id } })).lastError, null);
    assert.equal(managerLeague.monitorType, 'All'); assert.deepEqual(managerLeague.monitoredTeamIds, [42]);
    await call('auth/logout', { method: 'POST', cookie: user, status: 201 });
    await call('auth/me', { cookie: user, status: 401 });
    console.log('HTTP-to-SMTP integration passed: login/CSRF/roles, encrypted settings, pending/approval, real queue dispatch, native HTTP writes, downloading/imported states, local SMTP delivery, replay deduplication, lost-job/failed-delivery recovery, and paginated scoped-season completion.');
  } finally {
    if (worker) await worker.close();
    if (app) await app.close();
    if (smtp) await smtp.close();
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
