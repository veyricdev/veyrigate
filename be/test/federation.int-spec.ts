import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { Model } from 'mongoose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken, sha256 } from '../src/common/crypto/crypto.util';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { buildCsp } from '../src/common/http/csp';
import { OAuthExceptionFilter } from '../src/common/filters/oauth-exception.filter';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { RedisService } from '../src/database/redis/redis.service';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientService } from '../src/modules/clients/client.service';
import { FederationController } from '../src/modules/federation/federation.controller';
import { FederationService } from '../src/modules/federation/federation.service';
import { FederationStateStore } from '../src/modules/federation/federation-state.store';
import {
  buildFederationProviders,
  FEDERATION_PROVIDERS,
  GITHUB,
  GOOGLE,
  type FederationProviders,
} from '../src/modules/federation/providers';
import { FederatedIdentityService } from '../src/modules/identity/federated-identity.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { ADMIN_LOCKED_UNTIL, UserService } from '../src/modules/identity/user.service';
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
import { TokenService } from '../src/modules/oauth/token/token.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { SESSION_COOKIE, SessionCookie } from '../src/modules/sessions/session.cookie';
import { SessionService } from '../src/modules/sessions/session.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { UiController } from '../src/modules/ui/ui.controller';

/**
 * Run 32 (B5.1 + B5.2): federation broker end to end on real Mongo + Redis, with Google/GitHub
 * replaced by a `node:http` mock on 127.0.0.1 injected through the `FEDERATION_PROVIDERS` DI token
 * (`overrideProvider`, F1). No real provider is ever contacted (F13).
 */
const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-federation-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

const ISSUER = 'http://localhost:4000';
const RUN = `fed${Date.now()}`;
const CLIENT = `${RUN}-spa`;
const REDIRECT = 'https://rp.example.com/callback';
const API_AUD = 'https://api.example.com/';
const RP_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RP_STATE = 'rp-state/with+odd=chars&x';
const G_ID = 'mock-google-client-id';
const G_SECRET = 'MOCK-GOOGLE-CLIENT-SECRET-0001';
const GH_ID = 'mock-github-client-id';
const GH_SECRET = 'MOCK-GITHUB-CLIENT-SECRET-0002';
const G_ACCESS = 'MOCK-GOOGLE-ACCESS-TOKEN-0003';

type Res = Awaited<ReturnType<NestFastifyApplication['inject']>>;

interface Grant {
  provider: 'google' | 'github';
  challenge: string;
  redirectUri: string;
  nonce?: string;
  claims?: Record<string, unknown>;
  gh?: { id: number; emails: unknown[] };
}

