import { Controller, Get, Query, Req, Res, UseFilters } from '@nestjs/common';
import { SessionService } from '../../sessions/session.service';
import { SessionCookie } from '../../sessions/session.cookie';
import { HtmlExceptionFilter } from '../../ui/html-exception.filter';
import { safeReturnTo } from '../../ui/return-to';
import { AuthorizeErrorPage, AuthorizeRedirectError } from './authorize.errors';
import { AuthorizeService, type AuthorizeOutcome, type AuthorizeParams } from './authorize.service';

interface AuthorizeRequest {
  cookies?: Record<string, string | undefined>;
  ip?: string;
  id?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface AuthorizeReply {
  status(code: number): AuthorizeReply;
  view(template: string, data: Record<string, unknown>): unknown;
  redirect(url: string, status?: number): unknown;
}

/**
 * `/authorize` (B4.1, spec §9.2).
 *
 * Open-redirect safety (INV-3, tech-lead C2): `AuthorizeErrorPage` renders a first-party page
 * via the same `error.eta` used across the UI — it is NEVER redirected. The global
 * `OAuthExceptionFilter` (JSON) is overridden here with `HtmlExceptionFilter` so any *unexpected*
 * error on this route also renders a page instead of leaking JSON. Known OAuth errors for an
 * already-validated `redirect_uri` are delivered as a 302 redirect with `error`/`state`/`iss`.
 *
 * DEBT-015 (CSP `form-action`) does not apply: this route uses 302 GET redirects, not a POST form
 * to the RP, so helmet's `form-action 'self'` never blocks the flow (tech-lead C6; proven by the
 * redirect integration tests). DEBT-019/020 (CORS) do not apply: `/authorize` is a top-level
 * browser navigation, not a CORS fetch/preflight (tech-lead C5).
 */
@Controller()
@UseFilters(HtmlExceptionFilter)
export class AuthorizeController {
  constructor(
    private readonly authorize: AuthorizeService,
    private readonly sessions: SessionService,
    private readonly sessionCookie: SessionCookie,
  ) {}

  @Get('/authorize')
  async handle(
    @Req() req: AuthorizeRequest,
    @Res() reply: AuthorizeReply,
    @Query() params: AuthorizeParams,
  ): Promise<unknown> {
    const sessionId = this.sessionCookie.read(req);
    const live = sessionId ? await this.sessions.get(sessionId) : null;
    const session = live ? { userId: live.userId, authTime: live.authTime } : null;
    const audit = { ip: req.ip, requestId: req.id };

    try {
      // Resume after login (spec §9.1): the return URL carries only `request_id`; the original
      // parameters live in the stored context. A missing/expired context cannot be redirected
      // (redirect_uri is gone) → first-party error page.
      if (params.request_id) {
        const resumed = await this.authorize.resume(params.request_id, session, audit);
        if (!resumed) {
          return reply.status(400).view('error.eta', {
            title: 'Request expired',
            message: 'This authorization request has expired. Please start again.',
          });
        }
        return this.respond(reply, resumed);
      }

      const outcome = await this.authorize.handle(params, session, audit);
      return this.respond(reply, outcome);
    } catch (err) {
      if (err instanceof AuthorizeRedirectError) {
        return reply.redirect(this.buildErrorRedirect(err), 302);
      }
      if (err instanceof AuthorizeErrorPage) {
        return reply.status(400).view('error.eta', {
          title: 'Invalid request',
          message: 'The request could not be completed.',
        });
      }
      throw err;
    }
  }

  /** Turn a validated-request outcome into an HTTP response (shared by fresh + resumed paths). */
  private respond(reply: AuthorizeReply, outcome: AuthorizeOutcome): unknown {
    if (outcome.kind === 'login_required') {
      // Resumable login: carry request_id so the login flow can return to /authorize (B4.2+).
      const returnTo = safeReturnTo(
        `/authorize?request_id=${encodeURIComponent(outcome.requestId)}`,
        this.authorize.issuerUrl,
      );
      return reply.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, 302);
    }
    // kind === 'ready': B4.1 stops before code issuance (B4.3/B4.4). Show a holding page so the
    // walking skeleton is observable; the code-issuance redirect replaces this in B4.4.
    return reply.view('message.eta', {
      title: 'Authorization request accepted',
      message: 'Your request has been validated. Issuing the authorization code is next (B4.4).',
    });
  }

  /**
   * Build the OAuth error redirect to an already-validated redirect_uri (echo state + iss,
   * RFC 9207). `redirectUri`/`state` come from the error itself (set by `AuthorizeService.handle()`
   * at the point redirect_uri became trusted), NOT from the inbound HTTP `params` â€” on the
   * resume-after-login path `params` only has `request_id`, so reading `params.redirect_uri` there
   * would be `undefined` even though the error is for an already-validated redirect_uri.
   */
  private buildErrorRedirect(err: AuthorizeRedirectError): string {
    const url = new URL(err.redirectUri!);
    url.searchParams.set('error', err.error);
    url.searchParams.set('error_description', err.errorDescription);
    if (err.state !== undefined) url.searchParams.set('state', err.state);
    url.searchParams.set('iss', this.authorize.issuerUrl);
    return url.toString();
  }
}
