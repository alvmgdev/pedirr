const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { SportarrClient, managerUrl } = require('../dist/managers/sportarr');
const { SecretBox } = require('../dist/settings/secrets');
const { SportarrSettings } = require('../dist/settings/sportarr');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const config = { url: 'http://sportarr:8989/sports', apiKey: 'private-test-key', rootFolderId: 1, qualityProfileId: 2 };
const entry = id => ({ id, externalId: `ev-${id}`, title: 'Game', monitored: true, hasFile: false, files: [] });
test('Sportarr connection preserves URL base and sends credentials only as a header', async () => {
  const paths = [];
  global.fetch = async (url, init) => {
    assert.equal(init.headers['X-Api-Key'], config.apiKey);
    assert.equal(init.redirect, 'error');
    assert.ok(!url.includes(config.apiKey));
    const path = new URL(url).pathname;
    paths.push(path);
    assert.ok(path.startsWith('/sports/api/'));
    if (path.endsWith('system/status')) return Response.json({ appName: 'Sportarr', version: '4.1.0.1110' });
    if (path.endsWith('leagues')) return Response.json([]);
    if (path.endsWith('rootfolder')) return Response.json([{ id: 1, path: '/sports' }]);
    if (path.endsWith('qualityprofile')) return Response.json([{ id: 2, name: 'HD' }]);
    assert.fail('Unexpected endpoint');
  };
  const result = await new SportarrClient(config).testConnection();
  assert.equal(result.version, '4.1.0.1110');
  assert.equal(paths.length, 4);
  assert.equal(result.apiKey, undefined);
});
test('the client rejects another application and redacts upstream failures', async () => {
  const client = new SportarrClient(config);
  global.fetch = async () => Response.json({ appName: 'Sonarr', version: '4' });
  await assert.rejects(client.testConnection(), error => error.getResponse().code === 'SPORTARR_INVALID_RESPONSE');
  global.fetch = async () => new Response('Do not expose upstream body: ' + config.apiKey, { status: 401 });
  await assert.rejects(client.leagues(), error => error.getResponse().code === 'SPORTARR_AUTH_FAILED' && !JSON.stringify(error.getResponse()).includes(config.apiKey));
  global.fetch = async () => { throw new Error(config.apiKey); };
  await assert.rejects(client.leagues(), error => error.getResponse().code === 'SPORTARR_UNREACHABLE' && !error.message.includes(config.apiKey));
});
test('event reconciliation consumes every unfiltered page', async () => {
  const seen = [];
  global.fetch = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('showAll'), 'true');
    const page = Number(parsed.searchParams.get('page')); seen.push(page);
    return Response.json({ page, totalPages: 2, totalRecords: 2, records: [entry(page)] });
  };
  const result = await new SportarrClient(config).events(10);
  assert.deepEqual(result.map(row => row.id), [1, 2]);
  assert.deepEqual(seen, [1, 2]);
});
test('a failed or inconsistent page never returns a partial event list', async () => {
  global.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ page, totalPages: 2, totalRecords: 2, records: [entry(1)] });
  };
  await assert.rejects(new SportarrClient(config).events(10), error => error.getResponse().code === 'SPORTARR_INVALID_RESPONSE');
  global.fetch = async url => new URL(url).searchParams.get('page') === '1'
    ? Response.json({ page: 1, totalPages: 2, totalRecords: 2, records: [entry(1)] })
    : new Response('', { status: 500 });
  await assert.rejects(new SportarrClient(config).events(10), error => error.getResponse().code === 'SPORTARR_HTTP_ERROR');
});
test('URLs reject credential/query tricks while allowing private network installations', () => {
  assert.equal(managerUrl('http://192.168.1.10:8989/sportarr/'), 'http://192.168.1.10:8989/sportarr');
  for (const url of ['file:///etc/passwd', 'http://key:secret@localhost', 'http://localhost?apikey=secret', 'http://localhost/#token']) assert.throws(() => managerUrl(url));
});
test('encrypted settings authenticate the key, context and ciphertext', () => {
  const box = new SecretBox('ab'.repeat(32));
  const first = box.encrypt('secret-value', 'sportarr.apiKey');
  const second = box.encrypt('secret-value', 'sportarr.apiKey');
  assert.notEqual(first, second);
  assert.ok(!first.includes('secret-value'));
  assert.equal(box.decrypt(first, 'sportarr.apiKey'), 'secret-value');
  assert.throws(() => box.decrypt(first, 'smtp.password'));
  assert.throws(() => new SecretBox('cd'.repeat(32)).decrypt(first, 'sportarr.apiKey'));
  const parts = first.split('.');
  const data = Buffer.from(parts[3], 'base64'); data[0] ^= 1; parts[3] = data.toString('base64');
  assert.throws(() => box.decrypt(parts.join('.'), 'sportarr.apiKey'));
});
test('settings persist ciphertext, return no key and cannot reuse it for a different host', async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = 'ab'.repeat(32);
  let stored;
  const settings = new SportarrSettings({ db: { setting: {
    findUnique: async () => stored ? { value: stored } : null,
    upsert: async ({create}) => { stored = create.value; },
  } } });
  global.fetch = async url => {
    if (url.endsWith('system/status')) return Response.json({ appName: 'Sportarr', version: '4.1' });
    if (url.endsWith('leagues')) return Response.json([]);
    if (url.endsWith('rootfolder')) return Response.json([{ id: 1, path: '/sports' }]);
    return Response.json([{ id: 2, name: 'HD' }]);
  };
  const result = await settings.save(config);
  assert.equal(result.hasApiKey, true);
  assert.ok(!JSON.stringify(result).includes(config.apiKey));
  assert.ok(!JSON.stringify(stored).includes(config.apiKey));
  assert.equal((await settings.configuration()).apiKey, config.apiKey);
  assert.equal((await settings.credentials({url: config.url})).apiKey, config.apiKey);
  await assert.rejects(settings.credentials({url: 'http://another-host'}), error => error.getResponse().code === 'API_KEY_REQUIRED');
});
