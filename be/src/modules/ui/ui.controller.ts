import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { generateToken } from '../../common/crypto/crypto.util';
import { buildCsp, safeCspOrigin } from '../../common/http/csp';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import type { AppConfig, SessionConfig } from '../../config/configuration';
import { AuthenticationService } from '../authentication/authentication.service';
import { normalizeEmail } from '../identity/user.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { SESSION_COOKIE, SessionCookie } from '../sessions/session.cookie';
import { SessionService } from '../sessions/session.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import { LogoutService, type LogoutParams } from '../oauth/logout/logout.service';
import { AuthorizeRequestContextService } from '../oauth/authorize/authorize-request-context.service';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { requestIdFromReturnTo, safeReturnTo } from './return-to';

class FormDto {
  @IsOptional() @IsString() _csrf?: string;
}
class LoginDto extends FormDto {
  @IsEmail() email!: string;
  @IsString() @Length(8, 128) password!: string;
  @IsOptional() @IsString() returnTo?: string;
}
class RegisterDto extends LoginDto {}
class EmailDto extends FormDto {
  @IsEmail() email!: string;
}
class TokenDto extends FormDto {
  @IsString() token!: string;
}
class ResetDto extends TokenDto {
  @IsString() @Length(8, 128) password!: string;
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
}

type UiRequest = HttpRequest;
type UiReply = HttpReply;

const ANON_COOKIE = 'idp_csrf';

@Controller()
@UseFilters(HtmlExceptionFilter)
export class UiController {
  private readonly issuer: string;
  private readonly secure: boolean;
  private readonly logger = new Logger(UiController.name);
  constructor(
    private readonly auth: AuthenticationService,
    private readonly csrf: CsrfService,
    private readonly sessions: SessionService,
    private readonly sessionCookie: SessionCookie,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly logoutRp: LogoutService,
    private readonly authzContexts: AuthorizeRequestContextService,
    config: ConfigService,
  ) {
    this.issuer = config.getOrThrow<AppConfig>('app').issuer;
    this.secure = config.getOrThrow<SessionConfig>('session').cookieSecure;
  }

  @Get('/') async home(@Req() req: UiRequest, @Res() reply: UiReply) {
    if (!(await this.hasLiveSession(req, reply))) return reply.redirect('/login', 302);
    return reply.view('message.eta', {
      title: 'Signed in',
      message: 'You are signed in.',
      actionUrl: '/logout',
      actionLabel: 'Sign out',
    });
  }
  @Get('/login') async login(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('returnTo') returnTo?: string,
  ) {
    if (await this.hasLiveSession(req, reply)) return reply.redirect('/', 302);
    const safeReturn = safeReturnTo(returnTo, this.issuer);
    // DEBT-084: the login form POSTs here, then 302s to `/authorize?request_id`, then 302s to the RP.
    // Chromium enforces the `form-action` of THIS page across that chain, so relax it to the single
    // RP origin already exact-matched in the resumable context (never the raw query). Fail-closed to
    // `'self'` on any doubt. The page carries a CSRF token + credentials field: never cache it.
    await this.setLoginFormActionCsp(reply, safeReturn);
    return this.form(req, reply, 'login.eta', {
      title: 'Sign in',
      returnTo: safeReturn,
    });
  }

  /**
   * Set the per-response CSP for `GET /login` (DEBT-084). Only when `safeReturn` is EXACTLY
   * `/authorize?request_id=<id>` (single query key) and the still-live context's already-validated
   * `redirectUri` yields a clean origin is that one origin appended to `form-action`; otherwise the
   * header stays `form-action 'self'` (INV-084-1/2). `peek` never consumes/extends the context
   * (INV-084-3). A Redis failure is fail-closed (`'self'`) and logged without the request_id.
   */
  private async setLoginFormActionCsp(reply: UiReply, safeReturn: string): Promise<void> {
    reply.header('Cache-Control', 'no-store');
    const origin = await this.loginFormActionOrigin(safeReturn);
    reply.header('Content-Security-Policy', buildCsp({ formAction: origin ? [origin] : [] }));
  }

