import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { ValidationPipe } from '@nestjs/common';
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
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { AdminAuditController } from '../src/modules/admin/admin-audit.controller';
import { AdminUsersController } from '../src/modules/admin/admin-users.controller';
import { AdminController } from '../src/modules/admin/admin.controller';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { LoginThrottleService } from '../src/modules/authentication/login-throttle.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { STEP_UP_CLOCK } from '../src/modules/identity/tenant-context/tenant-context';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import {
  ADMIN_LOCKED_UNTIL,
  UserService,
  normalizeEmail,
} from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { SuperAdminGuard } from '../src/modules/identity/super-admin-guard';
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
import { UserinfoController } from '../src/modules/oauth/userinfo/userinfo.controller';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SessionCookie, SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-admin-users-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
const DEMO_AUD = 'http://localhost:4000/demo/';
const OTHER_AUD = 'https://other.example.com/';
const RUN = `ausr${Date.now()}`;
const CLIENT_A = `${RUN}-a`;
const CLIENT_A2 = `${RUN}-a2`;
const CLIENT_B = `${RUN}-b`;
const TENANT_A = `${RUN}-tenant-A`;
const TENANT_B = `${RUN}-tenant-B`;
const REDIRECT = 'https://admin.example.com/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = deriveS256Challenge(VERIFIER);
const PASSWORD = 'admin-users-int-password-1'; // test-only value for throwaway int DB users.
const NEW_PASSWORD = 'admin-users-int-password-2'; // test-only value (reset target).
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const USER_SCOPE = 'openid offline_access';
const FAKE_SID = 'c'.repeat(64);
const MIN = 60_000;

/** Fields an admin user view must never carry (fold: allowlist). */
const USER_KEYS = [
  'createdAt',
  'email',
  'emailVerified',
  'id',
  'lockedUntil',
  'locked',
  'membershipStatus',
  'roles',
].sort();

