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
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { AdminClientsController } from '../src/modules/admin/admin-clients.controller';
import { AdminResourcesController } from '../src/modules/admin/admin-resources.controller';
import { AdminController } from '../src/modules/admin/admin.controller';
import { registerAdminOpenApi } from '../src/modules/admin/admin.openapi';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { AdminAuthErrorFilter } from '../src/modules/identity/tenant-context/admin-auth.errors';
import {
  AdminScope,
  AdminTokenGuard,
  STEP_UP_CLOCK,
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
import { seedCodeGrant } from './oauth-fixtures';
import { IntrospectController } from '../src/modules/oauth/introspect/introspect.controller';
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
  `mongodb://localhost:27117/vg-int-admin-api-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

const ISSUER = 'http://localhost:4000';
const ADMIN_AUD = adminResourceIdentifier(ISSUER);
const API_AUD = 'https://api.example.com/';
const RUN = `aapi${Date.now()}`;
const BFF_A = `${RUN}-bff-a`;
const BFF_B = `${RUN}-bff-b`;
const TENANT_A = `${RUN}-tenant-A`;
const TENANT_B = `${RUN}-tenant-B`;
const REDIRECT = 'https://rp.example.com/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const SID = 'c'.repeat(64);
const MIN = 60_000;

/** Test-only controller under `/admin-test` (must never appear in the admin OpenAPI doc). */
@Controller('admin-test')
@UseGuards(AdminTokenGuard)
@UseFilters(AdminAuthErrorFilter)
class ProbeController {
  @Post('x')
  @AdminScope('admin.write')
  x() {
    return { ok: true };
  }
}

describe('Admin API B6.3a (clients, secrets, resources) on real Mongo + Redis', () => {
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let signer: TokenSigner;
  let sessions: SessionService;
  let clientModel: Model<Client>;
  let credentialModel: Model<Record<string, unknown>>;
  let resourceModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;
  let secretA = '';
  let stepUpOffset = 0;

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
      if (ns === 'client') return { secretGraceTtl: 3600 };
      if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
      throw new Error(`Unexpected config namespace: ${ns}`);
    },
  } as unknown as ConfigService;

  const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
  const basic = (id: string, secret: string): string =>
    'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

  /** Admin token as `/token` would mint it (aud=admin, sid, auth_time), via the issuing BFF. */
  const tok = (
    sub: string,
    over: { client?: string; scope?: string; authAgoMs?: number } = {},
  ): Promise<string> =>
    signer.sign(
      {
        scope: over.scope ?? 'openid admin.read admin.write',
        client_id: over.client ?? BFF_A,
        sid: SID,
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

  const confidential = (over: Record<string, unknown> = {}) => ({
    clientType: 'confidential',
    tokenEndpointAuthMethod: 'client_secret_basic',
    redirectUris: [REDIRECT],
    allowedResources: ['api'],
    scopes: ['openid', 'api.read'],
    ...over,
  });
  const publicSpa = (over: Record<string, unknown> = {}) => ({
    clientType: 'public',
    tokenEndpointAuthMethod: 'none',
    redirectUris: [REDIRECT],
    allowedResources: ['api'],
    scopes: ['openid', 'api.read'],
    ...over,
  });

  /** Create a client through the API as tenant_admin A; returns the server-generated id. */
  async function mkClient(body: Record<string, unknown>, as = tadminA): Promise<string> {
    const res = await call('POST', '/admin/clients', await tok(as), body);
    expect(res.statusCode).toBe(201);
    return res.json().clientId as string;
  }

  /** `/token` exchange attempt with a bogus code: 401 = client auth failed, 400 = auth passed. */
  const tokenAttempt = (headers: Record<string, string>, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload: form({
        grant_type: 'authorization_code',
        code: 'bogus-code',
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        ...extra,
      }),
    });

  const authorizeUrl = (clientId: string) =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: 'openid api.read',
      resource: API_AUD,
      state: 'rp-state',
      code_challenge: deriveS256Challenge(VERIFIER),
      code_challenge_method: 'S256',
    }).toString()}`;

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-admin-api-int-'));
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
        IntrospectController,
        UiController,
        AdminController,
        AdminClientsController,
        AdminResourcesController,
        ProbeController,
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
    // Same pipe + global filter as `main.ts`/`AppModule` (unknown field => 400 invalid_request).
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new OAuthExceptionFilter());
    expect(registerAdminOpenApi(app, { NODE_ENV: 'test' })).toBe(true);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    signer = moduleRef.get(TokenSigner);
    sessions = moduleRef.get(SessionService);
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    credentialModel = app.get(getModelToken('ClientCredential'));
    resourceModel = app.get(getModelToken('Resource'));
    auditModel = app.get(getModelToken('AuditLog'));
    const userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    await syncAllIndexes(clientModel.db);

    const resources = moduleRef.get(ResourceService);
    await resources.create({ resourceId: 'admin', identifier: ADMIN_AUD });
    await resources.create({ resourceId: 'api', identifier: API_AUD, scopes: ['api.read'] });
    const clients = moduleRef.get(ClientService);
    for (const [clientId, tenantId] of [
      [BFF_A, TENANT_A],
      [BFF_B, TENANT_B],
    ]) {
      await clients.create({
        clientId,
        clientType: 'confidential',
        tokenEndpointAuthMethod: 'client_secret_basic',
        redirectUris: [REDIRECT],
        allowedResources: ['admin', 'api'],
        scopes: ['openid', 'admin.read', 'admin.write'],
        tenantId,
      });
    }
    secretA = (await moduleRef.get(ClientCredentialService).createSecret(BFF_A)).secret;

    const mkUser = async (email: string): Promise<string> =>
      (
        (await userModel.create({ email: normalizeEmail(email) }))._id as Types.ObjectId
      ).toHexString();
    const members = moduleRef.get(UserTenantService);
    tadminA = await mkUser(`${RUN}-ta@example.com`);
    await members.addMembership(tadminA, TENANT_A, ['tenant_admin']);
    superA = await mkUser(`${RUN}-sa@example.com`);
    await members.addMembership(superA, TENANT_A, ['super_admin']);
    tadminB = await mkUser(`${RUN}-tb@example.com`);
    await members.addMembership(tadminB, TENANT_B, ['tenant_admin']);
  }, 60_000);

  afterAll(async () => {
    if (redis) {
      for (const p of ['authz_ctx:*', 'authz_code:*', 'sess_rp:*', 'rl:*']) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
      for (const u of [tadminA, superA, tadminB]) {
        if (u && sessions) await sessions.revokeAllForUser(u);
      }
    }
    if (clientModel) await clientModel.db.dropDatabase();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    stepUpOffset = 0;
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------- Task 1: foundation
  describe('Task 1 — foundation', () => {
    it('GET /openapi/admin.json (test env) => OpenAPI 3.x with /admin/clients, only /admin paths, no secretHash', async () => {
      const res = await app.inject({ method: 'GET', url: '/openapi/admin.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const doc = res.json();
      expect(doc.openapi).toMatch(/^3\./);
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/admin/clients',
          '/admin/clients/{clientId}',
          '/admin/clients/{clientId}/secrets',
          '/admin/clients/{clientId}/secrets/{version}',
          '/admin/resources',
          '/admin/resources/{resourceId}',
        ]),
      );
      for (const p of Object.keys(doc.paths)) expect(p).toMatch(/^\/admin(\/|$)/);
      expect(res.body).not.toContain('secretHash');
      expect(res.body).not.toContain('admin-test');
      expect(doc.components.schemas).toHaveProperty('CreateClientDto');
      // DEBT-290/294: response schemas + typed nullable `frontchannelLogoutUri` in the served doc.
      expect(doc.paths['/admin/clients/{clientId}'].get.responses['200'].content).toEqual({
        'application/json': { schema: { $ref: '#/components/schemas/AdminClientViewDto' } },
      });
      expect(doc.components.schemas.UpdateClientDto.properties.frontchannelLogoutUri).toMatchObject(
        { type: 'string', nullable: true },
      );
    });

    it('pagination: limit + nextCursor walks every client of the tenant exactly once', async () => {
      const ids = [await mkClient(confidential()), await mkClient(confidential())];
      const token = await tok(tadminA);
      const seen: string[] = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const url: string = `/admin/clients?limit=1${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        const res = await call('GET', url, token);
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          items: { clientId: string; tenantId: string }[];
          nextCursor: string | null;
        };
        expect(body.items.length).toBeLessThanOrEqual(1);
        for (const c of body.items) {
          expect(c.tenantId).toBe(TENANT_A);
          seen.push(c.clientId);
        }
        after = body.nextCursor;
        pages++;
      } while (after && pages < 100);
      expect(after).toBeNull();
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining([BFF_A, ...ids]));
      expect(seen).not.toContain(BFF_B);
      expect([...seen].sort()).toEqual(seen); // ordered by clientId
    });

    it('limit=101 / limit=0 / limit=abc / repeated after => 400 invalid_request', async () => {
      const token = await tok(tadminA);
      for (const q of ['limit=101', 'limit=0', 'limit=abc', 'after=a&after=b']) {
        const res = await call('GET', `/admin/clients?${q}`, token);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
      expect((await call('GET', '/admin/clients?limit=100', token)).statusCode).toBe(200);
    });

    it('?tenantId= on list, or tenantId in a body => 400 (tenant only ever comes from the token)', async () => {
      const token = await tok(tadminA);
      const q = await call('GET', `/admin/clients?tenantId=${TENANT_B}`, token);
      expect(q.statusCode).toBe(400);
      const before = await clientModel.countDocuments({ tenantId: TENANT_B });
      const b = await call('POST', '/admin/clients', token, confidential({ tenantId: TENANT_B }));
      expect(b.statusCode).toBe(400);
      expect(b.json().error_description).toContain('tenantId');
      expect(await clientModel.countDocuments({ tenantId: TENANT_B })).toBe(before);
    });

    it('client projection: exact allowlisted key set, no _id/__v', async () => {
      const res = await call('GET', `/admin/clients/${BFF_A}`, await tok(tadminA));
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(
        [
          'allowedCorsOrigins',
          'allowedResources',
          'clientId',
          'clientType',
          'createdAt',
          'disabled',
          'disabledAt',
          'frontchannelLogoutUri',
          'grantTypes',
          'postLogoutRedirectUris',
          'redirectUris',
          'scopes',
          'tenantId',
          'tokenEndpointAuthMethod',
          'updatedAt',
        ].sort(),
      );
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  // ---------------------------------------------------------------- Task 2: clients
  describe('Task 2 — clients', () => {
    it('CRUD: POST (server-generated id, never a secret) -> GET -> PATCH -> list', async () => {
      const token = await tok(tadminA);
      const created = await call('POST', '/admin/clients', token, confidential());
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.tenantId).toBe(TENANT_A);
      expect(created.body).not.toMatch(/secret"/i);
      expect(await credentialModel.countDocuments({ clientId: body.clientId })).toBe(0);

      const got = await call('GET', `/admin/clients/${body.clientId}`, token);
      expect(got.json()).toEqual(body);

      const patched = await call('PATCH', `/admin/clients/${body.clientId}`, token, {
        scopes: ['openid'],
        postLogoutRedirectUris: ['https://rp.example.com/bye'],
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().scopes).toEqual(['openid']);
      expect(patched.json().postLogoutRedirectUris).toEqual(['https://rp.example.com/bye']);
      const stored = await clientModel.findOne({ clientId: body.clientId }).lean();
      expect(stored?.scopes).toEqual(['openid']);
    });

    it('POST with a client-chosen clientId => 400', async () => {
      const res = await call(
        'POST',
        '/admin/clients',
        await tok(tadminA),
        confidential({ clientId: 'mine' }),
      );
      expect(res.statusCode).toBe(400);
      expect(await clientModel.exists({ clientId: 'mine' })).toBeNull();
    });

    it('cross-tenant GET/PATCH => 404 byte-identical to a random missing id', async () => {
      const id = await mkClient(confidential());
      const tokenB = await tok(tadminB, { client: BFF_B });
      const missing = await call('GET', `/admin/clients/${RUN}-nope`, tokenB);
      const cross = await call('GET', `/admin/clients/${id}`, tokenB);
      expect(missing.statusCode).toBe(404);
      expect(cross.statusCode).toBe(404);
      expect(cross.body).toBe(missing.body);
      expect(cross.json()).toEqual({ error: 'not_found' });

      const crossPatch = await call('PATCH', `/admin/clients/${id}`, tokenB, { scopes: ['x'] });
      const missingPatch = await call('PATCH', `/admin/clients/${RUN}-nope`, tokenB, {
        scopes: ['x'],
      });
      expect(crossPatch.statusCode).toBe(404);
      expect(crossPatch.body).toBe(missingPatch.body);
      expect((await clientModel.findOne({ clientId: id }).lean())?.scopes).toEqual([
        'openid',
        'api.read',
      ]);
    });

    it('auth_time older than 5 min => 403 step_up_required on POST and PATCH, DB unchanged', async () => {
      const id = await mkClient(confidential());
      const stale = await tok(tadminA, { authAgoMs: 6 * MIN });
      const count = await clientModel.countDocuments();
      const post = await call('POST', '/admin/clients', stale, confidential());
      expect(post.statusCode).toBe(403);
      expect(post.json()).toEqual({ error: 'step_up_required', max_age: 0 });
      expect(await clientModel.countDocuments()).toBe(count);
      const patch = await call('PATCH', `/admin/clients/${id}`, stale, {
        redirectUris: ['https://evil.example.com/cb'],
      });
      expect(patch.statusCode).toBe(403);
      expect(patch.json().error).toBe('step_up_required');
      expect((await clientModel.findOne({ clientId: id }).lean())?.redirectUris).toEqual([
        REDIRECT,
      ]);
      // GET needs no step-up.
      expect((await call('GET', `/admin/clients/${id}`, stale)).statusCode).toBe(200);
    });

    it('token with admin.read only => POST 403 insufficient_scope', async () => {
      const res = await call(
        'POST',
        '/admin/clients',
        await tok(tadminA, { scope: 'openid admin.read' }),
        confidential(),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'insufficient_scope' });
    });

    it('invalid redirect URIs / CORS origins / unknown resource / bad auth-method pairing => 400', async () => {
      const token = await tok(tadminA);
      const bad: Record<string, unknown>[] = [
        { redirectUris: ['https://*.example.com/cb'] },
        { redirectUris: ['https://rp.example.com/cb#frag'] },
        { redirectUris: ['http://rp.example.com/cb'] },
        { redirectUris: ['/relative'] },
        { postLogoutRedirectUris: ['https://rp.example.com/#x'] },
        { frontchannelLogoutUri: 'http://rp.example.com/fc' },
        { allowedCorsOrigins: ['https://app.example.com/path'] },
        { allowedCorsOrigins: ['https://app.example.com/'] },
        { allowedCorsOrigins: ['*'] },
        { allowedCorsOrigins: ['http://app.example.com'] },
        { allowedResources: ['no-such-resource'] },
        { tokenEndpointAuthMethod: 'none' },
        { clientType: 'public' },
        { redirectUris: Array.from({ length: 21 }, (_, i) => `https://rp.example.com/${i}`) },
        { scopes: ['has space'] },
        { grantTypes: ['client_credentials'] },
      ];
      const count = await clientModel.countDocuments();
      for (const over of bad) {
        const res = await call('POST', '/admin/clients', token, confidential(over));
        expect({ over, status: res.statusCode }).toEqual({ over, status: 400 });
        expect(res.json().error).toBe('invalid_request');
      }
      expect(await clientModel.countDocuments()).toBe(count);
      // http://localhost is fine outside production; public + none is the valid public pairing.
      await mkClient(publicSpa({ allowedCorsOrigins: ['http://localhost:5173'] }));
    });

    it('PATCH immutable field / empty body => 400', async () => {
      const id = await mkClient(confidential());
      const token = await tok(tadminA);
      for (const body of [
        { clientType: 'public' },
        { tokenEndpointAuthMethod: 'none' },
        { clientId: 'x' },
        { tenantId: TENANT_B },
        {},
        { redirectUris: null },
      ]) {
        const res = await call('PATCH', `/admin/clients/${id}`, token, body);
        expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      }
      const stored = await clientModel.findOne({ clientId: id }).lean();
      expect(stored?.clientType).toBe('confidential');
      expect(stored?.tenantId).toBe(TENANT_A);
    });

    it('allowing the admin resource: tenant_admin => 403 (create + patch), super_admin => ok', async () => {
      const count = await clientModel.countDocuments();
      const res = await call(
        'POST',
        '/admin/clients',
        await tok(tadminA),
        confidential({ allowedResources: ['admin'] }),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
      expect(await clientModel.countDocuments()).toBe(count);

      const id = await mkClient(confidential());
      const patch = await call('PATCH', `/admin/clients/${id}`, await tok(tadminA), {
        allowedResources: ['api', 'admin'],
      });
      expect(patch.statusCode).toBe(403);
      expect((await clientModel.findOne({ clientId: id }).lean())?.allowedResources).toEqual([
        'api',
      ]);

      const bySuper = await call('PATCH', `/admin/clients/${id}`, await tok(superA), {
        allowedResources: ['api', 'admin'],
      });
      expect(bySuper.statusCode).toBe(200);
      expect(bySuper.json().allowedResources).toEqual(['api', 'admin']);
    });

    it('client that already allows the admin resource: every tenant_admin mutation => 403, nothing changes; super_admin => ok', async () => {
      // An admin-capable client (e.g. the admin BFF) configured by super_admin.
      const id = await mkClient(confidential({ allowedResources: ['api', 'admin'] }), superA);
      const issued = await call('POST', `/admin/clients/${id}/secrets`, await tok(superA));
      expect(issued.statusCode).toBe(201);
      const secret = (issued.json() as { clientSecret: string }).clientSecret;
      const snapshot = async () => {
        const c = await clientModel.findOne({ clientId: id }).lean();
        const creds = await credentialModel
          .find({ clientId: id }, { _id: 0, version: 1, expiresAt: 1, revokedAt: 1 })
          .sort({ version: 1 })
          .lean();
        return JSON.stringify({ c, creds });
      };
      const before = await snapshot();
      const ta = await tok(tadminA);

      for (const body of [
        { redirectUris: [REDIRECT, 'https://evil.example/cb'] },
        { allowedResources: [] },
        { allowedResources: ['api', 'admin'] },
        { disabled: true },
        { scopes: ['openid'] },
      ]) {
        const res = await call('PATCH', `/admin/clients/${id}`, ta, body);
        expect({ body, status: res.statusCode, json: res.json() }).toEqual({
          body,
          status: 403,
          json: { error: 'forbidden' },
        });
      }
      const post = await call('POST', `/admin/clients/${id}/secrets`, ta);
      expect(post.statusCode).toBe(403);
      expect(post.body).not.toContain('clientSecret');
      const del = await call('DELETE', `/admin/clients/${id}/secrets/1`, ta);
      expect(del.statusCode).toBe(403);

      expect(await snapshot()).toBe(before);
      expect((await tokenAttempt({ authorization: basic(id, secret) })).statusCode).toBe(400); // credential still valid
      // Still a 404 (not 403) for an id that is not in the tenant: no existence oracle.
      expect(
        (await call('PATCH', `/admin/clients/${randomUUID()}`, ta, { scopes: ['openid'] }))
          .statusCode,
      ).toBe(404);

      const sp = await tok(superA);
      const bySuper = await call('PATCH', `/admin/clients/${id}`, sp, { scopes: ['openid'] });
      expect(bySuper.statusCode).toBe(200);
      expect((await call('POST', `/admin/clients/${id}/secrets`, sp)).statusCode).toBe(201);
      expect((await call('DELETE', `/admin/clients/${id}/secrets/1`, sp)).statusCode).toBe(204);

      // A client without the admin resource stays fully manageable by tenant_admin.
      const plain = await mkClient(confidential());
      expect(
        (await call('PATCH', `/admin/clients/${plain}`, ta, { scopes: ['openid'] })).statusCode,
      ).toBe(200);
      expect((await call('POST', `/admin/clients/${plain}/secrets`, ta)).statusCode).toBe(201);
      expect((await call('DELETE', `/admin/clients/${plain}/secrets/1`, ta)).statusCode).toBe(204);
    });

    it('two concurrent first POST secrets => exactly one version without expiry (DEBT-133)', async () => {
      const id = await mkClient(confidential());
      const t = await tok(tadminA);
      const [a, b] = await Promise.all([
        call('POST', `/admin/clients/${id}/secrets`, t),
        call('POST', `/admin/clients/${id}/secrets`, t),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      const creds = await credentialModel.find({ clientId: id }, { _id: 0, expiresAt: 1 }).lean();
      expect(creds.map((c) => c.expiresAt == null).sort()).toEqual([false, true]);
    });

    it('after PATCH allowedCorsOrigins, /token CORS accepts the new origin and drops the old one', async () => {
      const id = await mkClient(publicSpa({ allowedCorsOrigins: ['https://one.example.com'] }));
      const attempt = (origin: string) => tokenAttempt({ origin }, { client_id: id });
      expect(
        (await attempt('https://one.example.com')).headers['access-control-allow-origin'],
      ).toBe('https://one.example.com');
      const res = await call('PATCH', `/admin/clients/${id}`, await tok(tadminA), {
        allowedCorsOrigins: ['https://two.example.com'],
      });
      expect(res.statusCode).toBe(200);
      expect(
        (await attempt('https://two.example.com')).headers['access-control-allow-origin'],
      ).toBe('https://two.example.com');
      expect(
        (await attempt('https://one.example.com')).headers['access-control-allow-origin'],
      ).toBeUndefined();
    });

    it('disable => /token invalid_client, issued AT inactive at /introspect, /authorize error page, CORS off; enable => works again', async () => {
      const id = await mkClient(publicSpa({ allowedCorsOrigins: ['https://spa.example.com'] }));
      const token = await tok(tadminA);
      const at = await signer.sign(
        { scope: 'openid api.read', client_id: id, sid: SID },
        { audience: API_AUD, subject: tadminA, expiresInSec: 900, typ: 'at+jwt' },
      );
      const introspect = () =>
        app.inject({
          method: 'POST',
          url: '/introspect',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: basic(BFF_A, secretA),
          },
          payload: form({ token: at }),
        });
      const { id: sessionId } = await sessions.create(tadminA, DEFAULT_TENANT_ID);
      const authorize = () =>
        app.inject({
          method: 'GET',
          url: authorizeUrl(id),
          cookies: { [SESSION_COOKIE]: sessionId },
        });

      expect((await tokenAttempt({}, { client_id: id })).statusCode).toBe(400); // auth ok
      expect((await introspect()).json().active).toBe(true);
      expect((await authorize()).statusCode).toBe(200); // consent screen

      const off = await call('PATCH', `/admin/clients/${id}`, token, { disabled: true });
      expect(off.statusCode).toBe(200);
      expect(off.json().disabled).toBe(true);
      expect(off.json().disabledAt).toBeTruthy();

      const denied = await tokenAttempt({ origin: 'https://spa.example.com' }, { client_id: id });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toBe('invalid_client');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      // Both CORS lookups (per-client + union used by preflight/jwks/discovery) skip it.
      const cors = moduleRef.get(ClientCorsService);
      expect(await cors.isOriginAllowedForClient(id, 'https://spa.example.com')).toBe(false);
      expect(await cors.isOriginRegisteredForAnyClient('https://spa.example.com')).toBe(false);
      expect(await introspect().then((r) => r.json())).toEqual({ active: false });
      const page = await authorize();
      expect(page.statusCode).toBe(400);
      expect(page.headers['location']).toBeUndefined();
      // Admin reads still see it (disabled clients are listed, not hidden).
      expect((await call('GET', `/admin/clients/${id}`, token)).json().disabled).toBe(true);

      const on = await call('PATCH', `/admin/clients/${id}`, token, { disabled: false });
      expect(on.json()).toMatchObject({ disabled: false, disabledAt: null });
      expect((await tokenAttempt({}, { client_id: id })).statusCode).toBe(400);
      expect((await introspect()).json().active).toBe(true);
      expect((await authorize()).statusCode).toBe(200);
      expect(await cors.isOriginRegisteredForAnyClient('https://spa.example.com')).toBe(true);
    });

    it('disabling the client that issued the admin token => 409, nothing changes', async () => {
      const res = await call('PATCH', `/admin/clients/${BFF_A}`, await tok(tadminA), {
        disabled: true,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('conflict');
      expect((await clientModel.findOne({ clientId: BFF_A }).lean())?.disabledAt).toBeNull();
    });

    it('pending consent + admin removes that redirect_uri => approve gives the first-party page, no 302, no code', async () => {
      const id = await mkClient(
        confidential({ redirectUris: [REDIRECT, 'https://rp.example.com/2'] }),
      );
      const { id: sessionId } = await sessions.create(tadminA, DEFAULT_TENANT_ID);
      const consentPage = await app.inject({
        method: 'GET',
        url: authorizeUrl(id),
        cookies: { [SESSION_COOKIE]: sessionId },
      });
      expect(consentPage.statusCode).toBe(200);
      const requestId = consentPage.body.match(/name="request_id" value="([^"]+)"/)?.[1];
      const csrf = consentPage.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      expect(requestId && csrf).toBeTruthy();

      const patch = await call('PATCH', `/admin/clients/${id}`, await tok(tadminA), {
        redirectUris: ['https://rp.example.com/2'],
      });
      expect(patch.statusCode).toBe(200);

      const mint = jest.spyOn(moduleRef.get(AuthorizationCodeService), 'create');
      const res = await app.inject({
        method: 'POST',
        url: '/authorize/consent',
        cookies: { [SESSION_COOKIE]: sessionId },
        payload: { _csrf: csrf!, request_id: requestId!, approve: 'true' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['location']).toBeUndefined();
      expect(res.body).not.toContain('code=');
      expect(mint).not.toHaveBeenCalled();
    });

    it('audit: create => ADMIN_CLIENT_CREATED; redirect change => ADMIN_CLIENT_UPDATED + REDIRECT_URI_CHANGED, no secret keys', async () => {
      const id = await mkClient(confidential());
      const created = await auditModel
        .findOne({ action: 'ADMIN_CLIENT_CREATED', targetId: id })
        .lean();
      expect(created).toMatchObject({
        actorType: 'admin',
        actorId: tadminA,
        tenantId: TENANT_A,
        clientId: id,
        result: 'success',
      });
      expect(created?.requestId).toBeTruthy();

      await call('PATCH', `/admin/clients/${id}`, await tok(tadminA), {
        redirectUris: ['https://rp.example.com/new', REDIRECT],
        scopes: ['openid'],
      });
      const updated = await auditModel
        .findOne({ action: 'ADMIN_CLIENT_UPDATED', targetId: id })
        .lean();
      expect(updated?.metadata).toEqual({
        changedFields: 'redirectUris,scopes',
        redirectUrisAdded: 1,
        redirectUrisRemoved: 0,
      });
      const redirect = await auditModel
        .findOne({ action: 'REDIRECT_URI_CHANGED', targetId: id })
        .lean();
      expect(redirect).toMatchObject({ actorId: tadminA, tenantId: TENANT_A });
      expect(redirect?.metadata).toMatchObject({ changedFields: 'redirectUris' });

      // Non-redirect change: no REDIRECT_URI_CHANGED.
      await call('PATCH', `/admin/clients/${id}`, await tok(tadminA), { scopes: ['openid', 'x'] });
      expect(
        await auditModel.countDocuments({ action: 'REDIRECT_URI_CHANGED', targetId: id }),
      ).toBe(1);
      const all = JSON.stringify(await auditModel.find({ targetId: id }).lean());
      expect(all).not.toMatch(/secret|password|token"/i);
    });
  });

  // ---------------------------------------------------------------- Task 3: secrets
  describe('Task 3 — client secrets', () => {
    let out = '';
    beforeEach(() => {
      out = '';
      for (const stream of [process.stdout, process.stderr]) {
        const orig = stream.write.bind(stream);
        jest.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
          out += String(chunk);
          return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
        }) as typeof stream.write);
      }
    });

    const issue = async (id: string, as = tadminA) =>
      call('POST', `/admin/clients/${id}/secrets`, await tok(as));
    const auth = (id: string, secret: string) => tokenAttempt({ authorization: basic(id, secret) });

    it('create -> rotate (grace) -> expire -> revoke, metadata-only listing, no plaintext in audit/log', async () => {
      const id = await mkClient(confidential());
      expect((await auth(id, 'anything')).statusCode).toBe(401); // no credential yet

      const first = await issue(id);
      expect(first.statusCode).toBe(201);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.headers['pragma']).toBe('no-cache');
      const s1 = first.json() as { clientId: string; version: number; clientSecret: string };
      expect(s1).toEqual({ clientId: id, version: 1, clientSecret: expect.any(String) });
      expect((await auth(id, s1.clientSecret)).statusCode).toBe(400); // auth passes

      const second = await issue(id);
      const s2 = second.json() as { version: number; clientSecret: string };
      expect(s2.version).toBe(2);
      expect((await auth(id, s2.clientSecret)).statusCode).toBe(400);
      expect((await auth(id, s1.clientSecret)).statusCode).toBe(400); // still in grace

      const list = await call('GET', `/admin/clients/${id}/secrets`, await tok(tadminA));
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain('$argon2');
      expect(list.body).not.toContain('secretHash');
      // DB-level projection too (defence in depth under the allowlist mapper).
      const meta = await moduleRef.get(ClientCredentialService).listMetadata(id);
      expect(meta.every((c) => !('secretHash' in c))).toBe(true);
      expect(
        list.json().items.map((c: { version: number; status: string }) => [c.version, c.status]),
      ).toEqual([
        [2, 'active'],
        [1, 'grace'],
      ]);
      expect(Object.keys(list.json().items[0]).sort()).toEqual(
        ['createdAt', 'expiresAt', 'revokedAt', 'status', 'version'].sort(),
      );

      // End of grace (no sleep): move v1's deadline into the past.
      await credentialModel.updateOne(
        { clientId: id, version: 1 },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
      expect((await auth(id, s1.clientSecret)).statusCode).toBe(401);
      expect((await auth(id, s2.clientSecret)).statusCode).toBe(400);

      const revoke = await call('DELETE', `/admin/clients/${id}/secrets/2`, await tok(tadminA));
      expect(revoke.statusCode).toBe(204);
      expect((await auth(id, s2.clientSecret)).statusCode).toBe(401); // immediately
      expect(
        (await call('DELETE', `/admin/clients/${id}/secrets/2`, await tok(tadminA))).statusCode,
      ).toBe(404);
      const after = await call('GET', `/admin/clients/${id}/secrets`, await tok(tadminA));
      expect(after.json().items.map((c: { status: string }) => c.status)).toEqual([
        'revoked',
        'expired',
      ]);

      // Next issue after everything is invalid => CREATED again (not ROTATED), v3.
      const third = await issue(id);
      expect(third.json().version).toBe(3);

      const actions = (
        await auditModel
          .find({ targetId: id, action: /^CLIENT_SECRET_/ })
          .sort({ timestamp: 1 })
          .lean()
      ).map((e) => [e.action, (e.metadata as { version: number }).version]);
      expect(actions).toEqual([
        ['CLIENT_SECRET_CREATED', 1],
        ['CLIENT_SECRET_ROTATED', 2],
        ['CLIENT_SECRET_REVOKED', 2],
        ['CLIENT_SECRET_CREATED', 3],
      ]);
      const audits = JSON.stringify(await auditModel.find({ targetId: id }).lean());
      for (const s of [s1.clientSecret, s2.clientSecret, third.json().clientSecret]) {
        expect(audits).not.toContain(s);
        expect(out).not.toContain(s);
      }
    });

    it('version not a positive integer => 400; cross-tenant => 404; public client => 400; stale auth => step_up', async () => {
      const id = await mkClient(confidential());
      const token = await tok(tadminA);
      for (const v of ['0', '-1', 'abc', '1.5', '01']) {
        expect((await call('DELETE', `/admin/clients/${id}/secrets/${v}`, token)).statusCode).toBe(
          400,
        );
      }
      expect((await call('DELETE', `/admin/clients/${id}/secrets/7`, token)).statusCode).toBe(404);

      const tokenB = await tok(tadminB, { client: BFF_B });
      for (const res of [
        await call('POST', `/admin/clients/${id}/secrets`, tokenB),
        await call('GET', `/admin/clients/${id}/secrets`, tokenB),
        await call('DELETE', `/admin/clients/${id}/secrets/1`, tokenB),
      ]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'not_found' });
      }
      expect(await credentialModel.countDocuments({ clientId: id })).toBe(0);

      const pub = await mkClient(publicSpa());
      expect((await issue(pub)).statusCode).toBe(400);

      const stale = await tok(tadminA, { authAgoMs: 6 * MIN });
      const res = await call('POST', `/admin/clients/${id}/secrets`, stale);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('step_up_required');
      expect(await credentialModel.countDocuments({ clientId: id })).toBe(0);
    });

    it('audit write fails => 5xx and the plaintext is NOT returned', async () => {
      const id = await mkClient(confidential());
      jest
        .spyOn(moduleRef.get(AuditService), 'record')
        .mockRejectedValueOnce(new Error('audit down'));
      const res = await issue(id);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('clientSecret');
    });
  });

  // ---------------------------------------------------------------- Task 4: resources
  describe('Task 4 — resources (global)', () => {
    it('any admin can list/get; tenant_admin POST/PATCH => 403 and DB unchanged', async () => {
      const token = await tok(tadminA);
      const list = await call('GET', '/admin/resources?limit=100', token);
      expect(list.statusCode).toBe(200);
      expect(list.json().items.map((r: { resourceId: string }) => r.resourceId)).toEqual(
        expect.arrayContaining(['admin', 'api']),
      );
      const get = await call('GET', '/admin/resources/api', token);
      expect(get.json()).toEqual({ resourceId: 'api', identifier: API_AUD, scopes: ['api.read'] });
      expect((await call('GET', `/admin/resources/${RUN}-x`, token)).json()).toEqual({
        error: 'not_found',
      });

      const count = await resourceModel.countDocuments();
      const post = await call('POST', '/admin/resources', token, {
        resourceId: `${RUN}-ta`,
        identifier: 'https://ta.example.com/',
      });
      expect(post.statusCode).toBe(403);
      expect(post.json()).toEqual({ error: 'forbidden' });
      const patch = await call('PATCH', '/admin/resources/api', token, { scopes: ['x'] });
      expect(patch.statusCode).toBe(403);
      expect(await resourceModel.countDocuments()).toBe(count);
      expect((await resourceModel.findOne({ resourceId: 'api' }).lean())?.scopes).toEqual([
        'api.read',
      ]);
    });

    it('super_admin: create, validation 400, duplicates 409, PATCH scopes only, audit', async () => {
      const token = await tok(superA);
      const rid = `${RUN}-r1`.toLowerCase();
      const created = await call('POST', '/admin/resources', token, {
        resourceId: rid,
        identifier: 'https://r1.example.com/',
        scopes: ['r1.read'],
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({
        resourceId: rid,
        identifier: 'https://r1.example.com/',
        scopes: ['r1.read'],
      });

      const count = await resourceModel.countDocuments();
      for (const body of [
        { resourceId: `${rid}-a`, identifier: 'https://r1.example.com/#frag' },
        { resourceId: `${rid}-b`, identifier: '/relative' },
        { resourceId: 'Bad Id', identifier: 'https://bad.example.com/' },
        { resourceId: `${rid}-c`, identifier: 'https://c.example.com/', scopes: ['a b'] },
        { resourceId: `${rid}-d`, identifier: 'https://d.example.com/', tenantId: TENANT_A },
      ]) {
        const res = await call('POST', '/admin/resources', token, body);
        expect({ body, status: res.statusCode }).toEqual({ body, status: 400 });
      }
      const dupIdentifier = await call('POST', '/admin/resources', token, {
        resourceId: `${rid}-e`,
        identifier: 'https://r1.example.com/',
      });
      expect(dupIdentifier.statusCode).toBe(409);
      const dupId = await call('POST', '/admin/resources', token, {
        resourceId: rid,
        identifier: 'https://r1-other.example.com/',
      });
      expect(dupId.statusCode).toBe(409);
      expect(dupId.json().error).toBe('conflict');
      expect(await resourceModel.countDocuments()).toBe(count);

      for (const body of [{ identifier: 'https://moved.example.com/' }, { resourceId: 'x' }]) {
        const res = await call('PATCH', `/admin/resources/${rid}`, token, {
          scopes: ['a'],
          ...body,
        });
        expect(res.statusCode).toBe(400);
      }
      expect((await call('PATCH', `/admin/resources/${rid}`, token, {})).statusCode).toBe(400);
      const patched = await call('PATCH', `/admin/resources/${rid}`, token, {
        scopes: ['r1.read', 'r1.write'],
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().identifier).toBe('https://r1.example.com/');
      expect(patched.json().scopes).toEqual(['r1.read', 'r1.write']);
      expect(
        (await call('PATCH', `/admin/resources/${RUN}-none`, token, { scopes: [] })).statusCode,
      ).toBe(404);

      expect(
        await auditModel.findOne({ action: 'ADMIN_RESOURCE_CREATED', targetId: rid }).lean(),
      ).toMatchObject({ actorId: superA, tenantId: TENANT_A, result: 'success' });
      expect(
        (await auditModel.findOne({ action: 'ADMIN_RESOURCE_UPDATED', targetId: rid }).lean())
          ?.metadata,
      ).toEqual({ changedFields: 'scopes', scopesAdded: 1, scopesRemoved: 0 });
    });

    it('stale auth_time => 403 step_up_required on resource writes', async () => {
      const stale = await tok(superA, { authAgoMs: 6 * MIN });
      const res = await call('POST', '/admin/resources', stale, {
        resourceId: `${RUN}-stale`.toLowerCase(),
        identifier: 'https://stale.example.com/',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('step_up_required');
    });
  });

  // ---------------------------------------------------------------- tester run 27: gap tests
  describe('tester run 27 — gaps (DEBT-136, disable liveness, grace, OpenAPI prod)', () => {
    it('DEBT-136: admin-capable client of ANOTHER tenant => every read/mutation 404 byte-identical to a random id, nothing changes', async () => {
      // BFF_B: tenant B, allowedResources includes `admin` (admin-capable).
      const snapshot = async () =>
        JSON.stringify({
          c: await clientModel.findOne({ clientId: BFF_B }).lean(),
          creds: await credentialModel.find({ clientId: BFF_B }, { _id: 0 }).lean(),
        });
      const before = await snapshot();
      const missing = randomUUID();
      const ops: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?]> = [
        ['GET', ''],
        ['PATCH', '', { redirectUris: [REDIRECT, 'https://evil.example/cb'] }],
        ['PATCH', '', { allowedResources: [] }],
        ['PATCH', '', { disabled: true }],
        ['GET', '/secrets'],
        ['POST', '/secrets'],
        ['DELETE', '/secrets/1'],
      ];
      // tenant_admin A and super_admin A alike: no cross-tenant in run 27 (Q-27.2).
      for (const actor of [tadminA, superA]) {
        const t = await tok(actor);
        for (const [method, suffix, body] of ops) {
          const cross = await call(method, `/admin/clients/${BFF_B}${suffix}`, t, body);
          const rand = await call(method, `/admin/clients/${missing}${suffix}`, t, body);
          expect({ method, suffix, status: cross.statusCode, body: cross.body }).toEqual({
            method,
            suffix,
            status: 404,
            body: rand.body,
          });
          expect(cross.json()).toEqual({ error: 'not_found' });
          expect(cross.body).not.toContain('clientSecret');
        }
      }
      expect(await snapshot()).toBe(before);
    });

    it('disable an admin-capable client => admin tokens it issued are dead at /admin (liveness, 401); enable => alive again', async () => {
      const sp = await tok(superA);
      const x = await mkClient(
        confidential({ allowedResources: ['api', 'admin'], scopes: ['openid', 'admin.read'] }),
        superA,
      );
      const viaX = await tok(superA, { client: x, scope: 'openid admin.read' });
      expect((await call('GET', '/admin/clients', viaX)).statusCode).toBe(200);

      expect((await call('PATCH', `/admin/clients/${x}`, sp, { disabled: true })).statusCode).toBe(
        200,
      );
      const dead = await call('GET', '/admin/clients', viaX);
      expect(dead.statusCode).toBe(401);
      expect(dead.json()).toEqual({ error: 'invalid_token' });

      expect((await call('PATCH', `/admin/clients/${x}`, sp, { disabled: false })).statusCode).toBe(
        200,
      );
      expect((await call('GET', '/admin/clients', viaX)).statusCode).toBe(200);
    });

    it('disable blocks client_secret_post at /token too; enable restores it', async () => {
      const id = await mkClient(confidential({ tokenEndpointAuthMethod: 'client_secret_post' }));
      const t = await tok(tadminA);
      const s = (await call('POST', `/admin/clients/${id}/secrets`, t)).json()
        .clientSecret as string;
      const attempt = () => tokenAttempt({}, { client_id: id, client_secret: s });
      expect((await attempt()).statusCode).toBe(400); // auth passed
      await call('PATCH', `/admin/clients/${id}`, t, { disabled: true });
      const denied = await attempt();
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toBe('invalid_client');
      await call('PATCH', `/admin/clients/${id}`, t, { disabled: false });
      expect((await attempt()).statusCode).toBe(400);
    });

    it('rotation: old secret gets expiresAt = now + CLIENT_SECRET_GRACE_TTL (3600s), new one none', async () => {
      const id = await mkClient(confidential());
      const t = await tok(tadminA);
      await call('POST', `/admin/clients/${id}/secrets`, t);
      const t0 = Date.now();
      expect((await call('POST', `/admin/clients/${id}/secrets`, t)).statusCode).toBe(201);
      const t1 = Date.now();
      const creds = await credentialModel
        .find({ clientId: id }, { _id: 0, version: 1, expiresAt: 1 })
        .sort({ version: 1 })
        .lean();
      expect(creds.map((c) => c.version)).toEqual([1, 2]);
      expect(creds[1].expiresAt ?? null).toBeNull();
      const exp = new Date(creds[0].expiresAt as Date).getTime();
      expect(exp).toBeGreaterThanOrEqual(t0 + 3600_000 - 2000);
      expect(exp).toBeLessThanOrEqual(t1 + 3600_000 + 2000);
    });

    it('OpenAPI: NODE_ENV=production (or unset) => GET /openapi/admin.json is 404 on a real Fastify app', async () => {
      for (const env of ['production', undefined]) {
        const m = await Test.createTestingModule({}).compile();
        const a = m.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
        try {
          expect(registerAdminOpenApi(a, { NODE_ENV: env })).toBe(false);
          await a.init();
          await a.getHttpAdapter().getInstance().ready();
          const res = await a.inject({ method: 'GET', url: '/openapi/admin.json' });
          expect(res.statusCode).toBe(404);
          expect(res.json()).not.toHaveProperty('paths');
        } finally {
          await a.close();
        }
      }
    });
  });

  describe('run 29 Task 3 — disable revokes refresh families (DEBT-125), keeps first disabledAt (DEBT-132)', () => {
    const refreshModel = () =>
      app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    const rtClient = (over: Record<string, unknown> = {}) =>
      confidential({ grantTypes: ['authorization_code', 'refresh_token'], ...over });

    /** A live refresh family inserted directly (plaintext value only known to the test). */
    async function insertRefresh(clientId: string): Promise<string> {
      const value = `rt-${randomUUID()}`;
      await refreshModel().create({
        tokenHash: sha256(value),
        familyId: `fam-${randomUUID()}`,
        userId: new Types.ObjectId(tadminA),
        clientId,
        scope: ['openid', 'api.read'],
        resource: API_AUD,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      return value;
    }
    const refreshGrant = (clientId: string, secret: string, value: string) =>
      app.inject({
        method: 'POST',
        url: '/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(clientId, secret),
        },
        payload: form({ grant_type: 'refresh_token', refresh_token: value }),
      });
    async function clientWithSecret(): Promise<{ id: string; secret: string }> {
      const id = await mkClient(rtClient());
      const issued = await call('POST', `/admin/clients/${id}/secrets`, await tok(tadminA));
      return { id, secret: (issued.json() as { clientSecret: string }).clientSecret };
    }
    const liveCount = async (clientId: string) =>
      refreshModel().countDocuments({ clientId, revokedAt: null, familyRevokedAt: null });
    const disabledAtOf = async (clientId: string) =>
      ((await clientModel.findOne({ clientId }).lean())?.disabledAt as Date | null | undefined) ??
      null;

    it('disable -> enable: old refresh => invalid_grant, whole family stamped; another client of the same user survives', async () => {
      const x = await clientWithSecret();
      const y = await clientWithSecret();
      const first = await refreshGrant(x.id, x.secret, await insertRefresh(x.id));
      expect(first.statusCode).toBe(200); // the family is genuinely live before the disable
      const rotated = first.json().refresh_token as string;
      const yValue = await insertRefresh(y.id);
      const t = await tok(tadminA);

      expect(
        (await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true })).statusCode,
      ).toBe(200);
      expect(
        (await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: false })).statusCode,
      ).toBe(200);

      const replay = await refreshGrant(x.id, x.secret, rotated);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe('invalid_grant');
      const docs = await refreshModel().find({ clientId: x.id }).lean();
      expect(docs.length).toBeGreaterThanOrEqual(2);
      for (const d of docs) expect(d.familyRevokedAt).toBeInstanceOf(Date);
      expect((await refreshGrant(y.id, y.secret, yValue)).statusCode).toBe(200);

      const revokedEvent = await auditModel
        .findOne({ action: 'TOKEN_REVOKED', clientId: x.id, 'metadata.reason': 'client_disabled' })
        .lean();
      expect(revokedEvent).toMatchObject({
        actorType: 'admin',
        actorId: tadminA,
        tenantId: TENANT_A,
        metadata: { reason: 'client_disabled', count: 1 },
      });
    });

    it('disable twice: disabledAt keeps the FIRST time; the 2nd disable still revokes a family that slipped in', async () => {
      const x = await clientWithSecret();
      const t = await tok(tadminA);
      expect(
        (await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true })).statusCode,
      ).toBe(200);
      const firstAt = (await disabledAtOf(x.id))!;
      expect(firstAt).toBeInstanceOf(Date);

      await insertRefresh(x.id); // e.g. a code exchange that passed client auth before the disable
      expect(await liveCount(x.id)).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
      const again = await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true });
      expect(again.statusCode).toBe(200);
      expect(new Date(again.json().disabledAt as string).getTime()).toBe(firstAt.getTime());
      expect((await disabledAtOf(x.id))!.getTime()).toBe(firstAt.getTime());
      expect(await liveCount(x.id)).toBe(0);

      // ADMIN_CLIENT_UPDATED for both PATCHes; `disabled` only when the state actually changed.
      const updates = await auditModel
        .find({ action: 'ADMIN_CLIENT_UPDATED', targetId: x.id, result: 'success' })
        .sort({ timestamp: 1 })
        .lean();
      expect(updates).toHaveLength(2);
      expect((updates[0].metadata as Record<string, unknown>).disabled).toBe(true);
      expect(updates[1].metadata as Record<string, unknown>).not.toHaveProperty('disabled');
    });

    it('enable clears disabledAt; a later disable stamps a NEW time', async () => {
      const x = await clientWithSecret();
      const t = await tok(tadminA);
      await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true });
      const firstAt = (await disabledAtOf(x.id))!;
      await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: false });
      expect(await disabledAtOf(x.id)).toBeNull();
      await new Promise((r) => setTimeout(r, 20));
      await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true });
      expect((await disabledAtOf(x.id))!.getTime()).toBeGreaterThan(firstAt.getTime());
    });

    it('tenant_admin B disabling a client of tenant A => 404, its refresh family stays live', async () => {
      const x = await clientWithSecret();
      await insertRefresh(x.id);
      const res = await call(
        'PATCH',
        `/admin/clients/${x.id}`,
        await tok(tadminB, { client: BFF_B }),
        { disabled: true },
      );
      expect(res.statusCode).toBe(404);
      expect(await liveCount(x.id)).toBe(1);
      expect(await disabledAtOf(x.id)).toBeNull();
    });

    it('revoke fails => 5xx, client stays disabled (fail-closed), failure audited; retry revokes', async () => {
      const x = await clientWithSecret();
      await insertRefresh(x.id);
      const t = await tok(tadminA);
      const spy = jest
        .spyOn(moduleRef.get(RefreshTokenService), 'revokeForClient')
        .mockRejectedValueOnce(new Error('mongo down'));
      const res = await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      spy.mockRestore();
      expect(await disabledAtOf(x.id)).toBeInstanceOf(Date);
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_CLIENT_UPDATED', targetId: x.id, result: 'failure' })
          .lean(),
      ).toMatchObject({ reason: 'revoke_failed' });
      expect(await liveCount(x.id)).toBe(1);

      expect(
        (await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true })).statusCode,
      ).toBe(200);
      expect(await liveCount(x.id)).toBe(0);
    });
  });

  describe('run 30 Task 4 — super_admin granting admin revokes every secret (DEBT-137)', () => {
    const auth = (id: string, secret: string) => tokenAttempt({ authorization: basic(id, secret) });
    const grant = async (id: string) =>
      call('PATCH', `/admin/clients/${id}`, await tok(superA), {
        allowedResources: ['api', 'admin'],
      });
    /** Confidential client set up by tenant_admin A with a secret S it knows. */
    async function tenantAdminClient(): Promise<{ id: string; s: string }> {
      const id = await mkClient(confidential());
      const res = await call('POST', `/admin/clients/${id}/secrets`, await tok(tadminA));
      expect(res.statusCode).toBe(201);
      const s = (res.json() as { clientSecret: string }).clientSecret;
      expect((await auth(id, s)).statusCode).toBe(400); // S authenticates before the grant
      return { id, s };
    }
    const liveCreds = (id: string) =>
      credentialModel.countDocuments({ clientId: id, revokedAt: null });

    it('grant => 200, every credential revoked, S => invalid_client (/token + /introspect); new secret only via super_admin', async () => {
      const { id, s } = await tenantAdminClient();
      const res = await grant(id);
      expect(res.statusCode).toBe(200);
      expect(res.json().allowedResources).toEqual(['api', 'admin']);
      expect(await credentialModel.countDocuments({ clientId: id })).toBe(1);
      expect(await liveCreds(id)).toBe(0);

      const viaToken = await auth(id, s);
      expect(viaToken.statusCode).toBe(401);
      expect(viaToken.json().error).toBe('invalid_client');
      const viaIntrospect = await app.inject({
        method: 'POST',
        url: '/introspect',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(id, s),
        },
        payload: form({ token: 'whatever' }),
      });
      expect(viaIntrospect.statusCode).toBe(401);
      expect(viaIntrospect.json().error).toBe('invalid_client');

      // tenant_admin can no longer mint a secret nor repoint the redirect.
      const ta = await tok(tadminA);
      expect((await call('POST', `/admin/clients/${id}/secrets`, ta)).statusCode).toBe(403);
      expect(
        (
          await call('PATCH', `/admin/clients/${id}`, ta, {
            redirectUris: ['https://evil.example/cb'],
          })
        ).statusCode,
      ).toBe(403);
      expect(await liveCreds(id)).toBe(0);

      const fresh = await call('POST', `/admin/clients/${id}/secrets`, await tok(superA));
      expect(fresh.statusCode).toBe(201);
      const s2 = (fresh.json() as { clientSecret: string }).clientSecret;
      expect((await auth(id, s2)).statusCode).toBe(400);

      // Audit: flag on the update + a CLIENT_SECRET_REVOKED with the count, no secret material.
      const updated = await auditModel
        .findOne({ action: 'ADMIN_CLIENT_UPDATED', targetId: id, actorId: superA })
        .lean();
      expect(updated).toMatchObject({ result: 'success', tenantId: TENANT_A });
      expect(updated?.metadata).toMatchObject({ adminGranted: true });
      const revokedAudit = await auditModel
        .find({ action: 'CLIENT_SECRET_REVOKED', targetId: id })
        .lean();
      expect(revokedAudit).toHaveLength(1);
      expect(revokedAudit[0]).toMatchObject({
        actorId: superA,
        result: 'success',
        metadata: { reason: 'admin_granted', count: 1 },
      });
      expect(JSON.stringify(await auditModel.find({ targetId: id }).lean())).not.toContain(s);

      // PATCH again (already admin-capable) => no further revoke, s2 keeps working.
      const again = await grant(id);
      expect(again.statusCode).toBe(200);
      expect((await auth(id, s2)).statusCode).toBe(400);
      expect(
        await auditModel.countDocuments({ action: 'CLIENT_SECRET_REVOKED', targetId: id }),
      ).toBe(1);
      const last = await auditModel
        .find({ action: 'ADMIN_CLIENT_UPDATED', targetId: id, actorId: superA })
        .sort({ _id: -1 })
        .limit(1)
        .lean();
      expect(last[0].metadata).not.toHaveProperty('adminGranted');
    });

    it('a secret issued between the two revoke passes is revoked too (2nd pass)', async () => {
      const { id } = await tenantAdminClient();
      const svc = moduleRef.get(ClientCredentialService);
      const real = svc.revokeAll.bind(svc);
      let sneaked = '';
      jest.spyOn(svc, 'revokeAll').mockImplementationOnce(async (clientId, now) => {
        const n = await real(clientId, now);
        // tenant_admin's POST secrets passed `assertMayModify` before the grant and inserts now.
        sneaked = (await svc.createSecret(clientId)).secret;
        return n;
      });
      expect((await grant(id)).statusCode).toBe(200);
      expect(sneaked).not.toBe('');
      expect(await liveCreds(id)).toBe(0);
      expect((await auth(id, sneaked)).statusCode).toBe(401);
      const revokedAudit = await auditModel
        .findOne({ action: 'CLIENT_SECRET_REVOKED', targetId: id })
        .lean();
      expect(revokedAudit?.metadata).toEqual({ reason: 'admin_granted', count: 2 });
    });

    it('1st revoke fails => 5xx, admin NOT granted, S still works (fail-closed)', async () => {
      const { id, s } = await tenantAdminClient();
      jest
        .spyOn(moduleRef.get(ClientCredentialService), 'revokeAll')
        .mockRejectedValueOnce(new Error('mongo down'));
      expect((await grant(id)).statusCode).toBeGreaterThanOrEqual(500);
      expect((await clientModel.findOne({ clientId: id }).lean())?.allowedResources).toEqual([
        'api',
      ]);
      expect(await liveCreds(id)).toBe(1);
      expect((await auth(id, s)).statusCode).toBe(400);
    });

    it('2nd revoke fails => 5xx + failure audit secret_revoke_failed; super_admin recovers with DELETE secrets/:v', async () => {
      const { id } = await tenantAdminClient();
      const svc = moduleRef.get(ClientCredentialService);
      const real = svc.revokeAll.bind(svc);
      let sneaked = '';
      jest
        .spyOn(svc, 'revokeAll')
        .mockImplementationOnce(async (clientId, now) => {
          const n = await real(clientId, now);
          sneaked = (await svc.createSecret(clientId)).secret;
          return n;
        })
        .mockRejectedValueOnce(new Error('mongo down'));
      expect((await grant(id)).statusCode).toBeGreaterThanOrEqual(500);
      expect((await clientModel.findOne({ clientId: id }).lean())?.allowedResources).toEqual([
        'api',
        'admin',
      ]);
      expect(
        await auditModel
          .findOne({ action: 'ADMIN_CLIENT_UPDATED', targetId: id, result: 'failure' })
          .lean(),
      ).toMatchObject({ reason: 'secret_revoke_failed', actorId: superA, metadata: { count: 1 } });
      // DEBT-170: the 1st pass revoked S; that revocation is audited even though the 2nd failed.
      expect(
        (await auditModel.find({ action: 'CLIENT_SECRET_REVOKED', targetId: id }).lean()).map(
          (r) => r.metadata,
        ),
      ).toEqual([{ reason: 'admin_granted', count: 1 }]);
      expect(
        await auditModel.countDocuments({
          action: 'ADMIN_CLIENT_UPDATED',
          targetId: id,
          actorId: superA,
          result: 'success',
        }),
      ).toBe(0);
      expect((await auth(id, sneaked)).statusCode).toBe(400); // the documented residual
      expect(
        (await call('DELETE', `/admin/clients/${id}/secrets/2`, await tok(superA))).statusCode,
      ).toBe(204);
      expect((await auth(id, sneaked)).statusCode).toBe(401);
    });

    const abortAudits = async (id: string) => ({
      revoked: await auditModel.find({ action: 'CLIENT_SECRET_REVOKED', targetId: id }).lean(),
      failed: await auditModel
        .find({ action: 'ADMIN_CLIENT_UPDATED', targetId: id, result: 'failure' })
        .lean(),
      success: await auditModel.countDocuments({
        action: 'ADMIN_CLIENT_UPDATED',
        targetId: id,
        result: 'success',
      }),
    });

    it('DEBT-170: client gone between the 1st revoke pass and the update => 404 + CLIENT_SECRET_REVOKED{admin_grant_aborted,count} + failure audit', async () => {
      const { id, s } = await tenantAdminClient();
      const svc = moduleRef.get(ClientCredentialService);
      const real = svc.revokeAll.bind(svc);
      jest.spyOn(svc, 'revokeAll').mockImplementationOnce(async (clientId, now) => {
        const n = await real(clientId, now);
        await clientModel.deleteOne({ clientId }); // concurrent delete
        return n;
      });
      const res = await grant(id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
      expect(await liveCreds(id)).toBe(0); // the revocation stands (fail-closed)
      const a = await abortAudits(id);
      expect(a.revoked).toHaveLength(1);
      expect(a.revoked[0]).toMatchObject({
        actorId: superA,
        result: 'success',
        metadata: { reason: 'admin_grant_aborted', count: 1 },
      });
      expect(a.failed).toHaveLength(1);
      expect(a.failed[0]).toMatchObject({ reason: 'admin_grant_aborted', metadata: { count: 1 } });
      expect(a.success).toBe(0);
      expect(JSON.stringify(await auditModel.find({ targetId: id }).lean())).not.toContain(s);
    });

    it('DEBT-170: the update throws after the 1st revoke pass => 5xx, admin NOT granted, same audits', async () => {
      const { id, s } = await tenantAdminClient();
      jest.spyOn(clientModel, 'findOneAndUpdate').mockImplementationOnce(
        () =>
          ({
            lean: () => ({ exec: () => Promise.reject(new Error('mongo down')) }),
          }) as never,
      );
      const res = await grant(id);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('mongo down');
      expect((await clientModel.findOne({ clientId: id }).lean())?.allowedResources).toEqual([
        'api',
      ]);
      expect(await liveCreds(id)).toBe(0);
      const a = await abortAudits(id);
      expect(a.revoked.map((r) => r.metadata)).toEqual([
        { reason: 'admin_grant_aborted', count: 1 },
      ]);
      expect(a.failed.map((r) => [r.reason, r.metadata])).toEqual([
        ['admin_grant_aborted', { count: 1 }],
      ]);
      expect(a.success).toBe(0);
      expect(JSON.stringify(await auditModel.find({ targetId: id }).lean())).not.toContain(s);
    });

    it('DEBT-170: no secret to revoke + client gone => plain 404, no abort audit', async () => {
      const id = await mkClient(confidential());
      const svc = moduleRef.get(ClientCredentialService);
      jest.spyOn(svc, 'revokeAll').mockImplementationOnce(async (clientId) => {
        await clientModel.deleteOne({ clientId });
        return 0;
      });
      expect((await grant(id)).statusCode).toBe(404);
      const a = await abortAudits(id);
      expect(a.revoked).toHaveLength(0);
      expect(a.failed).toHaveLength(0);
    });

    it('DEBT-167: disabled:true with any other field => 400, DB unchanged; disabled:false + field => 200', async () => {
      const sp = await tok(superA);
      const id = await mkClient(confidential());
      const before = JSON.stringify(await clientModel.findOne({ clientId: id }).lean());
      for (const extra of [
        { redirectUris: ['https://rp.example.com/other'] },
        { scopes: ['openid'] },
        { allowedResources: ['api', 'admin'] },
        { frontchannelLogoutUri: null },
      ]) {
        const res = await call('PATCH', `/admin/clients/${id}`, sp, { disabled: true, ...extra });
        expect({ extra, status: res.statusCode, json: res.json() }).toEqual({
          extra,
          status: 400,
          json: { error: 'invalid_request', error_description: 'disable must be sent alone' },
        });
      }
      expect(JSON.stringify(await clientModel.findOne({ clientId: id }).lean())).toBe(before);
      expect(
        await auditModel.countDocuments({ targetId: id, action: 'ADMIN_CLIENT_UPDATED' }),
      ).toBe(0);

      expect((await call('PATCH', `/admin/clients/${id}`, sp, { disabled: true })).statusCode).toBe(
        200,
      );
      const enabled = await call('PATCH', `/admin/clients/${id}`, sp, {
        disabled: false,
        scopes: ['openid'],
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ disabled: false, scopes: ['openid'] });
    });

    it('rule A: a public client can never get admin (super_admin POST/PATCH => 400, DB unchanged)', async () => {
      const sp = await tok(superA);
      const count = await clientModel.countDocuments();
      const created = await call(
        'POST',
        '/admin/clients',
        sp,
        publicSpa({ allowedResources: ['api', 'admin'] }),
      );
      expect(created.statusCode).toBe(400);
      expect(created.json().error).toBe('invalid_request');
      expect(await clientModel.countDocuments()).toBe(count);

      const id = await mkClient(publicSpa());
      const before = JSON.stringify(await clientModel.findOne({ clientId: id }).lean());
      const patched = await call('PATCH', `/admin/clients/${id}`, sp, {
        allowedResources: ['api', 'admin'],
      });
      expect(patched.statusCode).toBe(400);
      expect(patched.json().error).toBe('invalid_request');
      expect(JSON.stringify(await clientModel.findOne({ clientId: id }).lean())).toBe(before);

      // Confidential create with admin by super_admin stays allowed (fe-admin / BFF case).
      expect(
        (await call('POST', '/admin/clients', sp, confidential({ allowedResources: ['admin'] })))
          .statusCode,
      ).toBe(201);
    });

    it('grant on a client of another tenant => 404, its secret untouched', async () => {
      const id = await mkClient(confidential(), tadminA);
      await moduleRef.get(ClientCredentialService).createSecret(id);
      // Move it to tenant B: super_admin of A (token tenant = A) must not reach its secrets.
      await clientModel.updateOne({ clientId: id }, { $set: { tenantId: TENANT_B } });
      const res = await grant(id);
      expect(res.statusCode).toBe(404);
      expect(await liveCreds(id)).toBe(1);
    });
  });

  describe('run 29 QA (tester) — /token grant paths after disable (DEBT-125)', () => {
    const tokenPost = (clientId: string, secret: string, fields: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/token',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(clientId, secret),
        },
        payload: form(fields),
      });
    async function liveClient(): Promise<{ id: string; secret: string }> {
      const id = await mkClient(
        confidential({
          grantTypes: ['authorization_code', 'refresh_token'],
          scopes: ['openid', 'offline_access', 'api.read'],
        }),
      );
      const issued = await call('POST', `/admin/clients/${id}/secrets`, await tok(tadminA));
      return { id, secret: (issued.json() as { clientSecret: string }).clientSecret };
    }
    /** A code minted the way `/authorize` mints it, bound to a live session of tadminA. */
    async function mintCode(clientId: string): Promise<string> {
      const { session } = await sessions.create(tadminA, DEFAULT_TENANT_ID);
      // Run 35: the code grant re-checks the owner's membership in the client's tenant + consent.
      await seedCodeGrant(
        clientModel.db,
        { userId: tadminA, clientId, resource: API_AUD, scope: 'openid offline_access api.read' },
        TENANT_A,
      );
      return (
        await moduleRef.get(AuthorizationCodeService).create({
          clientId,
          redirectUri: REDIRECT,
          codeChallenge: deriveS256Challenge(VERIFIER),
          resource: API_AUD,
          scope: 'openid offline_access api.read',
          userId: tadminA,
          authTime: Math.floor(Date.now() / 1000),
          sessionRef: session.ref,
        })
      ).code;
    }
    const codeGrant = (c: { id: string; secret: string }, code: string) =>
      tokenPost(c.id, c.secret, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      });
    const refreshModel = () =>
      app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));

    it('code minted BEFORE disable cannot be exchanged while disabled; refresh dies; enable does not revive it', async () => {
      const x = await liveClient();
      // Positive control: our mint path really yields a working code + refresh token.
      const ok = await codeGrant(x, await mintCode(x.id));
      expect(ok.statusCode).toBe(200);
      const rt = ok.json().refresh_token as string;
      expect(typeof rt).toBe('string');
      const pending = await mintCode(x.id); // issued before the disable, exchanged after

      const t = await tok(tadminA);
      expect(
        (await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true })).statusCode,
      ).toBe(200);

      const exch = await codeGrant(x, pending);
      expect(exch.statusCode).not.toBe(200);
      expect(exch.json()).not.toHaveProperty('access_token');
      expect(['invalid_client', 'invalid_grant']).toContain(exch.json().error);

      const r1 = await tokenPost(x.id, x.secret, {
        grant_type: 'refresh_token',
        refresh_token: rt,
      });
      expect(r1.statusCode).not.toBe(200);
      expect(r1.json()).not.toHaveProperty('access_token');
      expect(['invalid_client', 'invalid_grant']).toContain(r1.json().error);

      const cc = await tokenPost(x.id, x.secret, {
        grant_type: 'client_credentials',
        scope: 'api.read',
      });
      expect(cc.statusCode).toBe(400);
      expect(cc.json()).not.toHaveProperty('access_token');

      expect(
        (await call('PATCH', `/admin/clients/${x.id}`, t, { disabled: false })).statusCode,
      ).toBe(200);
      const r2 = await tokenPost(x.id, x.secret, {
        grant_type: 'refresh_token',
        refresh_token: rt,
      });
      expect(r2.statusCode).toBe(400);
      expect(r2.json().error).toBe('invalid_grant');
      const live = await refreshModel().countDocuments({
        clientId: x.id,
        revokedAt: null,
        familyRevokedAt: null,
      });
      expect(live).toBe(0);
      // A fresh code after re-enable works again (the client is not bricked).
      expect((await codeGrant(x, await mintCode(x.id))).statusCode).toBe(200);
    });

    it('concurrent disable PATCHes: all 2xx, one disabledAt, zero live families, no 5xx', async () => {
      const x = await liveClient();
      const ok = await codeGrant(x, await mintCode(x.id));
      expect(ok.statusCode).toBe(200);
      const t = await tok(tadminA);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          call('PATCH', `/admin/clients/${x.id}`, t, { disabled: true }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
      const stored = await clientModel.findOne({ clientId: x.id }).lean();
      expect(stored?.disabledAt).toBeInstanceOf(Date);
      expect(
        await refreshModel().countDocuments({
          clientId: x.id,
          revokedAt: null,
          familyRevokedAt: null,
        }),
      ).toBe(0);
      const changed = await auditModel
        .find({
          action: 'ADMIN_CLIENT_UPDATED',
          targetId: x.id,
          result: 'success',
          'metadata.disabled': true,
        })
        .lean();
      expect(changed.length).toBeGreaterThanOrEqual(1);
    });
  });
  describe('run 30 QA (tester) — DEBT-137 rule A on every write path + DEBT-161 real race', () => {
    it('public client: admin alone / duplicated / by tenant_admin => refused, DB unchanged', async () => {
      const sp = await tok(superA);
      const id = await mkClient(publicSpa());
      const before = JSON.stringify(await clientModel.findOne({ clientId: id }).lean());
      for (const allowedResources of [['admin'], ['admin', 'admin'], ['admin', 'api']]) {
        const res = await call('PATCH', `/admin/clients/${id}`, sp, { allowedResources });
        expect(res.statusCode).toBe(400);
      }
      const byTenantAdmin = await call('PATCH', `/admin/clients/${id}`, await tok(tadminA), {
        allowedResources: ['admin'],
      });
      expect(byTenantAdmin.statusCode).toBe(403);
      expect(
        (
          await call(
            'POST',
            '/admin/clients',
            await tok(tadminA),
            publicSpa({ allowedResources: ['admin'] }),
          )
        ).statusCode,
      ).toBe(403);
      expect(JSON.stringify(await clientModel.findOne({ clientId: id }).lean())).toBe(before);
    });

    it('legacy public client already holding admin (pre-run-30 data): re-sending admin => 400', async () => {
      const id = await mkClient(publicSpa());
      await clientModel.updateOne(
        { clientId: id },
        { $set: { allowedResources: ['api', 'admin'] } },
      );
      const res = await call('PATCH', `/admin/clients/${id}`, await tok(superA), {
        allowedResources: ['api', 'admin'],
        scopes: ['openid'],
      });
      expect(res.statusCode).toBe(400);
      expect((await clientModel.findOne({ clientId: id }).lean())?.scopes).toEqual([
        'openid',
        'api.read',
      ]);
    });

    it('DEBT-161: concurrent disable+disable => same disabledAt everywhere; disable+enable => only 200/409, response never contradicts the stamp', async () => {
      const sp = await tok(superA);
      for (let i = 0; i < 10; i++) {
        const id = await mkClient(confidential());
        const [a, b] = await Promise.all([
          call('PATCH', `/admin/clients/${id}`, sp, { disabled: true }),
          call('PATCH', `/admin/clients/${id}`, sp, { disabled: true }),
        ]);
        expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
        const db = await clientModel.findOne({ clientId: id }).lean();
        expect(a.json().disabledAt).toBe(db!.disabledAt!.toISOString());
        expect(b.json().disabledAt).toBe(db!.disabledAt!.toISOString());
      }
      let conflicts = 0;
      for (let i = 0; i < 15; i++) {
        const id = await mkClient(confidential());
        const auditsBefore = await auditModel.countDocuments({
          action: 'ADMIN_CLIENT_UPDATED',
          targetId: id,
          result: 'success',
        });
        const [dis, en] = await Promise.all([
          call('PATCH', `/admin/clients/${id}`, sp, { disabled: true }),
          call('PATCH', `/admin/clients/${id}`, sp, { disabled: false }),
        ]);
        expect([200, 409]).toContain(dis.statusCode);
        expect(en.statusCode).toBe(200);
        if (dis.statusCode === 409) {
          conflicts++;
          expect(dis.json().error).toBe('conflict');
          // DEBT-167: a 409 never follows a write of another field (a disable is sent alone).
          const after = await clientModel.findOne({ clientId: id }).lean();
          expect(after?.disabledAt ?? null).toBeNull();
        } else {
          expect(dis.json().disabled).toBe(true);
          expect(typeof dis.json().disabledAt).toBe('string');
        }
        const auditsAfter = await auditModel.countDocuments({
          action: 'ADMIN_CLIENT_UPDATED',
          targetId: id,
          result: 'success',
        });
        // A 409 never leaves a success audit behind for the disable request.
        expect(auditsAfter - auditsBefore).toBe(dis.statusCode === 200 ? 2 : 1);
      }
      // Informational: how often the matchedCount=0 branch was hit by the real race.
      console.info(`DEBT-161 race: ${conflicts}/15 disable requests got 409`);
    });
  });
});
