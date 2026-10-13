import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import IORedis from 'ioredis';
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
import { SessionService } from '../src/modules/sessions/session.service';
import { RedisService } from '../src/database/redis/redis.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
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
    if (ns === 'security')
      return {
        rateLimitWindow: 60,
        rateLimitMax: 100,
        // High thresholds so the client-auth failure limiter never fires in these tests.
        clientAuthFailIpMax: 100000,
        clientAuthFailClientMax: 100000,
      };
    throw new Error(`unexpected ns ${ns}`);
  },
} as unknown as ConfigService;

// A session-end lookup double (DEBT-037). `isEnded` is spy-able so a test can assert the exact
// number of calls (Task 1: an unrelated caller must drive ZERO session lookups) and drive specific
// outcomes (tombstone present/absent, Redis fault). Only the `isEnded` method is used.
const isEnded = jest.fn<(ref: string) => Promise<boolean>>().mockResolvedValue(false);
const sessionsStub = { isEnded } as unknown as SessionService;

function basic(id: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}
function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';

describe('/introspect (B4.6 Task 3, RFC 7662) on real Mongo', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
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

  const access = (
    over: {
      scope?: string;
      aud?: string;
      clientId?: string;
      sub?: string;
      sid?: string | number;
    } = {},
  ) =>
    signer.sign(
      {
        scope: over.scope ?? 'openid profile',
        client_id: over.clientId ?? TOKEN_CLIENT,
        ...(over.sid !== undefined ? { sid: over.sid } : {}),
      },
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
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
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
        RateLimitService,
        TokenSigner,
        TokenVerifier,
        { provide: KEY_PROVIDER, useValue: provider },
        { provide: RedisService, useValue: new RedisService(redis) },
        { provide: ConfigService, useValue: cfg },
        { provide: SessionService, useValue: sessionsStub },
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
    if (redis) {
      const keys = await redis.keys('rl:client-auth:*');
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
    if (app) await app.close();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    isEnded.mockReset();
    isEnded.mockResolvedValue(false);
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

  it('DEBT-040: an unrelated caller is rejected BEFORE any content-dependent lookup (spy proof)', async () => {
    // Authorization runs before liveness: an unrelated confidential caller (not the token client,
    // no claim on the aud) must get `active:false` WITHOUT the endpoint probing the token's
    // subjects. Prove it with spies: the user-existence probe and the session-end lookup are never
    // called, and `findByClientId` is never called for the TOKEN's client_id (only OTHER_CLIENT, to
    // authenticate the caller). Otherwise `/introspect` would be an existence oracle for arbitrary
    // tokens (timing + DB load) that an unrelated client could query.
    const userSpy = jest.spyOn(userModel, 'exists');
    const clients = app.get(ClientService);
    const clientSpy = jest.spyOn(clients, 'findByClientId');
    try {
      const token = await access(); // client_id = TOKEN_CLIENT, aud = RESOURCE
      const res = await post(form({ token }), { authorization: basic(OTHER_CLIENT, otherSecret) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ active: false });
      // No content-dependent I/O for someone else's token:
      expect(userSpy).not.toHaveBeenCalled();
      expect(isEnded).not.toHaveBeenCalled();
      // `findByClientId` ran only to authenticate the caller — never for the token's client_id.
      const lookedUp = clientSpy.mock.calls.map((c) => c[0]);
      expect(lookedUp).not.toContain(TOKEN_CLIENT);
    } finally {
      userSpy.mockRestore();
      clientSpy.mockRestore();
    }
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

  it('liveness: token aud no longer in the issuing client allowedResources => active:false (DEBT-041)', async () => {
    // The caller is TOKEN_CLIENT itself, so authorization passes via `client_id === caller` — this
    // isolates the `aud` branch of liveness (the token targets an aud TOKEN_CLIENT no longer holds).
    // If we used RS_CLIENT the result would be active:false from the authz gate, not the aud branch.
    const tokSecret = (await app.get(ClientCredentialService).createSecret(TOKEN_CLIENT)).secret;
    const token = await access({ aud: 'https://removed.example.com/' });
    const res = await post(form({ token }), { authorization: basic(TOKEN_CLIENT, tokSecret) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
  });

  it('DEBT-041 control: same caller (TOKEN_CLIENT) + a valid aud => active:true (authz really passed)', async () => {
    // Companion to the test above: same confidential caller, but the token targets an aud the
    // client still holds (RESOURCE). A live result proves the previous `active:false` came from the
    // `aud` liveness branch, not from authorization failing.
    const tokSecret = (await app.get(ClientCredentialService).createSecret(TOKEN_CLIENT)).secret;
    const res = await post(form({ token: await access() }), {
      authorization: basic(TOKEN_CLIENT, tokSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
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

  it('access token with NO sid stays active:true even when a refresh family is revoked (?214 limit)', async () => {
    // A legacy access token (no `sid`) is self-contained and only reflects client/aud/user; a
    // refresh-family revoke it cannot see before exp. This is the documented limit for sid-less
    // tokens (DEBT-037 Q-C), not a bug — sid-bearing tokens ARE reflected via the tombstone above.
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

  it('DEBT-037: a token with a well-formed sid whose session is ENDED => active:false', async () => {
    isEnded.mockResolvedValueOnce(true);
    const sid = sha256('ended-session');
    const res = await post(form({ token: await access({ sid }) }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
    expect(isEnded).toHaveBeenCalledWith(sid);
  });

  it('DEBT-037: a token with a well-formed sid whose session is NOT ended => active:true (and sid is not echoed)', async () => {
    isEnded.mockResolvedValueOnce(false);
    const sid = sha256('live-session');
    const res = await post(form({ token: await access({ sid }) }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
    // The session identifier is never surfaced in the introspection body (minimised, not a cap).
    expect(res.json()).not.toHaveProperty('sid');
    expect(isEnded).toHaveBeenCalledWith(sid);
  });

  it('DEBT-037: token with NO sid keeps legacy behaviour (active:true, Redis never consulted)', async () => {
    const res = await post(form({ token: await access() }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
    expect(isEnded).not.toHaveBeenCalled();
  });

  it('DEBT-037: a malformed sid => active:false and Redis is NEVER called', async () => {
    const res = await post(form({ token: await access({ sid: 'not-a-64-hex-ref' }) }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
    expect(isEnded).not.toHaveBeenCalled();
  });

  it('DEBT-037: a non-string sid (number) => verifier throws => active:false, Redis never called', async () => {
    const res = await post(form({ token: await access({ sid: 12345 }) }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
    expect(isEnded).not.toHaveBeenCalled();
  });

  it('DEBT-037 fail-closed: a Redis error in isEnded => 500, never active:true', async () => {
    isEnded.mockRejectedValueOnce(new Error('redis down'));
    const res = await post(form({ token: await access({ sid: sha256('x-session') }) }), {
      authorization: basic(RS_CLIENT, rsSecret),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('server_error');
    expect(res.json()).not.toHaveProperty('active');
  });

  it('DEBT-040+037: an unrelated caller never triggers isEnded even for a sid-bearing token', async () => {
    const res = await post(form({ token: await access({ sid: sha256('any-session') }) }), {
      authorization: basic(OTHER_CLIENT, otherSecret),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ active: false });
    expect(isEnded).not.toHaveBeenCalled();
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
