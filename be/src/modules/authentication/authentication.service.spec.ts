import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AuthenticationService } from './authentication.service';
import { LoginThrottleService } from './login-throttle.service';
import { UserService } from '../identity/user.service';
import { UserTenantService } from '../identity/user-tenant.service';
import { SessionService } from '../sessions/session.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import { AuditService } from '../security/audit/audit.service';
import { MAILER } from '../mailer/mailer';
import { DuplicateError } from '../identity/identity.errors';
import { AuditAction } from '../security/audit/audit-action.enum';
import { registry } from '../../common/metrics/metrics';
import { hashPassword, sha256 } from '../../common/crypto/crypto.util';

describe('AuthenticationService', () => {
  const user = {
    sub: '507f1f77bcf86cd799439011',
    email: 'a@example.com',
    profile: {},
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const users = {
    createWithPasswordHash: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findByEmail: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findByEmailForAuthentication: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findById: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findByIdForAuthentication: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    verifyEmail: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    clearFailedLoginsIfUnlocked: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    setPassword: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    // Run 89: not enrolled => the pre-run-89 session path.
    mfaEnrolledAt: jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
    isUnverifiedWithPassword: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const tokenModel = {
    create: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findOneAndUpdate: jest.fn<(...args: unknown[]) => unknown>(),
    exists: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    updateOne: jest.fn<(...args: unknown[]) => unknown>(() => ({ exec: async () => ({}) })),
    updateMany: jest.fn<(...args: unknown[]) => unknown>(() => ({ exec: async () => ({}) })),
  };
  const sessions = {
    establish: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    revokeAllForUser: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    revoke: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const refreshTokens = {
    revokeAllForUser: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const memberships = { addMembership: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  // Run 85 (DEBT-575): throttle behaviour is covered on real Redis (run85-anti-lockout.int-spec).
  const throttle = {
    buckets: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    reserve: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    onSuccess: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    forgetDevices: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    clearAccount: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  let service: AuthenticationService;
  let module: TestingModule;

  beforeEach(async () => {
    jest.clearAllMocks();
    tokenModel.create.mockResolvedValue(undefined);
    throttle.buckets.mockResolvedValue({ trusted: false, keys: [] });
    throttle.reserve.mockResolvedValue({ blocked: false });
    throttle.onSuccess.mockResolvedValue(undefined);
    throttle.forgetDevices.mockResolvedValue(undefined);
    throttle.clearAccount.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
    module = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: UserService, useValue: users },
        { provide: UserTenantService, useValue: memberships },
        { provide: SessionService, useValue: sessions },
        { provide: RefreshTokenService, useValue: refreshTokens },
        { provide: AuditService, useValue: audit },
        { provide: LoginThrottleService, useValue: throttle },
        {
          provide: MAILER,
          useValue: { send: jest.fn<() => Promise<void>>(async () => undefined) },
        },
        { provide: getModelToken('PasswordResetToken'), useValue: tokenModel },
        { provide: getModelToken('EmailVerificationToken'), useValue: tokenModel },
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue({ issuer: 'https://id.example.com' }) },
        },
      ],
    }).compile();
    service = module.get(AuthenticationService);
  });

  it('consumes a reset ticket atomically only after validating password', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    users.setPassword.mockResolvedValue(user);
    sessions.revokeAllForUser.mockResolvedValue(2);
    refreshTokens.revokeAllForUser.mockResolvedValue(1);
    await service.resetPassword('secret-token', 'new password');
    expect(tokenModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketHash: sha256('secret-token'),
        usedAt: null,
        expiresAt: { $gt: expect.any(Date) },
      }),
      { $set: { usedAt: expect.any(Date) } },
      { returnDocument: 'after' },
    );
    await expect(service.resetPassword('secret-token', 'short')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tokenModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('DEBT-661: claimResetTicket burns an unexchanged token for a 15-minute ticket in one update', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    const before = Date.now();
    const ticket = await service.claimResetTicket('mail-token');
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [filter, [update], options] = tokenModel.findOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      [{ $set: { ticketHash: string; expiresAt: { $min: [string, Date] } } }],
      Record<string, unknown>,
    ];
    expect(options).toEqual({ updatePipeline: true });
    // Run 94 retry: the ticket never outlives the token (min of both expiries).
    expect(update.$set.expiresAt.$min[0]).toBe('$expiresAt');
    expect(filter).toEqual({
      tokenHash: sha256('mail-token'),
      usedAt: null,
      ticketHash: null,
      expiresAt: { $gt: expect.any(Date) },
    });
    expect(update.$set.ticketHash).toBe(sha256(ticket!));
    const ttl = update.$set.expiresAt.$min[1].getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(ttl).toBeLessThan(15 * 60 * 1000 + 5000);

    tokenModel.findOneAndUpdate.mockReturnValue({ lean: () => ({ exec: async () => null }) });
    await expect(service.claimResetTicket('mail-token')).resolves.toBeNull();
  });

  it('reset revokes refresh families AND sessions in order: family -> session -> family(sweep) -> audit (DEBT-050)', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    users.setPassword.mockResolvedValue(user);
    sessions.revokeAllForUser.mockResolvedValue(3);
    refreshTokens.revokeAllForUser.mockResolvedValue(2);
    audit.record.mockResolvedValue(undefined);

    await service.resetPassword('secret-token', 'new password');

    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledTimes(2);
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_PASSWORD_RESET, actorId: user.sub }),
    );
    // Stamp-first + sweep: family(1) < session < family(2) < audit.
    const firstFamily = refreshTokens.revokeAllForUser.mock.invocationCallOrder[0];
    const session = sessions.revokeAllForUser.mock.invocationCallOrder[0];
    const sweepFamily = refreshTokens.revokeAllForUser.mock.invocationCallOrder[1];
    const auditOrder = audit.record.mock.invocationCallOrder[0];
    expect(firstFamily).toBeLessThan(session);
    expect(session).toBeLessThan(sweepFamily);
    expect(sweepFamily).toBeLessThan(auditOrder);
  });

  it('DEBT-055: pre-revoke throws => sessions MARK still runs, sweep runs, failure audit (pre_revoke), rethrow first error, no rollback', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    users.setPassword.mockResolvedValue(user);
    // Both refresh calls (pre-revoke + sweep) fail; the FIRST error (pre_revoke) must win.
    refreshTokens.revokeAllForUser
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockRejectedValueOnce(new Error('mongo still down'));
    sessions.revokeAllForUser.mockResolvedValue(3);
    audit.record.mockResolvedValue(undefined);

    await expect(service.resetPassword('secret-token', 'new password')).rejects.toThrow(
      'mongo down',
    );
    expect(users.setPassword).toHaveBeenCalledTimes(1); // password already changed, not rolled back
    // The session MARK is NOT skipped just because pre-revoke failed (would leave a hijacked
    // session alive on a consumed, non-retryable link).
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledTimes(2); // pre-revoke + sweep both attempted
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AUTH_PASSWORD_RESET,
        result: 'failure',
        reason: 'revoke_failed',
        metadata: { failedStep: 'pre_revoke' },
      }),
    );
  });

  it('DEBT-055: session revoke throws => sweep still runs, failure audit (sessions), rethrow (DEBT-050 fail-closed kept)', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    users.setPassword.mockResolvedValue(user);
    refreshTokens.revokeAllForUser.mockResolvedValue(1);
    sessions.revokeAllForUser.mockRejectedValueOnce(new Error('redis down'));
    audit.record.mockResolvedValue(undefined);

    await expect(service.resetPassword('secret-token', 'new password')).rejects.toThrow(
      'redis down',
    );
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledTimes(2); // pre-revoke + sweep still run
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AUTH_PASSWORD_RESET,
        result: 'failure',
        reason: 'revoke_failed',
        metadata: { failedStep: 'sessions' },
      }),
    );
  });

  it('DEBT-055: a failing failure-audit write never masks the original revoke error', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    users.setPassword.mockResolvedValue(user);
    sessions.revokeAllForUser.mockRejectedValueOnce(new Error('redis down'));
    refreshTokens.revokeAllForUser.mockResolvedValue(1);
    audit.record.mockRejectedValue(new Error('audit mongo down'));

    await expect(service.resetPassword('secret-token', 'new password')).rejects.toThrow(
      'redis down',
    );
  });

  it('DEBT-687: burning the other reset tokens fails => 5xx (reject) AND the password-changed mail still goes', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    users.setPassword.mockResolvedValue(user);
    sessions.revokeAllForUser.mockResolvedValue(1);
    refreshTokens.revokeAllForUser.mockResolvedValue(1);
    tokenModel.updateMany.mockReturnValueOnce({
      exec: async () => {
        throw new Error('mongo down');
      },
    });
    await expect(service.resetPassword('secret-token', 'new password')).rejects.toThrow(
      'mongo down',
    );
    const mailer = module.get<{ send: jest.Mock }>(MAILER);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: user.email }));
  });

  it('reset does not revoke anything when the link is invalid (fail-closed) (DEBT-050)', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => null }),
    });
    await expect(service.resetPassword('secret-token', 'new password')).resolves.toBe(false);
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('treats a duplicate created by a concurrent registration as the generic success path', async () => {
    users.findByEmail.mockResolvedValue(null);
    users.createWithPasswordHash.mockRejectedValue(new DuplicateError('User'));
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.register('race@example.com', 'correct password')).resolves.toBeUndefined();
    await service.drainBackgroundWrites();
    expect(memberships.addMembership).not.toHaveBeenCalled();
    expect(tokenModel.create).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  describe('existence-dependent writes leave the response path (DEBT-659/660, run 90 C2)', () => {
    /** A promise the test resolves by hand: the write it stands for is still running until then. */
    function gate() {
      let open!: () => void;
      const done = new Promise<void>((resolve) => (open = resolve));
      return { done, open };
    }
    /** Resolves to 'returned' when `p` settles first, 'blocked' when it is still pending after 2 s. */
    const race = (p: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // DEBT-667 (a): the 2 s timer is cleared once the race is decided (no open handle left behind).
      return Promise.race([
        p.then(() => 'returned'),
        new Promise((r) => (timer = setTimeout(() => r('blocked'), 2000))),
      ]).finally(() => clearTimeout(timer));
    };

    it('/register returns while the user/membership/token writes are still pending', async () => {
      users.findByEmail.mockResolvedValue(null);
      const create = gate();
      users.createWithPasswordHash.mockImplementation(async () => {
        await create.done;
        return { ...user, email: 'new@example.com' };
      });
      memberships.addMembership.mockResolvedValue(undefined);

      expect(await race(service.register('new@example.com', 'correct password'))).toBe('returned');
      expect(users.createWithPasswordHash).toHaveBeenCalledTimes(1);
      expect(memberships.addMembership).not.toHaveBeenCalled();
      expect(tokenModel.create).not.toHaveBeenCalled();

      create.open();
      await service.drainBackgroundWrites();
      expect(memberships.addMembership).toHaveBeenCalledWith(user.sub, expect.any(String));
      expect(tokenModel.create).toHaveBeenCalledTimes(1);
      expect(module.get(MAILER).send).toHaveBeenCalledTimes(1);
    });

    it('/forgot returns while the reset token write is still pending', async () => {
      users.findByEmail.mockResolvedValue(user);
      const write = gate();
      tokenModel.create.mockImplementation(async () => {
        await write.done;
        return undefined;
      });

      expect(await race(service.forgotPassword(user.email))).toBe('returned');
      expect(tokenModel.create).toHaveBeenCalledTimes(1);
      expect(module.get(MAILER).send).not.toHaveBeenCalled();

      write.open();
      await service.drainBackgroundWrites();
      expect(module.get(MAILER).send).toHaveBeenCalledTimes(1);
    });

    it('a failed background write is logged without the email and never reaches the caller', async () => {
      const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      users.findByEmail.mockResolvedValue(null);
      users.createWithPasswordHash.mockResolvedValue({ ...user, email: 'new@example.com' });
      memberships.addMembership.mockRejectedValue(new Error('mongo down new@example.com'));

      await expect(
        service.register('new@example.com', 'correct password'),
      ).resolves.toBeUndefined();
      await service.drainBackgroundWrites();
      expect(tokenModel.create).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('register background write failed');
      expect(JSON.stringify(log.mock.calls)).not.toContain('new@example.com');

      log.mockClear();
      users.findByEmail.mockResolvedValue(user);
      tokenModel.create.mockRejectedValue(new Error(`E11000 ${user.email}`));
      await expect(service.forgotPassword(user.email)).resolves.toBeUndefined();
      await service.drainBackgroundWrites();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('forgot background write failed');
      expect(JSON.stringify(log.mock.calls)).not.toContain(user.email);
      log.mockRestore();
    });

    it('shutdown waits for pending writes (beforeApplicationShutdown)', async () => {
      users.findByEmail.mockResolvedValue(user);
      const write = gate();
      tokenModel.create.mockImplementation(async () => {
        await write.done;
        return undefined;
      });
      await service.forgotPassword(user.email);

      expect(await race(service.beforeApplicationShutdown())).toBe('blocked');
      write.open();
      expect(await race(service.beforeApplicationShutdown())).toBe('returned');
    });

    it('DEBT-667 (b): shutdown gives up after 5 s on a write that never ends and logs only the count', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      users.findByEmail.mockResolvedValue(user);
      tokenModel.create.mockImplementation(() => new Promise(() => undefined)); // hangs forever
      await service.forgotPassword(user.email);
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        let done = false;
        const hook = service.beforeApplicationShutdown().then(() => (done = true));
        await jest.advanceTimersByTimeAsync(4999);
        expect(done).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await hook;
        expect(done).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBe('shutdown: 1 background write(s) still pending');
        expect(JSON.stringify(warn.mock.calls)).not.toContain(user.email);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
        warn.mockRestore();
      }
    });

    it('DEBT-667 (b): a write that finishes first => no warning and no timer left behind', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      users.findByEmail.mockResolvedValue(user);
      const write = gate();
      tokenModel.create.mockImplementation(async () => {
        await write.done;
        return undefined;
      });
      await service.forgotPassword(user.email);
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      try {
        const hook = service.beforeApplicationShutdown();
        write.open();
        await hook;
        expect(warn).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
        warn.mockRestore();
      }
    });
  });

  describe('background write failures are counted (DEBT-666)', () => {
    const WHATS = ['register', 'forgot', 'resend_verify', 'auth_mail'] as const;
    const counts = async (): Promise<Record<string, number | undefined>> => {
      const { values } = await registry
        .getSingleMetric('sso_background_write_failures_total')!
        .get();
      return Object.fromEntries(
        WHATS.map((w) => [w, values.find((v) => v.labels.what === w)?.value]),
      );
    };
    const quiet = () => {
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      return {
        logged: () => JSON.stringify([err.mock.calls, warn.mock.calls]),
        restore: () => {
          err.mockRestore();
          warn.mockRestore();
        },
      };
    };

    it('createWithPasswordHash rejects => register +1, nothing else moves, no email logged', async () => {
      const log = quiet();
      users.findByEmail.mockResolvedValue(null);
      users.createWithPasswordHash.mockRejectedValue(new Error('mongo down x@example.com'));
      const before = await counts();
      await service.register('x@example.com', 'correct password');
      await service.drainBackgroundWrites();
      expect(await counts()).toEqual({ ...before, register: before.register! + 1 });
      expect(log.logged()).toContain('register background write failed');
      expect(log.logged()).not.toContain('x@example.com');
      log.restore();
    });

    it('the counter still moves when the logger itself throws', async () => {
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
        throw new Error('logger down');
      });
      users.findByEmail.mockResolvedValue(null);
      users.createWithPasswordHash.mockRejectedValue(new Error('mongo down'));
      const before = await counts();
      await service.register('y@example.com', 'correct password');
      await service.drainBackgroundWrites();
      expect((await counts()).register).toBe(before.register! + 1);
      err.mockRestore();
    });

    it('issueToken rejects in /forgot => forgot +1', async () => {
      const log = quiet();
      users.findByEmail.mockResolvedValue(user);
      tokenModel.create.mockRejectedValue(new Error(`E11000 ${user.email}`));
      const before = await counts();
      await service.forgotPassword(user.email);
      await service.drainBackgroundWrites();
      expect(await counts()).toEqual({ ...before, forgot: before.forgot! + 1 });
      expect(log.logged()).not.toContain(user.email);
      log.restore();
    });

    it('the mailer rejects => auth_mail +1 (the token write itself succeeded)', async () => {
      const log = quiet();
      users.findByEmail.mockResolvedValue(user);
      (module.get(MAILER) as { send: jest.Mock<() => Promise<void>> }).send.mockRejectedValue(
        new Error(`smtp refused ${user.email}`),
      );
      const before = await counts();
      await service.forgotPassword(user.email);
      await service.drainBackgroundWrites();
      await new Promise((r) => setImmediate(r)); // the mail send itself is fire-and-forget
      expect(await counts()).toEqual({ ...before, auth_mail: before.auth_mail! + 1 });
      expect(log.logged()).not.toContain(user.email);
      log.restore();
    });
  });

  describe('unfinished registration recovery through /register (DEBT-665, D91.4 retry 1)', () => {
    const unverified = { ...user, emailVerifiedAt: null };
    const sent = () =>
      (
        module.get(MAILER) as { send: jest.Mock<(m: unknown) => Promise<void>> }
      ).send.mock.calls.map(([m]) => m as { subject: string; text: string });

    it('existing unverified user with a password and no live reset token => one RESET token + "finish" mail, never a verify token', async () => {
      users.findByEmail.mockResolvedValue(unverified);
      users.isUnverifiedWithPassword.mockResolvedValue(true);
      tokenModel.exists.mockResolvedValue(null);
      await service.register(user.email, 'correct password');
      await service.drainBackgroundWrites();
      expect(users.isUnverifiedWithPassword).toHaveBeenCalledWith(user.sub);
      expect(users.findByIdForAuthentication).not.toHaveBeenCalled(); // no hash pulled (projection only)
      expect(tokenModel.exists).toHaveBeenCalledWith({
        userId: user.sub,
        usedAt: null,
        expiresAt: { $gt: expect.any(Date) },
      });
      expect(tokenModel.create).toHaveBeenCalledTimes(1);
      const create = tokenModel.create.mock.calls[0][0] as { expiresAt: Date };
      expect(create.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
      expect(sent()).toHaveLength(1);
      expect(sent()[0].subject).toBe('Finish creating your account');
      expect(sent()[0].text).toContain('https://id.example.com/reset#token=');
      expect(sent()[0].text).not.toContain('/verify-email');
      expect(users.createWithPasswordHash).not.toHaveBeenCalled();
    });

    it('a live reset token already exists => nothing is issued', async () => {
      users.findByEmail.mockResolvedValue(unverified);
      users.isUnverifiedWithPassword.mockResolvedValue(true);
      tokenModel.exists.mockResolvedValue({ _id: 'x' });
      await service.register(user.email, 'correct password');
      await service.drainBackgroundWrites();
      expect(tokenModel.create).not.toHaveBeenCalled();
      expect(module.get(MAILER).send).not.toHaveBeenCalled();
    });

    it('verified user, or federation-only user (no password) => nothing is issued', async () => {
      users.findByEmail.mockResolvedValue(user);
      await service.register(user.email, 'correct password');
      users.findByEmail.mockResolvedValue(unverified);
      users.isUnverifiedWithPassword.mockResolvedValue(false);
      tokenModel.exists.mockResolvedValue(null);
      await service.register(user.email, 'correct password');
      await service.drainBackgroundWrites();
      expect(tokenModel.create).not.toHaveBeenCalled();
      expect(module.get(MAILER).send).not.toHaveBeenCalled();
    });

    it('issueToken fails in the recovery branch => resend_verify +1, caller unaffected', async () => {
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const read = async () =>
        (await registry.getSingleMetric('sso_background_write_failures_total')!.get()).values.find(
          (v) => v.labels.what === 'resend_verify',
        )!.value;
      const before = await read();
      users.findByEmail.mockResolvedValue(unverified);
      users.isUnverifiedWithPassword.mockResolvedValue(true);
      tokenModel.exists.mockResolvedValue(null);
      tokenModel.create.mockRejectedValue(new Error('mongo down'));
      await expect(service.register(user.email, 'correct password')).resolves.toBeUndefined();
      await service.drainBackgroundWrites();
      expect(await read()).toBe(before + 1);
      expect(JSON.stringify(err.mock.calls)).not.toContain(user.email);
      err.mockRestore();
    });
  });

  describe('verify-email proves the password (DEBT-671, D91.14)', () => {
    const reserved = (attempts: number) => ({
      _id: 'tok1',
      userId: user.sub,
      tokenHash: 'h',
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      attempts,
    });
    const chain = (doc: unknown) => ({ lean: () => ({ exec: async () => doc }) });
    let hash: string;
    beforeAll(async () => {
      hash = await hashPassword('owner password 1');
    });
    beforeEach(() => {
      users.findByIdForAuthentication.mockResolvedValue({ ...user, passwordHash: hash });
      users.verifyEmail.mockResolvedValue(user);
    });

    it('reserves one attempt BEFORE Argon2 (live, unused, < 5 attempts), then consumes and verifies', async () => {
      tokenModel.findOneAndUpdate
        .mockReturnValueOnce(chain(reserved(1)))
        .mockReturnValueOnce(chain({ ...reserved(1), usedAt: new Date() }));
      await service.verifyEmail('the-token', 'owner password 1');
      expect(tokenModel.findOneAndUpdate).toHaveBeenNthCalledWith(
        1,
        {
          tokenHash: expect.any(String),
          usedAt: null,
          expiresAt: { $gt: expect.any(Date) },
          attempts: { $not: { $gte: 5 } },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      );
      expect(tokenModel.findOneAndUpdate).toHaveBeenNthCalledWith(
        2,
        { _id: 'tok1', usedAt: null },
        { $set: { usedAt: expect.any(Date) } },
        { returnDocument: 'after' },
      );
      expect(users.verifyEmail).toHaveBeenCalledWith(user.sub);
    });

    it('a wrong password => generic 400, the token is NOT consumed, the email is NOT verified', async () => {
      tokenModel.findOneAndUpdate.mockReturnValueOnce(chain(reserved(1)));
      await expect(service.verifyEmail('the-token', 'attacker password')).rejects.toThrow(
        'This link is invalid or expired, or the password is wrong.',
      );
      expect(tokenModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(tokenModel.updateOne).not.toHaveBeenCalled();
      expect(users.verifyEmail).not.toHaveBeenCalled();
    });

    it('the 5th wrong password is a plain 400 with no extra write (DEBT-672: the reservation filter already exhausts the token)', async () => {
      tokenModel.findOneAndUpdate.mockReturnValueOnce(chain(reserved(5)));
      await expect(service.verifyEmail('the-token', 'attacker password')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tokenModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(tokenModel.updateOne).not.toHaveBeenCalled();
      expect(users.verifyEmail).not.toHaveBeenCalled();
    });

    it('unknown / used / expired / exhausted token => same 400, no Argon2, no user read', async () => {
      tokenModel.findOneAndUpdate.mockReturnValueOnce(chain(null));
      await expect(service.verifyEmail('nope', 'owner password 1')).rejects.toThrow(
        'This link is invalid or expired, or the password is wrong.',
      );
      expect(users.findByIdForAuthentication).not.toHaveBeenCalled();
    });

    it('a user without a password (federation-only) => same 400, token kept', async () => {
      users.findByIdForAuthentication.mockResolvedValue({ ...user, passwordHash: undefined });
      tokenModel.findOneAndUpdate.mockReturnValueOnce(chain(reserved(1)));
      await expect(service.verifyEmail('the-token', 'whatever pw')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tokenModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(users.verifyEmail).not.toHaveBeenCalled();
    });
  });

  it('a throttled attempt is a 429 with the fixed text, no Argon2 result, no user write (DEBT-575)', async () => {
    users.findByEmailForAuthentication.mockResolvedValue({ ...user, passwordHash: '$x' });
    throttle.reserve.mockResolvedValue({
      blocked: true,
      retryAfterSec: 42,
      scope: 'network',
      report: false,
    });
    await expect(service.login(user.email, 'wrong password', {})).rejects.toMatchObject({
      status: 429,
      response: {
        retryAfter: 42,
        message: 'Too many sign-in attempts. Try again later or reset your password.',
      },
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(users.clearFailedLoginsIfUnlocked).not.toHaveBeenCalled();
  });

  it('uses a generic login failure and establishes a fresh session on success', async () => {
    const withHash = {
      ...user,
      passwordHash: await import('../../common/crypto/crypto.util').then(({ hashPassword }) =>
        hashPassword('correct password'),
      ),
    };
    users.findByEmailForAuthentication.mockResolvedValueOnce(null).mockResolvedValueOnce(withHash);
    await expect(service.login('missing@example.com', 'wrong', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    sessions.establish.mockResolvedValue({ id: 'new-id', session: {} });
    users.clearFailedLoginsIfUnlocked.mockResolvedValue(user);
    // run 36 + DEBT-600: post-establish re-read (still unlocked, same hash)
    users.findByIdForAuthentication.mockResolvedValue(withHash);
    await expect(
      service.login('a@example.com', 'correct password', { oldSessionId: 'old' }),
    ).resolves.toMatchObject({ id: 'new-id' });
    expect(sessions.establish).toHaveBeenCalledWith('old', user.sub, 'default-tenant', {
      amr: ['pwd'],
    });
  });

  it('DEBT-600: the hash changed between verify and establish => session revoked, generic 401, no success audit/trust', async () => {
    const withHash = {
      ...user,
      passwordHash: await import('../../common/crypto/crypto.util').then(({ hashPassword }) =>
        hashPassword('correct password'),
      ),
    };
    users.findByEmailForAuthentication.mockResolvedValueOnce(withHash);
    sessions.establish.mockResolvedValue({ id: 'raced-id', session: { ref: 'r' } });
    users.clearFailedLoginsIfUnlocked.mockResolvedValue(user);
    users.findByIdForAuthentication.mockResolvedValue({ ...withHash, passwordHash: '$changed' });
    await expect(
      service.login('a@example.com', 'correct password', { trustDevice: true }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.revoke).toHaveBeenCalledWith('raced-id');
    expect(throttle.onSuccess).not.toHaveBeenCalled();
    const actions = audit.record.mock.calls.map(([e]) => (e as { action: AuditAction }).action);
    expect(actions).not.toContain(AuditAction.AUTH_LOGIN_SUCCESS);
    expect(actions).toContain(AuditAction.AUTH_LOGIN_FAILED);
  });

  it('DEBT-637: an enrollment lands between the step-1 read and establish => the password-only session dies, generic 401', async () => {
    const withHash = {
      ...user,
      passwordHash: await import('../../common/crypto/crypto.util').then(({ hashPassword }) =>
        hashPassword('correct password'),
      ),
    };
    users.findByEmailForAuthentication.mockResolvedValueOnce(withHash);
    sessions.establish.mockResolvedValue({ id: 'raced-id', session: { ref: 'r' } });
    users.clearFailedLoginsIfUnlocked.mockResolvedValue(user);
    users.findByIdForAuthentication.mockResolvedValue(withHash);
    users.mfaEnrolledAt.mockResolvedValueOnce(null).mockResolvedValueOnce(new Date());
    await expect(
      service.login('a@example.com', 'correct password', { trustDevice: true }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.revoke).toHaveBeenCalledWith('raced-id');
    expect(throttle.onSuccess).not.toHaveBeenCalled();
    const actions = audit.record.mock.calls.map(([e]) => (e as { action: AuditAction }).action);
    expect(actions).not.toContain(AuditAction.AUTH_LOGIN_SUCCESS);
  });
});
