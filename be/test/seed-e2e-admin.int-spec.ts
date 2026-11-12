import { jest } from '@jest/globals';
import mongoose, { Types, type Connection, type Model } from 'mongoose';
import { verifyPassword } from '../src/common/crypto/crypto.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import type { AdminSeedConfig } from '../src/database/seed';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL } from '../src/modules/identity/user.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import type { ConfigService } from '@nestjs/config';
import { seedE2eAdmin, type E2eUserConfig } from './e2e/seed-e2e-admin';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';

// Throwaway int DB on vg-test-mongo (the DB-name guard is covered by the unit spec; this exercises
// the writes). Test-only values, never a real credential.
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-seed-e2e-${Date.now()}?directConnection=true`;
const ISSUER = 'http://localhost:4000';
const ADMIN: AdminSeedConfig = { email: 'E2E-Admin@Example.com', password: 'e2e-int-admin-pass-1' };
const SECRET = 'e2e-int-fe-admin-secret-0123456789abcdef';
const E2E_USER: E2eUserConfig = { email: 'E2E-User@Example.com', password: 'e2e-int-user-pass-1' };

describe('seed-e2e-admin (run 39 Task 0) on real Mongo', () => {
  let connection: Connection;
  let creds: Model<Record<string, unknown>>;
  let users: Model<Record<string, unknown>>;
  let service: ClientCredentialService;
  const output: string[] = [];

  // DEBT-448: afterAll waits for a setup that outlived its hook, then cleans up what it opened.
  const boot = async (): Promise<void> => {
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
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await settled(setup);
    jest.restoreAllMocks();
    await connection?.dropDatabase();
    await connection?.close();
  }, INT_SETUP_TIMEOUT_MS);

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
            lockedUntil: new Date(Date.now() + 3_600_000),
          },
        },
      )
      .exec();
    await run();
    const user = await users.findOne({ email }).select('+passwordHash').lean().exec();
    expect(user?.lockedUntil).toBeUndefined();
    expect(await verifyPassword(String(user?.passwordHash), ADMIN.password)).toBe(true);
  });

  describe('E2E target user (run 47 Task 0)', () => {
    let members: Model<Record<string, unknown>>;
    beforeAll(() => {
      members = connection.model<Record<string, unknown>>('UserTenant');
    });
    const runWithUser = (u: E2eUserConfig | undefined) =>
      seedE2eAdmin(connection, ADMIN, ISSUER, 'test', SECRET, u);
    const target = E2E_USER.email.toLowerCase();
    const readUser = () => users.findOne({ email: target }).select('+passwordHash').lean().exec();
    const readMember = async () => {
      const u = await users.findOne({ email: target }).lean().exec();
      return members.findOne({ userId: u?._id, tenantId: DEFAULT_TENANT_ID }).lean().exec();
    };

    it('config unset => step skipped, no user written', async () => {
      await runWithUser(undefined);
      expect(await users.countDocuments({ email: target }).exec()).toBe(0);
    });

    it('creates the user: verified, password set, active membership in the default tenant, no role', async () => {
      await runWithUser(E2E_USER);
      const user = await readUser();
      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(user).not.toHaveProperty('failedLoginCount'); // removed field (run 87, DEBT-589)
      expect(user?.lockedUntil).toBeUndefined();
      expect(await verifyPassword(String(user?.passwordHash), E2E_USER.password)).toBe(true);
      const member = await readMember();
      expect(member).toMatchObject({ status: 'active', roles: [] });
      expect(await members.countDocuments({ userId: user?._id }).exec()).toBe(1);
    });

    it('second run (admin "unchanged") still runs the user step and writes nothing', async () => {
      const before = { user: await readUser(), member: await readMember() };
      output.length = 0;
      await runWithUser(E2E_USER);
      expect(output.join('\n')).toMatch(/admin user unchanged/);
      expect(output.join('\n')).toMatch(/E2E user unchanged/);
      expect(await readUser()).toEqual(before.user);
      expect(await readMember()).toEqual(before.member);
    });

    it('admin-locked, suspended, tenant_admin, password changed => all reset', async () => {
      const user = await readUser();
      await users
        .updateOne(
          { _id: user?._id },
          {
            $set: {
              passwordHash: 'not-a-valid-hash',
              lockedUntil: ADMIN_LOCKED_UNTIL,
            },
            $unset: { emailVerifiedAt: 1 },
          },
        )
        .exec();
      await members
        .updateOne(
          { userId: user?._id, tenantId: DEFAULT_TENANT_ID },
          { $set: { status: 'suspended', roles: ['tenant_admin'] } },
        )
        .exec();
      output.length = 0;
      await runWithUser(E2E_USER);
      expect(output.join('\n')).toMatch(/E2E user reset/);
      const after = await readUser();
      expect(after?.lockedUntil).toBeUndefined();
      expect(after?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(await verifyPassword(String(after?.passwordHash), E2E_USER.password)).toBe(true);
      expect(await readMember()).toMatchObject({ status: 'active', roles: [] });
    });

    it('active membership holding an admin role (roles only drift) => roles cleared', async () => {
      const user = await readUser();
      await members
        .updateOne(
          { userId: user?._id, tenantId: DEFAULT_TENANT_ID },
          { $set: { status: 'active', roles: ['super_admin'] } },
        )
        .exec();
      await runWithUser(E2E_USER);
      expect(await readMember()).toMatchObject({ status: 'active', roles: [] });
    });

    it('membership missing => re-created; user untouched', async () => {
      const before = await readUser();
      await members.deleteOne({ userId: before?._id }).exec();
      await runWithUser(E2E_USER);
      expect(await readMember()).toMatchObject({ status: 'active', roles: [] });
      expect((await readUser())?.passwordHash).toBe(before?.passwordHash);
    });

    it('DEBT-608: every refresh token of the target user is deleted; another user keeps theirs', async () => {
      await runWithUser(E2E_USER);
      const target = await readUser();
      const other = new Types.ObjectId();
      const rt = (userId: Types.ObjectId, i: number, revoked: boolean) => ({
        tokenHash: `r87-${userId.toHexString()}-${i}`,
        familyId: `fam-${i % 10}`,
        userId,
        clientId: 'fe-admin',
        resource: 'http://localhost:4000/admin',
        scope: ['openid'],
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        ...(revoked ? { revokedAt: new Date() } : {}),
      });
      const rts = connection.collection('refreshtokens');
      await rts.insertMany([
        ...Array.from({ length: 30 }, (_, i) => rt(target!._id as Types.ObjectId, i, i % 2 === 0)),
        rt(other, 99, false),
      ]);
      await runWithUser(E2E_USER);
      expect(await rts.countDocuments({ userId: target!._id })).toBe(0);
      expect(await rts.countDocuments({ userId: other })).toBe(1);
      await rts.deleteMany({ userId: other });
    });

    it('email equal to the admin seed (normalized) => throws before any write', async () => {
      const snapshot = async () => ({
        users: await users.find().select('+passwordHash').lean().exec(),
        members: await members.find().lean().exec(),
        creds: await creds.find().lean().exec(),
      });
      const before = await snapshot();
      await expect(
        runWithUser({ email: ` ${ADMIN.email.toUpperCase()} `, password: 'other-pass-123' }),
      ).rejects.toThrow(/E2E_USER_EMAIL must differ from ADMIN_SEED_EMAIL/);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('X3 clients (run 73, E2E_X3=1)', () => {
    const x3Ids = ['x3-alpha', 'x3-beta'];
    const clients = () => connection.model('Client');
    const x3Docs = () =>
      clients()
        .find({ clientId: { $in: x3Ids } })
        .sort({ clientId: 1 })
        .lean()
        .exec();

    it('off by default: no x3-* client is written', async () => {
      await run();
      expect(await x3Docs()).toHaveLength(0);
    });

    it('on: upserts two public PKCE clients bound to their https origin, no credential', async () => {
      await seedE2eAdmin(connection, ADMIN, ISSUER, 'test', SECRET, undefined, true);
      const docs = (await x3Docs()) as unknown as Record<string, unknown>[];
      expect(docs.map((d) => d.clientId)).toEqual(x3Ids);
      for (const [d, origin] of [
        [docs[0], 'https://app.alpha.localhost:8443'],
        [docs[1], 'https://app.beta.localhost:8443'],
      ] as const) {
        expect(d).toMatchObject({
          clientType: 'public',
          tokenEndpointAuthMethod: 'none',
          redirectUris: [`${origin}/callback`],
          postLogoutRedirectUris: [`${origin}/`],
          allowedCorsOrigins: [origin],
          allowedResources: ['demo', 'other'],
          tenantId: DEFAULT_TENANT_ID,
        });
      }
      expect(await creds.countDocuments({ clientId: { $in: x3Ids } }).exec()).toBe(0);
    });

    it('on, run 2: idempotent (still one document per client)', async () => {
      await seedE2eAdmin(connection, ADMIN, ISSUER, 'test', SECRET, undefined, true);
      expect(
        await clients()
          .countDocuments({ clientId: { $in: x3Ids } })
          .exec(),
      ).toBe(2);
    });
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
    expect(all).not.toContain(E2E_USER.password);
    expect(all).not.toMatch(/client_secret/i);
  });
});