describe('Admin API B6.3b (users, families, consents, audit) on real Mongo + Redis', () => {
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let signer: TokenSigner;
  let sessions: SessionService;
  let consents: ConsentService;
  let auth: AuthenticationService;
  let clientModel: Model<Client>;
  let userModel: Model<Record<string, unknown>>;
  let userTenantModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  let refreshModel: Model<Record<string, unknown>>;
  let consentModel: Model<Record<string, unknown>>;
  const secrets: Record<string, string> = {};
  const created: string[] = [];
  let seq = 0;

  let tadminA = '';
  let superA = '';
  let tadminB = '';

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
          rateLimitMax: 100000,
          clientAuthFailIpMax: 100000,
          clientAuthFailClientMax: 100000,
        };
      if (ns === 'client') return { secretGraceTtl: 60 };
      if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
      throw new Error(`Unexpected config namespace: ${ns}`);
    },
  } as unknown as ConfigService;

  const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
  const basic = (id: string): string =>
    'Basic ' + Buffer.from(`${id}:${secrets[id]}`).toString('base64');

  /** Hand-signed admin token (aud=admin, fresh auth_time, never-ended sid) for the ACTOR. */
  const tok = (
    sub: string,
    over: { client?: string; scope?: string; authAgoMs?: number } = {},
  ): Promise<string> =>
    signer.sign(
      {
        scope: over.scope ?? 'openid admin.read admin.write',
        client_id: over.client ?? CLIENT_A,
        sid: FAKE_SID,
        auth_time: Math.floor((Date.now() - (over.authAgoMs ?? 0)) / 1000),
      },
      { audience: ADMIN_AUD, subject: sub, expiresInSec: 900, typ: 'at+jwt' },
    );

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  /** Throwaway user with a password + memberships `{tenant: roles}`. */
  async function mkUser(memberships: Record<string, string[]>, tag = 'u'): Promise<string> {
    const email = `${RUN}-${tag}-${++seq}@example.com`;
    const user = await userModel.create({
      email: normalizeEmail(email),
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    });
    const id = (user._id as Types.ObjectId).toHexString();
    created.push(id);
    const members = moduleRef.get(UserTenantService);
    for (const [tenant, roles] of Object.entries(memberships)) {
      await members.addMembership(id, tenant, roles);
    }
    return id;
  }
  const emailOf = async (id: string): Promise<string> =>
    (await userModel.findById(id).lean())!.email as string;

  const authorize = (sessionId: string, clientId: string, resource: string, scope = USER_SCOPE) =>
    app.inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope,
        resource,
        state: 'rp-state',
        nonce: 'rp-nonce',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      }).toString()}`,
      cookies: { [SESSION_COOKIE]: sessionId },
    });

  /** REAL `/authorize` (consent pre-granted) -> code -> `/token` on a live session. */
  async function realFlow(
    userId: string,
    opts: { clientId?: string; resource?: string; scope?: string; sessionId?: string } = {},
  ): Promise<{ access_token: string; refresh_token?: string; sessionId: string }> {
    const clientId = opts.clientId ?? CLIENT_A;
    const resource = opts.resource ?? DEMO_AUD;
    const scope = opts.scope ?? USER_SCOPE;
    const sessionId = opts.sessionId ?? (await sessions.create(userId, DEFAULT_TENANT_ID)).id;
    await consents.grant(
      userId,
      clientId,
      resource,
      scope.split(' '),
      consents.currentVersions(),
      scope.split(' '),
    );
    const res = await authorize(sessionId, clientId, resource, scope);
    expect(res.statusCode).toBe(302);
    const code = new URL(res.headers['location'] as string).searchParams.get('code');
    expect(code).toBeTruthy();
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(clientId),
      },
      payload: form({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    });
    expect(tokenRes.statusCode).toBe(200);
    return { ...(tokenRes.json() as { access_token: string; refresh_token?: string }), sessionId };
  }

  const refresh = (value: string, clientId = CLIENT_A) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(clientId),
      },
      payload: form({ grant_type: 'refresh_token', refresh_token: value }),
    });
  const userinfo = (at: string) =>
    app.inject({ method: 'GET', url: '/userinfo', headers: { authorization: `Bearer ${at}` } });
  const me = (at: string) => call('GET', '/admin/me', at);
  const canLogin = async (id: string, password = PASSWORD): Promise<boolean> =>
    auth.login(await emailOf(id), password, {}).then(
      () => true,
      () => false,
    );
  /** Real `/forgot` path; the reset token is taken from the (mocked) email link. */
  const forgotToken = async (id: string): Promise<string> => {
    const send = jest.spyOn(
      moduleRef.get<{ send: (m: { text: string }) => Promise<void> }>(MAILER),
      'send',
    );
    await auth.forgotPassword(await emailOf(id));
    const link = send.mock.calls[0][0].text.match(/https?:\S+/)![0];
    send.mockRestore();
    return new URL(link).searchParams.get('token')!;
  };
  const lockedUntilOf = async (id: string) =>
    ((await userModel.findById(id).lean())?.lockedUntil as Date | undefined) ?? null;
  const rolesOf = async (id: string, tenant = TENANT_A) =>
    (await userTenantModel.findOne({ userId: new Types.ObjectId(id), tenantId: tenant }).lean())
      ?.roles;

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-admin-users-int-'));
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
        UserinfoController,
        AdminController,
        AdminUsersController,
        AdminAuditController,
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
        LoginThrottleService,
        UserService,
        UserTenantService,
        SuperAdminGuard,
        LogoutService,
        { provide: MAILER, useValue: { send: async () => undefined } },
        { provide: STEP_UP_CLOCK, useValue: () => Date.now() },
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
    // Same pipe + global filter as `main.ts` (unknown field => 400 invalid_request).
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new OAuthExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    signer = moduleRef.get(TokenSigner);
    sessions = moduleRef.get(SessionService);
    consents = moduleRef.get(ConsentService);
    auth = moduleRef.get(AuthenticationService);
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    userModel = app.get(getModelToken('User'));
    userTenantModel = app.get(getModelToken('UserTenant'));
    auditModel = app.get(getModelToken('AuditLog'));
    refreshModel = app.get(getModelToken('RefreshToken'));
    consentModel = app.get(getModelToken('Consent'));
    await syncAllIndexes(clientModel.db);

    const resources = moduleRef.get(ResourceService);
    await resources.create({
      resourceId: 'admin',
      identifier: ADMIN_AUD,
      scopes: ['admin.read', 'admin.write'],
    });
    await resources.create({ resourceId: 'demo', identifier: DEMO_AUD });
    await resources.create({ resourceId: 'other', identifier: OTHER_AUD });
    const clients = moduleRef.get(ClientService);
    const creds = moduleRef.get(ClientCredentialService);
    for (const [clientId, tenantId] of [
      [CLIENT_A, TENANT_A],
      [CLIENT_A2, TENANT_A],
      [CLIENT_B, TENANT_B],
    ]) {
      await clients.create({
        clientId,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: [REDIRECT],
        allowedResources: ['admin', 'demo', 'other'],
        scopes: ADMIN_SCOPE.split(' '),
        tenantId,
      });
      secrets[clientId] = (await creds.createSecret(clientId)).secret;
    }

    tadminA = await mkUser({ [TENANT_A]: ['tenant_admin'] }, 'ta');
    superA = await mkUser({ [TENANT_A]: ['super_admin'] }, 'sa');
    tadminB = await mkUser({ [TENANT_B]: ['tenant_admin'] }, 'tb');
  }, 60_000);

  afterAll(async () => {
    if (redis) {
      for (const u of created) if (sessions) await sessions.revokeAllForUser(u);
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
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------ Task 1: users
  describe('Task 1 — users', () => {
    it('GET /admin/users: only members of the token tenant, exact key set, cursor walk', async () => {
      const onlyB = await mkUser({ [TENANT_B]: [] });
      const token = await tok(tadminA);
      const seen: string[] = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const url: string = `/admin/users?limit=2${after ? `&after=${after}` : ''}`;
        const res = await call('GET', url, token);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        const body = res.json() as { items: Record<string, unknown>[]; nextCursor: string | null };
        for (const u of body.items) {
          expect(Object.keys(u).sort()).toEqual(USER_KEYS);
          seen.push(u.id as string);
        }
        after = body.nextCursor;
        pages++;
      } while (after && pages < 100);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining([tadminA, superA]));
      expect(seen).not.toContain(onlyB);
      expect(seen).not.toContain(tadminB);
      const raw = (await call('GET', '/admin/users?limit=100', token)).body;
      expect(raw).not.toMatch(/passwordHash|mfaSecret|lockTransitionNonce|failedLoginCount/);
      expect(raw).not.toContain('$argon2');
    });

    it('GET /admin/users?email= is an EXACT match after normalize (no prefix / regex)', async () => {
      const id = await mkUser({ [TENANT_A]: [] }, 'mail');
      const email = await emailOf(id);
      const token = await tok(tadminA);
      const hit = await call(
        'GET',
        `/admin/users?email=${encodeURIComponent(`  ${email.toUpperCase()} `)}`,
        token,
      );
      expect(hit.json().items.map((u: { id: string }) => u.id)).toEqual([id]);
      for (const q of [email.slice(0, -3), `${RUN}.*`, '.*', `^${email}`]) {
        const res = await call('GET', `/admin/users?email=${encodeURIComponent(q)}`, token);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ items: [], nextCursor: null });
      }
      // A user of tenant B searched from A => nothing (no cross-tenant enumeration).
      const res = await call(
        'GET',
        `/admin/users?email=${encodeURIComponent(await emailOf(tadminB))}`,
        token,
      );
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    });

    it('GET /admin/users?status= filters by membership status', async () => {
      const susp = await mkUser({ [TENANT_A]: [] });
      await userTenantModel.updateOne(
        { userId: new Types.ObjectId(susp), tenantId: TENANT_A },
        { $set: { status: 'suspended' } },
      );
      const res = await call('GET', '/admin/users?status=suspended&limit=100', await tok(tadminA));
      const items = res.json().items as { id: string; membershipStatus: string }[];
      expect(items.map((u) => u.id)).toContain(susp);
      expect(items.every((u) => u.membershipStatus === 'suspended')).toBe(true);
    });

    it('bad query => 400 invalid_request (tenantId, limit=101, bad cursor, bad status)', async () => {
      const token = await tok(tadminA);
      for (const q of [`tenantId=${TENANT_B}`, 'limit=101', 'after=zzz', 'status=deleted']) {
        const res = await call('GET', `/admin/users?${q}`, token);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
    });

    it('cross-tenant / missing / malformed id => byte-identical 404 on every route', async () => {
      const onlyB = await mkUser({ [TENANT_B]: [] });
      const token = await tok(superA);
      const routes: ['GET' | 'POST' | 'PATCH', string, unknown?][] = [
        ['GET', ''],
        ['POST', '/lock'],
        ['POST', '/unlock'],
        ['POST', '/sessions/revoke'],
        ['PATCH', '/roles', { roles: [] }],
      ];
      for (const [method, suffix, body] of routes) {
        const bodies = new Set<string>();
        for (const id of [onlyB, new Types.ObjectId().toHexString(), 'not-an-id', 'a'.repeat(12)]) {
          const res = await call(method, `/admin/users/${id}${suffix}`, token, body);
          expect(res.statusCode).toBe(404);
          bodies.add(res.body);
        }
        expect([...bodies]).toEqual(['{"error":"not_found"}']);
      }
      expect(await lockedUntilOf(onlyB)).toBeNull();
    });

    it('GET /admin/users/:id (uppercase hex = same user) => exact key set', async () => {
      const id = await mkUser({ [TENANT_A]: ['tenant_admin'] });
      const res = await call('GET', `/admin/users/${id.toUpperCase()}`, await tok(tadminA));
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(USER_KEYS);
      expect(res.json()).toMatchObject({
        id,
        emailVerified: true,
        locked: false,
        lockedUntil: null,
        membershipStatus: 'active',
        roles: ['tenant_admin'],
      });
    });

    it('lock (tenant_admin on a plain member) => login refused, AT 401 at /userinfo, refresh invalid_grant; audit', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      const flow = await realFlow(target);
      expect((await userinfo(flow.access_token)).statusCode).toBe(200);

      const res = await call('POST', `/admin/users/${target}/lock`, await tok(tadminA));
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(USER_KEYS);
      expect(res.json()).toMatchObject({ id: target, locked: true });
      expect((await lockedUntilOf(target))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());

      expect(await canLogin(target)).toBe(false);
      expect((await userinfo(flow.access_token)).statusCode).toBe(401);
      const r = await refresh(flow.refresh_token!);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('invalid_grant');
      // Login while locked never bumps the counter (B2.4).
      expect((await userModel.findById(target).lean())?.failedLoginCount ?? 0).toBe(0);

      const ev = await auditModel.findOne({ action: 'ADMIN_USER_LOCKED', targetId: target }).lean();
      expect(ev).toMatchObject({
        actorType: 'admin',
        actorId: tadminA,
        tenantId: TENANT_A,
        targetType: 'user',
        result: 'success',
        // DEBT-420: recorded right after the lock write (before the revoke) => no session count.
        metadata: { level: 'tenant_admin' },
      });
      // DEBT-421: the revoke and its session count are their own event once the revoke is done.
      expect(
        await auditModel.findOne({ action: 'SESSION_REVOKED', targetId: target }).lean(),
      ).toMatchObject({
        actorId: tadminA,
        tenantId: TENANT_A,
        result: 'success',
        metadata: { scope: 'all', count: 1, via: 'lock' },
      });
      // Second lock: revokes again (idempotent) and audits it (DEBT-152, like sessions/revoke).
      expect(
        (await call('POST', `/admin/users/${target}/lock`, await tok(tadminA))).statusCode,
      ).toBe(200);
      expect(
        await auditModel.countDocuments({
          action: 'ADMIN_USER_LOCKED',
          targetId: target,
          result: 'success',
        }),
      ).toBe(2);
    });

    it('lock (super_admin on a tenant_admin) => the target admin AT 401 at /admin/me; unlock => login works again', async () => {
      const target = await mkUser({ [TENANT_A]: ['tenant_admin'] });
      const adminFlow = await realFlow(target, { resource: ADMIN_AUD, scope: ADMIN_SCOPE });
      expect((await me(adminFlow.access_token)).statusCode).toBe(200);

      expect(
        (await call('POST', `/admin/users/${target}/lock`, await tok(superA))).statusCode,
      ).toBe(200);
      expect((await me(adminFlow.access_token)).statusCode).toBe(401);
      expect(await canLogin(target)).toBe(false);

      const un = await call('POST', `/admin/users/${target}/unlock`, await tok(superA));
      expect(un.statusCode).toBe(200);
      expect(un.json()).toMatchObject({ locked: false, lockedUntil: null });
      expect(await canLogin(target)).toBe(true);
      expect(
        await auditModel.findOne({ action: 'ADMIN_USER_UNLOCKED', targetId: target }).lean(),
      ).toMatchObject({ actorType: 'admin', actorId: superA, tenantId: TENANT_A });
      // Unlock revoked nothing: the old (already dead) AT stays dead, a new login works.
    });

    it('admin lock survives forgot + reset (new password still refused); unlock => login works', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      expect(
        (await call('POST', `/admin/users/${target}/lock`, await tok(tadminA))).statusCode,
      ).toBe(200);
      // Same generic forgot/reset path as any user (§9.12): nothing reveals the lock.
      await auth.resetPassword(await forgotToken(target), NEW_PASSWORD);

      expect((await lockedUntilOf(target))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      expect(await canLogin(target, NEW_PASSWORD)).toBe(false);
      expect(
        (await call('POST', `/admin/users/${target}/unlock`, await tok(tadminA))).statusCode,
      ).toBe(200);
      expect(await canLogin(target, NEW_PASSWORD)).toBe(true);
    });

    it('a brute-force (B2.4) temporary lock is still cleared by reset (no regression)', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      await userModel.updateOne(
        { _id: target },
        { $set: { lockedUntil: new Date(Date.now() + 15 * MIN), failedLoginCount: 5 } },
      );
      expect(await canLogin(target)).toBe(false);
      await auth.resetPassword(await forgotToken(target), NEW_PASSWORD);
      expect(await lockedUntilOf(target)).toBeNull();
      expect(await canLogin(target, NEW_PASSWORD)).toBe(true);
    });

    it('lock: revoke fault => 5xx, lock kept, failure audit; retry is idempotent 200', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      jest.spyOn(sessions, 'revokeAllForUser').mockRejectedValueOnce(new Error('redis down'));
      const res = await call('POST', `/admin/users/${target}/lock`, await tok(tadminA));
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('redis down');
      expect((await lockedUntilOf(target))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_USER_LOCKED', targetId: target, result: 'failure' })
          .lean(),
      ).toMatchObject({ reason: 'revoke_failed', metadata: { failedStep: 'sessions' } });
      // run 57: put the per-user mark ahead of this clock, so a follow-up event stamped with a bare
      // `new Date()` would sort BEFORE the retry's `LOCKED success` (m4).
      await userModel.updateOne(
        { _id: target },
        { $set: { adminLockMarkAt: new Date(Date.now() + 3_600_000) } },
      );
      expect(
        (await call('POST', `/admin/users/${target}/lock`, await tok(tadminA))).statusCode,
      ).toBe(200);
      // DEBT-152: the successful retry is audited, so the trail does not end on the failure.
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_USER_LOCKED', targetId: target, result: 'success' })
          .lean(),
      ).toMatchObject({ metadata: { level: 'tenant_admin' } });
      // DEBT-152 + DEBT-420: the trail ends on the retry's success, never on the failure.
      const trail = await auditModel
        .find({ action: 'ADMIN_USER_LOCKED', targetId: target })
        .sort({ timestamp: 1, _id: 1 })
        .lean();
      expect(trail.map((e) => String(e.result))).toEqual(['success', 'failure', 'success']);
      // DEBT-421: only the completed revoke (the retry) has a SESSION_REVOKED, with its count.
      const revoked = await auditModel.find({ action: 'SESSION_REVOKED', targetId: target }).lean();
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatchObject({
        result: 'success',
        metadata: { scope: 'all', count: 0, via: 'lock' },
      });
      // run 57: in the same request, the follow-up sorts strictly after `LOCKED success`.
      expect((revoked[0].timestamp as Date).getTime()).toBeGreaterThan(
        (trail[2].timestamp as Date).getTime(),
      );
    });

    it('sessions/revoke => AT 401, refresh invalid_grant, login still possible; audit SESSION_REVOKED scope=all', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      const flow = await realFlow(target);
      const res = await call('POST', `/admin/users/${target}/sessions/revoke`, await tok(tadminA));
      expect(res.statusCode).toBe(204);
      expect((await userinfo(flow.access_token)).statusCode).toBe(401);
      expect((await refresh(flow.refresh_token!)).json().error).toBe('invalid_grant');
      expect(await canLogin(target)).toBe(true);
      expect(
        await auditModel.findOne({ action: 'SESSION_REVOKED', targetId: target }).lean(),
      ).toMatchObject({
        actorType: 'admin',
        actorId: tadminA,
        tenantId: TENANT_A,
        result: 'success',
        metadata: { scope: 'all', count: 1 },
      });
    });

    it('tenant_admin: lock/unlock/revoke an admin of ANY tenant or a user active elsewhere => 403, nothing changes', async () => {
      const multi = await mkUser({ [TENANT_A]: [], [TENANT_B]: [] });
      const adminElsewhere = await mkUser({ [TENANT_A]: [], [TENANT_B]: ['tenant_admin'] });
      const peer = await mkUser({ [TENANT_A]: ['tenant_admin'] });
      const token = await tok(tadminA);
      for (const target of [multi, adminElsewhere, peer, superA]) {
        const flow = await realFlow(target);
        for (const action of ['lock', 'unlock', 'sessions/revoke']) {
          const res = await call('POST', `/admin/users/${target}/${action}`, token);
          expect(res.statusCode).toBe(403);
          expect(res.json()).toEqual({ error: 'forbidden' });
        }
        expect(await lockedUntilOf(target)).toBeNull();
        expect((await userinfo(flow.access_token)).statusCode).toBe(200);
      }
      // A suspended membership elsewhere does not block (only an ACTIVE one does).
      const suspElsewhere = await mkUser({ [TENANT_A]: [], [TENANT_B]: [] });
      await userTenantModel.updateOne(
        { userId: new Types.ObjectId(suspElsewhere), tenantId: TENANT_B },
        { $set: { status: 'suspended' } },
      );
      expect((await call('POST', `/admin/users/${suspElsewhere}/lock`, token)).statusCode).toBe(
        200,
      );
      // super_admin is not limited by the rule.
      expect((await call('POST', `/admin/users/${multi}/lock`, await tok(superA))).statusCode).toBe(
        200,
      );
    });

    it('self: lock / roles on yourself => 403 (even super_admin)', async () => {
      for (const actor of [tadminA, superA]) {
        const token = await tok(actor);
        expect((await call('POST', `/admin/users/${actor}/lock`, token)).statusCode).toBe(403);
        expect(
          (await call('POST', `/admin/users/${actor.toUpperCase()}/lock`, token)).statusCode,
        ).toBe(403);
        expect(
          (await call('PATCH', `/admin/users/${actor}/roles`, token, { roles: [] })).statusCode,
        ).toBe(403);
        expect(await lockedUntilOf(actor)).toBeNull();
      }
      expect(await rolesOf(tadminA)).toEqual(['tenant_admin']);
      expect(await rolesOf(superA)).toEqual(['super_admin']);
    });

    it('roles: tenant_admin granting super_admin (other or self) / touching a super_admin => 403, DB unchanged', async () => {
      const plain = await mkUser({ [TENANT_A]: [] });
      const otherSuper = await mkUser({ [TENANT_A]: ['super_admin'] });
      const token = await tok(tadminA);
      for (const [target, roles] of [
        [plain, ['super_admin']],
        [plain, ['tenant_admin', 'super_admin']],
        [tadminA, ['tenant_admin', 'super_admin']],
        [otherSuper, []],
        [otherSuper, ['super_admin', 'tenant_admin']],
      ] as const) {
        const res = await call('PATCH', `/admin/users/${target}/roles`, token, { roles });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
      }
      expect(await rolesOf(plain)).toEqual([]);
      expect(await rolesOf(otherSuper)).toEqual(['super_admin']);
      expect(await rolesOf(tadminA)).toEqual(['tenant_admin']);
      expect(
        await auditModel.countDocuments({
          action: 'ADMIN_USER_ROLES_CHANGED',
          targetId: { $in: [plain, otherSuper] },
        }),
      ).toBe(0);
    });

    it('roles: tenant_admin grants/revokes tenant_admin; super_admin grants super_admin; audit diff only on change', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      const ta = await tok(tadminA);
      const up = await call('PATCH', `/admin/users/${target}/roles`, ta, {
        roles: ['tenant_admin'],
      });
      expect(up.statusCode).toBe(200);
      expect(Object.keys(up.json()).sort()).toEqual(USER_KEYS);
      expect(up.json().roles).toEqual(['tenant_admin']);
      expect(await rolesOf(target)).toEqual(['tenant_admin']);
      expect(
        await auditModel.findOne({ action: 'ADMIN_USER_ROLES_CHANGED', targetId: target }).lean(),
      ).toMatchObject({
        actorType: 'admin',
        actorId: tadminA,
        tenantId: TENANT_A,
        metadata: { addedRoles: 'tenant_admin', removedRoles: '' },
      });
      // Same roles again: no audit.
      await call('PATCH', `/admin/users/${target}/roles`, ta, { roles: ['tenant_admin'] });
      expect(
        await auditModel.countDocuments({ action: 'ADMIN_USER_ROLES_CHANGED', targetId: target }),
      ).toBe(1);

      const sup = await call('PATCH', `/admin/users/${target}/roles`, await tok(superA), {
        roles: ['super_admin'],
      });
      expect(sup.statusCode).toBe(200);
      expect(await rolesOf(target)).toEqual(['super_admin']);
      const down = await call('PATCH', `/admin/users/${target}/roles`, await tok(superA), {
        roles: [],
      });
      expect(down.statusCode).toBe(200);
      expect(await rolesOf(target)).toEqual([]);
    });

    it('roles: body validation => 400 (unknown role, duplicate, >2, tenantId field)', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      const token = await tok(superA);
      for (const body of [
        { roles: ['member'] },
        { roles: ['tenant_admin', 'tenant_admin'] },
        { roles: ['tenant_admin', 'super_admin', 'tenant_admin'] },
        { roles: ['tenant_admin'], tenantId: TENANT_B },
        { roles: 'tenant_admin' },
        {},
      ]) {
        const res = await call('PATCH', `/admin/users/${target}/roles`, token, body);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
      expect(await rolesOf(target)).toEqual([]);
    });

    it('demoting a tenant_admin of B => the next admin request of B with the OLD token is 403 forbidden', async () => {
      const victim = await mkUser({ [TENANT_B]: ['tenant_admin'] });
      const old = await tok(victim, { client: CLIENT_B });
      expect((await me(old)).statusCode).toBe(200);
      const res = await call(
        'PATCH',
        `/admin/users/${victim}/roles`,
        await tok(tadminB, { client: CLIENT_B }),
        { roles: [] },
      );
      expect(res.statusCode).toBe(200);
      const after = await me(old);
      expect(after.statusCode).toBe(403);
      expect(after.json()).toEqual({ error: 'forbidden' });
    });

    it('step-up and scope: stale auth_time => 403 step_up_required; admin.read only => 403 insufficient_scope; GET with admin.read ok', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      const stale = await tok(tadminA, { authAgoMs: 6 * MIN });
      const readOnly = await tok(tadminA, { scope: 'openid admin.read' });
      for (const [method, suffix, body] of [
        ['POST', '/lock'],
        ['POST', '/unlock'],
        ['POST', '/sessions/revoke'],
        ['PATCH', '/roles', { roles: ['tenant_admin'] }],
      ] as const) {
        const a = await call(method, `/admin/users/${target}${suffix}`, stale, body);
        expect(a.statusCode).toBe(403);
        expect(a.json().error).toBe('step_up_required');
        const b = await call(method, `/admin/users/${target}${suffix}`, readOnly, body);
        expect(b.statusCode).toBe(403);
        expect(b.json().error).toBe('insufficient_scope');
      }
      expect(await lockedUntilOf(target)).toBeNull();
      expect((await call('GET', `/admin/users/${target}`, readOnly)).statusCode).toBe(200);
      expect((await call('GET', '/admin/users', readOnly)).statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------------------ Task 2: families + consents
  describe('Task 2 — refresh families + consents', () => {
    const FAMILY_KEYS = [
      'active',
      'clientId',
      'createdAt',
      'expiresAt',
      'familyId',
      'lastRotatedAt',
      'resource',
      'revokedAt',
      'scope',
    ].sort();
    const CONSENT_KEYS = [
      'clientId',
      'grantedAt',
      'grantedScopes',
      'id',
      'policyVersion',
      'resource',
      'termsVersion',
      'updatedAt',
    ].sort();

    /** Member of A with 3 grants: A×demo, A×other (same client), B×demo (tenant-B client). */
    async function fixture() {
      // Run 35 (DEBT-116): /authorize only serves active members of the client's tenant, so the
      // B×demo grant is obtained while a member of B; the user then leaves B (not a member of B).
      const user = await mkUser({ [TENANT_A]: [], [TENANT_B]: [] }, 'fam');
      const demo = await realFlow(user);
      const other = await realFlow(user, { resource: OTHER_AUD, sessionId: demo.sessionId });
      const foreign = await realFlow(user, { clientId: CLIENT_B, sessionId: demo.sessionId });
      await userTenantModel.deleteOne({ userId: new Types.ObjectId(user), tenantId: TENANT_B });
      const familyOf = async (clientId: string, resource: string) =>
        (await refreshModel
          .findOne({ userId: new Types.ObjectId(user), clientId, resource })
          .lean())!.familyId as string;
      return {
        user,
        demo,
        other,
        foreign,
        demoFamily: await familyOf(CLIENT_A, DEMO_AUD),
        otherFamily: await familyOf(CLIENT_A, OTHER_AUD),
        foreignFamily: await familyOf(CLIENT_B, DEMO_AUD),
      };
    }

    /** Run 36 (DEBT-207): the user left B, so a B×demo refresh is refused (not_member) and would
     * itself revoke the family; "admin of A did not touch it" is asserted on the stored docs. */
    const familyUntouched = async (familyId: string) =>
      (await refreshModel.countDocuments({ familyId, revokedAt: null })) === 1;

    it('GET families: only clients of the token tenant, one row per family, exact key set, no tokenHash', async () => {
      const f = await fixture();
      const rotated = await refresh(f.demo.refresh_token!);
      expect(rotated.statusCode).toBe(200);
      const res = await call('GET', `/admin/users/${f.user}/families`, await tok(tadminA));
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Record<string, unknown>[];
      expect(items.map((i) => i.familyId).sort()).toEqual([f.demoFamily, f.otherFamily].sort());
      for (const i of items) {
        expect(Object.keys(i).sort()).toEqual(FAMILY_KEYS);
        expect(i).toMatchObject({ clientId: CLIENT_A, active: true, revokedAt: null });
      }
      const demoRow = items.find((i) => i.familyId === f.demoFamily)!;
      expect(demoRow.resource).toBe(DEMO_AUD);
      expect(new Date(demoRow.lastRotatedAt as string).getTime()).toBeGreaterThanOrEqual(
        new Date(demoRow.createdAt as string).getTime(),
      );
      expect(res.body).not.toMatch(/tokenHash|parentId|replacedBy|sessionRef|deviceId|userAgent/);
      expect(res.body).not.toContain(f.foreignFamily);

      // Cursor walk (limit=1) sees each family exactly once.
      const token = await tok(tadminA);
      const seen: string[] = [];
      let after: string | null = null;
      do {
        const page = await call(
          'GET',
          `/admin/users/${f.user}/families?limit=1${after ? `&after=${after}` : ''}`,
          token,
        );
        seen.push(...(page.json().items as { familyId: string }[]).map((i) => i.familyId));
        after = page.json().nextCursor;
      } while (after && seen.length < 10);
      expect(seen).toEqual([f.demoFamily, f.otherFamily].sort());
    });

    it('GET families: a cursor that is not a familyId => 400 invalid cursor, no list call; other tenant still 404 (DEBT-155)', async () => {
      const token = await tok(tadminA);
      const user = await mkUser({ [TENANT_A]: [] });
      const onlyB = await mkUser({ [TENANT_B]: [] });
      const list = jest.spyOn(moduleRef.get(RefreshTokenService), 'listFamilies');
      try {
        for (const bad of ['{"$gt":""}', 'a_b', 'a'.repeat(129)]) {
          const res = await call(
            'GET',
            `/admin/users/${user}/families?after=${encodeURIComponent(bad)}`,
            token,
          );
          expect([bad, res.statusCode]).toEqual([bad, 400]);
          expect(res.json()).toEqual({
            error: 'invalid_request',
            error_description: 'invalid cursor',
          });
          expect(res.body).not.toContain('$gt');
        }
        expect(list).not.toHaveBeenCalled();
        // Tenant check first: a user outside the token tenant is 404 even with a bad cursor.
        const foreign = await call('GET', `/admin/users/${onlyB}/families?after=a_b`, token);
        expect(foreign.statusCode).toBe(404);
        // A valid-looking cursor still pages (128 chars is the upper bound).
        const ok = await call(
          'GET',
          `/admin/users/${user}/families?after=${'a'.repeat(128)}`,
          token,
        );
        expect(ok.statusCode).toBe(200);
      } finally {
        list.mockRestore();
      }
    });

    it('revoke family => old AND rotated refresh invalid_grant; other family lives; audit TOKEN_REVOKED once', async () => {
      const f = await fixture();
      const rotated = await refresh(f.demo.refresh_token!);
      const next = rotated.json().refresh_token as string;
      const res = await call(
        'POST',
        `/admin/users/${f.user}/families/${f.demoFamily}/revoke`,
        await tok(tadminA),
      );
      expect(res.statusCode).toBe(204);
      expect((await refresh(next)).json().error).toBe('invalid_grant');
      expect((await refresh(f.demo.refresh_token!)).json().error).toBe('invalid_grant');
      expect((await refresh(f.other.refresh_token!)).statusCode).toBe(200);
      expect(
        await refreshModel.countDocuments({ familyId: f.demoFamily, familyRevokedAt: null }),
      ).toBe(0);
      const ev = await auditModel
        .find({ action: 'TOKEN_REVOKED', 'metadata.familyId': f.demoFamily })
        .lean();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        actorType: 'admin',
        actorId: tadminA,
        tenantId: TENANT_A,
        clientId: CLIENT_A,
        targetId: f.user,
        result: 'success',
      });
      expect(JSON.stringify(ev)).not.toMatch(/tokenHash|refresh_token/);
      // Already revoked => still 204, no second audit; list shows it inactive.
      expect(
        (
          await call(
            'POST',
            `/admin/users/${f.user}/families/${f.demoFamily}/revoke`,
            await tok(tadminA),
          )
        ).statusCode,
      ).toBe(204);
      expect(
        await auditModel.countDocuments({
          action: 'TOKEN_REVOKED',
          'metadata.familyId': f.demoFamily,
        }),
      ).toBe(1);
      const list = await call('GET', `/admin/users/${f.user}/families`, await tok(tadminA));
      const row = (
        list.json().items as { familyId: string; active: boolean; revokedAt: string }[]
      ).find((i) => i.familyId === f.demoFamily)!;
      expect(row.active).toBe(false);
      expect(row.revokedAt).toBeTruthy();
    });

    it('revoke family of a tenant-B client / of another user / unknown / malformed => 404, nothing changes', async () => {
      const f = await fixture();
      const stranger = await mkUser({ [TENANT_A]: [] });
      const strangerFlow = await realFlow(stranger);
      const strangerFamily = (await refreshModel
        .findOne({ userId: new Types.ObjectId(stranger) })
        .lean())!.familyId as string;
      const token = await tok(superA);
      for (const [user, fam] of [
        [f.user, f.foreignFamily],
        [f.user, strangerFamily],
        [f.user, 'no-such-family'],
        [f.user, '$where'],
        [stranger, f.demoFamily],
      ]) {
        const res = await call(
          'POST',
          `/admin/users/${user}/families/${encodeURIComponent(fam)}/revoke`,
          token,
        );
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe('{"error":"not_found"}');
      }
      expect(await familyUntouched(f.foreignFamily)).toBe(true);
      expect((await refresh(strangerFlow.refresh_token!)).statusCode).toBe(200);
      expect((await refresh(f.demo.refresh_token!)).statusCode).toBe(200);
    });

    it('GET consents: only active consents of tenant clients, exact key set', async () => {
      const f = await fixture();
      const res = await call('GET', `/admin/users/${f.user}/consents`, await tok(tadminA));
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Record<string, unknown>[];
      expect(items.map((i) => `${i.clientId}|${i.resource}`).sort()).toEqual(
        [`${CLIENT_A}|${DEMO_AUD}`, `${CLIENT_A}|${OTHER_AUD}`].sort(),
      );
      for (const i of items) expect(Object.keys(i).sort()).toEqual(CONSENT_KEYS);
      expect(res.body).not.toContain(CLIENT_B);
      expect(res.body).not.toContain('_id');
      for (const q of ['after=zzz', `tenantId=${TENANT_B}`, 'limit=101']) {
        const bad = await call('GET', `/admin/users/${f.user}/consents?${q}`, await tok(tadminA));
        expect(bad.statusCode).toBe(400);
      }
    });

    it('revoke consent => /authorize shows the consent screen again; refresh of THAT user×client×resource invalid_grant, other resource lives; audit', async () => {
      const f = await fixture();
      expect((await authorize(f.demo.sessionId, CLIENT_A, DEMO_AUD)).statusCode).toBe(302);
      const consent = await consentModel
        .findOne({ userId: new Types.ObjectId(f.user), clientId: CLIENT_A, resource: DEMO_AUD })
        .lean();
      const id = String(consent!._id);
      const res = await call('DELETE', `/admin/users/${f.user}/consents/${id}`, await tok(tadminA));
      expect(res.statusCode).toBe(204);

      const page = await authorize(f.demo.sessionId, CLIENT_A, DEMO_AUD);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('name="request_id"');
      expect((await refresh(f.demo.refresh_token!)).json().error).toBe('invalid_grant');
      expect((await refresh(f.other.refresh_token!)).statusCode).toBe(200);
      expect(await familyUntouched(f.foreignFamily)).toBe(true);
      expect(
        await auditModel.findOne({ action: 'OAUTH_CONSENT_REVOKED', targetId: f.user }).lean(),
      ).toMatchObject({
        actorType: 'admin',
        actorId: tadminA,
        tenantId: TENANT_A,
        clientId: CLIENT_A,
        result: 'success',
        metadata: { clientId: CLIENT_A, resource: DEMO_AUD, count: 1 },
      });
      // Run 58 (DEBT-151, intended change; was "already revoked => 404, no second audit"): an
      // already revoked consent is an idempotent 204 that sweeps its families again and is audited.
      const again = await call(
        'DELETE',
        `/admin/users/${f.user}/consents/${id}`,
        await tok(tadminA),
      );
      expect(again.statusCode).toBe(204);
      expect(
        await auditModel.countDocuments({ action: 'OAUTH_CONSENT_REVOKED', targetId: f.user }),
      ).toBe(2);
      const list = await call('GET', `/admin/users/${f.user}/consents`, await tok(tadminA));
      expect((list.json().items as { id: string }[]).map((i) => i.id)).not.toContain(id);
    });

    it('revoke consent of a tenant-B client / of another user / malformed => 404, DB unchanged', async () => {
      const f = await fixture();
      const stranger = await mkUser({ [TENANT_A]: [] });
      await realFlow(stranger);
      const foreign = await consentModel
        .findOne({ userId: new Types.ObjectId(f.user), clientId: CLIENT_B })
        .lean();
      const strangers = await consentModel.findOne({ userId: new Types.ObjectId(stranger) }).lean();
      const token = await tok(superA);
      for (const [user, id] of [
        [f.user, String(foreign!._id)],
        [f.user, String(strangers!._id)],
        [f.user, new Types.ObjectId().toHexString()],
        [f.user, 'not-an-id'],
      ]) {
        const res = await call('DELETE', `/admin/users/${user}/consents/${id}`, token);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe('{"error":"not_found"}');
      }
      expect((await consentModel.findById(foreign!._id).lean())?.revokedAt ?? null).toBeNull();
      expect((await consentModel.findById(strangers!._id).lean())?.revokedAt ?? null).toBeNull();
      expect(await familyUntouched(f.foreignFamily)).toBe(true);
    });

    it('cross-tenant user, step-up and scope on family/consent routes', async () => {
      const f = await fixture();
      const consentId = String(
        (await consentModel
          .findOne({ userId: new Types.ObjectId(f.user), clientId: CLIENT_A })
          .lean())!._id,
      );
      // tenant B admin: the user is not a member of B => 404 everywhere.
      const b = await tok(tadminB, { client: CLIENT_B });
      for (const [method, url] of [
        ['GET', `/admin/users/${f.user}/families`],
        ['GET', `/admin/users/${f.user}/consents`],
        ['POST', `/admin/users/${f.user}/families/${f.foreignFamily}/revoke`],
        ['DELETE', `/admin/users/${f.user}/consents/${consentId}`],
      ] as const) {
        expect((await call(method, url, b)).statusCode).toBe(404);
      }
      const stale = await tok(tadminA, { authAgoMs: 6 * MIN });
      const readOnly = await tok(tadminA, { scope: 'openid admin.read' });
      for (const [method, url] of [
        ['POST', `/admin/users/${f.user}/families/${f.demoFamily}/revoke`],
        ['DELETE', `/admin/users/${f.user}/consents/${consentId}`],
      ] as const) {
        expect((await call(method, url, stale)).json().error).toBe('step_up_required');
        expect((await call(method, url, readOnly)).json().error).toBe('insufficient_scope');
      }
      expect((await refresh(f.demo.refresh_token!)).statusCode).toBe(200);
      // Run 36 (DEBT-207, intended change): the user is no longer a member of CLIENT_B's tenant,
      // so the refresh is refused and the whole B×demo family is revoked.
      expect((await refresh(f.foreign.refresh_token!, CLIENT_B)).json().error).toBe(
        'invalid_grant',
      );
      expect(
        await refreshModel.countDocuments({ familyId: f.foreignFamily, revokedAt: null }),
      ).toBe(0);
    });

    describe('run 58 DEBT-151: DELETE consent is idempotent, always sweeps, audits every call', () => {
      const consentOf = async (user: string, clientId = CLIENT_A, resource = DEMO_AUD) =>
        String(
          (await consentModel
            .findOne({ userId: new Types.ObjectId(user), clientId, resource })
            .lean())!._id,
        );
      const del = async (user: string, id: string) =>
        call('DELETE', `/admin/users/${user}/consents/${id}`, await tok(tadminA));
      const revokedAtOf = async (id: string) =>
        ((await consentModel.findById(id).lean())?.revokedAt as Date | null | undefined) ?? null;
      const audits = (user: string, result?: string) =>
        auditModel
          .find({ action: 'OAUTH_CONSENT_REVOKED', targetId: user, ...(result ? { result } : {}) })
          .sort({ timestamp: 1, _id: 1 })
          .lean();
      const familyActive = async (familyId: string) =>
        refreshModel.countDocuments({ familyId, revokedAt: null });

      it('(a) repeat after a successful revoke => 204, first revokedAt kept, second audit alreadyRevoked:true count:0', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        expect((await del(f.user, id)).statusCode).toBe(204);
        const first = await revokedAtOf(id);
        expect(first).toBeInstanceOf(Date);
        const again = await del(f.user, id);
        expect(again.statusCode).toBe(204);
        expect(again.body).toBe('');
        expect((await revokedAtOf(id))!.getTime()).toBe(first!.getTime());
        const rows = await audits(f.user);
        expect(rows.map((r) => r.metadata)).toEqual([
          { clientId: CLIENT_A, resource: DEMO_AUD, count: 1, alreadyRevoked: false },
          { clientId: CLIENT_A, resource: DEMO_AUD, count: 0, alreadyRevoked: true },
        ]);
        expect(rows.every((r) => r.result === 'success')).toBe(true);
      });

      it('(b) family sweep fails => 5xx + failure audit; the family lived on; retry => 204 and the family dies', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        jest
          .spyOn(moduleRef.get(RefreshTokenService), 'revokeForConsent')
          .mockRejectedValueOnce(new Error('mongo sweep down'));
        const res = await del(f.user, id);
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
        expect(res.body).not.toContain('mongo sweep down');
        expect(await revokedAtOf(id)).toBeInstanceOf(Date);
        // The sweep did not run: the family lived on. Since run 69 (DEBT-214) the refresh grant
        // re-checks consent itself, so its next refresh is refused and kills it anyway.
        expect(await familyActive(f.demoFamily)).toBe(1);
        const rotated = await refresh(f.demo.refresh_token!);
        expect(rotated.statusCode).toBe(400);
        expect(rotated.json().error).toBe('invalid_grant');
        expect(await familyActive(f.demoFamily)).toBe(0);
        expect(await audits(f.user, 'failure')).toEqual([
          expect.objectContaining({
            reason: 'family_sweep_failed',
            metadata: { clientId: CLIENT_A, resource: DEMO_AUD, alreadyRevoked: false },
          }),
        ]);
        expect(await audits(f.user, 'success')).toHaveLength(0);

        expect((await del(f.user, id)).statusCode).toBe(204);
        expect(await familyActive(f.demoFamily)).toBe(0);
        expect(
          await refreshModel.countDocuments({ familyId: f.demoFamily, familyRevokedAt: null }),
        ).toBe(0);
        expect((await audits(f.user, 'success')).map((r) => r.metadata)).toEqual([
          expect.objectContaining({ alreadyRevoked: true }),
        ]);
        expect(await familyActive(f.otherFamily)).toBe(1);
      });

      it('(c) success audit fails => 5xx with the family already revoked; retry => 204 + exactly one success audit', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        jest
          .spyOn(moduleRef.get(AuditService), 'record')
          .mockRejectedValueOnce(new Error('audit down'));
        const res = await del(f.user, id);
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
        expect(res.body).not.toContain('audit down');
        expect(await familyActive(f.demoFamily)).toBe(0);
        expect((await del(f.user, id)).statusCode).toBe(204);
        const rows = await audits(f.user);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          result: 'success',
          metadata: { clientId: CLIENT_A, resource: DEMO_AUD, count: 0, alreadyRevoked: true },
        });
      });

      it('(d) two concurrent DELETEs => both 204, one alreadyRevoked:false + one alreadyRevoked:true, family revoked', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        const token = await tok(tadminA);
        const res = await Promise.all([
          call('DELETE', `/admin/users/${f.user}/consents/${id}`, token),
          call('DELETE', `/admin/users/${f.user}/consents/${id}`, token),
        ]);
        expect(res.map((r) => r.statusCode)).toEqual([204, 204]);
        const flags = (await audits(f.user, 'success'))
          .map((r) => (r.metadata as { alreadyRevoked: boolean }).alreadyRevoked)
          .sort();
        expect(flags).toEqual([false, true]);
        expect(await familyActive(f.demoFamily)).toBe(0);
        expect((await refresh(f.demo.refresh_token!)).json().error).toBe('invalid_grant');
      });

      it('(e) ALREADY revoked consent of a tenant-B client / another user / unknown / malformed => 404 byte-identical, DB unchanged', async () => {
        const f = await fixture();
        const stranger = await mkUser({ [TENANT_A]: [] }, 'str');
        const sf = await realFlow(stranger);
        const strangerFamily = (await refreshModel
          .findOne({ userId: new Types.ObjectId(stranger) })
          .lean())!.familyId as string;
        const foreign = await consentOf(f.user, CLIENT_B);
        const strangers = await consentOf(stranger);
        const stamp = new Date('2020-01-01T00:00:00.000Z');
        await consentModel.updateMany(
          { _id: { $in: [new Types.ObjectId(foreign), new Types.ObjectId(strangers)] } },
          { $set: { revokedAt: stamp } },
        );
        const token = await tok(superA);
        const shapes = new Set<string>();
        for (const id of [foreign, strangers, new Types.ObjectId().toHexString(), 'not-an-id']) {
          const res = await call('DELETE', `/admin/users/${f.user}/consents/${id}`, token);
          shapes.add(`${res.statusCode} ${String(res.headers['content-type'])} ${res.body}`);
        }
        expect([...shapes]).toHaveLength(1);
        expect([...shapes][0]).toMatch(/^404 application\/json.* \{"error":"not_found"\}$/);
        expect((await revokedAtOf(foreign))!.getTime()).toBe(stamp.getTime());
        expect((await revokedAtOf(strangers))!.getTime()).toBe(stamp.getTime());
        expect(await familyUntouched(f.foreignFamily)).toBe(true);
        expect(await familyActive(strangerFamily)).toBe(1);
        // Run 69 (DEBT-214): its consent was stamped revoked above, so the refresh grant itself
        // now refuses it (the 404 DELETEs still changed nothing, checked just above).
        expect((await refresh(sf.refresh_token!)).json().error).toBe('invalid_grant');
        expect(await audits(f.user)).toHaveLength(0);
      });
    });

    // ---------------------------------------------------------------- run 58 tester (DEBT-151)
    describe('run 58 tester DEBT-151: retry/replay/concurrency/guard risk matrix', () => {
      const consentOf = async (user: string, clientId = CLIENT_A, resource = DEMO_AUD) =>
        String(
          (await consentModel
            .findOne({ userId: new Types.ObjectId(user), clientId, resource })
            .lean())!._id,
        );
      const revokedAtOf = async (id: string) =>
        ((await consentModel.findById(id).lean())?.revokedAt as Date | null | undefined) ?? null;
      const consentAudits = (user: string, result?: string) =>
        auditModel
          .find({ action: 'OAUTH_CONSENT_REVOKED', targetId: user, ...(result ? { result } : {}) })
          .lean();
      const familyActive = (familyId: string) =>
        refreshModel.countDocuments({ familyId, revokedAt: null });
      /** A refresh that slipped past a sweep (or a resurrected doc): one live RT in the family. */
      const resurrect = (familyId: string) =>
        refreshModel.updateOne({ familyId }, { $set: { revokedAt: null, familyRevokedAt: null } });

      it('T58-1 sequential x4 + concurrent x6 => every call 204, family swept EVERY time, first revokedAt kept, exactly one alreadyRevoked:false', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        const token = await tok(tadminA);
        const del = () => call('DELETE', `/admin/users/${f.user}/consents/${id}`, token);
        expect((await del()).statusCode).toBe(204);
        const first = (await revokedAtOf(id))!.getTime();
        for (let i = 0; i < 3; i++) {
          await resurrect(f.demoFamily);
          expect(await familyActive(f.demoFamily)).toBe(1);
          const res = await del();
          expect(res.statusCode).toBe(204);
          expect(res.body).toBe('');
          expect(await familyActive(f.demoFamily)).toBe(0);
          expect((await revokedAtOf(id))!.getTime()).toBe(first);
        }
        await resurrect(f.demoFamily);
        const burst = await Promise.all(Array.from({ length: 6 }, () => del()));
        expect(burst.map((r) => r.statusCode)).toEqual(Array(6).fill(204));
        expect(await familyActive(f.demoFamily)).toBe(0);
        expect((await revokedAtOf(id))!.getTime()).toBe(first);
        const rows = await consentAudits(f.user);
        expect(rows).toHaveLength(10);
        expect(rows.every((r) => r.result === 'success')).toBe(true);
        const meta = rows.map((r) => r.metadata as { alreadyRevoked: boolean; count: number });
        expect(meta.filter((m) => !m.alreadyRevoked)).toHaveLength(1);
        // First call swept 1, the 3 sequential retries each swept the resurrected doc, the burst once.
        expect(meta.reduce((s, m) => s + m.count, 0)).toBe(1 + 3 + 1);
        for (const r of rows) {
          expect(Object.keys(r.metadata as object).sort()).toEqual(
            ['alreadyRevoked', 'clientId', 'count', 'resource'].sort(),
          );
          expect(JSON.stringify(r)).not.toMatch(/tokenHash|refresh_token/);
        }
        // offline_access family: the latest RT is dead; the unrelated family of the same user lives.
        expect((await refresh(f.demo.refresh_token!)).json().error).toBe('invalid_grant');
        expect(await familyActive(f.otherFamily)).toBe(1);
      });

      it('T58-2 sweep fails twice (the 2nd with the failure audit also down) => 500 each, nothing leaks; 3rd call converges', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        const token = await tok(tadminA);
        const del = () => call('DELETE', `/admin/users/${f.user}/consents/${id}`, token);
        const sweep = jest.spyOn(moduleRef.get(RefreshTokenService), 'revokeForConsent');
        sweep.mockRejectedValueOnce(new Error('sweep-down-1'));
        const r1 = await del();
        expect(r1.statusCode).toBe(500);
        expect(r1.body).not.toContain('sweep-down');
        const first = (await revokedAtOf(id))!.getTime();
        sweep.mockRejectedValueOnce(new Error('sweep-down-2'));
        jest
          .spyOn(moduleRef.get(AuditService), 'record')
          .mockRejectedValueOnce(new Error('audit-down-2'));
        const r2 = await del();
        expect(r2.statusCode).toBe(500);
        expect(r2.body).not.toMatch(/sweep-down|audit-down/);
        expect(await familyActive(f.demoFamily)).toBe(1);
        const r3 = await del();
        expect(r3.statusCode).toBe(204);
        expect(await familyActive(f.demoFamily)).toBe(0);
        expect((await revokedAtOf(id))!.getTime()).toBe(first);
        expect((await refresh(f.demo.refresh_token!)).json().error).toBe('invalid_grant');
        const fails = await consentAudits(f.user, 'failure');
        expect(
          fails.map((r) => [r.reason, (r.metadata as { alreadyRevoked: boolean }).alreadyRevoked]),
        ).toEqual([['family_sweep_failed', false]]);
        const ok = await consentAudits(f.user, 'success');
        expect(ok.map((r) => r.metadata)).toEqual([
          { clientId: CLIENT_A, resource: DEMO_AUD, count: 1, alreadyRevoked: true },
        ]);
      });

      it('T58-3 revokeById (DB) fails => 500, nothing changed, no audit; retry => 204 alreadyRevoked:false', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        const token = await tok(tadminA);
        jest
          .spyOn(moduleRef.get(ConsentService), 'revokeById')
          .mockRejectedValueOnce(new Error('mongo-consent-down'));
        const r1 = await call('DELETE', `/admin/users/${f.user}/consents/${id}`, token);
        expect(r1.statusCode).toBe(500);
        expect(r1.body).not.toContain('mongo-consent-down');
        expect(await revokedAtOf(id)).toBeNull();
        expect(await familyActive(f.demoFamily)).toBe(1);
        expect(await consentAudits(f.user)).toHaveLength(0);
        const r2 = await call('DELETE', `/admin/users/${f.user}/consents/${id}`, token);
        expect(r2.statusCode).toBe(204);
        expect((await consentAudits(f.user)).map((r) => r.metadata)).toEqual([
          { clientId: CLIENT_A, resource: DEMO_AUD, count: 1, alreadyRevoked: false },
        ]);
      });

      it('T58-4 tenant-B admin vs a user who IS a member of B: A-client consent (active and revoked) => 404 byte-identical to an unknown id, untouched', async () => {
        const both = await mkUser({ [TENANT_A]: [], [TENANT_B]: [] }, 'both');
        const flow = await realFlow(both);
        const fam = (await refreshModel
          .findOne({ userId: new Types.ObjectId(both), clientId: CLIENT_A })
          .lean())!.familyId as string;
        const id = await consentOf(both);
        const b = await tok(tadminB, { client: CLIENT_B });
        const shape = async (cid: string) => {
          const r = await call('DELETE', `/admin/users/${both}/consents/${cid}`, b);
          return `${r.statusCode} ${String(r.headers['content-type'])} ${r.body}`;
        };
        const unknown = await shape(new Types.ObjectId().toHexString());
        expect(unknown).toMatch(/^404 /);
        expect(await shape(id)).toBe(unknown);
        expect(await revokedAtOf(id)).toBeNull();
        const stamp = new Date('2021-02-03T04:05:06.000Z');
        await consentModel.updateOne(
          { _id: new Types.ObjectId(id) },
          { $set: { revokedAt: stamp } },
        );
        expect(await shape(id)).toBe(unknown);
        expect((await revokedAtOf(id))!.getTime()).toBe(stamp.getTime());
        expect(await familyActive(fam)).toBe(1);
        // Run 69 (DEBT-214): the consent was stamped revoked above, so the refresh grant itself
        // now refuses it (the tenant-B DELETEs still changed nothing, checked just above).
        expect((await refresh(flow.refresh_token!)).json().error).toBe('invalid_grant');
        expect(await consentAudits(both)).toHaveLength(0);
      });

      it('T58-5 guards on an ALREADY revoked consent: no token 401, stale auth step_up_required, read-only insufficient_scope; no sweep, no audit', async () => {
        const f = await fixture();
        const id = await consentOf(f.user);
        const stamp = new Date('2022-01-01T00:00:00.000Z');
        await consentModel.updateOne(
          { _id: new Types.ObjectId(id) },
          { $set: { revokedAt: stamp } },
        );
        const url = `/admin/users/${f.user}/consents/${id}`;
        const anon = await app.inject({ method: 'DELETE', url });
        expect(anon.statusCode).toBe(401);
        const stale = await call('DELETE', url, await tok(tadminA, { authAgoMs: 6 * MIN }));
        expect(stale.statusCode).toBe(403);
        expect(stale.json().error).toBe('step_up_required');
        const ro = await call('DELETE', url, await tok(tadminA, { scope: 'openid admin.read' }));
        expect(ro.statusCode).toBe(403);
        expect(ro.json().error).toBe('insufficient_scope');
        expect(await familyActive(f.demoFamily)).toBe(1);
        expect((await revokedAtOf(id))!.getTime()).toBe(stamp.getTime());
        expect(await consentAudits(f.user)).toHaveLength(0);
      });
    });
  });

  // ------------------------------------------------------------------ Task 3: audit query
  describe('Task 3 — audit log query', () => {
    const AUDIT_KEYS = new Set([
      'eventId',
      'timestamp',
      'actorType',
      'actorId',
      'action',
      'targetType',
      'targetId',
      'clientId',
      'ip',
      'userAgent',
      'requestId',
      'result',
      'reason',
      'metadata',
    ]);
    type Ev = { eventId: string; timestamp: string; action: string };

    /** Seed events for a unique actor: 5 in A (two share a timestamp), 1 in B, 1 without tenant. */
    async function seed() {
      const actor = `${RUN}-auditor-${++seq}`;
      const base = Date.now() - 60 * MIN;
      const at = (m: number) => new Date(base + m * MIN);
      const ev = (eventId: string, timestamp: Date, over: Record<string, unknown> = {}) => ({
        eventId,
        timestamp,
        actorType: 'admin',
        actorId: actor,
        tenantId: TENANT_A,
        action: 'ADMIN_CLIENT_UPDATED',
        result: 'success',
        ...over,
      });
      await auditModel.create([
        ev(`${actor}-1`, at(1), { targetType: 'client', targetId: 'c-1', clientId: 'c-1' }),
        ev(`${actor}-2`, at(2), { result: 'failure', reason: 'revoke_failed' }),
        ev(`${actor}-3a`, at(3), { action: 'ADMIN_USER_LOCKED', metadata: { count: 1 } }),
        ev(`${actor}-3b`, at(3), { action: 'ADMIN_USER_LOCKED' }),
        ev(`${actor}-4`, at(4)),
        ev(`${actor}-B`, at(5), { tenantId: TENANT_B }),
        ev(`${actor}-none`, at(6), { tenantId: undefined }),
      ]);
      // Expected order for tenant A: newest first, ties by _id desc (run 57: insertion order).
      const expected = [`${actor}-4`, `${actor}-3b`, `${actor}-3a`, `${actor}-2`, `${actor}-1`];
      return { actor, at, expected };
    }

    it('newest first, stable cursor pages (ties by _id), a write between pages neither repeats nor drops', async () => {
      const { actor, expected } = await seed();
      const token = await tok(tadminA);
      const first = await call('GET', `/admin/audit?actorId=${actor}&limit=2`, token);
      expect(first.statusCode).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      const seen = (first.json().items as Ev[]).map((e) => e.eventId);
      let after = first.json().nextCursor as string | null;
      expect(after).toMatch(/^[A-Za-z0-9_-]+$/);
      // A new event of the same actor lands between page 1 and page 2.
      await auditModel.create({
        eventId: `${actor}-new`,
        timestamp: new Date(),
        actorType: 'admin',
        actorId: actor,
        tenantId: TENANT_A,
        action: 'ADMIN_CLIENT_UPDATED',
        result: 'success',
      });
      while (after) {
        const page = await call(
          'GET',
          `/admin/audit?actorId=${actor}&limit=2&after=${after}`,
          token,
        );
        expect(page.statusCode).toBe(200);
        seen.push(...(page.json().items as Ev[]).map((e) => e.eventId));
        after = page.json().nextCursor;
      }
      expect(seen).toEqual(expected);
      // A fresh first page does show the new event, on top.
      const fresh = await call('GET', `/admin/audit?actorId=${actor}&limit=1`, token);
      expect(fresh.json().items[0].eventId).toBe(`${actor}-new`);
    });

    /** run 57 (DEBT-422): 5 events of one tenant at ONE ms, `_id` ascending, `eventId` descending. */
    async function seedSameMs() {
      const actor = `${RUN}-tie-${++seq}`;
      const ts = new Date(Date.now() - 30 * MIN);
      const ids = Array.from({ length: 5 }, () => new Types.ObjectId());
      const ev = (_id: Types.ObjectId, eventId: string, timestamp: Date, tenantId = TENANT_A) => ({
        _id,
        eventId,
        timestamp,
        actorType: 'admin',
        actorId: actor,
        tenantId,
        action: 'ADMIN_CLIENT_UPDATED',
        result: 'success',
      });
      await auditModel.create(ids.map((id, k) => ev(id, `${actor}-${9 - k}`, ts)));
      return { actor, ts, ids, ev };
    }
    const hexes = (ids: Types.ObjectId[]) => ids.map((i) => i.toHexString());

    it('T2a same-ms events come back in _id desc order, whatever their eventId', async () => {
      const { actor, ids } = await seedSameMs();
      const res = await call('GET', `/admin/audit?actorId=${actor}&limit=100`, await tok(tadminA));
      expect(res.statusCode).toBe(200);
      const got = (res.json().items as Ev[]).map((e) => e.eventId);
      // eventId `${actor}-${9-k}` belongs to ids[k]; _id desc => k = 4..0 => suffix 5..9.
      expect(got).toEqual([5, 6, 7, 8, 9].map((n) => `${actor}-${n}`));
      expect(hexes(ids)).toEqual([...hexes(ids)].sort()); // _id really ascends in insert order
    });

    it('T2b cursor pages across a same-ms boundary (limit=2): all 7 events, no repeat, no gap, in order', async () => {
      const { actor, ts, ev } = await seedSameMs();
      const before = new Types.ObjectId();
      const after = new Types.ObjectId();
      await auditModel.create([
        ev(after, `${actor}-later`, new Date(ts.getTime() + 1)),
        ev(before, `${actor}-earlier`, new Date(ts.getTime() - 1)),
      ]);
      const token = await tok(tadminA);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await call(
          'GET',
          `/admin/audit?actorId=${actor}&limit=2${cursor ? `&after=${cursor}` : ''}`,
          token,
        );
        expect(page.statusCode).toBe(200);
        seen.push(...(page.json().items as Ev[]).map((e) => e.eventId));
        cursor = page.json().nextCursor as string | null;
        if (cursor) {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as object;
          expect(Object.keys(decoded).sort()).toEqual(['i', 't']);
        }
      } while (cursor && ++pages < 10);
      expect(seen).toEqual([
        `${actor}-later`,
        ...[5, 6, 7, 8, 9].map((n) => `${actor}-${n}`),
        `${actor}-earlier`,
      ]);
    });

    it('T2d cursor holding the _id of a tenant B event, used by tenant A => only tenant A rows, no error', async () => {
      const { actor, ts, ev } = await seedSameMs();
      const bId = new Types.ObjectId();
      await auditModel.create(ev(bId, `${actor}-B`, ts, TENANT_B));
      const forged = Buffer.from(
        JSON.stringify({ t: ts.getTime(), i: bId.toHexString() }),
      ).toString('base64url');
      const res = await call(
        'GET',
        `/admin/audit?actorId=${actor}&limit=100&after=${forged}`,
        await tok(tadminA),
      );
      expect(res.statusCode).toBe(200);
      // bId is the newest _id: every A event at ts sorts after it.
      expect((res.json().items as Ev[]).map((e) => e.eventId)).toEqual(
        [5, 6, 7, 8, 9].map((n) => `${actor}-${n}`),
      );
    });

    it('tenant isolation: B and tenant-less events never show; tenant B admin sees only its own', async () => {
      const { actor } = await seed();
      const a = await call('GET', `/admin/audit?actorId=${actor}&limit=100`, await tok(tadminA));
      const ids = (a.json().items as Ev[]).map((e) => e.eventId);
      expect(ids).not.toContain(`${actor}-B`);
      expect(ids).not.toContain(`${actor}-none`);
      const b = await call(
        'GET',
        `/admin/audit?actorId=${actor}&limit=100`,
        await tok(tadminB, { client: CLIENT_B }),
      );
      expect((b.json().items as Ev[]).map((e) => e.eventId)).toEqual([`${actor}-B`]);
    });

    it('exact-match filters: action, result, targetType/targetId, clientId, [from, to)', async () => {
      const { actor, at } = await seed();
      const token = await tok(tadminA);
      const ids = async (q: string) =>
        ((await call('GET', `/admin/audit?actorId=${actor}&${q}`, token)).json().items as Ev[]).map(
          (e) => e.eventId,
        );
      expect(await ids('action=ADMIN_USER_LOCKED')).toEqual([`${actor}-3b`, `${actor}-3a`]);
      expect(await ids('result=failure')).toEqual([`${actor}-2`]);
      expect(await ids('targetType=client&targetId=c-1')).toEqual([`${actor}-1`]);
      expect(await ids('clientId=c-1')).toEqual([`${actor}-1`]);
      expect(await ids('targetId=c-')).toEqual([]); // no prefix match
      expect(await ids('targetId=.*')).toEqual([]); // no regex
      const range = `from=${at(2).toISOString()}&to=${at(4).toISOString()}`;
      expect(await ids(range)).toEqual([`${actor}-3b`, `${actor}-3a`, `${actor}-2`]);
      // Partial actorId never matches (exact only).
      const partial = await call('GET', `/admin/audit?actorId=${actor.slice(0, -1)}`, token);
      expect(partial.json().items).toEqual([]);
    });

    it('response: allowlisted keys only (no _id / tenantId), metadata kept', async () => {
      const { actor } = await seed();
      const res = await call(
        'GET',
        `/admin/audit?actorId=${actor}&action=ADMIN_USER_LOCKED`,
        await tok(tadminA, { scope: 'openid admin.read' }),
      );
      expect(res.statusCode).toBe(200);
      for (const e of res.json().items as Record<string, unknown>[]) {
        for (const k of Object.keys(e)) expect(AUDIT_KEYS.has(k)).toBe(true);
      }
      expect(res.body).not.toContain('"_id"');
      expect(res.body).not.toContain('tenantId');
      expect(res.json().items[1].metadata).toEqual({ count: 1 });
    });

    it('a real admin mutation is queryable (lock => ADMIN_USER_LOCKED of this tenant)', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      await call('POST', `/admin/users/${target}/lock`, await tok(tadminA));
      const res = await call(
        'GET',
        `/admin/audit?action=ADMIN_USER_LOCKED&targetId=${target}`,
        await tok(tadminA),
      );
      expect(res.json().items).toHaveLength(1);
      expect(res.json().items[0]).toMatchObject({ actorType: 'admin', actorId: tadminA });
    });

    it('bad query => 400 invalid_request (tenantId, limit, cursor, range, enum, length)', async () => {
      const token = await tok(tadminA);
      const forged = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const now = new Date().toISOString();
      for (const q of [
        `tenantId=${TENANT_B}`,
        'limit=101',
        'limit=0',
        'after=%24%24%24',
        `after=${forged({ t: 'x', e: 'y' })}`,
        `after=${forged({ t: 1 })}`,
        `after=${forged({ t: 1.5, e: 'y' })}`,
        `after=${Buffer.from('not json').toString('base64url')}`,
        `from=${now}&to=${now}`,
        `from=2026-10-17T00:00:00Z&to=2026-10-16T00:00:00Z`,
        'from=yesterday',
        'action=NOT_AN_ACTION',
        'result=maybe',
        `actorId=${'a'.repeat(129)}`,
        `targetType=${'t'.repeat(65)}`,
      ]) {
        const res = await call('GET', `/admin/audit?${q}`, token);
        expect([q, res.statusCode]).toEqual([q, 400]);
        expect(res.json().error).toBe('invalid_request');
      }
      expect((await call('GET', '/admin/audit?limit=100', token)).statusCode).toBe(200);
    });

    it('run 48 (DEBT-140 part): a real refresh reuse is visible to the client tenant admin only', async () => {
      const user = await mkUser({ [TENANT_A]: [] }, 'reuse');
      const flow = await realFlow(user);
      const familyId = (await refreshModel.findOne({ userId: new Types.ObjectId(user) }).lean())!
        .familyId as string;
      expect((await refresh(flow.refresh_token!)).statusCode).toBe(200);
      const replay = await refresh(flow.refresh_token!);
      expect(replay.json().error).toBe('invalid_grant');

      const q = `/admin/audit?action=TOKEN_REUSE_DETECTED&clientId=${CLIENT_A}&limit=100`;
      const mine = (await call('GET', q, await tok(tadminA))).json().items as Array<
        Record<string, unknown> & { metadata?: Record<string, unknown> }
      >;
      const hit = mine.filter((e) => e.metadata?.familyId === familyId);
      expect(hit).toHaveLength(1);
      expect(hit[0]).toMatchObject({
        action: 'TOKEN_REUSE_DETECTED',
        actorType: 'client',
        actorId: CLIENT_A,
        result: 'failure',
      });
      expect(hit[0]).not.toHaveProperty('tenantId');

      const other = await call('GET', q, await tok(tadminB, { client: CLIENT_B }));
      expect(other.statusCode).toBe(200);
      expect(other.json().items).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ QA (tester, run 28): risk matrix
  describe('QA — risk matrix', () => {
    it('identity: no token / garbage token => 401; plain member with an admin token => 403 forbidden', async () => {
      const plain = await mkUser({ [TENANT_A]: [] }, 'plain');
      const target = await mkUser({ [TENANT_A]: [] });
      for (const url of ['/admin/users', `/admin/users/${target}`, '/admin/audit']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
        expect((await call('GET', url, 'not-a-jwt')).statusCode).toBe(401);
        const res = await call('GET', url, await tok(plain));
        expect([url, res.statusCode, res.body]).toEqual([url, 403, '{"error":"forbidden"}']);
      }
      const res = await call('POST', `/admin/users/${target}/lock`, await tok(plain));
      expect(res.statusCode).toBe(403);
      expect(await lockedUntilOf(target)).toBeNull();
    });

    it('input: operator / array / encoded payloads in query => 400, never widened', async () => {
      const token = await tok(tadminA);
      for (const url of [
        '/admin/users?email[$ne]=x',
        '/admin/users?email=a@example.com&email=b@example.com',
        '/admin/users?limit=-1',
        '/admin/users?limit=1.5',
        '/admin/users?limit=abc',
        '/admin/audit?actorId[$gt]=',
        '/admin/audit?actorId=a&actorId=b',
        '/admin/audit?tenantId[$ne]=x',
        '/admin/audit?limit=-5',
      ]) {
        const res = await call('GET', url, token);
        expect([url, res.statusCode]).toEqual([url, 400]);
        expect(res.json().error).toBe('invalid_request');
      }
      const f = await mkUser({ [TENANT_A]: [] });
      for (const sub of ['families', 'consents']) {
        for (const q of ['limit=0', 'limit=101', 'tenantId=x']) {
          const res = await call('GET', `/admin/users/${f}/${sub}?${q}`, token);
          expect([sub, q, res.statusCode]).toEqual([sub, q, 400]);
        }
      }
      // consents cursor is an ObjectId; a garbage one => 400 (not 5xx).
      expect((await call('GET', `/admin/users/${f}/consents?after=zzz`, token)).statusCode).toBe(
        400,
      );
      // families cursor must be a familyId (DEBT-155): an operator-looking value => 400, no 5xx.
      const fam = await call(
        'GET',
        `/admin/users/${f}/families?after=${encodeURIComponent('{"$gt":""}')}`,
        token,
      );
      expect(fam.statusCode).toBe(400);
    });

    it('audit cursor: negative / oversized / non-object / legacy `{t,e}` / malformed `i` payloads => 400 (T2c)', async () => {
      const token = await tok(tadminA);
      const forged = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const hex = 'a'.repeat(24);
      for (const after of [
        forged({ t: -1, e: 'y' }),
        forged({ t: 1, e: '' }),
        forged({ t: 1, e: 'e'.repeat(129) }),
        forged({ t: 1, e: 5 }),
        forged([1, 'y']),
        forged(null),
        forged(1),
        forged({ t: Number.MAX_SAFE_INTEGER + 2, e: 'y' }),
        // run 57 (DEBT-422): the pre-run-57 cursor `{t, e}` is refused (client restarts at page 1).
        forged({ t: 0, e: 'x' }),
        forged({ t: 1, e: 'y', i: 5 }),
        forged({ t: 1, i: 'a'.repeat(23) }),
        forged({ t: 1, i: 'a'.repeat(25) }),
        forged({ t: 1, i: 'A'.repeat(24) }),
        forged({ t: 1, i: 'g'.repeat(24) }),
        forged({ t: 1, i: 1234567890 }),
        forged({ t: 1, i: { $gt: '' } }),
        forged({ t: 1, i: [hex] }),
        forged({ t: 1 }),
        forged({ i: hex }),
        forged({ t: -1, i: hex }),
        forged({ t: 1.5, i: hex }),
        forged({ t: Number.MAX_SAFE_INTEGER + 2, i: hex }),
        // DEBT-427: beyond the JS Date range (8.64e15 ms) => 400, never a 5xx cast error.
        forged({ t: 8.64e15 + 1, i: hex }),
        forged({ t: 9e15, i: hex }),
        forged({ t: Number.MAX_SAFE_INTEGER, i: hex }),
      ]) {
        const res = await call('GET', `/admin/audit?after=${after}`, token);
        expect([after, res.statusCode, res.json()]).toEqual([
          after,
          400,
          { error: 'invalid_request', error_description: 'invalid cursor' },
        ]);
      }
      // A well-formed cursor from the past is fine (empty page, never 5xx).
      const ok = await call(
        'GET',
        `/admin/audit?after=${forged({ t: 0, i: '0'.repeat(24) })}`,
        token,
      );
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ items: [], nextCursor: null });
      // The largest valid Date (8.64e15) is accepted (200, never 5xx).
      const max = await call('GET', `/admin/audit?after=${forged({ t: 8.64e15, i: hex })}`, token);
      expect(max.statusCode).toBe(200);
    });

    it('cross-tenant 404 is byte-identical (body + content-type) for families/consents GET and revoke', async () => {
      const onlyB = await mkUser({ [TENANT_B]: [] });
      await realFlow(onlyB, { clientId: CLIENT_B });
      const famB = (await refreshModel.findOne({ userId: new Types.ObjectId(onlyB) }).lean())!
        .familyId as string;
      const conB = String(
        (await consentModel.findOne({ userId: new Types.ObjectId(onlyB) }).lean())!._id,
      );
      const token = await tok(superA);
      const shapes = new Set<string>();
      for (const id of [onlyB, new Types.ObjectId().toHexString(), 'zz']) {
        for (const [method, url] of [
          ['GET', `/admin/users/${id}/families`],
          ['GET', `/admin/users/${id}/consents`],
          ['POST', `/admin/users/${id}/families/${famB}/revoke`],
          ['DELETE', `/admin/users/${id}/consents/${conB}`],
        ] as const) {
          const res = await call(method, url, token);
          shapes.add(`${res.statusCode} ${String(res.headers['content-type'])} ${res.body}`);
        }
      }
      expect([...shapes]).toHaveLength(1);
      expect([...shapes][0]).toMatch(/^404 application\/json.* \{"error":"not_found"\}$/);
      expect(
        await refreshModel.countDocuments({ familyId: famB, familyRevokedAt: { $ne: null } }),
      ).toBe(0);
      expect((await consentModel.findById(conB).lean())?.revokedAt ?? null).toBeNull();
    });

    it('mapper: secret-bearing DB fields set on the user never reach GET one / list', async () => {
      const id = await mkUser({ [TENANT_A]: [] }, 'secret');
      const MARK = `qa-mark-${RUN}`;
      await userModel.collection.updateOne(
        { _id: new Types.ObjectId(id) },
        {
          $set: {
            mfaSecret: `${MARK}-mfa`,
            lockTransitionNonce: `${MARK}-nonce`,
            failedLoginCount: 2,
            tokenHash: `${MARK}-th`,
          },
        },
      );
      const token = await tok(tadminA);
      const one = await call('GET', `/admin/users/${id}`, token);
      const list = await call(
        'GET',
        `/admin/users?email=${encodeURIComponent(await emailOf(id))}`,
        token,
      );
      for (const res of [one, list]) {
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(MARK);
        expect(res.body).not.toContain('$argon2');
        expect(res.body).not.toMatch(/passwordHash|mfaSecret|lockTransitionNonce|failedLoginCount/);
      }
      expect(Object.keys(one.json()).sort()).toEqual(USER_KEYS);
    });

    it('request chain: sessions/revoke => the old session cookie no longer yields a code at /authorize', async () => {
      const target = await mkUser({ [TENANT_A]: [] });
      const flow = await realFlow(target);
      const before = await authorize(flow.sessionId, CLIENT_A, DEMO_AUD);
      expect(new URL(before.headers['location'] as string).searchParams.get('code')).toBeTruthy();
      expect(
        (await call('POST', `/admin/users/${target}/sessions/revoke`, await tok(tadminA)))
          .statusCode,
      ).toBe(204);
      const after = await authorize(flow.sessionId, CLIENT_A, DEMO_AUD);
      const loc = (after.headers['location'] as string | undefined) ?? '';
      expect(loc).not.toMatch(/[?&]code=/);
      expect(loc.startsWith(REDIRECT)).toBe(false);
      // Replay: a second revoke is idempotent (204, audited with count 0).
      expect(
        (await call('POST', `/admin/users/${target}/sessions/revoke`, await tok(tadminA)))
          .statusCode,
      ).toBe(204);
      const evs = await auditModel
        .find({ action: 'SESSION_REVOKED', targetId: target, result: 'success' })
        .sort({ timestamp: 1 })
        .lean();
      expect(evs.map((e) => (e.metadata as { count: number }).count)).toEqual([1, 0]);
    });

    it('escalation race: tenant_admin PATCH ∥ super_admin granting super_admin => super_admin never lost', async () => {
      const taTok = await tok(tadminA);
      const saTok = await tok(superA);
      for (let i = 0; i < 8; i++) {
        const target = await mkUser({ [TENANT_A]: [] }, 'race');
        const url = `/admin/users/${target}/roles`;
        const taReq = () => call('PATCH', url, taTok, { roles: ['tenant_admin'] });
        const saReq = () => call('PATCH', url, saTok, { roles: ['super_admin'] });
        // Alternate who is dispatched first so both interleavings are exercised.
        const [ta, sa] =
          i % 2 === 0
            ? await Promise.all([taReq(), saReq()])
            : await Promise.all([saReq(), taReq()]).then(([s, t]) => [t, s]);
        expect(sa.statusCode).toBe(200);
        expect([200, 403]).toContain(ta.statusCode);
        // Either order: the super_admin write wins or the tenant_admin write was refused.
        expect(await rolesOf(target)).toEqual(['super_admin']);
      }
    });

    it('dependency failure => 5xx (fail-closed), never an empty 200 page', async () => {
      const token = await tok(tadminA);
      const target = await mkUser({ [TENANT_A]: [] });
      const boom = () => Promise.reject(new Error('qa: injected fault'));
      const cases: [object, string, string][] = [
        [moduleRef.get(AuditService), 'listForTenant', '/admin/audit'],
        [moduleRef.get(UserTenantService), 'listMembersPage', '/admin/users'],
        [moduleRef.get(UserTenantService), 'findMember', `/admin/users/${target}`],
        [moduleRef.get(RefreshTokenService), 'listFamilies', `/admin/users/${target}/families`],
        [moduleRef.get(ClientService), 'tenantClientIds', `/admin/users/${target}/consents`],
      ];
      for (const [svc, method, url] of cases) {
        const spy = jest
          .spyOn(svc as Record<string, () => Promise<unknown>>, method)
          .mockImplementation(boom);
        const res = await call('GET', url, token);
        expect([url, res.statusCode >= 500]).toEqual([url, true]);
        expect(res.body).not.toContain('items');
        expect(res.body).not.toContain('injected fault');
        spy.mockRestore();
      }
    });
  });

  // ------------------------------------------------------------------ QA (tester, run 48): reuse tenant
  describe('QA run 48 — TOKEN_REUSE_DETECTED tenant attribution', () => {
    const REUSE = '/admin/audit?action=TOKEN_REUSE_DETECTED&limit=100';
    /** Refresh at /token with request-controlled tenant hints (body + headers) the BE must ignore. */
    const injected = (value: string, clientId = CLIENT_A) =>
      app.inject({
        method: 'POST',
        url: `/token?tenantId=${TENANT_B}&tenant=${TENANT_B}`,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(clientId),
          'x-tenant-id': TENANT_B,
          'x-tenant': TENANT_B,
          tenant: TENANT_B,
        },
        payload: form({
          grant_type: 'refresh_token',
          refresh_token: value,
          tenantId: TENANT_B,
          tenant_id: TENANT_B,
        }),
      });
    const familyOf = async (user: string): Promise<string> =>
      (await refreshModel.findOne({ userId: new Types.ObjectId(user) }).lean())!.familyId as string;
    const seen = async (token: string, familyId: string) =>
      (
        (await call('GET', REUSE, token)).json().items as { metadata?: { familyId?: string } }[]
      ).filter((e) => e.metadata?.familyId === familyId);
    const stored = (familyId: string) =>
      auditModel
        .find({ action: 'TOKEN_REUSE_DETECTED', 'metadata.familyId': familyId })
        .lean<{ tenantId?: string; clientId?: string }[]>();

    it('tenant hints in query/body/headers are ignored: event tenant = client tenant (A), B sees 0', async () => {
      const user = await mkUser({ [TENANT_A]: [] }, 'qa48inj');
      const flow = await realFlow(user);
      const familyId = await familyOf(user);
      expect((await injected(flow.refresh_token!)).statusCode).toBe(200);
      const replay = await injected(flow.refresh_token!);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe('invalid_grant');

      const docs = await stored(familyId);
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ tenantId: TENANT_A, clientId: CLIENT_A });
      expect(await seen(await tok(tadminA), familyId)).toHaveLength(1);
      expect(await seen(await tok(tadminB, { client: CLIENT_B }), familyId)).toHaveLength(0);
      // Family revoke unchanged: every member revoked.
      const fam = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
      expect(fam.length).toBeGreaterThanOrEqual(2);
      expect(fam.every((d) => d.revokedAt)).toBe(true);
    });

    it("a client of tenant B replaying A's rotated value: invalid_grant, no reuse event, A's family intact", async () => {
      const user = await mkUser({ [TENANT_A]: [] }, 'qa48xc');
      const flow = await realFlow(user);
      const familyId = await familyOf(user);
      const rotated = await refresh(flow.refresh_token!);
      expect(rotated.statusCode).toBe(200);
      const foreign = await refresh(flow.refresh_token!, CLIENT_B);
      expect(foreign.statusCode).toBe(400);
      expect(foreign.json().error).toBe('invalid_grant');
      expect(await stored(familyId)).toHaveLength(0);
      expect(await seen(await tok(tadminB, { client: CLIENT_B }), familyId)).toHaveLength(0);
      // A's successor is still usable (no cross-client family teardown).
      expect((await refresh(rotated.json().refresh_token as string)).statusCode).toBe(200);
    });

    it('concurrent replays (N=4): all invalid_grant, every reuse event tenant A, B sees none', async () => {
      const user = await mkUser({ [TENANT_A]: [] }, 'qa48cc');
      const flow = await realFlow(user);
      const familyId = await familyOf(user);
      expect((await refresh(flow.refresh_token!)).statusCode).toBe(200);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => refresh(flow.refresh_token!)),
      );
      for (const r of results) {
        expect(r.statusCode).toBe(400);
        expect(r.json().error).toBe('invalid_grant');
      }
      const docs = await stored(familyId);
      expect(docs.length).toBeGreaterThanOrEqual(1);
      expect(docs.every((d) => d.tenantId === TENANT_A)).toBe(true);
      expect((await seen(await tok(tadminA), familyId)).length).toBe(docs.length);
      expect(await seen(await tok(tadminB, { client: CLIENT_B }), familyId)).toHaveLength(0);
      const fam = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
      expect(fam.every((d) => d.revokedAt)).toBe(true);
    });

    it('fail-closed: reuse audit write fails => 5xx no-store, no token, family still revoked', async () => {
      const user = await mkUser({ [TENANT_A]: [] }, 'qa48fc');
      const flow = await realFlow(user);
      const familyId = await familyOf(user);
      const rotated = await refresh(flow.refresh_token!);
      expect(rotated.statusCode).toBe(200);
      const svc = moduleRef.get(AuditService);
      const original = svc.record.bind(svc);
      const spy = jest
        .spyOn(svc, 'record')
        .mockImplementation(((ev: { action: string }) =>
          ev.action === 'TOKEN_REUSE_DETECTED'
            ? Promise.reject(new Error('qa: audit down'))
            : original(ev as never)) as never);
      try {
        const res = await refresh(flow.refresh_token!);
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).not.toContain('access_token');
        expect(res.body).not.toContain('refresh_token');
        expect(res.body).not.toContain('audit down');
      } finally {
        spy.mockRestore();
      }
      const fam = await refreshModel.find({ familyId }).lean<Record<string, unknown>[]>();
      expect(fam.every((d) => d.revokedAt)).toBe(true);
      expect((await refresh(rotated.json().refresh_token as string)).statusCode).toBe(400);
      expect(await stored(familyId)).toHaveLength(0);
    });
  });
  describe('run 56 Task 2 — lock level + atomic unlock audit (DEBT-147/153)', () => {
    const lock = async (id: string, as: string) =>
      call('POST', `/admin/users/${id}/lock`, await tok(as));
    const unlock = async (id: string, as: string) =>
      call('POST', `/admin/users/${id}/unlock`, await tok(as));
    const levelOf = async (id: string) =>
      ((await userModel.findById(id).lean()) as { adminLockLevel?: string } | null)?.adminLockLevel;
    const unlockAudits = (id: string, result = 'success') =>
      auditModel.countDocuments({ action: 'ADMIN_USER_UNLOCKED', targetId: id, result });
    /** A request held by a spy until released (barrier). */
    function barrier(count = 1) {
      let held = 0;
      let reach!: () => void;
      const reached = new Promise<void>((r) => (reach = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hold = async () => {
        if (++held === count) reach();
        await gate;
      };
      return { reached, release, hold };
    }
    async function expectSuperLockKept(id: string, res: Awaited<ReturnType<typeof call>>) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
      expect((await lockedUntilOf(id))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      expect(await unlockAudits(id)).toBe(0);
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_USER_UNLOCKED', targetId: id, result: 'failure' })
          .lean(),
      ).toMatchObject({ actorId: tadminA, reason: 'locked_by_super_admin' });
    }

    it('(a) super_admin lock => tenant_admin unlock 403 (lock kept, failure audit); super_admin unlock 200', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      expect((await lock(id, superA)).statusCode).toBe(200);
      expect(await levelOf(id)).toBe('super_admin');
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_USER_LOCKED', targetId: id, result: 'success' })
          .lean(),
      ).toMatchObject({ metadata: { level: 'super_admin' } });
      await expectSuperLockKept(id, await unlock(id, tadminA));
      const un = await unlock(id, superA);
      expect(un.statusCode).toBe(200);
      expect(un.json()).toMatchObject({ locked: false, lockedUntil: null });
      expect(await levelOf(id)).toBeUndefined();
      expect(await unlockAudits(id)).toBe(1);
    });

    it('(b) tenant_admin lock => tenant_admin unlock 200 + one audit; reset password keeps lock + level', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      expect((await lock(id, tadminA)).statusCode).toBe(200);
      expect(await levelOf(id)).toBe('tenant_admin');
      await moduleRef.get(UserService).setPassword(id, await hashPassword(NEW_PASSWORD));
      expect((await lockedUntilOf(id))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      expect(await levelOf(id)).toBe('tenant_admin');
      const un = await unlock(id, tadminA);
      expect(un.statusCode).toBe(200);
      expect(un.json()).toMatchObject({ locked: false, lockedUntil: null });
      expect(await unlockAudits(id)).toBe(1);
    });

    it('(c) tenant_admin lock on a super-locked user => 200, level stays super_admin; tenant_admin unlock => 403', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      expect((await lock(id, superA)).statusCode).toBe(200);
      const res = await lock(id, tadminA);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ locked: true });
      expect(await levelOf(id)).toBe('super_admin');
      await expectSuperLockKept(id, await unlock(id, tadminA));
      // super_admin over a tenant_admin lock raises the level.
      const id2 = await mkUser({ [TENANT_A]: [] });
      expect((await lock(id2, tadminA)).statusCode).toBe(200);
      expect((await lock(id2, superA)).statusCode).toBe(200);
      expect(await levelOf(id2)).toBe('super_admin');
    });

    it('(d) legacy sentinel without level => tenant_admin unlock 403, super_admin 200', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      await userModel.updateOne({ _id: id }, { $set: { lockedUntil: ADMIN_LOCKED_UNTIL } });
      await expectSuperLockKept(id, await unlock(id, tadminA));
      expect((await unlock(id, superA)).statusCode).toBe(200);
      expect(await lockedUntilOf(id)).toBeNull();
    });

    it('(e) brute-force lock (no level) => tenant_admin unlock 200 + audit', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      await userModel.updateOne(
        { _id: id },
        { $set: { lockedUntil: new Date(Date.now() + 15 * MIN), failedLoginCount: 5 } },
      );
      expect((await unlock(id, tadminA)).statusCode).toBe(200);
      expect(await lockedUntilOf(id)).toBeNull();
      expect((await userModel.findById(id).lean())?.failedLoginCount).toBe(0);
      expect(await unlockAudits(id)).toBe(1);
    });

    it('(f) race: K=5 unlocks held right before the write, released together => exactly 1 UNLOCKED success', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      expect((await lock(id, tadminA)).statusCode).toBe(200);
      const svc = moduleRef.get(UserService);
      const real = svc.adminUnlock.bind(svc);
      const K = 5;
      const b = barrier(K);
      jest.spyOn(svc, 'adminUnlock').mockImplementation(async (...args) => {
        await b.hold();
        return real(...args);
      });
      const token = await tok(tadminA);
      const pending = Array.from({ length: K }, () =>
        call('POST', `/admin/users/${id}/unlock`, token),
      );
      await b.reached;
      b.release();
      const res = await Promise.all(pending);
      expect(res.map((r) => r.statusCode)).toEqual(Array(K).fill(200));
      expect(await lockedUntilOf(id)).toBeNull();
      expect(await unlockAudits(id)).toBe(1);
    });

    it('(g) race: unlock reads "not locked", lock completes meanwhile, unlock released => unlocked AND 1 UNLOCKED after LOCKED', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      const svc = moduleRef.get(UserService);
      const real = svc.adminUnlock.bind(svc);
      const b = barrier();
      jest.spyOn(svc, 'adminUnlock').mockImplementationOnce(async (...args) => {
        await b.hold();
        return real(...args);
      });
      const pending = unlock(id, superA);
      await b.reached;
      expect((await lock(id, superA)).statusCode).toBe(200);
      b.release();
      expect((await pending).statusCode).toBe(200);
      expect(await lockedUntilOf(id)).toBeNull();
      const trail = await auditModel
        .find({ targetId: id, action: { $in: ['ADMIN_USER_LOCKED', 'ADMIN_USER_UNLOCKED'] } })
        .sort({ timestamp: 1, _id: 1 })
        .lean();
      expect(trail.map((e) => `${String(e.action)}:${String(e.result)}`)).toEqual([
        'ADMIN_USER_LOCKED:success',
        'ADMIN_USER_UNLOCKED:success',
      ]);
    });

    it('(h) user not locked, failedLoginCount 0 => unlock 200 without any audit', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      const res = await unlock(id, tadminA);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ locked: false, lockedUntil: null });
      expect(await unlockAudits(id)).toBe(0);
      expect(await unlockAudits(id, 'failure')).toBe(0);
    });
    it('(i) DEBT-420: the LOCKED success audit write fails => the revoke still runs (fail-closed), 5xx, lock kept', async () => {
      const id = await mkUser({ [TENANT_A]: [] });
      const flow = await realFlow(id);
      expect((await userinfo(flow.access_token)).statusCode).toBe(200);
      jest
        .spyOn(moduleRef.get(AuditService), 'record')
        .mockRejectedValueOnce(new Error('audit down'));
      const res = await lock(id, tadminA);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('audit down');
      expect((await lockedUntilOf(id))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      expect((await userinfo(flow.access_token)).statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ run 69 (DEBT-142 / DEBT-149)
  describe('run 69 — at least one active super_admin remains (DEBT-142); PATCH roles keeps non-admin roles (DEBT-149)', () => {
    const ROUNDS = 10;
    const CONFLICT = {
      error: 'conflict',
      error_description: 'at least one active super_admin must remain',
    };

    /** A fresh tenant with its own admin-capable client: the token's tenant is the client's. */
    async function freshTenant(): Promise<{ tenant: string; clientId: string }> {
      const tenant = `${RUN}-sg-${++seq}`;
      const clientId = `${tenant}-c`;
      await moduleRef.get(ClientService).create({
        clientId,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: [REDIRECT],
        allowedResources: ['admin', 'demo', 'other'],
        scopes: ADMIN_SCOPE.split(' '),
        tenantId: tenant,
      });
      return { tenant, clientId };
    }

    /** Two super_admins A/B (+ a non-admin role) of a fresh tenant, each with a live session. */
    async function superPair() {
      const { tenant, clientId } = await freshTenant();
      const a = await mkUser({ [tenant]: ['member', 'super_admin'] }, 'sga');
      const b = await mkUser({ [tenant]: ['member', 'super_admin'] }, 'sgb');
      return {
        tenant,
        clientId,
        a,
        b,
        at: await tok(a, { client: clientId }),
        bt: await tok(b, { client: clientId }),
        sa: (await sessions.create(a, tenant)).id,
        sb: (await sessions.create(b, tenant)).id,
      };
    }

    /** Active super_admins of `tenant`: active membership with the role, user not admin-locked. */
    async function activeSupers(tenant: string): Promise<string[]> {
      const rows = await userTenantModel
        .find({ tenantId: tenant, status: 'active', roles: 'super_admin' })
        .lean();
      const out: string[] = [];
      for (const r of rows) {
        const until = await lockedUntilOf((r.userId as Types.ObjectId).toHexString());
        if (until?.getTime() !== ADMIN_LOCKED_UNTIL.getTime()) {
          out.push((r.userId as Types.ObjectId).toHexString());
        }
      }
      return out;
    }

    const lastSuperAudits = (targets: string[]) =>
      auditModel
        .find({ targetId: { $in: targets }, result: 'failure', reason: 'last_super_admin' })
        .lean();
    const demote = (target: string, token: string) =>
      call('PATCH', `/admin/users/${target}/roles`, token, { roles: [] });
    const lockUser = (target: string, token: string) =>
      call('POST', `/admin/users/${target}/lock`, token);

    type Res = Awaited<ReturnType<typeof call>>;
    /** One winner (2xx), one 409 `conflict`, one survivor, one `last_super_admin` audit. */
    async function expectOneWinner(
      p: Awaited<ReturnType<typeof superPair>>,
      [ra, rb]: [Res, Res],
      action: [string, string],
    ): Promise<{ winner: 'a' | 'b' }> {
      const codes = [ra.statusCode, rb.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const loser = ra.statusCode === 409 ? ra : rb;
      expect(loser.json()).toEqual(CONFLICT);
      const winner = ra.statusCode === 200 ? 'a' : 'b';
      // The survivor is the winning actor; the loser's target (the winner) is untouched.
      expect(await activeSupers(p.tenant)).toEqual([winner === 'a' ? p.a : p.b]);
      const winnerId = winner === 'a' ? p.a : p.b;
      expect(await rolesOf(winnerId, p.tenant)).toEqual(['member', 'super_admin']);
      expect(await lockedUntilOf(winnerId)).toBeNull();
      expect(await sessions.get(winner === 'a' ? p.sa : p.sb)).not.toBeNull();
      const audits = await lastSuperAudits([p.a, p.b]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorId: winner === 'a' ? p.b : p.a,
        targetId: winnerId,
        targetType: 'user',
        action: winner === 'a' ? action[1] : action[0],
      });
      expect(audits[0].metadata ?? {}).toEqual({});
      return { winner };
    }

    it(`(r1) A demotes B ∥ B demotes A, ${ROUNDS} rounds => exactly one wins, one super_admin left`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const p = await superPair();
        const res = await Promise.all([demote(p.b, p.at), demote(p.a, p.bt)]);
        const { winner } = await expectOneWinner(p, res, [
          'ADMIN_USER_ROLES_CHANGED',
          'ADMIN_USER_ROLES_CHANGED',
        ]);
        // DEBT-149: the demoted one keeps its non-admin role.
        expect(await rolesOf(winner === 'a' ? p.b : p.a, p.tenant)).toEqual(['member']);
      }
    });

    it(`(r2) A locks B ∥ B locks A, ${ROUNDS} rounds => exactly one wins, one super_admin left`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const p = await superPair();
        const res = await Promise.all([lockUser(p.b, p.at), lockUser(p.a, p.bt)]);
        const { winner } = await expectOneWinner(p, res, [
          'ADMIN_USER_LOCKED',
          'ADMIN_USER_LOCKED',
        ]);
        const loserId = winner === 'a' ? p.b : p.a;
        expect((await lockedUntilOf(loserId))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      }
    });

    it(`(r3) A locks B ∥ B demotes A, ${ROUNDS} rounds => exactly one wins, one super_admin left`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const p = await superPair();
        const res = await Promise.all([lockUser(p.b, p.at), demote(p.a, p.bt)]);
        await expectOneWinner(p, res, ['ADMIN_USER_LOCKED', 'ADMIN_USER_ROLES_CHANGED']);
      }
    });

    it('(s1) the target is the only unlocked super_admin of ANOTHER tenant (the other one is admin-locked) => lock 409, nothing changed', async () => {
      const t2 = await freshTenant();
      const y = await mkUser({ [TENANT_A]: [], [t2.tenant]: ['super_admin'] }, 'sy');
      const z = await mkUser({ [t2.tenant]: ['super_admin'] }, 'sz');
      await userModel.updateOne(
        { _id: new Types.ObjectId(z) },
        { $set: { lockedUntil: ADMIN_LOCKED_UNTIL, adminLockLevel: 'super_admin' } },
      );
      const sy = (await sessions.create(y, t2.tenant)).id;
      const res = await lockUser(y, await tok(superA));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(CONFLICT);
      expect(await lockedUntilOf(y)).toBeNull();
      expect(await sessions.get(sy)).not.toBeNull();
      expect(await activeSupers(t2.tenant)).toEqual([y]);
      expect(await lastSuperAudits([y])).toMatchObject([
        { action: 'ADMIN_USER_LOCKED', actorId: superA, tenantId: TENANT_A },
      ]);
      expect(
        await auditModel.countDocuments({
          targetId: y,
          action: 'ADMIN_USER_LOCKED',
          result: 'success',
        }),
      ).toBe(0);
    });

    it('(s2) control: another active super_admin W in that tenant => lock 200', async () => {
      const t2 = await freshTenant();
      const y = await mkUser({ [TENANT_A]: [], [t2.tenant]: ['super_admin'] }, 'sy');
      const w = await mkUser({ [t2.tenant]: ['super_admin'] }, 'sw');
      const res = await lockUser(y, await tok(superA));
      expect(res.statusCode).toBe(200);
      expect((await lockedUntilOf(y))?.getTime()).toBe(ADMIN_LOCKED_UNTIL.getTime());
      expect(await activeSupers(t2.tenant)).toEqual([w]);
    });

    it('(s3) control: A demotes B while A remains => 200 (no false 409)', async () => {
      const p = await superPair();
      const res = await demote(p.b, p.at);
      expect(res.statusCode).toBe(200);
      expect(await activeSupers(p.tenant)).toEqual([p.a]);
      expect(await lastSuperAudits([p.a, p.b])).toHaveLength(0);
    });

    it('DEBT-149: super_admin PATCH keeps non-admin roles; response = DB after; audit diff only on admin roles', async () => {
      const target = await mkUser({ [TENANT_A]: ['member', 'super_admin'] }, 'r149');
      const to = await call('PATCH', `/admin/users/${target}/roles`, await tok(superA), {
        roles: ['tenant_admin'],
      });
      expect(to.statusCode).toBe(200);
      expect(to.json().roles).toEqual(['member', 'tenant_admin']);
      expect(await rolesOf(target)).toEqual(['member', 'tenant_admin']);
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_USER_ROLES_CHANGED', targetId: target, result: 'success' })
          .lean(),
      ).toMatchObject({ metadata: { addedRoles: 'tenant_admin', removedRoles: 'super_admin' } });
      const none = await call('PATCH', `/admin/users/${target}/roles`, await tok(superA), {
        roles: [],
      });
      expect(none.statusCode).toBe(200);
      expect(none.json().roles).toEqual(['member']);
      expect(await rolesOf(target)).toEqual(['member']);
      const audits = await auditModel
        .find({ action: 'ADMIN_USER_ROLES_CHANGED', targetId: target })
        .sort({ _id: 1 })
        .lean();
      expect(audits.map((a) => a.metadata)).toEqual([
        { addedRoles: 'tenant_admin', removedRoles: 'super_admin' },
        { addedRoles: '', removedRoles: 'tenant_admin' },
      ]);
    });

    it('DEBT-149: tenant_admin PATCH on a target with a non-admin role keeps it', async () => {
      const target = await mkUser({ [TENANT_A]: ['member'] }, 'r149t');
      const res = await call('PATCH', `/admin/users/${target}/roles`, await tok(tadminA), {
        roles: ['tenant_admin'],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().roles).toEqual(['member', 'tenant_admin']);
      expect(await rolesOf(target)).toEqual(['member', 'tenant_admin']);
      expect(
        await auditModel.findOne({ action: 'ADMIN_USER_ROLES_CHANGED', targetId: target }).lean(),
      ).toMatchObject({ metadata: { addedRoles: 'tenant_admin', removedRoles: '' } });
    });

    it('fail-closed: a DB fault inside the guard => 5xx, nothing written, no audit', async () => {
      const p = await superPair();
      jest
        .spyOn(moduleRef.get(SuperAdminGuard), 'assertSurvivors')
        .mockRejectedValueOnce(new Error('mongo down'));
      const res = await demote(p.b, p.at);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('mongo down');
      expect(await rolesOf(p.b, p.tenant)).toEqual(['member', 'super_admin']);
      expect(await auditModel.countDocuments({ targetId: p.b })).toBe(0);
    });
  });
});
