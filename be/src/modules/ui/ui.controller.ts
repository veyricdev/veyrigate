import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { sha256 } from '../../common/crypto/crypto.util';
import { buildCsp, safeCspOrigin } from '../../common/http/csp';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import { IsDeliverableEmail } from '../../common/validation/email-address';
import type { AppConfig } from '../../config/configuration';
import {
  AuthenticationService,
  RESET_TICKET_TTL_SEC,
} from '../authentication/authentication.service';
import { LoginThrottleService } from '../authentication/login-throttle.service';
import { MfaLoginService } from '../mfa/mfa-login.service';
import { normalizeEmail } from '../identity/user.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { hostCookieName, SessionCookie } from '../sessions/session.cookie';
import { deviceLabelFromUserAgent } from '../sessions/device-label';
import { SessionService } from '../sessions/session.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import {
  LogoutService,
  type LogoutParams,
  stringLogoutParams,
} from '../oauth/logout/logout.service';
import { AuthorizeRequestContextService } from '../oauth/authorize/authorize-request-context.service';
import {
  enabledProviderNames,
  FEDERATION_PROVIDERS,
  type FederationProviders,
} from '../federation/providers';
import { CsrfGuard, CsrfService, LogoutCsrfGuard } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { requestIdFromReturnTo, safeReturnTo } from './return-to';
import { revokeOneSession } from './session-revoke';
import { UiSessionHelper } from './ui-session.helper';

class FormDto {
  @IsOptional() @IsString() _csrf?: string;
}
class LoginDto extends FormDto {
  @IsEmail() email!: string;
  @IsString() @Length(8, 128) password!: string;
  @IsOptional() @IsString() returnTo?: string;
}
// Run 84 D84.1: every address that may get a mail or a new account also passes the narrow grammar
// (next to `@IsEmail()`, never instead). Login keeps the old rule so legacy accounts still sign in.
class RegisterDto extends FormDto {
  @IsEmail() @IsDeliverableEmail() email!: string;
  @IsString() @Length(8, 128) password!: string;
  @IsOptional() @IsString() returnTo?: string;
}
class EmailDto extends FormDto {
  @IsEmail() @IsDeliverableEmail() email!: string;
}
class TokenDto extends FormDto {
  // A code pasted by hand may carry spaces (DEBT-577, D86.1). No `@Matches`: a wrong code takes the
  // existing invalid-link path, no extra oracle.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  token!: string;
}
/** DEBT-671 (D91.14): verifying the email also proves the account password. */
class VerifyDto extends TokenDto {
  @IsString() @Length(1, 128) password!: string;
}
/** Run 94 (D94.3): the reset token is gone from this body; the ticket rides in its cookie. */
class ResetDto extends FormDto {
  @IsString() @Length(8, 128) password!: string;
}
class ChangePasswordDto extends FormDto {
  @IsString() @Length(1, 128) current_password!: string;
  @IsString() @Length(8, 128) new_password!: string;
}
/** Raw RP-initiated logout fields carried by the confirmation form. All re-validated on POST. */
class LogoutDto extends FormDto {
  @IsOptional() @IsString() @Length(0, 4096) id_token_hint?: string;
  @IsOptional() @IsString() @Length(0, 2048) post_logout_redirect_uri?: string;
  // Generous cap (4096): an over-long `state` must NOT 400 the logout (the user still needs to sign
  // out). `LogoutService.appendState` drops a `state` longer than its own cap (fold #8). The
  // @Length(0, 4096) only keeps the request body sane (pino truncates query, not body).
  @IsOptional() @IsString() @Length(0, 4096) state?: string;
  @IsOptional() @IsString() @Length(0, 256) client_id?: string;
  // RP-Initiated Logout 1.0 §2 parameters an RP may POST (DEBT-572, D86.7): accepted so the request
  // does not 400, then ignored (never reflected, never logged).
  @IsOptional() @IsString() @Length(0, 4096) logout_hint?: string;
  @IsOptional() @IsString() @Length(0, 256) ui_locales?: string;
}

