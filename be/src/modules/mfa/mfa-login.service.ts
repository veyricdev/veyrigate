import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { generateToken, sha256 } from '../../common/crypto/crypto.util';
import type { AppConfig, SessionConfig } from '../../config/configuration';
import { loadLuaScripts } from '../../database/redis/lua-loader';
import { RedisService } from '../../database/redis/redis.service';
import type { PendingMfa } from '../authentication/authentication.service';
import { LoginThrottleService } from '../authentication/login-throttle.service';
import { DEFAULT_TENANT_ID } from '../identity/tenant.service';
import { UserService } from '../identity/user.service';
import { MAILER, type Mailer } from '../mailer/mailer';
import { mfaLockedMessage } from '../mailer/templates';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { hostCookieName } from '../sessions/session.cookie';
import { SessionService } from '../sessions/session.service';
import { MFA_FAILURE_CAP, MfaService, type MfaCheck } from './mfa.service';

/** Ticket lifetime (D89.8): fixed, never slid. Step 1 and step 2 are at most 300 s apart. */
export const MFA_TICKET_TTL_SEC = 300;
/** Wrong codes per ticket before it is dropped (the password must be typed again). */
export const MFA_TICKET_MAX_FAILS = 5;
/** Wrong codes per user over every ticket and `/account/mfa` (D89.9). */
export const MFA_USER_LIMIT = 10;
export const MFA_USER_WINDOW_SEC = 900;
export const MFA_TICKET_COOKIE = 'idp_mfa';

const ticketKey = (id: string): string => `mfa_pend:${sha256(id)}`;
const userKey = (userId: string): string => `mfa_fail:{u:${sha256(userId)}}`;

/** HINCRBY only on a live ticket: an expired one must never come back without a TTL. */
const FAIL_SCRIPT = {
  name: 'mfaTicketFail',
  numberOfKeys: 1,
  lua: `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
return redis.call('HINCRBY', KEYS[1], 'fails', 1)`,
};
type FailRedis = { mfaTicketFail(key: string): Promise<number> };

/** Request context of an MFA audit; `tenantId` = the tenant of the flow (D89.29, DEBT-645). */
export type MfaAuditContext = {
  ip?: string;
  userAgent?: string;
  requestId?: string;
  tenantId?: string;
};

export type MfaCompletion =
  | { kind: 'signed_in'; sessionId: string; returnTo: string; deviceToken?: string }
  /** `suspended`: authenticator codes are refused after the DEBT-640 cap (fixed text). */
  | { kind: 'wrong'; suspended?: true }
  | { kind: 'restart'; returnTo: string }
  | { kind: 'expired' }
  | { kind: 'throttled'; retryAfterSec: number }
  | { kind: 'failed' };

/**
 * Step 2 of every sign-in of an enrolled user (run 89, D89.7–D89.9, D89.15): the MFA ticket in Redis
 * (`mfa_pend:{sha256(id)}`, raw id only in the HttpOnly cookie) and ONE completion shared by `/login`,
 * the federation callback and `/auth/link`. Order: user limiter (reserve) -> code (Mongo CAS) ->
 * `DEL` ticket (= 1 wins) -> `establish` -> re-check (lock, password, enrollment) -> audit ->
 * throttle success. A Redis/Mongo error propagates (5xx): before the `DEL` the ticket survives and
 * the user can retry; after `establish` the new session is killed first.
 */
@Injectable()
export class MfaLoginService {
  readonly cookieName: string;
  private readonly cookieOptions: CookieSerializeOptions;
  private readonly issuer: string;
  private readonly logger = new Logger(MfaLoginService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly users: UserService,
    private readonly audit: AuditService,
    private readonly throttle: LoginThrottleService,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
    const secure = config.getOrThrow<SessionConfig>('session').cookieSecure;
    this.cookieName = hostCookieName(MFA_TICKET_COOKIE, secure);
    this.cookieOptions = {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: MFA_TICKET_TTL_SEC,
    };
    loadLuaScripts(redis.client, [FAIL_SCRIPT]);
  }

  /** The ticket cookie of the request (well-formed only), or undefined. */
  readTicket(req: { cookies?: Record<string, string | undefined> }): string | undefined {
    const v = req.cookies?.[this.cookieName];
    return v && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : undefined;
  }

  setTicketCookie(
    reply: { setCookie(n: string, v: string, o: CookieSerializeOptions): unknown },
    id: string,
  ): void {
    reply.setCookie(this.cookieName, id, this.cookieOptions);
  }

  clearTicketCookie(reply: { clearCookie(n: string, o: CookieSerializeOptions): unknown }): void {
    reply.clearCookie(this.cookieName, { ...this.cookieOptions, maxAge: undefined });
  }

