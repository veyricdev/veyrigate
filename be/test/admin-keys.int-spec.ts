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
import { decodeProtectedHeader } from 'jose';
import { Types, type Model } from 'mongoose';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { AdminKeysController } from '../src/modules/admin/admin-keys.controller';
import { AdminTenantsController } from '../src/modules/admin/admin-tenants.controller';
import { AdminController } from '../src/modules/admin/admin.controller';
import { registerAdminOpenApi } from '../src/modules/admin/admin.openapi';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { DemoController } from '../src/modules/demo/demo.controller';
import { STEP_UP_CLOCK } from '../src/modules/identity/tenant-context/tenant-context';
import { DEFAULT_TENANT_ID, TenantService } from '../src/modules/identity/tenant.service';
import { UserService, normalizeEmail } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { KeyRotationService } from '../src/modules/keys/key-rotation.service';
import { KeysController } from '../src/modules/keys/keys.controller';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService, adminResourceIdentifier } from '../src/modules/oauth/token/token.service';
import { UserinfoController } from '../src/modules/oauth/userinfo/userinfo.controller';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SessionCookie, SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-admin-keys-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
const DEMO_AUD = 'http://localhost:4000/demo/';
const RUN = `akey${Date.now()}`;
const CLIENT_A = `${RUN}-a`;
const CLIENT_N = `${RUN}-n`; // client of the tenant WITHOUT a Tenant document
const TENANT_A = `${RUN}-tenant-A`;
const TENANT_B = `${RUN}-tenant-B`;
const TENANT_NODOC = `${RUN}-tenant-nodoc`;
const REDIRECT = 'https://admin.example.com/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = deriveS256Challenge(VERIFIER);
const PASSWORD = 'admin-keys-int-password-1'; // test-only value for throwaway int DB users.
const ADMIN_SCOPE = 'openid admin.read admin.write offline_access';
const USER_SCOPE = 'openid offline_access';
const FAKE_SID = 'd'.repeat(64);
const TTL = 900;
const MIN = 60_000;

/** Exact key sets (fold: exposure budget). */
const KEY_ITEM_KEYS = ['alg', 'createdAt', 'kid', 'retireAt', 'status'];
const ROTATE_KEYS = ['mode', 'newKid', 'oldKid'];
const KEY_MATERIAL = /"(n|e|d|p|q|dp|dq|qi)"|PRIVATE KEY|\.pem|keys\.json/;

