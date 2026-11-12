import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import IORedis from 'ioredis';
import type { Model } from 'mongoose';
import { MODELS } from '../src/database/mongo/models';
import { RedisService } from '../src/database/redis/redis.service';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { LoginThrottleService } from '../src/modules/authentication/login-throttle.service';
import { sha256 } from '../src/common/crypto/crypto.util';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { MAILER, type MailMessage } from '../src/modules/mailer/mailer';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { INT_SETUP_TIMEOUT_MS, settled } from './int-hooks';
import { tokenFromMailLink } from './helpers/mail-token';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-auth-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

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
  const refreshTokens = {
    revokeAllForUser: jest.fn(async () => 0),
  };
  const messages: MailMessage[] = [];
  let redis: IORedis;

  // DEBT-448: afterAll waits for a setup that outlived its hook, then cleans up what it opened.
  const boot = async (): Promise<void> => {
    // Run 85 (DEBT-575): the login throttle runs on the real test Redis.
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      providers: [
        AuthenticationService,
        LoginThrottleService,
        UserService,
        UserTenantService,
        RateLimitService,
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: SessionService, useValue: sessions },
        { provide: RefreshTokenService, useValue: refreshTokens },
        { provide: AuditService, useValue: audit },
        {
          provide: MAILER,
          useValue: { send: async (message: MailMessage) => void messages.push(message) },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => ({
              issuer: 'https://issuer.example',
              cookieSecure: false,
              rateLimitMax: 100,
              rateLimitWindow: 60,
            }),
          },
        },
      ],
    }).compile();
    userModel = moduleRef.get(getModelToken('User'));
    resetModel = moduleRef.get(getModelToken('PasswordResetToken'));
    await syncAllIndexes(userModel.db);
    auth = moduleRef.get(AuthenticationService);
    users = moduleRef.get(UserService);
  };
  let setup: Promise<void> | undefined;
  beforeAll(() => (setup = boot()), INT_SETUP_TIMEOUT_MS);

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await settled(setup);
    await userModel?.db.dropDatabase();
    await moduleRef?.close(); // RedisService.onApplicationShutdown quits the client
  }, INT_SETUP_TIMEOUT_MS);

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

  // Run 85 (DEBT-575, intentional change): login no longer writes a lock. Ten concurrent failures
  // from one network: the throttle lets exactly 5 reach Argon2, the user document is untouched,
  // no AUTH_ACCOUNT_LOCKED, one AUTH_LOGIN_THROTTLED.
  it('ten concurrent failed logins: 5 checked, 5 throttled, no lock written, one throttle audit', async () => {
    const user = await users.create({
      email: `locked-${Date.now()}@example.com`,
      password: 'correct password',
    });
    await users.verifyEmail(user.sub);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        auth.login(user.email, 'wrong password', { ip: '198.51.100.7' }),
      ),
    );
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    const statuses = results.map((r) =>
      r.status === 'rejected' ? (r.reason as { getStatus(): number }).getStatus() : 0,
    );
    expect(statuses.filter((c) => c === 401)).toHaveLength(5);
    expect(statuses.filter((c) => c === 429)).toHaveLength(5);
    expect((await users.findById(user.sub))?.failedLoginCount ?? 0).toBe(0);
    expect((await users.findById(user.sub))?.lockedUntil).toBeUndefined();
    const actions = audit.record.mock.calls.map(([e]) => (e as { action: AuditAction }).action);
    expect(actions.filter((a) => a === AuditAction.AUTH_ACCOUNT_LOCKED)).toHaveLength(0);
    expect(actions.filter((a) => a === AuditAction.AUTH_LOGIN_THROTTLED)).toHaveLength(1);
  });

  it('B7.1 AE8: five concurrent verifyEmail with one token => exactly one success, one verification, one audit', async () => {
    const email = 'verify-race@example.com';
    await auth.register(email, 'correct password');
    await new Promise((resolve) => setImmediate(resolve));
    const link = messages.find((m) => m.to === email)?.text.match(/https:\/\/\S+/)?.[0];
    const token = tokenFromMailLink(link!);
    const spy = jest.spyOn(users, 'verifyEmail');

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => auth.verifyEmail(token)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r.reason as Error).message).toBe('This link is invalid or expired.');
    }
    expect(spy).toHaveBeenCalledTimes(1); // emailVerifiedAt written by exactly one caller
    expect((await users.findByEmail(email))?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(
      audit.record.mock.calls.filter(
        ([event]) => (event as { action: AuditAction }).action === AuditAction.AUTH_EMAIL_VERIFIED,
      ),
    ).toHaveLength(1);
    spy.mockRestore();
  });

  it('builds mail links from ISSUER and never from request-controlled hosts', async () => {
    await auth.register('host@example.com', 'correct password');
    await new Promise((resolve) => setImmediate(resolve));
    // DEBT-577 (D86.3): the token rides in the fragment, never in the query.
    expect(messages.at(-1)?.text).toContain('https://issuer.example/verify-email#token=');
    expect(messages.at(-1)?.text).not.toMatch(/\?token=/);
    expect(messages.at(-1)?.text).not.toContain('evil.example');
  });
});
