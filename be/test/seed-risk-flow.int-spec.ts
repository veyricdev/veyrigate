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
import { Types, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Run 30 QA (tester) — end-to-end proof for the seed re-point path of DEBT-137: a PUBLIC client
 * that references resourceId `admin` while `admin` has a non-admin identifier (reachable through the
 * API: super_admin `POST /admin/resources` + tenant_admin `POST /admin/clients`, or a seed under a
 * previous ISSUER) becomes admin-capable once `db:seed` re-points `admin` to the admin identifier.
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-seedflow-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
// Test-only values for a throwaway int DB.
const ADMIN: AdminSeedConfig = { email: 'flow-admin@example.com', password: 'flow-admin-pass-1' };

describe('db:seed re-point: a public client must never obtain aud=admin (DEBT-137 rule A)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let seedError: Error | undefined;
  const SPA = 'ta-public-spa';
  const SPA_REDIRECT = 'http://localhost:5174/cb';
  let adminId = '';
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

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

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-seed-int-'));
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

    const db = app.get<Model<unknown>>(getModelToken('Client')).db;
    await syncAllIndexes(db);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    // Preconditions reachable via the API before the seed: resource `admin` with a NON-admin
    // identifier, and a public SPA (tenant_admin-controlled redirect) that references it.
    await db.collection('resources').insertOne({
      resourceId: 'admin',
      identifier: `${ISSUER}/legacy-api/`,
      scopes: ['admin.read', 'admin.write'],
    });
    await db.collection('clients').insertOne({
      clientId: SPA,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code'],
      redirectUris: [SPA_REDIRECT],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: ['admin'],
      scopes: ['openid', 'admin.read', 'admin.write'],
      tenantId: DEFAULT_TENANT_ID,
    });
    seedError = await seedBootstrap(db, ADMIN, ISSUER, 'test').then(
      () => undefined,
      (e: Error) => e,
    );
    jest.restoreAllMocks();
    const user = await db.collection('users').findOne({ email: ADMIN.email });
    adminId = user ? (user._id as Types.ObjectId).toHexString() : '';
  }, 60_000);

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
      await app.get<Model<unknown>>(getModelToken('Client')).db.dropDatabase();
      await app.close();
    }
    redis?.disconnect();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('seeded super_admin authorizing the PUBLIC SPA with resource=admin never yields a usable aud=admin token', async () => {
    if (seedError) return; // the seed refused the re-point: invariant holds
    const authorize = `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: SPA,
      redirect_uri: SPA_REDIRECT,
      scope: 'openid admin.read admin.write',
      resource: ADMIN_AUD,
      state: 's',
      nonce: 'n',
      code_challenge: deriveS256Challenge(VERIFIER),
      code_challenge_method: 'S256',
    }).toString()}`;
    const start = await app.inject({ method: 'GET', url: authorize });
    if (start.statusCode !== 302) return; // refused at /authorize: invariant holds
    const loginUrl = new URL(start.headers['location'] as string, ISSUER);
    if (loginUrl.pathname !== '/login') return; // error redirect to the RP: invariant holds
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
    if (consentPage.statusCode !== 200) return;
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
    const code = new URL(consent.headers['location'] as string).searchParams.get('code');
    if (!code) return;
    // The attacker (owner of the SPA redirect) redeems the code: public client, no secret.
    const token = await app.inject({
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
    if (token.statusCode !== 200) return;
    const access = token.json().access_token as string;
    const me = await app.inject({
      method: 'GET',
      url: '/admin/me',
      headers: { authorization: `Bearer ${access}` },
    });
    // Invariant: a public client's token must never pass the admin API.
    expect({ me: me.statusCode, sub: adminId }).not.toEqual({ me: 200, sub: adminId });
  });
});
