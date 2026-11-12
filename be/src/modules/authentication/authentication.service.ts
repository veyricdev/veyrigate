import {
  BadRequestException,
  HttpException,
  HttpStatus,
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
import {
  passwordChangedMessage,
  resetPasswordMessage,
  verifyEmailMessage,
} from '../mailer/templates';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { SessionService } from '../sessions/session.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import { DuplicateError } from '../identity/identity.errors';
import { LoginThrottleService } from './login-throttle.service';
import { assertAcceptablePassword } from './password-policy/password-policy';

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

/** Result of `changePassword` (DEBT-573); the controller maps each to a fixed page. */
export type ChangePasswordOutcome =
  | { kind: 'changed' }
  | { kind: 'throttled'; retryAfterSec: number }
  | { kind: 'no_password' }
  | { kind: 'invalid_current' }
  | { kind: 'policy'; message: string }
  | { kind: 'conflict' };

/** Step of `revokeAllUserCredentials` that failed first (audit metadata, never a secret). */
export type RevokeStep = 'pre_revoke' | 'sessions' | 'sweep';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';
/** One fixed 429 text for every login bucket and for unknown emails (DEBT-575, no oracle). */
export const LOGIN_THROTTLED_MESSAGE =
  'Too many sign-in attempts. Try again later or reset your password.';
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
    private readonly refreshTokens: RefreshTokenService,
    private readonly audit: AuditService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @InjectModel('PasswordResetToken') private readonly resetTokens: Model<OneTimeTokenDoc>,
    @InjectModel('EmailVerificationToken') private readonly verifyTokens: Model<OneTimeTokenDoc>,
    config: ConfigService,
    private readonly throttle: LoginThrottleService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  async register(email: string, password: string): Promise<void> {
    // DEBT-574: checked before the account lookup, so the answer never depends on whether it exists.
    assertAcceptablePassword(password, { email });
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

  /**
   * Password login (B2.4). DEBT-575 / D85.2: throttled per (email, network) + per email, or per
   * (email, trusted device) — reserved atomically BEFORE Argon2, identical for unknown emails; no
   * hard account lock is ever written (an admin lock or a legacy temporary lock is still honoured).
   * A Redis error while deciding (trust lookup, reserve) propagates: no Argon2, no session.
   * `deviceToken` is the well-formed device cookie of the request. With `trustDevice` (the `/login`
   * form only; federation neither reads nor sets the cookie) the result's `deviceToken` is the
   * new cookie value to set (always freshly generated, D85.11), absent when recording trust failed
   * (fail-safe).
   */
  async login(
    email: string,
    password: string,
    context: AuthContext & {
      oldSessionId?: string;
      deviceLabel?: string;
      deviceToken?: string;
      trustDevice?: boolean;
    },
  ) {
    const user = await this.users.findByEmailForAuthentication(email);
    const buckets = await this.throttle.buckets(email, context.ip, user?.sub, context.deviceToken);
    const reserved = await this.throttle.reserve(buckets);
    if (reserved.blocked) {
      if (reserved.report)
        await this.audit.record({
          actorType: 'system',
          ...(user ? { targetType: 'user', targetId: user.sub } : {}),
          action: AuditAction.AUTH_LOGIN_THROTTLED,
          result: 'failure',
          metadata: { scope: reserved.scope },
          ip: context.ip,
          userAgent: context.userAgent,
          requestId: context.requestId,
        });
      throw new HttpException(
        { retryAfter: reserved.retryAfterSec, message: LOGIN_THROTTLED_MESSAGE },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const passwordOk = await this.passwordMatches(user?.passwordHash ?? DUMMY_HASH, password);
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
    const recordFailed = () =>
      this.audit.record({
        actorType: 'system',
        ...(user ? { targetType: 'user', targetId: user.sub } : {}),
        action: AuditAction.AUTH_LOGIN_FAILED,
        result: 'failure',
        reason: 'invalid_credentials',
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
    if (!user || !passwordOk || !user.emailVerifiedAt || locked) {
      await recordFailed();
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    // DEBT-154: the snapshot above may be stale — an admin/brute-force lock set since then must
    // win. Atomic conditional reset; no match => same generic failure, no counter bump, no session.
    if (!(await this.users.clearFailedLoginsIfUnlocked(user.sub, new Date()))) {
      await recordFailed();
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    const established = await this.sessions.establish(
      context.oldSessionId,
      user.sub,
      DEFAULT_TENANT_ID,
      { amr: ['pwd'], ...(context.deviceLabel ? { deviceLabel: context.deviceLabel } : {}) },
    );
    // DEBT-141 (run 36 G5): a lock (any kind) can still land between the reset above and
    // `establish`. The locking side writes `lockedUntil` first and sweeps sessions second, so
    // re-reading AFTER the session exists leaves no interleaving where it survives. Locked/gone =>
    // kill the new session (tombstone), same generic failure, no counter bump, no success audit.
    // A DB error kills it best-effort and propagates (500, no cookie).
    // DEBT-600: same reasoning for a credential change. Change/reset write the new hash first and
    // revoke every session second, so if the hash re-read AFTER `establish` is still the one this
    // attempt verified, any later change revokes this session; if it differs, the password checked
    // here is already stale => kill the session, generic 401, no success audit, no device trust,
    // no bucket clear.
    let fresh: Awaited<ReturnType<UserService['findByIdForAuthentication']>>;
    try {
      fresh = await this.users.findByIdForAuthentication(user.sub);
    } catch (err) {
      await this.sessions.revoke(established.id).catch(() => undefined);
      throw err;
    }
    if (
      !fresh ||
      (fresh.lockedUntil && fresh.lockedUntil > new Date()) ||
      fresh.passwordHash !== user.passwordHash
    ) {
      await this.sessions.revoke(established.id);
      await recordFailed();
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
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
    // DEBT-596 (D85.11): a fresh device token on every successful login, never the presented one.
    const deviceToken = await this.throttle.onSuccess(
      buckets,
      user.sub,
      context.trustDevice === true,
      context.deviceToken,
    );
    return { ...established, ...(deviceToken ? { deviceToken } : {}) };
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    await hashPassword(generateToken());
    if (user)
      await this.issueToken(this.resetTokens, user.sub, user.email, '/reset', RESET_TTL_MS, false);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    // DEBT-574: before `consume` (a refused password keeps the token). The email is not known yet:
    // list + product words only.
    assertAcceptablePassword(password);
    const passwordHash = await hashPassword(password);
    const consumed = await this.consume(this.resetTokens, token);
    const updated = consumed
      ? await this.users.setPassword(String(consumed.userId), passwordHash)
      : null;
    if (!consumed || !updated) {
      throw new BadRequestException('This link is invalid or expired.');
    }
    // §9.8 / INV-11 / INV-28: terminate every session AND every refresh family of the user so a
    // leaked/old credential cannot survive the reset. `setPassword` MUST run before any revoke: if
    // we revoked first, an attacker who knows the old password could log in in between and keep a
    // fresh session. Any infra failure propagates (5xx) — never reported as success, and the
    // password is NOT rolled back (DEBT-050: rollback could re-enable a possibly-leaked credential).
    const userId = String(consumed.userId);
    await this.revokeAllUserCredentials(userId, new Date(), (failedStep) =>
      this.audit.record({
        actorType: 'user',
        actorId: userId,
        action: AuditAction.AUTH_PASSWORD_RESET,
        result: 'failure',
        reason: 'revoke_failed',
        metadata: { failedStep },
      }),
    );

    await this.audit.record({
      actorType: 'user',
      actorId: userId,
      action: AuditAction.AUTH_PASSWORD_RESET,
      result: 'success',
    });
    this.sendPasswordChanged(updated.email);
    // DEBT-575: the owner proved control of the mailbox => drop the per-email login bucket.
    await this.throttle
      .clearAccount(updated.email)
      .catch(() => this.logger.warn('reset: clearing the login account bucket failed'));
  }

  /**
   * Self-service password change (DEBT-573, D85.6), for the user of a live session. Order:
   * reserve a current-password attempt (5/900 s per user) BEFORE Argon2 → read the hash → verify
   * the current password → policy (D85.4) → compare-and-set on the verified hash (not locked) →
   * revoke EVERY credential (current session included; reuses the reset path, INV-11/28) → audit →
   * notification mail. A revoke failure propagates (5xx) after a failure audit; the new password
   * is NOT rolled back (DEBT-050). Never echoes a password; every refusal is a fixed outcome.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    context: AuthContext = {},
  ): Promise<ChangePasswordOutcome> {
    const fail = (reason: string, metadata?: Record<string, string>) =>
      this.audit.record({
        actorType: 'user',
        actorId: userId,
        action: AuditAction.AUTH_PASSWORD_CHANGED,
        result: 'failure',
        reason,
        ...(metadata ? { metadata } : {}),
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
    const reserved = await this.throttle.reservePasswordChange(userId);
    if (reserved.blocked) {
      if (reserved.report) await fail('throttled');
      return { kind: 'throttled', retryAfterSec: reserved.retryAfterSec };
    }
    const user = await this.users.findByIdForAuthentication(userId);
    if (!user?.passwordHash) {
      await this.throttle.refundPasswordChange(userId);
      await fail('no_password');
      return { kind: 'no_password' };
    }
    if (!(await this.passwordMatches(user.passwordHash, currentPassword))) {
      await fail('invalid_current');
      return { kind: 'invalid_current' };
    }
    try {
      assertAcceptablePassword(newPassword, { email: user.email });
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      await this.throttle.refundPasswordChange(userId);
      await fail('policy');
      return { kind: 'policy', message: err.message };
    }
    const newHash = await hashPassword(newPassword);
    if (!(await this.users.changePassword(userId, user.passwordHash, newHash))) {
      await fail('conflict');
      return { kind: 'conflict' };
    }
    const { sessionCount, tokenCount } = await this.revokeAllUserCredentials(
      userId,
      new Date(),
      (failedStep) => fail('revoke_failed', { failedStep }),
    );
    await this.throttle.refundPasswordChange(userId);
    await this.audit.record({
      actorType: 'user',
      actorId: userId,
      action: AuditAction.AUTH_PASSWORD_CHANGED,
      result: 'success',
      metadata: { sessionCount, tokenCount },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
    this.sendPasswordChanged(user.email);
    return { kind: 'changed' };
  }

  /** Whether the user can sign in with a password (a federation-only account cannot). */
  async hasPassword(userId: string): Promise<boolean> {
    return !!(await this.users.findByIdForAuthentication(userId))?.passwordHash;
  }

  /** "Your password was changed" notice (no token), fire-and-forget like every auth mail. */
  private sendPasswordChanged(email: string): void {
    const message = passwordChangedMessage(
      email,
      new Date().toISOString(),
      new URL('/forgot', this.issuer).href,
    );
    void this.mailer
      .send(message)
      .catch(() => this.logger.error('Password change notice delivery failed'));
  }

  /**
   * Terminate EVERY credential of a user (password reset, admin lock, admin "revoke sessions";
   * B6.3b). Order (tech-lead fold): revoke families (stamp-first) → revoke sessions (MARK, writes
   * `sess_end` tombstones so an access token carrying that `sid` dies via liveness) → revoke
   * families again (SWEEP) so a family a concurrent `/token` created between the first revoke and
   * the tombstone cannot survive (§15 inv. 29).
   *
   * DEBT-055: ALL three steps run even if an earlier one failed (skipping the session MARK because
   * Mongo failed in pre-revoke would leave a hijacked session alive). The FIRST error wins: the
   * caller's `onFailure(step)` is awaited best-effort (a failing failure-audit never masks the
   * revoke error), then that error is rethrown. Idempotent, so a caller may simply retry.
   */
  async revokeAllUserCredentials(
    userId: string,
    now: Date,
    onFailure?: (failedStep: RevokeStep) => Promise<unknown>,
  ): Promise<{ sessionCount: number; tokenCount: number }> {
    let firstError: unknown;
    let failedStep: RevokeStep | undefined;
    const runStep = async (step: RevokeStep, op: () => Promise<number>): Promise<number> => {
      try {
        return await op();
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
          failedStep = step;
        }
        return 0;
      }
    };
    let tokenCount = await runStep('pre_revoke', () =>
      this.refreshTokens.revokeAllForUser(userId, now),
    );
    const sessionCount = await runStep('sessions', () => this.sessions.revokeAllForUser(userId));
    tokenCount += await runStep('sweep', () => this.refreshTokens.revokeAllForUser(userId, now));
    // DEBT-575: last, best-effort — forget the user's trusted devices (a device cookie must not
    // outlive the credentials it signed in with). Never changes the outcome of the steps above.
    await this.throttle
      .forgetDevices(userId)
      .catch(() => this.logger.warn('revoke: forgetting trusted devices failed'));

    if (firstError !== undefined) {
      await onFailure?.(failedStep as RevokeStep).catch(() => undefined);
      throw firstError;
    }
    return { sessionCount, tokenCount };
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
    // DEBT-577 (D86.3): the token rides in the fragment, which the browser never sends, so it never
    // reaches a request line, access log or Referer. `token-fragment.js` moves it into the form.
    const link = new URL(path, this.issuer);
    link.hash = `token=${token}`;
    const message = verify
      ? verifyEmailMessage(email, link.href, ttlMs / 60000, token)
      : resetPasswordMessage(email, link.href, ttlMs / 60000, token);
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

  /** Argon2 verification of a login attempt (one call = one Argon2 run; tests count it). */
  private passwordMatches(hash: string, password: string): Promise<boolean> {
    return verifyPassword(hash, password).catch(() => false);
  }
}
