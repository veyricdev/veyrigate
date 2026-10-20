import { jest } from '@jest/globals';
import mongoose, { type Connection, type Model } from 'mongoose';
import { verifyPassword } from '../src/common/crypto/crypto.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import type { AdminSeedConfig } from '../src/database/seed';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import type { ConfigService } from '@nestjs/config';
import { seedE2eAdmin } from './e2e/seed-e2e-admin';

// Throwaway int DB on vg-test-mongo (the DB-name guard is covered by the unit spec; this exercises
// the writes). Test-only values, never a real credential.
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-seed-e2e-${Date.now()}?directConnection=true`;
const ISSUER = 'http://localhost:4000';
const ADMIN: AdminSeedConfig = { email: 'E2E-Admin@Example.com', password: 'e2e-int-admin-pass-1' };
const SECRET = 'e2e-int-fe-admin-secret-0123456789abcdef';

describe('seed-e2e-admin (run 39 Task 0) on real Mongo', () => {
  let connection: Connection;
  let creds: Model<Record<string, unknown>>;
  let users: Model<Record<string, unknown>>;
  let service: ClientCredentialService;
  const output: string[] = [];

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) connection.model(name, schema);
    await syncAllIndexes(connection);
    creds = connection.model<Record<string, unknown>>('ClientCredential');
    users = connection.model<Record<string, unknown>>('User');
    service = new ClientCredentialService(
      creds as never,
      {
        getOrThrow: () => ({ secretGraceTtl: 0 }),
      } as unknown as ConfigService,
    );
    const capture = (...args: unknown[]) => void output.push(args.map(String).join(' '));
    jest.spyOn(console, 'log').mockImplementation(capture);
    jest.spyOn(console, 'warn').mockImplementation(capture);
    jest.spyOn(console, 'error').mockImplementation(capture);
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await connection.dropDatabase();
    await connection.close();
  });

  const run = () => seedE2eAdmin(connection, ADMIN, ISSUER, 'test', SECRET);
  const credCount = () => creds.countDocuments({ clientId: 'fe-admin' }).exec();
  const email = ADMIN.email.toLowerCase();

  it('run 1: fe-admin verifies with the known secret; the random bootstrap secret is revoked', async () => {
    await run();
    expect(await service.verifySecret('fe-admin', SECRET)).toEqual({ valid: true, version: 2 });
    const active = await creds.find({ clientId: 'fe-admin', revokedAt: null }).lean().exec();
    expect(active.map((c) => c.version)).toEqual([2]);
    expect(await credCount()).toBe(2);
  });

  it('run 2: no new credential, no user write (idempotent)', async () => {
    const before = await users.findOne({ email }).select('+passwordHash').lean().exec();
    await run();
    expect(await credCount()).toBe(2);
    const after = await users.findOne({ email }).select('+passwordHash').lean().exec();
    expect(before?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(await service.verifySecret('fe-admin', SECRET)).toEqual({ valid: true, version: 2 });
  });

  it('secret drifted (rotated elsewhere) => all active revoked, next version gets the known secret', async () => {
    await creds.updateMany({ clientId: 'fe-admin' }, { $set: { revokedAt: new Date() } }).exec();
    await service.createSecret('fe-admin'); // v3, unknown random secret
    await run();
    const active = await creds.find({ clientId: 'fe-admin', revokedAt: null }).lean().exec();
    expect(active.map((c) => c.version)).toEqual([4]);
    expect(await service.verifySecret('fe-admin', SECRET)).toEqual({ valid: true, version: 4 });
  });

  it('locked admin with a changed password => password reset + unlocked', async () => {
    await users
      .updateOne(
        { email },
        {
          $set: {
            passwordHash: 'not-a-valid-hash',
            failedLoginCount: 7,
            lockedUntil: new Date(Date.now() + 3_600_000),
          },
        },
      )
      .exec();
    await run();
    const user = await users.findOne({ email }).select('+passwordHash').lean().exec();
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lockedUntil).toBeUndefined();
    expect(await verifyPassword(String(user?.passwordHash), ADMIN.password)).toBe(true);
  });

  it('refuses NODE_ENV other than test before any write', async () => {
    const n = await credCount();
    await expect(seedE2eAdmin(connection, ADMIN, ISSUER, 'development', SECRET)).rejects.toThrow(
      /only NODE_ENV=test/,
    );
    expect(await credCount()).toBe(n);
  });

  it('never prints the fe-admin secret nor the admin password', () => {
    const all = output.join('\n');
    expect(all).toMatch(/seed-e2e-admin:/);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(ADMIN.password);
    expect(all).not.toMatch(/client_secret/i);
  });
});
