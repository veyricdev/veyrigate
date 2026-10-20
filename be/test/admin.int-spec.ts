import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Controller, Post, UseFilters, UseGuards, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import { Types, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { AdminController } from '../src/modules/admin/admin.controller';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { AdminAuthErrorFilter } from '../src/modules/identity/tenant-context/admin-auth.errors';
import {
  AdminScope,
  AdminTokenGuard,
  RequireRecentAuth,
  STEP_UP_CLOCK,
  Tenant,
  type TenantContext,
} from '../src/modules/identity/tenant-context/tenant-context';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserService, normalizeEmail } from '../src/modules/identity/user.service';
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
import { SESSION_CLOCK, SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { UiController } from '../src/modules/ui/ui.controller';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-admin-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER); // single source, never hand-built.
const DEMO_AUD = 'http://localhost:4000/demo/';
const RUN = `adm${Date.now()}`;
const CLIENT_A = `${RUN}-a`; // confidential BFF of tenant A
const CLIENT_B = `${RUN}-b`; // confidential BFF of tenant B
const TENANT_A = `${RUN}-tenant-A`;
const TENANT_B = `${RUN}-tenant-B`;
const REDIRECT = 'https://admin.example.com/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = deriveS256Challenge(VERIFIER);
const PASSWORD = 'admin-int-password-1'; // test-only value for the throwaway int DB user.
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const MIN = 60_000;

/** Test-only step-up probe (fold: never mounted in `src/`). */
@Controller('admin-test')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
class StepUpProbeController {
  @Post('danger')
  @AdminScope('admin.write')
  @RequireRecentAuth(5)
  danger(@Tenant() ctx: TenantContext) {
    return { ok: true, tenantId: ctx.tenantId };
  }
}

const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

