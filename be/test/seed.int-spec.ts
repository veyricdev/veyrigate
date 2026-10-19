import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import mongoose, { Types, type Connection, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPassword } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import {
  buildFeAdminClient,
  readAdminSeedConfig,
  seedBootstrap,
  type AdminSeedConfig,
} from '../src/database/seed';
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

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-seed-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
// Test-only values for a throwaway int DB.
const ADMIN: AdminSeedConfig = { email: 'Seed-Admin@Example.com', password: 'seed-admin-pass-1' };
const COLLECTIONS = [
  'tenants',
  'resources',
  'users',
  'usertenants',
  'clients',
  'clientcredentials',
] as const;

describe('db:seed bootstrap (B6.4) on real Mongo', () => {
  let connection: Connection;
  let users: Model<Record<string, unknown>>;
  let members: Model<Record<string, unknown>>;
  let creds: Model<Record<string, unknown>>;

  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const c of COLLECTIONS) out[c] = await connection.collection(c).countDocuments({});
    return out;
  };
  const adminUser = () =>
    users.findOne({ email: 'seed-admin@example.com' }).select('+passwordHash').lean().exec();

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) connection.model(name, schema);
    await syncAllIndexes(connection);
    users = connection.model<Record<string, unknown>>('User');
    members = connection.model<Record<string, unknown>>('UserTenant');
    creds = connection.model<Record<string, unknown>>('ClientCredential');
  }, 30_000);

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const c of COLLECTIONS) await connection.collection(c).deleteMany({});
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('twice => identical document counts; secret returned once; credential unchanged on run 2', async () => {
    const first = await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    expect(typeof first.feAdminSecret).toBe('string');
    expect(first.feAdminSecret!.length).toBeGreaterThan(20);
    const after1 = await counts();
    const cred1 = await creds.find({ clientId: 'fe-admin' }).lean().exec();
    expect(cred1).toHaveLength(1);

    const second = await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    expect(second.feAdminSecret).toBeUndefined();
    expect(await counts()).toEqual(after1);
    expect(after1).toEqual({
      tenants: 1,
      resources: 3,
      users: 1,
      usertenants: 1,
      clients: 2,
      clientcredentials: 1,
    });
    const cred2 = await creds.find({ clientId: 'fe-admin' }).lean().exec();
    expect(cred2).toHaveLength(1);
    expect(cred2[0].secretHash).toBe(cred1[0].secretHash);
    expect(cred2[0].version).toBe(cred1[0].version);
    expect(await verifyPassword(cred1[0].secretHash as string, first.feAdminSecret!)).toBe(true);
  });

  it('seeds fe-admin, resource admin, tenant and the super_admin membership as specified', async () => {
    await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    const client = await connection
      .collection('clients')
      .findOne({ clientId: 'fe-admin' }, { projection: { _id: 0, createdAt: 0, updatedAt: 0 } });
    expect(client).toMatchObject(buildFeAdminClient());
    expect(client).toMatchObject({
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: ['http://localhost:3000/auth/callback'],
      allowedCorsOrigins: [],
      allowedResources: ['admin'],
    });
    expect(await connection.collection('resources').findOne({ resourceId: 'admin' })).toMatchObject(
      { identifier: ADMIN_AUD, scopes: ['admin.read', 'admin.write'] },
    );
    expect(await connection.collection('clients').countDocuments({ clientId: 'fe-sso-test' })).toBe(
      1,
    );
    expect(await connection.collection('tenants').findOne({ id: DEFAULT_TENANT_ID })).toBeTruthy();
    const user = await adminUser();
    expect(user!.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await verifyPassword(user!.passwordHash as string, ADMIN.password)).toBe(true);
    const member = await members.findOne({ userId: user!._id }).lean().exec();
    expect(member).toMatchObject({
      tenantId: DEFAULT_TENANT_ID,
      status: 'active',
      roles: ['super_admin'],
    });
  });

  it('re-run with a DIFFERENT password keeps the hash; a lock stays; emptied roles get super_admin back', async () => {
    await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    const before = await adminUser();
    const lockedUntil = new Date(Date.now() + 3_600_000);
    await users.updateOne({ _id: before!._id }, { $set: { lockedUntil, failedLoginCount: 7 } });
    await members.updateOne({ userId: before!._id }, { $set: { roles: [], status: 'suspended' } });

    await seedBootstrap(connection, { ...ADMIN, password: 'another-password-2' }, ISSUER, 'test');
    const after = await adminUser();
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(await verifyPassword(after!.passwordHash as string, 'another-password-2')).toBe(false);
    expect((after!.lockedUntil as Date).getTime()).toBe(lockedUntil.getTime());
    expect(after!.failedLoginCount).toBe(7);
    const member = await members.findOne({ userId: before!._id }).lean().exec();
    expect(member).toMatchObject({ status: 'active', roles: ['super_admin'] });
  });

  it('fe-admin is insert-only: API-edited config and a disable survive a re-run', async () => {
    await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    const disabledAt = new Date();
    await connection
      .collection('clients')
      .updateOne(
        { clientId: 'fe-admin' },
        { $set: { redirectUris: ['http://localhost:3001/cb'], disabledAt } },
      );
    await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    const client = await connection.collection('clients').findOne({ clientId: 'fe-admin' });
    expect(client!.redirectUris).toEqual(['http://localhost:3001/cb']);
    expect((client!.disabledAt as Date).getTime()).toBe(disabledAt.getTime());
  });

  it('a revoked-only fe-admin credential => a new secret is issued (documented recovery path)', async () => {
    await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    await creds.updateMany({ clientId: 'fe-admin' }, { $set: { revokedAt: new Date() } });
    const again = await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    expect(typeof again.feAdminSecret).toBe('string');
    expect(await creds.countDocuments({ clientId: 'fe-admin', revokedAt: null })).toBe(1);
  });

  it('existing admin user without a password => warn (email only), password not set', async () => {
    await users.create({ email: 'seed-admin@example.com' });
    const warn = console.warn as jest.Mock;
    await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    expect((await adminUser())!.passwordHash).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('seed-admin@example.com');
  });

  it('never logs the password or the secret (console + Nest Logger + stdout)', async () => {
    const sinks = [
      console.log as jest.Mock,
      console.warn as jest.Mock,
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
      jest.spyOn(console, 'info').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      jest.spyOn(Logger, 'log').mockImplementation(() => undefined),
      jest.spyOn(process.stdout, 'write'),
    ];
    const { feAdminSecret } = await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    await users.updateOne({}, { $unset: { passwordHash: 1 } }); // force the warn path too
    await seedBootstrap(connection, ADMIN, ISSUER, 'test');
    const text = sinks.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(ADMIN.password);
    expect(text).not.toContain(feAdminSecret!);
  });

  it('NODE_ENV production / unset / empty => throws BEFORE any write (0 documents)', async () => {
    for (const env of ['production', undefined, '', 'staging']) {
      await expect(seedBootstrap(connection, ADMIN, ISSUER, env)).rejects.toThrow(/NODE_ENV/);
    }
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
  });

  it('admin identifier already registered under resourceId adm2 => throws; no fe-admin, no credential', async () => {
    await connection
      .collection('resources')
      .insertOne({ resourceId: 'adm2', identifier: ADMIN_AUD, scopes: [] });
    await expect(seedBootstrap(connection, ADMIN, ISSUER, 'test')).rejects.toThrow(
      /resource 'admin'/,
    );
    expect(await connection.collection('clients').countDocuments({ clientId: 'fe-admin' })).toBe(0);
    expect(await creds.countDocuments({})).toBe(0);
    expect(await users.countDocuments({})).toBe(0);
  });

  describe('re-point guard (run 30 retry 1: DEBT-137 via seed)', () => {
    const LEGACY = `${ISSUER}/legacy-api/`;
    const insertClient = (clientId: string, clientType: 'public' | 'confidential') =>
      connection.collection('clients').insertOne({
        clientId,
        clientType,
        tokenEndpointAuthMethod: clientType === 'public' ? 'none' : 'client_secret_basic',
        grantTypes: ['authorization_code'],
        redirectUris: ['http://localhost:5174/cb'],
        postLogoutRedirectUris: [],
        allowedCorsOrigins: [],
        allowedResources: ['admin'],
        scopes: ['openid'],
        tenantId: DEFAULT_TENANT_ID,
      });
    const expectRefusedNoWrite = async (identifierBefore: string | null) => {
      await expect(seedBootstrap(connection, ADMIN, ISSUER, 'test')).rejects.toThrow(
        /refusing to point resource 'admin'/,
      );
      const admin = await connection.collection('resources').findOne({ resourceId: 'admin' });
      expect(admin?.identifier ?? null).toBe(identifierBefore);
      expect(await connection.collection('tenants').countDocuments({})).toBe(0);
      expect(await users.countDocuments({})).toBe(0);
      expect(await connection.collection('clients').countDocuments({ clientId: 'fe-admin' })).toBe(
        0,
      );
      expect(await creds.countDocuments({ clientId: 'fe-admin' })).toBe(0);
    };

    it('legacy `admin` + PUBLIC referrer => refused before any write', async () => {
      await connection
        .collection('resources')
        .insertOne({ resourceId: 'admin', identifier: LEGACY, scopes: [] });
      await insertClient('ta-spa', 'public');
      await expectRefusedNoWrite(LEGACY);
    });

    it('legacy `admin` + CONFIDENTIAL referrer => refused (its secret stays non-admin)', async () => {
      await connection
        .collection('resources')
        .insertOne({ resourceId: 'admin', identifier: LEGACY, scopes: [] });
      await insertClient('ta-bff', 'confidential');
      await expectRefusedNoWrite(LEGACY);
    });

    it('no `admin` resource but a dangling reference => refused (the upsert would create it)', async () => {
      await insertClient('ta-spa', 'public');
      await expectRefusedNoWrite(null);
    });

    it('legacy (non-admin) `admin` referenced only by fe-admin => refused (fe-admin was tenant-editable)', async () => {
      await connection
        .collection('resources')
        .insertOne({ resourceId: 'admin', identifier: LEGACY, scopes: [] });
      await insertClient('fe-admin', 'confidential');
      await expect(seedBootstrap(connection, ADMIN, ISSUER, 'test')).rejects.toThrow(
        /client fe-admin already references it/,
      );
    });

    it('ISSUER change with another client on `admin` => refused; fe-admin alone => re-pointed', async () => {
      await seedBootstrap(connection, ADMIN, 'http://localhost:4100', 'test');
      await insertClient('other-admin-bff', 'confidential');
      await expect(seedBootstrap(connection, ADMIN, ISSUER, 'test')).rejects.toThrow(
        /client other-admin-bff/,
      );
      expect(
        (await connection.collection('resources').findOne({ resourceId: 'admin' }))?.identifier,
      ).toBe(adminResourceIdentifier('http://localhost:4100'));
      await connection.collection('clients').deleteOne({ clientId: 'other-admin-bff' });
      await seedBootstrap(connection, ADMIN, ISSUER, 'test');
      expect(
        (await connection.collection('resources').findOne({ resourceId: 'admin' }))?.identifier,
      ).toBe(ADMIN_AUD);
    });

    it('already pointed at the admin identifier => other referrers are not a reason to refuse', async () => {
      await seedBootstrap(connection, ADMIN, ISSUER, 'test');
      await insertClient('other-admin-bff', 'confidential');
      await expect(seedBootstrap(connection, ADMIN, ISSUER, 'test')).resolves.toEqual({});
    });
  });

  it('readAdminSeedConfig: missing/invalid env throws naming the variable, never the password', () => {
    expect(() => readAdminSeedConfig({ ADMIN_SEED_PASSWORD: 'x'.repeat(12) })).toThrow(
      /ADMIN_SEED_EMAIL is required/,
    );
    expect(() =>
      readAdminSeedConfig({
        ADMIN_SEED_EMAIL: 'not-an-email',
        ADMIN_SEED_PASSWORD: 'x'.repeat(12),
      }),
    ).toThrow(/ADMIN_SEED_EMAIL must be a valid email/);
    expect(() => readAdminSeedConfig({ ADMIN_SEED_EMAIL: 'a@example.com' })).toThrow(
      /ADMIN_SEED_PASSWORD is required/,
    );
    const short = 'Sh0rt-pass!'; // 11 chars
    expect(short).toHaveLength(11);
    let msg = '';
    try {
      readAdminSeedConfig({ ADMIN_SEED_EMAIL: 'a@example.com', ADMIN_SEED_PASSWORD: short });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/ADMIN_SEED_PASSWORD must be between 12 and 128 characters/);
    expect(msg).not.toContain(short);
    expect(() =>
      readAdminSeedConfig({
        ADMIN_SEED_EMAIL: 'a@example.com',
        ADMIN_SEED_PASSWORD: 'x'.repeat(129),
      }),
    ).toThrow(/between 12 and 128/);
    expect(
      readAdminSeedConfig({
        ADMIN_SEED_EMAIL: 'a@example.com',
        ADMIN_SEED_PASSWORD: 'x'.repeat(12),
      }),
    ).toEqual({ email: 'a@example.com', password: 'x'.repeat(12) });
  });
});

