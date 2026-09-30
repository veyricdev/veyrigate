import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import type { Model } from 'mongoose';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { sha256 } from '../src/common/crypto/crypto.util';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { MAILER, type MailMessage } from '../src/modules/mailer/mailer';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { SessionService } from '../src/modules/sessions/session.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-auth-${Date.now()}?directConnection=true`;

describe('Authentication races on real Mongo (B2.4, C2-C6, C13)', () => {
  let moduleRef: TestingModule;
  let auth: AuthenticationService;
  let users: UserService;
  let userModel: Model<Record<string, unknown>>;
  let resetModel: Model<Record<string, unknown>>;
  const audit = { record: jest.fn(async (_event: unknown) => undefined) };
  const sessions = {
    establish: jest.fn(),
    revokeAllForUser: jest.fn(async () => 0),
  };
  const messages: MailMessage[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(MONGO_URI), MongooseModule.forFeature(MODELS)],
      providers: [
        AuthenticationService,
        UserService,
        UserTenantService,
        { provide: SessionService, useValue: sessions },
        { provide: AuditService, useValue: audit },
        { provide: MAILER, useValue: { send: async (message: MailMessage) => void messages.push(message) } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => ({ issuer: 'https://issuer.example' }) },
        },
      ],
    }).compile();
    userModel = moduleRef.get(getModelToken('User'));
    resetModel = moduleRef.get(getModelToken('PasswordResetToken'));
    await syncAllIndexes(userModel.db);
    auth = moduleRef.get(AuthenticationService);
    users = moduleRef.get(UserService);
  }, 30_000);

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await userModel.db.dropDatabase();
    await moduleRef.close();
  });

  it('concurrent registration returns the same success result and creates one account', async () => {
    const results = await Promise.allSettled([
      auth.register('race@example.com', 'correct password'),
      auth.register('race@example.com', 'correct password'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await userModel.countDocuments({ email: 'race@example.com' })).toBe(1);
  });

  it('two concurrent password resets consume one token and recover the account once', async () => {
    const user = await users.create({ email: 'reset@example.com', password: 'old password' });
    const token = 'one-reset-token';
    await resetModel.create({
      tokenHash: sha256(token),
      userId: user.sub,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const results = await Promise.allSettled([
      auth.resetPassword(token, 'new password one'),
      auth.resetPassword(token, 'new password two'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await users.findById(user.sub))?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
  });

  it('ten concurrent failed logins persist ten failures and one lock audit event', async () => {
    const user = await users.create({ email: 'locked@example.com', password: 'correct password' });
    await users.verifyEmail(user.sub);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => auth.login(user.email, 'wrong password', {})),
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect((await users.findById(user.sub))?.failedLoginCount).toBe(10);
    expect((await users.findById(user.sub))?.lockedUntil).toBeInstanceOf(Date);
    expect(
      audit.record.mock.calls.filter(
        ([event]) => (event as { action: AuditAction }).action === AuditAction.AUTH_ACCOUNT_LOCKED,
      ),
    ).toHaveLength(1);
  });

  it('builds mail links from ISSUER and never from request-controlled hosts', async () => {
    await auth.register('host@example.com', 'correct password');
    await new Promise((resolve) => setImmediate(resolve));
    expect(messages.at(-1)?.text).toContain('https://issuer.example/verify-email?token=');
    expect(messages.at(-1)?.text).not.toContain('evil.example');
  });
});