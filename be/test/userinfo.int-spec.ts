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
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { sha256 } from '../src/common/crypto/crypto.util';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ResourceService, type Resource } from '../src/modules/resources/resource.service';
import { jest } from '@jest/globals';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { registerCorsPreflight } from '../src/modules/clients/client-cors.helper';
import { SessionService } from '../src/modules/sessions/session.service';
import { UserinfoController } from '../src/modules/oauth/userinfo/userinfo.controller';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-userinfo-${Date.now()}?directConnection=true`;
const RUN = `ui${Date.now()}`;
const ISSUER = 'http://localhost:4000';
// `allowedResources[]` holds resourceIds (spec §7); `aud`/`RefreshToken.resource` hold the URI
// identifier. The two are reconciled via the `Resource` registry (Task 0), so the fixtures below
// register a `Resource {resourceId, identifier}` and put the resourceId — never the URI — in
// `allowedResources`.
const RESOURCE = 'https://api.example.com/';
const RESOURCE_ID = 'res-api';
const OTHER_RESOURCE = 'https://other.example.com/';
const OTHER_RESOURCE_ID = 'res-other';
const ORIGIN = 'https://spa.example.com';
const CLIENT = `${RUN}-client`;
const OTHER_CLIENT = `${RUN}-other`;

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    throw new Error(`unexpected ns ${ns}`);
  },
} as unknown as ConfigService;

// Session-end lookup double (DEBT-037): spy-able so a test can assert call counts and drive
// specific outcomes (tombstone present/absent, Redis fault). Only `isEnded` is used by /userinfo.
const isEnded = jest.fn<(ref: string) => Promise<boolean>>().mockResolvedValue(false);
const sessionsStub = { isEnded } as unknown as SessionService;

describe('/userinfo (B4.6 Task 2) on real Mongo', () => {
  let app: NestFastifyApplication;
  let keyDir: string;
  let signer: TokenSigner;
  let provider: LocalKeyProvider;
  let userModel: Model<Record<string, unknown>>;
  let clientModel: Model<Client>;
  let resourceModel: Model<Resource>;
  let userId: string;

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/userinfo', headers });

  /** Sign an access token (RFC 9068 `typ: at+jwt`) with controlled claims. */
  const accessToken = (
    over: {
      scope?: string;
      sub?: string;
      aud?: string;
      clientId?: string;
      sid?: string | number;
    } = {},
  ) =>
    signer.sign(
      {
        scope: over.scope ?? 'openid email profile',
        client_id: over.clientId ?? CLIENT,
        ...(over.sid !== undefined ? { sid: over.sid } : {}),
      },
      {
        audience: over.aud ?? RESOURCE,
        subject: over.sub ?? userId,
        expiresInSec: 900,
        typ: 'at+jwt',
      },
    );

  /** Sign an ID token (typ: JWT, aud=client) ? must be rejected by /userinfo. */
  const idToken = () => signer.sign({}, { audience: CLIENT, subject: userId, expiresInSec: 900 });

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'vg-userinfo-int-'));
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
      controllers: [UserinfoController],
      providers: [
        ClientService,
        ClientCorsService,
        ResourceService,
        TokenSigner,
        TokenVerifier,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: ConfigService, useValue: cfg },
        { provide: SessionService, useValue: sessionsStub },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Register the EXACT CORS preflight hook main.ts installs (the shared `registerCorsPreflight`),
    // so the tested behaviour cannot drift from production wiring.
    registerCorsPreflight(app.getHttpAdapter().getInstance(), moduleRef.get(ClientCorsService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    signer = moduleRef.get(TokenSigner);
    userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    resourceModel = app.get<Model<Resource>>(getModelToken('Resource'));
    await syncAllIndexes(clientModel.db);

    const clients = new ClientService(clientModel, cfg);
    await clients.create({
      clientId: CLIENT,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [`${ORIGIN}/cb`],
      allowedCorsOrigins: [ORIGIN],
      allowedResources: [RESOURCE_ID],
      tenantId: 'tenant-A',
    });
    await clients.create({
      clientId: OTHER_CLIENT,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      allowedResources: [OTHER_RESOURCE_ID],
      tenantId: 'tenant-A',
    });

    const resources = new ResourceService(resourceModel);
    await resources.create({ resourceId: RESOURCE_ID, identifier: RESOURCE });
    await resources.create({ resourceId: OTHER_RESOURCE_ID, identifier: OTHER_RESOURCE });

    const user = await userModel.create({
      email: 'alice@example.com',
      emailVerifiedAt: new Date(),
      profile: {
        name: 'Alice A',
        given_name: 'Alice',
        picture: 'https://img/a.png',
        internalNote: 'SECRET',
      },
    });
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

  it('valid token (openid email profile) => 200 with sub/email/email_verified/profile, no-store', async () => {
    const token = await accessToken();
    const res = await get({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.sub).toBe(userId);
    expect(body.email).toBe('alice@example.com');
    expect(body.email_verified).toBe(true);
    expect(body.name).toBe('Alice A');
    expect(body.given_name).toBe('Alice');
    expect(body.picture).toBe('https://img/a.png');
    // whitelist: an arbitrary profile key never leaks.
    expect(body).not.toHaveProperty('internalNote');
    expect(typeof body.updated_at).toBe('number');
  });

  it('email_verified reflects emailVerifiedAt == null', async () => {
    const u = await userModel.create({ email: 'bob@example.com', profile: {} });
    const token = await accessToken({
      sub: (u._id as Types.ObjectId).toHexString(),
      scope: 'openid email',
    });
    const body = (await get({ authorization: `Bearer ${token}` })).json();
    expect(body.email).toBe('bob@example.com');
    expect(body.email_verified).toBe(false);
    expect(body).not.toHaveProperty('name');
  });

  it('scope only openid => 200 with just { sub }, no email/profile', async () => {
    const token = await accessToken({ scope: 'openid' });
    const res = await get({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sub: userId });
  });

  it('missing / malformed / absent token => 401 invalid_token + WWW-Authenticate Bearer', async () => {
    const none = await get();
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toContain('Bearer');
    expect(none.json().error).toBe('invalid_token');

    const garbage = await get({ authorization: 'Bearer not.a.jwt' });
    expect(garbage.statusCode).toBe(401);
  });

  it('an ID token (typ: JWT) presented as access token => 401 (token confusion closed)', async () => {
    const res = await get({ authorization: `Bearer ${await idToken()}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('an HS256-signed token (alg confusion) => 401 (only RS256 accepted)', async () => {
    // Forge a token that is a well-formed access token in every way EXCEPT the alg: HS256 with an
    // attacker-chosen symmetric secret. verifyAccessToken pins algorithms:['RS256'] so this must
    // never verify (alg-confusion / downgrade closed) and collapse to the opaque 401.
    const secret = new Uint8Array(32).fill(7);
    const forged = await new SignJWT({ scope: 'openid email profile', client_id: CLIENT })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .setJti(randomUUID())
      .sign(secret);
    const res = await get({ authorization: `Bearer ${forged}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('a token with a wrong iss (real key + at+jwt) => 401 (issuer binding enforced)', async () => {
    // Signed with the IdP's REAL private key (so the signature verifies against JWKS) but a foreign
    // issuer: verifyAccessToken pins `iss` to the configured issuer, so this fails on iss, proving
    // the signature check alone is not enough.
    const { kid, privateKey } = await provider.getSigningKey();
    const forged = await new SignJWT({ scope: 'openid', client_id: CLIENT })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
      .setIssuer('https://evil-idp.example.com')
      .setAudience(RESOURCE)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .setJti(randomUUID())
      .sign(privateKey);
    const res = await get({ authorization: `Bearer ${forged}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('a token missing exp (real key + at+jwt) => 401 (exp required, no eternal token)', async () => {
    // verifyAccessToken passes requiredClaims including `exp`; jose only enforces exp when present,
    // so a token WITHOUT exp must be rejected outright rather than treated as never-expiring.
    const { kid, privateKey } = await provider.getSigningKey();
    const forged = await new SignJWT({ scope: 'openid', client_id: CLIENT })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setSubject(userId)
      .setIssuedAt()
      .setJti(randomUUID())
      .sign(privateKey);
    const res = await get({ authorization: `Bearer ${forged}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('scope profile only (no email) => 200 profile claims without email', async () => {
    const token = await accessToken({ scope: 'openid profile' });
    const res = await get({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sub).toBe(userId);
    expect(body.name).toBe('Alice A');
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('email_verified');
  });

  it('token missing openid scope => 403 insufficient_scope', async () => {
    const token = await accessToken({ scope: 'email profile' });
    const res = await get({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_scope');
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
  });

  it('(Task 0 e) fail-closed: a Mongo error resolving the resource mapping => 5xx, never 200/401', async () => {
    const token = await accessToken();
    const resources = app.get(ResourceService);
    const spy = jest
      .spyOn(resources, 'identifiersFor')
      .mockRejectedValueOnce(new Error('mongo down'));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/userinfo',
        headers: { authorization: `Bearer ${token}` },
      });
      // An infrastructure fault must surface as a 5xx, NOT be swallowed into a 401 (which would
      // look like "token revoked") or a 200 (which would leak PII without a live check).
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.json()).not.toHaveProperty('sub');
    } finally {
      spy.mockRestore();
    }
  });

  it('aud not in client.allowedResources => 401', async () => {
    const token = await accessToken({ aud: OTHER_RESOURCE });
    expect((await get({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
  });

  it('unknown client_id => 401', async () => {
    const token = await accessToken({ clientId: 'ghost-client' });
    expect((await get({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
  });

  it('sub not an ObjectId / user not found => 401 (no CastError 500)', async () => {
    const bad = await accessToken({ sub: 'not-an-objectid' });
    expect((await get({ authorization: `Bearer ${bad}` })).statusCode).toBe(401);
    const missing = await accessToken({ sub: new Types.ObjectId().toHexString() });
    expect((await get({ authorization: `Bearer ${missing}` })).statusCode).toBe(401);
  });

  it('access_token in query is ignored (only Authorization header) => 401', async () => {
    const token = await accessToken();
    const res = await app.inject({ method: 'GET', url: `/userinfo?access_token=${token}` });
    expect(res.statusCode).toBe(401);
  });

  it('preflight OPTIONS from a registered origin => ACAO + allow method/headers; unknown origin => no ACAO', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/userinfo',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(allowed.headers['access-control-allow-methods']).toContain('GET');
    expect(allowed.headers['access-control-allow-headers']).toContain('Authorization');
    expect(allowed.headers['vary']).toContain('Origin');

    const unknown = await app.inject({
      method: 'OPTIONS',
      url: '/userinfo',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    });
    expect(unknown.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('real request: Origin registered for the token client => ACAO echoes origin; cross-client origin => no ACAO', async () => {
    const token = await accessToken();
    const ok = await get({ authorization: `Bearer ${token}`, origin: ORIGIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['vary']).toContain('Origin');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();

    // ORIGIN is registered for CLIENT only; a token of OTHER_CLIENT from ORIGIN => no ACAO.
    const otherTok = await accessToken({ clientId: OTHER_CLIENT, aud: OTHER_RESOURCE });
    const cross = await get({ authorization: `Bearer ${otherTok}`, origin: ORIGIN });
    // OTHER_CLIENT has no allowedResources[RESOURCE] but aud=OTHER_RESOURCE is allowed for it:
    expect(cross.statusCode).toBe(200);
    expect(cross.headers['access-control-allow-origin']).toBeUndefined();
    expect(cross.headers['vary']).toContain('Origin');
  });

  it('shared preflight also answers /token (not only /userinfo) for a registered origin', async () => {
    // Proves the test runs the PRODUCTION hook (all CORS paths), not a /userinfo-only copy.
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/token',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('401 from a registered origin carries ACAO (SPA can read the error to trigger refresh)', async () => {
    // An invalid token from a registered Origin must still get ACAO on the 401 so the SPA reads the
    // status + WWW-Authenticate instead of an opaque CORS network error (union allowlist).
    const res = await get({ authorization: 'Bearer not-a-real-token', origin: ORIGIN });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['vary']).toContain('Origin');
  });

  it('401 from an unregistered origin gets NO ACAO (fail-closed)', async () => {
    const res = await get({
      authorization: 'Bearer not-a-real-token',
      origin: 'https://evil.example.com',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('DEBT-037: token whose session is ENDED (tombstone) => 401 invalid_token', async () => {
    isEnded.mockResolvedValueOnce(true);
    const sid = sha256('ended');
    const res = await get({ authorization: `Bearer ${await accessToken({ sid })}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
    expect(isEnded).toHaveBeenCalledWith(sid);
  });

  it('DEBT-037: token whose session is NOT ended => 200', async () => {
    isEnded.mockResolvedValueOnce(false);
    const sid = sha256('live');
    const res = await get({ authorization: `Bearer ${await accessToken({ sid })}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().sub).toBe(userId);
    expect(isEnded).toHaveBeenCalledWith(sid);
  });

  it('DEBT-037: token with NO sid => 200 (legacy), Redis never consulted', async () => {
    const res = await get({ authorization: `Bearer ${await accessToken()}` });
    expect(res.statusCode).toBe(200);
    expect(isEnded).not.toHaveBeenCalled();
  });

  it('DEBT-037: a malformed sid => 401, Redis never called', async () => {
    const res = await get({ authorization: `Bearer ${await accessToken({ sid: 'bad-sid' })}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
    expect(isEnded).not.toHaveBeenCalled();
  });

  it('DEBT-037: a non-string sid (number) => verifier rejects => 401, Redis never called', async () => {
    const res = await get({ authorization: `Bearer ${await accessToken({ sid: 42 })}` });
    expect(res.statusCode).toBe(401);
    expect(isEnded).not.toHaveBeenCalled();
  });

  it('DEBT-037 fail-closed: a Redis error in isEnded => 500, NOT 401/200', async () => {
    // 401 would make the RP treat the token as revoked/logged-out and mask an infra outage; a 200
    // would leak data past a possibly-ended session. A Redis fault must surface as a 5xx.
    isEnded.mockRejectedValueOnce(new Error('redis down'));
    const res = await get({ authorization: `Bearer ${await accessToken({ sid: sha256('x') })}` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).not.toHaveProperty('sub');
  });
});
