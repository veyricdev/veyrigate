import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import { Types, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { registerCorsPreflight } from '../src/modules/clients/client-cors.helper';
import { DemoController } from '../src/modules/demo/demo.controller';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-demo-${Date.now()}?directConnection=true`;
const RUN = `demo${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const DEMO_AUD = 'http://localhost:4000/demo/'; // = ${ISSUER}/demo/
const OTHER_AUD = 'http://localhost:4000/other/';
const DEMO_RESOURCE_ID = 'demo';
const OTHER_RESOURCE_ID = 'other';
const ORIGIN = 'http://localhost:5173';
const CLIENT = `${RUN}-client`;

// Session-end lookup double (DEBT-037): spy-able so a test drives tombstone present/absent.
const isEnded = jest.fn<(ref: string) => Promise<boolean>>().mockResolvedValue(false);
const sessionsStub = { isEnded } as unknown as SessionService;

/** `cfg` with a given raw `nodeEnv` so we can also exercise the production-defence 404 branch. */
const configFor = (nodeEnv: string): ConfigService =>
  ({
    getOrThrow: (ns: string) => {
      if (ns === 'app') return { nodeEnv, issuer: ISSUER };
      throw new Error(`unexpected ns ${ns}`);
    },
  }) as unknown as ConfigService;

describe('/demo/me (B6.5) on real Mongo', () => {
  let app: NestFastifyApplication;
  let keyDir: string;
  let signer: TokenSigner;
  let provider: LocalKeyProvider;
  let userModel: Model<Record<string, unknown>>;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let userId = '';
  const SID = 'a'.repeat(64); // a well-formed (sha256-hex) session ref.

  const accessToken = (
    over: { scope?: string; sub?: string; aud?: string; clientId?: string; sid?: string } = {},
  ): Promise<string> =>
    signer.sign(
      {
        scope: over.scope ?? 'openid',
        client_id: over.clientId ?? CLIENT,
        ...(over.sid !== undefined ? { sid: over.sid } : {}),
      },
      {
        audience: over.aud ?? DEMO_AUD,
        subject: over.sub ?? userId,
        expiresInSec: 900,
        typ: 'at+jwt',
      },
    );

  /** An ID token (typ: JWT, aud=client) — must be rejected by /demo/me (token confusion). */
  const idToken = (): Promise<string> =>
    signer.sign({}, { audience: CLIENT, subject: userId, expiresInSec: 900 });

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/demo/me', headers });

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'vg-demo-int-'));
    provider = new LocalKeyProvider(keyDir);
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
      controllers: [DemoController],
      providers: [
        ClientService,
        ClientCorsService,
        ResourceService,
        TokenSigner,
        TokenVerifier,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: ConfigService, useValue: configFor('development') },
        { provide: SessionService, useValue: sessionsStub },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Install the EXACT shared preflight hook main.ts uses WITH the demo path (demo enabled).
    registerCorsPreflight(
      app.getHttpAdapter().getInstance(),
      moduleRef.get(ClientCorsService),
      new Set(['/demo/me']),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    signer = moduleRef.get(TokenSigner);
    userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    resourceModel = app.get<Model<Resource>>(getModelToken('Resource'));
    await syncAllIndexes(clientModel.db);

    const clients = new ClientService(clientModel, configFor('development'));
    await clients.create({
      clientId: CLIENT,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [`${ORIGIN}/callback`],
      allowedCorsOrigins: [ORIGIN],
      allowedResources: [DEMO_RESOURCE_ID, OTHER_RESOURCE_ID],
      tenantId: 'tenant-A',
    });
    const resources = new ResourceService(resourceModel);
    await resources.create({ resourceId: DEMO_RESOURCE_ID, identifier: DEMO_AUD });
    await resources.create({ resourceId: OTHER_RESOURCE_ID, identifier: OTHER_AUD });

    const user = await userModel.create({ email: `${RUN}@example.com` });
    userId = (user._id as Types.ObjectId).toHexString();
  }, 60_000);

  afterAll(async () => {
    if (clientModel) await clientModel.db.dropDatabase();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    isEnded.mockReset();
    isEnded.mockResolvedValue(false);
  });

  it('valid access token (aud = demo) => 200 with safe claims, no sid, no-store', async () => {
    const token = await accessToken();
    const res = await get({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.sub).toBe(userId);
    expect(body.aud).toBe(DEMO_AUD);
    expect(body.client_id).toBe(CLIENT);
    expect(body).not.toHaveProperty('sid'); // DEBT-047
  });

  it('token for another resource (aud = other) => 401 invalid_token (INV-8)', async () => {
    const token = await accessToken({ aud: OTHER_AUD });
    const res = await get({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('logout (sid tombstone) => the SAME token is 401 immediately (not after exp)', async () => {
    const token = await accessToken({ sid: SID });
    // First call: session live => 200.
    expect((await get({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
    // Now the session is actively ended (tombstone): same token must be 401 at once.
    isEnded.mockResolvedValue(true);
    const after = await get({ authorization: `Bearer ${token}` });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe('invalid_token');
  });

  it('missing / malformed token => 401 invalid_token + WWW-Authenticate Bearer', async () => {
    const none = await get();
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');
    expect(none.json().error).toBe('invalid_token');
    const garbage = await get({ authorization: 'Bearer not-a-jwt' });
    expect(garbage.statusCode).toBe(401);
  });

  it('an ID token (typ: JWT) => 401 (token confusion closed)', async () => {
    const res = await get({ authorization: `Bearer ${await idToken()}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('an expired access token => 401', async () => {
    const { kid, privateKey } = await provider.getSigningKey();
    const forged = await new SignJWT({ scope: 'openid', client_id: CLIENT })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(DEMO_AUD)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .setJti(randomUUID())
      .sign(privateKey);
    const res = await get({ authorization: `Bearer ${forged}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('an HS256-signed token (alg confusion) => 401 (only RS256 accepted)', async () => {
    const secret = new Uint8Array(32).fill(7);
    const forged = await new SignJWT({ scope: 'openid', client_id: CLIENT })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(DEMO_AUD)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .setJti(randomUUID())
      .sign(secret);
    const res = await get({ authorization: `Bearer ${forged}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('fail-closed: an infrastructure fault (user lookup throws) => 5xx, not 200/401', async () => {
    const token = await accessToken();
    const spy = jest.spyOn(userModel, 'exists').mockImplementationOnce(() => {
      throw new Error('mongo down');
    });
    try {
      const res = await get({ authorization: `Bearer ${token}` });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.json()).not.toHaveProperty('sub');
    } finally {
      spy.mockRestore();
    }
  });

  it('QA fail-closed: a Redis fault in the sid tombstone lookup => 5xx (never 200/401), body opaque', async () => {
    isEnded.mockRejectedValueOnce(new Error('ECONNREFUSED redis 127.0.0.1:6479 secret-detail'));
    const token = await accessToken({ sid: SID });
    const res = await get({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.body).not.toContain('secret-detail');
    expect(res.body).not.toContain(token);
  });

  it('QA fail-closed: a Mongo fault resolving the resource mapping => 5xx (never 200/401), body opaque', async () => {
    const resources = app.get(ResourceService);
    const spy = jest
      .spyOn(resources, 'identifiersFor')
      .mockRejectedValueOnce(new Error('MongoServerSelectionError secret-detail'));
    try {
      const res = await get({ authorization: `Bearer ${await accessToken()}` });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain('secret-detail');
    } finally {
      spy.mockRestore();
    }
  });

  it('QA INV-8: a token for an UNREGISTERED aud (not any Resource) => 401, and a token of a client that does not allow demo => 401', async () => {
    const unknown = await get({
      authorization: `Bearer ${await accessToken({ aud: 'http://localhost:4000/nope/' })}`,
    });
    expect(unknown.statusCode).toBe(401);
    // Correct aud, but the token's client never had 'demo' in allowedResources (cross-client).
    const rogue = `${RUN}-rogue`;
    await new ClientService(clientModel, configFor('development')).create({
      clientId: rogue,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [`${ORIGIN}/callback`],
      allowedCorsOrigins: [ORIGIN],
      allowedResources: [OTHER_RESOURCE_ID],
      tenantId: 'tenant-A',
    });
    const res = await get({ authorization: `Bearer ${await accessToken({ clientId: rogue })}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('access token in query is ignored (only Authorization header) => 401', async () => {
    const token = await accessToken();
    const res = await app.inject({ method: 'GET', url: `/demo/me?access_token=${token}` });
    expect(res.statusCode).toBe(401);
  });

  it('preflight OPTIONS from the SPA origin => 204 + ACAO + Vary; unknown origin => no ACAO', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/demo/me',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(allowed.headers['vary']).toContain('Origin');

    const unknown = await app.inject({
      method: 'OPTIONS',
      url: '/demo/me',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    });
    expect(unknown.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('real request: ACAO echoes the SPA origin registered for the token client; no Allow-Credentials', async () => {
    const token = await accessToken();
    const res = await get({ authorization: `Bearer ${token}`, origin: ORIGIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

/**
 * Defence in depth (Q-24.2): even if the DemoController were somehow instantiated in a production
 * process, `GET /demo/me` must 404 (look absent), never serve. The allowlist that normally keeps
 * the whole module out of production is covered by `demo.enabled.spec.ts`; this proves the
 * controller's own fallback.
 */
describe('/demo/me production defence-in-depth (controller 404)', () => {
  let app: NestFastifyApplication;
  let keyDir: string;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'vg-demo-prod-int-'));
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
      controllers: [DemoController],
      providers: [
        ClientService,
        ClientCorsService,
        ResourceService,
        TokenSigner,
        TokenVerifier,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: ConfigService, useValue: configFor('production') },
        { provide: SessionService, useValue: sessionsStub },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('GET /demo/me => 404 even with no token (production)', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo/me' });
    expect(res.statusCode).toBe(404);
  });
});