  /** Store a ticket (TTL 300 s, fixed). `returnTo` must already be `safeReturnTo`'d. */
  async start(pending: PendingMfa, returnTo: string): Promise<string> {
    const id = generateToken();
    const key = ticketKey(id);
    const fields: Record<string, string> = {
      userId: pending.userId,
      returnTo,
      amr: JSON.stringify(pending.amr),
      enrolledAt: String(pending.enrolledAt.getTime()),
      trustDevice: pending.trustDevice ? '1' : '0',
      fails: '0',
    };
    if (pending.authTime !== undefined) fields.authTime = String(pending.authTime);
    if (pending.provider) fields.provider = pending.provider;
    if (pending.pwdFp) fields.pwdFp = pending.pwdFp;
    if (pending.buckets) fields.buckets = JSON.stringify(pending.buckets);
    if (pending.deviceHash) fields.deviceHash = pending.deviceHash;
    if (pending.deviceLabel) fields.deviceLabel = pending.deviceLabel;
    const replies = await this.redis.client
      .multi()
      .hset(key, fields)
      .expire(key, MFA_TICKET_TTL_SEC)
      .exec();
    if (!replies || replies.some(([err]) => err)) throw new Error('mfa ticket write failed');
    return id;
  }

  /** `returnTo` of a live ticket, or null (gone / expired). Redis errors propagate. */
  async returnToOf(id: string | undefined): Promise<string | null> {
    return id ? this.redis.client.hget(ticketKey(id), 'returnTo') : null;
  }

  /** Whether the ticket is live (the `/login/mfa` page). Redis errors propagate. */
  async exists(id: string | undefined): Promise<boolean> {
    return !!id && (await this.redis.client.exists(ticketKey(id))) === 1;
  }

  /**
   * D89.9: reserve one second-factor attempt for the user BEFORE any code is computed (shared by
   * `/login/mfa` and `/account/mfa/*`). Blocked => `AUTH_MFA_THROTTLED` once per window (alert).
   */
  async reserveAttempt(
    userId: string,
    ctx: MfaAuditContext,
  ): Promise<{ blocked: false } | { blocked: true; retryAfterSec: number }> {
    const key = userKey(userId);
    const r = await this.rateLimit.reserve([{ key, limit: MFA_USER_LIMIT }], MFA_USER_WINDOW_SEC);
    if (!r.blocked) return { blocked: false };
    const first = await this.redis.client.set(
      `${key}:throttled`,
      '1',
      'EX',
      MFA_USER_WINDOW_SEC,
      'NX',
    );
    if (first === 'OK') {
      await this.audit.record({
        actorType: 'system',
        targetType: 'user',
        targetId: userId,
        action: AuditAction.AUTH_MFA_THROTTLED,
        result: 'failure',
        ...ctx,
      });
    }
    return { blocked: true, retryAfterSec: r.retryAfterSec };
  }

  /** Give the attempt back after a right code (best-effort, like the password buckets). */
  async refundAttempt(userId: string): Promise<void> {
    await this.rateLimit.refund([userKey(userId)]).catch(() => undefined);
  }

  /**
   * A wrong second-factor code: one more consecutive failure (DEBT-640; reaching the cap => one
   * alerting `AUTH_MFA_LOCKED` + a mail to the owner), and `AUTH_MFA_FAILED` once per user per
   * window (never the code).
   */
  async recordWrongCode(userId: string, ctx: MfaAuditContext, via: string): Promise<void> {
    const failures = await this.mfa.recordFailure(userId);
    if (failures === MFA_FAILURE_CAP) {
      await this.audit.record({
        actorType: 'system',
        targetType: 'user',
        targetId: userId,
        action: AuditAction.AUTH_MFA_LOCKED,
        result: 'failure',
        metadata: { via, failures },
        ...ctx,
      });
      const user = await this.users.findById(userId).catch(() => null);
      if (user) {
        void this.mailer
          .send(
            mfaLockedMessage(
              user.email,
              new Date().toISOString(),
              new URL('/account/mfa', this.issuer).href,
            ),
          )
          .catch(() => this.logger.error('MFA blocked notice delivery failed'));
      }
    }
    const first = await this.redis.client.set(
      `${userKey(userId)}:failed`,
      '1',
      'EX',
      MFA_USER_WINDOW_SEC,
      'NX',
    );
    if (first !== 'OK') return;
    await this.audit.record({
      actorType: 'system',
      targetType: 'user',
      targetId: userId,
      action: AuditAction.AUTH_MFA_FAILED,
      result: 'failure',
      metadata: { via },
      ...ctx,
    });
  }

  /** 6 digits (spaces ignored) => TOTP; anything else => a recovery code (D89.11). */
  checkCode(
    userId: string,
    code: string,
    enrolledAt?: Date,
    requestId?: string,
  ): Promise<MfaCheck> {
    return /^\d{6}$/.test(code.replace(/\s+/g, ''))
      ? this.mfa.verify(userId, code, enrolledAt, requestId)
      : this.mfa.consumeRecovery(userId, code, enrolledAt);
  }

