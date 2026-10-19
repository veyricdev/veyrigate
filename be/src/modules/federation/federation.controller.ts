import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { generateToken } from '../../common/crypto/crypto.util';
import { buildCsp } from '../../common/http/csp';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import type { SessionConfig } from '../../config/configuration';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { SessionCookie } from '../sessions/session.cookie';
import { CsrfGuard, CsrfService, formCsrfIdentity } from '../ui/csrf.service';
import { HtmlExceptionFilter } from '../ui/html-exception.filter';
import { FederationError, type FederationErrorCode } from './federation.errors';
import { FED_LINK_TTL_MS, FED_STATE_TTL_MS } from './federation-state.store';
import { FederationService, type LinkOutcome } from './federation.service';

/** Browser-binding cookie of the provider leg (anti login-CSRF, F5). Scoped to `/auth/`. */
export const FED_BINDING_COOKIE = 'idp_fed';
/** Opaque handle of a pending account link (B5.3, F6). Never in a URL or HTML. */
export const FED_LINK_COOKIE = 'idp_link';

/** Only the password: the email to sign in with comes from the server-side pending link (F7). */
class LinkDto {
  @IsOptional() @IsString() _csrf?: string;
  @IsString() @Length(8, 128) password!: string;
}

const PROVIDER_LABELS = { google: 'Google', github: 'GitHub' } as const;

/** First-party error page per fixed code (generic wording, no provider detail, F6/F9). */
const ERROR_PAGES: Record<FederationErrorCode, { status: number; message: string }> = {
  not_found: { status: 404, message: 'The request could not be completed.' },
  context_expired: {
    status: 400,
    message: 'This sign-in request has expired. Please start again from the application.',
  },
  invalid_state: {
    status: 400,
    message: 'This sign-in attempt is invalid or has expired. Please start again.',
  },
  provider_denied: { status: 400, message: 'Sign-in with the provider was cancelled.' },
  provider_unavailable: {
    status: 502,
    message: 'The sign-in provider is unavailable. Please try again later.',
  },
  invalid_identity: { status: 400, message: 'The sign-in could not be verified.' },
  reauth_required: {
    status: 400,
    message: 'This application requires a fresh sign-in. Please use another sign-in method.',
  },
  email_unverified: {
    status: 400,
    message: 'A verified email address is required to create an account.',
  },
  account_locked: { status: 403, message: 'Sign-in is not possible for this account.' },
  retry: { status: 503, message: 'Sign-in could not be completed. Please try again.' },
};

/** A single string query value, or undefined (arrays/duplicates are ignored). */
const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Federation routes (B5.2, spec §9.9): `/auth/:provider/start` and `/auth/:provider/callback`.
 * Every failure renders a first-party page: this leg NEVER redirects to an RP, and the only
 * redirect targets are the registry's provider URL or `/authorize?request_id` built server-side.
 */
@Controller('auth')
@UseFilters(HtmlExceptionFilter)
export class FederationController {
  private readonly logger = new Logger(FederationController.name);
  private readonly secure: boolean;

  constructor(
    private readonly federation: FederationService,
    private readonly sessionCookie: SessionCookie,
    private readonly rateLimit: RateLimitService,
    private readonly csrf: CsrfService,
    config: ConfigService,
  ) {
    this.secure = config.getOrThrow<SessionConfig>('session').cookieSecure;
  }

