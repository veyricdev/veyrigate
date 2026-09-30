import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import {
  generateToken,
  hashPassword,
  sha256,
  verifyPassword,
} from '../../common/crypto/crypto.util';
import type { AppConfig } from '../../config/configuration';
import { DEFAULT_TENANT_ID } from '../identity/tenant.service';
import { UserTenantService } from '../identity/user-tenant.service';
import { UserService } from '../identity/user.service';
import { MAILER, type Mailer } from '../mailer/mailer';
import { resetPasswordMessage, verifyEmailMessage } from '../mailer/templates';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { SessionService } from '../sessions/session.service';
import { DuplicateError } from '../identity/identity.errors';

interface OneTimeTokenDoc {
  tokenHash: string;
  userId: Types.ObjectId | string;
  expiresAt: Date;
  usedAt: Date | null;
}
export interface AuthContext {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';
// Valid Argon2id hash used to equalise work when the account does not exist.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$J8mD4QvqXdKlBVM7c8xOyg$D/7oPtX6TaG7b7aIjqTQZV4VYI5h/QVwsgK0MUpYwlQ';

@Injectable()
export class AuthenticationService {
  private readonly logger = new Logger(AuthenticationService.name);
  private readonly issuer: string;

  constructor(
    private readonly users: UserService,
    private readonly memberships: UserTenantService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @InjectModel('PasswordResetToken') private readonly resetTokens: Model<OneTimeTokenDoc>,
    @InjectModel('EmailVerificationToken') private readonly verifyTokens: Model<OneTimeTokenDoc>,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  async register(email: string, password: string): Promise<void> {
    this.validatePassword(password);
    const existing = await this.users.findByEmail(email);
    // Equalise the expensive branch even when no user will be created.
    const passwordHash = await hashPassword(password);
    if (existing) return;
    let user;
    try {
      user = await this.users.createWithPasswordHash(email, passwordHash);
    } catch (error) {
      if (error instanceof DuplicateError) return;
      throw error;
    }
    await this.memberships.addMembership(user.sub, DEFAULT_TENANT_ID);
    await this.issueToken(
      this.verifyTokens,
      user.sub,
      user.email,
      '/verify-email',
      VERIFY_TTL_MS,
      true,
    );
  }

  async verifyEmail(token: string): Promise<void> {
    const consumed = await this.consume(this.verifyTokens, token);
    if (!consumed || !(await this.users.verifyEmail(String(consumed.userId)))) {
      throw new BadRequestException('This link is invalid or expired.');
    }
    await this.audit.record({
      actorType: 'user',
      actorId: String(consumed.userId),
      action: AuditAction.AUTH_EMAIL_VERIFIED,
      result: 'success',
    });
  }

  async login(
    email: string,
    password: string,
    context: AuthContext & { oldSessionId?: string; deviceLabel?: string },
  ) {
    const user = await this.users.findByEmailForAuthentication(email);
    const passwordOk = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, password).catch(
      () => false,
    );
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
    if (!user || !passwordOk || !user.emailVerifiedAt || locked) {
      let newlyLocked = false;
      if (user && !locked) {
        const updated = await this.users.recordFailedLogin(user.sub);
        newlyLocked = updated?.newlyLocked ?? false;
      }
      await this.audit.record({
        actorType: 'system',
        ...(user ? { targetType: 'user', targetId: user.sub } : {}),
        action: AuditAction.AUTH_LOGIN_FAILED,
        result: 'failure',
        reason: 'invalid_credentials',
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
      if (newlyLocked)
        await this.audit.record({
          actorType: 'system',
          targetType: 'user',
          targetId: user!.sub,
          action: AuditAction.AUTH_ACCOUNT_LOCKED,
          result: 'success',
        });
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    await this.users.resetFailedLogins(user.sub);
    const established = await this.sessions.establish(
      context.oldSessionId,
      user.sub,
      DEFAULT_TENANT_ID,
      context.deviceLabel ? { deviceLabel: context.deviceLabel } : {},
    );
    await this.audit.record({
      actorType: 'user',
      actorId: user.sub,
      action: AuditAction.AUTH_LOGIN_SUCCESS,
      result: 'success',
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
    await this.audit.record({
      actorType: 'user',
      actorId: user.sub,
      action: AuditAction.SESSION_CREATED,
      targetType: 'session',
      targetId: established.session.ref,
      result: 'success',
    });
    return established;
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    await hashPassword(generateToken());
    if (user)
      await this.issueToken(this.resetTokens, user.sub, user.email, '/reset', RESET_TTL_MS, false);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    this.validatePassword(password);
    const passwordHash = await hashPassword(password);
    const consumed = await this.consume(this.resetTokens, token);
    if (!consumed || !(await this.users.setPassword(String(consumed.userId), passwordHash))) {
      throw new BadRequestException('This link is invalid or expired.');
    }
    await this.sessions.revokeAllForUser(String(consumed.userId));
    await this.audit.record({
      actorType: 'user',
      actorId: String(consumed.userId),
      action: AuditAction.AUTH_PASSWORD_RESET,
      result: 'success',
    });
  }

  private async issueToken(
    model: Model<OneTimeTokenDoc>,
    userId: string,
    email: string,
    path: string,
    ttlMs: number,
    verify: boolean,
  ): Promise<void> {
    const token = generateToken();
    await model.create({
      tokenHash: sha256(token),
      userId,
      expiresAt: new Date(Date.now() + ttlMs),
      usedAt: null,
    });
    const link = new URL(path, this.issuer);
    link.searchParams.set('token', token);
    const message = verify
      ? verifyEmailMessage(email, link.href, ttlMs / 60000)
      : resetPasswordMessage(email, link.href, ttlMs / 60000);
    void this.mailer
      .send(message)
      .catch(() => this.logger.error('Authentication email delivery failed'));
  }

  private consume(model: Model<OneTimeTokenDoc>, token: string): Promise<OneTimeTokenDoc | null> {
    const now = new Date();
    return model
      .findOneAndUpdate(
        { tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
        { returnDocument: 'after' },
      )
      .lean<OneTimeTokenDoc>()
      .exec();
  }

  private validatePassword(password: string): void {
    if (password.length < 8 || password.length > 128)
      throw new BadRequestException('Password must be between 8 and 128 characters.');
  }
}