describe('db:seed: seeded admin logs in, fe-admin gets aud=admin, /admin/me 200 super_admin', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let secret = '';
  let adminId = '';
  const REDIRECT = 'http://localhost:3000/auth/callback';
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
    secret = (await seedBootstrap(db, ADMIN, ISSUER, 'test')).feAdminSecret!;
    jest.restoreAllMocks();
    const user = await db.collection('users').findOne({ email: 'seed-admin@example.com' });
    adminId = (user!._id as Types.ObjectId).toHexString();
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

  it('login -> /authorize (resource admin, PKCE) -> consent -> /token (basic) -> GET /admin/me 200', async () => {
    const authorize = `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'fe-admin',
      redirect_uri: REDIRECT,
      scope: 'openid admin.read admin.write',
      resource: ADMIN_AUD,
      state: 'rp-state',
      nonce: 'rp-nonce',
      code_challenge: deriveS256Challenge(VERIFIER),
      code_challenge_method: 'S256',
    }).toString()}`;
    const start = await app.inject({ method: 'GET', url: authorize });
    expect(start.statusCode).toBe(302);
    const loginUrl = new URL(start.headers['location'] as string, ISSUER);
    expect(loginUrl.pathname).toBe('/login');
    const returnTo = loginUrl.searchParams.get('returnTo')!;

    const page = await app.inject({ method: 'GET', url: `${loginUrl.pathname}${loginUrl.search}` });
    expect(page.statusCode).toBe(200);
    const anon = cookieOf(page.headers, 'idp_csrf')!;
    const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: anon },
      payload: { _csrf: csrf, email: ADMIN.email, password: ADMIN.password, returnTo },
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers['location']).toBe(returnTo);
    const session = cookieOf(login.headers, SESSION_COOKIE)!;
    expect(session).toBeTruthy();

    const consentPage = await app.inject({
      method: 'GET',
      url: returnTo,
      headers: { cookie: session },
    });
    expect(consentPage.statusCode).toBe(200);
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
    expect(consent.statusCode).toBe(302);
    const callback = new URL(consent.headers['location'] as string);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
    const code = callback.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const token = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`fe-admin:${secret}`).toString('base64'),
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const access = token.json().access_token as string;
    const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.aud).toBe(ADMIN_AUD);

    const me = await app.inject({
      method: 'GET',
      url: '/admin/me',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      sub: adminId,
      tenantId: DEFAULT_TENANT_ID,
      roles: ['super_admin'],
    });
  });

  it('a wrong fe-admin secret is refused at /token (secret really is the seeded one)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from('fe-admin:not-the-secret').toString('base64'),
      },
      payload: 'grant_type=authorization_code&code=x&redirect_uri=x&code_verifier=x',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
  });
});
