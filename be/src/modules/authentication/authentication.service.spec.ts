import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AuthenticationService } from './authentication.service';
import { UserService } from '../identity/user.service';
import { UserTenantService } from '../identity/user-tenant.service';
import { SessionService } from '../sessions/session.service';
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
    verifyEmail: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    recordFailedLogin: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    resetFailedLogins: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
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
    users.resetFailedLogins.mockResolvedValue(user);
    await expect(
      service.login('a@example.com', 'correct password', { oldSessionId: 'old' }),
    ).resolves.toMatchObject({ id: 'new-id' });
    expect(sessions.establish).toHaveBeenCalledWith('old', user.sub, 'default-tenant', {});
  });
});
