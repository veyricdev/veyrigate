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
import { ClientService, type Client } from '../src/modules/clients/client.service';
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
import { seedCodeGrant } from './oauth-fixtures';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { LogoutService } from '../src/modules/oauth/logout/logout.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService, adminResourceIdentifier } from '../src/modules/oauth/token/token.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { UiController } from '../src/modules/ui/ui.controller';

/**
 * Run 31 QA (tester) — DEBT-174/173(3) over the REAL HTTP paths, for the 9 client shapes of the
 * `isAdminCapableClient` unit table (dev only covered `{public,none}`/`{confidential,none}` at
 * HTTP level). Per shape: `/authorize resource=admin`, `/token` code exchange, `/token` refresh
 * (+ no false TOKEN_REUSE_DETECTED, no burn) and `AdminTokenGuard` (`GET /admin/me`). The client
 * authenticates with the method matching its stored shape, so `{public, client_secret_basic}` and
 * `{<no type>, client_secret_basic}` pass client auth and must still be refused by the invariant.
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-admincapable-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
// Test-only values for a throwaway int DB.
const ADMIN: AdminSeedConfig = {
  email: 'matrix-admin@example.com',
  password: 'matrix-admin-pass-1',
};
const RP = 'qa-matrix-rp';
const RP_REDIRECT = 'http://localhost:5175/cb';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

type Shape = { clientType?: string; tokenEndpointAuthMethod?: string };
type Auth = 'basic' | 'post' | 'none';
/** [shape, auth used at /token, expected outcome of a token call for aud=admin]. */
type Row = [Shape, Auth, 'ok' | 'invalid_target' | 'invalid_client'];
const ROWS: Row[] = [
  [{ clientType: 'confidential', tokenEndpointAuthMethod: 'client_secret_basic' }, 'basic', 'ok'],
  [{ clientType: 'confidential', tokenEndpointAuthMethod: 'client_secret_post' }, 'post', 'ok'],
  [{ clientType: 'confidential', tokenEndpointAuthMethod: 'none' }, 'none', 'invalid_target'],
  [{ clientType: 'confidential' }, 'basic', 'invalid_client'],
  [
    { clientType: 'confidential', tokenEndpointAuthMethod: 'private_key_jwt' },
    'basic',
    'invalid_client',
  ],
  [
    { clientType: 'public', tokenEndpointAuthMethod: 'client_secret_basic' },
    'basic',
    'invalid_target',
  ],
  [{ clientType: 'public', tokenEndpointAuthMethod: 'none' }, 'none', 'invalid_target'],
  [{ tokenEndpointAuthMethod: 'client_secret_basic' }, 'basic', 'invalid_target'],
  [{}, 'none', 'invalid_client'],
];