/** GET `/logout` query as received: each value may be a string or an array (repeated param). */
interface LogoutQuery {
  id_token_hint?: string;
  post_logout_redirect_uri?: string;
  state?: string;
  client_id?: string;
}

type UiRequest = HttpRequest;
type UiReply = HttpReply;

/** Reset ticket cookie (DEBT-661, D94.5): `__Host-idp_reset` when Secure. */
const RESET_TICKET_COOKIE = 'idp_reset';
const RESET_INVALID = 'This link is invalid or expired.';
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

@Controller()
@UseFilters(HtmlExceptionFilter)
export class UiController {
  private readonly issuer: string;
  private readonly logger = new Logger(UiController.name);
  constructor(
    private readonly auth: AuthenticationService,
    private readonly csrf: CsrfService,
    private readonly sessions: SessionService,
    private readonly sessionCookie: SessionCookie,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly logoutRp: LogoutService,
    private readonly authzContexts: AuthorizeRequestContextService,
    config: ConfigService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly ui: UiSessionHelper,
    private readonly mfaLogin: MfaLoginService,
    // Optional: absent (tests composing UiController without FederationModule) => no buttons.
    @Optional() @Inject(FEDERATION_PROVIDERS) private readonly federation?: FederationProviders,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
  }

  @Get('/') async home(@Req() req: UiRequest, @Res() reply: UiReply) {
    if (!(await this.hasLiveSession(req, reply))) return reply.redirect('/login', 302);
    return reply.view('message.eta', {
      title: 'Signed in',
      message: 'You are signed in.',
      secondaryUrl: '/account/password',
      secondaryLabel: 'Change password',
      links: [
        { url: '/account/sessions', label: 'Your sessions' },
        { url: '/account/apps', label: 'Connected apps' },
        { url: '/account/mfa', label: 'Two-step verification' },
      ],
      actionUrl: '/logout',
      actionLabel: 'Sign out',
    });
  }
  @Get('/login') async login(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('returnTo') returnTo?: string,
  ) {
    const safeReturn = safeReturnTo(returnTo, this.issuer);
    // B6.2: a live session normally skips the form, EXCEPT when the resumable `/authorize` context
    // demands re-authentication (`prompt=login` / `max_age`) - then the user must sign in again.
    if ((await this.hasLiveSession(req, reply)) && !(await this.reauthRequested(safeReturn))) {
      return reply.redirect('/', 302);
    }
    // DEBT-084: the login form POSTs here, then 303s to `/authorize?request_id`, then 302s to the RP.
    // Chromium enforces the `form-action` of THIS page across that chain, so relax it to the single
    // RP origin already exact-matched in the resumable context (never the raw query). Fail-closed to
    // `'self'` on any doubt. The page carries a CSRF token + credentials field: never cache it.
    await this.ui.setLoginFormActionCsp(reply, safeReturn);
    return this.form(req, reply, 'login.eta', {
      title: 'Sign in',
      returnTo: safeReturn,
      social: await this.socialLogins(safeReturn),
    });
  }

  /**
   * Social login buttons (B5.2, F11): only enabled providers, and only for a live resumable login
   * context (`/authorize?request_id=<id>` exactly) — no context, no button (no RP-less social flow).
   * GitHub is hidden when the context demands re-authentication (F8). The link carries only the
   * opaque `request_id` (escaped by Eta). A Redis failure shows no button (fail-closed).
   */
  private async socialLogins(safeReturn: string): Promise<{ label: string; href: string }[]> {
    const names = this.federation ? enabledProviderNames(this.federation) : [];
    const requestId = requestIdFromReturnTo(safeReturn);
    if (names.length === 0 || !requestId) return [];
    let ctx;
    try {
      ctx = await this.authzContexts.peek(requestId);
    } catch {
      this.logger.warn('login: context peek failed; hiding social login');
      return [];
    }
    if (!ctx || ctx.kind !== 'login') return [];
    return names
      .filter((name) => !(name === 'github' && ctx.reauthAfter !== undefined))
      .map((name) => ({
        label: name === 'google' ? 'Sign in with Google' : 'Sign in with GitHub',
        href: `/auth/${name}/start?request_id=${encodeURIComponent(requestId)}`,
      }));
  }

