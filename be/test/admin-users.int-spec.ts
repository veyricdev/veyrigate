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
        UserService,
        UserTenantService,
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
    await resources.create({ resourceId: 'admin', identifier: ADMIN_AUD });
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
        metadata: { count: 1 },
      });
      // Second lock: revokes again (idempotent) and audits that revoke (DEBT-152, like sessions/revoke).
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
      expect(
        (await call('POST', `/admin/users/${target}/lock`, await tok(tadminA))).statusCode,
      ).toBe(200);
      // DEBT-152: the successful retry is audited, so the trail does not end on the failure.
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_USER_LOCKED', targetId: target, result: 'success' })
          .lean(),
      ).toMatchObject({ metadata: { count: 0 } });
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
      await moduleRef.get(UserTenantService).deleteMembership(user, TENANT_B);
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
      // Already revoked => 404 (chosen contract), no second audit.
      const again = await call(
        'DELETE',
        `/admin/users/${f.user}/consents/${id}`,
        await tok(tadminA),
      );
      expect(again.statusCode).toBe(404);
      expect(
        await auditModel.countDocuments({ action: 'OAUTH_CONSENT_REVOKED', targetId: f.user }),
      ).toBe(1);
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
      // Expected order for tenant A: newest first, ties by eventId desc.
      const expected = [`${actor}-4`, `${actor}-3b`, `${actor}-3a`, `${actor}-2`, `${actor}-1`];
      return { actor, at, expected };
    }

    it('newest first, stable cursor pages (ties by eventId), a write between pages neither repeats nor drops', async () => {
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
      // families cursor is compared as a plain string: an operator-looking value is inert (200, no 5xx).
      const fam = await call(
        'GET',
        `/admin/users/${f}/families?after=${encodeURIComponent('{"$gt":""}')}`,
        token,
      );
      expect(fam.statusCode).toBe(200);
    });

    it('audit cursor: negative / oversized / non-object payloads => 400', async () => {
      const token = await tok(tadminA);
      const forged = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
      for (const after of [
        forged({ t: -1, e: 'y' }),
        forged({ t: 1, e: '' }),
        forged({ t: 1, e: 'e'.repeat(129) }),
        forged({ t: 1, e: 5 }),
        forged([1, 'y']),
        forged(null),
        forged(1),
        forged({ t: Number.MAX_SAFE_INTEGER + 2, e: 'y' }),
      ]) {
        const res = await call('GET', `/admin/audit?after=${after}`, token);
        expect([after, res.statusCode]).toEqual([after, 400]);
      }
      // A well-formed cursor from the past is fine (empty page, never 5xx).
      const ok = await call('GET', `/admin/audit?after=${forged({ t: 0, e: 'x' })}`, token);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ items: [], nextCursor: null });
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
});
