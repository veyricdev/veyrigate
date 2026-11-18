import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import type { HttpReply, HttpRequest } from '../../common/http/http.types';
import { AuthenticationService } from '../authentication/authentication.service';
import { LoginThrottleService } from '../authentication/login-throttle.service';
import { ClientService } from '../clients/client.service';
import { ConsentService } from '../oauth/consent/consent.service';
import { RefreshTokenService } from '../oauth/token/refresh-token.service';
import { AuditAction } from '../security/audit/audit-action.enum';
import { AuditService } from '../security/audit/audit.service';
import type { AuditEventInput } from '../security/audit/audit.types';
import { SessionService, type Session } from '../sessions/session.service';
import { CsrfGuard, CsrfService } from './csrf.service';
import { HtmlExceptionFilter } from './html-exception.filter';
import { revokeOneSession } from './session-revoke';
import { ACCOUNT_REAUTH_WINDOW_MS, UiSessionHelper } from './ui-session.helper';

const HEX64 = /^[0-9a-f]{64}$/;
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/;
const MAX_APPS = 100;
const MAX_SESSIONS = 50;
const DONE: Record<string, string> = {
  session: 'The session was signed out.',
  others: 'Every other session was signed out.',
  device: 'The device is no longer trusted.',
  devices: 'Every other device is no longer trusted.',
};

class ReauthDto {
  @IsOptional() @IsString() _csrf?: string;
  @IsOptional() @IsString() @Length(0, 128) current_password?: string;
}
class RevokeSessionDto extends ReauthDto {
  @IsOptional() @IsString() @Length(0, 128) ref?: string;
}
class RevokeConsentDto {
  @IsOptional() @IsString() _csrf?: string;
  @IsOptional() @IsString() @Length(0, 64) consent_id?: string;
}
class ForgetDeviceDto extends ReauthDto {
  @IsOptional() @IsString() @Length(0, 128) device?: string;
}

/**
 * Self-service account pages (run 88): `/account/sessions` (C-7.5.2, DEBT-582/586, D88.15–D88.20).
 * Every POST: CSRF bound to the session cookie, a per-user limiter, re-authentication (session
 * authenticated < 5' ago, or the current password through the `/account/password` bucket), then an
 * ownership check against the CURRENT user only (IDOR => one fixed 404), then PRG 303.
 */
@Controller()
@UseFilters(HtmlExceptionFilter)
export class AccountController {
  constructor(
    private readonly auth: AuthenticationService,
    private readonly csrf: CsrfService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly consents: ConsentService,
    private readonly clients: ClientService,
    private readonly ui: UiSessionHelper,
  ) {}

