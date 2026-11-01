import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { required } from './config';

async function main() {
  const email = required('ADMIN_EMAIL').trim().toLowerCase();
  const password = required('ADMIN_PASSWORD');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) throw new Error('Valid ADMIN_EMAIL and 12-128 character ADMIN_PASSWORD required');
  const db = new PrismaClient();
  try {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(192837)`;
      if (await tx.user.count({ where: { role: 'ADMIN' } })) throw new Error('Administrator already exists; use user management');
      await tx.user.create({ data: { email, passwordHash, role: 'ADMIN' } });
    });
    console.log('Administrator created');
  } finally { await db.$disconnect(); }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
