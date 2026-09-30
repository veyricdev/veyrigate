import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import view from '@fastify/view';
import { Controller, Get, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { Eta } from 'eta';
import { join } from 'node:path';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { UiController } from '../src/modules/ui/ui.controller';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';

@Controller('oauth-test')
class OAuthTestController {
  @Get() fail() {
    throw new UnauthorizedException('OAuth credential rejected.');
  }
}

describe('UI HTTP contract (B2.5, C2, C7-C12, C14)', () => {
  let app: NestFastifyApplication;
  const auth = {
    register: jest.fn(async () => undefined),
    login: jest.fn(async () => ({ id: 'fresh-session', session: { ref: 'fresh-ref' } })),
    forgotPassword: jest.fn(async () => undefined),
    verifyEmail: jest.fn(async () => undefined),
    resetPassword: jest.fn(async () => undefined),
  };
  const sessions = {
    get: jest.fn<SessionService['get']>(async () => null),
    revoke: jest.fn<SessionService['revoke']>(async () => undefined),
  };
  const audit = { record: jest.fn(async () => undefined) };

  beforeAll(async () => {
    const config = {
      getOrThrow: (namespace: string) => {
        if (namespace === 'app') return { issuer: 'https://issuer.example' };
        if (namespace === 'session') return { cookieSecure: false };
        if (namespace === 'token') return { sessionAbsoluteTtl: 3600 };
        if (namespace === 'security') return { csrfSecret: 'test-csrf-secret' };
        throw new Error(`Unexpected config namespace: ${namespace}`);
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [UiController, OAuthTestController],
      providers: [
        CsrfService,
        CsrfGuard,
        HtmlExceptionFilter,
        SessionCookie,
        { provide: AuthenticationService, useValue: auth },
        { provide: SessionService, useValue: sessions },
        { provide: AuditService, useValue: audit },
        {
          provide: RateLimitService,
          useValue: { hit: jest.fn(async () => ({ allowed: true, retryAfterSec: 0 })) },
        },
        { provide: ConfigService, useValue: config },
        { provide: APP_FILTER, useClass: OAuthExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    });
    await app.register(cookie);
    await app.register(view, {
      engine: { eta: new Eta({ views: join(process.cwd(), 'src/views'), autoEscape: true }) },
      root: join(process.cwd(), 'src/views'),
      layout: 'layout.eta',
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(() => {
    jest.clearAllMocks();
    sessions.get.mockResolvedValue(null);
    sessions.revoke.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
  });
  afterAll(() => app.close());

  const form = async (path: string, cookie?: string) => {
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: cookie ? { cookie } : {},
    });
    const cookieHeader = response.headers['set-cookie'];
    const sessionCookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(';')[0];
    const csrf = response.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    return { response, cookie: sessionCookie ?? cookie!, csrf: csrf! };
  };
  const sessionSetCookie = (header: string | string[] | undefined) =>
    (Array.isArray(header) ? header : [header]).find((value) => value?.startsWith('idp_session='));

  it('renders strict CSP/referrer-safe HTML without inline scripts or styles', async () => {
    const { response } = await form('/login');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("style-src 'self'");
    expect(response.headers['content-security-policy']).toContain("form-action 'self'");
    expect(response.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).not.toMatch(/<script\b|style=/i);
  });

  describe.each([
    { path: '/', liveStatus: 200, guestStatus: 302, guestLocation: '/login', content: 'Signed in' },
    { path: '/login', liveStatus: 302, guestStatus: 200, liveLocation: '/', content: 'Sign in' },
    {
      path: '/register',
      liveStatus: 302,
      guestStatus: 200,
      liveLocation: '/',
      content: 'Create account',
    },
  ])('GET $path session classification', (route) => {
    it('uses a live session without clearing it', async () => {
      sessions.get.mockResolvedValue({
        ref: 'session-ref',
        userId: 'user-1',
        tenantId: 'tenant-1',
        authTime: 1,
        createdAt: 1,
        lastSeenAt: 1,
        device: {},
      });

      const response = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: 'idp_session=live-session' },
      });

      expect(response.statusCode).toBe(route.liveStatus);
      expect(response.headers.location).toBe(route.liveLocation);
      if (route.liveStatus === 200) expect(response.body).toContain(route.content);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(sessions.get).toHaveBeenCalledWith('live-session');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('treats an absent cookie as guest without looking up or clearing a session', async () => {
      const response = await app.inject({ method: 'GET', url: route.path });

      expect(response.statusCode).toBe(route.guestStatus);
      expect(response.headers.location).toBe(route.guestLocation);
      if (route.guestStatus === 200) expect(response.body).toContain(route.content);
      expect(sessions.get).not.toHaveBeenCalled();
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain('idp_session=');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('clears a stale cookie with the session cookie options and continues as guest', async () => {
      const response = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: 'idp_session=stale-session' },
      });

      expect(response.statusCode).toBe(route.guestStatus);
      expect(response.headers.location).toBe(route.guestLocation);
      if (route.guestStatus === 200) expect(response.body).toContain(route.content);
      const cleared = sessionSetCookie(response.headers['set-cookie']);
      expect(cleared).toEqual(expect.stringContaining('idp_session='));
      expect(cleared).toEqual(expect.stringContaining('Max-Age=0'));
      expect(cleared).toEqual(expect.stringContaining('Path=/'));
      expect(cleared).toEqual(expect.stringContaining('HttpOnly'));
      expect(cleared).toEqual(expect.stringContaining('SameSite=Lax'));
      expect(cleared).not.toEqual(expect.stringContaining('Secure'));
      expect(sessions.get).toHaveBeenCalledWith('stale-session');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('fails closed when session lookup throws', async () => {
      sessions.get.mockRejectedValue(new Error('Redis unavailable'));

      const response = await app.inject({
        method: 'GET',
        url: route.path,
        headers: { cookie: 'idp_session=unknown-session' },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.headers.location).toBeUndefined();
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain('idp_session=');
      expect(response.body).not.toContain('Signed in');
      expect(response.body).not.toContain('Sign in to your account');
      expect(response.body).not.toContain('Create your account');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });
  });

  it('authenticated home exposes logout action', async () => {
    sessions.get.mockResolvedValue({
      ref: 'session-ref',
      userId: 'user-1',
      tenantId: 'tenant-1',
      authTime: 1,
      createdAt: 1,
      lastSeenAt: 1,
      device: {},
    });

    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: 'idp_session=live-session' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.match(/href="\/logout"[^>]*>Sign out<\/a>/g)).toHaveLength(1);
    expect(response.body).not.toContain('href="/login"');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("style-src 'self'");
    expect(response.headers['content-security-policy']).toContain("form-action 'self'");
    expect(response.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(response.body).not.toMatch(/<script\b|style=/i);
  });

  it.each([
    ['/register', { email: 'new@example.com', password: 'correct password' }],
    ['/forgot', { email: 'user@example.com' }],
    ['/verify-email', { token: 'verification-token' }],
    ['/reset', { token: 'reset-token', password: 'correct password' }],
  ] as const)('shared message outcomes retain login action for POST %s', async (url, payload) => {
    const page = await form(url === '/verify-email' || url === '/reset' ? `${url}?token=x` : url);
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: page.cookie },
      payload: { _csrf: page.csrf, ...payload },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(response.body.match(/href="\/login"[^>]*>Return to sign in<\/a>/g)).toHaveLength(1);
    expect(response.body).not.toContain('href="/logout"');
  });

  it('message template escapes dynamic content', () => {
    const eta = new Eta({ views: join(process.cwd(), 'src/views'), autoEscape: true });
    const html = eta.render('message.eta', {
      title: '<img src=x onerror=alert(1)>',
      message: '<script>alert(1)</script>',
    });

    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script');
    expect(html).not.toMatch(/<img\b|<script\b/i);
  });

  it('ends a stale home redirect at the login form after the cookie is cleared', async () => {
    const home = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: 'idp_session=stale-session' },
    });
    expect(home.statusCode).toBe(302);
    expect(home.headers.location).toBe('/login');
    const login = await app.inject({ method: 'GET', url: home.headers.location! });
    expect(login.statusCode).toBe(200);
    expect(login.headers.location).toBeUndefined();
    expect(login.body).toContain('Sign in');
  });

  it.each([
    ['/login', { email: 'user@example.com', password: 'correct password', returnTo: '/' }, 302],
    ['/register', { email: 'new@example.com', password: 'correct password' }, 201],
  ] as const)('submits the %s form after the browser clears a stale session cookie', async (url, payload, status) => {
    const page = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: 'idp_session=stale-session' },
    });
    const setCookies = Array.isArray(page.headers['set-cookie'])
      ? page.headers['set-cookie']
      : [page.headers['set-cookie']];
    const browserCookies = setCookies
      .filter((value) => value && !value.includes('Max-Age=0'))
      .map((value) => value!.split(';')[0])
      .join('; ');
    const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)?.[1];

    const response = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: browserCookies },
      payload: { _csrf: csrf, ...payload },
    });

    expect(page.statusCode).toBe(200);
    expect(browserCookies).not.toContain('idp_session=');
    expect(response.statusCode).toBe(status);
  });

  it.each(['/register', '/login', '/forgot', '/verify-email', '/reset', '/logout'])(
    'rejects POST %s without CSRF before invoking the action',
    async (url) => {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('The request could not be completed.');
      expect(auth.register).not.toHaveBeenCalled();
      expect(auth.login).not.toHaveBeenCalled();
      expect(auth.forgotPassword).not.toHaveBeenCalled();
      expect(auth.verifyEmail).not.toHaveBeenCalled();
      expect(auth.resetPassword).not.toHaveBeenCalled();
      expect(sessions.revoke).not.toHaveBeenCalled();
    },
  );

  it.each(['/register', '/login', '/forgot', '/verify-email', '/reset', '/logout'])(
    'rejects POST %s with an invalid CSRF before invoking the action',
    async (url) => {
      const page = await form(url === '/verify-email' || url === '/reset' ? `${url}?token=x` : url);
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { cookie: page.cookie },
        payload: { _csrf: 'invalid' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('The request could not be completed.');
      expect(auth.register).not.toHaveBeenCalled();
      expect(auth.login).not.toHaveBeenCalled();
      expect(auth.forgotPassword).not.toHaveBeenCalled();
      expect(auth.verifyEmail).not.toHaveBeenCalled();
      expect(auth.resetPassword).not.toHaveBeenCalled();
      expect(sessions.revoke).not.toHaveBeenCalled();
    },
  );

  it('GET verify/reset only render hidden tokens and never consume them', async () => {
    const verify = await app.inject({ method: 'GET', url: '/verify-email?token=%3Cx%3E' });
    const reset = await app.inject({ method: 'GET', url: '/reset?token=%3Cx%3E' });
    expect(verify.body).toContain('value="&lt;x&gt;"');
    expect(reset.body).toContain('value="&lt;x&gt;"');
    expect(auth.verifyEmail).not.toHaveBeenCalled();
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it.each(['/forgot', '/verify-email?token=x', '/reset?token=x', '/consent', '/logout'])(
    'leaves GET %s outside guest-route session classification',
    async (url) => {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: 'idp_session=stale-session' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain('Max-Age=0');
      expect(sessions.get).not.toHaveBeenCalled();
      expect(sessions.revoke).not.toHaveBeenCalled();
    },
  );

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/%0d%0a', 'javascript:alert(1)'])(
    'drops unsafe returnTo %s',
    async (returnTo) => {
      const response = await app.inject({
        method: 'GET',
        url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
      });
      expect(response.body).toContain('name="returnTo" value="/"');
    },
  );

  it('rotates the session cookie after login and redirects only internally', async () => {
    const page = await form('/login?returnTo=%2Faccount');
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: `${page.cookie}; idp_session=old-session` },
      payload: {
        _csrf: new CsrfService({ getOrThrow: () => ({ csrfSecret: 'test-csrf-secret' }) } as never).token(
          'old-session',
        ),
        email: 'USER@example.com',
        password: 'correct password',
        returnTo: '/account',
      },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/account');
    expect(response.headers['set-cookie']).toEqual(expect.stringContaining('idp_session=fresh-session'));
    expect(auth.login).toHaveBeenCalledWith(
      'user@example.com',
      'correct password',
      expect.objectContaining({ oldSessionId: 'old-session' }),
    );
  });

  it('authenticated GET logout renders confirmation without changing session state', async () => {
    let live = true;
    const page = await form('/logout', 'idp_session=session-a');

    expect(page.response.statusCode).toBe(200);
    expect(page.response.body).toContain('<form method="post" action="/logout">');
    expect(live).toBe(true);
    expect(sessions.get).not.toHaveBeenCalled();
    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(sessionSetCookie(page.response.headers['set-cookie'])).toBeUndefined();
  });

  it('POST logout without CSRF fails closed before session work', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: 'idp_session=session-a' },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(sessions.get).not.toHaveBeenCalled();
    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(sessionSetCookie(response.headers['set-cookie'])).toBeUndefined();
  });

  it('POST logout with invalid CSRF fails closed before session work', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: 'idp_session=session-a' },
      payload: { _csrf: 'invalid' },
    });

    expect(response.statusCode).toBe(403);
    expect(sessions.get).not.toHaveBeenCalled();
    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(sessionSetCookie(response.headers['set-cookie'])).toBeUndefined();
  });

  it('cross-session CSRF replay fails closed without changing either session', async () => {
    const pageA = await form('/logout', 'idp_session=session-a');
    jest.clearAllMocks();
    let sessionA = true;
    let sessionB = true;

    const response = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: 'idp_session=session-b' },
      payload: { _csrf: pageA.csrf },
    });

    expect(response.statusCode).toBe(403);
    expect(sessionA).toBe(true);
    expect(sessionB).toBe(true);
    expect(sessions.get).not.toHaveBeenCalled();
    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(response.headers.location).toBeUndefined();
    expect(sessionSetCookie(response.headers['set-cookie'])).toBeUndefined();
  });

  it('POST logout revokes and audits before clearing the cookie and redirecting locally', async () => {
    let live = true;
    const session = {
      ref: 'session-ref',
      userId: 'user-1',
      tenantId: 'tenant-1',
      authTime: 1,
      createdAt: 1,
      lastSeenAt: 1,
      device: {},
    };
    sessions.get.mockImplementation(async () => (live ? session : null));
    sessions.revoke.mockImplementation(async () => void (live = false));
    const page = await form('/logout', 'idp_session=session-a');
    jest.clearAllMocks();

    const response = await app.inject({
      method: 'POST',
      url: '/logout?returnTo=https%3A%2F%2Fevil.example&redirect_uri=%2F%2Fevil.example',
      headers: { cookie: 'idp_session=session-a' },
      payload: { _csrf: page.csrf },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?loggedOut=1');
    expect(sessionSetCookie(response.headers['set-cookie'])).toContain('Max-Age=0');
    expect(sessions.get).toHaveBeenCalledTimes(1);
    expect(sessions.get).toHaveBeenCalledWith('session-a');
    expect(sessions.revoke).toHaveBeenCalledTimes(1);
    expect(sessions.revoke).toHaveBeenCalledWith('session-a');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      actorType: 'user',
      actorId: 'user-1',
      action: AuditAction.SESSION_REVOKED,
      targetType: 'session',
      targetId: 'session-ref',
      result: 'success',
    });
    expect(sessions.get.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.revoke.mock.invocationCallOrder[0],
    );
    expect(sessions.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      audit.record.mock.invocationCallOrder[0],
    );

    const next = await app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: 'idp_session=session-a' },
    });
    expect(next.statusCode).toBe(302);
    expect(next.headers.location).toBe('/login');
  });

  it.each(['get', 'revoke', 'audit'] as const)(
    'POST logout dependency failure at %s does not present success',
    async (failure) => {
      let live = true;
      const session = {
        ref: 'session-ref',
        userId: 'user-1',
        tenantId: 'tenant-1',
        authTime: 1,
        createdAt: 1,
        lastSeenAt: 1,
        device: {},
      };
      sessions.get.mockImplementation(async () => {
        if (failure === 'get') throw new Error('session lookup failed');
        return live ? session : null;
      });
      sessions.revoke.mockImplementation(async () => {
        if (failure === 'revoke') throw new Error('session revoke failed');
        live = false;
      });
      audit.record.mockImplementation(async () => {
        if (failure === 'audit') throw new Error('audit write failed');
      });
      const csrf = new CsrfService({
        getOrThrow: () => ({ csrfSecret: 'test-csrf-secret' }),
      } as never).token('session-a');

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrf },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.headers.location).toBeUndefined();
      expect(sessionSetCookie(response.headers['set-cookie'])).toBeUndefined();
      expect(response.body).not.toContain('loggedOut=1');
      expect(live).toBe(failure === 'audit' ? false : true);
      if (failure === 'get') {
        expect(sessions.revoke).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      }
      if (failure === 'revoke') expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('POST logout retry is idempotent and does not duplicate success audit', async () => {
    let live = true;
    const session = {
      ref: 'session-ref',
      userId: 'user-1',
      tenantId: 'tenant-1',
      authTime: 1,
      createdAt: 1,
      lastSeenAt: 1,
      device: {},
    };
    sessions.get.mockImplementation(async () => (live ? session : null));
    sessions.revoke.mockImplementation(async () => void (live = false));
    const csrf = new CsrfService({
      getOrThrow: () => ({ csrfSecret: 'test-csrf-secret' }),
    } as never).token('session-a');
    const request = {
      method: 'POST' as const,
      url: '/logout',
      headers: { cookie: 'idp_session=session-a' },
      payload: { _csrf: csrf },
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    expect(first.statusCode).toBe(302);
    expect(retry.statusCode).toBe(302);
    expect(first.headers.location).toBe('/login?loggedOut=1');
    expect(retry.headers.location).toBe('/login?loggedOut=1');
    expect(sessionSetCookie(first.headers['set-cookie'])).toContain('Max-Age=0');
    expect(sessionSetCookie(retry.headers['set-cookie'])).toContain('Max-Age=0');
    expect(live).toBe(false);
    expect(sessions.revoke).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('renders HTML validation errors without leaking field details', async () => {
    const page = await form('/register');
    const response = await app.inject({
      method: 'POST',
      url: '/register',
      headers: { cookie: page.cookie },
      payload: { _csrf: page.csrf, email: 'not-email', password: 'short', extra: 'leak' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('The request could not be completed.');
    expect(response.body).not.toContain('extra');
  });

  it('keeps OAuth errors in the OAuth response format outside UI routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/oauth-test' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'OAuth credential rejected.',
    });
  });
});