  @Get('/account/sessions')
  async sessionsPage(
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
    @Query('done') done?: string,
  ) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fsessions', 302);
    return this.render(req, reply, session, {
      notice: typeof done === 'string' ? DONE[done] : undefined,
    });
  }

  @Post('/account/sessions/revoke')
  @UseGuards(CsrfGuard)
  async revokeSession(
    @Body() body: RevokeSessionDto,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fsessions', 303);
    await this.ui.limit('account_sessions', req, session.userId);
    const reauth = await this.reauth(req, session, body.current_password, 'session');
    if (!reauth.ok) return this.render(req, reply, session, { error: reauth.error }, reauth.status);

    const ref = body.ref ?? '';
    if (ref === session.ref) {
      return this.render(
        req,
        reply,
        session,
        { error: 'This is the current session: use Sign out.' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const target = HEX64.test(ref) ? await this.sessions.findOwned(session.userId, ref) : null;
    if (!target) {
      // The submitted value is never recorded: it may not be one of this user's refs.
      await this.record(session, AuditAction.SESSION_REVOKED, 'failure', {
        reason: 'not_found',
        metadata: { scope: 'session', via: 'self' },
      });
      return this.notFound(reply);
    }
    const now = new Date();
    const count = await revokeOneSession(
      this.refreshTokens,
      target,
      now,
      () => this.sessions.revokeOwnedRef(session.userId, target.ref),
      (failedStep) =>
        this.record(session, AuditAction.SESSION_REVOKED, 'failure', {
          targetId: target.ref,
          reason: 'revoke_failed',
          metadata: { scope: 'session', via: 'self', failedStep },
        }),
    );
    await this.recordRevoked(session, { scope: 'session', targetId: target.ref }, count);
    return this.done(reply, 'session');
  }

  @Post('/account/sessions/revoke-others')
  @UseGuards(CsrfGuard)
  async revokeOthers(@Body() body: ReauthDto, @Req() req: HttpRequest, @Res() reply: HttpReply) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fsessions', 303);
    await this.ui.limit('account_sessions', req, session.userId);
    const reauth = await this.reauth(req, session, body.current_password, 'others');
    if (!reauth.ok) return this.render(req, reply, session, { error: reauth.error }, reauth.status);

    // A session created after this listing is not touched (it did not exist when the user asked).
    const others = (await this.sessions.listByUser(session.userId)).filter(
      (s) => s.ref !== session.ref,
    );
    const now = new Date();
    let firstError: unknown;
    let failedStep: string | undefined;
    let sessions = 0;
    let tokens = 0;
    // Every session is attempted; the first error wins (DEBT-055).
    for (const other of others) {
      try {
        tokens += await revokeOneSession(
          this.refreshTokens,
          other,
          now,
          () => this.sessions.revokeByDevice(session.userId, other.ref),
          async (step) => {
            failedStep ??= step;
          },
        );
        sessions += 1;
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) {
      await this.record(session, AuditAction.SESSION_REVOKED, 'failure', {
        reason: 'revoke_failed',
        metadata: { scope: 'others', via: 'self', count: sessions, failedStep: failedStep ?? null },
      }).catch(() => undefined);
      throw firstError;
    }
    await this.recordRevoked(session, { scope: 'others', count: sessions }, tokens);
    return this.done(reply, 'others');
  }

  @Post('/account/devices/forget')
  @UseGuards(CsrfGuard)
  async forgetDevice(
    @Body() body: ForgetDeviceDto,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fsessions', 303);
    await this.ui.limit('account_sessions', req, session.userId);
    const reauth = await this.reauth(req, session, body.current_password, 'device');
    if (!reauth.ok) return this.render(req, reply, session, { error: reauth.error }, reauth.status);

    const device = body.device ?? '';
    const removed = HEX64.test(device)
      ? await this.loginThrottle.forgetTrusted(session.userId, { device })
      : 0;
    if (removed === 0) {
      await this.record(session, AuditAction.TRUSTED_DEVICE_REVOKED, 'failure', {
        reason: 'not_found',
        metadata: { scope: 'device' },
      });
      return this.notFound(reply);
    }
    await this.record(session, AuditAction.TRUSTED_DEVICE_REVOKED, 'success', {
      metadata: { scope: 'device', count: removed },
    });
    return this.done(reply, 'device');
  }

  @Post('/account/devices/forget-others')
  @UseGuards(CsrfGuard)
  async forgetOtherDevices(
    @Body() body: ReauthDto,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fsessions', 303);
    await this.ui.limit('account_sessions', req, session.userId);
    const reauth = await this.reauth(req, session, body.current_password, 'devices');
    if (!reauth.ok) return this.render(req, reply, session, { error: reauth.error }, reauth.status);

    const count = await this.loginThrottle.forgetTrusted(session.userId, {
      allBut: this.loginThrottle.deviceHash(req),
    });
    await this.record(session, AuditAction.TRUSTED_DEVICE_REVOKED, 'success', {
      metadata: { scope: 'others', count },
    });
    return this.done(reply, 'devices');
  }

  /** `/account/apps` (C-10.7b, DEBT-581, D88.22): the user's own active consents. */
  @Get('/account/apps')
  async appsPage(@Req() req: HttpRequest, @Res() reply: HttpReply, @Query('done') done?: string) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fapps', 302);
    const rows = await this.consents.listOwn(session.userId, MAX_APPS);
    const states = await this.clients.disabledStates([...new Set(rows.map((c) => c.clientId))]);
    reply.header('Cache-Control', 'no-store');
    return reply.view('apps.eta', {
      title: 'Connected apps',
      notice: done === 'revoked' ? 'Access was revoked.' : undefined,
      apps: rows.map((c) => ({
        id: c._id.toHexString(),
        clientId: c.clientId,
        status: !states.has(c.clientId) ? 'removed' : states.get(c.clientId) ? 'disabled' : '',
        resource: c.resource,
        scopes: c.grantedScopes.join(' '),
        grantedAt: new Date(c.grantedAt).toISOString(),
        updatedAt: new Date(c.updatedAt).toISOString(),
      })),
      csrf: this.csrf.token(this.ui.identity(req, reply)),
    });
  }

  /**
   * Revoke one of the user's consents. No re-authentication (ASVS 10.7.3; revoking is the safe
   * direction). Consent first, then its refresh families, also when already revoked (DEBT-151: a
   * retry finishes a failed sweep). An access token already issued lives until its expiry.
   */
  @Post('/account/apps/revoke')
  @UseGuards(CsrfGuard)
  async revokeApp(
    @Body() body: RevokeConsentDto,
    @Req() req: HttpRequest,
    @Res() reply: HttpReply,
  ) {
    const session = await this.ui.liveSession(req, reply);
    if (!session) return reply.redirect('/login?returnTo=%2Faccount%2Fapps', 303);
    await this.ui.limit('account_apps', req, session.userId);
    const id = body.consent_id ?? '';
    const now = new Date();
    const revoked = OBJECT_ID_HEX.test(id)
      ? await this.consents.revokeOwn(id, session.userId, now)
      : null;
    const base = {
      actorType: 'user' as const,
      actorId: session.userId,
      action: AuditAction.OAUTH_CONSENT_REVOKED,
      targetType: 'user',
      targetId: session.userId,
    };
    if (!revoked) {
      // The submitted id is never recorded: it may be another user's consent.
      await this.audit.record({
        ...base,
        result: 'failure',
        reason: 'not_found',
        metadata: { via: 'self' },
      });
      reply.header('Cache-Control', 'no-store');
      reply.status(HttpStatus.NOT_FOUND);
      return reply.view('message.eta', {
        title: 'Not found',
        message: 'This app has no access to revoke.',
        actionUrl: '/account/apps',
        actionLabel: 'Back to connected apps',
      });
    }
    const { alreadyRevoked } = revoked;
    const { clientId, resource } = revoked.consent;
    let count: number;
    try {
      count = await this.refreshTokens.revokeForConsent(session.userId, clientId, resource, now);
    } catch (err) {
      await this.audit
        .record({
          ...base,
          clientId,
          result: 'failure',
          reason: 'family_sweep_failed',
          metadata: { clientId, resource, alreadyRevoked, via: 'self' },
        })
        .catch(() => undefined);
      throw err;
    }
    await this.audit.record({
      ...base,
      clientId,
      result: 'success',
      metadata: { clientId, resource, count, alreadyRevoked, via: 'self' },
    });
    return reply.redirect('/account/apps?done=revoked', 303);
  }

  /** D88.18 through the shared helper (DEBT-638): fresh session or the current password. */
  private reauth(req: HttpRequest, session: Session, password: string | undefined, scope: string) {
    const devices = scope === 'device' || scope === 'devices';
    return this.ui.reauth(req, session, password, {
      audit: {
        action: devices ? AuditAction.TRUSTED_DEVICE_REVOKED : AuditAction.SESSION_REVOKED,
        targetType: devices ? 'device' : 'session',
        metadata: { scope, via: 'self' },
      },
      noPasswordMessage: NO_PASSWORD_REAUTH,
    });
  }

  private async render(
    req: HttpRequest,
    reply: HttpReply,
    session: Session,
    extra: { notice?: string; error?: string },
    status: number = HttpStatus.OK,
  ) {
    const [all, trusted, hasPassword] = await Promise.all([
      this.sessions.listByUser(session.userId),
      this.loginThrottle.listTrusted(session.userId),
      this.auth.hasPassword(session.userId),
    ]);
    const fresh = session.authTime >= Date.now() - ACCOUNT_REAUTH_WINDOW_MS;
    const thisDevice = this.loginThrottle.deviceHash(req);
    const rows = all
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_SESSIONS)
      .map((s) => ({
        ref: s.ref,
        label: s.device?.label ?? 'Unknown device',
        method:
          (s.amr?.includes('fed') ? 'Google/GitHub sign-in' : 'Password') +
          // D89.24: a session that passed the second factor.
          (s.amr?.includes('mfa') ? ' + authenticator' : ''),
        createdAt: new Date(s.createdAt).toISOString(),
        lastSeenAt: new Date(s.lastSeenAt).toISOString(),
        current: s.ref === session.ref,
      }));
    const devices = trusted.map((d) => ({
      device: d.device,
      since: new Date(d.trustedAt).toISOString().slice(0, 10),
      current: d.device === thisDevice,
    }));
    reply.header('Cache-Control', 'no-store');
    reply.status(status);
    return reply.view('sessions.eta', {
      title: 'Your sessions',
      sessions: rows,
      devices,
      // Which confirmation the forms carry: none (fresh), the password field, or none possible.
      reauth: fresh ? 'fresh' : hasPassword ? 'password' : 'impossible',
      noPasswordMessage: NO_PASSWORD_REAUTH,
      ...extra,
      csrf: this.csrf.token(this.ui.identity(req, reply)),
    });
  }

  private record(
    session: Session,
    action: AuditAction,
    result: 'success' | 'failure',
    extra: Partial<Pick<AuditEventInput, 'targetId' | 'reason' | 'metadata'>>,
  ) {
    return this.audit.record({
      actorType: 'user',
      actorId: session.userId,
      action,
      targetType: action === AuditAction.SESSION_REVOKED ? 'session' : 'device',
      result,
      ...extra,
    });
  }

  private async recordRevoked(
    session: Session,
    what: { scope: 'session'; targetId: string } | { scope: 'others'; count: number },
    tokenCount: number,
  ) {
    await this.record(session, AuditAction.SESSION_REVOKED, 'success', {
      ...(what.scope === 'session' ? { targetId: what.targetId } : {}),
      metadata:
        what.scope === 'session'
          ? { scope: 'session', via: 'self' }
          : { scope: 'others', via: 'self', count: what.count },
    });
    if (tokenCount > 0) {
      await this.record(session, AuditAction.TOKEN_REVOKED, 'success', {
        metadata: { scope: what.scope, via: 'self', count: tokenCount },
      });
    }
  }

  private notFound(reply: HttpReply) {
    reply.header('Cache-Control', 'no-store');
    reply.status(HttpStatus.NOT_FOUND);
    return reply.view('message.eta', {
      title: 'Not found',
      message: 'Nothing to sign out or forget here.',
      actionUrl: '/account/sessions',
      actionLabel: 'Back to your sessions',
    });
  }

  private done(reply: HttpReply, kind: keyof typeof DONE) {
    return reply.redirect(`/account/sessions?done=${kind}`, 303);
  }
}

const NO_PASSWORD_REAUTH =
  'To manage your sessions, sign out and sign in again, then come back within 5 minutes.';
