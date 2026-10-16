import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import IORedis from 'ioredis';
import { Types, type Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODELS } from '../src/database/mongo/models';
import { syncAllIndexes } from '../src/database/mongo/sync-indexes';
import { parseTrustProxy } from '../src/config/trust-proxy';
import { RedisService } from '../src/database/redis/redis.service';
import { KEY_PROVIDER } from '../src/modules/keys/key-provider';
import { LocalKeyProvider } from '../src/modules/keys/local-key-provider';
import { TokenSigner } from '../src/modules/keys/token-signer';
import { TokenVerifier } from '../src/modules/keys/token-verifier';
import { ClientService, type Client } from '../src/modules/clients/client.service';
import { ResourceService } from '../src/modules/resources/resource.service';
import { ClientCredentialService } from '../src/modules/clients/client-credential.service';
import { ClientAuthenticationService } from '../src/modules/clients/client-authentication.service';
import { ClientCorsService } from '../src/modules/clients/client-cors.service';
import { AuditService } from '../src/modules/security/audit/audit.service';
import { RateLimitService } from '../src/modules/security/rate-limit/rate-limit.service';
import { AuthorizationCodeService } from '../src/modules/oauth/code/authorization-code.service';
import { SessionService } from '../src/modules/sessions/session.service';
import { TokenController } from '../src/modules/oauth/token/token.controller';
import { IntrospectController } from '../src/modules/oauth/introspect/introspect.controller';
import { TokenService } from '../src/modules/oauth/token/token.service';
import { RefreshTokenService } from '../src/modules/oauth/token/refresh-token.service';

const MONGO_URI =
  process.env.TEST_MONGO_URI ??
  `mongodb://localhost:27117/vg-int-clrl-${Date.now()}?directConnection=true`;
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6479';
const RUN = `rl${Date.now()}`;
const ISSUER = 'http://localhost:4000';
const REDIRECT = 'https://app.example.com/callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

// Small thresholds so the limiter fires within a test (fold acceptance: CLIENT_MAX=3, IP_MAX=5).
const CLIENT_MAX = 3;
const IP_MAX = 5;