describe('Federation broker (run 32, B5.1/B5.2) on real Mongo + Redis + mock providers', () => {
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let server: Server;
  let registry: FederationProviders;
  let googleKey: Parameters<SignJWT['sign']>[0];
  let verifier: TokenVerifier;
  let sessions: SessionService;
  let users: UserService;
  let contexts: AuthorizeRequestContextService;
  let userModel: Model<Record<string, unknown>>;
  let fiModel: Model<Record<string, unknown>>;
  let utModel: Model<Record<string, unknown>>;
  let auditModel: Model<Record<string, unknown>>;

  // --- mock provider state ---
  const grants = new Map<string, Grant>();
  const ghTokens = new Map<string, NonNullable<Grant['gh']>>();
  const mock = {
    tokenStatus: 200,
    tokenDelayMs: 0,
    ghTokenBody: undefined as unknown,
    issuedSecrets: [] as string[],
    // Tester (run 32): raw response override per path (3xx, oversized body); hits for leak checks.
    raw: undefined as
      | ((path: string, res: import('node:http').ServerResponse) => boolean)
      | undefined,
    hits: [] as string[],
  };

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
      if (ns === 'federation') return {};
      throw new Error(`Unexpected config namespace: ${ns}`);
    },
  } as unknown as ConfigService;

  const signGoogle = (grant: Grant, sub: string) => {
    const now = Math.floor(Date.now() / 1000);
    const { iss, aud, ...claims } = grant.claims ?? {};
    return new SignJWT({
      nonce: grant.nonce,
      email: `${sub}@example.com`,
      email_verified: true,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'mock-k1' })
      .setIssuer((iss as string) ?? 'https://accounts.google.com')
      .setAudience((aud as string) ?? G_ID)
      .setSubject((claims.sub as string) ?? sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(googleKey);
  };

  async function handle(
    path: string,
    body: string,
    auth: string | undefined,
  ): Promise<[number, unknown]> {
    if (path === '/g/token' || path === '/gh/token') {
      if (mock.tokenDelayMs) await new Promise((r) => setTimeout(r, mock.tokenDelayMs));
      if (mock.tokenStatus !== 200) return [mock.tokenStatus, { error: 'MOCK-UPSTREAM-DETAIL' }];
      const form = new URLSearchParams(body);
      const code = form.get('code') ?? '';
      const grant = grants.get(code);
      grants.delete(code);
      const secret = path === '/g/token' ? G_SECRET : GH_SECRET;
      if (
        !grant ||
        deriveS256Challenge(form.get('code_verifier') ?? '') !== grant.challenge ||
        form.get('client_secret') !== secret ||
        form.get('redirect_uri') !== grant.redirectUri
      ) {
        return [400, { error: 'invalid_grant' }];
      }
      if (grant.provider === 'github') {
        if (mock.ghTokenBody !== undefined) return [200, mock.ghTokenBody];
        const access = `MOCK-GH-ACCESS-${code}`;
        mock.issuedSecrets.push(access);
        ghTokens.set(access, grant.gh!);
        return [200, { access_token: access, token_type: 'bearer' }];
      }
      const idToken = await signGoogle(grant, (grant.claims?.sub as string) ?? code);
      mock.issuedSecrets.push(idToken);
      return [200, { access_token: G_ACCESS, id_token: idToken }];
    }
    const gh = ghTokens.get((auth ?? '').replace(/^Bearer /, ''));
    if (!gh) return [401, { message: 'Bad credentials' }];
    if (path === '/gh/user') return [200, { id: gh.id, login: `login-${gh.id}` }];
    if (path === '/gh/emails') return [200, gh.emails];
    return [404, {}];
  }

  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  const cookieOf = (res: Res, name: string) => res.cookies.find((c) => c.name === name);

  const authorizeQuery = (extra: Record<string, string> = {}) =>
    `/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope: 'openid api.read',
      resource: API_AUD,
      state: RP_STATE,
      nonce: 'rp-nonce',
      code_challenge: deriveS256Challenge(RP_VERIFIER),
      code_challenge_method: 'S256',
      ...extra,
    }).toString()}`;

  /** RP -> /authorize (signed out) -> 302 /login?returnTo=/authorize?request_id=X; returns X. */
  async function rpAuthorize(extra: Record<string, string> = {}, sessionId?: string) {
    const res = await app.inject({
      method: 'GET',
      url: authorizeQuery(extra),
      ...(sessionId ? { cookies: { [SESSION_COOKIE]: sessionId } } : {}),
    });
    expect(res.statusCode).toBe(302);
    const login = new URL(res.headers.location as string, ISSUER);
    expect(login.pathname).toBe('/login');
    const returnTo = login.searchParams.get('returnTo')!;
    return { requestId: new URL(returnTo, ISSUER).searchParams.get('request_id')!, returnTo };
  }

  const loginPage = (returnTo: string) =>
    app.inject({ method: 'GET', url: `/login?returnTo=${encodeURIComponent(returnTo)}` });

  async function start(provider: string, requestId: string, fed?: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${provider}/start?request_id=${encodeURIComponent(requestId)}`,
      ...(fed ? { cookies: { idp_fed: fed } } : {}),
    });
    return {
      res,
      location: res.statusCode === 302 ? new URL(res.headers.location as string) : undefined,
      fed: cookieOf(res, 'idp_fed')?.value ?? fed,
    };
  }

  /** The mock "user approved at the provider": register a code bound to this leg. */
  function grant(
    provider: 'google' | 'github',
    location: URL,
    extra: Partial<Pick<Grant, 'claims' | 'gh'>> = {},
  ) {
    const code = `MOCK-CODE-${generateToken(12)}`;
    grants.set(code, {
      provider,
      challenge: location.searchParams.get('code_challenge')!,
      redirectUri: location.searchParams.get('redirect_uri')!,
      nonce: location.searchParams.get('nonce') ?? undefined,
      ...extra,
    });
    return { code, state: location.searchParams.get('state')! };
  }

  const callback = (
    provider: string,
    query: Record<string, string>,
    cookies: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'GET',
      url: `/auth/${provider}/callback?${new URLSearchParams(query).toString()}`,
      cookies,
    });

  /** Full social leg: start -> provider grant -> callback. */
  async function socialLogin(
    provider: 'google' | 'github',
    requestId: string,
    extra: Partial<Pick<Grant, 'claims' | 'gh'>> = {},
    cookies: Record<string, string> = {},
  ) {
    const s = await start(provider, requestId);
    expect(s.res.statusCode).toBe(302);
    const g = grant(provider, s.location!, extra);
    const res = await callback(provider, g, { idp_fed: s.fed!, ...cookies });
    return { res, ...g, fed: s.fed! };
  }

  /** From a signed-in session, resume `/authorize?request_id`, approve consent if shown, return RP redirect. */
  async function resumeToRp(location: string, sessionId: string): Promise<URL> {
    let res = await app.inject({
      method: 'GET',
      url: location,
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    if (res.statusCode === 200) {
      const requestId = res.body.match(/name="request_id" value="([^"]+)"/)?.[1];
      const csrf = res.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
      res = await app.inject({
        method: 'POST',
        url: '/authorize/consent',
        cookies: { [SESSION_COOKIE]: sessionId },
        payload: { _csrf: csrf!, request_id: requestId!, approve: 'true' },
      });
    }
    expect(res.statusCode).toBe(302);
    return new URL(res.headers.location as string);
  }

  async function exchange(rp: URL) {
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'authorization_code',
        code: rp.searchParams.get('code')!,
        redirect_uri: REDIRECT,
        client_id: CLIENT,
        code_verifier: RP_VERIFIER,
      }),
    });
    expect(res.statusCode).toBe(200);
    return verifier.verify(res.json().id_token, CLIENT);
  }

  const expectNoSession = (res: Res) => {
    expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
  };

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-federation-int-'));
    const keyProvider = new LocalKeyProvider(keyDir);
    await keyProvider.init();

    const pair = await generateKeyPair('RS256');
    googleKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'mock-k1', alg: 'RS256' } as JWK;

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const path = new URL(req.url!, 'http://127.0.0.1').pathname;
        mock.hits.push(path);
        if (mock.raw?.(path, res)) return;
        void handle(path, body, req.headers.authorization)
          .then(([status, json]) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(json));
          })
          .catch(() => {
            res.writeHead(500);
            res.end();
          });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    registry = {
      google: {
        name: 'google',
        enabled: true,
        clientId: G_ID,
        clientSecret: G_SECRET,
        authorizeUrl: `${base}/g/authorize`,
        tokenUrl: `${base}/g/token`,
        scopes: GOOGLE.scopes,
        issuers: GOOGLE.issuers,
        timeoutMs: 500,
        jwks: createLocalJWKSet({ keys: [jwk] }),
      },
      github: {
        name: 'github',
        enabled: true,
        clientId: GH_ID,
        clientSecret: GH_SECRET,
        authorizeUrl: `${base}/gh/authorize`,
        tokenUrl: `${base}/gh/token`,
        userUrl: `${base}/gh/user`,
        emailsUrl: `${base}/gh/emails`,
        scopes: GITHUB.scopes,
        timeoutMs: 500,
      },
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [AuthorizeController, TokenController, UiController, FederationController],
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
        FederatedIdentityService,
        LogoutService,
        FederationService,
        FederationStateStore,
        // The production factory (same shape as FederationModule) — replaced below (F1).
        {
          provide: FEDERATION_PROVIDERS,
          inject: [ConfigService],
          useFactory: () => buildFederationProviders({}),
        },
        { provide: MAILER, useValue: { send: async () => undefined } },
        { provide: KEY_PROVIDER, useValue: keyProvider },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    })
      .overrideProvider(FEDERATION_PROVIDERS)
      .useValue(registry)
      .compile();

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
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    verifier = moduleRef.get(TokenVerifier);
    sessions = moduleRef.get(SessionService);
    users = moduleRef.get(UserService);
    contexts = moduleRef.get(AuthorizeRequestContextService);
    userModel = app.get(getModelToken('User'));
    fiModel = app.get(getModelToken('FederatedIdentity'));
    utModel = app.get(getModelToken('UserTenant'));
    auditModel = app.get(getModelToken('AuditLog'));
    await syncAllIndexes(userModel.db);

    await moduleRef.get(ResourceService).create({
      resourceId: 'api',
      identifier: API_AUD,
      scopes: ['api.read'],
    });
    await moduleRef.get(ClientService).create({
      clientId: CLIENT,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      allowedResources: ['api'],
      scopes: ['openid', 'api.read'],
      tenantId: 'tenant-A',
    });
  }, 60_000);

  afterAll(async () => {
    if (redis) {
      for (const p of ['authz_ctx:*', 'authz_code:*', 'fed_state:*', 'sess_rp:*', 'rl:*']) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
    }
    if (userModel) {
      for (const u of await userModel.find({}, { _id: 1 }).lean()) {
        await sessions.revokeAllForUser(String(u._id));
      }
      await userModel.db.dropDatabase();
    }
    if (app) await app.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    mock.tokenStatus = 200;
    mock.tokenDelayMs = 0;
    mock.ghTokenBody = undefined;
    mock.raw = undefined;
    mock.hits = [];
    registry.google.enabled = true;
    registry.github.enabled = true;
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------ happy path (F13)
  describe('full flow RP -> /authorize -> /login -> provider -> callback -> consent -> /token', () => {
    it('Google: new user is provisioned, RP state echoed intact, sub = local User._id, amr=[fed]', async () => {
      const { requestId, returnTo } = await rpAuthorize();
      const page = await loginPage(returnTo);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain(`href="/auth/google/start?request_id=${requestId}"`);
      expect(page.body).toContain(`href="/auth/github/start?request_id=${requestId}"`);
      // F12: the CSP is NOT widened for provider hosts (top-level <a> navigation).
      expect(page.headers['content-security-policy']).toBe(
        buildCsp({ formAction: ['https://rp.example.com'] }),
      );

      const s = await start('google', requestId);
      expect(s.res.statusCode).toBe(302);
      expect(s.res.headers['cache-control']).toBe('no-store');
      expect(s.location!.origin + s.location!.pathname).toBe(registry.google.authorizeUrl);
      const q = Object.fromEntries(s.location!.searchParams);
      expect(q).toMatchObject({
        client_id: G_ID,
        redirect_uri: `${ISSUER}/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email',
        code_challenge_method: 'S256',
      });
      expect(q.state && q.nonce && q.code_challenge).toBeTruthy();
      expect(q).not.toHaveProperty('max_age');
      expect(s.location!.href).not.toContain(requestId);
      const fed = cookieOf(s.res, 'idp_fed')!;
      expect(fed).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/auth/', maxAge: 600 });

      const sub = `${RUN}-g-new`;
      const g = grant('google', s.location!, { claims: { sub } });
      const oldSession = await sessions.create('000000000000000000000001', DEFAULT_TENANT_ID);
      const cb = await callback('google', g, {
        idp_fed: s.fed!,
        [SESSION_COOKIE]: oldSession.id,
      });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers['cache-control']).toBe('no-store');
      expect(cb.headers.location).toBe(`/authorize?request_id=${encodeURIComponent(requestId)}`);
      const sessionId = cookieOf(cb, SESSION_COOKIE)!.value;
      expect(sessionId).not.toBe(oldSession.id);
      // Session fixation: the pre-login session id is gone.
      expect(await sessions.get(oldSession.id)).toBeNull();
      const live = await sessions.get(sessionId);
      expect(live?.amr).toEqual(['fed']);
      expect(live?.tenantId).toBe(DEFAULT_TENANT_ID);

      const user = await userModel.findOne({ email: `${sub}@example.com` }).lean();
      expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
      expect(user).not.toHaveProperty('passwordHash');
      expect(live?.userId).toBe(String(user!._id));
      const fi = await fiModel.findOne({ provider: 'google', providerId: sub }).lean();
      expect(String(fi?.userId)).toBe(String(user!._id));
      expect(fi?.lastLoginAt).toBeInstanceOf(Date);
      expect(fi).toMatchObject({ email: `${sub}@example.com`, emailVerified: true });
      expect(await utModel.countDocuments({ userId: user!._id, tenantId: DEFAULT_TENANT_ID })).toBe(
        1,
      );

      const rp = await resumeToRp(cb.headers.location as string, sessionId);
      expect(rp.origin + rp.pathname).toBe(REDIRECT);
      expect(rp.searchParams.get('state')).toBe(RP_STATE);
      const idToken = await exchange(rp);
      expect(idToken.sub).toBe(String(user!._id));
      expect(idToken.sub).not.toBe(sub);
      expect(idToken.amr).toEqual(['fed']);
      expect(idToken.nonce).toBe('rp-nonce');

      const success = await auditModel
        .findOne({ action: 'AUTH_LOGIN_SUCCESS', actorId: String(user!._id) })
        .lean();
      expect(success?.metadata).toEqual({ provider: 'google', newUser: true });
    });

    it('second login of the same identity => same user, no duplicate, newUser=false, lastLoginAt moves', async () => {
      const sub = `${RUN}-g-again`;
      const first = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      expect(first.res.statusCode).toBe(302);
      const fi1 = await fiModel.findOne({ provider: 'google', providerId: sub }).lean();
      await new Promise((r) => setTimeout(r, 5));
      const second = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      expect(second.res.statusCode).toBe(302);
      const uid = (await sessions.get(cookieOf(second.res, SESSION_COOKIE)!.value))!.userId;
      expect(uid).toBe((await sessions.get(cookieOf(first.res, SESSION_COOKIE)!.value))!.userId);
      expect(await userModel.countDocuments({ email: `${sub}@example.com` })).toBe(1);
      const fi2 = await fiModel.findOne({ provider: 'google', providerId: sub }).lean();
      expect((fi2!.lastLoginAt as Date).getTime()).toBeGreaterThan(
        (fi1!.lastLoginAt as Date).getTime(),
      );
      const audits = await auditModel
        .find({ action: 'AUTH_LOGIN_SUCCESS', actorId: uid })
        .sort({ timestamp: 1 })
        .lean();
      expect(audits.map((a) => (a.metadata as { newUser: boolean }).newUser)).toEqual([
        true,
        false,
      ]);
    });

    it('GitHub: primary+verified email provisions; providerId = numeric id; full flow to /token', async () => {
      const ghId = 900_000 + Math.floor(Math.random() * 1000);
      const email = `${RUN}-gh@example.com`;
      const { requestId } = await rpAuthorize();
      const { res } = await socialLogin('github', requestId, {
        gh: {
          id: ghId,
          emails: [
            { email: `${RUN}-other@example.com`, primary: false, verified: true },
            { email, primary: true, verified: true },
          ],
        },
      });
      expect(res.statusCode).toBe(302);
      const fi = await fiModel.findOne({ provider: 'github', providerId: String(ghId) }).lean();
      const user = await userModel.findOne({ email }).lean();
      expect(String(fi?.userId)).toBe(String(user!._id));
      const rp = await resumeToRp(
        res.headers.location as string,
        cookieOf(res, SESSION_COOKIE)!.value,
      );
      expect(rp.searchParams.get('state')).toBe(RP_STATE);
      const idToken = await exchange(rp);
      expect(idToken.sub).toBe(String(user!._id));
      expect(idToken.amr).toEqual(['fed']);
    });

    it('local password login still yields amr=[pwd] (DEBT-030)', async () => {
      const email = `${RUN}-local@example.com`;
      const local = await users.create({ email, password: 'correct horse battery' });
      await users.verifyEmail(local.sub);
      await moduleRef.get(UserTenantService).addMembership(local.sub, DEFAULT_TENANT_ID);
      const { returnTo } = await rpAuthorize();
      const page = await loginPage(returnTo);
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        cookies: { idp_csrf: cookieOf(page, 'idp_csrf')!.value },
        payload: { _csrf: csrf, email, password: 'correct horse battery', returnTo },
      });
      expect(res.statusCode).toBe(302);
      const sessionId = cookieOf(res, SESSION_COOKIE)!.value;
      expect((await sessions.get(sessionId))?.amr).toEqual(['pwd']);
      const idToken = await exchange(await resumeToRp(res.headers.location as string, sessionId));
      expect(idToken.amr).toEqual(['pwd']);
    });
  });

  // ------------------------------------------------------------------ negative paths (F14)
  describe('state / binding / context (F5, F6, F14)', () => {
    it('unknown state => 400 first-party page, no session, no redirect', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const res = await callback(
        'google',
        { state: generateToken(), code: 'x' },
        { idp_fed: s.fed! },
      );
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    });

    it('missing state => 400', async () => {
      const res = await callback('google', { code: 'x' }, { idp_fed: 'x' });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
    });

    it('replayed state (second use) => 400 even after a successful first use', async () => {
      const { requestId } = await rpAuthorize();
      const first = await socialLogin('google', requestId, { claims: { sub: `${RUN}-replay` } });
      expect(first.res.statusCode).toBe(302);
      const again = grant('google', new URL(`http://x/?state=${first.state}&code_challenge=c`));
      const res = await callback(
        'google',
        { state: first.state, code: again.code },
        { idp_fed: first.fed },
      );
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
    });

    it('expired state => 400', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-expired` } });
      expect(await redis.del(`fed_state:${sha256(g.state)}`)).toBe(1); // TTL elapsed
      const res = await callback('google', g, { idp_fed: s.fed! });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
    });

    it('Google state on the GitHub callback route (mix-up) => 400, and the state is dead afterwards', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-mixup` } });
      const wrong = await callback('github', g, { idp_fed: s.fed! });
      expect(wrong.statusCode).toBe(400);
      expectNoSession(wrong);
      const right = await callback('google', g, { idp_fed: s.fed! });
      expect(right.statusCode).toBe(400);
      expectNoSession(right);
      expect(await fiModel.countDocuments({ providerId: `${RUN}-mixup` })).toBe(0);
    });

    it('missing or foreign idp_fed cookie (login CSRF) => 400, state consumed', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-csrf` } });
      const none = await callback('google', g);
      expect(none.statusCode).toBe(400);
      expectNoSession(none);

      const s2 = await start('google', requestId);
      const g2 = grant('google', s2.location!, { claims: { sub: `${RUN}-csrf` } });
      const foreign = await callback('google', g2, { idp_fed: generateToken() });
      expect(foreign.statusCode).toBe(400);
      expectNoSession(foreign);
      // Even the right cookie cannot reuse the state now.
      expect((await callback('google', g2, { idp_fed: s2.fed! })).statusCode).toBe(400);
      expect(await fiModel.countDocuments({ providerId: `${RUN}-csrf` })).toBe(0);
    });

    it('idp_fed is reused across legs (two tabs both complete)', async () => {
      const a = await rpAuthorize();
      const b = await rpAuthorize();
      const s1 = await start('google', a.requestId);
      const s2 = await start('google', b.requestId, s1.fed);
      expect(s2.fed).toBe(s1.fed);
      const g1 = grant('google', s1.location!, { claims: { sub: `${RUN}-tabs` } });
      const g2 = grant('google', s2.location!, { claims: { sub: `${RUN}-tabs` } });
      expect((await callback('google', g2, { idp_fed: s1.fed! })).statusCode).toBe(302);
      expect((await callback('google', g1, { idp_fed: s1.fed! })).statusCode).toBe(302);
    });

    it('start: unknown request_id / consent-kind context / no request_id => 400, no redirect', async () => {
      const consentCtx = await contexts.create({
        kind: 'consent',
        clientId: CLIENT,
        redirectUri: REDIRECT,
        codeChallenge: deriveS256Challenge(RP_VERIFIER),
        scope: 'openid',
      });
      for (const url of [
        `/auth/google/start?request_id=${generateToken()}`,
        `/auth/google/start?request_id=${consentCtx.requestId}`,
        '/auth/google/start',
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(400);
        expect(res.headers.location).toBeUndefined();
        expect(cookieOf(res, 'idp_fed')).toBeUndefined();
      }
    });

    it('context expired between start and callback => session but /authorize resume shows the expired page (no RP redirect)', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      await contexts.consume(requestId); // gone (TTL)
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-ctxgone` } });
      const cb = await callback('google', g, { idp_fed: s.fed! });
      expect(cb.statusCode).toBe(302);
      const resumed = await app.inject({
        method: 'GET',
        url: cb.headers.location as string,
        cookies: { [SESSION_COOKIE]: cookieOf(cb, SESSION_COOKIE)!.value },
      });
      expect(resumed.statusCode).toBe(400);
      expect(resumed.headers.location).toBeUndefined();
    });
  });

  describe('provider failures (F2, F14)', () => {
    it('error=access_denied => first-party page with a link back to /login, context still usable', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const state = s.location!.searchParams.get('state')!;
      const res = await callback('google', { state, error: 'access_denied' }, { idp_fed: s.fed! });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
      const back = `/login?returnTo=${encodeURIComponent(`/authorize?request_id=${encodeURIComponent(requestId)}`)}`;
      expect(res.body).toContain(`href="${back.replace(/&/g, '&amp;')}"`);
      expect(await contexts.peek(requestId)).not.toBeNull();
      expect(res.body).not.toContain(RP_STATE);
    });

    it('token endpoint 500 => 502, no session, no user', async () => {
      mock.tokenStatus = 500;
      const { requestId } = await rpAuthorize();
      const { res } = await socialLogin('google', requestId, { claims: { sub: `${RUN}-500` } });
      expect(res.statusCode).toBe(502);
      expectNoSession(res);
      expect(res.body).not.toContain('MOCK-UPSTREAM-DETAIL');
      expect(await userModel.countDocuments({ email: `${RUN}-500@example.com` })).toBe(0);
    });

    it('token endpoint timeout => 502, no session', async () => {
      mock.tokenDelayMs = 1500; // registry timeoutMs = 500
      const { requestId } = await rpAuthorize();
      const { res } = await socialLogin('google', requestId, { claims: { sub: `${RUN}-slow` } });
      expect(res.statusCode).toBe(502);
      expectNoSession(res);
    });

    it('GitHub token 200 with an error body => 502, no session', async () => {
      mock.ghTokenBody = { error: 'bad_verification_code' };
      const { requestId } = await rpAuthorize();
      const { res } = await socialLogin('github', requestId, { gh: { id: 1, emails: [] } });
      expect(res.statusCode).toBe(502);
      expectNoSession(res);
    });

    it('Google ID token with a wrong aud => 400 invalid, no session', async () => {
      const { requestId } = await rpAuthorize();
      const { res } = await socialLogin('google', requestId, {
        claims: { sub: `${RUN}-aud`, aud: 'someone-else' },
      });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
    });

    it('Google callback `iss` param from another issuer (RFC 9207) => 400', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-iss` } });
      const res = await callback(
        'google',
        { ...g, iss: 'https://evil.example' },
        { idp_fed: s.fed! },
      );
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
    });
  });

  describe('provisioning rules (F7, F14)', () => {
    it('admin-locked federated user => 403, no session, AUTH_LOGIN_FAILED reason=locked', async () => {
      const sub = `${RUN}-locked`;
      const first = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      const uid = (await sessions.get(cookieOf(first.res, SESSION_COOKIE)!.value))!.userId;
      await users.updateStatus(uid, { lockedUntil: ADMIN_LOCKED_UNTIL });
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      expect(res.statusCode).toBe(403);
      expectNoSession(res);
      expect(
        await auditModel.countDocuments({
          action: 'AUTH_LOGIN_FAILED',
          targetId: uid,
          reason: 'locked',
        }),
      ).toBe(1);
    });

    it('verified email already used by a local account => 409, 0 new User, 0 FI (no auto-link)', async () => {
      const email = `${RUN}-taken@example.com`;
      const local = await users.create({ email, password: 'some local password' });
      const sub = `${RUN}-taken`;
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub, email },
      });
      expect(res.statusCode).toBe(409);
      expectNoSession(res);
      expect(await userModel.countDocuments({ email })).toBe(1);
      expect(await fiModel.countDocuments({ providerId: sub })).toBe(0);
      expect(await fiModel.countDocuments({ userId: local.sub })).toBe(0);
      expect(
        await auditModel.countDocuments({
          action: 'AUTH_LOGIN_FAILED',
          reason: 'federated_email_conflict',
        }),
      ).toBeGreaterThanOrEqual(1);
    });

    it.each([
      ['primary but unverified', [{ email: 'x', primary: true, verified: false }]],
      ['verified but not primary', [{ email: 'y', primary: false, verified: true }]],
    ])('GitHub %s email => 400, nothing created', async (_n, raw) => {
      const id = 700_000 + Math.floor(Math.random() * 100_000);
      const emails = (raw as { email: string }[]).map((e) => ({
        ...e,
        email: `${RUN}-${e.email}-${id}@example.com`,
      }));
      const { res } = await socialLogin('github', (await rpAuthorize()).requestId, {
        gh: { id, emails },
      });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
      expect(await fiModel.countDocuments({ provider: 'github', providerId: String(id) })).toBe(0);
      expect(await userModel.countDocuments({ email: emails[0].email })).toBe(0);
    });

    it('Google email_verified=false => 400, nothing created', async () => {
      const sub = `${RUN}-unverified`;
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub, email_verified: false },
      });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
      expect(await fiModel.countDocuments({ providerId: sub })).toBe(0);
      expect(await userModel.countDocuments({ email: `${sub}@example.com` })).toBe(0);
    });

    /** Two callbacks of the same identity at once; returns both responses. */
    async function race(sub: string, emails: [string, string]) {
      const legs = await Promise.all(
        emails.map(async (email) => {
          const s = await start('google', (await rpAuthorize()).requestId);
          return { s, g: grant('google', s.location!, { claims: { sub, email } }) };
        }),
      );
      return Promise.all(legs.map(({ s, g }) => callback('google', g, { idp_fed: s.fed! })));
    }

    async function expectSingleAccount(sub: string, emails: string[], results: Res[]) {
      const fis = await fiModel.find({ provider: 'google', providerId: sub }).lean();
      expect(fis).toHaveLength(1);
      const winner = String(fis[0].userId);
      expect(await userModel.countDocuments({ email: { $in: emails } })).toBe(1);
      expect(String((await userModel.findOne({ email: { $in: emails } }).lean())!._id)).toBe(
        winner,
      );
      expect(await utModel.countDocuments({ userId: fis[0].userId })).toBe(1);
      for (const res of results) {
        if (res.statusCode === 302) {
          const live = await sessions.get(cookieOf(res, SESSION_COOKIE)!.value);
          expect(live?.userId).toBe(winner);
        } else {
          // Loser: "please retry" (503), or — while the winner's user exists but is not linked
          // yet — the safe email-conflict stop (409). Either way nothing is linked or created.
          expect([503, 409]).toContain(res.statusCode);
          expectNoSession(res);
        }
      }
      expect(results.some((r) => r.statusCode === 302)).toBe(true);
    }

    it('race: 2 parallel callbacks of the same identity x10 => exactly 1 User, 1 FI, 1 membership', async () => {
      for (let i = 0; i < 10; i++) {
        const sub = `${RUN}-race-${i}`;
        const email = `${sub}@example.com`;
        await expectSingleAccount(sub, [email], await race(sub, [email, email]));
      }
    }, 60_000);

    it('race with differing emails (FI E11000) x10 => loser user compensated, no orphan', async () => {
      for (let i = 0; i < 10; i++) {
        const sub = `${RUN}-race2-${i}`;
        const emails: [string, string] = [`${sub}-a@example.com`, `${sub}-b@example.com`];
        await expectSingleAccount(sub, emails, await race(sub, emails));
      }
    }, 60_000);
  });

  describe('re-authentication (F8)', () => {
    it('prompt=login: login page hides GitHub; GitHub start is refused', async () => {
      const { requestId, returnTo } = await rpAuthorize({ prompt: 'login' });
      const page = await loginPage(returnTo);
      expect(page.body).toContain('/auth/google/start');
      expect(page.body).not.toContain('/auth/github/start');
      const s = await start('github', requestId);
      expect(s.res.statusCode).toBe(400);
      expect(s.res.headers.location).toBeUndefined();
    });

    it('prompt=login + Google: max_age=0 sent; stale auth_time => refused; fresh => resume issues a code', async () => {
      const sub = `${RUN}-reauth`;
      const { requestId } = await rpAuthorize({ prompt: 'login' });
      const s = await start('google', requestId);
      expect(s.location!.searchParams.get('max_age')).toBe('0');
      const stale = grant('google', s.location!, {
        claims: { sub, auth_time: Math.floor(Date.now() / 1000) - 3600 },
      });
      const refused = await callback('google', stale, { idp_fed: s.fed! });
      expect(refused.statusCode).toBe(400);
      expectNoSession(refused);
      const missing = await start('google', requestId);
      const noAuthTime = grant('google', missing.location!, { claims: { sub } });
      expect((await callback('google', noAuthTime, { idp_fed: missing.fed! })).statusCode).toBe(
        400,
      );

      const s2 = await start('google', requestId);
      const fresh = grant('google', s2.location!, {
        claims: { sub, auth_time: Math.floor(Date.now() / 1000) },
      });
      const ok = await callback('google', fresh, { idp_fed: s2.fed! });
      expect(ok.statusCode).toBe(302);
      const rp = await resumeToRp(
        ok.headers.location as string,
        cookieOf(ok, SESSION_COOKIE)!.value,
      );
      expect(rp.searchParams.get('code')).toBeTruthy();
      expect(rp.searchParams.get('state')).toBe(RP_STATE);
    });
  });

  describe('enabled providers (F1, F11, F14)', () => {
    it('disabled provider => 404 on start and callback, and no button', async () => {
      registry.github.enabled = false;
      const { requestId, returnTo } = await rpAuthorize();
      const page = await loginPage(returnTo);
      expect(page.body).toContain('/auth/google/start');
      expect(page.body).not.toContain('/auth/github/start');
      expect((await start('github', requestId)).res.statusCode).toBe(404);
      expect((await callback('github', { state: 'x', code: 'y' })).statusCode).toBe(404);
      for (const name of ['mock', 'constructor', '__proto__']) {
        expect((await start(name, requestId)).res.statusCode).toBe(404);
      }
    });

    it('no buttons without a resumable context, or when every provider is disabled', async () => {
      const bare = await app.inject({ method: 'GET', url: '/login' });
      expect(bare.body).not.toContain('/auth/');
      const smuggled = await loginPage(`/authorize?request_id=abc&redirect_uri=x`);
      expect(smuggled.body).not.toContain('/auth/');
      registry.google.enabled = false;
      registry.github.enabled = false;
      const { returnTo } = await rpAuthorize();
      const page = await loginPage(returnTo);
      expect(page.body).not.toContain('/auth/');
      expect(page.headers['content-security-policy']).toBe(
        buildCsp({ formAction: ['https://rp.example.com'] }),
      );
    });
  });

  describe('exposure (F9)', () => {
    it('logs, audit and error pages never contain client secrets, provider codes or tokens', async () => {
      const logged: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
      }
      const bodies: string[] = [];
      const codes: string[] = [];
      // success + several failures
      const ok = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-expose` },
      });
      codes.push(ok.code);
      mock.tokenStatus = 500;
      const fail = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-expose2` },
      });
      codes.push(fail.code);
      bodies.push(fail.res.body);
      mock.tokenStatus = 200;
      const gh = await socialLogin('github', (await rpAuthorize()).requestId, {
        gh: { id: 31337, emails: [] },
      });
      codes.push(gh.code);
      bodies.push(gh.res.body);
      const bad = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-expose3`, nonce: 'wrong' },
      });
      codes.push(bad.code);
      bodies.push(bad.res.body);
      expect(logged.some((l) => l.includes('federation failed'))).toBe(true);

      const audit = JSON.stringify(await auditModel.find({}).lean());
      const haystacks = [...logged, audit, ...bodies];
      const secrets = [G_SECRET, GH_SECRET, G_ACCESS, ...mock.issuedSecrets, ...codes];
      expect(secrets.length).toBeGreaterThan(6);
      for (const secret of secrets) {
        for (const h of haystacks) expect(h.includes(secret)).toBe(false);
      }
    });
  });

  // ------------------------------------------------------------------ tester risk matrix (run 32)
  describe('tester risk matrix (run 32)', () => {
    const now = () => Math.floor(Date.now() / 1000);

    it('state: N concurrent callbacks with the same state+code => exactly 1 session (atomic consume)', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-conc-replay` } });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => callback('google', g, { idp_fed: s.fed! })),
      );
      expect(results.filter((r) => r.statusCode === 302)).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 302)) {
        expect(r.statusCode).toBe(400);
        expectNoSession(r);
      }
      expect(await fiModel.countDocuments({ providerId: `${RUN}-conc-replay` })).toBe(1);
    });

    it('state: duplicated `state` query params => 400, no session (arrays ignored)', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-dupstate` } });
      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?state=${g.state}&state=${g.state}&code=${g.code}`,
        cookies: { idp_fed: s.fed! },
      });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
    });

    it('state: idp_fed of ANOTHER browser that also has a live leg => 400 (binding is per state)', async () => {
      const a = await start('google', (await rpAuthorize()).requestId);
      const b = await start('google', (await rpAuthorize()).requestId);
      expect(b.fed).not.toBe(a.fed);
      const g = grant('google', a.location!, { claims: { sub: `${RUN}-othertab` } });
      const res = await callback('google', g, { idp_fed: b.fed! });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
      expect(await fiModel.countDocuments({ providerId: `${RUN}-othertab` })).toBe(0);
    });

    it('provider error + code together => denied page, no session; error with a replayed state => 400', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-errcode` } });
      const res = await callback('google', { ...g, error: 'access_denied' }, { idp_fed: s.fed! });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
      expect(res.body).toContain('/login?returnTo=');
      const again = await callback('google', { state: g.state, error: 'x' }, { idp_fed: s.fed! });
      expect(again.statusCode).toBe(400);
      expect(again.body).not.toContain('/login?returnTo=');
      expect(await fiModel.countDocuments({ providerId: `${RUN}-errcode` })).toBe(0);
    });

    it('provider 3xx on the token endpoint is never followed (redirect:error) => 502, no session', async () => {
      mock.raw = (path, res) => {
        if (path !== '/g/token') return false;
        res.writeHead(302, { location: '/g/token-evil' });
        res.end();
        return true;
      };
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-3xx` },
      });
      expect(res.statusCode).toBe(502);
      expectNoSession(res);
      expect(mock.hits).toContain('/g/token');
      expect(mock.hits).not.toContain('/g/token-evil');
    });

    it('GitHub API 3xx (/user) => 502, the redirect target is never contacted', async () => {
      mock.raw = (path, res) => {
        if (path !== '/gh/user') return false;
        res.writeHead(307, { location: '/gh/user-evil' });
        res.end();
        return true;
      };
      const id = 600_000 + Math.floor(Math.random() * 100_000);
      const { res } = await socialLogin('github', (await rpAuthorize()).requestId, {
        gh: { id, emails: [{ email: `${RUN}-gh3xx@example.com`, primary: true, verified: true }] },
      });
      expect(res.statusCode).toBe(502);
      expectNoSession(res);
      expect(mock.hits).toContain('/gh/user');
      expect(mock.hits).not.toContain('/gh/user-evil');
      expect(await fiModel.countDocuments({ provider: 'github', providerId: String(id) })).toBe(0);
    });

    it('oversized (8 MB) non-JSON token response => 502, no session, body not echoed', async () => {
      const junk = 'A'.repeat(8 * 1024 * 1024);
      mock.raw = (path, res) => {
        if (path !== '/g/token') return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(junk);
        return true;
      };
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-big` },
      });
      expect(res.statusCode).toBe(502);
      expectNoSession(res);
      expect(res.body).not.toContain('AAAAAAAA');
    });

    it('GitHub /user/emails returns an object (not an array) or [] => no account created', async () => {
      const id1 = 500_000 + Math.floor(Math.random() * 100_000);
      const r1 = await socialLogin('github', (await rpAuthorize()).requestId, {
        gh: { id: id1, emails: { email: `${RUN}-obj@example.com` } as unknown as unknown[] },
      });
      expect(r1.res.statusCode).toBe(502);
      expectNoSession(r1.res);
      const id2 = id1 + 1;
      const r2 = await socialLogin('github', (await rpAuthorize()).requestId, {
        gh: { id: id2, emails: [] },
      });
      expect(r2.res.statusCode).toBe(400);
      expectNoSession(r2.res);
      expect(
        await fiModel.countDocuments({
          provider: 'github',
          providerId: { $in: [String(id1), String(id2)] },
        }),
      ).toBe(0);
    });

    it('Google JWKS unavailable (non-timeout error) => fail-closed (no 302, no session, no user)', async () => {
      const original = registry.google.jwks;
      registry.google.jwks = (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof original;
      try {
        const sub = `${RUN}-jwksdown`;
        const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
          claims: { sub },
        });
        expect([400, 502]).toContain(res.statusCode);
        expectNoSession(res);
        expect(await userModel.countDocuments({ email: `${sub}@example.com` })).toBe(0);
      } finally {
        registry.google.jwks = original;
      }
    });

    it('Google ID token: attacker nonce / look-alike iss at the full callback => 400, nothing created', async () => {
      const cases: [string, Record<string, unknown>][] = [
        // `exp`/`iat` are not controllable here (the mock signer always sets them): unit spec covers.
        ['nonce', { nonce: 'attacker-nonce' }],
        ['iss', { iss: 'https://accounts.google.com.evil.example' }],
      ];
      for (const [label, claims] of cases) {
        const sub = `${RUN}-idt-${label}`;
        const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
          claims: { sub, ...claims },
        });
        expect(res.statusCode).toBe(400);
        expectNoSession(res);
        expect(await fiModel.countDocuments({ providerId: sub })).toBe(0);
      }
    });

    it('email conflict is case-insensitive and also applies to an UNVERIFIED local account (no link)', async () => {
      const lower = `${RUN}-case@example.com`;
      const local = await users.create({ email: lower, password: 'local password 123' });
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-case`, email: lower.toUpperCase() },
      });
      expect(res.statusCode).toBe(409);
      expectNoSession(res);
      expect(await fiModel.countDocuments({ userId: local.sub })).toBe(0);
      expect(await fiModel.countDocuments({ providerId: `${RUN}-case` })).toBe(0);
      expect(await userModel.countDocuments({ email: lower })).toBe(1);
      expect((await userModel.findOne({ email: lower }).lean())?.emailVerifiedAt).toBeUndefined();
    });

    it('cross-provider: same numeric id at Google and GitHub => two distinct accounts; GitHub with a Google-provisioned email => 409 (no auto-link)', async () => {
      const id = 400_000 + Math.floor(Math.random() * 100_000);
      const gEmail = `${RUN}-xp-g@example.com`;
      const g = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: String(id), email: gEmail },
      });
      expect(g.res.statusCode).toBe(302);
      const gh = await socialLogin('github', (await rpAuthorize()).requestId, {
        gh: { id, emails: [{ email: `${RUN}-xp-gh@example.com`, primary: true, verified: true }] },
      });
      expect(gh.res.statusCode).toBe(302);
      const gUser = (await sessions.get(cookieOf(g.res, SESSION_COOKIE)!.value))!.userId;
      const ghUser = (await sessions.get(cookieOf(gh.res, SESSION_COOKIE)!.value))!.userId;
      expect(ghUser).not.toBe(gUser);

      const conflict = await socialLogin('github', (await rpAuthorize()).requestId, {
        gh: { id: id + 1, emails: [{ email: gEmail, primary: true, verified: true }] },
      });
      expect(conflict.res.statusCode).toBe(409);
      expectNoSession(conflict.res);
      expect(await fiModel.countDocuments({ provider: 'github', providerId: String(id + 1) })).toBe(
        0,
      );
      const gDoc = await userModel.findOne({ email: gEmail }).lean();
      expect(await fiModel.countDocuments({ userId: gDoc!._id })).toBe(1);
    });

    it('FI whose user was deleted => 400, never silently re-provisioned', async () => {
      const sub = `${RUN}-orphanfi`;
      const first = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      expect(first.res.statusCode).toBe(302);
      await userModel.deleteOne({ email: `${sub}@example.com` });
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      expect(res.statusCode).toBe(400);
      expectNoSession(res);
      expect(await userModel.countDocuments({ email: `${sub}@example.com` })).toBe(0);
    });

    it('brute-force lock (lockedUntil in the near future) also blocks federated login', async () => {
      const sub = `${RUN}-bflock`;
      const first = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      const uid = (await sessions.get(cookieOf(first.res, SESSION_COOKIE)!.value))!.userId;
      await users.updateStatus(uid, { lockedUntil: new Date(Date.now() + 10 * 60_000) });
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      expect(res.statusCode).toBe(403);
      expectNoSession(res);
    });

    it('dependency failure: Redis state store throws => 500 first-party, no session, no redirect', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-redisdown` } });
      jest
        .spyOn(FederationStateStore.prototype, 'consume')
        .mockRejectedValueOnce(new Error('redis down'));
      const res = await callback('google', g, { idp_fed: s.fed! });
      expect(res.statusCode).toBe(500);
      expectNoSession(res);
      expect(res.body).not.toContain('redis down');
    });

    it('dependency failure: Mongo FI lookup throws => 500, no session, no user (not masked)', async () => {
      const sub = `${RUN}-mongodown`;
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      const g = grant('google', s.location!, { claims: { sub } });
      jest
        .spyOn(FederatedIdentityService.prototype, 'findByProvider')
        .mockRejectedValueOnce(new Error('mongo down'));
      const res = await callback('google', g, { idp_fed: s.fed! });
      expect(res.statusCode).toBe(500);
      expectNoSession(res);
      expect(res.body).not.toContain('mongo down');
      expect(await userModel.countDocuments({ email: `${sub}@example.com` })).toBe(0);
    });

    it('max_age=0 WITH a live IdP session => reauth leg: Google gets max_age=0 + stale auth_time refused, GitHub refused', async () => {
      const sub = `${RUN}-maxage-sess`;
      const first = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub },
      });
      const sid = cookieOf(first.res, SESSION_COOKIE)!.value;
      const { requestId } = await rpAuthorize({ max_age: '0' }, sid);
      const s = await start('google', requestId);
      expect(s.location!.searchParams.get('max_age')).toBe('0');
      const stale = grant('google', s.location!, { claims: { sub, auth_time: now() - 86400 } });
      const refused = await callback('google', stale, { idp_fed: s.fed! });
      expect(refused.statusCode).toBe(400);
      expectNoSession(refused);
      expect((await start('github', requestId)).res.statusCode).toBe(400);
    });

    it('DEBT-189 (known gap, accepted -> run 33): max_age WITHOUT an IdP session is not forwarded; a 30-day-old Google auth yields ID token auth_time = now', async () => {
      const sub = `${RUN}-debt189`;
      for (const maxAge of ['60', '0']) {
        const { requestId } = await rpAuthorize({ max_age: maxAge });
        const s = await start('google', requestId);
        // Gap: no max_age forwarded to Google and no auth_time requirement on the ID token.
        expect(s.location!.searchParams.get('max_age')).toBeNull();
        const old = grant('google', s.location!, {
          claims: { sub, auth_time: now() - 30 * 86400 },
        });
        const cb = await callback('google', old, { idp_fed: s.fed! });
        expect(cb.statusCode).toBe(302);
        const idToken = await exchange(
          await resumeToRp(cb.headers.location as string, cookieOf(cb, SESSION_COOKIE)!.value),
        );
        // The ID token claims a fresh authentication although the upstream one is 30 days old.
        expect(idToken.auth_time as number).toBeGreaterThanOrEqual(now() - 60);
        expect(idToken.amr).toEqual(['fed']);
      }
    });
  });
});
