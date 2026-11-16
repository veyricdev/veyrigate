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
import { errorForLog } from '../../common/logger/error-log';
import { observeBackgroundWriteFailure, type BackgroundWrite } from '../../common/metrics/metrics';
import type { AppConfig } from '../../config/configuration';
import { DEFAULT_TENANT_ID } from '../identity/tenant.service';
import { UserTenantService } from '../identity/user-tenant.service';
import { UserService } from '../identity/user.service';
import { MAILER, type MailMessage, type Mailer } from '../mailer/mailer';
import {
  completeRegistrationMessage,
  passwordChangedMessage,
  resetPasswordMessage,
  verifyEmailMessage,
} from '../mailer/templates';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { SessionService, type Session } from '../sessions/session.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import { DuplicateError } from '../identity/identity.errors';
import { LoginThrottleService, type LoginBuckets } from './login-throttle.service';
import { assertAcceptablePassword } from './password-policy/password-policy';

interface OneTimeTokenDoc {
  tokenHash: string;
  userId: Types.ObjectId | string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts?: number;
}
type MailTemplate = (to: string, link: string, minutes: number, code: string) => MailMessage;
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

/**
 * A first factor proven for a user who has a second one (run 89, D89.7/D89.8): what step 2 needs to
 * finish the sign-in. Nothing here was applied yet (no session, no bucket clear, no device trust, no
 * success audit). Server data only, stored in the MFA ticket (never a password or a device cookie).
 */
export interface PendingMfa {
  userId: string;
  /** First-factor method: `['pwd']` or `['fed']`. */
  amr: string[];
  /** The enrollment step 1 saw; step 2 must verify against the same one. */
  enrolledAt: Date;
  /** Federation only: the upstream `auth_time` (ms) kept as the session `authTime` (D89.15). */
  authTime?: number;
  /** Federation only: provider name for the success audit. */
  provider?: string;
  /** Password only: sha256(passwordHash) verified at step 1 (re-checked after `establish`). */
  pwdFp?: string;
  /** Password only: the throttle buckets to clear and the device to trust once step 2 succeeds. */
  buckets?: LoginBuckets;
  deviceHash?: string;
  trustDevice?: boolean;
  deviceLabel?: string;
}

/** `login()` (D89.7): a session, or a pending second factor. */
export type LoginResult =
  | { kind: 'session'; id: string; session: Session; deviceToken?: string }
  | { kind: 'mfa'; pending: PendingMfa };

