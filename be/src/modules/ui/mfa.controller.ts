import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsOptional, IsString, Length } from 'class-validator';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import type { AppConfig } from '../../config/configuration';
import { RedisService } from '../../database/redis/redis.service';
import { AuthenticationService } from '../authentication/authentication.service';
import { LoginThrottleService } from '../authentication/login-throttle.service';
import { UserService } from '../identity/user.service';
import { MAILER, type Mailer } from '../mailer/mailer';
import {
  mfaDisabledMessage,
  mfaEnabledMessage,
  mfaRecoveryRegeneratedMessage,
} from '../mailer/templates';
import { base32Encode, newTotpSecret } from '../mfa/base32';
import { enrollAad, MFA_KEYRING, MfaKeyring, type SealedSecret } from '../mfa/mfa-crypto';
import { MfaLoginService } from '../mfa/mfa-login.service';
import { MfaService } from '../mfa/mfa.service';
import { generateRecoveryCodes } from '../mfa/recovery-codes';
import { verifyTotp } from '../mfa/totp';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { SessionCookie } from '../sessions/session.cookie';
import type { Session } from '../sessions/session.service';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { safeReturnTo } from './return-to';
import { ACCOUNT_REAUTH_WINDOW_MS, UiSessionHelper } from './ui-session.helper';

class CodeDto {
  @IsOptional() @IsString() _csrf?: string;
  @IsOptional() @IsString() @Length(0, 64) code?: string;
}
class MfaFormDto extends CodeDto {
  @IsOptional() @IsString() @Length(0, 128) current_password?: string;
  @IsOptional() @IsString() @Length(0, 2048) returnTo?: string;
}

/** Pending enrollment secret (D89.13): Redis `mfa_enr:{sessionRef}`, sealed, 600 s. */
const ENROLL_TTL_MS = 600_000;
const enrollKey = (sessionRef: string): string => `mfa_enr:${sessionRef}`;
const WRONG_CODE = 'That code is not valid. Try again.';
/**
 * D89.25/D89.28 (DEBT-646): after too many wrong codes in a row only a recovery code (or an MFA
 * reset by an administrator) lifts the block; a password reset does not.
 */
const SUSPENDED_CODE =
  'Authenticator codes are blocked for this account after too many wrong codes. Use a recovery code. If you have none left, contact your administrator.';
const LOGIN_MFA_TITLE = 'Two-step verification';
const ISSUER_LABEL = 'Veyrigate';

/**
 * Second factor HTML routes (run 89, D89.2/D89.13): step 2 of sign-in (`/login/mfa`, identity of
 * the CSRF token = the ticket cookie) and self-service `/account/mfa` (enroll, turn off, new
 * recovery codes). Secrets, `otpauth://` and recovery codes appear only on the owner's no-store
 * pages; never in a URL, log, audit or mail.
 */
@Controller()
@UseFilters(HtmlExceptionFilter)
export class MfaController {
  private readonly logger = new Logger(MfaController.name);
  private readonly issuer: string;

