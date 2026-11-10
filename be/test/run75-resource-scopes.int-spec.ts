import { jest } from '@jest/globals';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import { Types, type Connection, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { UserService } from '../src/modules/identity/user.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import {
  AuthorizeService,
  type AuthorizeParams,
  type SessionView,
} from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService, type Consent } from '../src/modules/oauth/consent/consent.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';
import { AuditAction } from '../src/modules/security/audit/audit-action.enum';
import { AuditService } from '../src/modules/security/audit/audit.service';
import type { AuditEvent } from '../src/modules/security/audit/audit.types';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SESSION_COOKIE, SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { expectNoIssued, recordIssued } from './issued-tokens';
import { seedConsent, seedOAuthUser } from './oauth-fixtures';

/**
 * Run 75 — DEBT-321 (`Resource.scopes` enforced: Client.scopes ∩ (OIDC ∪ Resource.scopes) at
 * /authorize, the consent bound and the code exchange) and DEBT-512 (refresh narrows the family to
 * the current intersection BEFORE signing, stores it on the successor; (i) empty, (ii) no non-OIDC
 * scope left, (iii) offline_access withdrawn ⇒ invalid_grant + family revoked). Cases a–f, c1–c2,
 * r1–r7 of `runs/75-resource-scopes/tasks.md` (g/g2 live in admin.int-spec.ts).
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-run75-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `r75${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const REDIRECT = 'https://app.example.com/callback';
const TENANT = 'tenant-B';
const FULL = ['openid', 'offline_access', 'api.read', 'api.write'];
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = deriveS256Challenge(VERIFIER);
let issued: string[] = [];

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'session') return { cookieSecure: false };
    if (ns === 'token')
      return {
        accessTokenTtl: 900,
        refreshTokenTtl: 2592000,
        sessionIdleTtl: 3600,
        sessionAbsoluteTtl: 86400,
      };
    if (ns === 'client') return { secretGraceTtl: 60 };
    if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
    if (ns === 'security')
      return {
        csrfSecret: 'test-csrf-secret',
        rateLimitWindow: 60,
        rateLimitMax: 100000,
        clientAuthFailIpMax: 100000,
        clientAuthFailClientMax: 100000,
      };
    throw new Error(`Unexpected config namespace: ${ns}`);
  },
} as unknown as ConfigService;

describe('run 75: Resource.scopes enforced (DEBT-321) + refresh narrows (DEBT-512)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let conn: Connection;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let auditModel: Model<AuditEvent>;
  let refreshModel: Model<Record<string, unknown>>;
  let refresh: RefreshTokenService;
  let authz: AuthorizeService;
  let seq = 0;

  interface Setup {
    clientId: string;
    resourceId: string;
    identifier: string;
    userId: string;
  }

  /** A fresh resource + public refresh-capable client + member user, owned by one case. */
  async function setup(clientScopes: string[], resourceScopes: string[]): Promise<Setup> {
    const k = ++seq;
    const resourceId = `${RUN}-r${k}`;
    const identifier = `https://api${k}.${RUN}.example.com/`;
    await app.get(ResourceService).create({ resourceId, identifier, scopes: resourceScopes });
    const clientId = `${RUN}-c${k}`;
    await new ClientService(clientModel, cfg).create({
      clientId,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      allowedResources: [resourceId],
      scopes: clientScopes,
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: TENANT,
    });
    const userId = await seedOAuthUser(conn, { tenantId: TENANT });
    return { clientId, resourceId, identifier, userId };
  }

  const setResourceScopes = (resourceId: string, scopes: string[]) =>
    resourceModel.updateOne({ resourceId }, { $set: { scopes } });
  const setClientScopes = (clientId: string, scopes: string[]) =>
    clientModel.updateOne({ clientId }, { $set: { scopes } });

  const authorizeParams = (s: Setup, scope: string): AuthorizeParams => ({
    response_type: 'code',
    client_id: s.clientId,
    redirect_uri: REDIRECT,
    scope,
    resource: s.identifier,
    state: 'rp-state',
    nonce: 'rp-nonce',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  });

  /** A live session for `userId`: the cookie id (HTTP) and the SessionView (service calls). */
  async function session(userId: string): Promise<{ id: string; view: SessionView }> {
    const { id, session: s } = await app.get(SessionService).create(userId, DEFAULT_TENANT_ID);
    return { id, view: { userId, authTime: Date.now(), ref: s.ref } };
  }

  const authorizeHttp = async (s: Setup, scope: string, cookieId: string) =>
    app.inject({
      method: 'GET',
      url: `/authorize?${new URLSearchParams(
        authorizeParams(s, scope) as Record<string, string>,
      ).toString()}`,
      cookies: { [SESSION_COOKIE]: cookieId },
    });

  const redirectParams = (res: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers['location'] as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    return loc.searchParams;
  };

  /** Consent pre-seeded for `scope` + real /authorize => a valid code. */
  async function issueCode(s: Setup, scope: string): Promise<string> {
    await seedConsent(conn, {
      userId: s.userId,
      clientId: s.clientId,
      resource: s.identifier,
      scopes: scope.split(' '),
    });
    const { id } = await session(s.userId);
    const code = redirectParams(await authorizeHttp(s, scope, id)).get('code');
    expect(code).toBeTruthy();
    return code!;
  }

  const exchange = (clientId: string, code: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }).toString(),
    });

  const refreshReq = (clientId: string, rt: string, scope?: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: rt,
        ...(scope !== undefined ? { scope } : {}),
      }).toString(),
    });

  /** Family `scope` granted by code => its first refresh token. */
  async function family(s: Setup, scope: string): Promise<string> {
    const res = await exchange(s.clientId, await issueCode(s, scope));
    expect(res.statusCode).toBe(200);
    return res.json().refresh_token as string;
  }

  const familyDocs = (userId: string) =>
    refreshModel.find({ userId: new Types.ObjectId(userId) }).lean<Record<string, unknown>[]>();
  const audits = (action: AuditAction, filter: Record<string, unknown>) =>
    auditModel.find({ action, ...filter }).lean<AuditEvent[]>();
  const atScope = (jwt: string): string =>
    JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).scope as string;
  const ctxKeys = async () => (await redis.keys('authz_ctx:*')).length;
  const codeKeys = async () => (await redis.keys('authz_code:*')).length;

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-run75-int-'));
    const provider = new LocalKeyProvider(keyDir);
    issued = recordIssued(provider);
    await provider.init();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [AuthorizeController, TokenController],
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
        UserService,
        UserTenantService,
        ResourceService,
        SessionService,
        SessionCookie,
        AuditService,
        RateLimitService,
        TokenSigner,
        TokenVerifier,
        HtmlExceptionFilter,
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

    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    conn = clientModel.db;
    await syncAllIndexes(conn);
    resourceModel = app.get<Model<Resource>>(getModelToken('Resource'));
    auditModel = app.get<Model<AuditEvent>>(getModelToken('AuditLog'));
    refreshModel = app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    refresh = app.get(RefreshTokenService);
    authz = app.get(AuthorizeService);
  }, 60_000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    if (redis) await redis.quit();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  describe('DEBT-321 /authorize + consent', () => {
    it('(a) a scope the client has but the resource does not list => invalid_scope redirect, no context, no code', async () => {
      const s = await setup(FULL, ['api.read']);
      await seedConsent(conn, {
        userId: s.userId,
        clientId: s.clientId,
        resource: s.identifier,
        scopes: FULL,
      });
      const { id } = await session(s.userId);
      const [ctx0, code0] = [await ctxKeys(), await codeKeys()];
      const q = redirectParams(await authorizeHttp(s, 'openid api.write', id));
      expect(q.get('error')).toBe('invalid_scope');
      expect(q.get('state')).toBe('rp-state');
      expect(q.get('code')).toBeNull();
      expect([await ctxKeys(), await codeKeys()]).toEqual([ctx0, code0]);
      // Not signed in: refused before any login context is stored either.
      await expect(
        authz.handle(authorizeParams(s, 'openid api.write'), null),
      ).rejects.toMatchObject({ error: 'invalid_scope', redirectUri: REDIRECT });
      expect(await ctxKeys()).toBe(ctx0);
    });

    it('(b) OIDC + a resource scope both granted => code', async () => {
      const s = await setup(FULL, ['api.read']);
      const code = await issueCode(s, 'openid offline_access api.read');
      const res = await exchange(s.clientId, code);
      expect(res.statusCode).toBe(200);
      expect(res.json().scope).toBe('openid offline_access api.read');
    });

    it('(c) openid on a resource with scopes [] => code', async () => {
      const s = await setup(['openid', 'offline_access'], []);
      const res = await exchange(s.clientId, await issueCode(s, 'openid offline_access'));
      expect(res.statusCode).toBe(200);
    });

    it('(d) intersection, not union: a resource scope the client lacks, and a client scope the resource lacks => invalid_scope', async () => {
      const s = await setup(['openid', 'api.read', 'api.write'], ['api.read', 'api.admin']);
      const { id } = await session(s.userId);
      expect(redirectParams(await authorizeHttp(s, 'openid api.admin', id)).get('error')).toBe(
        'invalid_scope',
      );
      const q = redirectParams(await authorizeHttp(s, 'openid api.write', id));
      expect(q.get('error')).toBe('invalid_scope');
      expect(q.get('code')).toBeNull();
    });

    it('(e) resume after login when the resource lost the scope meanwhile => invalid_scope', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      // DEBT-413: the login context is bound to the browser's `idp_authz` hash; resume with it.
      const binding = 'b'.repeat(64);
      const out = await authz.handle(authorizeParams(s, 'openid api.write'), null, {}, binding);
      if (out.kind !== 'login_required') throw new Error('expected login_required');
      await setResourceScopes(s.resourceId, ['api.read']);
      const { view: v } = await session(s.userId);
      const code0 = await codeKeys();
      await expect(authz.resume(out.requestId, v, {}, binding)).rejects.toMatchObject({
        error: 'invalid_scope',
        redirectUri: REDIRECT,
        state: 'rp-state',
      });
      expect(await codeKeys()).toBe(code0);
    });

    it('(f) resource scope removed between consent render and approve => consent never records it; /token invalid_grant', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const { view: v } = await session(s.userId);
      const out = await authz.handle(authorizeParams(s, FULL.join(' ')), v);
      if (out.kind !== 'consent_required') throw new Error('expected consent_required');
      await setResourceScopes(s.resourceId, ['api.read']);
      const decision = await authz.decideConsent(out.requestId, true, v);
      expect(decision?.code).toBeTruthy();
      const consent = await conn
        .model<Consent>('Consent')
        .findOne({ userId: new Types.ObjectId(s.userId), clientId: s.clientId })
        .lean<Consent>();
      expect(consent!.grantedScopes).not.toContain('api.write');
      expect(consent!.grantedScopes).toEqual(
        expect.arrayContaining(['openid', 'offline_access', 'api.read']),
      );
      const res = await exchange(s.clientId, decision!.code!);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      expect(res.body).not.toContain('access_token');
    });
  });

  describe('DEBT-321 code exchange (c1–c2)', () => {
    async function expectCodeRefused(s: Setup, res: { statusCode: number; body: string }) {
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_grant');
      expect(res.body).not.toContain('access_token');
      expectNoIssued(res.body, issued);
      const a = await audits(AuditAction.TOKEN_ISSUED, { actorId: s.userId });
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ result: 'failure', reason: 'scope_not_allowed' });
      expect((await familyDocs(s.userId)).every((d) => d.revokedAt)).toBe(true);
    }

    it('(c1) consent covers api.write, code issued, admin removes api.write from the resource => invalid_grant scope_not_allowed', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const code = await issueCode(s, FULL.join(' '));
      await setResourceScopes(s.resourceId, ['api.read']);
      await expectCodeRefused(s, await exchange(s.clientId, code));
    });

    it('(c2) same, but api.write removed from Client.scopes => invalid_grant scope_not_allowed', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const code = await issueCode(s, FULL.join(' '));
      await setClientScopes(s.clientId, ['openid', 'offline_access', 'api.read']);
      await expectCodeRefused(s, await exchange(s.clientId, code));
    });
  });

  describe('DEBT-512 refresh narrows to the current intersection (r1–r7)', () => {
    const refreshed = (userId: string) => audits(AuditAction.TOKEN_REFRESHED, { actorId: userId });
    const reuse = (clientId: string) => audits(AuditAction.TOKEN_REUSE_DETECTED, { clientId });
    const liveDoc = async (userId: string) => {
      const live = (await familyDocs(userId)).filter((d) => !d.revokedAt);
      expect(live).toHaveLength(1);
      return live[0];
    };

    async function expectNarrowed(s: Setup, rt: string, want: string): Promise<string> {
      const res = await refreshReq(s.clientId, rt);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.scope).toBe(want);
      expect(atScope(body.access_token as string)).toBe(want);
      expect(((await liveDoc(s.userId)).scope as string[]).join(' ')).toBe(want);
      return body.refresh_token as string;
    }

    it('(r1) resource narrowed to [api.read] => 200 without api.write everywhere; re-adding it does not revive it', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setResourceScopes(s.resourceId, ['api.read']);
      const rt2 = await expectNarrowed(s, rt, 'openid offline_access api.read');
      await setResourceScopes(s.resourceId, ['api.read', 'api.write']);
      await expectNarrowed(s, rt2, 'openid offline_access api.read');
    });

    it('(r2) api.read removed from Client.scopes => narrowed the same way', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setClientScopes(s.clientId, ['openid', 'offline_access', 'api.write']);
      await expectNarrowed(s, rt, 'openid offline_access api.write');
    });

    async function expectFamilyKilled(
      s: Setup,
      rt: string,
      res: { statusCode: number; body: string },
    ) {
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_grant');
      expectNoIssued(res.body, issued);
      const docs = await familyDocs(s.userId);
      expect(docs).toHaveLength(1); // nothing rotated: no successor
      expect(docs.every((d) => d.revokedAt)).toBe(true);
      const a = (await refreshed(s.userId)).filter((e) => e.result === 'failure');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        reason: 'scope_not_allowed',
        metadata: { resource: s.identifier },
      });
      expect(JSON.stringify(a[0])).not.toContain(rt);
      expect(await reuse(s.clientId)).toHaveLength(0);
      const replay = await refreshReq(s.clientId, rt);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe('invalid_grant');
      expect(await reuse(s.clientId)).toHaveLength(0);
    }

    it('(r3) resource scopes [] => no non-OIDC scope left => invalid_grant, family revoked, one audit, no reuse', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setResourceScopes(s.resourceId, []);
      await expectFamilyKilled(s, rt, await refreshReq(s.clientId, rt));
    });

    it('(r4) an OIDC-only family on a resource with scopes [] keeps refreshing unchanged', async () => {
      const s = await setup(['openid', 'offline_access'], []);
      const rt = await family(s, 'openid offline_access');
      await expectNarrowed(s, rt, 'openid offline_access');
    });

    it('(r5) offline_access removed from Client.scopes => invalid_grant, family revoked', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setClientScopes(s.clientId, ['openid', 'api.read', 'api.write']);
      await expectFamilyKilled(s, rt, await refreshReq(s.clientId, rt));
    });

    it('(r6) a requested scope outside the current intersection => invalid_scope, the RT stays active', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setResourceScopes(s.resourceId, ['api.read']);
      // Still in the family grant, but no longer grantable: nothing to issue.
      const bad = await refreshReq(s.clientId, rt, 'api.write');
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('invalid_scope');
      expect((await liveDoc(s.userId)).scope).toEqual(FULL);
      // After the narrowing refresh (r1), api.write is outside the family itself.
      const rt2 = await expectNarrowed(s, rt, 'openid offline_access api.read');
      const bad2 = await refreshReq(s.clientId, rt2, 'api.write');
      expect(bad2.statusCode).toBe(400);
      expect(bad2.json().error).toBe('invalid_scope');
      expect((await liveDoc(s.userId)).scope).toEqual(['openid', 'offline_access', 'api.read']);
      // A narrower request inside the intersection works and the family keeps its scope.
      const ok = await refreshReq(s.clientId, rt2, 'openid');
      expect(ok.statusCode).toBe(200);
      expect(ok.json().scope).toBe('openid');
      expect((await liveDoc(s.userId)).scope).toEqual(['openid', 'offline_access', 'api.read']);
    });

    it('(r7) revokeFamily fails on the refusal => 500, no detail, audit kept; retry => invalid_grant, family revoked', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setResourceScopes(s.resourceId, []);
      jest
        .spyOn(refresh, 'revokeFamily')
        .mockRejectedValueOnce(new Error('mongo down secret-detail'));
      const res = await refreshReq(s.clientId, rt);
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('secret-detail');
      expectNoIssued(res.body, issued);
      const a = await refreshed(s.userId);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ result: 'failure', reason: 'scope_not_allowed' });
      jest.restoreAllMocks();
      const again = await refreshReq(s.clientId, rt);
      expect(again.statusCode).toBe(400);
      expect(again.json().error).toBe('invalid_grant');
      expect((await familyDocs(s.userId)).every((d) => d.revokedAt)).toBe(true);
      expect(await reuse(s.clientId)).toHaveLength(0);
    });
  });

  // Tester run 75: risk-matrix gaps (negative actor, concurrency) not covered by a–g / c / r.
  describe('tester: negative actor + concurrency', () => {
    const refusals = (familyId: unknown) =>
      audits(AuditAction.TOKEN_REFRESHED, {
        reason: 'scope_not_allowed',
        'metadata.familyId': familyId,
      });

    it('(t1) another client presenting the victim RT after its resource was emptied => invalid_grant, victim family untouched, no refusal audit', async () => {
      const victim = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(victim, FULL.join(' '));
      const attacker = await setup(FULL, ['api.read', 'api.write']);
      // The attacker client is even allowed on the victim's resource (worst case).
      await clientModel.updateOne(
        { clientId: attacker.clientId },
        { $set: { allowedResources: [attacker.resourceId, victim.resourceId] } },
      );
      await setResourceScopes(victim.resourceId, []);
      const res = await refreshReq(attacker.clientId, rt);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      expectNoIssued(res.body, issued);
      const docs = await familyDocs(victim.userId);
      expect(docs).toHaveLength(1);
      expect(docs[0].revokedAt ?? null).toBeNull();
      expect(await refusals(docs[0].familyId)).toHaveLength(0);
      // The owner still gets the (fail-closed) refusal on its own request.
      const own = await refreshReq(victim.clientId, rt);
      expect(own.statusCode).toBe(400);
      expect(await refusals(docs[0].familyId)).toHaveLength(1);
    });

    it('(t2) concurrent refreshes of one RT after narrowing => no response or stored RT ever carries the removed scope', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setResourceScopes(s.resourceId, ['api.read']);
      const results = await Promise.all([1, 2, 3].map(() => refreshReq(s.clientId, rt)));
      const ok = results.filter((r) => r.statusCode === 200);
      expect(ok.length).toBeLessThanOrEqual(1);
      for (const r of results) {
        if (r.statusCode === 200) {
          expect(r.json().scope).toBe('openid offline_access api.read');
          expect(atScope(r.json().access_token as string)).toBe('openid offline_access api.read');
        } else {
          expect(r.statusCode).toBe(400);
          expect(r.json().error).toBe('invalid_grant');
        }
      }
      const docs = await familyDocs(s.userId);
      // The original keeps its grant; every descendant stores only the narrowed scope.
      expect(docs.filter((d) => (d.scope as string[]).includes('api.write'))).toHaveLength(1);
      // At most one successor. A concurrent loser is reuse (existing semantics) and kills the family,
      // so the winner may also end invalid_grant (fail closed): then nothing stays alive.
      expect(docs.length).toBeLessThanOrEqual(2);
      if (ok.length === 0) expect(docs.every((d) => d.revokedAt)).toBe(true);
    });

    it('(t3) concurrent refreshes of one RT after the resource was emptied => all invalid_grant, family revoked, no false reuse', async () => {
      const s = await setup(FULL, ['api.read', 'api.write']);
      const rt = await family(s, FULL.join(' '));
      await setResourceScopes(s.resourceId, []);
      const results = await Promise.all([1, 2, 3].map(() => refreshReq(s.clientId, rt)));
      for (const r of results) {
        expect(r.statusCode).toBe(400);
        expect(r.json().error).toBe('invalid_grant');
        expectNoIssued(r.body, issued);
      }
      const docs = await familyDocs(s.userId);
      expect(docs).toHaveLength(1);
      expect(docs.every((d) => d.revokedAt)).toBe(true);
      expect(await audits(AuditAction.TOKEN_REUSE_DETECTED, { clientId: s.clientId })).toHaveLength(
        0,
      );
    });
  });
});