  async complete(
    id: string | undefined,
    code: string,
    ctx: MfaAuditContext & { oldSessionId?: string },
  ): Promise<MfaCompletion> {
    if (!id) return { kind: 'expired' };
    const key = ticketKey(id);
    const t = await this.redis.client.hgetall(key);
    if (!t.userId) return { kind: 'expired' };
    const userId = t.userId;
    // D89.29: step 2 belongs to the IdP session it creates (`DEFAULT_TENANT_ID`, as `establish`),
    // so the tenant's admin sees every audit of it in `GET /admin/audit`.
    const audit = {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      tenantId: DEFAULT_TENANT_ID,
    };

    const reserved = await this.reserveAttempt(userId, audit);
    if (reserved.blocked) return { kind: 'throttled', retryAfterSec: reserved.retryAfterSec };

    const check = await this.checkCode(userId, code, new Date(Number(t.enrolledAt)), ctx.requestId);
    if (!check.ok) {
      if (!check.suspended) await this.recordWrongCode(userId, audit, 'login');
      const fails = await (this.redis.client as unknown as FailRedis).mfaTicketFail(key);
      if (fails < 0) return { kind: 'expired' };
      if (fails >= MFA_TICKET_MAX_FAILS) {
        await this.redis.client.del(key);
        return { kind: 'restart', returnTo: t.returnTo };
      }
      return check.suspended ? { kind: 'wrong', suspended: true } : { kind: 'wrong' };
    }
    await this.refundAttempt(userId);
    // The DEL is the single winner of this ticket (a parallel request with the same ticket lost
    // the CAS above, or finds it gone here).
    if ((await this.redis.client.del(key)) !== 1) return { kind: 'expired' };

    const totp = check.step !== undefined;
    const now = this.mfa.clock();
    const firstAmr = JSON.parse(t.amr) as string[];
    const established = await this.sessions.establish(ctx.oldSessionId, userId, DEFAULT_TENANT_ID, {
      amr: [...firstAmr, ...(totp ? ['otp'] : []), 'mfa'],
      authTime: t.authTime !== undefined ? Number(t.authTime) : now,
      mfaAt: now,
      ...(t.deviceLabel ? { deviceLabel: t.deviceLabel } : {}),
    });
    // Same reasoning as DEBT-141/600/187 in `login`: lock / password change / MFA reset+re-enroll
    // between step 1 and here must win. Read AFTER the session exists; a DB error kills it.
    let fresh: Awaited<ReturnType<UserService['findByIdForAuthentication']>>;
    let enrolledNow: Date | null;
    try {
      fresh = await this.users.findByIdForAuthentication(userId);
      enrolledNow = await this.users.mfaEnrolledAt(userId);
    } catch (err) {
      await this.sessions.revoke(established.id).catch(() => undefined);
      throw err;
    }
    if (
      !fresh ||
      (fresh.lockedUntil && fresh.lockedUntil.getTime() > Date.now()) ||
      (t.pwdFp !== undefined && sha256(fresh.passwordHash ?? '') !== t.pwdFp) ||
      enrolledNow?.getTime() !== check.enrolledAt.getTime()
    ) {
      await this.sessions.revoke(established.id);
      await this.audit.record({
        actorType: 'system',
        targetType: 'user',
        targetId: userId,
        action: AuditAction.AUTH_LOGIN_FAILED,
        result: 'failure',
        reason: 'mfa_recheck',
        ...audit,
      });
      return { kind: 'failed' };
    }
    await this.audit.record({
      actorType: 'user',
      actorId: userId,
      action: AuditAction.AUTH_LOGIN_SUCCESS,
      result: 'success',
      metadata: {
        mfa: totp ? 'totp' : 'recovery',
        ...(t.provider ? { provider: t.provider } : {}),
      },
      ...audit,
    });
    await this.audit.record({
      actorType: 'user',
      actorId: userId,
      action: AuditAction.SESSION_CREATED,
      targetType: 'session',
      targetId: established.session.ref,
      result: 'success',
      tenantId: DEFAULT_TENANT_ID,
    });
    if (!totp) {
      await this.audit.record({
        actorType: 'user',
        actorId: userId,
        action: AuditAction.MFA_RECOVERY_USED,
        targetType: 'user',
        targetId: userId,
        result: 'success',
        metadata: { left: check.recoveryLeft ?? 0 },
        ...audit,
      });
    }
    const deviceToken = t.buckets
      ? await this.throttle.onSuccess(
          JSON.parse(t.buckets),
          userId,
          t.trustDevice === '1',
          t.deviceHash,
        )
      : undefined;
    return {
      kind: 'signed_in',
      sessionId: established.id,
      returnTo: t.returnTo,
      ...(deviceToken ? { deviceToken } : {}),
    };
  }
}
