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
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { LogoutService } from '../src/modules/oauth/logout/logout.service';
import {
  AuthorizeRequestContextService,
  type AuthorizeRequestContext,
} from '../src/modules/oauth/authorize/authorize-request-context.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { UiController } from '../src/modules/ui/ui.controller';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { buildCsp } from '../src/common/http/csp';
import { Logger } from '@nestjs/common';

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
    revokeAllForUser: jest.fn<SessionService['revokeAllForUser']>(async () => 0),
    clientsForSession: jest.fn<SessionService['clientsForSession']>(async () => []),
    clientsForUser: jest.fn<SessionService['clientsForUser']>(async () => []),
  };
  const refreshTokens = {
    revokeForSession: jest.fn(async () => 0),
    revokeAllForUser: jest.fn(async () => 0),
  };
  const logoutRp = {
    defaultRedirect: '/login?loggedOut=1',
    resolvePostLogoutRedirect: jest.fn(async () => '/login?loggedOut=1'),
    frontchannelIframes: jest.fn(async () => [] as string[]),
    frameSrcOrigins: jest.fn((srcs: readonly string[]) => [
      ...new Set(srcs.map((s) => new URL(s).origin)),
    ]),
  };
  const audit = { record: jest.fn(async () => undefined) };
  // DEBT-084: `GET /login` peeks the resumable context (non-consuming) to derive the CSP
  // `form-action` origin. Default: no context (keeps `form-action 'self'`).
  const authzContexts = {
    peek: jest.fn<AuthorizeRequestContextService['peek']>(async () => null),
  };

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
        { provide: RefreshTokenService, useValue: refreshTokens },
        { provide: LogoutService, useValue: logoutRp },
        { provide: AuthorizeRequestContextService, useValue: authzContexts },
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
    sessions.revokeAllForUser.mockResolvedValue(0);
    sessions.clientsForSession.mockResolvedValue([]);
    sessions.clientsForUser.mockResolvedValue([]);
    refreshTokens.revokeForSession.mockResolvedValue(0);
    refreshTokens.revokeAllForUser.mockResolvedValue(0);
    logoutRp.resolvePostLogoutRedirect.mockResolvedValue('/login?loggedOut=1');
    logoutRp.frontchannelIframes.mockResolvedValue([]);
    authzContexts.peek.mockResolvedValue(null);
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
    const sessionCookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(
      ';',
    )[0];
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

  describe('DEBT-084: per-response CSP form-action for redirect forms', () => {
    // Parse a CSP header value into a directive -> value map (same model as csp.spec.ts).
    const directives = (csp: string | undefined): Map<string, string> => {
      const map = new Map<string, string>();
      for (const part of (csp ?? '').split(';')) {
        const t = part.trim();
        if (!t) continue;
        const i = t.indexOf(' ');
        if (i === -1) map.set(t, '');
        else map.set(t.slice(0, i), t.slice(i + 1));
      }
      return map;
    };
    const ctx = (redirectUri: string): AuthorizeRequestContext => ({
      kind: 'login',
      clientId: 'rp',
      redirectUri,
      codeChallenge: 'x',
      scope: 'openid',
      createdAt: 0,
      expiresAt: 0,
    });

    // Acceptance #1: valid resume context => form-action gains exactly the client origin; every
    // other directive equals the global CSP measured from GET /register; no path/query leaks.
    it('GET /login with a valid request_id resume adds only the redirect_uri origin to form-action', async () => {
      authzContexts.peek.mockResolvedValue(ctx('https://rp.example/callback?x=1'));
      const returnTo = encodeURIComponent('/authorize?request_id=abc123');
      const { response } = await form(`/login?returnTo=${returnTo}`);
      expect(response.statusCode).toBe(200);
      const d = directives(response.headers['content-security-policy'] as string);
      expect(d.get('form-action')).toBe("'self' https://rp.example");
      // Only form-action differs from the global header.
      const base = directives(
        (await form('/register')).response.headers['content-security-policy'] as string,
      );
      for (const [name, value] of base) {
        if (name === 'form-action') continue;
        expect(d.get(name)).toBe(value);
      }
      expect([...d.keys()].sort()).toEqual([...base.keys()].sort());
      // No path/query of the redirect_uri in the header.
      expect(response.headers['content-security-policy']).not.toContain('/callback');
      expect(response.headers['content-security-policy']).not.toContain('x=1');
      expect(response.headers['cache-control']).toBe('no-store');
      // peek is a read, never consume.
      expect(authzContexts.peek).toHaveBeenCalledWith('abc123');
    });

    // Acceptance #2: negative returnTo shapes keep form-action 'self' verbatim.
    it.each([
      ['no returnTo', '/login'],
      ['returnTo=/', `/login?returnTo=${encodeURIComponent('/')}`],
      [
        'extra redirect_uri query',
        `/login?returnTo=${encodeURIComponent('/authorize?request_id=X&redirect_uri=https://evil.example')}`,
      ],
      ['consent path', `/login?returnTo=${encodeURIComponent('/authorize/consent?request_id=X')}`],
      ['raw redirect_uri query', `/login?redirect_uri=https://evil.example`],
    ])('GET /login (%s) keeps form-action self', async (_label, url) => {
      authzContexts.peek.mockResolvedValue(ctx('https://rp.example/callback'));
      const { response } = await form(url);
      expect(response.statusCode).toBe(200);
      const d = directives(response.headers['content-security-policy'] as string);
      expect(d.get('form-action')).toBe("'self'");
    });

    it('GET /login with an unknown/consumed request_id keeps form-action self', async () => {
      authzContexts.peek.mockResolvedValue(null); // missing/expired/consumed => null
      const returnTo = encodeURIComponent('/authorize?request_id=gone');
      const { response } = await form(`/login?returnTo=${returnTo}`);
      const d = directives(response.headers['content-security-policy'] as string);
      expect(d.get('form-action')).toBe("'self'");
    });

    // Acceptance #4: Redis failure during peek => fail-closed to 'self', still 200, no leak.
    // DEBT-087: also prove the fail-closed warning log never carries the request_id or returnTo
    // (the exposure budget). Spy on every Logger sink and scan all args for the secret id.
    it('GET /login fails closed to self when peek throws (Redis error), without logging request_id', async () => {
      const SECRET_ID = 'secret-id';
      const sinks = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
      const spies = sinks.map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
      try {
        authzContexts.peek.mockRejectedValue(new Error('redis down'));
        const returnTo = encodeURIComponent(`/authorize?request_id=${SECRET_ID}`);
        const { response } = await form(`/login?returnTo=${returnTo}`);
        expect(response.statusCode).toBe(200);
        const d = directives(response.headers['content-security-policy'] as string);
        expect(d.get('form-action')).toBe("'self'");

        // A warn MUST have fired (fail-closed path is reached)...
        const warn = spies[sinks.indexOf('warn')];
        expect(warn).toHaveBeenCalled();
        // ...but no log sink may contain the request_id or returnTo anywhere in its arguments.
        const allArgs = spies
          .flatMap((spy) => spy.mock.calls)
          .flat()
          .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
        for (const line of allArgs) {
          expect(line).not.toContain(SECRET_ID);
          expect(line).not.toContain('request_id');
          expect(line).not.toContain('returnTo');
          expect(line).not.toContain('/authorize');
        }
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    // Acceptance #7: legacy/hand-edited redirect URI with a header-splitting host => no origin added.
    it.each([
      ['semicolon host', 'https://evil.example;script-src *'],
      ['space host', 'https://evil.example x'],
      ['non-http scheme', 'app://evil/callback'],
    ])(
      'GET /login drops a legacy redirect_uri (%s) that could split the header',
      async (_label, uri) => {
        authzContexts.peek.mockResolvedValue(ctx(uri));
        const returnTo = encodeURIComponent('/authorize?request_id=legacy');
        const { response } = await form(`/login?returnTo=${returnTo}`);
        const d = directives(response.headers['content-security-policy'] as string);
        expect(d.get('form-action')).toBe("'self'");
        // Header never splits into an injected directive.
        expect(d.has('script-src')).toBe(true);
        expect(d.get('script-src')).toBe("'self'");
      },
    );

    // Acceptance #6: GET /logout adds the resolved RP origin only when it is a real target.
    it('GET /logout adds the resolved post-logout origin to form-action', async () => {
      logoutRp.resolvePostLogoutRedirect.mockResolvedValue('https://rp.example/signed-out?x=1');
      const { response } = await form('/logout');
      expect(response.statusCode).toBe(200);
      const d = directives(response.headers['content-security-policy'] as string);
      expect(d.get('form-action')).toBe("'self' https://rp.example");
      expect(response.headers['content-security-policy']).not.toContain('/signed-out');
    });

    it('GET /logout keeps form-action self when resolve falls back to the default redirect', async () => {
      logoutRp.resolvePostLogoutRedirect.mockResolvedValue('/login?loggedOut=1'); // == defaultRedirect
      const { response } = await form('/logout');
      const d = directives(response.headers['content-security-policy'] as string);
      expect(d.get('form-action')).toBe("'self'");
    });

    // Acceptance #8 (regression): other form pages keep the global CSP; buildCsp() === global.
    it.each(['/register', '/forgot', '/verify-email', '/reset'])(
      '%s keeps the global form-action self CSP',
      async (path) => {
        const { response } = await form(path);
        const d = directives(response.headers['content-security-policy'] as string);
        expect(d.get('form-action')).toBe("'self'");
      },
    );

    // DEBT-088: automate the byte-identity the senior verified by hand. The header helmet emits for
    // an ordinary page (GET /register) must equal `buildCsp()` with no arguments, directive for
    // directive and byte for byte. A helmet default-directive change would break this immediately
    // instead of silently drifting the 3 relaxed pages away from the global header.
    it('buildCsp() with no args is byte-identical to the global helmet header (DEBT-088)', async () => {
      const { response } = await form('/register');
      const global = response.headers['content-security-policy'] as string;
      expect(typeof global).toBe('string');
      expect(buildCsp()).toBe(global);
    });

    // DEBT-088: `/` (home → 302 to /login with no session) still carries the unrelaxed global CSP.
    it('GET / keeps form-action self on its response (DEBT-088)', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(302); // redirect to /login (no session in this suite)
      const d = directives(response.headers['content-security-policy'] as string);
      expect(d.get('form-action')).toBe("'self'");
    });

    // DEBT-088: the HTML error page (403 CSRF reject) keeps form-action self — never relaxed.
    it('HTML error page keeps form-action self (DEBT-088)', async () => {
      const response = await app.inject({ method: 'POST', url: '/login', payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain('The request could not be completed.');
      const d = directives(response.headers['content-security-policy'] as string);
      expect(d.get('form-action')).toBe("'self'");
    });
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
  ] as const)(
    'submits the %s form after the browser clears a stale session cookie',
    async (url, payload, status) => {
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
    },
  );

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

  it.each(['/forgot', '/verify-email?token=x', '/reset?token=x', '/logout'])(
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

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/%0d%0a',
    'javascript:alert(1)',
  ])('drops unsafe returnTo %s', async (returnTo) => {
    const response = await app.inject({
      method: 'GET',
      url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
    expect(response.body).toContain('name="returnTo" value="/"');
  });

  it('rotates the session cookie after login and redirects only internally', async () => {
    const page = await form('/login?returnTo=%2Faccount');
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: `${page.cookie}; idp_session=old-session` },
      payload: {
        _csrf: new CsrfService({
          getOrThrow: () => ({ csrfSecret: 'test-csrf-secret' }),
        } as never).token('old-session'),
        email: 'USER@example.com',
        password: 'correct password',
        returnTo: '/account',
      },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/account');
    expect(response.headers['set-cookie']).toEqual(
      expect.stringContaining('idp_session=fresh-session'),
    );
    expect(auth.login).toHaveBeenCalledWith(
      'user@example.com',
      'correct password',
      expect.objectContaining({ oldSessionId: 'old-session' }),
    );
  });

  it('authenticated GET logout renders confirmation without changing session state', async () => {
    const live = true;
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
    const sessionA = true;
    const sessionB = true;

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
    // Local logout revokes the refresh family of THIS session only, MARK then SWEEP (DEBT-051):
    // once before and once after the session is revoked+tombstoned, so a /token exchange racing the
    // logout cannot leave a live family (§9.8 / §15 inv. 29). Both calls use the same scope.
    expect(refreshTokens.revokeForSession).toHaveBeenCalledTimes(2);
    expect(refreshTokens.revokeForSession).toHaveBeenCalledWith(
      'user-1',
      'session-ref',
      expect.any(Date),
    );
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    expect(sessions.revoke).toHaveBeenCalledTimes(1);
    expect(sessions.revoke).toHaveBeenCalledWith('session-a');
    // No TOKEN_REVOKED audit when zero refresh tokens were revoked.
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      actorType: 'user',
      actorId: 'user-1',
      action: AuditAction.SESSION_REVOKED,
      targetType: 'session',
      targetId: 'session-ref',
      result: 'success',
      metadata: { scope: 'session' },
    });
    // Order: token revoke (MARK) -> session revoke -> token revoke (SWEEP) -> audit.
    expect(refreshTokens.revokeForSession.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.revoke.mock.invocationCallOrder[0],
    );
    expect(sessions.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      refreshTokens.revokeForSession.mock.invocationCallOrder[1],
    );
    expect(refreshTokens.revokeForSession.mock.invocationCallOrder[1]).toBeLessThan(
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

  it.each(['get', 'token', 'revoke', 'audit'] as const)(
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
      refreshTokens.revokeForSession.mockImplementation(async () => {
        if (failure === 'token') throw new Error('token revoke failed');
        return 0;
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
      // Token revoke runs before session revoke; a fault there never kills the session.
      expect(live).toBe(failure === 'audit' ? false : true);
      if (failure === 'get') {
        expect(refreshTokens.revokeForSession).not.toHaveBeenCalled();
        expect(sessions.revoke).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      }
      if (failure === 'token') {
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
    // First POST revokes; the retry sees no live session (session already gone) so it only clears
    // the cookie + redirects — no second destructive revoke, no duplicate success audit.
    expect(sessions.revoke).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  describe('B4.7 RP-initiated / global / front-channel logout', () => {
    const liveSession = {
      ref: 'session-ref',
      userId: 'user-1',
      tenantId: 'tenant-1',
      authTime: 1,
      createdAt: 1,
      lastSeenAt: 1,
      device: {},
    };
    const csrfFor = (identity: string) =>
      new CsrfService({
        getOrThrow: () => ({ csrfSecret: 'test-csrf-secret' }),
      } as never).token(identity);

    it('GET /logout renders the hidden RP params (validated URI) + no-store without destroying session state', async () => {
      // The GET only reflects a `post_logout_redirect_uri` that WOULD validate on POST (resolve
      // returns a non-default target); this mock stands in for that validated outcome.
      logoutRp.resolvePostLogoutRedirect.mockResolvedValue('https://rp.example/out?state=xyz');
      const response = await app.inject({
        method: 'GET',
        url: '/logout?id_token_hint=HINT&post_logout_redirect_uri=https%3A%2F%2Frp.example%2Fout&state=xyz&client_id=rp1',
        headers: { cookie: 'idp_session=session-a' },
      });
      expect(response.statusCode).toBe(200);
      // The page carries a JWT hint (PII) + CSRF token → must never be cached.
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain('name="id_token_hint" value="HINT"');
      expect(response.body).toContain(
        'name="post_logout_redirect_uri" value="https://rp.example/out"',
      );
      expect(response.body).toContain('name="state" value="xyz"');
      expect(response.body).toContain('name="client_id" value="rp1"');
      // GET resolves with NO session user (does not trust the cookie as the hint subject here).
      expect(logoutRp.resolvePostLogoutRedirect).toHaveBeenCalledWith(
        {
          idTokenHint: 'HINT',
          postLogoutRedirectUri: 'https://rp.example/out',
          state: 'xyz',
          clientId: 'rp1',
        },
        undefined,
      );
      // GET never touches session/token state.
      expect(sessions.revoke).not.toHaveBeenCalled();
      expect(refreshTokens.revokeForSession).not.toHaveBeenCalled();
    });

    it('GET /logout does NOT reflect a post_logout_redirect_uri that would fail validation', async () => {
      // resolve returns the default → the URI would be dropped on POST, so it must not appear in the
      // form (exposure budget: no unvalidated URI echoed into a response). Other params still ride.
      logoutRp.resolvePostLogoutRedirect.mockResolvedValue('/login?loggedOut=1');
      const response = await app.inject({
        method: 'GET',
        url: '/logout?id_token_hint=HINT&post_logout_redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&state=xyz',
        headers: { cookie: 'idp_session=session-a' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('evil.example');
      expect(response.body).not.toContain('name="post_logout_redirect_uri"');
      // The benign params (hint/state) still ride along for the POST to re-validate.
      expect(response.body).toContain('name="id_token_hint" value="HINT"');
      expect(response.body).toContain('name="state" value="xyz"');
    });

    it('POST local logout revokes only this session family and audits TOKEN_REVOKED when > 0', async () => {
      sessions.get.mockResolvedValue(liveSession);
      // First revoke kills the family (2); the SWEEP (DEBT-051) re-runs after the session MARK and
      // is idempotent — it revokes nothing more (0) in the no-race case. The audited count is the
      // sum (2 + 0), i.e. everything actually revoked across both passes (fold 🟡: cộng dồn).
      refreshTokens.revokeForSession.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      });

      expect(response.statusCode).toBe(302);
      expect(refreshTokens.revokeForSession).toHaveBeenCalledWith(
        'user-1',
        'session-ref',
        expect.any(Date),
      );
      expect(refreshTokens.revokeForSession).toHaveBeenCalledTimes(2); // first revoke + sweep
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith({
        actorType: 'user',
        actorId: 'user-1',
        action: AuditAction.TOKEN_REVOKED,
        result: 'success',
        metadata: { scope: 'session', count: 2 },
      });
    });

    it('SWEEP catches a family inserted after the first revoke (P=0, S=1) ⇒ count reflects the sweep, TOKEN_REVOKED still audited', async () => {
      // Race (fold 🟡#4): a `/token` exchange inserts a family AFTER the first family revoke but
      // before the session MARK, so the first revoke returns 0 and only the SWEEP revokes it (1).
      // The summed count must be 1 (not 0) so the TOKEN_REVOKED audit is written at all.
      sessions.get.mockResolvedValue(liveSession);
      refreshTokens.revokeForSession.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      });

      expect(response.statusCode).toBe(302);
      expect(refreshTokens.revokeForSession).toHaveBeenCalledTimes(2);
      expect(audit.record).toHaveBeenCalledWith({
        actorType: 'user',
        actorId: 'user-1',
        action: AuditAction.TOKEN_REVOKED,
        result: 'success',
        metadata: { scope: 'session', count: 1 },
      });
    });

    it('POST ?scope=all revokes every session + family and audits scope:all', async () => {
      sessions.get.mockResolvedValue(liveSession);
      sessions.revokeAllForUser.mockResolvedValue(3);
      // First revoke (5) + idempotent SWEEP (0): the audited count is the sum (fold 🟡: cộng dồn).
      refreshTokens.revokeAllForUser.mockResolvedValueOnce(5).mockResolvedValueOnce(0);

      const response = await app.inject({
        method: 'POST',
        url: '/logout?scope=all',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      });

      expect(response.statusCode).toBe(302);
      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('user-1', expect.any(Date));
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1');
      expect(refreshTokens.revokeForSession).not.toHaveBeenCalled();
      expect(sessions.revoke).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith({
        actorType: 'user',
        actorId: 'user-1',
        action: AuditAction.SESSION_REVOKED,
        targetType: 'session',
        targetId: 'session-ref',
        result: 'success',
        // Global scope records how many sessions were revoked (fold Task 3).
        metadata: { scope: 'all', count: 3 },
      });
      expect(audit.record).toHaveBeenCalledWith({
        actorType: 'user',
        actorId: 'user-1',
        action: AuditAction.TOKEN_REVOKED,
        result: 'success',
        metadata: { scope: 'all', count: 5 },
      });
    });

    it('fail-closed ordering: refreshTokens.revokeForSession throws → 5xx, session alive, no clear/audit; retry → 302', async () => {
      let live = true;
      sessions.get.mockImplementation(async () => (live ? liveSession : null));
      sessions.revoke.mockImplementation(async () => void (live = false));
      // Token revoke is the FIRST destructive step; a fault there must throw before the session is
      // touched, before any audit, and before the cookie is cleared (fold Task 3 ordering).
      refreshTokens.revokeForSession.mockRejectedValueOnce(new Error('token revoke failed'));

      const req = {
        method: 'POST' as const,
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      };
      const failed = await app.inject(req);

      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      expect(failed.headers.location).toBeUndefined();
      expect(sessionSetCookie(failed.headers['set-cookie'])).toBeUndefined();
      expect(failed.body).not.toContain('loggedOut=1');
      expect(live).toBe(true); // session still alive — token revoke ran first and failed
      expect(sessions.revoke).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();

      // Retry: the once-rejection is spent, so the whole sequence completes idempotently.
      const retry = await app.inject(req);
      expect(retry.statusCode).toBe(302);
      expect(retry.headers.location).toBe('/login?loggedOut=1');
      expect(sessionSetCookie(retry.headers['set-cookie'])).toContain('Max-Age=0');
      expect(live).toBe(false);
    });

    it('fail-closed ordering: sessions.revoke throws → 5xx, no audit/cookie clear; retry → 302', async () => {
      let revokeCalls = 0;
      let live = true;
      sessions.get.mockImplementation(async () => (live ? liveSession : null));
      // Session revoke runs AFTER token revoke; first attempt throws, so no audit + no cookie clear.
      sessions.revoke.mockImplementation(async () => {
        revokeCalls += 1;
        if (revokeCalls === 1) throw new Error('session revoke failed');
        live = false;
      });

      const req = {
        method: 'POST' as const,
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      };
      const failed = await app.inject(req);

      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      expect(failed.headers.location).toBeUndefined();
      expect(sessionSetCookie(failed.headers['set-cookie'])).toBeUndefined();
      expect(failed.body).not.toContain('loggedOut=1');
      expect(audit.record).not.toHaveBeenCalled(); // audit is strictly after session revoke

      const retry = await app.inject(req);
      expect(retry.statusCode).toBe(302);
      expect(retry.headers.location).toBe('/login?loggedOut=1');
      expect(sessionSetCookie(retry.headers['set-cookie'])).toContain('Max-Age=0');
      expect(live).toBe(false);
    });

    it('fail-OPEN after revoke: a fault resolving the redirect / iframes still logs the user out (default redirect)', async () => {
      sessions.get.mockResolvedValue(liveSession);
      // The destructive steps succeed; a fault in the POST-revoke resolve (legacy client data) must
      // NOT 5xx — the user is already logged out, so fall back to the default redirect, no iframe.
      logoutRp.resolvePostLogoutRedirect.mockRejectedValueOnce(
        new Error('bad stored redirect uri'),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?loggedOut=1');
      expect(sessionSetCookie(response.headers['set-cookie'])).toContain('Max-Age=0');
      expect(sessions.revoke).toHaveBeenCalled(); // revoke already happened (fail-open is post-revoke)
    });

    it('fail-OPEN with no session: a fault resolving the redirect still clears the cookie (default redirect, no 5xx)', async () => {
      // The cookie was already cleared, so a transient fault resolving the redirect (e.g. a Mongo
      // read in findByClientId) must NOT surface as a 5xx — fall back to the default redirect.
      logoutRp.resolvePostLogoutRedirect.mockRejectedValueOnce(new Error('transient mongo read'));

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?loggedOut=1');
      expect(sessionSetCookie(response.headers['set-cookie'])).toContain('Max-Age=0');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('POST redirects to a resolved post-logout URI with state', async () => {
      sessions.get.mockResolvedValue(liveSession);
      logoutRp.resolvePostLogoutRedirect.mockResolvedValue('https://rp.example/out?state=xyz');

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: {
          _csrf: csrfFor('session-a'),
          id_token_hint: 'HINT',
          post_logout_redirect_uri: 'https://rp.example/out',
          state: 'xyz',
        },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('https://rp.example/out?state=xyz');
      // POST re-resolves from the RAW params + the session user (never trusts the hidden field).
      expect(logoutRp.resolvePostLogoutRedirect).toHaveBeenCalledWith(
        {
          idTokenHint: 'HINT',
          postLogoutRedirectUri: 'https://rp.example/out',
          state: 'xyz',
          clientId: undefined,
        },
        'user-1',
      );
    });

    it('POST with a non-matching redirect falls back to the default (no open redirect)', async () => {
      sessions.get.mockResolvedValue(liveSession);
      logoutRp.resolvePostLogoutRedirect.mockResolvedValue('/login?loggedOut=1');

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: {
          _csrf: csrfFor('session-a'),
          id_token_hint: 'FORGED',
          post_logout_redirect_uri: 'https://evil.example/steal',
        },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?loggedOut=1');
      expect(response.headers.location).not.toContain('evil.example');
    });

    it('renders the front-channel page with iframes + relaxed frame-src only on that response', async () => {
      sessions.get.mockResolvedValue(liveSession);
      sessions.clientsForSession.mockResolvedValue(['rp1', 'rp2']);
      logoutRp.frontchannelIframes.mockResolvedValue([
        'https://rp1.example/fc?iss=https%3A%2F%2Fissuer.example',
        'https://rp2.example/fc?iss=https%3A%2F%2Fissuer.example',
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<iframe src="https://rp1.example/fc');
      expect(response.body).toContain('<iframe src="https://rp2.example/fc');
      expect(response.body).toContain('/assets/logout-redirect.js');
      expect(response.body).not.toMatch(/<script>[^<]/); // no inline script body
      const csp = response.headers['content-security-policy'];
      expect(csp).toContain('frame-src https://rp1.example https://rp2.example');
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // DEBT-088: the front-channel page relaxes ONLY frame-src — form-action stays 'self'.
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toMatch(/form-action 'self' \S/);
      expect(response.headers['cache-control']).toBe('no-store');

      // A later ordinary page keeps the default (iframe-free) CSP.
      const other = await app.inject({ method: 'GET', url: '/login' });
      expect(other.headers['content-security-policy']).not.toContain('frame-src https://rp1');
    });

    it('no front-channel RP → redirects straight through without the intermediate page', async () => {
      sessions.get.mockResolvedValue(liveSession);
      sessions.clientsForSession.mockResolvedValue([]);
      logoutRp.frontchannelIframes.mockResolvedValue([]);

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=session-a' },
        payload: { _csrf: csrfFor('session-a') },
      });

      expect(response.statusCode).toBe(302);
      expect(response.body).not.toContain('<iframe');
    });

    it('POST with no live session only clears the cookie and redirects (idempotent)', async () => {
      sessions.get.mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/logout',
        headers: { cookie: 'idp_session=gone' },
        payload: { _csrf: csrfFor('gone') },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login?loggedOut=1');
      expect(sessionSetCookie(response.headers['set-cookie'])).toContain('Max-Age=0');
      expect(refreshTokens.revokeForSession).not.toHaveBeenCalled();
      expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
      expect(sessions.revoke).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
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
