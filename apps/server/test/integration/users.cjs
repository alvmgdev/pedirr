const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { UsersService } = require('../../dist/users');

async function main() {
  const schema = 'test_users_' + randomUUID().replaceAll('-', '');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url.href }, stdio: 'ignore',
    });
    const users = await Promise.all(['first', 'second'].map(name => db.user.create({
      data: { email: `${name}@example.invalid`, passwordHash: 'unused-test-fixture', role: 'ADMIN' },
    })));
    await db.session.createMany({ data: users.map(user => ({
      userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60000),
    })) });
    const service = new UsersService({ db });
    const detail = await service.detail(users[0].id);
    assert.equal(detail.email, users[0].email);
    assert.equal(Object.hasOwn(detail, 'passwordHash'), false);
    await assert.rejects(service.detail(randomUUID()), error => error.getResponse().code === 'USER_NOT_FOUND');
    const results = await Promise.allSettled(users.map(user => service.update(user.id, { active: false })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.getResponse().code, 'LAST_ADMIN');
    assert.equal(await db.user.count({ where: { active: true, role: 'ADMIN' } }), 1);
    const disabled = await db.user.findFirstOrThrow({ where: { active: false } });
    assert.equal(await db.session.count({ where: { userId: disabled.id } }), 0);
    assert.equal(await db.session.count(), 1);
    console.log('Concurrent administrator changes preserve one active admin and revoke disabled sessions.');
  } finally {
    // The identifier is generated locally from a UUID, never from external input.
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
}
main().catch(() => { console.error('Administrator database integration test failed.'); process.exitCode = 1; });
