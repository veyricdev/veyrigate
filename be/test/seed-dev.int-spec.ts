import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import mongoose, { type Connection, type Model } from 'mongoose';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { jest } from '@jest/globals';
import {
  seedDev,
  seedDevUser,
  readDevSeedUserConfig,
  buildSeedDevTargets,
  assertNotProduction,
  type DevSeedUserConfig,
} from '../src/database/seed-dev';
import { AuthenticationService } from '../src/modules/authentication/authentication.service';
import { UserService, normalizeEmail } from '../src/modules/identity/user.service';
import { UserTenantService } from '../src/modules/identity/user-tenant.service';
import { MAILER } from '../src/modules/mailer/mailer';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { UserinfoController } from '../src/modules/oauth/userinfo/userinfo.controller';
import { IntrospectController } from '../src/modules/oauth/introspect/introspect.controller';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { deriveS256Challenge } from '../src/common/crypto/pkce.util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Types } from 'mongoose';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { registerCorsPreflight } from '../src/modules/clients/client-cors.helper';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { DemoController } from '../src/modules/demo/demo.controller';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { SessionService } from '../src/modules/sessions/session.service';
import { SessionCookie, SESSION_COOKIE } from '../src/modules/sessions/session.cookie';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { sha256 } from '../src/common/crypto/crypto.util';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-seed-dev-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

const ISSUER = 'http://localhost:4000';
const RESOURCE_URI = 'http://localhost:4000/demo/'; // = VITE_OIDC_RESOURCE in fe-sso-test/.env.example
const OTHER_RESOURCE_URI = 'http://localhost:4000/other/'; // second resource (Q-24.1), INV-8 probe
// fe-sso-test/.env.example requests exactly these scopes (incl. offline_access for refresh).
const FE_SCOPE = 'openid profile email offline_access';
const SPA_ORIGIN = 'http://localhost:5173'; // the one origin the seeded client registers for CORS.
const VALID_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // 43-char base64url PKCE S256.

function config(nodeEnv: string): ConfigService {
  const base: Record<string, unknown> = {
    app: { nodeEnv, issuer: ISSUER },
  };
  return { getOrThrow: (ns: string) => base[ns] } as unknown as ConfigService;
}

