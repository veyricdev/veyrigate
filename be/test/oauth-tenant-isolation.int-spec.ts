import { jest } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import { Types, type Connection, type Model } from 'mongoose';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import type { AuditEvent } from '../src/modules/security/audit/audit.types';
import { SESSION_COOKIE, SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-tenantiso-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `ti${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const REDIRECT = 'https://app.example.com/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const CLIENT_B = `${RUN}-b`; // client of tenant B
const CLIENT_D = `${RUN}-d`; // client of default-tenant

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'session') return { cookieSecure: false };
    if (ns === 'token')
      return { accessTokenTtl: 900, sessionIdleTtl: 3600, sessionAbsoluteTtl: 86400 };
    if (ns === 'security') return { csrfSecret: 'test-csrf-secret' };
    if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
    throw new Error(`Unexpected config namespace: ${ns}`);
  },
} as unknown as ConfigService;

const authorizeUrl = (clientId: string, extra = '') =>
  `/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'openid profile',
    state: 'rp-state',
    nonce: 'rp-nonce',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  }).toString()}${extra}`;

// Run 35 Task 2 (DEBT-116, spec §9.10/INV-24, matrix MT1/MT2/24b): a signed-in user gets a code or
// consent for a client only while an ACTIVE member of that client's tenant (from the client doc).
describe('OAuth tenant isolation at /authorize + POST /authorize/consent (MT1/MT2, INV-24)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let conn: Connection;
  let sessions: SessionService;
  let auditModel: Model<AuditEvent>;

  const get = (url: string, sessionId: string) =>
    app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: sessionId } });
  const sessionOf = async (userId: string) => (await sessions.create(userId, DEFAULT_TENANT_ID)).id;
  const countKeys = async () =>
    (await redis.keys('authz_code:*')).length + (await redis.keys('authz_ctx:*')).length;
  const consentsOf = (userId: string) =>
    conn.model('Consent').countDocuments({ userId: new Types.ObjectId(userId) });

  /** 302 to the trusted redirect_uri with access_denied + state + iss, and no code. */
  const expectAccessDenied = (res: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers['location'] as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('rp-state');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);
    expect(loc.searchParams.get('code')).toBeNull();
    // Exposure: no tenant or reason leaks into the RP redirect.
    expect(loc.toString()).not.toContain(TENANT_B);
    expect(loc.toString()).not.toContain('member');
  };

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [AuthorizeController],
      providers: [
        AuthorizeService,
        AuthorizeRequestContextService,
        AuthorizationCodeService,
        ConsentService,
        CsrfService,
        CsrfGuard,
        ClientService,
        ResourceService,
        SessionService,
        SessionCookie,
        AuditService,
        UserTenantService,
        HtmlExceptionFilter,
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(cookie);
    await app.register(view, {
      engine: { eta: new Eta({ views: join(process.cwd(), 'src/views'), autoEscape: true }) },
      root: join(process.cwd(), 'src/views'),
      layout: 'layout.eta',
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const clientModel = app.get<Model<Client>>(getModelToken('Client'));
    conn = clientModel.db;
    await syncAllIndexes(conn);
    auditModel = app.get<Model<AuditEvent>>(getModelToken('AuditLog'));
    sessions = app.get(SessionService);
    const clients = new ClientService(clientModel, cfg);
    for (const [clientId, tenantId] of [
      [CLIENT_B, TENANT_B],
      [CLIENT_D, DEFAULT_TENANT_ID],
    ]) {
      await clients.create({
        clientId,
        clientType: 'public',
        tokenEndpointAuthMethod: 'none',
        redirectUris: [REDIRECT],
        allowedResources: [],
        scopes: ['openid', 'profile'],
        tenantId,
      });
    }
  }, 30_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    if (app) await app.close();
  });

  it('MT1: member of tenant A only, client of tenant B => 302 access_denied, nothing written, audit not_member', async () => {
    const userA = await seedOAuthUser(conn, { tenantId: TENANT_A });
    const before = await countKeys();
    expectAccessDenied(await get(authorizeUrl(CLIENT_B), await sessionOf(userA)));
    expect(await countKeys()).toBe(before);
    expect(await consentsOf(userA)).toBe(0);
    const events = await auditModel
      .find({ action: AuditAction.OAUTH_AUTHORIZE, actorId: userA })
      .lean<AuditEvent[]>();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: 'failure',
      reason: 'not_member',
      tenantId: TENANT_B,
      clientId: CLIENT_B,
      metadata: { outcome: 'not_member' },
    });
  });

  it('MT1 + prompt=none => access_denied (not consent_required)', async () => {
    const userA = await seedOAuthUser(conn, { tenantId: TENANT_A });
    expectAccessDenied(await get(authorizeUrl(CLIENT_B, '&prompt=none'), await sessionOf(userA)));
  });

  it('MT1 with a still-valid consent for the client => access_denied, no code', async () => {
    const userA = await seedOAuthUser(conn, { tenantId: TENANT_A });
    await seedConsent(conn, { userId: userA, clientId: CLIENT_B, scopes: ['openid', 'profile'] });
    const before = await countKeys();
    expectAccessDenied(await get(authorizeUrl(CLIENT_B), await sessionOf(userA)));
    expect(await countKeys()).toBe(before);
  });

  it('SUSPENDED membership in the client tenant => access_denied', async () => {
    const suspended = await seedOAuthUser(conn, { tenantId: TENANT_B, status: 'suspended' });
    expectAccessDenied(await get(authorizeUrl(CLIENT_B), await sessionOf(suspended)));
  });

  it('control: ACTIVE member of tenant B => 200 consent screen, then approve => code', async () => {
    const userB = await seedOAuthUser(conn, { tenantId: TENANT_B });
    const sid = await sessionOf(userB);
    const page = await get(authorizeUrl(CLIENT_B), sid);
    expect(page.statusCode).toBe(200);
    const post = await app.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sid },
      payload: {
        _csrf: page.body.match(/name="_csrf" value="([^"]+)"/)![1],
        request_id: page.body.match(/name="request_id" value="([^"]+)"/)![1],
        approve: 'true',
      },
    });
    expect(post.statusCode).toBe(302);
    expect(new URL(post.headers['location'] as string).searchParams.get('code')).toBeTruthy();
  });

  it('MT2: membership suspended between consent render and POST approve => access_denied, no consent, no code', async () => {
    const userB = await seedOAuthUser(conn, { tenantId: TENANT_B });
    const sid = await sessionOf(userB);
    const page = await get(authorizeUrl(CLIENT_B), sid);
    expect(page.statusCode).toBe(200);
    await conn
      .model('UserTenant')
      .updateOne(
        { userId: new Types.ObjectId(userB), tenantId: TENANT_B },
        { $set: { status: 'suspended' } },
      );
    const codesBefore = (await redis.keys('authz_code:*')).length;
    const post = await app.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sid },
      payload: {
        _csrf: page.body.match(/name="_csrf" value="([^"]+)"/)![1],
        request_id: page.body.match(/name="request_id" value="([^"]+)"/)![1],
        approve: 'true',
      },
    });
    expectAccessDenied(post);
    expect(await consentsOf(userB)).toBe(0);
    expect((await redis.keys('authz_code:*')).length).toBe(codesBefore);
    const denied = await auditModel
      .find({ action: AuditAction.OAUTH_AUTHORIZE, actorId: userB, result: 'failure' })
      .lean<AuditEvent[]>();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ reason: 'not_member', tenantId: TENANT_B });
    expect(
      await auditModel.countDocuments({
        action: AuditAction.OAUTH_CONSENT_GRANTED,
        actorId: userB,
      }),
    ).toBe(0);
  });

  it('a new user (default-tenant only) is served by a default-tenant client; a tenant-B client never auto-grants membership', async () => {
    const fresh = await seedOAuthUser(conn, { tenantId: DEFAULT_TENANT_ID });
    const sid = await sessionOf(fresh);
    expect((await get(authorizeUrl(CLIENT_D), sid)).statusCode).toBe(200);
    const memberships = () =>
      conn.model('UserTenant').countDocuments({ userId: new Types.ObjectId(fresh) });
    expect(await memberships()).toBe(1);
    expectAccessDenied(await get(authorizeUrl(CLIENT_B), sid));
    expect(await memberships()).toBe(1);
    expect(
      await conn
        .model('UserTenant')
        .countDocuments({ userId: new Types.ObjectId(fresh), tenantId: TENANT_B }),
    ).toBe(0);
  });

  it('fail-closed: a DB error reading the membership => 500 error page, no redirect, nothing written', async () => {
    const userB = await seedOAuthUser(conn, { tenantId: TENANT_B });
    jest
      .spyOn(app.get(UserTenantService), 'isActiveMember')
      .mockRejectedValueOnce(new Error('mongo down secret-detail'));
    const before = await countKeys();
    const res = await get(authorizeUrl(CLIENT_B), await sessionOf(userB));
    expect(res.statusCode).toBe(500);
    expect(res.headers['location']).toBeUndefined();
    expect(res.body).not.toContain('secret-detail');
    expect(await countKeys()).toBe(before);
    expect(await consentsOf(userB)).toBe(0);
  });

  // Tester (run 35, DEBT-212): the RESUME path. Signed out => login context => (login happens) =>
  // `/authorize?request_id=` with a session of a non-member => access_denied built from the
  // consumed context (state from ctx), no code, the context is single-use.
  const startSignedOut = async (clientId: string, extra = '') => {
    const res = await app.inject({ method: 'GET', url: authorizeUrl(clientId, extra) });
    expect(res.statusCode).toBe(302);
    const login = new URL(res.headers['location'] as string, ISSUER);
    expect(login.pathname).toBe('/login');
    const returnTo = login.searchParams.get('returnTo')!;
    return returnTo;
  };

  it('DEBT-212: resume after login as a NON-member of the client tenant => access_denied (state from ctx), no code, context consumed', async () => {
    const returnTo = await startSignedOut(CLIENT_B);
    expect(returnTo).toMatch(/^\/authorize\?request_id=/);
    const userA = await seedOAuthUser(conn, { tenantId: TENANT_A });
    const sid = await sessionOf(userA);
    const codesBefore = (await redis.keys('authz_code:*')).length;
    const ctxBefore = (await redis.keys('authz_ctx:*')).length;
    expectAccessDenied(await get(returnTo, sid));
    expect((await redis.keys('authz_code:*')).length).toBe(codesBefore);
    // The login context was consumed and no consent context was created.
    expect((await redis.keys('authz_ctx:*')).length).toBe(ctxBefore - 1);
    expect(await consentsOf(userA)).toBe(0);
    const denied = await auditModel
      .find({ action: AuditAction.OAUTH_AUTHORIZE, actorId: userA })
      .lean<AuditEvent[]>();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      result: 'failure',
      reason: 'not_member',
      tenantId: TENANT_B,
    });
    // Replay of the same request_id => first-party page, never a second redirect or a code.
    const replay = await get(returnTo, sid);
    expect(replay.headers['location']).toBeUndefined();
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect((await redis.keys('authz_code:*')).length).toBe(codesBefore);
  });

  it('DEBT-212: resume after login as a non-member holding a still-valid consent => access_denied, no code', async () => {
    const returnTo = await startSignedOut(CLIENT_B);
    const userA = await seedOAuthUser(conn, { tenantId: TENANT_A });
    await seedConsent(conn, { userId: userA, clientId: CLIENT_B, scopes: ['openid', 'profile'] });
    const codesBefore = (await redis.keys('authz_code:*')).length;
    expectAccessDenied(await get(returnTo, await sessionOf(userA)));
    expect((await redis.keys('authz_code:*')).length).toBe(codesBefore);
  });

  it('control (resume): ACTIVE member of tenant B resumes => 200 consent screen', async () => {
    const returnTo = await startSignedOut(CLIENT_B);
    const userB = await seedOAuthUser(conn, { tenantId: TENANT_B });
    const res = await get(returnTo, await sessionOf(userB));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Authorize access');
  });

  it('MT1 + prompt=none + still-valid consent (covered branch) => access_denied, no code', async () => {
    const userA = await seedOAuthUser(conn, { tenantId: TENANT_A });
    await seedConsent(conn, { userId: userA, clientId: CLIENT_B, scopes: ['openid', 'profile'] });
    const before = await countKeys();
    expectAccessDenied(await get(authorizeUrl(CLIENT_B, '&prompt=none'), await sessionOf(userA)));
    expect(await countKeys()).toBe(before);
  });

  it('control: ACTIVE member of tenant B + prompt=none + covered consent => code (the check is not a blanket deny)', async () => {
    const userB = await seedOAuthUser(conn, { tenantId: TENANT_B });
    await seedConsent(conn, { userId: userB, clientId: CLIENT_B, scopes: ['openid', 'profile'] });
    const res = await get(authorizeUrl(CLIENT_B, '&prompt=none'), await sessionOf(userB));
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers['location'] as string);
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('rp-state');
  });
});