  /**
   * Whether `safeReturn` is exactly `/authorize?request_id=<id>` of a live context that demands
   * re-authentication (`reauthAfter`, B6.2). A Redis failure keeps the old behaviour (false) and is
   * logged without the request_id.
   */
  private async reauthRequested(safeReturn: string): Promise<boolean> {
    const requestId = requestIdFromReturnTo(safeReturn);
    if (!requestId) return false;
    try {
      return (await this.authzContexts.peek(requestId))?.reauthAfter !== undefined;
    } catch {
      this.logger.warn('login: context peek failed; treating as no re-authentication demand');
      return false;
    }
  }

  @Get('/register') async register(@Req() req: UiRequest, @Res() reply: UiReply) {
    if (await this.hasLiveSession(req, reply)) return reply.redirect('/', 302);
    return this.form(req, reply, 'register.eta', { title: 'Create account' });
  }
  @Get('/forgot') forgot(@Req() req: UiRequest, @Res() reply: UiReply) {
    return this.form(req, reply, 'forgot.eta', { title: 'Reset password' });
  }
  // DEBT-577 (D86.3): the token rides in the link's fragment; GET never reads, renders or redirects
  // a `?token=` (a query token already sits in proxy logs). `token-fragment.js` fills the field.
  @Get('/verify-email') verifyForm(@Req() req: UiRequest, @Res() reply: UiReply) {
    return this.form(req, reply, 'verify.eta', { title: 'Verify email' });
  }
  // DEBT-661 (D94.3): a live ticket cookie => the password form (no token field); otherwise the
  // code form posting to `/reset/code`, and a dead ticket cookie is cleared.
  @Get('/reset') async resetForm(@Req() req: UiRequest, @Res() reply: UiReply) {
    const ticket = this.readResetTicket(req);
    const live = ticket !== undefined && (await this.auth.isLiveResetTicket(ticket));
    if (!live && req.cookies?.[this.resetCookie] !== undefined) this.clearResetTicket(reply);
    return this.form(req, reply, live ? 'reset.eta' : 'reset-code.eta', {
      title: 'Choose a new password',
    });
  }
  @Get('/logout') async logoutForm(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    // Raw query (interface type => no ValidationPipe coercion): a repeated param stays an array so
    // `stringLogoutParams` drops it, instead of `String(['a','b'])` = 'a,b' (CodeQL #9, run 92).
    @Query() query: LogoutQuery,
  ) {
    // GET NEVER destroys state (spec §9.8, anti-CSRF): render the confirmation form only.
    return this.renderLogoutConfirm(req, reply, {
      idTokenHint: query.id_token_hint,
      postLogoutRedirectUri: query.post_logout_redirect_uri,
      state: query.state,
      clientId: query.client_id,
    });
  }