  constructor(
    private readonly ui: UiSessionHelper,
    private readonly csrf: CsrfService,
    private readonly sessionCookie: SessionCookie,
    private readonly mfaLogin: MfaLoginService,
    private readonly mfa: MfaService,
    @Inject(MFA_KEYRING) private readonly keyring: MfaKeyring,
    private readonly auth: AuthenticationService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly users: UserService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    @Inject(MAILER) private readonly mailer: Mailer,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  // ------------------------------------------------------------------ step 2 of sign-in

  @Get('/login/mfa')
  async loginMfaPage(@Req() req: HttpRequest, @Res() reply: HttpReply) {
    const ticket = this.mfaLogin.readTicket(req);
    if (!(await this.mfaLogin.exists(ticket))) return this.backToLogin(reply);
    return this.loginForm(reply, ticket!, HttpStatus.OK);
  }

  @Post('/login/mfa')
  async loginMfa(@Body() body: CodeDto, @Req() req: HttpRequest, @Res() reply: HttpReply) {
    await this.ui.limit('login_mfa', req);
    const ticket = this.mfaLogin.readTicket(req);
    if (!ticket) return this.backToLogin(reply);
    // CSRF identity = the ticket cookie (D89.8): a session cookie of anyone does not count.
    if (typeof body._csrf !== 'string' || !this.csrf.verify(ticket, body._csrf)) {
      throw new ForbiddenException('Invalid form submission.');
    }
    const result = await this.mfaLogin.complete(ticket, body.code ?? '', {
      oldSessionId: this.sessionCookie.read(req),
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      requestId: req.id,
    });
    switch (result.kind) {
      case 'wrong':
        return this.loginForm(
          reply,
          ticket,
          HttpStatus.BAD_REQUEST,
          result.suspended ? SUSPENDED_CODE : WRONG_CODE,
        );
      case 'throttled':
        throw new HttpException(
          { retryAfter: result.retryAfterSec, message: 'Too many attempts. Try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'expired':
        return this.backToLogin(reply);
      case 'restart':
        this.mfaLogin.clearTicketCookie(reply);
        return reply.redirect(`/login?returnTo=${encodeURIComponent(result.returnTo)}`, 302);
      case 'failed':
        this.mfaLogin.clearTicketCookie(reply);
        reply.header('Cache-Control', 'no-store');
        reply.status(HttpStatus.UNAUTHORIZED);
        return reply.view('message.eta', {
          title: 'Sign-in not completed',
          message: 'Your sign-in could not be completed. Please sign in again.',
        });
      case 'signed_in':
        this.mfaLogin.clearTicketCookie(reply);
        this.sessionCookie.set(reply, result.sessionId);
        if (result.deviceToken) this.loginThrottle.setDeviceCookie(reply, result.deviceToken);
        return reply.redirect(safeReturnTo(result.returnTo, this.issuer), 302);
    }
  }

  // ------------------------------------------------------------------ /account/mfa

  @Get('/account/mfa')
  async accountPage(
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
    @Query('returnTo') returnTo?: string,
  ) {
    const session = await this.ui.liveSession(req, reply);
    const back = this.safeBack(returnTo);
    if (!session) {
      const self = back ? `/account/mfa?returnTo=${encodeURIComponent(back)}` : '/account/mfa';
      return reply.redirect(`/login?returnTo=${encodeURIComponent(self)}`, 302);
    }
    return this.render(req, reply, session, back);
  }

  @Post('/account/mfa/start')
  @UseGuards(CsrfGuard)
  async start(@Body() body: MfaFormDto, @Req() req: HttpRequest, @Res() reply: HttpReply) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fmfa', 302);
    const back = this.safeBack(body.returnTo);
    await this.ui.limit('account_mfa', req, session.userId);
    const state = await this.mfa.state(session.userId);
    if (state.enrolled) {
      return this.render(req, reply, session, back, 'Two-step verification is already on.', 400);
    }
    const reauth = await this.firstFactor(req, session, body.current_password, 'mfa_enroll');
    if (reauth) return this.render(req, reply, session, back, reauth, 400);
    const secret = newTotpSecret();
    const sealed = this.keyring.seal(secret, enrollAad(session.userId));
    // Redis error => 5xx, nothing in Mongo.
    await this.redis.client.set(
      enrollKey(session.ref),
      JSON.stringify(sealed),
      'PX',
      ENROLL_TTL_MS,
    );
    return this.setupPage(req, reply, session, secret, back);
  }

  @Post('/account/mfa/confirm')
  @UseGuards(CsrfGuard)
  async confirm(@Body() body: MfaFormDto, @Req() req: HttpRequest, @Res() reply: HttpReply) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fmfa', 302);
    const back = this.safeBack(body.returnTo);
    await this.ui.limit('account_mfa', req, session.userId);
    const raw = await this.redis.client.get(enrollKey(session.ref));
    const secret = raw
      ? this.keyring.open(JSON.parse(raw) as SealedSecret, enrollAad(session.userId), req.id)
      : null;
    if (!secret) {
      return this.render(req, reply, session, back, 'The setup expired. Start again.', 400);
    }
    const audit = this.auditCtx(req, session);
    const reserved = await this.mfaLogin.reserveAttempt(session.userId, audit);
    if (reserved.blocked) throw this.tooMany(reserved.retryAfterSec);
    const step = verifyTotp(secret, body.code ?? '', this.mfa.clock());
    if (step === null) {
      await this.mfaLogin.recordWrongCode(session.userId, audit, 'enroll');
      return this.setupPage(req, reply, session, secret, back, WRONG_CODE, 400);
    }
    await this.mfaLogin.refundAttempt(session.userId);
    const codes = generateRecoveryCodes();
    const enrolled = await this.mfa.enroll(session.userId, secret, step, codes);
    await this.redis.client.del(enrollKey(session.ref));
    if (!enrolled.ok) {
      return this.render(req, reply, session, back, 'Two-step verification is already on.', 409);
    }
    await this.audit.record({
      actorType: 'user',
      actorId: session.userId,
      action: AuditAction.MFA_ENROLLED,
      targetType: 'user',
      targetId: session.userId,
      result: 'success',
      ...audit,
    });
    await this.revokeEverything(session, AuditAction.MFA_ENROLLED);
    this.sessionCookie.clear(reply);
    await this.notify(session.userId, mfaEnabledMessage);
    return this.codesPage(reply, codes, {
      title: 'Two-step verification is on',
      message: 'Every session was signed out. Save these recovery codes now: they are shown once.',
      continueUrl: `/login?returnTo=${encodeURIComponent(back ?? '/')}`,
    });
  }

  @Post('/account/mfa/disable')
  @UseGuards(CsrfGuard)
  async disable(@Body() body: MfaFormDto, @Req() req: HttpRequest, @Res() reply: HttpReply) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fmfa', 302);
    await this.ui.limit('account_mfa', req, session.userId);
    const proof = await this.bothFactors(req, session, body, 'mfa_disable');
    if (!proof.ok) return this.render(req, reply, session, undefined, proof.error, proof.status);
    if (!(await this.mfa.disable(session.userId, proof.enrolledAt))) {
      return this.render(req, reply, session, undefined, 'Nothing to turn off.', 409);
    }
    await this.audit.record({
      actorType: 'user',
      actorId: session.userId,
      action: AuditAction.MFA_DISABLED,
      targetType: 'user',
      targetId: session.userId,
      result: 'success',
      metadata: { factor: proof.factor },
      ...this.auditCtx(req, session),
    });
    await this.revokeEverything(session, AuditAction.MFA_DISABLED);
    this.sessionCookie.clear(reply);
    await this.notify(session.userId, mfaDisabledMessage);
    reply.header('Cache-Control', 'no-store');
    reply.status(HttpStatus.OK);
    return reply.view('message.eta', {
      title: 'Two-step verification is off',
      message: 'Every session was signed out. Sign in again with your password.',
    });
  }

