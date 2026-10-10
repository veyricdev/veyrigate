import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Types, type Model } from 'mongoose';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { IntrospectController } from '../src/modules/oauth/introspect/introspect.controller';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-introspect-${Date.now()}?directConnection=true`;
const RUN = `is${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const RESOURCE = 'https://api.example.com/';
const RS_CLIENT = `${RUN}-rs`; // a resource server, registered as a confidential client
const TOKEN_CLIENT = `${RUN}-app`; // the client the tokens were issued to
const OTHER_CLIENT = `${RUN}-other`;
const PUBLIC_CLIENT = `${RUN}-public`;

const cfg = {
  getOrThrow: (ns: string) => {
    if (ns === 'app') return { nodeEnv: 'production', issuer: ISSUER };
    if (ns === 'client') return { secretGraceTtl: 3600 };
    throw new Error(`unexpected ns ${ns}`);
  },
} as unknown as ConfigService;

function basic(id: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}
function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

describe('/introspect (B4.6 Task 3, RFC 7662) on real Mongo', () => {
  let app: NestFastifyApplication;
  let keyDir: string;
  let signer: TokenSigner;
  let refreshModel: Model<Record<string, unknown>>;
  let clientModel: Model<Client>;
  let userModel: Model<Record<string, unknown>>;
  let rsSecret = '';
  let otherSecret = '';
  // A REAL user id: `/introspect` now gates on access-token liveness (OPEN-1 -> A), so an access
  // token whose `sub` does not exist in the User collection is reported `active:false`.
  let userId: Types.ObjectId;

  const post = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });

  const access = (over: { scope?: string; aud?: string; clientId?: string; sub?: string } = {}) =>
    signer.sign(
      { scope: over.scope ?? 'openid profile', client_id: over.clientId ?? TOKEN_CLIENT },
      {
        audience: over.aud ?? RESOURCE,
        subject: over.sub ?? userId.toHexString(),
        expiresInSec: 900,
        typ: 'at+jwt',
      },
    );

  /** Insert a refresh doc directly; returns the (fake) plaintext value whose hash is stored. */
  async function insertRefresh(
    value: string,
    over: Partial<Record<string, unknown>> = {},
  ): Promise<void> {
    await refreshModel.create({
      tokenHash: sha256(value),
      familyId: 'fam-' + value,
      userId,
      clientId: TOKEN_CLIENT,
      scope: ['openid', 'offline_access'],
      resource: RESOURCE,
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    });
  }

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'vg-introspect-int-'));
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
      controllers: [IntrospectController],
      providers: [
        ClientService,
        ClientCredentialService,
        ClientAuthenticationService,
        TokenSigner,
        TokenVerifier,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: ConfigService, useValue: cfg },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    signer = moduleRef.get(TokenSigner);
    refreshModel = app.get<Model<Record<string, unknown>>>(getModelToken('RefreshToken'));
    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    userModel = app.get<Model<Record<string, unknown>>>(getModelToken('User'));
    await syncAllIndexes(clientModel.db);

    // A real user whose `_id` every default-`sub` token points at (liveness requires it to exist).
    const user = await userModel.create({ email: `is-${Date.now()}@example.com` });
    userId = user._id as Types.ObjectId;

    const clients = new ClientService(clientModel, cfg);
    const creds = moduleRef.get(ClientCredentialService);
    // RS: a confidential client that holds RESOURCE in allowedResources (may introspect its tokens).
    await clients.create({
      clientId: RS_CLIENT,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
    rsSecret = (await creds.createSecret(RS_CLIENT)).secret;
    // The app client the tokens belong to (confidential so it can also introspect its own tokens).
    await clients.create({
      clientId: TOKEN_CLIENT,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
    // Another confidential client with no claim on RESOURCE (confused-deputy probe).
    await clients.create({
      clientId: OTHER_CLIENT,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      allowedResources: ['https://nope.example.com/'],
      tenantId: 'tenant-A',
    });
    otherSecret = (await creds.createSecret(OTHER_CLIENT)).secret;
    // A public client (method none) ? must NOT be allowed to introspect.
    await clients.create({
      clientId: PUBLIC_CLIENT,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      tenantId: 'tenant-A',
    });
  }, 60_000);

  afterAll(async () => {
    if (refreshModel) await refreshModel.db.dropDatabase();
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  it('no caller auth => 401 invalid_client, no introspection body', async () => {
    const res = await post(form({ token: await access() }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.json()).not.toHaveProperty('active');
  });

  it('public (none) client => 401 invalid_client (not an oracle)', async () => {
    const res = await post(form({ token: await access(), client_id: PUBLIC_CLIENT }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
  });

  it('bad secret => 401 invalid_client + WWW-Authenticate (Basic)', async () => {
    const res = await post(form({ token: await access() }), {
      authorization: basic(RS_CLIENT, 'wrong'),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('RS holding the aud introspects a live access token => active:true + no-store', async () => {
    const token = await access();
    const res = await post(form({ token }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.active).toBe(true);
    expect(body.token_type).toBe('access_token');
    expect(body.sub).toBe(userId.toHexString());
    expect(body.aud).toBe(RESOURCE);
    expect(body.scope).toBe('openid profile');
    expect(body.client_id).toBe(TOKEN_CLIENT);
    expect(typeof body.exp).toBe('number');
  });

  it('the token client itself can introspect its own access token', async () => {
    const tokSecret = (await app.get(ClientCredentialService).createSecret(TOKEN_CLIENT)).secret;
    const res = await post(form({ token: await access() }), {
      authorization: basic(TOKEN_CLIENT, tokSecret),
    });
    expect(res.json().active).toBe(true);
  });

  it('confused-deputy: a confidential client with no claim on the aud => active:false', async () => {
    const res = await post(form({ token: await access() }), {
      authorization: basic(OTHER_CLIENT, otherSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('expired access token => active:false', async () => {
    const expired = await signer.sign(
      { scope: 'openid', client_id: TOKEN_CLIENT },
      { audience: RESOURCE, subject: userId.toHexString(), expiresInSec: -10, typ: 'at+jwt' },
    );
    const res = await post(form({ token: expired }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.json()).toEqual({ active: false });
  });

  it('an ID token (typ: JWT) => active:false', async () => {
    const id = await signer.sign(
      {},
      { audience: TOKEN_CLIENT, subject: userId.toHexString(), expiresInSec: 900 },
    );
    const res = await post(form({ token: id }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.json()).toEqual({ active: false });
  });

  it('liveness: token client was deleted => active:false', async () => {
    // Register a throwaway confidential client, mint a token for it, then delete it.
    const gone = `${RUN}-gone-${Date.now()}`;
    const clients = new ClientService(clientModel, cfg);
    await clients.create({
      clientId: gone,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
    const token = await access({ clientId: gone });
    await clientModel.deleteOne({ clientId: gone }).exec();
    const res = await post(form({ token }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('liveness: token aud no longer in the issuing client allowedResources => active:false', async () => {
    // TOKEN_CLIENT currently allows RESOURCE; a token for an aud it does NOT allow is not live.
    const token = await access({ aud: 'https://removed.example.com/' });
    // RS allows RESOURCE only, not the removed aud — but liveness is checked FIRST (before caller
    // authorization), so this is `active:false` regardless of who the RS is.
    const res = await post(form({ token }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('liveness: user (sub) does not exist => active:false', async () => {
    const token = await access({ sub: new Types.ObjectId().toHexString() });
    const res = await post(form({ token }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('liveness: malformed (non-ObjectId) sub => active:false (never a 500 CastError)', async () => {
    const token = await access({ sub: 'not-an-object-id' });
    const res = await post(form({ token }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('live refresh token, owning client => active:true (refresh_token)', async () => {
    await insertRefresh('rt-live');
    const res = await post(form({ token: 'rt-live' }), {
      authorization: basic(
        TOKEN_CLIENT,
        (await app.get(ClientCredentialService).createSecret(TOKEN_CLIENT)).secret,
      ),
    });
    const body = res.json();
    expect(body.active).toBe(true);
    expect(body.token_type).toBe('refresh_token');
    expect(body.client_id).toBe(TOKEN_CLIENT);
    expect(body.aud).toBe(RESOURCE);
    expect(body.scope).toBe('openid offline_access');
    expect(body).not.toHaveProperty('familyId');
    expect(body).not.toHaveProperty('_id');
  });

  it('revoked / family-revoked / expired refresh => active:false', async () => {
    const tokSecret = (await app.get(ClientCredentialService).createSecret(TOKEN_CLIENT)).secret;
    const auth = { authorization: basic(TOKEN_CLIENT, tokSecret) };
    await insertRefresh('rt-revoked', { revokedAt: new Date() });
    expect((await post(form({ token: 'rt-revoked' }), auth)).json()).toEqual({ active: false });
    await insertRefresh('rt-famrevoked', { familyRevokedAt: new Date() });
    expect((await post(form({ token: 'rt-famrevoked' }), auth)).json()).toEqual({ active: false });
    await insertRefresh('rt-expired', { expiresAt: new Date(Date.now() - 1000) });
    expect((await post(form({ token: 'rt-expired' }), auth)).json()).toEqual({ active: false });
  });

  it('IDOR: client B introspects client A refresh token => active:false', async () => {
    await insertRefresh('rt-a-owned');
    const res = await post(form({ token: 'rt-a-owned' }), {
      authorization: basic(OTHER_CLIENT, otherSecret),
    });
    expect(res.json()).toEqual({ active: false });
  });

  it('caller auth via client_secret_post (body credentials, not Basic) => active:true', async () => {
    // The fold requires caller auth to reuse /token's parser, which accepts client_secret_post.
    // Register a post-method confidential client holding RESOURCE and authenticate via the body.
    const postClient = `${RUN}-post-${Date.now()}`;
    const clients = new ClientService(clientModel, cfg);
    await clients.create({
      clientId: postClient,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_post',
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
    const secret = (await app.get(ClientCredentialService).createSecret(postClient)).secret;
    const res = await post(
      form({ token: await access(), client_id: postClient, client_secret: secret }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
    expect(res.json().token_type).toBe('access_token');
  });

  it('client_secret_post with a WRONG secret => 401 invalid_client (no introspection body)', async () => {
    const postClient = `${RUN}-postbad-${Date.now()}`;
    const clients = new ClientService(clientModel, cfg);
    await clients.create({
      clientId: postClient,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_post',
      allowedResources: [RESOURCE],
      tenantId: 'tenant-A',
    });
    await app.get(ClientCredentialService).createSecret(postClient);
    const res = await post(
      form({ token: await access(), client_id: postClient, client_secret: 'wrong-secret' }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.json()).not.toHaveProperty('active');
  });

  it('token_type_hint is accepted but NOT trusted: branch follows the token SHAPE', async () => {
    // RFC 7662 2.1 - the hint is advisory only. A live refresh token presented with a LYING
    // access_token hint must still be resolved as a refresh token (shape = opaque), and a live
    // access token presented with a LYING refresh_token hint must still verify as an access token.
    const tokSecret = (await app.get(ClientCredentialService).createSecret(TOKEN_CLIENT)).secret;
    const auth = { authorization: basic(TOKEN_CLIENT, tokSecret) };

    await insertRefresh('rt-wrong-hint');
    const refreshRes = await post(
      form({ token: 'rt-wrong-hint', token_type_hint: 'access_token' }),
      auth,
    );
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().active).toBe(true);
    expect(refreshRes.json().token_type).toBe('refresh_token');

    const accessRes = await post(
      form({ token: await access(), token_type_hint: 'refresh_token' }),
      auth,
    );
    expect(accessRes.statusCode).toBe(200);
    expect(accessRes.json().active).toBe(true);
    expect(accessRes.json().token_type).toBe('access_token');
  });

  it('garbage / unknown token => active:false (200)', async () => {
    const res = await post(form({ token: 'totally-random-value' }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('missing token => 400 invalid_request; repeated token param => 400 invalid_request', async () => {
    const missing = await post(form({ client_id: RS_CLIENT }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('invalid_request');
    const dup = await post('token=a&token=b', { authorization: basic(RS_CLIENT, rsSecret) });
    expect(dup.statusCode).toBe(400);
  });

  it('access token stays active:true even when a refresh family of the same session is revoked (?214 limit)', async () => {
    // Access tokens are self-contained (no DB), so /introspect cannot reflect a family/logout
    // revoke before exp ? this asserts the documented OPEN-1 (A) contract, not a bug.
    const token = await access();
    const res = await post(form({ token }), { authorization: basic(RS_CLIENT, rsSecret) });
    expect(res.json().active).toBe(true);
  });

  it('fail-closed: a DB error => 500 server_error, never active:true', async () => {
    const spy = jest.spyOn(refreshModel, 'findOne').mockImplementationOnce(() => {
      throw new Error('mongo down');
    });
    try {
      const res = await post(form({ token: 'opaque-refresh-shaped' }), {
        authorization: basic(RS_CLIENT, rsSecret),
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('server_error');
      expect(res.json()).not.toHaveProperty('active');
    } finally {
      spy.mockRestore();
    }
  });

  it('fail-closed: a DB error during access-token liveness => 500, never active:true', async () => {
    // The liveness user lookup faults — it MUST propagate to 500, not be swallowed into
    // active:false (which would wrongly tell a resource server "stop trusting this token").
    const spy = jest.spyOn(userModel, 'exists').mockImplementationOnce(() => {
      throw new Error('mongo down');
    });
    try {
      const res = await post(form({ token: await access() }), {
        authorization: basic(RS_CLIENT, rsSecret),
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('server_error');
      expect(res.json()).not.toHaveProperty('active');
    } finally {
      spy.mockRestore();
    }
  });
});
