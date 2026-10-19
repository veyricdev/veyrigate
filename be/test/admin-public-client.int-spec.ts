import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import type { Connection, Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { seedBootstrap, type AdminSeedConfig } from '../src/database/seed';
import { AdminController } from '../src/modules/admin/admin.controller';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { MAILER } from '../src/modules/mailer/mailer';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { LogoutService } from '../src/modules/oauth/logout/logout.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService, adminResourceIdentifier } from '../src/modules/oauth/token/token.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SessionCookie, SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { UiController } from '../src/modules/ui/ui.controller';

/**
 * DEBT-172 (run 30 retry 1): runtime guard — a PUBLIC client whose stored `allowedResources`
 * contains the admin resource (data written before run 30, a direct DB write, a seed re-point)
 * never obtains `aud=admin`: refused at `/authorize`, at the consent POST, at the code exchange
 * and at the refresh grant. Each case has a non-admin control on the same client (the guard is
 * narrow, not a blanket refusal).
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-adminpublic-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
const DEMO_AUD = `${ISSUER}/demo/`;
// Test-only values for a throwaway int DB.
const ADMIN: AdminSeedConfig = { email: 'pub-admin@example.com', password: 'pub-admin-pass-1' };
const SPA = 'legacy-public-spa';
const SPA_REDIRECT = 'http://localhost:5174/cb';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('DEBT-172: a public client never obtains aud=admin (runtime guard)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let db: Connection;
  let userId = '';

  const cfg = {
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv: 'test', issuer: ISSUER };
      if (ns === 'session') return { cookieSecure: false };
      if (ns === 'token')
        return {
          accessTokenTtl: 900,
          refreshTokenTtl: 2592000,
          sessionIdleTtl: 3600,
          sessionAbsoluteTtl: 86400,
        };
      if (ns === 'security')
        return {
          csrfSecret: 'test-csrf-secret',
          rateLimitWindow: 60,
          rateLimitMax: 1000,
          clientAuthFailIpMax: 100000,
          clientAuthFailClientMax: 100000,
        };
      if (ns === 'client') return { secretGraceTtl: 60 };
      if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
      throw new Error(`Unexpected config namespace: ${ns}`);
    },
  } as unknown as ConfigService;

  const cookieOf = (headers: Record<string, unknown>, name: string): string | undefined =>
    ([] as string[])
      .concat((headers['set-cookie'] as string | string[] | undefined) ?? [])
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0];

  const authorizeUrl = (resource: string): string =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: SPA,
      redirect_uri: SPA_REDIRECT,
      scope: 'openid admin.read',
      resource,
      state: 's',
      nonce: 'n',
      code_challenge: deriveS256Challenge(VERIFIER),
      code_challenge_method: 'S256',
    }).toString()}`;

  const setClientType = (clientType: 'public' | 'confidential') =>
    db.collection('clients').updateOne(
      { clientId: SPA },
      {
        $set: {
          clientType,
          tokenEndpointAuthMethod: clientType === 'public' ? 'none' : 'client_secret_basic',
        },
      },
    );

  /** A live session + an authorization code bound to it (as `/authorize` would mint it). */
  const mintCode = async (resource: string): Promise<string> => {
    const { id } = await app.get(SessionService).create(userId, DEFAULT_TENANT_ID);
    const { code } = await app.get(AuthorizationCodeService).create({
      clientId: SPA,
      redirectUri: SPA_REDIRECT,
      codeChallenge: deriveS256Challenge(VERIFIER),
      resource,
      scope: 'openid admin.read',
      userId,
      authTime: Date.now(),
      sessionRef: sha256(id),
    });
    return code;
  };

  const exchange = (code: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: SPA,
        code,
        redirect_uri: SPA_REDIRECT,
        code_verifier: VERIFIER,
      }).toString(),
    });

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-adminpublic-int-'));
    const provider = new LocalKeyProvider(keyDir);
    await provider.init();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, { serverSelectionTimeoutMS: 5000 }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [AuthorizeController, TokenController, UiController, AdminController],
      providers: [
        AuthorizeService,
        AuthorizeRequestContextService,
        AuthorizationCodeService,
        ConsentService,
        CsrfService,
        CsrfGuard,
        TokenService,
        RefreshTokenService,
        ClientService,
        ClientCredentialService,
        ClientAuthenticationService,
        ClientCorsService,
        ResourceService,
        SessionService,
        SessionCookie,
        AuditService,
        RateLimitService,
        TokenSigner,
        TokenVerifier,
        HtmlExceptionFilter,
        AuthenticationService,
        UserService,
        UserTenantService,
        LogoutService,
        { provide: MAILER, useValue: { send: async () => undefined } },
        { provide: KEY_PROVIDER, useValue: provider },
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

    db = app.get<Model<unknown>>(getModelToken('Client')).db;
    await syncAllIndexes(db);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await seedBootstrap(db, ADMIN, ISSUER, 'test');
    jest.restoreAllMocks();
    const user = await db.collection('users').findOne({ email: ADMIN.email });
    userId = (user!._id as Types.ObjectId).toHexString();
    // Legacy state the admin API now refuses (rule A): a public client listing `admin`.
    await db.collection('clients').insertOne({
      clientId: SPA,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: [SPA_REDIRECT],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: ['admin', 'demo'],
      scopes: ['openid', 'offline_access', 'admin.read'],
      tenantId: DEFAULT_TENANT_ID,
    });
  }, 60_000);

  afterEach(() => setClientType('public'));

  afterAll(async () => {
    if (redis) {
      for (const p of [
        'authz_ctx:*',
        'authz_code:*',
        'sess:*',
        'sess_end:*',
        'user_sess:*',
        'sess_rp:*',
        'rl:*',
      ]) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
    }
    if (app) {
      await db.dropDatabase();
      await app.close();
    }
    redis?.disconnect();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('/authorize resource=admin => 302 to the RP with error=invalid_target (control: demo => /login)', async () => {
    const res = await app.inject({ method: 'GET', url: authorizeUrl(ADMIN_AUD) });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['location'] as string);
    expect(`${location.origin}${location.pathname}`).toBe(SPA_REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('code')).toBeNull();

    const control = await app.inject({ method: 'GET', url: authorizeUrl(DEMO_AUD) });
    expect(new URL(control.headers['location'] as string, ISSUER).pathname).toBe('/login');
  });

  it('consent POST: client turned public between render and approve => no code', async () => {
    await setClientType('confidential');
    const start = await app.inject({ method: 'GET', url: authorizeUrl(ADMIN_AUD) });
    const loginUrl = new URL(start.headers['location'] as string, ISSUER);
    expect(loginUrl.pathname).toBe('/login');
    const returnTo = loginUrl.searchParams.get('returnTo')!;
    const page = await app.inject({ method: 'GET', url: `${loginUrl.pathname}${loginUrl.search}` });
    const anon = cookieOf(page.headers, 'idp_csrf')!;
    const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: anon },
      payload: { _csrf: csrf, email: ADMIN.email, password: ADMIN.password, returnTo },
    });
    const session = cookieOf(login.headers, SESSION_COOKIE)!;
    const consentPage = await app.inject({
      method: 'GET',
      url: returnTo,
      headers: { cookie: session },
    });
    expect(consentPage.statusCode).toBe(200);

    await setClientType('public');
    const consent = await app.inject({
      method: 'POST',
      url: '/authorize/consent',
      headers: { cookie: session },
      payload: {
        _csrf: consentPage.body.match(/name="_csrf" value="([^"]+)"/)![1],
        request_id: consentPage.body.match(/name="request_id" value="([^"]+)"/)![1],
        approve: 'true',
      },
    });
    const location = (consent.headers['location'] as string | undefined) ?? '';
    expect(location).not.toContain('code=');
    expect(location.startsWith(SPA_REDIRECT)).toBe(false);
    expect(
      await db.collection('consents').countDocuments({ clientId: SPA, resource: ADMIN_AUD }),
    ).toBe(0);
  });

  it('/token code exchange: an aud=admin code for a public client => 400 invalid_target (control: demo => 200)', async () => {
    const res = await exchange(await mintCode(ADMIN_AUD));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_target' });
    expect(res.json().access_token).toBeUndefined();

    const control = await exchange(await mintCode(DEMO_AUD));
    expect(control.statusCode).toBe(200);
  });

  it('/token refresh: an aud=admin family of a public client => 400 invalid_grant, not burned (control: demo => 200)', async () => {
    const tokens = app.get(TokenService);
    const mint = (resource: string) =>
      tokens.insertRefreshToken({
        userId,
        clientId: SPA,
        scope: ['openid', 'offline_access', 'admin.read'],
        resource,
        familyId: randomUUID(),
        parentId: null,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const refresh = (value: string) =>
      app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: SPA,
          refresh_token: value,
        }).toString(),
      });

    const admin = await mint(ADMIN_AUD);
    const res = await refresh(admin.token);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
    const row = await db.collection('refreshtokens').findOne({ _id: admin._id });
    expect(row?.revokedAt ?? null).toBeNull();
    expect(await db.collection('refreshtokens').countDocuments({ resource: ADMIN_AUD })).toBe(1);

    const control = await refresh((await mint(DEMO_AUD)).token);
    expect(control.statusCode).toBe(200);
  });
});
