import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { HttpReply, HttpRequest } from '../../../common/http/http.types';
import { SessionService } from '../../sessions/session.service';
import { SessionCookie } from '../../sessions/session.cookie';
import { CsrfGuard, CsrfService } from '../../ui/csrf.service';
import { HtmlExceptionFilter } from '../../ui/html-exception.filter';
import { safeReturnTo } from '../../ui/return-to';
import { AuthorizeErrorPage, AuthorizeRedirectError } from './authorize.errors';
import {
  AuthorizeService,
  type AuthorizeOutcome,
  type AuthorizeParams,
  type SessionView,
} from './authorize.service';

/** POST body of the consent form. `approve` present => allow; absent/anything-else => deny. */
class ConsentDto {
  @IsOptional() @IsString() _csrf?: string;
  @IsString() request_id!: string;
  @IsOptional() @IsString() approve?: string;
}

/**
 * `/authorize` + consent (B4.1/B4.2, spec Â§9.2/Â§9.4).
 *
 * Open-redirect safety (INV-3, tech-lead C2): `AuthorizeErrorPage` renders a first-party page via
 * the same `error.eta` used across the UI -- it is NEVER redirected. `HtmlExceptionFilter`
 * overrides the global JSON filter so any *unexpected* error on these routes renders a page instead
 * of leaking JSON. Known OAuth errors for an already-validated `redirect_uri` are delivered as a
 * 302 redirect with `error`/`state`/`iss`; a successful consent is delivered as a 302 with
 * `code`/`state`/`iss`.
 *
 * DEBT-015 (CSP `form-action 'self'`): the consent form POSTs to this same IdP origin
 * (`/authorize/consent`, same-origin) and only *then* 302-redirects (GET) to the RP, so helmet's
 * `form-action 'self'` never blocks the flow (proven by the consent redirect tests). DEBT-019/020
 * (CORS) do not apply: `/authorize` is a top-level browser navigation, not a CORS fetch/preflight.
 */
@Controller()
@UseFilters(HtmlExceptionFilter)
export class AuthorizeController {
  constructor(
    private readonly authorize: AuthorizeService,
    private readonly sessions: SessionService,
    private readonly sessionCookie: SessionCookie,
    private readonly csrf: CsrfService,
  ) {}

  @Get('/authorize')
  async handle(
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
    @Query() params: AuthorizeParams,
  ): Promise<unknown> {
    const session = await this.liveSession(req);
    const audit = { ip: req.ip, requestId: req.id };

    try {
      // Resume after login (spec Â§9.1): the return URL carries only `request_id`; the original
      // parameters live in the stored context. A missing/expired context cannot be redirected
      // (redirect_uri is gone) -> first-party error page.
      if (params.request_id) {
        const resumed = await this.authorize.resume(params.request_id, session, audit);
        if (!resumed) return this.expiredPage(reply);
        return this.respond(req, reply, resumed);
      }

      const outcome = await this.authorize.handle(params, session, audit);
      return this.respond(req, reply, outcome);
    } catch (err) {
      return this.handleError(reply, err);
    }
  }

  /**
   * POST /authorize/consent: the user approved or denied the consent screen. CSRF-guarded (identity
   * = session cookie, same model as the login form). The redirect target and all OAuth params come
   * from the stored `AuthorizeRequestContext` (resumed by `request_id`), NOT from this body, so a
   * forged body cannot retarget the redirect or widen scope.
   */
  @Post('/authorize/consent')
  @HttpCode(302)
  @UseGuards(CsrfGuard)
  async consent(
    @Body() body: ConsentDto,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ): Promise<unknown> {
    // Re-verify the session on POST: it may have expired between render and submit. No session =>
    // never issue a code; send the user back to login (resumable).
    const session = await this.liveSession(req);
    if (!session) {
      return reply.redirect('/login', 302);
    }
    const audit = { ip: req.ip, requestId: req.id };
    const approve = body.approve === 'true';

    try {
      const decision = await this.authorize.decideConsent(body.request_id, approve, session, audit);
      if (!decision) {
        // Context missing/expired/replayed: redirect_uri is gone => first-party page, no redirect.
        return this.expiredPage(reply);
      }
      if (decision.denied) {
        return reply.redirect(
          this.buildRedirect(decision.redirectUri, { error: 'access_denied' }, decision.state),
          302,
        );
      }
      return reply.redirect(
        this.buildRedirect(decision.redirectUri, { code: decision.code! }, decision.state),
        302,
      );
    } catch (err) {
      return this.handleError(reply, err);
    }
  }

  /** Current live session as the minimal `SessionView`, or null when signed out/stale. */
  private async liveSession(req: HttpRequest): Promise<SessionView | null> {
    const sessionId = this.sessionCookie.read(req);
    const live = sessionId ? await this.sessions.get(sessionId) : null;
    return live ? { userId: live.userId, authTime: live.authTime } : null;
  }

  /** Turn a validated-request outcome into an HTTP response (shared by fresh + resumed paths). */
  private respond(req: HttpRequest, reply: HttpReply, outcome: AuthorizeOutcome): unknown {
    if (outcome.kind === 'login_required') {
      // Resumable login: carry request_id so the login flow can return to /authorize.
      const returnTo = safeReturnTo(
        `/authorize?request_id=${encodeURIComponent(outcome.requestId)}`,
        this.authorize.issuerUrl,
      );
      return reply.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, 302);
    }
    if (outcome.kind === 'consent_required') {
      // Render the consent screen. CSRF identity = session cookie (same as login); the guard on
      // POST verifies the same token, so the user must be signed-in here (B4.1 guaranteed that).
      const identity = this.sessionCookie.read(req)!;
      return reply.view('consent.eta', {
        title: 'Authorize access',
        csrf: this.csrf.token(identity),
        requestId: outcome.requestId,
        clientId: outcome.clientId,
        scopes: outcome.scopes,
        resource: outcome.resource,
      });
    }
    // kind === 'code_issued': 302 to the RP with code/state/iss (spec Â§9.2, RFC 9207).
    return reply.redirect(
      this.buildRedirect(outcome.redirectUri, { code: outcome.code }, outcome.state),
      302,
    );
  }

  private handleError(reply: HttpReply, err: unknown): unknown {
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

  private expiredPage(reply: HttpReply): unknown {
    return reply.status(400).view('error.eta', {
      title: 'Request expired',
      message: 'This authorization request has expired. Please start again.',
    });
  }

  /**
   * Build a redirect to an already-validated redirect_uri, echoing `state` and always adding `iss`
   * (RFC 9207). `params` carries either `{ code }` (success) or `{ error }` (deny/OAuth error).
   */
  private buildRedirect(
    redirectUri: string,
    params: Record<string, string>,
    state?: string,
  ): string {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (state !== undefined) url.searchParams.set('state', state);
    url.searchParams.set('iss', this.authorize.issuerUrl);
    return url.toString();
  }

  /**
   * Build the OAuth error redirect to an already-validated redirect_uri (echo state + iss).
   * `redirectUri`/`state` come from the error itself (set by `AuthorizeService` where redirect_uri
   * became trusted), NOT from the inbound HTTP request -- on the resume/consent paths the inbound
   * body only has `request_id`, so those live in the consumed context.
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