  @Get(':provider/start')
  async start(
    @Param('provider') provider: string,
    @Query('request_id') requestId: unknown,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    await this.limit(req);
    try {
      // Reuse the binding cookie (not rotated per leg, so two tabs do not break each other).
      const binding = req.cookies?.[FED_BINDING_COOKIE] || generateToken();
      const location = await this.federation.start(provider, one(requestId), binding);
      reply.setCookie(FED_BINDING_COOKIE, binding, {
        httpOnly: true,
        secure: this.secure,
        sameSite: 'lax',
        path: '/auth/',
        maxAge: FED_STATE_TTL_MS / 1000,
      });
      return reply.redirect(location, 302);
    } catch (err) {
      return this.fail(reply, err);
    }
  }

  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    await this.limit(req);
    try {
      const outcome = await this.federation.callback(
        provider,
        {
          state: one(query.state),
          code: one(query.code),
          error: one(query.error),
          iss: one(query.iss),
        },
        { binding: req.cookies?.[FED_BINDING_COOKIE], session: this.sessionCookie.read(req) },
        {
          ip: req.ip,
          userAgent: String(req.headers['user-agent'] ?? ''),
          requestId: req.id,
        },
      );
      if (outcome.kind === 'denied') {
        return this.page(reply, 'provider_denied', {
          actionUrl: outcome.loginUrl,
          actionLabel: 'Choose another sign-in method',
        });
      }
      if (outcome.kind === 'link_required') {
        reply.setCookie(FED_LINK_COOKIE, outcome.linkToken, this.linkCookieOptions());
        return reply.redirect('/auth/link', 302);
      }
      this.sessionCookie.set(reply, outcome.sessionId);
      return reply.redirect(outcome.location, 302);
    } catch (err) {
      return this.fail(reply, err);
    }
  }

  /**
   * B5.3 (F7): "an account already uses this email — enter its password to link". Only the browser
   * that ran the provider leg (`idp_fed`) sees it. The page is identical for every kind of target
   * account (F11): no lock/password/verification state is consulted here.
   */
  @Get('link')
  async linkForm(@Req() req: HttpRequest, @Res() reply: HttpReply): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    await this.limit(req);
    try {
      const page = await this.federation.linkPage(
        req.cookies?.[FED_LINK_COOKIE],
        req.cookies?.[FED_BINDING_COOKIE],
      );
      // DEBT-084: the form POSTs, then 302s via `/authorize` to the RP; Chromium applies THIS
      // page's `form-action` to the whole chain, so allow the single already-matched RP origin.
      reply.header(
        'Content-Security-Policy',
        buildCsp({ formAction: page.formAction ? [page.formAction] : [] }),
      );
      const identity = formCsrfIdentity(this.sessionCookie.read(req), req, reply, this.secure);
      return reply.view('link.eta', {
        title: 'Link your account',
        provider: PROVIDER_LABELS[page.provider],
        email: page.email,
        loginUrl: page.loginUrl,
        csrf: this.csrf.token(identity),
      });
    } catch (err) {
      return this.fail(reply, err);
    }
  }

  /**
   * B5.3 (F8): rate-limit (`federation` + `login` keyed by the pending email) BEFORE the pending
   * link is consumed; the service then consumes it (single-use), checks the binding and signs in
   * with the password. The `idp_link` cookie is cleared whatever happens.
   */
  @Post('link')
  @UseGuards(CsrfGuard)
  async linkSubmit(
    @Body() body: LinkDto,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ): Promise<unknown> {
    reply.header('Cache-Control', 'no-store');
    await this.limit(req);
    const token = req.cookies?.[FED_LINK_COOKIE];
    const pending = await this.federation.pendingLink(token);
    if (pending) await this.limit(req, 'login', pending.email);
    reply.clearCookie(FED_LINK_COOKIE, this.linkCookieOptions());
    const outcome = await this.federation.completeLink(
      token,
      req.cookies?.[FED_BINDING_COOKIE],
      body.password,
      {
        oldSessionId: this.sessionCookie.read(req),
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? ''),
        requestId: req.id,
      },
    );
    if (outcome.kind !== 'failed') this.sessionCookie.set(reply, outcome.sessionId);
    if (outcome.kind === 'linked') return reply.redirect(outcome.location, 302);
    return this.linkFailedPage(reply, outcome);
  }

  /** One generic page per failure class, whatever the account state (F8/F11). */
  private linkFailedPage(reply: HttpReply, outcome: Exclude<LinkOutcome, { kind: 'linked' }>) {
    if (outcome.kind === 'failed') {
      return reply.status(400).view('error.eta', {
        title: 'Account not linked',
        message: 'The account could not be linked. Please sign in again.',
        actionUrl: outcome.loginUrl,
        actionLabel: 'Return to sign in',
      });
    }
    return reply.status(400).view('error.eta', {
      title: 'Account not linked',
      message: 'You are signed in, but the account could not be linked.',
      actionUrl: outcome.location,
      actionLabel: 'Continue',
    });
  }

  private linkCookieOptions() {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: '/auth/',
      maxAge: FED_LINK_TTL_MS / 1000,
    } as const;
  }

  private async limit(req: HttpRequest, name = 'federation', account?: string): Promise<void> {
    const result = await this.rateLimit.hit(
      { name },
      { ip: req.ip, account, deviceId: req.cookies?.[FED_BINDING_COOKIE] },
    );
    if (!result.allowed)
      throw new HttpException({ retryAfter: result.retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Known failures => fixed page + fixed log code; anything else => HtmlExceptionFilter (500). */
  private fail(reply: HttpReply, err: unknown): unknown {
    if (!(err instanceof FederationError)) throw err;
    this.logger.warn(`federation failed: ${err.code}`);
    return this.page(reply, err.code);
  }

  private page(reply: HttpReply, code: FederationErrorCode, extra: Record<string, string> = {}) {
    const { status, message } = ERROR_PAGES[code];
    return reply.status(status).view('error.eta', { title: 'Sign-in failed', message, ...extra });
  }
}
