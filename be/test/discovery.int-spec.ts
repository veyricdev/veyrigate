import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { KeysController } from '../src/modules/keys/keys.controller';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { DiscoveryController } from '../src/modules/oauth/discovery/discovery.controller';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-discovery-${Date.now()}?directConnection=true`;
const RUN = `disc${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const ORIGIN = 'https://spa.example.com';

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    throw new Error(`unexpected ns ${ns}`);
  },
} as unknown as ConfigService;

describe('/.well-known/openid-configuration discovery (B4.6 Task 1)', () => {
  let app: NestFastifyApplication;
  let keyDir: string;
  let clientModel: Model<Client>;

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'vg-disc-int-'));
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
      controllers: [DiscoveryController, KeysController],
      providers: [
        ClientCorsService,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    await syncAllIndexes(clientModel.db);

    const clients = new ClientService(clientModel, cfg);
    await clients.create({
      clientId: `${RUN}-spa`,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [`${ORIGIN}/cb`],
      allowedCorsOrigins: [ORIGIN],
      tenantId: 'tenant-A',
    });
  }, 60_000);

  afterAll(async () => {
    if (clientModel) await clientModel.db.dropDatabase();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('200 JSON; every endpoint URL is derived from the issuer and points at a mounted route', async () => {
    const res = await get('/.well-known/openid-configuration');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const body = res.json();
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/token`);
    expect(body.userinfo_endpoint).toBe(`${ISSUER}/userinfo`);
    expect(body.jwks_uri).toBe(`${ISSUER}/jwks.json`);
    expect(body.revocation_endpoint).toBe(`${ISSUER}/revoke`);
    expect(body.introspection_endpoint).toBe(`${ISSUER}/introspect`);

    // The advertised jwks_uri must actually serve keys (no drift).
    const jwks = await get('/jwks.json');
    expect(jwks.statusCode).toBe(200);
    expect(Array.isArray(jwks.json().keys)).toBe(true);
    expect(jwks.json().keys.length).toBeGreaterThanOrEqual(1);
  });

  it('metadata matches the agreed contract (snapshot of every field)', async () => {
    const body = (await get('/.well-known/openid-configuration')).json();
    expect(body).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks.json`,
      revocation_endpoint: `${ISSUER}/revoke`,
      introspection_endpoint: `${ISSUER}/introspect`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      claims_supported: [
        'iss',
        'sub',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'acr',
        'amr',
        'email',
        'email_verified',
        'name',
        'given_name',
        'family_name',
        'middle_name',
        'nickname',
        'preferred_username',
        'picture',
        'website',
        'gender',
        'birthdate',
        'zoneinfo',
        'locale',
        'updated_at',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('does NOT advertise end_session_endpoint yet (GET /logout is a form, not RP-initiated) ? DEBT-038', async () => {
    const body = (await get('/.well-known/openid-configuration')).json();
    expect(body).not.toHaveProperty('end_session_endpoint');
  });

  it('leaks no private key material / non-RS256 alg / `plain` PKCE method', async () => {
    const raw = (await get('/.well-known/openid-configuration')).payload;
    // `client_secret_*` auth-method names legitimately contain "secret"; what must NEVER appear is
    // private key material or alg confusion.
    expect(raw).not.toContain('plain');
    expect(raw).not.toContain('HS256');
    expect(raw).not.toContain('"d"'); // RSA private exponent
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('secretHash');
  });

  it('real GET echoes a registered Origin (CORS) and always sets Vary: Origin', async () => {
    const allowed = await get('/.well-known/openid-configuration', { origin: ORIGIN });
    expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(allowed.headers['vary']).toContain('Origin');

    const unknown = await get('/.well-known/openid-configuration', {
      origin: 'https://evil.example.com',
    });
    expect(unknown.headers['access-control-allow-origin']).toBeUndefined();
    expect(unknown.headers['vary']).toContain('Origin');
  });
});

describe('discovery URL join when the issuer carries a path / trailing slash (unit, Task 1 fold)', () => {
  function build(issuer: string): Record<string, unknown> {
    const c = new DiscoveryController(
      { getOrThrow: () => ({ nodeEnv: 'production', issuer }) } as unknown as ConfigService,
      { isOriginRegisteredForAnyClient: async () => false } as unknown as ClientCorsService,
    );
    const reply = {
      header() {
        return reply;
      },
      status() {
        return reply;
      },
      send(payload: unknown) {
        return payload;
      },
    };
    return c.configuration({ headers: {} }, reply) as unknown as Record<string, unknown>;
  }

  it('issuer with a path keeps the path (no new URL("/x", issuer) swallow)', async () => {
    const body = (await build('https://h/idp')) as unknown as Record<string, string>;
    expect(body.token_endpoint).toBe('https://h/idp/token');
    expect(body.jwks_uri).toBe('https://h/idp/jwks.json');
  });

  it('issuer with a trailing slash does not produce a double slash', async () => {
    const body = (await build('https://h/')) as unknown as Record<string, string>;
    expect(body.token_endpoint).toBe('https://h/token');
    expect(body.issuer).toBe('https://h/');
  });
});