function cfgFor(trustProxyEnv?: string): ConfigService {
  const security = {
    rateLimitWindow: 60,
    rateLimitMax: 100,
    clientAuthFailIpMax: IP_MAX,
    clientAuthFailClientMax: CLIENT_MAX,
  };
  const base: Record<string, unknown> = {
    app: { nodeEnv: 'production', issuer: ISSUER, trustProxy: parseTrustProxy(trustProxyEnv) },
    token: {
      accessTokenTtl: 900,
      refreshTokenTtl: 2592000,
      sessionIdleTtl: 28800,
      sessionAbsoluteTtl: 2592000,
    },
    client: { secretGraceTtl: 3600 },
    security,
  };
  return { getOrThrow: (ns: string) => base[ns] } as unknown as ConfigService;
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
function basic(id: string, secret: string): string {
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

/**
 * Build a token+introspect app with the given TRUST_PROXY env for `req.ip`/XFF resolution. Each app
 * gets its OWN Redis connection (RedisService quits it on `app.close()`), so closing one app never
 * tears down another app's / the test harness's client. Counters are shared via the same Redis DB.
 */
async function buildApp(keyDir: string, trustProxyEnv?: string): Promise<NestFastifyApplication> {
  const provider = new LocalKeyProvider(keyDir);
  await provider.init();
  const cfg = cfgFor(trustProxyEnv);
  const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        retryAttempts: 5,
        retryDelay: 1000,
      }),
      MongooseModule.forFeature(MODELS),
    ],
    controllers: [TokenController, IntrospectController],
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

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({
      trustProxy: parseTrustProxy(trustProxyEnv),
    }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('client-auth failure rate limit (DEBT-029/039 + DEBT-006) on real Mongo + Redis', () => {
  let app: NestFastifyApplication;
  let redis: IORedis;
  let keyDir: string;
  let clientModel: Model<Client>;
  let clients: ClientService;
  let creds: ClientCredentialService;
  let confSecret = '';
  const CONF = `${RUN}-conf`;
  const PUBLIC = `${RUN}-public`;

  const tokenPost = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });
  const revokePost = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });
  const introspectPost = (payload: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/introspect',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload,
    });

  // Wrong-secret /token request for a confidential client via client_secret_post.
  const wrongSecretPost = () =>
    tokenPost(
      form({
        grant_type: 'refresh_token',
        refresh_token: 'rt-does-not-matter',
        client_id: CONF,
        client_secret: 'wrong-secret',
      }),
    );

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-clrl-int-'));
    app = await buildApp(keyDir);

    clientModel = app.get<Model<Client>>(getModelToken('Client'));
    await syncAllIndexes(clientModel.db);
    clients = new ClientService(clientModel, cfgFor());
    creds = app.get(ClientCredentialService);

    await clients.create({
      clientId: CONF,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: 'tenant-A',
    });
    confSecret = (await creds.createSecret(CONF)).secret;

    await clients.create({
      clientId: PUBLIC,
      clientType: 'public',
      tokenEndpointAuthMethod: 'none',
      redirectUris: [REDIRECT],
      grantTypes: ['authorization_code', 'refresh_token'],
      tenantId: 'tenant-A',
    });
  }, 60_000);

  afterAll(async () => {
    if (clientModel) await clientModel.db.dropDatabase();
    if (app) await app.close();
    if (redis) await redis.quit();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  // Each test starts from a clean counter (counters live 60s across the shared 127.0.0.1).
  beforeEach(async () => {
    const keys = await redis.keys('rl:client-auth:*');
    if (keys.length) await redis.del(...keys);
    jest.restoreAllMocks();
  });

  it('(a) wrong secret: 1-3 => 401 invalid_client, 4th => 429 + Retry-After + temporarily_unavailable; Argon2 not called on the 4th', async () => {
    for (let i = 0; i < CLIENT_MAX; i++) {
      const res = await wrongSecretPost();
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
    }
    const spy = jest.spyOn(creds, 'verifySecret');
    const blocked = await wrongSecretPost();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('temporarily_unavailable');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(spy).not.toHaveBeenCalled();
  });

  it('(b) correct secret after the block still 429 (limiter runs before the secret check)', async () => {
    for (let i = 0; i < CLIENT_MAX; i++) {
      expect((await wrongSecretPost()).statusCode).toBe(401);
    }
    // Even with the right secret, the request is blocked (deliberate — pre-Argon2 gate).
    const res = await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'x' }), {
      authorization: basic(CONF, confSecret),
    });
    expect(res.statusCode).toBe(429);
  });

  it('(c) success never counts: 20 valid-secret requests in a row never 429', async () => {
    for (let i = 0; i < 20; i++) {
      // A valid client auth that still fails the grant (bogus refresh token) => NOT a client-auth
      // failure, so it is never counted. Status is 400 invalid_grant, never 401/429.
      const res = await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'bogus' }), {
        authorization: basic(CONF, confSecret),
      });
      expect(res.statusCode).not.toBe(429);
      expect(res.statusCode).not.toBe(401);
    }
  });

  it('(d) Basic and client_secret_post for the same client_id share one counter', async () => {
    // 3 Basic failures reach the client limit; a 4th via client_secret_post is 429.
    for (let i = 0; i < CLIENT_MAX; i++) {
      const res = await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'x' }), {
        authorization: basic(CONF, 'wrong'),
      });
      expect(res.statusCode).toBe(401);
    }
    const res = await wrongSecretPost();
    expect(res.statusCode).toBe(429);
  });

  it('(e) rotating non-existent client_id from one IP => IP bucket trips on the 6th (no Argon2)', async () => {
    for (let i = 0; i < IP_MAX; i++) {
      const res = await tokenPost(
        form({
          grant_type: 'refresh_token',
          refresh_token: 'x',
          client_id: `${RUN}-ghost-${i}`,
          client_secret: 'nope',
        }),
      );
      expect(res.statusCode).toBe(401);
    }
    const spy = jest.spyOn(creds, 'verifySecret');
    const res = await tokenPost(
      form({
        grant_type: 'refresh_token',
        refresh_token: 'x',
        client_id: `${RUN}-ghost-final`,
        client_secret: 'nope',
      }),
    );
    expect(res.statusCode).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it('(g) /revoke and /introspect share the /token bucket (2 on /token + 1 on /introspect => 4th on /revoke => 429)', async () => {
    const h = { authorization: basic(CONF, 'wrong') };
    expect(
      (await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'x' }), h)).statusCode,
    ).toBe(401);
    expect(
      (await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'x' }), h)).statusCode,
    ).toBe(401);
    const is = await introspectPost(form({ token: 'x' }), h);
    expect(is.statusCode).toBe(401);
    const rv = await revokePost(form({ token: 'x' }), h);
    expect(rv.statusCode).toBe(429);
    // /introspect 429 carries no `active`.
    const isBlocked = await introspectPost(form({ token: 'x' }), h);
    expect(isBlocked.statusCode).toBe(429);
    expect(isBlocked.json().error).toBe('temporarily_unavailable');
    expect(isBlocked.json().active).toBeUndefined();
  });

  it('(n) Redis error on reserve => 500 server_error; no DB lookup, no Argon2, no token', async () => {
    const rl = app.get(RateLimitService);
    const reserveSpy = jest.spyOn(rl, 'reserve').mockRejectedValueOnce(new Error('redis down'));
    const findSpy = jest.spyOn(clients, 'findByClientId');
    const verifySpy = jest.spyOn(creds, 'verifySecret');
    const res = await wrongSecretPost();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('server_error');
    expect(res.json().access_token).toBeUndefined();
    expect(reserveSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('(o) a blocked request never reaches findByClientId (reserve is before the DB lookup)', async () => {
    for (let i = 0; i < CLIENT_MAX; i++) {
      expect((await wrongSecretPost()).statusCode).toBe(401);
    }
    const findSpy = jest.spyOn(clients, 'findByClientId');
    const blocked = await wrongSecretPost();
    expect(blocked.statusCode).toBe(429);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('(k) race: N=50 concurrent wrong-secret => verifySecret called exactly CLIENT_MAX, rest 429', async () => {
    const verifySpy = jest.spyOn(creds, 'verifySecret');
    const results = await Promise.all(Array.from({ length: 50 }, () => wrongSecretPost()));
    const codes = results.map((r) => r.statusCode);
    // Atomic reserve caps Argon2 at the client limit even under full concurrency (no peek→hit race).
    expect(verifySpy).toHaveBeenCalledTimes(CLIENT_MAX);
    expect(codes.filter((c) => c === 401)).toHaveLength(CLIENT_MAX);
    expect(codes.filter((c) => c === 429)).toHaveLength(50 - CLIENT_MAX);
  });

  it('(k-variant) rotating client_id from one IP, concurrent => Argon2 <= IP_MAX', async () => {
    const verifySpy = jest.spyOn(creds, 'verifySecret');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_unused, i) =>
        tokenPost(
          form({
            grant_type: 'refresh_token',
            refresh_token: 'x',
            client_id: `${RUN}-race-ghost-${i}`,
            client_secret: 'nope',
          }),
        ),
      ),
    );
    // Different client_ids never share a client bucket, so the IP bucket is the binding cap.
    expect(verifySpy).toHaveBeenCalledTimes(IP_MAX);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(50 - IP_MAX);
  });

  it('(l) success never penalised: concurrent valid-secret requests are never 429, counters stay 0', async () => {
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'bogus' }), {
            authorization: basic(CONF, confSecret),
          }),
        ),
      );
      // Valid client auth (grant still fails on the bogus refresh token) => never 401/429.
      for (const r of results) {
        expect(r.statusCode).not.toBe(429);
        expect(r.statusCode).not.toBe(401);
      }
      // After the refunds, no client-auth counter is left standing.
      const keys = await redis.keys('rl:client-auth:*');
      for (const key of keys) {
        expect(Number(await redis.get(key))).toBe(0);
      }
    }
  });

  it('(m) refund failure => still 200 with a token + a warning; the reservation is not given back', async () => {
    const rl = app.get(RateLimitService);
    const refundSpy = jest.spyOn(rl, 'refund').mockRejectedValueOnce(new Error('redis down'));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // A valid client auth (bogus refresh => 400 invalid_grant, but the client auth itself succeeds).
    const res = await tokenPost(form({ grant_type: 'refresh_token', refresh_token: 'bogus' }), {
      authorization: basic(CONF, confSecret),
    });
    expect(res.statusCode).not.toBe(429);
    expect(res.statusCode).not.toBe(401);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    // Refund failed, so the reservation stands: the client bucket holds exactly 1.
    const keys = await redis.keys('rl:client-auth:*');
    const counts = await Promise.all(keys.map((k) => redis.get(k)));
    expect(counts.some((c) => c === '1')).toBe(true);
  });

  it('(h) INV-13: a 429 on authorization_code does NOT consume the code (re-exchange succeeds)', async () => {
    // Issue a real, consumable authorization code for the confidential client, bound to a LIVE
    // session (DEBT-043: /token refuses a code whose session is not live).
    const codeSvc = app.get(AuthorizationCodeService);
    const sessions = app.get(SessionService);
    const sessionRef = (await sessions.create(new Types.ObjectId().toHexString(), 'tenant-A'))
      .session.ref;
    const challenge = createHash('sha256').update(VERIFIER).digest('base64url');
    const { code } = await codeSvc.create({
      clientId: CONF,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scope: 'openid',
      userId: new Types.ObjectId().toHexString(),
      authTime: Math.floor(Date.now() / 1000),
      sessionRef,
    });
    // Block the client via CLIENT_MAX wrong-secret attempts, then try to exchange the real code.
    for (let i = 0; i < CLIENT_MAX; i++) {
      expect((await wrongSecretPost()).statusCode).toBe(401);
    }
    const blocked = await tokenPost(
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
      { authorization: basic(CONF, confSecret) },
    );
    expect(blocked.statusCode).toBe(429);
    // INV-13: the 429 is thrown by `reserve` BEFORE the grant handler, so the code must NOT have
    // been consumed. Proof: it is still consumable directly from the store (returns its data once).
    const stillThere = await codeSvc.consume(code, CONF, REDIRECT, challenge);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.userId).toBeDefined();
    // And it was genuinely single-use: a second consume now returns null (we just spent it).
    expect(await codeSvc.consume(code, CONF, REDIRECT, challenge)).toBeNull();
  });

  it('(j) public client (method none) is never reserved/refunded/blocked even under IP pressure', async () => {
    const rl = app.get(RateLimitService);
    // Fill the per-IP bucket to IP_MAX with CONFIDENTIAL wrong-secret failures. Rotate the client_id
    // each time so the per-client bucket never trips first (it would 429 at CLIENT_MAX < IP_MAX).
    for (let i = 0; i < IP_MAX; i++) {
      const res = await tokenPost(
        form({
          grant_type: 'refresh_token',
          refresh_token: 'x',
          client_id: `${RUN}-jfill-${i}`,
          client_secret: 'nope',
        }),
      );
      expect(res.statusCode).toBe(401);
    }
    const reserveSpy = jest.spyOn(rl, 'reserve');
    const refundSpy = jest.spyOn(rl, 'refund');
    // A `none` (public) client auth still succeeds: it never touches the failure limiter at all.
    const res = await tokenPost(
      form({
        grant_type: 'authorization_code',
        code: 'bogus',
        redirect_uri: REDIRECT,
        client_id: PUBLIC,
        code_verifier: VERIFIER,
      }),
    );
    // Grant fails on the bogus code (400), but client auth is NOT blocked (429) and NOT limiter-bound.
    expect(res.statusCode).not.toBe(429);
    expect(reserveSpy).not.toHaveBeenCalled();
    expect(refundSpy).not.toHaveBeenCalled();
  });
});

