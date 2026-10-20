import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AuthenticationService } from './authentication.service';
import { UserService } from '../identity/user.service';
import { UserTenantService } from '../identity/user-tenant.service';
import { SessionService } from '../sessions/session.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import { AuditService } from '../security/audit/audit.service';
import { MAILER } from '../mailer/mailer';
import { DuplicateError } from '../identity/identity.errors';
import { AuditAction } from '../security/audit/audit-action.enum';

describe('AuthenticationService', () => {
  const user = {
    sub: '507f1f77bcf86cd799439011',
    email: 'a@example.com',
    profile: {},
    emailVerifiedAt: new Date(),
    failedLoginCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const users = {
    createWithPasswordHash: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findByEmail: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findByEmailForAuthentication: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findById: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    verifyEmail: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    recordFailedLogin: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    clearFailedLoginsIfUnlocked: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    setPassword: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const tokenModel = {
    create: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    findOneAndUpdate: jest.fn<(...args: unknown[]) => unknown>(),
  };
  const sessions = {
    establish: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    revokeAllForUser: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const refreshTokens = {
    revokeAllForUser: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const memberships = { addMembership: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  const audit = { record: jest.fn<(...args: unknown[]) => Promise<unknown>>() };
  let service: AuthenticationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tokenModel.create.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        AuthenticationService,
        { provide: UserService, useValue: users },
        { provide: UserTenantService, useValue: memberships },
        { provide: SessionService, useValue: sessions },
        { provide: RefreshTokenService, useValue: refreshTokens },
        { provide: AuditService, useValue: audit },
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

  it('consumes a reset token atomically only after validating password', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => ({ userId: user.sub }) }),
    });
    users.setPassword.mockResolvedValue(user);
    sessions.revokeAllForUser.mockResolvedValue(2);
    refreshTokens.revokeAllForUser.mockResolvedValue(1);
    await service.resetPassword('secret-token', 'new password');
    expect(tokenModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHash: expect.any(String),
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

  it('reset does not revoke anything when the link is invalid (fail-closed) (DEBT-050)', async () => {
    tokenModel.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: async () => null }),
    });
    await expect(service.resetPassword('secret-token', 'new password')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('treats a duplicate created by a concurrent registration as the generic success path', async () => {
    users.findByEmail.mockResolvedValue(null);
    users.createWithPasswordHash.mockRejectedValue(new DuplicateError('User'));

    await expect(service.register('race@example.com', 'correct password')).resolves.toBeUndefined();
    expect(memberships.addMembership).not.toHaveBeenCalled();
    expect(tokenModel.create).not.toHaveBeenCalled();
  });

  it('audits exactly the atomic transition into lock under concurrent failures', async () => {
    users.findByEmailForAuthentication.mockResolvedValue({
      ...user,
      emailVerifiedAt: new Date(),
      passwordHash: '$invalid-hash',
    });
    let failure = 0;
    users.recordFailedLogin.mockImplementation(async () => ({ newlyLocked: ++failure === 5 }));
    audit.record.mockResolvedValue(undefined);

    await Promise.allSettled(
      Array.from({ length: 10 }, () => service.login(user.email, 'wrong password', {})),
    );

    expect(audit.record).toHaveBeenCalledTimes(11);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUTH_ACCOUNT_LOCKED }),
    );
  });

  it('uses a generic login failure and establishes a fresh session on success', async () => {
    users.findByEmailForAuthentication.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...user,
      passwordHash: await import('../../common/crypto/crypto.util').then(({ hashPassword }) =>
        hashPassword('correct password'),
      ),
    });
    await expect(service.login('missing@example.com', 'wrong', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    sessions.establish.mockResolvedValue({ id: 'new-id', session: {} });
    users.clearFailedLoginsIfUnlocked.mockResolvedValue(user);
    users.findById.mockResolvedValue(user); // run 36: post-establish re-read (still unlocked)
    await expect(
      service.login('a@example.com', 'correct password', { oldSessionId: 'old' }),
    ).resolves.toMatchObject({ id: 'new-id' });
    expect(sessions.establish).toHaveBeenCalledWith('old', user.sub, 'default-tenant', {
      amr: ['pwd'],
    });
  });
});