describe('seed-dev (Task 4, B6.4 interim) on real Mongo', () => {
  let connection: Connection;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let clients: ClientService;
  let resources: ResourceService;

  beforeAll(async () => {
    connection = await mongoose.createConnection(MONGO_URI, { autoIndex: false }).asPromise();
    for (const { name, schema } of MODELS) connection.model(name, schema);
    await syncAllIndexes(connection);
    clientModel = connection.model<Client>('Client');
    resourceModel = connection.model<Resource>('Resource');
    // `allowHttpLocalhost` must be on so the http://localhost:5173 redirect URIs pass format checks.
    clients = new ClientService(clientModel, config('development'));
    resources = new ResourceService(resourceModel);
  }, 30_000);

  afterEach(async () => {
    await clientModel.deleteMany({}).exec();
    await resourceModel.deleteMany({}).exec();
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
  });

  it('seeds exactly one public client + the demo AND other resources with the fe-sso-test config', async () => {
    await seedDev(connection, ISSUER, 'development');

    const clientDocs = await clientModel.find({ clientId: 'fe-sso-test' }).lean().exec();
    expect(clientDocs).toHaveLength(1);
    const client = await clients.findByClientId('fe-sso-test');
    expect(client).toMatchObject({
      clientId: 'fe-sso-test',
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      redirectUris: ['http://localhost:5173/callback'],
      postLogoutRedirectUris: ['http://localhost:5173/'],
      allowedCorsOrigins: ['http://localhost:5173'],
      allowedResources: ['demo', 'other'],
      tenantId: DEFAULT_TENANT_ID,
    });

    // Exactly two resources (`demo` + `other`, Q-24.1), each with the issuer-derived identifier.
    const resourceDocs = await resourceModel.find({}).lean().exec();
    expect(resourceDocs).toHaveLength(2);
    const demo = await resources.findByIdentifier(RESOURCE_URI);
    expect(demo).toMatchObject({ resourceId: 'demo', identifier: RESOURCE_URI });
    const other = await resources.findByIdentifier(OTHER_RESOURCE_URI);
    expect(other).toMatchObject({ resourceId: 'other', identifier: OTHER_RESOURCE_URI });
  });

  it('no ClientCredential is created (public client has no secret)', async () => {
    await seedDev(connection, ISSUER, 'development');
    const creds = await connection.model('ClientCredential').countDocuments({}).exec();
    expect(creds).toBe(0);
  });

  it('is idempotent: running twice yields exactly one client + two resources (no duplicates)', async () => {
    await seedDev(connection, ISSUER, 'development');
    await seedDev(connection, ISSUER, 'development');

    expect(await clientModel.countDocuments({ clientId: 'fe-sso-test' }).exec()).toBe(1);
    expect(await resourceModel.countDocuments({ resourceId: 'demo' }).exec()).toBe(1);
    expect(await resourceModel.countDocuments({ resourceId: 'other' }).exec()).toBe(1);
    expect(await resourceModel.countDocuments({ identifier: RESOURCE_URI }).exec()).toBe(1);
    expect(await resourceModel.countDocuments({}).exec()).toBe(2);
  });

  it('re-seeding after ISSUER changes updates the demo + other resources in place (no extra documents)', async () => {
    await seedDev(connection, ISSUER, 'development');
    // Same control-plane, different issuer: `identifier` is derived from the issuer, so keying the
    // upsert by `identifier` (the old bug) would insert a SECOND document per resource here.
    const otherIssuer = 'http://localhost:5000';
    const demoUri = 'http://localhost:5000/demo/';
    const otherUri = 'http://localhost:5000/other/';
    await seedDev(connection, otherIssuer, 'development');

    expect(await resourceModel.countDocuments({ resourceId: 'demo' }).exec()).toBe(1);
    expect(await resourceModel.countDocuments({ resourceId: 'other' }).exec()).toBe(1);
    const docs = await resourceModel.find({}).lean().exec();
    expect(docs).toHaveLength(2);
    // Each document now carries the NEW issuer's identifier (updated in place).
    expect(docs.find((d) => d.resourceId === 'demo')!.identifier).toBe(demoUri);
    expect(docs.find((d) => d.resourceId === 'other')!.identifier).toBe(otherUri);
  });

  it('NODE_ENV=production is refused by seedDev itself (fail-closed) and writes NOTHING to the DB', async () => {
    // The guard must live inside seedDev (not only in the CLI's main()), so actually CALL seedDev
    // with production and assert it rejects. Counting AFTER a real call is the only way to prove
    // "0 writes": if the guard regresses, seedDev would upsert a public client with a
    // localhost redirect/CORS into the control plane before any later check could catch it.
    await expect(seedDev(connection, ISSUER, 'production')).rejects.toThrow(/production/);
    expect(await clientModel.countDocuments({}).exec()).toBe(0);
    expect(await resourceModel.countDocuments({}).exec()).toBe(0);

    // Non-production environments are still allowed (and the direct guard stays consistent).
    expect(() => assertNotProduction('production')).toThrow(/production/);
    expect(() => assertNotProduction('development')).not.toThrow();
    expect(() => assertNotProduction('test')).not.toThrow();
  });

  it('buildSeedDevTargets derives the resource identifier from the issuer without a double slash', () => {
    const demoOf = (issuer: string): string =>
      buildSeedDevTargets(issuer).resources.find((r) => r.resourceId === 'demo')!.identifier;
    expect(demoOf('http://localhost:4000')).toBe(RESOURCE_URI);
    expect(demoOf('http://localhost:4000/')).toBe(RESOURCE_URI);
    // The `other` resource (Q-24.1) is derived the same way and is included in the client allowlist.
    const otherOf = (issuer: string): string =>
      buildSeedDevTargets(issuer).resources.find((r) => r.resourceId === 'other')!.identifier;
    expect(otherOf('http://localhost:4000')).toBe(OTHER_RESOURCE_URI);
    expect(buildSeedDevTargets('http://localhost:4000').client.allowedResources).toEqual([
      'demo',
      'other',
    ]);
  });
});

/**
 * F9 acceptance: after `seedDev`, the seeded `fe-sso-test` client must actually work end-to-end
 * against the REAL endpoints, not a test re-implementation of the rules. We drive the real
 * `@Get('/authorize')` route and the real shared CORS preflight hook (`registerCorsPreflight`,
 * the exact wiring `main.ts` installs), so a controller/service rule change cannot pass here
 * while the seeded config is actually wrong.
 */