  @Post('/account/mfa/recovery')
  @UseGuards(CsrfGuard)
  async regenerate(@Body() body: MfaFormDto, @Req() req: HttpRequest, @Res() reply: HttpReply) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fmfa', 302);
    await this.ui.limit('account_mfa', req, session.userId);
    const proof = await this.bothFactors(req, session, body, 'mfa_recovery');
    if (!proof.ok) return this.render(req, reply, session, undefined, proof.error, proof.status);
    const codes = generateRecoveryCodes();
    if (!(await this.mfa.regenerate(session.userId, proof.enrolledAt, codes))) {
      return this.render(req, reply, session, undefined, 'Two-step verification is off.', 409);
    }
    await this.audit.record({
      actorType: 'user',
      actorId: session.userId,
      action: AuditAction.MFA_RECOVERY_REGENERATED,
      targetType: 'user',
      targetId: session.userId,
      result: 'success',
      metadata: { factor: proof.factor },
      ...this.auditCtx(req, session),
    });
    await this.notify(session.userId, mfaRecoveryRegeneratedMessage);
    return this.codesPage(reply, codes, {
      title: 'New recovery codes',
      message: 'Every older code no longer works. Save these now: they are shown once.',
      continueUrl: '/account/mfa',
    });
  }

  // ------------------------------------------------------------------ helpers

  /**
   * D88.18 / D89.23 first factor through the shared re-authentication (DEBT-638). A refusal is
   * audited as `AUTH_REAUTH_FAILED` (DEBT-639: never under the alerting `MFA_DISABLED`).
   */
  private async firstFactor(
    req: HttpRequest,
    session: Session,
    password: string | undefined,
    scope: 'mfa_enroll' | 'mfa_disable' | 'mfa_recovery',
    alwaysPassword = false,
  ): Promise<string | null> {
    const r = await this.ui.reauth(req, session, password, {
      audit: {
        action: AuditAction.AUTH_REAUTH_FAILED,
        targetType: 'user',
        targetId: session.userId,
        tenantId: session.tenantId,
        metadata: { scope, via: 'self' },
      },
      noPasswordMessage: NO_PASSWORD_REAUTH,
      alwaysPassword,
    });
    return r.ok ? null : r.error;
  }

  /**
   * Turning the factor off / new recovery codes (D88.28, D89.23, D89.27): the password (no
   * freshness shortcut) AND a second factor: a current authenticator code, OR a recovery code (lost
   * device: the code is consumed, `MFA_RECOVERY_USED {via:'account'}`). Accounts without a
   * password: a session < 5' + the second factor. `factor` goes into the success audit.
   */
  private async bothFactors(
    req: HttpRequest,
    session: Session,
    body: MfaFormDto,
    scope: 'mfa_disable' | 'mfa_recovery',
  ): Promise<
    | { ok: false; error: string; status: number }
    | { ok: true; enrolledAt: Date; factor: 'totp' | 'recovery_code' }
  > {
    const state = await this.mfa.state(session.userId);
    if (!state.enrolled) return { ok: false, error: 'Two-step verification is off.', status: 400 };
    const first = await this.firstFactor(req, session, body.current_password, scope, true);
    if (first) return { ok: false, error: first, status: 400 };
    const code = (body.code ?? '').trim();
    if (!code) {
      return {
        ok: false,
        error: 'Enter a code from your authenticator app, or one of your recovery codes.',
        status: 400,
      };
    }
    const audit = this.auditCtx(req, session);
    const reserved = await this.mfaLogin.reserveAttempt(session.userId, audit);
    if (reserved.blocked) throw this.tooMany(reserved.retryAfterSec);
    const check = await this.mfaLogin.checkCode(session.userId, code, state.enrolledAt, req.id);
    if (!check.ok) {
      if (check.suspended) return { ok: false, error: SUSPENDED_CODE, status: 400 };
      await this.mfaLogin.recordWrongCode(session.userId, audit, 'account');
      return { ok: false, error: WRONG_CODE, status: 400 };
    }
    await this.mfaLogin.refundAttempt(session.userId);
    const totp = check.step !== undefined;
    if (!totp) {
      await this.audit.record({
        actorType: 'user',
        actorId: session.userId,
        action: AuditAction.MFA_RECOVERY_USED,
        targetType: 'user',
        targetId: session.userId,
        result: 'success',
        metadata: { left: check.recoveryLeft ?? 0, via: 'account' },
        ...audit,
      });
    }
    return { ok: true, enrolledAt: state.enrolledAt, factor: totp ? 'totp' : 'recovery_code' };
  }

  /** Enroll / turn off => every session, family and trusted device (D89.13). DEBT-050 order. */
  private async revokeEverything(session: Session, action: AuditAction): Promise<void> {
    const userId = session.userId;
    await this.auth.revokeAllUserCredentials(userId, new Date(), (failedStep) =>
      this.audit.record({
        actorType: 'user',
        actorId: userId,
        tenantId: session.tenantId,
        action,
        targetType: 'user',
        targetId: userId,
        result: 'failure',
        reason: 'revoke_failed',
        metadata: { failedStep },
      }),
    );
  }

  /** Fire-and-forget notice (D89.18): a failure is only logged. */
  private async notify(
    userId: string,
    build: (to: string, at: string, url: string) => Parameters<Mailer['send']>[0],
  ): Promise<void> {
    const user = await this.users.findById(userId).catch(() => null);
    if (!user) return;
    void this.mailer
      .send(build(user.email, new Date().toISOString(), new URL('/account/mfa', this.issuer).href))
      .catch(() => this.logger.error('MFA notice delivery failed'));
  }

  private async render(
    req: HttpRequest,
    reply: HttpReply,
    session: Session,
    back: string | undefined,
    error?: string,
    status: number = HttpStatus.OK,
  ) {
    const [state, hasPassword] = await Promise.all([
      this.mfa.state(session.userId),
      this.auth.hasPassword(session.userId),
    ]);
    const fresh = session.authTime >= Date.now() - ACCOUNT_REAUTH_WINDOW_MS;
    reply.header('Cache-Control', 'no-store');
    reply.status(status);
    return reply.view('account-mfa.eta', {
      title: 'Two-step verification',
      enrolled: state.enrolled,
      enrolledAt: state.enrolled ? state.enrolledAt.toISOString() : undefined,
      recoveryLeft: state.enrolled ? state.recoveryLeft : undefined,
      hasPassword,
      fresh,
      noPasswordMessage: NO_PASSWORD_REAUTH,
      returnTo: back,
      error,
      csrf: this.csrf.token(this.ui.identity(req, reply)),
    });
  }

  private async setupPage(
    req: HttpRequest,
    reply: HttpReply,
    session: Session,
    secret: Buffer,
    back: string | undefined,
    error?: string,
    status: number = HttpStatus.OK,
  ) {
    const user = await this.users.findById(session.userId);
    const key = base32Encode(secret);
    const label = encodeURIComponent(`${ISSUER_LABEL}:${user?.email ?? ''}`);
    reply.header('Cache-Control', 'no-store');
    reply.status(status);
    return reply.view('account-mfa.eta', {
      title: 'Set up two-step verification',
      setup: true,
      key: key.match(/.{1,4}/g)!.join(' '),
      otpauth: `otpauth://totp/${label}?secret=${key}&issuer=${ISSUER_LABEL}&algorithm=SHA1&digits=6&period=30`,
      returnTo: back,
      error,
      csrf: this.csrf.token(this.ui.identity(req, reply)),
    });
  }

  private codesPage(
    reply: HttpReply,
    codes: string[],
    data: { title: string; message: string; continueUrl: string },
  ) {
    reply.header('Cache-Control', 'no-store');
    reply.status(HttpStatus.OK);
    return reply.view('account-mfa-codes.eta', { ...data, codes });
  }

  /**
   * The step-2 form. DEBT-647 (D89.30): its POST ends in `302 /authorize?request_id` then `302` to
   * the RP, so it gets the same per-response `form-action` as `GET /login` (the RP origin of the
   * ticket's live context, else `'self'`), on the first render and on every 400 re-render.
   */
  private async loginForm(reply: HttpReply, ticket: string, status: number, error?: string) {
    const returnTo = await this.mfaLogin.returnToOf(ticket);
    await this.ui.setLoginFormActionCsp(reply, safeReturnTo(returnTo ?? '/', this.issuer));
    reply.status(status);
    return reply.view('login-mfa.eta', {
      title: LOGIN_MFA_TITLE,
      error,
      csrf: this.csrf.token(ticket),
    });
  }

  private backToLogin(reply: HttpReply) {
    this.mfaLogin.clearTicketCookie(reply);
    return reply.redirect('/login', 302);
  }

  /** A `returnTo` that is a safe local path other than `/`, or undefined (strange values dropped). */
  private safeBack(value: unknown): string | undefined {
    const safe = safeReturnTo(value, this.issuer);
    return safe === '/' ? undefined : safe;
  }

  /** Request context + the tenant of the session (D89.29: visible to that tenant's admin). */
  private auditCtx(req: HttpRequest, session: Session) {
    return {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      requestId: req.id,
      tenantId: session.tenantId,
    };
  }

  private tooMany(retryAfterSec: number): HttpException {
    return new HttpException(
      { retryAfter: retryAfterSec, message: 'Too many attempts. Try again later.' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

const NO_PASSWORD_REAUTH =
  'To change two-step verification, sign out and sign in again, then come back within 5 minutes.';
