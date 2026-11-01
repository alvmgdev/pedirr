const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { HubProvider, parsePage, retrySeconds } = require('../dist/metadata/hub');
const { CatalogController } = require('../dist/metadata/controller');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
function fixture() {
  const data = new Map();
  let count = 0;
  const redis = {
    get: async key => data.get(key), del: async key => data.delete(key),
    ttl: async key => key.endsWith('cooldown') ? Number(data.get(key) ?? -2) : 60,
    set: async (key, value, _, __, nx) => {
      if (nx && data.has(key)) return null;
      data.set(key, value); return 'OK';
    },
    eval: async (script, _, key, value) => {
      if (key.endsWith(':budget')) return ++count;
      if (key.endsWith(':cooldown')) { data.set(key, value); return 1; }
      if (data.get(key) === value) data.delete(key);
      return 1;
    },
  };
  return { provider: new HubProvider({ redis }), data, redis };
}
test('search uses the documented contract and reuses shared cached results', async () => {
  const { provider, redis } = fixture();
  let calls = 0;
  global.fetch = async url => {
    calls++;
    assert.equal(url.pathname, '/api/public/v1/search');
    assert.equal(url.searchParams.get('types'), 'league,team,event');
    assert.equal(url.searchParams.get('q'), 'Real Madrid');
    return Response.json({ query: 'Real Madrid', total: 1, results: [{ id: 'uuid', name: 'Real Madrid', shortId: 'tm-123', entityType: 'team' }] });
  };
  const first = await provider.search('Real Madrid');
  const secondReplica = new HubProvider({ redis });
  assert.deepEqual(await secondReplica.search('Real Madrid'), first);
  assert.equal(calls, 1);
});
test('429 cooldown applies to other routes and honors Retry-After', async () => {
  const { provider } = fixture();
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '120' } }); };
  await assert.rejects(provider.league('nfl'), error => error.getResponse().retryAfterSeconds === 120);
  await assert.rejects(provider.team('arsenal'), error => error.getResponse().retryAfterSeconds === 120);
  assert.equal(calls, 1);
  assert.equal(retrySeconds('invalid'), 60);
  assert.ok(retrySeconds(new Date(Date.now() + 30000).toUTCString()) >= 29);
});
test('malformed pages fail without being cached and release the request lock', async () => {
  const { provider } = fixture();
  global.fetch = async () => Response.json({ items: [{ title: 'Missing identity' }], total: 1, page: 1, pageSize: 50, totalPages: 1 });
  await assert.rejects(provider.events({ page: 1 }), error => error.getResponse().code === 'METADATA_INVALID');
  global.fetch = async () => Response.json({ items: [], total: 0, page: 1, pageSize: 50, totalPages: 0 });
  assert.equal((await provider.events({ page: 1 })).total, 0);
  assert.throws(() => parsePage({ items: [], total: 0, page: -1, pageSize: 50, totalPages: 0 }));
});
test('event filters preserve explicit season and provider identifiers', async () => {
  const { provider } = fixture();
  global.fetch = async url => {
    assert.equal(url.searchParams.get('league'), 'league-uuid');
    assert.equal(url.searchParams.get('season'), 'sn-123');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('page_size'), '50');
    return Response.json({ items: [{ id: 'event-uuid', shortId: 'ev-123', tsdbId: '987', name: 'Final' }], total: 51, page: 2, pageSize: 50, totalPages: 2 });
  };
  const page = await provider.events({ league: 'league-uuid', season: 'sn-123', page: 2 });
  assert.equal(page.items[0].tsdbId, '987');
  assert.equal(page.items[0].shortId, 'ev-123');
});
test('upcoming excludes past, cancelled, and undated entries while preserving pagination', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const metadata = { events: async () => ({ page: 1, totalPages: 3, items: [
    { id: 'past', scheduledStart: '2000-01-01T00:00:00Z' },
    { id: 'future', scheduledStart: future },
    { id: 'cancelled', scheduledStart: future, status: 'cancelled' },
    { id: 'undated', scheduledStart: null },
  ] }) };
  const controller = new CatalogController(metadata, { rate: async () => {} }, {});
  const result = await controller.upcoming({ page: 1 }, { viewer: { id: 'viewer' } });
  assert.deepEqual(result.items.map(item => item.id), ['future']);
  assert.equal(result.hasMore, true);
});