describe('seed-dev: the seeded client works against the REAL /authorize + CORS preflight (F9)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;

  const cfg = {
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv: 'development', issuer: ISSUER };
      if (ns === 'session') return { cookieSecure: false };
      if (ns === 'token')
        return { accessTokenTtl: 900, sessionIdleTtl: 3600, sessionAbsoluteTtl: 86400 };
      if (ns === 'security') return { csrfSecret: 'test-csrf-secret' };
      if (ns === 'consent') return { policyVersion: '1', termsVersion: '1' };
      throw new Error(`Unexpected config namespace: ${ns}`);
    },
  } as unknown as ConfigService;

  // A valid /authorize query for the SEEDED client (redirect_uri + scope come from the seed).
  const authorizeQuery = (overrides: Record<string, string> = {}): string => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'fe-sso-test',
      redirect_uri: 'http://localhost:5173/callback',
      scope: FE_SCOPE,
      resource: RESOURCE_URI,
      state: 'rp-state',
      nonce: 'rp-nonce',
      code_challenge: VALID_CHALLENGE,
      code_challenge_method: 'S256',
      ...overrides,
    });
    return `/authorize?${params.toString()}`;
  };

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      controllers: [AuthorizeController],
      providers: [
        AuthorizeService,
        AuthorizeRequestContextService,
        AuthorizationCodeService,
        ConsentService,
        CsrfService,
        CsrfGuard,
        ClientService,
        ResourceService,
        SessionService,
        SessionCookie,
        AuditService,
        ClientCorsService,
        HtmlExceptionFilter,
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Install the EXACT shared CORS preflight hook main.ts uses, so the OPTIONS behaviour under
    // test is the production wiring (not a hand-copied stand-in).
    registerCorsPreflight(app.getHttpAdapter().getInstance(), moduleRef.get(ClientCorsService));
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
    resourceModel = app.get<Model<Resource>>(getModelToken('Resource'));
    await syncAllIndexes(clientModel.db);

    // Provision the control plane exactly as `pnpm db:seed-dev` would.
    await seedDev(clientModel.db, ISSUER, 'development');
  }, 60_000);

  afterAll(async () => {
    if (clientModel) {
      await clientModel.deleteMany({}).exec();
      await resourceModel.deleteMany({}).exec();
      await clientModel.db.dropDatabase();
    }
    if (redis) {
      const keys = await redis.keys('authz_ctx:*');
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
    if (app) await app.close();
  });

  it('valid request for the seeded client (redirect/scope/resource) => NO OAuth error (302 to /login)', async () => {
    // No session => the request is valid and resumable: 302 to /login carrying a request_id. Crucially
    // it is NOT a redirect back to redirect_uri with error=invalid_scope/invalid_target/invalid_request,
    // which is exactly what would happen if the seeded scopes/allowedResources were wrong.
    const res = await app.inject({ method: 'GET', url: authorizeQuery() });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toMatch(/^\/login\?returnTo=/);
    expect(location).not.toContain('error=');
  });

  it('an out-of-scope request DOES get error=invalid_scope (proves the route really validates scope)', async () => {
    // Negative control: a scope not in the seeded client => the real route redirects to redirect_uri
    // with error=invalid_scope. This guards against a tautology where the happy path passes only
    // because the route never validates scope at all.
    const res = await app.inject({
      method: 'GET',
      url: authorizeQuery({ scope: 'openid admin' }),
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toContain('http://localhost:5173/callback?');
    expect(new URL(location).searchParams.get('error')).toBe('invalid_scope');
  });

  it('an unknown resource DOES get error=invalid_target (proves allowedResources is enforced)', async () => {
    // `/other/` is now a seeded, allowed resource (Q-24.1), so probe a genuinely unregistered one.
    const res = await app.inject({
      method: 'GET',
      url: authorizeQuery({ resource: 'http://localhost:4000/nope/' }),
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    expect(location).toContain('http://localhost:5173/callback?');
    expect(new URL(location).searchParams.get('error')).toBe('invalid_target');
  });

  it('OPTIONS /token preflight: :5173 (seeded origin) => 204 + ACAO; :5174 => no ACAO', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/token',
      headers: { origin: SPA_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(SPA_ORIGIN);
    expect(allowed.headers['access-control-allow-methods']).toContain('POST');
    expect(allowed.headers['vary']).toContain('Origin');

    const unknown = await app.inject({
      method: 'OPTIONS',
      url: '/token',
      headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'POST' },
    });
    expect(unknown.headers['access-control-allow-origin']).toBeUndefined();
  });
});

/**
 * Task 0 acceptance (a): the resourceId↔identifier mapping works END TO END on the EXACT control
 * plane `pnpm db:seed-dev` provisions (`buildSeedDevTargets`), not a hand-written fixture that
 * could accidentally store the URI as a "resourceId" and mask the bug. The seeded `fe-sso-test`
 * client (public) holds `allowedResources:['demo']`; the `demo` resource's identifier is
 * `${ISSUER}/demo/`. A real code->token->/userinfo->refresh chain must all be 200, and a SEPARATE
 * confidential resource-server client holding `allowedResources:['demo']` must introspect the
 * token as active:true via the mapping path (NOT the `client_id === caller` short-circuit, since
 * fe-sso-test is public and cannot introspect).
 */
describe('seed-dev: resourceId mapping works end-to-end on real seed data (Task 0 acceptance a)', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let userModel: Model<Record<string, unknown>>;
  let codes: AuthorizationCodeService;
  let sessions: SessionService;
  let rsSecret = '';
  let userId = '';

  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = deriveS256Challenge(VERIFIER);
  const RS_CLIENT = 'rs-demo'; // a confidential resource server that may introspect demo tokens.

  const form = (fields: Record<string, string>): string =>
    Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  const basic = (id: string, secret: string): string =>
    'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

  const cfg = {
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv: 'development', issuer: ISSUER };
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
          rateLimitMax: 100,
          // High thresholds so the client-auth failure limiter never fires in these tests.
          clientAuthFailIpMax: 100000,
          clientAuthFailClientMax: 100000,
        };
      if (ns === 'client') return { secretGraceTtl: 60 };
      throw new Error(`Unexpected config namespace: ${ns}`);
    },
  } as unknown as ConfigService;

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-seed-map-int-'));
    const provider = new LocalKeyProvider(keyDir);
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
      controllers: [TokenController, UserinfoController, IntrospectController],
      providers: [
        TokenService,
        RefreshTokenService,
        ResourceService,
        AuthorizationCodeService,
        SessionService,
        ClientService,
        ClientCredentialService,
        ClientAuthenticationService,
        ClientCorsService,
        AuditService,
        RateLimitService,
        TokenSigner,
        TokenVerifier,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    resourceModel = app.get<Model<Resource>>(getModelToken('Resource'));
    userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    codes = moduleRef.get(AuthorizationCodeService);
    sessions = moduleRef.get(SessionService);
    await syncAllIndexes(clientModel.db);

    // Provision the control plane EXACTLY as `pnpm db:seed-dev` would (fe-sso-test + demo resource).
    await seedDev(clientModel.db, ISSUER, 'development');

    // A real user the minted tokens' `sub` points at (liveness requires it to exist).
    const user = await userModel.create({ email: `seedmap-${Date.now()}@example.com` });
    userId = (user._id as Types.ObjectId).toHexString();

    // A SEPARATE confidential resource server that holds the SAME resourceId ('demo'). It is NOT
    // fe-sso-test (public), so introspection authorization must go through the resourceId->identifier
    // mapping, not the `client_id === caller` short-circuit.
    const clients = new ClientService(clientModel, cfg);
    await clients.create({
      clientId: RS_CLIENT,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      allowedResources: ['demo'],
      tenantId: DEFAULT_TENANT_ID,
    });
    rsSecret = (await app.get(ClientCredentialService).createSecret(RS_CLIENT)).secret;
  }, 60_000);

  afterAll(async () => {
    if (clientModel) {
      await clientModel.deleteMany({}).exec();
      await resourceModel.deleteMany({}).exec();
      await clientModel.db.dropDatabase();
    }
    if (redis) {
      for (const p of ['authz_code:*', 'sess:*', 'sess_end:*', 'user_sess:*', 'sess_rp:*']) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
      redis.disconnect();
    }
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  /** Mint a code bound to a fresh live session for the seeded fe-sso-test client + demo resource. */
  async function firstTokens(): Promise<{ access: string; refresh: string }> {
    const { session } = await sessions.create(userId, DEFAULT_TENANT_ID);
    const { code } = await codes.create({
      clientId: 'fe-sso-test',
      redirectUri: 'http://localhost:5173/callback',
      codeChallenge: CHALLENGE,
      resource: RESOURCE_URI, // = ${ISSUER}/demo/ (the seeded demo identifier)
      scope: 'openid profile email offline_access',
      userId,
      authTime: session.authTime,
      sessionRef: session.ref,
    } as never);
    const res = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:5173/callback',
        client_id: 'fe-sso-test',
        code_verifier: VERIFIER,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    return { access: body.access_token as string, refresh: body.refresh_token as string };
  }

  it('code -> token -> /userinfo 200 -> refresh 200 -> /introspect active:true (aud = ${ISSUER}/demo/)', async () => {
    const { access, refresh } = await firstTokens();

    // /userinfo: 200 for the token whose aud is the demo identifier the seeded client is allowed.
    const ui = await app.inject({
      method: 'GET',
      url: '/userinfo',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(ui.statusCode).toBe(200);
    expect(ui.json().sub).toBe(userId);

    // Refresh: 200, successor bound to the same demo identifier (INV-12).
    const rr = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'refresh_token',
        client_id: 'fe-sso-test',
        refresh_token: refresh,
      }),
    });
    expect(rr.statusCode).toBe(200);
    const refreshed = rr.json();
    const refreshedAud = JSON.parse(
      Buffer.from((refreshed.access_token as string).split('.')[1], 'base64url').toString('utf8'),
    ).aud as string;
    expect(refreshedAud).toBe(RESOURCE_URI);

    // /introspect by the confidential RS caller (holds resourceId 'demo') => active:true via the
    // resourceId->identifier mapping (fe-sso-test could never reach here, it is public).
    const is = await app.inject({
      method: 'POST',
      url: '/introspect',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basic(RS_CLIENT, rsSecret),
      },
      payload: form({ token: refreshed.access_token as string }),
    });
    expect(is.statusCode).toBe(200);
    const ib = is.json();
    expect(ib.active).toBe(true);
    expect(ib.aud).toBe(RESOURCE_URI);
    expect(ib.client_id).toBe('fe-sso-test');
  });

  it('(b) negative: remove demo from fe-sso-test => /userinfo 401, refresh invalid_grant, RS introspect active:false', async () => {
    const { access, refresh } = await firstTokens();
    await clientModel.updateOne({ clientId: 'fe-sso-test' }, { $set: { allowedResources: [] } });
    try {
      const ui = await app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${access}` },
      });
      expect(ui.statusCode).toBe(401);

      const rr = await app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({
          grant_type: 'refresh_token',
          client_id: 'fe-sso-test',
          refresh_token: refresh,
        }),
      });
      expect(rr.statusCode).toBe(400);
      expect(rr.json().error).toBe('invalid_grant');

      // The RS caller STILL holds 'demo', so authorization passes, but liveness now fails because
      // the token's issuing client no longer allows the aud => active:false (not an authz leak).
      const is = await app.inject({
        method: 'POST',
        url: '/introspect',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(RS_CLIENT, rsSecret),
        },
        payload: form({ token: access }),
      });
      expect(is.statusCode).toBe(200);
      expect(is.json()).toEqual({ active: false });
    } finally {
      await clientModel.updateOne(
        { clientId: 'fe-sso-test' },
        { $set: { allowedResources: ['demo', 'other'] } },
      );
    }
  });

  // ----- QA additions (run 24 tester): Task 0 acceptance (c) + replay on real seed data -----

  it('QA (c) wrong-format data: allowedResources holds the URI (not the resourceId) => fail-closed everywhere, refresh doc untouched', async () => {
    const { access, refresh } = await firstTokens();
    const rtModel = app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    // Data entered in the WRONG shape: the URI itself instead of resourceId 'demo'. Must never be
    // accepted as "the same thing" (confused deputy id vs URI) — no fail-open.
    await clientModel.updateOne(
      { clientId: 'fe-sso-test' },
      { $set: { allowedResources: [RESOURCE_URI] } },
    );
    try {
      const ui = await app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${access}` },
      });
      expect(ui.statusCode).toBe(401);
      expect(ui.body).not.toContain(RESOURCE_URI); // opaque: no "wrong aud" leak

      const rr = await app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({
          grant_type: 'refresh_token',
          client_id: 'fe-sso-test',
          refresh_token: refresh,
        }),
      });
      expect(rr.statusCode).toBe(400);
      expect(rr.json().error).toBe('invalid_grant');
      // Not burned, not family-revoked: the doc is unchanged (same as the (b) negative path).
      const doc = await rtModel.findOne({ tokenHash: sha256(refresh) }).lean();
      expect(doc).not.toBeNull();
      expect(doc?.revokedAt ?? null).toBeNull();
    } finally {
      await clientModel.updateOne(
        { clientId: 'fe-sso-test' },
        { $set: { allowedResources: ['demo', 'other'] } },
      );
    }

    // RS caller holding the URI (not 'demo') while the token's client is CORRECT: authorization
    // must not pass via the URI (isolates the introspect call-site from the liveness gate).
    await clientModel.updateOne(
      { clientId: RS_CLIENT },
      { $set: { allowedResources: [RESOURCE_URI] } },
    );
    try {
      // RS caller with the URI in its allowlist does NOT get authorization via the URI.
      const is = await app.inject({
        method: 'POST',
        url: '/introspect',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basic(RS_CLIENT, rsSecret),
        },
        payload: form({ token: access }),
      });
      expect(is.statusCode).toBe(200);
      expect(is.json()).toEqual({ active: false });
    } finally {
      await clientModel.updateOne(
        { clientId: RS_CLIENT },
        { $set: { allowedResources: ['demo'] } },
      );
    }

    // Restored to the correct resourceId shape => the SAME refresh token works again (proves the
    // negative above was the mapping, not a burned/broken token).
    const ok = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'refresh_token',
        client_id: 'fe-sso-test',
        refresh_token: refresh,
      }),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('QA replay: after a successful mapped rotation, replaying the old refresh token => invalid_grant and the successor is revoked (INV-14)', async () => {
    const { refresh } = await firstTokens();
    const rotate = (rt: string) =>
      app.inject({
        method: 'POST',
        url: '/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ grant_type: 'refresh_token', client_id: 'fe-sso-test', refresh_token: rt }),
      });
    const first = await rotate(refresh);
    expect(first.statusCode).toBe(200);
    const successor = first.json().refresh_token as string;

    const replay = await rotate(refresh);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');

    // Reuse detection kills the family: the successor no longer rotates.
    const after = await rotate(successor);
    expect(after.statusCode).toBe(400);
    expect(after.json().error).toBe('invalid_grant');
  });
});