describe('Admin API B6.3c (keys + tenants) on real Mongo + Redis', () => {
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let signer: TokenSigner;
  let sessions: SessionService;
  let consents: ConsentService;
  let clientModel: Model<Client>;
  let userModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  let tenantModel: Model<Record<string, unknown>>;
  const secrets: Record<string, string> = {};
  const created: string[] = [];
  let seq = 0;

  let superA = '';
  let tadminA = '';
  let tadminNoDoc = '';
  let endUser = '';

  const cfg = {
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv: 'test', issuer: ISSUER };
      if (ns === 'session') return { cookieSecure: false };
      if (ns === 'token')
        return {
          accessTokenTtl: TTL,
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

  /** Hand-signed admin token (aud=admin, never-ended sid), signed with the CURRENT active key. */
  const tok = (sub: string, over: { authAgoMs?: number; client?: string } = {}): Promise<string> =>
    signer.sign(
      {
        scope: 'openid admin.read admin.write',
        client_id: over.client ?? CLIENT_A,
        sid: FAKE_SID,
        auth_time: Math.floor((Date.now() - (over.authAgoMs ?? 0)) / 1000),
      },
      { audience: ADMIN_AUD, subject: sub, expiresInSec: TTL, typ: 'at+jwt' },
    );

  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const bearerGet = (url: string, at: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${at}` } });
  const jwksKids = async (): Promise<string[]> =>
    (
      (await app.inject({ method: 'GET', url: '/jwks.json' })).json() as { keys: { kid: string }[] }
    ).keys
      .map((k) => k.kid)
      .sort();

  async function mkUser(memberships: Record<string, string[]>, tag = 'u'): Promise<string> {
    const user = await userModel.create({
      email: normalizeEmail(`${RUN}-${tag}-${++seq}@example.com`),
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

  /** REAL `/authorize` (consent pre-granted) -> code -> `/token`: a user AT (aud=demo) + refresh. */
  async function realFlow(
    userId: string,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const sessionId = (await sessions.create(userId, DEFAULT_TENANT_ID)).id;
    const scopes = USER_SCOPE.split(' ');
    await consents.grant(userId, CLIENT_A, DEMO_AUD, scopes, consents.currentVersions(), scopes);
    const res = await app.inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_A,
        redirect_uri: REDIRECT,
        scope: USER_SCOPE,
        resource: DEMO_AUD,
        state: 'rp-state',
        nonce: 'rp-nonce',
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      }).toString()}`,
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(res.statusCode).toBe(302);
    const code = new URL(res.headers['location'] as string).searchParams.get('code')!;
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(CLIENT_A),
      },
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    });
    expect(tokenRes.statusCode).toBe(200);
    return tokenRes.json() as { access_token: string; refresh_token: string };
  }

  const refresh = (value: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(CLIENT_A),
      },
      payload: form({ grant_type: 'refresh_token', refresh_token: value }),
    });

  /** Status of a user AT at the 2 resources + an admin AT at `/admin/me`. */
  const statuses = async (userAt: string, adminAt: string) => [
    (await bearerGet('/userinfo', userAt)).statusCode,
    (await bearerGet('/demo/me', userAt)).statusCode,
    (await bearerGet('/admin/me', adminAt)).statusCode,
  ];

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-admin-keys-int-'));
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
        DemoController,
        KeysController,
        AdminController,
        AdminKeysController,
        AdminTenantsController,
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
        KeyRotationService,
        HtmlExceptionFilter,
        TenantService,
        UserService,
        UserTenantService,
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new OAuthExceptionFilter());
    registerAdminOpenApi(app, { NODE_ENV: 'test' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    signer = moduleRef.get(TokenSigner);
    sessions = moduleRef.get(SessionService);
    consents = moduleRef.get(ConsentService);
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    userModel = app.get(getModelToken('User'));
    auditModel = app.get(getModelToken('AuditLog'));
    tenantModel = app.get(getModelToken('Tenant'));
    await syncAllIndexes(clientModel.db);
    await tenantModel.create({ id: TENANT_A, name: 'Tenant A' });
    await tenantModel.create({ id: TENANT_B, name: 'Tenant B' });

    const resources = moduleRef.get(ResourceService);
    await resources.create({ resourceId: 'admin', identifier: ADMIN_AUD });
    await resources.create({ resourceId: 'demo', identifier: DEMO_AUD });
    for (const [clientId, tenantId] of [
      [CLIENT_A, TENANT_A],
      [CLIENT_N, TENANT_NODOC],
    ]) {
      await moduleRef.get(ClientService).create({
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
    secrets[CLIENT_A] = (
      await moduleRef.get(ClientCredentialService).createSecret(CLIENT_A)
    ).secret;

    superA = await mkUser({ [TENANT_A]: ['super_admin'] }, 'sa');
    tadminA = await mkUser({ [TENANT_A]: ['tenant_admin'] }, 'ta');
    tadminNoDoc = await mkUser({ [TENANT_NODOC]: ['tenant_admin'] }, 'tn');
    // Run 35 (DEBT-116): the end user signs in to CLIENT_A, so it is a (role-less) member of its tenant.
    endUser = await mkUser({ [TENANT_A]: [] }, 'eu');
  }, 60_000);

  afterAll(async () => {
    if (redis) {
      for (const u of created) if (sessions) await sessions.revokeAllForUser(u);
      for (const p of ['authz_ctx:*', 'authz_code:*', 'sess_end:*', 'sess_rp:*', 'rl:*']) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
      await redis.quit();
    }
    if (clientModel) await clientModel.db.dropDatabase();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('keys — authorization and validation (state never changes)', () => {
    it('tenant_admin GET/POST => 403 forbidden, JWKS unchanged', async () => {
      const before = await jwksKids();
      const t = await tok(tadminA);
      const list = await call('GET', '/admin/keys', t);
      expect(list.statusCode).toBe(403);
      expect(list.json()).toEqual({ error: 'forbidden' });
      for (const mode of ['normal', 'emergency']) {
        const res = await call('POST', '/admin/keys/rotate', t, { mode });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
      }
      expect(await jwksKids()).toEqual(before);
    });

    it('stale auth_time => 403 step_up_required, JWKS unchanged', async () => {
      const before = await jwksKids();
      const res = await call(
        'POST',
        '/admin/keys/rotate',
        await tok(superA, { authAgoMs: 6 * MIN }),
        {
          mode: 'emergency',
        },
      );
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'step_up_required' });
      expect(await jwksKids()).toEqual(before);
    });

    it.each([
      ['missing mode', {}],
      ['unknown mode', { mode: 'panic' }],
      ['extra field', { mode: 'normal', retainSec: 0 }],
    ])('%s => 400, JWKS unchanged', async (_name, body) => {
      const before = await jwksKids();
      const res = await call('POST', '/admin/keys/rotate', await tok(superA), body);
      expect(res.statusCode).toBe(400);
      expect(await jwksKids()).toEqual(before);
    });

    it('?emergency=1 query is ignored (body mode wins: normal keeps the old key)', async () => {
      const [oldKid] = await jwksKids();
      const res = await call('POST', '/admin/keys/rotate?emergency=1', await tok(superA), {
        mode: 'normal',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ mode: 'normal', oldKid });
      expect(await jwksKids()).toContain(oldKid);
    });
  });

  describe('keys — rotate normal / emergency', () => {
    it('normal: old ATs still 200 everywhere, new AT has newKid, JWKS has both, list shows retiring', async () => {
      const user = await realFlow(endUser);
      const adminAt = await tok(superA);
      expect(await statuses(user.access_token, adminAt)).toEqual([200, 200, 200]);

      const res = await call('POST', '/admin/keys/rotate', adminAt, { mode: 'normal' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(Object.keys(res.json()).sort()).toEqual(ROTATE_KEYS);
      expect(res.body).not.toMatch(KEY_MATERIAL);
      const { newKid, oldKid } = res.json() as { newKid: string; oldKid: string };
      expect(decodeProtectedHeader(user.access_token).kid).toBe(oldKid);

      expect(await statuses(user.access_token, adminAt)).toEqual([200, 200, 200]);
      const rotated = await refresh(user.refresh_token);
      expect(rotated.statusCode).toBe(200);
      expect(decodeProtectedHeader(rotated.json().access_token as string).kid).toBe(newKid);
      expect(await jwksKids()).toEqual(expect.arrayContaining([oldKid, newKid]));

      const list = await call('GET', '/admin/keys', adminAt);
      expect(list.statusCode).toBe(200);
      expect(list.headers['cache-control']).toContain('no-store');
      expect(list.body).not.toMatch(KEY_MATERIAL);
      const body = list.json() as {
        items: { kid: string; status: string; retireAt: string | null; alg: string }[];
        nextCursor: null;
      };
      expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
      expect(body.nextCursor).toBeNull();
      for (const item of body.items) expect(Object.keys(item).sort()).toEqual(KEY_ITEM_KEYS);
      expect(body.items.map((k) => k.kid).sort()).toEqual(await jwksKids());
      const old = body.items.find((k) => k.kid === oldKid)!;
      expect(old.status).toBe('retiring');
      expect(Math.abs(Date.parse(old.retireAt!) - (Date.now() + TTL * 1000))).toBeLessThan(10_000);
      expect(body.items.find((k) => k.kid === newKid)).toMatchObject({
        status: 'active',
        retireAt: null,
        alg: 'RS256',
      });

      const event = await auditModel
        .findOne({ action: AuditAction.SIGNING_KEY_ROTATED, targetId: newKid })
        .lean();
      expect(event).toMatchObject({
        actorType: 'admin',
        actorId: superA,
        tenantId: TENANT_A,
        targetType: 'signing_key',
        result: 'success',
        metadata: { mode: 'normal', oldKid },
      });
      expect(JSON.stringify(event)).not.toMatch(KEY_MATERIAL);
    });

    it('emergency: old ATs 401 at /userinfo, /demo/me, /admin/me; JWKS = {newKid}; old refresh still works', async () => {
      const user = await realFlow(endUser);
      const adminAt = await tok(superA);
      expect(await statuses(user.access_token, adminAt)).toEqual([200, 200, 200]);

      const res = await call('POST', '/admin/keys/rotate', adminAt, { mode: 'emergency' });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(ROTATE_KEYS);
      expect(res.body).not.toMatch(KEY_MATERIAL);
      const { newKid, oldKid } = res.json() as { newKid: string; oldKid: string };

      // Every token signed with a removed key dies at once — including the caller's own admin AT.
      expect(await statuses(user.access_token, adminAt)).toEqual([401, 401, 401]);
      expect(await jwksKids()).toEqual([newKid]);
      expect((await readdir(keyDir)).filter((f) => f.endsWith('.pem'))).toEqual([`${newKid}.pem`]);

      // Q-29.2: refresh tokens are opaque, not signed => not revoked; the new AT uses newKid.
      const rotated = await refresh(user.refresh_token);
      expect(rotated.statusCode).toBe(200);
      const newAt = rotated.json().access_token as string;
      expect(decodeProtectedHeader(newAt).kid).toBe(newKid);
      const freshAdmin = await tok(superA); // must re-mint: the old admin AT is dead
      expect(await statuses(newAt, freshAdmin)).toEqual([200, 200, 200]);

      const list = await call('GET', '/admin/keys', freshAdmin);
      expect((list.json() as { items: { kid: string }[] }).items.map((k) => k.kid)).toEqual([
        newKid,
      ]);
      const event = await auditModel
        .findOne({ action: AuditAction.SIGNING_KEY_ROTATED, targetId: newKid })
        .lean();
      expect(event).toMatchObject({
        actorType: 'admin',
        tenantId: TENANT_A,
        metadata: { mode: 'emergency', oldKid },
      });
    });
  });

  it('OpenAPI documents GET /admin/keys, POST /admin/keys/rotate {mode enum}, GET /admin/tenants', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi/admin.json' })).json() as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
    };
    expect(Object.keys(doc.paths['/admin/keys'])).toEqual(['get']);
    expect(Object.keys(doc.paths['/admin/keys/rotate'])).toEqual(['post']);
    expect(Object.keys(doc.paths['/admin/tenants'])).toEqual(['get']);
    expect(doc.components.schemas.RotateKeyDto.properties?.mode.enum).toEqual([
      'normal',
      'emergency',
    ]);
  });

  describe('tenants', () => {
    type Page = { items: { id: string; name: string }[]; nextCursor: string | null };

    it('tenant_admin sees only its own tenant (allowlist {id, name}), even with a cursor/limit', async () => {
      const t = await tok(tadminA);
      for (const url of ['/admin/tenants', `/admin/tenants?after=${TENANT_A}&limit=1`]) {
        const res = await call('GET', url, t);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.json()).toEqual({
          items: [{ id: TENANT_A, name: 'Tenant A' }],
          nextCursor: null,
        });
      }
    });

    it('tenant_admin of a tenant without a document => items []', async () => {
      const res = await call('GET', '/admin/tenants', await tok(tadminNoDoc, { client: CLIENT_N }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], nextCursor: null });
    });

    it('super_admin sees every tenant, ordered by id, paginated', async () => {
      const t = await tok(superA);
      const all = (await call('GET', '/admin/tenants', t)).json() as Page;
      // Lexical `id` order: `akey…-tenant-A` < `akey…-tenant-B` < `default-tenant`.
      expect(all.items).toEqual([
        { id: TENANT_A, name: 'Tenant A' },
        { id: TENANT_B, name: 'Tenant B' },
        { id: DEFAULT_TENANT_ID, name: 'Default' },
      ]);
      for (const item of all.items) expect(Object.keys(item).sort()).toEqual(['id', 'name']);

      const p1 = (await call('GET', '/admin/tenants?limit=1', t)).json() as Page;
      expect(p1).toEqual({ items: [{ id: TENANT_A, name: 'Tenant A' }], nextCursor: TENANT_A });
      const p2 = (
        await call('GET', `/admin/tenants?limit=2&after=${p1.nextCursor}`, t)
      ).json() as Page;
      expect(p2.items.map((x) => x.id)).toEqual([TENANT_B, DEFAULT_TENANT_ID]);
      expect(p2.nextCursor).toBeNull();
    });

    it.each([
      ['operator-looking cursor', 'after=%24gt'],
      ['space in cursor', 'after=a%20b'],
      ['cursor too long', `after=${'a'.repeat(129)}`],
      ['limit 0', 'limit=0'],
      ['limit 101', 'limit=101'],
      ['unknown query field', 'tenantId=x'],
    ])('%s => 400', async (_name, qs) => {
      const res = await call('GET', `/admin/tenants?${qs}`, await tok(superA));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('run 29 QA (tester) — keys/tenants risk matrix', () => {
    const stateKids = async () =>
      (
        JSON.parse(await readFile(join(keyDir, 'keys.json'), 'utf8')) as {
          kid: string;
          status: string;
        }[]
      ).map((e) => `${e.kid}:${e.status}`);
    const pems = async () => (await readdir(keyDir)).filter((f) => f.endsWith('.pem')).sort();
    type KeyList = { items: { kid: string; status: string; retireAt: string | null }[] };
    const listKeys = async (t: string) => (await call('GET', '/admin/keys', t)).json() as KeyList;
    const adminClaims = () => ({
      scope: 'openid admin.read admin.write',
      client_id: CLIENT_A,
      sid: FAKE_SID,
      auth_time: Math.floor(Date.now() / 1000),
    });

    it.each([
      ['GET', '/admin/keys'],
      ['POST', '/admin/keys/rotate'],
      ['GET', '/admin/tenants'],
    ] as const)(
      '%s %s: no token / garbage / expired / wrong-audience token => 401, JWKS unchanged',
      async (method, url) => {
        const before = await jwksKids();
        const payload = method === 'POST' ? { mode: 'emergency' } : undefined;
        const noTok = await app.inject({
          method,
          url,
          ...(payload
            ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) }
            : {}),
        });
        expect(noTok.statusCode).toBe(401);
        expect(noTok.json()).toEqual({ error: 'invalid_token' });
        const expired = await signer.sign(adminClaims(), {
          audience: ADMIN_AUD,
          subject: superA,
          expiresInSec: -120,
          typ: 'at+jwt',
        });
        const demoAud = await signer.sign(adminClaims(), {
          audience: DEMO_AUD,
          subject: superA,
          expiresInSec: TTL,
          typ: 'at+jwt',
        });
        for (const bad of ['not.a.jwt', expired, demoAud]) {
          const res = await call(method, url, bad, payload);
          expect(res.statusCode).toBe(401);
          expect(res.json()).toEqual({ error: 'invalid_token' });
          expect(res.headers['cache-control']).toContain('no-store');
        }
        expect(await jwksKids()).toEqual(before);
      },
    );

    it('member / non-member / admin via a foreign-tenant client => 403 on keys and tenants', async () => {
      const before = await jwksKids();
      const member = await mkUser({ [TENANT_A]: [] }, 'mem');
      const cases: [string, string][] = [
        ['member without role', await tok(member)],
        ['end user not in A', await tok(endUser)],
        ['tenant_admin nodoc via client A', await tok(tadminNoDoc)],
        ['tenant_admin A via nodoc client', await tok(tadminA, { client: CLIENT_N })],
        ['super_admin A via nodoc client', await tok(superA, { client: CLIENT_N })],
      ];
      for (const [name, t] of cases) {
        for (const [m, u, p] of [
          ['GET', '/admin/keys', undefined],
          ['POST', '/admin/keys/rotate', { mode: 'emergency' }],
          ['GET', '/admin/tenants?limit=100', undefined],
        ] as const) {
          const res = await call(m, u, t, p);
          expect({ name, u, status: res.statusCode, body: res.json() }).toEqual({
            name,
            u,
            status: 403,
            body: { error: 'forbidden' },
          });
        }
      }
      expect(await jwksKids()).toEqual(before);
      const own = (await call('GET', '/admin/tenants?limit=100', await tok(tadminA))).json() as {
        items: { id: string }[];
      };
      expect(own.items.map((i) => i.id)).toEqual([TENANT_A]);
    });

    it('rotate normal x3 then past retention: retiring tokens 401, rotate prunes durably, PEM only for active', async () => {
      const user = await realFlow(endUser); // user AT signed with K0
      const k0Admin = await tok(superA);
      const kids: string[] = [decodeProtectedHeader(k0Admin).kid as string];
      const ats: string[] = [k0Admin];
      for (let i = 0; i < 3; i++) {
        const res = await call('POST', '/admin/keys/rotate', await tok(superA), { mode: 'normal' });
        expect(res.statusCode).toBe(200);
        expect(res.json().oldKid).toBe(kids[kids.length - 1]);
        kids.push(res.json().newKid as string);
        ats.push(await tok(superA));
        expect(decodeProtectedHeader(ats[ats.length - 1]).kid).toBe(kids[kids.length - 1]);
      }
      expect(new Set(kids).size).toBe(4);
      for (const at of ats) expect((await bearerGet('/admin/me', at)).statusCode).toBe(200);
      expect((await bearerGet('/userinfo', user.access_token)).statusCode).toBe(200);
      const listed = await listKeys(ats[3]);
      expect(listed.items.filter((k) => k.status === 'active').map((k) => k.kid)).toEqual([
        kids[3],
      ]);
      expect(listed.items.map((k) => k.kid)).toEqual(expect.arrayContaining(kids));
      expect(await pems()).toEqual([`${kids[3]}.pem`]);

      // Shift Date.now past ACCESS_TOKEN_TTL. jose checks `exp` with `new Date()` (real clock), so
      // a 401 below proves the KEY left JWKS, not that the token expired.
      const real = Date.now.bind(Date);
      const spy = jest.spyOn(Date, 'now').mockImplementation(() => real() + (TTL + 120) * 1000);
      try {
        expect(await jwksKids()).toEqual([kids[3]]);
        for (const at of ats.slice(0, 3)) {
          expect((await bearerGet('/admin/me', at)).statusCode).toBe(401);
        }
        expect((await bearerGet('/userinfo', user.access_token)).statusCode).toBe(401);
        expect((await bearerGet('/demo/me', user.access_token)).statusCode).toBe(401);
        const fresh = await tok(superA);
        expect((await bearerGet('/admin/me', fresh)).statusCode).toBe(200);
        expect(await stateKids()).toHaveLength(4); // read paths never write
        const rot = await call('POST', '/admin/keys/rotate', fresh, { mode: 'normal' });
        expect(rot.statusCode).toBe(200);
        kids.push(rot.json().newKid as string);
      } finally {
        spy.mockRestore();
      }
      expect((await stateKids()).sort()).toEqual(
        [`${kids[3]}:retiring`, `${kids[4]}:active`].sort(),
      );
      expect(await jwksKids()).toEqual([kids[3], kids[4]].sort());
      for (const at of ats.slice(0, 3)) {
        expect((await bearerGet('/admin/me', at)).statusCode).toBe(401);
      }
      expect((await bearerGet('/admin/me', ats[3])).statusCode).toBe(200);
      expect(await pems()).toEqual([`${kids[4]}.pem`]);
    });

    it('concurrent HTTP rotates (normal x2) => both 200, chained, one active, nothing lost', async () => {
      const t = await tok(superA);
      const oldKid = decodeProtectedHeader(t).kid as string;
      const [a, b] = await Promise.all([
        call('POST', '/admin/keys/rotate', t, { mode: 'normal' }),
        call('POST', '/admin/keys/rotate', t, { mode: 'normal' }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const ra = a.json() as { newKid: string; oldKid: string };
      const rb = b.json() as { newKid: string; oldKid: string };
      expect(ra.newKid).not.toBe(rb.newKid);
      // Serialised: one ran on oldKid, the other on the first one's newKid.
      const [first, second] = ra.oldKid === oldKid ? [ra, rb] : [rb, ra];
      expect(first.oldKid).toBe(oldKid);
      expect(second.oldKid).toBe(first.newKid);
      const after = await listKeys(await tok(superA));
      const active = after.items.filter((k) => k.status === 'active').map((k) => k.kid);
      expect(active).toEqual([second.newKid]);
      expect(await jwksKids()).toEqual(expect.arrayContaining([oldKid, ra.newKid, rb.newKid]));
      expect(await pems()).toEqual([`${second.newKid}.pem`]);
      expect((await bearerGet('/admin/me', t)).statusCode).toBe(200);
    });

    it('concurrent HTTP normal ∥ emergency => no 5xx, pre-rotation kid gone, one active key that signs', async () => {
      const t = await tok(superA);
      const preKid = decodeProtectedHeader(t).kid as string;
      const res = await Promise.all([
        call('POST', '/admin/keys/rotate', t, { mode: 'normal' }),
        call('POST', '/admin/keys/rotate', t, { mode: 'emergency' }),
      ]);
      // A request authenticated after the emergency removed preKid may get 401; never 5xx.
      for (const r of res) expect([200, 401]).toContain(r.statusCode);
      expect(res.some((r) => r.statusCode === 200)).toBe(true);
      const kidsNow = await jwksKids();
      if (res[1].statusCode === 200) expect(kidsNow).not.toContain(preKid);
      const fresh = await tok(superA);
      expect((await bearerGet('/admin/me', fresh)).statusCode).toBe(200);
      const list = await listKeys(fresh);
      const active = list.items.filter((k) => k.status === 'active').map((k) => k.kid);
      expect(active).toEqual([decodeProtectedHeader(fresh).kid]);
      expect(list.items.map((k) => k.kid).sort()).toEqual(kidsNow);
      expect(await pems()).toEqual([`${active[0]}.pem`]);
      const events = await auditModel.find({ action: AuditAction.SIGNING_KEY_ROTATED }).lean();
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(JSON.stringify(e)).not.toMatch(KEY_MATERIAL);
    });
  });

  describe('run 49 QA (tester) — A6.5 mode contract and emergency over retiring keys', () => {
    type Listed = { items: { kid: string; status: string; retireAt: string | null }[] };

    it.each([
      ['upper case', { mode: 'EMERGENCY' }],
      ['leading space', { mode: ' emergency' }],
      ['array', { mode: ['emergency'] }],
      ['boolean flag', { emergency: true }],
      ['null', { mode: null }],
    ])('mode %s => 400, JWKS unchanged (the BE never guesses the mode)', async (_n, body) => {
      const before = await jwksKids();
      const res = await call('POST', '/admin/keys/rotate', await tok(superA), body);
      expect(res.statusCode).toBe(400);
      expect(await jwksKids()).toEqual(before);
    });

    it('normal x2 then emergency: retiring keys stay after normal, ALL previous keys (active + retiring) gone after emergency; audit mode/oldKid per call', async () => {
      const k0 = decodeProtectedHeader(await tok(superA)).kid as string;
      const normals: { newKid: string; oldKid: string }[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await call('POST', '/admin/keys/rotate', await tok(superA), { mode: 'normal' });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({ mode: 'normal' });
        normals.push(r.json() as { newKid: string; oldKid: string });
      }
      expect(normals[0].oldKid).toBe(k0);
      expect(normals[1].oldKid).toBe(normals[0].newKid);
      const k2 = normals[1].newKid;
      const afterNormal = (await call('GET', '/admin/keys', await tok(superA))).json() as Listed;
      const retiring = afterNormal.items.filter((k) => k.status === 'retiring').map((k) => k.kid);
      expect(retiring).toEqual(expect.arrayContaining([k0, normals[0].newKid]));
      for (const k of afterNormal.items.filter((x) => x.status === 'retiring')) {
        expect(typeof k.retireAt).toBe('string');
      }
      expect(afterNormal.items.filter((k) => k.status === 'active').map((k) => k.kid)).toEqual([
        k2,
      ]);

      const em = await call('POST', '/admin/keys/rotate', await tok(superA), { mode: 'emergency' });
      expect(em.statusCode).toBe(200);
      const { newKid, oldKid, mode } = em.json() as {
        newKid: string;
        oldKid: string;
        mode: string;
      };
      expect(mode).toBe('emergency');
      expect(oldKid).toBe(k2); // the ACTIVE key before the call, not a retiring one
      expect(await jwksKids()).toEqual([newKid]);
      expect((await readdir(keyDir)).filter((f) => f.endsWith('.pem'))).toEqual([`${newKid}.pem`]);
      const listed = (await call('GET', '/admin/keys', await tok(superA))).json() as Listed;
      expect(listed.items).toEqual([
        expect.objectContaining({ kid: newKid, status: 'active', retireAt: null }),
      ]);

      const events = await auditModel
        .find({
          action: AuditAction.SIGNING_KEY_ROTATED,
          targetId: { $in: [...normals.map((n) => n.newKid), newKid] },
        })
        .lean();
      const byTarget = new Map(events.map((e) => [e.targetId, e]));
      for (const n of normals) {
        expect(byTarget.get(n.newKid)).toMatchObject({
          result: 'success',
          targetType: 'signing_key',
          metadata: { mode: 'normal', oldKid: n.oldKid },
        });
      }
      expect(byTarget.get(newKid)).toMatchObject({
        result: 'success',
        targetType: 'signing_key',
        metadata: { mode: 'emergency', oldKid: k2 },
      });
      for (const e of events) expect(JSON.stringify(e)).not.toMatch(KEY_MATERIAL);
    });
  });
});