/** Step of `revokeAllUserCredentials` that failed first (audit metadata, never a secret). */
export type RevokeStep = 'pre_revoke' | 'sessions' | 'sweep';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
/** Longest wait for detached writes at shutdown (D91.11); the orchestrator grace period is longer. */
const SHUTDOWN_DRAIN_MS = 5000;
const GENERIC_LOGIN_ERROR = 'Email or password is incorrect.';
/** One answer for every refused `/verify-email` (D91.14): bad/used/expired link or wrong password. */
const VERIFY_FAILED = 'This link is invalid or expired, or the password is wrong.';
/** Password attempts per verify token (D91.14); the last wrong one burns the token. */
const VERIFY_MAX_ATTEMPTS = 5;
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

  /**
   * Writes that depend on whether the account exists, run off the response path (DEBT-659/660, run 90
   * C2): `/register` and `/forgot` answer in the same time for a known and an unknown email.
   */
  private readonly pending = new Set<Promise<void>>();

  /**
   * Starts `work` now and returns at once. A failure is counted (DEBT-666, alert
   * `SsoBackgroundWriteFailed`) BEFORE it is logged (error class + frames, never the message, which
   * may carry the email), and never reaches the caller: the page is the same either way.
   */
  private detach(what: BackgroundWrite, work: () => Promise<void>): void {
    const run: Promise<void> = work()
      .catch((err: unknown) => {
        observeBackgroundWriteFailure(what);
        this.logger.error(`${what} background write failed: ${errorForLog(err)}`);
      })
      .catch(() => undefined) // a throwing logger must not leave an unhandled rejection
      .finally(() => this.pending.delete(run));
    this.pending.add(run);
  }

  /** Resolves once every detached write has finished (shutdown drain; int tests). */
  async drainBackgroundWrites(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * SIGTERM (`enableShutdownHooks`): finish detached writes before Mongo closes, waiting at most
   * {@link SHUTDOWN_DRAIN_MS} (D91.11). Past that, log how many are still pending (a count only)
   * and return so the rest of the shutdown still runs.
   */
  async beforeApplicationShutdown(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), SHUTDOWN_DRAIN_MS);
      timer.unref();
    });
    try {
      if (await Promise.race([this.drainBackgroundWrites().then(() => false), timedOut])) {
        this.logger.warn(`shutdown: ${this.pending.size} background write(s) still pending`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async register(email: string, password: string): Promise<void> {
    // DEBT-574: checked before the account lookup, so the answer never depends on whether it exists.
    assertAcceptablePassword(password, { email });
    const existing = await this.users.findByEmail(email);
    // Equalise the expensive branch even when no user will be created.
    const passwordHash = await hashPassword(password);
    if (existing) {
      // DEBT-665 (D91.4, retry 1): the way back for an unfinished registration. A RESET link, never
      // a verify link: the stored password may be an attacker's (pre-hijacking, D91.13); the reset
      // lets the mailbox owner choose the password, verifies the email (D91.5) and revokes every
      // credential. Detached like the new-email branch (no await on the response path); one mail at
      // most while a reset token is live (30', the `/forgot` rate), on top of the `register`
      // throttle. Check-then-issue is not atomic: two concurrent requests may send two mails —
      // accepted. Verified or federation-only accounts get nothing.
      if (!existing.emailVerifiedAt) {
        this.detach('resend_verify', async () => {
          if (!(await this.users.isUnverifiedWithPassword(existing.sub))) return;
          const live = await this.resetTokens.exists({
            userId: existing.sub,
            usedAt: null,
            expiresAt: { $gt: new Date() },
          });
          if (live) return;
          await this.issueToken(
            this.resetTokens,
            existing.sub,
            existing.email,
            '/reset',
            RESET_TTL_MS,
            completeRegistrationMessage,
          );
        });
      }
      return;
    }
    // DEBT-659: creating the user, its membership and the verify token (~20 ms) only happens for a
    // new email, so it runs detached; the answer is the same generic page either way.
    this.detach('register', async () => {
      let user;
      try {
        user = await this.users.createWithPasswordHash(email, passwordHash);
      } catch (error) {
        if (error instanceof DuplicateError) return; // a concurrent registration won: nothing to do
        throw error;
      }
      await this.memberships.addMembership(user.sub, DEFAULT_TENANT_ID);
      await this.issueToken(
        this.verifyTokens,
        user.sub,
        user.email,
        '/verify-email',
        VERIFY_TTL_MS,
        verifyEmailMessage,
      );
    });
  }

  /**
   * DEBT-671 (D91.14): verifying the mailbox must also prove the password, so a mailbox owner never
   * activates a password someone else chose (D91.13). Order: reserve one attempt on the live token
   * (atomic `$inc`, at most {@link VERIFY_MAX_ATTEMPTS}) BEFORE Argon2, so parallel guesses stay
   * bounded → Argon2 → only then consume the token atomically. A wrong password keeps the token;
   * after the 5th attempt the reservation filter refuses it for good (DEBT-672: no separate burn
   * write). Every refusal is the same 400; nothing is logged.
   */
  async verifyEmail(token: string, password: string): Promise<void> {
    const reserved = await this.verifyTokens
      .findOneAndUpdate(
        {
          tokenHash: sha256(token),
          usedAt: null,
          expiresAt: { $gt: new Date() },
          attempts: { $not: { $gte: VERIFY_MAX_ATTEMPTS } },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      )
      .lean<OneTimeTokenDoc & { _id: unknown }>()
      .exec();
    if (!reserved) throw new BadRequestException(VERIFY_FAILED);
    const user = await this.users.findByIdForAuthentication(String(reserved.userId));
    if (!user?.passwordHash || !(await this.passwordMatches(user.passwordHash, password))) {
      throw new BadRequestException(VERIFY_FAILED);
    }
    const consumed = await this.verifyTokens
      .findOneAndUpdate(
        { _id: reserved._id, usedAt: null },
        { $set: { usedAt: new Date() } },
        { returnDocument: 'after' },
      )
      .lean<OneTimeTokenDoc>()
      .exec();
    if (!consumed || !(await this.users.verifyEmail(String(consumed.userId)))) {
      throw new BadRequestException(VERIFY_FAILED);
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
   * (fail-safe). Run 89 (D89.7): a user with a second factor gets `{kind:'mfa'}` after every step-1
   * check passed, and NOTHING of the success path runs yet (no session, no bucket clear, no device
   * trust, no success audit): the caller turns `pending` into an MFA ticket.
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
  ): Promise<LoginResult> {
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
    const enrolledAt = await this.users.mfaEnrolledAt(user.sub);
    if (enrolledAt) {
      return {
        kind: 'mfa',
        pending: {
          userId: user.sub,
          amr: ['pwd'],
          enrolledAt,
          pwdFp: sha256(user.passwordHash!),
          buckets,
          ...(context.deviceToken ? { deviceHash: sha256(context.deviceToken) } : {}),
          trustDevice: context.trustDevice === true,
          ...(context.deviceLabel ? { deviceLabel: context.deviceLabel } : {}),
        },
      };
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
    // DEBT-637 (run 89): same for an enrollment racing this login (read `null` above, enrolled
    // before `establish`): its revoke-all may have run before this session existed.
    let fresh: Awaited<ReturnType<UserService['findByIdForAuthentication']>>;
    let enrolledNow: Date | null;
    try {
      fresh = await this.users.findByIdForAuthentication(user.sub);
      enrolledNow = await this.users.mfaEnrolledAt(user.sub);
    } catch (err) {
      await this.sessions.revoke(established.id).catch(() => undefined);
      throw err;
    }
    if (
      !fresh ||
      (fresh.lockedUntil && fresh.lockedUntil > new Date()) ||
      fresh.passwordHash !== user.passwordHash ||
      enrolledNow !== null
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
      context.deviceToken ? sha256(context.deviceToken) : undefined,
    );
    return { kind: 'session', ...established, ...(deviceToken ? { deviceToken } : {}) };
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    await hashPassword(generateToken());
    // DEBT-660: the reset token write only happens for a known email, so it runs detached.
    if (user)
      this.detach('forgot', () =>
        this.issueToken(
          this.resetTokens,
          user.sub,
          user.email,
          '/reset',
          RESET_TTL_MS,
          resetPasswordMessage,
        ),
      );
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

  /**
   * Re-authentication with the current password (run 88, D88.18, ASVS 5.0 7.5.2) through the SAME
   * 5/900 s bucket as `/account/password` (reserved before Argon2, refunded on success), so the
   * form is not a second password-guessing oracle. Redis/Mongo errors propagate (fail-closed).
   * `throttled.report` is true for the first refusal of the window (DEBT-629: the caller audits it
   * once, like `changePassword`).
   */
  async verifyCurrentPassword(
    userId: string,
    password: string,
  ): Promise<
    | { kind: 'ok' | 'invalid' | 'no_password' }
    | { kind: 'throttled'; retryAfterSec: number; report: boolean }
  > {
    const reserved = await this.throttle.reservePasswordChange(userId);
    if (reserved.blocked) {
      return { kind: 'throttled', retryAfterSec: reserved.retryAfterSec, report: reserved.report };
    }
    const user = await this.users.findByIdForAuthentication(userId);
    if (!user?.passwordHash) {
      await this.throttle.refundPasswordChange(userId);
      return { kind: 'no_password' };
    }
    if (!(await this.passwordMatches(user.passwordHash, password))) return { kind: 'invalid' };
    await this.throttle.refundPasswordChange(userId);
    return { kind: 'ok' };
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
    template: MailTemplate,
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
    const message = template(email, link.href, ttlMs / 60000, token);
    void this.mailer
      .send(message)
      .catch(() => {
        observeBackgroundWriteFailure('auth_mail'); // DEBT-666 (D91.3): counted before logging
        this.logger.error('Authentication email delivery failed');
      })
      .catch(() => undefined);
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
