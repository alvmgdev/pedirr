const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException } = require('@nestjs/common');
const { ApiExceptionFilter } = require('../dist/errors');
const { logger } = require('../dist/infrastructure');

test('unexpected errors cannot expose driver secrets in logs or HTTP responses', () => {
  const original = logger.error;
  const logs = [];
  logger.error = (...args) => logs.push(args);
  let status, body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; } };
  const host = { switchToHttp: () => ({ getResponse: () => response }) };
  try {
    new ApiExceptionFilter().catch(new Error('database://user:private-password@server private-api-key'), host);
    assert.equal(status, 500);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify({ logs, body }).includes('private-'));
    assert.equal(logs.length, 1);
    new ApiExceptionFilter().catch(new BadRequestException({ code: 'INVALID_TIMEZONE' }), host);
    assert.equal(status, 400);
    assert.deepEqual(body, { code: 'INVALID_TIMEZONE' });
    assert.equal(logs.length, 1);
  } finally { logger.error = original; }
});
