const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RequestsService } = require('../dist/requests/service');
test('an event without a league cannot create an unscoped request', async () => {
  const service = new RequestsService({ db: { $transaction: () => assert.fail('Must not write') } }, {
    event: async () => ({ id: 'event', name: 'Incomplete metadata' }),
  });
  await assert.rejects(service.create({ kind: 'event', identifier: 'event' }, {}), error => error.getResponse().code === 'INVALID_TARGET');
});
test('an inactive season cannot silently expand to the whole league', async () => {
  const service = new RequestsService({ db: { $transaction: () => assert.fail('Must not write') } }, {
    season: async () => ({ id: 'season', name: 'Season', leagueId: 'league', isActive: false }),
  });
  await assert.rejects(service.create({ kind: 'season', identifier: 'season' }, {}), error => error.getResponse().code === 'INVALID_TARGET');
});
test('ordinary users cannot invoke moderation through the service', async () => {
  const service = new RequestsService({}, {});
  await assert.rejects(service.moderate('request', { decision: 'approve', version: 0 }, { role: 'USER' }), error => error.getStatus() === 403);
});