describe('TRUST_PROXY (DEBT-006): X-Forwarded-For vs rate-limit bucket isolation', () => {
  let redis: IORedis;
  let keyDir: string;
  const RUN2 = `tp${Date.now()}`;

  const wrong = (app: NestFastifyApplication, clientId: string, xff?: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(xff ? { 'x-forwarded-for': xff } : {}),
      },
      payload: form({
        grant_type: 'refresh_token',
        refresh_token: 'x',
        client_id: clientId,
        client_secret: 'wrong',
      }),
    });

  // Distinct client per test (the two apps share one Mongo DB, so a reused id would E11000).
  async function seedClient(app: NestFastifyApplication, clientId: string): Promise<string> {
    const clientModel = app.get<Model<Client>>(getModelToken('Client'));
    await syncAllIndexes(clientModel.db);
    const svc = new ClientService(clientModel, cfgFor());
    await svc.create({
      clientId,
      clientType: 'confidential',
      tokenEndpointAuthMethod: 'client_secret_basic',
      redirectUris: [REDIRECT],
      grantTypes: ['refresh_token'],
      tenantId: 'tenant-A',
    });
    return (await app.get(ClientCredentialService).createSecret(clientId)).secret;
  }

  const goodBasic = (app: NestFastifyApplication, clientId: string, secret: string, xff: string) =>
    app.inject({
      method: 'POST',
      url: '/token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': xff,
        authorization: basic(clientId, secret),
      },
      payload: form({ grant_type: 'refresh_token', refresh_token: 'bogus' }),
    });

  beforeAll(async () => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
    keyDir = await mkdtemp(join(tmpdir(), 'vg-tp-int-'));
  }, 30_000);

  afterAll(async () => {
    if (redis) await redis.quit();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const keys = await redis.keys('rl:client-auth:*');
    if (keys.length) await redis.del(...keys);
  });

  it('no TRUST_PROXY => two different X-Forwarded-For share one counter (XFF ignored)', async () => {
    const app = await buildApp(keyDir); // trustProxy disabled
    const clientId = `${RUN2}-off`;
    try {
      await seedClient(app, clientId);
      // CLIENT_MAX failures across two different XFF values, same socket IP => same client|ip bucket.
      for (let i = 0; i < CLIENT_MAX; i++) {
        const res = await wrong(app, clientId, i % 2 === 0 ? '9.9.9.9' : '8.8.8.8');
        expect(res.statusCode).toBe(401);
      }
      const blocked = await wrong(app, clientId, '7.7.7.7');
      expect(blocked.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('TRUST_PROXY=127.0.0.1 => different X-Forwarded-For get independent counters', async () => {
    const app = await buildApp(keyDir, '127.0.0.1');
    const clientId = `${RUN2}-on`;
    try {
      const secret = await seedClient(app, clientId);
      // Fill client A's IP bucket from one spoofed XFF...
      for (let i = 0; i < CLIENT_MAX; i++) {
        expect((await wrong(app, clientId, '9.9.9.9')).statusCode).toBe(401);
      }
      expect((await wrong(app, clientId, '9.9.9.9')).statusCode).toBe(429);
      // ...a DIFFERENT XFF is an independent client|ip bucket, so still 401 (not blocked).
      expect((await wrong(app, clientId, '8.8.8.8')).statusCode).toBe(401);
      // (f) From that DIFFERENT XFF the CORRECT secret still authenticates (200-class, not 429):
      // the block is scoped to the spoofed XFF's bucket, the legit client on IP2 is unaffected.
      const ok = await goodBasic(app, clientId, secret, '8.8.8.8');
      expect(ok.statusCode).not.toBe(429);
      expect(ok.statusCode).not.toBe(401);
    } finally {
      await app.close();
    }
  });
});
