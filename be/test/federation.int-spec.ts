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
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from 'jose';
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
import { MAILER, type MailMessage } from '../src/modules/mailer/mailer';
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

  const mails: MailMessage[] = [];

  // --- mock provider state ---
  const grants = new Map<string, Grant>();
  const ghTokens = new Map<string, NonNullable<Grant['gh']>>();
  const mock = {
    tokenStatus: 200,
    tokenDelayMs: 0,
    tokenPad: 0,
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
      return [
        200,
        {
          access_token: G_ACCESS,
          id_token: idToken,
          ...(mock.tokenPad ? { pad: 'p'.repeat(mock.tokenPad) } : {}),
        },
      ];
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
        { provide: MAILER, useValue: { send: async (m: MailMessage) => void mails.push(m) } },
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
      for (const p of [
        'authz_ctx:*',
        'authz_code:*',
        'fed_state:*',
        'fed_link:*',
        'sess_rp:*',
        'rl:*',
      ]) {
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
    mock.tokenPad = 0;
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

    it('verified email already used by a local account => 302 /auth/link (pending), 0 new User, 0 FI, no session (no auto-link)', async () => {
      const email = `${RUN}-taken@example.com`;
      const local = await users.create({ email, password: 'some local password' });
      const sub = `${RUN}-taken`;
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub, email },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/link');
      expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
      expect(await userModel.countDocuments({ email })).toBe(1);
      expect(await fiModel.countDocuments({ providerId: sub })).toBe(0);
      expect(await fiModel.countDocuments({ userId: local.sub })).toBe(0);
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
        if (res.statusCode === 302 && res.headers.location !== '/auth/link') {
          const live = await sessions.get(cookieOf(res, SESSION_COOKIE)!.value);
          expect(live?.userId).toBe(winner);
        } else {
          // Loser: "please retry" (503), or — while the winner's user exists but is not linked
          // yet — a pending link (302 /auth/link, B5.3). Either way nothing is linked or created.
          if (res.statusCode === 302) expect(res.headers.location).toBe('/auth/link');
          else expect(res.statusCode).toBe(503);
          expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
        }
      }
      expect(results.some((r) => cookieOf(r, SESSION_COOKIE) !== undefined)).toBe(true);
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

    // ---- run 33 T1 (DEBT-189, F1-F4): max_age without an IdP session
    const nowSec = () => Math.floor(Date.now() / 1000);

    it('max_age=60, no session: start sends max_age~60; auth_time=now-3600 => reauth_required page, no session', async () => {
      const { requestId } = await rpAuthorize({ max_age: '60' });
      const s = await start('google', requestId);
      const sent = Number(s.location!.searchParams.get('max_age'));
      expect(sent).toBeGreaterThanOrEqual(60);
      expect(sent).toBeLessThanOrEqual(62);
      const stale = grant('google', s.location!, {
        claims: { sub: `${RUN}-ma-stale`, auth_time: nowSec() - 3600 },
      });
      const res = await callback('google', stale, { idp_fed: s.fed! });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('requires a fresh sign-in');
      expectNoSession(res);
      expect(await fiModel.countDocuments({ providerId: `${RUN}-ma-stale` })).toBe(0);
    });

    it('max_age=60, no session: auth_time=now-10 => code; ID token auth_time = provider auth_time (not callback time)', async () => {
      const { requestId } = await rpAuthorize({ max_age: '60' });
      const s = await start('google', requestId);
      const authTime = nowSec() - 10;
      const g = grant('google', s.location!, {
        claims: { sub: `${RUN}-ma-fresh`, auth_time: authTime },
      });
      const cb = await callback('google', g, { idp_fed: s.fed! });
      expect(cb.statusCode).toBe(302);
      const sid = cookieOf(cb, SESSION_COOKIE)!.value;
      expect(Math.abs((await sessions.get(sid))!.authTime - authTime * 1000)).toBeLessThanOrEqual(
        1000,
      );
      const idToken = await exchange(await resumeToRp(cb.headers.location as string, sid));
      expect(Math.abs((idToken.auth_time as number) - authTime)).toBeLessThanOrEqual(1);
    });

    it('auth_time inside the 60s skew before reauthAfter => accepted and clamped up, so resume still issues a code (F3)', async () => {
      const { requestId } = await rpAuthorize({ max_age: '60' });
      const ctx = (await contexts.peek(requestId))!;
      const s = await start('google', requestId);
      // 30s older than the demand: within skew, so Google's answer is accepted...
      const authTime = Math.floor((ctx.reauthAfter! - 30_000) / 1000);
      const g = grant('google', s.location!, {
        claims: { sub: `${RUN}-ma-skew`, auth_time: authTime },
      });
      const cb = await callback('google', g, { idp_fed: s.fed! });
      expect(cb.statusCode).toBe(302);
      const sid = cookieOf(cb, SESSION_COOKIE)!.value;
      // ...and the session is clamped to reauthAfter, never earlier (else resume => login_required).
      expect((await sessions.get(sid))!.authTime).toBe(ctx.reauthAfter);
      const rp = await resumeToRp(cb.headers.location as string, sid);
      expect(rp.searchParams.get('code')).toBeTruthy();
      expect(rp.searchParams.get('error')).toBeNull();
    });

    it('a future auth_time is clamped down to now (never later than the callback)', async () => {
      const { requestId } = await rpAuthorize({ max_age: '60' });
      const s = await start('google', requestId);
      const g = grant('google', s.location!, {
        claims: { sub: `${RUN}-ma-future`, auth_time: nowSec() + 30 },
      });
      const before = Date.now();
      const cb = await callback('google', g, { idp_fed: s.fed! });
      expect(cb.statusCode).toBe(302);
      const live = (await sessions.get(cookieOf(cb, SESSION_COOKIE)!.value))!;
      expect(live.authTime).toBeLessThanOrEqual(Date.now());
      expect(live.authTime).toBeGreaterThanOrEqual(before);
    });

    it('max_age without session: GitHub hidden on the login page and its start => 400 reauth_required', async () => {
      const { requestId, returnTo } = await rpAuthorize({ max_age: '3600' });
      const page = await loginPage(returnTo);
      expect(page.body).toContain('/auth/google/start');
      expect(page.body).not.toContain('/auth/github/start');
      const s = await start('github', requestId);
      expect(s.res.statusCode).toBe(400);
      expect(s.res.body).toContain('requires a fresh sign-in');
      expect(s.res.headers.location).toBeUndefined();
    });

    it('no max_age / prompt: Google without auth_time still signs in (session authTime = now)', async () => {
      const { requestId } = await rpAuthorize();
      const s = await start('google', requestId);
      expect(s.location!.searchParams.has('max_age')).toBe(false);
      const before = Date.now();
      const g = grant('google', s.location!, { claims: { sub: `${RUN}-ma-none` } });
      const cb = await callback('google', g, { idp_fed: s.fed! });
      expect(cb.statusCode).toBe(302);
      expect(
        (await sessions.get(cookieOf(cb, SESSION_COOKIE)!.value))!.authTime,
      ).toBeGreaterThanOrEqual(before);
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

  // ------------------------------------------------------------------ run 33 T2 (B5.3, F5-F14)
  describe('account linking (B5.3, INV-22)', () => {
    const PASSWORD = 'local password 123';
    let seq = 0;

    /** A local account; `password: null` => federated-only (no passwordHash). */
    async function localUser(
      opts: { password?: string | null; verified?: boolean; lockedUntil?: Date } = {},
    ) {
      const email = `${RUN}-link-${++seq}@example.com`;
      const password = opts.password === undefined ? PASSWORD : opts.password;
      const user = await users.create(
        password === null ? { email, emailVerifiedAt: new Date() } : { email, password },
      );
      if (password !== null && opts.verified !== false) await users.verifyEmail(user.sub);
      await moduleRef.get(UserTenantService).addMembership(user.sub, DEFAULT_TENANT_ID);
      if (opts.lockedUntil) await users.updateStatus(user.sub, { lockedUntil: opts.lockedUntil });
      return { ...user, email };
    }

    /** RP -> Google leg with the local email -> pending link. */
    async function linkLeg(email: string, extra: Record<string, string> = {}) {
      const sub = `${RUN}-lk-${generateToken(6)}`;
      const { requestId } = await rpAuthorize(extra);
      const leg = await socialLogin('google', requestId, {
        claims: { sub, email, auth_time: Math.floor(Date.now() / 1000) },
      });
      expect(leg.res.statusCode).toBe(302);
      expect(leg.res.headers.location).toBe('/auth/link');
      expect(cookieOf(leg.res, SESSION_COOKIE)).toBeUndefined();
      const link = cookieOf(leg.res, 'idp_link')!;
      return { sub, requestId, fed: leg.fed, link: link.value, linkCookie: link, res: leg.res };
    }

    const linkPage = (cookies: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/auth/link', cookies });

    /** GET the page (for _csrf + idp_csrf), then POST the password. */
    async function submitLink(
      leg: { link: string; fed: string },
      password: string,
      over: { cookies?: Record<string, string>; payload?: Record<string, string> } = {},
    ) {
      const page = await linkPage({ idp_link: leg.link, idp_fed: leg.fed });
      expect(page.statusCode).toBe(200);
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      return app.inject({
        method: 'POST',
        url: '/auth/link',
        cookies: {
          idp_link: leg.link,
          idp_fed: leg.fed,
          idp_csrf: cookieOf(page, 'idp_csrf')!.value,
          ...over.cookies,
        },
        payload: { _csrf: csrf, password, ...over.payload },
      });
    }

    const linkedAudits = (userId: string) =>
      auditModel.countDocuments({ action: 'ACCOUNT_LINKED', targetId: userId });

    /** Nothing linked for this provider identity / account. */
    async function expectNotLinked(sub: string, userId: string) {
      expect(await fiModel.countDocuments({ providerId: sub })).toBe(0);
      expect(await fiModel.countDocuments({ userId })).toBe(0);
      expect(await linkedAudits(userId)).toBe(0);
    }

    const expectFailedPage = (res: Res) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('The account could not be linked. Please sign in again.');
      expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
      expect(res.headers.location).toBeUndefined();
    };

    it('(a) happy path: password of THAT account => FI, ACCOUNT_LINKED, resume => code => ID token sub = local user; next social login goes straight in', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      // F6: the token lives only in an HttpOnly cookie scoped to /auth/ — never in URL/HTML.
      expect(leg.linkCookie).toMatchObject({
        httpOnly: true,
        sameSite: 'Lax',
        path: '/auth/',
        maxAge: 600,
      });
      expect(leg.res.headers.location).not.toContain(leg.link);
      expect(await fiModel.countDocuments({ providerId: leg.sub })).toBe(0);

      const page = await linkPage({ idp_link: leg.link, idp_fed: leg.fed });
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['content-security-policy']).toBe(
        buildCsp({ formAction: ['https://rp.example.com'] }),
      );
      expect(page.body).toContain(local.email);
      expect(page.body).toContain('Google');
      expect(page.body).not.toContain(leg.link);
      expect(page.body).not.toContain(leg.sub);
      expect(page.body).not.toMatch(/name="email"/);
      expect(page.body).toContain(
        `href="${`/login?returnTo=${encodeURIComponent(`/authorize?request_id=${leg.requestId}`)}`}"`,
      );

      const res = await submitLink(leg, PASSWORD);
      expect(res.statusCode).toBe(302);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.location).toBe(
        `/authorize?request_id=${encodeURIComponent(leg.requestId)}`,
      );
      expect(cookieOf(res, 'idp_link')).toMatchObject({ value: '', path: '/auth/' });
      const sid = cookieOf(res, SESSION_COOKIE)!.value;
      const live = (await sessions.get(sid))!;
      expect(live.userId).toBe(local.sub);
      expect(live.amr).toEqual(['pwd']);

      const fi = await fiModel.findOne({ provider: 'google', providerId: leg.sub }).lean();
      expect(String(fi?.userId)).toBe(local.sub);
      expect(fi).toMatchObject({ email: local.email, emailVerified: true });
      const audit = await auditModel
        .findOne({ action: 'ACCOUNT_LINKED', targetId: local.sub })
        .lean();
      expect(audit).toMatchObject({
        actorType: 'user',
        actorId: local.sub,
        targetType: 'user',
        result: 'success',
        metadata: { provider: 'google' },
      });
      expect(JSON.stringify(audit)).not.toContain(leg.sub);
      expect(JSON.stringify(audit)).not.toContain(local.email);

      const idToken = await exchange(await resumeToRp(res.headers.location as string, sid));
      expect(idToken.sub).toBe(local.sub);
      expect(idToken.amr).toEqual(['pwd']);

      const again = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: leg.sub, email: local.email },
      });
      expect(again.res.statusCode).toBe(302);
      expect(again.res.headers.location).toMatch(/^\/authorize\?request_id=/);
      expect((await sessions.get(cookieOf(again.res, SESSION_COOKIE)!.value))!.userId).toBe(
        local.sub,
      );
    });

    it('(b) wrong password => generic page, no FI/audit/session; the pending link is burnt (the right password afterwards also fails)', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      const bad = await submitLink(leg, 'not the password');
      expectFailedPage(bad);
      expect(bad.body).toContain(
        `/login?returnTo=${encodeURIComponent(`/authorize?request_id=${leg.requestId}`)}`.replace(
          /&/g,
          '&amp;',
        ),
      );
      expect(await contexts.peek(leg.requestId)).not.toBeNull();
      expect((await linkPage({ idp_link: leg.link, idp_fed: leg.fed })).statusCode).toBe(400);
      expect((await users.findById(local.sub))?.failedLoginCount).toBe(1);
      await expectNotLinked(leg.sub, local.sub);
    });

    it.each([
      ['admin lock', () => ADMIN_LOCKED_UNTIL],
      ['brute-force lock', () => new Date(Date.now() + 10 * 60_000)],
    ])('(c) %s with the CORRECT password => generic page, not linked', async (_n, until) => {
      const local = await localUser({ lockedUntil: until() });
      const leg = await linkLeg(local.email);
      expectFailedPage(await submitLink(leg, PASSWORD));
      await expectNotLinked(leg.sub, local.sub);
    });

    it('(d) federated-only account (no password) => generic page, not linked', async () => {
      const local = await localUser({ password: null });
      const leg = await linkLeg(local.email);
      expectFailedPage(await submitLink(leg, PASSWORD));
      await expectNotLinked(leg.sub, local.sub);
    });

    it('(e) unverified local account (pre-hijack) with the CORRECT password => generic page, never linked', async () => {
      const local = await localUser({ verified: false });
      const leg = await linkLeg(local.email);
      expectFailedPage(await submitLink(leg, PASSWORD));
      await expectNotLinked(leg.sub, local.sub);
    });

    it('F11: link page and failure page are byte-identical for password / federated-only / locked / unverified targets', async () => {
      const targets = [
        await localUser(),
        await localUser({ password: null }),
        await localUser({ lockedUntil: ADMIN_LOCKED_UNTIL }),
        await localUser({ verified: false }),
      ];
      const pages: string[] = [];
      const fails: string[] = [];
      const statuses = new Set<number>();
      for (const t of targets) {
        const leg = await linkLeg(t.email);
        const norm = (body: string) =>
          body
            .replace(/name="_csrf" value="[^"]+"/, '')
            .split(t.email)
            .join('<email>')
            .split(encodeURIComponent(leg.requestId))
            .join('<rid>')
            .split(leg.requestId)
            .join('<rid>');
        const page = await linkPage({ idp_link: leg.link, idp_fed: leg.fed });
        pages.push(norm(page.body));
        const res = await submitLink(leg, 'an attacker guess 1');
        statuses.add(res.statusCode);
        fails.push(norm(res.body));
        await expectNotLinked(leg.sub, t.sub);
      }
      expect(new Set(pages).size).toBe(1);
      expect(new Set(fails).size).toBe(1);
      expect([...statuses]).toEqual([400]);
    });

    it('(f) replay of POST /auth/link after success => generic page, still exactly 1 FI and 1 audit', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      expect((await submitLink(leg, PASSWORD)).statusCode).toBe(302);
      const page = await linkPage({ idp_link: leg.link, idp_fed: leg.fed });
      expect(page.statusCode).toBe(400);
      const replay = await app.inject({
        method: 'POST',
        url: '/auth/link',
        cookies: { idp_link: leg.link, idp_fed: leg.fed, idp_csrf: 'x' },
        payload: { _csrf: (await moduleRef.get(CsrfService)).token('x'), password: PASSWORD },
      });
      expectFailedPage(replay);
      expect(await fiModel.countDocuments({ userId: local.sub })).toBe(1);
      expect(await linkedAudits(local.sub)).toBe(1);
    });

    it('(g) foreign or missing idp_fed => GET 400; POST generic page and the pending link is consumed', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      expect((await linkPage({ idp_link: leg.link, idp_fed: generateToken() })).statusCode).toBe(
        400,
      );
      expect((await linkPage({ idp_link: leg.link })).statusCode).toBe(400);
      const foreign = await submitLink(leg, PASSWORD, { cookies: { idp_fed: generateToken() } });
      expectFailedPage(foreign);
      expect(await redis.exists(`fed_link:${sha256(leg.link)}`)).toBe(0);
      expect((await linkPage({ idp_link: leg.link, idp_fed: leg.fed })).statusCode).toBe(400);
      await expectNotLinked(leg.sub, local.sub);

      const leg2 = await linkLeg(local.email);
      const page = await linkPage({ idp_link: leg2.link, idp_fed: leg2.fed });
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      const missing = await app.inject({
        method: 'POST',
        url: '/auth/link',
        cookies: { idp_link: leg2.link, idp_csrf: cookieOf(page, 'idp_csrf')!.value },
        payload: { _csrf: csrf, password: PASSWORD },
      });
      expectFailedPage(missing);
      await expectNotLinked(leg2.sub, local.sub);
    });

    it('(h) missing or wrong _csrf => 403, nothing consumed or linked', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      for (const payload of [{ password: PASSWORD }, { password: PASSWORD, _csrf: 'forged' }]) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/link',
          cookies: { idp_link: leg.link, idp_fed: leg.fed, idp_csrf: generateToken() },
          payload,
        });
        expect(res.statusCode).toBe(403);
        expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
      }
      await expectNotLinked(leg.sub, local.sub);
      expect(await redis.exists(`fed_link:${sha256(leg.link)}`)).toBe(1);
    });

    it('(i) expired pending link => GET 400 and POST generic page, not linked', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      const page = await linkPage({ idp_link: leg.link, idp_fed: leg.fed });
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      expect(await redis.del(`fed_link:${sha256(leg.link)}`)).toBe(1); // TTL elapsed
      expect((await linkPage({ idp_link: leg.link, idp_fed: leg.fed })).statusCode).toBe(400);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/link',
        cookies: {
          idp_link: leg.link,
          idp_fed: leg.fed,
          idp_csrf: cookieOf(page, 'idp_csrf')!.value,
        },
        payload: { _csrf: csrf, password: PASSWORD },
      });
      expectFailedPage(res);
      await expectNotLinked(leg.sub, local.sub);
    });

    it('(j) email changed between callback and POST => not linked (old email no longer signs in; a new owner of it is a different user)', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      await users.changeEmail(local.sub, `${RUN}-moved-${seq}@example.com`);
      expectFailedPage(await submitLink(leg, PASSWORD));
      await expectNotLinked(leg.sub, local.sub);

      // The email now belongs to someone else who knows their own password: signed in as THEM,
      // but the identity is never attached to either account (user mismatch).
      const victim = await localUser();
      const leg2 = await linkLeg(victim.email);
      await users.changeEmail(victim.sub, `${RUN}-moved2-${seq}@example.com`);
      const other = await users.create({ email: victim.email, password: 'other password 456' });
      await users.verifyEmail(other.sub);
      const res = await submitLink(leg2, 'other password 456');
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('could not be linked');
      expect((await sessions.get(cookieOf(res, SESSION_COOKIE)!.value))!.userId).toBe(other.sub);
      await expectNotLinked(leg2.sub, victim.sub);
      await expectNotLinked(leg2.sub, other.sub);
    });

    it('(k) provider email NOT verified + email of a local account => email_unverified, no pending link', async () => {
      const local = await localUser();
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-lk-unv`, email: local.email, email_verified: false },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('verified email address is required');
      expect(cookieOf(res, 'idp_link')).toBeUndefined();
      expectNoSession(res);
      await expectNotLinked(`${RUN}-lk-unv`, local.sub);
    });

    it('(l) prompt=login context: linking with the password satisfies the re-auth demand => code', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email, { prompt: 'login' });
      const res = await submitLink(leg, PASSWORD);
      expect(res.statusCode).toBe(302);
      const rp = await resumeToRp(
        res.headers.location as string,
        cookieOf(res, SESSION_COOKIE)!.value,
      );
      expect(rp.searchParams.get('code')).toBeTruthy();
      expect(rp.searchParams.get('error')).toBeNull();
    });

    it('(m) two parallel POSTs of the same pending link => exactly one links', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      const page = await linkPage({ idp_link: leg.link, idp_fed: leg.fed });
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      const post = () =>
        app.inject({
          method: 'POST',
          url: '/auth/link',
          cookies: {
            idp_link: leg.link,
            idp_fed: leg.fed,
            idp_csrf: cookieOf(page, 'idp_csrf')!.value,
          },
          payload: { _csrf: csrf, password: PASSWORD },
        });
      const results = await Promise.all([post(), post(), post()]);
      expect(results.filter((r) => r.statusCode === 302)).toHaveLength(1);
      expect(await fiModel.countDocuments({ userId: local.sub })).toBe(1);
      expect(await linkedAudits(local.sub)).toBe(1);
    });

    it('the email is never taken from the form: an extra `email` field is rejected, nothing linked', async () => {
      const victim = await localUser();
      const attacker = await localUser();
      const leg = await linkLeg(victim.email);
      const res = await submitLink(leg, PASSWORD, { payload: { email: attacker.email } });
      expect(res.statusCode).toBe(400);
      expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
      await expectNotLinked(leg.sub, victim.sub);
      await expectNotLinked(leg.sub, attacker.sub);
    });

    it('Redis failure creating the pending link => 500 first-party, no cookie, nothing linked (fail-closed)', async () => {
      const local = await localUser();
      jest
        .spyOn(FederationStateStore.prototype, 'createLink')
        .mockRejectedValueOnce(new Error('redis down'));
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-lk-redis`, email: local.email },
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('redis down');
      expect(cookieOf(res, 'idp_link')).toBeUndefined();
      expectNoSession(res);
      await expectNotLinked(`${RUN}-lk-redis`, local.sub);
    });

    it('F12: link failures log fixed codes only (no email, providerId, token)', async () => {
      const logged: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
        });
      }
      const local = await localUser();
      const leg = await linkLeg(local.email);
      expectFailedPage(await submitLink(leg, 'not the password'));
      expect(logged.some((l) => l.includes('federation link failed: credentials'))).toBe(true);
      for (const secret of [local.email, leg.sub, leg.link, leg.fed]) {
        for (const l of logged) expect(l.includes(secret)).toBe(false);
      }
    });

    // ---- tester (run 33): risk-matrix additions (abuse linking, max_age local + federation)
    const nowS = () => Math.floor(Date.now() / 1000);

    it('T33-1 max_age=60 context: linking with the password satisfies max_age => code; ID token auth_time = link time', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email, { max_age: '60' });
      const before = nowS();
      const res = await submitLink(leg, PASSWORD);
      expect(res.statusCode).toBe(302);
      const sid = cookieOf(res, SESSION_COOKIE)!.value;
      const rp = await resumeToRp(res.headers.location as string, sid);
      expect(rp.searchParams.get('error')).toBeNull();
      const idToken = await exchange(rp);
      expect(idToken.sub).toBe(local.sub);
      expect(idToken.auth_time as number).toBeGreaterThanOrEqual(before - 1);
    });

    it('T33-2 local login (no federation): max_age=60 without session => code; a session older than max_age cannot resume (login_required, no code)', async () => {
      const local = await localUser();
      const { returnTo } = await rpAuthorize({ max_age: '60' });
      const page = await loginPage(returnTo);
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      const before = nowS();
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        cookies: { idp_csrf: cookieOf(page, 'idp_csrf')!.value },
        payload: { _csrf: csrf, email: local.email, password: PASSWORD, returnTo },
      });
      expect(res.statusCode).toBe(302);
      const sid = cookieOf(res, SESSION_COOKIE)!.value;
      const rp = await resumeToRp(res.headers.location as string, sid);
      expect(rp.searchParams.get('error')).toBeNull();
      const idToken = await exchange(rp);
      expect(idToken.sub).toBe(local.sub);
      expect(idToken.auth_time as number).toBeGreaterThanOrEqual(before - 1);

      // A session authenticated 1 h ago: /authorize?max_age=60 sends it to /login...
      const stale = await sessions.create(local.sub, DEFAULT_TENANT_ID, {
        amr: ['pwd'],
        authTime: Date.now() - 3_600_000,
      });
      const { requestId } = await rpAuthorize({ max_age: '60' }, stale.id);
      // ...and replaying the context with that stale session is refused to the RP (no code).
      const direct = await app.inject({
        method: 'GET',
        url: `/authorize?request_id=${encodeURIComponent(requestId)}`,
        cookies: { [SESSION_COOKIE]: stale.id },
      });
      expect(direct.statusCode).toBe(302);
      const loc = new URL(direct.headers.location as string);
      expect(loc.searchParams.get('error')).toBe('login_required');
      expect(loc.searchParams.get('code')).toBeNull();
    });

    it('T33-3 POST /auth/link shares the REAL `login` account bucket with /login (pending email): exhausted => 429 on both, the pending link is NOT consumed', async () => {
      const local = await localUser();
      const leg = await linkLeg(local.email);
      const key = `rl:login:account:${sha256(local.email.trim().toLowerCase())}`;
      await redis.set(key, '999999', 'PX', 60_000);
      try {
        const blocked = await submitLink(leg, PASSWORD);
        expect(blocked.statusCode).toBe(429);
        expect(cookieOf(blocked, SESSION_COOKIE)).toBeUndefined();
        // Same bucket as the password form: /login for that email is throttled too.
        const { returnTo } = await rpAuthorize();
        const page = await loginPage(returnTo);
        const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
        const viaLogin = await app.inject({
          method: 'POST',
          url: '/login',
          cookies: { idp_csrf: cookieOf(page, 'idp_csrf')!.value },
          payload: { _csrf: csrf, email: local.email, password: PASSWORD, returnTo },
        });
        expect(viaLogin.statusCode).toBe(429);
        await expectNotLinked(leg.sub, local.sub);
        expect((await users.findById(local.sub))?.failedLoginCount ?? 0).toBe(0);
      } finally {
        await redis.del(key);
      }
      // 429 happened before consume: the same pending link still completes afterwards.
      expect((await submitLink(leg, PASSWORD)).statusCode).toBe(302);
      expect(await fiModel.countDocuments({ providerId: leg.sub, userId: local.sub })).toBe(1);
    });

    it('T33-4 one provider identity, two pending links (email changed at the provider): first completed wins; the second => signed in but NOT linked, 1 FI, no audit', async () => {
      const a = await localUser();
      const b = await localUser();
      const sub = `${RUN}-dup-${generateToken(6)}`;
      const legFor = async (email: string) => {
        const { requestId } = await rpAuthorize();
        const l = await socialLogin('google', requestId, {
          claims: { sub, email, auth_time: nowS() },
        });
        expect(l.res.headers.location).toBe('/auth/link');
        return { link: cookieOf(l.res, 'idp_link')!.value, fed: l.fed };
      };
      const legA = await legFor(a.email);
      const legB = await legFor(b.email);
      expect((await submitLink(legB, PASSWORD)).statusCode).toBe(302);
      const res = await submitLink(legA, PASSWORD);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('You are signed in, but the account could not be linked.');
      expect((await sessions.get(cookieOf(res, SESSION_COOKIE)!.value))!.userId).toBe(a.sub);
      expect(await fiModel.countDocuments({ providerId: sub })).toBe(1);
      expect(String((await fiModel.findOne({ providerId: sub }).lean())?.userId)).toBe(b.sub);
      expect(await linkedAudits(a.sub)).toBe(0);
      expect(await linkedAudits(b.sub)).toBe(1);
    });

    it('T33-5 a session already in the browser (another user, e.g. planted) is rotated away; the new session belongs to the link target', async () => {
      const other = await localUser();
      const target = await localUser();
      const planted = await sessions.create(other.sub, DEFAULT_TENANT_ID, { amr: ['pwd'] });
      const leg = await linkLeg(target.email);
      const cookies = { idp_link: leg.link, idp_fed: leg.fed, [SESSION_COOKIE]: planted.id };
      const page = await linkPage(cookies);
      expect(page.statusCode).toBe(200);
      const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)![1];
      const res = await app.inject({
        method: 'POST',
        url: '/auth/link',
        cookies: {
          ...cookies,
          ...(cookieOf(page, 'idp_csrf') ? { idp_csrf: cookieOf(page, 'idp_csrf')!.value } : {}),
        },
        payload: { _csrf: csrf, password: PASSWORD },
      });
      expect(res.statusCode).toBe(302);
      const sid = cookieOf(res, SESSION_COOKIE)!.value;
      expect(sid).not.toBe(planted.id);
      expect(await sessions.get(planted.id)).toBeNull();
      expect((await sessions.get(sid))!.userId).toBe(target.sub);
      expect(await fiModel.countDocuments({ providerId: leg.sub, userId: target.sub })).toBe(1);
      expect(await fiModel.countDocuments({ userId: other.sub })).toBe(0);
    });

    it('DEBT-186 (F10): a federated-only user sets a password via /forgot => password login works + AUTH_PASSWORD_RESET audited', async () => {
      const local = await localUser({ password: null });
      mails.length = 0;
      await moduleRef.get(AuthenticationService).forgotPassword(local.email);
      const token = mails[0]?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
      expect(token).toBeTruthy();
      await moduleRef.get(AuthenticationService).resetPassword(token!, 'brand new password 1');
      const established = await moduleRef
        .get(AuthenticationService)
        .login(local.email, 'brand new password 1', {});
      expect(established.session.userId).toBe(local.sub);
      expect(
        await auditModel.countDocuments({
          action: 'AUTH_PASSWORD_RESET',
          actorId: local.sub,
          result: 'success',
        }),
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------------ run 33 T4' (DEBT-190a, DEBT-191)
  describe('provisioning compensation + provider fetch limits (F15, F16)', () => {
    it.each(['deleteById', 'deleteMembership'] as const)(
      'F15: %s failing during compensation never masks the original error; both undo steps run',
      async (method) => {
        const sub = `${RUN}-comp-${method}`;
        const s = await start('google', (await rpAuthorize()).requestId);
        const g = grant('google', s.location!, { claims: { sub } });
        jest
          .spyOn(FederatedIdentityService.prototype, 'link')
          .mockRejectedValueOnce(new Error('ORIGINAL-link-failure'));
        const delUser = jest.spyOn(UserService.prototype, 'deleteById');
        const delMember = jest.spyOn(UserTenantService.prototype, 'deleteMembership');
        const failing = new Error('COMPENSATION-failure');
        if (method === 'deleteById') delUser.mockRejectedValueOnce(failing);
        else delMember.mockRejectedValueOnce(failing);
        await expect(
          moduleRef.get(FederationService).callback('google', g, { binding: s.fed }, {}),
        ).rejects.toThrow('ORIGINAL-link-failure');
        expect(delUser).toHaveBeenCalledTimes(1);
        expect(delMember).toHaveBeenCalledTimes(1);
        expect(await fiModel.countDocuments({ providerId: sub })).toBe(0);
        // The step that did NOT fail really ran.
        const user = await userModel.findOne({ email: `${sub}@example.com` }).lean();
        if (method === 'deleteById') {
          expect(await utModel.countDocuments({ userId: user!._id })).toBe(0);
        } else {
          expect(user).toBeNull();
        }
      },
    );

    it('F16: an 8 MB streamed token body => 502 and the IdP stops reading early (socket closed)', async () => {
      let written = 0;
      let closed = false;
      mock.raw = (path, res) => {
        if (path !== '/g/token') return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.on('close', () => (closed = true));
        const chunk = Buffer.alloc(64 * 1024, 0x41);
        void (async () => {
          res.write('{"x":"');
          for (let i = 0; i < 128 && !closed; i++) {
            written += chunk.length;
            if (!res.write(chunk)) {
              await new Promise((r) => {
                res.once('drain', r);
                res.once('close', r);
              });
            }
          }
          if (!closed) res.end('"}');
        })();
        return true;
      };
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-cap` },
      });
      expect(res.statusCode).toBe(502);
      expectNoSession(res);
      for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 20));
      expect(closed).toBe(true);
      expect(written).toBeLessThan(8 * 1024 * 1024);
    });

    it('F16: a valid token response just under 64 KB still signs in', async () => {
      mock.tokenPad = 60 * 1024;
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-undercap` },
      });
      expect(res.statusCode).toBe(302);
    });

    it('F16: remote JWKS refusing connections (ECONNREFUSED) => 502, no session, no user', async () => {
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
      const port = (probe.address() as AddressInfo).port;
      await new Promise((r) => probe.close(r));
      const original = registry.google.jwks;
      registry.google.jwks = createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/certs`), {
        timeoutDuration: 500,
      });
      try {
        const sub = `${RUN}-jwks-refused`;
        const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
          claims: { sub },
        });
        expect(res.statusCode).toBe(502);
        expectNoSession(res);
        expect(await userModel.countDocuments({ email: `${sub}@example.com` })).toBe(0);
      } finally {
        registry.google.jwks = original;
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

    it('Google JWKS unavailable (non-timeout network error) => 502 fail-closed (no session, no user) (DEBT-191)', async () => {
      const original = registry.google.jwks;
      registry.google.jwks = (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof original;
      try {
        const sub = `${RUN}-jwksdown`;
        const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
          claims: { sub },
        });
        expect(res.statusCode).toBe(502);
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

    it('email match is case-insensitive and also applies to an UNVERIFIED local account (pending link only, no FI)', async () => {
      const lower = `${RUN}-case@example.com`;
      const local = await users.create({ email: lower, password: 'local password 123' });
      const { res } = await socialLogin('google', (await rpAuthorize()).requestId, {
        claims: { sub: `${RUN}-case`, email: lower.toUpperCase() },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/link');
      expect(cookieOf(res, SESSION_COOKIE)).toBeUndefined();
      expect(await fiModel.countDocuments({ userId: local.sub })).toBe(0);
      expect(await fiModel.countDocuments({ providerId: `${RUN}-case` })).toBe(0);
      expect(await userModel.countDocuments({ email: lower })).toBe(1);
      expect((await userModel.findOne({ email: lower }).lean())?.emailVerifiedAt).toBeUndefined();
    });

    it('cross-provider: same numeric id at Google and GitHub => two distinct accounts; GitHub with a Google-provisioned email => pending link, no FI (no auto-link)', async () => {
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
      expect(conflict.res.statusCode).toBe(302);
      expect(conflict.res.headers.location).toBe('/auth/link');
      expect(cookieOf(conflict.res, SESSION_COOKIE)).toBeUndefined();
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

    it('DEBT-189 closed (run 33): max_age WITHOUT an IdP session is forwarded; a 30-day-old Google auth is refused', async () => {
      const sub = `${RUN}-debt189`;
      for (const maxAge of ['60', '0']) {
        const { requestId } = await rpAuthorize({ max_age: maxAge });
        const s = await start('google', requestId);
        expect(s.location!.searchParams.get('max_age')).not.toBeNull();
        const old = grant('google', s.location!, {
          claims: { sub, auth_time: now() - 30 * 86400 },
        });
        const cb = await callback('google', old, { idp_fed: s.fed! });
        expect(cb.statusCode).toBe(400);
        expectNoSession(cb);
      }
    });
  });
});
