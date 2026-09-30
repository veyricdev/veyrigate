import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import type { Model } from 'mongoose';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { RedisService } from '../src/database/redis/redis.service';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { MAILER, type MailMessage } from '../src/modules/mailer/mailer';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { UiController } from '../src/modules/ui/ui.controller';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-ui-auth-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

describe('UI authentication request flow on real Mongo and Redis', () => {
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let redis: IORedis;
  let users: UserService;
  let sessions: SessionService;
  let userModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  const messages: MailMessage[] = [];

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const config = {
      getOrThrow: (namespace: string) => {
        if (namespace === 'app') return { issuer: 'https://issuer.example' };
        if (namespace === 'session') return { cookieSecure: false };
        if (namespace === 'token') return { sessionIdleTtl: 3600, sessionAbsoluteTtl: 86400 };
        if (namespace === 'security')
          return { csrfSecret: 'e2e-csrf-secret', rateLimitMax: 20, rateLimitWindow: 60 };
        throw new Error(`Unexpected config namespace: ${namespace}`);
      },
    };
    moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(MONGO_URI), MongooseModule.forFeature(MODELS)],
      controllers: [UiController],
      providers: [
        AuthenticationService,
        UserService,
        UserTenantService,
        SessionService,
        SessionCookie,
        AuditService,
        RateLimitService,
        CsrfService,
        CsrfGuard,
        HtmlExceptionFilter,
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: MAILER, useValue: { send: async (message: MailMessage) => void messages.push(message) } },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    userModel = moduleRef.get(getModelToken('User'));
    auditModel = moduleRef.get(getModelToken('AuditLog'));
    await syncAllIndexes(userModel.db);
    users = moduleRef.get(UserService);
    sessions = moduleRef.get(SessionService);
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
  }, 30_000);

  afterAll(async () => {
    await userModel.db.dropDatabase();
    const keys = await redis.keys('rl:*');
    if (keys.length) await redis.del(...keys);
    await app.close();
  });

  const form = async (path: string, cookieHeader?: string) => {
    const response = await app.inject({
      method: 'GET',
      url: path,
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    });
    const setCookie = response.headers['set-cookie'];
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return {
      response,
      cookie: cookieValue?.split(';')[0] ?? cookieHeader!,
      csrf: response.body.match(/name="_csrf" value="([^"]+)"/)?.[1] as string,
    };
  };

  it('classifies live and stale sessions through real Redis on guest-facing routes', async () => {
    const live = await sessions.create('route-user', 'default-tenant');
    const liveCookie = `idp_session=${live.id}`;

    for (const [path, status, location] of [
      ['/', 200, undefined],
      ['/login', 302, '/'],
      ['/register', 302, '/'],
    ] as const) {
      const response = await app.inject({ method: 'GET', url: path, headers: { cookie: liveCookie } });
      expect(response.statusCode).toBe(status);
      expect(response.headers.location).toBe(location);
      expect(String(response.headers['set-cookie'] ?? '')).not.toContain('idp_session=');
    }

    for (const [path, status, location] of [
      ['/', 302, '/login'],
      ['/login', 200, undefined],
      ['/register', 200, undefined],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: path,
        headers: { cookie: 'idp_session=stale-session' },
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers.location).toBe(location);
      expect(String(response.headers['set-cookie'])).toContain('idp_session=');
      expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
    }
  });

  it('sends ten concurrent login requests through the controller and RateLimitService', async () => {
    const user = await users.create({ email: 'http-lock@example.com', password: 'correct password' });
    await users.verifyEmail(user.sub);
    const page = await form('/login');
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: '/login',
          headers: { cookie: page.cookie },
          payload: {
            _csrf: page.csrf,
            email: user.email,
            password: 'wrong password',
            returnTo: '/',
          },
        }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 401)).toBe(true);
    expect((await users.findById(user.sub))?.failedLoginCount).toBe(10);
  });

  it('registers, verifies without GET consumption, logs in, and revokes the real session on POST logout', async () => {
    const email = 'flow@example.com';
    let page = await form('/register');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/register',
          headers: { cookie: page.cookie },
          payload: { _csrf: page.csrf, email, password: 'correct password' },
        })
      ).statusCode,
    ).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));
    const link = messages.find((message) => message.to === email)?.text.match(/https:\/\/\S+/)?.[0];
    expect(link).toBeDefined();
    const token = new URL(link!).searchParams.get('token')!;

    page = await form(`/verify-email?token=${encodeURIComponent(token)}`);
    expect((await users.findByEmail(email))?.emailVerifiedAt).toBeUndefined();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/verify-email',
          headers: { cookie: page.cookie },
          payload: { _csrf: page.csrf, token },
        })
      ).statusCode,
    ).toBe(201);

    page = await form('/login');
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: page.cookie },
      payload: { _csrf: page.csrf, email, password: 'correct password', returnTo: '/' },
    });
    expect(login.statusCode).toBe(302);
    const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
    const sessionId = sessionCookie.split('=')[1];
    expect(await sessions.get(sessionId)).not.toBeNull();

    const logoutPage = await form('/logout', sessionCookie);
    expect(await sessions.get(sessionId)).not.toBeNull();
    const logout = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: sessionCookie },
      payload: { _csrf: logoutPage.csrf },
    });
    expect(logout.statusCode).toBe(302);
    expect(await sessions.get(sessionId)).toBeNull();
    expect(
      await auditModel.exists({ action: AuditAction.SESSION_REVOKED, result: 'success' }),
    ).not.toBeNull();
  });
});