  /** Resolve the single `form-action` origin for a `/login` resume, or null (→ `'self'`). */
  private async loginFormActionOrigin(safeReturn: string): Promise<string | null> {
    const requestId = requestIdFromReturnTo(safeReturn);
    if (!requestId) return null;
    let ctx;
    try {
      ctx = await this.authzContexts.peek(requestId);
    } catch {
      // Redis read failure: never guess an origin; keep `form-action 'self'` (fail-closed). Do not
      // log the request_id or returnTo (exposure budget).
      this.logger.warn('login CSP: context peek failed; keeping form-action self');
      return null;
    }
    return ctx ? safeCspOrigin(ctx.redirectUri) : null;
  }
  @Get('/register') async register(@Req() req: UiRequest, @Res() reply: UiReply) {
    if (await this.hasLiveSession(req, reply)) return reply.redirect('/', 302);
    return this.form(req, reply, 'register.eta', { title: 'Create account' });
  }
  @Get('/forgot') forgot(@Req() req: UiRequest, @Res() reply: UiReply) {
    return this.form(req, reply, 'forgot.eta', { title: 'Reset password' });
  }
  @Get('/verify-email') verifyForm(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('token') token = '',
  ) {
    return this.form(req, reply, 'verify.eta', { title: 'Verify email', token });
  }
  @Get('/reset') resetForm(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('token') token = '',
  ) {
    return this.form(req, reply, 'reset.eta', { title: 'Choose a new password', token });
  }
  @Get('/logout') async logoutForm(
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('id_token_hint') idTokenHint?: string,
    @Query('post_logout_redirect_uri') postLogoutRedirectUri?: string,
    @Query('state') state?: string,
    @Query('client_id') clientId?: string,
  ) {
    // GET NEVER destroys state (spec §9.8, anti-CSRF): render the confirmation form only. The raw
    // RP-initiated params ride along as hidden fields; the POST re-validates them (never trusted).
    // The page carries a JWT hint (user PII) and a CSRF token, so it must never be cached.
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

    // DEBT-084: the logout form POSTs here, then 302s to `post_logout_redirect_uri`. Relax
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
    await this.limit('register', req, body.email);
    await this.auth.register(normalizeEmail(body.email), body.password);
    return reply.view('message.eta', {
      title: 'Check your email',
      message: 'If the address can be registered, a verification email has been sent.',
    });
  }
  @Post('/login')
  @UseGuards(CsrfGuard)
  async loginPost(@Body() body: LoginDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.limit('login', req, body.email);
    const established = await this.auth.login(normalizeEmail(body.email), body.password, {
      oldSessionId: this.sessionCookie.read(req),
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
      requestId: req.id,
    });
    this.sessionCookie.set(reply, established.id);
    return reply.redirect(safeReturnTo(body.returnTo, this.issuer), 302);
  }
  @Post('/forgot')
  @UseGuards(CsrfGuard)
  async forgotPost(@Body() body: EmailDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.limit('forgot', req, body.email);
    await this.auth.forgotPassword(normalizeEmail(body.email));
    return reply.view('message.eta', {
      title: 'Check your email',
      message: 'If the account exists, a reset email has been sent.',
    });
  }
  @Post('/verify-email')
  @UseGuards(CsrfGuard)
  async verifyPost(@Body() body: TokenDto, @Res() reply: UiReply) {
    await this.auth.verifyEmail(body.token);
    return reply.view('message.eta', {
      title: 'Email verified',
      message: 'Your email has been verified.',
    });
  }
  @Post('/reset')
  @UseGuards(CsrfGuard)
  async resetPost(@Body() body: ResetDto, @Req() req: UiRequest, @Res() reply: UiReply) {
    await this.limit('reset', req, body.token);
    await this.auth.resetPassword(body.token, body.password);
    return reply.view('message.eta', {
      title: 'Password changed',
      message: 'Your password has been changed.',
    });
  }
  @Post('/logout')
  @UseGuards(CsrfGuard)
  async logout(
    @Body() body: LogoutDto,
    @Req() req: UiRequest,
    @Res() reply: UiReply,
    @Query('scope') scope?: string,
  ) {
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
        return reply.redirect(target, 302);
      } catch {
        return reply.redirect(this.logoutRp.defaultRedirect, 302);
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
    let tokenCount = global
      ? await this.refreshTokens.revokeAllForUser(session.userId, now)
      : await this.refreshTokens.revokeForSession(session.userId, session.ref, now);

    let sessionCount = 1;
    if (global) {
      sessionCount = await this.sessions.revokeAllForUser(session.userId);
    } else {
      await this.sessions.revoke(id!);
    }

    // SWEEP (DEBT-051, §15 inv. 29): revoke the families a second time AFTER the session is gone +
    // tombstoned. A `/token` code exchange racing this logout either inserted its family before the
    // first revoke (caught there) or after it — in which case it ran after the MARK above and its
    // own post-insert re-check already revoked it, OR it lands here and this sweep catches it. Net:
    // no refresh family survives bound to an actively-terminated session. Idempotent.
    // The sweep may be the ONLY revoke that catches a family inserted by a `/token` exchange that
    // raced between the first revoke and the session MARK (so the first revoke returned 0). Add its
    // count so the TOKEN_REVOKED audit below reflects everything revoked (fold 🟡: cộng dồn).
    tokenCount += global
      ? await this.refreshTokens.revokeAllForUser(session.userId, now)
      : await this.refreshTokens.revokeForSession(session.userId, session.ref, now);

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
      return reply.redirect(target, 302);
    } catch {
      // Legacy/hand-edited client data (bad redirect URI, un-parseable front-channel URI) or a
      // transient Mongo read must not block an already-completed logout. No hint/token is logged.
      return reply.redirect(this.logoutRp.defaultRedirect, 302);
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

  private form(req: UiRequest, reply: UiReply, template: string, data: Record<string, unknown>) {
    const identity = this.identity(req, reply);
    return reply.view(template, { ...data, csrf: this.csrf.token(identity) });
  }
  private async hasLiveSession(req: UiRequest, reply: UiReply): Promise<boolean> {
    const id = this.sessionCookie.read(req);
    if (!id) return false;
    if (await this.sessions.get(id)) return true;
    this.sessionCookie.clear(reply);
    delete req.cookies?.[SESSION_COOKIE];
    return false;
  }
  private identity(req: UiRequest, reply?: UiReply): string {
    const session = this.sessionCookie.read(req);
    if (session) return session;
    let anon = req.cookies?.[ANON_COOKIE];
    if (!anon) {
      if (!reply) throw new BadRequestException('Invalid form submission.');
      anon = generateToken();
      reply.setCookie(ANON_COOKIE, anon, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.secure,
        path: '/',
      });
    }
    return anon;
  }
  private async limit(name: string, req: UiRequest, account?: string) {
    const result = await this.rateLimit.hit(
      { name },
      { ip: req.ip, account, deviceId: req.cookies?.[ANON_COOKIE] },
    );
    if (!result.allowed)
      throw new HttpException({ retryAfter: result.retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