  /**
   * The logout confirmation (GET `/logout`, and POST `/logout` without a `_csrf` key, DEBT-572
   * D86.4). The raw RP-initiated params ride along as hidden fields; the POST re-validates them
   * (never trusted). No session read, no revoke, no audit. The page carries a JWT hint (user PII)
   * and a CSRF token, so it must never be cached.
   */
  private async renderLogoutConfirm(req: UiRequest, reply: UiReply, params: LogoutParams) {
    // A repeated query param (array) is treated as absent, never reflected (CodeQL #9).
    const { idTokenHint, postLogoutRedirectUri, state, clientId } = stringLogoutParams(params);
    reply.header('Cache-Control', 'no-store');

    // Do NOT reflect a `post_logout_redirect_uri` that would not survive validation into the form
    // (exposure budget: no unvalidated URI in a response). Resolve it with no session user (the
    // same decision the no-session POST path makes); only reflect the raw URI when it validates.
    const resolved = await this.logoutRp.resolvePostLogoutRedirect(
      { idTokenHint, postLogoutRedirectUri, state, clientId },
      undefined,
    );
    const reflectUri =
      resolved === this.logoutRp.defaultRedirect ? undefined : postLogoutRedirectUri;

    // DEBT-084: the logout form POSTs here, then 303s to `post_logout_redirect_uri`. Relax
    // `form-action` to that single already-validated origin, but ONLY when `resolved` is a real RP
    // target (`!== defaultRedirect`) and yields a clean origin; otherwise keep `'self'` (INV-084-1/2).
    const logoutOrigin =
      resolved === this.logoutRp.defaultRedirect ? null : safeCspOrigin(resolved);
    reply.header(
      'Content-Security-Policy',
      buildCsp({ formAction: logoutOrigin ? [logoutOrigin] : [] }),
    );

    return this.form(req, reply, 'logout.eta', {
      title: 'Sign out',
      idTokenHint,
      postLogoutRedirectUri: reflectUri,
      state,
      clientId,
    });
  }