describe('DEBT-174 HTTP matrix: 9 client shapes x 4 aud=admin gates (run 31 QA)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let db: Connection;
  let auditModel: Model<Record<string, unknown>>;
  let userId = '';
  let secret = '';

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

  const setShape = (shape: Shape) =>
    db
      .collection('clients')
      .updateOne(
        { clientId: RP },
        {
          $unset: { clientType: '', tokenEndpointAuthMethod: '' },
        },
      )
      .then(() => db.collection('clients').updateOne({ clientId: RP }, { $set: { ...shape } }));

  const authorizeUrl = (resource: string): string =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: RP,
      redirect_uri: RP_REDIRECT,
      scope: 'openid admin.read',
      resource,
      state: 's',
      nonce: 'n',
      code_challenge: deriveS256Challenge(VERIFIER),
      code_challenge_method: 'S256',
    }).toString()}`;

  const tokenCall = (auth: Auth, fields: Record<string, string>) => {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    const body: Record<string, string> = { ...fields };
    if (auth === 'basic') {
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(RP)}:${encodeURIComponent(secret)}`,
      ).toString('base64')}`;
    } else {
      body.client_id = RP;
      if (auth === 'post') body.client_secret = secret;
    }
    return app.inject({
      method: 'POST',
      url: '/token',
      headers,
      payload: new URLSearchParams(body).toString(),
    });
  };

  const newSessionRef = async () =>
    sha256((await app.get(SessionService).create(userId, DEFAULT_TENANT_ID)).id);

  const mintCode = async (): Promise<string> => {
    // Run 35: the code grant re-checks the owner's membership + consent (code minted directly).
    await seedCodeGrant(
      db,
      { userId, clientId: RP, resource: ADMIN_AUD, scope: 'openid admin.read' },
      DEFAULT_TENANT_ID,
    );
    const { code } = await app.get(AuthorizationCodeService).create({
      clientId: RP,
      redirectUri: RP_REDIRECT,
      codeChallenge: deriveS256Challenge(VERIFIER),
      resource: ADMIN_AUD,
      scope: 'openid admin.read',
      userId,
      authTime: Date.now(),
      sessionRef: await newSessionRef(),
    });
    return code;
  };

  const mintRefresh = () =>
    app.get(TokenService).insertRefreshToken({
      userId,
      clientId: RP,
      scope: ['openid', 'offline_access', 'admin.read'],
      resource: ADMIN_AUD,
      familyId: randomUUID(),
      parentId: null,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

  /** An aud=admin AT minted while the client WAS capable (the issuance gate reads the passed client). */
  const mintAdminAt = async (): Promise<string> => {
    const capable = {
      ...(await db.collection('clients').findOne({ clientId: RP })),
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
    } as unknown as Client;
    const { response } = await app.get(TokenService).issueForAuthorizationCode(capable, {
      clientId: RP,
      redirectUri: RP_REDIRECT,
      codeChallenge: deriveS256Challenge(VERIFIER),
      resource: ADMIN_AUD,
      scope: 'openid admin.read',
      userId,
      authTime: Date.now(),
      sessionRef: await newSessionRef(),
    });
    return response.access_token;
  };

  const reuseAlerts = () =>
    auditModel.countDocuments({ action: AuditAction.TOKEN_REUSE_DETECTED, clientId: RP });

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-admincapable-int-'));
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
    auditModel = app.get<Model<Record<string, unknown>>>(getModelToken('AuditLog'));
    await syncAllIndexes(db);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await seedBootstrap(db, ADMIN, ISSUER, 'test');
    jest.restoreAllMocks();
    const user = await db.collection('users').findOne({ email: ADMIN.email });
    userId = (user!._id as Types.ObjectId).toHexString();
    await db.collection('clients').insertOne({
      clientId: RP,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: [RP_REDIRECT],
      postLogoutRedirectUris: [],
      allowedCorsOrigins: [],
      allowedResources: ['admin', 'demo'],
      scopes: ['openid', 'offline_access', 'admin.read'],
      tenantId: DEFAULT_TENANT_ID,
    });
    secret = (await app.get(ClientCredentialService).createSecret(RP)).secret;
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
      await db.dropDatabase();
      await app.close();
    }
    redis?.disconnect();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it.each(ROWS)('shape %o (auth %s) => %s', async (shape, auth, expected) => {
    await setShape(shape);
    const capable = expected === 'ok';

    // 1. /authorize resource=admin (no client auth here: only the invariant decides).
    const authz = await app.inject({ method: 'GET', url: authorizeUrl(ADMIN_AUD) });
    expect(authz.statusCode).toBe(302);
    const loc = new URL(authz.headers['location'] as string, ISSUER);
    if (capable) {
      expect(loc.pathname).toBe('/login');
    } else {
      expect(`${loc.origin}${loc.pathname}`).toBe(RP_REDIRECT);
      expect(loc.searchParams.get('error')).toBe('invalid_target');
      expect(loc.searchParams.get('code')).toBeNull();
    }

    // 2. /token authorization_code (aud=admin code).
    const ex = await tokenCall(auth, {
      grant_type: 'authorization_code',
      code: await mintCode(),
      redirect_uri: RP_REDIRECT,
      code_verifier: VERIFIER,
    });
    if (capable) {
      expect(ex.statusCode).toBe(200);
      // The AT obtained over HTTP is accepted by the guard (positive control end-to-end).
      const me = await app.inject({
        method: 'GET',
        url: '/admin/me',
        headers: { authorization: `Bearer ${ex.json().access_token as string}` },
      });
      expect(me.statusCode).toBe(200);
    } else {
      expect(ex.statusCode).toBe(expected === 'invalid_client' ? 401 : 400);
      expect(ex.json()).toMatchObject({ error: expected });
      expect(ex.json().access_token).toBeUndefined();
    }

    // 3. /token refresh_token on an aud=admin family: twice (a retry must not look like reuse).
    const reuseBefore = await reuseAlerts();
    const rt = await mintRefresh();
    const r1 = await tokenCall(auth, { grant_type: 'refresh_token', refresh_token: rt.token });
    if (capable) {
      expect(r1.statusCode).toBe(200);
    } else {
      const r2 = await tokenCall(auth, { grant_type: 'refresh_token', refresh_token: rt.token });
      for (const r of [r1, r2]) {
        expect(r.statusCode).toBe(expected === 'invalid_client' ? 401 : 400);
        expect(r.json()).toMatchObject({
          error: expected === 'invalid_client' ? 'invalid_client' : 'invalid_grant',
        });
        expect(r.json().access_token).toBeUndefined();
      }
      const row = await db.collection('refreshtokens').findOne({ _id: rt._id });
      expect(row?.revokedAt ?? null).toBeNull(); // not burned
      expect(await db.collection('refreshtokens').countDocuments({ familyId: row!.familyId })).toBe(
        1,
      ); // not rotated
      expect(await reuseAlerts()).toBe(reuseBefore); // no false TOKEN_REUSE_DETECTED
    }

    // 4. AdminTokenGuard: an aud=admin AT minted while capable, used under the current shape.
    const me = await app.inject({
      method: 'GET',
      url: '/admin/me',
      headers: { authorization: `Bearer ${await mintAdminAt()}` },
    });
    if (capable) {
      expect(me.statusCode).toBe(200);
    } else {
      expect(me.statusCode).toBe(401);
      expect(me.json()).toMatchObject({ error: 'invalid_token' });
      expect(me.headers['www-authenticate']).toBeDefined();
    }
  });

  it('a REAL reuse still alarms after drift: RT rotated while capable, client drifts to {public,none}, replay of the rotated parent => TOKEN_REUSE_DETECTED + family revoked', async () => {
    await setShape({ clientType: 'confidential', tokenEndpointAuthMethod: 'client_secret_basic' });
    const rt = await mintRefresh();
    const first = await tokenCall('basic', {
      grant_type: 'refresh_token',
      refresh_token: rt.token,
    });
    expect(first.statusCode).toBe(200);
    const familyId = (await db.collection('refreshtokens').findOne({ _id: rt._id }))!.familyId;

    await setShape({ clientType: 'public', tokenEndpointAuthMethod: 'none' });
    const before = await reuseAlerts();
    const replay = await tokenCall('none', {
      grant_type: 'refresh_token',
      refresh_token: rt.token,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await reuseAlerts()).toBe(before + 1);
    const family = await db.collection('refreshtokens').find({ familyId }).toArray();
    expect(family.length).toBe(2);
    expect(family.every((d) => d.revokedAt)).toBe(true);
  });
});