/**
 * DEBT-076: `seedDevUser` upserts one dev user that can actually log in through the REAL
 * `AuthenticationService.login` (password hash verified, `emailVerifiedAt` set, membership present,
 * lockout reset), is idempotent, refuses production, and refuses the admin-seed email.
 */
describe('seed-dev: dev user (DEBT-076) on real Mongo', () => {
  const DEV_EMAIL = 'dev@example.com';
  const DEV_PASSWORD = 'dev-password-123';
  const ADMIN_EMAIL = 'admin@example.com';
  const devConfig: DevSeedUserConfig = {
    email: DEV_EMAIL,
    password: DEV_PASSWORD,
    adminEmail: ADMIN_EMAIL,
  };

  let moduleRef: TestingModule;
  let connection: Connection;
  let userModel: Model<Record<string, unknown>>;
  let userTenantModel: Model<Record<string, unknown>>;
  let auth: AuthenticationService;
  const sessions = {
    establish: jest.fn(async () => ({ session: { ref: 'sess-ref' } })),
    revokeAllForUser: jest.fn(async () => 0),
  };
  const refreshTokens = { revokeAllForUser: jest.fn(async () => 0) };
  const audit = { record: jest.fn(async () => undefined) };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(MONGO_URI, {
          serverSelectionTimeoutMS: 5000,
          retryAttempts: 5,
          retryDelay: 1000,
        }),
        MongooseModule.forFeature(MODELS),
      ],
      providers: [
        AuthenticationService,
        UserService,
        UserTenantService,
        { provide: SessionService, useValue: sessions },
        { provide: RefreshTokenService, useValue: refreshTokens },
        { provide: AuditService, useValue: audit },
        { provide: MAILER, useValue: { send: async () => undefined } },
        { provide: ConfigService, useValue: { getOrThrow: () => ({ issuer: ISSUER }) } },
      ],
    }).compile();
    userModel = moduleRef.get(getModelToken('User'));
    userTenantModel = moduleRef.get(getModelToken('UserTenant'));
    connection = userModel.db;
    await syncAllIndexes(connection);
    auth = moduleRef.get(AuthenticationService);
  }, 30_000);

  afterEach(async () => {
    jest.clearAllMocks();
    await userModel.deleteMany({}).exec();
    await userTenantModel.deleteMany({}).exec();
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await moduleRef.close();
  });

  it('seeding twice yields exactly one user + one membership (idempotent, no duplicates)', async () => {
    await seedDevUser(connection, devConfig, 'development');
    await seedDevUser(connection, devConfig, 'development');

    const normalized = normalizeEmail(DEV_EMAIL);
    expect(await userModel.countDocuments({ email: normalized }).exec()).toBe(1);
    const userDoc = await userModel.findOne({ email: normalized }).lean().exec();
    expect(userDoc).not.toBeNull();
    const user = userDoc as unknown as {
      _id: { toString(): string };
      emailVerifiedAt: Date;
      failedLoginCount: number;
      lockedUntil?: Date;
    };
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeUndefined();

    expect(
      await userTenantModel
        .countDocuments({ userId: user._id, tenantId: DEFAULT_TENANT_ID })
        .exec(),
    ).toBe(1);
    const membership = (await userTenantModel
      .findOne({ userId: user._id, tenantId: DEFAULT_TENANT_ID })
      .lean()
      .exec()) as unknown as { roles: string[]; status: string };
    expect(membership.roles).toEqual([]); // dev user is a plain non-admin
    expect(membership.status).toBe('active');
  });

  it('the seeded user logs in through the REAL login service (password + emailVerifiedAt + membership ok)', async () => {
    await seedDevUser(connection, devConfig, 'development');
    // Drives AuthenticationService.login: a resolved result means the Argon2 hash verified, the
    // emailVerifiedAt gate passed, and the account was not locked. SessionService is mocked (no
    // Redis needed) exactly as authentication.int-spec does.
    await expect(auth.login(DEV_EMAIL, DEV_PASSWORD, {})).resolves.toBeDefined();
    expect(sessions.establish).toHaveBeenCalledTimes(1);

    // Negative control: wrong password is rejected (the happy path is not a tautology).
    await expect(auth.login(DEV_EMAIL, 'wrong-password', {})).rejects.toThrow();
  });

  it('re-seeding resets lockout: failedLoginCount -> 0 and lockedUntil unset', async () => {
    await seedDevUser(connection, devConfig, 'development');
    const normalized = normalizeEmail(DEV_EMAIL);
    // Simulate a prior run that failed/locked the account.
    await userModel
      .updateOne(
        { email: normalized },
        { $set: { failedLoginCount: 9, lockedUntil: new Date(Date.now() + 3_600_000) } },
      )
      .exec();

    await seedDevUser(connection, devConfig, 'development');

    const user = (await userModel.findOne({ email: normalized }).lean().exec()) as unknown as {
      failedLoginCount: number;
      lockedUntil?: Date;
    };
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeUndefined();
  });

  it('keeps the original emailVerifiedAt on re-seed ($min, not overwrite)', async () => {
    await seedDevUser(connection, devConfig, 'development');
    const normalized = normalizeEmail(DEV_EMAIL);
    const first = (await userModel.findOne({ email: normalized }).lean().exec()) as unknown as {
      emailVerifiedAt: Date;
    };

    await new Promise((r) => setTimeout(r, 10));
    await seedDevUser(connection, devConfig, 'development', new Date());

    const second = (await userModel.findOne({ email: normalized }).lean().exec()) as unknown as {
      emailVerifiedAt: Date;
    };
    expect(second.emailVerifiedAt.getTime()).toBe(first.emailVerifiedAt.getTime());
  });

  it('refuses a DEV_SEED_EMAIL that collides with ADMIN_SEED_EMAIL (privilege split) and writes nothing', async () => {
    await expect(
      seedDevUser(connection, { ...devConfig, email: ADMIN_EMAIL }, 'development'),
    ).rejects.toThrow(/ADMIN_SEED_EMAIL/);
    expect(await userModel.countDocuments({}).exec()).toBe(0);
    expect(await userTenantModel.countDocuments({}).exec()).toBe(0);
  });

  it('NODE_ENV=production is refused by seedDevUser itself (fail-closed) and writes NOTHING', async () => {
    await expect(seedDevUser(connection, devConfig, 'production')).rejects.toThrow(/production/);
    expect(await userModel.countDocuments({}).exec()).toBe(0);
    expect(await userTenantModel.countDocuments({}).exec()).toBe(0);
  });

  it('readDevSeedUserConfig fails (naming the var) on missing/invalid env, without leaking the password', () => {
    expect(() => readDevSeedUserConfig({}, ADMIN_EMAIL)).toThrow(/DEV_SEED_EMAIL/);
    expect(() =>
      readDevSeedUserConfig(
        { DEV_SEED_EMAIL: 'not-an-email', DEV_SEED_PASSWORD: 'short' },
        ADMIN_EMAIL,
      ),
    ).toThrow(/DEV_SEED_EMAIL/);
    // A short password is reported by name/bound only — never echoes the value.
    try {
      readDevSeedUserConfig(
        { DEV_SEED_EMAIL: DEV_EMAIL, DEV_SEED_PASSWORD: 'secret7' },
        ADMIN_EMAIL,
      );
      throw new Error('expected to throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('DEV_SEED_PASSWORD');
      expect(msg).not.toContain('secret7');
    }
    // Valid env parses and carries the admin email through for the collision check.
    expect(
      readDevSeedUserConfig(
        { DEV_SEED_EMAIL: DEV_EMAIL, DEV_SEED_PASSWORD: DEV_PASSWORD },
        ADMIN_EMAIL,
      ),
    ).toEqual({ email: DEV_EMAIL, password: DEV_PASSWORD, adminEmail: ADMIN_EMAIL });
  });
});

