import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildCsp, safeCspOrigin } from '../../common/http/csp';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import type { SessionConfig } from '../../config/configuration';
import { AuthenticationService } from '../authentication/authentication.service';
import { AuthorizeRequestContextService } from '../oauth/authorize/authorize-request-context.service';
import type { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import type { AuditMetadata } from '../security/audit/audit.types';
import { RateLimitService } from '../security/rate-limit/rate-limit.service';
import { SessionCookie } from '../sessions/session.cookie';
import { SessionService, type Session } from '../sessions/session.service';
import { csrfCookieName, formCsrfIdentity } from './csrf.service';
import { requestIdFromReturnTo } from './return-to';

/** Re-authentication window (D88.18): same 5' as the admin step-up (D3). */
export const ACCOUNT_REAUTH_WINDOW_MS = 300_000;

export type Reauth = { ok: true } | { ok: false; status: number; error: string };

export interface ReauthOptions {
  /** How a refused attempt is audited (`reauth_failed` / `reauth_throttled`); never an alerting action. */
  audit: {
    action: AuditAction;
    targetType: string;
    targetId?: string;
    tenantId?: string;
    metadata: AuditMetadata;
  };
  /** Shown to an account without a password whose session is older than the window. */
  noPasswordMessage: string;
  /** D88.28: the password is required even inside the window (accounts that have one). */
  alwaysPassword?: boolean;
}

/**
 * Session plumbing shared by the HTML controllers (DEBT-632): ONE place clears a dead session
 * cookie, derives the form CSRF identity, applies the per-endpoint limiter (IP, account, device)
 * and re-authenticates (D88.18, DEBT-638).
 */
@Injectable()
export class UiSessionHelper {
  readonly secure: boolean;
  private readonly logger = new Logger(UiSessionHelper.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly sessionCookie: SessionCookie,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
    private readonly auth: AuthenticationService,
    private readonly audit: AuditService,
    private readonly authzContexts: AuthorizeRequestContextService,
  ) {
    this.secure = config.getOrThrow<SessionConfig>('session').cookieSecure;
  }

  /** The live session of the cookie, or null (a dead cookie is cleared). Redis errors propagate. */
  async liveSession(req: HttpRequest, reply: HttpReply): Promise<Session | null> {
    const id = this.sessionCookie.read(req);
    if (!id) return null;
    const session = await this.sessions.get(id);
    if (session) return session;
    this.sessionCookie.clear(reply);
    delete req.cookies?.[this.sessionCookie.name];
    return null;
  }

  /** CSRF identity of a form page: the session cookie, else the anonymous CSRF cookie. */
  identity(req: HttpRequest, reply: HttpReply): string {
    return formCsrfIdentity(this.sessionCookie.read(req), req, reply, this.secure);
  }

  /** One hit on the limiter `name`; over the limit => 429 with `retryAfter`. */
  async limit(name: string, req: HttpRequest, account?: string): Promise<void> {
    const result = await this.rateLimit.hit(
      { name },
      { ip: req.ip, account, deviceId: req.cookies?.[csrfCookieName(this.secure)] },
    );
    if (!result.allowed)
      throw new HttpException({ retryAfter: result.retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * D88.18 / D89.23 re-authentication (DEBT-638, one copy for every account page): a session
   * authenticated < 5' ago (unless `alwaysPassword`), or the current password through the shared
   * 5/900 s `pwc:` bucket. An account without a password passes only inside the window. A refused
   * password is audited with the request context; a throttled one once per window, then 429.
   * Redis/Mongo errors propagate (fail-closed).
   */
  async reauth(
    req: HttpRequest,
    session: Session,
    password: string | undefined,
    opts: ReauthOptions,
  ): Promise<Reauth> {
    const fresh = session.authTime >= Date.now() - ACCOUNT_REAUTH_WINDOW_MS;
    if (fresh && !opts.alwaysPassword) return { ok: true };
    if (!(await this.auth.hasPassword(session.userId))) {
      return fresh
        ? { ok: true }
        : { ok: false, status: HttpStatus.BAD_REQUEST, error: opts.noPasswordMessage };
    }
    if (!password) {
      return {
        ok: false,
        status: HttpStatus.BAD_REQUEST,
        error: 'Enter your current password to confirm.',
      };
    }
    const result = await this.auth.verifyCurrentPassword(session.userId, password);
    if (result.kind === 'ok') return { ok: true };
    const record = (reason: string) =>
      this.audit.record({
        actorType: 'user',
        actorId: session.userId,
        ...opts.audit,
        result: 'failure',
        reason,
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? ''),
        requestId: req.id,
      });
    if (result.kind === 'throttled') {
      if (result.report) await record('reauth_throttled');
      throw new HttpException(
        { retryAfter: result.retryAfterSec, message: 'Too many attempts. Try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await record('reauth_failed');
    return {
      ok: false,
      status: HttpStatus.BAD_REQUEST,
      error:
        result.kind === 'no_password'
          ? opts.noPasswordMessage
          : 'The current password is incorrect.',
    };
  }

  /**
   * Per-response CSP of a sign-in form whose POST ends in a redirect chain to the RP (`GET /login`,
   * DEBT-084; `/login/mfa`, DEBT-647/D89.30): Chromium applies THIS page's `form-action` to every
   * step of that chain. Only when `safeReturn` is EXACTLY `/authorize?request_id=<id>` (single query
   * key) and the still-live context's already-validated `redirectUri` yields a clean origin is that
   * one origin appended; otherwise `form-action 'self'` (INV-084-1/2). `peek` never consumes or
   * extends the context (INV-084-3). A Redis failure is fail-closed (`'self'`), logged without the
   * request_id. Also sets `no-store`.
   */
  async setLoginFormActionCsp(reply: HttpReply, safeReturn: string): Promise<void> {
    reply.header('Cache-Control', 'no-store');
    const origin = await this.loginFormActionOrigin(safeReturn);
    reply.header('Content-Security-Policy', buildCsp({ formAction: origin ? [origin] : [] }));
  }

  /** The single `form-action` origin for a sign-in resume, or null (=> `'self'`). */
  private async loginFormActionOrigin(safeReturn: string): Promise<string | null> {
    const requestId = requestIdFromReturnTo(safeReturn);
    if (!requestId) return null;
    let ctx;
    try {
      ctx = await this.authzContexts.peek(requestId);
    } catch {
      // Never guess an origin; never log the request_id or returnTo (exposure budget).
      this.logger.warn('login CSP: context peek failed; keeping form-action self');
      return null;
    }
    return ctx ? safeCspOrigin(ctx.redirectUri) : null;
  }
}
