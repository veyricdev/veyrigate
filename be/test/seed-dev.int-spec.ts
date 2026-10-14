import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import view from '@fastify/view';
import { Eta } from 'eta';
import IORedis from 'ioredis';
import mongoose, { type Connection, type Model } from 'mongoose';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { seedDev, buildSeedDevTargets, assertNotProduction } from '../src/database/seed-dev';
import { RedisService } from '../src/database/redis/redis.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { registerCorsPreflight } from '../src/modules/clients/client-cors.helper';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';
import { DEFAULT_TENANT_ID } from '../src/modules/identity/tenant.service';
import { AuthorizeController } from '../src/modules/oauth/authorize/authorize.controller';
import { AuthorizeService } from '../src/modules/oauth/authorize/authorize.service';
import { AuthorizeRequestContextService } from '../src/modules/oauth/authorize/authorize-request-context.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { ConsentService } from '../src/modules/oauth/consent/consent.service';
import { CsrfGuard, CsrfService } from '../src/modules/ui/csrf.service';
import { HtmlExceptionFilter } from '../src/modules/ui/html-exception.filter';
import { SessionService } from '../src/modules/sessions/session.service';
import { SessionCookie } from '../src/modules/sessions/session.cookie';
import { AuditService } from '../src/modules/security/audit/audit.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-seed-dev-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

const ISSUER = 'http://localhost:4000';
const RESOURCE_URI = 'http://localhost:4000/demo/'; // = VITE_OIDC_RESOURCE in fe-sso-test/.env.example
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

  it('seeds exactly one public client + one demo resource with the fe-sso-test config', async () => {
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
      allowedResources: ['demo'],
      tenantId: DEFAULT_TENANT_ID,
    });

    const resourceDocs = await resourceModel.find({ resourceId: 'demo' }).lean().exec();
    expect(resourceDocs).toHaveLength(1);
    const resource = await resources.findByIdentifier(RESOURCE_URI);
    expect(resource).toMatchObject({ resourceId: 'demo', identifier: RESOURCE_URI });
  });

  it('no ClientCredential is created (public client has no secret)', async () => {
    await seedDev(connection, ISSUER, 'development');
    const creds = await connection.model('ClientCredential').countDocuments({}).exec();
    expect(creds).toBe(0);
  });

  it('is idempotent: running twice yields exactly one client + one resource (no duplicates)', async () => {
    await seedDev(connection, ISSUER, 'development');
    await seedDev(connection, ISSUER, 'development');

    expect(await clientModel.countDocuments({ clientId: 'fe-sso-test' }).exec()).toBe(1);
    expect(await resourceModel.countDocuments({ resourceId: 'demo' }).exec()).toBe(1);
    expect(await resourceModel.countDocuments({ identifier: RESOURCE_URI }).exec()).toBe(1);
  });

  it('re-seeding after ISSUER changes updates the one demo resource in place (no second document)', async () => {
    await seedDev(connection, ISSUER, 'development');
    // Same control-plane, different issuer: `identifier` is derived from the issuer, so keying the
    // upsert by `identifier` (the old bug) would insert a SECOND `demo` resource here.
    const otherIssuer = 'http://localhost:5000';
    const otherUri = 'http://localhost:5000/demo/';
    await seedDev(connection, otherIssuer, 'development');

    expect(await resourceModel.countDocuments({ resourceId: 'demo' }).exec()).toBe(1);
    const docs = await resourceModel.find({}).lean().exec();
    expect(docs).toHaveLength(1);
    // The single document now carries the NEW issuer's identifier (updated in place).
    expect(docs[0]!.identifier).toBe(otherUri);
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
    expect(buildSeedDevTargets('http://localhost:4000').resource.identifier).toBe(RESOURCE_URI);
    expect(buildSeedDevTargets('http://localhost:4000/').resource.identifier).toBe(RESOURCE_URI);
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
    const res = await app.inject({
      method: 'GET',
      url: authorizeQuery({ resource: 'http://localhost:4000/other/' }),
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
