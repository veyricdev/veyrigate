import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateToken } from '../../common/crypto/crypto.util';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import type { SessionConfig } from '../../config/configuration';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { SessionCookie } from '../sessions/session.cookie';
import { HtmlExceptionFilter } from '../ui/html-exception.filter';
import { FederationError, type FederationErrorCode } from './federation.errors';
import { FED_STATE_TTL_MS } from './federation-state.store';
import { FederationService } from './federation.service';

/** Browser-binding cookie of the provider leg (anti login-CSRF, F5). Scoped to `/auth/`. */
export const FED_BINDING_COOKIE = 'idp_fed';

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
  email_conflict: {
    status: 409,
    message: 'An account with this email already exists. Please sign in with your password.',
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
      this.sessionCookie.set(reply, outcome.sessionId);
      return reply.redirect(outcome.location, 302);
    } catch (err) {
      return this.fail(reply, err);
    }
  }

  private async limit(req: HttpRequest): Promise<void> {
    const result = await this.rateLimit.hit(
      { name: 'federation' },
      { ip: req.ip, deviceId: req.cookies?.[FED_BINDING_COOKIE] },
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