describe('Admin API guard (B6.1) + step-up (B6.2) on real Mongo + Redis', () => {
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let signer: TokenSigner;
  let sessions: SessionService;
  let consents: ConsentService;
  let clientModel: Model<Client>;
  let userModel: Model<Record<string, unknown>>;
  let userTenantModel: Model<Record<string, unknown>>;
  let secretA = '';
  let secretB = '';
  // Mutable clocks (offset from real time, ms).
  let sessionOffset = 0;
  let stepUpOffset = 0;

  // Actors.
  let admin = ''; // tenant_admin of A (+ password for the real login flow)
  const adminEmail = `${RUN}-admin@example.com`;
  let plainA = ''; // member of A without any role
  let suspendedA = ''; // tenant_admin of A, membership suspended
  let adminOfB = ''; // tenant_admin of B, plain member of A
  let superA = ''; // super_admin of A

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

  const form = (fields: Record<string, string>): string =>
    Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  const basic = (id: string, secret: string): string =>
    'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

  const authorizeUrl = (clientId: string, extra: Record<string, string> = {}): string =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: ADMIN_SCOPE,
      resource: ADMIN_AUD,
      state: 'rp-state',
      nonce: 'rp-nonce',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      ...extra,
    }).toString()}`;

  const exchange = async (clientId: string, code: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(clientId, clientId === CLIENT_A ? secretA : secretB),
      },
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { access_token: string; refresh_token?: string };
  };

  /** REAL `/authorize` (consent pre-granted) -> code -> `/token` for a live session. */
  async function realFlow(
    sessionId: string,
    userId: string,
    clientId = CLIENT_A,
  ): Promise<{ access_token: string; refresh_token?: string }> {
    await consents.grant(
      userId,
      clientId,
      ADMIN_AUD,
      ADMIN_SCOPE.split(' '),
      consents.currentVersions(),
      ADMIN_SCOPE.split(' '),
    );
    const res = await app.inject({
      method: 'GET',
      url: authorizeUrl(clientId),
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(res.statusCode).toBe(302);
    const code = new URL(res.headers['location'] as string).searchParams.get('code');
    expect(code).toBeTruthy();
    return exchange(clientId, code!);
  }

  async function tokenFor(userId: string, clientId = CLIENT_A): Promise<string> {
    const { id } = await sessions.create(userId, DEFAULT_TENANT_ID);
    return (await realFlow(id, userId, clientId)).access_token;
  }

  /** Hand-signed access token (for shapes the real `/token` never mints). */
  const signed = (
    sub: string,
    over: { aud?: string; scope?: string; sid?: string | null; authTime?: unknown } = {},
  ): Promise<string> =>
    signer.sign(
      {
        scope: over.scope ?? 'admin.read admin.write',
        client_id: CLIENT_A,
        ...(over.sid === null ? {} : { sid: over.sid ?? 'b'.repeat(64) }),
        ...(over.authTime !== undefined ? { auth_time: over.authTime } : {}),
      },
      { audience: over.aud ?? ADMIN_AUD, subject: sub, expiresInSec: 900, typ: 'at+jwt' },
    );

  const me = (token?: string, extra: { url?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method: 'GET',
      url: extra.url ?? '/admin/me',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra.headers },
    });
  const danger = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/admin-test/danger',
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-admin-int-'));
    const provider = new LocalKeyProvider(keyDir);
    await provider.init();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [
        AuthorizeController,
        TokenController,
        UiController,
        AdminController,
        StepUpProbeController,
      ],
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
        { provide: SESSION_CLOCK, useValue: () => Date.now() + sessionOffset },
        { provide: STEP_UP_CLOCK, useValue: () => Date.now() + stepUpOffset },
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

    signer = moduleRef.get(TokenSigner);
    sessions = moduleRef.get(SessionService);
    consents = moduleRef.get(ConsentService);
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    userTenantModel = app.get<Model<Record<string, unknown>>>(getModelToken('UserTenant'));
    await syncAllIndexes(clientModel.db);

    const resources = moduleRef.get(ResourceService);
    await resources.create({ resourceId: 'admin', identifier: ADMIN_AUD });
    await resources.create({ resourceId: 'demo', identifier: DEMO_AUD });
    const clients = moduleRef.get(ClientService);
    for (const [clientId, tenantId] of [
      [CLIENT_A, TENANT_A],
      [CLIENT_B, TENANT_B],
    ]) {
      await clients.create({
        clientId,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: [REDIRECT],
        allowedResources: ['admin', 'demo'],
        scopes: ADMIN_SCOPE.split(' '),
        tenantId,
      });
    }
    const creds = moduleRef.get(ClientCredentialService);
    secretA = (await creds.createSecret(CLIENT_A)).secret;
    secretB = (await creds.createSecret(CLIENT_B)).secret;

    const mkUser = async (email: string, withPassword = false): Promise<string> => {
      const user = await userModel.create({
        email: normalizeEmail(email),
        ...(withPassword
          ? { passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() }
          : {}),
      });
      return (user._id as Types.ObjectId).toHexString();
    };
    const members = moduleRef.get(UserTenantService);
    admin = await mkUser(adminEmail, true);
    await members.addMembership(admin, TENANT_A, ['tenant_admin']);
    plainA = await mkUser(`${RUN}-plain@example.com`);
    await members.addMembership(plainA, TENANT_A, ['member']);
    suspendedA = await mkUser(`${RUN}-susp@example.com`);
    await members.addMembership(suspendedA, TENANT_A, ['tenant_admin']);
    await userTenantModel.updateOne(
      { userId: new Types.ObjectId(suspendedA), tenantId: TENANT_A },
      { $set: { status: 'suspended' } },
    );
    adminOfB = await mkUser(`${RUN}-bAdmin@example.com`);
    await members.addMembership(adminOfB, TENANT_B, ['tenant_admin']);
    await members.addMembership(adminOfB, TENANT_A, ['member']);
    superA = await mkUser(`${RUN}-super@example.com`);
    await members.addMembership(superA, TENANT_A, ['super_admin']);
  }, 60_000);

  afterAll(async () => {
    if (redis) {
      for (const u of [admin, plainA, suspendedA, adminOfB, superA]) {
        if (u && sessions) await sessions.revokeAllForUser(u);
      }
      for (const p of ['authz_ctx:*', 'authz_code:*', 'sess_end:*', 'sess_rp:*', 'rl:*']) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
    }
    if (clientModel) await clientModel.db.dropDatabase();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    sessionOffset = 0;
    stepUpOffset = 0;
    jest.restoreAllMocks();
  });

  describe('B6.1 admin guard (INV-24)', () => {
    it('real /authorize -> /token flow => GET /admin/me 200 {sub, tenantId: A, roles}, no sid, no-store', async () => {
      const token = await tokenFor(admin);
      expect(claimsOf(token).aud).toBe(ADMIN_AUD);
      const res = await me(token);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.json()).toEqual({ sub: admin, tenantId: TENANT_A, roles: ['tenant_admin'] });
      expect(res.body).not.toContain('sid');
      expect(res.body).not.toContain(token);
    });

    it('super_admin of A => 200 tenant A (no cross-tenant power in run 26)', async () => {
      const res = await me(await tokenFor(superA));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sub: superA, tenantId: TENANT_A, roles: ['super_admin'] });
    });

    it('tenant from query/header/body is ignored (still A)', async () => {
      const token = await tokenFor(admin);
      const res = await app.inject({
        method: 'GET',
        url: `/admin/me?tenantId=${TENANT_B}`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-tenant-id': TENANT_B,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ tenantId: TENANT_B }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tenantId).toBe(TENANT_A);
    });

    it('missing / garbage token => 401 invalid_token + WWW-Authenticate, no-store', async () => {
      for (const res of [await me(), await me('not-a-jwt')]) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'invalid_token' });
        expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('a valid token for another resource (aud = demo) => 401 (confused deputy)', async () => {
      const res = await me(await signed(admin, { aud: DEMO_AUD }));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
    });

    it('an ID token (typ JWT) => 401', async () => {
      const idToken = await signer.sign(
        {},
        { audience: CLIENT_A, subject: admin, expiresInSec: 900 },
      );
      expect((await me(idToken)).statusCode).toBe(401);
    });

    it('an admin token WITHOUT sid => 401 (logout must always be able to revoke it)', async () => {
      expect((await me(await signed(admin))).statusCode).toBe(200); // control: same shape + sid
      const res = await me(await signed(admin, { sid: null }));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
    });

    it('client no longer allows the admin resource => 401', async () => {
      const token = await tokenFor(admin);
      await clientModel.updateOne({ clientId: CLIENT_A }, { $set: { allowedResources: ['demo'] } });
      try {
        expect((await me(token)).statusCode).toBe(401);
      } finally {
        await clientModel.updateOne(
          { clientId: CLIENT_A },
          { $set: { allowedResources: ['admin', 'demo'] } },
        );
      }
    });

    it('logout of the issuing session (tombstone) => the SAME token 401', async () => {
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const { access_token } = await realFlow(id, admin);
      expect((await me(access_token)).statusCode).toBe(200);
      await sessions.revoke(id); // the logout path's tombstone write
      const res = await me(access_token);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
    });

    it('token without admin.read => 403 insufficient_scope + WWW-Authenticate scope', async () => {
      const res = await me(await signed(admin, { scope: 'openid admin.write' }));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'insufficient_scope' });
      expect(res.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="admin.read"',
      );
    });

    it('member of A without an admin role => 403 forbidden', async () => {
      const res = await me(await tokenFor(plainA));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
    });

    it('tenant_admin of A with a SUSPENDED membership => 403 forbidden', async () => {
      // Run 35 (DEBT-116): the real /authorize no longer issues a code to a suspended member, so the
      // guard (defence in depth) is exercised with a hand-signed token of the same shape.
      const res = await me(await signed(suspendedA));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
    });

    it('tenant_admin of B with a token from the tenant-A client => 403 (no cross-tenant)', async () => {
      // Control: via B's client the same user IS admin of B.
      const viaB = await me(await tokenFor(adminOfB, CLIENT_B));
      expect(viaB.statusCode).toBe(200);
      expect(viaB.json().tenantId).toBe(TENANT_B);
      const viaA = await me(await tokenFor(adminOfB, CLIENT_A));
      expect(viaA.statusCode).toBe(403);
      expect(viaA.json()).toEqual({ error: 'forbidden' });
    });

    it('non-member of the token tenant is indistinguishable from member-without-role (both forbidden)', async () => {
      const outsider = (
        (await userModel.create({ email: `${RUN}-out@example.com` }))._id as Types.ObjectId
      ).toHexString();
      // Run 35 (DEBT-116): a non-member gets no code from /authorize; hand-signed, as above.
      const res = await me(await signed(outsider));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
    });

    it('fail-closed: Mongo fault reading the membership => 5xx (never 200/401/403)', async () => {
      const token = await tokenFor(admin);
      jest.spyOn(userTenantModel, 'findOne').mockImplementationOnce(() => {
        throw new Error('mongo down secret-detail');
      });
      const res = await me(token);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('secret-detail');
    });

    it('fail-closed: Redis fault on the sid tombstone lookup => 5xx', async () => {
      const token = await tokenFor(admin);
      jest.spyOn(sessions, 'isEnded').mockRejectedValueOnce(new Error('ECONNREFUSED redis'));
      const res = await me(token);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('ECONNREFUSED');
    });

    it('fail-closed: Mongo fault loading the client => 5xx', async () => {
      const token = await tokenFor(admin);
      jest
        .spyOn(moduleRef.get(ClientService), 'findByClientId')
        .mockRejectedValueOnce(new Error('mongo down'));
      expect((await me(token)).statusCode).toBeGreaterThanOrEqual(500);
    });
  });

  describe('B6.2 step-up @RequireRecentAuth(5) (INV-26)', () => {
    const nowSec = () => Math.floor(Date.now() / 1000);

    it('fresh real-flow token (auth_time just now) => 200', async () => {
      const token = await tokenFor(admin);
      expect(typeof claimsOf(token).auth_time).toBe('number');
      const res = await danger(token);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true, tenantId: TENANT_A });
    });

    it('boundary: exactly 5 min old => 200; 5 min + 1 s => 403 step_up_required', async () => {
      const authTime = nowSec();
      const token = await signed(admin, { authTime });
      stepUpOffset = authTime * 1000 + 5 * MIN - Date.now();
      expect((await danger(token)).statusCode).toBe(201);
      stepUpOffset = authTime * 1000 + 5 * MIN + 1000 - Date.now();
      const res = await danger(token);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'step_up_required', max_age: 0 });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['www-authenticate']).toBeUndefined(); // no RFC 9470 mix (D3: 403)
    });

    it('missing / non-integer auth_time => 403 step_up_required', async () => {
      for (const authTime of [undefined, nowSec() + 0.5, String(nowSec())]) {
        const res = await danger(await signed(admin, { authTime }));
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('step_up_required');
      }
    });

    it('auth_time in the future: +30 s tolerated, +31 s => 403 (clock skew)', async () => {
      const base = nowSec();
      stepUpOffset = base * 1000 - Date.now();
      expect((await danger(await signed(admin, { authTime: base + 30 }))).statusCode).toBe(201);
      const res = await danger(await signed(admin, { authTime: base + 31 }));
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('step_up_required');
    });

    it('B6.1 errors take precedence over step-up (no token => 401, plain member => 403 forbidden)', async () => {
      const none = await app.inject({ method: 'POST', url: '/admin-test/danger' });
      expect(none.statusCode).toBe(401);
      const plain = await danger(await signed(plainA, { authTime: 0 }));
      expect(plain.statusCode).toBe(403);
      expect(plain.json()).toEqual({ error: 'forbidden' });
    });

    it('token from the refresh grant (no auth_time) => 403 step_up_required, /admin/me still 200', async () => {
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const first = await realFlow(id, admin);
      expect(first.refresh_token).toBeTruthy();
      const rr = await app.inject({
        method: 'POST',
        url: '/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(CLIENT_A, secretA),
        },
        payload: form({ grant_type: 'refresh_token', refresh_token: first.refresh_token! }),
      });
      expect(rr.statusCode).toBe(200);
      const refreshed = rr.json().access_token as string;
      expect(claimsOf(refreshed).auth_time).toBeUndefined();
      expect((await me(refreshed)).statusCode).toBe(200);
      const res = await danger(refreshed);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'step_up_required', max_age: 0 });
    });

    /** Start a step-up re-auth: `/authorize?prompt=login&max_age=0` with a live session. */
    async function startReauth(
      sessionId: string,
    ): Promise<{ returnTo: string; requestId: string }> {
      const res = await app.inject({
        method: 'GET',
        url: authorizeUrl(CLIENT_A, { prompt: 'login', max_age: '0' }),
        cookies: { [SESSION_COOKIE]: sessionId },
      });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers['location'] as string, ISSUER);
      expect(location.pathname).toBe('/login');
      const returnTo = location.searchParams.get('returnTo')!;
      const requestId = new URLSearchParams(returnTo.split('?')[1]).get('request_id')!;
      expect(requestId).toBeTruthy();
      return { returnTo, requestId };
    }

    it('full chain: stale session => 403; prompt=login&max_age=0 => GET /login 200 form => POST /login => resume => code => fresh token => 200', async () => {
      // Session authenticated 10 min ago (session clock inject).
      sessionOffset = -10 * MIN;
      const { id: oldId } = await sessions.create(admin, DEFAULT_TENANT_ID);
      sessionOffset = 0;
      const stale = await realFlow(oldId, admin);
      const staleAuthTime = claimsOf(stale.access_token).auth_time as number;
      expect(nowSec() - staleAuthTime).toBeGreaterThanOrEqual(599);
      expect((await danger(stale.access_token)).statusCode).toBe(403);

      const { returnTo } = await startReauth(oldId);
      // Live session + reauth context => the login FORM (not 302 '/').
      const loginPage = await app.inject({
        method: 'GET',
        url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
        cookies: { [SESSION_COOKIE]: oldId },
      });
      expect(loginPage.statusCode).toBe(200);
      const csrf = loginPage.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();

      const post = await app.inject({
        method: 'POST',
        url: '/login',
        cookies: { [SESSION_COOKIE]: oldId },
        payload: { _csrf: csrf!, email: adminEmail, password: PASSWORD, returnTo },
      });
      expect(post.statusCode).toBe(302);
      expect(post.headers['location']).toBe(returnTo);
      const setCookie = ([] as string[]).concat(post.headers['set-cookie'] ?? []);
      const newId = setCookie
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
        .split(';')[0]
        .split('=')[1];
      expect(newId).toBeTruthy();
      expect(newId).not.toBe(oldId); // session rotated (fixation)

      const resumed = await app.inject({
        method: 'GET',
        url: returnTo,
        cookies: { [SESSION_COOKIE]: newId },
      });
      expect(resumed.statusCode).toBe(302);
      const code = new URL(resumed.headers['location'] as string).searchParams.get('code');
      expect(code).toBeTruthy();
      const fresh = await exchange(CLIENT_A, code!);
      expect(claimsOf(fresh.access_token).auth_time as number).toBeGreaterThan(staleAuthTime);
      const ok = await danger(fresh.access_token);
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toEqual({ ok: true, tenantId: TENANT_A });
    });

    it('bypass: calling /authorize?request_id=X directly (no re-login) => error=login_required, no code', async () => {
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const { returnTo } = await startReauth(id);
      const res = await app.inject({
        method: 'GET',
        url: returnTo,
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers['location'] as string);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get('error')).toBe('login_required');
      expect(location.searchParams.get('state')).toBe('rp-state');
      expect(location.searchParams.get('code')).toBeNull();
      // Single-use: the context is gone, a retry cannot loop or mint a code.
      const again = await app.inject({
        method: 'GET',
        url: returnTo,
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(again.statusCode).toBe(400);
    });

    it('bypass with NO session at all on a reauth context => error=login_required, no code', async () => {
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const { returnTo } = await startReauth(id);
      const res = await app.inject({ method: 'GET', url: returnTo });
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers['location'] as string);
      expect(location.searchParams.get('error')).toBe('login_required');
      expect(location.searchParams.get('code')).toBeNull();
    });

    // Run 26 retry 1 (senior 🔴): the consent door must not accept a re-auth (login) context.
    it('bypass via POST /authorize/consent with the OLD session => error=login_required, no code, no consent, single-use', async () => {
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const { returnTo, requestId } = await startReauth(id);
      const loginPage = await app.inject({
        method: 'GET',
        url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(loginPage.statusCode).toBe(200);
      const csrf = loginPage.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();
      const grant = jest.spyOn(consents, 'grant');

      const consent = () =>
        app.inject({
          method: 'POST',
          url: '/authorize/consent',
          cookies: { [SESSION_COOKIE]: id },
          payload: { _csrf: csrf!, request_id: requestId, approve: 'true' },
        });
      const res = await consent();
      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers['location'] as string);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get('error')).toBe('login_required');
      expect(location.searchParams.get('state')).toBe('rp-state');
      expect(location.searchParams.get('code')).toBeNull();
      expect(grant).not.toHaveBeenCalled();
      // Context consumed: neither door can use it again.
      expect((await consent()).statusCode).toBe(400);
      const resumed = await app.inject({
        method: 'GET',
        url: returnTo,
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(resumed.statusCode).toBe(400);
    });

    it('max_age exceeded (not 0) with a live session also forces the login form', async () => {
      sessionOffset = -10 * MIN;
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      sessionOffset = 0;
      const res = await app.inject({
        method: 'GET',
        url: authorizeUrl(CLIENT_A, { max_age: '300' }),
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(res.statusCode).toBe(302);
      const returnTo = new URL(res.headers['location'] as string, ISSUER).searchParams.get(
        'returnTo',
      )!;
      const page = await app.inject({
        method: 'GET',
        url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(page.statusCode).toBe(200);
    });

    it('GET /login with a live session and a NON-reauth context => still 302 /', async () => {
      // No session at /authorize => a plain login_required context (no reauthAfter).
      const plain = await app.inject({ method: 'GET', url: authorizeUrl(CLIENT_A) });
      expect(plain.statusCode).toBe(302);
      const returnTo = new URL(plain.headers['location'] as string, ISSUER).searchParams.get(
        'returnTo',
      )!;
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const page = await app.inject({
        method: 'GET',
        url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(page.statusCode).toBe(302);
      expect(page.headers['location']).toBe('/');
    });

    it('GET /login: Redis fault peeking the context with a live session => keeps old behaviour (302 /)', async () => {
      const { id } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const { returnTo } = await startReauth(id);
      jest
        .spyOn(moduleRef.get(AuthorizeRequestContextService), 'peek')
        .mockRejectedValue(new Error('ECONNREFUSED'));
      const page = await app.inject({
        method: 'GET',
        url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
        cookies: { [SESSION_COOKIE]: id },
      });
      expect(page.statusCode).toBe(302);
      expect(page.headers['location']).toBe('/');
    });
  });

  // Tester (run 26) risk matrix: credential / scope / tenant positive control / exposure / replay+concurrency.
  describe('tester risk matrix (run 26)', () => {
    const accessClaims = {
      scope: 'admin.read admin.write',
      client_id: CLIENT_A,
      sid: 'c'.repeat(64),
    };

    /** prompt=login&max_age=0 with a live session -> login form -> POST /login; returns rotated cookie. */
    async function reauth(oldId: string): Promise<{ returnTo: string; newId: string }> {
      const start = await app.inject({
        method: 'GET',
        url: authorizeUrl(CLIENT_A, { prompt: 'login', max_age: '0' }),
        cookies: { [SESSION_COOKIE]: oldId },
      });
      expect(start.statusCode).toBe(302);
      const returnTo = new URL(start.headers['location'] as string, ISSUER).searchParams.get(
        'returnTo',
      )!;
      const page = await app.inject({
        method: 'GET',
        url: `/login?returnTo=${encodeURIComponent(returnTo)}`,
        cookies: { [SESSION_COOKIE]: oldId },
      });
      expect(page.statusCode).toBe(200);
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      const post = await app.inject({
        method: 'POST',
        url: '/login',
        cookies: { [SESSION_COOKIE]: oldId },
        payload: { _csrf: csrf, email: adminEmail, password: PASSWORD, returnTo },
      });
      expect(post.statusCode).toBe(302);
      const newId = ([] as string[])
        .concat(post.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
        .split(';')[0]
        .split('=')[1];
      return { returnTo, newId };
    }

    it('credential: expired admin token => 401 invalid_token', async () => {
      const expired = await signer.sign(accessClaims, {
        audience: ADMIN_AUD,
        subject: admin,
        expiresInSec: -120,
        typ: 'at+jwt',
      });
      const res = await me(expired);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token' });
    });

    it('credential: payload tampered (sub swapped, signature kept) => 401', async () => {
      const good = await signed(plainA);
      const [h, , sig] = good.split('.');
      const forged = Buffer.from(
        JSON.stringify({ ...claimsOf(good), sub: admin }),
        'utf8',
      ).toString('base64url');
      expect((await me(`${h}.${forged}.${sig}`)).statusCode).toBe(401);
    });

    it('credential: token signed by a foreign key (same iss/aud/typ) => 401', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vg-admin-foreign-'));
      try {
        const foreign = new LocalKeyProvider(dir);
        await foreign.init();
        const rogue = new TokenSigner(foreign, cfg);
        const token = await rogue.sign(accessClaims, {
          audience: ADMIN_AUD,
          subject: admin,
          expiresInSec: 900,
          typ: 'at+jwt',
        });
        expect((await me(token)).statusCode).toBe(401);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('credential: token only in query string / non-Bearer scheme => 401', async () => {
      const token = await tokenFor(admin);
      expect((await me(undefined, { url: `/admin/me?access_token=${token}` })).statusCode).toBe(
        401,
      );
      expect(
        (await me(undefined, { headers: { authorization: `Basic ${token}` } })).statusCode,
      ).toBe(401);
    });

    it('credential: user deleted after issuance => same token 401', async () => {
      const ghostDoc = await userModel.create({
        email: normalizeEmail(`${RUN}-ghost@example.com`),
      });
      const ghost = (ghostDoc._id as Types.ObjectId).toHexString();
      await moduleRef.get(UserTenantService).addMembership(ghost, TENANT_A, ['tenant_admin']);
      const token = await tokenFor(ghost);
      expect((await me(token)).statusCode).toBe(200);
      await userModel.deleteOne({ _id: ghostDoc._id });
      expect((await me(token)).statusCode).toBe(401);
      await sessions.revokeAllForUser(ghost);
    });

    it('scope: admin.write only on GET /admin/me => 403 insufficient_scope scope="admin.read"', async () => {
      const res = await me(await signed(admin, { scope: 'admin.write' }));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'insufficient_scope' });
      expect(res.headers['www-authenticate']).toBe(
        'Bearer error="insufficient_scope", scope="admin.read"',
      );
    });

    it('scope: admin.read only on a write route (fresh auth_time) => 403 insufficient_scope before step-up', async () => {
      const res = await danger(
        await signed(admin, { scope: 'admin.read', authTime: Math.floor(Date.now() / 1000) }),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'insufficient_scope' });
      expect(res.headers['www-authenticate']).toContain('scope="admin.write"');
    });

    it('scope: lookalike scopes ("admin.readx", "admin", "xadmin.read") do not satisfy admin.read', async () => {
      for (const scope of ['admin.readx', 'admin', 'xadmin.read']) {
        const res = await me(await signed(admin, { scope }));
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'insufficient_scope' });
      }
    });

    it('tenant positive control: tenant_admin of B via the tenant-B client => 200 tenant B', async () => {
      const res = await me(await tokenFor(adminOfB, CLIENT_B));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sub: adminOfB, tenantId: TENANT_B, roles: ['tenant_admin'] });
    });

    it('exposure: 401/403 bodies never echo tenant / sub / roles', async () => {
      for (const res of [
        await me(await tokenFor(plainA)),
        await me(await tokenFor(adminOfB)),
        await me(await signed(admin, { aud: DEMO_AUD })),
      ]) {
        expect([401, 403]).toContain(res.statusCode);
        for (const secret of [TENANT_A, TENANT_B, adminOfB, plainA, admin, 'tenant_admin']) {
          expect(res.body).not.toContain(secret);
        }
      }
    });

    it('concurrency: after re-login, 5 parallel resumes of the same request_id => exactly one code', async () => {
      const { id: oldId } = await sessions.create(admin, DEFAULT_TENANT_ID);
      const { returnTo, newId } = await reauth(oldId);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({ method: 'GET', url: returnTo, cookies: { [SESSION_COOKIE]: newId } }),
        ),
      );
      const withCode = results.filter(
        (r) =>
          r.statusCode === 302 &&
          new URL(r.headers['location'] as string, ISSUER).searchParams.get('code'),
      );
      expect(withCode).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 400)).toHaveLength(4);
    });

    it('request chain: old cookie after step-up re-login is dead (rotated) => next /authorize gives no code', async () => {
      const { id: oldId } = await sessions.create(admin, DEFAULT_TENANT_ID);
      await reauth(oldId);
      const again = await app.inject({
        method: 'GET',
        url: authorizeUrl(CLIENT_A),
        cookies: { [SESSION_COOKIE]: oldId },
      });
      expect(again.statusCode).toBe(302);
      const loc = new URL(again.headers['location'] as string, ISSUER);
      expect(loc.searchParams.get('code')).toBeNull();
    });
  });
});
