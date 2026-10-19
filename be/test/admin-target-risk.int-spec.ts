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
 * Run 30 retest (tester): variants of the DEBT-172 runtime guard not covered by
 * admin-public-client.int-spec — unknown/odd `clientType` values (fail-closed), the auto-approve
 * path (consent already stored before run 30 + live session, with and without prompt=none),
 * a repeated `resource` parameter, and the seed re-point guard with a referrer in another tenant.
 *
 * Original header: DEBT-172 (run 30 retry 1): runtime guard — a PUBLIC client whose stored `allowedResources`
 * contains the admin resource (data written before run 30, a direct DB write, a seed re-point)
 * never obtains `aud=admin`: refused at `/authorize`, at the consent POST, at the code exchange
 * and at the refresh grant. Each case has a non-admin control on the same client (the guard is
 * narrow, not a blanket refusal).
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-admintarget-risk-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
const DEMO_AUD = `${ISSUER}/demo/`;
// Test-only values for a throwaway int DB.
const ADMIN: AdminSeedConfig = { email: 'pub-admin@example.com', password: 'pub-admin-pass-1' };
const SPA = 'legacy-public-spa';
const SPA_REDIRECT = 'http://localhost:5174/cb';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('run 30 QA (tester): DEBT-172 runtime guard variants', () => {
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
    keyDir = await mkdtemp(join(tmpdir(), 'vg-admintarget-risk-int-'));
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

  const expectInvalidTargetToRp = (res: {
    statusCode: number;
    headers: Record<string, unknown>;
  }) => {
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['location'] as string, ISSUER);
    expect(location.searchParams.get('code')).toBeNull();
    expect(location.pathname).not.toBe('/login');
    expect(location.pathname).not.toMatch(/consent/);
    expect(`${location.origin}${location.pathname}`).toBe(SPA_REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_target');
  };

  it.each([
    ['field missing', undefined],
    ['empty string', ''],
    ["'Public'", 'Public'],
    ["'CONFIDENTIAL' (wrong case)", 'CONFIDENTIAL'],
    ["'confidential ' (trailing space)", 'confidential '],
  ])('clientType %s => /authorize resource=admin refused (fail-closed)', async (_label, value) => {
    await db
      .collection('clients')
      .updateOne(
        { clientId: SPA },
        value === undefined ? { $unset: { clientType: '' } } : { $set: { clientType: value } },
      );
    expectInvalidTargetToRp(await app.inject({ method: 'GET', url: authorizeUrl(ADMIN_AUD) }));
  });

  it('auto-approve path: consent stored before run 30 + live session => no code for admin (with and without prompt=none); control demo => code', async () => {
    const consents = app.get(ConsentService);
    for (const aud of [ADMIN_AUD, DEMO_AUD]) {
      await consents.grant(userId, SPA, aud, ['openid', 'admin.read'], consents.currentVersions(), [
        'openid',
        'offline_access',
        'admin.read',
      ]);
    }
    const { id } = await app.get(SessionService).create(userId, DEFAULT_TENANT_ID);
    const cookie = `${SESSION_COOKIE}=${id}`;
    for (const extra of ['', '&prompt=none']) {
      const res = await app.inject({
        method: 'GET',
        url: authorizeUrl(ADMIN_AUD) + extra,
        headers: { cookie },
      });
      expectInvalidTargetToRp(res);
    }
    const control = await app.inject({
      method: 'GET',
      url: authorizeUrl(DEMO_AUD),
      headers: { cookie },
    });
    expect(control.statusCode).toBe(302);
    expect(new URL(control.headers['location'] as string).searchParams.get('code')).toBeTruthy();
  });

  it('repeated resource parameter (demo + admin, admin + demo) => never a flow toward an admin code', async () => {
    const { id } = await app.get(SessionService).create(userId, DEFAULT_TENANT_ID);
    const cookie = `${SESSION_COOKIE}=${id}`;
    for (const order of [
      [DEMO_AUD, ADMIN_AUD],
      [ADMIN_AUD, DEMO_AUD],
    ]) {
      const url = authorizeUrl(order[0]) + `&resource=${encodeURIComponent(order[1])}`;
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      const location = res.headers['location'] as string | undefined;
      // Either refused outright, or (if a code is ever minted) it must not be bound to admin.
      const code = location ? new URL(location, ISSUER).searchParams.get('code') : null;
      if (code) {
        const ex = await exchange(code);
        if (ex.statusCode === 200) {
          const payload = JSON.parse(
            Buffer.from(ex.json().access_token.split('.')[1], 'base64url').toString(),
          );
          expect(payload.aud).not.toBe(ADMIN_AUD);
          expect([].concat(payload.aud)).not.toContain(ADMIN_AUD);
        }
      }
      expect(res.statusCode).toBeLessThan(500);
    }
  });

  it('seed re-point guard: a public client of ANOTHER tenant referencing `admin` (foreign identifier) => seed throws, nothing written', async () => {
    const mongoose = (await import('mongoose')).default;
    const uri = MONGO_URI.replace('vg-int-admintarget-risk-', 'vg-int-admintarget-risk-seed-');
    const conn = await mongoose
      .createConnection(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false })
      .asPromise();
    try {
      for (const { name, schema } of MODELS) conn.model(name, schema);
      await syncAllIndexes(conn);
      await conn.collection('resources').insertOne({
        resourceId: 'admin',
        identifier: 'https://api.other-tenant.example/',
        scopes: ['read'],
      });
      await conn.collection('clients').insertOne({
        clientId: 'other-tenant-spa',
        tenantId: 'tenant-b',
        clientType: 'public',
        allowedResources: ['admin'],
        redirectUris: ['https://spa.other.example/cb'],
      });
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await expect(seedBootstrap(conn, ADMIN, ISSUER, 'test')).rejects.toThrow(/refusing to point/);
      jest.restoreAllMocks();
      const names = (await conn.db!.listCollections().toArray()).map((c) => c.name).sort();
      const counts: Record<string, number> = {};
      for (const n of names) {
        const c = await conn.collection(n).countDocuments();
        if (c > 0) counts[n] = c;
      }
      expect(counts).toEqual({ clients: 1, resources: 1 });
      expect(
        (await conn.collection('resources').findOne({ resourceId: 'admin' }))?.identifier,
      ).toBe('https://api.other-tenant.example/');
    } finally {
      await conn.dropDatabase();
      await conn.close();
    }
  });
});