/**
 * DEBT-100: the live FE/E2E INV-8 probe mints a token for the SECOND seeded resource `other` via
 * `/authorize` + consent (`POST /authorize/consent`). On the DEV database this returned a 500: the
 * environment was deployed before DEBT-028 and still carries the STALE `{userId, clientId}` unique
 * index on `consents` (the pre-Q1 single-resource key) that `db:sync-indexes`/`syncAllIndexes` was
 * never run to drop. With that stale index present, a user who already consented to `demo` cannot
 * consent to a SECOND resource (`other`) for the SAME client: the insert violates the old unique
 * key, surfaces as a persistent E11000 (the grant retry-once cannot resolve it — it is not the
 * composite key), `decideConsent` throws a non-`AuthorizeRedirectError`, and the controller 500s.
 *
 * This test reproduces that exact end-to-end failure (controller level, not just the index layer
 * `indexes.int-spec.ts` covers) on a FRESH DB that is deliberately seeded with the stale index, then
 * proves the sanctioned fix — running `syncAllIndexes` (= `pnpm db:sync-indexes`, the DEBT-028
 * runbook) — drops the stale index so the `other` consent 302s with a code. It then walks the full
 * INV-8 chain: `/token` mints an access token with `aud=${ISSUER}/other/`, and `GET /demo/me` with
 * that token is refused 401 (a token for `other` must not open the `demo` resource).
 */