  @Post('/register')
  @UseGuards(CsrfGuard)
  async registerPost(@Body() body: RegisterDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.ui.limit('register', req, body.email);
    await this.auth.register(normalizeEmail(body.email), body.password);
    return reply.view('message.eta', {
      title: 'Check your email',
      message: 'If the address can be registered, a verification email has been sent.',
    });
  }
  @Post('/login')
  @UseGuards(CsrfGuard)
  async loginPost(@Body() body: LoginDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    // DEBT-575: no `account` dimension here — the per-email limit lives in the login throttle,
    // where a trusted device is exempt (a shared per-account counter would be a lockout vector).
    await this.ui.limit('login', req);
    const result = await this.auth.login(normalizeEmail(body.email), body.password, {
      oldSessionId: this.sessionCookie.read(req),
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      requestId: req.id,
      deviceLabel: deviceLabelFromUserAgent(req.headers['user-agent']),
      deviceToken: this.loginThrottle.readDeviceToken(req),
      trustDevice: true,
    });
    if (result.kind === 'mfa') {
      // Run 89 (D89.7/D89.8): password right, second factor pending => ticket cookie, no session.
      const ticketId = await this.mfaLogin.start(
        result.pending,
        safeReturnTo(body.returnTo, this.issuer),
      );
      this.mfaLogin.setTicketCookie(reply, ticketId);
      return reply.redirect('/login/mfa', 303);
    }
    this.sessionCookie.set(reply, result.id);
    if (result.deviceToken) this.loginThrottle.setDeviceCookie(reply, result.deviceToken);
    return reply.redirect(safeReturnTo(body.returnTo, this.issuer), 303);
  }
  @Post('/forgot')
  @UseGuards(CsrfGuard)
  async forgotPost(@Body() body: EmailDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.ui.limit('forgot', req, body.email);
    await this.auth.forgotPassword(normalizeEmail(body.email));
    return reply.view('message.eta', {
      title: 'Check your email',
      message: 'If the account exists, a reset email has been sent.',
    });
  }
  @Post('/verify-email')
  @UseGuards(CsrfGuard)
  async verifyPost(@Body() body: VerifyDto, @Res() reply: UiReply) {
    await this.auth.verifyEmail(body.token, body.password);
    return reply.view('message.eta', {
      title: 'Email verified',
      message: 'Your email has been verified.',
    });
  }
  /**
   * DEBT-661 (D94.3): `Continue` on the code form. The token is exchanged for a 15' ticket cookie
   * and dies, so the link left in the browser history is useless afterwards. Every refused token
   * (unknown, expired, used, already exchanged, malformed) gets the same 400 and no cookie.
   */
  @Post('/reset/code')
  @UseGuards(CsrfGuard)
  async resetCodePost(@Body() body: TokenDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.ui.limit('reset', req, body.token);
    const ticket = await this.auth.claimResetTicket(body.token);
    if (!ticket) throw new BadRequestException(RESET_INVALID);
    reply.setCookie(this.resetCookie, ticket, {
      httpOnly: true,
      secure: this.sessionCookie.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: RESET_TICKET_TTL_SEC,
    });
    return reply.redirect('/reset', 303);
  }
  @Post('/reset')
  @UseGuards(CsrfGuard)
  async resetPost(@Body() body: ResetDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    const ticket = this.readResetTicket(req);
    // No ticket => IP/device dimensions only (no shared account bucket for every ticketless post).
    await this.ui.limit('reset', req, ticket && sha256(ticket));
    // A refused password throws and keeps the ticket (DEBT-574); a dead ticket loses its cookie.
    if (!ticket || !(await this.auth.resetPassword(ticket, body.password))) {
      this.clearResetTicket(reply);
      throw new BadRequestException(RESET_INVALID);
    }
    this.clearResetTicket(reply);
    return reply.view('message.eta', {
      title: 'Password changed',
      message: 'Your password has been changed.',
    });
  }
  /** DEBT-573 (D85.6): change password form; a live session is required. */
  @Get('/account/password') async passwordForm(@Req() req: UiRequest, @Res() reply: UiReply) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fpassword', 302);
    if (!(await this.auth.hasPassword(session.userId))) {
      reply.header('Cache-Control', 'no-store');
      return reply.view('message.eta', {
        title: 'Change password',
        message: 'This account has no password. Use "Forgot password" to set one.',
        actionUrl: '/forgot',
        actionLabel: 'Forgot password',
      });
    }
    return this.form(req, reply, 'password-change.eta', { title: 'Change password' });
  }
  @Post('/account/password')
  @UseGuards(CsrfGuard)
  async passwordChange(
    @Body() body: ChangePasswordDto,
    @Req() req: UiRequest,
    @Res() reply: UiReply,
  ) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login', 303);
    await this.ui.limit('password_change', req, session.userId);
    const outcome = await this.auth.changePassword(
      session.userId,
      body.current_password,
      body.new_password,
      { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''), requestId: req.id },
    );
    reply.header('Cache-Control', 'no-store');
    switch (outcome.kind) {
      case 'throttled':
        throw new HttpException(
          { retryAfter: outcome.retryAfterSec, message: 'Too many attempts. Try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'no_password':
        reply.status(HttpStatus.BAD_REQUEST);
        return reply.view('message.eta', {
          title: 'Change password',
          message: 'This account has no password. Use "Forgot password" to set one.',
          actionUrl: '/forgot',
          actionLabel: 'Forgot password',
        });
      case 'invalid_current':
      case 'policy':
        reply.status(HttpStatus.BAD_REQUEST);
        return this.form(req, reply, 'password-change.eta', {
          title: 'Change password',
          error: outcome.kind === 'policy' ? outcome.message : 'The current password is incorrect.',
        });
      case 'conflict':
        reply.status(HttpStatus.CONFLICT);
        return reply.view('message.eta', {
          title: 'Password not changed',
          message: 'Your password could not be changed. Sign in again and retry.',
        });
      case 'changed':
        // Every session (this one too) is already revoked: drop the dead cookie.
        this.sessionCookie.clear(reply);
        reply.status(HttpStatus.OK);
        return reply.view('message.eta', {
          title: 'Password changed',
          message: 'Your password has been changed. Sign in again with your new password.',
        });
    }
  }
  @Post('/logout')
  @UseGuards(LogoutCsrfGuard)
  async logout(
    // Typed `LogoutDto` (not a union: that would emit `Object` metadata and skip validation); a
    // POST with no body reaches the handler as `undefined`.
    @Body() body: LogoutDto,
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('scope') scope?: string,
  ) {
    // No `_csrf` key (an RP POSTing its logout request, DEBT-572 D86.4): the same confirmation as
    // GET, no session work. `LogoutCsrfGuard` already verified any `_csrf` that IS present.
    if (body?._csrf === undefined) {
      reply.status(HttpStatus.OK); // same page and status as GET, not Nest's POST 201
      return this.renderLogoutConfirm(req, reply, this.logoutParams(body ?? {}));
    }
    const id = this.sessionCookie.read(req);
    const global = scope === 'all';
    const session = id ? await this.sessions.get(id) : null;

    // No live session: nothing to revoke. Still clear the cookie and redirect (idempotent). The
    // redirect is resolved from the raw params with no session user (hint sub check is skipped).
    if (!session) {
      this.sessionCookie.clear(reply);
      // Fail-open, same as the post-revoke branch below: the cookie is already cleared so there is
      // nothing left to protect, and a transient fault resolving the redirect (e.g. a Mongo read in
      // `findByClientId`, or legacy/hand-edited post-logout URI data) must not surface as a 5xx that
      // implies logout failed. No hint/token is logged.
      try {
        const target = await this.logoutRp.resolvePostLogoutRedirect(
          this.logoutParams(body),
          undefined,
        );
        return reply.redirect(target, 303);
      } catch {
        return reply.redirect(this.logoutRp.defaultRedirect, 303);
      }
    }

    // Collect front-channel RP candidates BEFORE revoking (the sets are deleted by revoke).
    const rpCandidates = global
      ? await this.sessions.clientsForUser(session.userId)
      : await this.sessions.clientsForSession(session.ref);

    const now = new Date();
    // Order (tech-lead fold): revoke token -> revoke session -> audit -> clear cookie -> redirect.
    // A fault at any step throws (5xx via HtmlExceptionFilter) and never presents success; every
    // revoke is idempotent so a retry is safe.
    let tokenCount: number;
    let sessionCount = 1;
    if (global) {
      // DEBT-150: the shared revoke (family -> sessions MARK -> SWEEP, all inside the service) runs
      // every step even if one fails, then rethrows the first error (5xx, no success audit/cookie clear).
      // DEBT-521: a partial failure is audited (failedStep only — no error text/token); the
      // service swallows an audit fault and rethrows the original error.
      ({ tokenCount, sessionCount } = await this.auth.revokeAllUserCredentials(
        session.userId,
        now,
        (failedStep) =>
          this.audit.record({
            actorType: 'user',
            actorId: session.userId,
            action: AuditAction.SESSION_REVOKED,
            targetType: 'session',
            targetId: session.ref,
            result: 'failure',
            reason: 'revoke_failed',
            metadata: { scope: 'all', failedStep },
          }),
      ));
    } else {
      // DEBT-526: stop at the first fault (a token fault leaves the session alive, so a retry redoes
      // every step) and audit it with failedStep only; an audit fault never masks the original error.
      // Same sequence as `/account/sessions` (one helper, run 88 D88.19).
      tokenCount = await revokeOneSession(
        this.refreshTokens,
        session,
        now,
        () => this.sessions.revoke(id!),
        (failedStep) =>
          this.audit.record({
            actorType: 'user',
            actorId: session.userId,
            action: AuditAction.SESSION_REVOKED,
            targetType: 'session',
            targetId: session.ref,
            result: 'failure',
            reason: 'revoke_failed',
            metadata: { scope: 'session', failedStep },
          }),
      );
    }

    await this.audit.record({
      actorType: 'user',
      actorId: session.userId,
      action: AuditAction.SESSION_REVOKED,
      targetType: 'session',
      targetId: session.ref,
      result: 'success',
      metadata: global ? { scope: 'all', count: sessionCount } : { scope: 'session' },
    });
    if (tokenCount > 0) {
      await this.audit.record({
        actorType: 'user',
        actorId: session.userId,
        action: AuditAction.TOKEN_REVOKED,
        result: 'success',
        metadata: { scope: global ? 'all' : 'session', count: tokenCount },
      });
    }

    this.sessionCookie.clear(reply);

    // Everything below runs AFTER the destructive state change (token + session revoked). The user
    // IS logged out, so a fault here must NOT turn into a 5xx that implies logout failed: fall back
    // to the default redirect with no front-channel iframes (fail-open, Task 4 invariant). The
    // revoke/audit/clear steps above still fail CLOSED (they throw before we reach here).
    try {
      // Re-validate the redirect from the RAW params against this session user (never the hidden
      // field as "already validated"); non-match / bad hint -> default (/login?loggedOut=1).
      const target = await this.logoutRp.resolvePostLogoutRedirect(
        this.logoutParams(body),
        session.userId,
      );

      // Front-channel: notify every RP that received a code in the logged-out session(s). If none,
      // redirect straight away (no intermediate page).
      const iframes = await this.logoutRp.frontchannelIframes(rpCandidates);
      if (iframes.length > 0) {
        return this.renderFrontchannel(reply, iframes, target);
      }
      return reply.redirect(target, 303);
    } catch {
      // Legacy/hand-edited client data (bad redirect URI, un-parseable front-channel URI) or a
      // transient Mongo read must not block an already-completed logout. No hint/token is logged.
      return reply.redirect(this.logoutRp.defaultRedirect, 303);
    }
  }

  /** Map the form body to the raw RP-initiated params the LogoutService validates. */
  private logoutParams(body: LogoutDto): LogoutParams {
    return {
      idTokenHint: body.id_token_hint,
      postLogoutRedirectUri: body.post_logout_redirect_uri,
      state: body.state,
      clientId: body.client_id,
    };
  }

  /**
   * Render the front-channel intermediate page (B4.7): one hidden iframe per RP, then auto-redirect
   * to `target` via a static script. Only THIS response relaxes CSP `frame-src` to the registered
   * iframe origins (allowlist); `default-src`/`script-src` stay `'self'`, `frame-ancestors 'none'`.
   * `Cache-Control: no-store` so the intermediate page is never cached.
   */
  private renderFrontchannel(reply: UiReply, iframes: string[], target: string): unknown {
    // Keep the SAME hardening directives helmet applies globally and ONLY relax `frame-src` to the
    // registered RP origins (one source of truth via `buildCsp`; DEBT-084). This page keeps
    // `form-action 'self'` (it redirects via a static script, not a form).
    reply.header(
      'Content-Security-Policy',
      buildCsp({ frameSrc: this.logoutRp.frameSrcOrigins(iframes) }),
    );
    reply.header('Cache-Control', 'no-store');
    reply.status(200);
    return reply.view('logout-frontchannel.eta', {
      title: 'Signing out',
      iframes,
      target,
    });
  }

  private get resetCookie(): string {
    return hostCookieName(RESET_TICKET_COOKIE, this.sessionCookie.secure);
  }
  private readResetTicket(req: UiRequest): string | undefined {
    const v = req.cookies?.[this.resetCookie];
    return v && TICKET_SHAPE.test(v) ? v : undefined;
  }
  private clearResetTicket(reply: UiReply): void {
    reply.clearCookie(this.resetCookie, {
      httpOnly: true,
      secure: this.sessionCookie.secure,
      sameSite: 'lax',
      path: '/',
    });
  }
  private form(req: UiRequest, reply: UiReply, template: string, data: Record<string, unknown>) {
    // Every form page carries a CSRF token (and often a one-time token): never cache it (B7.4).
    reply.header('Cache-Control', 'no-store');
    const identity = this.ui.identity(req, reply);
    return reply.view(template, { ...data, csrf: this.csrf.token(identity) });
  }
  private async hasLiveSession(req: UiRequest, reply: UiReply): Promise<boolean> {
    return (await this.ui.liveSession(req, reply)) !== null;
  }
}