describe('seed-dev: DEBT-100 consent for a 2nd resource (`other`) + INV-8 chain on real seed data', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let userModel: Model<Record<string, unknown>>;
  let sessions: SessionService;
  let userId = '';
  const OLD_CONSENT_INDEX = 'userId_1_clientId_1'; // the pre-DEBT-028 stale unique index.

  const cfg = {
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv: 'development', issuer: ISSUER };
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
          rateLimitMax: 100,
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

  const authorizeQuery = (overrides: Record<string, string> = {}): string => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'fe-sso-test',
      redirect_uri: 'http://localhost:5173/callback',
      scope: FE_SCOPE,
      resource: RESOURCE_URI,
      state: 'rp-state',
      nonce: 'rp-nonce',
      code_challenge: VALID_CHALLENGE,
      code_challenge_method: 'S256',
      ...overrides,
    });
    return `/authorize?${params.toString()}`;
  };

  // Drive one approve-consent round-trip; returns the raw POST reply so a caller can assert 302/500.
  async function consentRoundTrip(sessionId: string, scope: string, resource: string) {
    const screen = await app.inject({
      method: 'GET',
      url: authorizeQuery({ scope, resource }),
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(screen.statusCode).toBe(200);
    const csrf = screen.body.match(/name="_csrf" value="([^"]+)"/)?.[1] as string;
    const requestId = screen.body.match(/name="request_id" value="([^"]+)"/)?.[1] as string;
    return app.inject({
      method: 'POST',
      url: '/authorize/consent',
      cookies: { [SESSION_COOKIE]: sessionId },
      payload: { _csrf: csrf, request_id: requestId, approve: 'true' },
    });
  }

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-debt100-int-'));
    const provider = new LocalKeyProvider(keyDir);
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
      controllers: [AuthorizeController, TokenController, DemoController],
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
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorsPreflight(app.getHttpAdapter().getInstance(), moduleRef.get(ClientCorsService));
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
    resourceModel = app.get<Model<Resource>>(getModelToken('Resource'));
    userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    sessions = moduleRef.get(SessionService);
    await syncAllIndexes(clientModel.db);

    // Provision the control plane EXACTLY as `pnpm db:seed-dev` would (fe-sso-test + demo + other).
    await seedDev(clientModel.db, ISSUER, 'development');

    // A real user the minted tokens' `sub` points at (liveness requires it to exist).
    const user = await userModel.create({ email: `debt100-${Date.now()}@example.com` });
    userId = (user._id as Types.ObjectId).toHexString();
  }, 60_000);

  afterAll(async () => {
    if (clientModel) {
      await clientModel.deleteMany({}).exec();
      await resourceModel.deleteMany({}).exec();
      await clientModel.db.collection('consents').deleteMany({});
      await clientModel.db.dropDatabase();
    }
    if (redis) {
      for (const p of [
        'authz_ctx:*',
        'authz_code:*',
        'sess:*',
        'sess_end:*',
        'user_sess:*',
        'sess_rp:*',
      ]) {
        const keys = await redis.keys(p);
        if (keys.length) await redis.del(...keys);
      }
      redis.disconnect();
    }
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('repro: a STALE {userId,clientId} consent index makes the 2nd-resource (`other`) consent 500', async () => {
    // Recreate the pre-DEBT-028 deployed state the DEV DB `sso-idp` still carries: the old
    // single-resource unique key alongside the current composite one.
    await clientModel.db
      .collection('consents')
      .createIndex({ userId: 1, clientId: 1 }, { unique: true });
    const { id } = await sessions.create(userId, DEFAULT_TENANT_ID);

    // First consent: `demo` (button A already did this) => 302 with a code.
    const demo = await consentRoundTrip(id, FE_SCOPE, RESOURCE_URI);
    expect(demo.statusCode).toBe(302);
    expect(new URL(demo.headers['location'] as string).searchParams.get('code')).toBeTruthy();

    // Second consent: `other` (the INV-8 aud-probe, button B). The stale key is violated =>
    // persistent E11000 => decideConsent throws => controller 500 (DEBT-100).
    const other = await consentRoundTrip(id, 'openid', OTHER_RESOURCE_URI);
    expect(other.statusCode).toBe(500);

    await sessions.revoke(id);
    await clientModel.db.collection('consents').deleteMany({});
    // Leave the collection clean but keep the stale index for the "fix" test to drop.
  });

  it('fix: syncAllIndexes drops the stale index; `other` consent then 302s with a code', async () => {
    // The stale index is still present from the previous test. Confirm it, then run the DEBT-028
    // runbook remedy (`syncAllIndexes` = `pnpm db:sync-indexes`) and prove it is dropped.
    const before = (await clientModel.db.collection('consents').indexes()) as {
      name: string;
    }[];
    expect(before.some((i) => i.name === OLD_CONSENT_INDEX)).toBe(true);

    const dropped = await syncAllIndexes(clientModel.db);
    expect(dropped.Consent).toContain(OLD_CONSENT_INDEX);
    const after = (await clientModel.db.collection('consents').indexes()) as { name: string }[];
    expect(after.some((i) => i.name === OLD_CONSENT_INDEX)).toBe(false);

    const { id } = await sessions.create(userId, DEFAULT_TENANT_ID);
    const demo = await consentRoundTrip(id, FE_SCOPE, RESOURCE_URI);
    expect(demo.statusCode).toBe(302);
    const other = await consentRoundTrip(id, 'openid', OTHER_RESOURCE_URI);
    expect(other.statusCode).toBe(302);
    expect(new URL(other.headers['location'] as string).searchParams.get('code')).toBeTruthy();
    await sessions.revoke(id);
    await clientModel.db.collection('consents').deleteMany({});
  });

  it('INV-8: an `other`-aud token minted via consent is REFUSED (401) by GET /demo/me', async () => {
    // Indexes are already healthy here (previous test synced them). Walk the full probe chain:
    // consent `other` -> /token -> access token aud=${ISSUER}/other/ -> GET /demo/me => 401.
    const { id } = await sessions.create(userId, DEFAULT_TENANT_ID);
    const post = await consentRoundTrip(id, 'openid', OTHER_RESOURCE_URI);
    expect(post.statusCode).toBe(302);
    const code = new URL(post.headers['location'] as string).searchParams.get('code')!;
    expect(code).toBeTruthy();

    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    // The authorize PKCE challenge (VALID_CHALLENGE) is the S256 of this verifier.
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:5173/callback',
        client_id: 'fe-sso-test',
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.statusCode).toBe(200);
    const access = tokenRes.json().access_token as string;
    const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.aud).toBe(OTHER_RESOURCE_URI); // minted for `other`, NOT `demo`.

    const me = await app.inject({
      method: 'GET',
      url: '/demo/me',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(401); // INV-8: token for `other` must not open the `demo` resource.
    expect(me.json().error).toBe('invalid_token');
    await sessions.revoke(id);
  });
});
